import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from rundown import db, preparation, show
from rundown.config import settings
from rundown.main import app
from rundown.models import InboxSource, PreparationRun, RSSFeed


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(settings, 'preparation_enabled', True)
    monkeypatch.setattr(settings, 'preparation_model', 'fixture-model')
    monkeypatch.setattr(settings, 'preparation_daily_limit', 10)
    monkeypatch.setattr(settings, 'preparation_test_origin', 'http://127.0.0.1:8172')
    monkeypatch.setattr(preparation, 'call_provider', lambda *args: (
        preparation.Suggestion(summary='A useful summary.', talking_points=['First question?', 'Second?', 'Third?']), 123, 87))
    with TestClient(app) as client:
        yield client


def idea(client, notes='Saved evidence provides useful background for the show.'):
    return client.post('/inbox', json={'text': 'Creative tools', 'duration': 120, 'notes': notes, 'source_url': 'https://example.com/story'}).json()


def generate(client, item, request_id=None, **patch):
    return client.post(f"/preparation/topics/{item['id']}/generate", json={
        'revision': item['revision'], 'request_id': request_id or str(uuid4()), 'consent': True, **patch})


def test_generate_is_separate_idempotent_and_durable(client, monkeypatch):
    item = idea(client)
    client.put('/rundown/schedule', json={'revision': 0, 'topics': [{'text': 'On air', 'duration': 3600}]})
    client.post('/rundown/control', json={'revision': 1, 'action': 'play'})
    with db.session() as s:
        clock = s.get(show.ShowClock, 1)
        assert clock
        before = clock.model_dump()
    preview = client.get(f"/preparation/topics/{item['id']}").json()
    calls = []
    def provider(text, model):
        calls.append(text)
        return preparation.Suggestion(summary='Summary', talking_points=['One', 'Two', 'Three']), 10, 20
    monkeypatch.setattr(preparation, 'call_provider', provider)
    req = str(uuid4())
    run = generate(client, item, req).json()
    assert run['status'] == 'succeeded' and not run['stale']
    assert calls == [preview['input_text']]
    assert generate(client, item, req).json() == run
    assert len(calls) == 1 and client.get('/preparation/status').json()['used_today'] == 1
    assert client.get('/inbox/' + item['id']).json() == item
    assert client.get(f"/preparation/topics/{item['id']}").json()['latest_run'] == run
    other = idea(client)
    assert generate(client, other, req).status_code == 409
    with db.session() as s:
        clock = s.get(show.ShowClock, 1)
        assert clock and clock.model_dump() == before


def test_disabled_key_model_cap_consent_input_and_stale(client, monkeypatch):
    item = idea(client)
    assert generate(client, item, consent=False).status_code == 422
    assert generate(client, item, consent=1).status_code == 422
    assert generate(client, item, request_id='bad').status_code == 422
    assert generate(client, item, revision=2).status_code == 409
    empty = idea(client, '')
    assert generate(client, empty).status_code == 422
    monkeypatch.setattr(settings, 'preparation_enabled', False)
    assert generate(client, item).status_code == 503
    monkeypatch.setattr(settings, 'preparation_enabled', True)
    monkeypatch.setattr(settings, 'preparation_model', '')
    assert not client.get('/preparation/status').json()['ready']
    monkeypatch.setattr(settings, 'preparation_model', 'fixture-model')
    monkeypatch.setattr(settings, 'preparation_test_origin', '')
    monkeypatch.setattr(settings, 'anthropic_api_key', '')
    assert not client.get('/preparation/status').json()['ready']
    monkeypatch.setattr(settings, 'preparation_test_origin', 'http://127.0.0.1:8172')
    monkeypatch.setattr(settings, 'preparation_daily_limit', 1)
    assert generate(client, item).json()['status'] == 'succeeded'
    assert generate(client, item).status_code == 429
    assert client.get('/preparation/status').json()['remaining_today'] == 0
    # Failed/started attempts count even after a restart, not in-process counters.
    monkeypatch.setattr(settings, 'preparation_daily_limit', 10)
    archived = client.post(f"/inbox/{item['id']}/archive", json={'revision': 1, 'archived': True}).json()
    assert generate(client, archived).status_code == 409
    assert client.get(f"/preparation/topics/{item['id']}").json()['latest_run']['stale']


def test_failures_are_durable_safe_and_not_retried(client, monkeypatch):
    item = idea(client)
    calls = []
    def bad(*args):
        calls.append(1)
        raise ValueError('SECRET remote body')
    monkeypatch.setattr(preparation, 'call_provider', bad)
    r = generate(client, item)
    assert r.status_code == 200 and r.json()['status'] == 'failed'
    assert 'SECRET' not in r.text and len(calls) == 1
    assert client.get('/inbox/' + item['id']).json() == item
    assert client.get(f"/preparation/topics/{item['id']}").json()['latest_run'] == r.json()


