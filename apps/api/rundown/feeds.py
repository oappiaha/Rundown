"""Explicit RSS imports, with durable results and independent inbox copies."""

import hashlib
import json
import time
from contextlib import suppress
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlmodel import Session, col, select

from rundown import rss
from rundown.db import session
from rundown.inbox import copy_notes
from rundown.library import ShowName, _stamp, saved_transaction
from rundown.models import FeedEntry, FeedRun, FeedSchedule, InboxSource, InboxTopic, RSSFeed

router = APIRouter(prefix='/feeds', tags=['rss-sources'])
LEASE_SECONDS = 120


class CreateFeed(ShowName):
    url: str = Field(min_length=1, max_length=2048)
    default_duration: int = Field(ge=15, le=3600, strict=True)

    @field_validator('url', mode='before')
    @classmethod
    def clean_url(cls, value: object) -> object:
        return rss.canonical_url(value.strip()) if isinstance(value, str) else value


class EditFeed(ShowName):
    revision: int = Field(ge=1, strict=True)
    default_duration: int = Field(ge=15, le=3600, strict=True)
    enabled: bool = Field(strict=True)


class ImportFeed(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: int = Field(ge=1, strict=True)


def lookup(db: Session, feed_id: str) -> RSSFeed:
    feed = db.get(RSSFeed, feed_id)
    if feed is None:
        raise HTTPException(404, 'Feed not found.')
    return feed


def check_revision(feed: RSSFeed, revision: int) -> None:
    if feed.revision != revision:
        raise HTTPException(409, 'Feed settings changed on another screen. Reload before retrying.')


def run_detail(run: FeedRun) -> dict:
    return {'id': run.id, 'feed_id': run.feed_id, 'status': run.status,
            'started_at': _stamp(run.started_at),
            'finished_at': _stamp(run.finished_at) if run.finished_at is not None else None,
            'created': run.created, 'duplicates': run.duplicates, 'skipped': run.skipped,
            'examined': run.examined, 'error': run.error,
            'warnings': json.loads(run.warnings_json), 'items': json.loads(run.items_json)}


def active(db: Session, feed: RSSFeed) -> FeedRun | None:
    run = db.get(FeedRun, feed.active_run_id) if feed.active_run_id else None
    return run if run and run.status == 'running' and time.time() - run.started_at < LEASE_SECONDS else None


def clear_interrupted(db: Session, feed: RSSFeed) -> None:
    if feed.active_run_id:
        old = db.get(FeedRun, feed.active_run_id)
        if old and old.status == 'running':
            old.status = 'failed'
            old.error = 'The previous import was interrupted or timed out. A new attempt can be made.'
            old.finished_at = time.time()
            db.add(old)
        feed.active_run_id = None
        db.add(feed)


def detail(db: Session, feed: RSSFeed) -> dict:
    latest = db.exec(select(FeedRun).where(FeedRun.feed_id == feed.id).order_by(
        col(FeedRun.started_at).desc(), col(FeedRun.id).desc())).first()
    return {'id': feed.id, 'revision': feed.revision, 'name': feed.name, 'url': feed.url,
            'default_duration': feed.default_duration, 'enabled': feed.enabled,
            'created_at': _stamp(feed.created_at), 'updated_at': _stamp(feed.updated_at),
            'can_import': feed.enabled and active(db, feed) is None,
            'latest_run': run_detail(latest) if latest else None}


@router.get('')
def list_feeds() -> dict:
    with session() as db:
        return {'feeds': [detail(db, feed) for feed in db.exec(select(RSSFeed).order_by(
            col(RSSFeed.created_at).desc(), col(RSSFeed.id))).all()]}


@router.post('', status_code=201)
def create_feed(payload: CreateFeed) -> dict:
    with saved_transaction() as db:
        if db.exec(select(RSSFeed).where(RSSFeed.url == payload.url)).first():
            raise HTTPException(409, 'That feed URL is already configured.')
        now = time.time()
        feed = RSSFeed(id=str(uuid4()), created_at=now, updated_at=now, **payload.model_dump())
        db.add(feed)
        db.flush()
        return detail(db, feed)


@router.get('/{feed_id}')
def get_feed(feed_id: str) -> dict:
    with session() as db:
        return detail(db, lookup(db, feed_id))


@router.put('/{feed_id}')
def edit_feed(feed_id: str, payload: EditFeed) -> dict:
    with saved_transaction() as db:
        feed = lookup(db, feed_id)
        check_revision(feed, payload.revision)
        if active(db, feed):
            raise HTTPException(409, 'This feed is importing. Wait for the result before changing its settings.')
        clear_interrupted(db, feed)
        if feed.enabled != payload.enabled:
            schedule = db.get(FeedSchedule, feed.id)
            if schedule and schedule.enabled:
                schedule.next_run_at = time.time() + schedule.interval_minutes * 60 if payload.enabled else None
                db.add(schedule)
        feed.name, feed.default_duration, feed.enabled = payload.name, payload.default_duration, payload.enabled
        feed.revision += 1
        feed.updated_at = time.time()
        db.add(feed)
        return detail(db, feed)


@router.get('/{feed_id}/runs')
def list_runs(feed_id: str) -> dict:
    with session() as db:
        lookup(db, feed_id)
        runs = db.exec(select(FeedRun).where(FeedRun.feed_id == feed_id).order_by(
            col(FeedRun.started_at).desc(), col(FeedRun.id).desc()).limit(20)).all()
        return {'runs': [run_detail(run) for run in runs]}


def inbox_notes(entry: rss.Entry, feed_name: str) -> str:
    body = f'Feed: {feed_name}\n\nOriginal title: {entry.title}'
    if entry.body:
        body += '\n\n' + entry.body
    budget = 10000 - len(copy_notes('x', entry.url)) + 1
    if len(body) > budget:
        suffix = '\n[Shortened for the show; original feed text is retained in the inbox.]'
        body = body[:budget - len(suffix)] + suffix
    return body


def ingest(db: Session, feed: RSSFeed, run: FeedRun, entries: list[rss.Entry | dict], warnings: list[str]) -> None:
    # This transaction covers all entries, provenance, dedup keys and final run.
    # Include manual and archived ideas when identifying existing article links.
    urls = {entry.url_key: entry.inbox_topic_id for entry in db.exec(select(FeedEntry)).all()}
    for item in db.exec(select(InboxTopic)).all():
        if item.source_url:
            with suppress(ValueError):
                urls[rss.canonical_url(item.source_url)] = item.id
    diagnostics = []
    for entry in entries:
        run.examined += 1
        if isinstance(entry, dict):
            run.skipped += 1
            diagnostics.append(entry)
            continue
        key = hashlib.sha256(f'{feed.id}\0{entry.identity}'.encode()).hexdigest()
        previous = db.get(FeedEntry, key)
        topic_id = previous.inbox_topic_id if previous else urls.get(entry.url)
        if topic_id:
            run.duplicates += 1
            diagnostics.append({'title': entry.title[:100], 'reason': 'Already captured; existing idea left unchanged.'})
        else:
            topic_id = str(uuid4())
            now = time.time()
            notes = inbox_notes(entry, feed.name)
            item = InboxTopic(id=topic_id, text=entry.title[:30], duration=feed.default_duration,
                              notes=notes, source_url=entry.url, created_at=now, updated_at=now)
            db.add(item)
            db.add(InboxSource(inbox_topic_id=topic_id, feed_id=feed.id, feed_name=feed.name,
                               original_title=entry.title, body_text=entry.body, published_at=entry.published,
                               imported_at=now, truncated=entry.truncated))
            run.created += 1
            urls[entry.url] = topic_id
        if previous is None:
            db.add(FeedEntry(id=key, feed_id=feed.id, url_key=entry.url, inbox_topic_id=topic_id))
        # A repeated GUID within this same document must see the inserted key.
        db.flush()
    run.warnings_json = json.dumps(warnings)
    run.items_json = json.dumps(diagnostics[:20])


def fail_run(run_id: str, message: str) -> dict:
    with saved_transaction() as db:
        run = db.get(FeedRun, run_id)
        assert run is not None
        feed = lookup(db, run.feed_id)
        if run.status == 'running':
            run.status, run.error, run.finished_at = 'failed', message, time.time()
            db.add(run)
        if feed.active_run_id == run.id:
            feed.active_run_id = None
            db.add(feed)
        return run_detail(run)


@router.post('/{feed_id}/import')
def import_feed(feed_id: str, payload: ImportFeed) -> dict:
    with saved_transaction() as db:
        feed = lookup(db, feed_id)
        check_revision(feed, payload.revision)
        if not feed.enabled:
            raise HTTPException(409, 'Enable this feed before importing.')
        if active(db, feed):
            raise HTTPException(409, 'This feed is already importing. Refresh to see its result.')
        run_id = start_import(db, feed)
        url = feed.url
    return finish_import(feed_id, run_id, url)


def start_import(db: Session, feed: RSSFeed) -> str:
    """Caller holds the write transaction and has checked the shared feed lease."""
    clear_interrupted(db, feed)
    run_id = str(uuid4())
    db.add(FeedRun(id=run_id, feed_id=feed.id, started_at=time.time()))
    feed.active_run_id = run_id
    db.add(feed)
    return run_id


def finish_import(feed_id: str, run_id: str, url: str) -> dict:
    # Network and parsing never hold a SQLite write lock or touch the live clock.
    try:
        data, final_url = rss.fetch_feed(url)
        entries, warnings = rss.parse_feed(data, final_url)
        with saved_transaction() as db:
            feed = lookup(db, feed_id)
            run = db.get(FeedRun, run_id)
            assert run is not None
            if feed.active_run_id != run.id or run.status != 'running':
                return run_detail(run)
            ingest(db, feed, run, entries, warnings)
            run.status, run.finished_at = 'succeeded', time.time()
            feed.active_run_id = None
            db.add(run)
            db.add(feed)
            return run_detail(run)
    except rss.FeedError as exc:
        return fail_run(run_id, str(exc))
    except Exception:
        # Atomic ingest was rolled back. Keep a durable safe failure record.
        return fail_run(run_id, 'The import could not be saved. No new ideas were added; try again.')
