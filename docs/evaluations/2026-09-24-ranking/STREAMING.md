# Bounded streaming verification — September 24, 2026

Implemented internal Anthropic SDK streaming for research analysis. The browser
still receives one complete, validated result. No UI/layout/API contract changes.
30-second connection/read inactivity limit remains; a new60-second total request
deadline cancels the async transport, within the90-second analysis lease. Retries
remain disabled. Source input, output cap5000 and editorial selection rules unchanged.

A complete message_stop event is mandatory, even if partial data contains valid
JSON and end_turn. Truncated output is rejected. No partial result is applied. Closing the local connection does not prove the
provider stopped processing or billing.
Logs record input hash, time to first SDK event, event count, completion and elapsed
time; no source text, provider text, headers, URLs or exception contents. First SDK
event is not necessarily first network byte. Failed/cancelled usage remains unknown.

## Actual running API / SDK evidence

| Fixture | Seconds | Stored status |
| --- | ---: | --- |
| success | 0.08 | succeeded |
| disconnect | 0.02 | failed |
| delay | 30.02 | failed |
| slow | 32.12 | succeeded |
| stall | 30.02 | failed |
| endless | 60.01 | failed |
| truncated | 0.02 | failed |

A progress-bearing32-second stream now succeeds; absence of a first response and
a stalled stream fail near30seconds; endless heartbeats are cut off at60seconds.
The same actual endpoints verify in-flight recovery, concurrent request409,
terminal exact-ID recovery, mismatched-payload409, final budget429 and no provider
retries. Exactly one provider call per distinct accepted request. Successful
shortlists save/read back exact titles/durations/notes and source URLs. Inbox/live
state stays unchanged. Fresh-process/database repeat tests slow success and rejection
of a stream missing message_stop. See stream-full-* and stream-recheck-* artifacts.

The first runtime pass found that midstream HTTPX errors bypass the SDK's wrapped
API errors. The implementation now handles both, backed by four additional raw
transport regressions. Full rerun passes. Unit regressions also prove deadline
cancellation exits stream/client contexts, never accepts incomplete output, and
preserves exact-request recovery. The provider deadline fits within the lease.

## Reproduce

From apps/api, with8185/API and8186/fixture free, use a fresh evidence directory:

```
.venv/bin/python tests/runtime/analysis_transport.py /private/tmp/stream-fresh
.venv/bin/python tests/runtime/analysis_transport.py /private/tmp/stream-repeat --recheck
```

The full real-time run takes about155seconds. It deliberately uses production
30/60second limits. The repeat takes32seconds. Both blank the provider key, require
the guarded loopback provider, use disposable SQLite, disable RSS scheduling,
verify their own API startup log and stop owned API/provider processes.

Ruff/Pyright and199 API tests pass. Web ESLint/TypeScript,210 UI tests and production
build pass. No new browser interaction test: no frontend code changed; this is
backend transport behavior exercised through actual HTTP. SDK streaming pattern:
https://platform.claude.com/docs/en/build-with-claude/streaming

## Limits and next step

These are controlled transport fixtures, not live-model ranking evidence. They
prove the slow-progress case works and waiting is bounded; they do not establish
that streaming resolves the previous provider read timeout. No new paid attempt
was made. A missing first response can still hit30seconds.

Before any live generation: obtain approval for one new metered streaming attempt
on the frozen public sample, max5000 output tokens, no retries, persistent AI off.
Respect the existing sample DB's daily cap and prior failed-run ledger; do not reset
it to evade the cap. Verify frozen input again, record provider usage if available,
then evaluate the rubric and actual shortlist. Historical ranking remains unassessed.

All owned servers stopped. Synthetic verification DBs removed after evidence capture;
the prior public sample DB/failed-run ledger remains untouched. No commits, push,
deployment, OBS changes or production database access. Existing edits preserved.
