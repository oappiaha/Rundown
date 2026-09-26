"""Drives the Rundown discovery prototype through the done checklist with a real browser.
Fresh browser profile per run; only 127.0.0.1:3187 may be contacted."""
import asyncio, json, sys, time
from playwright.async_api import async_playwright
EXE = "/Users/rei/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
URL = "http://127.0.0.1:3187/"
OUT = "/private/tmp/rundown-discovery-prototype/evidence/shots/"
results = []
def check(name, ok, obs=""):
    results.append({"check": name, "ok": bool(ok), "observed": str(obs)[:300]})
    print(("PASS " if ok else "FAIL ") + name + ("  — " + str(obs)[:160] if obs else ""))

async def settle(pg):
    """wait until the stage scroll position is stable (smooth scroll / snap finished)"""
    last = -1
    for _ in range(40):
        cur = await pg.evaluate("document.getElementById('stage').scrollTop")
        if cur == last: return cur
        last = cur; await pg.wait_for_timeout(80)
    return last
async def current_id(pg):
    await settle(pg)
    return await pg.evaluate("""() => { const st = document.getElementById('stage'); const r = st.getBoundingClientRect();
      const cards=[...st.querySelectorAll('.card')]; const c = cards.find(c => { const b=c.getBoundingClientRect(); return b.top >= r.top-2 && b.top < r.top + r.height/2; }); return c ? c.dataset.id : null; }""")
async def visible_ids(pg):
    return await pg.evaluate("window.__rundown.visible()")
async def story_meta(pg):
    return await pg.evaluate("window.RUNDOWN_STORIES.map(s => ({id:s.id, source:s.source, topic:s.topic}))")

