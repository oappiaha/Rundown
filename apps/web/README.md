# RUNDOWN control room

React control room for driving the live show. It polls the server-owned show
state once a second, lets a producer add a topic at the end or immediately
after the current segment, edit, reorder and remove entries, publish the exact
ordered schedule, and drive transport (play/pause/next/previous/jump/reset).

Visual direction follows `ui/rundown-mockups.html`: light Apple structure with
one silver Walkman deck. Desktop docks the deck in the sidebar; under 880px the
deck becomes the hero above the queue.

## API contract

See `docs/plans/2026-09-14-visual-control-room.md`.

- `GET /rundown/state` polled every second; never overwrites unsaved edits.
- `PUT /rundown/schedule` `{revision, topics}`; new rows omit `id`.
  A 409 keeps the draft and offers *Merge and publish*, *Merge, don't
  publish yet* and *Discard my changes*.
- `POST /rundown/control` `{revision, action, topic_id?}`.

Draft rules: the first edit snapshots the server schedule and its revision.
Polling updates the deck but never re-pins the draft. Only your own
successful transport action re-pins it, and only when the server topic list
is unchanged. Revisions are internal: the UI says *Connected*, *Published*,
*Unsaved changes* and *The show changed on another screen* instead.

Safety rules (`src/lib/snapshot.ts`, `src/lib/draft.ts`, `src/App.tsx`):

- Every adopted snapshot must supersede the one on screen (higher revision,
  or same revision with a later `server_time`), so a delayed poll cannot
  regress state after a publish or transport action.
- While a publish is in flight every editor, add, reorder, remove and
  transport control is disabled; text already typed into the quick-add
  survives. Quick-add is unavailable until the first state has loaded.
- Merging is a per-field three-way merge: fields you edited stay yours,
  fields you left alone take the other screen's value, rows added there are
  inserted after their predecessor, rows removed there disappear unless you
  edited them (then they are re-sent as new rows).
- *Publish immediately* (quick-add checkbox) turns the buttons into
  *Add & publish* / *Insert next & publish*. It publishes the draft that
  results from the add, so any other unsaved changes go with it; a stale
  base still yields the normal conflict banner with the new row kept.

## Development

Start the API (default `http://localhost:8000`), then:

```bash
npm ci
npm run dev
```

Point the dev proxy elsewhere with `RUNDOWN_API_TARGET`:

```bash
RUNDOWN_API_TARGET=http://127.0.0.1:8141 npm run dev -- --port 3141
```

`scripts/contract-stub.mjs` is an in-memory stand-in for the contract, useful
when the FastAPI service is not running:

```bash
node scripts/contract-stub.mjs 8151
RUNDOWN_API_TARGET=http://127.0.0.1:8151 npm run dev
```

## Checks

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

FastAPI serves the resulting `dist/` directory at `/`, so only the API process
is needed on Wolf-4.

Tool caches (`tsc -b` buildinfo, Vite/Vitest dep cache) are written to the
ignored `apps/web/.cache/` directory, never into `node_modules`, so a linked
or read-only install is safe.

## Adding context to a topic

Click **Add context** under the new-topic fields to enter background, talking
points, questions, or source URLs. Add the topic normally, or check
**Publish immediately** to save it to the current show in the same action.

For an existing topic, click **Add notes** or **Notes** beneath its title.
Edit the text, then click **Publish schedule**. A blue dot indicates that the
topic has notes. Clearing the field and publishing removes its current notes.

Notes support up to10,000 Unicode characters, preserve line breaks, and remain
plain text. Enter makes a new line. Notes stay in the control room; the deck
and OBS overlay display the short title. Conflicting saves keep the draft and
offer the existing field-level merge. Source URLs are stored as text, not
fetched or summarized automatically.

## Saved Shows

Use **Saved Shows** in the navigation to prepare named rundowns separately from
what is on air. **New show** opens an empty draft; add topics, expand their
notes, adjust durations/order, then **Save show**. Empty drafts can be saved.

- **Save live rundown as show** copies the published live list, including notes.
  Any unsaved live edits are excluded.
- **Duplicate** / **Create copy** makes an independent named copy of the saved
  version. Save your edits before duplicating.
- **Reuse a topic…** lets you select another saved show and copy a topic with
  its notes into the open draft. Save the target to keep it.
