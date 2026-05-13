# TikTok Collection — Scraping Research Notes

**Added by:** rei (obed-rei agent)  
**Date:** May 11, 2026  
**Context:** Research for RUNDOWN project — evaluating Playwright/Chromium vs. paid scraper APIs

---

## Decision: Use Playwright + Stealth Instead of ScrapeCreators

The TDD recommends ScrapeCreators (~$20/mo) for TikTok collection. After research, we can build this with Playwright + playwright-stealth on the mac mini at $0/mo. Here's why it works and how.

---

## Why Vanilla Playwright Gets Detected

TikTok detects bots via browser fingerprinting:
- `navigator.webdriver` flag exposed
- Missing browser plugins
- `HeadlessChrome` in User-Agent string
- WebGL/Canvas fingerprint anomalies
- Timezone/font detection mismatches

**Fix:** `playwright-stealth` patches all of these.

---

## Setup

```bash
pip install playwright-stealth
playwright install chromium
```

```python
import asyncio
from playwright_stealth import Stealth
from playwright.async_api import async_playwright

async def collect_tiktok(hashtag: str, count: int = 20):
    async with Stealth().use_async(async_playwright()) as p:
        browser = await p.chromium.launch_persistent_context(
            user_data_dir="/Users/rei/.openclaw/browser/tiktok-profile",
            headless=True,  # headless=False is even safer if issues arise
            channel="chromium",
            viewport={"width": 1280, "height": 900},
        )
        page = browser.pages[0] if browser.pages else await browser.new_page()
        
        # Search by hashtag
        await page.goto(f"https://www.tiktok.com/tag/{hashtag}", wait_until="domcontentloaded")
        await asyncio.sleep(3)  # human-like delay
        
        # Scrape video metadata here
        # ... (videos, likes, views, captions, URLs)
        
        await browser.close()
```

---

## TikTok Login Session (Critical)

Logged-in sessions get significantly less bot scrutiny than anonymous scraping. Set up once:

```python
# Run once manually to log in
PROFILE_DIR = "/Users/rei/.openclaw/browser/tiktok-profile"

with sync_playwright() as p:
    browser = p.chromium.launch_persistent_context(
        user_data_dir=PROFILE_DIR,
        headless=False,  # must be visible to log in manually
        channel="chromium",
    )
    page = browser.pages[0]
    page.goto("https://www.tiktok.com/login")
    print("Log in manually, then close the browser window.")
    try:
        page.wait_for_event("close", timeout=0)
    except:
        pass
    browser.close()
    print("Session saved.")
```

After logging in, the `tiktok-profile` dir holds cookies permanently. Future headless runs reuse the session — no re-login needed until cookies expire (~weeks/months).

---

## Rate Limiting (Stay Under the Radar)

For a daily collection job running once at 9AM:
- 2-5 second delays between page navigations
- 6 topics × ~20 videos/topic = ~120 assets/run
- One run per day

At this volume, on a residential IP (mac mini), TikTok has no reason to flag or ban. Their enforcement targets mass data harvesting, not personal tools making a few hundred requests per day.

---

## Fallback If Detection Becomes an Issue

1. **headless=False** — visible browser is harder to detect even without stealth
2. **Patchright** — more advanced stealth library: `pip install patchright` (Node.js: `patchright-nodejs`)
3. **Playwright + residential proxy** — if mac mini IP gets flagged (unlikely for low-volume use)
4. **ScrapeCreators API** — the paid fallback from the original TDD, ~$20/mo

---

## Recommended Data to Extract Per Video

```python
{
    "url": "https://www.tiktok.com/@user/video/123456",
    "author": "@username",
    "caption": "video caption text",
    "views": 1500000,
    "likes": 45000,
    "comments": 1200,
    "shares": 3400,
    "published_at": "2026-05-10",
    "thumbnail_url": "https://...",
}
```

Engagement score formula (from TDD):
```
engagement = (likes * 0.4 + comments * 0.4 + shares * 0.2) / views
```

---

## Instagram Reference Implementation

The mac mini already has a working Playwright setup for Instagram:
- Script: `/Users/rei/.openclaw/browser/launch_ig_login.py`
- Profile: `/Users/rei/.openclaw/browser/ig-profile`

The TikTok setup follows the exact same pattern. Reuse the infrastructure.

---

## Sources

- r/webscraping: "Trying to Scrape TikTok Account Page" — confirms IP + user-agent rotation needed
- r/webscraping: "Scraping best practices to anti-bot detection?" — recommends patchright as advanced option
- Scrapfly blog: "Playwright Stealth: Bypass Bot Detection" (April 2026) — current stealth setup guide
- GitHub: zed-kira/bot-detection — fingerprint spoofing reference for WebGL, canvas, fonts, timezone
