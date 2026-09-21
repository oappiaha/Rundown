# rundown — API

FastAPI app: saved shows, persistent live schedule, shared playback clock, and OBS bridge.
Research ingestion, scoring, and generation are planned but not implemented in
this checkout.

## Setup

```bash
cd apps/web
npm ci
npm run build

cd ../api
uv sync
# If needed, create .env from .env.example without overwriting existing keys.
uv run uvicorn rundown.main:app --reload
```

The control room will be at <http://localhost:8000>, the OBS overlay at
<http://localhost:8000/static/overlay.html>, and OpenAPI docs at `/docs`.

For frontend development, run `npm run dev` from `apps/web`; Vite proxies
`/health` and `/rundown/*` to the API on port 8000.

## Useful entry points

- `rundown.main:app` — FastAPI app
- `rundown.db:init_db()` — create SQLite tables
- `rundown.obs_bridge` — OBS WebSocket refresh + topics endpoints

## Shared show state

- `GET /rundown/state`: stable topic IDs, active ID, pause state, remaining
  seconds, revision, server time. Fresh installations start empty and paused.
- `PUT /rundown/schedule`: `{revision, topics}`; new topics omit `id`. Saves
  preserve the current segment and elapsed time. Stale saves or removal of the
  active topic return 409. Select another topic before removing the active one.
- `POST /rundown/control`: `{revision, action, topic_id?}`. Actions: play,
  pause, next, previous, jump, reset. Reset selects the first topic paused.
- `GET /rundown/topics` remains compatible with old topic-only consumers.
- `POST /rundown/push-to-obs` is the legacy full-show replacement operation.
  It selects the first topic paused; new live clients use PUT instead.

An additive `showclock` table stores playback. Existing rundown rows bootstrap
the first shared state without modifying their schema. SQLite serializes
revision checks and commits; concurrent writers cannot both accept one revision.
The clock uses elapsed wall time and catches up on the next state request even
after a process restart. Overlay and control room poll once per second. No
OBS refresh is needed when editing via PUT.

Verification uses `DB_PATH`, `RAW_CACHE_DIR`, and `LOGS_DIR` pointed at temporary
directories. Tests automatically isolate all three. Never verify against the
project's live `data/rundown.db`.

## Topic notes / context

Each topic in `/rundown/state` includes `notes`, a plain multiline string (empty
when absent). New and existing entries in `PUT /rundown/schedule` accept up to
10,000 Unicode characters. Newlines, source URLs, and whitespace are preserved;
notes are not interpreted as HTML or fetched from the web.

Send `notes: ""` to clear context. Omitting `notes` for an existing topic keeps
its stored value, so an older client editing a title cannot erase it. A notes
edit uses the normal revision check and preserves playback time and identity.
The control room displays notes; the OBS overlay and legacy `/rundown/topics`
display/return only the short topic labels and durations.

Current context lives in `showclock.topics_json`. Historical notes use the
additive `rundownitemnotes` table keyed to a rundown item. Startup creates the
new table without altering old rows; old clock/history entries read as empty
notes. New archives include context atomically with the schedule. Existing
structured `talking_points_json` data is not rewritten.

## Saved shows

Saved shows are named preparation copies stored in the additive `savedshow`
table. Saving them never updates the live clock or its published history.
Names are trimmed to1–80 characters, and a saved show may contain0–20 topics
with the same title/duration/notes rules as the live schedule.

- `GET /shows`: summaries ordered by last update (name, revision, topic count,
  total seconds, creation/update timestamps).
- `GET /shows/{id}`: full saved show with topics and notes.
- `POST /shows`: `{name, topics?}`; topics contain content only, no IDs.
- `PUT /shows/{id}`: `{revision, name, topics}`; existing saved-topic IDs stay
  stable, while new rows omit their ID. A stale revision returns409.
- `POST /shows/from-live`: `{name, live_revision}` copies the currently
  published rundown into a named show. Client-side unsaved edits are excluded.
- `POST /shows/{id}/duplicate`: `{revision, name}` copies a saved show with
  independent show/topic IDs and notes.
- `POST /shows/{id}/activate`: `{revision, live_revision}` replaces the live
  rundown with a copy of this saved version. It returns the usual `ShowState`,
  selects its first topic paused at full duration, and archives atomically.
  An empty show or a stale saved/live revision returns409. No OBS refresh.