- **Activate show…** opens a confirmation. Activation replaces the live rundown
  with a copy of the saved version, cues its first topic, and pauses. Press Play
  on Tonight's Show when ready. Resolve unsaved edits in either editor first.

Saving/editing either copy after activation never silently updates the other.
Switching views keeps local edits and live quick-add text. Selecting a different
saved show protects unsaved edits with a discard/cancel choice. Conflicting saves
keep the draft and offer explicit merge or reload; stale activations are not
retried automatically. Saved shows have no calendar scheduling in this slice.

## Topic inbox

Open **Inbox → New idea** to capture a title, duration, notes and optional
source URL. Save the idea before using it in a show. Archived ideas can be
restored; editing or archiving an idea leaves existing show copies unchanged.
The editor shows title and notes first, then the source card; an imported
idea's provenance and the assisted preparation tool sit folded underneath,
each behind one toggle that states its condition (for example *Assisted
preparation · ready* or *· draft to review*).

In **Tonight's Show** or **Saved Shows**, choose **Add from inbox…**. The picker
copies the latest active idea, including its source attribution, into the local
draft. Live insertion supports **Insert next** or **Add to end**. Use the normal
**Publish schedule** or **Save show** action to persist the addition. Copying
never publishes or starts playback automatically.

Drafts survive switching views. Explicit conflict recovery keeps local edits and
can merge other changes. A pending copy is cancelled if you leave the target,
switch or discard it, or the live segment changes before the idea finishes
loading. Full schedules (20 topics) and archived ideas cannot receive/be copied
through the picker. Context remains private to the control room, off the overlay.

### Public X and TikTok link preview

Paste a full public X post link (`https://x.com/user/status/…`) or TikTok video
link (`https://www.tiktok.com/@user/video/…`) into **Source URL**, then press
**Preview link** on the source card under it. The API asks the platform's
official embed service for the public post text or video caption and the card
shows it once, as plain text, with the platform, the author, a short scope
(**Post text only** / **Caption only**) and a small **Test data** badge when the
server runs on synthetic data. Nothing is fetched until you ask, and fetching
never changes the idea. Any safe link, social or not, gets an **Open original**
link on the card.

**Add to notes** appends the reviewed block after your existing notes and fills
the title only when it is empty (cut to 30 characters); the entered link is kept
as attribution. **Details** folds away what was not retrieved, how many
characters adding puts into the notes, the canonical permalink with **Use
canonical link** (applied only when you click it) and **Fetch again**. Adding is
refused, with nothing truncated, when notes plus the source line would exceed
10,000 characters, and while the same block is already in the notes (fetch
again, save and reopen, or a double click never appends twice); delete the
block from the notes to add it again. Save the idea as usual with **Save idea**.

Changing the link or opening another idea discards the preview, so a slow
answer can never land on the wrong idea. A provider failure, an unsupported or
short link and the two-second spacing between previews leave the draft as it
was; retry by hand. Archived ideas cannot fetch or add. The dev proxy forwards
`/social-links`. Verified against the local provider fixture on desktop and a
390px phone; live platform availability is not covered by fixtures.

## RSS sources and import review

Open **Sources → New feed**, enter the feed name, RSS/Atom URL and default topic
duration, then **Add feed**. Saving configures the source; **Import now** fetches
it explicitly. Saved URLs are fixed; add another feed to use a different address.
Disable a feed to prevent imports while keeping its settings and history.

The result and import history show new ideas, duplicates, skipped entries and
failure reasons. Review the imported ideas in **Inbox**, edit their context, then
copy them into a saved or live draft using **Add from inbox…**. Publish/save is
still explicit. Reimporting never overwrites edited or archived ideas.

An imported idea retains its original title, feed, dates and plain source text
in a read-only block folded behind **Imported from <feed>**. Expand it to
compare the original with your editable notes. Very long source text is clipped
at 50,000 characters with a notice; show notes keep their existing
10,000-character limit.

Feed fetching accepts public HTTP(S) addresses; private/local endpoints are
blocked except the exact isolated test origin configured by the API. There is
no scheduled polling in this slice.

## Assisted preparation

