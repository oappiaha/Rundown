# Consented real-story attempt — September 24, 2026

The user approved the proposed single metered Sonnet5 evaluation by saying
“ok lets continue.” Exactly one generation attempt was made against the frozen
10-story input through the real /research/ai/input and /research/ai/generate API.
Input equality and SHA-256 were checked before claiming the attempt. No automatic
retry, model substitution, timeout increase or persistent AI enablement occurred.
The frozen rubric remains unchanged, including its approval=false value at freeze;
live-attempt.json records the subsequent consent separately.

## Observed result
- Model: claude-sonnet-5; output cap5000; daily cap1; SDK retries0.
- Run:24c0912d-135d-4afc-b3c7-190298732164.
- HTTP response:200 containing status=failed, after30.087s.
- Provider diagnostic:timeout_read, elapsed30.054s.
- Stored error: Provider timed out waiting for a response. Check usage before starting another analysis.
- Input/output token usage:null. No exact charge can be established from this response.
- No assessments, shortlist or AI-derived show were produced. Every model-quality
  rubric item remains unassessed; this is not a ranking-quality failure or pass.

A read timeout is distinguishable from a connection-establishment timeout and from
output validation failure. It does not distinguish slow provider generation from
an interrupted/stalled network response, nor establish the cause of the earlier
historical timeout. Do not claim the timeout is fixed or raise limits on conjecture.

## Recovery and preservation
GET by exact run ID and exact POST replay returned the same stored failed result.
A fresh request ID returned429 under the one-attempt daily cap. Generation left the
isolated Inbox, source context, live state and saved-show list unchanged. No live
production database was touched. The owned API stopped; persistent AI remains off.
The disposable sample DB is retained with its failed-run ledger, rather than reset
to bypass the cap. Request/result/checks/server-log artifacts are alongside this file.

## Remaining work
The authorized one-call allowance has been consumed. Do not generate again without
new explicit spend authorization. Model quality and actual AI-shortlist retention
are still pending. Prior local/public-context save/readback evidence remains valid,
but is not evidence for a model-generated shortlist. No code changed during this
live-attempt continuation, so the prior192 API/210 UI checks were not rerun.

A useful next hypothesis is internal streaming with a bounded total deadline,
first-response/progress diagnostics, no retries and lease-compatible recovery.
Anthropic documents internal streaming that still returns a complete message:
https://platform.claude.com/docs/en/build-with-claude/streaming
Its error guidance distinguishes long-request and idle-connection hazards:
https://platform.claude.com/docs/en/api/errors
These docs motivate a controlled experiment; they do not prove streaming will fix
this failure. Before any new paid experiment, implement/prove delayed chunks,
missing first response, stalled stream, lease deadline and exact-ID recovery using
local fixtures, then specify the next bounded paid attempt for separate approval.

No commit, push or deployment occurred. The original pending push remains pending.
