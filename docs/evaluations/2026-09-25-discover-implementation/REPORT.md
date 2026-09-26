# E2E evidence: Discover first slice (wave 1)

## Status
completed — all 6 done-checklist items proven on the owned stack; 42/42 driver checks passed (`results.json`, `logs/drive.log`).

## Candidate
- Working tree `/Users/rei/2026/Rundown` at `5015924` + preserved prior dirty diff (analysis.py, obs_bridge.py, their tests, docs/NEXT-STEPS.md unchanged at +248/−28) + this slice's diff (see `git status`).
- Servers ran from that checkout: API `rundown.main:app` on 127.0.0.1:8193 (uvicorn from apps/api/.venv), Vite dev on 127.0.0.1:3189 proxying to 8193, synthetic provider on 127.0.0.1:8192. Loaded-candidate proof: `/inbox` responses carry the new `presentation`/`editorial` fields and `PUT /inbox/{id}/editorial` answers 200/409, which only this diff provides.
- Plan: `docs/plans/2026-09-25-discover-implementation.md`.

## Owned stack (still running for parent acceptance)
- stack supervisor pid 20220 (`stack.py`), children {"fixture": 20227, "api": 20228, "web": 20229}; ports {"fixture": 8192, "api": 8193, "web": 3189}.
- DB: `/private/tmp/rundown-discover-implementation/demo.db` (only DB touched; populated by the final driver run: 7 topics, YouTube topic `47168e20-556a-408c-af02-3629194674f6` bookmarked with note "mine (draft)" at editorial revision 4).
- Commands: see `lease.json`. Logs: `logs/api.log`, `logs/vite.log`, `logs/fixture.log`, `logs/stack.log`. Stop with `kill -TERM 20220`.
- Env: RSS_SCHEDULER_ENABLED=false, RESEARCH_AI_ENABLED=false, PREPARATION_ENABLED=false, all provider/AI/OBS credentials blanked, fixture origins `http://127.0.0.1:8192`. `.env` was never read or copied by me; OBS_WS_PORT points at an unused loopback port and no push with refresh_obs was made.
- Browser: Chrome for Testing chromium-1217 via Python Playwright, fresh contexts (desktop 1280×800, phone 390×844).

## Done checklist (driver run, `drive.py`)
1. Real import both providers → presentation readback → browser Discover full title + served thumbnail: PASS. `POST /retrieval/{id}/import` created 3, `POST /feeds/{id}/import` created 4; `/inbox` shows creator "Frame & Field" + 480×360 thumbnail URL; in Chrome the `<img>` decoded at 480×360 with `loading=lazy` and was not fetched until scrolled to. Screenshot `screenshots/01-desktop-focus.png`, `02-desktop-explore.png`.
2. Bookmark + note persist across reload; source/legacy notes unchanged; note arrows never swipe: PASS. Editorial revision 1 (bookmark) → 2 (note "Ask about the long take"); `revision/text/notes/source_url/source/topic/updated_at/presentation` byte-equal before/after; fresh-context reload shows the bookmark and note; ArrowDown/ArrowUp/j inside the textarea left `scrollTop` unchanged on desktop and phone. `03-desktop-note-saved.png`.
3. Missing and 404 thumbnails fall back; 390×844 no horizontal overflow: PASS. Four cards (404 YouTube thumb, 404 article cover, unsafe/malformed YouTube thumb, no image) render deterministic SVG artwork with `data-state=artwork`, zero broken `<img>` in the document; phone `scrollWidth == innerWidth == 390` for document and stage; wheel swipe snapped the next card to the stage top (0.25px). `05-mobile-focus.png`, `06-mobile-second-card.png`, `07-mobile-explore.png`.
4. Stale editorial 409 keeps draft; duplicate import keeps editorial: PASS. Other-screen write → revision 3; UI save with revision 2 → 409, conflict banner quotes "theirs", textarea still "mine (draft)", stored note untouched; direct stale PUT → 409; "Keep mine and save again" → revision 4. Re-running both imports: created 0, duplicates 3+4, YouTube item identical before/after. `04-desktop-conflict.png`.
5. Live current topic/time untouched: PASS. `/rundown/state` revision, current_topic_id, topics, paused identical; remaining seconds decreased by wall-clock elapsed (drift −0.23s over 9.2s). `08-live-untouched.png`.
6. Old tables upgraded additively: PASS (`upgrade_check.py`, `upgrade-check.json`). Built a database with every pre-slice table (topicpresentation/topiceditorial absent), seeded RSS/YouTube/manual topics + saved show, booted the app on it: exactly `['topiceditorial', 'topicpresentation']` added, every old row byte-identical, every old column list unchanged, old items read back with `presentation: null` and default editorial, editorial write on an old row → revision 1 with topic notes/revision untouched, stale → 409. Note: the prior audit harness's `demo.db` no longer exists on disk, so this proof builds the old schema from the models rather than upgrading that file.

