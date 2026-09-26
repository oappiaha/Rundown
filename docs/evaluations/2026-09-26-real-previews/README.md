# Real-source preview smoke — September 26, 2026

Candidate df68aa8 (application release 44dd08a), sole root-owned stack: API 127.0.0.1:8193, Vite 3189, disposable /private/tmp/rundown-real-previews/demo.db. Provider credentials blank, fixture overrides blank, AI/preparation/RSS scheduling disabled. No production writes or model calls. Scripts retain scratch paths; allocate ports and a disposable DB before replay.

## Results

| Source | First preview latency | Result |
|---|---:|---|
| TypeSafe Jev announcement | 0.217s | Title, description, site fallback creator, thumbnail |
| Blender 4.5 LTS release page | 0.489s | Title, description, creator, thumbnail; bounded page prefix marked truncated |
| TikTok official docs example | 0.279s | Caption, creator, portrait cover |

Actual Chromium interactions for each: Discover → New → Link → paste source URL → enter own title/note → Preview → decode remote image → Create with preview → card → API readback → reload. All passed. Decoded images: TypeSafe 1200×630, Blender 1000×500, TikTok 720×1280 (provider dimensions differ from delivered cover; both portrait). New page context finds the saved TikTok card; 390px layout fits; zero JavaScript page errors. Preview alone creates no topics. Private-address rejection displays an error and manual save succeeds. Plans and live state unchanged.

This is three bounded public samples, not broad provider coverage. TikTok sample is from https://developers.tiktok.com/docs/en/embed-videos and demonstrates access, not topical relevance. Article sources are https://typesafe.ai/blog/introducing-system-one-models-and-jev and https://www.blender.org/download/releases/4-5/ .

TikTok cover URLs contain expiry/signature parameters. Their queries are omitted from durable evidence. Long-term image availability is not proven; existing artwork fallback applies if the URL later fails. No thumbnail renewal/caching added. Metadata can be site-level (the TypeSafe description/creator), not article-specific. No full text, transcripts or comments extracted.

No application code changed; required full suites passed in the immediately preceding release (299 API / 242 web) and were not rerun for this documentation-only smoke. Cleanup: owned local stack stopped after evidence capture; disposable records stay in scratch only. MacBook/OBS verification is next and requires the user's device.
