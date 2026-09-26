"""Real-browser + API proof of the Discover slice against the owned stack.
Writes results.json and screenshots/. Fails loudly on any unmet check."""
import json
import sys
import time
import traceback
from uuid import uuid4

import httpx
from playwright.sync_api import sync_playwright

O = '/private/tmp/rundown-discover-implementation'
API = 'http://127.0.0.1:8193'
WEB = 'http://127.0.0.1:3189'
CHROME = '/Users/rei/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
YT_TITLE = 'Why the long take came back: how one-shot scenes went from stunt to scheduling decision'
ART_TITLE = 'Off-white is a decision: paper makers, gallery painters and screen designers on the colour nobody thinks they chose'
BROKEN_YT = 'How a foley artist builds a footstep (broken thumbnail on purpose)'
NOIMG_YT = 'The grid that ran a newspaper for forty years (no thumbnail offered)'
BROKEN_ART = 'Article whose cover image returns 404'

results = {'checks': [], 'api': {}, 'console_errors': [], 'failed_requests': []}
api = httpx.Client(base_url=API, timeout=20)


def check(name, ok, detail=None):
    results['checks'].append({'name': name, 'ok': bool(ok), 'detail': detail})
    print(('PASS ' if ok else 'FAIL ') + name + ('' if detail is None else f'  {json.dumps(detail)[:300]}'), flush=True)
    if not ok:
        raise AssertionError(name)


def card(page, title):
    return page.get_by_role('article', name=title)


def open_discover(page):
    page.goto(WEB + '/')
    page.get_by_role('button', name="Tonight's Show").wait_for()
    page.get_by_role('button', name='Discover').click()
    page.get_by_role('heading', name=YT_TITLE).wait_for(timeout=15000)


