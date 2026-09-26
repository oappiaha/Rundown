import os,json,subprocess,time
from pathlib import Path
import httpx
O=Path('/private/tmp/rundown-full-audit');R=Path('/Users/rei/2026/Rundown')
env={**os.environ,'DB_PATH':str(O/'obs-proof.db'),'RAW_CACHE_DIR':str(O/'obs-raw'),'LOGS_DIR':str(O/'obs-logs'),'RSS_SCHEDULER_ENABLED':'false','OBS_WS_HOST':'127.0.0.1','OBS_WS_PORT':'8189','OBS_WS_PASS':'demo-password'}
log=(O/'obs-api.log').open('w');p=subprocess.Popen([str(R/'apps/api/.venv/bin/python'),'-m','uvicorn','rundown.main:app','--host','127.0.0.1','--port','8191'],cwd=R/'apps/api',env=env,stdout=log,stderr=subprocess.STDOUT)
try:
 with httpx.Client(base_url='http://127.0.0.1:8191',trust_env=False) as c:
  for _ in range(100):
   if p.poll() is not None:raise RuntimeError('Server exited')
   if 'Uvicorn running on http://127.0.0.1:8191' in (O/'obs-api.log').read_text():break
   time.sleep(.1)
  r=c.post('/rundown/push-to-obs',json={'topics':[{'text':'OBS synthetic check','duration':120}],'refresh_obs':True});assert r.status_code==200 and r.json()['obs_refreshed'],r.text
  (O/'obs-fixed-result.json').write_text(json.dumps(r.json(),indent=2));print(r.json())
finally:p.terminate();p.wait(timeout=10);log.close()
