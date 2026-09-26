# Core-workflow audit — September25, 2026

## Verdict
The core local workflow works: source collection → editorial review → shortlist →
timed saved show → explicit activation → live control and mid-show insertion →
rendered browser overlay. Both manual and optional AI/preparation paths were driven
through the real compiled UI in Chromium. The UI is functional but too elaborate
for the main job. No claim of exhaustive input permutations or real OBS deployment.

79 captured steps plus intro/verdict cards make a compressed GIF walkthrough, not a
continuous real-time video. All frames are actual browser screenshots except clearly
labeled audit cards. Script-selector mistakes are excluded; legitimate app error
states remain. Collection's immediate second-click429 is labeled rate-limiting,
not deduplication; a later collection demonstrates4 duplicates and0 new ideas.

## Environment and authority
Single owner of existing checkout, existing changes preserved. API8187 with
/private/tmp/rundown-full-audit/demo.db; loopback synthetic provider8188, corrected
oEmbed proxy8192, OBS v5 simulator8189, fresh Chromium profile/CDP8194. Initial
browser/backend runs used current dist and source. Only OBS bridge changed during
this audit; fresh candidate API8191 with separate obs-proof.db proved the fix,
then owned8187 API restarted to load it. No hosted/private/live database, real
collector, paid provider, real OBS instance or existing browser profile used.

## Browser coverage

| Area | Actual interactions / observed evidence |
| --- | --- |
| Discovery | Create/save YouTube and Reddit searches; explicit collect; Inbox receives retained descriptions; immediate repeat429; later4duplicates/0new. Provider responses synthetic. |
| RSS | Create/save/import feed; enable/disable source;404 failure is visible without wiping Inbox. |
| Scheduling | Save opt-in15minute schedule; advance only synthetic DB due time; execute real scheduling.tick worker; cursor advances, second tick makes no new run; refresh UI/history; restore off. Not a15minute real-time wait. |
| Inbox | Review imported metadata, notes, source URL; manual capture/edit/save; archive/read-only/restore. |
| Public links | Failed malformed fixture response displays error; corrected provider fixture gives X post and TikTok caption; explicit Add to notes then Save. No video/transcript understanding claim. |
| Single-topic prep | Expand optional panel, consent, generate via fixture, review, append to context, explicit save. |
| Research | Local category-scoped shortlist without AI; optional four-story AI input preview/consent/results; confirm replacement; name/preview/save show. Exclude, search/filter and old-analysis stale guard. |
| Saved shows | Edit duration, reorder, show notes, save; duplicate independently, copy a segment from another show, remove that addition (no-op save stays disabled); direct manual show creation; save live rundown as show. |
| Whole-show prep | Preview exact input, consent, fixture generation, untick one topic, save selected prepared notes only. |
| Activation | Confirmation states replacement and paused cue; activate then Play explicitly. |
| Live | Play, pause, next, previous, jump, reset; insert next with notes and immediate publish while playing; authoritative before/after proves current topic/clock preserved. Add Inbox idea to draft and publish explicitly. |
| Overlay | Load actual /static/overlay.html; polling shows current titles/timer/new insertion; private presenter note not rendered. This is a browser-source page, not captured OBS output. |
| Review | Open published version, pick segment, Good rating, actual seconds and note, save. Review versions represent publication snapshots, not automatically completed streams. |
| Recovery | Two-client concurrent edit produces409; Merge and publish preserves both edits; offline badge and recovery; Keep editing / Discard and open guards; invalid duration blocks add; disabled source blocks import. |
| Phone |390×844 viewport, play/insert/pause, save live as show; fresh-page check confirms no horizontal overflow or JavaScript page errors. |
| OBS | API-only authenticated refresh before/after against protocol simulator; no UI connection flow exists. |

Not exhaustively covered on camera: every validation boundary, full20-topic capacity,
every provider failure type, all ambiguous/lost-response combinations, all keyboard/
assistive-technology paths, actual installed OBS/browser-source setup and live stream
output. Existing203 backend and210 frontend tests supplement the recorded journeys;
unit tests are not substituted for recorded running-system proof.

## Real bug found and fixed
Authenticated OBS refresh failed with obs_refreshed=false and simulator auth=false.
Bridge used HMAC where OBS v5 requires SHA256(password+salt), base64, then
SHA256(base64_secret+challenge), base64. Corrected those operations and require
Identified opcode2 plus matching request response before success. Real WebSocket
regressions added for valid auth and refusing an unidentified session.
Fresh running API returned obs_refreshed=true and simulator recorded the exact
PressInputPropertiesButton/refreshnocache request. Source name RUNDOWN Overlay.
Official protocol: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md#creating-an-authentication-string

This does not turn Rundown into an OBS configurator: no UI connects OBS, configures
host/password/browser source or reports OBS status. The Connected badge means API
connectivity. Modern UI publication uses /rundown/schedule; browser overlay polls
/rundown/state. Legacy /rundown/push-to-obs publishes and best-effort refreshes;
that API is not a standalone harmless connection-test endpoint. Audit used synthetic
state so these publication effects could not reset a real show.

## Product judgment: simplify before expanding
1. Present three primary stages: Discover → Prepare show → Live. Combine or clearly
   connect Inbox and Research; keep sources/settings secondary. Research currently
   retains a mounted list until refresh/mutation; new items are not obvious on return.
2. Offer one optional preparation action in the show editor. Topic-level prep can
   stay secondary; doing both is redundant and can append duplicate preparation.
3. Hide raw scoring explanations, exact input JSON, quotas and long procedural
   paragraphs behind details. Keep state, short errors and next action visible.
4. Preserve explicit Activate/Publish boundaries and conflict handling. Those guards
   prevent real live-state mistakes and should not be removed for superficial speed.
5. Add a small OBS setup/health affordance that distinguishes API/overlay/OBS states;
   no new integration dashboard. Rehearse real OBS separately before claiming release.
6. Pause Jev/provider expansion until this main path and OBS setup are settled.

Synthetic queries prove collection plumbing and selection flow, not current external
access or genuine relevance. Prior real YouTube/AI smoke evidence is separate.
Reddit approved access is still an external prerequisite; this fixture audit does
not resolve it. Current task made no metered calls.

## Verification, artifacts and cleanup
Ruff/Pyright and203 backend tests passed after OBS fix. Web code unchanged; last
web checks in this session:210 tests, ESLint/TypeScript and production build pass.
Runtime screenshots/readbacks and original/fixed OBS evidence above. Full-resolution
GIF chapters and combined GIF retained under /private/tmp/rundown-full-audit and
uploaded through Omnigent for user access; URLs recorded in delivery-links.txt.
Scripts/caption index are preserved here for reconstruction; drive.py accepts Python
Playwright actions via stdin. This is an audit harness, not a production launcher.

All owned API/provider/browser processes stopped after capture; disposable SQLite
files removed after authoritative JSON readback. Original source snapshots and real
ranking evaluation DB untouched. No commit, push, deployment or changes to real OBS.
