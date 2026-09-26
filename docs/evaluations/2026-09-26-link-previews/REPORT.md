# E2E evidence: pasted article / TikTok previews in Discover Link capture

## Status
completed — all six required criteria verified on the running stack. **Ownership of the /Users/rei/2026/Rundown checkout is released to root as of this report**; the owned stack is retained for independent acceptance (see Handoff).

## Candidate
- Checkout: /Users/rei/2026/Rundown main @ 796d05e (clean at start) + uncommitted slice diff.
- Diff identity: sha256(git diff) = 4696f95e07b8c60a (`candidate.diff`); untracked new files with their sha256 prefixes in `untracked-file-ids.txt` (test file final id e88fde91396ef853 after two pyright-only edits that do not change runtime code).
- Loaded-server proof: `logs/restarts.log` records four owned-stack restarts; the final backend restart at 22:29:37Z (pids 43777/43778/43779, then 50074/50075/50076 after a fixture-only change) predates every browser/API run in `results.json`/`api-results.json`. Baseline before mutation returned 405 on `POST /link-previews/preview` (`parent-baseline.json`); the same request now returns 200 with a token.
- Plan/API contract: `docs/plans/2026-09-26-link-previews.md` (written before code).

## Changed files
Backend (apps/api)
- `rundown/rss.py` — `fetch_feed` factored into generic `fetch_public(...)` (per-hop canonicalize/resolve/public check, pinned socket, identity encoding, byte/time caps, optional prefix truncation, `StatusError` with status, socket timeouts → "timed out"). Feed messages unchanged.
- `rundown/link_previews.py` (new) — `POST /link-previews/preview`: article `<head>` OG/title/description/author/site/published/first-image extraction (ogp.me root/dimension pairing, standalone `og:image:url`, implied head, stops at `</head>`/`<body>`, script/style ignored, 256 KiB / 10 s, HTML content-type only); TikTok official oEmbed (caption/creator/thumbnail + dimensions retained); X and TikTok profiles 422; rate limit/lock/60 s cache like social links.
- `rundown/preview_token.py` (new) — HMAC-signed 30-minute token (per-process key, 96 KiB bound covering the maximal UTF-8 payload, byte-wise signature compare so malformed suffixes are 409 not 500).
- `rundown/inbox.py` — `CaptureIn.preview` (link only), token verify (409 on invalid/expired/URL mismatch, nothing saved), `attach_preview` writing `topiclinksource` + `topicpresentation`; `get_source`/`all_sources`/`source_detail` read the link source (kinds `article`/`tiktok`, extra `entered_url`/`resolved_url`/`creator`).
- `rundown/models.py` — additive table `TopicLinkSource`. `rundown/main.py` — router. `analysis.py`/`research.py` — annotation widened only (no logic change).
- `tests/test_link_previews.py` (new, 28 tests). `tests/conftest.py` — guardrail: module engine replaced by an in-memory engine before any test (see Incident).
Frontend (apps/web)
- `components/CaptureSheet.tsx` — Preview button in Link tab, loading/failure/review card, ref-backed title so an in-flight preview never overwrites typed text, stale-response ignore, link-edit drops preview, "Create with preview" sends only the token, 409 keeps the form and offers plain create.
- `lib/api.ts` — `previewLink`, `LinkPreview` type, `CaptureInput.preview`, source kinds `article`/`tiktok`. `lib/plans.ts` — `boundedTitle`. `lib/discover.ts` — "Article link"/"TikTok link" labels, `sourceKind`, excerpt not repeated when equal to the headline. `components/DiscoverView.tsx` — tag Video/Article for link sources. `components/InboxView.tsx` — provenance wording for the two kinds. `index.css` — `.dsc-preview*` in existing tokens. `vite.config.ts` — proxy `/link-previews`.
- `components/CapturePreview.test.tsx` (new, 4 tests incl. deferred-promise race), `lib/discover.test.ts` (+1).

