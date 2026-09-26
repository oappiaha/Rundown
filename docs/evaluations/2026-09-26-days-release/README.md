# Streaming days release acceptance — September 26, 2026

Parent independently verified UI creation, the same topic in two dated days, immutable note snapshots, actual text upload and byte readback, invalid upload rejection without new topics, persistence across reload, mobile width, and unchanged live show. See parent-result.json and parent_accept.py (requires the disposable fixture stack from the worker report).

Fresh release checks: 271 API tests and 237 web tests passed; Ruff, Pyright, ESLint, TypeScript and production build passed. Build reports a non-blocking main bundle size warning. Worker report records 51 browser checks with synthetic providers; these do not establish live provider or OBS availability.

The implemented UI includes Discover Focus/Explore, persistent notes/bookmarks, dated plans, independent order/timing, manual/link capture and PNG/JPEG/TXT/Markdown/PDF upload (1 MiB). Existing saved-show activation remains explicit. Tonight's Show remains the landing view. Link metadata fetching, TikTok/Reddit expansion and preference learning remain deferred.

Uploads are raw-body requests. Image validation checks signatures/header dimensions, not complete pixel decoding; undecodable images fall back in the browser. PDFs are stored/downloaded, not parsed or OCRed. These are limits, not proof that all media formats are validated completely.

Deployment: attempted SSH to documented beezy@wolf-4 port 22; connection refused. No production service, database, OBS or host settings changed. Push is authorized for this release. Deployment remains pending access to the confirmed host.
