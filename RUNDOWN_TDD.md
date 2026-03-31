# RUNDOWN — Technical Design Document
**Version:** 1.0  
**Author:** Beezy  
**Status:** Pre-Build  
**Last Updated:** March 30, 2026  
**Stack Context:** Full-stack engineer, Python/React primary, Mac mini always-on infra, Claude Code multi-agent familiar

---

## 0. Engineering Philosophy

This is personal tooling first. That changes almost every architectural decision:

- **No premature scaling.** SQLite over Postgres. Local filesystem over S3. Single process over microservices.
- **No premature auth.** No JWT, no sessions, no middleware for security you don't need yet.
- **Debuggability over elegance.** Readable Python jobs with verbose logging beat clever abstraction.
- **Cost discipline.** Every external API call has a cost. Design for minimum viable calls.

If this works and productizes, the V2 rewrite starts fresh with proper infra. V1 is not a prototype of V2 — it's a working tool that validates the concept.

---

## 1. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Mac Mini (always-on)                      │
│                                                                   │
│  ┌─────────────────┐    ┌────────────────────────────────────┐   │
│  │  Scheduler      │    │           Collector Agents          │   │
│  │  (APScheduler)  │───▶│  YouTube  │ TikTok │ X  │ RSS/News │   │
│  └─────────────────┘    └─────────────────┬──────────────────┘   │
│                                           │                       │
│  ┌────────────────────────────────────────▼──────────────────┐   │
│  │                     SQLite Database                        │   │
│  │   topics | assets | digests | segments | queries           │   │
│  └────────────────────────────────────────┬──────────────────┘   │
│                                           │                       │
│  ┌────────────────────────────────────────▼──────────────────┐   │
│  │                      AI Layer (Claude API)                 │   │
│  │   Relevance Scorer │ Curator │ Rundown Generator │ Query   │   │
│  └────────────────────────────────────────┬──────────────────┘   │
│                                           │                       │
│  ┌────────────────────────────────────────▼──────────────────┐   │
│  │                    FastAPI Backend                         │   │
│  │                  REST API + SSE for jobs                   │   │
│  └────────────────────────────────────────┬──────────────────┘   │
└───────────────────────────────────────────┼─────────────────────┘
                                            │
                              ┌─────────────▼──────────────┐
                              │     React Frontend          │
                              │   (AURA design system)      │
                              │   localhost:3000            │
                              └────────────────────────────┘
```

---

## 2. Technology Stack

| Layer | Choice | Justification |
|---|---|---|
| Backend runtime | Python 3.11+ | Fits Mac mini setup, rich scraping ecosystem |
| Web framework | FastAPI | Async support, auto-docs, lightweight |
| Scheduler | APScheduler 3.x | In-process, no Redis needed for personal use |
| Database | SQLite (via SQLModel) | Zero-config, file-based, 100% sufficient for single-user |
| ORM | SQLModel | Combines SQLAlchemy + Pydantic, clean models |
| AI layer | Anthropic Claude API (claude-sonnet-4-6) | Cost-efficient for scoring + generation at this volume |
| Frontend | React 18 + Vite | Fast dev, compatible with AURA system |
| Styling | Tailwind CSS | Rapid iteration, AURA variables layered on top |
| HTTP client | httpx (async) | Better than requests for async FastAPI context |

---

## 3. Data Source Strategy & Scraping Recommendation

This is the most consequential architectural decision. Here is the honest assessment for each platform:

### 3.1 YouTube ✅ Official API — Recommended

**Use:** YouTube Data API v3  
**Cost:** Free (10,000 units/day)  
**Quota math:** One search call = 100 units. At 6 topics × 2 searches/topic = 1,200 units/day. Well within free tier.  
**Capabilities:** Search by keyword, filter by date, get video metadata, channel uploads  
**Legal status:** Fully legitimate. Google's ToS permits this use.  
**Setup:** GCP project → Enable YouTube Data API v3 → API key (no OAuth needed for public data)

```python
# Cost breakdown per daily run
searches_per_topic = 2       # keyword + hashtag variant
topics = 6
units_per_search = 100
total_units = searches_per_topic * topics * units_per_search  # = 1,200
daily_quota = 10_000
# Remaining quota: 8,800 — plenty of headroom
```

### 3.2 TikTok ⚠️ Third-Party Scraper — Recommended (With Eyes Open)

**Recommendation:** [ScrapeCreators](https://scrapecreators.com) or Apify TikTok Scraper Actor  
**Cost:** ScrapeCreators: credit-based, ~$15-25/month for this volume  
**Why not official TikTok API:**
- TikTok's Display API (for creators) does not support content discovery by keyword/hashtag for third-party apps
- TikTok's Research API requires institutional affiliation (universities, research organizations) — not available to individual developers
- There is no official pathway for "find trending TikToks about [topic]" via API

**Why third-party scrapers are acceptable here:**
- V1 is personal tooling — you are not redistributing the data or building a commercial product on top of it
- You are accessing public content only (no login required to view these TikToks)
- You are not downloading video files — only metadata and URLs
- Legal precedent (hiQ v. LinkedIn) generally favors scraping of public data, though it's not settled law
- TikTok's enforcement focus is on mass data harvesting for AI training and competitive espionage, not personal tools

**Risk acknowledgment:** TikTok can block the scraper's proxy IPs, requiring the vendor to rotate them (they handle this). The API can break temporarily when TikTok updates its anti-bot measures. This is the cost of the dependency.

**Capability:** Hashtag search, keyword search, trending feed, specific account videos, video metadata (views, likes, comments, shares, caption, URL)

```python
# ScrapeCreators endpoint example
GET https://api.scrapecreators.com/v1/tiktok/search/hashtag
  ?hashtag=fashiondrop&count=20
