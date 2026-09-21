# YouTube and Reddit topic retrieval

Build saved keyword/channel/subreddit discovery searches with freshness, bounded result counts and explicit collection into the existing Inbox. Imported source evidence feeds existing Research AI ranking, shortlist composition, and topic/show preparation. Preserve manual instant topic insertion.

Root owns backend then Claude Code owns frontend sequentially in the existing checkout. No concurrent checkout writes; preserve previous uncommitted work. Verification uses API8170, fixture8171, web3170, disposable SQLite under /private/tmp/dienda/rundown-retrieval. No production deployment, live profiles or external collection.

Additive RetrievalSource/Run/RetrievedItem tables avoid altering existing SQLite tables. /retrieval CRUD, revision guards, request UUID recovery, global active-run lease, 2-second spacing and shared daily attempt cap. Fixed official provider hosts, no redirects, bounded JSON, no automatic retries. Retain canonical platform IDs, full title, available body, publication time and immutable source provenance. Duplicate imports leave editorial/archived topics alone.

YouTube uses Data API v3 search.list; keyword and/or channel ID, newest first. API key required. Descriptions are not transcripts. Reddit uses approved application OAuth client credentials, subreddit/global keyword search or subreddit newest posts; locally enforce requested freshness. Post text is not comments or linked article text. Expose setup reasons without secrets.

Current access references reviewed September 16, 2026:
- https://developers.google.com/youtube/v3/docs/search/list
- https://developers.google.com/youtube/v3/getting-started
- https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy
- https://www.reddit.com/dev/api/
- https://github.com/reddit-archive/reddit/wiki/OAuth2

These supersede the older implementation plan's assumption of anonymous Reddit JSON access. No paid data services. X/TikTok, transcript extraction, automatic collection/ranking and real-provider quality checks remain subsequent slices.

Acceptance: both providers through actual local HTTP protocol fixtures; safe credentials/errors/rate limits; repeat/lost-response dedup; source evidence in AI input; desktop/phone configure/import/review/compose; revision conflict preservation; unchanged live state; regression tests and build. Evidence and final results recorded after verification.

## Acceptance results

Root backend + actual Claude Code frontend (claude-fable-5-1 child
4640ce59d64b4868b016a4279b0c868a), sequential checkout ownership. Independent
root checks: 159 API tests, 191 UI tests, Ruff/Pyright, ESLint/TypeScript and
production build pass. Worker report: frontend-evidence.md; root evidence under
/private/tmp/dienda/rundown-retrieval/evidence.

- api.json /boundaries.json: both actual HTTP adapters against local fixtures;
  original evidence in AI input; compose saved show; safe provider failures,
  concurrent collection, exact retries and playing-clock preservation.
- restart.json: real process restart preserves sources/history/show/provenance;
  missing credentials reject without consuming an attempt.
- adapters.json: official-host requests, no redirects, bounded/malformed JSON,
  channel-only and subreddit-only requests (mock transport, no external calls).
- ui.json: final compiled desktop + fresh390px phone; new results for both
  providers; committed import followed by gateway503 recovers exact UUID once;
  draft navigation/refresh preservation; real stale409; pause; original evidence;
  Research shortlist/preview/save; phone dedup/reload; immediate live topic with
  context preserves the playing deadline and saved copy.
- polling.json: actual same-request recovery while provider is still running;
  terminal list status wins over a stale running history response.
- manual-dedup.json: short YouTube and long Reddit manual links match platform
  IDs; edit-away + archive still deduplicates without altering manual provenance.
- missing-key-ui.json: actual missing configuration on a390px compiled UI;
  search creation/editing works and collection is disabled.

Additive RetrievalIdentity table records matches against manual/RSS items without
replacing their provenance. Root hardened result reconciliation after reviewing
worker output. The worker monitor emitted false inactivity failures while the
child was observably running; root inspected code, browser traces and session
state, then confirmed the worker idle before its final edits.

No real platform collection, paid AI calls, persistent credential changes,
production data/service/OBS changes, commit, push or deployment. X access reference:
https://docs.x.com/x-api/fundamentals/post-cap . TikTok access references:
https://developers.tiktok.com/products/research-api and
https://developers.tiktok.com/docs/en/research-api-faq . Live access and content
quality remain unverified; these provider requirements are not satisfied by fixtures.
