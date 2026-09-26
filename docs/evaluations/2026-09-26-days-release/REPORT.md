# E2E evidence: streaming days and topic capture (Rundown)

## Status
**completed** — all six done criteria have real-runtime evidence; no scope was silently dropped. Two decisions the parent should ratify are listed under Risks (no Pillow / no python-multipart in the shared virtualenv).

## Candidate
- Checkout: `/Users/rei/2026/Rundown` main @ `5015924` + preserved Discover-slice diff + this slice (sole writer; no commit/push/deploy; no nesting).
- Loaded-server proof: the API was started from this checkout after the last backend edit and `GET /openapi.json` lists `/plans`, `/plans/{show_id}`, `/plans/{show_id}/topics`, `/attachments`, `/attachments/{attachment_id}`, `/inbox/capture` (logs/stack.log, logs/api.log). Vite dev server serves the working tree with hot reload; the final full driver run (`logs/drive-run10.log`) and the fresh-context recheck (`recheck-tab.json`) ran after the last frontend edit.
- Plan/contracts: `docs/plans/2026-09-25-days-and-capture.md`. Lease/checklist: `state.md`.

## File changes
Backend (apps/api)
- `rundown/models.py` — four additive tables: `ShowPlan` (show_id, stream_date), `ShowTopicOrigin` (topic_id, show_id, inbox_topic_id, display_title, label), `TopicCapture` (kind, display_title, source_text), `Attachment` (opaque id, topic, role, display filename, media_type, size, sha256, width/height). No existing column changed.
- `rundown/config.py` — `assets_dir` setting (default `data/assets`); `tests/conftest.py` isolates it to `tmp_path/assets`; `rundown/main.py` creates it and registers the two routers.
- `rundown/library.py` — `stream_date` in show summary/detail (read through the row's session, so every existing caller reports it), shared `replace_topics`, `sync_origins` (removed rows lose their mapping; relabels update `label`), `copy_origins` on duplicate; legacy `PUT /shows/{id}` and duplicate use them.
- `rundown/inbox.py` — `POST /inbox/capture` (write/link), `create_capture` (topic + capture + bookmarked editorial note in one transaction), `display_title`, `capture`/`attachments` in every inbox response, `live_label` rule (422 instead of truncation).
- `rundown/plans.py` (new) — `GET/POST /plans`, `GET/PUT /plans/{id}`, `POST /plans/{id}/topics` (snapshot of note + source at add time, label rule, duplicate-in-day 409, 20-topic cap, revision 409).
- `rundown/attachments.py` (new) — raw-body upload with 1 MiB streaming cap (413), byte sniffing for PNG/JPEG/PDF/UTF-8 text, header dimension bounds, display-only filename sanitising, atomic file+row commit with unlink on failure, `GET /attachments/{id}` with nosniff/CSP sandbox/inline-for-covers/attachment-for-documents and `?download=1`.
- Tests: `tests/test_plans.py` (5) and `tests/test_attachments.py` (17 incl. 12 rejection cases) — 271 total.

Frontend (apps/web)
- `src/lib/api.ts` — `capture`/`attachments` normalisation (attachment URL derived from the opaque id), `captureInboxTopic`, `uploadInboxTopic` (raw body), `listPlans/getPlan/createPlan/updatePlan/addPlanTopic`, `stream_date` on show types.
- `src/lib/plans.ts` (+test) — label suggestion/limits, day labels, moves, date/link/upload pre-checks.
- `src/lib/discover.ts` — cards read the capture headline, source text, cover attachment, document attachment, kind label and live label.
- `src/components/Drawer.tsx` (new) — modal drawer/bottom sheet with focus move, Tab cycle, Escape/scrim close, focus return; stays mounted so typed text survives a close.
- `src/components/DaysDrawer.tsx` (new), `src/components/CaptureSheet.tsx` (new), `src/components/DiscoverView.tsx` (New/Days tools, ＋ Day and Download actions, "On air as" label line, toast, drawers), `src/App.tsx` (`onOpenShow` → existing `openSavedShow`), `src/index.css` (drawer/day/capture styles, phone sheet), `vite.config.ts` (`/plans`, `/attachments` proxies).
- Tests: `src/components/DiscoverDays.test.tsx` (4), `src/lib/plans.test.ts` (7) — 237 total.

## Checklist
- [x] **1. Two named dated plans, same topic in both, reorder/time/remove in one; independence; full title vs short label**
  - Action (drive.py, Chrome for Testing 1280×800): ＋ Day on the 87-character YouTube card → create "Friday live" 2026-10-02 → label field pre-filled "Why the long take came back:" → over-long label refused visibly → "Long take is back" added → second day "Sunday recap" 2026-10-04 with label "One-shot scenes" → article card added to both → move up / 900 s / remove in Friday only → reload.
  - Observed: `/plans/{friday}` and `/plans/{sunday}` hold the same two `inbox_topic_id`s under disjoint snapshot ids; `origin.display_title` is the full headline while `text` is the ≤30 label; Friday `[Long take is back]` at 900 s rev 6, Sunday unchanged byte-for-byte; after reload the drawer shows the durable order/label/time. Lists put dated days first.
  - Evidence: logs/drive-run10.log checks 4–15; results.json; screenshots/01-desktop-days-label.png, 02-desktop-days-reordered.png; tests/test_plans.py::test_two_days_share_an_idea…
- [x] **2. Write and Link capture → real cards with note/source; add to selected plan; open the actual saved-show editor**
  - Action: from the day, "＋ Create a topic for this day" → Link tab → URL + long title (label field appears) → note → "Add to 2026-10-02 · Friday live" pre-ticked → Create; then New → Write "Own idea" with a note, box unticked; then "Open in Saved Shows".
  - Observed: Link card shows "Your link", host `example.com`, real `Open original` href, "On air as COLOUR TEMPERATURE"; wire item has full title, label, note, url, bookmarked, `capture.kind = link`; Friday snapshot notes = `Ask about warm vs cool\n\nSource: https://example.com/pasted-story?ref=1`. Write card keeps its note and bookmark. Saved Shows editor opened with Show name "Friday live", inputs `Long take is back / 900`, `From elsewhere / 60`, `Colour temperature / 120` and the existing "Activate show…" button (no activation performed).
  - Evidence: drive-run10 checks 19–26; screenshots/04-desktop-capture-link.png, 05-desktop-saved-show-editor.png.
- [x] **3. Browser uploads PNG/JPEG/TXT/MD/PDF; reload card; byte readback; rejections leave nothing; traversal display-only**
  - Action: five real `<input type=file>` uploads through the sheet (files/…); reload; PDF "Download brief.pdf" link via Playwright download; "Read more" on the TXT card; three rejected browser uploads (1 MiB+1, SVG, malformed PNG) plus API-level malformed PNG and `../../etc/passwd.pdf` filename.
  - Observed: each attachment row has the sniffed media type and sha256 of the original bytes; `GET /attachments/{id}` returns identical bytes with `X-Content-Type-Options: nosniff`, inline for images, attachment for PDF/text; PNG cover decodes on the card at 320×200 from `/attachments/…` after reload; the browser-saved PDF is byte-identical (sha256 cfa3181c…); TXT shows "ünïcode" as plain text. Rejections: sheet alerts "Choose a file smaller than 1 MB." / "Use a PNG, JPEG, PDF, TXT or Markdown file." / "Uploading rejected (422): This PNG file is malformed."; row counts and the assets directory grew only by the one deliberate traversal upload, which stored as `<opaque id>.pdf` with display name `passwd.pdf` and no `etc` directory.
  - Evidence: drive-run10 checks 28–41; screenshots/06-desktop-upload-cover.png; files/downloaded-brief.pdf; tests/test_attachments.py (byte round trip per type, 12 rejection cases, failed-commit unlink, filename helper).
- [x] **4. Snapshot unchanged after library note edit; live clock/revision unchanged; stale edit 409 without draft loss; legacy /shows interoperable**
  - Action: another screen `PUT /plans/{friday}` (revision moves) then the drawer retimes → 409 banner → "Use theirs"; library editorial note edited after planning; `POST /shows/{friday}/duplicate`; legacy `PUT /shows/{friday}` relabel + drop; stale `PUT /plans` with revision 1; live state read at start, middle and end.
  - Observed: conflict banner "changed on another screen", local order kept and controls disabled until resolved, server duration still 900; day snapshot notes unchanged after the library edit; duplicate carries `origin` under fresh ids with `stream_date: null`; legacy relabel keeps the headline origin, the removed row's mapping is gone and origin rows equal the topics that show one; stale write 409 and body unchanged; live revision/topics/paused identical at all three reads (a 3600 s topic kept playing).
  - Evidence: drive-run10 checks 16–18, 27, 42–46; screenshots/03-desktop-days-conflict.png; tests/test_plans.py (all five), test_library.py unchanged and green.
- [x] **5. Desktop + 390 px focus/explore/drawer interactions; no horizontal overflow; no unexpected console/network errors; screenshots**
  - Action: fresh 390×844 context: Focus, ＋ Day → day sheet → select Sunday → Escape → New → JPEG upload → Explore.
  - Observed: `scrollWidth <= innerWidth` on Focus, with the sheet open, and in Explore; the sheet's rect fits the viewport; Escape closes; the JPEG card appears. Desktop: drawer is `aria-modal`, focus moves inside on open and returns to the ＋ Day button on close. All ≥400 responses seen by the browser are the provoked ones (fixture's broken thumbnails 404 ×3, one 409, one 422); no other console errors; the only failed requests are `net::ERR_ABORTED` live-state polls on reload/context close.
  - Evidence: drive-run10 checks 47–51; screenshots/08-mobile-focus.png, 09-mobile-days.png, 10-mobile-capture.png, 11-mobile-explore.png, 07-desktop-explore-after.png, 12-desktop-capture-tab-hover.png (recheck-tab.json). **GIF: not produced** — no Pillow/ffmpeg/ImageMagick on this machine (the earlier slideshow GIF used a Pillow install that is no longer present); the 12 screenshots are the flow record.
- [x] **6. Additive schema; old rows/columns unchanged; all static/test/build commands pass with new regression tests**
  - `tests/test_plans.py::test_old_schema_upgrades_additively_for_days` builds a real SQLite file without the four tables, inserts an old SavedShow and InboxTopic, runs `init_db()`, and proves the old rows read back unchanged (`stream_date: null`, `origin: null`, `capture: null`) and that a topic can be planned into the old show without a `showplan` row being invented. `test_presentation.py::test_old_schema_upgrades_additively` still passes.

## Negative/preservation
Covered above: over-long label refused (UI + 422), duplicate idea in one day 409, stale revision 409 with draft kept, archived/missing idea 404/409, oversized 413, SVG/HTML/GIF/malformed/incomplete/binary-text/non-UTF-8/over-50k/mismatched-declared-type 422 with zero rows and files, traversal filename neutralised, failed commit unlinks the file, live clock untouched, library note edit never rewrites a snapshot, legacy duplicate/update leave no stale mapping.

## Checks
- Static (apps/api): `.venv/bin/python -m ruff check .` → All checks passed (logs/api-ruff.log); `.venv/bin/python -m pyright --pythonpath …/.venv/bin/python` → 0 errors (logs/api-pyright.log).
- Focused tests: `.venv/bin/python -m pytest -q` → **271 passed** (logs/api-pytest.log; 249 before this slice).
- Web: `npm run lint` exit 0, `npm run typecheck` exit 0, `npx vitest run` → **237 passed** (226 before), `npm run build` exit 0 (logs/web-*.log).
- Real surface: `drive.py` → **51/51 checks, status completed** (logs/drive-run10.log, results.json); `recheck_tab.py` fresh context → ok.
- Read-back: API GETs after every mutation, SQLite row counts (`results.json.db_counts`), assets directory listing (7 files = 7 attachment rows), sha256 of downloaded vs source bytes.

