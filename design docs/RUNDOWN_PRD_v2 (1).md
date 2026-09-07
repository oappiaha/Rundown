# RUNDOWN — Product Requirements Document
**Version:** 2.1
**Author:** Beezy
**Status:** Active Build
**Last Updated:** Sept 2026
**Changelog:** v2.0 → v2.1 — OBS 32.1 compatibility (served overlay, not local file), launchd scheduling on Mac mini (VPS evaluated and rejected), topic preview via Tailscale. v1.0 → v2.0 — Phase 3 OBS Stream Integration shipped.

---

## 0. v2.1 Delta — Ship Checklist

Three changes, all small, all before next stream:

1. **Serve, don't file-load.** OBS 32.1 (Apr 2026) locked down `file://` browser sources. Overlay moves from Local File mode to URL mode: `http://localhost:8000/static/overlay.html`, served by the existing FastAPI app via StaticFiles. Removes the CORS requirement entirely (same-origin). Pin OBS ≥ 32.1.1 (32.1.0 had a WebSocket SetSourceSettings bug, fixed in RC3).
2. **launchd, not VPS.** Scraper + uvicorn run on Wolf-4 (M1 Mac mini) as launchd jobs — scraper on a schedule (7:00 AM daily + T-60min before stream), uvicorn with KeepAlive. VPS was evaluated and rejected: adds cost and a second deploy target to replicate what the always-on mini already does.
3. **Topic preview from anywhere.** Topic browser UI served at `/`, reachable over Tailscale (`http://wolf-4:8000/`). Morning scrape → topics reviewable on phone all day → push to overlay before going live.


---

## 1. Product Overview

RUNDOWN is a personal pre-stream content intelligence tool. It automates pre-production research across fashion, AI, and entertainment, generates a prioritized topic rundown, and now delivers that rundown directly into an OBS broadcast overlay — live, in real-time, with no manual file editing.

The core loop:
```
Research pipeline runs → Topics generated + scored →
Pushed to OBS overlay → Streamer advances topics live →
Timer counts down, LCD flips, bottom bar updates
```

---

## 2. Problem Statement

Same as v1.0. Streamers spend 1–3 hours on pre-production research that could be automated. The additional problem v2.0 solves: even with a good rundown, there was no broadcast-native way to display it — streamers were reading from notes or a second screen, breaking immersion.

---

## 3. Users

Primary user: Beezy (personal tooling, single-user).
Secondary: other streamers who want a branded broadcast rundown overlay (productization path).

---

## 4. Core Features — Shipped

### 4.1 Research Pipeline (v1.0 — unchanged)
- Multi-source ingestion: RSS, newsletters, Perplexity, web scrape
- Topic scoring: recency × cultural relevance × estimated talk time
- Claude-powered summarization per topic
- SQLite persistence on Mac mini

### 4.2 OBS Broadcast Overlay (v2.0 — NEW)

**Two-layer overlay architecture:**

**Layer A — Right Panel (310px, full height)**
- BEEZY wordmark + RUNDOWN label
- Dark LCD bezel with scanline texture
  - `NOW PLAYING` indicator with blinking dot
  - Topic name as scrolling marquee ticker (auto-scrolls when text overflows, static when it fits)
  - Track number (`TRK 01/08`) + countdown timer
  - Seekbar draining left-to-right
- Track list (8 topics): done/active/upcoming states
  - Done: struck through, 40% opacity, checkmark
  - Active: Sony blue left bar, gradient highlight, `▶` indicator
  - Upcoming: dimmed white
- Footer: model number + track counter

**Layer B — Bottom Bar (1920px wide, 110px tall)**
- Left: `NOW ON` label + current topic name + `Topic 01 of 08` subtitle
- Center: embossed hardware transport buttons
  - `⏮ PREV` `⏸ PAUSE / ▶ PLAY` `⏭ NEXT` `■ RESET`
  - Full 3D radial-gradient embossed look (convex surface simulation)
  - Press state: inset shadow, translate down 2px
- Right: track counter `01 / of 08`

**Aesthetic system — Sony Walkman / CD Player skin:**
- Body: multi-stop brushed platinum gradient with top shine + left bevel edge
- LCD: `#0a1520` background, `#78c8e8` text with glow, scanlines overlay
- Urgent state (≤15s): LCD text → `#e090a8`, step-blink animation
- Flash: white `opacity:0.06` overlay on topic change

**Transparency:** `body { background: transparent }` — only panel + bar render in OBS

### 4.3 Live Topic Bridge (v2.0 — NEW)

