from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from rundown import db, show
from rundown.main import app
from rundown.models import Rundown, RundownItemNotes


@pytest.fixture
def client():
    with TestClient(app) as client:
        yield client


def capture(client, **patch):
    return client.post('/inbox', json={
        'text': '  Creative tools  ', 'duration': 120,
        'notes': '背景\nWhat changes for creators?\n',
        'source_url': ' https://example.com/story?x=1&y=2#section ', **patch})


def edit(client, item, **patch):
    return client.put('/inbox/' + item['id'], json={
        k: patch.get(k, item[k]) for k in ('revision', 'text', 'duration', 'notes', 'source_url')})


def archive(client, item, archived=True, **patch):
    return client.post('/inbox/' + item['id'] + '/archive', json={
        'revision': item['revision'], 'archived': archived, **patch})


def test_lifecycle_and_clock_preservation(client, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(show.time, 'time', lambda: now[0])
    live = client.put('/rundown/schedule', json={'revision': 0, 'topics': [
        {'text': 'On air', 'duration': 3600, 'notes': 'Already live'}]}).json()
    client.post('/rundown/control', json={'revision': live['revision'], 'action': 'play'})
    with db.session() as s:
        clock = s.get(show.ShowClock, 1)
        assert clock
        baseline = clock.model_dump()
    now[0] += 30
    response = capture(client)
    assert response.status_code == 201
    item = response.json()
    assert item['text'] == 'Creative tools' and item['revision'] == 1
    assert item['topic']['notes'] == item['notes'] + '\n\nSource: ' + item['source_url']
    assert item['source_url'] == 'https://example.com/story?x=1&y=2#section'
    assert client.get('/inbox').json()['items'] == [item]
    assert client.get('/inbox?archived=true').json() == {'items': []}
    assert client.get('/inbox/' + item['id']).json() == item
    item = edit(client, item, notes='Edited context', text='Next week').json()
    assert item['revision'] == 2 and item['topic']['text'] == 'Next week'
    archived = archive(client, item).json()
    assert archived['archived'] and archived['revision'] == 3
    assert client.get('/inbox').json() == {'items': []}
    assert client.get('/inbox?archived=true').json()['items'] == [archived]
    assert archive(client, archived).json() == archived
    assert edit(client, archived, text='Forbidden').status_code == 409
    restored = archive(client, archived, False).json()
    assert not restored['archived'] and restored['revision'] == 4
    cleared = edit(client, restored, notes='', source_url='').json()
    assert cleared['topic']['notes'] == ''
    with db.session() as s:
        clock = s.get(show.ShowClock, 1)
        assert clock and clock.model_dump() == baseline
        assert len(s.exec(select(Rundown)).all()) == 1
    latest = client.get('/rundown/state').json()
    assert latest['remaining_seconds'] == 3570 and not latest['paused']


def test_capture_does_not_bootstrap_live_and_reopen_keeps_data(client):
    item = capture(client).json()
    with db.session() as s:
        assert s.get(show.ShowClock, 1) is None
        assert not s.exec(select(Rundown)).all()
    db._engine.dispose()
    db.init_db()
    assert client.get('/inbox/' + item['id']).json() == item


def test_independent_copies_keep_attribution_in_saved_live_and_history(client):
    item = capture(client).json()
    saved = client.post('/shows', json={'name': 'Tomorrow', 'topics': [item['topic']]}).json()
    live = client.put('/rundown/schedule', json={'revision': 0, 'topics': [item['topic']]}).json()
    assert saved['topics'][0]['notes'] == live['topics'][0]['notes'] == item['topic']['notes']
    assert len({item['id'], saved['topics'][0]['id'], live['topics'][0]['id']}) == 3
    changed = edit(client, item, notes='Different', source_url='https://example.org/next').json()
    archive(client, changed)
    assert client.get('/shows/' + saved['id']).json() == saved
    assert client.get('/rundown/state').json()['topics'] == live['topics']
    with db.session() as s:
        history = s.exec(select(RundownItemNotes)).all()
        assert len(history) == 1 and history[0].notes == item['topic']['notes']


@pytest.mark.parametrize('patch', [
    {'text': '  '}, {'text': 'x' * 31}, {'duration': 14}, {'duration': 3601},
    {'duration': True}, {'duration': 120.0}, {'notes': 'x' * 10001},
    {'source_url': 'javascript:alert(1)'}, {'source_url': 'data:text/plain,hello'},
    {'source_url': 'file:///etc/passwd'}, {'source_url': '//example.com/x'},
    {'source_url': 'https://user:pass@example.com/'}, {'source_url': 'https://user@example.com/'},
    {'source_url': 'https://example.com/a b'}, {'source_url': 'https://example.com/\nx'},
    {'source_url': 'https://example.com\\@evil.test'}, {'source_url': 'http://'},
    {'source_url': 'https://example.com:99999'}, {'source_url': 'https://example.com/' + 'x' * 2048},
    {'notes': 'x' * 9990}, {'archived': True}, {'revision': 1}, {'id': 'forged'},
])
def test_invalid_capture_is_atomic(client, patch):
    assert capture(client, **patch).status_code == 422
    assert client.get('/inbox').json() == {'items': []}
    with db.session() as s:
        assert s.get(show.ShowClock, 1) is None


def test_context_boundary_and_unicode(client):
    url = 'https://example.com/source'
    notes = '🙂' * (10000 - len('\n\nSource: ' + url))
    item = capture(client, text='🙂' * 30, notes=notes, source_url=url).json()
    assert len(item['topic']['notes']) == 10000
    assert edit(client, item, notes=notes + '🙂').status_code == 422
    assert client.get('/inbox/' + item['id']).json() == item
    assert capture(client, source_url='', notes='🙂' * 10000).status_code == 201
    no_context = capture(client, source_url=url, notes='').json()
    assert no_context['topic']['notes'] == 'Source: ' + url


def test_stale_missing_and_invalid_writes_keep_data(client):
    item = capture(client).json()
    latest = edit(client, item, text='Other screen').json()
    assert edit(client, item, notes='Local edit').status_code == 409
    assert archive(client, item).status_code == 409
    assert archive(client, latest, revision=True).status_code == 422
    assert client.post('/inbox/' + item['id'] + '/archive', json={
        'revision': latest['revision'], 'archived': 'true'}).status_code == 422
    assert client.put('/inbox/' + item['id'], json={
        'revision': latest['revision'], 'text': 'Missing context', 'duration': 120}).status_code == 422
    assert client.get('/inbox/' + item['id']).json() == latest
    assert client.get('/inbox/missing').status_code == 404
    assert edit(client, {**latest, 'id': 'missing'}).status_code == 404
    assert archive(client, {**latest, 'id': 'missing'}).status_code == 404


def test_competing_edit_archive_only_one_wins(client):
    item = capture(client).json()
    with ThreadPoolExecutor(max_workers=2) as pool:
        edit_future = pool.submit(edit, client, item, notes='Winner context')
        archive_future = pool.submit(archive, client, item)
        responses = [edit_future.result(), archive_future.result()]
    assert sorted(r.status_code for r in responses) == [200, 409]
    winner = next(r.json() for r in responses if r.status_code == 200)
    assert client.get('/inbox/' + item['id']).json() == winner
    assert winner['revision'] == 2
