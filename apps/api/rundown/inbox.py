"""Manual topic capture. Never fetch URLs or mutate saved/live shows here."""

import time
from typing import Literal, Self
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

from rundown import presentation, preview_token
from rundown.db import session
from rundown.library import _stamp, saved_transaction
from rundown.models import (
    Attachment,
    InboxSource,
    InboxTopic,
    RetrievedItem,
    TopicCapture,
    TopicEditorial,
    TopicLinkSource,
    TopicPresentation,
)
from rundown.show import TopicIn

MAX_TITLE = 200
MAX_LABEL = 30
MAX_SOURCE_TEXT = 50000
SourceRow = InboxSource | RetrievedItem | TopicLinkSource

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


class EditorialIn(BaseModel):
    """Complete personal state. Its revision namespace is separate from the topic's."""

    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0, strict=True)
    saved: bool = Field(strict=True)
    note: str = Field(max_length=10000)

    @field_validator("note")
    @classmethod
    def plain_note(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("Notes cannot contain NUL characters.")
        return value


def plain(value: str) -> str:
    if "\x00" in value:
        raise ValueError("Text cannot contain NUL characters.")
    return value


class CaptureIn(BaseModel):
    """A topic the user writes or links from Discover. `title` is the full
    headline; `label` is the live label and is required only when the title
    does not fit the 30-character live limit (never truncated silently)."""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["write", "link"]
    title: str = Field(min_length=1, max_length=MAX_TITLE)
    label: str | None = Field(default=None, min_length=1, max_length=MAX_LABEL)
    note: str = Field(default="", max_length=10000)
    source_url: str = Field(default="", max_length=2048)
    duration: int = Field(default=120, ge=15, le=3600, strict=True)
    # A token the preview endpoint issued for exactly this source_url; the
    # client never sends provider fields directly.
    preview: str | None = Field(default=None, min_length=1, max_length=preview_token.MAX_TOKEN)

    @field_validator("title", "label", mode="before")
    @classmethod
    def collapse(cls, value: object) -> object:
        return " ".join(value.split()) if isinstance(value, str) else value

    @field_validator("note")
    @classmethod
    def plain_note(cls, value: str) -> str:
        return plain(value)

    @field_validator("source_url", mode="before")
    @classmethod
    def trim_url(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("source_url")
    @classmethod
    def safe_url(cls, value: str) -> str:
        return CaptureTopic.safe_url(value)

    @model_validator(mode="after")
    def link_needs_url(self) -> Self:
        if self.kind == "link" and not self.source_url:
            raise ValueError("A link topic needs its source URL.")
        if self.kind == "write" and self.source_url:
            raise ValueError("A written topic has no source URL; use a link topic.")
        if self.preview is not None and self.kind != "link":
            raise ValueError("A preview belongs to a link topic.")
        return self


def live_label(title: str, label: str | None) -> str:
    """The live label is the title when it fits; otherwise the user must have chosen one."""
    if label is not None:
        return label
    if len(title) > MAX_LABEL:
        raise HTTPException(422, f"The title is longer than {MAX_LABEL} characters. Choose a live label for it.")
    return title


def create_capture(db: Session, *, kind: str, title: str, label: str | None, note: str, duration: int,
                   source_url: str = "", source_text: str = "", now: float | None = None) -> InboxTopic:
    """One transaction: the idea (live label), its capture sidecar and a
    bookmarked editorial row carrying the personal note."""
    now = time.time() if now is None else now
    item = InboxTopic(id=str(uuid4()), text=live_label(title, label), duration=duration, notes="",
                      source_url=source_url, created_at=now, updated_at=now)
    db.add(item)
    db.add(TopicCapture(inbox_topic_id=item.id, kind=kind, display_title=title, source_text=source_text, created_at=now))
    db.add(TopicEditorial(inbox_topic_id=item.id, revision=1, saved=True, note=note, updated_at=now))
    db.flush()
    return item


def attach_preview(db: Session, topic_id: str, meta: dict, now: float) -> None:
    """Store an accepted preview as provenance plus card metadata. The topic
    row, its title, note and entered URL are what the user typed; the full
    fetched headline stays here untruncated."""
    thumb = meta.get("thumbnail") if isinstance(meta.get("thumbnail"), dict) else None
    image = presentation.safe_image_url(thumb.get("url")) if thumb else None
    width = presentation.dimension(thumb.get("width")) if thumb and image else None
    height = presentation.dimension(thumb.get("height")) if thumb and image else None
    kind = str(meta.get("kind") or "article")
    site = presentation.clean_text(meta.get("site_name"), presentation.MAX_CREATOR)
    description = presentation.clean_text(meta.get("description"), 6000)
    db.add(TopicLinkSource(inbox_topic_id=topic_id, kind=kind, entered_url=str(meta.get("source_url") or ""),
                           resolved_url=str(meta.get("resolved_url") or ""), feed_name=site,
                           original_title=presentation.clean_text(meta.get("title"), 1000), body_text=description,
                           creator=presentation.clean_text(meta.get("creator"), presentation.MAX_CREATOR),
                           published_at=presentation.clean_text(meta.get("published_at"), 120), imported_at=now,
                           truncated=bool(meta.get("truncated"))))
    db.add(TopicPresentation(inbox_topic_id=topic_id, provider=kind,
                             creator=presentation.clean_text(meta.get("creator"), presentation.MAX_CREATOR) or site,
                             excerpt=description[:presentation.MAX_EXCERPT], thumbnail_url=image, thumbnail_width=width,
                             thumbnail_height=height, media_seconds=None, state="ready" if image else "partial",
                             reason=None if image else "The source offered no usable image.", fetched_at=now))


def lookup(db: Session, topic_id: str) -> InboxTopic:
    item = db.get(InboxTopic, topic_id)
    if item is None:
        raise HTTPException(404, "Inbox topic not found.")
    return item


def check_revision(item: InboxTopic, revision: int) -> None:
    if item.revision != revision:
        raise HTTPException(409, "Inbox topic changed on another screen. Your edits are kept; reload before retrying.")


def get_source(db: Session, topic_id: str) -> SourceRow | None:
    return (db.get(InboxSource, topic_id)
            or db.exec(select(RetrievedItem).where(RetrievedItem.inbox_topic_id == topic_id)).first()
            or db.get(TopicLinkSource, topic_id))


def all_sources(db: Session) -> dict[str, SourceRow]:
    return {s.inbox_topic_id: s for s in [*db.exec(select(TopicLinkSource)).all(), *db.exec(select(InboxSource)).all(),
                                          *db.exec(select(RetrievedItem)).all()]}


def source_detail(source: SourceRow | None) -> dict | None:
    if source is None:
        return None
    kind = source.platform if isinstance(source, RetrievedItem) else source.kind if isinstance(source, TopicLinkSource) else "rss"
    detail = {"kind": kind, "feed_id": source.feed_id, "feed_name": source.feed_name,
              "original_title": source.original_title, "body_text": source.body_text,
              "published_at": source.published_at, "imported_at": _stamp(source.imported_at),
              "truncated": source.truncated}
    if isinstance(source, TopicLinkSource):
        detail.update(entered_url=source.entered_url, resolved_url=source.resolved_url, creator=source.creator)
    return detail


def editorial_detail(row: TopicEditorial | None) -> dict:
    if row is None:
        return {"revision": 0, "saved": False, "note": "", "updated_at": None}
    return {"revision": row.revision, "saved": row.saved, "note": row.note, "updated_at": _stamp(row.updated_at)}


def attachment_detail(row: Attachment) -> dict:
    return {"id": row.id, "role": row.role, "filename": row.filename, "media_type": row.media_type,
            "size": row.size, "sha256": row.sha256, "width": row.width, "height": row.height,
            "url": f"/attachments/{row.id}", "created_at": _stamp(row.created_at)}


def capture_detail(row: TopicCapture | None, attachments: list[Attachment] | None = None) -> dict | None:
    if row is None:
        return None
    return {"kind": row.kind, "display_title": row.display_title, "source_text": row.source_text,
            "attachments": [attachment_detail(a) for a in sorted(attachments or [], key=lambda a: (a.created_at, a.id))],
            "created_at": _stamp(row.created_at)}


def attachments_of(db: Session, topic_id: str) -> list[Attachment]:
    return list(db.exec(select(Attachment).where(Attachment.inbox_topic_id == topic_id)).all())


def sidecars(db: Session, topic_id: str) -> dict:
    return {"presentation_row": db.get(TopicPresentation, topic_id), "editorial": db.get(TopicEditorial, topic_id),
            "capture": db.get(TopicCapture, topic_id), "attachments": attachments_of(db, topic_id)}


def display_title(item: InboxTopic, source: SourceRow | None, capture: TopicCapture | None) -> str:
    """The full headline a card shows: the import's original title, the capture's title, else the live label."""
    if capture is not None:
        return capture.display_title
    if source is not None and source.original_title:
        return source.original_title
    return item.text


def detail(item: InboxTopic, source: SourceRow | None = None,
           presentation_row: TopicPresentation | None = None, editorial: TopicEditorial | None = None,
           capture: TopicCapture | None = None, attachments: list[Attachment] | None = None) -> dict:
    return {
        "id": item.id, "revision": item.revision, "text": item.text,
        "duration": item.duration, "notes": item.notes, "source_url": item.source_url,
        "archived": item.archived, "created_at": _stamp(item.created_at),
        "updated_at": _stamp(item.updated_at),
        "source": source_detail(source),
        "topic": {"text": item.text, "duration": item.duration,
                  "notes": copy_notes(item.notes, item.source_url)},
        "presentation": presentation.detail(presentation_row),
        "editorial": editorial_detail(editorial),
        "capture": capture_detail(capture, attachments),
    }


def full_detail(db: Session, item: InboxTopic) -> dict:
    assert item.id is not None
    return detail(item, get_source(db, item.id), **sidecars(db, item.id))


@router.get("")
def list_topics(archived: bool = False) -> dict:
    with session() as db:
        items = db.exec(select(InboxTopic).where(InboxTopic.archived == archived).order_by(
            col(InboxTopic.updated_at).desc(), col(InboxTopic.id))).all()
        sources = all_sources(db)
        cards = {row.inbox_topic_id: row for row in db.exec(select(TopicPresentation)).all()}
        marks = {row.inbox_topic_id: row for row in db.exec(select(TopicEditorial)).all()}
        captures = {row.inbox_topic_id: row for row in db.exec(select(TopicCapture)).all()}
        files: dict[str, list[Attachment]] = {}
        for row in db.exec(select(Attachment)).all():
            files.setdefault(row.inbox_topic_id, []).append(row)
        return {"items": [detail(item, sources.get(item.id), cards.get(item.id), marks.get(item.id),
                                 captures.get(item.id), files.get(item.id)) for item in items]}


@router.post("", status_code=201)
def capture_topic(payload: CaptureTopic) -> dict:
    with saved_transaction() as db:
        now = time.time()
        item = InboxTopic(id=str(uuid4()), created_at=now, updated_at=now,
                          **payload.model_dump())
        db.add(item)
        return detail(item)


@router.post("/capture", status_code=201)
def capture_from_discover(payload: CaptureIn) -> dict:
    """Write or link a topic from Discover. Links are stored, never fetched
    here; an accepted preview arrives as a server-issued token."""
    meta = None
    if payload.preview is not None:
        try:
            meta = preview_token.verify(payload.preview, payload.source_url)
        except preview_token.TokenError as exc:
            raise HTTPException(409, str(exc)) from exc
    with saved_transaction() as db:
        now = time.time()
        item = create_capture(db, kind=payload.kind, title=payload.title, label=payload.label, note=payload.note,
                              duration=payload.duration, source_url=payload.source_url, now=now)
        if meta is not None:
            assert item.id is not None
            attach_preview(db, item.id, meta, now)
            db.flush()
        return full_detail(db, item)


@router.get("/{topic_id}")
def get_topic(topic_id: str) -> dict:
    with session() as db:
        return full_detail(db, lookup(db, topic_id))


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
        return full_detail(db, item)


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
        return full_detail(db, item)


@router.api_route("/{topic_id}/editorial", methods=["PUT", "PATCH"])
def set_editorial(topic_id: str, payload: EditorialIn) -> dict:
    """Bookmark and personal note. The topic row, its imported source and its
    generated notes are never written here; the live clock is never touched."""
    with saved_transaction() as db:
        item = lookup(db, topic_id)
        row = db.get(TopicEditorial, topic_id)
        current = row.revision if row else 0
        if current != payload.revision:
            raise HTTPException(409, "Your note changed on another screen. Your text is kept; reload before retrying.")
        now = time.time()
        if row is None:
            row = TopicEditorial(inbox_topic_id=topic_id, updated_at=now)
        row.saved, row.note, row.revision, row.updated_at = payload.saved, payload.note, current + 1, now
        db.add(row)
        db.flush()
        return full_detail(db, item)
