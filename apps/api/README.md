# rundown — API

FastAPI app: research pipeline, scoring, rundown generator, OBS bridge.

## Setup

```bash
cd apps/api
uv sync
uv run playwright install chromium
cp ../../.env.example ../../.env  # then fill in keys
uv run uvicorn rundown.main:app --reload
```

API will be at <http://localhost:8000>. OpenAPI docs at `/docs`.

## Useful entry points

- `rundown.main:app` — FastAPI app
- `rundown.db:init_db()` — create SQLite tables
- `rundown.obs_bridge` — OBS WebSocket refresh + topics endpoints
