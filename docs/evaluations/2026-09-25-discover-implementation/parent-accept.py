import json, urllib.request, pathlib
from playwright.sync_api import sync_playwright, expect
OUT=pathlib.Path('/private/tmp/rundown-discover-parent')
API='http://127.0.0.1:8193'
def req(path, body=None):
    r=urllib.request.Request(API+path, data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'},method='GET' if body is None else 'PUT')
    return json.load(urllib.request.urlopen(r))
items=req('/inbox')['items']
item=next(i for i in items if i.get('presentation',{}).get('thumbnail'))
id=item['id']; title=item['source']['original_title']
before=req('/rundown/state')
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/Users/rei/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',headless=True)
    page=browser.new_page(viewport={'width':1440,'height':960})
    page.goto('http://127.0.0.1:3189')
    page.get_by_role('button',name='Discover',exact=True).click()
    page.get_by_role('tab',name='Explore',exact=True).click()
    card=page.locator(f'.dsc-card[data-id="{id}"]')
    expect(card).to_be_visible()
    card.get_by_role('button',name='Note: '+title,exact=True).click()
    note=card.get_by_role('textbox')
    note.fill('Independent browser acceptance note')
    card.get_by_role('button',name='Save note',exact=True).click()
    expect(card.get_by_role('button',name='Save note',exact=True)).to_be_disabled()
    assert req('/inbox/'+id)['editorial']['note']=='Independent browser acceptance note'
    note.fill('Keep this browser draft')
    remote=req('/inbox/'+id)['editorial']
    req('/inbox/'+id+'/editorial',dict(revision=remote['revision'],saved=remote['saved'],note='Other screen note'))
    page.get_by_role('button',name='Refresh topics',exact=True).click()
    expect(card.get_by_role('button',name='Keep mine and save again')).to_be_visible()
    expect(note).to_have_value('Keep this browser draft')
    expect(card.locator('.dsc-save')).to_be_disabled()
    assert req('/inbox/'+id)['editorial']['note']=='Other screen note'
    page.screenshot(path=str(OUT/'conflict.png'))
    card.get_by_role('button',name='Keep mine and save again').click()
    expect(card.get_by_role('button',name='Save note',exact=True)).to_be_disabled()
    assert req('/inbox/'+id)['editorial']['note']=='Keep this browser draft'
    page.reload()
    page.get_by_role('button',name='Discover',exact=True).click()
    page.get_by_role('tab',name='Explore',exact=True).click()
    page.screenshot(path=str(OUT/'explore.png'))
    page.get_by_role('tab',name='Focus',exact=True).click()
    page.screenshot(path=str(OUT/'focus.png'))
    page.set_viewport_size({'width':390,'height':844})
    page.wait_for_timeout(400)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(OUT/'mobile.png'))
    browser.close()
after=req('/inbox/'+id)
for field in ['source','notes','topic','source_url']:
    assert item[field]==after[field],field
live=req('/rundown/state')
for field in ['topics','current_topic_id','paused','revision']:
    assert before[field]==live[field],field
(OUT/'results.json').write_text(json.dumps({'passed':True,'topic':id,'checks':['real UI note save/readback','remote refresh conflict retains draft','explicit overwrite','reload','desktop/mobile screenshots','no horizontal overflow','source and live state preserved']},indent=2))
print('Independent acceptance passed')
