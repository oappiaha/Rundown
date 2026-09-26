# Pasted link previews: articles and TikTok (September 26, 2026)

Implements sequence step 3 of `2026-09-25-selected-ui-and-media-imports.md`
for the Link tab of Discover capture: an explicit, read-only server-side
preview of a pasted article page (Open Graph / standard `<head>` metadata) or
a full TikTok video permalink (official oEmbed), reviewed by the user and saved
with the topic as source and card metadata. The warm cream/sand palette and the
existing capture layout are unchanged. On-demand players, Reddit, automatic
fetching on page load, AI, and image fetching by the backend stay out.

## Decisions

- **Nothing is fetched until the user presses Preview.** The Link tab keeps
  its manual path exactly as today; a preview can fail (403/429/404/timeout/
  non-HTML/oversize/private redirect/malformed provider data) and the topic is
  still saved manually from the same form.
- **One bounded fetch helper.** `rss.fetch_feed` is factored into
  `rss.fetch_public(url, *, accept, max_bytes, seconds, label, truncate=False)`.
  Every hop is canonicalized, resolved and checked (public address only, or the
  single configured loopback fixture origin), the socket is pinned to the
  checked address, `Content-Encoding` must be identity, and the body is capped.
  Feed callers keep the same messages and limits (2 MB, 20 s, error on
  overflow). Article pages use `Accept: text/html`, 256 KiB, 10 s and
  `truncate=True`: metadata lives in `<head>`, so an oversize page is cut, not
  rejected. The response `Content-Type` must be `text/html` or
  `application/xhtml+xml`; anything else is rejected before parsing.
- **Article extraction** parses only the `<head>` (parsing stops at `</head>`
  or the first `<body>`), ignores script/style content and never renders or
  executes anything. Fields: title (`og:title` → `twitter:title` → `<title>`),
  description (`og:description` → `meta[name=description]` →
  `twitter:description`), site name (`og:site_name` → hostname), creator
  (`meta[name=author]` → `article:author` when it is not a URL → site name),
  published (`article:published_time`), image. Per ogp.me the **first**
  `og:image` root is preferred and `og:image:width`/`height`/`secure_url`/`url`
  attach to the root that precedes them, so a second image's dimensions are
  never paired with the first. Fallback image: `twitter:image`. Image
  addresses are resolved against the final page URL and validated with
  `presentation.safe_image_url` / `dimension` (public http(s) only); an
  invalid image drops only the image.
- **TikTok** reuses `social_links.permalink` for the permalink shape and
  `collectors.request_json` for the official oEmbed call (fixture origin when
  configured). `title` is the caption, `author_name` the creator, and
  `thumbnail_url`/`thumbnail_width`/`thumbnail_height` are validated the same
  way, keeping the portrait dimensions the provider returned. X links are not
  part of this slice (no thumbnail in X oEmbed); they are reported as
  unsupported for preview and remain saveable as plain links.
- **Accepted preview travels as a signed token, not a table.** The preview
  response carries `token`: base64url JSON of the extracted metadata plus the
  entered URL and issue time, signed with an HMAC key generated once per API
  process (`secrets.token_bytes(32)`; never persisted, never in `.env`). It is
  valid for 30 minutes and bounded at 96 KiB, which covers the largest
  metadata the preview can emit (6000-character caption, 1000-character
  title, three URLs, all in 4-byte UTF-8). On save the server verifies
  signature (byte comparison, so a malformed suffix is a 409, never a 500) and expiry and
  requires the token's entered URL to equal the request's `source_url`; a
  mismatch or expiry is a clear 409 and the client can save the same form
  without the preview. The client never supplies provider fields directly.
