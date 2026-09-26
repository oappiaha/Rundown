# Shipping — RUNDOWN

## Environment hazards

- This is a local-first, single-user application. Do not touch OBS, launchd, Tailscale, logged-in browser profiles, or external collectors during local verification.
- `.env` contains secrets and is never committed or copied into evidence.
- `data/rundown.db` is live local state. Tests must point `settings.db_path` at a temporary SQLite database.
- Production runs on rei’s Mac mini; OBS runs separately on the MacBook. Deployment was explicitly authorized September 26, 2026.

## Port registry

- Production API: `100.93.40.70:8088` (Tailscale interface only). Port 8000 belongs to another application.
- Development API default: `8000`; override to avoid the other application.
- Vite development server default: `3000`.
- OBS WebSocket default: `4455`; never bind or replace this during verification.
- For isolated verification, choose unused loopback ports in `8100–8199` for API and `3100–3199` for web.

## Verification recipes

- API: from `apps/api`, use `uv run uvicorn rundown.main:app --host 127.0.0.1 --port <port>` with a temporary database configured through the process environment.
- Web: from `apps/web`, use `npm run dev -- --host 127.0.0.1 --port <port>` and proxy to the isolated API.
- UI behavior: drive the Vite app with a real browser; create, edit, reorder, remove, and push a topic, then read it back from the API.
- OBS absence is the standard local test condition. Push with `refresh_obs: false` unless OBS integration is explicitly being tested.

## Test & build commands

- API (`apps/api`): `uv run ruff check .`, `uv run pyright`, `uv run pytest -q`.
- Web (`apps/web`): `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.

## Git & migration conventions

- Preserve uncommitted user work. Inspect `git status` before edits.
- SQLite schema is currently created by SQLModel; add a migration mechanism before any destructive schema evolution.
- Commits, pushes, and production changes are centralized and only performed when explicitly authorized.

## Deploy runbook — verified September 26, 2026

- Host: rei’s Mac mini, local user `rei`, Tailscale `reis-mac-mini.taildb04a2.ts.net` / `100.93.40.70`. The old `beezy@wolf-4` examples are historical and incorrect for this installation.
- UI: http://reis-mac-mini.taildb04a2.ts.net:8088/
- MacBook OBS Browser Source URL: http://reis-mac-mini.taildb04a2.ts.net:8088/static/overlay.html
- Both devices must be signed into the intended Tailscale network with ACL access. HTTP here travels through the encrypted Tailscale network; no public listener, TLS termination, or Funnel. Tailscale Serve is not enabled and was not changed. Never bind this unauthenticated app to all interfaces.
- App release: `/Users/rei/services/rundown/releases/44dd08ac6221c3303a85ca996961e186dff03b06`; `current` symlink selects it. Source was exported from Git and compiled `apps/web/dist` copied into it. No dev server or hot reload.
- Python: `/Users/rei/2026/Rundown/apps/api/.venv/bin/python -m uvicorn rundown.main:app --host 100.93.40.70 --port 8088`, working directory `current/apps/api`. The venv is shared with the checkout: do not upgrade it without release verification. Release `.env` is a symlink to the original secret file; never commit/copy its contents into artifacts.
- Explicit data paths stay under `/Users/rei/2026/Rundown/data`: `rundown.db`, `assets`, `raw`. Logs: `/Users/rei/services/rundown/logs`.
- LaunchAgent: `~/Library/LaunchAgents/com.rei.rundown.plist`, RunAtLoad + KeepAlive, 10-second restart throttle. `launchctl print gui/$(id -u)/com.rei.rundown`; restart with `launchctl kickstart -k gui/$(id -u)/com.rei.rundown`.
- This is a user LaunchAgent: starts at login, not before login, and stops on logout. Keep the mini powered, networked and signed in. Sleep is already 0 on AC; display sleep is fine. Automatic restart after power failure was off and was not changed. Unattended recovery after power failure/reboot is not yet verified.
- RSS scheduler retains its enabled configuration; zero enabled feed schedules at deployment. AI analysis/preparation stay disabled in the service environment. No source import/model calls were made for deployment.
- Before any update: clean reviewed Git release, build/test, snapshot DB with SQLite backup, copy uploads, export new immutable release and built frontend, switch current, restart service, verify actual private URL. Keep previous release for rollback. Do not test mutations against production.
- Smoke: `/health`, `/`, `/static/overlay.html`, `/rundown/topics`, `/inbox`, `/plans`. Real browser: Discover → Explore → Days → New draft/Escape, mobile overflow, overlay polling. Repeat from MacBook before streaming; actual OBS setup and WebSocket refresh remain unverified.

### Backups and rollback

- Pre-deploy backup and daily snapshots: `/Users/rei/services/rundown/backups` (private directory). Database backup verified by `PRAGMA integrity_check`; uploads copied alongside. No secrets included.
- `ops/backup.py` is installed at `/Users/rei/services/rundown/bin/backup.py`. LaunchAgent `com.rei.rundown-backup` runs at 04:15 local time when the user session is available. Seven daily snapshots retained; pre-deploy snapshot retained separately. Manual: `/usr/bin/python3 /Users/rei/services/rundown/bin/backup.py`.
- Backups are local to the same disk, not off-machine disaster recovery. Full restore rehearsal remains pending.
- Rollback: stop the service using `launchctl bootout gui/$(id -u)/com.rei.rundown`; repoint `current` to a previously verified release and bootstrap its plist. Previous production release 43e20fd is retained for rollback.
- Data restore (destructive; explicit authorization required): stop service, preserve current data separately, verify the chosen backup with SQLite integrity_check, restore DB plus matching assets, remove stale DB WAL/SHM only while stopped, restart, and verify. Do not restore an older DB casually: it discards post-backup changes.

## Post-deploy log

- Record shipped slices and verification evidence in `PROGRESS.md` (create it on the first authorized deployment round).

## Isolated checkout provisioning

For this local build round, link read-only dependency installations from the
primary checkout: `apps/web/node_modules` and `apps/api/.venv`. Never link
`dist`, test output, runtime data, or `.env`. Use `.venv/bin/python -m pytest`
and `python -m pyright --pythonpath <checkout>/apps/api/.venv/bin/python`
(the copied environment entrypoint shebangs reference an old repository path).
Root applies the preserved tracked working diff and copies docs/UI references
to each worker before dispatch. Workers never install into linked dependencies.