**FastAPI router (`rundown_obs_bridge.py`):**
- `GET /rundown/topics` — returns current topics + MD5 hash
- `POST /rundown/push-to-obs` — accepts topic array, stores in memory + `topics.json`, optionally fires OBS WebSocket refresh

**Overlay polling:**
- Polls `localhost:8000/rundown/topics` every 5 seconds
- Hash comparison: only resets rundown when topics actually changed
- Graceful fallback: if RUNDOWN server offline → `FALLBACK_TOPICS` array used silently
- On new topics detected: LCD flip animation, reset to track 01, timer restarts

**OBS WebSocket integration:**
- OBS 28+ built-in WebSocket v5 on port 4455
- Auth: SHA-256 HMAC challenge/response
- Trigger: `PressInputPropertiesButton` → `refreshnocache` on the browser source
- Non-blocking: if OBS isn't open, push-to-obs still succeeds

### 4.4 Keyboard Controls
- `→` / `N` — next topic (debounced 300ms to prevent OBS double-fire)
- `←` / `P` — previous topic (debounced)
- `Space` — pause/resume timer
- `1–8` — jump directly to topic number

### 4.5 Timer Behavior
- Per-topic duration set in TOPICS array (seconds)
- Auto-advances to next topic at 0:00
- Urgent state triggers at ≤15 seconds
- Pause freezes timer, does not reset
- Reset returns to topic 01 with full duration

---

## 5. Deliverables — File Manifest

| File | Purpose |
|---|---|
| `rundown-obs-final.html` | OBS Browser Source (1920×1080, transparent bg) |
| `rundown-stream-preview.html` | Browser preview with simulated cameras + producer controls |
| `rundown-walkman-demo.html` | Isolated Walkman device demo for testing controls |
| `rundown_obs_bridge.py` | FastAPI router for live topic push + OBS WebSocket refresh |

---

## 6. OBS Setup Requirements (v2.1)

1. OBS Studio **32.1.1+** (WebSocket v5 built in; 32.1.0's SetSourceSettings bug is fixed here)
2. Browser Source: **URL mode** → `http://localhost:8000/static/overlay.html` (NOT Local File — file:// sources are security-restricted as of OBS 32.1)
3. Width 1920, Height 1080; default Custom CSS retained
4. Source layer order: RUNDOWN Overlay on top of all camera sources
5. Interact window for clicking buttons while live (or keyboard shortcuts)
6. FastAPI (uvicorn) must be running before OBS loads the scene — launchd KeepAlive guarantees this

---

## 7. Known Issues — Resolved in v2.0

| Issue | Fix |
|---|---|
| Arrow key double-skip in OBS | 300ms debounce on `keydown` handler |
| Topic text overflow on LCD | CSS marquee ticker — auto-scrolls when `scrollWidth > clientWidth` |
| Panel not visible in browser | Expected — transparent bg; use stream-preview.html for testing |
| Buttons buried inside Walkman skin | Refactored to two-layer layout: panel (right) + transport bar (bottom) |

---

## 8. Success Metrics (unchanged from v1.0)

- Pre-production time < 5 minutes for a full 8-topic rundown
- Zero manual file edits to update topics between streams
- Timer accuracy: ±1 second per topic
- Overlay visible and functional in OBS within 60 seconds of stream start

---

## 9. Constraints (unchanged from v1.0)

- Single user, local infrastructure only (Mac mini + Tailscale)
- No cloud hosting for v1
- Time estimates are heuristic, not learned — calibrate manually first 5 streams

---

## 10. Future Development Paths — Updated

### Phase 4 (next): Producer Remote
- Second HTML page served by FastAPI
- Accessible on phone/tablet over Tailscale
- Controls: jump to topic, pause, reset, edit topic text live
- No OBS Interact window required

### Phase 5: Feedback + Learning (from v1.0)
- Post-stream rating per segment (good/bad)
- Claude uses ratings to improve scoring for next rundown
- Duration calibration from Twitch VOD timestamps

### Phase 6: Twitch Chat Integration
- `!topic` command prints current segment to chat
- Viewer vote on next topic
- Segment engagement correlation with sub/clip events

### Phase 7: Productization
- Multi-user auth (Clerk)
- Twitch OAuth identity
- Custom branding per streamer (replace BEEZY wordmark)
- Topic marketplace: share/clone rundowns from other streamers

### Phase 8: Distribution Expansion
- Newsletter/Substack draft export
- Tweet thread auto-generation from rundown
- Media archive with VOD timestamp index

---

*End of PRD v2.0*
