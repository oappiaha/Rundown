"""Explicit review of published versions, independent of live playback."""

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlmodel import Session, col, select

from rundown.db import session
from rundown.library import saved_transaction
from rundown.models import Feedback, FeedbackTiming, Rundown, RundownItem, RundownItemNotes

router = APIRouter(prefix="/reviews", tags=["show-review"])


class ReviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0, strict=True)
    rating: int = Field(ge=-1, le=1, strict=True)
    note: str = Field(max_length=4000)
    actual_seconds: int | None = Field(ge=0, le=86400, strict=True)


def stamp(value: datetime | None) -> str | None:
    return value.replace(tzinfo=UTC).isoformat() if value else None


def published(db: Session, version_id: int) -> Rundown:
    version = db.get(Rundown, version_id)
    if version is None or version.pushed_at is None:
        raise HTTPException(404, "Published version not found.")
    return version


def latest(db: Session, item_id: int) -> Feedback | None:
    return db.exec(select(Feedback).where(Feedback.rundown_item_id == item_id)
                   .order_by(col(Feedback.id).desc()).limit(1)).first()


def topic_detail(db: Session, item: RundownItem) -> dict:
    assert item.id is not None
    feedback = latest(db, item.id)
    timing = db.get(FeedbackTiming, feedback.id) if feedback else None
    actual = timing.actual_seconds if timing else None
    context = db.get(RundownItemNotes, item.id)
    return {"id": item.id, "text": item.text, "planned_seconds": item.duration,
            "context": context.notes if context else "",
            "revision": feedback.id if feedback else 0,
            "rating": feedback.rating if feedback else 0,
            "note": (feedback.note or "") if feedback else "",
            "actual_seconds": actual,
            "delta_seconds": actual - item.duration if actual is not None else None,
            "updated_at": stamp(feedback.created_at) if feedback else None}


def items(db: Session, version_id: int):
    return db.exec(select(RundownItem).where(RundownItem.rundown_id == version_id)
                   .order_by(col(RundownItem.position), col(RundownItem.id))).all()


@router.get("")
def list_versions(limit: int = Query(default=20, ge=1, le=50),
                  before_id: int | None = Query(default=None, ge=1)) -> dict:
    with session() as db:
        query = select(Rundown).where(col(Rundown.pushed_at).is_not(None))
        if before_id is not None:
            query = query.where(col(Rundown.id) < before_id)
        versions = db.exec(query.order_by(col(Rundown.id).desc()).limit(limit + 1)).all()
        result = []
        for version in versions[:limit]:
            assert version.id is not None
            topics = items(db, version.id)
            result.append({"id": version.id, "published_at": stamp(version.pushed_at),
                           "topic_count": len(topics),
                           "planned_seconds": sum(t.duration for t in topics),
                           "reviewed_count": sum(latest(db, t.id) is not None
                                                 for t in topics if t.id is not None)})
        return {"versions": result,
                "next_before_id": result[-1]["id"] if len(versions) > limit else None}


@router.get("/{version_id}")
def get_version(version_id: int) -> dict:
    with session() as db:
        version = published(db, version_id)
        return {"id": version.id, "published_at": stamp(version.pushed_at),
                "topics": [topic_detail(db, item) for item in items(db, version_id)]}


@router.put("/{version_id}/topics/{item_id}")
def save_review(version_id: int, item_id: int, payload: ReviewIn) -> dict:
    with saved_transaction() as db:
        published(db, version_id)
        item = db.get(RundownItem, item_id)
        if item is None or item.rundown_id != version_id:
            raise HTTPException(404, "Topic not found in this published version.")
        previous = latest(db, item_id)
        if payload.revision != (previous.id if previous else 0):
            raise HTTPException(409, "Review changed on another screen. Reload before saving.")
        feedback = Feedback(rundown_item_id=item_id, rating=payload.rating, note=payload.note)
        db.add(feedback)
        db.flush()
        assert feedback.id is not None
        db.add(FeedbackTiming(feedback_id=feedback.id, actual_seconds=payload.actual_seconds))
        db.flush()
        return topic_detail(db, item)
