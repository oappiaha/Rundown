"""Link previews: bounded article/TikTok metadata, signed token, additive persistence."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from rundown import link_previews as lp
from rundown import preview_token, rss
from rundown.config import settings
from rundown.main import app

PAGE = '''<!doctype html><html><head><meta charset="utf-8"><title>Fallback</title>
<meta property="og:title" content="Off-white is a decision">
<meta property="og:description" content="Pure white is a lab value.">
<meta property="og:site_name" content="Surface Notes"><meta name="author" content="Tomas Reyes">
<meta property="article:published_time" content="2026-09-22T09:00:00Z">
<meta property="og:image" content="{o}/first.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image" content="{o}/second.png"><meta property="og:image:width" content="300"><meta property="og:image:height" content="300">
<script>var s = '<meta property="og:title" content="SCRIPT">';</script>
</head><body><meta property="og:title" content="BODY"><meta property="og:image" content="{o}/body.png"></body></html>'''
LONG = 'Long ' * 60  # 300 characters
UNICODE_CAPTION = '𝔘𝔫𝔦𝔠𝔬𝔡𝔢 caption ' * 400  # > 6000 characters of 4-byte code points
ORIGIN: dict[str, str] = {}  # the fixture server's own origin, set by the `origin` fixture


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body, ctype='text/html; charset=utf-8', headers=None):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        if not (headers and 'Content-Length' in headers):
            self.send_header('Content-Length', str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = urlparse(self.path)
        o = ORIGIN['url']
        routes = {
            '/page': (200, PAGE.format(o=o).encode()),
            '/long': (200, f'<html><head><meta property="og:title" content="{LONG}"><meta property="og:image" content="/rel.png"></head></html>'.encode()),
            '/notitle': (200, b'<html><head></head><body><h1>x</h1></body></html>'),
            '/forbidden': (403, b'<html><head><meta property="og:title" content="SECRET"></head></html>'),
            '/many': (429, b'<html></html>'),
            '/implied': (200, b'<meta property="og:title" content="Implied head"><meta property="og:image:url" content="' + o.encode() + b'/standalone.png"><meta property="og:image:width" content="50"></head><meta property="og:title" content="AFTER HEAD"><body></body>'),
            '/afterhead': (200, b'<html><head><title>Only title</title></head><meta property="og:image" content="' + o.encode() + b'/late.png"><body></body></html>'),
        }
        if p.path in routes:
            return self.reply(*routes[p.path])
        if p.path == '/json':
            return self.reply(200, b'{"og:title": "x"}', 'application/json')
        if p.path == '/gzip':
            return self.reply(200, b'<html></html>', headers={'Content-Encoding': 'gzip'})
        if p.path == '/badlen':
            return self.reply(200, b'<html></html>', headers={'Content-Length': 'abc'})
        if p.path == '/big-early':
            return self.reply(200, b'<html><head><meta property="og:title" content="Big"></head><body>' + b'x' * (lp.PAGE_BYTES + 5000) + b'</body></html>')
        if p.path == '/big-late':
            return self.reply(200, b'<html><head>' + b'<!-- ' + b'x' * (lp.PAGE_BYTES + 5000) + b' -->' + b'<meta property="og:title" content="Late"></head></html>')
        if p.path in {'/private', '/hop'}:
            self.send_response(302)
            self.send_header('Location', 'http://10.0.0.1/x' if p.path == '/private' else '/page?via=hop')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if p.path == '/tiktok/oembed':
            ident = parse_qs(p.query)['url'][0].rstrip('/').split('/')[-1]
            data = {
                '1': {'type': 'video', 'title': 'Caption <b>bold</b> &amp; text', 'author_name': 'maker', 'thumbnail_url': o + '/p.png', 'thumbnail_width': 360, 'thumbnail_height': 640},
                '2': {'type': 'video', 'title': UNICODE_CAPTION, 'author_name': 'maker', 'thumbnail_url': o + '/p.png', 'thumbnail_width': '360', 'thumbnail_height': 640},
                '3': {'type': 'video', 'title': 'x', 'author_name': {'bad': 1}},
                '4': {'type': 'video', 'title': 'Private image', 'author_name': 'm', 'thumbnail_url': 'http://10.0.0.1/x.png', 'thumbnail_width': '²'},
                '6': {'type': 'video', 'title': 'mid ' * 400, 'author_name': 'm'},
            }.get(ident)
            if ident == '5':
                return self.reply(200, b'{"type": "video", "title": ', 'application/json')
            if data is None:
                return self.reply(403, b'{"error": "private"}', 'application/json')
            return self.reply(200, json.dumps(data).encode(), 'application/json')
        return self.reply(404, b'<html><head><title>NOPE</title></head></html>')


@pytest.fixture
def origin(monkeypatch):
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    url = f'http://127.0.0.1:{server.server_port}'
    ORIGIN['url'] = url
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    monkeypatch.setattr(settings, 'rss_test_feed_origin', url)
    monkeypatch.setattr(settings, 'retrieval_test_origin', url)
    monkeypatch.setattr(settings, 'rss_scheduler_enabled', False)
    monkeypatch.setattr(lp, '_last_request', 0.0)
    monkeypatch.setattr(lp, '_cache', {})
    yield url
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


@pytest.fixture
def client(origin):
    with TestClient(app) as c:
        yield c


def preview(client, url):
    lp._last_request = 0.0
    return client.post('/link-previews/preview', json={'url': url})


def test_article_head_metadata_first_image_and_no_write(client, origin):
    r = preview(client, origin + '/page')
    assert r.status_code == 200, r.json()
    body = r.json()
    assert body['kind'] == 'article' and body['title'] == 'Off-white is a decision'
    assert body['thumbnail'] == {'url': origin + '/first.png', 'width': 1200, 'height': 630}
    assert body['creator'] == 'Tomas Reyes' and body['site_name'] == 'Surface Notes' and body['published_at'] == '2026-09-22T09:00:00Z'
    assert body['source_url'] == body['resolved_url'] == origin + '/page' and body['mode'] == 'fixture'
    assert client.get('/inbox').json()['items'] == []
    hop = preview(client, origin + '/hop').json()
    assert hop['source_url'] == origin + '/hop' and hop['resolved_url'] == origin + '/page?via=hop'


def test_article_long_title_relative_image_and_no_title(client, origin):
    body = preview(client, origin + '/long').json()
    assert len(body['title']) == 299 and body['thumbnail'] == {'url': origin + '/rel.png', 'width': None, 'height': None}
    assert body['creator'] == body['site_name'] == '127.0.0.1'
    assert preview(client, origin + '/notitle').status_code == 502


@pytest.mark.parametrize('path, fragment', [
    ('/forbidden', 'HTTP 403'), ('/many', 'HTTP 429'), ('/nope', 'HTTP 404'), ('/json', 'not an HTML page'),
    ('/gzip', 'compressed'), ('/badlen', 'invalid length'), ('/big-late', 'no title'), ('/private', 'public internet address'),
])
def test_article_failures_are_safe(client, origin, path, fragment):
    r = preview(client, origin + path)
    assert r.status_code == 502 and fragment in r.json()['detail'] and 'SECRET' not in r.json()['detail']


def test_implied_head_and_standalone_image_url(client, origin):
    body = preview(client, origin + '/implied').json()
    assert body['title'] == 'Implied head' and body['thumbnail'] == {'url': origin + '/standalone.png', 'width': 50, 'height': None}
    after = preview(client, origin + '/afterhead').json()
    assert after['title'] == 'Only title' and after['thumbnail'] is None


def test_tiktok_title_cut_marks_truncated(client, origin):
    mid = preview(client, 'https://www.tiktok.com/@maker/video/6').json()
    assert 990 < len(mid['title']) <= 1000 < len(mid['description']) and mid['truncated'] is True and mid['thumbnail'] is None


def test_oversize_head_is_truncated_not_rejected(client, origin):
    body = preview(client, origin + '/big-early').json()
    assert body['title'] == 'Big' and body['truncated'] is True


@pytest.mark.parametrize('url', [
    'https://x.com/user/status/123', 'https://www.tiktok.com/@user', 'ftp://example.com/x', 'http://user:pw@example.com/x',
    'http://example.com/a b', 'not a url',
])
def test_unsupported_links_never_fetch(client, url, monkeypatch):
    monkeypatch.setattr(lp, 'fetch_preview', lambda *a: pytest.fail('fetched'))
    assert preview(client, url).status_code == 422


def test_private_and_loopback_literals_rejected_without_fixture(client, origin):
    for url in ['http://10.0.0.1/x', 'http://127.0.0.1:1/x', 'http://localhost/x']:
        r = preview(client, url)
        assert r.status_code == 502 and 'public internet address' in r.json()['detail']


def test_tiktok_preview_and_edge_cases(client, origin):
    body = preview(client, 'https://www.tiktok.com/@maker/video/1?utm=x').json()
    assert body['kind'] == 'tiktok' and body['title'] == 'Caption bold & text' and body['creator'] == 'maker'
    assert body['thumbnail'] == {'url': origin + '/p.png', 'width': 360, 'height': 640} and body['site_name'] == 'TikTok'
    assert body['source_url'] == 'https://www.tiktok.com/@maker/video/1?utm=x' and body['resolved_url'] == 'https://www.tiktok.com/@maker/video/1'
    huge = preview(client, 'https://www.tiktok.com/@maker/video/2').json()
    assert len(huge['title']) <= 1000 and len(huge['description']) <= 6000 and huge['truncated'] is True and huge['thumbnail']['width'] == 360
    assert preview(client, 'https://www.tiktok.com/@maker/video/3').status_code == 502
    private = preview(client, 'https://www.tiktok.com/@maker/video/4').json()
    assert private['thumbnail'] is None and private['title'] == 'Private image'
    assert preview(client, 'https://www.tiktok.com/@maker/video/5').status_code == 502
    assert preview(client, 'https://www.tiktok.com/@maker/video/9').status_code == 502


def test_rate_limit_cache_and_busy(client, origin):
    assert preview(client, origin + '/page').status_code == 200
    assert client.post('/link-previews/preview', json={'url': origin + '/page'}).status_code == 200  # cached
    assert client.post('/link-previews/preview', json={'url': origin + '/long'}).status_code == 429
    with lp._lock:
        assert client.post('/link-previews/preview', json={'url': origin + '/page'}).status_code == 429


def test_capture_with_token_persists_source_and_presentation(client, origin):
    p = preview(client, origin + '/page').json()
    r = client.post('/inbox/capture', json={'kind': 'link', 'title': 'My own title', 'note': 'my note', 'source_url': origin + '/page', 'preview': p['token']})
    assert r.status_code == 201, r.json()
    item = r.json()
    assert item['capture']['display_title'] == 'My own title' and item['editorial']['note'] == 'my note' and item['source_url'] == origin + '/page'
    assert item['source']['kind'] == 'article' and item['source']['original_title'] == 'Off-white is a decision'
    assert item['source']['entered_url'] == origin + '/page' and item['source']['feed_name'] == 'Surface Notes' and item['source']['creator'] == 'Tomas Reyes'
    assert item['presentation']['provider'] == 'article' and item['presentation']['thumbnail'] == {'url': origin + '/first.png', 'width': 1200, 'height': 630}
    assert item['presentation']['state'] == 'ready' and item['presentation']['excerpt'] == 'Pure white is a lab value.'
    assert client.get(f"/inbox/{item['id']}").json()['source'] == item['source']
    # The list route carries it too, and the legacy manual path is unchanged.
    assert client.get('/inbox').json()['items'][0]['presentation']['provider'] == 'article'
    plain = client.post('/inbox/capture', json={'kind': 'link', 'title': 'Manual', 'note': '', 'source_url': origin + '/forbidden'})
    assert plain.status_code == 201 and plain.json()['source'] is None and plain.json()['presentation'] is None


def test_long_headline_keeps_full_title_in_source(client, origin):
    p = preview(client, origin + '/long').json()
    short = p['title'][:200].strip()
    r = client.post('/inbox/capture', json={'kind': 'link', 'title': short, 'label': 'Long one', 'note': '', 'source_url': origin + '/long', 'preview': p['token']})
    assert r.status_code == 201 and r.json()['source']['original_title'] == p['title'] and len(r.json()['capture']['display_title']) <= 200
    assert r.json()['presentation']['thumbnail'] == {'url': origin + '/rel.png', 'width': None, 'height': None}


def test_unicode_caption_token_roundtrip(client, origin):
    p = preview(client, 'https://www.tiktok.com/@maker/video/2').json()
    assert len(p['token']) <= preview_token.MAX_TOKEN
    r = client.post('/inbox/capture', json={'kind': 'link', 'title': 'Unicode caption', 'note': '', 'source_url': 'https://www.tiktok.com/@maker/video/2', 'preview': p['token']})
    assert r.status_code == 201 and r.json()['source']['body_text'] == p['description'] and r.json()['source']['kind'] == 'tiktok'
    assert r.json()['presentation']['thumbnail'] == {'url': origin + '/p.png', 'width': 360, 'height': 640}


def test_token_binding_expiry_and_malformed(client, origin, monkeypatch):
    p = preview(client, origin + '/page').json()
    tok = p['token']
    def attempt(url, token):
        return client.post('/inbox/capture', json={'kind': 'link', 'title': 'T', 'note': 'kept', 'source_url': url, 'preview': token})
    assert attempt(origin + '/hop', tok).status_code == 409
    assert attempt(origin + '/page?x=1', tok).status_code == 409
    for bad in [tok[:-2] + 'AA', tok.split('.')[0] + '.é', 'nonsense', tok + '.x', 'a.' + 'é' * 43, '.']:
        r = attempt(origin + '/page', bad)
        assert r.status_code == 409, bad[-8:]
    assert client.post('/inbox/capture', json={'kind': 'write', 'title': 'W', 'preview': tok}).status_code == 422
    assert client.post('/inbox/capture', json={'kind': 'link', 'title': 'T', 'source_url': origin + '/page', 'preview': ''}).status_code == 422
    assert client.get('/inbox').json()['items'] == []
    real = time.time
    # A scoped context: monkeypatch.undo() would also drop the isolated-database fixture.
    with monkeypatch.context() as later:
        later.setattr(preview_token.time, 'time', lambda: real() + preview_token.TOKEN_SECONDS + 1)
        r = attempt(origin + '/page', tok)
    assert r.status_code == 409 and 'expired' in r.json()['detail']
    ok = attempt(origin + '/page', tok)
    assert ok.status_code == 201 and ok.json()['editorial']['note'] == 'kept'


def test_token_module_bounds():
    meta = {'kind': 'tiktok', 'source_url': 'https://www.tiktok.com/@x/video/1', 'resolved_url': 'https://www.tiktok.com/@x/video/1',
            'title': '𝔘' * 1000, 'description': '𝔘' * 6000, 'site_name': '𝔘' * 200, 'creator': '𝔘' * 200, 'published_at': 'x' * 120,
            'thumbnail': {'url': 'https://e.example/' + 'x' * 2030, 'width': 1, 'height': 1}, 'truncated': True}
    token, _ = preview_token.issue(meta)
    assert len(token) <= preview_token.MAX_TOKEN
    assert preview_token.verify(token, meta['source_url'])['description'] == meta['description']
    with pytest.raises(preview_token.TokenError):
        preview_token.verify(token.split('.')[0] + '.é', meta['source_url'])


def test_feed_transport_messages_unchanged(monkeypatch):
    monkeypatch.setattr(rss.socket, 'getaddrinfo', lambda *a, **k: [(2, 1, 6, '', ('10.0.0.1', 80))])
    monkeypatch.setattr(settings, 'rss_test_feed_origin', '')
    with pytest.raises(rss.FeedError, match='Feed imports require a public internet address'):
        rss.fetch_feed('http://example.com/feed')
    with pytest.raises(rss.FeedError, match='Link previews require a public internet address'):
        lp.article_preview('http://example.com/page')
