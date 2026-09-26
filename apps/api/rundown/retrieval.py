"""Saved discovery searches and explicit durable imports into the research inbox."""
import re
import time
from contextlib import suppress
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlmodel import Session, col, select

from rundown import collectors, presentation, rss
from rundown.config import settings
from rundown.db import session
from rundown.library import ShowName, _stamp, saved_transaction
from rundown.models import (
    FeedEntry,
    InboxTopic,
    RetrievalIdentity,
    RetrievalRun,
    RetrievalSource,
    RetrievedItem,
    TopicPresentation,
)

router = APIRouter(prefix='/retrieval', tags=['topic-retrieval'])
LEASE_SECONDS = 120


class SourceIn(ShowName):
    platform: Literal['youtube', 'reddit']
    query: str = Field(default='', max_length=200)
    scope: str = Field(default='', max_length=80)
    freshness_hours: int = Field(default=168, ge=1, le=720, strict=True)
    limit: int = Field(default=20, ge=1, le=50, strict=True)
    default_duration: int = Field(default=120, ge=15, le=3600, strict=True)
    enabled: bool = Field(default=True, strict=True)

    @model_validator(mode='after')
    def valid_search(self):
        self.query, self.scope = self.query.strip(), self.scope.strip()
        if self.platform == 'reddit':
            self.scope = self.scope.removeprefix('r/').lower()
        if not self.query and not self.scope:
            raise ValueError('Enter keywords or a channel/subreddit.')
        if self.scope:
            pattern = r'UC[A-Za-z0-9_-]{22}' if self.platform == 'youtube' else r'[a-z0-9_]{2,21}'
            if not re.fullmatch(pattern, self.scope):
                raise ValueError('Use a YouTube channel ID (UC plus 22 characters) or a subreddit name.')
        if any(ord(c) < 32 for c in self.query):
            raise ValueError('Keywords must be a single line.')
        return self


class SourceEdit(SourceIn):
    revision: int = Field(ge=1, strict=True)


class ImportIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: int = Field(ge=1, strict=True)
    request_id: UUID


def lookup(db: Session, source_id: str) -> RetrievalSource:
    source = db.get(RetrievalSource, source_id)
    if source is None:
        raise HTTPException(404, 'Retrieval source not found.')
    return source


def run_detail(run: RetrievalRun) -> dict:
    return {**run.model_dump(), 'status': 'interrupted' if run.status == 'running' and time.time() - run.started_at >= LEASE_SECONDS else run.status, 'started_at': _stamp(run.started_at),
            'finished_at': _stamp(run.finished_at) if run.finished_at else None}


def running(db: Session) -> RetrievalRun | None:
    return db.exec(select(RetrievalRun).where(RetrievalRun.status == 'running',
                   RetrievalRun.started_at > time.time() - LEASE_SECONDS)).first()


def detail(db: Session, source: RetrievalSource) -> dict:
    latest = db.exec(select(RetrievalRun).where(RetrievalRun.source_id == source.id).order_by(
        col(RetrievalRun.started_at).desc(), col(RetrievalRun.id).desc())).first()
    reason = collectors.availability(source.platform)
    return {**source.model_dump(), 'created_at': _stamp(source.created_at), 'updated_at': _stamp(source.updated_at),
            'setup_reason': reason, 'can_import': source.enabled and reason is None and running(db) is None,
            'latest_run': run_detail(latest) if latest else None}


