"""Manual topic capture. Never fetch URLs or mutate saved/live shows here."""

import time
from typing import Self
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    HttpUrl,
    TypeAdapter,
    field_validator,
    model_validator,
)
from sqlmodel import Session, col, select

from rundown.db import session
from rundown.library import _stamp, saved_transaction
from rundown.models import InboxSource, InboxTopic, RetrievedItem
from rundown.show import TopicIn

router = APIRouter(prefix="/inbox", tags=["topic-inbox"])
url_adapter = TypeAdapter(HttpUrl)


def copy_notes(notes: str, source_url: str) -> str:
    if not source_url:
        return notes
    return f"{notes}\n\nSource: {source_url}" if notes else f"Source: {source_url}"


class CaptureTopic(TopicIn):
    source_url: str = Field(default="", max_length=2048)

    @field_validator("source_url", mode="before")
    @classmethod
    def trim_url(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("source_url")
    @classmethod
    def safe_url(cls, value: str) -> str:
        if not value:
            return value
        # Retain exactly the entered attribution, after trimming. Validate it
        # without fetching it, canonicalizing query parameters or following redirects.
        if "\\" in value or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("Source URL cannot contain whitespace or backslashes.")
        parsed = urlsplit(value)
        if (parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname
                or parsed.username is not None or parsed.password is not None):
            raise ValueError("Use an absolute http or https source URL without credentials.")
        url_adapter.validate_python(value)
        return value

    @model_validator(mode="after")
    def context_fits_show(self) -> Self:
        if len(copy_notes(self.notes, self.source_url)) > 10000:
            raise ValueError("Context and source attribution together must fit within 10000 characters.")
        return self


class EditTopic(CaptureTopic):
    revision: int = Field(ge=1, strict=True)

    @model_validator(mode="before")
    @classmethod
    def require_full_edit(cls, value: object) -> object:
        if isinstance(value, dict) and not {"notes", "source_url"} <= value.keys():
            raise ValueError("An edit must include notes and source_url; send an empty string to clear them.")
        return value


class ArchiveTopic(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1, strict=True)
    archived: bool = Field(strict=True)


def lookup(db: Session, topic_id: str) -> InboxTopic:
    item = db.get(InboxTopic, topic_id)
    if item is None:
        raise HTTPException(404, "Inbox topic not found.")
    return item


def check_revision(item: InboxTopic, revision: int) -> None:
    if item.revision != revision:
        raise HTTPException(409, "Inbox topic changed on another screen. Your edits are kept; reload before retrying.")


def get_source(db: Session, topic_id: str) -> InboxSource | RetrievedItem | None:
    return db.get(InboxSource, topic_id) or db.exec(select(RetrievedItem).where(RetrievedItem.inbox_topic_id == topic_id)).first()


def all_sources(db: Session) -> dict[str, InboxSource | RetrievedItem]:
    return {s.inbox_topic_id: s for s in [*db.exec(select(InboxSource)).all(), *db.exec(select(RetrievedItem)).all()]}


def source_detail(source: InboxSource | RetrievedItem | None) -> dict | None:
    if source is None:
        return None
    return {"kind": source.platform if isinstance(source, RetrievedItem) else "rss", "feed_id": source.feed_id, "feed_name": source.feed_name,
            "original_title": source.original_title, "body_text": source.body_text,
            "published_at": source.published_at, "imported_at": _stamp(source.imported_at),
            "truncated": source.truncated}


def detail(item: InboxTopic, source: InboxSource | RetrievedItem | None = None) -> dict:
    return {
        "id": item.id, "revision": item.revision, "text": item.text,
        "duration": item.duration, "notes": item.notes, "source_url": item.source_url,
        "archived": item.archived, "created_at": _stamp(item.created_at),
        "updated_at": _stamp(item.updated_at),
        "source": source_detail(source),
        "topic": {"text": item.text, "duration": item.duration,
                  "notes": copy_notes(item.notes, item.source_url)},
    }


@router.get("")
def list_topics(archived: bool = False) -> dict:
    with session() as db:
        items = db.exec(select(InboxTopic).where(InboxTopic.archived == archived).order_by(
            col(InboxTopic.updated_at).desc(), col(InboxTopic.id))).all()
        sources = all_sources(db)
        return {"items": [detail(item, sources.get(item.id)) for item in items]}


@router.post("", status_code=201)
def capture_topic(payload: CaptureTopic) -> dict:
    with saved_transaction() as db:
        now = time.time()
        item = InboxTopic(id=str(uuid4()), created_at=now, updated_at=now,
                          **payload.model_dump())
        db.add(item)
        return detail(item)


@router.get("/{topic_id}")
def get_topic(topic_id: str) -> dict:
    with session() as db:
        return detail(lookup(db, topic_id), get_source(db, topic_id))


@router.put("/{topic_id}")
def edit_topic(topic_id: str, payload: EditTopic) -> dict:
    with saved_transaction() as db:
        item = lookup(db, topic_id)
        check_revision(item, payload.revision)
        if item.archived:
            raise HTTPException(409, "Restore this archived topic before editing it.")
        item.text = payload.text
        item.duration = payload.duration
        item.notes = payload.notes
        item.source_url = payload.source_url
        item.revision += 1
        item.updated_at = time.time()
        db.add(item)
        return detail(item, get_source(db, topic_id))


@router.post("/{topic_id}/archive")
def archive_topic(topic_id: str, payload: ArchiveTopic) -> dict:
    with saved_transaction() as db:
        item = lookup(db, topic_id)
        check_revision(item, payload.revision)
        if item.archived != payload.archived:
            item.archived = payload.archived
            item.revision += 1
            item.updated_at = time.time()
            db.add(item)
        return detail(item, get_source(db, topic_id))
