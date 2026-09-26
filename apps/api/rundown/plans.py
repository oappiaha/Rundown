"""Streaming days: a dated SavedShow with topic-origin display metadata.

A day reuses SavedShow for its timed topic snapshots (same limits, same
revision namespace, same explicit activation through /shows). Adding an idea
captures its note and source at that moment; later library edits never touch
the snapshot. Nothing here writes the live clock.
"""

import json
import re
import time
from datetime import date
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlmodel import Session, col, select

from rundown import library
from rundown.db import session
from rundown.inbox import MAX_LABEL, copy_notes, display_title, get_source
from rundown.inbox import lookup as lookup_idea
from rundown.library import ShowName, saved_transaction
from rundown.models import SavedShow, ShowPlan, ShowTopicOrigin, TopicCapture, TopicEditorial
from rundown.show import ScheduleTopic, TopicIn

router = APIRouter(prefix="/plans", tags=["streaming-days"])

MAX_DISPLAY_TITLE = 300
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def valid_date(value: str) -> str:
    if not DATE_PATTERN.fullmatch(value):
        raise ValueError("Use a calendar date as YYYY-MM-DD.")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("Use a real calendar date as YYYY-MM-DD.") from exc
    return value


class CreatePlan(ShowName):
    stream_date: str

    @field_validator("stream_date")
    @classmethod
    def check_date(cls, value: str) -> str:
        return valid_date(value)


class UpdatePlan(ShowName):
    revision: int = Field(ge=1, strict=True)
    stream_date: str | None = None
    topics: list[ScheduleTopic] = Field(max_length=20)

    @field_validator("stream_date")
    @classmethod
    def check_date(cls, value: str | None) -> str | None:
        return None if value is None else valid_date(value)


class AddTopic(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1, strict=True)
    inbox_topic_id: str = Field(min_length=1, max_length=80)
    label: str | None = Field(default=None, min_length=1, max_length=MAX_LABEL)
    duration: int | None = Field(default=None, ge=15, le=3600, strict=True)

    @field_validator("label", mode="before")
    @classmethod
    def collapse(cls, value: object) -> object:
        return " ".join(value.split()) if isinstance(value, str) else value


def origin_detail(row: ShowTopicOrigin | None) -> dict | None:
    if row is None:
        return None
    return {"inbox_topic_id": row.inbox_topic_id, "display_title": row.display_title}


def plan_detail(db: Session, saved: SavedShow) -> dict:
    assert saved.id is not None
    rows = library.origins(db, saved.id)
    base = library.detail(saved)
    base["topics"] = [{**topic, "origin": origin_detail(rows.get(topic["id"]))} for topic in base["topics"]]
    return base


@router.get("")
def list_plans() -> dict:
    """Every saved show with its date; dated days first (soonest last), then undated shows."""
    with session() as db:
        shows = db.exec(select(SavedShow).order_by(col(SavedShow.updated_at).desc(), col(SavedShow.id))).all()
        dates = {row.show_id: row.stream_date for row in db.exec(select(ShowPlan)).all()}
        items = []
        for saved in shows:
            entry = library.summary(saved)
            entry["stream_date"] = dates.get(saved.id)
            items.append(entry)
        items.sort(key=lambda s: (s["stream_date"] is None, s["stream_date"] or "", s["name"].lower()))
        return {"plans": items}


@router.post("", status_code=201)
def create_plan(payload: CreatePlan) -> dict:
    with saved_transaction() as db:
        saved = library.create(db, payload.name, [])
        db.flush()
        assert saved.id is not None
        db.add(ShowPlan(show_id=saved.id, stream_date=payload.stream_date, created_at=time.time()))
        db.flush()
        return plan_detail(db, saved)


@router.get("/{show_id}")
def get_plan(show_id: str) -> dict:
    with session() as db:
        return plan_detail(db, library.lookup(db, show_id))


@router.put("/{show_id}")
def update_plan(show_id: str, payload: UpdatePlan) -> dict:
    """Order, timing, labels, notes, name and date in one revision-guarded write."""
    with saved_transaction() as db:
        saved = library.lookup(db, show_id)
        library.check_saved_revision(saved, payload.revision)
        assert saved.id is not None
        plan = db.get(ShowPlan, saved.id)
        if payload.stream_date is None and "stream_date" in payload.model_fields_set and plan is not None:
            raise HTTPException(422, "A streaming day keeps its date; pick another date instead.")
        if payload.stream_date is not None:
            if plan is None:
                db.add(ShowPlan(show_id=saved.id, stream_date=payload.stream_date, created_at=time.time()))
            elif plan.stream_date != payload.stream_date:
                plan.stream_date = payload.stream_date
                db.add(plan)
        topics = library.replace_topics(saved, payload.topics, payload.name)
        db.add(saved)
        library.sync_origins(db, saved, topics)
        db.flush()
        return plan_detail(db, saved)


@router.post("/{show_id}/topics")
def add_topic(show_id: str, payload: AddTopic) -> dict:
    """Snapshot an idea into this day: full headline kept as display metadata,
    the live label confirmed by the user when the headline is longer than 30
    characters, the personal note and source copied as they are right now."""
    with saved_transaction() as db:
        saved = library.lookup(db, show_id)
        library.check_saved_revision(saved, payload.revision)
        assert saved.id is not None
        item = lookup_idea(db, payload.inbox_topic_id)
        assert item.id is not None
        if item.archived:
            raise HTTPException(409, "Restore this archived idea before planning it.")
        topics = library._topics(saved)
        if len(topics) >= 20:
            raise HTTPException(422, "A day holds at most 20 topics.")
        rows = library.origins(db, saved.id)
        if any(row.inbox_topic_id == item.id for row in rows.values()):
            raise HTTPException(409, "This idea is already in this day.")
        title = display_title(item, get_source(db, item.id), db.get(TopicCapture, item.id))[:MAX_DISPLAY_TITLE]
        label = payload.label
        if label is None:
            if len(title) > MAX_LABEL:
                raise HTTPException(422, f"The headline is longer than {MAX_LABEL} characters. Choose a live label for it.")
            label = title
        editorial = db.get(TopicEditorial, item.id)
        personal = editorial.note if editorial and editorial.note.strip() else item.notes
        notes = copy_notes(personal, item.source_url)
        if len(notes) > 10000:
            raise HTTPException(422, "The note and source together exceed the 10000-character topic limit. Shorten the note first.")
        snapshot = TopicIn(text=label, duration=payload.duration or item.duration, notes=notes)
        topic_id = str(uuid4())
        topics.append({"id": topic_id, **snapshot.model_dump()})
        saved.topics_json = json.dumps(topics)
        saved.revision += 1
        saved.updated_at = time.time()
        db.add(saved)
        db.add(ShowTopicOrigin(topic_id=topic_id, show_id=saved.id, inbox_topic_id=item.id, display_title=title,
                               label=snapshot.text, created_at=saved.updated_at))
        db.flush()
        return plan_detail(db, saved)
