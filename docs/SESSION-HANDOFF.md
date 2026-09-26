# RUNDOWN — start here in a new session

Updated September 26, 2026. This is the current handoff; NEXT-STEPS.md contains historical round reports, some superseded by later entries.

## Current operational status — September 26, 2026

Production runs on rei’s Mac mini as LaunchAgent `com.rei.rundown`, release `44dd08a`, at http://reis-mac-mini.taildb04a2.ts.net:8088/. Warm cream/sand UI retained. OBS runs separately on the MacBook; use the mini’s `/static/overlay.html`. See SHIPPING.md for service, backup and rollback instructions. User has authorized push and deployment; historical push rejection and Wolf-4 notes below are superseded.

Discover, streaming days, write/link/upload capture and pasted article/TikTok previews are implemented. New previews fetch title/creator/description/thumbnail only on Preview, retain manual fallback and personal notes, then persist source metadata with the card. No automatic players, full articles, transcripts, preference learning or approved Reddit integration. AI/preparation remain disabled.

Root verification: 299 API / 242 web tests, lint/types/build pass; independent API and Chromium preview/save/reload/mobile flows pass against disposable fixtures. Worker 55 API / 35 browser checks and schema proof retained. Production compiled UI, new preview control, API validation and overlay polling passed without saving test data. New empty table added; existing records preserved. See [release evidence](evaluations/2026-09-26-link-previews/README.md), including the rolled-back test-isolation incident and guardrail. Three live samples now pass: TypeSafe Jev, Blender 4.5 and TikTok’s official example, including real browser image decode/save/reload. See [real-source evidence](evaluations/2026-09-26-real-previews/README.md). Broader coverage and expiring TikTok cover longevity remain unverified.

Next: MacBook reachability and actual OBS rehearsal; then retrieval relevance/access and preparation improvements. Daily backups are local only; off-machine recovery remains pending. Mini must stay powered and signed in. The sections below are historical development records, not current push/deployment status.

## Objective and user preferences
Deliver a useful preparation-to-live workflow: retrieve relevant topics → curate a shortlist → prepare notes → save a timed show → explicitly activate and run it. Fast creation of a topic with context and insertion into the schedule, including during playback, is essential.

Keep the UI minimally cluttered: primary content/actions first, one copy of source text, optional details/tools collapsed, short contextual status/errors. Preserve the Sony/Walkman direction. Avoid adding permanent explanatory paragraphs, nested cards, or a dashboard for every backend capability.

Codex owns backend/integration; use actual Claude Code for frontend work when available. Never claim delegation without an observable worker. Use deez for real runtime proof, dienda for suitable multi-part work, ship before commits/deployment. Do not expand post-show reviews or peripheral features ahead of retrieval/preparation/live usability.

## Git and delivery state
At handoff creation the working tree was clean and HEAD was 5015924. This handoff and the NEXT-STEPS pointer are new local documentation edits.

Three local commits:
- 45bb92a — backend research/retrieval/preparation/show APIs and tests.
- 74c49b2 — control room UI, simplified context workflow and overlay.
- 5015924 — plans, verification reports and UI references.

Remote: git@github.com:oappiaha/Rundown.git, branch main. Local HEAD is three commits ahead of the last fetched origin/main (8eafdb9). This is a cached comparison, not a fresh remote check. Push was rejected by automatic approval review; the prior turn asked for explicit approval to push these three commits (code/docs/UI references) to this destination. The user's new-session question is not that approval. Do not say the work is pushed or deployed. Once approval is supplied, inspect changes, fetch/pull safely, push without force, and verify the remote commit. Include this new handoff in a reviewed docs commit if within the approved payload.

No operational deployment has occurred. GitHub push and Wolf-4/OBS deployment are separate actions.

