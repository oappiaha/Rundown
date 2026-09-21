import json
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from rundown import show_preparation as prep
from rundown.config import settings
from rundown.main import app


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(settings, 'preparation_enabled', True)
    monkeypatch.setattr(settings, 'preparation_model', 'fixture-model')
    monkeypatch.setattr(settings, 'preparation_test_origin', 'http://127.0.0.1:8161')
    monkeypatch.setattr(settings, 'rss_scheduler_enabled', False)
    with TestClient(app) as c:
        yield c


def show(c, notes='Original private context\nSource: https://example.com/source'):
    r = c.post('/shows', json={'name': 'Prepared show', 'topics': [
        {'text': 'Creator story', 'duration': 120, 'notes': notes},
        {'text': 'Film story', 'duration': 90, 'notes': 'Another original context.'}]})
    assert r.status_code == 201
    return r.json()


def payload(c, saved):
    r = c.post(f"/preparation/shows/{saved['id']}/input", json={'revision': saved['revision']})
    assert r.status_code == 200, r.text
    return {'revision': saved['revision'], 'input_hash': r.json()['input_hash'],
            'request_id': str(uuid4()), 'consent': True}


def fake(text, model):
    data = json.loads(text)
    return prep.PreparedResult(items=[prep.PreparedItem(id=t['id'], summary='Grounded summary.',
        talking_points=['Question one?', 'Question two?', 'What remains uncertain?'])
        for t in data['topics']]), 200, 300


def generate(c, saved, monkeypatch):
    monkeypatch.setattr(prep, 'call_provider', fake)
    p = payload(c, saved)
    r = c.post(f"/preparation/shows/{saved['id']}/generate", json=p)
    assert r.status_code == 200 and r.json()['status'] == 'succeeded', r.text
    return r.json(), p


def test_complete_review_apply_retry_preserves(client, monkeypatch):
    saved = show(client)
    live = client.get('/rundown/state').json()
    run, p = generate(client, saved, monkeypatch)
    assert client.get('/shows/' + saved['id']).json() == saved
    assert client.get('/preparation/status').json()['used_today'] == 1
    assert client.post(f"/preparation/shows/{saved['id']}/generate", json=p).json() == run
    selected = run['items'][:1]
    selected[0]['summary'] = 'My reviewed version'
    path = f"/preparation/shows/{saved['id']}/runs/{run['id']}/apply"
    body = {'revision': saved['revision'], 'items': selected}
    with ThreadPoolExecutor(2) as pool:
        replies = list(pool.map(lambda _: client.post(path, json=body), range(2)))
    assert all(r.status_code == 200 for r in replies)
    result = replies[0].json()
    assert result['revision'] == saved['revision'] + 1
    assert result['topics'][0]['notes'].startswith(saved['topics'][0]['notes'])
    assert result['topics'][0]['notes'].count('My reviewed version') == 1
    assert result['topics'][1] == saved['topics'][1]
    assert [{k: t[k] for k in ('id', 'text', 'duration')} for t in result['topics']] == [
        {k: t[k] for k in ('id', 'text', 'duration')} for t in saved['topics']]
    assert client.get('/rundown/state').json()['topics'] == live['topics']
    assert client.get(f"/preparation/shows/{saved['id']}").json()['latest_run']['applied_revision'] == result['revision']
    body['items'][0]['summary'] = 'Different version'
    assert client.post(path, json=body).status_code == 409


def test_stale_and_overflow_atomic(client, monkeypatch):
    saved = show(client, notes='x' * 9900)
    run, _ = generate(client, saved, monkeypatch)
    path = f"/preparation/shows/{saved['id']}/runs/{run['id']}/apply"
    assert client.post(path, json={'revision': 1, 'items': run['items']}).status_code == 422
    assert client.get('/shows/' + saved['id']).json() == saved
    client.put('/shows/' + saved['id'], json={'name': 'Edited', 'revision': 1, 'topics': saved['topics']})
    assert client.get(f"/preparation/shows/{saved['id']}").json()['latest_run']['stale']
    assert client.post(path, json={'revision': 2, 'items': run['items']}).status_code == 409


def test_source_edit_during_generation(client, monkeypatch):
    saved = show(client)
    def editing(text, model):
        response = client.put('/shows/' + saved['id'], json={'name': 'Changed during request',
                            'revision': 1, 'topics': saved['topics']})
        assert response.status_code == 200
        return fake(text, model)
    monkeypatch.setattr(prep, 'call_provider', editing)
    p = payload(client, saved)
    result = client.post(f"/preparation/shows/{saved['id']}/generate", json=p).json()
    assert result['status'] == 'succeeded' and result['stale']
    assert client.post(f"/preparation/shows/{saved['id']}/runs/{result['id']}/apply",
                       json={'revision': 2, 'items': result['items']}).status_code == 409


def test_failed_request_and_shared_quota(client, monkeypatch):
    saved = show(client)
    monkeypatch.setattr(settings, 'preparation_daily_limit', 1)
    calls = []
    def fail(*args):
        calls.append(1)
        raise ValueError('bad model response')
    monkeypatch.setattr(prep, 'call_provider', fail)
    p = payload(client, saved)
    path = f"/preparation/shows/{saved['id']}/generate"
    assert client.post(path, json=p).json()['status'] == 'failed'
    assert client.post(path, json=p).json()['status'] == 'failed'
    assert calls == [1]
    assert client.post(path, json={**p, 'request_id': str(uuid4())}).status_code == 429
    topic = client.post('/inbox', json={'text': 'Inbox topic', 'duration': 60,
                                      'notes': 'Sufficient context for preparation.'}).json()
    assert client.post(f"/preparation/topics/{topic['id']}/generate", json={
        'revision': 1, 'consent': True, 'request_id': str(uuid4())}).status_code == 429


@pytest.mark.parametrize('change', [{'consent': 1}, {'revision': True}, {'extra': 1}, {'input_hash': 'x'}])
def test_strict_generate(client, change):
    saved = show(client)
    assert client.post(f"/preparation/shows/{saved['id']}/generate", json={**payload(client, saved), **change}).status_code == 422


def test_empty_disabled_stale_hash_and_cross_show(client, monkeypatch):
    empty = client.post('/shows', json={'name': 'Empty', 'topics': []}).json()
    assert client.post(f"/preparation/shows/{empty['id']}/input", json={'revision': 1}).status_code == 422
    saved = show(client)
    p = payload(client, saved)
    path = f"/preparation/shows/{saved['id']}/generate"
    assert client.post(path, json={**p, 'input_hash': '0'*64}).status_code == 409
    monkeypatch.setattr(settings, 'preparation_enabled', False)
    assert client.post(path, json=p).status_code == 503
    monkeypatch.setattr(settings, 'preparation_enabled', True)
    run, _ = generate(client, saved, monkeypatch)
    assert client.get(f"/preparation/shows/{empty['id']}/runs/{run['id']}").status_code == 404
    bad = [{**run['items'][0], 'id': 'invented'}]
    assert client.post(f"/preparation/shows/{saved['id']}/runs/{run['id']}/apply",json={'revision': 1, 'items': bad}).status_code == 422