Every idea has an **Assisted preparation** toggle under its source card; it is
folded by default and its label carries the state (after saving, ready, off,
generating, draft to review, notes added, request unanswered), so a run or a
draft is never hidden. Opening it shows the panel for a saved, active idea, which stays
mounted while folded: a draft under review, the consent box and a request in
flight are kept. It reports whether a provider is configured (`GET /preparation/status`
is included in `GET /preparation/topics/{id}`): provider, model, requests used
today against the daily cap (every attempt counts, including failed and
interrupted ones), and a **Test fixture** badge when the API is wired to its
local test provider. The cap, input size and output tokens are request and
token controls set on the API; there is no money budget in the UI. When nothing is configured, the panel shows
the API environment variables to set (`PREPARATION_ENABLED`,
`PREPARATION_MODEL`, `ANTHROPIC_API_KEY`); keys are never entered or shown in
the browser.

Expand **Text to send** to preview the exact plain text the API would send: the
saved title, saved context and any retained feed text, capped at 12,000
characters with a truncation notice. Unsaved edits are never sent; the idea
must be saved and clean before **Generate draft** is enabled, and the consent
box has to be ticked for that exact input (it is asked again whenever the input
changes). Each click sends one `POST /preparation/topics/{id}/generate` with a
fresh UUID `request_id`; nothing is retried automatically. A provider failure
comes back as a normal answer with status `failed` and is shown as a failure
with **Try again**. A run left in progress (for example after a reload) is
polled every two seconds while the Inbox is visible. If the browser gets no
answer at all, the panel offers **Check status**, **Resend the same request**
and **Forget that request**. Resending asks the server first and adopts the run
if it exists; otherwise it reuses the same id, and only while the idea is still
saved at the same revision, clean, active and the provider ready.

The result is a local draft: the summary (1–1,500 characters) and talking points
(3–5 lines, one per line, each up to 500 characters) are editable in the panel,
edits survive switching ideas, filters and views and **Refresh status** (state
is kept per idea for as long as the Inbox is open), and an edited draft blocks
regeneration until it is appended or explicitly discarded. **Append to context**
adds `Summary … Talking points - …` after the current context in the editor and
nothing else changes: title, duration and source URL stay, the idea is not saved
until **Save idea**, and the button becomes **Appended** so the same draft cannot
be added twice. Appending is refused (draft kept) when context plus the source
line would exceed 10,000 characters, while the idea has unsaved edits, or once
the idea's saved revision differs from the one the draft was generated for. If
the idea changed on another screen, the panel says so and offers to reload it.

The dev proxy forwards `/preparation` like the other API routes.

## Automatic RSS imports

Open a saved feed in Sources. Under Schedule, turn on Automatic imports, choose
an interval (15 minutes to 7 days) and Save schedule. Scheduling starts off for
every feed. Saving sets the first future time; it does not fetch immediately.

The panel displays the next import in your browser's timezone and the last
automatic result. Timed imports appear in the normal Inbox and import history;
duplicates and edited/archived ideas follow the same rules as manual imports.
Manual Import now does not move the automatic timer.

The API must remain running and the machine awake. An overdue feed gets one
catch-up import after restart; missed intervals are not replayed. Failed imports
wait for the next regular interval. Turn automatic imports off to cancel future
runs, or disable the feed to pause its saved schedule. Reenable the feed to start
a fresh interval.

Schedule edits survive switching feeds/views and refreshing. Conflicting edits
offer explicit merge or reload. Generation, publishing and live playback remain
separate actions; scheduling requires no API keys.


## Show review

Open **Show review**, choose a published version and topic, then record a
Good/Neutral/Bad rating, review note and optional actual seconds. **Save review**
persists the review; typing alone does not. Blank actual seconds means unrecorded;
zero is a recorded value. The comparison shows time over or under the plan.
Original context remains read-only, and reviews leave live playback unchanged.

Unsaved reviews survive trips to other views. Switching topic/version or
refreshing prompts before discarding edits. Conflicting saves keep your draft:
reload the saved review or explicitly keep your values on the latest revision,
then save. Published versions are snapshots, not automatically measured streams.
Phone navigation wraps so all six views remain tappable at 390px.


## Research → saved show

Open **Research** to filter active Inbox stories by category and inspect ranking
reasons and matching coverage. **Curate** changes category, priority, pin or
exclusion only after **Save**. Conflicts preserve your edits; reload or rebase
explicitly, then save. Ranking and category suggestions use local rules.

