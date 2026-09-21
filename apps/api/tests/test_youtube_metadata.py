import time
from datetime import UTC, datetime

import httpx
import pytest

from rundown import collectors
from rundown.config import settings
from rundown.models import RetrievalSource
from rundown.rss import FeedError

A, B, C = 'abcdefghijk', 'lmnopqrstuv', '12345678901'


def source(limit=50):
    return RetrievalSource(id='test', name='Test', platform='youtube', query='AI',
                           limit=limit, created_at=0, updated_at=0)


def video(ident, body: object = 'Full description', **patch):
    return {'id': ident, 'snippet': {'title': 'Title ' + ident, 'description': body,
                                    'publishedAt': datetime.now(UTC).isoformat(), **patch}}


def transport(monkeypatch, ids, payload, status=200):
    monkeypatch.setattr(settings, 'retrieval_test_origin', '')
    monkeypatch.setattr(settings, 'youtube_api_key', 'test-only-key')
    requests = []
    def handler(request):
        requests.append(request)
        assert request.url.host == 'www.googleapis.com'
        assert request.url.params['key'] == 'test-only-key'
        if request.url.path.endswith('/search'):
            return httpx.Response(200, json={'items': [
                {'id': {'videoId': ident}, 'snippet': {'title': 'Search excerpt', 'description': 'SHORT EXCERPT'}}
                for ident in ids]})
        assert request.url.path == '/youtube/v3/videos'
        assert request.url.params['part'] == 'snippet'
        assert 'maxResults' not in request.url.params
        return httpx.Response(status, json=payload)
    original = httpx.Client
    monkeypatch.setattr(collectors.httpx, 'Client', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    return requests


def test_join_by_identity_order_missing_and_unrequested(monkeypatch):
    requests = transport(monkeypatch, [A, B, C], {'items': [video(B, 'Body B'), video('outside0000'), video(A, 'Body A')]})
    entries, skipped = collectors.collect(source())
    assert [e.identity for e in entries] == ['youtube:' + A, 'youtube:' + B]
    assert 'Body A' in entries[0].body and 'Body B' in entries[1].body
    assert skipped == 1
    assert requests[1].url.params['id'] == ','.join([A, B, C])
    assert all('SHORT EXCERPT' not in e.body for e in entries)


def test_limit_unique_batch_and_invalid_ids(monkeypatch):
    requests = transport(monkeypatch, [A, A, B, 'bad', C], {'items': [video(A), video(B)]})
    entries, skipped = collectors.collect(source(4))
    assert requests[1].url.params['id'] == A + ',' + B
    assert len(entries) == 3 and skipped == 2  # duplicate entries still handled by importer
    assert len(requests) == 2


@pytest.mark.parametrize('ids', [[], ['invalid'], [None]])
def test_no_metadata_request_without_valid_ids(monkeypatch, ids):
    requests = transport(monkeypatch, ids, {})
    entries, skipped = collectors.collect(source())
    assert entries == [] and skipped == len(ids) and len(requests) == 1


def test_text_limits_empty_and_freshness(monkeypatch):
    transport(monkeypatch, [A, B, C], {'items': [
        video(A, 'x' * 7000, title='t' * 1200),
        video(B, ''),
        video(C, 'Old', publishedAt=datetime.fromtimestamp(time.time() - 40*86400, UTC).isoformat())]})
    entries, skipped = collectors.collect(source())
    assert len(entries) == 2 and skipped == 1
    assert len(entries[0].body) == 6000 and len(entries[0].title) == 1000 and entries[0].truncated
    assert 'No description provided' in entries[1].body and not entries[1].truncated


@pytest.mark.parametrize('payload,status', [
    ({'unexpected': []}, 200), ({'items': {}}, 200),
    ({'items': [video(A), video(A)]}, 200), ({'error': 'SECRET'}, 403),
    ({'error': 'SECRET'}, 429), ({}, 302),
])
def test_batch_failure_never_falls_back(monkeypatch, payload, status):
    transport(monkeypatch, [A], payload, status)
    with pytest.raises(FeedError) as error:
        collectors.collect(source())
    assert 'SECRET' not in str(error.value) and 'test-only-key' not in str(error.value)


def test_bad_individual_metadata_skips(monkeypatch):
    transport(monkeypatch, [A, B, C], {'items': [
        {'id': A, 'snippet': None}, video(B, ['not text']),
        video(C, 'Valid text'), None, {'id': ['bad']}]})
    entries, skipped = collectors.collect(source())
    assert [e.identity for e in entries] == ['youtube:' + C]
    assert skipped == 2
