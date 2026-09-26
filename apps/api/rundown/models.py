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


class RundownItemNotes(SQLModel, table=True):
    """Additive storage for topic context without altering existing history rows."""

    rundown_item_id: int = Field(primary_key=True, foreign_key="rundownitem.id")
    notes: str


class SavedShow(SQLModel, table=True):
    """Named preparation copy, independent of the live clock and its archives."""

    id: str = Field(primary_key=True)
    name: str
    revision: int = 1
    topics_json: str = "[]"
    created_at: float
    updated_at: float = Field(index=True)


class InboxTopic(SQLModel, table=True):
    """Manual research idea; show topics are independent copies of its content."""

    id: str = Field(primary_key=True)
    revision: int = 1
    text: str
    duration: int
    notes: str = ""
    source_url: str = ""
    archived: bool = Field(default=False, index=True)
    created_at: float
    updated_at: float = Field(index=True)


class RSSFeed(SQLModel, table=True):
    id: str = Field(primary_key=True)
    revision: int = 1
    name: str
    url: str = Field(unique=True)
    default_duration: int = 120
    enabled: bool = True
    active_run_id: str | None = None
    created_at: float
    updated_at: float


class FeedRun(SQLModel, table=True):
    id: str = Field(primary_key=True)
    feed_id: str = Field(foreign_key="rssfeed.id", index=True)
    status: str = "running"
    started_at: float = Field(index=True)
    finished_at: float | None = None
    created: int = 0
    duplicates: int = 0
    skipped: int = 0
    examined: int = 0
    error: str | None = None
    warnings_json: str = "[]"
    items_json: str = "[]"


class FeedEntry(SQLModel, table=True):
    # Hash of feed id + entry GUID (or canonical URL), retained after archive.
    id: str = Field(primary_key=True)
    feed_id: str = Field(foreign_key="rssfeed.id", index=True)
    url_key: str = Field(index=True)
    inbox_topic_id: str = Field(foreign_key="inboxtopic.id")


class InboxSource(SQLModel, table=True):
    inbox_topic_id: str = Field(primary_key=True, foreign_key="inboxtopic.id")
    feed_id: str = Field(foreign_key="rssfeed.id")
    feed_name: str
    original_title: str
    body_text: str
    published_at: str | None = None
    imported_at: float
    truncated: bool = False


class PreparationRun(SQLModel, table=True):
    id: str = Field(primary_key=True)
    topic_id: str = Field(foreign_key="inboxtopic.id", index=True)
    revision: int
    status: str = "running"
    started_at: float = Field(index=True)
    finished_at: float | None = None
    model: str
    summary: str | None = None
    talking_points_json: str = "[]"
    input_truncated: bool = False
    input_tokens: int | None = None
    output_tokens: int | None = None
    error: str | None = None


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


class FeedbackTiming(SQLModel, table=True):
    """Manual timing for a feedback revision; preserves the legacy Feedback schema."""

    feedback_id: int = Field(primary_key=True, foreign_key="feedback.id")
    actual_seconds: int | None = None


class ResearchPreference(SQLModel, table=True):
    inbox_topic_id: str = Field(primary_key=True, foreign_key="inboxtopic.id")
    revision: int = 1
    category: str | None = None
    priority: int = 0
    pinned: bool = False
    excluded: bool = False


class ResearchBuild(SQLModel, table=True):
    request_id: str = Field(primary_key=True)
    payload_hash: str
    show_id: str = Field(foreign_key="savedshow.id")


class FeedSchedule(SQLModel, table=True):
    """Opt-in interval and durable claim cursor; existing feed schemas stay intact."""

    feed_id: str = Field(primary_key=True, foreign_key='rssfeed.id')
    revision: int = 0
    enabled: bool = False
    interval_minutes: int = 60
    next_run_at: float | None = Field(default=None, index=True)
    last_run_id: str | None = None


class ResearchAnalysis(SQLModel, table=True):
    id: str = Field(primary_key=True)
    payload_hash: str
    input_hash: str
    brief: str
    selections_json: str
    status: str = "running"
    started_at: float = Field(index=True)
    finished_at: float | None = None
    model: str
    mode: str
    result_json: str = "[]"
    input_tokens: int | None = None
    output_tokens: int | None = None
    error: str | None = None


