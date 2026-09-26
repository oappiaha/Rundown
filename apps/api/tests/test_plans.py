"""Streaming days: dated SavedShows with independent order/timing and topic-origin
display metadata; snapshots never follow later library edits; live clock untouched."""

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import inspect
from sqlmodel import SQLModel, select

from rundown import db, show
from rundown.main import app
from rundown.models import (
    InboxTopic,
    SavedShow,
    ShowPlan,
    ShowTopicOrigin,
    TopicCapture,
    TopicEditorial,
)

LONG = 'Why the long take came back: how one-shot scenes went from stunt to scheduling decision'


@pytest.fixture
def client():
    with TestClient(app) as client:
        yield client


def idea(client, text='Creative tools', **patch):
    r = client.post('/inbox', json={'text': text, 'duration': 240, 'notes': 'Legacy context', 'source_url': 'https://example.com/story', **patch})
    assert r.status_code == 201, r.text
    return r.json()


def captured(client, title=LONG, label='Long take is back', note='My angle'):
    r = client.post('/inbox/capture', json={'kind': 'link', 'title': title, 'label': label, 'note': note, 'source_url': 'https://example.com/long-take'})
    assert r.status_code == 201, r.text
    return r.json()


def plan(client, name='Friday live', stream_date='2026-10-02'):
    r = client.post('/plans', json={'name': name, 'stream_date': stream_date})
    assert r.status_code == 201, r.text
    return r.json()


def add(client, p, item, **extra):
    return client.post(f'/plans/{p["id"]}/topics', json={'revision': p['revision'], 'inbox_topic_id': item['id'], **extra})


def put(client, p, **patch):
    body = {'revision': p['revision'], 'name': p['name'], 'topics': [{k: t[k] for k in ('id', 'text', 'duration', 'notes')} for t in p['topics']]}
    body.update(patch)
    return client.put(f'/plans/{p["id"]}', json=body)


def live(client):
    r = client.put('/rundown/schedule', json={'revision': 0, 'topics': [{'text': 'On air', 'duration': 3600, 'notes': 'Already live'}]})
    client.post('/rundown/control', json={'revision': r.json()['revision'], 'action': 'play'})
    return client.get('/rundown/state').json()


