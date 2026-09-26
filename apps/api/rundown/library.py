"""Named saved shows; only explicit activation changes the shared live show."""

import json
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import text
from sqlmodel import Session, col, select

from rundown import show
from rundown.db import session
from rundown.models import SavedShow, ShowPlan, ShowTopicOrigin
from rundown.show import ScheduleTopic, TopicIn

router = APIRouter(prefix="/shows", tags=["saved-shows"])


class ShowName(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class CreateShow(ShowName):
    topics: list[TopicIn] = Field(default_factory=list, max_length=20)


class UpdateShow(ShowName):
    revision: int = Field(ge=1, strict=True)
    topics: list[ScheduleTopic] = Field(max_length=20)


class DuplicateShow(ShowName):
    revision: int = Field(ge=1, strict=True)


class FromLive(ShowName):
    live_revision: int = Field(ge=0, strict=True)


class ActivateShow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1, strict=True)
    live_revision: int = Field(ge=0, strict=True)


@contextmanager
def saved_transaction():
    # Saved preparation must not initialize, advance or otherwise write the
    # live clock. Lock before checking revision for concurrent writers.
    with session() as db:
        db.connection().execute(text("BEGIN IMMEDIATE"))
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise


def lookup(db: Session, show_id: str) -> SavedShow:
    saved = db.get(SavedShow, show_id)
    if saved is None:
        raise HTTPException(404, "Saved show not found.")
    return saved


def check_saved_revision(saved: SavedShow, revision: int) -> None:
    if saved.revision != revision:
        raise HTTPException(409, "Saved show changed on another screen. Reload it before trying again.")


def _topics(saved: SavedShow) -> list[dict]:
    return json.loads(saved.topics_json)


def _stamp(value: float) -> str:
    return datetime.fromtimestamp(value, UTC).isoformat()


def stream_date(saved: SavedShow) -> str | None:
    """The additive streaming-day date, read through the show's own session so
    every existing caller of summary/detail reports it without a new argument."""
    db = Session.object_session(saved)
    if db is None:
        return None
    plan = db.get(ShowPlan, saved.id)
    return plan.stream_date if plan else None


def summary(saved: SavedShow) -> dict:
    topics = _topics(saved)
    return {"id": saved.id, "name": saved.name, "revision": saved.revision,
            "topic_count": len(topics), "total_seconds": sum(t["duration"] for t in topics),
            "stream_date": stream_date(saved),
            "created_at": _stamp(saved.created_at), "updated_at": _stamp(saved.updated_at)}


def detail(saved: SavedShow) -> dict:
    return {"id": saved.id, "name": saved.name, "revision": saved.revision,
            "topics": _topics(saved), "stream_date": stream_date(saved),
            "created_at": _stamp(saved.created_at), "updated_at": _stamp(saved.updated_at)}


# ---- Topic origins (additive display metadata) -------------------------------

def origins(db: Session, show_id: str) -> dict[str, ShowTopicOrigin]:
    rows = db.exec(select(ShowTopicOrigin).where(ShowTopicOrigin.show_id == show_id)).all()
    return {row.topic_id: row for row in rows}


def sync_origins(db: Session, saved: SavedShow, topics: list[dict]) -> None:
    """After a show's topic list was replaced: a topic that is gone loses its
    mapping, a topic whose live label changed keeps its origin with the new
    label. Never creates a mapping."""
    assert saved.id is not None
    kept = {t["id"]: t for t in topics}
    for topic_id, row in origins(db, saved.id).items():
        if topic_id not in kept:
            db.delete(row)
        elif row.label != kept[topic_id]["text"]:
            row.label = kept[topic_id]["text"]
            db.add(row)


def copy_origins(db: Session, source: SavedShow, copied: SavedShow, id_map: dict[str, str]) -> None:
    """A duplicate keeps the same display metadata under its fresh topic ids."""
    assert source.id is not None and copied.id is not None
    now = time.time()
    for topic_id, row in origins(db, source.id).items():
        new_id = id_map.get(topic_id)
        if new_id is not None:
            db.add(ShowTopicOrigin(topic_id=new_id, show_id=copied.id, inbox_topic_id=row.inbox_topic_id,
                                   display_title=row.display_title, label=row.label, created_at=now))


