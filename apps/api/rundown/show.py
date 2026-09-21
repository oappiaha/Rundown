"""Persistent single-show clock. SQLite serializes all snapshot/mutation operations."""

import json
import math
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import text
from sqlmodel import Field as SQLField
from sqlmodel import SQLModel, col, select

from rundown.db import session
from rundown.models import Rundown, RundownItem, RundownItemNotes

router = APIRouter(prefix="/rundown", tags=["show"])


class ShowClock(SQLModel, table=True):
    # Additive table: old rundown history and its schema remain intact.
    id: int = SQLField(default=1, primary_key=True)
    revision: int = 0
    topics_json: str = "[]"
    current_topic_id: str | None = None
    remaining: float = 0
    paused: bool = True
    updated_at: float = 0


class TopicIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=30)
    duration: int = Field(ge=15, le=3600, strict=True)
    notes: str = Field(default="", max_length=10000)

    @field_validator("text", mode="before")
    @classmethod
    def strip_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class ScheduleTopic(TopicIn):
    id: str | None = Field(default=None, min_length=1, max_length=80)


class ScheduleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0, strict=True)
    topics: list[ScheduleTopic] = Field(max_length=20)


class ControlIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0, strict=True)
    action: Literal["play", "pause", "next", "previous", "reset", "jump"]
    topic_id: str | None = None


def _topics(clock: ShowClock) -> list[dict]:
    # Existing show snapshots predate notes. Normalize on read, without a
    # destructive migration or changing the published revision.
    return [{**topic, "notes": topic.get("notes", "")}
            for topic in json.loads(clock.topics_json)]


def _advance(clock: ShowClock, now: float) -> None:
    topics = _topics(clock)
    if clock.paused or not topics:
        clock.updated_at = now
        return
    remaining = clock.remaining - max(0, now - clock.updated_at)
    index = next(i for i, t in enumerate(topics) if t["id"] == clock.current_topic_id)
    while remaining <= 0:
        clock.revision += 1
        if index == len(topics) - 1:
            clock.paused = True
            remaining = 0
            break
        index += 1
        clock.current_topic_id = topics[index]["id"]
        remaining += topics[index]["duration"]
    clock.remaining = remaining
    clock.updated_at = now


@contextmanager
def transaction():
    with session() as db:
        # Acquired before loading the revision: competing processes cannot both
        # accept the same edit. Also protects first-use bootstrap.
        db.connection().execute(text("BEGIN IMMEDIATE"))
        now = time.time()
        clock = db.get(ShowClock, 1)
        if clock is None:
            clock = ShowClock(updated_at=now)
            previous = db.exec(select(Rundown).order_by(col(Rundown.id).desc())).first()
            if previous:
                items = db.exec(select(RundownItem).where(
                    RundownItem.rundown_id == previous.id
                ).order_by(col(RundownItem.position))).all()
                topics = []
                for item in items:
                    context = db.get(RundownItemNotes, item.id)
                    topics.append({"id": str(uuid4()), "text": item.text,
                                   "duration": item.duration,
                                   "notes": context.notes if context else ""})
                clock.topics_json = json.dumps(topics)
                if topics:
                    clock.current_topic_id = topics[0]["id"]
                    clock.remaining = topics[0]["duration"]
                    clock.revision = 1
            db.add(clock)
        _advance(clock, now)
        try:
            yield db, clock, now
            db.add(clock)
            db.commit()
        except Exception:
            db.rollback()
            raise


def snapshot(clock: ShowClock, now: float) -> dict:
    return {
        "revision": clock.revision,
        "topics": _topics(clock),
        "current_topic_id": clock.current_topic_id,
        "remaining_seconds": math.ceil(clock.remaining),
        "paused": clock.paused,
        "server_time": datetime.fromtimestamp(now, UTC).isoformat(),
    }


def check_revision(clock: ShowClock, revision: int) -> None:
    if revision != clock.revision:
        raise HTTPException(409, "Show changed. Reload the latest schedule before saving.")


