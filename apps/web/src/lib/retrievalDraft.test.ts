import { describe, expect, test } from "vitest"
import type { RetrievalRun, RetrievalSource } from "./api"
import {
  draftFromSource,
  hasSearchWork,
  isSearchDirty,
  newSearchDraft,
  normalizeScope,
  runSummary,
  scopeProblem,
  searchProblem,
  searchTarget,
  toSearchCreateWire,
  toSearchUpdateWire,
} from "./retrievalDraft"

function source(patch: Partial<RetrievalSource> = {}): RetrievalSource {
  return { id: "s1", revision: 3, name: "AI tools", platform: "youtube", query: "AI tools", scope: "", freshness_hours: 168, limit: 20, default_duration: 120, enabled: true, created_at: "2026-09-16T00:00:00Z", updated_at: "2026-09-16T00:00:00Z", setup_reason: null, can_import: true, latest_run: null, ...patch }
}

function run(patch: Partial<RetrievalRun> = {}): RetrievalRun {
  return { id: "r1", source_id: "s1", revision: 3, status: "succeeded", started_at: "2026-09-16T00:00:00Z", finished_at: "2026-09-16T00:00:01Z", created: 2, duplicates: 1, skipped: 1, error: null, mode: "fixture", ...patch }
}

describe("search validation", () => {
  test("keywords or a scope is required; both may be given", () => {
    const fresh = { ...newSearchDraft(120), name: "New" }
    expect(searchProblem(fresh)).toMatch(/keywords, a channel or subreddit/)
    expect(searchProblem({ ...fresh, query: "AI" })).toBeNull()
    expect(searchProblem({ ...fresh, platform: "reddit", scope: "r/Technology" })).toBeNull()
  })

  test("a YouTube scope is a channel ID, a Reddit scope a subreddit name; r/ and case are normalised", () => {
    expect(scopeProblem("youtube", "UC" + "a".repeat(22))).toBeNull()
    expect(scopeProblem("youtube", "https://youtube.com/@handle")).toMatch(/channel ID/)
    expect(scopeProblem("reddit", "r/Technology")).toBeNull()
    expect(scopeProblem("reddit", "a")).toMatch(/subreddit/)
    expect(scopeProblem("reddit", "has space")).toMatch(/subreddit/)
    expect(normalizeScope("reddit", " R/Technology ")).toBe("technology")
    expect(normalizeScope("youtube", " UCabc ")).toBe("UCabc")
  })

  test("keywords are a single line of at most 200 characters; counts are strict integers within range", () => {
    const base = { ...newSearchDraft(120), name: "New", query: "AI" }
    expect(searchProblem({ ...base, query: "line\nbreak" })).toMatch(/single line/)
    expect(searchProblem({ ...base, query: "x".repeat(201) })).toMatch(/200/)
    expect(searchProblem({ ...base, freshness_hours: 0 })).toMatch(/Freshness/)
    expect(searchProblem({ ...base, freshness_hours: 721 })).toMatch(/Freshness/)
    expect(searchProblem({ ...base, limit: 51 })).toMatch(/Result limit/)
    expect(searchProblem({ ...base, limit: 2.5 })).toMatch(/Result limit/)
    expect(searchProblem({ ...base, default_duration: 14 })).toMatch(/Default length/)
    expect(searchProblem({ ...base, name: " " })).toMatch(/Search name/)
  })
})

describe("drafts and wire payloads", () => {
  test("a saved draft is clean until a field changes; a new draft only counts as work once something is typed", () => {
    const draft = draftFromSource(source())
    expect(isSearchDirty(draft)).toBe(false)
    expect(hasSearchWork(draft)).toBe(false)
    expect(isSearchDirty({ ...draft, enabled: false })).toBe(true)
    expect(hasSearchWork(newSearchDraft(120))).toBe(false)
    expect(hasSearchWork({ ...newSearchDraft(120), scope: "r/x" })).toBe(true)
  })

  test("payloads trim text, normalise the scope and carry every setting; the update adds the base revision", () => {
    const draft = { ...draftFromSource(source({ platform: "reddit" })), name: " Reddit AI ", query: " AI ", scope: "r/Technology" }
    expect(toSearchCreateWire(draft)).toEqual({ name: "Reddit AI", platform: "reddit", query: "AI", scope: "technology", freshness_hours: 168, limit: 20, default_duration: 120, enabled: true })
    expect(toSearchUpdateWire(draft)).toMatchObject({ revision: 3, scope: "technology" })
    expect(searchTarget(draft)).toBe("keywords “AI” · r/technology")
  })

  test("run summaries name every outcome, including an interrupted lease", () => {
    expect(runSummary(null)).toBe("Never collected")
    expect(runSummary(run())).toBe("Collected 2 new ideas · 1 duplicate · 1 skipped")
    expect(runSummary(run({ status: "failed", error: "Quota exceeded." }))).toBe("Failed: Quota exceeded.")
    expect(runSummary(run({ status: "interrupted" }))).toMatch(/interrupted/)
  })
})
