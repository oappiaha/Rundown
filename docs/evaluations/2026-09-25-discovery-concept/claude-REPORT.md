# Evidence report · Rundown discovery prototype

**Status:** complete, verified in a real browser (Chromium via Playwright), 63/63 checks passed on the final run (`results.json`, ran 2026-09-24 23:53 local). Server left running for parent acceptance.

## Candidate files
- `/private/tmp/rundown-discovery-prototype/index.html`
- `/private/tmp/rundown-discovery-prototype/assets/styles.css`
- `/private/tmp/rundown-discovery-prototype/assets/app.js`
- `/private/tmp/rundown-discovery-prototype/assets/data.js`
- `/private/tmp/rundown-discovery-prototype/README.md`
- `evidence/verify.py`, `evidence/results.json`, `evidence/shots/01..17-*.png`, `evidence/server.log`, `evidence/server.pid`

## Environment lease
- Working tree: `/private/tmp/rundown-discovery-prototype` (standalone, no git). Repo `/Users/rei/2026/Rundown` read only, untouched.
- Start command: `python3 -m http.server 3187 --bind 127.0.0.1 --directory /private/tmp/rundown-discovery-prototype`
- Process: PID **78938** (`evidence/server.pid`), log `evidence/server.log`. URL **http://127.0.0.1:3187/**
- Data: browser `localStorage` only, fresh Playwright contexts per run (no profile reuse). No DB, no accounts.
- Browser: `/Users/rei/Library/Caches/ms-playwright/chromium-1217/.../Google Chrome for Testing`, driven by `/Users/rei/2026/Rundown/apps/api/.venv/bin/python evidence/verify.py`.

## Static checks
- `node --check assets/app.js` → ok; `node --check assets/data.js` → ok
- `grep` for `http|fetch|XMLHttp|import(` in app/index → only the `xmlns` inside an inline `data:` favicon (not a request).

## Done checklist (action → observation → evidence)
| Criterion | Action | Observed | Evidence |
|---|---|---|---|
| Browse four content types by scroll/swipe | Desktop: mouse wheel then `↓`/`↑` walk of all 12 cards. Mobile: two CDP touch swipes (touchStart/Move/End) | Wheel moved to card 2; keyboard walk hit article, youtube, tiktok, reddit; both swipes advanced exactly one card (`oner → grid → serve`) | results.json "mouse wheel", "keyboard walk", "touch swipe"; shots 01, 02, 11, 12 |
| Save + note persist reload | Click Save, click Note, type, wait, `page.reload()` | Save button `aria-pressed=true` and textarea prefilled after reload; badge 2; localStorage readback shows saved ids + note text. Mobile repeated: saved `[serve]`, note "Count the bounces" after reload | "after reload …" checks; shots 06, 13 |
| Local feedback visibly changes later ordering, undo, reset | Two "More like this" on a Sport story → Tune → Refresh; then Undo, Reset, Refresh. Mobile: "Less" on a Film story → Refresh | Current card did not move on More (scrollTop 1792 → 1792, same id, order unchanged); toast with Undo; Tune shows Sport +2.0 / 2 signals; after Refresh the three Sport stories are first; Undo → +1.0; Reset → 0 signals; order returns to base. Mobile: Film stories last three | shots 04, 05, 15 |
| Two visual modes share state | Save/note in Focus → switch to Explore; toggle save in Explore reader → back to Focus | Explore tile shows Saved + "Has note"; toggle in reader mirrored on tile in place and in the Focus card | shots 08, 09 |
| Mobile: no horizontal overflow | 390×844 focus (incl. TikTok card), explore | `document.scrollWidth = 390`, stage `scrollWidth ≤ clientWidth`, no non-SVG element extends past the right edge (offscreen panels/popover/toast excluded by design) | "no horizontal overflow" checks; shots 11, 12, 16 |
| Typing arrows don't change card (negative) | Focus textarea, press `↓ ↓ j ↑` on desktop and `↓ ↑` on mobile | Same card id before/after, focus stayed in textarea, the literal `j` landed in the note | "NEGATIVE …" checks; shot 06 |
| No requests to live API / real source | All `request` events collected across both contexts; "Open source" clicked | 16 requests, all to `http://127.0.0.1:3187/`; Open source shows local toast, URL unchanged, no new page | "NETWORK …", "Open source …"; shot 10 |
| Reader / dialogs (parent add-on) | Read more; 14× Tab; `↓` in reader; `Esc` | Reader has 3 takeaways + 2 paragraphs; stage/header carry `inert`; Tab never left the reader; `↓` stepped to next story; `Esc` closed and the feed sat on that story; inert removed | shots 03, 09, 14 |
| Saved tray + reorder | Open tray, move second item up | Items listed in save order with note preview; after Up the order swapped and persisted | shots 07, 17 |
| Keyboard in Explore | `→`, `Enter` | Next tile focused; Enter opened the reader on that tile (after fixing the Enter default-activation bug) | shot 09 |
| Console health | Both contexts | Zero console errors / page errors | "no console errors" |

## Negative / preservation
- Arrow keys and `j` inside a textarea do not navigate (desktop and mobile).
- "More like this" and "Save" leave the current card and the feed order untouched until Refresh.
- Every network request stayed on loopback; "Open source" never navigates.
- Fresh mobile context started with 0 saved (no state bleed between contexts).

## Fixes made during verification (real behavior)
1. Enter on an Explore tile opened the reader and then immediately stepped back one story: focus moved to the reader's "previous" button before Enter's default activation fired. Fixed with `preventDefault`.
2. `Esc` while typing a note left focus in the textarea, so the next `j` was typed instead of navigating. `Esc` now blurs the field.
3. Phone toast overlapped the note textarea and reader body; the toast now anchors under the chips on phones.
4. Parent review: first-screen card was too wordy. Focus card reduced to kicker + title + dek + one takeaway + actions; full body moved behind "Read more". Added `inert` + Tab trap for dialogs.

Harness-only corrections (not app defects): waiting for scroll-snap to settle before reading positions; the note status label is CSS-uppercased; the overflow probe originally counted SVG geometry clipped inside its own viewport.

## Side effects / cleanup
- Retained on purpose: static server PID 78938 on 127.0.0.1:3187 (kill with `kill $(cat evidence/server.pid)`).
- Nothing written outside `/private/tmp/rundown-discovery-prototype/` (except this run's Playwright temp profiles, auto-removed). `state.md` untouched. No repo writes, no commits, no external calls.

## Risks / limitations
- Verified in Chromium only; Safari/Firefox untested (system font stack, `dvh`, `inert`, scroll-snap all mainstream but unchecked here).
- Touch swipe was proven with synthesized CDP touch events, not a physical device.
- Ranking is a transparent toy (topic/source weights); it is not meant to be a recommender.
- Drag-to-reorder in the tray is buttons only.
