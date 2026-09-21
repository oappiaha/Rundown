# Topic context — implementation and acceptance

## Outcome

Quickly create a topic with an optional expandable Notes / context field;
edit/read that context later in the control room. Preserve background, talking
points, questions, and pasted source URLs without putting notes on the overlay.

## Contract

- GET /rundown/state topic entries always include `notes: string`.
- PUT /rundown/schedule accepts up to10,000 Unicode characters per topic.
- Preserve whitespace/newlines verbatim; plain text, no HTML or link fetching.
- Explicit empty string clears notes. Omitted existing notes preserve stored
  context for older clients. New/old unannotated topics default to empty.
- Notes participate in revision checks, draft dirty state and field-level merge.
- Editing notes preserves active topic identity and elapsed playback time.
- Archived context lives in additive rundownitemnotes keyed to rundownitem;
  existing history columns/talking_points_json are untouched.

## Ownership and isolation

Root owns backend and integration in primary checkout. Claude Code owns
apps/web in the retained rundown-visual/frontend worktree, provisioned with
current source and read-mostly dependency links. Backend8143 and worker8144
use distinct disposable SQLite files; worker web3143 is loopback-only. No
commits, pushes, live OBS, service, or deployment changes.

## Acceptance

1. Create with multiline notes, publish immediately, reopen in fresh browser.
2. Edit, clear, reorder and merge without dropping notes or resetting playback.
3. Validate overlimit input, preserve draft notes on stale saves, lock pending
   edits, and safely display literal HTML as plain text.
4. Verify desktop/mobile accessibility, wrapping and overlay label-only display.
5. Pass static checks, focused tests and independent real API/browser proof.

Evidence and reproduction scripts: /private/tmp/dienda/rundown-notes.
Next build assessment: ../NEXT-STEPS.md.

## Accepted result

Implemented and independently verified locally. Root API: Ruff/Pyright clean,
14 tests passing; frontend: lint/TypeScript clean,31 tests passing, production
build successful. Claude Code supplied13 real browser verification steps.
Root independently exercised the built app served by FastAPI on8143: create
and immediately publish multiline context during playback without timer reset;
edit/clear; stale-draft merge preserving remote title/untouched notes; overlimit
feedback; fresh-browser persistence; phone editing and long-URL wrapping;
actual overlay label-only rendering. No unexpected console/network or page
errors. An actual API process restart preserved notes and playback state.

Evidence: verify_backend.py, verify_integrated.py, backend-evidence.md,
frontend-evidence.md, evidence/backend.json, evidence/integration.json and
notes-desktop.png/notes-mobile.png under the notes-round scratch directory.
Screenshot links were uploaded to the current Omnigent session.

Correction to the worker's evidence: the current overlay polls /rundown/state,
not /rundown/topics. Root's real overlay check established that notes are not
rendered; they are still present in the shared state API response. This is a
display distinction, not an authorization boundary.

All code is integrated into the primary checkout and the frontend source is
archived. No commits, pushes, or live deployment. The previously retained
worker worktree stays intact; destructive removal was not retried this round.
Recommended follow-up is saved shows/reusable topics; see docs/NEXT-STEPS.md.
