# Rundown · Discovery concept (standalone prototype)

An exploratory redesign sample for Rundown's discovery surface. Not a production
migration. Vanilla HTML/CSS/JS, no dependencies, no network requests, no backend.
All stories are invented ("Concept · sample stories" is shown in the header).

## Run

```
python3 -m http.server 3187 --bind 127.0.0.1 --directory ui/discovery-concept
open http://127.0.0.1:3187/
```

Any static file server works. Opening `index.html` directly from disk also works.

## What it shows

- **Two layout directions in one implementation**, switchable in the header:
  - **Focus**: one story per screen, vertical scroll-snap feed (TikTok/Deepstash feel). Wheel, trackpad, touch swipe, and keyboard (`↓`/`↑`, `j`/`k`) all move between cards.
  - **Explore**: a spacious editorial grid with a lead tile. `←`/`→` moves between tiles, `Enter` opens one.
  - Both share the same saved list, notes, and preference signals.
- **Micro-learning cards** keep the first screen short: kicker, title, dek, one takeaway, quick actions. **Read more** opens a reader (side panel on desktop, bottom sheet on phone) with the three takeaways and two short paragraphs. Inside the reader `↓`/`↑` step to the next or previous story.
- **Four source kinds**, three stories each: Article, YouTube, TikTok, Reddit. Video kinds show a clearly labelled *sample frame / no playback*. Reddit shows a small thread strip. **Open source** shows a local note with the would-be URL; nothing navigates or fetches.
- **Save** toggles in place and never moves the current card. **Note** is one tap: a textarea appears and autosaves to `localStorage` (status reads "Saved on this device").
- **Saved tray**: list of saved stories with note preview, move up/down, remove, and jump-to-story.
- **More / Less like this**: records a local signal (+/−1 on the topic, +/−0.5 on the source); each save adds +0.5 to its topic. The feed does **not** reorder under you. A toast offers **Undo**, and **Refresh feed** (chips row on desktop, or the **Tune** popover) re-ranks deterministically: `score = topic weight + source weight`, ties keep base order. **Tune** shows every weight, with Undo last and Reset. No AI claims; the copy says exactly what is happening.
- Topic chips: All / Film / Design / Tech / Sport.
- Dialogs (reader, tray, tune) make the rest of the page `inert` and trap Tab; `Esc` closes. `Esc` inside a note leaves the field so keyboard navigation works again. Arrow keys never move the feed while typing.
- `prefers-reduced-motion` disables transitions and smooth scrolling. Focus rings are visible.

## Files

```
index.html            shell + panels
assets/styles.css     warm off-white palette, near-black type, cobalt/lime accents, phone breakpoint at 720px
assets/app.js         state, ranking, rendering for both modes, SVG art generator, keyboard + dialog handling
assets/data.js        12 sample stories (fake)
../../docs/evaluations/2026-09-25-discovery-concept/  verification evidence
```

State lives under one `localStorage` key: `rundown.discovery.concept.v1`. Clear it to reset everything.
A small debug handle exists at `window.__rundown` (`state`, `visible()`, `weights()`).

## Design notes

Typography: system serif for headlines (Iowan Old Style / Palatino / Georgia), system sans for body,
mono uppercase for small labels (a nod to the earlier Walkman-style labels). Illustrations are generated
SVG compositions with a light grain, six palettes. No remote fonts or images.

## Known limitations

- Ranking is intentionally simple and transparent; it is a demo of "the harness learns tastes locally", not a recommender.
- Touch drag-reorder in the saved tray is not implemented; up/down buttons are.
- Only Chromium was exercised (see evidence). Safari/Firefox were not tested.
