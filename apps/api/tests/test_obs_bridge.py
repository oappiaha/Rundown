from fastapi.testclient import TestClient

from rundown.main import app


def test_health():
    with TestClient(app) as client:
        r = client.get("/health")
        assert r.status_code == 200
        assert r.json() == {"status": "ok"}


def test_topics_roundtrip(tmp_path, monkeypatch):
    # Each test gets its own SQLite file so we don't poison shared state.
    from rundown import config, db

    monkeypatch.setattr(config.settings, "db_path", tmp_path / "rundown.db")
    monkeypatch.setattr(db, "_engine", db.create_engine(f"sqlite:///{config.settings.db_path}"))

    with TestClient(app) as client:
        r = client.post(
            "/rundown/push-to-obs",
            json={
                "topics": [
                    {"text": "NBA Playoffs", "duration": 120},
                    {"text": "Drake vs Kendrick", "duration": 90},
                ],
                "refresh_obs": False,
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["topics_count"] == 2

        r2 = client.get("/rundown/topics")
        assert r2.status_code == 200
        data = r2.json()
        assert data["topics"][0]["text"] == "NBA Playoffs"
        assert len(data["hash"]) == 8


def test_rejects_invalid_or_empty_schedules(tmp_path, monkeypatch):
    from rundown import config, db

    monkeypatch.setattr(config.settings, "db_path", tmp_path / "rundown.db")
    monkeypatch.setattr(db, "_engine", db.create_engine(f"sqlite:///{config.settings.db_path}"))

    with TestClient(app) as client:
        valid_topics = [{"text": "Keep this schedule", "duration": 120}]
        assert client.post(
            "/rundown/push-to-obs",
            json={"topics": valid_topics, "refresh_obs": False},
        ).status_code == 200

        assert client.post(
            "/rundown/push-to-obs", json={"topics": [], "refresh_obs": False}
        ).status_code == 422
        assert client.post(
            "/rundown/push-to-obs",
            json={"topics": [{"text": "   ", "duration": 120}], "refresh_obs": False},
        ).status_code == 422
        assert client.post(
            "/rundown/push-to-obs",
            json={"topics": [{"text": "Valid topic", "duration": 10}], "refresh_obs": False},
        ).status_code == 422
        assert client.post(
            "/rundown/push-to-obs",
            json={
                "topics": [{"text": "This topic title is definitely too long", "duration": 120}],
                "refresh_obs": False,
            },
        ).status_code == 422

        assert client.get("/rundown/topics").json()["topics"] == valid_topics


def test_serves_overlay_with_same_origin_api():
    with TestClient(app) as client:
        response = client.get("/static/overlay.html")
        assert response.status_code == 200
        assert 'const RUNDOWN_API = "/rundown/state"' in response.text


async def test_obs_v5_authenticated_refresh(monkeypatch):
    import base64
    import hashlib
    import json

    import websockets

    from rundown.config import settings
    from rundown.obs_bridge import _obs_refresh_browser_source

    seen = []
    async def handler(ws):
        await ws.send(json.dumps({'op': 0, 'd': {'authentication': {
            'salt': 'fixture-salt', 'challenge': 'fixture-challenge'}}}))
        identify = json.loads(await ws.recv())
        # OBS v5 specification: two concatenations and plain SHA256, not HMAC.
        secret = base64.b64encode(hashlib.sha256(b'fixture-passwordfixture-salt').digest()).decode()
        expected = base64.b64encode(hashlib.sha256((secret + 'fixture-challenge').encode()).digest()).decode()
        assert identify['d']['authentication'] == expected
        await ws.send(json.dumps({'op': 2, 'd': {'negotiatedRpcVersion': 1}}))
        request = json.loads(await ws.recv())
        seen.append(request)
        await ws.send(json.dumps({'op': 7, 'd': {'requestId': request['d']['requestId'],
            'requestStatus': {'result': True, 'code': 100}}}))
    async with websockets.serve(handler, '127.0.0.1', 0) as server:
        monkeypatch.setattr(settings, 'obs_ws_host', '127.0.0.1')
        monkeypatch.setattr(settings, 'obs_ws_port', server.sockets[0].getsockname()[1])
        monkeypatch.setattr(settings, 'obs_ws_pass', 'fixture-password')
        assert await _obs_refresh_browser_source()
    assert seen[0]['d']['requestData']['propertyName'] == 'refreshnocache'


async def test_obs_rejects_unidentified_connection(monkeypatch):
    import json

    import websockets

    from rundown.config import settings
    from rundown.obs_bridge import _obs_refresh_browser_source

    async def handler(ws):
        await ws.send(json.dumps({'op': 0, 'd': {}}))
        await ws.recv()
        await ws.send(json.dumps({'op': 5, 'd': {}}))
    async with websockets.serve(handler, '127.0.0.1', 0) as server:
        monkeypatch.setattr(settings, 'obs_ws_host', '127.0.0.1')
        monkeypatch.setattr(settings, 'obs_ws_port', server.sockets[0].getsockname()[1])
        assert not await _obs_refresh_browser_source()
