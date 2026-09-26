# Discovery concept — September25,2026

Standalone sample at ui/discovery-concept/index.html, created with Claude Code/Fable5.1 and independently verified by parent. Focus is an airy vertical feed; Explore is a spacious editorial grid. Both share personal notes, saved topics, a reorderable collection and explicit preference feedback. Twelve fictional stories span articles, YouTube, TikTok and Reddit. No production integration.

## Run
From repository root: `python3 -m http.server 3187 --bind 127.0.0.1 --directory ui/discovery-concept`, then open http://127.0.0.1:3187 on the Mac. The prototype README describes interactions. No dependency installation needed.

## Verification
Claude final Chromium run passed63/63 assertions; see claude-results.json and claude-REPORT.md. Independent parent browser flow covered note/save/reload, typing-arrow preservation, shared state across modes, saved order, preference reranking/reset preserving notes and saves, phone layout and media previews. acceptance.log and browser-result.json record success with no page errors/external requests. Independent CDP touch swipe advanced746px; Enter selected the correct story and Escape closed it (touch-result.json). Fresh contexts used throughout. Node syntax checks passed for both JS files. Main app files unchanged; production test suites were not rerun for this sample.

Parent reduced initial verbose Focus card to title/summary/one takeaway with full content behind Read more. Worker fixed Enter default activation opening the wrong story, note Escape focus, modal focus containment, and toast placement on phones. Original custom SVG art and local fonts; no remote assets.

## Evidence use
GIF is11 captured browser states, not continuous video; captures precede the final phone-toast placement adjustment and Enter fix, with same layouts. Final source hashes in checksums.json. Scripts preserve this Mac's explicit browser/Python/scratch paths; run browser.py with actions.py on stdin. claude-verify.py expects original scratch evidence folder. Adapt output paths when reproducing elsewhere. Screenshot/GIF originals retained at /private/tmp/rundown-ui-acceptance and /private/tmp/rundown-discovery-prototype/evidence/shots; delivery links alongside this report.

## Limits and safety
Fake media previews have no playback; Open source describes a fictional source. Local fixed ranking rules demonstrate feedback, not trained recommendations or live retrieval quality. Reset clears explicit signals while saved topics still contribute, as UI states. Notes remain in this browser, without cross-device sync or production-grade storage-failure recovery. No integrated show creation/publication, OBS controls or talking-point generation. Chromium/emulated touch only; Safari, physical-phone keyboard and comprehensive accessibility audit remain untested.

No real data, .env, collectors, providers, OBS, production UI or backend modified. No commit, push or deployment; earlier dirty state and pending commits preserved. Worker server cleanup is recorded separately below.

## Final acceptance and cleanup
Standalone downloadable HTML independently passed save/note/reload/Explore from file:// in fresh Chromium. It bundles identical final CSS/JS/data. Verified owned server PID78938 command then terminated it; browser contexts closed. Source/evidence retained; no verification service intentionally left running. Durable prototype README uses the repo path; worker report retains historical scratch paths.
