from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from rundown import show
from rundown.main import app


@pytest.fixture
def client():
    with TestClient(app) as client:
        yield client

def seed(client):
    r = client.put('/rundown/schedule', json={'revision': 0, 'topics': [
        {'text': 'Opening', 'duration': 60}, {'text': 'Second', 'duration': 30}]})
    assert r.status_code == 200, r.text
    return r.json()

def command(client, state, action, **extra):
    r = client.post('/rundown/control', json={'revision': state['revision'], 'action': action, **extra})
    assert r.status_code == 200, r.text
    return r.json()

def test_live_insertion_pause_and_reorder(client, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(show.time, 'time', lambda: now[0])
    state = command(client, seed(client), 'play')
    now[0] += 17.25
    current = client.get('/rundown/state').json()
    assert current['remaining_seconds'] == 43
    assert current['revision'] == state['revision']
    topics = current['topics']
    topics.insert(1, {'text': 'Breaking', 'duration': 45})
    r = client.put('/rundown/schedule', json={'revision': current['revision'], 'topics': topics})
    assert r.status_code == 200
    inserted = r.json()
    assert inserted['current_topic_id'] == state['current_topic_id']
    assert inserted['remaining_seconds'] == 43 and not inserted['paused']
    paused = command(client, inserted, 'pause')
    now[0] += 200
    assert client.get('/rundown/state').json()['remaining_seconds'] == 43
    paused['topics'].reverse()
    changed = client.put('/rundown/schedule', json={'revision': paused['revision'], 'topics': paused['topics']}).json()
    assert changed['paused'] and changed['current_topic_id'] == state['current_topic_id']

def test_invalid_stale_and_active_removal_preserve(client):
    state = seed(client)
    for revision, topics, status in [
        (0, state['topics'], 409), (state['revision'], state['topics'][1:], 409),
        (state['revision'], [{'text': '  ', 'duration': 90}], 422),
        (state['revision'], state['topics'] * 2, 422),
        (state['revision'], [{'id': 'foreign', 'text': 'Other', 'duration': 90}], 422),
        (state['revision'], [{'text': 'bad', 'duration': 15.1}], 422)]:
        assert client.put('/rundown/schedule', json={'revision': revision, 'topics': topics}).status_code == status
        after = client.get('/rundown/state').json()
        assert after['topics'] == state['topics'] and after['revision'] == state['revision']

def test_clock_catches_up_once_and_end(client, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(show.time, 'time', lambda: now[0])
    state = command(client, seed(client), 'play')
    now[0] += 65
    advanced = client.get('/rundown/state').json()
    assert advanced['current_topic_id'] == state['topics'][1]['id']
    assert advanced['remaining_seconds'] == 25 and advanced['revision'] == state['revision'] + 1
    assert client.get('/rundown/state').json() == advanced
    now[0] += 40
    done = client.get('/rundown/state').json()
    assert done['paused'] and done['remaining_seconds'] == 0
    restarted = command(client, done, 'play')
    assert restarted['remaining_seconds'] == 30
    reset = command(client, restarted, 'reset')
    assert reset['paused'] and reset['remaining_seconds'] == 60

def test_transport_and_duration_edit(client, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(show.time, 'time', lambda: now[0])
    state = seed(client)
    assert command(client, state, 'previous')['revision'] == state['revision']
    state = command(client, state, 'next')
    assert state['paused'] and state['remaining_seconds'] == 30
    state = command(client, state, 'jump', topic_id=state['topics'][0]['id'])
    state = command(client, state, 'play')
    now[0] += 20
    state['topics'][0]['duration'] = 30
    changed = client.put('/rundown/schedule', json={'revision': state['revision'], 'topics': state['topics']}).json()
    assert changed['remaining_seconds'] == 10
    assert client.post('/rundown/control', json={'revision': changed['revision'], 'action': 'jump', 'topic_id': 'bad'}).status_code == 422

def test_concurrent_edits_only_one_wins(client):
    state = seed(client)
    def save(title):
        topics = state['topics'] + [{'text': title, 'duration': 60}]
        return client.put('/rundown/schedule', json={'revision': state['revision'], 'topics': topics}).status_code
    with ThreadPoolExecutor(2) as executor:
        statuses = list(executor.map(save, ['One', 'Two']))
    assert sorted(statuses) == [200, 409]
    assert len(client.get('/rundown/state').json()['topics']) == 3

def test_empty_restart_and_legacy_read(client):
    assert client.get('/rundown/state').json()['topics'] == []
    assert client.post('/rundown/control', json={'revision': 0, 'action': 'play'}).status_code == 409
    state = seed(client)
    with TestClient(app) as restarted:
        after = restarted.get('/rundown/state').json()
        assert after['topics'] == state['topics'] and after['current_topic_id'] == state['current_topic_id']
    assert client.get('/rundown/topics').json()['topics'] == [
        {'text': t['text'], 'duration': t['duration']} for t in state['topics']]


def test_schedule_failure_rolls_back_both_clock_and_history(client, monkeypatch):
    state = seed(client)
    def fail(*args, **kwargs):
        raise RuntimeError('simulated history failure')
    monkeypatch.setattr(show, 'archive', fail)
    with pytest.raises(RuntimeError, match='simulated history failure'):
        client.put('/rundown/schedule', json={'revision': state['revision'], 'topics':
            state['topics'] + [{'text': 'Not saved', 'duration': 60}]})
    after = client.get('/rundown/state').json()
    assert after['topics'] == state['topics'] and after['revision'] == state['revision']


def test_notes_roundtrip_edit_clear_and_clock_preservation(client, monkeypatch):
    from sqlmodel import select

    from rundown.db import session
    from rundown.models import RundownItemNotes

    now = [1000.0]
    monkeypatch.setattr(show.time, 'time', lambda: now[0])
    state = command(client, seed(client), 'play')
    now[0] += 12
    notes = 'Background: new launch\n• Ask about availability\nhttps://example.com/report\n<b>literal</b>  '
    state['topics'][0]['notes'] = notes
    updated = client.put('/rundown/schedule', json={
        'revision': state['revision'], 'topics': state['topics']}).json()
    assert updated['topics'][0]['notes'] == notes
    assert updated['remaining_seconds'] == 48 and not updated['paused']
    assert updated['current_topic_id'] == state['current_topic_id']
    assert client.get('/rundown/state').json()['topics'][0]['notes'] == notes
    with session() as db:
        stored = db.exec(select(RundownItemNotes)).all()
        assert len(stored) == 1 and stored[0].notes == notes
    # Older clients that omit context preserve it, including after a reorder.
    topics = [{k: v for k, v in t.items() if k != 'notes'} for t in updated['topics']]
    topics.reverse()
    kept = client.put('/rundown/schedule', json={
        'revision': updated['revision'], 'topics': topics}).json()
    assert kept['topics'][1]['notes'] == notes
    kept['topics'][1]['notes'] = ''
    cleared = client.put('/rundown/schedule', json={
        'revision': kept['revision'], 'topics': kept['topics']}).json()
    assert cleared['topics'][1]['notes'] == ''
    assert cleared['current_topic_id'] == state['current_topic_id']
    with session() as db:
        assert all(row.notes == notes for row in db.exec(select(RundownItemNotes)).all())


def test_notes_validation_and_stale_write_preserve_state(client):
    state = seed(client)
    for bad in [None, 12, ['point'], {'body': 'bad'}, 'x' * 10001]:
        topics = [{**t, 'notes': bad} for t in state['topics']]
        r = client.put('/rundown/schedule', json={'revision': state['revision'], 'topics': topics})
        assert r.status_code == 422
        assert client.get('/rundown/state').json()['topics'] == state['topics']
    state['topics'][1]['notes'] = '🎙' * 10000
    r = client.put('/rundown/schedule', json={'revision': state['revision'], 'topics': state['topics']})
    assert r.status_code == 200
    saved = r.json()
    state['topics'][1]['notes'] = 'stale overwrite'
    assert client.put('/rundown/schedule', json={
        'revision': state['revision'], 'topics': state['topics']}).status_code == 409
    assert client.get('/rundown/state').json()['topics'] == saved['topics']


def test_old_clock_and_history_notes_bootstrap(client):
    import json

    from sqlmodel import select

    from rundown.db import session
    from rundown.models import RundownItem, RundownItemNotes

    state = seed(client)
    with session() as db:
        clock = db.get(show.ShowClock, 1)
        assert clock is not None
        clock.topics_json = json.dumps([{k: v for k, v in t.items() if k != 'notes'}
                                      for t in state['topics']])
        db.add(clock)
        db.commit()
    old = client.get('/rundown/state').json()
    assert all(t['notes'] == '' for t in old['topics'])
    assert old['revision'] == state['revision']
    old['topics'][0]['notes'] = 'Archived background\nhttps://example.com/source'
    r = client.put('/rundown/schedule', json={'revision': old['revision'], 'topics': old['topics']})
    assert r.status_code == 200
    with session() as db:
        clock = db.get(show.ShowClock, 1)
        assert clock is not None
        db.delete(clock)
        db.commit()
    restored = client.get('/rundown/state').json()
    assert restored['topics'][0]['notes'] == old['topics'][0]['notes']
    assert restored['topics'][1]['notes'] == ''
    with session() as db:
        assert len(db.exec(select(RundownItem)).all()) == 4
        assert len(db.exec(select(RundownItemNotes)).all()) == 1