def test_concurrent_request_lease_cap_and_changed_idea(client, monkeypatch):
    item = idea(client)
    entered, release = threading.Event(), threading.Event()
    def slow(*args):
        entered.set()
        assert release.wait(5)
        return preparation.Suggestion(summary='Summary', talking_points=['One', 'Two', 'Three']), 1, 2
    monkeypatch.setattr(preparation, 'call_provider', slow)
    req = str(uuid4())
    with ThreadPoolExecutor() as pool:
        future = pool.submit(generate, client, item, req)
        assert entered.wait(5)
        assert generate(client, item).status_code == 409
        assert generate(client, item, req).json()['status'] == 'running'
        monkeypatch.setattr(settings, 'preparation_daily_limit', 1)
        assert generate(client, idea(client)).status_code == 429
        edit = {k: item[k] for k in ['revision', 'text', 'duration', 'notes', 'source_url']}
        edit['notes'] = 'Changed while generating, preserve these edits.'
        assert client.put('/inbox/' + item['id'], json=edit).status_code == 200
        release.set()
        result = future.result().json()
    assert result['status'] == 'succeeded' and result['stale']
    assert client.get('/inbox/' + item['id']).json()['notes'] == edit['notes']


def test_interrupted_run_recovery_never_retries_same_id(client):
    item = idea(client)
    req = str(uuid4())
    with db.session() as s:
        s.add(PreparationRun(id=req, topic_id=item['id'], revision=1, started_at=time.time()-100, model='fixture-model'))
        s.commit()
    assert generate(client, item, req).json()['status'] == 'interrupted'
    assert client.get(f"/preparation/topics/{item['id']}").json()['can_generate']
    assert generate(client, item).json()['status'] == 'succeeded'
    with db.session() as s:
        old = s.get(PreparationRun, req)
        assert old and old.status == 'failed'


def test_source_preview_bound_and_original_preservation(client):
    item = idea(client, 'User angle ' * 700)
    with db.session() as s:
        s.add(RSSFeed(id='f', name='Fixture', url='https://example.com/rss', created_at=0, updated_at=0))
        s.add(InboxSource(inbox_topic_id=item['id'], feed_id='f', feed_name='Fixture', original_title='Full original', body_text='Evidence ' * 6000, imported_at=0, truncated=True))
        s.commit()
    before = client.get('/inbox/' + item['id']).json()
    view = client.get(f"/preparation/topics/{item['id']}").json()
    assert len(view['input_text']) == 12000 and view['input_truncated']
    assert 'Evidence' in view['input_text'] and 'Saved context:' in view['input_text']
    assert generate(client, item).json()['input_truncated']
    assert client.get('/inbox/' + item['id']).json() == before


@pytest.mark.parametrize('origin', ['https://127.0.0.1:9', 'http://example.com:9', 'http://127.0.0.1:9/path', 'http://user:pass@127.0.0.1:9', 'http://localhost:9'])
def test_fixture_origin_restricted(client, monkeypatch, origin):
    monkeypatch.setattr(settings, 'preparation_test_origin', origin)
    assert not client.get('/preparation/status').json()['ready']


def test_real_sdk_contract_timeout_retries_and_json(monkeypatch):
    monkeypatch.setattr(settings, 'preparation_test_origin', 'http://127.0.0.1:8172')
    monkeypatch.setattr(settings, 'anthropic_api_key', 'must-not-leave-process')
    calls = []
    def handler(request):
        calls.append(request)
        assert request.headers['x-api-key'] == 'local-fixture-only'
        payload = json.loads(request.content)
        assert payload['max_tokens'] == 1200 and payload['messages'][0]['content'] == 'Evidence'
        return httpx.Response(503, json={'type': 'error', 'error': {'type': 'overloaded_error', 'message': 'fixture'}})
    class FixtureClient(httpx.Client):
        def __init__(self, **kw):
            super().__init__(transport=httpx.MockTransport(handler), **kw)
    monkeypatch.setattr(httpx, 'Client', FixtureClient)
    with pytest.raises(preparation.anthropic.APIStatusError):
        preparation.call_provider('Evidence', 'fixture-model')
    assert len(calls) == 1


@pytest.mark.parametrize('value', [
    {'summary': ' ', 'talking_points': ['a', 'b', 'c']},
    {'summary': 'Valid', 'talking_points': ['a', 'b']},
    {'summary': 'Valid', 'talking_points': ['a', ' ', 'c']},
    {'summary': 'Valid', 'talking_points': ['x' * 501, 'b', 'c']},
    {'summary': 'x' * 1501, 'talking_points': ['a', 'b', 'c']},
    {'summary': 'Valid', 'talking_points': ['a', 'b', 'c'], 'action': 'publish'},
])
def test_reject_invalid_provider_suggestions(value):
    with pytest.raises(preparation.ValidationError):
        preparation.Suggestion.model_validate(value)
