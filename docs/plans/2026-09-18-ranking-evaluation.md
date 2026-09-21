# Real-story ranking evaluation and shortlist ordering
Evaluate nine public YouTube results (3 film,3 fashion,3 sports) plus one explicitly controlled manual duplicate. Record rubric before one bounded Sonnet5 request. No private Inbox content, one-attempt cap, no persistent enablement.
Live provider attempt timed out; no valid quality conclusions or token/billing total. No second generation attempted. Same-ID recovery and new-ID429 verified.
Independent deterministic bug reproduced through actual propose endpoint: controlled scores95/85/65/2 yielded95/65/2 because category diversity preceded relevance. Fix AI proposal selection only: pins first, manual priority, descending AI score, then category variety as a tie-breaker. Keep local-rule shortlist diversity unchanged, groups/exclusions/stale guards and manual category precedence.
No frontend changes or new clutter. Add regression tests and rerun existing manual-override/local-rules tests; real HTTP repeat same fixture after restart, unique-group shortlist ->savedshow preserves notes and liveclock. Mark model-quality evaluation pending, not passed.

## Observed acceptance
Before: actual running propose endpoint returned controlled scores95/65/2.
After restart with the candidate:95/85/65, duplicate excluded. Saved-show readback
retains exact notes/attribution; original Inbox and playing clock unchanged.
Editorial source edit still makes the result stale and propose returns409.
188 backend tests/Ruff/Pyright pass, including manual-pin/category/priority and
local-rule diversity preservation. No frontend changes, commits or deployment.

The real analysis request returned the existing connection/timeout error. Its
stored status is failed; input/output usage absent, charge cannot be established
from the API response. Exact request reuse returned that failure; another request
ID was rejected429. No live model retry occurred. Controlled regression results
must not be reported as evidence of actual model ranking quality.

Remaining: diagnose provider transport/latency before another bounded real-story
quality attempt. Public sample/rubric preserved in scratch for reproducibility.

A separate read-only Models API check returned200 in0.23seconds and listed
claude-sonnet-5. Credentials/model availability were valid at that check; this
does not isolate the cause of the generation timeout. No second generation call.
