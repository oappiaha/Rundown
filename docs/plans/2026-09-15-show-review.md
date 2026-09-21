# Post-show review

Build the PRD feedback and implementation-plan manual duration calibration flow. Review published rundown snapshots, explicitly identified as versions rather than completed stream sessions. The existing archive does not record actual attendance or automatic elapsed durations.

List published versions newest first with cursor pagination; inspect immutable topic titles/context/planned durations; save per-topic good/neutral/bad rating, optional review note and optional manually entered actual seconds. Show the actual-minus-planned difference. All saves explicit, stale revisions rejected. No scoring changes or model calls yet.

Backend owns apps/api; Claude Code UI follows after backend is ready using serialized primary-checkout ownership. Preserve current Sony-style UI. Historical Feedback rows remain compatible; append new feedback revisions with optional durations in one additive companion table, without modifying existing schemas or live playback.

Acceptance: real HTTP read/save/restart, strict invalid/stale/cross-version rejection, concurrent save, exact live-clock/archive preservation; real desktop/390px phone review/save/reload, dirty draft guard and conflict recovery; required API/web checks. Evidence: /private/tmp/dienda/rundown-review. No deployment, keys or live data.


## Accepted locally

Backend: 105 tests, Ruff and Pyright pass; actual HTTP saved/read back reviews,
validated 20+3 pagination, rejected stale/invalid/cross-version writes, serialized
two writers, and preserved exact live-clock/archive rows. Actual restart
preserved reviews. FeedbackTiming is additive; historical Feedback is retained.

Frontend: Claude Code implemented the screen and tests in a serialized primary
checkout phase. Root reproduced and Claude fixed two real browser bugs: Retry
used an older-page cursor after a failed refresh, and the fifth phone navigation
button overflowed/intercepted taps. Root independently confirmed both fixes.
The worker monitor repeatedly timed out despite saved tool activity; the task
was cancelled and confirmed idle. Root took over acceptance from its checkpoint;
a full worker completion report is not claimed.

Final compiled asset index-BwuYN1sZ.js: web lint/types/build and 131 tests pass.
Independent desktop and fresh 390px touch flows verified pagination, explicit
save, positive/negative/zero/unrecorded durations, dirty guards, real stale409,
failed recovery/retry, phone reload, and exact clock/archive preservation. Only
background clock polling was fulfilled from a starting snapshot for the exact
SQL preservation check; all review reads/writes used the real API. Separate
held real responses proved selection and pagination races safe.

The complete capture/import/context/saved-show/activation/instant-insertion and
phone playback rehearsal passed again on the final build without clock stubs.
Evidence: /private/tmp/dienda/rundown-review/evidence/{backend.json,restart.json,
ui-result.json,ui-races.json}, plus /private/tmp/dienda/rundown-rehearsal/evidence/
result.json and their runnable scripts. Screenshots retained for review.

No API keys or paid application calls needed. Built locally; not committed or
deployed. Live data, OBS and services unchanged. Temporary resources are removed
at round close; cleanup and accepted source hashes are recorded in root-acceptance.md
and accepted-code-hashes.json under the review scratch directory.
