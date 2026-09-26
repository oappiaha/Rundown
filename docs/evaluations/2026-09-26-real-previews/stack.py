"""Owned verification stack: live public sources, API 8193, Vite 3189. Disposable DB only."""
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

O = Path('/private/tmp/rundown-real-previews')
R = Path('/Users/rei/2026/Rundown')
PY = R / 'apps/api/.venv/bin/python'
PORTS = {'api': 8193, 'web': 3189}

for name, port in PORTS.items():
    with socket.socket() as s:
        if s.connect_ex(('127.0.0.1', port)) == 0:
            sys.exit(f'port {port} ({name}) is already in use; refusing to start')

if '--reset-db' in sys.argv:
    import shutil
    for suffix in ['', '-journal', '-wal', '-shm']:
        p = O / f'demo.db{suffix}'
        if p.exists():
            p.unlink()
    shutil.rmtree(O / 'assets', ignore_errors=True)

env = {k: v for k, v in os.environ.items() if not k.startswith(('ANTHROPIC', 'YOUTUBE', 'REDDIT', 'OBS_'))}
env.update({
    'DB_PATH': str(O / 'demo.db'), 'RAW_CACHE_DIR': str(O / 'raw'), 'LOGS_DIR': str(O / 'logs'), 'ASSETS_DIR': str(O / 'assets'),
    'RSS_SCHEDULER_ENABLED': 'false', 'RESEARCH_AI_ENABLED': 'false', 'PREPARATION_ENABLED': 'false',
    'RETRIEVAL_TEST_ORIGIN': '', 'RSS_TEST_FEED_ORIGIN': '',
    'ANTHROPIC_API_KEY': '', 'YOUTUBE_API_KEY': '', 'REDDIT_CLIENT_ID': '', 'REDDIT_CLIENT_SECRET': '',
    'REDDIT_USER_AGENT': '', 'REDDIT_API_APPROVED': 'false', 'RESEARCH_AI_MODEL': '', 'PREPARATION_MODEL': '',
    'PREPARATION_TEST_ORIGIN': '', 'OBS_WS_HOST': '127.0.0.1', 'OBS_WS_PORT': '8199', 'OBS_WS_PASS': '',
})
logs = O / 'logs'
logs.mkdir(exist_ok=True)
procs = {}
procs['api'] = subprocess.Popen([str(PY), '-m', 'uvicorn', 'rundown.main:app', '--host', '127.0.0.1', '--port', '8193'], cwd=R / 'apps/api', env=env, stdout=(logs / 'api.log').open('w'), stderr=subprocess.STDOUT)
web_env = {**os.environ, 'RUNDOWN_API_TARGET': 'http://127.0.0.1:8193'}
procs['web'] = subprocess.Popen(['npx', 'vite', '--host', '127.0.0.1', '--port', '3189', '--strictPort'], cwd=R / 'apps/web', env=web_env, stdout=(logs / 'vite.log').open('w'), stderr=subprocess.STDOUT)
lease = {'started_at': time.time(), 'pids': {k: p.pid for k, p in procs.items()}, 'stack_pid': os.getpid(), 'ports': PORTS,
         'db': str(O / 'demo.db'), 'commands': {
             'api': f'cd {R}/apps/api && {PY} -m uvicorn rundown.main:app --host 127.0.0.1 --port 8193  (env: DB_PATH={O}/demo.db, ASSETS_DIR={O}/assets, scheduler/AI/prep off, credentials blank, fixture origins blank)',
             'web': f'cd {R}/apps/web && RUNDOWN_API_TARGET=http://127.0.0.1:8193 npx vite --host 127.0.0.1 --port 3189 --strictPort'}}
(O / 'lease.json').write_text(json.dumps(lease, indent=1))
print('stack started', json.dumps(lease['pids']), flush=True)


def stop(*_):
    for p in procs.values():
        p.terminate()
    sys.exit(0)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
while True:
    time.sleep(1)
    for name, p in procs.items():
        if p.poll() is not None:
            print(f'{name} exited with {p.returncode}', flush=True)
