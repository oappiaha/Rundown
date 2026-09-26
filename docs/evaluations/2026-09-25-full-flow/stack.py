import asyncio,base64,hashlib,json,os,subprocess,threading,time,signal
from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from urllib.parse import urlparse
from datetime import datetime,timezone
import websockets
O=Path('/private/tmp/rundown-full-audit');R=Path('/Users/rei/2026/Rundown')
DATA=[('demo0000001','AI camera continuity','A synthetic tutorial: storyboard, matching camera angles, lighting and editing. Demo data, not real news.'),('demo0000002','Small studio AI workflow','Synthetic practical workflow: script, shot list, keyframes, generate clips and review artifacts.'),('demo0000003','Fashion runway teaser','Synthetic promotional fashion showcase; no practical filmmaking steps.'),('demo0000004','Weekend football scores','Synthetic football result, unrelated to filmmaking.')]
class H(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def sendj(self,v,status=200):
  b=json.dumps(v).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
 def do_GET(self):
  path=urlparse(self.path).path
  if path.endswith('/search'):return self.sendj({'items':[{'id':{'videoId':i}} for i,t,b in DATA]})
  if path.endswith('/videos'):return self.sendj({'items':[{'id':i,'snippet':{'title':t,'description':b,'channelTitle':'DEMO Studio','publishedAt':datetime.now(timezone.utc).isoformat()}} for i,t,b in DATA]})
  if path.endswith('/new'):return self.sendj({'data':{'children':[{'data':{'id':'abc123','title':'Community camera tips','selftext':'Synthetic discussion: keeping AI shots consistent. Check lighting and reference frames.','subreddit':'filmmaking','created_utc':time.time()}}]}})
  if path.endswith('/oembed'):return self.sendj({'html':'<blockquote>Synthetic public post: compare lighting before exporting your film.</blockquote>','author_name':'Demo creator','title':'Demo creative workflow'})
  if path.endswith('.xml'):
   b=b'<rss version="2.0"><channel><title>Demo production feed</title><link>https://example.com</link><description>Synthetic</description><item><guid>demo-feed-1</guid><title>New editing workflow</title><link>https://example.com/editing</link><description>Synthetic guide to editing, sound and final checks for a short film.</description></item></channel></rss>'
   self.send_response(200);self.send_header('Content-Type','application/rss+xml');self.end_headers();self.wfile.write(b);return
  self.sendj({'error':'fixture missing'},404)
 def do_POST(self):
  n=int(self.headers.get('Content-Length',0));raw=self.rfile.read(n)
  if self.path.endswith('/access_token'):return self.sendj({'access_token':'fixture'})
  d=json.loads(raw);text=d['messages'][0]['content'];q=json.loads(text) if text.startswith('{') else {}
  if 'stories' in q:
   out={'items':[{'id':s['id'],'score':92 if 'workflow' in s['title'].lower() or 'camera' in s['title'].lower() else 15,'category':'film-entertainment' if 'workflow' in s['title'].lower() or 'camera' in s['title'].lower() else 'uncategorized','group_id':s['id'],'reason':'Synthetic classification: practical production relevance.'} for s in q['stories']]}
  else:
   v={'summary':'Demo summary: review the supplied workflow before going live.','talking_points':['What changes the production process?','Which claims still need checking?','What can a small studio try first?']}
   out={'items':[{'id':t['id'],**v} for t in q['topics']]} if 'topics' in q else v
  msg={'id':'msg_demo','type':'message','role':'assistant','model':'fixture-model','content':[{'type':'text','text':json.dumps(out)}],'stop_reason':'end_turn','stop_sequence':None,'usage':{'input_tokens':100,'output_tokens':80}}
  if not d.get('stream'):return self.sendj(msg)
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  def emit(k,**v):self.wfile.write(('event: '+k+'\ndata: '+json.dumps({'type':k,**v})+'\n\n').encode());self.wfile.flush()
  emit('message_start',message={**msg,'content':[],'stop_reason':None});emit('content_block_start',index=0,content_block={'type':'text','text':''});emit('content_block_delta',index=0,delta={'type':'text_delta','text':json.dumps(out)});emit('content_block_stop',index=0);emit('message_delta',delta={'stop_reason':'end_turn','stop_sequence':None},usage={'output_tokens':80});emit('message_stop')
http=ThreadingHTTPServer(('127.0.0.1',8188),H);threading.Thread(target=http.serve_forever,daemon=True).start()
async def obs(ws):
 salt='demo-salt';challenge='demo-challenge'
 await ws.send(json.dumps({'op':0,'d':{'rpcVersion':1,'authentication':{'salt':salt,'challenge':challenge}}}))
 m=json.loads(await ws.recv());secret=base64.b64encode(hashlib.sha256(('demo-password'+salt).encode()).digest()).decode();expected=base64.b64encode(hashlib.sha256((secret+challenge).encode()).digest()).decode()
 good=m.get('d',{}).get('authentication')==expected
 with (O/'obs.jsonl').open('a') as f:f.write(json.dumps({'authenticated':good})+'\n')
 if not good:await ws.close(code=4009,reason='Authentication failed');return
 await ws.send(json.dumps({'op':2,'d':{'negotiatedRpcVersion':1}}));m=json.loads(await ws.recv())
 with (O/'obs.jsonl').open('a') as f:f.write(json.dumps({'request':m})+'\n')
 await ws.send(json.dumps({'op':7,'d':{'requestId':m['d']['requestId'],'requestStatus':{'result':True,'code':100}}}))
async def obs_main():
 async with websockets.serve(obs,'127.0.0.1',8189,subprotocols=['obswebsocket.json']):await asyncio.Future()
threading.Thread(target=lambda:asyncio.run(obs_main()),daemon=True).start()
env={**os.environ,'DB_PATH':str(O/'demo.db'),'RAW_CACHE_DIR':str(O/'raw'),'LOGS_DIR':str(O/'logs'),'RSS_SCHEDULER_ENABLED':'false','RETRIEVAL_TEST_ORIGIN':'http://127.0.0.1:8188','RSS_TEST_FEED_ORIGIN':'http://127.0.0.1:8188','PREPARATION_TEST_ORIGIN':'http://127.0.0.1:8188','RESEARCH_AI_ENABLED':'true','RESEARCH_AI_MODEL':'fixture-model','RESEARCH_AI_DAILY_LIMIT':'20','PREPARATION_ENABLED':'true','PREPARATION_MODEL':'fixture-model','ANTHROPIC_API_KEY':'','YOUTUBE_API_KEY':'','REDDIT_CLIENT_SECRET':'','OBS_WS_HOST':'127.0.0.1','OBS_WS_PORT':'8189','OBS_WS_PASS':'demo-password'}
api=subprocess.Popen([str(R/'apps/api/.venv/bin/python'),'-m','uvicorn','rundown.main:app','--host','127.0.0.1','--port','8187'],cwd=R/'apps/api',env=env,stdout=(O/'api.log').open('w'),stderr=subprocess.STDOUT)
chrome='/Users/rei/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
browser=subprocess.Popen([chrome,'--headless','--no-first-run','--remote-debugging-port=8194','--user-data-dir='+str(O/'browser'),'about:blank'],stdout=(O/'browser.log').open('w'),stderr=subprocess.STDOUT)
(O/'lease.json').write_text(json.dumps({'api_pid':api.pid,'browser_pid':browser.pid,'ports':[8187,8188,8189,8194],'db':str(O/'demo.db')}))
print('Synthetic stack started',flush=True)
try:
 while True:time.sleep(1)
finally:
 api.terminate();browser.terminate();http.shutdown()
