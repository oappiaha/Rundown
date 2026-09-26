# Discover: first real slice (September 25, 2026)

Implements sequence step 1 of `2026-09-25-selected-ui-and-media-imports.md`: real
imported YouTube/RSS topics rendered as visual cards in a new Discover surface,
with a persistent bookmark and a separate personal note. Day planner, uploads,
TikTok/Reddit enrichment, article page fetching and talking points stay out.

## Backend contracts (all additive)

- `rss.Entry` gains optional defaulted fields after the existing six positional
  ones: `creator`, `thumbnail_url`, `thumbnail_width`, `thumbnail_height`,
  `media_seconds`, `excerpt`. Existing positional callers are unchanged.
- `rundown/presentation.py` validates image metadata without any network:
  http(s) only, no credentials/whitespace/control characters, no private,
  loopback, link-local or multicast IP literals, no `localhost`; a configured
  loopback fixture origin (`RSS_TEST_FEED_ORIGIN` / `RETRIEVAL_TEST_ORIGIN`) is
  the only exception. Dimensions must be plain integers 1–10000. Invalid
  metadata drops only the image, never the topic.
- YouTube collector keeps `part=snippet` (no contentDetails call) and now
  retains `snippet.channelTitle` and the largest valid `snippet.thumbnails`
  entry. RSS parser reads `media:thumbnail`, `media:content` (image) and image
  enclosures, plus entry author or feed title as creator. No article fetch.
- New table `topicpresentation` keyed by `inboxtopic.id`: provider, creator,
  excerpt, thumbnail url/width/height, media_seconds, state
  (`ready`/`partial`), reason, fetched_at. Written on first import only; a
  duplicate import backfills a missing row and never overwrites one.
- New table `topiceditorial` keyed by `inboxtopic.id`: `revision` (starts at 0),
  `saved`, `note`, `updated_at`. Its revision namespace is independent from
  `InboxTopic.revision`; source rows, generated notes and the topic row are
  never touched by editorial writes.
- Inbox list/get/put/archive responses add `presentation` (object or null) and
  `editorial` (`{revision, saved, note, updated_at}`; defaults for rows without
  editorial state).
- `PUT|PATCH /inbox/{id}/editorial` takes the complete state
  `{revision, saved, note}` (strict int ≥ 0, strict bool, note ≤ 10000 chars,
  extra fields rejected). Locks with `BEGIN IMMEDIATE`, returns the full inbox
  item, `409` on a stale revision with the stored note untouched, `404` for an
  unknown topic. No live-clock or saved-show writes.
- Schema evolution: `create_all` adds the two tables; older databases keep
  every existing row and column. No destructive migration.

## Frontend

- New `DiscoverView` (React, existing CSS tokens, `dsc-` classes) reproduces
  the selected prototype: minimal header with Focus/Explore, source chips
  (All / YouTube / Articles / Reddit / Manual), Saved chip, Refresh and an
  Import link to Sources. Focus = one card per viewport with scroll snap and
  j/k/arrow navigation (never while typing); Explore = tile grid with a lead tile.
- Card: full original headline, lazy thumbnail (`loading="lazy"`,
  `referrerPolicy="no-referrer"`), creator/source, optional date/duration,
  source excerpt, "Read more" (retained text, plain), external original link,
  bookmark and a compact note control with explicit **Save note** and an
  unsaved/saved/error status. Missing or failed images fall back once to
  deterministic SVG artwork derived from the topic id. No remote HTML.
- Drafts are keyed by topic id and survive mode switches, filter changes,
  refresh and navigation (the view stays mounted). A `409` keeps the draft and
  offers "Use theirs" / "Keep mine and save again".
- Nav: Discover added as the first sidebar item. Default view stays **Tonight's
  Show**: every existing App-level test (and the inbox/sources/review suites
  that render `App`) queries the live view by role, and role queries exclude
  hidden subtrees, so a Discover default would have required rewriting their
  initial-state assumptions. Preserving the default is the non-reckless choice.

## Done checklist

1. Real API import from both fixture providers → presentation readback → real
   browser shows Discover with full title and a served thumbnail.
2. Bookmark + personal note persist across reload; source text and legacy
   imported notes unchanged; arrow keys inside the note do not move cards.
3. Missing and 404 thumbnails fall back to artwork without a broken image or
   layout break; 390×844 has no horizontal overflow.
4. Stale editorial write → 409 with draft kept; duplicate import leaves the
   bookmark and note intact.
5. Live current topic/time untouched by import and editorial writes.
6. Old-schema database upgraded additively with all rows intact.

Checks: `ruff`, `pyright`, `pytest`; `npm run lint|typecheck|test|build`.
Evidence: `/private/tmp/rundown-discover-implementation/REPORT.md`.
