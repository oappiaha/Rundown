# Streaming days and topic capture (September 25, 2026)

Implements sequence step 2 of `2026-09-25-selected-ui-and-media-imports.md` on
top of the Discover slice: from Discover, organize topics into independent dated
streaming days, create Write/Link topics, upload image/TXT/MD/PDF topics, and
open a day in the existing saved-show editor for explicit activation. No
talking-point generation, AI, image generation or web metadata fetching.

## Decisions

- **A streaming day is a `SavedShow`.** Its timed topic snapshots reuse
  `SavedShow.topics_json` unchanged (`id`, `text` ≤ 30, `duration` 15–3600,
  `notes` ≤ 10000, ≤ 20 topics). Additive sidecar `showplan` keyed by
  `savedshow.id` holds `stream_date` (ISO `YYYY-MM-DD`). Old shows have no row
  and read as `stream_date: null`; `POST /plans` requires a date and a
  `PUT /plans/{id}` cannot clear one.
- **Topic origin and full headline** live in additive `showtopicorigin`, keyed
  by the snapshot topic id (`uuid4`, unique across shows): `show_id`,
  `inbox_topic_id`, `display_title` (full headline at add time, ≤ 300) and
  `label` (the live label as saved). The 30-character live label stays in the
  snapshot itself; the row is display metadata only.
  - Removal from a day (through `/plans` or legacy `/shows`) deletes the row.
  - Legacy `/shows/{id}/duplicate` copies rows to the fresh topic ids.
  - A label edit through either editor updates `label`; the origin and the
    headline still describe the same story, so the row is kept.
  - Legacy `PUT /shows/{id}` and `PUT /plans/{id}` share one update helper, so
    neither path can leave a mapping for a topic that is no longer in the show.
- **Adding a topic** is `POST /plans/{id}/topics {revision, inbox_topic_id,
  label?, duration?}`. The server snapshots, at that moment, the personal
  editorial note (falling back to the legacy context notes for imported ideas)
  plus `Source: <url>` through the existing `copy_notes` rule. Later library
  note edits never rewrite the snapshot. If the headline is longer than 30
  characters and no `label` is sent, the request is rejected (422) rather than
  truncated; the UI always shows an editable, pre-filled label field in that
  case. The same idea may be in many days; the same day rejects a second copy
  (409). `duration` defaults to the idea's duration.
- **Capture** (`POST /inbox/capture`, kinds `write` and `link`) creates an
  `InboxTopic` (`text` = live label, `duration` default 120, `notes` = "") plus
  additive `topiccapture` (`kind`, `display_title` ≤ 200, `source_text`) and a
  bookmarked `topiceditorial` row carrying the personal note, in one
  transaction. A link is validated exactly like manual Inbox capture (no fetch).
- **Uploads** are `POST /attachments?title=&label=&filename=&duration=` with the
  raw file as the request body (no multipart: `python-multipart` is not in the
  shared virtualenv and it is not mutated). The body is streamed with a 1 MiB
  cap (413 beyond). Type is decided from bytes, never from the extension:
  PNG (`\x89PNG…` + IHDR), JPEG (`FF D8 FF` + SOF frame), PDF (`%PDF-` and a
  trailing `%%EOF`), or UTF-8 text without NUL (≤ 50000 characters) whose
  filename ends in `.txt`/`.md`/`.markdown`. SVG/HTML are never accepted; the
  declared content type must agree with the sniffed one when given. Image
  dimensions are read from the header and bounded to 1–10000 per side and
  25 M pixels total. **Pillow is not installed in the shared virtualenv**, so
  the server never decodes pixels; it only checks signatures and header
  dimensions. That is a header check, not a bespoke decoder, and the browser
  is the only decoder. Adding Pillow for a full decode is a separate dependency
  decision for the parent.
  - The file is written to `settings.assets_dir` under an opaque id and a
    server-chosen extension; the `attachment` row (id, topic, role
    `cover`/`document`, sanitized display filename, media type, size, sha256,
    width/height) and the topic/capture/editorial rows commit together. Any
    failure unlinks the file; a rejected upload leaves no rows and no files.
  - Client filenames are display only: control characters and path separators
    are stripped, `..` segments collapse, length ≤ 120. No client path is used.
  - `GET /attachments/{id}` serves by opaque id with the stored media type,
    `X-Content-Type-Options: nosniff`, `Cache-Control: private`,
    `Content-Security-Policy: sandbox`, `inline` for images (so cards can show
    them) and `attachment` for PDF/text, with `?download=1` forcing attachment.
    Bytes are served unchanged (byte-readback test).
  - The personal note for an upload is saved right after creation through the
    existing editorial endpoint; if that second call fails the topic exists and
    the sheet hands the note to the card's draft so nothing typed is lost.
- **Inbox responses** gain `capture` (object or null) with `kind`,
  `display_title`, `source_text` and `attachments[]`; everything else is
  unchanged. `/shows` summaries and details gain `stream_date`.
- **Schema**: `create_all` adds four tables (`showplan`, `showtopicorigin`,
  `topiccapture`, `attachment`); no existing column changes. `assets_dir` is a
  new setting (default `data/assets`), isolated in `tests/conftest.py`.
- **Frontend**: Discover gets `New` and `Days` header tools and a `+ Day` card
  action; both open right-side drawers (bottom sheets at phone width) with
  focus trap, Escape and scrim close, and focus return. The days drawer lists
  dated plans first, creates a plan (date required), shows the selected day's
  order with reorder/duration/remove (each action is one revision-guarded PUT;
  a 409 keeps the local order and offers "Use theirs" / "Keep mine and save
  again"), adds the pending card with a visible live-label field when the
  headline exceeds 30 characters, and opens the day in Saved Shows through
  App's existing `openSavedShow`. Activation stays in Saved Shows.
- The capture sheet has Write / Link / Upload, a title, a note, a link or a
  file, an "Add to <day>" checkbox when a day is selected, and a live-label
  field that appears only when the title exceeds 30 characters. Client-side
  file checks are limited to size and accept-list; the server is the authority.

## Done checklist

1. Real browser: create two named dated plans, add the same existing topic to
   both, reorder/change time/remove in one; API and reload prove independence
   and the full-title vs short-label distinction.
2. Write and Link capture render real Discover cards with note and source
   preserved; add to the selected plan and open the actual saved-show editor.
3. Browser uploads PNG, JPEG, TXT, MD and PDF; reload shows the card and the
   download returns identical bytes; oversized/malformed/unsupported uploads
   leave no rows or files; traversal filenames are treated as display only.
4. Snapshot note unchanged after a library note edit; live clock/revision
   unchanged across all preparation work; stale plan edit 409 without draft
   loss; legacy /shows remain interoperable.
5. Desktop and 390 px browser focus/explore/drawer interactions with no
   horizontal overflow and no unexpected console/network errors.
6. Additive schema with old rows/columns unchanged; ruff, pyright, pytest,
   lint, typecheck, vitest and build pass with new regression tests.

Evidence: `/private/tmp/rundown-days-implementation/REPORT.md`.
