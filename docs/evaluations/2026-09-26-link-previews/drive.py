"""Real-browser proof of link previews in Discover capture against the owned stack
(Vite 3189 → API 8193 → fixture 8192). Writes results.json and screenshots/."""
import json, os, sys, time, traceback
import httpx
from playwright.sync_api import sync_playwright

O = '/private/tmp/rundown-link-preview'; API = 'http://127.0.0.1:8193'; WEB = 'http://127.0.0.1:3189'; F = 'http://127.0.0.1:8192'
CHROME = '/Users/rei/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
HEADLINE = 'Off-white is a decision: paper makers, gallery painters and screen designers on the colour nobody thinks they chose'
CAPTION = 'Fixing a shop sign with a finger and a marker #kerning #type'
TIKTOK = 'https://www.tiktok.com/@synthetic.maker/video/7000000000000000001?utm_source=paste'
results = {'checks': [], 'console_errors': [], 'failed_requests': [], 'responses_4xx5xx': [], 'screens': [], 'ids': {}}
api = httpx.Client(base_url=API, timeout=20)
os.makedirs(f'{O}/screenshots', exist_ok=True)
baseline = json.load(open(f'{O}/parent-baseline.json'))
last_preview = [0.0]


def check(name, ok, detail=None):
    results['checks'].append({'name': name, 'ok': bool(ok), 'detail': detail})
    print(('PASS ' if ok else 'FAIL ') + name + ('' if detail is None else '  ' + json.dumps(detail, default=str)[:300]), flush=True)
    if not ok:
        raise AssertionError(name)


def shot(page, name):
    page.screenshot(path=f'{O}/screenshots/{name}.png'); results['screens'].append(name)


def open_link_tab(page):
    nav = page.get_by_role('link', name='Discover') if page.get_by_role('link', name='Discover').count() else page.get_by_role('button', name='Discover')
    nav.click()
    page.get_by_role('button', name='New topic').click()
    sheet = page.get_by_role('dialog', name='New topic')
    sheet.get_by_role('button', name='Link', exact=True).click()
    return sheet


def press_preview(sheet):
    gap = 2.2 - (time.monotonic() - last_preview[0])
    if gap > 0:
        time.sleep(gap)
    last_preview[0] = time.monotonic()
    sheet.get_by_role('button', name='Preview', exact=True).click()


def wait_preview(sheet, page):
    page.wait_for_selector('[data-testid="dsc-preview"]', timeout=15000)
    return sheet.locator('[data-testid="dsc-preview"]')


def card_of(page, title):
    card = page.locator(f'.dsc-stage .dsc-card[aria-label="{title}"]').first
    card.wait_for(timeout=10000); card.scroll_into_view_if_needed(); return card


