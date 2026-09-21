import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from rundown import db, feeds, rss, scheduling, show
from rundown.config import settings
from rundown.main import app
from rundown.models import FeedRun, FeedSchedule

XML = b'<rss version="2.0"><channel><title>News</title><item><title>Research</title><link>https://example.com/story</link><description>Useful original context.</description></item></channel></rss>'


@pytest.fixture
def client(monkeypatch):
    # Drive tick explicitly in unit tests; real lifespan is tested separately.
    monkeypatch.setattr(scheduling.FeedScheduler, 'start', lambda self: None)
    monkeypatch.setattr(scheduling.FeedScheduler, 'stop', lambda self: None)
    monkeypatch.setattr(settings, 'rss_scheduler_enabled', True)
    monkeypatch.setattr(rss, 'fetch_feed', lambda url: (XML, url))
    with TestClient(app) as client:
        yield client


def feed(client):
    return client.post('/feeds', json={'name': 'Research', 'url': 'https://example.com/rss', 'default_duration': 120}).json()


def update(client, f, revision=0, enabled=True, interval_minutes=15):
    return client.put(f"/feeds/{f['id']}/schedule", json={'revision': revision, 'enabled': enabled, 'interval_minutes': interval_minutes})


def due(f):
    with db.session() as s:
        row = s.get(FeedSchedule, f['id'])
        assert row
        row.next_run_at = time.time() - 90000
        s.add(row)
        s.commit()


def schedule(client, f):
    return client.get(f"/feeds/{f['id']}/schedule").json()


def test_opt_in_validation_config_and_next_run(client):
    f = feed(client)
    initial = schedule(client, f)
    assert initial['revision'] == 0 and not initial['enabled'] and initial['next_run_at'] is None
    assert update(client, f, interval_minutes=14).status_code == 422
    assert update(client, f, interval_minutes=10081).status_code == 422
    assert update(client, f, interval_minutes=True).status_code == 422
    assert client.put(f"/feeds/{f['id']}/schedule", json={'revision': 0, 'enabled': 1, 'interval_minutes': 15}).status_code == 422
    saved = update(client, f).json()
    assert saved['revision'] == 1 and saved['effective'] and saved['last_run'] is None
    same = update(client, f, revision=1).json()
    assert saved['next_run_at'] == same['next_run_at']
    assert update(client, f, revision=1).status_code == 409
    assert client.get('/inbox').json()['items'] == []
    off = update(client, f, revision=2, enabled=False).json()
    assert off['next_run_at'] is None and not off['effective']
    assert client.get('/feeds/missing/schedule').status_code == 404


def test_due_catchup_dedup_and_clock_preserved(client):
    f = feed(client)
    update(client, f)
    client.put('/rundown/schedule', json={'revision': 0, 'topics': [{'text': 'Opening', 'duration': 3600}]})
    client.post('/rundown/control', json={'revision': 1, 'action': 'play'})
    with db.session() as s:
        clock = s.get(show.ShowClock, 1)
        assert clock
        before = clock.model_dump()
    due(f)
    scheduling.tick(threading.Event())
    result = schedule(client, f)
    assert result['last_run']['created'] == 1
    assert result['last_run']['status'] == 'succeeded'
    scheduling.tick(threading.Event())
    assert schedule(client, f)['last_run']['id'] == result['last_run']['id']
    item = client.get('/inbox').json()['items'][0]
    edited = client.put('/inbox/' + item['id'], json={**{k: item[k] for k in ['revision', 'text', 'duration', 'source_url']}, 'notes': 'My preserved angle.'}).json()
    due(f)
    scheduling.tick(threading.Event())
    second = schedule(client, f)
    assert second['last_run']['created'] == 0 and second['last_run']['duplicates'] == 1
    assert client.get('/inbox/' + item['id']).json() == edited
    with db.session() as s:
        clock = s.get(show.ShowClock, 1)
        assert clock and clock.model_dump() == before
        row = s.get(FeedSchedule, f['id'])
        assert row and row.next_run_at and row.next_run_at > time.time() + 890


