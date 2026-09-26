# AI timeout diagnosis and public ranking sample — September 24, 2026

**Latest live result (September25 UTC):** [streaming succeeded in31.12s](STREAMING-LIVE-RESULT.md); correct relevant shortlist and duplicate grouping, with explanation-caution limitations.

**Latest transport update:** [bounded streaming implemented and locally tested](STREAMING.md). No additional live call.

**Previous live result:** the subsequent approved single live attempt timed out after30.09s
with a confirmed read-timeout classification. Ranking remains unassessed and
usage/charge unknown. See [LIVE-RESULT.md](LIVE-RESULT.md). The report below records
the pre-approval preparation and fixture verification.

## Result and limits
Implemented transport diagnostics, not a timeout-limit increase or a model-quality
fix. The original live failure cannot be diagnosed retrospectively: its persisted
error conflated connection failures and timeouts. No billed generation occurred in
this round. Real-story ranking assessment remains blocked on explicit spend consent.

The actual API plus actual Anthropic SDK against a loopback fixture demonstrated:
- Success in 0.03s, dropped connection in 0.01s, delayed response timeout in 30.02s.
- Persisted read-timeout and connection-failure messages are now distinct.
- Logs contain only local run ID, failure classification and elapsed seconds;
  timeout regression tests reject leaked exception text, URLs and fake secrets.
- During a pending request, GET and exact POST return running; a new ID returns409.
- After completion, exact POST/GET recover the result without another provider call.
- Exactly three fixture calls for three distinct attempts; fourth ID returns429.
- Inbox and live state remain unchanged. No UI components or layout changed.

Provider timeout remains30s, lease90s, max output5000tokens, SDK retries0. The HTTP
transport timeout is per operation/inactivity, not a new total wall-clock deadline;
existing expired-run fencing remains intact. We have not established that30s is
sufficient for the live sample, nor justified raising it.

Read-only Models API:200 in0.316s, claude-sonnet-5 listed. That proves neither
Messages latency nor generation success. Key values were never printed or copied.

## Reproduce transport verification
From apps/api, with8185(API) and8186(fake provider) free:

```
.venv/bin/python tests/runtime/analysis_transport.py /private/tmp/rundown-transport-fresh
```

Use a fresh output directory. The harness starts its own API with disposable SQLite,
checks its owned startup log before requests, blanks the provider key, disables RSS
scheduling and stops both owned servers. It uses the real30s timeout; expect~32s.
See runtime-verification.json and runtime-server.log. Baseline/candidate JSON record
the before/after runs; no fixture scores are model-quality evidence.

## Frozen live evaluation proposal
Public YouTube API searches retrieved six candidates each with batched full video
metadata. The first three from each group form this sample: three AI filmmaking
workflows, three fashion contrasts, three sports distractors. Snapshots retain the
collector's bounded description text (up to6000characters); no transcripts/video
were retrieved. One explicitly labeled manual duplicate repeats the first tutorial.

- source-snapshots.json: the nine real descriptions and URLs.
- input.json: exact bounded user message (20,183characters).
- system-prompt.txt: exact system instruction.
- rubric.json: expectations frozen before any model generation; duplicate ID/URL.
- request-draft.json: brief and selections for the existing preview/generate API.
- checksums.json: artifact integrity values (input.json hash equals rubric input_hash).

Proposed call: claude-sonnet-5, this frozen input and system prompt, max_tokens5000,
one attempt, daily cap1, no SDK/automatic retries, no persistent enablement. This is
a metered provider request; no exact dollar charge is asserted. A timeout can leave
usage unknown. Approval must precede the call. Reuse the exact request ID for result
recovery, never substitute a new ID to retry. The sample DB is retained temporarily
at /private/tmp/deez/rundown-timeout-20260924/sample.db; if unavailable, reconstruct
a disposable sample and re-freeze IDs/input before generation.

After consent: run through preview/generate, preserve exact request/result/usage,
assess every rubric item against source evidence, inspect the AI shortlist, verify
manual overrides and saved-show retention. One sample is a smoke test, not general
quality assurance. Sparse/promotional claims are source claims, not verified facts.

## Verification and cleanup
192 API tests,24 focused analysis tests, Ruff/Pyright pass. Web ESLint/TypeScript,
210 UI tests and production build pass. Existing manual-pin/category/priority,
local-rule diversity and expired-lease tests pass. No new browser journey was run;
this change is backend diagnostics, verified through real HTTP.

An independent real-HTTP save/readback of all10 public sample topics preserved exact
titles/durations/notes and source links; Inbox/live state unchanged (retention.json).
This is source-retention evidence, not AI-shortlist evidence. Only the disposable
sample contains that saved show. All owned servers stopped. Synthetic probe databases
removed after evidence capture; public sample DB deliberately retained pending approval.
No live data/rundown.db changes, persistent configuration changes, commits, push or
deployment. Existing NEXT-STEPS and SESSION-HANDOFF edits were preserved.
