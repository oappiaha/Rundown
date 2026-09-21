import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from rundown import db, feeds, rss, show
from rundown.config import settings
from rundown.main import app
from rundown.models import FeedEntry, FeedRun, InboxSource, InboxTopic

RSS = b'''<rss version="2.0"><channel><title>News</title><link>https://example.com/</link><description>News</description>
<item><guid isPermaLink="false">one</guid><title>A long original headline for the full research context</title><link>https://EXAMPLE.com:443/one#story</link><description><![CDATA[<p>Important background.</p><script>secret script</script><p>Ask why now?</p>]]></description></item>
<item><guid isPermaLink="false">two</guid><title>Second story</title><link>https://example.com/two</link><description>More detail.</description></item>
<item><guid isPermaLink="false">one</guid><title>Repeated</title><link>https://example.com/one</link></item>
<item><title>Missing link</title></item><item><title>Bad link</title><link>javascript:alert(1)</link></item>
</channel></rss>'''


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(rss, 'fetch_feed', lambda url: (RSS, url))
    with TestClient(app) as client:
        yield client


def create(client, **patch):
    r = client.post('/feeds', json={'name': 'Research', 'url': 'https://example.com/feed.xml', 'default_duration': 120, **patch})
    assert r.status_code == 201, r.text
    return r.json()


def run(client, feed):
    r = client.post('/feeds/' + feed['id'] + '/import', json={'revision': feed['revision']})
    assert r.status_code == 200, r.text
    return r.json()


def edit(client, feed, **patch):
    return client.put('/feeds/' + feed['id'], json={k: patch.get(k, feed[k]) for k in ['revision', 'name', 'default_duration', 'enabled']})


def test_import_context_dedup_and_clock_preservation(client):
    client.put('/rundown/schedule', json={'revision': 0, 'topics': [{'text': 'On air', 'duration': 3600}]})
    client.post('/rundown/control', json={'revision': 1, 'action': 'play'})
    with db.session() as s:
        clock = s.get(show.ShowClock, 1)
        assert clock
        before = clock.model_dump()
    feed = create(client)
    result = run(client, feed)
    assert result['status'] == 'succeeded'
    assert (result['created'], result['duplicates'], result['skipped'], result['examined']) == (2, 1, 2, 5)
    ideas = client.get('/inbox').json()['items']
    original = next(x for x in ideas if x['source_url'].endswith('/one'))
    assert len(original['text']) == 30
    assert original['source']['original_title'] == 'A long original headline for the full research context'
    assert original['source']['body_text'] == 'Important background.\nAsk why now?'
    assert original['source']['feed_name'] == 'Research'
    assert original['topic']['notes'].endswith('Source: https://example.com/one')
    assert client.get('/inbox/' + original['id']).json() == original
    changed = client.put('/inbox/' + original['id'], json={'revision': original['revision'], 'text': 'My title', 'duration': 180, 'notes': 'My editorial notes', 'source_url': original['source_url']}).json()
    assert changed['source'] == original['source']
    archived = client.post('/inbox/' + original['id'] + '/archive', json={'revision': changed['revision'], 'archived': True}).json()
    repeat = run(client, feed)
    assert (repeat['created'], repeat['duplicates'], repeat['skipped']) == (0, 3, 2)
    assert client.get('/inbox/' + original['id']).json() == archived
    cross = run(client, create(client, url='https://example.org/feed.xml'))
    assert cross['created'] == 0 and cross['duplicates'] == 3
    with db.session() as s:
        clock = s.get(show.ShowClock, 1)
        assert clock and clock.model_dump() == before
    assert client.get('/feeds/' + feed['id']).json()['latest_run']['id'] == repeat['id']
    assert len(client.get('/feeds/' + feed['id'] + '/runs').json()['runs']) == 2


def test_feed_config_stale_disabled_duplicate_and_no_network(client, monkeypatch):
    calls = []
    monkeypatch.setattr(rss, 'fetch_feed', lambda url: calls.append(url))
    feed = create(client, name='  Research  ')
    assert feed['name'] == 'Research' and feed['can_import']
    assert client.get('/feeds').json()['feeds'] == [feed]
    assert client.post('/feeds', json={'name': 'Duplicate', 'url': 'https://EXAMPLE.com:443/feed.xml#f', 'default_duration': 120}).status_code == 409
    disabled = edit(client, feed, enabled=False).json()
    assert disabled['revision'] == 2 and not disabled['can_import']
    assert edit(client, feed, name='Stale').status_code == 409
    assert client.post('/feeds/' + feed['id'] + '/import', json={'revision': 2}).status_code == 409
    assert edit(client, disabled, default_duration=180).json()['default_duration'] == 180
    assert not calls
    assert client.get('/feeds/missing/runs').status_code == 404


@pytest.mark.parametrize('patch', [{'name': ' '}, {'url': 'javascript:x'}, {'url': 'https://a:b@example.com'}, {'url': '//example.com'}, {'default_duration': True}, {'default_duration': 14}, {'default_duration': 3601}])
def test_validation(client, patch):
    assert client.post('/feeds', json={'name': 'Feed', 'url': 'https://example.com/', 'default_duration': 120, **patch}).status_code == 422
    assert client.get('/feeds').json()['feeds'] == []


def test_manual_archived_url_dedup(client):
    idea = client.post('/inbox', json={'text': 'Manual idea', 'duration': 120, 'source_url': 'https://example.com/one#manual', 'notes': 'Keep this'}).json()
    idea = client.post('/inbox/' + idea['id'] + '/archive', json={'revision': 1, 'archived': True}).json()
    result = run(client, create(client))
    assert result['created'] == 1 and result['duplicates'] == 2
    assert client.get('/inbox/' + idea['id']).json() == idea


def test_failure_retry_and_atomic_rollback(client, monkeypatch):
    feed = create(client)
    def fail(url):
        raise rss.FeedError('The feed returned HTTP 503.')
    monkeypatch.setattr(rss, 'fetch_feed', fail)
    failed = run(client, feed)
    assert failed['status'] == 'failed' and '503' in failed['error']
    assert client.get('/inbox').json()['items'] == []
    assert client.get('/feeds/' + feed['id']).json()['can_import']
    monkeypatch.setattr(rss, 'fetch_feed', lambda url: (RSS, url))
    original = feeds.ingest
    def broken(*args):
        original(*args)
        raise RuntimeError('Do not leak this diagnostic')
    monkeypatch.setattr(feeds, 'ingest', broken)
    failed2 = run(client, feed)
    assert failed2['status'] == 'failed' and failed2['created'] == 0
    with db.session() as s:
        assert not s.exec(select(InboxTopic)).all()
        assert not s.exec(select(InboxSource)).all()
        assert not s.exec(select(FeedEntry)).all()
    monkeypatch.setattr(feeds, 'ingest', original)
    assert run(client, feed)['created'] == 2
    assert [r['status'] for r in client.get('/feeds/' + feed['id'] + '/runs').json()['runs']] == ['succeeded', 'failed', 'failed']


def test_concurrent_import_and_expired_lease(client, monkeypatch):
    started, release = threading.Event(), threading.Event()
    def delayed(url):
        started.set()
        assert release.wait(3)
        return RSS, url
    monkeypatch.setattr(rss, 'fetch_feed', delayed)
    feed = create(client)
    with ThreadPoolExecutor() as pool:
        task = pool.submit(run, client, feed)
        assert started.wait(3)
        try:
            assert not client.get('/feeds/' + feed['id']).json()['can_import']
            assert client.post('/feeds/' + feed['id'] + '/import', json={'revision': 1}).status_code == 409
            assert edit(client, feed, enabled=False).status_code == 409
        finally:
            release.set()
        assert task.result()['created'] == 2
    with db.session() as s:
        f = s.get(feeds.RSSFeed, feed['id'])
        assert f
        f.active_run_id = 'interrupted'
        s.add(FeedRun(id='interrupted', feed_id=f.id, started_at=0))
        s.add(f)
        s.commit()
    assert client.get('/feeds/' + feed['id']).json()['can_import']
    assert run(client, feed)['created'] == 0
    with db.session() as s:
        old = s.get(FeedRun, 'interrupted')
        assert old and old.status == 'failed' and old.error