Headers: x-api-key: YOUR_KEY
```

### 3.3 X/Twitter ⚠️ Official Basic API — Recommended

**Recommendation:** X API Basic tier ($100/month)  
**Why not a scraper:** X has become the most aggressively defended platform (rate limits rotate every 2-4 weeks, scrapers break constantly). The maintenance overhead for a DIY or managed scraper on X exceeds the cost of the Basic API for a personal tool.  
**Why not Free tier:** Free tier (v2) is write-only. You cannot read/search tweets on the free tier.  
**Cost:** $100/month. Non-trivial for personal tooling. If this is a blocker, use Apify's Twitter scraper ($10-20/month) with the understanding that it will break periodically.  
**Quota:** Basic tier = 10,000 tweets/month read. At 6 topics × ~5 tweets/topic/day × 30 days = 900 tweets/month. Well within quota.  
**Capabilities:** Recent search by keyword/hashtag, user timeline lookup, tweet metadata

**Decision framework:** If you stream > 3x/week and X discourse is core to your content (especially fashion-industry and AI-innovation topics), pay the $100. If you stream casually, use Apify and tolerate occasional downtime.

### 3.4 News / Articles ✅ RSS + NewsAPI — Free & Clean

**Primary:** RSS feeds from curated publications (direct, no intermediary, no ToS concerns)  
**Secondary:** [NewsAPI.org](https://newsapi.org) free tier (100 requests/day, plenty for this use)  

**Pre-configured RSS sources by topic:**

```yaml
fashion-drops:
  - https://hypebeast.com/feed
  - https://highsnobiety.com/rss
  - https://sneakernews.com/feed

fashion-industry:
  - https://wwd.com/feed/
  - https://vogue.com/feed/rss
  - https://businessoffashion.com/rss/all

fashion-tech:
  - https://techcrunch.com/feed/   # filtered by keywords
  - https://wwd.com/tag/technology/feed/

ai-innovation:
  - https://techcrunch.com/feed/
  - https://theverge.com/rss/index.xml
  - https://venturebeat.com/feed/   # filtered AI category

film-entertainment:
  - https://variety.com/feed/
  - https://deadline.com/feed/

brain-rot:
  # No RSS — TikTok and YouTube only for this topic
