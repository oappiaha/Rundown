# Bounded internal analysis streaming

Sole owner of current Rundown checkout; preserve prior changes and live database.
No paid calls, commits/push or UI changes. Provider inactivity30s, total60s,
lease90s, retries0. Internal SDK stream must finish and validate before saving.

Acceptance: complete slow stream succeeds after30s; no-first-response/stall fail;
endless progressing stream cancels at60s; truncated valid JSON rejected; exact-ID
in-flight/terminal recovery and409/429 preserved; source/live state unchanged.
Run real SDK/API with disposable SQLite on8185 and loopback fixture8186; root owns
process cleanup. Evidence /private/tmp/rundown-stream-proof, fresh repeat directory.
Use tests/runtime/analysis_transport.py; logs contain no raw provider content.
Static/full API checks and unchanged-web checks required. Maximum7 iterations.
Baseline is prior actual30.09s read timeout and local30.02s delayed fixture failure.
