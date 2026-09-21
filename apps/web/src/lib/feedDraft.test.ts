import { describe, expect, test } from "vitest"
import type { Feed, ImportRun } from "./api"
import {
  draftFromFeed,
  feedDurationProblem,
  feedHost,
  feedNameProblem,
  feedProblem,
  feedUrlProblem,
  hasFeedWork,
  isFeedDirty,
  mergeFeedDraft,
  newFeedDraft,
  runCounts,
  runSummary,
  toFeedCreateWire,
  toFeedUpdateWire,
} from "./feedDraft"

function run(patch: Partial<ImportRun> = {}): ImportRun {
  return { id: "r1", feed_id: "f1", status: "succeeded", started_at: "2026-09-15T00:00:00Z", finished_at: "2026-09-15T00:00:02Z", created: 2, duplicates: 1, skipped: 1, examined: 4, error: null, warnings: [], items: [], ...patch }
}

function feed(patch: Partial<Feed> = {}): Feed {
  return { id: "f1", revision: 3, name: "Studio research", url: "http://127.0.0.1:8168/feed.xml", default_duration: 120, enabled: true, created_at: "2026-09-15T00:00:00Z", updated_at: "2026-09-15T00:00:00Z", can_import: true, latest_run: null, ...patch }
}

describe("feed validation", () => {
  test("name is trimmed and limited to 1–80 characters", () => {
    expect(feedNameProblem("  Studio  ")).toBeNull()
    expect(feedNameProblem("   ")).toMatch(/1–80/)
    expect(feedNameProblem("x".repeat(80))).toBeNull()
    expect(feedNameProblem("x".repeat(81))).toMatch(/1–80/)
  })

  test("URL must be an absolute http(s) address without credentials, whitespace or backslashes; a local fixture address is fine", () => {
    expect(feedUrlProblem("http://127.0.0.1:8168/feed.xml")).toBeNull()
    expect(feedUrlProblem("  https://example.com/rss?x=1  ")).toBeNull()
    expect(feedUrlProblem("")).toMatch(/required/)
    for (const bad of ["example.com/feed", "ftp://x/feed", "https://user:pw@example.com/feed", "https://example.com/a b", "https://example.com/a\\b", "https:example.com", "javascript:alert(1)"]) {
      const problem = feedUrlProblem(bad)
      expect(problem, bad).not.toBeNull()
      expect(problem, bad).toMatch(/^Feed URL/)
    }
  })

  test("default duration is a strict integer 15–3600", () => {
    expect(feedDurationProblem(15)).toBeNull()
    expect(feedDurationProblem(3600)).toBeNull()
    expect(feedDurationProblem(14)).not.toBeNull()
    expect(feedDurationProblem(3601)).not.toBeNull()
    expect(feedDurationProblem(90.5)).not.toBeNull()
    expect(feedDurationProblem(Number.NaN)).not.toBeNull()
  })

  test("a saved feed is never blocked by its (immutable) URL; a new one is", () => {
    const saved = { ...draftFromFeed(feed({ url: "not a url" })) }
    expect(feedProblem(saved)).toBeNull()
    const fresh = { ...newFeedDraft(120), name: "New", url: "not a url" }
    expect(feedProblem(fresh)).toMatch(/^Feed URL/)
  })
})

describe("feed draft", () => {
  test("new draft: pristine is not work, typing a name or URL is; create wire trims and never sends id or enabled", () => {
    const fresh = newFeedDraft(120)
    expect(isFeedDirty(fresh)).toBe(true)
    expect(hasFeedWork(fresh)).toBe(false)
    expect(hasFeedWork({ ...fresh, url: " http://x " })).toBe(true)
    expect(toFeedCreateWire({ ...fresh, name: "  A  ", url: "  http://127.0.0.1:8168/feed.xml " })).toEqual({ name: "A", url: "http://127.0.0.1:8168/feed.xml", default_duration: 120 })
  })

  test("saved draft: dirty on name/duration/enabled only; update wire carries the revision and no URL", () => {
    const draft = draftFromFeed(feed())
    expect(isFeedDirty(draft)).toBe(false)
    expect(isFeedDirty({ ...draft, url: "http://other" })).toBe(false)
    expect(isFeedDirty({ ...draft, enabled: false })).toBe(true)
    const wire = toFeedUpdateWire({ ...draft, name: " Renamed ", default_duration: 60, enabled: false })
    expect(wire).toEqual({ revision: 3, name: "Renamed", default_duration: 60, enabled: false })
    expect("url" in wire).toBe(false)
  })

  test("merge after a conflict keeps edited fields, takes the rest from the latest version, and re-pins the revision", () => {
    const draft = { ...draftFromFeed(feed()), name: "Mine" }
    const latest = feed({ revision: 5, name: "Theirs", default_duration: 45, enabled: false })
    const merged = mergeFeedDraft(draft, latest)
    expect(merged).toMatchObject({ baseRevision: 5, name: "Mine", default_duration: 45, enabled: false })
    expect(isFeedDirty(merged)).toBe(true)
    expect(isFeedDirty(mergeFeedDraft(draftFromFeed(feed()), latest))).toBe(false)
  })
})

describe("run presentation", () => {
  test("counts and summaries", () => {
    expect(runCounts(run())).toBe("2 new ideas · 1 duplicate · 1 skipped · 4 examined")
    expect(runCounts(run({ created: 1, duplicates: 2 }))).toBe("1 new idea · 2 duplicates · 1 skipped · 4 examined")
    expect(runSummary(null)).toBe("Never imported")
    expect(runSummary(run({ status: "running" }))).toBe("Importing…")
    expect(runSummary(run({ status: "failed", error: "HTTP 503" }))).toBe("Failed: HTTP 503")
    expect(runSummary(run())).toBe("Imported 2 new ideas · 1 duplicate · 1 skipped · 4 examined")
    expect(feedHost("http://127.0.0.1:8168/feed.xml")).toBe("127.0.0.1:8168")
    expect(feedHost("nope")).toBe("")
  })
})