def test_two_days_share_an_idea_but_keep_independent_order_time_and_removal(client, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(show.time, 'time', lambda: now[0])
    before = live(client)
    with db.session() as d:
        clock = d.get(show.ShowClock, 1)
        assert clock is not None
        clock_before = clock.model_dump()
    story = captured(client)
    short = idea(client)
    a = plan(client, 'Friday live', '2026-10-02')
    b = plan(client, 'Sunday recap', '2026-10-04')
    assert a['stream_date'] == '2026-10-02' and a['topics'] == [] and a['revision'] == 1
    # The headline is 87 characters: no label means a 422, never a silent truncation.
    r = add(client, a, story)
    assert r.status_code == 422 and 'live label' in r.json()['detail']
    assert client.get(f'/plans/{a["id"]}').json()['topics'] == []
    a = add(client, a, story, label='Long take is back').json()
    a = add(client, a, short).json()
    b = add(client, b, short, duration=600).json()
    b = add(client, b, story, label='One-shot scenes').json()
    assert [t['text'] for t in a['topics']] == ['Long take is back', 'Creative tools']
    assert [t['text'] for t in b['topics']] == ['Creative tools', 'One-shot scenes']
    assert a['topics'][0]['origin'] == {'inbox_topic_id': story['id'], 'display_title': LONG}
    assert a['topics'][0]['notes'] == 'My angle\n\nSource: https://example.com/long-take'
    assert a['topics'][1]['notes'] == 'Legacy context\n\nSource: https://example.com/story'
    assert a['topics'][1]['duration'] == 240 and b['topics'][0]['duration'] == 600
    # Same idea twice in one day is rejected; other days are unaffected.
    assert add(client, a, story, label='Again').status_code == 409
    # Reorder, retime and remove in A only.
    edited = [dict(a['topics'][1], duration=900), dict(a['topics'][0])]
    r = put(client, a, topics=[{k: t[k] for k in ('id', 'text', 'duration', 'notes')} for t in edited])
    assert r.status_code == 200, r.text
    a = r.json()
    assert [t['text'] for t in a['topics']] == ['Creative tools', 'Long take is back'] and a['topics'][0]['duration'] == 900
    a = put(client, a, topics=[{k: a['topics'][1][k] for k in ('id', 'text', 'duration', 'notes')}]).json()
    assert [t['text'] for t in a['topics']] == ['Long take is back'] and a['revision'] == 5
    b_again = client.get(f'/plans/{b["id"]}').json()
    assert b_again == b, 'editing day A never touches day B'
    with db.session() as d:
        rows = d.exec(select(ShowTopicOrigin)).all()
        assert {(r.show_id, r.inbox_topic_id) for r in rows} == {(a['id'], story['id']), (b['id'], short['id']), (b['id'], story['id'])}
        clock = d.get(show.ShowClock, 1)
        assert clock is not None and clock.model_dump() == clock_before
    after = client.get('/rundown/state').json()
    assert after['revision'] == before['revision'] and after['topics'] == before['topics'] and not after['paused']
    # Listing puts dated days first, soonest first, and the summaries carry the date.
    listed = client.get('/plans').json()['plans']
    assert [(p['name'], p['stream_date']) for p in listed] == [('Friday live', '2026-10-02'), ('Sunday recap', '2026-10-04')]
    assert client.get('/shows').json()['shows'][0]['stream_date'] in {'2026-10-02', '2026-10-04'}


def test_snapshot_ignores_later_library_edits_and_stale_writes_keep_state(client):
    story = captured(client, note='First thought')
    p = add(client, plan(client), story, label='Long take is back').json()
    # Library note edit after the snapshot.
    r = client.put(f'/inbox/{story["id"]}/editorial', json={'revision': 1, 'saved': True, 'note': 'Changed my mind'})
    assert r.status_code == 200 and r.json()['editorial']['note'] == 'Changed my mind'
    again = client.get(f'/plans/{p["id"]}').json()
    assert again['topics'][0]['notes'] == 'First thought\n\nSource: https://example.com/long-take'
    assert again == p
    # Stale revision: nothing changes, the caller keeps its draft.
    stale = put(client, dict(p, revision=p['revision'] - 1), name='Renamed')
    assert stale.status_code == 409
    assert client.get(f'/plans/{p["id"]}').json() == p
    assert add(client, dict(p, revision=99), idea(client)).status_code == 409
    # A day keeps its date; a legacy show may stay undated.
    assert put(client, p, stream_date=None).status_code == 422
    assert put(client, p, stream_date='2026-13-01').status_code == 422
    assert put(client, p, stream_date='2026-10-09').json()['stream_date'] == '2026-10-09'
    assert client.post('/plans', json={'name': 'No date'}).status_code == 422
    legacy = client.post('/shows', json={'name': 'Old style', 'topics': [{'text': 'Opening', 'duration': 120}]}).json()
    assert legacy['stream_date'] is None
    assert client.get(f'/plans/{legacy["id"]}').json()['topics'][0]['origin'] is None
    undated = client.put(f'/plans/{legacy["id"]}', json={'revision': 1, 'name': 'Old style', 'topics': legacy['topics']})
    assert undated.status_code == 200 and undated.json()['stream_date'] is None
    dated = client.put(f'/plans/{legacy["id"]}', json={'revision': 2, 'name': 'Old style', 'stream_date': '2026-10-10', 'topics': legacy['topics']})
    assert dated.json()['stream_date'] == '2026-10-10'
    # An idea that does not exist / is archived cannot be planned.
    assert add(client, client.get(f'/plans/{p["id"]}').json(), {'id': 'missing'}).status_code == 404


def test_legacy_show_editor_interoperates_without_stale_mappings(client):
    story = captured(client)
    short = idea(client)
    p = add(client, plan(client), story, label='Long take is back').json()
    p = add(client, p, short).json()
    shown = client.get(f'/shows/{p["id"]}').json()
    assert [t['id'] for t in shown['topics']] == [t['id'] for t in p['topics']] and shown['stream_date'] == '2026-10-02'
    # Legacy editor: relabel the first topic, drop the second, add a plain one.
    edited = [dict(shown['topics'][0], text='One shot'), {'text': 'Questions', 'duration': 60}]
    r = client.put(f'/shows/{p["id"]}', json={'revision': shown['revision'], 'name': shown['name'], 'topics': edited})
    assert r.status_code == 200, r.text
    back = client.get(f'/plans/{p["id"]}').json()
    assert back['topics'][0]['text'] == 'One shot' and back['topics'][0]['origin']['display_title'] == LONG
    assert back['topics'][1]['origin'] is None
    with db.session() as d:
        rows = d.exec(select(ShowTopicOrigin).where(ShowTopicOrigin.show_id == p['id'])).all()
        assert [(r.topic_id, r.label) for r in rows] == [(back['topics'][0]['id'], 'One shot')]
    # Duplicate carries the mapping under fresh ids; the source keeps its own.
    dup = client.post(f'/shows/{p["id"]}/duplicate', json={'revision': back['revision'], 'name': 'Copy'}).json()
    dup_plan = client.get(f'/plans/{dup["id"]}').json()
    assert dup_plan['stream_date'] is None
    assert dup_plan['topics'][0]['id'] != back['topics'][0]['id']
    assert dup_plan['topics'][0]['origin'] == back['topics'][0]['origin']
    with db.session() as d:
        assert len(d.exec(select(ShowTopicOrigin)).all()) == 2
    # Activation is still the only live write and still explicit.
    state = client.get('/rundown/state').json()
    r = client.post(f'/shows/{p["id"]}/activate', json={'revision': back['revision'], 'live_revision': state['revision']})
    assert r.status_code == 200 and [t['text'] for t in r.json()['topics']] == ['One shot', 'Questions']


def test_write_and_link_capture_validation(client):
    r = client.post('/inbox/capture', json={'kind': 'write', 'title': 'Short title', 'note': 'n'})
    assert r.status_code == 201
    item = r.json()
    assert item['text'] == 'Short title' and item['capture']['kind'] == 'write' and item['capture']['display_title'] == 'Short title'
    assert item['editorial'] == {**item['editorial'], 'revision': 1, 'saved': True, 'note': 'n'} and item['notes'] == ''
    assert client.post('/inbox/capture', json={'kind': 'write', 'title': LONG}).status_code == 422
    assert client.post('/inbox/capture', json={'kind': 'write', 'title': LONG, 'label': 'x' * 31}).status_code == 422
    assert client.post('/inbox/capture', json={'kind': 'link', 'title': 'No url'}).status_code == 422
    assert client.post('/inbox/capture', json={'kind': 'link', 'title': 'Bad', 'source_url': 'javascript:alert(1)'}).status_code == 422
    assert client.post('/inbox/capture', json={'kind': 'write', 'title': 'Has url', 'source_url': 'https://example.com'}).status_code == 422
    assert client.post('/inbox/capture', json={'kind': 'write', 'title': 'NUL', 'note': 'a\x00b'}).status_code == 422
    assert client.post('/inbox/capture', json={'kind': 'write', 'title': 'Extra', 'extra': 1}).status_code == 422
    with db.session() as d:
        assert len(d.exec(select(InboxTopic)).all()) == 1 and len(d.exec(select(TopicCapture)).all()) == 1
        assert len(d.exec(select(TopicEditorial)).all()) == 1
    listed = client.get('/inbox').json()['items']
    assert listed[0]['capture']['attachments'] == [] and listed[0]['presentation'] is None


def test_old_schema_upgrades_additively_for_days(client):
    engine = db._engine
    new = {'showplan', 'showtopicorigin', 'topiccapture', 'attachment'}
    old = [t for name, t in SQLModel.metadata.tables.items() if name not in new]
    SQLModel.metadata.drop_all(engine)
    SQLModel.metadata.create_all(engine, tables=old)
    assert set(inspect(engine).get_table_names()) & new == set()
    with db.session() as d:
        d.add(SavedShow(id='old', name='Old show', topics_json=json.dumps([{'id': 't1', 'text': 'Opening', 'duration': 120, 'notes': 'kept'}]), created_at=1, updated_at=1))
        d.add(InboxTopic(id='idea', text='Old idea', duration=120, notes='ctx', source_url='', created_at=1, updated_at=1))
        d.commit()
    db.init_db()
    assert new <= set(inspect(engine).get_table_names())
    old_show = client.get('/shows/old').json()
    assert old_show['topics'] == [{'id': 't1', 'text': 'Opening', 'duration': 120, 'notes': 'kept'}] and old_show['stream_date'] is None
    p = client.get('/plans/old').json()
    assert p['topics'][0]['origin'] is None and p['stream_date'] is None
    item = client.get('/inbox/idea').json()
    assert item['capture'] is None and item['notes'] == 'ctx'
    added = client.post('/plans/old/topics', json={'revision': 1, 'inbox_topic_id': 'idea'})
    assert added.status_code == 200 and added.json()['topics'][1]['origin'] == {'inbox_topic_id': 'idea', 'display_title': 'Old idea'}
    with db.session() as d:
        assert d.get(ShowPlan, 'old') is None
