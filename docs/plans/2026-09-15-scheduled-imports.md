# Scheduled RSS imports — completed locally

September 15, 2026. Claude Code implemented the UI in the retained isolated
checkout; root Codex implemented the backend, integrated it and fixed refresh
ordering and pause/resume display issues found during independent acceptance.

## Delivered

Saved Sources feeds now have an opt-in schedule: interval from 15 minutes to
7 days, next automatic import in the browser timezone, last automatic result
and shared history. Save is explicit and never fetches immediately. Schedule
edits remain separate from feed edits and survive view/feed changes.

A new additive FeedSchedule table stores configuration, revision, next time and
last automatic run. The API scans due work every five seconds. Claiming an import
and advancing the next time happen in one SQLite transaction, using the same
feed lock as manual imports. Two API processes cannot claim the same due work.
A missed deadline causes one catch-up after restart, followed by a future time.
Failures wait for the regular interval. Manual imports do not move the schedule.

Disabling the schedule cancels its next time. Disabling the feed pauses an enabled
schedule; reenabling starts a fresh interval. A global API switch can pause all
automatic imports. No keys or AI calls are involved; the API must remain running
and the machine awake. No OS service was installed.

## Acceptance

- Ruff, Pyright and 90 API tests pass (84 existing plus 6 scheduler cases).
- Web lint, typecheck, build and 116 tests pass (102 existing plus 14 added).
- Actual local HTTP scheduler: save without fetch, timed import 2 new/1 duplicate/
  2 skipped, repeat 0/3/2 preserving edited context, malformed-feed failure with
  no rapid retry, pause/resume, manual timer independence, exact live clock row
  unchanged.
- Actual process restart with two APIs sharing a disposable DB: one catch-up,
  persisted schedule configuration and edited topic, no duplicate/burst.
- Root drove compiled desktop and fresh 390px touch UI: opt-in, validation,
  background result/history/Inbox refresh, timezone, dirty drafts through refresh/
  navigation/new selection, stale merge, feed pause/resume, repeat deduplication,
  phone disable and reload persistence, no horizontal overflow.
- Held HTTP responses in Chromium verified a pre-save poll cannot overwrite a
  newer save, and conflict recovery held beyond the polling interval completes
  without leaving controls locked. A separate phone flow proved failed automatic
  imports remain visible in history after scheduling is turned off.
- Root found and reproduced the re-enabled feed still showing paused; an effect
  now reloads schedule status on feed enablement/parent operation completion and
  explicit Sources refresh. Reads skip pending mutations; saves invalidate older
  reads. First observation of a completed automatic run refreshes the Inbox.

## Evidence

Round directory: /private/tmp/dienda/rundown-schedules.
Backend report and JSON: backend-evidence.md, evidence/backend.json,
evidence/restart.json. Root UI scripts and results: evidence/root-ui/verify.py,
result.json, verify-race.py, race-result.json, verify-failure.py,
failure-result.json, verify-overlap.py and overlap-result.json. The overlap
check confirms active imports refuse schedule changes, disable manual import
when known to be running, and retain the draft for saving after completion.
Browser deadlines were advanced only in disposable SQLite
fixtures to observe the actual API loop without waiting 15 minutes. No manual
import POST substituted for the timed import.

Worker startup watchdog repeatedly reported failure despite saved implementation
activity. Work was harvested from checkpoints; root independently verified the
integrated candidate. Final worker status/cleanup is recorded in state.md.
Retained scripts/reports/screenshots permit review; real source documents and
live data were not used for fixtures.

## Release and next step

Built locally, not deployed or committed. OBS, launchd, keys and live data remain
untouched. Owned test processes/data are cleaned up after readback; the previously
retained dirty worker checkout remains. No new worktree/branch was created.

Next: a complete show-preparation rehearsal using capture/import, editable
context, saved-show activation and playback. Live AI model enablement is separate;
notify the user before credentials or paid application calls are needed.
