import httpx,json,time
from pathlib import Path
base='http://127.0.0.1:8193';a=httpx.Client(base_url=base,timeout=20)
old=a.get('/rundown/state').json();plans=a.get('/plans').json();count=len(a.get('/inbox').json()['items'])
url='http://127.0.0.1:8192/articles/redirect'
r=a.post('/link-previews/preview',json={'url':url});r.raise_for_status();v=r.json()
assert v['source_url']==url and v['resolved_url']!=url
assert len(a.get('/inbox').json()['items'])==count
payload={'kind':'link','title':'My editorial headline','note':'Independent personal note','source_url':url,'preview':v['token']}
for changes in [{'source_url':url+'?changed=1'},{'preview':v['token'][:-3]+'BAD'}]:
 bad=a.post('/inbox/capture',json={**payload,**changes});assert bad.status_code==409,(bad.status_code,bad.text)
assert len(a.get('/inbox').json()['items'])==count
r=a.post('/inbox/capture',json=payload);r.raise_for_status();item=r.json();assert item['source_url']==url and item['editorial']['note']==payload['note'] and item['capture']['display_title']==payload['title']
assert item['source']['original_title']==v['title'];assert item['presentation']['thumbnail']==v['thumbnail']
assert a.get('/inbox/'+item['id']).json()==item
for u in ['http://127.0.0.1:8192/articles/private-redirect','http://127.0.0.1:1/private']:
 time.sleep(2.1);bad=a.post('/link-previews/preview',json={'url':u});assert bad.status_code==502,(bad.status_code,bad.text)
manual=a.post('/inbox/capture',json={'kind':'link','title':'Manual fallback','source_url':'https://example.com/no-preview','note':'Keep me'});manual.raise_for_status();assert manual.json()['editorial']['note']=='Keep me'
assert a.get('/plans').json()==plans
new=a.get('/rundown/state').json();assert all(new[k]==old[k] for k in ['topics','current_topic_id','paused','revision'])
Path('/private/tmp/rundown-link-preview/parent-api-result.json').write_text(json.dumps({'passed':True,'checks':['preview read-only','redirect attribution','URL/signature binding','persisted preview/source/note','private redirect rejection','manual fallback','plans/live preservation']},indent=2))
print('Independent API acceptance passed')