Add stories yourself or suggest a shortlist, then remove/reorder its entries.
Preview the ordered saved context and total duration, name the show and save it.
Opening the result uses Saved Shows' existing unsaved-edit guard. Changing the
selection or its source revisions requires another preview; an interrupted save
can be retried without creating a duplicate show. Draft work survives view changes.

The composer preserves existing text, source links and duration. It makes no AI
calls. Saved Shows provides further editing and explicit activation. Research
preparation leaves playback untouched, including on the 390px phone layout.
The development proxy includes `/research`.


## Optional AI research analysis

In Research, open **AI analysis · optional** in the shortlist column:

1. Tick up to 20 stories, or explicitly tick the current shortlist. Excluded
   stories are blocked; nothing is preselected automatically.
2. Write the show's angle and audience in **Show brief**.
3. Choose **Preview AI input** and inspect the exact saved text and any truncation.
4. Tick consent and analyze. This is the action that calls the configured provider.
5. Review scores, suggested categories, explanations and same-event groups, then
   **Suggest shortlist from AI**. Confirm replacement if you already have a shortlist.
6. Reorder, add/remove, preview and save through the existing composer.

The model and fixture/live mode are labeled. AI suggestions stay separate from
local rankings; your manual category, pins and priorities keep precedence. Grouping
is advisory and does not delete or merge stories. Scores are editorial suggestions,
not engagement predictions or verified facts. Existing titles, context and durations
remain the show content; this feature does not generate talking points.

Briefs and choices survive navigation. Input changes invalidate consent and preview.
Failed or stale results preserve your work. After a lost connection, **Check status**
retrieves the exact request; **Resend the same request** reuses its ID when needed.
A deliberate new analysis consumes another daily attempt. Running results are polled
with read-only requests and can be recovered after reload. Failed attempts count
against the daily limit. No provider calls happen automatically.

AI analysis starts disabled. Missing configuration is explained in the panel while
local research remains usable. Credentials are configured on the API server; see
[API setup](../api/README.md#optional-ai-research-ranking-and-grouping).
The implementation was verified with a local fixture on desktop and a 390px phone;
real model quality and paid-provider acceptance remain the next step.


## Prepare an entire show

Save your Research shortlist as a show, or open an existing show in **Saved Shows**.
In **Prepare the whole show**:

1. Save any local show edits, then **Preview what will be sent**.
2. Inspect the exact saved context, consent, and choose **Prepare the show**.
3. Review/edit each summary and its 3–5 talking points. Untick topics you do not
   want appended. Existing context and source attribution remain in place.
4. Choose **Save prepared notes**. This updates the saved show only; activation
   is still explicit.

Edited suggestions and topic selections survive view navigation, switching shows
and status refresh for the current browser session. Successful runs and applied
notes survive reload/restart; unsaved edits to suggestions are not persisted across
a browser reload. Generating again asks before replacing edited suggestions.

A changed saved show makes the preparation stale; your edited suggestions stay
visible, and applying them is blocked until you generate from the current version.
Invalid provider responses and notes exceeding the topic limit do not partially
save. After an uncertain generation response, recover the exact run or resend the
same request. After an uncertain save, **Retry the same save** reuses the frozen
body, so notes cannot be appended twice. Local show edits made meanwhile are
preserved through the existing explicit merge/reload recovery.

Provider readiness, model, fixture/live mode and the shared preparation allowance
are shown. Missing configuration blocks generation while ordinary editing remains
available. No credentials are entered in the browser. See [API setup](../api/README.md#whole-show-preparation).

Verified on compiled desktop and 390px phone UI, including ordinary live insertion
after activating a prepared show. This development round used a local provider
fixture, with no additional paid calls.

### Discovery searches

In **Sources → Discovery searches**, add a YouTube or Reddit search, enter
keywords and optionally a channel ID/subreddit, set freshness/result limits,
and save. **Collect now** imports new ideas into **Inbox**. Inspect the original
source text there, then use **Research** to rank/select topics and save a show.
AI ranking remains an explicit, consented action using the existing AI settings.

Searches can be edited or paused without platform credentials. Setup messages
explain why collection is unavailable. Fixture mode is visibly marked. Search
edits survive navigation and status refresh (not a full browser reload); a stale
save preserves your draft and offers explicit reload. Collection history survives
reload/restart. An unanswered collection can be checked in history or retried
using **Retry the same request**, which preserves the attempt ID. No automatic
collection, AI generation, show activation or publishing is enabled by this panel.
