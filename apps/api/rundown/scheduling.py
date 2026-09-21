"""Persistent opt-in feed intervals, sharing the manual import transaction/lease."""

import logging
import threading
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlmodel import Session, col, select

from rundown import feeds
from rundown.config import settings
from rundown.db import session
from rundown.library import _stamp, saved_transaction
from rundown.models import FeedRun, FeedSchedule, RSSFeed

router = APIRouter(prefix='/feeds', tags=['feed-schedules'])
logger = logging.getLogger(__name__)


class EditSchedule(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: int = Field(ge=0, strict=True)
    enabled: bool = Field(strict=True)
    interval_minutes: int = Field(ge=15, le=10080, strict=True)


def detail(db: Session, feed: RSSFeed, schedule: FeedSchedule | None) -> dict:
    schedule = schedule or FeedSchedule(feed_id=feed.id)
    reason = (
        'Automatic imports are off for this feed.' if not schedule.enabled else
        'This feed is disabled. Enable the feed to resume automatic imports.' if not feed.enabled else
        'Automatic imports are paused in the API configuration.' if not settings.rss_scheduler_enabled else None
    )
    run = db.get(FeedRun, schedule.last_run_id) if schedule.last_run_id else None
    return {'feed_id': feed.id, 'revision': schedule.revision, 'enabled': schedule.enabled,
            'interval_minutes': schedule.interval_minutes,
            'next_run_at': _stamp(schedule.next_run_at) if schedule.next_run_at is not None else None,
            'last_run': feeds.run_detail(run) if run else None, 'effective': reason is None,
            'reason': reason, 'server_time': _stamp(time.time())}


@router.get('/{feed_id}/schedule')
def get_schedule(feed_id: str) -> dict:
    with session() as db:
        return detail(db, feeds.lookup(db, feed_id), db.get(FeedSchedule, feed_id))


@router.put('/{feed_id}/schedule')
def edit_schedule(feed_id: str, payload: EditSchedule) -> dict:
    with saved_transaction() as db:
        feed = feeds.lookup(db, feed_id)
        schedule = db.get(FeedSchedule, feed_id) or FeedSchedule(feed_id=feed_id)
        if schedule.revision != payload.revision:
            raise HTTPException(409, 'Automatic import settings changed on another screen. Reload before saving.')
        if feeds.active(db, feed):
            raise HTTPException(409, 'This feed is importing. Wait for the result before changing its schedule.')
        changed = schedule.enabled != payload.enabled or schedule.interval_minutes != payload.interval_minutes
        schedule.enabled, schedule.interval_minutes = payload.enabled, payload.interval_minutes
        if not schedule.enabled or not feed.enabled:
            schedule.next_run_at = None
        elif changed or schedule.next_run_at is None:
            schedule.next_run_at = time.time() + schedule.interval_minutes * 60
        schedule.revision += 1
        db.add(schedule)
        return detail(db, feed, schedule)


def claim_due(feed_id: str) -> tuple[str, str] | None:
    """Advance cursor and start run in ONE commit; all API processes arbitrate here."""
    with saved_transaction() as db:
        if not settings.rss_scheduler_enabled:
            return None
        schedule = db.get(FeedSchedule, feed_id)
        feed = db.get(RSSFeed, feed_id)
        now = time.time()
        if (not schedule or not feed or not schedule.enabled or not feed.enabled
                or schedule.next_run_at is None or schedule.next_run_at > now or feeds.active(db, feed)):
            return None
        run_id = feeds.start_import(db, feed)
        # Skip missed intervals: a restart performs one catch-up, never a burst.
        schedule.next_run_at = now + schedule.interval_minutes * 60
        schedule.last_run_id = run_id
        db.add(schedule)
        return run_id, feed.url


def tick(stop: threading.Event) -> None:
    if not settings.rss_scheduler_enabled:
        return
    with session() as db:
        due = db.exec(select(FeedSchedule.feed_id).join(RSSFeed).where(
            FeedSchedule.enabled == True,  # noqa: E712
            RSSFeed.enabled == True,  # noqa: E712
            col(FeedSchedule.next_run_at) <= time.time(),
        ).order_by(col(FeedSchedule.next_run_at), FeedSchedule.feed_id).limit(10)).all()
    for feed_id in due:
        if stop.is_set():
            break
        try:
            claimed = claim_due(feed_id)
            if claimed:
                run_id, url = claimed
                feeds.finish_import(feed_id, run_id, url)
        except Exception:
            # Don't print feed bodies/URLs. A claimed run stays durable and the
            # next normal interval can recover its expired shared lease.
            logger.error('Automatic feed import failed unexpectedly; its next attempt remains scheduled.')


class FeedScheduler:
    def __init__(self):
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.run, name='rundown-feed-scheduler', daemon=True)

    def start(self) -> None:
        self.thread.start()

    def run(self) -> None:
        while not self.stop_event.is_set():
            try:
                tick(self.stop_event)
            except Exception:
                logger.error('Automatic import scan failed; it will be checked again.')
            self.stop_event.wait(settings.rss_scheduler_poll_seconds)

    def stop(self) -> None:
        self.stop_event.set()
        # Finish the currently claimed import before closing the owned runtime.
        self.thread.join()
