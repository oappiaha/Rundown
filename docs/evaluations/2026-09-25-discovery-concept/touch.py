import json
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
O=Path('/private/tmp/rundown-ui-acceptance')
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,executable_path='/Users/rei/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
 c=b.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,reduced_motion='reduce');page=c.new_page();page.goto('http://127.0.0.1:3187/');page.wait_for_timeout(400)
 s=c.new_cdp_session(page)
 s.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':195,'y':700}]})
 for y in [660,610,550,490,430,370,310,250,210]:
  s.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':195,'y':y}]});page.wait_for_timeout(40)
 s.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]});page.wait_for_timeout(700)
 top=page.locator('#stage').evaluate('(e)=>e.scrollTop');assert top>500,top
 page.screenshot(path=str(O/'phone-swipe.png'))
 page.get_by_role('tab',name='Explore').click();page.wait_for_timeout(200)
 tile=page.locator('#stage .tile[data-id="grid"]');tile.focus();page.keyboard.press('Enter');page.wait_for_timeout(300)
 assert page.locator('#reader .reader-story').get_attribute('data-id')=='grid'
 page.keyboard.press('Escape');assert page.locator('#reader').get_attribute('aria-hidden')=='true'
 assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
 (O/'touch-result.json').write_text(json.dumps({'touch_scroll_top':top,'enter_opens_correct_story':True,'escape_closes_reader':True,'mobile_no_overflow':True},indent=2));b.close();print('TOUCH AND ENTER PASS')