## What exists
- Desktop/mobile schedule editing, transport, context notes, on-the-fly insertion/publishing with playback preservation.
- Saved shows, reuse/duplication, explicit activation, revision/conflict protection.
- Inbox manual capture/edit/archive/source URLs; independent copies into shows.
- RSS import, provenance, deduplication, history and scheduled imports.
- YouTube/Reddit saved searches, explicit collection, recovery/history and deduplication.
- YouTube search followed by one batched full-description metadata fetch; unavailable videos skipped, bounded text, atomic failure, no silent overwrites of existing ideas.
- X/TikTok public permalink previews → review → Add to notes → Save. These are NOT automatic search or video/transcript understanding.
- Local research curation/composition; optional AI relevance/category/same-event suggestions; per-topic and whole-show preparation with explicit review/apply/save.
- AI shortlist selection fix: pins and manual priority first, then relevance score; category variety only breaks score ties. Local-rule diversity behavior is unchanged.
- Published-show review exists; expanding it is not a current priority.

## Verification and limits
Last full verification before the push attempt: 188 API tests, 210 UI tests, Ruff/Pyright/ESLint/TypeScript checks and web production build passed. These are historical results, not tests rerun for this documentation handoff. Multiple rounds exercised isolated real HTTP and compiled desktop/390px browser flows, source/context preservation, retry/dedup and playing-clock protection.

Live YouTube authentication/import/full descriptions worked in bounded samples. One public X example and one TikTok example returned text. Recheck availability when needed; these results do not prove arbitrary content access. Reddit approved access/credentials were missing at the last check. Read configuration presence only; never print keys or ask for secrets in chat.

Anthropic synthetic six-story smoke previously passed. The later nine-real-video plus duplicate-control evaluation timed out; no valid real-story AI quality result or token/charge total was returned. A read-only Models API check succeeded afterward. That does NOT identify the timeout cause. One attempt only; same-request recovery and daily cap passed. Persistent AI configuration was left off. Controlled scores used to reproduce/fix the shortlist bug are NOT model-quality evidence.

## Ordered next work

### 1. Diagnose AI generation timeout, then complete real-story evaluation
Read apps/api/rundown/analysis.py and docs/plans/2026-09-18-ranking-evaluation.md. Current provider request timeout is 30 seconds, retries disabled; analysis lease is 90 seconds. Investigate transport/provider latency with safe diagnostics and controlled delayed fixtures before changing limits. Keep provider timeout, lease, UI recovery and idempotence consistent. Do not blindly increase timeouts or repeat potentially billed requests.

The old /private/tmp/deez/rundown-real-ranking/rubric.json is no longer present. Recreate a public-only sample: three AI filmmaking workflow videos, three fashion contrasts, three sports distractors using full metadata; add one clearly labeled manual duplicate of a real tutorial. Save source snapshots and exact bounded model input to a new isolated evidence directory. Do not use the live Inbox as evaluation input.

Record expectations BEFORE the model call: concrete filmmaking workflows outrank unrelated sports/fashion promotions; generic showcases rank below concrete workflows; identical coverage groups; distinct videos sharing a subject remain separate; sparse/promotional evidence gets cautious reasons with no invented facts. Use a bounded explicitly consented run with the existing preview/generate contract and no automatic retries. Resolve any outstanding provider-spend approval requirement before a new billed attempt. Review both model assessments and resulting shortlist; preserve manual overrides.

Done: source-grounded result assessment, explicit failures/limitations, exact-request recovery, bounded spend/usage where available, no source/live-state mutations, saved-show context/source retention. A single passing batch is a smoke test, not general quality assurance. Do not tune solely to one sample.

### 2. Improve retrieval quality and resolve access dependencies
Use evaluation findings to improve source/channel targeting and reduce promotional/empty-context results. Reddit requires approved app access, client credentials and identifying user-agent. Do not block independent YouTube work on Reddit setup.
Assess article/transcript/comment enrichment only where useful and permitted. Full YouTube descriptions are already implemented—do not rebuild them. X/TikTok automatic discovery remains unresolved under the no-paid-data-services constraint; public-link previews are not a substitute for discovery. Verify current official access options before implementation, and do not adopt logged-in scraping notes as verified authorization or reliability claims.

