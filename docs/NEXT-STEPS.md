# RUNDOWN — next build priorities

Reviewed September 15, 2026 against PRD/TDD v2.1 (`design docs/*v2 (1).md`),
`ui/rundown-mockups.html`, registered FastAPI routes, and the actual frontend.
This is an implementation assessment, not a deployment report.

## Current foundation

The control room supports desktop/mobile schedule editing, quick topic
insertion, immediate publishing, shared playback, and conflict recovery.
The topic-context round adds multiline background, questions, and source URLs.
Saved Shows now provides named preparation drafts, duplication, topic reuse,
and explicit activation. The Topic Inbox adds manual capture, context, source links,
archive/restore and independent copies into saved/live drafts. The API archives published schedule versions in SQLite;
published versions can now be browsed and reviewed in Show review. Source, asset, score, feedback, and stream-session models
exist; their user flows and research pipeline are not implemented here.

The PRD labels the research pipeline "shipped"; that label does not match this
checkout. The state, schedule, transport, saved-show, manual inbox, legacy bridge, health,
RSS feed configuration/import/history, and static-serving routes are registered.
Other collectors remain unbuilt. Local research, opt-in AI ranking/grouping and
per-topic preparation are implemented below; live-model quality is still unverified.

## Completed locally: saved shows and reusable topics

- Named drafts stay separate from live playback and retain titles, durations,
  notes and order across reloads/restarts.
- Save the published live rundown as a show; duplicate saved shows; reuse
  individual topics with notes as independent copies.
- Explicit activation copies a saved version into the live rundown, first topic
  paused. Saved/live revisions guard against conflicting edits.
- Desktop/mobile browser acceptance and API tests passed. Not deployed to OBS.

## Completed locally: topic inbox

- Capture and edit ideas with context and an optional source URL; archive/restore.
- Copy active ideas into saved-show drafts or append/insert next in live drafts.
  Source attribution is retained in the notes; copies are independent.
- Explicit Save/Publish persists additions; preparation does not alter playback.
- Conflict recovery preserves edits, and delayed copies are cancelled when the
  target changes. Desktop/mobile browser and live-clock preservation checks pass.

## Completed locally: RSS collection and import review

- Configure RSS/Atom sources, enable/disable them and import explicitly into Inbox.
- Keep original titles, source links and plain text alongside editable context.
- Deduplicate repeat/cross-feed imports, including edited and archived ideas.
- Record durable results and failure reasons; review before copying to shows.
- Backend real-HTTP and restart acceptance passed. Desktop/mobile browser
  acceptance passed; the Sony-style control-room layout is retained.
- 66 API tests and 83 web tests pass, with lint/type checks and production build.

## Completed locally: assisted topic preparation

- Explicit generation from previewed saved source/context; editable summary and
  3–5 talking points. Append to local context, then save explicitly.
- Anthropic configuration is opt-in, with a model choice, daily request allowance,
  bounded input/output and no automatic retries. Original text stays available.
- Backend checks, restart persistence, and desktop/mobile browser acceptance
  passed. 84 API tests and 102 UI tests pass.
- Suggestions survive ordinary view/filter changes; original context/source and
  saved/live copies stay unchanged until explicit append/save/publish actions.
- Production AI remains opt-in and requires a configured model. Provider protocol
  and UI recovery were tested with a local fixture, not a billed live-model call.

## Completed locally: scheduled RSS collection

- Opt-in intervals from 15 minutes to 7 days; next time in the browser timezone,
  last automatic result and shared import history.
- Saved next-run cursor and shared import lock prevent duplicate claims across
  API processes. One catch-up after downtime; no replay burst.
- Feed/schedule pause controls, manual-import independence and failure history.
- 90 API tests and 116 UI tests pass, plus actual timed-import, restart and
  desktop/mobile acceptance. No API keys needed.

## Completed locally: complete show-preparation rehearsal

- Exercised capture/import → context → saved show → explicit activation → live
  playback through the compiled UI, with a disposable database and local feed.
- Inserting a new topic with context and publishing immediately preserves the
  playing segment and its deadline. Preparation and reviews leave playback alone.
- Desktop and fresh 390px phone transport, reload persistence and overlay privacy
  passed again after adding Show review.

## Completed locally: post-show review and manual duration records

- Browse published versions newest first, including older pages and saved context.
- Explicit per-topic Good/Neutral/Bad ratings, review notes and manually entered
  actual seconds, with differences from planned duration. Blank differs from zero.
- Reviews persist across restart, preserve original archives/live clock and guard
  conflicting edits. Legacy Feedback records remain readable.
- 105 API tests and 131 UI tests pass, plus independent compiled desktop/mobile,
  delayed-response, actual HTTP, concurrent-save and restart checks.
- Published versions are snapshots, not automatically recorded stream sessions.
  No automatic timing or scoring feedback loop has been enabled.

## Completed locally: Research shortlist and show composer

- Research groups active Inbox stories into editable categories, with explicit
  priority, pins, exclusions, ranking reasons and conservative matching coverage.
- Suggest a diverse shortlist, adjust its order, preview saved context and total
  duration, then save an independent named show and open it in Saved Shows.
- Conflicting edits preserve local work; interrupted save retries create one show.
- 118 API tests and 152 UI tests pass, plus real HTTP/restart checks and compiled
  desktop/390px phone acceptance. Instant live insertion still preserves playback.
- Ranking and category suggestions use local rules. Composition retains saved
  text and duration. Optional AI suggestions are implemented separately below.

## Completed locally: optional AI research analysis

- Explicit selection of up to 20 stories and an editable show brief; inspect exact
  bounded source/context input before consenting to a provider call.
- Suggested relevance scores, categories, same-event groups and explanations feed
  the existing guarded, editable shortlist. Manual curation keeps precedence.
- Durable request recovery, daily attempt limits, malformed-result rejection and
  stale-source protection. Source editing remains available during analysis.
- 136 API tests, 169 UI tests, lint/type checks and production build pass. Independent
  compiled desktop/phone, real HTTP/restart, missing-key and live-insertion checks pass.
- Provider protocol and recovery were tested with a local fixture. No real model
  quality assessment or billed calls yet; AI remains off by default.

## Live provider smoke test: September 16, 2026

The configured Anthropic key authenticated and one Sonnet5 analysis passed on six
synthetic stories. Same-event grouping, separate-event preservation, relevance
ordering, injected-instruction rejection, request recovery and the daily cap passed.
Usage was 1338 input /881 output tokens (estimated $0.011486). Persistent AI settings
remain off; no private stories were sent. See [acceptance report](plans/2026-09-16-live-ai-acceptance.md).
Real-news quality across representative batches remains unverified.

## Completed locally: whole-show preparation

- Saved Shows now previews and generates summaries/talking points for all saved
  topics in one request, with editable results and selected-topic apply.
- Explicit save appends reviewed notes while retaining original context/source
  links and topic identity/order/duration. Playback remains unchanged.
- Edited suggestions survive navigation/show switching/status refresh. Durable
  generation recovery and exact-save retry prevent duplicate provider attempts
  and duplicated notes. Stale/oversized saves reject atomically.
- 145 API and 182 UI tests pass, plus independent compiled desktop/390px phone,
  restart, 20-topic boundary, missing-key, concurrent-edit and live insertion checks.
- Uses existing preparation model/key and a shared daily attempt allowance.
  Whole-show provider behavior was tested with a fixture; paid-model quality
  evaluation remains open. No additional billed calls or persistent AI enablement.

## Completed locally: YouTube and Reddit discovery

- Saved keyword/channel/subreddit searches with freshness, result limits, pause
  controls, setup status, explicit collection and durable history in Sources.
- Original source evidence enters Inbox and existing Research AI input/composition;
  manual topic creation with context remains available throughout the show workflow.
- Stable platform identities handle common YouTube/Reddit permalink variants,
  preserve edited/archived/manual topics, and prevent repeat import duplicates.
- Lost/gateway responses recover the same collection attempt; revision guards,
  active-run leases, safe provider errors and daily limits protect retries.
- 159 API /191 UI tests, static checks, production build and independent compiled
  desktop/390px phone acceptance passed. Collection → Inbox → Research → saved
  show and instant live insertion preserve source context and playback deadlines.
- This round used local provider fixtures, not live YouTube/Reddit or billed AI.
  YouTube needs its Data API key; Reddit needs approved access and app credentials.
  Descriptions/post text only; transcripts, comments and linked articles remain open.

## Completed locally: public X/TikTok link context

- Inbox Source URL → Fetch link context → review → Add to context → Save idea.
- Official public oEmbed endpoints retrieve X post text or TikTok captions;
  existing editorial context/title are preserved, blank titles can be suggested,
  and limitations remain in saved notes. No new API keys or paid services.
- Unsupported/private/unavailable links leave manual capture available. Delayed
  responses cannot populate a different link/idea; repeated fetch/reopen cannot
  append the identical context block twice; oversized appends are refused.
- 173 API /210 UI tests, Ruff/Pyright/ESLint/type checks and production build pass.
  Independent compiled desktop/390px phone acceptance proves preview/apply/save
  and Research → saved show retain text and attribution without changing a
  playing show's state. An RSS provenance regression caught by the existing
  suite was fixed by giving sibling panels distinct React keys.
- Verification used synthetic providers. Live provider availability is not yet
  verified. No transcripts/media analysis, automatic X/TikTok discovery, immutable
  social-import provenance or Inbox-record deduplication are claimed.