def run():
    # ---- 5a. live show running before anything else -------------------------
    live = api.put('/rundown/schedule', json={'revision': 0, 'topics': [{'text': 'On air', 'duration': 3600, 'notes': 'Already live'}]}).json()
    api.post('/rundown/control', json={'revision': live['revision'], 'action': 'play'})
    before = api.get('/rundown/state').json()
    t0 = time.time()
    results['api']['live_before'] = before
    check('live show is playing before imports', not before['paused'] and before['current_topic_id'] is not None)

    # ---- 1. real imports through the API (both providers) -----------------
    src = api.post('/retrieval', json={'name': 'Film craft', 'platform': 'youtube', 'query': 'long take'}).json()
    run1 = api.post(f"/retrieval/{src['id']}/import", json={'revision': src['revision'], 'request_id': str(uuid4())}).json()
    results['api']['youtube_import'] = run1
    check('YouTube fixture import succeeded with 3 topics', run1['status'] == 'succeeded' and run1['created'] == 3, run1)
    feed = api.post('/feeds', json={'name': 'Surface Notes', 'url': 'http://127.0.0.1:8192/feed.xml', 'default_duration': 120}).json()
    run2 = api.post(f"/feeds/{feed['id']}/import", json={'revision': feed['revision']}).json()
    results['api']['rss_import'] = run2
    check('RSS fixture import succeeded with 4 topics', run2['status'] == 'succeeded' and run2['created'] == 4, {k: run2[k] for k in ['status', 'created', 'duplicates', 'skipped', 'error']})
    items = api.get('/inbox').json()['items']
    by_title = {i['source']['original_title']: i for i in items if i['source']}
    results['api']['inbox_after_import'] = items
    yt = by_title[YT_TITLE]
    art = by_title[ART_TITLE]
    check('YouTube presentation readback: creator + served thumbnail + full title kept', yt['presentation']['creator'] == 'Frame & Field'
          and yt['presentation']['thumbnail'] == {'url': 'http://127.0.0.1:8192/thumbs/long-take.png', 'width': 480, 'height': 360}
          and yt['source']['original_title'] == YT_TITLE and len(yt['text']) == 30 and yt['source_url'] == 'https://www.youtube.com/watch?v=vid00000001', yt['presentation'])
    check('RSS presentation readback: author + media:thumbnail', art['presentation']['creator'] == 'Tomas Reyes'
          and art['presentation']['thumbnail']['url'] == 'http://127.0.0.1:8192/thumbs/offwhite.png' and art['presentation']['thumbnail']['width'] == 1200, art['presentation'])
    check('unsafe/malformed YouTube thumbnail dropped, topic kept (partial)', by_title[NOIMG_YT]['presentation']['state'] == 'partial' and by_title[NOIMG_YT]['presentation']['thumbnail'] is None)
    check('portrait RSS media:content retained with dimensions', by_title['Kerning in twelve seconds (portrait cover)']['presentation']['thumbnail'] == {'url': 'http://127.0.0.1:8192/thumbs/portrait.png', 'width': 180, 'height': 320})
    check('all imported items start with default editorial', all(i['editorial'] == {'revision': 0, 'saved': False, 'note': '', 'updated_at': None} for i in items))
    yt_frozen = {k: yt[k] for k in ['revision', 'text', 'notes', 'source_url', 'source', 'topic', 'updated_at', 'presentation']}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=CHROME, headless=True)

        def new_page(viewport):
            ctx = browser.new_context(viewport=viewport, device_scale_factor=1)
            pg = ctx.new_page()
            pg.on('console', lambda m: results['console_errors'].append(m.text) if m.type == 'error' else None)
            pg.on('requestfailed', lambda r: results['failed_requests'].append(r.url))
            return ctx, pg

        # ---- 1b. desktop browser: Discover shows full title + real thumbnail ----
        ctx, page = new_page({'width': 1280, 'height': 800})
        open_discover(page)
        check('Discover nav opens the Discover surface with the full YouTube headline', page.get_by_role('heading', name=YT_TITLE).is_visible())
        # Newest-first list: the YouTube card is below the fold, so its lazy thumbnail is only fetched once scrolled to.
        fetched_before = page.evaluate('() => performance.getEntriesByType("resource").map(e => e.name).filter(n => n.includes("long-take.png")).length')
        card(page, YT_TITLE).scroll_into_view_if_needed()
        img = card(page, YT_TITLE).get_by_test_id('dsc-thumb')
        img.wait_for()
        page.wait_for_function('el => el.complete && el.naturalWidth > 0', arg=img.element_handle(), timeout=10000)
        nat = img.evaluate('el => [el.naturalWidth, el.naturalHeight, el.getAttribute("src"), el.getAttribute("loading")]')
        check('served thumbnail decoded in the browser (480x360, lazy: not fetched before scrolling to it)', nat[0] == 480 and nat[1] == 360 and nat[2].endswith('/thumbs/long-take.png') and nat[3] == 'lazy' and fetched_before == 0, nat + [fetched_before])
        check('creator and source label visible on the card', card(page, YT_TITLE).get_by_text('Frame & Field').is_visible() and card(page, YT_TITLE).get_by_text('YouTube', exact=True).is_visible())
        check('original source link points at the real URL, opens in a new tab', card(page, YT_TITLE).get_by_role('link', name='Open original').get_attribute('href') == yt['source_url']
              and card(page, YT_TITLE).get_by_role('link', name='Open original').get_attribute('rel') == 'noopener noreferrer')
        page.screenshot(path=f'{O}/screenshots/01-desktop-focus.png')

        # ---- 3. broken / missing thumbnails fall back (desktop, Explore grid) ----
        page.get_by_role('tab', name='Explore').click()
        page.get_by_role('heading', name=ART_TITLE).wait_for()
        for title in [BROKEN_YT, BROKEN_ART, NOIMG_YT, 'Article with no image at all']:
            fig = card(page, title).locator('figure.dsc-art')
            fig.scroll_into_view_if_needed()
            page.wait_for_function('el => el.dataset.state === "artwork"', arg=fig.element_handle(), timeout=10000)
            check(f'artwork fallback for "{title[:40]}…"', fig.get_attribute('data-state') == 'artwork' and fig.locator('svg[data-testid="dsc-art-generated"]').count() == 1 and fig.locator('img').count() == 0)
        check('article cover thumbnail decoded', card(page, ART_TITLE).get_by_test_id('dsc-thumb').evaluate('el => el.complete && el.naturalWidth === 1200'))
        broken_imgs = page.evaluate('() => [...document.querySelectorAll("img")].filter(i => i.complete && i.naturalWidth === 0).map(i => i.src)')
        check('no broken <img> left in the document', broken_imgs == [], broken_imgs)
        page.screenshot(path=f'{O}/screenshots/02-desktop-explore.png', full_page=False)

        # ---- 2. bookmark + personal note; arrows in the note never move cards ----
        page.get_by_role('tab', name='Focus').click()
        c = card(page, YT_TITLE)
        c.scroll_into_view_if_needed()
        c.get_by_role('button', name=f'Bookmark: {YT_TITLE}').click()
        c.get_by_role('button', name=f'Remove bookmark: {YT_TITLE}').wait_for()
        rb = api.get(f"/inbox/{yt['id']}").json()
        check('bookmark persisted through the editorial endpoint (revision 1)', rb['editorial']['saved'] is True and rb['editorial']['revision'] == 1 and rb['editorial']['note'] == '', rb['editorial'])
        c.get_by_role('button', name=f'Note: {YT_TITLE}').click()
        box = c.get_by_role('textbox', name=f'Your note for {YT_TITLE}')
        box.click()
        stage = page.locator('.dsc-stage')
        top_before = stage.evaluate('el => el.scrollTop')
        page.keyboard.type('Ask about the long take')
        page.keyboard.press('ArrowDown')
        page.keyboard.press('ArrowUp')
        page.keyboard.press('j')
        page.wait_for_timeout(400)
        top_after = stage.evaluate('el => el.scrollTop')
        typed = box.input_value()
        # ArrowUp moves the caret to the line start, so the 'j' lands at the front: every key reached the textarea, none moved the feed.
        check('arrow keys / j inside the note reach the textarea and do not scroll the feed', top_before == top_after and typed.replace('j', '', 1) == 'Ask about the long take' and typed.startswith('j'), [top_before, top_after, typed])
        box.fill('Ask about the long take')
        check('status says unsaved before explicit save', 'Unsaved' in c.get_by_role('status').text_content())
        c.get_by_role('button', name='Save note').click()
        page.wait_for_function('el => el.textContent.trim() === "Saved"', arg=c.get_by_role('status').element_handle(), timeout=10000)
        rb = api.get(f"/inbox/{yt['id']}").json()
        results['api']['after_note'] = rb
        check('note persisted (revision 2), bookmark kept', rb['editorial']['note'] == 'Ask about the long take' and rb['editorial']['saved'] is True and rb['editorial']['revision'] == 2, rb['editorial'])
        check('source text, imported notes, topic revision and presentation untouched by editorial writes', all(rb[k] == yt_frozen[k] for k in yt_frozen), {k: (rb[k] == yt_frozen[k]) for k in yt_frozen})
        page.screenshot(path=f'{O}/screenshots/03-desktop-note-saved.png')
        ctx.close()

        # ---- 2b. fresh context reload: bookmark + note survive -----------------
        ctx, page = new_page({'width': 1280, 'height': 800})
        open_discover(page)
        c = card(page, YT_TITLE)
        c.scroll_into_view_if_needed()
        check('after reload in a fresh context the bookmark shows', c.get_by_role('button', name=f'Remove bookmark: {YT_TITLE}').get_attribute('aria-pressed') == 'true')
        c.get_by_role('button', name=f'Note: {YT_TITLE}').click()
        check('after reload the saved note shows', c.get_by_role('textbox', name=f'Your note for {YT_TITLE}').input_value() == 'Ask about the long take')
        page.get_by_role('button', name='Saved · 1').click()
        check('Saved filter lists only the bookmarked topic', page.locator('article.dsc-card').count() == 1)
        page.get_by_role('button', name='Saved · 1').click()

        # ---- 4. stale editorial write -> 409, draft kept -------------------------
        box = c.get_by_role('textbox', name=f'Your note for {YT_TITLE}')
        box.fill('mine (draft)')
        theirs = api.put(f"/inbox/{yt['id']}/editorial", json={'revision': 2, 'saved': True, 'note': 'theirs'}).json()
        check('other screen wrote revision 3', theirs['editorial']['revision'] == 3)
        c.get_by_role('button', name='Save note').click()
        c.get_by_role('alert').wait_for(timeout=10000)
        alert = c.get_by_role('alert').text_content()
        rb = api.get(f"/inbox/{yt['id']}").json()
        check('stale save refused: conflict shown with theirs, draft kept, stored note untouched', 'theirs' in alert and box.input_value() == 'mine (draft)' and rb['editorial']['note'] == 'theirs' and rb['editorial']['revision'] == 3, {'alert': alert, 'stored': rb['editorial']})
        results['api']['stale_409'] = api.put(f"/inbox/{yt['id']}/editorial", json={'revision': 2, 'saved': True, 'note': 'direct stale'}).status_code
        check('direct stale PUT returns 409', results['api']['stale_409'] == 409)
        page.screenshot(path=f'{O}/screenshots/04-desktop-conflict.png')
        c.get_by_role('button', name='Keep mine and save again').click()
        page.wait_for_function('el => el.textContent.trim() === "Saved"', arg=c.get_by_role('status').element_handle(), timeout=10000)
        rb = api.get(f"/inbox/{yt['id']}").json()
        check('resubmitting against revision 3 saves the draft (revision 4)', rb['editorial']['note'] == 'mine (draft)' and rb['editorial']['revision'] == 4, rb['editorial'])

        # ---- 4b. duplicate imports keep bookmark/note and presentation ----------
        time.sleep(2.2)
        run3 = api.post(f"/retrieval/{src['id']}/import", json={'revision': src['revision'], 'request_id': str(uuid4())}).json()
        run4 = api.post(f"/feeds/{feed['id']}/import", json={'revision': feed['revision']}).json()
        results['api']['duplicate_imports'] = [run3, {k: run4[k] for k in ['status', 'created', 'duplicates']}]
        check('duplicate imports create nothing', run3['created'] == 0 and run3['duplicates'] == 3 and run4['created'] == 0 and run4['duplicates'] == 4)
        rb2 = api.get(f"/inbox/{yt['id']}").json()
        check('duplicate import left bookmark, note, presentation and source unchanged', rb2 == rb, None)
        check('inbox still has exactly 7 topics', len(api.get('/inbox').json()['items']) == 7)

        # ---- 3b. mobile 390x844: no horizontal overflow, swipe works, fallbacks ----
        ctx.close()
        ctx, page = new_page({'width': 390, 'height': 844})
        open_discover(page)
        overflow = page.evaluate('() => ({docW: document.documentElement.scrollWidth, innerW: window.innerWidth, stageW: document.querySelector(".dsc-stage").scrollWidth, stageC: document.querySelector(".dsc-stage").clientWidth})')
        check('390px: no horizontal overflow (document and stage)', overflow['docW'] <= overflow['innerW'] and overflow['stageW'] <= overflow['stageC'], overflow)
        page.screenshot(path=f'{O}/screenshots/05-mobile-focus.png')
        first = page.locator('.dsc-progress .n').inner_text() if page.locator('.dsc-progress .n').count() else None
        idx_before = page.evaluate('() => [...document.querySelectorAll(".dsc-progress i")].findIndex(i => i.classList.contains("on"))')
        stage = page.locator('.dsc-stage')
        stage.hover()
        page.mouse.wheel(0, 320)
        page.wait_for_timeout(1200)
        idx_after = page.evaluate('() => [...document.querySelectorAll(".dsc-progress i")].findIndex(i => i.classList.contains("on"))')
        snapped = page.evaluate('() => { const s = document.querySelector(".dsc-stage"); const on = [...document.querySelectorAll(".dsc-progress i")].findIndex(i => i.classList.contains("on")); const c = document.querySelectorAll(".dsc-card")[on]; return Math.abs(c.getBoundingClientRect().top - s.getBoundingClientRect().top) }')
        check('390px: swipe/scroll snaps to a following card (progress moved, aligned to card start)', idx_after >= idx_before + 1 and snapped <= 2, [idx_before, idx_after, first, snapped])
        page.screenshot(path=f'{O}/screenshots/06-mobile-second-card.png')
        page.get_by_role('tab', name='Explore').click()
        fig = card(page, BROKEN_ART).locator('figure.dsc-art')
        fig.scroll_into_view_if_needed()
        page.wait_for_function('el => el.dataset.state === "artwork"', arg=fig.element_handle(), timeout=10000)
        overflow2 = page.evaluate('() => document.documentElement.scrollWidth <= window.innerWidth')
        check('390px Explore: broken cover falls back and no horizontal overflow', overflow2 and fig.get_attribute('data-state') == 'artwork')
        page.screenshot(path=f'{O}/screenshots/07-mobile-explore.png')
        # a note on mobile with arrows does not scroll either
        page.get_by_role('tab', name='Focus').click()
        c = card(page, YT_TITLE)
        c.scroll_into_view_if_needed()
        c.get_by_role('button', name=f'Note: {YT_TITLE}').click()
        c.get_by_role('textbox', name=f'Your note for {YT_TITLE}').click()
        page.wait_for_timeout(600)
        top_before = stage.evaluate('el => el.scrollTop')
        page.keyboard.press('ArrowDown')
        page.wait_for_timeout(400)
        check('390px: arrow in note keeps the feed still', stage.evaluate('el => el.scrollTop') == top_before)
        ctx.close()

        # ---- existing surfaces still work (Inbox / Sources / Live) ----------------
        ctx, page = new_page({'width': 1280, 'height': 800})
        page.goto(WEB + '/')
        page.get_by_role('button', name='Inbox', exact=True).click()
        page.get_by_text(yt['text'], exact=True).first.wait_for(timeout=10000)
        check('Inbox view still lists the imported idea by its live label', page.get_by_text(yt['text'], exact=True).first.is_visible())
        page.get_by_role('button', name='Sources', exact=True).click()
        page.get_by_text('Surface Notes', exact=True).first.wait_for(timeout=10000)
        check('Sources view lists the feed', page.get_by_text('Surface Notes', exact=True).first.is_visible())
        page.get_by_role('button', name="Tonight's Show", exact=True).click()
        page.wait_for_function('() => [...document.querySelectorAll("input")].some(i => i.value === "On air")', timeout=10000)
        check('Live view shows the running topic', page.evaluate('() => [...document.querySelectorAll("input")].some(i => i.value === "On air")'))
        page.screenshot(path=f'{O}/screenshots/08-live-untouched.png')
        ctx.close()
        browser.close()

    # ---- 5b. live clock untouched -------------------------------------------
    after = api.get('/rundown/state').json()
    elapsed = time.time() - t0
    results['api']['live_after'] = after
    drift = (before['remaining_seconds'] - after['remaining_seconds']) - elapsed
    check('live current topic/time untouched by imports and editorial writes',
          after['revision'] == before['revision'] and after['current_topic_id'] == before['current_topic_id'] and after['topics'] == before['topics']
          and not after['paused'] and abs(drift) < 3, {'elapsed': round(elapsed, 1), 'remaining_before': before['remaining_seconds'], 'remaining_after': after['remaining_seconds'], 'drift': round(drift, 2)})
    # 404 thumbnails and the deliberate stale save are expected browser console lines.
    noise = [u for u in results['failed_requests'] if not u.endswith(('/missing.png', '/gone.png', '/rundown/state'))]  # state polls abort on context close
    check('no unexpected failed network requests or console errors', noise == [] and [e for e in results['console_errors'] if 'missing.png' not in e and 'gone.png' not in e and '404' not in e and '409 (Conflict)' not in e] == [], {'failed': results['failed_requests'], 'console': results['console_errors']})


try:
    run()
    results['status'] = 'completed'
except Exception:
    results['status'] = 'failed'
    results['traceback'] = traceback.format_exc()
    print(results['traceback'])
finally:
    json.dump(results, open(f'{O}/results.json', 'w'), indent=1, default=str)
    print('status', results['status'])
    sys.exit(0 if results['status'] == 'completed' else 1)