Creation/copy routes return201. Unknown shows return404; invalid values or
foreign/duplicate saved-topic IDs return422. Copy a single topic by adding its
text, duration, and notes without its ID to the target saved show, then saving
that target. Changes to either copy never propagate to the other automatically.

Only activation changes live topics. The UI confirms this transition and
requires unsaved live/saved edits to be resolved first. Current show playback
does not automatically start when a saved show is activated.

## Topic inbox

Manual ideas are stored separately from saved shows and the live clock:

- `GET /inbox?archived=false`: active ideas (default); `archived=true` lists archived ideas.
- `GET /inbox/{id}`: one idea and its copy-ready `topic` projection.
- `POST /inbox`: capture `{text, duration, notes?, source_url?}`.
- `PUT /inbox/{id}`: full edit `{revision, text, duration, notes, source_url}`.
- `POST /inbox/{id}/archive`: archive or restore `{revision, archived}`.

Titles use the same 30-character limit as schedule topics; durations are integer
seconds (15–3600). Context stays verbatim. The optional source URL must be HTTP(S),
without credentials or whitespace, and is stored without fetching the page.
`topic.notes` appends `Source: <url>` to the context; the combined text must fit
10,000 Unicode characters. Use `topic` when copying into a schedule or saved show
so attribution survives. Every copy has an independent identity and remains
unchanged when its inbox idea is edited or archived.

Inbox edits and archive/restore use optimistic revisions: stale requests return
409 without mutation. Archived ideas must be restored before editing. The
additive `InboxTopic` table does not alter existing data. Inbox operations never
initialize, advance, or write the live clock, and never refresh OBS.

## RSS/Atom sources and import history

- `GET /feeds`, `GET /feeds/{id}`: feed settings and latest import result.
- `POST /feeds`: `{name,url,default_duration}`; saving does not fetch anything.
- `PUT /feeds/{id}`: `{revision,name,default_duration,enabled}`. The URL is
  immutable; add another feed to use a different address.
- `POST /feeds/{id}/import`: `{revision}` starts an explicit import. Returns an
  import run, including `status` (`succeeded` or `failed`), counters, warnings
  and skipped-entry reasons. **HTTP200 alone does not mean the import succeeded.**
- `GET /feeds/{id}/runs`: the latest20 runs, including failures and running jobs.

Imports populate the inbox, never a live or saved show directly. Entry IDs and
canonical article URLs deduplicate repeated/cross-feed imports, including ideas
that were edited, manually captured or archived. Existing ideas are never
rewritten or restored by an import. Inbox `source` metadata retains the feed name,
original title and plain feed text independently of editable notes. Article pages
are not fetched, and imported HTML is not rendered.

Network retrieval validates public addresses and each redirect, connects to a
validated IP, verifies TLS for HTTPS, requests uncompressed XML, and caps input
at2MB and100 examined entries. DTD/entity declarations are rejected. Retained
source text is capped at50,000 characters and the original title at1,000, with a
`truncated` flag. Initial show notes are shortened to fit the10,000-character
limit including attribution; retained source text remains available for review.

A per-feed lease rejects overlapping imports and settings changes. Interrupted
leases become retryable after120seconds; a deliberate retry marks the abandoned
run failed. All new ideas, provenance, dedup records and successful run results
commit atomically; a failed import adds no partial batch. Configuration revisions
change on edits, not imports. A new source is enabled by default.