- No deployment, live database edits or paid-model calls. Evidence:
  `/private/tmp/dienda/rundown-social-links/root-acceptance.md`.

## Completed locally: simpler Inbox and live retrieval checks (September 17)

- Source preview now uses one flat card and one copy of the caption. Preview link,
  Add to notes and Open original are the primary controls; Details holds longer
  limitations, counts and refresh/canonical controls. Notes and title come first.
- Source history and assisted preparation are collapsed, with preparation status
  still visible. Existing drafts, consent and duplicate/stale guards remain.
- All 210 UI tests, lint/type checks and production build pass. Independent compiled
  desktop/390px browser checks cover preview/apply/save, errors, duplicates, source
  history and preserving a playing show. Backend code is unchanged this round.
- Real YouTube key authentication and searches succeeded. A real application import
  added five videos to an isolated Inbox and saved show with descriptions/source
  links intact; retry reused the same run and playback remained unchanged.
- One public X post and one public TikTok example returned usable text via live
  oEmbed. This verifies sampled availability, not general discovery or all links.
- Reddit approval and required credentials are still missing. No paid-model calls,
  deployment or live database changes were made.
- Quality probe: six of ten sampled videos had fuller descriptions available from
  video metadata than from search snippets; four had none. Full description
  retrieval and real-story ranking quality are the next priorities.
- Evidence: /private/tmp/dienda/rundown-clean-ui/root-acceptance.md.

## Completed locally: fuller YouTube descriptions (September 18)

- Existing collection now retrieves full video descriptions in one metadata batch,
  matches by ID, skips unavailable videos and preserves bounded source context.
  Metadata failures leave the Inbox unchanged; exact retry/dedup preserve edited ideas.
- No frontend changes: source text remains in the existing collapsed disclosure.
- 186 API tests, Ruff and Pyright pass. Real fixture HTTP verifies import → Inbox →
  saved show, failure atomicity, recovery and playing-clock preservation. Desktop
  and 390px phone source-disclosure checks pass.
- Separate live smoke test retained five videos with descriptions of 280–1155
  characters. No transcripts or AI-quality evaluation are claimed.
- Existing ideas are not backfilled. No new credentials, paid AI, live DB changes
  or deployment. Evidence: /private/tmp/deez/rundown-full-descriptions/.

## Completed locally: relevance-first AI shortlists (September 18)

- Reproduced a selection bug: category variety caused controlled scores 95/85/65/2
  to yield 95/65/2. AI shortlists now put relevance ahead of category variety,
  retaining manual pins/priority, duplicate groups and stale-result guards.
  Category variety remains a tie-breaker; local-rule suggestions are unchanged.
- 188 backend tests and static checks pass. Real HTTP verifies corrected
  selection 95/85/65, saved-show source retention and playing-clock preservation.
  No frontend panels, controls or explanatory copy were added.
- Real quality evaluation: retrieved nine public videos plus a labeled duplicate
  control and saved a rubric before one model attempt. The attempt timed out;
  there is no valid model-quality result. Same-request recovery and one-attempt
  cap passed. No automatic billed retry; token usage/charge is unavailable.
- Controlled scores used for the selection regression are not model assessments.
  Persistent AI settings remain unchanged; no private Inbox data was sent.
- Report: plans/2026-09-18-ranking-evaluation.md. Runtime evidence:
  /private/tmp/deez/rundown-real-ranking/.

## Remaining core tasks, in order

1. **Retrieval quality and Reddit access:** YouTube live retrieval and sample
   X/TikTok previews now work. Configure approved Reddit app access; evaluate editorial relevance
   using the fuller YouTube descriptions now collected.
   Keep the existing no-paid-data-services constraint.
2. **X/TikTok automatic discovery:** public-link previews are implemented below,
   but keyword discovery is still open. X documents pay-per-use search access,
   which conflicts with the no-paid-data constraint. TikTok Research API has
   eligibility restrictions; Display API is scoped to authorized users. Sample live oEmbed requests passed; do not equate link previews with search.
3. **Richer source context:** assess transcript/article/comment retrieval where
   permitted and useful; never imply that descriptions establish a video's claims.
4. **Real-story AI quality and automation:** evaluate ranking and whole-show
   preparation on retrieved material, then connect collection/ranking/preparation
   with visible job state and recovery. Keep explicit show activation. RSS already
   has scheduling; YouTube/Reddit collection is currently manual.
5. **Operational release:** validate the intended host, service startup and actual
   browser/OBS workflow under an authorized release.

Review-note extensions are outside the current core build priorities. Twitch chat,
distribution exports and multi-user features can follow the preparation/live flow.

## Operational release is separate

A real OBS/Wolf-4 deployment still needs an authorized release: verify the
actual target, available port, data backup, service startup, and OBS URL against
that machine. No live setup changes were made by the local build rounds.
