# Selected UI and media imports

Status: user selected the streaming-day concept on September25,2026. This is the implementation design, not a claim that the prototype is integrated. Chosen baseline: ui/streaming-day-concept/. Keep original light/blue/silver design, Focus/Explore discovery, quick personal notes, separate dated show plans, and Write/Link/Upload. Talking-point generation remains deferred. No new permission needed to continue authorized local implementation; push/deploy remain separate and unapproved.

## User experience
Paste a link, upload material, or collect from a configured source. Save the topic promptly; enrich its card asynchronously. The card shows the original headline, publisher/creator, publication time when known, a brief attributed source excerpt and an image when available. Missing metadata does not prevent saving, noting or adding to a day. Full source text stays in Read more. No AI generation on the critical path. Model relevance work is a separate later step.

Image order: a user-chosen cover, provider/publisher image, then the existing deterministic artwork or a text-first discussion card. No fabricated news imagery, engagement numbers or durations. Images lazy-load; failed images fall back once without retry loops. Preserve aspect ratio: YouTube landscape, TikTok portrait, article cover crop, text-only Reddit discussion if appropriate. Media duration is distinct from the user's allotted speaking time. Load third-party players only after an explicit play action; thumbnail support does not imply permission or ability to download videos.

## What the repository already has
- collectors.py: YouTube search followed by videos.list(part=snippet); structured thumbnails discarded when converting to rss.Entry. Channel name is embedded in body text rather than retained separately. Duration is not requested.
- social_links.py: official TikTok/X oEmbed preview. TikTok caption/author retained; thumbnail_url and dimensions discarded. Preview is read-only and not yet a persistent source record.
- rss.py: bounded public-address fetcher with checked/pinned DNS and redirect validation. RSS/Atom title, text, date and link imported; Media RSS thumbnails/image enclosures ignored. It deliberately does not fetch articles today.
- inbox.py source_detail exposes original title/body/date/imported date; no image/creator/media-duration fields. Manual capture preserves links without fetching them.
- models.py has thumbnail_url on legacy Asset, but the active InboxSource/RetrievedItem workflow does not use that model. Do not revive a parallel legacy ingestion system.
- SavedShow stores independent topic copies, with no scheduled date. Current TopicIn text limit30characters and duration15–3600seconds are live-controller constraints. Do not blindly plug the prototype's long headlines/1–120minute input into those APIs.
- Browser prototype uploads have no production upload endpoint or durable backend file storage. LocalStorage is demonstration storage only.

## Source-specific ingestion
| Source | Import path | Card metadata | Failure behavior |
| --- | --- | --- | --- |
| YouTube | Keep official search; retain video snippet; request contentDetails/status when needed | Video ID, canonical URL, full title/description, channel, published date, offered thumbnail URLs/dimensions, duration, embeddability | Private/deleted/blocked video keeps topic/notes; unavailable media affordance |
| Articles/RSS | Prefer entry Media RSS thumbnail or image enclosure; otherwise bounded article-head metadata request | Original headline, publisher/author if given, excerpt, date, image+alt text | No image yields artwork; no full article yields attributed excerpt/link |
| Pasted article URL | Validate and save URL, then bounded server-side Open Graph/standard meta extraction | og:title, og:description, og:image, og:site_name and optional article metadata | Blocked/paywalled/no-metadata page retains link plus editable manual title |
| TikTok | Extend existing official oEmbed adapter for full supported permalink | Caption/title, author, thumbnail_url/width/height, source ID | Unavailable/private/expired preview retains link, no guessed transcript or duration; broader discovery is separate from permalink previews |
| Reddit | Existing official adapter only after approved access for this use case | Post title/body/community; preview image and counts only when available in approved responses | Text-first thread card; source link/manual context while access unresolved; no unauthenticated scraping fallback |
| Own uploads | Backend upload + managed local asset files | User image as cover; TXT/Markdown as source text; PDF attachment with document cover initially | Preserve original file; no claim of PDF OCR/extraction in first slice |