def test_atom_caps_entities_and_invalid_feed():
    atom = b'<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><id>urn:x</id><title>Story</title><link href="/story"/><content type="html">&lt;p&gt;Atom context&lt;/p&gt;</content></entry></feed>'
    entries, warnings = rss.parse_feed(atom, 'https://example.com/feed')
    assert not warnings and isinstance(entries[0], rss.Entry)
    assert entries[0].url == 'https://example.com/story' and entries[0].body == 'Atom context'
    for value in [b'<rss><bad>', b'<html/>', b'<!DOCTYPE rss [<!ENTITY x "boom">]><rss>&x;</rss>', '<!DOCTYPE rss><rss/>'.encode('utf-16')]:
        with pytest.raises(rss.FeedError):
            rss.parse_feed(value, 'https://example.com')
    items = '<item><title>Story</title><link>https://example.com</link><description>' + 'x' * 60000 + '</description></item>'
    entries, _ = rss.parse_feed(('<rss version="2.0"><channel>' + items + '</channel></rss>').encode(), 'https://example.com')
    entry = entries[0]
    assert isinstance(entry, rss.Entry) and entry.truncated and len(entry.body) == 50000
    assert len(feeds.copy_notes(feeds.inbox_notes(entry, 'Feed'), entry.url)) <= 10000
    entries, warnings = rss.parse_feed(('<rss version="2.0"><channel>' + '<item/>' * 101 + '</channel></rss>').encode(), 'https://example.com')
    assert len(entries) == 100 and warnings


def test_private_dns_and_fixture_origin_are_checked(monkeypatch):
    monkeypatch.setattr(rss.socket, 'getaddrinfo', lambda *a, **k: [(2, 1, 6, '', ('127.0.0.1', 80))])
    monkeypatch.setattr(settings, 'rss_test_feed_origin', '')
    with pytest.raises(rss.FeedError, match='private'):
        rss.checked_addresses('http://example.com/feed')
    monkeypatch.setattr(settings, 'rss_test_feed_origin', 'http://127.0.0.1:8168')
    assert rss.checked_addresses('http://127.0.0.1:8168/feed')[2] == ['127.0.0.1']
    with pytest.raises(rss.FeedError):
        rss.checked_addresses('http://127.0.0.1:9/feed')
    with pytest.raises(rss.FeedError):
        rss.checked_addresses('http://example.com:8168/feed')


def test_real_http_fetch_close_redirect_and_limit(monkeypatch):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == '/redirect':
                self.send_response(302)
                self.send_header('Location', '/feed')
                self.end_headers()
                return
            if self.path == '/private':
                self.send_response(302)
                self.send_header('Location', 'http://127.0.0.1:9/blocked')
                self.end_headers()
                return
            self.send_response(200)
            self.send_header('Content-Length', str(rss.MAX_BYTES + 1 if self.path == '/large' else len(RSS)))
            self.end_headers()
            if self.path != '/large':
                self.wfile.write(RSS)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    origin = f'http://127.0.0.1:{server.server_port}'
    monkeypatch.setattr(settings, 'rss_test_feed_origin', origin)
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    try:
        data, url = rss.fetch_feed(origin + '/redirect')
        assert data == RSS and url == origin + '/feed'
        with pytest.raises(rss.FeedError, match='private'):
            rss.fetch_feed(origin + '/private')
        with pytest.raises(rss.FeedError, match='2 MB'):
            rss.fetch_feed(origin + '/large')
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
