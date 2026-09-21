import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from rundown.analysis import router as analysis_router
from rundown.config import settings
from rundown.db import init_db
from rundown.feeds import router as feeds_router
from rundown.inbox import router as inbox_router
from rundown.library import router as library_router
from rundown.obs_bridge import router as obs_router
from rundown.preparation import router as preparation_router
from rundown.research import router as research_router
from rundown.retrieval import router as retrieval_router
from rundown.reviews import router as reviews_router
from rundown.scheduling import FeedScheduler
from rundown.scheduling import router as scheduling_router
from rundown.show import router as show_router
from rundown.show_preparation import router as show_preparation_router
from rundown.social_links import router as social_links_router


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    settings.raw_cache_dir.mkdir(parents=True, exist_ok=True)
    settings.logs_dir.mkdir(parents=True, exist_ok=True)
    init_db()
    scheduler = FeedScheduler()
    scheduler.start()
    try:
        yield
    finally:
        await asyncio.to_thread(scheduler.stop)


app = FastAPI(title="RUNDOWN", version="0.1.0", lifespan=lifespan)

app.include_router(obs_router)
app.include_router(show_router)
app.include_router(library_router)
app.include_router(inbox_router)
app.include_router(feeds_router)
app.include_router(scheduling_router)
app.include_router(preparation_router)
app.include_router(show_preparation_router)
app.include_router(reviews_router)
app.include_router(research_router)
app.include_router(analysis_router)
app.include_router(retrieval_router)
app.include_router(social_links_router)

OVERLAY_DIR = Path(__file__).resolve().parents[2] / "overlay"
WEB_DIST_DIR = Path(__file__).resolve().parents[2] / "web" / "dist"


@app.get("/static/overlay.html", include_in_schema=False)
async def overlay() -> FileResponse:
    return FileResponse(OVERLAY_DIR / "rundown-obs-final.html")


app.mount("/static", StaticFiles(directory=OVERLAY_DIR), name="static")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


# Keep this catch-all last so the API and OBS overlay routes win first. Vite's
# production assets use root-relative `/assets/...` URLs, and `html=True` also
# serves the control room at `/` without a second frontend server.
app.mount(
    "/",
    StaticFiles(directory=WEB_DIST_DIR, html=True, check_dir=False),
    name="control-room",
)