## Checklist
- [x] 1. Article paste → Preview → review → save → card → readback → reload
  - Action: browser (`drive.py`): New topic → Link → paste `http://127.0.0.1:8192/articles/offwhite.html` → note typed → Preview → review card → live label edited → "Create with preview" → card → `GET /inbox` → reload → fresh context.
  - Observed: review card "Article · Tomas Reyes · fixture", full headline, served thumbnail naturalWidth/Height 1200×630, referrerpolicy no-referrer; title prefilled, note untouched, no topic created by preview; Discover card "Article link · Tomas Reyes · Sep 22, 2026", tag Article, image state; API `source.kind=article`, `original_title` = full headline, `feed_name` Surface Notes, `presentation.thumbnail` 1200×630, entered URL stored, note and label as typed; identical after reload and in a fresh browser context. Second `og:image` (300×300) not paired with the first (`api-results.json`).
  - Evidence: `results.json` checks 1–8, screenshots `01`–`04`, topic id b881de62-f318-4de8-a0e9-593d47be89a7.
- [x] 2. TikTok official fixture preview → persisted caption/creator/portrait thumbnail
  - Action: paste `https://www.tiktok.com/@synthetic.maker/video/7000000000000000001?utm_source=paste` → Preview → label/note → Create with preview.
  - Observed: review card "TikTok · synthetic.maker", caption, thumbnail 360×640 with `portrait` class; card "TikTok link · synthetic.maker", tag Video, portrait figure; API `source.kind=tiktok`, `resolved_url` canonical permalink, `source_url` exactly as pasted (query kept), thumbnail {360,640}; caption shown once on the card after the excerpt fix (`14-tiktok-card-single-caption.png`, `recheck_excerpt.py`).
  - Evidence: `results.json` checks 9–12, screenshots `05`, `06`, `14`; id ceb0f7e5-ded3-4395-b13c-e73ec054f0e3.
- [x] 3. Failures rejected with clear message; manual save stays available
  - Action: browser previews of forbidden(403), ratelimited(429), missing(404), notes.json(JSON), malformed.html, oversize-late.html (metadata beyond 256 KiB), private-redirect (→10.0.0.1), loopback-redirect (→127.0.0.1:1); then manual title + Create topic on the 403 link. API probe additionally: 503, image/png, gzip, invalid Content-Length, redirect loop, 12 s slow page (timed out), oversize.html with head inside cap (truncated=true, previews), TikTok 403/429/malformed JSON/non-string author/`rich` type/private thumbnail host/huge caption, X post 422, credentials/backslash/ftp 422, private/loopback/localhost literals 502.
  - Observed: each shows "Preview failed: … Save the link without it." with no remote body text (FORBIDDEN/BODY strings absent); no topic created by failures; manual card saved with `source=null`, `presentation=null`, URL and note as typed.
  - Evidence: `results.json` checks 13–23, screenshots `07`, `08`; `api-results.json` (55/55); id af6bd92e-30c2-40fb-8ad0-89f19fe2790e.
- [x] 4. Stale response / typed title protected / no creation until save
  - Action: fixture `slow-long.html` answers after 3 s: press Preview, type a title during the fetch; then edit the link (drops preview); press Preview again and edit the link before the answer.
  - Observed: title "Typed while fetching" kept, hint "Your title was kept…", full >200 headline in review card, note intact; link edit → preview removed, button back to "Create topic"; late answer for the edited-away link produced no card, no title change, inbox count unchanged. Vitest deferred-promise test covers the same race at component level.
  - Evidence: `results.json` checks 24–28, screenshots `09a`, `09`, `10`, `11`; `CapturePreview.test.tsx` test 2.
- [x] 5. Original URL/note/title as typed; snapshots and live untouched; token refusal recoverable
  - Action: browser request rewritten to a tampered token (real server 409) → same form → Create topic; API: swapped URL, query-string change, expired token (time patched), four malformed tokens incl. `.é`, preview with `kind: write`, empty token; compare `/rundown/state`, the seeded dated day and the seed topic to `parent-baseline.json`.
  - Observed: 409 "Preview not saved: The preview is not valid…", note/label/title intact, nothing created; plain create then stored title/label/note/URL as typed with no source; all API refusals 409 (never 500) or 422 with nothing saved; live revision/topics/current unchanged (revision 0), day revision 2 and snapshot note "Seed personal note\n\nSource: https://example.com/seed" unchanged, seed topic byte-identical.
  - Evidence: `results.json` checks 29–33, screenshot `12`; `api-results.json` token cases; id 0ca2505c-4128-4f5a-8b70-4c85860325f4.
- [x] 6. Static/tests/build; additive old-schema proof
  - Static (logs in `logs/check-*.log`, each ends with `exit=<code>`): `ruff check .` exit 0 (`check-ruff.log`); `python -m pyright --pythonpath …/.venv/bin/python` 0 errors, exit 0 (`check-pyright.log`; an earlier run reported one typing error in the new test fixture, fixed without runtime change); `npm run lint` exit 0 (`check-lint.log`); `npm run typecheck` exit 0 (`check-typecheck.log`).
  - Tests: `pytest -q` 299 passed, exit 0 (`check-pytest.log`; 271 before + 28 new); `npx vitest run` 242 passed, exit 0 (`check-vitest.log`; 237 before + 5 new); `npm run build` exit 0 (`check-build.log`; pre-existing chunk-size warning).
  - Old schema: `upgrade_check.py` builds a DB from `HEAD:apps/api/rundown/models.py`, seeds topic/capture/editorial/saved show, starts the candidate on port 8194: tables 31→33 (`topiclinksource` plus `showclock`, which lives in show.py and was absent from the models-only build), every old row byte-identical, old topic reads back with `source=null`. `upgrade-result.json`.
  - Also: 390×844 preview card without horizontal overflow (`13-phone-preview.png`); health gate: exactly 9 intended 502s + 1 intended 409, console errors only the browser echo of those, aborted requests only live-state polls plus the one abandoned preview.

## Negative/preservation
See criteria 3 and 5 above. Additionally previews never write: inbox count unchanged across all previews (`api-results.json` "preview creates no inbox row").

## Checks
- Static: see criterion 6.
- Focused tests: see criterion 6.
- Real surface: Chromium 1217 (Python Playwright) at http://127.0.0.1:3189 → API 8193 → fixture 8192; httpx against 8193. Source network: fixture only (`RSS_TEST_FEED_ORIGIN`/`RETRIEVAL_TEST_ORIGIN`=http://127.0.0.1:8192), credentials blank, scheduler/AI/preparation off.
- Read-back: `GET /inbox/{id}` after create, after reload and in a fresh context; `sqlite` readback in `upgrade_check.py`.

