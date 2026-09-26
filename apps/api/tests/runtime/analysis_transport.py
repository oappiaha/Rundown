"""Run from apps/api: .venv/bin/python tests/runtime/analysis_transport.py <fresh-dir>."""

import json
import os
import socket
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

import httpx

ROOT = Path(__file__).resolve().parents[4]
OUT = Path(sys.argv[1]).resolve()
OUT.mkdir(parents=True, exist_ok=True)
if (OUT / "probe.db").exists():
    raise SystemExit("Use a fresh evidence directory; existing databases are preserved.")
CASES = (["slow", "truncated"] if "--recheck" in sys.argv else
         ["success", "disconnect", "delay", "slow", "stall", "endless", "truncated"])
mode = "success"
calls = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        current = mode
        calls.append(current)
        assert data['stream'] is True
        assert self.headers['x-api-key'] == 'local-fixture-only'
        if current == 'disconnect':
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        try:
            if current == 'delay':
                time.sleep(31)
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            def emit(kind, **values):
                event = {'type': kind, **values}
                self.wfile.write(('event: ' + kind + '\ndata: ' + json.dumps(event) + '\n\n').encode())
                self.wfile.flush()
            emit('message_start', message={'id': 'msg_fixture', 'type': 'message',
                 'role': 'assistant', 'model': 'fixture-model', 'content': [],
                 'stop_reason': None, 'stop_sequence': None,
                 'usage': {'input_tokens': 100, 'output_tokens': 0}})
            if current == 'stall':
                time.sleep(31)
            if current == 'endless':
                for _ in range(35):
                    emit('ping')
                    time.sleep(2)
                return
            emit('content_block_start', index=0, content_block={'type': 'text', 'text': ''})
            stories = json.loads(data['messages'][0]['content'])['stories']
            body = json.dumps({'items': [{'id': v['id'], 'score': 80,
                'category': 'ai-innovation', 'group_id': v['id'],
                'reason': 'Controlled fixture, not quality evidence.'} for v in stories]})
            split = len(body)//2
            emit('content_block_delta', index=0, delta={'type': 'text_delta', 'text': body[:split]})
            if current == 'slow':
                for _ in range(16):
                    time.sleep(2)
                    emit('ping')
            emit('content_block_delta', index=0, delta={'type': 'text_delta', 'text': body[split:]})
            emit('content_block_stop', index=0)
            emit('message_delta', delta={'stop_reason': 'end_turn', 'stop_sequence': None},
                 usage={'output_tokens': 50})
            if current != 'truncated':
                emit('message_stop')
        except (BrokenPipeError, ConnectionResetError):
            pass


