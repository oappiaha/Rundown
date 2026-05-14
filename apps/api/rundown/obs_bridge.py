"""
OBS bridge: serves the current rundown to the overlay and triggers OBS
WebSocket v5 refresh when new topics are pushed.

The overlay polls GET /rundown/topics every 5 seconds; we return the latest
Rundown's RundownItems plus an MD5 hash so the overlay only resets on change.
POST /rundown/push-to-obs writes a new Rundown row, then (best-effort) tells
OBS to refresh the browser source.
"""

import asyncio
import base64
import hashlib
import hmac
import json
from datetime import datetime

import websockets
from fastapi import APIRouter
from pydantic import BaseModel
from sqlmodel import col, select
from websockets.typing import Subprotocol

from rundown.config import settings
from rundown.db import session
from rundown.models import Rundown, RundownItem

router = APIRouter(prefix="/rundown", tags=["rundown-obs"])


class TopicIn(BaseModel):
    text: str
    duration: int


class TopicsPayload(BaseModel):
    topics: list[TopicIn]
    refresh_obs: bool = True
    notes: str | None = None


class TopicOut(BaseModel):
    text: str
    duration: int


_FALLBACK_TOPICS: list[dict] = [
    {"text": "Topic 1", "duration": 120},
    {"text": "Topic 2", "duration": 90},
]


def _load_current_topics() -> list[dict]:
    with session() as db:
        rundown = db.exec(
            select(Rundown).order_by(col(Rundown.generated_at).desc()).limit(1)
        ).first()
        if rundown is None:
            return _FALLBACK_TOPICS
        items = db.exec(
            select(RundownItem)
            .where(RundownItem.rundown_id == rundown.id)
            .order_by(col(RundownItem.position).asc())
        ).all()
        return [{"text": i.text, "duration": i.duration} for i in items] or _FALLBACK_TOPICS


@router.get("/topics")
async def get_topics() -> dict:
    topics = _load_current_topics()
    topics_hash = hashlib.md5(
        json.dumps(topics, sort_keys=True).encode()
    ).hexdigest()[:8]
    return {"topics": topics, "hash": topics_hash}


@router.post("/push-to-obs")
async def push_to_obs(payload: TopicsPayload) -> dict:
    """Persist a new rundown + (best-effort) refresh the OBS browser source."""
    with session() as db:
        rundown = Rundown(notes=payload.notes)
        db.add(rundown)
        db.commit()
        db.refresh(rundown)

        rundown_id = rundown.id
        assert rundown_id is not None  # set by refresh

        for position, topic in enumerate(payload.topics):
            db.add(
                RundownItem(
                    rundown_id=rundown_id,
                    position=position,
                    text=topic.text,
                    duration=topic.duration,
                )
            )
        db.commit()

    obs_refreshed = False
    if payload.refresh_obs:
        try:
            obs_refreshed = await asyncio.wait_for(
                _obs_refresh_browser_source(), timeout=3.0
            )
            with session() as db:
                r = db.get(Rundown, rundown_id)
                if r is not None:
                    r.pushed_at = datetime.utcnow()
                    db.add(r)
                    db.commit()
        except Exception as e:
            # OBS may not be running; that's fine — the overlay polls.
            print(f"OBS WebSocket refresh skipped: {e}")

    return {
        "ok": True,
        "rundown_id": rundown_id,
        "topics_count": len(payload.topics),
        "obs_refreshed": obs_refreshed,
    }


async def _obs_refresh_browser_source() -> bool:
    """OBS WebSocket v5 — auth then PressInputPropertiesButton refreshnocache."""
    uri = f"ws://{settings.obs_ws_host}:{settings.obs_ws_port}"

    async with websockets.connect(uri, subprotocols=[Subprotocol("obswebsocket.json")]) as ws:
        hello = json.loads(await ws.recv())
        auth_data = hello["d"].get("authentication")

        auth_string: str | None = None
        if auth_data and settings.obs_ws_pass:
            challenge = auth_data["challenge"]
            salt = auth_data["salt"]
            secret = base64.b64encode(
                hmac.new(
                    settings.obs_ws_pass.encode(),
                    (challenge + salt).encode(),
                    hashlib.sha256,
                ).digest()
            ).decode()
            auth_string = base64.b64encode(
                hmac.new(secret.encode(), challenge.encode(), hashlib.sha256).digest()
            ).decode()

        identify: dict = {"op": 1, "d": {"rpcVersion": 1, "eventSubscriptions": 0}}
        if auth_string:
            identify["d"]["authentication"] = auth_string

        await ws.send(json.dumps(identify))
        await ws.recv()  # Identified

        request = {
            "op": 6,
            "d": {
                "requestType": "PressInputPropertiesButton",
                "requestId": "rundown-refresh",
                "requestData": {
                    "inputName": settings.obs_source_name,
                    "propertyName": "refreshnocache",
                },
            },
        }
        await ws.send(json.dumps(request))
        response = json.loads(await ws.recv())

    return response.get("d", {}).get("requestStatus", {}).get("result", False)
