import asyncio,json
from pathlib import Path
import httpx
from playwright.async_api import async_playwright,expect
O=Path('/private/tmp/rundown-link-preview')
async def main():
 async with async_playwright() as p:
  b=await p.chromium.launch(executable_path='/Users/rei/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
  page=await b.new_page(viewport={'width':1280,'height':900});await page.goto('http://127.0.0.1:3189');await page.get_by_role('button',name='Discover',exact=True).click();await page.get_by_role('button',name='New topic',exact=True).click();s=page.get_by_role('dialog',name='New topic');await s.get_by_role('button',name='Link',exact=True).click()
  url='http://127.0.0.1:8192/articles/offwhite.html'
  await s.get_by_label('Source link').fill(url)
  seen=asyncio.Event()
  async def slow(route):
   response=await route.fetch();seen.set();await asyncio.sleep(1.5);await route.fulfill(response=response)
  await page.route('**/link-previews/preview',slow)
  await s.get_by_role('button',name='Preview',exact=True).click();await seen.wait();await s.get_by_label('Topic title').fill('My title typed while loading');await s.get_by_label('Personal note').fill('Keep this exact note')
  await expect(s.get_by_test_id('dsc-preview')).to_be_visible();await expect(s.get_by_label('Topic title')).to_have_value('My title typed while loading')
  await expect(s.get_by_label('Personal note')).to_have_value('Keep this exact note');await s.screenshot(path=str(O/'parent-preview.png'))
  await s.get_by_role('button',name='Create with preview',exact=True).click();c=page.get_by_role('article',name='My title typed while loading',exact=True);await expect(c).to_be_visible();await c.locator('img').evaluate('(img)=>img.decode()');await page.screenshot(path=str(O/'parent-saved.png'))
  async with httpx.AsyncClient(base_url='http://127.0.0.1:8193') as a:
   items=(await a.get('/inbox')).json()['items'];i=next(x for x in items if (x.get('capture') or {}).get('display_title')=='My title typed while loading');assert i['editorial']['note']=='Keep this exact note';assert i['source']['kind']=='article';assert i['source_url']==url
  await page.reload();await page.get_by_role('button',name='Discover',exact=True).click();await expect(page.get_by_role('article',name='My title typed while loading',exact=True)).to_be_visible();await page.set_viewport_size({'width':390,'height':844});await page.get_by_role('button',name='New topic',exact=True).click();assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth');await page.screenshot(path=str(O/'parent-mobile.png'))
  await b.close()
 (O/'parent-browser-result.json').write_text(json.dumps({'passed':True,'checks':['real API-backed delayed preview','typed title and note survive response','preview save -> card image decoded','API provenance/editorial readback','reload','mobile capture width']},indent=2));print('Independent browser acceptance passed')
asyncio.run(main())