def archive(db, topics: list[dict], notes: str | None = None) -> int:
    rundown = Rundown(notes=notes, pushed_at=datetime.now(UTC).replace(tzinfo=None))
    db.add(rundown)
    db.flush()
    assert rundown.id is not None
    for position, topic in enumerate(topics):
        item = RundownItem(rundown_id=rundown.id, position=position,
                           text=topic["text"], duration=topic["duration"])
        db.add(item)
        if topic.get("notes"):
            db.flush()
            assert item.id is not None
            db.add(RundownItemNotes(rundown_item_id=item.id, notes=topic["notes"]))
    return rundown.id


@router.get("/state")
def get_state() -> dict:
    with transaction() as (_, clock, now):
        return snapshot(clock, now)


@router.put("/schedule")
def save_schedule(payload: ScheduleIn) -> dict:
    with transaction() as (db, clock, now):
        check_revision(clock, payload.revision)
        old = {t["id"]: t for t in _topics(clock)}
        seen = set()
        topics = []
        for entry in payload.topics:
            if entry.id is not None and (entry.id not in old or entry.id in seen):
                raise HTTPException(422, "Existing topic IDs must be unique and belong to this show.")
            topic_id = entry.id or str(uuid4())
            seen.add(topic_id)
            notes = entry.notes
            if "notes" not in entry.model_fields_set and entry.id in old:
                # An older client editing a title/duration must not erase context.
                notes = old[entry.id]["notes"]
            topics.append({"id": topic_id, "text": entry.text,
                           "duration": entry.duration, "notes": notes})
        if clock.current_topic_id and clock.current_topic_id not in seen:
            raise HTTPException(409, "Select another topic before removing the current segment.")
        if clock.current_topic_id:
            current = next(t for t in topics if t["id"] == clock.current_topic_id)
            elapsed = old[clock.current_topic_id]["duration"] - clock.remaining
            clock.remaining = max(0, current["duration"] - elapsed)
        elif topics:
            clock.current_topic_id = topics[0]["id"]
            clock.remaining = topics[0]["duration"]
            clock.paused = True
        clock.topics_json = json.dumps(topics)
        clock.revision += 1
        archive(db, topics)
        return snapshot(clock, now)


@router.post("/control")
def control(payload: ControlIn) -> dict:
    with transaction() as (_, clock, now):
        check_revision(clock, payload.revision)
        topics = _topics(clock)
        if not topics:
            raise HTTPException(409, "Add a topic before using playback controls.")
        index = next(i for i, t in enumerate(topics) if t["id"] == clock.current_topic_id)
        if payload.action == "play":
            clock.paused = False
            if clock.remaining == 0:
                clock.remaining = topics[index]["duration"]
        elif payload.action == "pause":
            clock.paused = True
        else:
            target = index
            if payload.action == "reset":
                target = 0
                clock.paused = True
            elif payload.action == "jump":
                target = next((i for i, t in enumerate(topics) if t["id"] == payload.topic_id), -1)
                if target == -1:
                    raise HTTPException(422, "Choose a topic in this show.")
            else:
                target += 1 if payload.action == "next" else -1
                if target < 0 or target >= len(topics):
                    return snapshot(clock, now)
            clock.current_topic_id = topics[target]["id"]
            clock.remaining = topics[target]["duration"]
        clock.revision += 1
        return snapshot(clock, now)


def legacy_publish(entries: list[TopicIn], notes: str | None) -> int:
    """Old clients explicitly publish a replacement show; new clients use PUT."""
    with transaction() as (db, clock, _):
        topics = [{"id": str(uuid4()), **t.model_dump()} for t in entries]
        clock.topics_json = json.dumps(topics)
        clock.current_topic_id = topics[0]["id"]
        clock.remaining = topics[0]["duration"]
        clock.paused = True
        clock.revision += 1
        return archive(db, topics, notes)
