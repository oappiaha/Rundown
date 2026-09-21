# Shipping — RUNDOWN

## Environment hazards

- This is a local-first, single-user application. Do not touch OBS, launchd, Tailscale, logged-in browser profiles, or external collectors during local verification.
- `.env` contains secrets and is never committed or copied into evidence.
- `data/rundown.db` is live local state. Tests must point `settings.db_path` at a temporary SQLite database.
- The served application is intended for Wolf-4, but deployment and launchd installation require explicit user authorization.

## Port registry

- API default: `8000`.
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

## Deploy runbook

- Target: Wolf-4 Mac mini, outside `~/Documents`, per TDD v2.1.
- Build `apps/web`, run the FastAPI service with its repo environment, then smoke-check `/health`, `/`, `/static/overlay.html`, and `/rundown/topics`.
- Install or reload launchd agents only with explicit authorization. Never print secret values.
- Confirm OBS is configured for URL mode at `http://localhost:8000/static/overlay.html` before a live stream.

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
