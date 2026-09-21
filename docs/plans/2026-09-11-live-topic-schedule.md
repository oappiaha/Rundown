# Live topic schedule — implementation plan

## Outcome

The control room lets Beezy create a topic on the fly, place it in the current schedule, edit/reorder/remove entries, and push the exact schedule to the OBS-backed rundown API.

## Current decisions

- The newest duplicated specs (`RUNDOWN_*_v2 (1).md`) are v2.1 and supersede the v2.0 copies where they conflict.
- A “schedule” in this slice is the ordered rundown shown by the overlay, not the future APScheduler research job.
- Use the existing `POST /rundown/push-to-obs` contract; no new persistence model is needed for the first useful slice.
- Topic labels are non-empty and at most 30 characters; duration is 15–3600 seconds.
- Serve the OBS overlay from FastAPI at `/static/overlay.html` and use a same-origin topic endpoint.

## Done criteria

- A user can add a valid topic and it appears immediately in the ordered schedule.
- A user can edit topic text/duration, reorder entries, and remove an entry.
- Push persists the current schedule; a subsequent API read returns it in the same order.
- Empty/oversized labels, invalid durations, and an empty schedule cannot be pushed.
- The OBS overlay loads from `/static/overlay.html` and polls the same-origin endpoint.

## Out of scope

- Research collectors, Claude scoring/generation, daily APScheduler jobs, launchd installation, Tailscale configuration, and live OBS mutation.