## Environment lease (left running for parent acceptance)
- Scratch: `/private/tmp/rundown-days-implementation` (demo.db, assets/, raw/, logs/, files/, screenshots/).
- `stack.py` PID **90290** (supervisor); fixture **90293** :8192; API **90294** :8193 (`cd apps/api && .venv/bin/python -m uvicorn rundown.main:app --host 127.0.0.1 --port 8193`, env DB_PATH/RAW_CACHE_DIR/LOGS_DIR/ASSETS_DIR under scratch, RSS_SCHEDULER_ENABLED=false RESEARCH_AI_ENABLED=false PREPARATION_ENABLED=false, blank provider/OBS credentials, fixture origins 127.0.0.1:8192); Vite **90295** (node listener 90310) :3189 with `RUNDOWN_API_TARGET=http://127.0.0.1:8193`. Exact commands in `lease.json`.
- Stop: `kill -TERM 90290` (terminates the three children). Fresh rerun: `kill -TERM 90290; .venv/bin/python stack.py --reset-db & ; sleep 9; .venv/bin/python drive.py`.
- The database currently holds the state left by drive-run10 plus the recheck (no extra writes). No repo `data/`, `.env`, OBS, launchd or Tailscale was touched; no external fetches or model calls.

## Risks and decisions for the parent
1. **No Pillow in the shared virtualenv** (checked: `import PIL` fails in `.venv` and in `/usr/bin/python3`). Image validation is signature + header dimensions (PNG IHDR, JPEG SOF walk), bounded to 10000 px/side and 25 M pixels; the server never decodes pixels. If a full decode is wanted, add `pillow` to `pyproject.toml` deliberately; I did not mutate the venv.
2. **No `python-multipart`** in the venv, so uploads are raw-body POSTs with title/label/filename in the query (bounded sizes) and the personal note saved via the existing editorial endpoint afterwards; a failed note save is surfaced and the text is handed to the card's draft. Multipart can replace this later without changing storage.
3. `/shows` summary/detail now carry `stream_date` (additive key). Existing tests pass; any external consumer comparing exact JSON would see the new key.
4. Origin rule on label edits: relabelling keeps the origin and updates `label`; only removal deletes the row. Documented in the plan; parent may prefer severing on relabel.
5. After adding a pending card the pending block clears (status line confirms); adding the same card to a second day is done by pressing ＋ Day again and picking the other day (the driver does exactly this).
6. `GET /plans` returns every saved show (undated last) so old shows can be planned/dated; the drawer labels them "· undated".
7. Not done: docs/SESSION-HANDOFF.md not updated (parent's handoff round); evidence not yet copied under docs/evaluations (parent said it does this at acceptance); no GIF (tooling absent).

## Side effects and cleanup
- Created only under the scratch directory and the checkout (source, tests, plan doc, `apps/web/dist` from the build, which is git-ignored). No commits.
- Retained on purpose: the running stack and its disposable DB/assets for independent acceptance. Parent owns cleanup.
