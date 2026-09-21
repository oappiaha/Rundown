# Topic inbox — September 15, 2026

## Outcome
Capture an idea with manually editable context and an optional source URL, then
copy it into a saved-show draft or the live rundown draft. Copies are independent;
existing Save show / Publish actions commit them. Live insertion supports next or
end without replacing the current segment. Archive/restore keeps used ideas out
of the active inbox without deleting them or affecting copies.

## Fixed API

- `GET /inbox?archived=false` -> `{items: InboxItem[]}`; default active only,
  `archived=true` archived only, newest updated first then stable ID order.
- `GET /inbox/{id}` -> InboxItem.
- `POST /inbox` ->201; `{text,duration,notes?,source_url?}`.
- `PUT /inbox/{id}` ->200; `{revision,text,duration,notes,source_url}` full edit.
- `POST /inbox/{id}/archive` ->200; `{revision,archived:boolean}`; same-state
  operation is unchanged after revision check.

InboxItem: `id`, `revision`, `text`, `duration`, `notes`, `source_url`, `archived`,
ISO `created_at`/`updated_at`, and copy-ready `topic:{text,duration,notes}`.
Title trimmed1–30 Unicode characters; duration integer15–3600; context verbatim;
source optional trimmed HTTP(S) URL<=2048 characters, no credentials/whitespace.
The server retains but never fetches URLs. Copy-ready notes append a
`Source: <url>` line separated by two newlines when context exists. Combined
context+attribution must fit10,000 Unicode characters. No silent truncation.
Unknown IDs404; invalid payload422; stale revision or editing archived item409.
Restore before editing an archived item. Archive and edit are serialized under
SQLite BEGIN IMMEDIATE; failed operations do not mutate data.

## Implementation / ownership
Root Codex: backend `InboxTopic` additive table, routes, API tests and docs.
Claude Code: frontend, existing visual language, isolated retained frontend
worktree; primary source baseline and read-mostly dependency links provisioned.
No destructive schema migration. Existing source/asset research pipeline models
remain separate until an actual collector is implemented.

Inbox operations never initialize/advance/write the live clock. Transfers use
existing revision-guarded saved/live APIs and preserve context in history. The
picker re-reads the idea before copying; stale list entries archived elsewhere
are rejected. UI navigation preserves drafts; explicit discard/merge handles
conflicting edits. Delayed copy responses must not land in another target.

## Scope boundary
Manual capture and source attribution only. RSS/collectors, automatic fetching,
AI summaries, calendar scheduling, historical-version UI, deletion, deployment,
commits and pushes are outside this slice.

## Verification
Temporary API8155(root),8156(worker), web3155; disposable SQLite DBs under
`/private/tmp/dienda/rundown-inbox`, no live state/OBS/external requests.
Backend51tests, Ruff/Pyright clean. Actual HTTP lifecycle, URL/context validation,
parallel edit/archive200+409, exact SQLiteclock preservation, independent copies,
and real process restart persistence passed. Primary frontend68tests, lint/types/build pass. Independent production-build
Chromium tests pass on desktop1440px and fresh390px touch viewport, including
copy-to-saved/live, explicit Save/Publish, context attribution, conflict merge,
archive/restore, zero horizontal overflow and source URL rejection. Reproduced
then fixed saved picker navigation-away/back response race; separate real-browser
checks pass for live discard, segment changes, full20topics and archived stale-list
items. Claude independent runtime evidence reviewed:21/21 desktop/mobile steps pass,
with expected409 and cancelled-poll requests only. Final primary source hashes
match the worker candidate. Total119tests pass (51API+68web). All test servers
stopped and ports8155/8156/3155 released; disposable databases removed after
readback/evidence capture. Retained pre-existing worktree and source archive.
No deployment performed.
Evidence and worker contract: `/private/tmp/dienda/rundown-inbox/`.
