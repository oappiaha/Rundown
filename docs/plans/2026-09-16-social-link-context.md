# Public X and TikTok link context
Keep the no-paid-data constraint. Fetch public post/caption text through official oEmbed endpoints on explicit request. Review and append to an existing idea draft, then use Save idea. This is not keyword discovery, transcript retrieval, media analysis, or immutable importer provenance. Existing AI preparation/research can consume saved context.

POST /social-links/preview {url:string} supports full HTTPS X/Twitter /user/status/id and TikTok /@user/video/id URLs only, stripping tracking. Fixed provider hosts, no redirects/credentials, bounded responses, text-only output. Returns platform x|tiktok, source_url, title<=1000, text<=6000, author<=200, context<=7500, limitations, truncated, mode live|fixture. 422 unsupported link, 502 provider unavailable/malformed, 429 concurrent/too frequent. No database writes. Short in-process cache and throttle.

UI explicit fetch/review/append; preserve existing title/context, discard stale answers and require matching source at apply. Existing manual saving and unsaved-draft guards remain. Sony styling, desktop/mobile. Root backend then serialized Claude frontend; disposable fixture API/browser verification and full suites. No live collectors, paid services, commits or deployment.

References: https://docs.x.com/x-for-websites/oembed-api and https://developers.tiktok.com/docs/en/embed-videos . Live provider availability remains unverified by fixtures. Automatic X/TikTok discovery is a separate access decision.
