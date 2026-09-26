import json
from pathlib import Path
import httpx
from playwright.sync_api import sync_playwright,expect
base='http://reis-mac-mini.taildb04a2.ts.net:8088';out=Path('/private/tmp/rundown-warm')
with httpx.Client(base_url=base,trust_env=False) as a:
 before=a.get('/rundown/state').json()
 errors=[]
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/Users/rei/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
  page=browser.new_page(viewport={'width':1280,'height':900});page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(base);assert page.evaluate('getComputedStyle(document.body).backgroundColor')=='rgb(245, 241, 232)';page.get_by_role('button',name='Discover',exact=True).click();expect(page.get_by_role('heading',name='Discover',exact=True)).to_be_visible()
  page.get_by_role('tab',name='Explore',exact=True).click();page.get_by_role('button',name='Streaming days',exact=True).click();expect(page.get_by_role('dialog',name='Streaming days')).to_be_visible();page.get_by_role('button',name='Close streaming days').click()
  page.get_by_role('button',name='New topic',exact=True).click();s=page.get_by_role('dialog',name='New topic');s.get_by_label('Topic title').fill('Unsaved deployment check');page.keyboard.press('Escape');expect(s).not_to_be_visible()
  page.set_viewport_size({'width':390,'height':844});assert page.evaluate('document.documentElement.scrollWidth <= innerWidth');page.screenshot(path=str(out/'deployed-mobile.png'))
  overlay=browser.new_page();responses=[];overlay.on('response',lambda r:responses.append((r.url,r.status)));overlay.goto(base+'/static/overlay.html');overlay.wait_for_timeout(1800);assert any('/rundown/' in u and status==200 for u,status in responses)
  browser.close()
 after=a.get('/rundown/state').json();assert all(before[k]==after[k] for k in ['revision','topics','current_topic_id','paused']);assert not errors,errors
(out/'result.json').write_text(json.dumps({'passed':True,'url':base,'checks':['managed restart health','compiled UI served','Discover Explore','Days drawer','capture draft and Escape','mobile width','overlay polls API','live state preserved'],'scope':'Browser on Mac mini; MacBook and real OBS not yet verified'},indent=2));print('Deployment browser smoke passed')
