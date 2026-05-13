# RUNDOWN — End-to-End Implementation Plan
**Author:** Beezy
**Last Updated:** 2026-05-13
**Status:** Active — Phase 3 (OBS overlay) shipped; Phases 0–2 + 4–7 ahead

This plan turns the v2 PRD + TDD into a concrete build sequence. It assumes the
already-built OBS overlay (`rundown-obs-final.html` + `rundown_obs_bridge.py`)
stays as-is and the rest of the system is built around it.

---

## Hard constraints

- **No paid data services.** No ScrapeCreators, no X Basic, no Apify. Collectors
  must run on free APIs, public endpoints, or Playwright + stealth against a
  logged-in browser profile on the mac mini.
- **Single user, local infra.** Mac mini + Tailscale. SQLite, not Postgres.
  Local filesystem, not S3.
- **Cost discipline on Claude calls.** Batch scoring (10 assets/call), cache
  the system prompt + rubric, only summarize the topics that actually make it
  into a rundown.
- **Topic schema is fixed by the overlay:** `{text: str, duration: int}`. The
  generator must emit text ≤30 chars for LCD legibility.

---

## Current state

**Built (lives in `design docs/`):**
- `rundown-obs-final.html` — OBS Browser Source overlay, 1920×1080, transparent bg
- `rundown-stream-preview.html` — local preview with simulated cameras
- `rundown-walkman-demo.html` — isolated walkman device demo
- `rundown_obs_bridge.py` — FastAPI router: `GET /rundown/topics`, `POST /rundown/push-to-obs`, OBS WebSocket v5 refresh

**Spec'd but not built:**
- Research pipeline (collectors, scoring, curation, rundown generator)
- FastAPI app shell + SQLite schema
- React control-room UI
- Scheduler (APScheduler) + orchestration
- Producer remote (phone/tablet)

---

## Target repo layout

```
Rundown/
├── apps/
│   ├── api/           # FastAPI + collectors + scoring + scheduler
│   │   ├── rundown/
│   │   │   ├── main.py
│   │   │   ├── db.py              # SQLModel + engine
│   │   │   ├── models.py
│   │   │   ├── collectors/
│   │   │   ├── scoring/
│   │   │   ├── curator.py
│   │   │   ├── generator.py
│   │   │   ├── scheduler.py
│   │   │   └── obs_bridge.py      # moved from design docs
│   │   ├── pyproject.toml
│   │   └── tests/
│   ├── web/           # React + Vite + Tailwind control room
│   └── overlay/       # the three HTML files, served as static
├── data/              # SQLite db, raw cache, logs (gitignored)
├── design docs/       # PRD, TDD, this plan, tiktok notes
└── .github/workflows/
```

---

## Phase 0 — Foundations (Week 1)

**Goal:** scaffolded repo, working FastAPI app that serves the existing OBS
bridge from a real database.

1. Create the directory layout above.
2. `apps/api`: Python 3.11 + uv. Deps: `fastapi`, `uvicorn`, `sqlmodel`,
   `apscheduler`, `httpx`, `feedparser`, `playwright`, `playwright-stealth`,
   `anthropic`, `pydantic`, `python-dotenv`.
3. `apps/web`: `npm create vite@latest -- --template react-ts`. Add Tailwind
   and the AURA design tokens.
4. SQLModel schema (see §"Data model" below) → `data/rundown.db`.
5. Move `rundown_obs_bridge.py` into `apps/api/rundown/obs_bridge.py`. Replace
   the in-memory `_current_topics` with a SQLModel query against the most
   recent `Rundown` row.
6. `.env` for `ANTHROPIC_API_KEY`, `OBS_WS_PASS`, `YOUTUBE_API_KEY`.
7. GitHub Actions: ruff + pyright on `apps/api`, eslint + tsc + vitest on
   `apps/web`. Runs on PRs to `main`.

**Exit criteria:** `uvicorn rundown.main:app` boots, `GET /rundown/topics`
returns whatever's in the DB, `POST /rundown/push-to-obs` writes a Rundown
row and refreshes OBS.

