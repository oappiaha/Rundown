import json,os,signal,subprocess,time,threading
from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
import httpx
O=Path('/private/tmp/rundown-full-audit');R=Path('/Users/rei/2026/Rundown')
class H(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_GET(self):
  if '/oembed' in self.path:
   v={'type':'rich' if self.path.startswith('/x/') else 'video','html':'<blockquote><p>Synthetic public post: compare lighting before exporting your film.</p></blockquote>','author_name':'Demo creator','title':'Synthetic public caption: compare lighting before exporting.'};b=json.dumps(v).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b)
  else:
   with httpx.Client(trust_env=False) as c:r=c.get('http://127.0.0.1:8188'+self.path)
   self.send_response(r.status_code);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(r.content)
 def do_POST(self):
  b=self.rfile.read(int(self.headers.get('Content-Length',0)))
  with httpx.Client(trust_env=False) as c:r=c.post('http://127.0.0.1:8188'+self.path,content=b)
  self.send_response(r.status_code);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(r.content)
http=ThreadingHTTPServer(('127.0.0.1',8192),H);threading.Thread(target=http.serve_forever,daemon=True).start()
lease=json.loads((O/'lease.json').read_text());os.kill(lease['api_pid'],signal.SIGTERM);time.sleep(1)
env={**os.environ,'DB_PATH':str(O/'demo.db'),'RAW_CACHE_DIR':str(O/'raw'),'LOGS_DIR':str(O/'logs'),'RSS_SCHEDULER_ENABLED':'false','RETRIEVAL_TEST_ORIGIN':'http://127.0.0.1:8192','RSS_TEST_FEED_ORIGIN':'http://127.0.0.1:8188','PREPARATION_TEST_ORIGIN':'http://127.0.0.1:8188','RESEARCH_AI_ENABLED':'true','RESEARCH_AI_MODEL':'fixture-model','RESEARCH_AI_DAILY_LIMIT':'20','PREPARATION_ENABLED':'true','PREPARATION_MODEL':'fixture-model','ANTHROPIC_API_KEY':'','YOUTUBE_API_KEY':'','REDDIT_CLIENT_SECRET':'','OBS_WS_HOST':'127.0.0.1','OBS_WS_PORT':'8189','OBS_WS_PASS':'demo-password'}
p=subprocess.Popen([str(R/'apps/api/.venv/bin/python'),'-m','uvicorn','rundown.main:app','--host','127.0.0.1','--port','8187'],cwd=R/'apps/api',env=env,stdout=(O/'api-fixed.log').open('w'),stderr=subprocess.STDOUT);lease['api_pid']=p.pid;(O/'lease.json').write_text(json.dumps(lease));print('API restarted; correct oEmbed fixture added',flush=True)
try:
 while True:time.sleep(1)
finally:p.terminate();http.shutdown()
