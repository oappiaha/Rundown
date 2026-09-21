from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from rundown.db import session
from rundown.main import app
from rundown.models import InboxSource, InboxTopic, ResearchBuild, SavedShow
from rundown.show import ShowClock


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def capture(c, text="AI tools for creators", **values):
    r = c.post("/inbox", json={"text": text, "duration": 120, "notes": "Context\nQuestion?",
                               "source_url": "https://example.com/" + str(uuid4()), **values})
    assert r.status_code == 201, r.text
    return r.json()


def preferences(c, item, **values):
    return c.put(f"/research/{item['id']}/preferences", json={
        "revision": 0, "category": None, "priority": 0, "pinned": False,
        "excluded": False, **values})


def selection(item, revision=0):
    return {"id": item["id"], "revision": item["revision"], "preference_revision": revision}


def test_categories_priority_pin_and_exclusion(client):
    ai = capture(client)
    film = capture(client, "New film trailer")
    ignored = capture(client, "Fashion runway news")
    assert preferences(client, ai, priority=3).status_code == 200
    assert preferences(client, film, pinned=True).status_code == 200
    assert preferences(client, ignored, excluded=True).status_code == 200
    rows = client.get("/research").json()["items"]
    assert rows[0]["id"] == film["id"]
    assert next(r for r in rows if r["id"] == ai["id"])["score"] == 100
    assert {r["category"] for r in rows} == {"ai-innovation", "film-entertainment", "fashion-industry"}
    proposed = client.post("/research/propose", json={"count": 3}).json()
    assert [r["id"] for r in proposed["items"]] == [film["id"], ai["id"]]
    assert proposed["warnings"]
    assert preferences(client, ai, revision=1, category="brain-rot").status_code == 200
    assert next(r for r in client.get("/research").json()["items"] if r["id"] == ai["id"])["category"] == "brain-rot"
    assert preferences(client, ai).status_code == 409


def test_exact_grouping_and_diverse_proposal(client):
    a = capture(client, "AI tools for creators")
    b = capture(client, "AI tools for creators")
    capture(client, "AI robotics update")
    capture(client, "Film premiere news")
    rows = client.get("/research").json()["items"]
    assert next(r for r in rows if r["id"] == a["id"])["group_id"] == next(r for r in rows if r["id"] == b["id"])["group_id"]
    result = client.post("/research/propose", json={"count": 2}).json()["items"]
    assert len({r["category"] for r in result}) == 2
    result = client.post("/research/propose", json={"count": 20}).json()["items"]
    assert len(result) == 3
    assert len(client.get("/inbox").json()["items"]) == 4
    assert preferences(client, a, pinned=True).status_code == 200
    assert preferences(client, b, pinned=True).status_code == 200
    assert client.post("/research/propose", json={"count": 1}).status_code == 409
    result = client.post("/research/propose", json={"count": 2}).json()
    assert len(result["items"]) == 2 and result["warnings"]


def test_full_original_titles_prevent_truncation_false_groups(client):
    a = capture(client, "Same truncated display")
    b = capture(client, "Same truncated display")
    with session() as db:
        for item, title in [(a, "AI tools for filmmakers in summer"), (b, "AI tools for filmmakers in winter")]:
            db.add(InboxSource(inbox_topic_id=item["id"], feed_id="fixture", feed_name="Fixture",
                               original_title=title, body_text="", published_at="2020-01-01T00:00:00Z",
                               imported_at=1))
        db.commit()
    rows = client.get("/research").json()["items"]
    assert len({r["group_id"] for r in rows}) == 2
    assert all(r["score"] == 5 for r in rows)  # publication, not import/edit time


def test_preview_and_idempotent_build_preserve_live_and_inbox(client):
    client.get("/rundown/state")
    a = capture(client)
    b = capture(client, "Audience questions")
    selected = [selection(b), selection(a)]
    with session() as db:
        clock = db.get(ShowClock, 1)
        assert clock
        before = clock.model_dump()
        original = [r.model_dump() for r in db.exec(select(InboxTopic)).all()]
    preview = client.post("/research/preview", json={"selections": selected})
    assert preview.status_code == 200
    assert preview.json()["total_seconds"] == 240
    assert client.get("/shows").json()["shows"] == []
    payload = {"selections": selected, "name": "Friday show", "request_id": str(uuid4())}
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: client.post("/research/shows", json=payload), range(2)))
    assert all(r.status_code == 201 for r in results)
    saved = results[0].json()
    assert saved == results[1].json()
    assert saved["topics"][0]["text"] == b["text"]
    assert saved["topics"][1]["notes"] == a["topic"]["notes"]
    assert {t["id"] for t in saved["topics"]}.isdisjoint({a["id"], b["id"]})
    assert client.post("/research/shows", json={**payload, "name": "Different"}).status_code == 409
    with session() as db:
        clock = db.get(ShowClock, 1)
        assert clock and clock.model_dump() == before
        assert [r.model_dump() for r in db.exec(select(InboxTopic)).all()] == original
        assert len(db.exec(select(SavedShow)).all()) == len(db.exec(select(ResearchBuild)).all()) == 1


def test_stale_selection_archive_exclusion_and_retry(client):
    a = capture(client)
    payload = {"selections": [selection(a)], "name": "One", "request_id": str(uuid4())}
    assert client.post("/research/preview", json=payload | {"name": "Extra"}).status_code == 422
    assert preferences(client, a, excluded=True).status_code == 200
    assert client.post("/research/shows", json=payload).status_code == 409
    payload["selections"] = [selection(a, 1)]
    assert client.post("/research/shows", json=payload).status_code == 409
    assert preferences(client, a, revision=1).status_code == 200
    payload["selections"] = [selection(a, 2)]
    saved = client.post("/research/shows", json=payload).json()
    assert client.post(f"/inbox/{a['id']}/archive", json={"revision": 1, "archived": True}).status_code == 200
    assert client.post("/research/shows", json=payload).json()["id"] == saved["id"]
    assert client.post("/research/shows", json={**payload, "request_id": str(uuid4())}).status_code == 409
    assert client.get("/research").json()["items"] == []


@pytest.mark.parametrize("change", [
    {"priority": True}, {"priority": 4}, {"category": "fake"}, {"pinned": "yes"},
    {"pinned": True, "excluded": True}, {"revision": -1}, {"extra": 1},
])
def test_preference_validation(client, change):
    a = capture(client)
    assert preferences(client, a, **change).status_code == 422


def test_empty_and_duplicate_selection(client):
    assert client.get("/research").json()["items"] == []
    assert client.post("/research/propose", json={"count": 8}).json()["items"] == []
    assert client.post("/research/propose", json={"count": True}).status_code == 422
    assert client.post("/research/preview", json={"selections": []}).status_code == 422
    a = capture(client)
    assert client.post("/research/preview", json={"selections": [selection(a)] * 2}).status_code == 422
    assert client.post("/research/propose", json={"count": 8, "categories": ["fashion-tech"]}).json()["items"] == []
