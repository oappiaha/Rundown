import httpx
import pytest
from fastapi.testclient import TestClient

from rundown import social_links as links
from rundown.config import settings
from rundown.main import app
from rundown.rss import FeedError


@pytest.fixture(autouse=True)
def reset(monkeypatch):
    monkeypatch.setattr(links, '_last_request', 0)
    monkeypatch.setattr(links, '_cache', {})
    monkeypatch.setattr(settings, 'retrieval_test_origin', '')
    monkeypatch.setattr(settings, 'rss_scheduler_enabled', False)


@pytest.mark.parametrize('url', [
    'https://x.com.evil.test/u/status/123', 'http://x.com/u/status/123',
    'https://x.com:444/u/status/123', 'https://x.com@127.0.0.1/u/status/123',
    'https://x.com/u', 'https://vm.tiktok.com/share123',
    'https://www.tiktok.com/@u', 'https://127.0.0.1/post',
    'https://x.com/u/status/123\\',
])
def test_invalid_never_fetches(url, monkeypatch):
    def fail(*args):
        pytest.fail('Unsupported link caused a network request')
    monkeypatch.setattr(links, 'fetch_preview', fail)
    with TestClient(app) as client:
        assert client.post('/social-links/preview', json={'url': url}).status_code == 422
        assert client.get('/inbox').json()['items'] == []


def test_preview_cache_and_no_write(monkeypatch):
    calls = []
    def fake(platform, url):
        calls.append((platform, url))
        return {'platform': platform, 'source_url': url, 'context': 'Fixture'}
    monkeypatch.setattr(links, 'fetch_preview', fake)
    with TestClient(app) as client:
        r = client.post('/social-links/preview', json={'url': 'https://twitter.com/user/status/123?utm_source=test'})
        assert r.status_code == 200
        assert r.json()['source_url'] == 'https://x.com/user/status/123'
        assert client.post('/social-links/preview', json={'url': r.json()['source_url']}).json() == r.json()
        assert len(calls) == 1
        assert client.post('/social-links/preview', json={'url': 'https://x.com/user/status/124'}).status_code == 429
        assert client.get('/inbox').json()['items'] == []


def test_provider_error_and_busy(monkeypatch):
    def fail(*args):
        raise FeedError('Provider denied access.')
    monkeypatch.setattr(links, 'fetch_preview', fail)
    with TestClient(app) as client:
        r = client.post('/social-links/preview', json={'url': 'https://x.com/user/status/123'})
        assert r.status_code == 502 and r.json()['detail'] == 'Provider denied access.'
        with links._lock:
            assert client.post('/social-links/preview', json={'url': 'https://x.com/user/status/123'}).status_code == 429
        assert client.get('/inbox').json()['items'] == []


@pytest.mark.parametrize('platform', ['x', 'tiktok'])
def test_adapter_fixed_hosts_and_text_only(platform, monkeypatch):
    requests = []
    def handler(request):
        requests.append(request)
        assert not request.headers.get('authorization')
        assert 'key' not in request.url.params
        if platform == 'x':
            assert str(request.url).startswith('https://publish.x.com/oembed?')
            assert request.url.params['omit_script'] == 'true'
            return httpx.Response(200, json={'type': 'rich', 'author_name': 'Fixture', 'html': '<blockquote><p>Hello &amp; world<br>More<script>BAD SCRIPT</script></p>DATE</blockquote><script>BAD WIDGET</script>'})
        assert str(request.url).startswith('https://www.tiktok.com/oembed?')
        return httpx.Response(200, json={'type': 'video', 'author_name': 'Fixture', 'title': 'Caption &amp; context', 'html': '<script>BAD</script>'})
    original = httpx.Client
    monkeypatch.setattr(links.httpx, 'Client', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    url = 'https://x.com/user/status/123' if platform == 'x' else 'https://www.tiktok.com/@user/video/123'
    result = links.fetch_preview(platform, url)
    assert len(requests) == 1
    assert result['text'] == ('Hello & world\nMore' if platform == 'x' else 'Caption & context')
    assert 'BAD' not in str(result) and 'DATE' not in str(result)
    assert result['source_url'] == url and result['mode'] == 'live'


def test_missing_text_and_redirect_rejected(monkeypatch):
    original = httpx.Client
    for response in [httpx.Response(200, json={'type': 'rich', 'html': '<script>widget()</script>'}), httpx.Response(302, headers={'location': 'http://127.0.0.1'})]:
        monkeypatch.setattr(links.httpx, 'Client', lambda response=response, **kwargs: original(transport=httpx.MockTransport(lambda request: response), **kwargs))
        with pytest.raises(FeedError):
            links.fetch_preview('x', 'https://x.com/user/status/123')