def test_failure_waits_normal_interval_manual_does_not_move_schedule(client, monkeypatch):
    f = feed(client)
    update(client, f)
    calls = []
    def fail(url):
        calls.append(url)
        raise rss.FeedError('Fixture unavailable')
    monkeypatch.setattr(rss, 'fetch_feed', fail)
    due(f)
    scheduling.tick(threading.Event())
    failed = schedule(client, f)
    assert failed['last_run']['status'] == 'failed'
    scheduling.tick(threading.Event())
    assert len(calls) == 1
    client.post(f"/feeds/{f['id']}/import", json={'revision': 1})
    after = schedule(client, f)
    assert after['last_run'] == failed['last_run'] and after['next_run_at'] == failed['next_run_at']


def test_disabled_feed_and_scheduler_pause_and_reenable(client, monkeypatch):
    f = feed(client)
    update(client, f)
    due(f)
    monkeypatch.setattr(settings, 'rss_scheduler_enabled', False)
    scheduling.tick(threading.Event())
    assert not schedule(client, f)['effective'] and schedule(client, f)['last_run'] is None
    monkeypatch.setattr(settings, 'rss_scheduler_enabled', True)
    payload = {'revision': 1, 'name': f['name'], 'default_duration': 120, 'enabled': False}
    disabled = client.put('/feeds/' + f['id'], json=payload).json()
    assert schedule(client, f)['next_run_at'] is None
    scheduling.tick(threading.Event())
    assert schedule(client, f)['last_run'] is None
    # Schedules can be saved on disabled feeds, but have no next due until enabled.
    update(client, f, revision=1, interval_minutes=30)
    assert not schedule(client, f)['effective']
    client.put('/feeds/' + f['id'], json={**payload, 'revision': disabled['revision'], 'enabled': True})
    assert schedule(client, f)['effective']
    with db.session() as s:
        row = s.get(FeedSchedule, f['id'])
        assert row and row.next_run_at and row.next_run_at > time.time() + 1790


def test_atomic_claim_only_one_and_shared_manual_lock(client, monkeypatch):
    f = feed(client)
    update(client, f)
    due(f)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: scheduling.claim_due(f['id']), range(2)))
    assert sum(r is not None for r in results) == 1
    assert client.post(f"/feeds/{f['id']}/import", json={'revision': 1}).status_code == 409
    assert update(client, f, revision=1, enabled=False).status_code == 409
    claimed = next(r for r in results if r)
    feeds.finish_import(f['id'], *claimed)
    assert update(client, f, revision=1, enabled=False).status_code == 200
    # Manual active lease makes automatic claim wait, without consuming due time.
    update(client, f, revision=2)
    due(f)
    entered, release = threading.Event(), threading.Event()
    def slow(url):
        entered.set()
        assert release.wait(5)
        return XML, url
    monkeypatch.setattr(rss, 'fetch_feed', slow)
    with ThreadPoolExecutor() as pool:
        future = pool.submit(client.post, f"/feeds/{f['id']}/import", json={'revision': 1})
        assert entered.wait(5)
        assert scheduling.claim_due(f['id']) is None
        release.set()
        assert future.result().status_code == 200
    assert scheduling.claim_due(f['id']) is not None


def test_interrupted_claim_next_interval_recovers_old_lease(client):
    f = feed(client)
    update(client, f)
    due(f)
    claimed = scheduling.claim_due(f['id'])
    assert claimed
    assert scheduling.claim_due(f['id']) is None
    with db.session() as s:
        old = s.get(FeedRun, claimed[0])
        assert old
        old.started_at = time.time() - 150
        s.add(old)
        s.commit()
    due(f)
    scheduling.tick(threading.Event())
    with db.session() as s:
        old = s.get(FeedRun, claimed[0])
        assert old and old.status == 'failed'
        assert len(s.exec(select(FeedRun)).all()) == 2
