# Streaming-day UI concept

Original Rundown light/blue/silver styling with swipeable discovery and compact planning/capture drawers. This is a standalone iteration of ui/discovery-concept, not the production app.

From repository root: `python3 -m http.server 3188 --bind 127.0.0.1 --directory ui/streaming-day-concept` then open http://127.0.0.1:3188 on that Mac. The delivered single HTML file can also be downloaded and opened locally.

- Days: create dated, named streams. Add topics from discovery or saved library; reorder, set1–120minute durations, jot notes, remove topics from one day without deleting source ideas. The same topic can appear in multiple days. Personal notes are shared across appearances; order and duration belong to each day.
- New: write a topic, paste an http/https link, or upload TXT/Markdown, PNG/JPEG, or PDF. Upload maximum1MB; text maximum50,000characters. Files are stored locally. Text is retained as source material; images preview; PDF/image attachments can be downloaded using Open source. No OCR, PDF extraction or video hosting. Link submission stores the URL without fetching metadata; explicit Open source opens the real URL.
- Notes, library, days and attachments persist in this browser. No sync or production database. The same localStorage key supports prior discovery-demo notes/saves on the same origin. Storage is finite and new-topic failure preserves the draft.

Prototype data remains fictional unless you add it. No talking-point generation, real retrieval, OBS connection, live publication, cloud upload, or learned recommendation service. Mobile uses scrolling sheets; large files, cloud storage and complete production accessibility remain future work. Evidence: ../../docs/evaluations/2026-09-25-streaming-day-concept/README.md
