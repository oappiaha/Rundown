# AI research ranking and grouping
Outcome: explicitly analyze selected saved Inbox stories against a user show brief; inspect grounded relevance/category/group suggestions and build an editable shortlist.
Queue: root backend running -> sole Claude frontend -> root independent browser acceptance. At most one repository writer; seven verification passes and two worker rework passes.
Lease: sole primary /Users/rei/2026/Rundown main base8eafdb96dba38038a4dde87986d4449378c308cc, existing dirty source preserved. Dependencies already installed. API8170, provider fixture8171, Vite3170. Temporary DB test.db, raw/logs/evidence under /private/tmp/dienda/rundown-ai-research. Root owns cleanup. No production data, OBS, services, commits, secrets or billed calls.
Done: preview exact bounded outgoing input and explicit consent; durable revision-guarded/idempotent runs with usage cap; valid complete ID coverage and strict response schema; human pins/categories/exclusions preserved; editable shortlist through existing composer; HTTP/restart/concurrent and compiled desktop/390px browser proof including failure/stale preservation.
Model contract: Anthropic Messages API, require end_turn and valid bounded JSON, no automatic retries. Official reference https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons . Test transport uses explicit loopback fixture and dummy key. Real enablement later needs Anthropic key and configured model; no default model guess.


## Accepted locally, September 15, 2026

Root implemented the backend; Claude Code implemented the frontend with serialized
checkout ownership. The worker supplied source/test/build checkpoints and a UI smoke
check. Its monitor repeatedly reported a false start failure; root harvested the
candidate, completed independent compiled acceptance, cancelled the worker and
confirmed it idle before final repository checks and documentation.

136 API tests and 169 UI tests pass, with Ruff, Pyright, ESLint, TypeScript and a
production build. Real SDK/HTTP fixture checks cover concurrent request identity,
invalid results, stale edits and restart. Root desktop/390px phone acceptance covers
exact input/consent, grouping, protected shortlist replacement, reorder/preview/save,
recovery of an earlier request after a newer one exists, stale proposal 409, and the
real daily cap. A missing-key restart produces a clear UI explanation and API503.
Activating the composed show and inserting a topic while playing preserves the
current segment/deadline and the independent saved show.

Candidate JS `index-BbOpT9iS.js`, CSS `index-C9kkyqvs.css`; evidence and source hashes
retained under `/private/tmp/dienda/rundown-ai-research/`. Runtime data is disposable.
No commits, deployment, live database edits, secret inspection or billed calls.

Limitations: deterministic fixture results verify protocol and recovery, not semantic
accuracy. Real model relevance/grouping evaluation requires configuring the intended
provider/model and running a small authorized sample. Whole-show talking-point
preparation and additional collectors remain later work.
