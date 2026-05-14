from datetime import datetime
from enum import StrEnum

from sqlmodel import Field, SQLModel


class SourceKind(StrEnum):
    rss = "rss"
    youtube = "youtube"
    tiktok = "tiktok"
    x = "x"
    reddit = "reddit"
    newsletter = "newsletter"


class TopicBucket(StrEnum):
    fashion_drops = "fashion-drops"
    fashion_industry = "fashion-industry"
    fashion_tech = "fashion-tech"
    ai_innovation = "ai-innovation"
    film_entertainment = "film-entertainment"
    brain_rot = "brain-rot"


class Source(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str
    kind: SourceKind
    config_json: str = "{}"
    enabled: bool = True


class Asset(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    source_id: int = Field(foreign_key="source.id", index=True)
    bucket: TopicBucket = Field(index=True)

    url: str = Field(index=True)
    title: str
    author: str | None = None
    body: str | None = None
    thumbnail_url: str | None = None

    likes: int | None = None
    comments: int | None = None
    shares: int | None = None
    views: int | None = None

    published_at: datetime | None = Field(default=None, index=True)
    fetched_at: datetime = Field(default_factory=datetime.utcnow, index=True)

    raw_path: str | None = None


class Score(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    asset_id: int = Field(foreign_key="asset.id", index=True)

    relevance: float
    engagement: float
    composite: float

    reason: str | None = None
    model: str
    scored_at: datetime = Field(default_factory=datetime.utcnow)


class Rundown(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    generated_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    pushed_at: datetime | None = None
    notes: str | None = None


class RundownItem(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    rundown_id: int = Field(foreign_key="rundown.id", index=True)
    position: int

    text: str
    duration: int

    asset_id: int | None = Field(default=None, foreign_key="asset.id")
    talking_points_json: str = "[]"


class StreamSession(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    rundown_id: int = Field(foreign_key="rundown.id", index=True)
    started_at: datetime = Field(default_factory=datetime.utcnow)
    ended_at: datetime | None = None
    vod_url: str | None = None


class Feedback(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    rundown_item_id: int = Field(foreign_key="rundownitem.id", index=True)
    rating: int
    note: str | None = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
