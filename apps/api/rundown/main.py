from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from rundown.config import settings
from rundown.db import init_db
from rundown.obs_bridge import router as obs_router


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    settings.raw_cache_dir.mkdir(parents=True, exist_ok=True)
    settings.logs_dir.mkdir(parents=True, exist_ok=True)
    init_db()
    yield


app = FastAPI(title="RUNDOWN", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.include_router(obs_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