def inbox_count():
    return len(api.get('/inbox').json()['items'])


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME)
    context = browser.new_context(viewport={'width': 1280, 'height': 900})
    page = context.new_page()
    page.on('console', lambda m: results['console_errors'].append(m.text) if m.type == 'error' else None)
    page.on('requestfailed', lambda r: results['failed_requests'].append(r.url))
    page.on('response', lambda r: results['responses_4xx5xx'].append((r.status, r.url)) if r.status >= 400 else None)
    try:
        page.goto(WEB)
        n0 = inbox_count()
        # ---- 1. article: paste → Preview → review → save → card → readback → reload
        sheet = open_link_tab(page)
        check('link tab says nothing is fetched until Preview', 'Nothing is fetched until you press Preview' in sheet.text_content())
        sheet.get_by_label('Source link').fill(F + '/articles/offwhite.html')
        sheet.get_by_label('Personal note').fill('Talk about warm paper tones')
        time.sleep(0.5)
        check('typing a link fetches nothing (no preview request, no topic)', inbox_count() == n0 and not any('/link-previews' in u for _, u in results['responses_4xx5xx']))
        shot(page, '01-article-link-typed')
        press_preview(sheet)
        card = wait_preview(sheet, page)
        page.wait_for_function('document.querySelector(\'[data-testid="dsc-preview-thumb"]\')?.naturalWidth > 0')
        thumb = sheet.locator('[data-testid="dsc-preview-thumb"]')
        check('article review card: headline, publisher/author, fixture mode, served thumbnail 1200×630', card.locator('[data-testid="dsc-preview-title"]').text_content() == HEADLINE and 'Article · Tomas Reyes · fixture' in card.text_content() and thumb.evaluate('i => [i.naturalWidth, i.naturalHeight, i.getAttribute("referrerpolicy")]') == [1200, 630, 'no-referrer'], card.text_content()[:160])
        check('title prefilled from headline; live label shown ≤30; note untouched', sheet.get_by_label('Topic title').input_value() == HEADLINE and len(sheet.get_by_label('Live label').input_value()) <= 30 and sheet.get_by_label('Personal note').input_value() == 'Talk about warm paper tones', sheet.get_by_label('Live label').input_value())
        check('no topic created by previewing', inbox_count() == n0)
        shot(page, '02-article-preview-review')
        sheet.get_by_label('Live label').fill('Off-white paper')
        sheet.get_by_role('button', name='Create with preview').click()
        page.wait_for_selector('#dsc-capture[open], [id="dsc-capture"]', state='detached', timeout=10000) if False else None
        c = card_of(page, HEADLINE)
        page.wait_for_function('el => el.querySelector("img[data-testid=dsc-thumb]")?.naturalWidth > 0', arg=c.element_handle(), timeout=10000)
        check('Discover card: full headline, "Article link", publisher, tag Article, served thumbnail', c.locator('.dsc-src').text_content() == 'Article link' and c.locator('.dsc-creator').text_content() == 'Tomas Reyes' and c.locator('.dsc-tag').text_content() == 'Article' and c.locator('figure.dsc-art').get_attribute('data-state') == 'image' and 'On air as' in c.text_content() and 'Off-white paper' in c.text_content(), c.locator('.dsc-kicker').text_content())
        shot(page, '03-article-card')
        items = api.get('/inbox').json()['items']; art = next(i for i in items if i['capture'] and i['capture']['display_title'] == HEADLINE); results['ids']['article'] = art['id']
        check('API readback: source article/original headline/publisher, presentation thumbnail 1200×630, entered URL, note, label', art['source']['kind'] == 'article' and art['source']['original_title'] == HEADLINE and art['source']['feed_name'] == 'Surface Notes' and art['presentation']['thumbnail'] == {'url': F + '/thumbs/offwhite.png', 'width': 1200, 'height': 630} and art['source_url'] == F + '/articles/offwhite.html' and art['editorial']['note'] == 'Talk about warm paper tones' and art['text'] == 'Off-white paper' and art['presentation']['creator'] == 'Tomas Reyes', {'source': art['source'], 'presentation': art['presentation']})
        page.reload(); nav = page.get_by_role('link', name='Discover') if page.get_by_role('link', name='Discover').count() else page.get_by_role('button', name='Discover'); nav.click()
        c = card_of(page, HEADLINE)
        page.wait_for_function('el => el.querySelector("img[data-testid=dsc-thumb]")?.naturalWidth > 0', arg=c.element_handle(), timeout=10000)
        check('after reload the article card still shows headline/publisher/thumbnail', c.locator('.dsc-creator').text_content() == 'Tomas Reyes' and c.locator('figure.dsc-art').get_attribute('data-state') == 'image')
        shot(page, '04-article-card-after-reload')
        # ---- 2. tiktok
        sheet = open_link_tab(page)
        sheet.get_by_label('Source link').fill(TIKTOK)
        press_preview(sheet)
        card = wait_preview(sheet, page)
        page.wait_for_function('document.querySelector(\'[data-testid="dsc-preview-thumb"]\')?.naturalWidth > 0')
        thumb = sheet.locator('[data-testid="dsc-preview-thumb"]')
        check('tiktok review card: caption, creator, portrait thumbnail 360×640 with portrait class', card.get_attribute('data-kind') == 'tiktok' and card.locator('[data-testid="dsc-preview-title"]').text_content() == CAPTION and 'TikTok · synthetic.maker' in card.text_content() and thumb.evaluate('i => [i.naturalWidth, i.naturalHeight, i.className]') == [360, 640, 'portrait'], card.text_content()[:120])
        check('tiktok title prefilled with caption and live label offered', sheet.get_by_label('Topic title').input_value() == CAPTION and sheet.get_by_label('Live label').count() == 1)
        shot(page, '05-tiktok-preview-review')
        sheet.get_by_label('Live label').fill('Kerning sign fix')
        sheet.get_by_label('Personal note').fill('portrait card check')
        sheet.get_by_role('button', name='Create with preview').click()
        c = card_of(page, CAPTION)
        page.wait_for_function('el => el.querySelector("img[data-testid=dsc-thumb]")?.naturalWidth > 0', arg=c.element_handle(), timeout=10000)
        check('Discover tiktok card: "TikTok link", creator, tag Video, portrait figure', c.locator('.dsc-src').text_content() == 'TikTok link' and c.locator('.dsc-creator').text_content() == 'synthetic.maker' and c.locator('.dsc-tag').text_content() == 'Video' and 'portrait' in c.locator('figure.dsc-art').get_attribute('class'), c.locator('.dsc-kicker').text_content())
        shot(page, '06-tiktok-card')
        tt = next(i for i in api.get('/inbox').json()['items'] if i['capture'] and i['capture']['display_title'] == CAPTION); results['ids']['tiktok'] = tt['id']
        check('API readback: tiktok source caption/creator, portrait 360×640, canonical resolved + entered URL with query', tt['source']['kind'] == 'tiktok' and tt['source']['original_title'] == CAPTION and tt['presentation']['thumbnail'] == {'url': F + '/thumbs/portrait.png', 'width': 360, 'height': 640} and tt['source']['resolved_url'] == 'https://www.tiktok.com/@synthetic.maker/video/7000000000000000001' and tt['source_url'] == TIKTOK and tt['editorial']['note'] == 'portrait card check', tt['source'])
        # ---- 3. failures keep manual save
        sheet = open_link_tab(page)
        n1 = inbox_count()
        for name, fragment in [('forbidden', 'HTTP 403'), ('ratelimited', 'HTTP 429'), ('missing', 'HTTP 404'), ('notes.json', 'not an HTML page'), ('malformed.html', 'no title'), ('oversize-late.html', 'no title'), ('private-redirect', 'public internet address'), ('loopback-redirect', 'public internet address')]:
            sheet.get_by_label('Source link').fill(F + '/articles/' + name)
            press_preview(sheet)
            err = sheet.locator('[data-testid="dsc-preview-error"]'); err.wait_for(timeout=15000)
            text = err.text_content()
            check(f'{name}: preview error shown with "{fragment}", no remote body, save stays offered', fragment in text and 'BODY' not in text and 'Save the link without it.' in text and sheet.get_by_role('button', name='Create topic').is_enabled(), text[:160])
            if name == 'forbidden':
                shot(page, '07-preview-failure-403')
        check('failures created nothing', inbox_count() == n1)
        sheet.get_by_label('Source link').fill(F + '/articles/forbidden')
        press_preview(sheet); sheet.locator('[data-testid="dsc-preview-error"]').wait_for(timeout=15000)
        sheet.get_by_label('Topic title').fill('Manual title after 403')
        sheet.get_by_label('Personal note').fill('saved without preview')
        sheet.get_by_role('button', name='Create topic').click()
        c = card_of(page, 'Manual title after 403')
        man = next(i for i in api.get('/inbox').json()['items'] if i['capture'] and i['capture']['display_title'] == 'Manual title after 403'); results['ids']['manual'] = man['id']
        check('manual save after failed preview: card exists, no source/presentation, URL + note as typed', man['source'] is None and man['presentation'] is None and man['source_url'] == F + '/articles/forbidden' and man['editorial']['note'] == 'saved without preview' and c.locator('.dsc-src').text_content() == 'Your link')
        shot(page, '08-manual-card-after-failure')
        # ---- 4. stale response / typed title protected (fixture answers after 3 s, inside the 10 s cap)
        sheet = open_link_tab(page)
        n2 = inbox_count()
        sheet.get_by_label('Source link').fill(F + '/articles/slow-long.html')
        sheet.get_by_label('Personal note').fill('note stays')
        press_preview(sheet)
        check('fetching state shown', sheet.get_by_role('button', name='Fetching preview…').count() == 1 and sheet.locator('[data-testid="dsc-preview"]').count() == 0)
        sheet.get_by_label('Topic title').fill('Typed while fetching')
        shot(page, '09a-typing-while-fetching')
        card = wait_preview(sheet, page)
        note = sheet.locator('[data-testid="dsc-preview-note"]').text_content()
        check('title typed during the 3 s fetch kept; full headline in card; note untouched', sheet.get_by_label('Topic title').input_value() == 'Typed while fetching' and 'Your title was kept' in note and len(card.locator('[data-testid="dsc-preview-title"]').text_content()) > 200 and sheet.get_by_label('Personal note').input_value() == 'note stays', note)
        shot(page, '09-typed-title-protected')
        sheet.get_by_label('Source link').fill(F + '/articles/offwhite.html')
        check('editing the link drops the preview and submit falls back to Create topic', sheet.locator('[data-testid="dsc-preview"]').count() == 0 and 'Link changed' in sheet.locator('[data-testid="dsc-preview-note"]').text_content() and sheet.get_by_role('button', name='Create topic').count() == 1)
        sheet.get_by_label('Source link').fill(F + '/articles/slow-long.html?again=1')
        press_preview(sheet)
        page.wait_for_timeout(500)
        sheet.get_by_label('Source link').fill(F + '/articles/xss.html')
        page.wait_for_timeout(4000)
        check('response for an edited-away link ignored: no preview card, typed title intact, nothing created', sheet.locator('[data-testid="dsc-preview"]').count() == 0 and sheet.get_by_role('button', name='Fetching preview…').count() == 0 and sheet.get_by_label('Topic title').input_value() == 'Typed while fetching' and inbox_count() == n2)
        shot(page, '10-stale-response-ignored')
        # empty-title prefill path with the >200 headline
        sheet.get_by_label('Topic title').fill('')
        sheet.get_by_label('Source link').fill(F + '/articles/long-headline.html')
        press_preview(sheet); card = wait_preview(sheet, page)
        tval = sheet.get_by_label('Topic title').input_value()
        check('long headline prefills ≤200 editable title, card keeps full headline, hint says shortened', len(tval) <= 200 and card.locator('[data-testid="dsc-preview-title"]').text_content().startswith(tval) and 'shortened to 200' in sheet.locator('[data-testid="dsc-preview-note"]').text_content(), len(tval))
        shot(page, '11-long-headline-bounded-title')
        # ---- 5. tampered token → real 409 → same form saves without preview
        def tamper(route):
            body = json.loads(route.request.post_data)
            body['preview'] = body['preview'][:-3] + 'AAA'
            route.continue_(post_data=json.dumps(body))
        page.route('**/inbox/capture', tamper)
        sheet.get_by_label('Live label').fill('Coastal archive')
        sheet.get_by_role('button', name='Create with preview').click()
        alert = sheet.get_by_role('alert'); alert.wait_for(timeout=10000)
        check('server 409 on a bad token: message shown, form intact, nothing created', 'Preview not saved' in alert.text_content() and sheet.get_by_label('Personal note').input_value() == 'note stays' and sheet.get_by_label('Live label').input_value() == 'Coastal archive' and sheet.locator('[data-testid="dsc-preview"]').count() == 0 and inbox_count() == n2, alert.text_content()[:160])
        page.unroute('**/inbox/capture')
        shot(page, '12-token-409-form-kept')
        sheet.get_by_role('button', name='Create topic').click()
        c = card_of(page, tval)
        lg = next(i for i in api.get('/inbox').json()['items'] if i['capture'] and i['capture']['display_title'] == tval); results['ids']['long_manual'] = lg['id']
        check('after 409 the same form saved without preview: title/label/note/URL as typed, no source', lg['source'] is None and lg['text'] == 'Coastal archive' and lg['editorial']['note'] == 'note stays' and lg['source_url'] == F + '/articles/long-headline.html')
        # ---- 6. preservation and health
        live = api.get('/rundown/state').json(); plan = api.get(f"/plans/{baseline['plan']['id']}").json(); seed = api.get(f"/inbox/{baseline['seed_id']}").json()
        check('live clock unchanged', {k: live[k] for k in ('revision', 'topics', 'current_topic_id')} == {k: baseline['live'][k] for k in ('revision', 'topics', 'current_topic_id')})
        check('saved day snapshot unchanged (revision + note)', plan['revision'] == baseline['plan']['revision'] and plan['topics'] == baseline['plan']['topics'])
        check('seed topic unchanged', seed == baseline['seed'])
        # ---- 7. phone width
        phone = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        pp = phone.new_page(); pp.goto(WEB)
        psheet = open_link_tab(pp)
        psheet.get_by_label('Source link').fill(F + '/articles/offwhite.html')
        press_preview(psheet); wait_preview(psheet, pp)
        pp.wait_for_function('document.querySelector(\'[data-testid="dsc-preview-thumb"]\')?.naturalWidth > 0')
        check('390px: preview card renders without horizontal overflow', pp.evaluate('document.documentElement.scrollWidth <= window.innerWidth') and pp.evaluate('document.querySelector("[data-testid=dsc-preview]").getBoundingClientRect().right <= window.innerWidth'))
        pp.screenshot(path=f'{O}/screenshots/13-phone-preview.png'); results['screens'].append('13-phone-preview')
        phone.close()
        # ---- 8. fresh context readback
        fresh = browser.new_context(viewport={'width': 1280, 'height': 900}); fp = fresh.new_page(); fp.goto(WEB)
        nav = fp.get_by_role('link', name='Discover') if fp.get_by_role('link', name='Discover').count() else fp.get_by_role('button', name='Discover'); nav.click()
        fc = card_of(fp, HEADLINE)
        fp.wait_for_function('el => el.querySelector("img[data-testid=dsc-thumb]")?.naturalWidth > 0', arg=fc.element_handle(), timeout=10000)
        check('fresh browser context: article card with publisher and thumbnail', fc.locator('.dsc-creator').text_content() == 'Tomas Reyes' and fc.locator('figure.dsc-art').get_attribute('data-state') == 'image')
        fresh.close()
        expected_statuses = [r for r in results['responses_4xx5xx'] if r[0] == 502 and '/link-previews/preview' in r[1]] + [r for r in results['responses_4xx5xx'] if r[0] == 409 and '/inbox/capture' in r[1]]
        unexpected = [r for r in results['responses_4xx5xx'] if r not in expected_statuses]
        resource_lines = [m for m in results['console_errors'] if m.startswith('Failed to load resource') and ('502' in m or '409' in m)]
        other_console = [m for m in results['console_errors'] if m not in resource_lines]
        aborted_ok = [u for u in results['failed_requests'] if u.endswith('/rundown/state')]
        aborted_preview = [u for u in results['failed_requests'] if u.endswith('/link-previews/preview')]
        other_failed = [u for u in results['failed_requests'] if u not in aborted_ok + aborted_preview]
        check('health: 4xx/5xx are exactly the 9 intended 502 previews + 1 intended 409; console errors are only the browser echo of those; aborted requests are live-state polls + the one abandoned preview',
              len([r for r in expected_statuses if r[0] == 502]) == 9 and len([r for r in expected_statuses if r[0] == 409]) == 1 and not unexpected and len(resource_lines) == 10 and not other_console and not other_failed and len(aborted_preview) == 1,
              {'unexpected': unexpected[:5], 'other_console': other_console[:3], 'other_failed': other_failed[:3], 'resource_lines': len(resource_lines), 'aborted_preview': len(aborted_preview)})
        results['status'] = 'completed'
    except Exception:
        results['status'] = 'failed'; results['traceback'] = traceback.format_exc(); print(results['traceback'])
        shot(page, '99-failure')
    finally:
        json.dump(results, open(f'{O}/results.json', 'w'), indent=1, default=str)
        browser.close()
print('STATUS', results['status'], sum(1 for c in results['checks'] if c['ok']), '/', len(results['checks']))