### 3. Connect and automate the useful preparation flow
Once relevance is demonstrated, streamline collection → shortlist review → timed saved show → prepared notes using existing surfaces. Add opt-in scheduling for YouTube/Reddit only with durable job state, limits, deduplication and restart/retry proof; RSS scheduling already exists. Keep activation/publishing explicit. Do not silently enable billed AI or overwrite editorial notes. Avoid new permanent UI panels.

### 4. End-to-end usability and operational release
Rehearse real-source collection through preparation, saved-show activation and live playback on desktop/phone. Verify fast new-topic/context insertion preserves playback. Then prepare host/port/data-backup/startup/OBS checks for a separately authorized Wolf-4 release. Do not change services/OBS or deploy merely because code was pushed.

## Working safely and efficiently
Read docs/SHIPPING.md for exact commands and hazards. Repo: /Users/rei/2026/Rundown. Never test against data/rundown.db. Use disposable DB/raw/log paths, disable RSS scheduler for unrelated checks, and use loopback fixtures for local verification. Separate authorized live integration samples from local fixture tests. Do not copy .env into evidence or worktrees.

API checks from apps/api: .venv/bin/python -m ruff check .; .venv/bin/python -m pyright --pythonpath /Users/rei/2026/Rundown/apps/api/.venv/bin/python; .venv/bin/python -m pytest -q. Existing HTTP tests need permitted loopback networking. Web from apps/web: npm run lint; npm run typecheck; npm test; npm run build. Launch API/web on unused ports 8100–8199 / 3100–3199 with isolated data; confirm candidate loaded, then exercise real requests/browser interactions and negative cases.

Previous rounds serialized checkout mutation: root backend first, Claude frontend sole writer next, root acceptance after worker idle. Use provisioned worktrees for concurrent writers. Worker monitor sometimes reported failure while Claude was still active: inspect inbox/session/evidence before duplicating work. Stop only owned verified processes; remove disposable data, retain reproducible evidence. No prior verification servers were intentionally left running; check current ports rather than assuming.

Omnigent screenshots: read send-image skill, upload via sys_os_shell using omnigent-send-image, return the printed tappable link. Inline images and local file paths do not reach the user. Do not reuse old session IDs blindly.

## Reading order
1. This file and docs/SHIPPING.md.
2. docs/plans/2026-09-18-ranking-evaluation.md and relevant source/tests.
3. docs/NEXT-STEPS.md for historical verification and feature inventory.
4. design docs/RUNDOWN_PRD_v2 (1).md, design docs/RUNDOWN_TDD_v2 (1).md, design docs/IMPLEMENTATION_PLAN.md for product/design intent; ui/ for visual references. Resolve stale “shipped” claims against code and verified reports.

Start the next session with task 1; keep the UI simplicity requirement active throughout. Report what is built, what is actually verified, and what remains blocked separately.


## September 24 continuation: timeout diagnostics prepared, spend approval pending

See [evaluation report](evaluations/2026-09-24-ranking/README.md). The working tree
now also contains uncommitted analysis timeout classification/logging, four focused
regressions, a repeatable real-HTTP transport harness, and durable public sample/input/
rubric artifacts. No UI layout change or timeout/lease/retry limit change.

Fresh verification:192 API tests,210 UI tests, static checks and web build pass.
Actual delayed-provider failure at30.02s is distinguished from a dropped connection;
in-flight and terminal exact-request recovery,409/429 guards and source/live
preservation pass. Read-only Models API succeeded; historical generation cause still
unknown. No new billed generation or valid model-quality result. Next step requires
explicit consent for ONE claude-sonnet-5 request on the frozen10-story sample,
max5000 output tokens, no retries, daily cap1. Persistent AI remains off. Keep push
pending; no commits/push/deployment occurred in this continuation.


## Latest continuation: approved live attempt consumed, read timeout confirmed

