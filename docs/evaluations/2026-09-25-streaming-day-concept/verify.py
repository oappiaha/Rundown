from pathlib import Path
from playwright.sync_api import sync_playwright,expect
import json
O=Path('/private/tmp/rundown-day-concept');(O/'shots').mkdir(exist_ok=True)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,executable_path='/Users/rei/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
 c=b.new_context(viewport={'width':1440,'height':1000},reduced_motion='reduce');page=c.new_page();page.set_default_timeout(5000);errors=[];requests=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('request',lambda r:requests.append(r.url))
 def snap(n):page.wait_for_timeout(150);page.screenshot(path=str(O/'shots'/f'{n}.png'))
 def button(n):return page.get_by_role('button',name=n,exact=True)
 def close(panel):page.locator(panel).get_by_role('button',name='Close',exact=True).click()
 def create_day(date,name):
  if not page.locator('#dayForm').is_visible():page.locator('.day-new summary').click()
  page.get_by_label('Stream date',exact=True).fill(date);page.get_by_label('Show name',exact=True).fill(name);button('Create day').click()
 page.goto('http://127.0.0.1:3188/');page.wait_for_timeout(350)
 assert not errors,errors
 snap('01-discover')
 first=page.locator('#stage .card[data-id="oner"]');first.get_by_role('button',name='Save story',exact=True).click();first.get_by_role('button',name='Add a note',exact=True).click();first.get_by_role('textbox').fill('My opening thought stays with this topic.');page.wait_for_timeout(250)
 first.get_by_role('button',name='Add to streaming day',exact=True).click();create_day('2026-09-25','Friday live');button('Add to this day').click();assert page.locator('.day-item').count()==1;close('#dayPanel')
 page.locator('#stage .card[data-id="grid"]').get_by_role('button',name='Add to streaming day',exact=True).click();button('Add to this day').click();assert page.locator('.day-item').count()==2
 page.locator('.day-item').nth(1).get_by_role('button',name='Move topic up',exact=True).click();assert page.locator('.day-item').first.get_attribute('data-daytopic')=='grid'
 duration=page.locator('.day-item').first.get_by_role('spinbutton');duration.fill('8');duration.press('Tab');expect(page.locator('.day-deck')).to_contain_text('13 min');snap('02-friday-order')
 create_day('2026-09-26','Saturday conversations');assert page.locator('.day-item').count()==0
 button('＋ Create a topic for this day').click();page.get_by_label('Topic title',exact=True).fill('The audience chooses our next short film');page.get_by_label('Personal note',exact=True).fill('Ask chat to vote.');snap('03-create');button('Create topic').click();expect(page.locator('.day-list')).to_contain_text('The audience chooses');assert page.locator('.day-item').count()==1
 close('#dayPanel');button('New topic').click();button('Link').click();page.get_by_label('Source link',exact=True).fill('javascript:alert(1)');page.get_by_label('Topic title',exact=True).fill('Bad source');button('Create topic').click();expect(page.locator('#topicForm .form-error')).to_contain_text('http');assert page.evaluate('window.__rundown.state.custom.length')==1
 page.get_by_label('Source link',exact=True).fill('https://example.com/my-story');page.get_by_label('Topic title',exact=True).fill('A link worth discussing');button('Create topic').click();expect(page.locator('#stage')).to_contain_text('A link worth discussing')
 button('New topic').click();button('Upload').click();page.get_by_label('Topic file',exact=True).set_input_files({'name':'studio-notes.md','mimeType':'text/markdown','buffer':b'# Studio notes\nA practical filming idea for next weekend.'});page.get_by_label('Personal note',exact=True).fill('Compare this with our first experiment.');page.locator('[name="addToDay"]').check();snap('04-upload');button('Create topic').click();expect(page.locator('.day-list')).to_contain_text('studio-notes');assert page.locator('.day-item').count()==2
 close('#dayPanel');button('New topic').click();button('Upload').click();page.get_by_label('Topic file',exact=True).set_input_files({'name':'bad.exe','mimeType':'application/octet-stream','buffer':b'bad'});button('Create topic').click();expect(page.locator('#topicForm .form-error')).to_contain_text('valid TXT');assert page.evaluate('window.__rundown.state.custom.length')==3
 page.get_by_label('Topic file',exact=True).set_input_files({'name':'large.md','mimeType':'text/markdown','buffer':b'a'*1048577});button('Create topic').click();expect(page.locator('#topicForm .form-error')).to_contain_text('smaller than 1 MB');assert page.evaluate('window.__rundown.state.custom.length')==3
 page.get_by_label('Topic file',exact=True).set_input_files(str(O/'shots/01-discover.png'));page.get_by_label('Topic title',exact=True).fill('Visual reference');button('Create topic').click();expect(page.locator('#stage .card').first).to_contain_text('Visual reference');assert page.locator('#stage .card').first.locator('img').count()==1
 # switch days without contaminating their order
 button('Streaming days').click();days=page.evaluate('window.__rundown.state.days');friday=days[0]['id'];saturday=days[1]['id'];page.get_by_label('Streaming day',exact=True).select_option(friday);assert [x['id'] for x in page.evaluate('window.__rundown.state.days[0].topics')]==['grid','oner'];assert page.locator('.day-item').count()==2
 page.locator('.day-item').first.get_by_role('button',name='Remove from this day',exact=True).click();assert page.locator('.day-item').count()==1;assert 'oner' in page.evaluate('window.__rundown.state.saved');assert page.evaluate('window.__rundown.state.notes.oner')=='My opening thought stays with this topic.'
 page.get_by_label('Streaming day',exact=True).select_option(saturday);assert page.locator('.day-item').count()==2;close('#dayPanel');page.reload();page.wait_for_timeout(200);assert page.evaluate('window.__rundown.state.custom.length')==4
 button('Streaming days').click();assert page.locator('.day-item').count()==2;snap('05-saturday');page.set_viewport_size({'width':390,'height':844});snap('06-phone-day');assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');close('#dayPanel');snap('07-phone-feed');button('New topic').click();snap('08-phone-create');assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
 assert not errors,errors;assert all(x.startswith('http://127.0.0.1:3188/') or x.startswith('data:') for x in requests),requests
 (O/'results.json').write_text(json.dumps({'passed':True,'errors':errors,'requests':requests,'days':page.evaluate('window.__rundown.state.days'),'custom_count':page.evaluate('window.__rundown.state.custom.length'),'notes_preserved':True,'invalid_and_oversize_rejected':True},indent=2));b.close();print('PASS streaming days, reorder/duration, manual/link/text/image uploads, reload, isolation, negative inputs, mobile')
