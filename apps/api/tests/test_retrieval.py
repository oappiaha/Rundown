import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from threading import Event
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from rundown import collectors, db, retrieval, show
from rundown.config import settings
from rundown.main import app
from rundown.models import RetrievalRun, RetrievalSource
from rundown.rss import Entry, FeedError


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(settings, 'retrieval_test_origin', 'http://127.0.0.1:8171')
    monkeypatch.setattr(settings, 'rss_scheduler_enabled', False)
    with TestClient(app) as c:
        yield c


def source(client, **patch):
    r = client.post('/retrieval', json={'name': 'AI research', 'platform': 'youtube', 'query': 'AI', **patch})
    assert r.status_code == 201, r.text
    return r.json()


def collect(client, s, request_id=None):
    return client.post('/retrieval/' + s['id'] + '/import', json={'revision': s['revision'], 'request_id': request_id or str(uuid4())})


def age_runs():
    with retrieval.saved_transaction() as d:
        for r in d.exec(select(RetrievalRun)).all():
            r.started_at -= 3
            d.add(r)


def entry():
    return Entry('youtube:abcdefghijk', 'https://www.youtube.com/watch?v=abcdefghijk', 'Full title about AI innovation and research', 'Description only. Keep original context.', datetime.now(UTC).isoformat(), False)


def test_import_recovery_provenance_dedup_and_live_preservation(client, monkeypatch):
    monkeypatch.setattr(collectors, 'collect', lambda _: ([entry()], 2))
    s = source(client)
    client.put('/rundown/schedule', json={'revision': 0, 'topics': [{'text': 'On air', 'duration': 3600}]})
    client.post('/rundown/control', json={'revision': 1, 'action': 'play'})
    with db.session() as d:
        clock = d.get(show.ShowClock, 1)
        assert clock
        before = clock.model_dump()
    token = str(uuid4())
    r = collect(client, s, token).json()
    assert r['status'] == 'succeeded' and r['created'] == 1 and r['skipped'] == 2
    assert collect(client, s, token).json() == r
    topic = client.get('/inbox').json()['items'][0]
    assert topic['source']['kind'] == 'youtube' and topic['source']['original_title'] == entry().title
    assert entry().body in topic['topic']['notes']
    edited = client.put('/inbox/' + topic['id'], json={'revision': 1, 'text': 'Editorial title', 'notes': 'My notes', 'duration': 90, 'source_url': ''}).json()
    archived = client.post('/inbox/' + topic['id'] + '/archive', json={'revision': edited['revision'], 'archived': True}).json()
    age_runs()
    repeat = collect(client, source(client, name='Second search')).json()
    assert repeat['created'] == 0 and repeat['duplicates'] == 1
    assert client.get('/inbox/' + topic['id']).json() == archived
    with db.session() as d:
        clock = d.get(show.ShowClock, 1)
        assert clock and clock.model_dump() == before


def test_validation_setup_and_stale(client, monkeypatch):
    for patch in [{'query': '', 'scope': ''}, {'scope': 'https://example.com'}, {'platform': 'x'}, {'limit': True}, {'freshness_hours': 0}]:
        assert client.post('/retrieval', json={'name': 'Test', 'platform': 'youtube', 'query': 'ai', **patch}).status_code == 422
    s = source(client)
    monkeypatch.setattr(settings, 'retrieval_test_origin', '')
    monkeypatch.setattr(settings, 'youtube_api_key', '')
    assert collect(client, s).status_code == 503
    fields = {k: s[k] for k in retrieval.SourceEdit.model_fields}
    changed = client.put('/retrieval/' + s['id'], json={**fields, 'enabled': False}).json()
    assert client.put('/retrieval/' + s['id'], json=fields).status_code == 409
    assert collect(client, changed).status_code == 409
    assert client.get('/retrieval').json()['used_today'] == 0


def test_concurrent_recovery_edit_lock_and_daily_limit(client, monkeypatch):
    entered, release = Event(), Event()
    def slow(_):
        entered.set()
        assert release.wait(5)
        return [entry()], 0
    monkeypatch.setattr(collectors, 'collect', slow)
    monkeypatch.setattr(settings, 'retrieval_daily_limit', 1)
    s = source(client)
    token = str(uuid4())
    with ThreadPoolExecutor() as pool:
        future = pool.submit(collect, client, s, token)
        assert entered.wait(5)
        assert collect(client, s, token).json()['status'] == 'running'
        assert collect(client, s).status_code == 409
        fields = {k: s[k] for k in retrieval.SourceEdit.model_fields}
        assert client.put('/retrieval/' + s['id'], json=fields).status_code == 409
        release.set()
        assert future.result().json()['created'] == 1
    age_runs()
    assert collect(client, s).status_code == 429
    assert collect(client, source(client, name='Other'), token).status_code == 409