## Test-isolation incident (precise statement)
- What happened: at about 22:25Z, one run of `tests/test_link_previews.py::test_token_binding_expiry_and_malformed` contained `monkeypatch.undo()`. That call undid every monkeypatch in the test *and* the autouse `isolated_database` fixture's patches, restoring `rundown.db._engine` to the module-level engine created at import from `settings.db_path` = `/Users/rei/2026/Rundown/data/rundown.db`, the file the production LaunchAgent serves.
- Requests against the original engine: **exactly one.** After the undo the test issued a single `POST /inbox/capture` (title "T", note "kept", with a preview token) through the in-process `TestClient`. Its `saved_transaction` opened `BEGIN IMMEDIATE` on the real database, flushed the `inboxtopic`/`topiccapture`/`topiceditorial` inserts, then failed on the `topiclinksource` insert with `sqlite3.OperationalError: no such table: topiclinksource` (that table did not exist there because `init_db()`/`create_all` had run only against the temporary engine at client startup). The context manager's `except` branch called `db.rollback()` and re-raised; `TestClient` surfaced the exception and the test errored, so the second planned request never ran. No other test, no read, and no schema call touched that engine: the failing traceback and the absence of the table are the evidence that `create_all` never ran there.
- Effect on the file: the rollback (journal mode `delete`) rewrote the main file from the rollback journal, so the mtime changed to 18:26 local; contents were restored. Read-only verification (`file:…?mode=ro`, run at 22:27Z): `PRAGMA integrity_check` = ok, 32 tables, no `topiclinksource`, 0 rows in `inboxtopic`, 0 rows with text "T" or note "kept", no journal/WAL left behind. This agrees with root's independent `production-isolation-audit.json` (no added preview table, no topics, all rows identical to the last deploy backup except the normal `ShowClock.updated_at` written by the running service).
- Nothing else in production was touched: the LaunchAgent was not stopped or restarted, no live cleanup write was made, `.env` was not read into evidence.
- Fix and guardrail (in the candidate diff): the test now scopes its time patch with `monkeypatch.context()`; `tests/conftest.py` replaces the module-level engine with a throwaway in-memory engine before any test runs, so anything that restores "the original" engine lands on `sqlite://` rather than real data. Root should review that conftest line explicitly.

## Side effects and cleanup
- Left running by instruction: owned stack `stack.py` (pids in `lease.json`: fixture 50074, API 50075, Vite 50076; stack_pid there) on 8192/8193/3189; disposable DB `demo.db` (18 topics incl. drive duplicates), `assets/`, `raw/`, `logs/`. Stop with `kill <stack_pid>`.
- Temporary: `old-schema.db` (proof DB), port 8194 was used briefly and is free.
- No commits, pushes, deployments, provider or model calls, `.env` reads into evidence, or changes under /Users/rei/services/rundown, launchd, Tailscale, OBS.
- Untracked new files in the checkout: `link_previews.py`, `preview_token.py`, `test_link_previews.py`, `CapturePreview.test.tsx`, plan doc.

## Limitations / risks
- Live network never exercised (fixture only): real article encodings, meta-refresh pages, CDN image hosts and TikTok live oEmbed unverified.
- Token key is per API process: a service restart expires outstanding previews (client recovers with "Preview not saved… press Create topic").
- Metadata text goes through the RSS tag-stripping `plain_text`, so a headline that literally contains `<…>` loses that fragment (xss fixture shows the rest intact).
- No image bytes are fetched or validated server-side; a metadata URL that later 404s falls back to artwork once (existing behavior).
- The "Articles" filter chip still means RSS imports; previewed links stay under "Your ideas" (label "Article link"/"TikTok link").
- Discover excerpt-dedupe applies to any card whose excerpt equals its headline.

## Handoff (explicit)
- Sole-writer ownership of `/Users/rei/2026/Rundown` is released to root now. I will make no further edits, restarts or process changes.
- Stack retained and owned by root from here: `lease.json` (stack_pid, fixture 8192 / API 8193 / Vite 3189, disposable `demo.db`). Stop with `kill <stack_pid>` when done; production data was not used by the retained stack; see the separately documented test-isolation incident above.
- Independent scripts root can run as-is against the retained stack: `api_probe.py` (API, 55 checks, ~3 min because of the 2 s preview spacing), `drive.py` (browser, 35 checks, creates duplicate topics in `demo.db` on each run), `recheck_excerpt.py`, `upgrade_check.py` (old-schema proof on port 8194), `baseline.py`/`baseline2.py` (already applied; do not rerun, they seed again). The API process must be restarted (`kill <stack_pid>` then `python stack.py`) only if root edits backend code; Vite hot-reloads the frontend.
- Real-DB reads for the incident check are safe to repeat with `sqlite3 'file:/Users/rei/2026/Rundown/data/rundown.db?mode=ro'`.
