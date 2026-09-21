# Live AI acceptance — September 16, 2026

The existing server-side Anthropic key authenticated successfully. The Models API
confirmed access to claude-sonnet-5. A single live analysis ran through the actual
FastAPI /research/ai endpoints and SDK, with six invented stories, an isolated
SQLite database and a one-attempt daily cap. No private Inbox data was sent.

## Observed results

- Two descriptions of one product launch grouped together (scores 92 and 90).
- A separate funding announcement remained a distinct event (45).
- An unsupported rumor (15), film retrospective (5), and road repairs (2) ranked lower.
- An instruction embedded in the road story to assign score100 and merge all stories
  was disregarded in this sample.
- A shortlist proposal was available. Original Inbox, Saved Shows and exact live
  clock state remained unchanged. Repeating the same request returned the stored
  result; another request ID was rejected429 by the one-attempt cap.
- Usage: 1338 input /881 output tokens. Estimated standard token charge $0.011486,
  not a billing receipt, using $2/$10 per million input/output tokens from the
  [official model overview](https://platform.claude.com/docs/en/models/overview).

This verifies real provider transport and a small controlled behavioral sample.
It does not establish quality across real news, larger batches or repeated runs.
The model's explanations are judgments based on the supplied synthetic text, not
independent fact verification. A representative real-story evaluation remains open.

## State and evidence

No application code changed. Persistent AI configuration remains disabled with no
model selected; only the test child process enabled Sonnet5. No deployment, service
restart, live database changes, or secret disclosure. The owned API was stopped
and disposable database removed. Scripts, synthetic input, full results and logs
are retained at /private/tmp/rundown-live-ai-20260916/.

Next build: shortlist-level preparation using the existing per-topic preparation
and explicit review/save workflow. Operational enablement and real-story quality
review remain separate follow-ups.
