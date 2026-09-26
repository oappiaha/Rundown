import json,os,sqlite3,subprocess,time
from pathlib import Path
import httpx
R=Path('/Users/rei/2026/Rundown');O=Path('/private/tmp/rundown-compact-recheck');O.mkdir(exist_ok=True)
assert not (O/'sample.db').exists()
src=sqlite3.connect('file:/private/tmp/deez/rundown-timeout-20260924/sample.db?mode=ro',uri=True);dst=sqlite3.connect(O/'sample.db');src.backup(dst);src.close();dst.close()
env={**os.environ,'DB_PATH':str(O/'sample.db'),'RAW_CACHE_DIR':str(O/'raw'),'LOGS_DIR':str(O/'logs'),'RSS_SCHEDULER_ENABLED':'false','RESEARCH_AI_ENABLED':'false','PREPARATION_TEST_ORIGIN':''}
log=(O/'server.log').open('w');p=subprocess.Popen([str(R/'apps/api/.venv/bin/python'),'-m','uvicorn','rundown.main:app','--host','127.0.0.1','--port','8187'],cwd=R/'apps/api',env=env,stdout=log,stderr=subprocess.STDOUT)
try:
 with httpx.Client(base_url='http://127.0.0.1:8187',trust_env=False) as c:
  for _ in range(100):
   if p.poll() is not None:raise RuntimeError('Owned server exited')
   if 'Uvicorn running on http://127.0.0.1:8187' in (O/'server.log').read_text():break
   time.sleep(.1)
  else:raise RuntimeError('Startup failed')
  d=R/'docs/evaluations/2026-09-24-ranking';req=json.loads((d/'request-draft.json').read_text());old=(d/'input.json').read_text();before=c.get('/inbox').json();live=c.get('/rundown/topics').json()
  res=c.post('/research/ai/input',json=req);assert res.status_code==200,res.text
  preview=res.json();new=preview['input_text'];a=json.loads(old)['stories'];b=json.loads(new)['stories']
  assert all(x['source_text']==y['source_text'] and x['source_url']==y['source_url'] for x,y in zip(a,b,strict=True))
  assert all(not x['context'] for x in b[:9]);assert a[9]['context']==b[9]['context']
  assert c.get('/inbox').json()==before and c.get('/rundown/topics').json()==live
  old_run='fdbe60af-211d-4e84-bde4-adc6e1f349d7'
  assert c.get('/research/ai/runs/'+old_run).json()['stale']
  assert c.post('/research/ai/runs/'+old_run+'/propose',json={'count':3}).status_code==409
  (O/'input.json').write_text(new);(O/'preview.json').write_text(json.dumps(preview,indent=2))
  # Verify edited context survives the actual preview endpoint.
  ident=req['selections'][0]['id']; detail=c.get('/inbox/'+ident).json()
  edit=c.put('/inbox/'+ident,json={'text':detail['text'],'duration':detail['duration'],'notes':'Editorial correction: treat this claim cautiously.','source_url':detail['source_url'],'revision':detail['revision']});assert edit.status_code==200,edit.text
  assert c.post('/research/ai/input',json=req).status_code==409
  req['selections'][0]['revision']=edit.json()['revision']
  edited=c.post('/research/ai/input',json=req).json()
  assert json.loads(edited['input_text'])['stories'][0]['context']=='Editorial correction: treat this claim cautiously.'
  report={'old_characters':len(old),'new_characters':len(new),'reduction_percent':round(100*(1-len(new)/len(old)),1),'source_text_and_urls_preserved':True,'manual_duplicate_context_preserved':True,'edited_context_preserved':True,'stale_revision_rejected':True,'preview_source_live_unchanged':True,'old_result_stale_and_propose_rejected':True,'paid_calls':0,'live_latency_unmeasured':True}
  (O/'verification.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
finally:
 p.terminate();p.wait(timeout=10);log.close()
