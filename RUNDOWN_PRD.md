# RUNDOWN — Product Requirements Document
**Version:** 1.0  
**Author:** Beezy  
**Status:** Pre-Build  
**Last Updated:** March 30, 2026

---

## 0. Document Philosophy

This PRD uses first-principles reasoning. Assumptions are surfaced and challenged explicitly. Requirements are written as constraints, not wishes.

---

## 1. Problem Statement

### 1.1 The Real Problem (First Principles)

The surface ask is: "build a tool that aggregates news for my stream." The actual problem is more specific and more valuable:

**Streamers who do talk-format content (reaction, commentary, news) spend significant unpaid pre-production time doing what broadcast networks have entire research teams for.** PTI has a production staff. Charlamagne Tha God has a morning prep team. Streamers doing equivalent content are solo.

The failure mode isn't "I can't find content." You can find content manually. The failure mode is:
- **Context switching cost**: Switching between Twitter, TikTok, YouTube, news sites to assemble a show wastes 1-2 hours pre-stream
- **Format loss**: You find good content but lose the thread by the time you're on stream
- **No structure**: Good content doesn't automatically become good TV. Without segment structure, streams meander.
- **No estimation**: You don't know if you have 30 minutes or 3 hours of material until you're already live

The PTI analogy is correct in one specific way: PTI is not a news show. It's a *structured opinion format built on top of news*. The tool needs to not just surface assets — it needs to produce a pre-structured show.

### 1.2 What This Is Not

- This is not a content aggregator like Feedly or Flipboard. Those are for reading, not for performing.
- This is not a social media scheduler. There's no publishing component.
- This is not an AI streamer. The human is the talent.
- This is not a news alerting system. Recency is ranked #3 — this is about *curated depth*, not breaking news.

---

## 2. Product Vision

**RUNDOWN** is a personal pre-stream intelligence tool. It runs daily collection jobs across configured topics, scores and clusters content by relevance and engagement, and produces a structured show rundown with embedded media and AI-generated talking points — so you arrive at stream with a formatted show, not a pile of links.

The mental model for the user experience: **you open RUNDOWN, you have a show.**

---

## 3. User

### 3.1 V1 User: Beezy Only

V1 is personal tooling. There is no onboarding, no multi-tenancy, no auth system, no user accounts. This is a significant architectural simplification and the correct call for V1.

Design implication: Build for speed of iteration, not for scale. Optimize developer experience over user experience — you're both.

### 3.2 V2 Consideration (Not Requirements)

If this works, the natural productization path is other variety/talk-format streamers. That future user is a Twitch/Kick streamer doing 3-5x/week, covering culture, gaming, sports, or news commentary. They are not technical and need full self-serve. V2 requirements are documented in Section 8 only.

---

## 4. Core Workflows

### 4.1 Daily Digest (Primary Workflow)

**Trigger:** Scheduled job runs each morning (configurable time, default 9AM).

**Process:**
1. Collector fetches new content across all configured topic channels
2. AI scoring layer ranks each asset for relevance to its topic
3. Curator selects top assets per topic, deduplicates, clusters
4. Rundown Generator produces a structured show outline

**Output:** A formatted, scrollable rundown of 10-15 segments with:
- Topic headline
- Estimated duration per segment
- 2-3 AI-generated talking points per segment
- Embedded or linked primary media asset (TikTok, YouTube, article, tweet)
- Secondary sources (supporting links)
- Total estimated show runtime

**User action:** Open the webapp, review the rundown, drag/reorder segments if needed, start stream.

### 4.2 On-Demand Deep Research (Secondary Workflow)

**Trigger:** User types a freeform query ("give me everything on the Rick Owens Paris show" or "what's the discourse on AI companions this week").

**Process:**
1. Query is parsed by Claude to extract topic, timeframe, and platform preferences
2. Ad-hoc collection fires against configured sources + query-specific search terms
3. Results are scored, clustered, and a single formatted segment card is produced

**Output:** A single segment card identical in format to a digest segment — headline, talking points, media, estimated time. Optionally appended to the current day's rundown.

### 4.3 Pre-Stream Summary (Tertiary Workflow)

**Trigger:** User clicks "Prepare Stream" button.

**Output:** A modal/overlay with:
- Total estimated runtime across selected segments
- One-sentence topic summary per segment (for the streamer to announce transitions)
- Quick-copy list of all segment titles (for overlays/chat commands)

---

## 5. Content Architecture

### 5.1 Topics (V1 Default Configuration)

Topics are configurable YAML/JSON. V1 ships with these six defaults:

| Topic ID | Name | Primary Platforms | Content Type |
|---|---|---|---|
| `fashion-drops` | Fashion Drops & Releases | TikTok, YouTube, RSS | New product drops, brand collabs, limited releases |
| `fashion-industry` | Fashion Industry News | RSS, X/Twitter | CD appointments, brand moves, show reviews |
| `fashion-tech` | Fashion Tech & Startups | RSS, YouTube, X/Twitter | Startup funding, new tools, innovation |
| `ai-innovation` | AI Innovation | RSS, X/Twitter, YouTube | Lab releases, new models, startup news |
| `film-entertainment` | Film & Entertainment | RSS, YouTube | Trailers, releases, reviews, discourse |
| `brain-rot` | Brain Rot | TikTok, YouTube | Viral moments, streamer content to react to |

### 5.2 Per-Topic Configuration Schema

```yaml
topic:
  id: "fashion-drops"
  name: "Fashion Drops & Releases"
  keywords: ["drop", "release", "collab", "limited edition", "sold out"]
  hashtags: ["#fashiondrop", "#newdrop", "#streetwear"]
  curated_accounts:
    tiktok: ["@hypebeast", "@ssense", "@endclothing"]
    youtube_channels: ["UCxxxx"]
    twitter_accounts: ["@hypebeast", "@highsnobiety"]
  rss_feeds:
    - "https://hypebeast.com/feed"
    - "https://highsnobiety.com/rss"
  max_assets_per_run: 20
  preferred_platform: "tiktok"  # surfaces first in segment card
```

### 5.3 Asset Scoring Model

Assets are scored on two dimensions by the AI layer:

**Relevance Score (1-10):** How well does this asset match the topic? Evaluated by Claude against the topic's keywords, accounts, and a topic-level description prompt.

**Engagement Score (normalized 0-1):** Platform-normalized engagement signal.
- TikTok: `(likes * 0.4 + comments * 0.4 + shares * 0.2) / views`
- YouTube: `(likes * 0.5 + comments * 0.5) / views`
- X/Twitter: `(retweets * 0.5 + likes * 0.3 + replies * 0.2) / impressions`
- Articles: Time-decay weighted; freshness is the proxy

**Composite Score:** `(relevance * 0.6) + (engagement * 0.4)`

This weighting reflects the priority ranking from product discovery: topic relevance first, engagement second.

### 5.4 Segment Time Estimation Logic

Estimated duration per segment is calculated by Claude based on:
- Number of media assets (video watch time + reaction buffer)
- Article density (read-and-summarize overhead)
- Topic complexity (more nuanced topics = more discussion)
- Historical calibration (user feedback loop in V2)

V1 default estimates:
- Single TikTok reaction: 3-5 min
- YouTube clip: 5-10 min
- Article discussion: 3-4 min
- Multi-asset topic (2-3 pieces): 8-12 min

---

## 6. Feature Requirements

### 6.1 Must Have (V1 Launch)

| ID | Requirement |
|---|---|
| F-01 | Daily automated collection job runs at configured time |
| F-02 | Rundown view: scrollable list of segments sorted by composite score |
| F-03 | Each segment card shows: headline, topic tag, platform, duration estimate, 2-3 talking points, primary media embed/link |
| F-04 | Manual segment reorder via drag-and-drop |
| F-05 | On-demand query input: freeform text → segment card output |
| F-06 | Mark segment as "used" or "skip" (persists per session) |
| F-07 | Pre-stream summary modal with total runtime and segment titles |
| F-08 | Topic configuration editable via UI (not just YAML) |
| F-09 | Collection status indicator (last run time, asset count per topic) |
| F-10 | Basic deduplication: same URL not added twice within a 7-day window |

### 6.2 Should Have (V1 if time allows)

| ID | Requirement |
|---|---|
| F-11 | TikTok video embed (inline player within segment card) |
| F-12 | YouTube embed (inline player within segment card) |
| F-13 | Swipe-to-skip on mobile (since you said swipeable) |
| F-14 | Historical archive: browse past digests by date |
| F-15 | Per-topic toggle: enable/disable without deleting config |

### 6.3 Won't Have (V1)

| ID | Requirement | Reason |
|---|---|---|
| F-X1 | Multi-user / auth | Personal tooling only |
| F-X2 | Push notifications / alerts | Pre-stream prep, not breaking news |
| F-X3 | Auto-posting to social | Out of scope |
| F-X4 | Live stream integration (OBS plugin) | V2 territory |
| F-X5 | Sentiment analysis / audience prediction | Over-engineering V1 |
| F-X6 | Automatic video download | Legal and storage risk |

---

## 7. Design Goals