The user approved ONE metered Sonnet5 call with “ok lets continue.” It was executed
against the frozen10-story sample and failed after30.09s with timeout_read; no
assessments or token totals were returned. [Full evidence](evaluations/2026-09-24-ranking/LIVE-RESULT.md).
Exact-ID GET/POST recovery returned the stored failure, another ID was rejected429,
and source/live/saved-show state stayed unchanged. The owned server stopped;
persistent AI remains disabled. No additional code change, commit, push or deployment.

Do NOT repeat generation under that consumed one-call approval. Real-story model
quality remains unassessed, charge unknown, historical failure cause unproven.
The next independent work is a local-fixture experiment for bounded internal
streaming with first-response/progress diagnostics and deadline/lease/recovery
proof; only then propose another explicitly approved live attempt. Preserve the
sample.db failed-run ledger and frozen artifacts; do not reset the budget to retry.


## Latest: bounded streaming implemented and locally verified

See [streaming evidence](evaluations/2026-09-24-ranking/STREAMING.md). Internal
research analysis now streams with30s inactivity/60s total deadline within90s lease,
no retries, and complete-message/output validation before persistence. UI unchanged.
Seven real HTTP/SDK cases pass, including32s success, stalled/no-first-response30s
failures,60s endless-stream cancellation and truncated-stream rejection; recovery,
409/429, exact saved-show notes/source retention and source/live preservation pass.
Fresh database recheck passes.199 API/210 UI tests, static checks and web build pass.
No new paid call. Actual model quality remains unassessed. Next step is one explicitly
approved live streaming evaluation when the retained sample DB daily cap permits it;
never reset that ledger to bypass the cap. No commit/push/deployment.


## Latest: real streaming evaluation succeeded (September25 UTC)

User authorized “try again.” One call after natural UTC budget reset succeeded in
31.12s (first event1.118s), usage9015 input/2985 output tokens. Frozen sample unchanged.
Workflow scores96/90/88 outrank distractors1–3; duplicate correctly grouped; three
independent workflows form shortlist. Exact request recovery and429 cap verified;
explicit disposable saved-show readback retains original notes/source URLs; Inbox/live
unchanged. See [live streaming assessment](evaluations/2026-09-24-ranking/STREAMING-LIVE-RESULT.md).
Caution rubric only partially met: promotional claims treated too confidently, sparse
sports description overcharacterized, duplicate “identical” phrasing overstated. One
successful smoke batch is not broad QA. No further call, code change, commit, push
or deployment. Owned server stopped; persistent AI still disabled. The timeout
mitigation is now live-tested, not just fixture-tested. Next priority is retrieval
quality and stronger source-grounded evaluation, followed by preparation automation.


## Latest: input compaction and Jev investigation

[Compact input evidence and Jev assessment](evaluations/2026-09-25-compact/README.md).
Removed only exact autogenerated source-note copies from AI context; edited/manual
notes preserved. Requests short120character explanations (validation maximum500
unchanged). Actual API sample input20183→12329characters,38.9% reduction. Fresh
recheck verifies preservation and old-result stale/propose409.201 API/210 UI tests,
static/build checks pass. No paid comparison yet: retained evaluation cap consumed;
actual latency improvement and new explanation quality remain unmeasured.

Jev is relevant for typed categories/relevance/evidence decisions, not prose prep.
Official docs reviewed; provider speed claims unbenchmarked. No TypeSafe credential
present, no integration/provider switch. Configure access locally before a bounded
benchmark; never request secrets in chat. Keep current UI and manual overrides.
No push/commit/deployment; persistent AI stays off. Original frozen live evaluation
is historical evidence and remains preserved despite changed input making its run stale.


## Latest: full core-flow UI audit and OBS auth fix

