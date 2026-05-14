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
