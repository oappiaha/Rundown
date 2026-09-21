# Research shortlist and show composer
Core outcome: organize active Inbox stories, select an ordered shortlist, preview and save it as an independent Saved Show without touching live playback.
Scope: additive ResearchPreference and ResearchBuild tables; separate /research API; categories (six design buckets + uncategorized), explicit priority/pin/exclude, transparent local ranking, conservative duplicate title/URL grouping. Category suggestions use keyword rules and remain editable; no AI/engagement claims. Composition retains existing titles/durations/context/source URLs. No fabricated talking points. Saved Show edits and explicit activation already exist.
Done: preferences strict revision-guarded/persistent; rankings and conservative grouping deterministic; auto shortlist diverse and pins/exclusions respected; preview read-only, build optimistic snapshot guard + idempotent request ID; real desktop/390 touch selection/reorder/preview/save/open; exact live clock and Inbox unchanged; static/full suites and HTTP/restart/browser proof.
Root sole primary owner for backend, then freeze writes and give actual Claude Code sole apps/web ownership. No concurrent checkout mutation. Existing main dirty work preserved. Temporary API8190/workerVite3190/rootAPI8191, DBs/evidence in /private/tmp/dienda/rundown-research; ports checked before launch. Seven verification/two rework budget. No keys/AI/public requests, live data, OBS, service, commit or deployment.


## Accepted September 15, 2026

Root implemented the backend; actual Claude Code implemented the frontend with
serialized checkout ownership. The worker monitor failed before a final browser
report, so root accepted only after independent compiled desktop and phone checks.

Verification: 118 API tests, 152 UI tests, Ruff, Pyright, ESLint, TypeScript and
production build passed. HTTP concurrency/restart checks passed. Browser acceptance
covered stale curation, fresh captured stories, shortlist order, preview invalidation,
lost-response save retry, existing dirty-show protection and phone save/open/reload.
A separate full rehearsal verified RSS/capture/context, explicit activation and
instant topic insertion while playing, preserving the current segment/deadline.

Evidence: `/private/tmp/dienda/rundown-research/evidence/` (JSON reports, scripts,
screenshots); final ownership/cleanup recorded in its parent `state.md`.
Local rules and saved context only; semantic grouping and model-backed ranking
remain next. No API keys, live database edits, commits or deployment in this round.