- **Persistence is additive.** `POST /inbox/capture` accepts an optional
  `preview` token for `kind: "link"`. With a valid token the existing
  transaction also writes:
  - `topiclinksource` (new table keyed by `inboxtopic.id`): `kind`
    (`article`/`tiktok`), `entered_url` (exactly what the user pasted; the
    topic's `source_url`), `resolved_url` (after redirects), `original_title`
    (full fetched headline, ≤ 1000, never truncated to fit the 200-character
    title), `body_text` (description/caption, ≤ 6000), `feed_name`
    (site name / "TikTok"), `creator`, `published_at`, `imported_at`,
    `truncated`. It is exposed as the item's `source` with kind
    `article`/`tiktok`, so review, analysis and preparation read the fetched
    headline/description exactly like RSS/YouTube provenance.
  - `topicpresentation` (existing table): provider = kind, creator, excerpt =
    description, thumbnail url/width/height, `state` ready/partial.
  The user's `title` remains `topiccapture.display_title`; the live label rule
  is unchanged (a title over 30 characters needs an explicit label, 422
  otherwise). `note` and `source_url` are stored exactly as typed. Saved-show
  snapshots, live state and other topics are never written.
- **Frontend (Link tab only).** A compact **Preview** button next to the link
  field. States: idle → loading (button disabled, "Fetching preview…") →
  review card (thumbnail if any, fetched headline, publisher/creator, short
  description, "Preview · <mode>") with a **Remove preview** action → or a
  short failure line ("Preview failed: … Save the link without it.") that
  leaves the form saveable. The title field is prefilled only when it is empty
  or still equals the previous preview's suggestion; a title the user typed is
  never overwritten. A fetched headline longer than 200 characters prefills a
  word-bounded 200-character editable title while the full headline stays in
  the token (and then in `topiclinksource`). The note is never touched. Editing
  the link after a preview drops the preview (hint: "Link changed · preview
  removed"); a preview response for a URL that is no longer in the field is
  ignored. The submit button reads "Create with preview" while a preview is
  attached, and the token is sent only then. A 409 on the token clears the
  preview, shows the server message, and the same form can be resubmitted
  without it.
- **Rate limiting** mirrors social links: one preview at a time (429), two
  seconds between provider requests (429), 60-second in-process cache keyed by
  fixture mode and URL.

## API contract

`POST /link-previews/preview` — body `{ "url": string }` (1–2048 chars, http(s),
no credentials/whitespace). Responses:

- `200` `{ kind: "article" | "tiktok", source_url, resolved_url, title,
  description, site_name, creator, published_at: string | null,
  thumbnail: { url, width: int|null, height: int|null } | null,
  truncated: bool, token: string, expires_at: ISO string, mode: "live" | "fixture" }`
- `422` invalid URL, X link, unsupported scheme.
- `502` provider/page failure with a safe `detail` (HTTP 403/429/404/5xx,
  private or unresolvable address, redirect loop, not an HTML page, no
  usable metadata, malformed oEmbed).
- `429` a preview is already running or one ran less than two seconds ago.

`POST /inbox/capture` — unchanged, plus optional `preview: string` (only with
`kind: "link"`; 422 otherwise). `409` when the token is invalid, expired or
issued for a different URL; the body is not saved in that case.

Inbox item `source` gains kinds `article` and `tiktok` with the fields above
(`feed_id` is `""`, `feed_name` is the site name / "TikTok"; extra
`resolved_url`, `entered_url`, `creator`). `presentation.provider` is
`article` or `tiktok` for these topics.

## Done checklist

1. Real browser: paste a fixture article link, Preview → review card with the
   original headline, publisher and served thumbnail → Create with preview →
   Discover card shows the same headline/publisher/thumbnail; API and reload
   read back `source.kind = article`, `original_title`, `presentation.thumbnail`.
2. Real browser: fixture TikTok permalink Preview → caption/creator/portrait
   thumbnail → save → persisted `source.kind = tiktok`, portrait dimensions.
3. Fixture 403, 429, 404, non-HTML, malformed HTML, an oversize page whose
   metadata lies beyond the 256 KiB cap, private redirect and loopback-port
   redirect all fail the preview with a clear message; an oversize page whose
   `<head>` fits is truncated and still previews; the same form creates the
   topic manually after any failure.
4. Stale response (URL edited during the fetch) is ignored; a typed title and
   note are never overwritten; editing the link drops the preview; no topic is
   created until Create.
5. Original entered URL, personal note and title are stored as typed; an
   existing saved show's snapshot and the live clock are unchanged by preview
   and save; an expired/mismatched token is refused (409) and manual save
   still works.
6. `ruff`, `pyright`, `pytest`, `npm run lint|typecheck|test|build` pass with
   new tests; an old-schema database opens with the new table added and every
   existing row intact.

Evidence: `/private/tmp/rundown-link-preview/REPORT.md`.
