"""Local, explainable curation and explicit composition; never operates the live show."""

import hashlib
import json
import re
import time
import unicodedata
from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlmodel import Session, select

from rundown import inbox, library
from rundown.db import session
from rundown.models import (
    InboxSource,
    InboxTopic,
    ResearchBuild,
    ResearchPreference,
    RetrievedItem,
    SavedShow,
)

router = APIRouter(prefix="/research", tags=["research"])
Category = Literal["fashion-drops", "fashion-industry", "fashion-tech", "ai-innovation",
                   "film-entertainment", "brain-rot", "uncategorized"]
CATEGORIES = [
    {"id": "fashion-drops", "label": "Fashion drops"},
    {"id": "fashion-industry", "label": "Fashion industry"},
    {"id": "fashion-tech", "label": "Fashion tech"},
    {"id": "ai-innovation", "label": "AI innovation"},
    {"id": "film-entertainment", "label": "Film & entertainment"},
    {"id": "brain-rot", "label": "Internet culture"},
    {"id": "uncategorized", "label": "Uncategorized"},
]
KEYWORDS = {
    "fashion-drops": {"sneaker", "sneakers", "streetwear", "drop", "drops", "collab"},
    "fashion-industry": {"fashion", "runway", "luxury", "designer", "couture"},
    "fashion-tech": {"wearable", "wearables", "textile", "textiles", "smartwatch"},
    "ai-innovation": {"ai", "llm", "gpt", "anthropic", "openai", "chatgpt", "robotics"},
    "film-entertainment": {"film", "movie", "cinema", "trailer", "actor", "netflix", "music"},
    "brain-rot": {"meme", "memes", "viral", "tiktok", "streamer", "twitch"},
}


class PreferencesIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0, strict=True)
    category: Category | None
    priority: int = Field(ge=0, le=3, strict=True)
    pinned: bool = Field(strict=True)
    excluded: bool = Field(strict=True)

    @model_validator(mode="after")
    def no_excluded_pin(self):
        if self.pinned and self.excluded:
            raise ValueError("A pinned topic cannot also be excluded.")
        return self


class ProposalIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    count: int = Field(ge=1, le=20, strict=True)
    categories: list[Category] = Field(default_factory=list, max_length=7)


class Selection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=80)
    revision: int = Field(ge=1, strict=True)
    preference_revision: int = Field(ge=0, strict=True)


class PreviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    selections: list[Selection] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def distinct(self):
        if len({s.id for s in self.selections}) != len(self.selections):
            raise ValueError("Each selected topic must appear only once.")
        return self


class BuildIn(PreviewIn, library.ShowName):
    request_id: UUID


def normalized_title(value: str) -> str:
    return " ".join(re.findall(r"\w+", unicodedata.normalize("NFKC", value).casefold()))


def category_for(item: InboxTopic, source: InboxSource | RetrievedItem | None) -> str:
    text = source.original_title if source else item.text
    tokens = set(normalized_title(text).split())
    scores = {category: len(tokens & words) for category, words in KEYWORDS.items()}
    winner = max(scores, key=lambda k: scores[k])
    return winner if scores[winner] else "uncategorized"


def preference(pref: ResearchPreference | None) -> dict:
    return {"revision": pref.revision if pref else 0,
            "category": pref.category if pref else None,
            "priority": pref.priority if pref else 0,
            "pinned": pref.pinned if pref else False,
            "excluded": pref.excluded if pref else False}


def row(item: InboxTopic, source: InboxSource | RetrievedItem | None,
        pref: ResearchPreference | None, now: float) -> dict:
    options = preference(pref)
    category = options["category"] or category_for(item, source)
    timestamp = item.created_at
    recency_basis = "capture time"
    if source and source.published_at:
        try:
            parsed = datetime.fromisoformat(source.published_at.replace("Z", "+00:00"))
            if parsed.tzinfo is not None and parsed.timestamp() <= now + 300:
                timestamp = parsed.timestamp()
                recency_basis = "source publication time"
        except (ValueError, OverflowError):
            pass
    age_hours = max(0, (now - timestamp) / 3600)
    freshness = 20 if age_hours < 24 else 10 if age_hours < 72 else 5 if age_hours < 168 else 0
    score = options["priority"] * 25 + freshness + (5 if item.notes.strip() else 0)
    reasons = [f"Priority {options['priority']}/3: +{options['priority'] * 25}",
               f"Freshness from {recency_basis}: +{freshness}"]
    if item.notes.strip():
        reasons.append("Saved context: +5")
    if options["pinned"]:
        reasons.insert(0, "Pinned: selected ahead of unpinned stories")
    full_title = source.original_title if source else item.text
    return {**inbox.detail(item, source), "preferences": options, "category": category,
            "category_origin": "manual" if options["category"] else "keyword suggestion",
            "score": score, "reasons": reasons, "full_title": full_title,
            "group_id": item.id, "related_count": 0}


def candidates(db: Session) -> list[dict]:
    sources = inbox.all_sources(db)
    prefs = {p.inbox_topic_id: p for p in db.exec(select(ResearchPreference)).all()}
    now = time.time()
    rows = [row(i, sources.get(i.id), prefs.get(i.id), now)
            for i in db.exec(select(InboxTopic).where(InboxTopic.archived == False)).all()]  # noqa: E712
    # Only exact full headline or exact source URL; never merge/delete originals.
    parent = {r["id"]: r["id"] for r in rows}

    def root(key):
        while parent[key] != key:
            parent[key] = parent[parent[key]]
            key = parent[key]
        return key

    seen = {}
    for r in sorted(rows, key=lambda r: r["id"]):
        title = normalized_title(r["full_title"])
        keys = [("title", title)] if len(title.split()) >= 4 else []
        if r["source_url"]:
            keys.append(("url", r["source_url"]))
        for key in keys:
            if key in seen:
                parent[root(r["id"])] = root(seen[key])
            else:
                seen[key] = r["id"]
    sizes: dict[str, int] = {}
    for r in rows:
        r["group_id"] = root(r["id"])
        sizes[r["group_id"]] = sizes.get(r["group_id"], 0) + 1
    for r in rows:
        r["related_count"] = sizes[r["group_id"]] - 1
    return sorted(rows, key=lambda r: (-int(r["preferences"]["pinned"]), -r["score"],
                                      r["created_at"], r["id"]))


@router.get("")
def get_research() -> dict:
    with session() as db:
        return {"categories": CATEGORIES, "method": "local-rules-v1",
                "items": candidates(db)}


@router.put("/{topic_id}/preferences")
def save_preferences(topic_id: str, payload: PreferencesIn) -> dict:
    with library.saved_transaction() as db:
        item = inbox.lookup(db, topic_id)
        if item.archived:
            raise HTTPException(409, "Restore this topic in the Inbox before curating it.")
        pref = db.get(ResearchPreference, topic_id)
        if payload.revision != (pref.revision if pref else 0):
            raise HTTPException(409, "Curation changed on another screen. Reload before saving.")
        values = payload.model_dump(exclude={"revision"})
        if pref is None:
            pref = ResearchPreference(inbox_topic_id=topic_id, **values)
        else:
            for key, value in values.items():
                setattr(pref, key, value)
            pref.revision += 1
        db.add(pref)
        return preference(pref)


@router.post("/propose")
def propose(payload: ProposalIn) -> dict:
    with session() as db:
        rows = [r for r in candidates(db) if not r["preferences"]["excluded"]
                and (not payload.categories or r["category"] in payload.categories)]
        return select_rows(rows, payload.count)


def select_rows(rows: list[dict], count: int, method: str = "local-rules-v1",
                prefer_priority: bool = False) -> dict:
    pins = [r for r in rows if r["preferences"]["pinned"]]
    if len(pins) > count:
        raise HTTPException(409, "More pinned topics than requested slots. Increase the count or unpin topics.")
    selected = list(pins)
    groups = {r["group_id"] for r in selected}
    counts: dict[str, int] = {}
    for r in selected:
        counts[r["category"]] = counts.get(r["category"], 0) + 1
    remaining = [r for r in rows if not r["preferences"]["pinned"]]
    while len(selected) < count:
        options = [r for r in remaining if r["group_id"] not in groups]
        if not options:
            break
        chosen = min(options, key=lambda r: (-r["preferences"]["priority"] if prefer_priority else 0,
                                             -r["score"] if prefer_priority else 0,
                                             counts.get(r["category"], 0), -r["score"],
                                             r["created_at"], r["id"]))
        selected.append(chosen)
        groups.add(chosen["group_id"])
        counts[chosen["category"]] = counts.get(chosen["category"], 0) + 1
        remaining.remove(chosen)
    warnings = []
    if len(selected) < count:
        warnings.append(f"Only {len(selected)} distinct eligible stories are available.")
    if len(groups) < len(selected):
        warnings.append("Pinned selections include matching coverage; review both before saving.")
    return {"items": selected, "warnings": warnings, "method": method}

def preview(db: Session, selections: list[Selection]) -> dict:
    topics = []
    for chosen in selections:
        item = inbox.lookup(db, chosen.id)
        pref = db.get(ResearchPreference, item.id)
        if (item.archived or item.revision != chosen.revision
                or chosen.preference_revision != (pref.revision if pref else 0)):
            raise HTTPException(409, "Selected research changed. Refresh the shortlist and preview again.")
        if pref and pref.excluded:
            raise HTTPException(409, "An excluded topic cannot be added. Change its curation first.")
        topics.append({"text": item.text, "duration": item.duration,
                       "notes": inbox.copy_notes(item.notes, item.source_url)})
    return {"topics": topics, "total_seconds": sum(t["duration"] for t in topics),
            "method": "saved-context", "warnings": [
                "Uses saved titles, durations and context. No AI text has been generated."]}


@router.post("/preview")
def preview_selection(payload: PreviewIn) -> dict:
    with library.saved_transaction() as db:
        return preview(db, payload.selections)


@router.post("/shows", status_code=201)
def build_show(payload: BuildIn) -> dict:
    request_id = str(payload.request_id)
    digest = hashlib.sha256(json.dumps(payload.model_dump(mode="json", exclude={"request_id"}),
                                       sort_keys=True).encode()).hexdigest()
    with library.saved_transaction() as db:
        previous = db.get(ResearchBuild, request_id)
        if previous:
            if previous.payload_hash != digest:
                raise HTTPException(409, "This save request was already used for a different draft.")
            saved = db.get(SavedShow, previous.show_id)
            if saved is None:
                raise HTTPException(409, "The previously saved show no longer exists.")
            return library.detail(saved)
        data = preview(db, payload.selections)
        saved = library.create(db, payload.name, data["topics"])
        db.flush()
        db.add(ResearchBuild(request_id=request_id, payload_hash=digest, show_id=saved.id))
        return library.detail(saved)