```

**RSS parsing:** Use `feedparser` library. Zero cost, zero rate limits, reliable.

### 3.5 Cost Summary

| Source | Tool | Est. Monthly Cost |
|---|---|---|
| YouTube | Official API | $0 |
| TikTok | ScrapeCreators | ~$20 |
| X/Twitter | Basic API | $100 (or Apify ~$15) |
| News/RSS | feedparser + NewsAPI free | $0 |
| Claude API | Anthropic | ~$10-20 (see Section 7) |
| Hosting | localhost / Mac mini | $0 |
| **Total** | | **~$130-140/mo** (or ~$45 with Apify for X) |

---

## 4. Database Schema

```sql
-- Topics: configurable, user-managed
CREATE TABLE topics (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,               -- used in Claude relevance scoring prompt
    keywords    TEXT,               -- JSON array
    hashtags    TEXT,               -- JSON array
    sources     TEXT,               -- JSON config object
    enabled     BOOLEAN DEFAULT 1,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Raw collected assets (pre-scoring)
CREATE TABLE assets (
    id              TEXT PRIMARY KEY,       -- UUID
    topic_id        TEXT REFERENCES topics(id),
    platform        TEXT NOT NULL,          -- 'tiktok' | 'youtube' | 'twitter' | 'rss'
    url             TEXT NOT NULL UNIQUE,
    title           TEXT,
    description     TEXT,
    thumbnail_url   TEXT,
    author          TEXT,
    published_at    DATETIME,
    
    -- Platform-specific engagement metrics (stored as JSON for flexibility)
    engagement_raw  TEXT,                   -- JSON: {views, likes, comments, shares}
    engagement_score FLOAT,                 -- normalized 0-1
    
    -- AI scoring
    relevance_score FLOAT,                  -- 0-10, null until scored
    relevance_reasoning TEXT,               -- Claude's brief explanation
    composite_score FLOAT,                  -- computed: relevance*0.6 + engagement*0.4
    
    -- Lifecycle
    collected_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    scored_at       DATETIME,
    status          TEXT DEFAULT 'new',     -- 'new' | 'scored' | 'used' | 'skipped' | 'expired'
    
    CONSTRAINT no_duplicate_within_week 
        CHECK (collected_at > datetime('now', '-7 days') OR url != url)
);

-- A digest is one day's rundown
CREATE TABLE digests (
    id          TEXT PRIMARY KEY,
    date        DATE NOT NULL UNIQUE,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    total_estimated_minutes INTEGER,
    status      TEXT DEFAULT 'draft'    -- 'draft' | 'active' | 'completed'
);

-- Segments are the show's building blocks, linked to a digest
CREATE TABLE segments (
    id              TEXT PRIMARY KEY,
    digest_id       TEXT REFERENCES digests(id),
    topic_id        TEXT REFERENCES topics(id),
    position        INTEGER,            -- sort order within digest
    headline        TEXT NOT NULL,      -- AI-generated, ~10 words
    talking_points  TEXT NOT NULL,      -- JSON array of 2-3 strings
    estimated_minutes INTEGER,
    primary_asset_id TEXT REFERENCES assets(id),
    supporting_assets TEXT,             -- JSON array of asset IDs
    status          TEXT DEFAULT 'pending', -- 'pending' | 'active' | 'used' | 'skipped'
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- On-demand queries
CREATE TABLE queries (
    id          TEXT PRIMARY KEY,
    prompt      TEXT NOT NULL,
    parsed_topic TEXT,                  -- Claude's interpretation of the query
    result_segment_id TEXT REFERENCES segments(id),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Collection job runs (for monitoring)
CREATE TABLE collection_runs (
    id              TEXT PRIMARY KEY,
    topic_id        TEXT REFERENCES topics(id),
    started_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at    DATETIME,
    assets_collected INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'running',  -- 'running' | 'success' | 'failed'
    error_message   TEXT
);
```

---

## 5. Agent Design

The AI layer has four distinct agents. Each is a Claude API call with a specific system prompt and deterministic inputs. They are not autonomous — they are invoked synchronously as part of defined pipeline steps.

### 5.1 Relevance Scorer Agent

**Invoked:** After collection, before curation  
**Purpose:** Score each raw asset 1-10 for relevance to its assigned topic  
**Batching:** Process up to 10 assets per Claude call to minimize API costs  

```python
RELEVANCE_SCORER_SYSTEM_PROMPT = """
You are a content relevance evaluator for a fashion and culture streaming show.
You will receive a topic configuration and a batch of collected content assets.
For each asset, output a relevance score (1-10) and a one-sentence reasoning.

Score interpretation:
9-10: Directly on-topic, high value, would make excellent stream content
7-8: On-topic, worth including
5-6: Tangentially related, include only if better options are unavailable
1-4: Off-topic, do not include

Respond ONLY with a JSON array. No preamble.
Format: [{"id": "...", "score": 8, "reason": "..."}]
"""

# Input constructed per batch:
user_message = f"""
Topic: {topic.name}
Description: {topic.description}
Keywords: {topic.keywords}

Assets to score:
{json.dumps(asset_batch, indent=2)}
"""
```

**Cost estimate:** ~1,000 tokens input + ~500 tokens output per 10-asset batch  
At claude-sonnet-4-6 pricing: approximately $0.003 per batch of 10 assets

### 5.2 Curator Agent

**Invoked:** After all topics are scored  
**Purpose:** Select the best assets per topic, cluster into segments, determine primary vs supporting  
**Input:** All scored assets for today grouped by topic  
**Output:** A proposed segment list with asset assignments

```python
CURATOR_SYSTEM_PROMPT = """
You are a broadcast producer building a daily show rundown for a culture/fashion
streaming show on Twitch. The show format is similar to PTI — opinionated, 
conversational, entertainment-first.

Given scored assets per topic, select and cluster them into 10-15 segments.

Rules:
- Each segment should have one PRIMARY asset (the main thing to react to)
- Optionally 1-2 SUPPORTING assets (context, contrast, or follow-up)
- Topics marked as "brain-rot" should have viscerally engaging content
- Prefer TikTok as primary asset when available (host's preference)
- Avoid clustering too many segments from the same topic
- Output segments in recommended stream order

Respond ONLY with valid JSON. No preamble.
"""
```

### 5.3 Rundown Generator Agent

**Invoked:** After curation, once per daily digest  
**Purpose:** Write the segment headlines, talking points, and time estimates  
**This is the highest-value Claude call in the pipeline**

```python
RUNDOWN_GENERATOR_SYSTEM_PROMPT = """
You are a show writer for a culture, fashion, and tech streaming show.
Your host is opinionated, culturally fluent, NYC-based, with a strong aesthetic
sensibility. They are informed but also entertaining. Think Complex Conversation
meets PTI.

For each segment, generate:
1. HEADLINE: 8-12 words. Punchy. Not a news headline — a conversation starter.
   Bad: "Balenciaga Announces New Creative Director"
   Good: "Balenciaga Just Handed the Keys to Someone Nobody Expected"

2. TALKING POINTS: 3 distinct angles, not 3 restatements of the same fact.
   - Point 1: The news/fact (brief)
   - Point 2: The interesting angle or implication
   - Point 3: A question or challenge that could spark chat interaction

3. ESTIMATED MINUTES: Integer. Be conservative. 
   - Single video < 3 min: 4 min total
   - Single video 3-10 min: 6-8 min total  
   - Article + context: 4 min total
   - Multi-asset: 8-12 min total

Respond ONLY with valid JSON. No preamble.
"""
```

### 5.4 On-Demand Query Agent

**Invoked:** User submits a freeform query  
**Purpose:** Parse intent → trigger ad-hoc collection → produce a single segment card  
**This is a two-step process:**

```
Step 1: Intent parsing
  Input: User's freeform text
  Output: {topic_id or null, keywords[], platforms[], timeframe}

Step 2: Collection + segment generation
  Input: Parsed intent + collected results
  Output: Single segment card (same format as Rundown Generator output)
```

**Latency expectation:** 15-30 seconds end-to-end. Show a loading state. Use SSE to stream status updates to the frontend ("Searching TikTok... Found 8 results... Scoring... Generating talking points...").

---

## 6. Backend API Design

```
FastAPI application: localhost:8000

# Digest endpoints
GET  /api/digest/today              → Today's rundown (segments + assets)
GET  /api/digest/{date}             → Historical digest by date
POST /api/digest/regenerate         → Re-run curation + generation for today

# Segment endpoints  
PATCH /api/segment/{id}/status      → Update status (used/skipped/pending)
PATCH /api/segment/{id}/position    → Reorder (drag-and-drop)

# Query (on-demand research)
POST /api/query                     → Submit freeform query
GET  /api/query/{id}/status         → SSE stream for job progress
GET  /api/query/{id}/result         → Completed segment card

# Topics
GET  /api/topics                    → List all topics
POST /api/topics                    → Create topic
PATCH /api/topics/{id}              → Update topic config
DELETE /api/topics/{id}             → Delete topic
PATCH /api/topics/{id}/toggle       → Enable/disable topic

# Collection
GET  /api/collection/status         → Last run status per topic
POST /api/collection/run            → Trigger manual collection run
GET  /api/collection/runs           → Recent run history

# Pre-stream summary
GET  /api/digest/today/summary      → Total runtime + title list for overlay
```

---

## 7. Claude API Cost Model

All calls use `claude-sonnet-4-6` (cost-efficient, more than sufficient for this task).

| Agent | Calls/day | Avg tokens in | Avg tokens out | Est. cost/day |
|---|---|---|---|---|
| Relevance Scorer | ~12 batches of 10 | ~1,200 | ~600 | ~$0.05 |
| Curator | 1 | ~3,000 | ~1,500 | ~$0.02 |
| Rundown Generator | 1 | ~4,000 | ~2,000 | ~$0.03 |
| On-demand Query | ~2/day avg | ~2,000 | ~1,000 | ~$0.02 |
| **Daily total** | | | | **~$0.12** |
| **Monthly total** | | | | **~$3.60** |

Total Claude API cost: **< $5/month**. Negligible.

---

## 8. Scheduler Design

```python
from apscheduler.schedulers.background import BackgroundScheduler

scheduler = BackgroundScheduler()

# Daily digest pipeline — runs at 9AM
scheduler.add_job(
    run_daily_pipeline,
    'cron',
    hour=9, minute=0,
    id='daily_digest',
    max_instances=1,    # never run two at once
    coalesce=True       # if missed, run once when back online
)

# RSS feed refresh — runs every 4 hours (RSS is cheap)
scheduler.add_job(
    refresh_rss_feeds,
    'interval',
    hours=4,
    id='rss_refresh'
)
```

**Pipeline execution order:**
```
run_daily_pipeline():
  1. collect_youtube()   → async, per topic
  2. collect_tiktok()    → async, per topic  
  3. collect_twitter()   → async, per topic
  4. collect_rss()       → sync, already cached
  5. score_assets()      → Claude API, batched
  6. curate_segments()   → Claude API
  7. generate_rundown()  → Claude API
  8. save_digest()       → SQLite write
  9. notify_ready()      → Log + optional desktop notification
```

Steps 1-4 run concurrently. Steps 5-9 are sequential.

---

## 9. Frontend Architecture

### 9.1 Component Structure

```
src/
├── components/
│   ├── Rundown/
│   │   ├── RundownFeed.jsx          # Main scrollable feed
│   │   ├── SegmentCard.jsx          # Individual segment card
│   │   ├── SegmentCardDetail.jsx    # Expanded detail panel
│   │   ├── TalkingPoints.jsx        # Bulleted talking points
│   │   ├── MediaEmbed.jsx           # TikTok/YouTube embed wrapper
│   │   └── DurationBadge.jsx        # Time estimate pill
│   ├── Query/
│   │   ├── QueryInput.jsx           # Freeform search bar
│   │   ├── QueryStatus.jsx          # SSE-fed loading state
│   │   └── QueryResult.jsx          # Result segment card
│   ├── Summary/
│   │   └── PreStreamModal.jsx       # Total runtime + title list
│   ├── Topics/
│   │   ├── TopicList.jsx
│   │   └── TopicEditor.jsx
│   └── Status/
│       └── CollectionStatus.jsx     # Last run time + asset counts
├── hooks/
│   ├── useDigest.js                 # Today's digest data
│   ├── useQuery.js                  # On-demand query + SSE
│   └── useTopics.js
├── store/
│   └── digestStore.js               # Zustand store for segment order/status
└── pages/
    ├── Today.jsx                    # Main rundown view
    ├── Archive.jsx                  # Historical digests
    └── Settings.jsx                 # Topic configuration
```

### 9.2 Key Interaction: Drag-and-Drop Reorder

Use `@dnd-kit/core` + `@dnd-kit/sortable` for drag-and-drop segment reordering. On drop, PATCH `/api/segment/{id}/position` with new position integer. Optimistic update in Zustand store.

### 9.3 Key Interaction: TikTok Embeds

TikTok provides an official oEmbed endpoint:
```
GET https://www.tiktok.com/oembed?url={tiktok_url}
```
Returns embed HTML. Render in an iframe. This is the legitimate, ToS-compliant way to embed TikToks — it's what web publishers use. No scraping of video files involved.

YouTube: Use standard YouTube iframe embed API.

### 9.4 Mobile Consideration

The rundown should be usable on iPhone (you might review it on your phone before sitting down to stream). Apply responsive breakpoints:
- Mobile: Single-column, full-width segment cards, swipe-left to skip, swipe-right to mark used
- Desktop: Two-column layout (feed + detail panel)

Use `react-swipeable` for mobile gestures.

---

## 10. Deduplication Strategy

An asset is considered a duplicate if:
1. Exact URL match within the last 7 days — hard block, never re-add
2. Same author + same video posted to multiple platform sources — fuzzy match on title, auto-merge
3. Same story covered by multiple news sources — keep highest engagement version, link others as supporting

Implementation: Check URL against `assets` table on insert. For fuzzy matching (same story, different source), run a lightweight similarity check on title strings before Claude scoring — if Levenshtein distance < 0.3, flag for merge.

---

## 11. Development Phases

### Phase 1: Foundation (Week 1-2)
- [ ] SQLite schema + SQLModel setup
- [ ] FastAPI skeleton with all endpoints returning mocks
- [ ] YouTube collector (official API)
- [ ] RSS collector (feedparser)
- [ ] Basic React shell with AURA styling — rundown view renders mock data

### Phase 2: Core Pipeline (Week 3-4)
- [ ] APScheduler + daily pipeline structure
- [ ] Relevance Scorer agent (Claude API)
- [ ] Curator agent
- [ ] Rundown Generator agent
- [ ] Full end-to-end: collection → scoring → digest in DB → renders in UI

### Phase 3: Social Sources (Week 5)
- [ ] TikTok collector (ScrapeCreators API)
- [ ] X/Twitter collector (Basic API or Apify)
- [ ] TikTok oEmbed integration in SegmentCard
- [ ] Deduplication logic

### Phase 4: Interactive Features (Week 6)
- [ ] Drag-and-drop segment reorder
- [ ] Mark used/skip segment status
- [ ] On-demand query flow + SSE loading state
- [ ] Pre-stream summary modal
- [ ] Mobile swipe gestures

### Phase 5: Polish (Week 7)
- [ ] Collection status dashboard
- [ ] Historical digest archive view
- [ ] Topic editor UI (edit without touching YAML)
- [ ] Error handling + retry logic for collectors
- [ ] Log viewer for collection runs

---

## 12. Error Handling & Reliability

### Collector Failures
- Each collector wraps calls in try/except, logs failure to `collection_runs` table
- If TikTok scraper fails: skip topic for that run, log, continue pipeline with other sources
- If YouTube quota exhausted: fall back to RSS-only for YouTube-heavy topics
- If Claude API fails: skip AI agents, surface raw top-scored assets with placeholder talking points (better than nothing)

### Scheduler Reliability
- APScheduler with `coalesce=True` — if Mac mini was asleep at 9AM, job runs immediately on wake
- `max_instances=1` prevents parallel runs if a job runs long
- Manual trigger endpoint (`POST /api/collection/run`) as override for any missed run

### Data Freshness
- Assets older than 7 days are auto-expired (status = 'expired') and excluded from scoring
- RSS feeds refresh every 4 hours independently of the main pipeline
- YouTube and TikTok collection only runs once per day (quota and cost discipline)

---

## 13. Local Development Setup

```bash
# Backend
python -m venv .venv
source .venv/bin/activate
pip install fastapi uvicorn sqlmodel apscheduler httpx feedparser anthropic python-dotenv

# Environment variables (.env)
ANTHROPIC_API_KEY=sk-ant-...
YOUTUBE_API_KEY=AIza...
SCRAPECREATORS_API_KEY=...
TWITTER_BEARER_TOKEN=...       # X Basic API bearer token

# Run backend
uvicorn main:app --reload --port 8000

# Frontend
cd frontend
npm install
npm run dev   # localhost:3000
```

---

## 14. Open Architecture Decisions (Pre-Build)

These are explicitly deferred — decide before Phase 3:

| Decision | Options | Recommendation |
|---|---|---|
| X/Twitter access | Basic API ($100/mo) vs Apify (~$15/mo) | Start with Apify, upgrade if X discourse is high-value |
| TikTok scraper vendor | ScrapeCreators vs Apify TikTok Actor | ScrapeCreators has TikTok-specific endpoints; prefer it |
| Local vs remote hosting | Mac mini localhost vs VPS | Mac mini for V1. If Mac goes offline regularly, move to $6/mo VPS |
| Notifications | None vs desktop notif | Add `terminal-notifier` for macOS push when digest is ready |

---

*End of TDD v1.0*
