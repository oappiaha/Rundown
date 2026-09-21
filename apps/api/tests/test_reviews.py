from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from rundown.db import session
from rundown.main import app
from rundown.models import Feedback, Rundown, RundownItem
from rundown.show import ShowClock


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def publish(client):
    state = client.get('/rundown/state').json()
    r = client.put('/rundown/schedule', json={'revision': state['revision'], 'topics': state['topics'] or [
        {'text': 'Opening', 'duration': 120, 'notes': 'Private context'},
        {'text': 'Questions', 'duration': 60}]})
    assert r.status_code == 200
    v = client.get('/reviews').json()['versions'][0]
    return client.get(f'/reviews/{v["id"]}').json()


def payload(**changes):
    return {'revision': 0, 'rating': 1, 'note': 'Good discussion', 'actual_seconds': 150, **changes}


def test_review_preserves_clock_archive_and_prior_feedback(client):
    v = publish(client)
    topic = v['topics'][0]
    assert topic['context'] == 'Private context' and topic['revision'] == 0
    assert topic['actual_seconds'] is None and topic['delta_seconds'] is None
    with session() as db:
        clock = db.get(ShowClock, 1)
        assert clock
        before = clock.model_dump()
        archive = [t.model_dump() for t in db.exec(select(RundownItem)).all()]
    path = f'/reviews/{v["id"]}/topics/{topic["id"]}'
    r = client.put(path, json=payload())
    assert r.status_code == 200
    saved = r.json()
    assert saved['delta_seconds'] == 30 and saved['rating'] == 1 and saved['revision'] > 0
    assert client.get(f'/reviews/{v["id"]}').json()['topics'][0] == saved
    assert client.get('/reviews').json()['versions'][0]['reviewed_count'] == 1
    cleared = client.put(path, json=payload(revision=saved['revision'], rating=0,
                                          actual_seconds=None, note='')).json()
    assert cleared['actual_seconds'] is None and cleared['delta_seconds'] is None
    assert cleared['rating'] == 0 and cleared['revision'] > saved['revision']
    with session() as db:
        clock = db.get(ShowClock, 1)
        assert clock and clock.model_dump() == before
        assert [t.model_dump() for t in db.exec(select(RundownItem)).all()] == archive
        assert len(db.exec(select(Feedback)).all()) == 2


def test_concurrent_stale_and_cross_version_rejection(client):
    v = publish(client)
    other = publish(client)
    path = f'/reviews/{v["id"]}/topics/{v["topics"][0]["id"]}'
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: client.put(path, json=payload()).status_code, range(2)))
    assert sorted(results) == [200, 409]
    assert client.put(path, json=payload()).status_code == 409
    wrong = f'/reviews/{other["id"]}/topics/{v["topics"][0]["id"]}'
    assert client.put(wrong, json=payload()).status_code == 404
    assert client.get('/reviews/999999').status_code == 404


@pytest.mark.parametrize('change', [
    {'revision': True}, {'revision': -1}, {'rating': True}, {'rating': 2}, {'rating': -2},
    {'actual_seconds': -1}, {'actual_seconds': 86401}, {'actual_seconds': 1.5},
    {'actual_seconds': True}, {'actual_seconds': '150'}, {'note': 'x' * 4001}, {'extra': 1},
])
def test_strict_validation(client, change):
    v = publish(client)
    path = f'/reviews/{v["id"]}/topics/{v["topics"][0]["id"]}'
    assert client.put(path, json=payload(**change)).status_code == 422
    assert client.get(f'/reviews/{v["id"]}').json()['topics'][0]['revision'] == 0


def test_pagination_and_legacy_feedback(client):
    assert client.get('/reviews').json() == {'versions': [], 'next_before_id': None}
    first = publish(client)
    second = publish(client)
    page = client.get('/reviews?limit=1').json()
    assert page['versions'][0]['id'] == second['id'] and page['next_before_id'] == second['id']
    assert client.get(f'/reviews?before_id={second["id"]}').json()['versions'][0]['id'] == first['id']
    assert client.get('/reviews?limit=0').status_code == 422
    assert client.get('/reviews?before_id=0').status_code == 422
    with session() as db:
        hidden = Rundown()
        db.add(hidden)
        db.add(Feedback(rundown_item_id=first['topics'][0]['id'], rating=-1, note='Legacy note'))
        db.commit()
        hidden_id = hidden.id
    legacy = client.get(f'/reviews/{first["id"]}').json()['topics'][0]
    assert legacy['rating'] == -1 and legacy['note'] == 'Legacy note'
    assert legacy['actual_seconds'] is None and legacy['revision'] > 0
    assert client.get(f'/reviews/{hidden_id}').status_code == 404
    assert len(client.get('/reviews').json()['versions']) == 2
