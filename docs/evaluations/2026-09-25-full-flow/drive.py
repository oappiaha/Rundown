import sys,json,time
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
O=Path('/private/tmp/rundown-full-audit');(O/'frames').mkdir(exist_ok=True)
pw=sync_playwright().start();browser=pw.chromium.connect_over_cdp('http://127.0.0.1:8194');ctx=browser.contexts[0];page=next((p for p in ctx.pages if p.url=="http://127.0.0.1:8187/"),ctx.pages[0]);page.set_viewport_size({'width':1280,'height':900});page.set_default_timeout(5000)
def snap(label):
 page.wait_for_timeout(350)
 n=len(list((O/'frames').glob('*.png')))
 page.screenshot(path=str(O/'frames'/f'{n:03d}.png'))
 with (O/'frames.jsonl').open('a') as f:f.write(json.dumps({'frame':n,'label':label,'url':page.url})+'\n')
 print('FRAME',n,label,flush=True)
def b(name):return page.get_by_role('button',name=name,exact=True)
def l(name):return page.get_by_label(name,exact=True)
def show():print(page.locator('body').inner_text()[:10500])
try:exec(sys.stdin.read())
except Exception:
 snap('Audit interrupted: inspect state');show();raise
finally:browser.close();pw.stop()
