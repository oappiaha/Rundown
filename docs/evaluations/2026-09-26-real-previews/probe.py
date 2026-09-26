import httpx,time,json
from pathlib import Path
urls=['https://typesafe.ai/blog/introducing-system-one-models-and-jev','https://www.blender.org/download/releases/4-5/','https://www.tiktok.com/@scout2015/video/6718335390845095173']
a=httpx.Client(base_url='http://127.0.0.1:8193',timeout=30,trust_env=False);assert a.get('/health').is_success
before=a.get('/inbox').json();out=[]
for url in urls:
 start=time.monotonic();r=a.post('/link-previews/preview',json={'url':url});v=r.json();v.pop('token',None)
 row={'url':url,'status':r.status_code,'seconds':round(time.monotonic()-start,3),'response':v};out.append(row);print(json.dumps(row),flush=True);time.sleep(2.1)
assert a.get('/inbox').json()==before
Path('/private/tmp/rundown-real-previews/api-results.json').write_text(json.dumps(out,indent=2))
