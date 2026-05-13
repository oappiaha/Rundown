"""
RUNDOWN OBS Bridge
==================
Drop this into your RUNDOWN FastAPI app.

It does two things:
1. Serves /topics so the OBS overlay can poll for live topic updates
2. Exposes /push-to-obs which writes topics AND triggers OBS to auto-refresh

Usage:
  from rundown_obs_bridge import router
  app.include_router(router)

Then call POST /push-to-obs with your topics whenever RUNDOWN generates them.
"""

import json
import hashlib
import asyncio
import websockets
import base64
import hmac
import hashlib
from pathlib import Path
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

router = APIRouter(prefix="/rundown", tags=["rundown-obs"])

# ─── CONFIG ────────────────────────────────────────────────────────────────────
TOPICS_FILE    = Path(__file__).parent / "topics.json"   # where topics are stored
OBS_WS_HOST    = "localhost"
OBS_WS_PORT    = 4455                                     # default OBS WebSocket port
OBS_WS_PASS    = "your_obs_password_here"                 # set in OBS → Tools → WebSocket Settings
OBS_SOURCE_NAME = "RUNDOWN Overlay"                       # must match your source name in OBS exactly
# ───────────────────────────────────────────────────────────────────────────────


class Topic(BaseModel):
    text: str
    duration: int  # seconds


class TopicsPayload(BaseModel):
    topics: List[Topic]
    refresh_obs: Optional[bool] = True  # set False to skip OBS WebSocket call


# ── Current topics in memory (also persisted to topics.json) ──────────────────
_current_topics: List[dict] = [
    {"text": "Topic 1", "duration": 120},
    {"text": "Topic 2", "duration": 90},
]


@router.get("/topics")
async def get_topics():
    """
    The OBS overlay polls this endpoint every 5 seconds.
    Returns current topics + a hash so the overlay knows when something changed.
    """
    topics_hash = hashlib.md5(
        json.dumps(_current_topics, sort_keys=True).encode()
    ).hexdigest()[:8]

    return {
        "topics": _current_topics,
        "hash": topics_hash,
    }


@router.post("/push-to-obs")
async def push_to_obs(payload: TopicsPayload):
    """
    Call this from RUNDOWN when topics are generated.
    Stores topics + optionally tells OBS to refresh the overlay.

    Example:
      POST /rundown/push-to-obs
      {
        "topics": [
          {"text": "NBA Playoffs", "duration": 120},
          {"text": "AI in Music",  "duration": 90}
        ],
        "refresh_obs": true
      }
    """
    global _current_topics

    # 1. Update in-memory store
    _current_topics = [t.dict() for t in payload.topics]

    # 2. Persist to disk (overlay can also read this directly if served)
    TOPICS_FILE.write_text(
        json.dumps({"topics": _current_topics}, indent=2)
    )

    # 3. Tell OBS to refresh the browser source
    obs_refreshed = False
    if payload.refresh_obs:
        try:
            obs_refreshed = await _obs_refresh_browser_source()
        except Exception as e:
            # Don't fail the whole request if OBS isn't open
            print(f"OBS WebSocket: {e} (OBS might not be running)")

    return {
        "ok": True,
        "topics_count": len(_current_topics),
        "obs_refreshed": obs_refreshed,
    }


async def _obs_refresh_browser_source() -> bool:
    """
    Connects to OBS WebSocket v5 and triggers a browser source refresh.
    Uses PressInputPropertiesButton with 'refreshnocache'.
    """
    uri = f"ws://{OBS_WS_HOST}:{OBS_WS_PORT}"

    async with websockets.connect(uri, subprotocols=["obswebsocket.json"]) as ws:

        # Step 1: receive Hello
        hello = json.loads(await ws.recv())
        rpc_version = hello["d"].get("rpcVersion", 1)
        auth_data   = hello["d"].get("authentication")

        # Step 2: build auth string if password is set
        auth_string = None
        if auth_data and OBS_WS_PASS:
            challenge = auth_data["challenge"]
            salt      = auth_data["salt"]
            secret    = base64.b64encode(
                hmac.new(
                    OBS_WS_PASS.encode(),
                    (challenge + salt).encode(),
                    hashlib.sha256
                ).digest()
            ).decode()
            auth_string = base64.b64encode(
                hmac.new(
                    secret.encode(),
                    challenge.encode(),
                    hashlib.sha256
                ).digest()
            ).decode()

        # Step 3: Identify
        identify = {
            "op": 1,
            "d": {
                "rpcVersion": 1,
                "eventSubscriptions": 0,
            }
        }
        if auth_string:
            identify["d"]["authentication"] = auth_string

        await ws.send(json.dumps(identify))
        await ws.recv()  # Identified response

        # Step 4: PressInputPropertiesButton → refreshnocache
        request = {
            "op": 6,
            "d": {
                "requestType": "PressInputPropertiesButton",
                "requestId":   "rundown-refresh",
                "requestData": {
                    "inputName":    OBS_SOURCE_NAME,
                    "propertyName": "refreshnocache",
                }
            }
        }
        await ws.send(json.dumps(request))
        response = json.loads(await ws.recv())

        success = response.get("d", {}).get("requestStatus", {}).get("result", False)
        return success


# ─── CORS (needed so the OBS browser source can call localhost) ────────────────
def add_cors(app):
    """Call this in your main FastAPI app: add_cors(app)"""
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],   # OBS browser sources use file:// origin
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )
