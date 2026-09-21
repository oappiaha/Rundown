import { describe, expect, test } from "vitest"
import type { AnalysisRun, ResearchItem, ResearchPreferences } from "./api"
import { indexStories } from "./researchDraft"
import {
  MAX_ANALYSIS,
  analysisIntentKey,
  analysisSelections,
  briefProblem,
  choiceProblem,
  choicesFrom,
  defaultProposeCount,
  groupItems,
  previewCurrent,
  rankedItems,
  requestIdFor,
  runProblem,
  titleFor,
  toggleChoice,
  validProposeCount,
} from "./analysisDraft"

function prefs(patch: Partial<ResearchPreferences> = {}): ResearchPreferences {
  return { revision: 0, category: null, priority: 0, pinned: false, excluded: false, ...patch }
}

function story(id: string, patch: Partial<ResearchItem> = {}): ResearchItem {
  return {
    id,
    revision: 1,
    text: id,
    duration: 60,
    notes: "",
    source_url: "",
    archived: false,
    created_at: "2026-09-15T00:00:00Z",
    updated_at: "2026-09-15T00:00:00Z",
    topic: { text: id, duration: 60, notes: "" },
    source: null,
    preferences: prefs(),
    category: "uncategorized",
    category_origin: "keyword suggestion",
    score: 0,
    reasons: [],
    full_title: `${id} headline`,
    group_id: id,
    related_count: 0,
    ...patch,
  }
}

function run(patch: Partial<AnalysisRun> = {}): AnalysisRun {
  return {
    id: "run-1",
    status: "succeeded",
    brief: "Tonight's angle",
    selections: [
      { id: "a", revision: 1, preference_revision: 0 },
      { id: "b", revision: 1, preference_revision: 0 },
    ],
    started_at: "2026-09-15T10:00:00Z",
    model: "fixture-model",
    mode: "fixture",
    stale: false,
    items: [
      { id: "a", score: 95, category: "ai-innovation", group_id: "a", reason: "r-a" },
      { id: "b", score: 92, category: "ai-innovation", group_id: "a", reason: "r-b" },
    ],
    input_tokens: 300,
    output_tokens: 150,
    error: null,
    ...patch,
  }
}

const catalog = indexStories([story("a"), story("b"), story("c", { preferences: prefs({ revision: 2, excluded: true }) })])

describe("brief and choices", () => {
  test("brief needs 10 trimmed characters and at most 1000", () => {
    expect(briefProblem("   short   ")).toMatch(/at least 10/)
    expect(briefProblem("exactly10c")).toBeNull()
    expect(briefProblem("x".repeat(1000))).toBeNull()
    expect(briefProblem("x".repeat(1001))).toMatch(/at most 1000/)
  })

  test("toggle adds, removes and refuses a 21st story", () => {
    expect(toggleChoice([], "a")).toEqual(["a"])
    expect(toggleChoice(["a"], "a")).toEqual([])
    const twenty = Array.from({ length: MAX_ANALYSIS }, (_, index) => `s${index}`)
    expect(toggleChoice(twenty, "extra")).toBe(twenty)
    expect(toggleChoice(twenty, "s3")).toHaveLength(19)
  })

  test("choices copied from a list skip unknown, excluded and duplicate ids and stop at the bound", () => {
    expect(choicesFrom(["a", "zzz", "c", "b", "a"], catalog)).toEqual(["a", "b"])
    const many = indexStories(Array.from({ length: 25 }, (_, index) => story(`s${index}`)))
    expect(choicesFrom([...many.keys()], many)).toHaveLength(MAX_ANALYSIS)
  })

  test("choice problems name the empty, over-bound, missing and excluded cases; selections pin the loaded versions", () => {
    expect(choiceProblem([], catalog)).toMatch(/at least one/)
    expect(choiceProblem(Array.from({ length: 21 }, (_, index) => `s${index}`), catalog)).toMatch(/At most 20/)
    expect(choiceProblem(["a", "a"], catalog)).toMatch(/only once/)
    expect(choiceProblem(["a", "gone"], catalog)).toMatch(/no longer in the active inbox/)
    expect(choiceProblem(["a", "c"], catalog)).toBe('"c headline" is excluded. Untick it or change its curation.')
    expect(choiceProblem(["a", "b"], catalog)).toBeNull()
    expect(analysisSelections(["a", "c"], catalog)).toEqual([
      { id: "a", revision: 1, preference_revision: 0 },
      { id: "c", revision: 1, preference_revision: 2 },
    ])
    expect(analysisSelections(["a", "gone"], catalog)).toBeNull()
  })
})