### 7.1 AURA Design System Application

The frontend applies the AURA design system (Sony-inspired, desaturated metallics, Sony Blue / Lavender / Silver palette, light-mode-first). Specific application guidance:

- **Layout:** Single-column scrollable feed on the left (70% width), collapsible detail panel on the right (30%)
- **Segment cards:** Elevated with subtle shadow, topic color-coded via left border accent
- **Typography:** Editorial density — tight leading, clear hierarchy between segment headline and talking points
- **Status indicators:** Subtle, icon-based. No alert boxes.
- **Dark mode:** Supported as secondary. Stream environment is often dark.

### 7.2 Performance Requirements

- Initial load: < 2s
- Collection job runs async; UI never blocks on data fetch
- Rundown renders immediately from cached digest; fresh data loads in background

### 7.3 Design Anti-Patterns to Avoid

- Do not build a dashboard with charts and metrics. This is a *show prep tool*, not an analytics product.
- Do not surface raw links lists. Every piece of content must go through the segment card format.
- Do not display more than 15 segments by default. Overloading the rundown defeats the curation value.

---

## 8. Success Metrics

### 8.1 Primary (Personal Tooling)

Since V1 is personal tooling, success is behavioral, not KPI-driven:

| Metric | Target | Measurement |
|---|---|---|
| Pre-stream prep time | < 15 minutes from open to live | Self-tracked |
| Segments used per stream | > 70% of prepared segments | "Used" button clicks |
| On-demand query utility | Used at least once per stream week | Query log |
| Daily digest reliability | Collection job succeeds > 95% of scheduled runs | Server logs |

### 8.2 Quality Signal (Subjective)

The rundown is working when you stop opening Twitter/TikTok before a stream to find content. The tool has replaced that behavior. That is the single most important signal.

### 8.3 V2 Readiness Signal

If you use this consistently for 6 weeks and find yourself thinking "I wish I could share this with [streamer]," that's the signal to productize. The V2 decision gate is: **does it reliably save 60+ minutes of prep per stream?**

---

## 9. Risks & Assumption Challenges

### 9.1 The PTI Analogy Is Partially Wrong

PTI works because *two hosts disagree*. That friction is the entertainment engine. As a solo streamer, the talking points Claude generates will be directional, not oppositional. You need to bring your own POV and not just read the talking points verbatim. Risk: the tool makes the stream feel scripted. Mitigation: talking points are framed as *angles and questions*, not statements.

### 9.2 Relevance Scoring Will Be Wrong Early

Claude's relevance scoring is only as good as the topic configuration. Early runs will surface noise. This is expected. The feedback loop (marking assets as good/bad) is V2 — for V1, you tune through the YAML config. Budget 2-3 weeks of manual config tweaking before the digest feels right.

### 9.3 TikTok Is Your Preferred Platform But Is The Hardest to Access

You ranked TikTok first in preferred platform. TikTok has the most restrictive data access of all sources. There is no legitimate official API that supports "search TikToks by keyword or hashtag for content discovery." This means TikTok collection necessarily relies on third-party scrapers (with associated cost and legal gray zone). See TDD for full risk assessment.

### 9.4 "Streaming as Media Real Estate" Is a Distribution Strategy, Not a Product Feature

This is the right framing for *why* you're streaming, but it's not a product requirement. The tool doesn't need to understand or optimize for your distribution strategy — it just needs to give you good material. Don't let the bigger vision bloat the V1 requirements.

### 9.5 Time Estimation Will Be Wrong

Estimated durations in V1 are heuristic-based, not learned. You are not an average streamer and your pacing is specific to you. V1 estimates should be treated as rough guides. Calibrate manually for the first 5-6 streams.

---

## 10. Future Development Paths

### Phase 2: Feedback + Learning
- "This was good / bad" rating on segments after stream
- Claude uses historical ratings to improve scoring per topic
- Calibrated duration estimates from actual stream history (Twitch VOD timestamps)

### Phase 3: Stream Integration
- OBS browser source overlay showing current segment card
- Next segment preview widget
- Chat command: `!topic` prints current segment headline to Twitch chat

### Phase 4: Productization (If V1 Succeeds)
- Multi-user auth (Clerk or similar)
- Twitch OAuth for user identity
- Topic marketplace: share/clone topic configs from other streamers
- Twitch affiliate/sub revenue correlation (which segment topics drive most engagement)

### Phase 5: Distribution Expansion
- Exportable digest as newsletter/Substack draft
- Digest-to-short-form: auto-generate tweet threads from rundown
- Media library: archive of all used content with usage timestamps

---

*End of PRD v1.0*