---

## Phase 1 — Collectors, free-tier only (Weeks 2–3)

**Goal:** daily job pulls ~120 assets across 6 topic buckets, stored in SQLite.

Topic buckets (from project memory): `fashion-drops`, `fashion-industry`,
`fashion-tech`, `ai-innovation`, `film-entertainment`, `brain-rot`.

| Source | How | Cost | Notes |
|---|---|---|---|
| RSS | `feedparser` | $0 | Fashion blogs, AI newsletters, tech outlets |
| YouTube | Data API v3 | $0 (10k units/day) | Channels + topic search |
| TikTok | Playwright + stealth | $0 | Logged-in profile at `~/.openclaw/browser/tiktok-profile`, per `TIKTOK_SCRAPING_NOTES.md` |
| X / Twitter | Playwright + stealth | $0 | Same pattern as TikTok with a logged-in profile against x.com. Fall back to dropping X if detection becomes a problem; no paid API |
| Reddit | Public `*.json` endpoints | $0 | No auth needed for public subs |
| Newsletters | Dedicated Gmail + IMAP | $0 | Forward newsletters to that mailbox, `mailparser` extracts body |

Implementation rules:
- Each collector is a function `async def collect(since: datetime) -> list[Asset]`.
- Raw payloads cached to disk at `data/raw/{source}/{yyyy-mm-dd}/`.
- Circuit-break per source: one collector failing must not break the run.
- Rate limits: TikTok 2–5s human-like delay between page navs; YouTube respect
  daily quota; Reddit `User-Agent` header + ≥2s between requests.

**Exit criteria:** `python -m rundown.collectors.run --since=24h` produces
~120 fresh `Asset` rows across the 6 buckets with zero paid API calls.

---

## Phase 2 — Scoring + curation (Week 4)

**Goal:** every Asset gets a composite score; Curator picks ~20 candidates
across the 6 buckets.

- **Anthropic SDK**, `claude-sonnet-4-6`. Prompt caching on the system prompt
  + scoring rubric.
- **Relevance Scorer:** batch 10 assets/call → JSON `{id, score 0-100, reason}`.
- **Engagement score** (from `TIKTOK_SCRAPING_NOTES.md`):
  `(likes·0.4 + comments·0.4 + shares·0.2) / views`. Normalized per-platform.
- **Composite:** `relevance·0.6 + engagement·0.4`.
- **Curator:**
  - Dedupe by title/URL, then by embedding similarity (use Claude's embeddings
    or `sentence-transformers/all-MiniLM-L6-v2` locally — pick local to stay
    free and fast).
  - Cluster within each bucket.
  - Return top candidates per bucket so the generator has options.

**Exit criteria:** scoring a 120-asset batch costs <$0.50 in Claude calls and
finishes in under 90 seconds.

---

## Phase 3 — Rundown generator (Week 5)

**Goal:** 8-segment rundown emitted in the overlay's schema, auto-pushed.

- Allocate 8 segments across the 6 buckets, with TikTok as the tiebreaker for
  ties (per project memory).
- For each chosen segment, Claude produces:
  - `text` — display label, ≤30 chars, ALL CAPS-safe
  - `talking_points` — 3–5 bullets, stored on `RundownItem` (not pushed to
    overlay, surfaced in the React UI)
  - `duration` — suggested seconds (60–180)
- Write `Rundown` + `RundownItem` rows.
- Call `POST /rundown/push-to-obs` with the topic array. Bridge handles the
  OBS WebSocket refresh.

**Exit criteria:** a single command (`rundown generate --push`) produces a
rundown, persists it, and the OBS overlay flips to the new topics within 5s.

---

## Phase 4 — React control room (Weeks 5–6, parallel with Phase 3)

**Goal:** a localhost:3000 app for show prep + live control.

