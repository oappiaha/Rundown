# RSS sources and import review — completed locally

September 15, 2026. Two ordered slices: configure/import feeds, then review
results and retained source text. Claude Code implemented the frontend in an
isolated retained checkout; root Codex implemented the backend, integrated
and reviewed the changes, and added the stale-import recovery fix.

## Delivered

- Sources navigation with RSS/Atom feed name, URL, default duration and enabled
  settings. Save does not fetch; Import now does.
- Atomic inbox imports, cross-feed/manual/archived deduplication, independent
  original source text, safe plain-text rendering and durable import history.
- Explicit recovery for duplicate URLs, stale edits/imports and failed requests.
  Delayed results cannot replace another feed's draft.
- Existing quick topic creation, saved/live draft copying and Sony-style deck
  preserved. Preparation never publishes or changes the playback clock.

## Verification

- Backend: Ruff/Pyright passed; 66 tests including real local HTTP retrieval.
- Web: lint/typecheck/build passed; 83 tests. Claude's Chromium run: 83 checks,
  zero failures, including desktop and a fresh 390px touch context.
- Root independently verified the compiled app: create with no implicit fetch,
  import 2 new/1 duplicate/2 skipped, editable context separate from source,
  repeat 0/3/2 with edits unchanged, duplicate URL correction, failed import,
  stale import with explicit reload, phone taps and no horizontal page overflow.
- Final source-panel fix tested by switching between ideas with identical short
  titles, distinguished by feed; expansion resets and truncated text retains
  50,000 characters. No browser page errors.
- Actual API process restart preserves feeds, runs, edited/archived ideas and
  saved-show copies. Exact live clock row remains unchanged during preparation.

## Evidence and reproduction

Round directory: `/private/tmp/dienda/rundown-rss`.
`backend-evidence.md`, `frontend-evidence.md`, `integrated-hashes.json`,
`evidence/backend.json`, `evidence/restart.json`, `evidence/worker-proof/trace.json`,
`evidence/root-ui/result.json`, and `evidence/root-ui/switch-result.json`.
Scripts and fixture server are retained there; browser create/import scripts
require a fresh disposable DB and their configured loopback origin.

Use normal lint/typecheck/test/build commands from `docs/SHIPPING.md`. Real
HTTP/browser checks require permission to bind/reach loopback. Test DBs use
explicit DB_PATH and RSS_TEST_FEED_ORIGIN; never use the live database.

## Limits and release status

Manual imports only; no AI generation, scheduling or public-feed compatibility
claim beyond the bounded RSS/Atom implementation. Feed XML is capped at 2 MB,
first 100 entries per run, original text 50,000 characters; redirects and DNS
addresses are checked before connecting. Private destinations are blocked.
Short titles can collide; full originals and feed attribution remain available.
Next: editable assisted preparation with explicit provider/cost configuration.

Local build only. No commit, push, OBS change, service installation or deployment.
Retained preexisting dirty worker checkout is not force-removed. Owned temporary
servers are stopped after verification; cleanup details are in round state.md.