## Minimal data design
Extend the active Inbox route with an optional `presentation` object rather than changing every caller. Add a sidecar topic-presentation table keyed by InboxTopic.id, storing full display headline, structured creator/publisher, excerpt with provenance, media kind/duration, provider identity, image metadata and enrichment state (pending/ready/partial/unavailable), fetched time and bounded failure reason. Keep source body/source URL, personal editorial notes and show-specific copies distinct. Allow a user cover override to survive automatic refresh. Do not parse channel names back out of generated notes when upstream structured metadata is available.

For uploads add a local attachment table/path under a managed assets directory; serve by opaque ID through the API. Store file type, size and content hash. Apply size/type/decode limits, atomic file/DB commit and cleanup on failure. Do not carry browser base64 storage into the backend. Start with images/text/PDF; video processing later only if needed.

Add dated show-plan metadata linked to existing SavedShow and topic-origin links for display metadata. Keep explicit activation/publish and revision conflict safeguards. Source refresh must not rewrite an already prepared/live show's notes. The prototype shares library notes across days; production should show a library note by default with an explicit per-show override/snapshot when prepared. Do not silently rewrite historical show copies. Full discovery title and compact live overlay label are separate fields; avoid silent30character truncation. Keep current live bounds until deliberately changed with controller tests.

SQLite create_all does not migrate existing columns. Prefer additive tables first with versioned migration/backfill and disposable old-schema upgrade proof; no destructive evolution or live DB verification. Preserve imported generated notes as historical content rather than guessing which portions are user-authored. Separate personal-note field for future editing; legacy note history remains accessible.

## Fetching, freshness and deduplication
Reuse bounded fetch/DNS/redirect defenses from RSS for article metadata; every URL/redirect/image target must remain public and validated. Do not execute provider HTML/scripts or treat it as instructions. Accept only supported image types and bound decoded pixels if processing. Keep provider content attribution. Use provider ID/canonical URL deduplication already in retrieval.py; enrichment updates must not create duplicate topics or overwrite user fields.

Reuse returned provider thumbnail URLs first; do not assume permanent copies of third-party assets are allowed. Metadata/cache retention and refresh must follow each provider's policy. Use fetched/expiry information when known; on an expired cover request at most one bounded metadata refresh, then fallback. Do not guess URL TTLs. Freshness applies separately to cover links and engagement counts. No API keys in browser requests or logs.

## Implementation sequence
1. Preserve and expose card metadata on existing YouTube/RSS imports, using an additive presentation record. Add missing-image/failure fallback and lazy rendering in the selected UI. First acceptance: real source cards without waiting for AI.
2. Wire discovery/save/notes and dated plans to existing Inbox/SavedShow backend, preserving conflict/activation/live behavior. Local file upload storage and paste-link enrichment share the same topic pipeline.
3. Extend TikTok permalink preview with thumbnail persistence and build article Open Graph extraction. Add on-demand official embeds with unavailable fallback.
4. Enable Reddit collection only under approved access. Keep manual capture usable in the meantime. Add feedback-based personalization after mixed-source ingestion is reliable, without talking-point generation.

## Acceptance for implementation
- Real running UI from import → card image/source attribution → quick note → day plan → reload. Prove original URL/full headline/private note preservation through backend readback.
- Provider fixtures exercise missing/broken/expired image, portrait/landscape, no metadata, provider403/429, malformed data and a duplicate link; topics remain usable.
- Upload checks verify image thumbnail, text/PDF source retention, invalid/oversized input, storage rollback, reload and byte readback.
- Local/private-host and redirect rejection for metadata/image fetchers; no API credentials in UI/artifacts.
- New note/source metadata cannot mutate active live timer, overlay, or prepared-show snapshot. Test existing revision409 conflicts and explicit activation.
- Every eventual live-source smoke evaluation is labeled separately from fixture proofs; Reddit stays gated. This planning pass made no provider calls, paid model calls, DB changes or production implementation changes.

## Primary references checked September25,2026
- YouTube video metadata: https://developers.google.com/youtube/v3/docs/videos
- TikTok oEmbed fields: https://developers.tiktok.com/docs/en/embed-videos
- Publisher page image/description fields: https://ogp.me/
- Feed thumbnail metadata: https://www.rssboard.org/media-rss
- Reddit access requirements: https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy
