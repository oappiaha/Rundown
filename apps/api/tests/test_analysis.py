import json
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from rundown import analysis
from rundown.config import settings
from rundown.db import session
from rundown.main import app
from rundown.models import ResearchAnalysis


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(settings, 'research_ai_enabled', True)
    monkeypatch.setattr(settings, 'research_ai_model', 'fixture-model')
    monkeypatch.setattr(settings, 'preparation_test_origin', 'http://127.0.0.1:8171')
    monkeypatch.setattr(settings, 'rss_scheduler_enabled', False)
    with TestClient(app) as c:
        yield c


def seed(c, count=3):
    return [c.post('/inbox', json={'text': f'AI story {i}', 'duration': 120,
                                  'notes': 'Saved context for the show angle.', 'source_url': ''}).json()
            for i in range(count)]


def payload(c, items):
    p = {'brief': 'AI news for independent creators', 'selections': [
        {'id': i['id'], 'revision': i['revision'], 'preference_revision': 0} for i in items]}
    preview = c.post('/research/ai/input', json=p)
    assert preview.status_code == 200, preview.text
    return {**p, 'input_hash': preview.json()['input_hash'], 'consent': True, 'request_id': str(uuid4())}


def fake(text, model):
    ids = [i['id'] for i in json.loads(text)['stories']]
    return analysis.Result(items=[analysis.Assessment(id=i, score=90-n, category='ai-innovation',
        group_id=ids[0] if n < 2 else i, reason='Relevant to the saved creator context.')
        for n, i in enumerate(ids)]), 300, 100


def test_generation_idempotent_and_preserves_state(client, monkeypatch):
    monkeypatch.setattr(analysis, 'call_provider', fake)
    items = seed(client)
    before = client.get('/inbox').json()
    p = payload(client, items)
    with ThreadPoolExecutor(2) as pool:
        runs = list(pool.map(lambda _: client.post('/research/ai/generate', json=p), range(2)))
    assert all(r.status_code == 200 for r in runs)
    result = client.get('/research/ai/runs/' + p['request_id']).json()
    assert result['status'] == 'succeeded' and not result['stale']
    assert len(result['items']) == 3 and result['input_tokens'] == 300
    proposed = client.post('/research/ai/runs/' + p['request_id'] + '/propose', json={'count': 3})
    assert proposed.status_code == 200 and len(proposed.json()['items']) == 2
    assert client.get('/inbox').json() == before
    assert client.get('/shows').json()['shows'] == []
    assert client.get('/research/ai').json()['settings']['used_today'] == 1
    assert client.post('/research/ai/generate', json={**p, 'brief': 'Changed editorial focus'}).status_code == 409


def test_stale_input_and_result(client, monkeypatch):
    monkeypatch.setattr(analysis, 'call_provider', fake)
    items = seed(client, 1)
    p = payload(client, items)
    assert client.post('/research/ai/generate', json={**p, 'input_hash': '0'*64}).status_code == 409
    assert client.post('/research/ai/generate', json=p).json()['status'] == 'succeeded'
    i = items[0]
    client.put('/research/' + i['id'] + '/preferences', json={
        'revision': 0, 'category': None, 'priority': 0, 'pinned': False, 'excluded': True})
    assert client.get('/research/ai').json()['latest_run']['stale']
    assert client.post('/research/ai/runs/' + p['request_id'] + '/propose', json={'count': 1}).status_code == 409
    assert client.post('/research/ai/generate', json=p).json()['stale']
    assert client.get('/research/ai').json()['settings']['used_today'] == 1


def test_disabled_budget_failed_and_no_auto_retry(client, monkeypatch):
    p = payload(client, seed(client, 1))
    monkeypatch.setattr(settings, 'research_ai_enabled', False)
    assert client.post('/research/ai/generate', json=p).status_code == 503
    monkeypatch.setattr(settings, 'research_ai_enabled', True)
    monkeypatch.setattr(settings, 'research_ai_daily_limit', 1)
    calls = []
    def failure(*args):
        calls.append(1)
        raise ValueError('untrusted provider text')
    monkeypatch.setattr(analysis, 'call_provider', failure)
    assert client.post('/research/ai/generate', json=p).json()['status'] == 'failed'
    assert client.post('/research/ai/generate', json=p).json()['status'] == 'failed'
    assert calls == [1]
    assert client.post('/research/ai/generate', json={**p, 'request_id': str(uuid4())}).status_code == 429


@pytest.mark.parametrize('change', [{'consent': 1}, {'consent': False}, {'brief': ' '*20},
                                  {'extra': True}, {'selections': []}])
def test_strict_request(client, change):
    p = payload(client, seed(client, 1))
    assert client.post('/research/ai/generate', json={**p, **change}).status_code == 422


