# Visual control room and live topic insertion

## Design direction

Use `ui/rundown-mockups.html` as the visual authority for the control room:
light backgrounds, system typography, rounded white cards, blue selection,
and one silver Walkman instrument with a dark blue LCD. Desktop places the
deck in the sidebar; mobile puts it above the upcoming queue. Device frames,
fake status bars, sample scores, and unverified OBS connection indicators are
presentation scaffolding and must not become fabricated product state.

Keep topic creation prominent on both layouts. Support adding at the end or
immediately after the current segment, editing, reordering, and removal.

## Worker split

- Backend (this agent): `apps/api/**` and `apps/overlay/rundown-obs-final.html`. Persistent
  playback state, validated transport actions, atomic schedule updates, and
  overlay integration.
- Claude Code: `apps/web/**`. Responsive design, accessible topic editing, quick
  insertion and transport controls using the shared contract below. User selected Claude Code for frontend implementation.
- Root: contract, isolation provisioning, integration, independent runtime
  acceptance, screenshots, and documentation. Preserve the existing dirty
  checkout. Do not commit, push, deploy, or refresh live OBS in this round.

## Shared contract — frozen for implementation

Keep existing `/rundown/topics` and `/rundown/push-to-obs` clients compatible.
Use a dedicated server-owned show state for the new UI and overlay:

`GET /rundown/state` returns:

```json
{
  "revision": 1,
  "topics": [{"id": "stable-topic-id", "text": "Opening", "duration": 120}],
  "current_topic_id": "stable-topic-id",
  "remaining_seconds": 120,
  "paused": true,
  "server_time": "ISO-8601 timestamp"
}
```

`PUT /rundown/schedule` accepts `{revision, topics}` and returns the updated
state. IDs persist across edits and reorders; new entries receive IDs from
the server. Reject stale revisions with 409 and malformed input with 422.
Updating upcoming segments preserves current identity, elapsed time, and
pause state. Reject removal of the current segment with 409 until another
segment is selected explicitly. Clamp remaining time when its duration is
shortened. Schedule mutations are atomic.

`POST /rundown/control` accepts `{revision, action, topic_id?}`, where action
is `play`, `pause`, `next`, `previous`, `reset`, or `jump`. Return the same
state shape. Empty shows have a null current topic and disabled transport.
The server owns elapsed time and automatic advance; browser polling must
never itself decrement persistent state or cause duplicate advancement.

The UI polls state without overwriting unsaved edits. A 409 exposes a clear
reload/reconcile action and preserves the local draft. Inserting a new topic
must not force an OBS browser refresh.

## Verification and acceptance

1. Backend: real HTTP calls with a disposable SQLite database demonstrate
   transport, insertion, stable identity, pause preservation, persistence
   after restart, and stale-write rejection without state loss.
2. Frontend: real desktop and mobile browser interactions demonstrate add,
   insert-next, edit, reorder, removal, publish and transport. Validate focus,
   keyboard accessibility, no horizontal overflow, and draft preservation.
3. Integration: two browser pages (control room and overlay) show the same
   topic and timer; inserting during playback does not restart the segment.
4. Run repository static checks and focused tests. Capture real screenshots
   and deliver using tappable session resource links.

## Isolation and scope

Allocate separate provisioned worktrees and disposable databases before any
concurrent implementation. Record branch, base, ports, dependency provisioning,
and evidence paths in the dienda run state. Until that provisioning is verified,
serialize checkout mutations per dienda. Workers must use deez and return
runtime evidence; root independently reproduces central signals.

Collectors, AI generation, deployment, launchd, and sources/history screens
are follow-up work. Do not present their mockup controls as working features.

## Contract details

New topic IDs are omitted or null in PUT; existing IDs must be from current state.
Schedule length is 0–20, titles trimmed 1–30 characters, integer seconds 15–3600.
A fresh database starts empty and paused (revision 0). First publish selects
the first topic paused. `reset` selects first and pauses; `next`/`previous`/
`jump` preserve pause state and restart target duration; boundary next/previous
are no-ops. End of final topic pauses at zero; play at zero restarts that topic.
Revision changes on mutations and automatic segment transitions, not clock ticks.
Schedule revisions must remain tied to the draft base; polling cannot silently
update that base when draft edits exist. API conflicts use {"detail": "message"}.
Frontend polls once per second. Backend port 8141, frontend port 3141.

## Accepted result — September 14, 2026

Claude Code implemented the responsive frontend in an isolated worktree. Root
implemented the persistent API and shared overlay clock, reviewed the frontend,
requested and accepted race/conflict fixes, and integrated apps/web into this checkout.

- Desktop sidebar and mobile hero use the silver deck from the visual brief.
- Quick-add supports end/next insertion and optional immediate publishing.
- Schedule edits preserve the active topic and elapsed playback time.
- Pending saves lock mutations; delayed snapshots cannot regress newer state.
- Conflicts retain drafts and merge remote additions and untouched fields.
- API schedule saves and history are atomic; state survives process restart.
- Overlay and control room use the same server-owned transport and timer.

Independent checks: web lint, TypeScript, 21 tests, production build; API Ruff,
Pyright, 11 tests; git diff whitespace check. Claude Code also supplied 49 real
browser checks. Root served the production build through FastAPI on loopback
8142 with a disposable acceptance.db and verified desktop/mobile editing,
insert during playback without reset, stale-write recovery, remote-field merge,
and transport synchronization with the real overlay page. No page errors,
unexpected console errors, or failed requests in that acceptance run.

Runtime evidence and reproduction scripts are under
`/private/tmp/dienda/rundown-visual/` (temporary storage): `verify_integrated.py`,
`verify_backend.py`, `backend-evidence.md`, `frontend-evidence.md`, and
`evidence/integration.json`. Accepted frontend source is archived there too.
Screenshots were uploaded as tappable session resources for desktop, mobile,
and overlay review.

This is a locally built and verified control-room milestone. It has not been
committed, pushed, deployed, or tested against live OBS. Existing production
data and the unrelated service on port 8000 were left untouched. Collectors,
AI generation, and sources/history screens remain follow-up work.

Cleanup: temporary API servers stopped and Claude Code child closed. The
frontend worktree and branch remain intact under the scratch directory because
automatic review rejected force-removal of its uncommitted files.