class ShowPreparationRun(SQLModel, table=True):
    id: str = Field(primary_key=True)
    show_id: str = Field(foreign_key='savedshow.id', index=True)
    revision: int
    payload_hash: str
    input_hash: str
    status: str = 'running'
    started_at: float = Field(index=True)
    finished_at: float | None = None
    model: str
    mode: str
    result_json: str = '[]'
    input_tokens: int | None = None
    output_tokens: int | None = None
    error: str | None = None
    applied_hash: str | None = None
    applied_revision: int | None = None


class RetrievalSource(SQLModel, table=True):
    id: str = Field(primary_key=True)
    revision: int = 1
    name: str
    platform: str
    query: str = ""
    scope: str = ""
    freshness_hours: int = 168
    limit: int = 20
    default_duration: int = 120
    enabled: bool = True
    created_at: float
    updated_at: float


class RetrievalRun(SQLModel, table=True):
    id: str = Field(primary_key=True)
    source_id: str = Field(foreign_key="retrievalsource.id", index=True)
    revision: int
    status: str = "running"
    started_at: float = Field(index=True)
    finished_at: float | None = None
    created: int = 0
    duplicates: int = 0
    skipped: int = 0
    error: str | None = None
    mode: str


class RetrievedItem(SQLModel, table=True):
    id: str = Field(primary_key=True)
    inbox_topic_id: str = Field(foreign_key="inboxtopic.id", index=True)
    platform: str
    feed_id: str = Field(foreign_key="retrievalsource.id")
    feed_name: str
    url: str
    original_title: str
    body_text: str
    published_at: str
    imported_at: float
    truncated: bool = False


class RetrievalIdentity(SQLModel, table=True):
    """Remember dedup against manual/RSS ideas even after their link is edited."""
    id: str = Field(primary_key=True)
    inbox_topic_id: str = Field(foreign_key="inboxtopic.id")


class TopicPresentation(SQLModel, table=True):
    """Additive card metadata for an imported idea. Source text, generated notes
    and the personal note live elsewhere; this row is never required."""

    inbox_topic_id: str = Field(primary_key=True, foreign_key="inboxtopic.id")
    provider: str
    creator: str = ""
    excerpt: str = ""
    thumbnail_url: str | None = None
    thumbnail_width: int | None = None
    thumbnail_height: int | None = None
    media_seconds: int | None = None
    # ready: image offered; partial: no usable image, text-first card.
    state: str = "partial"
    reason: str | None = None
    fetched_at: float


class TopicEditorial(SQLModel, table=True):
    """Personal bookmark and note with its own revision namespace, independent
    from InboxTopic.revision and from imported or generated notes."""

    inbox_topic_id: str = Field(primary_key=True, foreign_key="inboxtopic.id")
    revision: int = 0
    saved: bool = False
    note: str = ""
    updated_at: float


class ShowPlan(SQLModel, table=True):
    """Additive streaming-day metadata for a saved show. Old shows have no row."""

    show_id: str = Field(primary_key=True, foreign_key="savedshow.id")
    stream_date: str = Field(index=True)
    created_at: float


class ShowTopicOrigin(SQLModel, table=True):
    """Display metadata for one saved-show topic snapshot: which idea it came
    from and its full headline. The 30-character live label stays in the
    snapshot; this row never changes timing, order or notes."""

    topic_id: str = Field(primary_key=True)
    show_id: str = Field(foreign_key="savedshow.id", index=True)
    inbox_topic_id: str = Field(foreign_key="inboxtopic.id", index=True)
    display_title: str
    label: str
    created_at: float


class TopicCapture(SQLModel, table=True):
    """A topic the user wrote, linked or uploaded from Discover. The full
    headline and retained text live here; InboxTopic keeps the live label."""

    inbox_topic_id: str = Field(primary_key=True, foreign_key="inboxtopic.id")
    kind: str
    display_title: str
    source_text: str = ""
    created_at: float


class Attachment(SQLModel, table=True):
    """A managed upload stored under settings.assets_dir by opaque id. The
    client filename is display only; the stored name is chosen by the server."""

    id: str = Field(primary_key=True)
    inbox_topic_id: str = Field(foreign_key="inboxtopic.id", index=True)
    role: str
    filename: str
    media_type: str
    size: int
    sha256: str
    width: int | None = None
    height: int | None = None
    created_at: float