async def run_desktop(b, requests):
    ctx = await b.new_context(viewport={"width":1440,"height":1000}, device_scale_factor=2)
    pg = await ctx.new_page(); errs = []
    pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("request", lambda r: requests.append(r.url))
    await pg.goto(URL); await pg.wait_for_selector(".card.in")
    meta = {m["id"]: m for m in await story_meta(pg)}
    base_order = await visible_ids(pg)
    check("desktop: page loads with 12 focus cards", len(await pg.query_selector_all(".card")) == 12)
    check("desktop: concept label visible", await pg.is_visible("text=Concept · sample stories"))
    srcs = {meta[i]["source"] for i in base_order}
    check("desktop: feed contains all four source types", srcs == {"article","youtube","tiktok","reddit"}, srcs)
    await pg.screenshot(path=OUT+"01-desktop-focus.png")

    # --- wheel scroll browses cards (scroll-snap) ---
    await pg.mouse.move(700, 600); await pg.mouse.wheel(0, 900); await pg.wait_for_timeout(900)
    after_wheel = await current_id(pg)
    check("desktop: mouse wheel advances to second card", after_wheel == base_order[1], f"{base_order[0]} -> {after_wheel}")
    # --- keyboard next/prev ---
    await pg.keyboard.press("ArrowDown"); await pg.wait_for_timeout(700)
    check("desktop: ArrowDown moves to third card", await current_id(pg) == base_order[2], await current_id(pg))
    await pg.keyboard.press("ArrowUp"); await pg.wait_for_timeout(700)
    check("desktop: ArrowUp moves back to second card", await current_id(pg) == base_order[1], await current_id(pg))
    # walk the feed and confirm every source type is reachable by keyboard
    seen = set()
    for _ in range(11):
        await pg.keyboard.press("ArrowDown"); await pg.wait_for_timeout(350)
        cid = await current_id(pg)
        if cid: seen.add(meta[cid]["source"])
    check("desktop: keyboard walk reaches all four source types", seen == {"article","youtube","tiktok","reddit"}, seen)
    await pg.screenshot(path=OUT+"02-desktop-focus-tiktok-or-last.png")
    await pg.keyboard.press("Home")  # no-op in app; then go top via k presses
    for _ in range(12): await pg.keyboard.press("k")
    await pg.wait_for_timeout(600)

    # --- Read more opens reader with full body; keyboard navigates inside reader; Escape closes ---
    card0 = pg.locator(f'.card[data-id="{base_order[0]}"]')
    await card0.locator('[data-act="read"]').click(); await pg.wait_for_timeout(450)
    reader_on = await pg.evaluate("document.getElementById('reader').classList.contains('on')")
    n_take = await pg.locator("#reader .takeaways li").count()
    n_para = await pg.locator("#reader .para").count()
    check("desktop: Read more opens reader with 3 takeaways + 2 paragraphs", reader_on and n_take == 3 and n_para == 2, f"on={reader_on} takeaways={n_take} paras={n_para}")
    check("desktop: background is inert while reader open", await pg.evaluate("document.getElementById('stage').hasAttribute('inert') && document.querySelector('.top').hasAttribute('inert')"))
    # focus trap: Tab repeatedly must stay within the reader
    inside = True
    for _ in range(14):
        await pg.keyboard.press("Tab")
        inside = inside and await pg.evaluate("!!document.activeElement.closest('#reader')")
    check("desktop: Tab focus stays trapped inside reader", inside)
    await pg.screenshot(path=OUT+"03-desktop-reader.png")
    await pg.keyboard.press("ArrowDown"); await pg.wait_for_timeout(300)
    check("desktop: ArrowDown in reader shows next story", await pg.evaluate("document.querySelector('#reader .reader-story').dataset.id") == base_order[1])
    await pg.keyboard.press("Escape"); await pg.wait_for_timeout(450)
    check("desktop: Escape closes reader and feed sits on that story", (not await pg.evaluate("document.getElementById('reader').classList.contains('on')")) and await current_id(pg) == base_order[1], await current_id(pg))
    check("desktop: inert removed after close", await pg.evaluate("!document.getElementById('stage').hasAttribute('inert')"))
    for _ in range(3): await pg.keyboard.press("k")
    await pg.wait_for_timeout(500)

    # --- preference signals: More on a sport story; current card must not move; refresh reorders; undo/reset ---
    sport_id = next(i for i in base_order if meta[i]["topic"] == "sport")
    sport_idx = base_order.index(sport_id)
    for _ in range(sport_idx): await pg.keyboard.press("j")
    await pg.wait_for_timeout(700)
    check("desktop: navigated to a Sport story", await current_id(pg) == sport_id, sport_id)
    scroll_before = await settle(pg)
    await pg.locator(f'.card[data-id="{sport_id}"] [data-act="more"]').click(); await pg.wait_for_timeout(400)
    scroll_after = await settle(pg)
    check("desktop: More like this does not move the current card", scroll_before == scroll_after and await current_id(pg) == sport_id and await visible_ids(pg) == base_order, f"scrollTop {scroll_before}->{scroll_after}")
    check("desktop: toast explains reorder-on-refresh with Undo", await pg.is_visible("#toast.on") and "reorders on refresh" in (await pg.inner_text("#toast")) and await pg.is_visible('#toast [data-act="toast-action"]'))
    await pg.screenshot(path=OUT+"04-desktop-more-toast.png")
    await pg.locator(f'.card[data-id="{sport_id}"] [data-act="more"]').click(); await pg.wait_for_timeout(300)  # second signal (+2 sport)
    # open Tune popover
    await pg.click("#tuneBtn"); await pg.wait_for_timeout(350)
    tune_txt = await pg.inner_text("#tune")
    check("desktop: Tune popover shows local weights (+2.0 Sport, 2 signals)", "+2.0" in tune_txt and "2 signals" in tune_txt and "Nothing leaves this browser" in tune_txt, tune_txt.replace("\n"," | ")[:200])
    await pg.screenshot(path=OUT+"05-desktop-tune.png")
    await pg.click('#tune [data-act="refresh"]'); await pg.wait_for_timeout(700)
    new_order = await visible_ids(pg)
    sport_first = [i for i in new_order[:3]]
    check("desktop: Refresh puts all three Sport stories first", all(meta[i]["topic"]=="sport" for i in sport_first) and new_order != base_order, new_order[:4])
    check("desktop: feed rerendered from top on refresh", await current_id(pg) == new_order[0])
    # undo one, reset all
    await pg.click("#tuneBtn"); await pg.wait_for_timeout(300)
    await pg.click('#tune [data-act="undo"]'); await pg.wait_for_timeout(200)
    check("desktop: Undo keeps popover open", await pg.evaluate("document.getElementById('tune').classList.contains('on')"))
    check("desktop: Undo drops one signal (+1.0 Sport, 1 signal)", "+1.0" in (await pg.inner_text("#tune")) and "1 signal " in (await pg.inner_text("#tune")))
    await pg.click('#tune [data-act="reset"]'); await pg.wait_for_timeout(200)
    check("desktop: Reset clears signals (0 signals)", "0 signals" in (await pg.inner_text("#tune")))
    await pg.click('#tune [data-act="refresh"]'); await pg.wait_for_timeout(600)
    check("desktop: order returns to base after reset+refresh", await visible_ids(pg) == base_order)

    # --- save + note on second card, no card movement, tray, persistence across reload ---
    await pg.keyboard.press("j"); await pg.wait_for_timeout(700)
    target = await current_id(pg)
    tcard = pg.locator(f'.card[data-id="{target}"]')
    sb = await settle(pg)
    await tcard.locator('[data-act="save"]').click(); await pg.wait_for_timeout(250)
    check("desktop: Save toggles button state in place, card stays", await tcard.locator('[data-act="save"]').get_attribute("aria-pressed") == "true" and sb == await settle(pg) and await current_id(pg) == target)
    check("desktop: Saved badge shows 1", (await pg.inner_text("#savedBtn .count")).strip() == "1")
    await tcard.locator('[data-act="note"]').click(); await pg.wait_for_timeout(200)
    ta = tcard.locator("textarea")
    check("desktop: Note textarea receives focus on one tap", await pg.evaluate("document.activeElement.tagName") == "TEXTAREA")
    await ta.type("Rewatch the serve routine before Sunday")
    # negative: arrow keys while typing must not change card
    before_typing_id = await current_id(pg)
    await pg.keyboard.press("ArrowDown"); await pg.keyboard.press("ArrowDown"); await pg.keyboard.press("j"); await pg.keyboard.press("ArrowUp")
    await pg.wait_for_timeout(500)
    check("NEGATIVE desktop: ArrowDown/j/ArrowUp inside textarea do not change card", await current_id(pg) == before_typing_id and await pg.evaluate("document.activeElement.tagName") == "TEXTAREA", f"still on {await current_id(pg)}; value={await ta.input_value()!r}")
    await ta.type(" j")  # literal j lands in the note
    await pg.wait_for_timeout(400)
    check("desktop: note autosaved status shown", "saved on this device" in (await tcard.locator(".note-status").text_content()).lower())
    await pg.screenshot(path=OUT+"06-desktop-note.png")
    stored = await pg.evaluate("JSON.parse(localStorage.getItem(window.__rundown.KEY))")
    check("desktop: localStorage holds save + note", target in stored["saved"] and "Rewatch the serve routine" in stored["notes"].get(target,""), json.dumps({k:stored[k] for k in ("saved","notes")}))
    # tray with reorder: save another story first
    await pg.keyboard.press("Escape"); await pg.wait_for_timeout(100)
    check("desktop: Escape leaves the note field", await pg.evaluate("document.activeElement.tagName") != "TEXTAREA")
    await pg.keyboard.press("j"); await pg.wait_for_timeout(700)
    second = await current_id(pg)
    check("desktop: j after leaving the note advances one card", second == (await visible_ids(pg))[(await visible_ids(pg)).index(target) + 1], second)
    await pg.locator(f'.card[data-id="{second}"] [data-act="save"]').click(); await pg.wait_for_timeout(200)
    await pg.click("#savedBtn"); await pg.wait_for_timeout(400)
    items = await pg.evaluate("[...document.querySelectorAll('#tray .tray-item')].map(e=>e.dataset.id)")
    check("desktop: Saved tray lists both stories in save order with note preview", items == [target, second] and await pg.is_visible("#tray .note-preview"), items)
    await pg.screenshot(path=OUT+"07-desktop-tray.png")
    await pg.click(f'#tray .tray-item[data-id="{second}"] [data-act="up"]'); await pg.wait_for_timeout(200)
    items2 = await pg.evaluate("[...document.querySelectorAll('#tray .tray-item')].map(e=>e.dataset.id)")
    check("desktop: tray reorder moves item up", items2 == [second, target], items2)
    await pg.keyboard.press("Escape"); await pg.wait_for_timeout(300)

    # --- reload: readback ---
    await pg.reload(); await pg.wait_for_selector(".card.in"); await pg.wait_for_timeout(400)
    tcard = pg.locator(f'.card[data-id="{target}"]')
    check("desktop: after reload Save state persists", await tcard.locator('[data-act="save"]').get_attribute("aria-pressed") == "true")
    check("desktop: after reload note text persists and is shown", "Rewatch the serve routine" in (await tcard.locator("textarea").input_value()) and not await tcard.locator(".note-wrap").get_attribute("hidden"))
    check("desktop: after reload Saved badge shows 2 in tray order", (await pg.inner_text("#savedBtn .count")).strip() == "2" and (await pg.evaluate("window.__rundown.state.saved")) == [second, target])

    # --- Explore mode shares state ---
    await pg.click('button[data-mode="explore"]'); await pg.wait_for_timeout(700)
    tile = pg.locator(f'.tile[data-id="{target}"]')
    check("explore: saved tile shows Saved + Has note", await tile.locator('[data-act="save"]').get_attribute("aria-pressed") == "true" and await tile.locator(".notemark").count() == 1)
    check("explore: renders 12 tiles, no horizontal overflow", await pg.locator(".tile").count() == 12 and await pg.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    await pg.screenshot(path=OUT+"08-desktop-explore.png")
    # keyboard in explore: ArrowRight moves active tile; Enter opens reader
    await pg.keyboard.press("ArrowRight"); await pg.wait_for_timeout(300)
    active = await pg.evaluate("document.activeElement.classList.contains('tile') ? document.activeElement.dataset.id : null")
    check("explore: ArrowRight focuses the next tile", active == (await visible_ids(pg))[1], active)
    await pg.keyboard.press("Enter"); await pg.wait_for_timeout(450)
    check("explore: Enter opens reader on that tile", await pg.evaluate("document.getElementById('reader').classList.contains('on') && document.querySelector('#reader .reader-story').dataset.id") == active)
    await pg.screenshot(path=OUT+"09-desktop-explore-reader.png")
    # unsave from explore reader, then check focus card reflects it
    was_saved = await pg.locator(f'.tile[data-id="{active}"] [data-act="save"]').get_attribute("aria-pressed")
    await pg.click('#reader [data-act="save"]'); await pg.wait_for_timeout(200)
    now_saved = "true" if was_saved == "false" else "false"
    await pg.keyboard.press("Escape"); await pg.wait_for_timeout(300)
    check("explore: save toggled in reader is mirrored on the tile in place", await pg.locator(f'.tile[data-id="{active}"] [data-act="save"]').get_attribute("aria-pressed") == now_saved, f"{was_saved} -> {now_saved}")
    await pg.click('button[data-mode="focus"]'); await pg.wait_for_timeout(600)
    check("focus: save toggled in Explore is reflected in the Focus card", await pg.locator(f'.card[data-id="{active}"] [data-act="save"]').get_attribute("aria-pressed") == now_saved)
    # category chips
    await pg.click('.chip[data-topic="design"]'); await pg.wait_for_timeout(500)
    ids = await visible_ids(pg)
    check("focus: Design chip filters to design stories only", ids and all(meta[i]["topic"]=="design" for i in ids) and len(await pg.query_selector_all(".card")) == len(ids), ids)
    # open source explains demo, no navigation
    url_before = pg.url
    await pg.click('.card [data-act="open"] >> nth=0'); await pg.wait_for_timeout(300)
    check("focus: Open source shows local explanation, no navigation", "nothing here calls the network" in await pg.inner_text("#toast") and pg.url == url_before and len(ctx.pages) == 1)
    await pg.screenshot(path=OUT+"10-desktop-open-source-toast.png")
    check("desktop: no console errors", not errs, errs)
    await ctx.close()

async def run_mobile(b, requests):
    ctx = await b.new_context(viewport={"width":390,"height":844}, device_scale_factor=2, is_mobile=True, has_touch=True,
        user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
    pg = await ctx.new_page(); errs = []
    pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("request", lambda r: requests.append(r.url))
    await pg.goto(URL); await pg.wait_for_selector(".card.in")
    meta = {m["id"]: m for m in await story_meta(pg)}
    order = await visible_ids(pg)
    check("mobile: fresh profile starts clean (0 saved)", (await pg.inner_text("#savedBtn .count")).strip() == "0")
    overflow = await pg.evaluate("""() => { const w = innerWidth; const bad=[]; document.querySelectorAll('body *').forEach(el => { const r = el.getBoundingClientRect(); if (r.width && r.right > w + 1 && !el.closest('svg') && !el.closest('.chips') && !el.closest('.panel') && !el.closest('.pop') && !el.closest('.toast')) bad.push(el.className || el.tagName); }); return {scrollW: document.documentElement.scrollWidth, stageW: document.getElementById('stage').scrollWidth, clientW: document.getElementById('stage').clientWidth, bad: bad.slice(0,5)}; }""")
    check("mobile: no horizontal overflow (focus)", overflow["scrollW"] <= 390 and overflow["stageW"] <= overflow["clientW"] and not overflow["bad"], overflow)
    fits = await pg.evaluate("""() => { const c = document.querySelector('.card'); const a = c.querySelector('.actions'); const st = document.getElementById('stage').getBoundingClientRect(); return { actionsBottom: a.getBoundingClientRect().bottom, stageBottom: st.bottom }; }""")
    check("mobile: first card actions fit without scrolling (no clipping)", fits["actionsBottom"] <= fits["stageBottom"], fits)
    await pg.screenshot(path=OUT+"11-mobile-focus.png")
    # touch swipe via CDP
    cdp = await ctx.new_cdp_session(pg)
    async def swipe_up():
        await cdp.send("Input.dispatchTouchEvent", {"type":"touchStart","touchPoints":[{"x":195,"y":650}]})
        for y in range(650, 250, -40):
            await cdp.send("Input.dispatchTouchEvent", {"type":"touchMove","touchPoints":[{"x":195,"y":y}]})
            await pg.wait_for_timeout(16)
        await cdp.send("Input.dispatchTouchEvent", {"type":"touchEnd","touchPoints":[]})
        await pg.wait_for_timeout(900)
    await swipe_up()
    cid = await current_id(pg)
    swiped = cid == order[1]
    if not swiped:  # fall back to wheel to keep going, but record honestly
        await pg.mouse.wheel(0, 800); await pg.wait_for_timeout(800); cid = await current_id(pg)
    check("mobile: touch swipe up advances to next card" + ("" if swiped else " (FELL BACK TO WHEEL)"), swiped, f"{order[0]} -> {cid}")
    await swipe_up()
    check("mobile: second swipe reaches third card", await current_id(pg) == order[2], await current_id(pg))
    # find the TikTok card and screenshot it (vertical sample frame)
    tik = next(i for i in order if meta[i]["source"]=="tiktok")
    while await current_id(pg) != tik:
        await pg.keyboard.press("ArrowDown"); await pg.wait_for_timeout(350)
    await pg.wait_for_timeout(300)
    await pg.screenshot(path=OUT+"12-mobile-focus-tiktok.png")
    ov2 = await pg.evaluate("document.documentElement.scrollWidth <= innerWidth")
    check("mobile: tiktok card no horizontal overflow", ov2)
    # note on mobile: tap Note, type, arrows while typing do not move
    card = pg.locator(f'.card[data-id="{tik}"]')
    await card.locator('[data-act="save"]').tap(); await pg.wait_for_timeout(200)
    await card.locator('[data-act="note"]').tap(); await pg.wait_for_timeout(250)
    await pg.keyboard.type("Count the bounces")
    await pg.keyboard.press("ArrowDown"); await pg.keyboard.press("ArrowUp"); await pg.wait_for_timeout(400)
    check("NEGATIVE mobile: arrows while typing keep the same card", await current_id(pg) == tik)
    fits2 = await pg.evaluate("""() => { const c = document.querySelector('.card .note-wrap:not([hidden]) textarea'); const st = document.getElementById('stage').getBoundingClientRect(); return c ? { taBottom: c.getBoundingClientRect().bottom, stageBottom: st.bottom } : null; }""")
    check("mobile: note textarea visible inside the card without large scroll", fits2 and fits2["taBottom"] <= fits2["stageBottom"] + 1, fits2)
    await pg.screenshot(path=OUT+"13-mobile-note.png")
    # Read more -> bottom sheet reader
    await card.locator('[data-act="read"]').tap(); await pg.wait_for_timeout(500)
    check("mobile: Read more opens reader sheet with full body", await pg.evaluate("document.getElementById('reader').classList.contains('on')") and await pg.locator("#reader .para").count() == 2)
    check("mobile: reader sheet fits viewport width", await pg.evaluate("(() => { const r = document.getElementById('reader').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 0.5; })()"))
    await pg.screenshot(path=OUT+"14-mobile-reader.png")
    await pg.tap("#reader .close"); await pg.wait_for_timeout(400)
    # Less on a film story then refresh: film moves last
    film = next(i for i in order if meta[i]["topic"]=="film")
    while await current_id(pg) != film:
        await pg.keyboard.press("ArrowUp" if order.index(film) < order.index(await current_id(pg)) else "ArrowDown"); await pg.wait_for_timeout(350)
    await pg.locator(f'.card[data-id="{film}"] [data-act="less"]').tap(); await pg.wait_for_timeout(300)
    check("mobile: Tune button shows pending dot after a signal", await pg.evaluate("document.getElementById('tuneBtn').classList.contains('pending')"))
    await pg.tap("#tuneBtn"); await pg.wait_for_timeout(350)
    await pg.screenshot(path=OUT+"15-mobile-tune.png")
    await pg.tap('#tune [data-act="refresh"]'); await pg.wait_for_timeout(700)
    new_order = await visible_ids(pg)
    check("mobile: after Less Film + refresh, film stories are last three", all(meta[i]["topic"]=="film" for i in new_order[-3:]), new_order[-4:])
    # reload readback + explore mode
    await pg.reload(); await pg.wait_for_selector(".card.in"); await pg.wait_for_timeout(300)
    check("mobile: reload keeps save + note + order", (await pg.evaluate("window.__rundown.state.saved")) == [tik] and (await pg.evaluate("window.__rundown.state.notes"))[tik] == "Count the bounces" and await visible_ids(pg) == new_order)
    await pg.tap('button[data-mode="explore"]'); await pg.wait_for_timeout(600)
    check("mobile: explore no horizontal overflow", await pg.evaluate("document.documentElement.scrollWidth <= innerWidth && document.getElementById('stage').scrollWidth <= document.getElementById('stage').clientWidth"))
    check("mobile: explore shows saved tile state", await pg.locator(f'.tile[data-id="{tik}"] [data-act="save"]').get_attribute("aria-pressed") == "true")
    await pg.screenshot(path=OUT+"16-mobile-explore.png")
    await pg.tap("#savedBtn"); await pg.wait_for_timeout(450)
    check("mobile: saved tray opens as a sheet with the story and note", await pg.is_visible("#tray.on .tray-item") and "Count the bounces" in await pg.inner_text("#tray"))
    await pg.screenshot(path=OUT+"17-mobile-tray.png")
    check("mobile: no console errors", not errs, errs)
    await ctx.close()

async def main():
    requests = []
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=EXE)
        await run_desktop(b, requests)
        await run_mobile(b, requests)
        await b.close()
    external = [u for u in requests if not u.startswith(URL)]
    check("NETWORK: every request stayed on 127.0.0.1:3187", not external, f"{len(requests)} requests; external={external[:5]}")
    passed = sum(r["ok"] for r in results)
    summary = {"passed": passed, "total": len(results), "results": results, "ran_at": time.strftime("%Y-%m-%d %H:%M:%S")}
    json.dump(summary, open("/private/tmp/rundown-discovery-prototype/evidence/results.json","w"), indent=2)
    print(f"\n{passed}/{len(results)} checks passed")
    sys.exit(0 if passed == len(results) else 1)
asyncio.run(main())