describe("intent, preview and request id", () => {
  const selections = [{ id: "a", revision: 1, preference_revision: 0 }]

  test("the intent key follows the trimmed brief and every selection version", () => {
    const key = analysisIntentKey("  Angle for tonight ", selections)
    expect(analysisIntentKey("Angle for tonight", selections)).toBe(key)
    expect(analysisIntentKey("Angle for tonight!", selections)).not.toBe(key)
    expect(analysisIntentKey("Angle for tonight", [{ id: "a", revision: 2, preference_revision: 0 }])).not.toBe(key)
    expect(analysisIntentKey("Angle for tonight", [{ id: "a", revision: 1, preference_revision: 1 }])).not.toBe(key)
    expect(analysisIntentKey("Angle for tonight", [...selections, { id: "b", revision: 1, preference_revision: 0 }])).not.toBe(key)
  })

  test("a preview is current only for its own intent and until the server rejects it", () => {
    const key = analysisIntentKey("Angle for tonight", selections)
    const preview = { key, brief: "Angle for tonight", selections, inputText: "{}", inputHash: "0".repeat(64), truncated: false, rejected: false }
    expect(previewCurrent(preview, key)).toBe(true)
    expect(previewCurrent(preview, analysisIntentKey("Other angle here", selections))).toBe(false)
    expect(previewCurrent({ ...preview, rejected: true }, key)).toBe(false)
    expect(previewCurrent(preview, null)).toBe(false)
    expect(previewCurrent(null, key)).toBe(false)
  })

  test("one request id per intent and input hash; a different hash or intent gets a fresh one", () => {
    const first = requestIdFor(null, "k1", "h1")
    expect(first.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(requestIdFor(first, "k1", "h1")).toBe(first)
    expect(requestIdFor(first, "k1", "h2").requestId).not.toBe(first.requestId)
    expect(requestIdFor(first, "k2", "h1").requestId).not.toBe(first.requestId)
  })
})

describe("run usability, ranking and groups", () => {
  test("only a successful, non-stale run whose stories are unchanged locally can propose", () => {
    expect(runProblem(null, catalog)).toBe("No analysis yet.")
    expect(runProblem(run({ status: "running" }), catalog)).toMatch(/still running/)
    expect(runProblem(run({ status: "failed" }), catalog)).toMatch(/failed/)
    expect(runProblem(run({ status: "interrupted" }), catalog)).toMatch(/interrupted/)
    expect(runProblem(run({ stale: true }), catalog)).toMatch(/stories changed/)
    expect(runProblem(run(), catalog)).toBeNull()
    // Local checks catch what the server has not been asked about yet.
    const moved = indexStories([story("a", { revision: 2 }), story("b")])
    expect(runProblem(run(), moved)).toMatch(/curation changed since this analysis/)
    const curated = indexStories([story("a"), story("b", { preferences: prefs({ revision: 1, priority: 2 }) })])
    expect(runProblem(run(), curated)).toMatch(/curation changed/)
    const excluded = indexStories([story("a"), story("b", { preferences: prefs({ excluded: true }) })])
    expect(runProblem(run(), excluded)).toMatch(/curation changed|excluded/)
    const gone = indexStories([story("a")])
    expect(runProblem(run(), gone)).toMatch(/no longer in the active inbox/)
  })

  test("ranking is by score then id; groups keep the representative first and sort by best score; titles never show raw ids", () => {
    const three = run({
      selections: [
        { id: "a", revision: 1, preference_revision: 0 },
        { id: "b", revision: 1, preference_revision: 0 },
        { id: "c", revision: 1, preference_revision: 0 },
      ],
      items: [
        { id: "c", score: 70, category: "brain-rot", group_id: "c", reason: "r-c" },
        { id: "b", score: 92, category: "ai-innovation", group_id: "a", reason: "r-b" },
        { id: "a", score: 92, category: "ai-innovation", group_id: "a", reason: "r-a" },
      ],
    })
    expect(rankedItems(three).map((item) => item.id)).toEqual(["a", "b", "c"])
    expect(groupItems(three).map((group) => [group.representativeId, group.items.map((item) => item.id)])).toEqual([
      ["a", ["a", "b"]],
      ["c", ["c"]],
    ])
    expect(titleFor("a", catalog)).toBe("a headline")
    expect(titleFor("gone", catalog)).toBe("Story no longer in the inbox")
  })

  test("proposal count is bounded 1–20 and defaults to the analysed size", () => {
    expect(validProposeCount(0)).toBe(false)
    expect(validProposeCount(1)).toBe(true)
    expect(validProposeCount(20)).toBe(true)
    expect(validProposeCount(21)).toBe(false)
    expect(validProposeCount(Number.NaN)).toBe(false)
    expect(defaultProposeCount(run())).toBe(2)
    expect(defaultProposeCount(run({ items: [] }))).toBe(1)
  })
})
