import json,time,hashlib
from pathlib import Path
import httpx
from playwright.sync_api import sync_playwright,expect
out=Path('/private/tmp/rundown-days-implementation/evidence');out.mkdir(exist_ok=True)
a=httpx.Client(base_url='http://127.0.0.1:8193');before=a.get('/rundown/state').json()
name='Release '+str(int(time.time()))
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/Users/rei/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
 page=b.new_page(viewport={'width':1280,'height':900});page.goto('http://127.0.0.1:3189');page.get_by_role('button',name='Discover',exact=True).click()
 page.get_by_role('button',name='New topic',exact=True).click();s=page.get_by_role('dialog',name='New topic')
 s.get_by_label('Topic title').fill(name);s.get_by_label('Personal note').fill('Snapshot test');s.get_by_role('button',name='Create topic',exact=True).click()
 c=page.get_by_role('article',name=name,exact=True);expect(c).to_be_visible()
 for day,date in [('A','2026-10-06'),('B','2026-10-07')]:
  c.get_by_role('button',name='Add to a streaming day: '+name).click();d=page.get_by_role('dialog',name='Streaming days')
  if not d.get_by_label('Stream date').is_visible(): d.get_by_role('button',name='New streaming day').click()
  d.get_by_label('Stream date').fill(date);d.get_by_label('Day name').fill(name+day);d.get_by_role('button',name='Create day',exact=True).click()
  d.get_by_role('button',name='Add to this day',exact=True).click();expect(d.get_by_role('list',name='Topics in '+name+day)).to_be_visible()
  page.screenshot(path=str(out/('parent-day-'+day+'.png')))
  d.get_by_role('button',name='Close streaming days').click()
 plans=[x for x in a.get('/plans').json()['plans'] if x['name'].startswith(name)];assert len(plans)==2
 snapshots=[a.get('/plans/'+x['id']).json() for x in plans];assert all(x['topics'][0]['notes']=='Snapshot test' for x in snapshots)
 item=next(x for x in a.get('/inbox').json()['items'] if x['text']==name)
 e=item['editorial'];r=a.put('/inbox/'+item['id']+'/editorial',json={'revision':e['revision'],'note':'Changed library','saved':True});r.raise_for_status()
 assert all(a.get('/plans/'+x['id']).json()==x for x in snapshots)
 stale=a.put('/plans/'+snapshots[0]['id'],json={'revision':0,'name':'stale','topics':[]});assert stale.status_code==422
 page.get_by_role('button',name='New topic',exact=True).click();s.get_by_role('button',name='Upload',exact=True).click()
 data=b'Release verification file\n';f=out/'release.txt';f.write_bytes(data)
 s.locator('input[type=file]').set_input_files(str(f));s.get_by_label('Topic title').fill(name+' file');s.get_by_label('Live label').fill('Release file') if s.get_by_label('Live label').is_visible() else None
 s.get_by_role('checkbox').uncheck() if s.get_by_role('checkbox').count() else None
 s.get_by_role('button',name='Create topic',exact=True).click();expect(page.get_by_role('article',name=name+' file',exact=True)).to_be_visible()
 upload=next(x for x in a.get('/inbox').json()['items'] if (x.get('capture') or {}).get('display_title')==name+' file');att=upload['capture']['attachments'][0];assert a.get('/attachments/'+att['id']).content==data
 count=len(a.get('/inbox').json()['items']);bad=a.post('/attachments',params={'title':'Invalid','filename':'bad.svg'},content=b'<svg/>',headers={'content-type':'image/svg+xml'});assert bad.status_code==422 and len(a.get('/inbox').json()['items'])==count
 page.reload();page.get_by_role('button',name='Discover',exact=True).click();expect(page.get_by_role('article',name=name+' file',exact=True)).to_be_visible()
 page.set_viewport_size({'width':390,'height':844});page.get_by_role('button',name='Streaming days',exact=True).click();assert page.evaluate('document.documentElement.scrollWidth <= innerWidth');page.screenshot(path=str(out/'parent-mobile.png'));b.close()
after=a.get('/rundown/state').json();assert all(before[k]==after[k] for k in ['revision','topics','paused','current_topic_id'])
(out/'parent-result.json').write_text(json.dumps({'passed':True,'checks':['UI capture','UI two dated days','independent note snapshots','upload byte readback','invalid upload rejects','reload','mobile','live preservation']},indent=2));print('Independent acceptance passed')