Verification uses only owned loopback fixtures. `RSS_TEST_FEED_ORIGIN` is empty
normally; tests can set an exact `http://127.0.0.1:<fixture-port>` origin to allow
that one fixture. It does not allow other private addresses or redirect ports.
Reference: [Python XML security](https://docs.python.org/3/library/xml.html#xml-vulnerabilities).

## Assisted topic preparation

`GET /preparation/status` reports readiness and the persisted daily request
allowance. `GET /preparation/topics/{id}` shows the exact input preview and latest
suggestion. `POST /preparation/topics/{id}/generate` accepts
`{revision, request_id: <UUID>, consent: true}`. It saves a separate generation
record, never changes inbox notes, sources, saved shows or playback. The browser
lets the user edit the suggestion and append it to a local context draft; the
normal **Save idea** action persists that change.

Operator configuration (API process environment; do not put keys in the browser):

- `PREPARATION_ENABLED=true` explicitly enables generation; default is false.
- `PREPARATION_MODEL=<your available Claude model ID>` is required, no default.
- `ANTHROPIC_API_KEY` is required for the real provider.
- `PREPARATION_DAILY_LIMIT=10` caps attempts per UTC day (allowed range 1–100).

Each attempt sends at most 12,000 characters of previewed source/context plus a
fixed system instruction, and caps output at 1,200 tokens. These are request/token
controls, **not a dollar budget**; provider pricing and account limits still apply.
Failed and interrupted attempts consume the local allowance because they may
incur provider usage. No automatic retries. Reusing a UUID for the same topic and
revision returns the original run without calling the provider again. Simultaneous
requests are serialized for allowance checks; one active request per idea.

A 90-second interrupted lease allows a deliberate new attempt. Editing or
archiving an idea makes its older suggestion stale. Invalid/incomplete provider
output is stored as a failed run, with a safe error; failed generations return
HTTP 200 with `status: failed`, while readiness/validation/conflict/cap refusals
use 503/422/409/429. Output schema is one summary and 3–5 talking points. Input
text is treated as untrusted evidence, with no tools, browsing or URL fetching.

The adapter uses the installed Anthropic SDK's
[Messages API](https://platform.claude.com/docs/en/api/messages/create), fixed
HTTPS endpoint, disabled retries, and a 30-second HTTP timeout. No dependencies
were added. `PREPARATION_TEST_ORIGIN=http://127.0.0.1:<port>` is only for isolated
protocol testing: it accepts an exact literal loopback origin, always substitutes
a dummy credential and reports `mode: fixture`. Leave it unset in normal use.

## Automatic RSS imports

Every feed starts with automatic imports off. GET /feeds/{id}/schedule returns
its settings, next time, last automatic run and effective state. PUT the same
route with revision, enabled and interval_minutes (15–10080) to save explicitly.
The schedule has its own revision, independent of the feed configuration.

Enabling starts the first interval; changing the interval starts a fresh interval.
Saving unchanged settings preserves the next time. Disabling the schedule clears
its next time. Disabling the feed pauses its schedule without erasing the choice;
reenabling the feed starts a fresh interval. Manual imports do not move the timer.

A lightweight API-owned thread scans due schedules every five seconds. It claims
a due run and advances its next time in the same SQLite transaction used to claim
the shared feed import lock. Multiple API processes can safely scan one database;
a manual import already in progress defers a due automatic one. History, duplicate
detection and error handling are shared with manual imports. Failures wait for the
next normal interval; there is no rapid retry loop or AI generation.

The API must be running and the machine awake. After downtime, an overdue feed
runs once, then schedules its next interval from that claim; missed intervals are
not replayed. Interval arithmetic uses UTC elapsed time, independent of DST;
the browser displays timestamps with its local timezone.

RSS_SCHEDULER_ENABLED=false pauses the API scheduler globally without changing
stored schedules. Its default is true, but no feed runs until individually enabled.
RSS_SCHEDULER_POLL_SECONDS defaults to 5 (range 1–60); use 1 in isolated tests.
FeedSchedule is an additive table: no existing feed/history columns are changed.
No API keys, launchd installation or paid provider access are required.


## Published-version review

`GET /reviews?limit=20&before_id=<id>` lists published rundown snapshots newest
first (limit 1–50, exclusive cursor). `GET /reviews/{version_id}` returns their
immutable topic titles, planned durations and private context alongside reviews.
These are published versions, not recorded stream sessions.

`PUT /reviews/{version_id}/topics/{item_id}` explicitly saves the full payload:
`revision` (integer, 0 when unreviewed), `rating` (-1, 0, 1), `note` (up to 4000
characters), and `actual_seconds` (integer 0–86400 or null for unrecorded).
Returns the updated topic and actual-minus-planned delta. Revision is the latest
Feedback ID, not a per-topic sequential counter. Stale saves return 409;
wrong-version/missing topics return 404; malformed or extra fields return 422.

Saves append Feedback and additive FeedbackTiming rows atomically. Existing
feedback without a timing row remains readable with an unrecorded duration.
No existing table schema, archived topic, live clock, scoring or model setting
is changed. Durations are entered manually; zero differs from unrecorded.


## Research and show composition

`GET /research` returns active Inbox stories with editable preferences, resolved
categories, local ranking reasons and conservative exact-title/source-URL groups.
The method is `local-rules-v1`; keyword categories and ranking are not AI results.
Original feed headlines and publication dates inform grouping and freshness.

`PUT /research/{topic_id}/preferences` saves the full revision-guarded object:
`revision`, nullable `category`, integer `priority` (0–3), `pinned`, `excluded`.
Pinning and excluding the same story is invalid. Stale edits return 409.
`POST /research/propose` accepts `count` (1–20) and optional `categories`; it
honors pins/exclusions and chooses distinct coverage with category diversity.

`POST /research/preview` accepts ordered `selections` containing `id`, Inbox
`revision` and `preference_revision`. It returns existing titles, durations,
context/source attribution and total seconds without creating a show.
`POST /research/shows` accepts those selections, `name` and a UUID `request_id`.
It atomically creates an independent Saved Show; retrying the same request ID
and payload returns that same show. Reusing the ID for another payload returns
409. Changed, archived or excluded selections require a fresh preview/selection.

ResearchPreference and ResearchBuild are additive tables. Research operations
leave the live rundown alone; activation remains a separate Saved Shows action.
No model calls or API keys are used by this composition flow.


## Optional AI research ranking and grouping

Research analysis compares an explicit selection of 1–20 saved Inbox stories
against an editable show brief. It returns suggested relevance scores, categories,
same-event groups and explanations. These are editorial suggestions requiring
review. They do not edit sources, curation, saved shows or live playback.

Configuration (off by default):

```dotenv
RESEARCH_AI_ENABLED=true
RESEARCH_AI_MODEL="your-model-id"
RESEARCH_AI_DAILY_LIMIT=5
ANTHROPIC_API_KEY="your-key"
```

Keep credentials in the API server environment. Select an available model before
enabling; no model is assumed by default. Restart the API after changing settings.
For real use, leave `PREPARATION_TEST_ORIGIN` empty. This existing test-only setting
also supports research protocol verification through a loopback fixture using a
dummy key. It must never be configured as an external provider URL.

### Endpoints and recovery

- `GET /research/ai`: settings/readiness, remaining daily attempts, latest run.
- `POST /research/ai/input`: `{brief, selections}`; brief is 10–1000 characters and
  selections use the existing research revision snapshot. Returns the exact
  `input_text`, its `input_hash`, truncation indicator and current settings.
  Previewing does not call a provider.
- `POST /research/ai/generate`: the same brief/selections plus `input_hash`, UUID
  `request_id`, and literal `consent: true`. Source changes require a new preview.
  The same ID/body retrieves the same running or terminal run; a changed body
  with that ID returns 409. It never automatically repeats a provider call.
- `GET /research/ai/runs/{id}`: recover that exact result, even after a newer run
  exists or the API restarted. Status is running/succeeded/failed/interrupted;
  `stale` marks changed, archived or excluded source selections.
- `POST /research/ai/runs/{id}/propose`: `{count: 1..20}`; returns a proposal for
  the existing editable composer. Rejects stale/unavailable results with 409.

The proposal honors manual pins and priority, keeps manual categories, and ranks
by AI relevance within equal priorities. Category variety breaks equal-score ties;
it cannot promote a weaker match above a stronger one. The proposal ordinarily
selects one story per AI group. The separate local-rules shortlist still balances
categories.
Explicit pins can include multiple reports of the same event, with a warning.
AI annotations remain in the analysis result; returned catalog rows retain local
metadata. Users can add/remove/reorder stories before previewing and saving.

### Bounds and persistence

The additive `ResearchAnalysis` table stores request identity, source revisions,
input hash, brief, model/mode, result, status and reported usage. One active
research analysis is allowed across processes. Provider I/O runs outside the
SQLite write lock so topic editing remains available. The request timeout is
30 seconds and the interruption lease is 90 seconds.

Per story, input retains at most 500 title characters, 1000 context characters
and 1500 source-text characters, plus the saved source link/date/category.
Shortening is disclosed. Output is limited to 5000 tokens, validated JSON with
all selected IDs exactly once, bounded scores/categories/reasons, and valid group
representatives. Truncated, missing or invented-ID output fails without adoption.
The transport requires a complete response and disables SDK retries; see the
[Anthropic stop-reason contract](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons).

The daily attempt limit is 1–100 (default 5), resetting at midnight UTC. Failed
and interrupted attempts count because usage may have been billed. This is a
request limit, not a monetary budget. Per-topic preparation has its own limit.
Missing configuration returns 503, the daily limit 429, and malformed input 422.

Verified locally with an Anthropic-compatible fixture, real SDK requests,
concurrency, restart and desktop/phone browser checks. Live model relevance and
grouping quality have not yet been evaluated; no billed calls were made.


## Whole-show preparation

A saved Research shortlist or manually composed Saved Show can generate a summary
and 3–5 talking points for every topic in one request. Generation stores a separate
review result. Only explicit apply appends selected, edited notes to the Saved Show.
Original context/source links, topic IDs, titles, durations and order remain intact;
Inbox and live playback are unaffected. Activation remains a separate action.

This uses existing `PREPARATION_ENABLED`, `PREPARATION_MODEL` and server-side
`ANTHROPIC_API_KEY`. It starts disabled. `PREPARATION_DAILY_LIMIT` is now shared by
individual-topic and whole-show attempts, including failed/interrupted attempts;
AI research analysis retains its separate allowance. A whole-show batch counts as
one attempt, so request count is not a monetary spending cap. The fixture-only
`PREPARATION_TEST_ORIGIN` remains empty in normal use.

Endpoints under `/preparation/shows/{show_id}`:

- `GET` returns current saved revision, provider settings and latest run.
- `POST /input` with `{revision}` returns exact bounded input, `input_hash`,
  truncation flag and settings. No provider request; save local show edits first.
- `POST /generate` with `{revision, input_hash, request_id: UUID, consent: true}`
  starts one request. Repeating the exact request returns its existing run;
  reusing the ID with another payload returns409. There are no automatic retries.
- `GET /runs/{run_id}` recovers that exact run, including after API restart.
- `POST /runs/{run_id}/apply` with `{revision, items}` appends reviewed notes for
  the selected subset. Each item has `id`, `summary`, `talking_points`. Same run
  and exact apply body return the current authoritative show without reappending;
  another body for an already-applied run returns409.

Each run records the saved revision, status, model/mode, input hash, results,
reported tokens and apply identity in additive `ShowPreparationRun`. A newer show
revision marks the run stale and rejects apply409. Changing the show during a
provider request is allowed and makes the returned preparation stale. Provider
I/O does not hold the database write lock. Only one whole-show generation can be
active across processes; request timeout is60 seconds, interruption lease180.

Bounds: 1–20 saved topics; context at most4000 characters per topic, retaining its
beginning and tail when shortened (disclosed in preview); output at most16000
tokens. Results require every topic ID exactly once, a nonblank summary up to800
characters and 3–5 nonblank talking points up to300 characters each. Missing,
invented, duplicate or incomplete output fails without adoption. Apply is atomic:
if any selected topic would exceed10000 notes characters, it returns422 and saves
none. No existing context is silently truncated during apply.

Local acceptance covers145 API tests, real SDK/HTTP fixture traffic, concurrent
retry/save, actual restart, invalid provider output, stale/oversized rejection and
20-topic batches. Whole-show generation quality has not yet been evaluated with a
paid model; the earlier live Sonnet ranking test is a separate feature.

### YouTube and Reddit discovery searches

`GET/POST /retrieval`, `PUT /retrieval/{id}`, `GET /retrieval/{id}/runs`, and
`POST /retrieval/{id}/import` configure and explicitly collect saved searches.
Create/edit fields: `name`, `platform` (`youtube` or `reddit`), `query`, `scope`,
`freshness_hours` (1–720), `limit` (1–50), `default_duration` (15–3600), `enabled`.
Supply keywords and/or a scope: YouTube channel ID (`UC` plus 22 characters), or
subreddit name. Edits require the current `revision`. Saving never fetches data.

Live configuration on the API server:

- YouTube: `YOUTUBE_API_KEY`, for an enabled YouTube Data API v3 project.
- Reddit: approved API access, `REDDIT_API_APPROVED=true`, `REDDIT_CLIENT_ID`,
  `REDDIT_CLIENT_SECRET`, and an identifying `REDDIT_USER_AGENT`. The adapter uses
  application-only OAuth client credentials. Actual app eligibility must be
  confirmed with Reddit; no anonymous JSON scraping fallback is enabled.
- `RETRIEVAL_DAILY_LIMIT` defaults to 20 collection attempts across both providers
  per UTC day (allowed range 1–100). This is an application guard, not a promise
  about provider quota or access. No paid data service is used.

Import body: `{"revision":1,"request_id":"<UUID>"}`. Retrying that exact UUID
and revision returns the original run without another provider attempt. Use a
new UUID only for a deliberate new collection. Runs expose status, created,
duplicate/skipped counts, safe errors and fixture/live mode. An active global
120-second lease prevents concurrent imports; attempts are spaced at least two
seconds apart. Expired runs read as `interrupted`. Setup errors consume no attempt;
provider failures do. HTTP 409 guards changed/paused/busy sources; 429 guards
spacing and daily allowance; 503 indicates missing setup. There are no automatic
provider retries or schedules for these sources yet.

New results become independent Inbox topics, retaining original titles, available
text, publication times, source links and immutable provenance. Platform IDs and
common permalink forms deduplicate against RSS/manual/archived ideas, including
a remembered match whose editable source link was subsequently removed. Existing
editorial content is never overwritten. Research ranking and preparation read
retained source evidence; show composition preserves context and attribution.
The provenance response retains `feed_id`/`feed_name` compatibility fields for the
saved search ID/name and uses `kind: youtube|reddit`.

YouTube collection follows search with one batched videos.list request for full
video descriptions (up to 50 unique search IDs). Results are matched by ID, not
response order. Missing/malformed videos are skipped; a failed metadata batch
fails the import atomically without falling back to abbreviated search excerpts.
Empty descriptions are labeled in the retained text. Existing 1000-character
title and 6000-character context limits/truncation flags still apply. Previously
imported or edited ideas are not overwritten or automatically backfilled.
Descriptions are publisher text, not transcripts or video analysis.
Reddit collection uses post text, not comments or linked articles. One bounded
page is requested, newest first; freshness is also enforced locally. Skipped
results can be stale, unavailable or malformed. No live playback/OBS changes.

For isolated verification only, `RETRIEVAL_TEST_ORIGIN=http://127.0.0.1:<port>`
redirects adapters to a local protocol fixture and sends sentinel credentials,
never real keys. Other origins are rejected. This round verified fixture protocol
and end-to-end behavior, not live platform access or real-content quality.

## Public X/TikTok link context

`POST /social-links/preview` with `{"url":"https://x.com/user/status/123"}`
explicitly fetches a public post preview using the official oEmbed endpoint.
TikTok supports full `https://www.tiktok.com/@user/video/123` links. Twitter/X
host aliases are accepted; tracking parameters are removed in the returned
`source_url`. Short/share links, profile URLs, non-HTTPS links, credentials,
nonstandard ports and unrelated hosts are rejected (422).

The response contains `platform`, `source_url`, `title`, `text`, `author`,
`context`, `limitations`, `truncated` and `mode` (`live` or `fixture`). X retains
post paragraph text only; TikTok retains caption text only. Embedded HTML/scripts
are never returned or executed. Replies, articles, transcripts and video content
are not retrieved. No API key or paid service is used by this endpoint.

Preview never writes to the database. Users review and append context in the
Inbox, then use the existing explicit Save idea action. Saved context feeds the
existing research/preparation/show flow. This route is not automatic discovery
and does not create immutable importer provenance or deduplicate Inbox records.

Only fixed official provider hosts are contacted, without redirects, proxy
environment settings or credentials, using bounded HTTP responses. Provider
failures return sanitized 502 messages; concurrent previews or new requests less
than two seconds apart return 429. Successful previews are cached for 60 seconds
(up to 128 entries). Cache/spacing/lock are process-local, not durable quotas.

For isolated tests, the existing `RETRIEVAL_TEST_ORIGIN` loopback override uses
`/x/oembed` and `/tiktok/oembed`. Real provider access and availability of individual
posts are not established by fixture tests. Keep manual context/link capture as
the fallback when a provider cannot supply usable public text.