[Full-flow audit](evaluations/2026-09-25-full-flow/README.md) covers79 captured browser
steps using fake sources/providers and disposable SQLite: discovery, curation,
manual/AI preparation, saved shows, activation, playback/insertion, overlay, reuse,
review, phone, conflicts/offline and scheduler. Core local flow works; user-facing
complexity needs reduction. GIFs delivered in Omnigent, links in the audit folder.

Found/fixed real OBS authentication bug (HMAC→specified SHA256 concatenations),
verified failed before/succeeded after against authenticated OBS v5 simulator;
203 API tests/static checks pass. No actual OBS deployment. Connected means API,
not OBS; no OBS setup/status UI exists. Recommend pause provider expansion, simplify
Discover→Prepare→Live, collapse optional controls, then add minimal OBS setup/health.
No UI layout changes, paid calls, commit, push or deployment in this audit.


## Latest: discovery-first UI concepts, user-directed overhaul

User rejected wordy forms and requested airy swipeable mixed-media microlearning, effortless personal notes and preference learning; talking-point generation is deferred. Built standalone Focus/Explore samples with Claude Code/Fable5.1 at ui/discovery-concept/. Production UI unchanged. [Evidence](evaluations/2026-09-25-discovery-concept/README.md):63 browser assertions plus independent parent desktop/mobile/touch proof. Fictional12stories, localStorage notes/saves, deterministic local feedback reranking; no live media/provider/OBS. GIF/screenshots delivered. Next: iterate on visual feedback, then integrate selected direction while preserving source context, private notes and explicit live-publication safeguards. No commit/push/deployment.


## Latest: streaming-day organization and personal topic capture sample

User likes swipeable discovery, wants same UI design plus organizing topics by streaming day and creating/uploading topics. Updated standalone sample at ui/streaming-day-concept/ uses original light/blue/silver styling (clarification unanswered; assumption stated). Named dated days have separate order/durations and shared topic notes. Write/link/text/image/PDF capture stored locally,1MB files. Main/negative/mobile browser proofs pass; [evidence](evaluations/2026-09-25-streaming-day-concept/README.md). Downloadable HTML/GIF delivered. Production app not migrated. No live integration, commit, push or deployment. Continue visual feedback before integrating this workflow into actual Inbox/shows.


## Latest: UI selected; metadata/import implementation direction recorded

User explicitly selected the streaming-day UI and requested figuring out imports/thumbnails. ui/streaming-day-concept is now the chosen design baseline. [Implementation design](plans/2026-09-25-selected-ui-and-media-imports.md) maps existing source adapters, fields dropped today, source-specific metadata/thumbnail extraction, backend storage and phased integration. First slice: preserve YouTube/RSS visual metadata and render real cards without waiting for AI, then persist planning/notes/uploads and paste-link enrichment. TikTok oEmbed cover metadata supported; Reddit approval remains unresolved. Do not mistake the demo for production integration. No application edits, provider calls, model spend, live data mutations, commit/push/deployment in this planning pass.


## September 26 link-preview implementation record (subsequently deployed)

Implements sequence step 3 of the selected-UI plan for the Link tab only: an explicit Preview button fetches article `<head>` metadata through the RSS public-address transport (factored into `rss.fetch_public`) or the official TikTok oEmbed answer, shows a compact review card, and saves the same metadata through a server-signed token (`preview_token.py`) into additive `topiclinksource` + existing `topicpresentation`. Nothing fetches on paste or page load; failures keep manual save; typed title/note/URL are never overwritten; saved-show snapshots and live state untouched. Plan/API contract: [link previews](plans/2026-09-26-link-previews.md). Evidence: `/private/tmp/rundown-link-preview/REPORT.md` (browser 35/35, API 55/55, 299 API / 242 web tests, static/build logs, old-schema proof, warm palette unchanged). One test-isolation incident (a `monkeypatch.undo()` briefly pointed one rolled-back request at `data/rundown.db`; verified read-only unchanged) is documented there with a conftest guardrail. Fixture-only verification; live sites/TikTok unverified. On-demand players, Reddit and X previews remain out. No commit, push, deployment, provider or model calls.