server = ThreadingHTTPServer(("127.0.0.1", 8186), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
env = {
    **os.environ,
    "DB_PATH": str(OUT / "probe.db"),
    "RAW_CACHE_DIR": str(OUT / "raw"),
    "LOGS_DIR": str(OUT / "logs"),
    "RSS_SCHEDULER_ENABLED": "false",
    "RESEARCH_AI_ENABLED": "true",
    "RESEARCH_AI_MODEL": "fixture-model",
    "RESEARCH_AI_DAILY_LIMIT": str(len(CASES)),
    "PREPARATION_TEST_ORIGIN": "http://127.0.0.1:8186",
    "ANTHROPIC_API_KEY": "",
}
log = (OUT / "server.log").open("w")
proc = subprocess.Popen(
    [
        str(ROOT / "apps/api/.venv/bin/python"),
        "-m",
        "uvicorn",
        "rundown.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        "8185",
    ],
    cwd=ROOT / "apps/api",
    env=env,
    stdout=log,
    stderr=subprocess.STDOUT,
)
try:
    with httpx.Client(base_url="http://127.0.0.1:8185", timeout=70, trust_env=False) as c:
        for _ in range(100):
            if proc.poll() is not None:
                raise RuntimeError("Owned API exited; do not probe an unrelated listener")
            if "Uvicorn running on http://127.0.0.1:8185" not in (OUT / "server.log").read_text():
                time.sleep(0.1)
                continue
            try:
                if c.get("/health").status_code == 200:
                    break
            except httpx.ConnectError:
                pass
            time.sleep(0.1)
        else:
            raise RuntimeError("Server failed to start")
        item = c.post(
            "/inbox",
            json={
                "text": "Timeout diagnostic",
                "duration": 120,
                "notes": "Synthetic context; no private input.",
                "source_url": "https://example.com/fixture-story",
            },
        ).json()
        p = {
            "brief": "AI filmmaking workflows for creators",
            "selections": [
                {"id": item["id"], "revision": item["revision"], "preference_revision": 0}
            ],
        }
        preview = c.post("/research/ai/input", json=p).json()
        before = c.get("/inbox").json()
        live = c.get("/rundown/topics").json()
        evidence = []
        for mode in CASES:
            req = {
                **p,
                "input_hash": preview["input_hash"],
                "request_id": str(uuid4()),
                "consent": True,
            }
            start = time.monotonic()
            if mode in {"delay", "slow", "stall", "endless"}:
                with ThreadPoolExecutor(1) as pool:
                    pending = pool.submit(c.post, "/research/ai/generate", json=req)
                    for _ in range(100):
                        if calls and calls[-1] == mode:
                            break
                        time.sleep(0.02)
                    assert (
                        c.get("/research/ai/runs/" + req["request_id"]).json()["status"]
                        == "running"
                    )
                    assert c.post("/research/ai/generate", json=req).json()["status"] == "running"
                    assert (
                        c.post(
                            "/research/ai/generate", json={**req, "request_id": str(uuid4())}
                        ).status_code
                        == 409
                    )
                    r = pending.result(timeout=70)
            else:
                r = c.post("/research/ai/generate", json=req)
            elapsed = time.monotonic() - start
            assert r.status_code == 200, r.text
            result = r.json()
            assert result["status"] == ("succeeded" if mode in {"success", "slow"} else "failed"), result
            if mode in {"delay", "stall"}:
                assert "timed out waiting for a response" in result["error"]
            if mode == "disconnect":
                assert "connection failed" in result["error"] and "timed out" not in result["error"]
            if mode == 'slow':
                assert 30 < elapsed < 60
                assert result['input_tokens'] == 100 and result['output_tokens'] == 50
            if mode == 'endless':
                assert 59 < elapsed < 65 and 'time limit' in result['error']
            if mode == 'truncated':
                assert 'invalid or incomplete' in result['error']
            if result['status'] == 'failed':
                assert result['items'] == [] and result['input_tokens'] is None
            assert c.get("/research/ai/runs/" + req["request_id"]).json() == result
            assert c.post("/research/ai/generate", json=req).json() == result
            assert (
                c.post(
                    "/research/ai/generate", json={**req, "brief": "Different editorial input"}
                ).status_code
                == 409
            )
            if result['status'] == 'succeeded':
                proposal = c.post('/research/ai/runs/' + req['request_id'] + '/propose', json={'count': 1})
                assert proposal.status_code == 200
                chosen = proposal.json()['items'][0]
                selections = [{'id': chosen['id'], 'revision': chosen['revision'],
                               'preference_revision': chosen['preferences']['revision']}]
                preview_show = c.post('/research/preview', json={'selections': selections}).json()
                saved = c.post('/research/shows', json={'selections': selections,
                    'name': 'Streaming fixture show', 'request_id': str(uuid4())})
                assert saved.status_code == 201
                read = c.get('/shows/' + saved.json()['id']).json()
                assert [{k: t[k] for k in ['text', 'duration', 'notes']}
                        for t in read['topics']] == preview_show['topics']
                assert 'https://example.com/fixture-story' in read['topics'][0]['notes']
            print(mode, round(elapsed, 2), result["status"], flush=True)
            evidence.append({"mode": mode, "elapsed_seconds": round(elapsed, 2), "result": result})
        assert calls == CASES, calls
        assert (
            c.post("/research/ai/generate", json={**req, "request_id": str(uuid4())}).status_code
            == 429
        )
        assert c.get("/inbox").json() == before
        assert c.get("/rundown/topics").json() == live
        name = "verification"
        (OUT / (name + ".json")).write_text(
            json.dumps(
                {
                    "cases": evidence,
                    "provider_calls": calls,
                    "replay_no_retry": True,
                    "cap_429": True,
                    "source_live_preserved": True,
                },
                indent=2,
            )
        )
        print(
            json.dumps(
                [
                    {
                        "mode": e["mode"],
                        "seconds": e["elapsed_seconds"],
                        "error": e["result"]["error"],
                    }
                    for e in evidence
                ]
            ),
            flush=True,
        )
finally:
    proc.terminate()
    proc.wait(timeout=10)
    log.close()
    server.shutdown()
    server.server_close()
