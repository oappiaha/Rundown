import sys,json,time
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
O=Path('/private/tmp/rundown-ui-acceptance'); (O/'frames').mkdir(exist_ok=True)
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path='/Users/rei/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
 context=browser.new_context(viewport={'width':1440,'height':1000},device_scale_factor=1)
 page=context.new_page(); errors=[];requests=[]
 page.on('pageerror',lambda error:errors.append(str(error)))
 page.on('request',lambda request:requests.append(request.url))
 page.set_default_timeout(6000)
 def snap(label):
  page.wait_for_timeout(350)
  n=len(list((O/'frames').glob('*.png')))
  page.screenshot(path=str(O/'frames'/f'{n:03}.png'))
  with (O/'frames.jsonl').open('a') as f:f.write(json.dumps({'frame':n,'label':label})+'\n')
  print(label,flush=True)
 def b(name):return page.get_by_role('button',name=name,exact=True)
 page.goto('http://127.0.0.1:3187/')
 try:exec(sys.stdin.read())
 finally:
  (O/'browser-result.json').write_text(json.dumps({'errors':errors,'requests':requests},indent=2))
  browser.close()
