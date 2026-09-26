# Discover implementation acceptance — September 25, 2026

Implemented first production slice in the existing React/FastAPI application: Focus/Explore cards; retained YouTube/RSS creator, thumbnail and excerpt metadata; deterministic missing/broken-image fallback; persistent bookmarks and separate personal notes with revision conflicts. Additive tables only.

Claude Code/Fable 5.1 implemented the candidate under exclusive checkout ownership; parent reviewed and accepted it independently. All source data used in runtime proof is synthetic, imported through actual running collector/API routes into disposable SQLite. This does not establish fresh live provider access or model-ranking quality.

## Evidence
- Worker real-browser driver: 42 passing checks, `results.json`; details in `REPORT.md`.
- Parent real-browser acceptance: `parent-results.json` and `parent-accept.py`: note save/readback, reload, remote edit plus refresh conflict, explicit recovery, disabled bookmark during unresolved conflict, source/live preservation and mobile overflow.
- Old-schema initialization: `upgrade-check.json` demonstrates additive tables and unchanged existing rows. Synthetic pre-slice schema, not the live database.
- Parent full checks: 249 API tests, 226 web tests; Ruff, Pyright, ESLint, TypeScript, production build passed before final guard. After final bookmark conflict guard, affected Discover tests, lint/types/build and independent browser acceptance rerun.
- `rundown-discover-implemented.gif` is a slideshow of captured running-app states, not a continuous recording; screenshots in `screenshots/`.

## Review corrections
Malformed optional dimensions and URLs cannot reject the story; empty RSS image URLs no longer resolve to the feed itself. Drafts retain their original revision across refresh. Older list responses cannot roll back successful editorial writes. Parent final fix disables bookmark toggles during a note conflict, preventing them from clearing the warning and rebasing an unresolved draft.

## Remaining scope
Tonight's Show is still the default view; Discover is first in navigation. Notes use explicit Save note (or Cmd/Ctrl+Enter); unsaved drafts survive in-app navigation, not full reload. Day planner, creation/upload drawer, preference learning and additional source enrichment remain future slices. No paid AI calls, real OBS operations, commit, push or deployment.

## Runtime cleanup
Parent stopped the verified supervisor and all fixture/API/Vite children; ports 8192, 8193 and 3189 have no listeners. Disposable demo/old-schema databases were removed after evidence capture. Scripts retain their original scratch-directory assumptions for reproduction. Disposable DB files are not committed as evidence.
