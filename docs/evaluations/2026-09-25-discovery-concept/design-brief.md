# Rundown discovery concept — September25,2026

User direction: replace large wordy forms with open, scrollable, swipeable discovery. Mixed articles, YouTube, TikTok and Reddit conversations should feel like microlearning. Notes are personal, quick and central. Talking-point generation is out of scope. Work requested as samples with Claude/Fable before production overhaul.

## Product hierarchy
1. Discover: see the story, understand one idea, access source context.
2. Capture: save, jot a thought, optionally collect for a show.
3. Learn: explicit more/less feedback adjusts future discovery; reset is available.
Live production is downstream. Existing publication/conflict guards remain a future integration requirement.

## Sample boundaries
Two views of one story model: Focus and Explore. Fake content is labeled; deterministic local preference demonstration is not a trained recommendation service. Browser storage holds notes and saves only for the prototype. No live API, collector, AI provider or OBS connection.

## Acceptance
- First screen prioritizes content over explanatory prose, forms and diagnostics.
- All four media types are distinguishable while sharing save/note gestures.
- Desktop wheel/keyboard and phone swipe browse topics; text editing does not navigate.
- Note/save persist reload, follow the story across views, and do not jump the reading position.
- Explicit feedback changes future ranking; reversal/reset works without deleting notes.
- Source preview is honest about sample media; no pretend playback.
- Mobile390x844 has no horizontal overflow; keyboard focus and reduced motion respected.
- Show collection feels optional and small; no AI talking-point controls.

## Implementation follow-up after design selection
Map existing Inbox/source payloads into story cards while preserving source references. Combine discovery and research navigation. Introduce separate personal-note storage rather than overwriting imported source description. Record explicit preference events separately from editorial notes; keep diversity and manual control. Build real embeddings/player fallbacks and retrieval quality/access before claiming a learning service. Preserve existing live state and publication safeguards. Backend migration not part of this sample.