All driver checks:
- [x] live show is playing before imports
- [x] YouTube fixture import succeeded with 3 topics
- [x] RSS fixture import succeeded with 4 topics
- [x] YouTube presentation readback: creator + served thumbnail + full title kept
- [x] RSS presentation readback: author + media:thumbnail
- [x] unsafe/malformed YouTube thumbnail dropped, topic kept (partial)
- [x] portrait RSS media:content retained with dimensions
- [x] all imported items start with default editorial
- [x] Discover nav opens the Discover surface with the full YouTube headline
- [x] served thumbnail decoded in the browser (480x360, lazy: not fetched before scrolling to it)
- [x] creator and source label visible on the card
- [x] original source link points at the real URL, opens in a new tab
- [x] artwork fallback for "How a foley artist builds a footstep (br…"
- [x] artwork fallback for "Article whose cover image returns 404…"
- [x] artwork fallback for "The grid that ran a newspaper for forty …"
- [x] artwork fallback for "Article with no image at all…"
- [x] article cover thumbnail decoded
- [x] no broken <img> left in the document
- [x] bookmark persisted through the editorial endpoint (revision 1)
- [x] arrow keys / j inside the note reach the textarea and do not scroll the feed
- [x] status says unsaved before explicit save
- [x] note persisted (revision 2), bookmark kept
- [x] source text, imported notes, topic revision and presentation untouched by editorial writes
- [x] after reload in a fresh context the bookmark shows
- [x] after reload the saved note shows
- [x] Saved filter lists only the bookmarked topic
- [x] other screen wrote revision 3
- [x] stale save refused: conflict shown with theirs, draft kept, stored note untouched
- [x] direct stale PUT returns 409
- [x] resubmitting against revision 3 saves the draft (revision 4)
- [x] duplicate imports create nothing
- [x] duplicate import left bookmark, note, presentation and source unchanged
- [x] inbox still has exactly 7 topics
- [x] 390px: no horizontal overflow (document and stage)
- [x] 390px: swipe/scroll snaps to a following card (progress moved, aligned to card start)
- [x] 390px Explore: broken cover falls back and no horizontal overflow
- [x] 390px: arrow in note keeps the feed still
- [x] Inbox view still lists the imported idea by its live label
- [x] Sources view lists the feed
- [x] Live view shows the running topic
- [x] live current topic/time untouched by imports and editorial writes
- [x] no unexpected failed network requests or console errors

## Checks
- Backend: `ruff check .` clean; `pyright --pythonpath .venv/bin/python` 0 errors; `pytest` 249 passed (baseline 203 + 46 new in `tests/test_presentation.py`).
- Web: `npm run lint` clean; `npm run typecheck` clean; `vitest run` 226 passed (baseline 210 + 16 new: `DiscoverView.test.tsx`, `lib/discover.test.ts`); `npm run build` ok.
- No existing test was modified or weakened. Baseline logs: `baseline-pytest.log`, `baseline-vitest.log`.

## Review fixes folded in (from the parent's read-only reviews)
- `presentation.dimension` guards non-ASCII digits ('²'), oversized strings and bools; `choose_thumbnail` never raises, so malformed optional metadata drops the image, never the story (tested in `test_youtube_snippet_keeps_creator_and_largest_valid_thumbnail`, `test_rss_media_thumbnails_enclosures_and_bad_data`).
- `safe_image_url` rejects numeric-ending hosts (`127.1`, `0x7f000001`, `2130706433`) alongside canonical private/loopback/link-local literals and `localhost`/`.local`; fixture origin only when configured (`test_unsafe_image_urls_rejected`, `test_fixture_origin_only_when_configured`).
- `rss.entry_media` skips missing/empty `url`/`href` instead of urljoin-ing the feed itself.
- Frontend drafts carry `baseRevision`/`baseNote`; a note save submits the base revision (never a refreshed one), list responses merge by editorial revision so an in-flight list cannot roll back a save, and a refresh that reveals a newer revision under a dirty draft flags the conflict before any save. Regression tests: "a refresh that reveals another screen's newer note flags the conflict…", "a list response requested before a save cannot roll the saved state back", plus the browser stale-409 flow.

## Decisions and limitations
- Default view stays Tonight's Show; Discover is the first nav item. Every existing App-level suite renders `App` and queries the live view by role (role queries exclude hidden subtrees), so a Discover default would have meant rewriting their initial-state assumptions.
- YouTube `videos.list` keeps `part=snippet`; no contentDetails call, so YouTube duration is not shown (no fake durations). `media_seconds` is plumbed for later.
- Explicit **Save note** (plus ⌘/Ctrl+Enter) rather than autosave, clearly labelled with an Unsaved/Saved status. Drafts survive mode/filter/refresh/navigation in memory; they do not survive a full page reload (no browser storage in this slice).
- Presentation backfill on duplicate import applies only to topics that already have an importer source row; manual ideas matched by URL stay byte-identical (existing feeds test guards this).
- Uploads, day planner, TikTok/Reddit enrichment, article page fetching remain out of scope. No commit, push or deploy was made.
- The prior-audit `demo.db` file is gone, so checklist 6 proves an additive upgrade of a freshly built pre-slice schema, not of that specific file.

## Side effects and cleanup
- Created under `/private/tmp/rundown-discover-implementation/` only: demo.db, old-schema.db, raw/, logs/, screenshots/, results.json, upgrade-check.json, lease.json, scripts. Stack left running deliberately for independent acceptance (cleanup owner: parent). Vite wrote its dep cache to `apps/web/.cache/vite` (already gitignored path).