def test_failure_atomic_and_retry_identity(client, monkeypatch):
    monkeypatch.setattr(collectors, 'collect', lambda _: ([entry()], 0))
    original = retrieval.ingest
    def broken(*args):
        original(*args)
        raise RuntimeError('secret response')
    monkeypatch.setattr(retrieval, 'ingest', broken)
    s, token = source(client), str(uuid4())
    r = collect(client, s, token).json()
    assert r['status'] == 'failed' and 'secret' not in r['error']
    assert client.get('/inbox').json()['items'] == []
    assert collect(client, s, token).json() == r


@pytest.mark.parametrize('platform', ['youtube', 'reddit'])
def test_provider_protocol_and_freshness(client, monkeypatch, platform):
    requests = []
    now = datetime.now(UTC).isoformat()
    def handler(request):
        requests.append(request)
        if request.url.path.endswith('access_token'):
            return httpx.Response(200, json={'access_token': 'fake'})
        if platform == 'youtube':
            if request.url.path.endswith('/videos'):
                assert request.url.params['id'] == 'abcdefghijk'
                return httpx.Response(200, json={'items': [{'id': 'abcdefghijk', 'snippet': {'title': 'AI &amp; fashion', 'description': 'Full video description beyond the excerpt.', 'publishedAt': now}}]})
            rows = [{'id': {'videoId': 'abcdefghijk'}, 'snippet': {'title': 'AI &amp; fashion', 'description': '<p>Details</p>', 'publishedAt': now}}, {'id': {'videoId': 'bad'}}]
            return httpx.Response(200, json={'items': rows})
        rows = [{'data': {'id': 'abc123', 'title': 'AI discussion', 'selftext': 'Full text', 'created_utc': time.time(), 'subreddit': 'technology'}}, {'data': {'id': 'old', 'title': 'Old', 'created_utc': 0}}]
        return httpx.Response(200, json={'data': {'children': rows}})
    factory = httpx.Client
    monkeypatch.setattr(collectors.httpx, 'Client', lambda **kwargs: factory(transport=httpx.MockTransport(handler), **kwargs))
    s = RetrievalSource(id='fixture', name='Test', platform=platform, query='AI', scope='' if platform == 'youtube' else 'technology', created_at=0, updated_at=0)
    entries, skipped = collectors.collect(s)
    assert len(entries) == 1 and skipped == 1
    assert 'have not been retrieved' in entries[0].body
    assert all(r.url.host == '127.0.0.1' for r in requests)
    if platform == 'youtube':
        assert len(requests) == 2
        assert 'beyond the excerpt' in entries[0].body
        assert requests[1].url.params['key'] == 'fixture'
        assert requests[0].url.params['key'] == 'fixture'
        assert requests[0].url.params['type'] == 'video'
    else:
        assert requests[-1].headers['Authorization'] == 'Bearer fake'
        assert requests[-1].url.path == '/r/technology/search'


@pytest.mark.parametrize('status,payload', [(429, {}), (403, {}), (200, {'unexpected': []}), (200, [])])
def test_provider_errors_are_safe(client, monkeypatch, status, payload):
    factory = httpx.Client
    monkeypatch.setattr(collectors.httpx, 'Client', lambda **kwargs: factory(transport=httpx.MockTransport(lambda _: httpx.Response(status, json=payload)), **kwargs))
    r = collect(client, source(client)).json()
    assert r['status'] == 'failed' and r['created'] == 0
    assert not client.get('/inbox').json()['items']


def test_fixture_boundary_and_reddit_setup(monkeypatch):
    monkeypatch.setattr(settings, 'retrieval_test_origin', 'https://example.com')
    with pytest.raises(FeedError):
        collectors.fixture_origin()
    monkeypatch.setattr(settings, 'retrieval_test_origin', '')
    monkeypatch.setattr(settings, 'reddit_api_approved', False)
    assert 'approved' in (collectors.availability('reddit') or '')


@pytest.mark.parametrize('url', ['https://youtu.be/abcdefghijk?t=30', 'https://www.youtube.com/shorts/abcdefghijk'])
def test_manual_permalink_dedup_survives_edit_archive(client, monkeypatch, url):
    monkeypatch.setattr(collectors, 'collect', lambda _: ([entry()], 0))
    item = client.post('/inbox', json={'text': 'Manual capture', 'duration': 120, 'notes': 'My original notes', 'source_url': url}).json()
    s = source(client)
    assert collect(client, s).json()['duplicates'] == 1
    edited = client.put('/inbox/' + item['id'], json={'revision': 1, 'text': item['text'], 'duration': 120, 'notes': item['notes'], 'source_url': ''}).json()
    archived = client.post('/inbox/' + item['id'] + '/archive', json={'revision': edited['revision'], 'archived': True}).json()
    age_runs()
    assert collect(client, s).json()['duplicates'] == 1
    assert client.get('/inbox/' + item['id']).json() == archived
    assert archived['source'] is None


def test_reddit_permalink_identity():
    assert collectors.platform_identity('https://www.reddit.com/r/technology/comments/abc123/a_title/?x=y') == 'reddit:abc123'
    assert collectors.platform_identity('https://redd.it/abc123') == 'reddit:abc123'
    assert collectors.platform_identity('https://reddit.com.evil.example/comments/abc123') is None