def test_expired_run_and_inflight_claim(client, monkeypatch):
    p = payload(client, seed(client, 1))
    with session() as db:
        db.add(ResearchAnalysis(id='other', payload_hash='x', input_hash=p['input_hash'],
               brief=p['brief'], selections_json=json.dumps(p['selections']),
               started_at=time.time(), model='fixture', mode='fixture'))
        db.commit()
    assert client.post('/research/ai/generate', json=p).status_code == 409
    with session() as db:
        r = db.get(ResearchAnalysis, 'other')
        assert r is not None
        r.started_at = time.time()-100
        db.add(r)
        db.commit()
    assert client.get('/research/ai/runs/other').json()['status'] == 'interrupted'
    monkeypatch.setattr(analysis, 'call_provider', fake)
    assert client.post('/research/ai/generate', json=p).json()['status'] == 'succeeded'
    with session() as db:
        previous = db.get(ResearchAnalysis, 'other')
        assert previous is not None and previous.status == 'failed'
        assert len(db.exec(select(ResearchAnalysis)).all()) == 2


def test_manual_pin_category_and_priority_win(client, monkeypatch):
    monkeypatch.setattr(analysis, 'call_provider', fake)
    items = seed(client, 3)
    for i in (items[1], items[2]):
        assert client.put('/research/' + i['id'] + '/preferences', json={
            'revision': 0, 'category': 'film-entertainment', 'priority': 3,
            'pinned': i == items[2], 'excluded': False}).status_code == 200
    p = {'brief': 'AI news for independent creators', 'selections': [
        {'id': i['id'], 'revision': i['revision'], 'preference_revision': int(n > 0)}
        for n, i in enumerate(items)]}
    preview = client.post('/research/ai/input', json=p).json()
    p.update(input_hash=preview['input_hash'], consent=True, request_id=str(uuid4()))
    client.post('/research/ai/generate', json=p)
    proposed = client.post('/research/ai/runs/' + p['request_id'] + '/propose', json={'count': 2}).json()
    assert [r['id'] for r in proposed['items']] == [items[2]['id'], items[1]['id']]
    assert proposed['items'][1]['category'] == 'film-entertainment'


@pytest.mark.parametrize('kind', ['missing', 'duplicate', 'unknown', 'bad_group', 'cycle', 'bool_score', 'blank', 'truncated'])
def test_provider_output_validation(client, monkeypatch, kind):
    from types import SimpleNamespace
    ids = ['a', 'b']
    entries = [{'id': i, 'score': 50, 'category': 'uncategorized', 'group_id': i, 'reason': 'Evidence is limited.'} for i in ids]
    if kind == 'missing':
        entries.pop()
    if kind == 'duplicate':
        entries[1] = entries[0]
    if kind == 'unknown':
        entries[1]['id'] = 'invented'
    if kind == 'bad_group':
        entries[1]['group_id'] = 'invented'
    if kind == 'cycle':
        entries[0]['group_id'], entries[1]['group_id'] = 'b', 'a'
    if kind == 'bool_score':
        entries[0]['score'] = True
    if kind == 'blank':
        entries[0]['reason'] = '  '
    response = SimpleNamespace(stop_reason='max_tokens' if kind == 'truncated' else 'end_turn',
        content=[SimpleNamespace(type='text', text=json.dumps({'items': entries}))],
        usage=SimpleNamespace(input_tokens=20, output_tokens=10))
    class Provider:
        def __init__(self, **kwargs):
            assert kwargs['max_retries'] == 0 and kwargs['api_key'] == 'local-fixture-only'
            self.messages = self
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def create(self, **kwargs): return response
    monkeypatch.setattr(analysis.anthropic, 'Anthropic', Provider)
    with pytest.raises(ValueError):
        analysis.call_provider(json.dumps({'stories': [{'id': i} for i in ids]}), 'fixture-model')


@pytest.mark.parametrize('scores,expected', [
    ([95, 85, 65, 2], [0, 1, 2]),
    ([95, 85, 85, 2], [0, 2, 1]),
])
def test_ai_relevance_precedes_category_variety(client, monkeypatch, scores, expected):
    items = seed(client, 4)
    categories: list[analysis.research.Category] = ['ai-innovation', 'ai-innovation', 'film-entertainment', 'uncategorized']
    def assessed(text, model):
        ids = [i['id'] for i in json.loads(text)['stories']]
        return analysis.Result(items=[
            analysis.Assessment(id=ident, score=scores[n], category=categories[n],
                                group_id=ident, reason='Controlled regression score.')
            for n, ident in enumerate(ids)]), 300, 100
    monkeypatch.setattr(analysis, 'call_provider', assessed)
    p = payload(client, items)
    assert client.post('/research/ai/generate', json=p).json()['status'] == 'succeeded'
    proposed = client.post('/research/ai/runs/' + p['request_id'] + '/propose', json={'count': 3})
    assert proposed.status_code == 200
    assert [r['id'] for r in proposed.json()['items']] == [items[n]['id'] for n in expected]
    # Local rules still favor category variety; AI uses it only for score ties.
    from rundown import research
    rows = [{'id': str(n), 'group_id': str(n), 'created_at': 0,
             'category': categories[n], 'score': score,
             'preferences': {'pinned': False, 'priority': 0}}
            for n, score in enumerate(scores)]
    assert [r['id'] for r in research.select_rows(rows, 3)['items']] == ['0', '2', '3']