- AURA design tokens. Sony-walkman/CD-player aesthetic to match the overlay.
- **Today view:**
  - Today's rundown — reorder (drag), edit text, edit duration, regenerate a
    single segment, pin/unpin.
  - Per-segment talking points panel.
  - "Push to OBS" button → `POST /rundown/push-to-obs`.
- **Archive view:** past rundowns, filter by date/bucket, anchor to Twitch VOD
  timestamps (manual entry for now).
- **Live view (when streaming):** mirror of the overlay state with the same
  transport controls — useful when OBS Interact window is awkward.

**Exit criteria:** can run a full show prep — review rundown, tweak two
segments, push to OBS — in under 5 minutes.

---

## Phase 5 — Scheduling + orchestration (Week 6)

**Goal:** daily 9 AM job runs end-to-end without manual intervention.

- APScheduler cron: `0 9 * * *` local time → `pipeline.run_daily()`.
- Orchestrator: `collect → score → curate → generate → push-to-obs`.
- Per-step retries (exponential backoff, max 3).
- Structured logs to `data/logs/{yyyy-mm-dd}.jsonl`.
- `/health` endpoint that the React app polls and surfaces in a status bar.
- Failure notification: write to a `~/Library/Logs/rundown-failures.log` and
  optionally a macOS notification via `osascript` — no external services.

**Exit criteria:** 5 consecutive days of green runs without me touching it.

---

## Phase 6 — Producer remote + live integration (Week 7)

**Goal:** control the overlay from a phone/tablet during the stream.

- Second HTML page served by FastAPI, accessible over Tailscale.
- Auth: simple bearer token in the URL (single-user, behind Tailscale = good
  enough).
- Controls: jump to topic N, pause/resume, reset, edit topic text live.
- Implementation: page polls `GET /rundown/topics` every 2s, control actions
  `POST` to a new `/rundown/control` endpoint that pushes the change to the
  overlay (re-uses the bridge).

**Exit criteria:** full stream rundown navigation from phone with no laptop
interaction.

---

## Phase 7 — Feedback + calibration (ongoing after Week 7)

- **Post-stream rating widget:** thumb up/down per segment. Stored on
  `Feedback`. Used as a scoring nudge for the next pipeline run.
- **Duration calibration:** first 5 streams, log actual vs. predicted segment
  length manually. Use the deltas to recalibrate the generator's duration
  prompt.
- **Future:** auto-pull Twitch VOD chapter marks if I start using them; learn
  durations from real timestamps.

---

## Data model (Phase 0)

```python
class Source(SQLModel, table=True):
    id: int; name: str; kind: str  # rss|youtube|tiktok|x|reddit|newsletter
    config_json: str               # url, channel id, hashtag, etc.

class Asset(SQLModel, table=True):
    id: int; source_id: int
    url: str; title: str; author: str | None
    body: str | None; thumbnail: str | None
    likes: int | None; comments: int | None; shares: int | None; views: int | None
    published_at: datetime; fetched_at: datetime
    bucket: str                    # fashion-drops, etc.

class Score(SQLModel, table=True):
    id: int; asset_id: int
    relevance: float; engagement: float; composite: float
    reason: str; model: str; scored_at: datetime

class Rundown(SQLModel, table=True):
    id: int; generated_at: datetime; pushed_at: datetime | None
    notes: str | None

class RundownItem(SQLModel, table=True):
    id: int; rundown_id: int; position: int
    text: str; duration: int       # matches overlay schema
    asset_id: int | None           # which asset it was generated from
    talking_points_json: str       # list[str]

class StreamSession(SQLModel, table=True):
    id: int; rundown_id: int; started_at: datetime; ended_at: datetime | None
    vod_url: str | None

class Feedback(SQLModel, table=True):
    id: int; rundown_item_id: int; rating: int  # -1, 0, +1
    note: str | None; created_at: datetime
```

---

## V2 decision gate

Ship if 6 weeks of use saves 60+ minutes of pre-stream prep on average. If
not, the build is wrong, not the tool — re-scope rather than abandon.

---

*End of plan.*
