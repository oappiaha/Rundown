import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from rundown import library, show
from rundown.db import session
from rundown.main import app
from rundown.models import Rundown, RundownItemNotes


@pytest.fixture
def client():
    with TestClient(app) as client:
        yield client


def saved(client, name='Friday Live'):
    r = client.post('/shows', json={'name': name, 'topics': [
        {'text': 'Opening', 'duration': 120, 'notes': 'Background\nhttps://example.com/source'},
        {'text': 'Questions', 'duration': 60}]})
    assert r.status_code == 201, r.text
    return r.json()


def live(client):
    r = client.put('/rundown/schedule', json={'revision': 0, 'topics': [
        {'text': 'On air', 'duration': 180, 'notes': 'Live context'}]})
    assert r.status_code == 200, r.text
    r = client.post('/rundown/control', json={'revision': r.json()['revision'], 'action': 'play'})
    assert r.status_code == 200
    return r.json()


def update(client, s, **kwargs):
    return client.put(f'/shows/{s["id"]}', json={
        'revision': s['revision'], 'name': s['name'], 'topics': s['topics'], **kwargs})


def test_saved_lifecycle_never_writes_live_clock(client, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(show.time, 'time', lambda: now[0])
    playing = live(client)
    with session() as db:
        clock = db.get(show.ShowClock, 1)
        assert clock
        baseline = clock.model_dump()
    now[0] += 20
    s = saved(client, '  Friday Live  ')
    assert s['name'] == 'Friday Live' and s['revision'] == 1
    assert client.get(f'/shows/{s["id"]}').json() == s
    assert client.get('/shows').json()['shows'][0]['total_seconds'] == 180
    s['topics'].reverse()
    s['topics'][0]['notes'] = 'Audience questions'
    r = update(client, s, name='Tomorrow')
    assert r.status_code == 200
    changed = r.json()
    assert changed['revision'] == 2 and changed['topics'][0]['notes'] == 'Audience questions'
    duplicate = client.post(f'/shows/{s["id"]}/duplicate', json={'revision': 2, 'name': 'Next week'})
    assert duplicate.status_code == 201
    d = duplicate.json()
    assert d['id'] != s['id'] and d['revision'] == 1
    assert {t['id'] for t in d['topics']}.isdisjoint(t['id'] for t in s['topics'])
    assert [t['notes'] for t in d['topics']] == [t['notes'] for t in changed['topics']]
    with session() as db:
        clock = db.get(show.ShowClock, 1)
        assert clock and clock.model_dump() == baseline  # not even updated_at was touched
        assert len(db.exec(select(Rundown)).all()) == 1
    after = client.get('/rundown/state').json()
    assert after['revision'] == playing['revision'] and after['topics'] == playing['topics']
    assert after['remaining_seconds'] == 160 and not after['paused']
    # Saved drafts can remove every row, including their first topic.
    assert update(client, changed, topics=[]).json()['topics'] == []


def test_copy_live_and_reuse_are_independent(client):
    playing = live(client)
    r = client.post('/shows/from-live', json={'name': 'Saved live', 'live_revision': playing['revision']})
    assert r.status_code == 201
    s = r.json()
    assert s['topics'][0]['notes'] == 'Live context'
    assert s['topics'][0]['id'] != playing['topics'][0]['id']
    # Reuse a topic by copying its content into another show, without its id.
    target = saved(client)
    target['topics'].append({k: v for k, v in s['topics'][0].items() if k != 'id'})
    changed = update(client, target).json()
    assert changed['topics'][-1]['notes'] == 'Live context'
    assert changed['topics'][-1]['id'] != s['topics'][0]['id']
    changed['topics'][-1]['notes'] = 'Different next week'
    assert update(client, changed).status_code == 200
    assert client.get(f'/shows/{s["id"]}').json() == s
    assert client.get('/rundown/state').json()['topics'] == playing['topics']


def test_activate_atomic_paused_copy_and_independent_followup(client):
    playing = live(client)
    s = saved(client)
    r = client.post(f'/shows/{s["id"]}/activate', json={
        'revision': s['revision'], 'live_revision': playing['revision']})
    assert r.status_code == 200, r.text
    active = r.json()
    assert active['paused'] and active['remaining_seconds'] == 120
    assert active['revision'] == playing['revision'] + 1
    assert active['current_topic_id'] == active['topics'][0]['id']
    assert {t['id'] for t in active['topics']}.isdisjoint(t['id'] for t in s['topics'])
    assert active['topics'][0]['notes'] == s['topics'][0]['notes']
    with session() as db:
        assert len(db.exec(select(Rundown)).all()) == 2
        assert any(n.notes == s['topics'][0]['notes'] for n in db.exec(select(RundownItemNotes)).all())
    s['topics'][0]['notes'] = 'Future copy edited'
    assert update(client, s).status_code == 200
    assert client.get('/rundown/state').json()['topics'] == active['topics']
    active['topics'][0]['notes'] = 'Live only'
    assert client.put('/rundown/schedule', json={
        'revision': active['revision'], 'topics': active['topics']}).status_code == 200
    assert client.get(f'/shows/{s["id"]}').json()['topics'][0]['notes'] == 'Future copy edited'


def test_stale_empty_and_missing_operations_preserve(client):
    playing = live(client)
    s = saved(client)
    assert update(client, s, name='Changed').status_code == 200
    assert update(client, s).status_code == 409
    for action in ['duplicate', 'activate']:
        body = {'revision': s['revision']}
        body.update({'name': 'Copy'} if action == 'duplicate' else {'live_revision': playing['revision']})
        assert client.post(f'/shows/{s["id"]}/{action}', json=body).status_code == 409
    assert client.post(f'/shows/{s["id"]}/activate', json={'revision': 2, 'live_revision': 0}).status_code == 409
    empty = client.post('/shows', json={'name': 'Empty'}).json()
    assert client.post(f'/shows/{empty["id"]}/activate', json={
        'revision': 1, 'live_revision': playing['revision']}).status_code == 409
    assert client.post('/shows/from-live', json={'name': 'Stale', 'live_revision': 0}).status_code == 409
    assert client.get('/shows/missing').status_code == 404
    assert client.put('/shows/missing', json={'name': 'Missing', 'revision': 1, 'topics': []}).status_code == 404
    assert client.post('/shows/missing/activate', json={'revision': 1, 'live_revision': 0}).status_code == 404
    assert client.get('/rundown/state').json()['topics'] == playing['topics']
    assert len(client.get('/shows').json()['shows']) == 2


def test_validation_notes_and_ids(client):
    for payload in [{'name': '  '}, {'name': 'x' * 81}, {'name': 'X', 'topics': [{'text': 'Bad', 'duration': True}]},
                    {'name': 'X', 'topics': [{'text': 'Bad', 'duration': 20, 'notes': 'x' * 10001}]},
                    {'name': 'X', 'topics': [{'text': 'Topic', 'duration': 20}] * 21}]:
        assert client.post('/shows', json=payload).status_code == 422
    s = saved(client)
    for topics in [s['topics'] * 2, [{**s['topics'][0], 'id': 'foreign'}]]:
        assert update(client, s, topics=topics).status_code == 422
    assert update(client, s, revision=True).status_code == 422
    assert client.get(f'/shows/{s["id"]}').json() == s
    topics = [{k: v for k, v in t.items() if k != 'notes'} for t in s['topics']]
    r = update(client, s, topics=topics)
    assert r.status_code == 200
    kept = r.json()
    assert kept['topics'][0]['notes'] == s['topics'][0]['notes']
    kept['topics'][0]['notes'] = ''
    assert update(client, kept).json()['topics'][0]['notes'] == ''


def test_concurrent_saved_writes_and_activations_only_one_wins(client):
    playing = live(client)
    s = saved(client)
    with ThreadPoolExecutor(2) as pool:
        statuses = list(pool.map(lambda name: update(client, s, name=name).status_code, ['A', 'B']))
    assert sorted(statuses) == [200, 409]
    with ThreadPoolExecutor(2) as pool:
        statuses = list(pool.map(lambda _: client.post(f'/shows/{s["id"]}/activate', json={
            'revision': 2, 'live_revision': playing['revision']}).status_code, range(2)))
    assert sorted(statuses) == [200, 409]


def test_failed_activation_rolls_back_clock_history_and_source(client, monkeypatch):
    playing = live(client)
    s = saved(client)
    def failed_archive(*args):
        raise RuntimeError('history unavailable')
    monkeypatch.setattr(show, 'archive', failed_archive)
    with pytest.raises(RuntimeError, match='history unavailable'):
        client.post(f'/shows/{s["id"]}/activate', json={'revision': 1, 'live_revision': playing['revision']})
    assert client.get('/rundown/state').json()['topics'] == playing['topics']
    assert client.get(f'/shows/{s["id"]}').json() == s
    with session() as db:
        assert len(db.exec(select(Rundown)).all()) == 1


def test_new_table_preserves_old_clock_and_reopens(client):
    playing = live(client)
    s = saved(client)
    with TestClient(app) as reopened:
        assert reopened.get(f'/shows/{s["id"]}').json() == s
        assert reopened.get('/rundown/state').json()['topics'] == playing['topics']
    with session() as db:
        row = db.get(library.SavedShow, s['id'])
        assert row and json.loads(row.topics_json) == s['topics']
