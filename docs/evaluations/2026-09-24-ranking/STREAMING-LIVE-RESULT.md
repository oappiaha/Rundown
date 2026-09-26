# Live streaming evaluation — September 25, 2026 UTC

The user explicitly requested “try again” after the one-attempt streaming proposal.
The retained sample database's UTC daily allowance had naturally reset: previous
failed attempt September24, new request September25. No reset/deletion/budget increase.
One call, zero retries, same frozen input/hash and system prompt, claude-sonnet-5,
max5000 output tokens. No persistent enablement or live Inbox input.

## Observed functionality

Succeeded in31.12seconds. First SDK event1.118seconds,651 SDK events, completed
stream at31.103seconds. Result usage9015 input /2985 output tokens; actual dollar
charge not available. No additional generation was performed. This proves one live
streamed evaluation works past the prior30-second nonstreaming read window. It does
not retrospectively prove why each earlier request timed out or guarantee reliability.

Run fdbe60af-211d-4e84-bde4-adc6e1f349d7 returned all10 assessments, no stale input.
Exact request replay and GET recovered the same result. New-ID generation was rejected
429 with no provider call. Before/after reads confirmed unchanged Inbox, live state,
and saved-show list from generation itself. Explicit shortlist save/readback preserved
exact original titles/durations/notes and source URLs in a disposable saved show.
Server stopped. Prior failed-run ledger retained, persistent AI off.

## Predeclared rubric assessment

| Criterion | Assessment |
| --- | --- |
| Three concrete workflows outrank all fashion/sports distractors | Pass: workflow scores96/90/88; fashion3/2/2; sports1/1/1. |
| Concrete workflows outrank generic showcases | Pass for supplied fashion showcases; no same-subject generic AI showcase was included, so that harder distinction remains untested. |
| Manual duplicate groups with original | Pass: duplicate score88 and original share original group ID. |
| Distinct AI videos sharing a subject stay separate | Pass: all three workflow group IDs remain distinct. |
| Cautious explanations for sparse/promotional evidence, no invented facts | Partial: reasons mostly match provided descriptions, but caution is inconsistent; see below. |
| Three distinct workflow shortlist, editorial overrides preserved | Actual shortlist pass: Scene Foundation96, 30-minute workflow90, five-step workflow88. No duplicate/distractor displaces them. Override regression tests passed previously; this live sample has no manual preferences and does not independently test overrides. |

The detailed workflow descriptions support the tools/steps cited in the first three
reasons. Fashion and sports classifications align with their source descriptions.
However, the30-minute “one master prompt” tutorial gets a confident90 with no caveat
that outcomes are promotional claims and have not been verified from video contents.
The sparse ANTUNA item is called a “skills clip” although the saved description is
mainly subscription/social hashtags; that characterization is an inference, not
established content. The duplicate reason claims identical title/channel/description,
while its title is truncated and its manually copied context is bounded differently;
shared URL and copied text support grouping but “identical” overstates equivalence.

Therefore do not report every quality criterion passed. This is a successful
functionality/relevance smoke test with explanation-calibration limitations, not
comprehensive ranking quality assurance. The brief explicitly labels distractor
classes; performance on ambiguous within-topic comparisons is still unknown. No
prompt tuning or extra model calls were made in response to this single sample.

## Evidence and follow-up

stream-live-attempt.json, stream-live-http.json, stream-live-result.json,
stream-live-proposal.json, stream-live-saved-show.json, stream-live-checks.json and
stream-live-server.log preserve the exact request, timing, output, usage and readbacks.
Frozen source/input/rubric remain unchanged. No code changed this continuation; prior
199 API/210 UI tests and static/build checks apply, and this adds real-provider proof.

Research AI is now live-tested on this one public sample. The app remains local and
persistent AI disabled; enabling ordinary metered use is a separate configuration
choice. No push/deploy/commit. Next work: better source targeting and a more demanding
public evaluation set (specificity, ambiguity and evidence caution), then preparation
workflow improvements. Keep UI minimal and avoid optimizing to this single batch.
