# RUNDOWN — Technical Design Document
**Version:** 2.1
**Author:** Beezy
**Status:** Active Build
**Last Updated:** Sept 2026
**Changelog:** v2.0 → v2.1 — served overlay (OBS 32.1 file:// lockdown), launchd deployment on Wolf-4, CORS removed. v1.0 → v2.0 — OBS overlay layer, live topic bridge, WebSocket integration.

---

## 0.1 v2.1 Delta — Implementation Notes

### A. Serve the overlay from FastAPI (replaces Local File browser source)

OBS 32.1 hardened `file://` browser sources. Move all frontend files into a `static/` folder next to the FastAPI app and mount it:

```python
from fastapi.staticfiles import StaticFiles

app.mount("/static", StaticFiles(directory="static"), name="static")
# static/overlay.html      → OBS browser source (URL mode)
# static/topic-ui.html     → topic preview (serve at "/" via RedirectResponse or direct route)
```

In the overlay JS, the API base becomes a relative path — no host, no CORS:

```js
const RUNDOWN_API = "/rundown/topics";   // same-origin now
```

Delete the CORSMiddleware block from `rundown_obs_bridge.py` — it existed only for the file:// origin.

OBS browser source config change: uncheck "Local file", set URL to
`http://localhost:8000/static/overlay.html`. Everything else (1920×1080, layer order, Interact) unchanged.

### B. launchd services on Wolf-4 (VPS rejected)

Two plists in `~/Library/LaunchAgents/`:

**`com.beezy.rundown-server.plist`** — uvicorn, KeepAlive (auto-restart on crash, starts at boot):
```xml
<key>ProgramArguments</key>
<array>
  <string>/Users/beezy/.venvs/rundown/bin/uvicorn</string>
  <string>main:app</string>
  <string>--host</string><string>0.0.0.0</string>
  <string>--port</string><string>8000</string>
</array>
<key>KeepAlive</key><true/>
<key>RunAtLoad</key><true/>
<key>WorkingDirectory</key><string>/Users/beezy/code/rundown</string>
```

**`com.beezy.rundown-scraper.plist`** — scheduled scrape (7:00 AM daily; add a second StartCalendarInterval entry for T-60min before regular stream time):
```xml
<key>ProgramArguments</key>
<array>
  <string>/Users/beezy/.venvs/rundown/bin/python</string>
  <string>scraper.py</string>
</array>
<key>StartCalendarInterval</key>
<dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
```

Load with `launchctl load ~/Library/LaunchAgents/com.beezy.rundown-*.plist`. Note: keep the project outside `~/Documents` (TCC gating) — `~/code/rundown` per the established Wolf-4 convention.

Binding uvicorn to `0.0.0.0` exposes it on the tailnet: topic preview from any device at `http://wolf-4:8000/`. Tailscale is the auth boundary; no app-level auth added.

### C. Version pins
- OBS Studio **≥ 32.1.1** (32.1.0 shipped a WebSocket bug where sources stopped responding to SetSourceSettings; fixed in RC3/32.1.1)
- WebSocket refresh path (`PressInputPropertiesButton` → `refreshnocache`) unchanged and still valid in v5 protocol

### D. Explicitly rejected (no overhead)
- **VPS for the scraper** — Wolf-4 + launchd already provides always-on; a VPS adds cost, a second deploy target, and a state-sync problem with zero benefit
- **WebSocket push to overlay** — 5s polling is adequate for a list that changes a few times/day
- **Docker / DB migration / app auth** — single process, single machine, tailnet-only

---

## 0. Engineering Philosophy (unchanged)

Personal tooling first. SQLite over Postgres. Local filesystem over S3. Debuggability over elegance. Cost discipline on every API call. V1 is not a prototype of V2 — it's a working tool.

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Mac Mini (always-on)                   │
│                                                           │
│  ┌─────────────────┐     ┌──────────────────────────┐   │
│  │  Research Agent  │────▶│  FastAPI Server :8000    │   │
│  │  (Claude pipeline│     │  - GET /rundown/topics   │   │
│  │   + scrapers)   │     │  - POST /push-to-obs      │   │
│  └─────────────────┘     │  - Serves topics.json     │   │
│                           └──────────┬───────────────┘   │
│                                      │                    │
│                           ┌──────────▼───────────────┐   │
│                           │  OBS Studio              │   │
│                           │  - WebSocket :4455       │   │
│                           │  - Browser Source        │   │
│                           │    rundown-obs-final.html│   │
│                           └──────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## 2. Tech Stack

### 2.1 Unchanged from v1.0
| Layer | Choice | Reason |
|---|---|---|
| Runtime | Python 3.11 | FastAPI, Claude SDK, scrapers |
| API server | FastAPI + uvicorn | Async, lightweight |
| Database | SQLite | Local-first, zero ops |
| AI | Claude Sonnet via Anthropic SDK | Topic scoring + summarization |
| Infra | Mac mini + Tailscale | Always-on, accessible remotely |

### 2.2 New in v2.0
| Layer | Choice | Reason |
|---|---|---|
| OBS overlay | HTML/CSS/JS (Browser Source) | OBS native; transparent background composites over camera |
| OBS control | OBS WebSocket v5 (port 4455) | Built into OBS 28+; no plugin required |
| WS auth | SHA-256 HMAC challenge/response | OBS WebSocket v5 protocol spec |
| Topic sync | HTTP polling (5s interval) | Simpler than WebSocket from overlay; survives page refresh |
| Topic persistence | `topics.json` (flat file) | Survives server restart; readable for debugging |
| Font stack | IBM Plex Mono + Barlow Condensed | Monospace for LCD/timer; condensed for track labels |

---

## 3. Overlay Architecture

### 3.1 File: `rundown-obs-final.html`

**Body:** `width:1920px; height:1080px; background:transparent`

Two absolutely-positioned layers:

**`#right-panel`**
```
position: absolute
right: 0, top: 0
width: 310px
height: calc(1080px - 110px)  ← leaves space for bottom bar
```

**`#bottom-bar`**
```
position: absolute
bottom: 0, left: 0
width: 1920px
height: 110px
```

### 3.2 Silver/Platinum Chrome Effect

Achieved entirely in CSS — no images:

```css
background:
  repeating-linear-gradient(
    90deg, transparent, transparent 4px,
    rgba(255,255,255,.024) 4px, rgba(255,255,255,.024) 5px
  ),                                          /* brushed lines */
  linear-gradient(162deg,
    #f8f8f8 0%, #ebebeb 10%, #d8d8d8 24%,
    #c8c8c8 38%, #d4d4d4 52%, #bcbcbc 66%,
    #cacaca 80%, #e0e0e0 100%                 /* platinum gradient */
  );

/* Top shine */
::before { background: linear-gradient(180deg, rgba(255,255,255,.38), transparent) }

/* Left bevel */
::after { border-left: 3px solid rgba(255,255,255,.55) }
```

### 3.3 Embossed Button Effect

```css
/* Resting state */
background: radial-gradient(circle at 36% 34%, #fafafa, #d8d8d8 52%, #bebebe);
box-shadow:
  4px 4px 8px rgba(0,0,0,.32),       /* drop shadow */
  -2px -2px 5px rgba(255,255,255,.88), /* top-left highlight */
  inset 0 2px 0 rgba(255,255,255,.75), /* inner top rim */
  inset 0 -1px 0 rgba(0,0,0,.1);       /* inner bottom rim */

/* Pressed state */
transform: translateY(2px) scale(.95);
box-shadow:
  1px 1px 3px rgba(0,0,0,.28),
  inset 3px 3px 6px rgba(0,0,0,.22),   /* concave inset */
  inset -1px -1px 3px rgba(255,255,255,.4);
```

### 3.4 LCD Marquee Ticker

**Problem:** Topic names overflow the fixed-width LCD panel.

**Solution:** Overflow detection + conditional CSS animation.

```js
function applyTicker(text) {
  const el   = els.lcdTopic;
  const wrap = document.getElementById('lcd-topic-wrap');
  el.textContent = text.toUpperCase();
  el.classList.remove('scrolling');
  void el.offsetWidth;                          // force reflow
  if(el.scrollWidth > wrap.clientWidth) {
    // speed: 60px/s — proportional to text length
    const duration = (el.scrollWidth + wrap.clientWidth) / 60;
    el.style.animationDuration = duration + 's';
    el.classList.add('scrolling');
  }
}
```

```css
/* Wrapper clips + fades edges */
#lcd-topic-wrap {
  overflow: hidden;
  mask-image: linear-gradient(
    90deg, transparent 0%, #000 8%, #000 92%, transparent 100%
  );
}

/* Scroll keyframe */
@keyframes ticker {
  0%   { transform: translateX(100%); }
  100% { transform: translateX(-100%); }
}
```

Short text → static. Long text → scrolls. No threshold to tune.

### 3.5 Keyboard Debounce

**Problem:** OBS Interact window fires `keydown` twice per keypress — once from the page, once from OBS browser navigation.

**Fix:**
```js
let lastKey = null, lastKeyTime = 0;
document.addEventListener('keydown', e => {
  const now = Date.now();
  if(e.key === lastKey && now - lastKeyTime < 300) return; // squash duplicate
  lastKey = e.key; lastKeyTime = now;
  // handle key...
});
```

300ms window: prevents double-fire, still allows rapid intentional presses.

---

## 4. Live Topic Bridge

### 4.1 File: `rundown_obs_bridge.py`

FastAPI router — attach to existing RUNDOWN FastAPI app:

```python
from rundown_obs_bridge import router, add_cors
add_cors(app)
app.include_router(router)
```

### 4.2 Endpoints

**`GET /rundown/topics`**
```json
{
  "topics": [
    {"text": "NBA Playoff Picture", "duration": 120},
    ...
  ],
  "hash": "a3f2b1c4"   // MD5[:8] of topics JSON
}
```

**`POST /rundown/push-to-obs`**
```json
// Request
{
  "topics": [{"text": "...", "duration": 120}],
  "refresh_obs": true
}

// Response
{
  "ok": true,
  "topics_count": 8,
  "obs_refreshed": true
}
```

### 4.3 Overlay Polling Logic

```js
async function pollTopics() {
  try {
    const res  = await fetch(RUNDOWN_API, { cache: 'no-store' });
    const data = await res.json();
    if(data.hash && data.hash !== lastTopicsHash) {
      lastTopicsHash = data.hash;
      TOPICS = data.topics;
      // reset to topic 01, animate LCD, rebuild list
    }
  } catch(e) {
    // server offline — stay on FALLBACK_TOPICS silently
  }
}

setInterval(pollTopics, 5000);
```

Hash comparison ensures the overlay only resets when topics actually change — a server restart or a repeated poll with identical topics does nothing.

### 4.4 OBS WebSocket Refresh

Protocol: OBS WebSocket v5 (built into OBS 28+, port 4455)

Auth flow:
1. Receive `Hello` with challenge + salt
2. Compute: `base64(HMAC-SHA256(base64(HMAC-SHA256(password, salt+challenge)), challenge))`
3. Send `Identify` with auth string
4. Send `PressInputPropertiesButton` with `propertyName: "refreshnocache"`

Failure mode: if OBS is not running, `push-to-obs` catches the WebSocket exception and returns `obs_refreshed: false` — the topics are still stored and the polling overlay will pick them up within 5 seconds.

---

## 5. Topic Data Model

```python
class Topic(BaseModel):
    text: str       # display name, max ~30 chars for LCD legibility
    duration: int   # seconds — shown on timer, auto-advances at 0
```

Stored in memory (`_current_topics: List[dict]`) and persisted to `topics.json`:

```json
{
  "topics": [
    {"text": "NBA Playoff Picture", "duration": 120},
    {"text": "Drake vs Kendrick",   "duration": 90}
  ]
}
```

---

## 6. State Machine — Overlay

```
IDLE (fallback topics loaded)
  │
  ▼ pollTopics() detects hash change
LOADING NEW TOPICS
  │ reset cur=0, tl=topics[0].duration
  ▼
PLAYING
  │ setInterval tick every 1s
  │ tl-- → updateTimer()
  │
  ├── tl hits 0 → auto-advance → goTo(cur+1) → PLAYING
  ├── keydown → → goTo(cur+1) → PLAYING
  ├── keydown ← → goTo(cur-1) → PLAYING
  ├── Space pressed → PAUSED
  └── cur === TOPICS.length-1 && tl===0 → DONE (timer stops)

PAUSED
  ├── Space pressed → PLAYING
  └── keydown →/← → goTo() → PLAYING

DONE
  └── Reset button → goTo(0) → PLAYING
```

---

## 7. CORS Configuration

OBS Browser Sources use `file://` origin. FastAPI must allow this:

```python
app.add_middleware(
  CORSMiddleware,
  allow_origins=["*"],   # file:// origin requires wildcard
  allow_methods=["GET", "POST"],
  allow_headers=["*"],
)
```

---

## 8. OBS Setup Checklist

```
□ OBS Studio 28+
□ Tools → WebSocket Server Settings → Enable, set password
□ Sources → + → Browser → Local File → rundown-obs-final.html
□ Width: 1920, Height: 1080
□ Custom CSS: body { background-color: rgba(0,0,0,0); margin: 0; overflow: hidden; }
□ ✓ Shutdown source when not visible
□ ✓ Refresh browser when scene becomes active
□ Source order: RUNDOWN Overlay above all camera sources
□ Right-click source → Interact → use for live button clicks
```

---

## 9. Performance Considerations

- **Poll interval:** 5s is conservative. Can drop to 2s if faster topic updates needed. Below 1s risks rate limiting `localhost`.
- **Ticker speed:** 60px/s. Adjust the divisor in `applyTicker()` — higher number = slower scroll.
- **Debounce window:** 300ms. If intentional rapid skipping feels sluggish, drop to 200ms.
- **Flash duration:** 90ms. Feels like a CRT display flash — don't extend beyond 150ms or it looks like a glitch.

---

## 10. Known Limitations

| Limitation | Mitigation |
|---|---|
| OBS WebSocket auth is synchronous-ish in async Python | Use `asyncio` + `websockets` library — already implemented |
| `file://` origin can't call `localhost` in some browsers | Not an issue in OBS Browser Source (Chromium, less restrictive) |
| `topics.json` has no versioning | Hash-based change detection is sufficient for v1 |
| No retry logic on failed WS refresh | `push-to-obs` returns `obs_refreshed: false`; overlay polls anyway as fallback |
| LCD text clipping on very long topics | Ticker handles this — but keep topic text under 40 chars for best legibility |

---

## 11. Future Technical Work

| Feature | Effort | Notes |
|---|---|---|
| Producer Remote (phone/tablet) | Low | Second HTML page polling same `/topics` endpoint, WebSocket for button presses back to server |
| WebSocket live push (replace polling) | Medium | Server → overlay WebSocket; eliminates 5s lag |
| Per-topic custom duration editing | Low | Add duration field to push-to-obs UI |
| Transition animations | Low | Slide-in/out between topics instead of flash |
| Lower-third overlay (separate source) | Low | Second browser source, just current topic + timer, full width bottom |
| Twitch chat `!topic` command | Medium | Twitch IRC bot reads `_current_topics[cur]` from bridge |

---

*End of TDD v2.0*
