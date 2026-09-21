# Saved shows and reusable topics

## Outcome

Prepare named saved shows separately from the live clock, reopen/duplicate
shows, reuse individual topics with their notes, and explicitly activate one.
Browsing, saving, duplicating, or editing a saved show never replaces live
playback. Activation replaces the live topic list and cues its first topic
paused; the user presses Play when ready.

## API contract (frozen)

Every route is same-origin JSON. Saved show names are trimmed1–80 chars.
Topics retain current limits: title1–30, integer duration15–3600, notes0–10000
Unicode chars verbatim,0–20 topics per saved show (activation requires1–20).
Create-topic input is {text,duration,notes?}; update topic input additionally
allows existing id or null/omitted for a new row. Saved topic IDs are local to
their saved show and never shared with the live clock or duplicated show.

Show detail: {id:string,name:string,revision:int,topics:[{id,text,duration,notes}],
created_at:ISO,updated_at:ISO}. Revision starts1 and increases on saves.

- GET /shows -> {shows:[{id,name,revision,topic_count,total_seconds,created_at,updated_at}]}, newest updated first.
- GET /shows/{id} -> detail; missing404.
- POST /shows {name,topics?:create-topic[]} -> detail201; default empty.
- PUT /shows/{id} {revision,name,topics:update-topic[]} -> detail200.
  Stale revision409. Duplicate/foreign topic IDs422. Omitted existing notes
  preserve context; explicit empty clears. All rows removable in saved drafts.
- POST /shows/from-live {name,live_revision} -> detail201; copies currently
  published live state, including notes, with independent IDs. Unsaved client
  edits are NOT included. Stale live_revision409.
- POST /shows/{id}/duplicate {revision,name} -> detail201 with fresh show/topic
  IDs; original untouched; stale source409.
- POST /shows/{id}/activate {revision,live_revision} -> normal existing ShowState
  (same shape as GET /rundown/state). Atomic source/live revision check, fresh
  live topic IDs, first topic paused at full duration, archive in same tx.
  Empty409; stale source/live409. No OBS WebSocket refresh or deployment.

Source copying of an individual topic is client-side: GET source show, select
row, append its text/duration/notes as a new row without id in target draft,
then explicitly Save target. Source is unchanged. No delete endpoints in this
slice. No auto-sync between a saved show and the live copy after activation.

## UI

Add a Shows view accessible on desktop and phone alongside live rundown.
Create/edit/save/reopen with name, topic title/duration/notes/order controls;
duplicate show; save the published live rundown as a named show; choose source
show/topic to reuse. Distinguish Save show from Activate show. Explain and
confirm activation of the saved version with topic count and replacement/pause
behavior. Disable activation when saved editor has unsaved changes and when the
live editor has unsaved changes or a mutation pending. Preserve local drafts
when switching views; prevent accidental loss when selecting another saved show.
Conflicting saved-show writes retain local draft and offer explicit reload or
merge recovery (no silent overwrite/retry). Lock pending saves; stale async
responses must not replace a newer selection or edit.

## Ownership / verification

Root backend/apps/api + docs; Claude Code apps/web in provisioned retained
worktree. Distinct databases/root8145 vs worker8146/web3145. Root independently
verifies built app via FastAPI plus actual overlay. Test saved drafts during
live playback; fresh load notes persistence; duplicate/reuse independence;
explicit activation; stale and empty activation rejection; no draft loss on
navigation or failed saves. Run API and web static/tests/build, capture real
screenshots. No commits/push/deploy or live data/OBS changes.

## Integration findings

Root independently reproduced and fixed two issues in the production build:

- Activation responses must pass through the same revision/time adoption guard
  as polls and transport responses. Otherwise a delayed activation response can
  replace newer state already received from another producer.
- The compact header needs navigation on its own row. Brand/navigation/status
  on one line expanded a390px device layout to448px and broke touch targeting.
  The browser check now compares document width to the configured390px viewport,
  rather than comparing two equally expanded layout widths.

The independent saved-shows workflow and delayed-response regression both pass
against FastAPI serving the real built frontend and overlay on loopback8145,
using the disposable saved-shows database. Final checks/worker acceptance and
cleanup are recorded at round completion below.

## Final local acceptance

Root API: Ruff/Pyright clean and22 tests passing. Integrated frontend: lint,
TypeScript and production build clean;48 tests passing, including a new
regression for delayed activation responses arriving after newer polling state.
Root production-browser acceptance and the dedicated activation race check pass
on API8145 with disposable data. The exact tests covered saved drafts during
live playback, full notes persistence, duplicate/reuse/source independence,
conflicting saved edits, navigation protection, activation cancel/stale refusal,
explicit paused activation, actual overlay synchronization, and a fresh phone
edit without modifying the live copy. No unexpected console/network/page errors.
Saved and active state also survived a real API process restart.

Claude Code implemented apps/web in its retained isolated worktree. Root
reviewed and integrated the candidate, preserving the independently verified
mobile header fix and snapshot-adoption notice, and added the regression test.
Evidence/reproduction: /private/tmp/dienda/rundown-shows/{verify_backend.py,
verify_integrated.py,verify_activation_race.py}, frontend-evidence.md and
backend-evidence.md, with JSON traces/screenshots under evidence/. Accepted
source and SHA256 manifest are archived in the scratch directory. Screenshot
links were uploaded to this Omnigent session.

No commits, pushes, live OBS changes, or deployment. The previously retained
worktree stays intact; destructive removal was not retried. Next priority:
topic inbox, as recorded in docs/NEXT-STEPS.md.