def replace_topics(saved: SavedShow, entries: list[ScheduleTopic], name: str) -> list[dict]:
    """Shared by the legacy /shows editor and the /plans editor: existing ids
    must belong to this show and be unique; omitted notes are kept."""
    old = {t["id"]: t for t in _topics(saved)}
    seen = set()
    topics = []
    for entry in entries:
        if entry.id is not None and (entry.id not in old or entry.id in seen):
            raise HTTPException(422, "Existing topic IDs must be unique and belong to this saved show.")
        topic_id = entry.id or str(uuid4())
        seen.add(topic_id)
        notes = entry.notes
        if "notes" not in entry.model_fields_set and entry.id in old:
            notes = old[entry.id]["notes"]
        topics.append({"id": topic_id, "text": entry.text,
                       "duration": entry.duration, "notes": notes})
    saved.name = name
    saved.topics_json = json.dumps(topics)
    saved.revision += 1
    saved.updated_at = time.time()
    return topics


def copy_topics(topics: list[dict]) -> list[dict]:
    # Every copy owns independent identities; context is copied verbatim.
    return [{"id": str(uuid4()), "text": t["text"], "duration": t["duration"],
             "notes": t.get("notes", "")} for t in topics]


def create(db: Session, name: str, topics: list[dict]) -> SavedShow:
    now = time.time()
    saved = SavedShow(id=str(uuid4()), name=name, topics_json=json.dumps(copy_topics(topics)),
                      created_at=now, updated_at=now)
    db.add(saved)
    return saved


@router.get("")
def list_shows() -> dict:
    with session() as db:
        rows = db.exec(select(SavedShow).order_by(
            col(SavedShow.updated_at).desc(), col(SavedShow.id))).all()
        return {"shows": [summary(saved) for saved in rows]}


@router.post("", status_code=201)
def create_show(payload: CreateShow) -> dict:
    with saved_transaction() as db:
        return detail(create(db, payload.name, [t.model_dump() for t in payload.topics]))


@router.post("/from-live", status_code=201)
def from_live(payload: FromLive) -> dict:
    with show.transaction() as (db, clock, now):
        show.check_revision(clock, payload.live_revision)
        return detail(create(db, payload.name, show.snapshot(clock, now)["topics"]))


@router.get("/{show_id}")
def get_show(show_id: str) -> dict:
    with session() as db:
        return detail(lookup(db, show_id))


@router.put("/{show_id}")
def update_show(show_id: str, payload: UpdateShow) -> dict:
    with saved_transaction() as db:
        saved = lookup(db, show_id)
        check_saved_revision(saved, payload.revision)
        topics = replace_topics(saved, payload.topics, payload.name)
        db.add(saved)
        sync_origins(db, saved, topics)
        return detail(saved)


@router.post("/{show_id}/duplicate", status_code=201)
def duplicate_show(show_id: str, payload: DuplicateShow) -> dict:
    with saved_transaction() as db:
        source = lookup(db, show_id)
        check_saved_revision(source, payload.revision)
        originals = _topics(source)
        copied = create(db, payload.name, originals)
        db.flush()
        copy_origins(db, source, copied, {o["id"]: c["id"] for o, c in zip(originals, _topics(copied), strict=True)})
        return detail(copied)


@router.post("/{show_id}/activate")
def activate_show(show_id: str, payload: ActivateShow) -> dict:
    with show.transaction() as (db, clock, now):
        saved = lookup(db, show_id)
        check_saved_revision(saved, payload.revision)
        show.check_revision(clock, payload.live_revision)
        topics = copy_topics(_topics(saved))
        if not topics:
            raise HTTPException(409, "Add and save at least one topic before activating this show.")
        # Replacing the live rundown is deliberate and atomic. Saving the
        # preparation copy after this does not auto-sync into the live show.
        clock.topics_json = json.dumps(topics)
        clock.current_topic_id = topics[0]["id"]
        clock.remaining = topics[0]["duration"]
        clock.paused = True
        clock.revision += 1
        show.archive(db, topics)
        return show.snapshot(clock, now)
