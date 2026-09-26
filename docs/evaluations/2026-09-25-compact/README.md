# Compact research input and Jev assessment

Implemented exact importer-note deduplication in analysis only. For RetrievedItem
sources, only notes that exactly equal the generated import text are omitted from
model context; source_text/title/URL remain. Any edited, appended or manual context
remains under existing bounds. No Inbox or source mutation. Prompt now requests one
short reason, ideally120characters, retaining500character validation compatibility;
asks for brief caution on sparse/promotional evidence. No UI change.

Actual API proof on a disposable copy of the retained public sample: input shrank
from20183 to12329characters (38.9%). Source text/URLs identical, nine generated context
copies removed, manual duplicate context unchanged. Edited context retained and stale
revision409 verified. Previous model result correctly becomes stale; propose409
prevents reuse for changed input. Second fresh-process/database check passed. The
original frozen input/rubric and public-sample database were not modified.

201 API tests, Ruff/Pyright,210 UI tests, ESLint/TypeScript and web build pass.
No billed generation: current retained sample's one-attempt UTC allowance is used.
Reduced characters are not measured token savings or latency savings. Next live
comparison must respect that cap and compare against31.12s/9015 input/2985 output
baseline, using the same predeclared relevance/duplicate/evidence-caution rubric.
The concise-output prompt itself still needs model-quality and latency evaluation.
Owned servers stopped; disposable copied databases removed; snapshots retained.
No commit, push, deployment, persistent AI enablement or provider switch.

Reproduce script records the exact local sample-copy/API setup; it needs the retained
public sample DB and a fresh output directory. It makes no provider call. Evidence:
verification.json, preview.json, input.json, server.log. Original repository sources
and manual notes are never cleaned up as a token-saving step.

## Jev: fit assessment, not an integration claim

User supplied https://typesafe.ai/blog/introducing-system-one-models-and-jev .
Official docs https://docs.typesafe.ai/introduction describe Choice for categories,
Score for rubric-based relevance and Noul for binary judgments, with structured
outputs rather than generated prose. This is a plausible fast classification layer
for Rundown; free-text explanations/preparation would still require a generative
model or explicit fixed labels. Do not display templated labels as generated reasons.

Proposed benchmark (not run): use compact public inputs, category Choice plus
separate relevance/specificity/evidence-quality decisions, combine deterministically
in code. Keep pins/manual categories/priority authoritative. Handle exact URL
identity in code; candidate-pair event equivalence may use a separate question,
but enforce grouping invariants in code. Avoid asking each independent output to
magically produce a consistent global cluster. No automatic paid fallback.

Evaluate latency and task quality against frozen expectations plus harder
same-subject comparisons, sparse evidence, injection text and distinct-event pairs.
Provider speed claims are not measured app latency. Schema validity does not mean
factual correctness. https://docs.typesafe.ai/model-jaggedness/jev-1.13 documents
literal interpretation, irrelevant-context and adversarial-input weaknesses and
lack of guaranteed invariants between separate judgments. These matter here.

No TypeSafe/Jev credential was present under matching key/token names in process
environment or ignored .env; only presence was checked. No secrets printed/copied.
API access is required for a benchmark; configure locally, not in chat. Official
setup: https://docs.typesafe.ai/introduction/quickstart . No new service/account,
package, credential or app UI was added merely from reading the blog.
