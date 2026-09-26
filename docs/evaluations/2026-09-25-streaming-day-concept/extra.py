from playwright.sync_api import sync_playwright,expect
from pathlib import Path
import json
O=Path('/private/tmp/rundown-day-concept')
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,executable_path='/Users/rei/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');c=b.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,reduced_motion='reduce');page=c.new_page();page.goto('http://127.0.0.1:3188/');page.wait_for_timeout(200)
 # old concept preferences and notes share the same storage key; fresh browser migration
 page.locator('#stage .card').first.get_by_role('button',name='Save story',exact=True).click()
 page.get_by_role('button',name='New topic',exact=True).click();page.get_by_role('button',name='Upload',exact=True).click()
 pdf=b'%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'
 page.get_by_label('Topic file',exact=True).set_input_files({'name':'reference.pdf','mimeType':'application/pdf','buffer':pdf});page.get_by_label('Topic title',exact=True).fill('Reference attachment');page.get_by_role('button',name='Create topic',exact=True).click();expect(page.locator('#stage .card').first).to_contain_text('Reference attachment');page.reload();page.wait_for_timeout(200)
 with page.expect_download() as info:page.locator('#stage .card').first.get_by_role('button',name='Open source',exact=True).click()
 dl=info.value;assert Path(dl.path()).read_bytes()==pdf
 # injected quota failure, real submit; new record must roll back
 page.get_by_role('button',name='New topic',exact=True).click();page.get_by_label('Topic title',exact=True).fill('Must not be lost silently')
 before=page.evaluate('JSON.stringify(window.__rundown.state)');page.evaluate('() => { Storage.prototype.setItem=function(){throw new DOMException("Quota full","QuotaExceededError")}; }');page.get_by_role('button',name='Create topic',exact=True).click();assert page.evaluate('JSON.stringify(window.__rundown.state)')==before;expect(page.locator('#toast')).to_contain_text('Storage is full');expect(page.get_by_label('Topic title',exact=True)).to_have_value('Must not be lost silently');page.reload()
 # saved-library chooser deduplicates and day invalid duration is rejected
 page.get_by_role('button',name='Streaming days',exact=True).click();page.get_by_label('Stream date',exact=True).fill('2026-09-27');page.get_by_label('Show name',exact=True).fill('Sunday');page.get_by_role('button',name='Create day',exact=True).click();page.locator('.pick-saved summary').click();page.locator('#savedPicker input[value="oner"]').check();page.get_by_role('button',name='Add selected',exact=True).click();assert page.locator('.day-item').count()==1
 page.locator('.pick-saved summary').click();assert page.locator('#savedPicker input[value="oner"]').is_disabled();page.get_by_role('button',name='Add selected',exact=True).click();assert page.locator('.day-item').count()==1
 spin=page.locator('.day-item input[type="number"]');spin.fill('0');spin.press('Tab');expect(spin).to_have_value('5')
 ta=page.locator('.day-note textarea');page.locator('.day-note summary').click();ta.fill('Personal angle');ta.press('ArrowDown');assert page.evaluate('window.__rundown.state.notes.oner')=='Personal angle';page.locator('#dayPanel .close').click()
 cdp=c.new_cdp_session(page);cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':190,'y':650}]})
 for y in [600,540,480,420,360,300,240,180]:cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':190,'y':y}]});page.wait_for_timeout(35)
 cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]});page.wait_for_timeout(500);assert page.locator('#stage').evaluate('(x)=>x.scrollTop')>400
 (O/'extra-results.json').write_text(json.dumps({'pdf_bytes_preserved_after_reload':True,'quota_failure_rolls_back_and_preserves_draft':True,'saved_picker_deduplicates':True,'invalid_duration_rejected':True,'day_note_saved':True,'touch_swipe_works':True},indent=2));b.close();print('EXTRA PASS')