@router.get('')
def list_sources() -> dict:
    with session() as db:
        used = len(db.exec(select(RetrievalRun).where(RetrievalRun.started_at >= int(time.time() // 86400) * 86400)).all())
        return {'sources': [detail(db, s) for s in db.exec(select(RetrievalSource).order_by(col(RetrievalSource.created_at).desc())).all()],
                'providers': [{'platform': p, 'setup_reason': collectors.availability(p)} for p in ['youtube', 'reddit']],
                'daily_limit': settings.retrieval_daily_limit, 'used_today': used,
                'mode': 'fixture' if settings.retrieval_test_origin else 'live'}


@router.post('', status_code=201)
def create_source(payload: SourceIn) -> dict:
    with saved_transaction() as db:
        values = payload.model_dump()
        for old in db.exec(select(RetrievalSource)).all():
            if all(getattr(old, k) == v for k, v in values.items()):
                return detail(db, old)
        now = time.time()
        source = RetrievalSource(id=str(uuid4()), created_at=now, updated_at=now, **values)
        db.add(source)
        db.flush()
        return detail(db, source)


@router.get('/{source_id}/runs')
def runs(source_id: str) -> dict:
    with session() as db:
        lookup(db, source_id)
        rows = db.exec(select(RetrievalRun).where(RetrievalRun.source_id == source_id).order_by(
            col(RetrievalRun.started_at).desc(), col(RetrievalRun.id).desc()).limit(20)).all()
        return {'runs': [run_detail(r) for r in rows]}


@router.put('/{source_id}')
def edit_source(source_id: str, payload: SourceEdit) -> dict:
    with saved_transaction() as db:
        source = lookup(db, source_id)
        if source.revision != payload.revision:
            raise HTTPException(409, 'Source changed elsewhere. Your edits are kept; reload before saving.')
        active = running(db)
        if active and active.source_id == source_id:
            raise HTTPException(409, 'Wait for this collection to finish before editing its settings.')
        for key, value in payload.model_dump(exclude={'revision'}).items():
            setattr(source, key, value)
        source.revision += 1
        source.updated_at = time.time()
        db.add(source)
        return detail(db, source)


def ingest(db: Session, source: RetrievalSource, run: RetrievalRun, entries: list[rss.Entry]):
    urls: dict[str, str] = {}
    identities: dict[str, str] = {}
    for item in db.exec(select(InboxTopic)).all():
        if item.source_url:
            with suppress(ValueError):
                urls[rss.canonical_url(item.source_url)] = item.id
    for old in db.exec(select(FeedEntry)).all():
        urls[old.url_key] = old.inbox_topic_id
    for original in db.exec(select(RetrievedItem)).all():
        urls[original.url] = original.inbox_topic_id
    for url, topic_id in urls.items():
        if ident := collectors.platform_identity(url):
            identities[ident] = topic_id
    for entry in entries:
        known = db.get(RetrievalIdentity, entry.identity)
        topic_id = known.inbox_topic_id if known else identities.get(entry.identity) or urls.get(entry.url)
        if topic_id:
            if known is None:
                db.add(RetrievalIdentity(id=entry.identity, inbox_topic_id=topic_id))
                db.flush()
            # Card metadata is backfilled for older collected imports only;
            # manual ideas and existing rows are never touched.
            if db.get(TopicPresentation, topic_id) is None and db.exec(select(RetrievedItem).where(
                    RetrievedItem.inbox_topic_id == topic_id)).first() is not None:
                db.add(presentation.from_entry(topic_id, source.platform, entry, time.time()))
            run.duplicates += 1
            continue
        now, topic_id = time.time(), str(uuid4())
        notes = f'{source.platform.title()} · {source.name}\nOriginal title: {entry.title}\nPublished: {entry.published}\n\n{entry.body}'
        if entry.truncated:
            notes += '\n[Source text shortened.]'
        db.add(InboxTopic(id=topic_id, text=entry.title[:30], duration=source.default_duration,
                          notes=notes, source_url=entry.url, created_at=now, updated_at=now))
        db.add(RetrievedItem(id=entry.identity, inbox_topic_id=topic_id, platform=source.platform,
                             feed_id=source.id, feed_name=source.name, url=entry.url,
                             original_title=entry.title, body_text=entry.body, published_at=entry.published or '',
                             imported_at=now, truncated=entry.truncated))
        db.add(RetrievalIdentity(id=entry.identity, inbox_topic_id=topic_id))
        db.add(presentation.from_entry(topic_id, source.platform, entry, now))
        db.flush()
        urls[entry.url] = topic_id
        identities[entry.identity] = topic_id
        run.created += 1


@router.post('/{source_id}/import')
def import_source(source_id: str, payload: ImportIn) -> dict:
    run_id = str(payload.request_id)
    with saved_transaction() as db:
        source = lookup(db, source_id)
        existing = db.get(RetrievalRun, run_id)
        if existing:
            if existing.source_id != source_id or existing.revision != payload.revision:
                raise HTTPException(409, 'Request ID already belongs to a different collection.')
            return run_detail(existing)
        if source.revision != payload.revision:
            raise HTTPException(409, 'Source changed elsewhere. Reload before collecting.')
        if not source.enabled:
            raise HTTPException(409, 'Enable this source before collecting.')
        if reason := collectors.availability(source.platform):
            raise HTTPException(503, reason)
        if running(db):
            raise HTTPException(409, 'Another collection is running. Refresh its status before trying again.')
        now = time.time()
        recent = db.exec(select(RetrievalRun).where(RetrievalRun.started_at > now - 2)).first()
        if recent:
            raise HTTPException(429, 'Wait a moment before starting another collection.')
        if len(db.exec(select(RetrievalRun).where(RetrievalRun.started_at >= int(now // 86400) * 86400)).all()) >= settings.retrieval_daily_limit:
            raise HTTPException(429, 'Daily collection attempt allowance reached; resets at midnight UTC.')
        for old in db.exec(select(RetrievalRun).where(RetrievalRun.status == 'running')).all():
            old.status, old.error, old.finished_at = 'failed', 'Collection was interrupted. Start a new attempt.', now
            db.add(old)
        run = RetrievalRun(id=run_id, source_id=source_id, revision=payload.revision, started_at=now,
                           mode='fixture' if settings.retrieval_test_origin else 'live')
        db.add(run)
        snapshot = RetrievalSource(**source.model_dump())
    try:
        entries, skipped = collectors.collect(snapshot)
        with saved_transaction() as db:
            run = db.get(RetrievalRun, run_id)
            assert run is not None
            if run.status != 'running':
                return run_detail(run)
            source = lookup(db, source_id)
            if source.revision != snapshot.revision:
                raise rss.FeedError('Source changed before collection finished. No items were imported.')
            ingest(db, snapshot, run, entries)
            run.skipped, run.status, run.finished_at = skipped, 'succeeded', time.time()
            db.add(run)
            return run_detail(run)
    except Exception as exc:
        error = str(exc) if isinstance(exc, rss.FeedError) else 'Collection failed. No new items were saved; try again.'
        with saved_transaction() as db:
            run = db.get(RetrievalRun, run_id)
            assert run is not None
            if run.status == 'running':
                run.status, run.error, run.finished_at = 'failed', error, time.time()
                db.add(run)
            return run_detail(run)
