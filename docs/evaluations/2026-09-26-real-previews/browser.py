import json,time
from pathlib import Path
import httpx
from playwright.sync_api import sync_playwright,expect
O=Path('/private/tmp/rundown-real-previews');rows=json.loads((O/'api-results.json').read_text());a=httpx.Client(base_url='http://127.0.0.1:8193',trust_env=False)
before=a.get('/rundown/state').json();plans=a.get('/plans').json();errors=[];checks=[]
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/Users/rei/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');page=b.new_page(viewport={'width':1280,'height':900});page.on('pageerror',lambda e:errors.append(str(e)));page.goto('http://127.0.0.1:3189');page.get_by_role('button',name='Discover',exact=True).click()
 for i,row in enumerate(rows):
  title=['Jev decisions','Blender workflows','TikTok example'][i]
  page.get_by_role('button',name='New topic',exact=True).click();s=page.get_by_role('dialog',name='New topic');s.get_by_role('button',name='Link',exact=True).click();s.get_by_label('Source link').fill(row['url']);s.get_by_label('Topic title').fill(title);s.get_by_label('Personal note').fill('My angle stays mine')
  s.get_by_role('button',name='Preview',exact=True).click();expect(s.get_by_test_id('dsc-preview')).to_be_visible(timeout=20000);expect(s.get_by_label('Topic title')).to_have_value(title);expect(s.get_by_label('Personal note')).to_have_value('My angle stays mine')
  img=s.get_by_test_id('dsc-preview-thumb');img.evaluate('(i)=>i.decode()');dimensions=img.evaluate('(i)=>[i.naturalWidth,i.naturalHeight]');assert min(dimensions)>0
  s.screenshot(path=str(O/f'{i}-preview.png'));s.get_by_role('button',name='Create with preview',exact=True).click();c=page.get_by_role('article',name=title,exact=True);expect(c).to_be_visible();c.locator('img').evaluate('(i)=>i.decode()');page.screenshot(path=str(O/f'{i}-saved.png'))
  items=a.get('/inbox').json()['items'];item=next(x for x in items if (x.get('capture') or {}).get('display_title')==title);assert item['source_url']==row['url'];assert item['editorial']['note']=='My angle stays mine';assert item['source']['kind']==row['response']['kind'];assert item['source']['original_title']==row['response']['title']
  page.reload();page.get_by_role('button',name='Discover',exact=True).click();expect(page.get_by_role('article',name=title,exact=True)).to_be_visible();checks.append({'title':title,'image_dimensions':dimensions,'preview_save_readback_reload':True});time.sleep(2.1)
 page.get_by_role('button',name='New topic',exact=True).click();s=page.get_by_role('dialog',name='New topic');s.get_by_role('button',name='Link',exact=True).click();s.get_by_label('Source link').fill('http://127.0.0.1:1/blocked');s.get_by_role('button',name='Preview',exact=True).click();expect(s.get_by_test_id('dsc-preview-error')).to_be_visible();s.get_by_label('Topic title').fill('Manual fallback');s.get_by_role('button',name='Create topic',exact=True).click();expect(page.get_by_role('article',name='Manual fallback',exact=True)).to_be_visible()
 page.set_viewport_size({'width':390,'height':844});assert page.evaluate('document.documentElement.scrollWidth <= innerWidth');page.screenshot(path=str(O/'mobile.png'))
 fresh=b.new_page();fresh.goto('http://127.0.0.1:3189');fresh.get_by_role('button',name='Discover',exact=True).click();expect(fresh.get_by_role('article',name='TikTok example',exact=True)).to_be_visible();b.close()
after=a.get('/rundown/state').json();assert all(before[k]==after[k] for k in ['revision','topics','current_topic_id','paused']);assert a.get('/plans').json()==plans;assert not errors,errors
(O/'browser-results.json').write_text(json.dumps({'passed':True,'sources':checks,'manual_fallback':True,'fresh_page':True,'mobile':True,'plans_live_preserved':True,'page_errors':errors},indent=2));print('All three real previews, images, save, reload and fallback passed')
