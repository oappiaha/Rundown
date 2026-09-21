import { expect, test } from "vitest"
import type { ResearchItem } from "./api"
import {
  MAX_SHORTLIST,
  addToShortlist,
  buildIntentKey,
  coverageOverlap,
  curationMoved,
  curationProblem,
  filterStories,
  groupByCategory,
  indexStories,
  isCurationDirty,
  mergeStories,
  moveInShortlist,
  newCurationDraft,
  newRequestId,
  pruneCleanDrafts,
  rebaseCuration,
  removeFromShortlist,
  sameSelections,
  selectionsFor,
  shortlistProblem,
  storyCount,
  toPreferencesWire,
} from "./researchDraft"

function story(id: string, patch: Partial<ResearchItem> = {}): ResearchItem {
  return {
    id,
    revision: 1,
    text: `Story ${id}`,
    duration: 120,
    notes: "",
    source_url: "",
    archived: false,
    created_at: "2026-09-15T00:00:00Z",
    updated_at: "2026-09-15T00:00:00Z",
    topic: { text: `Story ${id}`, duration: 120, notes: "" },
    source: null,
    preferences: { revision: 0, category: null, priority: 0, pinned: false, excluded: false },
    category: "uncategorized",
    category_origin: "keyword suggestion",
    score: 25,
    reasons: [],
    full_title: `Story ${id} full`,
    group_id: id,
    related_count: 0,
    ...patch,
  }
}

test("curation cannot be both pinned and excluded; wire carries the guarding revision", () => {
  expect(curationProblem({ category: null, priority: 1, pinned: true, excluded: true })).toMatch(/pinned story can't also be excluded/)
  expect(curationProblem({ category: "brain-rot", priority: 3, pinned: true, excluded: false })).toBeNull()
  expect(toPreferencesWire({ category: null, priority: 2, pinned: false, excluded: true }, 4)).toEqual({ revision: 4, category: null, priority: 2, pinned: false, excluded: true })
})

test("filter by category, excluded visibility and search", () => {
  const items = [
    story("a", { category: "ai-innovation" }),
    story("b", { category: "brain-rot", preferences: { revision: 1, category: null, priority: 0, pinned: false, excluded: true } }),
    story("c", { category: "ai-innovation", full_title: "Runway robots" }),
  ]
  expect(filterStories(items, { category: "all", showExcluded: true, search: "" }).map((item) => item.id)).toEqual(["a", "b", "c"])
  expect(filterStories(items, { category: "all", showExcluded: false, search: "" }).map((item) => item.id)).toEqual(["a", "c"])
  expect(filterStories(items, { category: "ai-innovation", showExcluded: true, search: "" }).map((item) => item.id)).toEqual(["a", "c"])
  expect(filterStories(items, { category: "all", showExcluded: true, search: "ROBOTS" }).map((item) => item.id)).toEqual(["c"])
})

test("grouping keeps category order and ranking order inside a group", () => {
  const categories = [
    { id: "ai-innovation" as const, label: "AI innovation" },
    { id: "brain-rot" as const, label: "Internet culture" },
  ]
  const grouped = groupByCategory([story("x", { category: "brain-rot" }), story("y", { category: "ai-innovation" }), story("z", { category: "ai-innovation" })], categories)
  expect(grouped.map((group) => [group.label, group.items.map((item) => item.id)])).toEqual([
    ["AI innovation", ["y", "z"]],
    ["Internet culture", ["x"]],
  ])
})

test("shortlist add/remove/move never duplicates and respects the cap", () => {
  let ids: string[] = []
  ids = addToShortlist(ids, "a")
  ids = addToShortlist(ids, "b")
  ids = addToShortlist(ids, "a")
  expect(ids).toEqual(["a", "b"])
  expect(moveInShortlist(ids, "b", -1)).toEqual(["b", "a"])
  expect(moveInShortlist(ids, "a", -1)).toBe(ids)
  expect(removeFromShortlist(ids, "zzz")).toBe(ids)
  expect(removeFromShortlist(ids, "a")).toEqual(["b"])
  const full = Array.from({ length: MAX_SHORTLIST }, (_, index) => `s${index}`)
  expect(addToShortlist(full, "extra")).toBe(full)
})

test("shortlist problems name excluded or vanished stories instead of dropping them", () => {
  const byId = indexStories([story("a"), story("b", { preferences: { revision: 2, category: null, priority: 0, pinned: false, excluded: true } })])
  expect(shortlistProblem([], byId)).toMatch(/at least one/)
  expect(shortlistProblem(["a"], byId)).toBeNull()
  expect(shortlistProblem(["a", "b"], byId)).toMatch(/is excluded/)
  expect(shortlistProblem(["a", "gone"], byId)).toMatch(/no longer in the active inbox/)
  expect(shortlistProblem(["a", "a"], byId)).toMatch(/only once/)
})

test("selections follow the latest revisions, so a curation save invalidates an older preview", () => {
  const before = indexStories([story("a"), story("b", { revision: 3 })])
  const first = selectionsFor(["b", "a"], before)
  expect(first).toEqual([
    { id: "b", revision: 3, preference_revision: 0 },
    { id: "a", revision: 1, preference_revision: 0 },
  ])
  const after = indexStories([story("a"), story("b", { revision: 3, preferences: { revision: 1, category: "ai-innovation", priority: 2, pinned: false, excluded: false } })])
  const second = selectionsFor(["b", "a"], after)
  expect(second && sameSelections(first ?? [], second)).toBe(false)
  expect(sameSelections(first ?? [], selectionsFor(["b", "a"], before) ?? [])).toBe(true)
  expect(sameSelections(first ?? [], selectionsFor(["a", "b"], before) ?? [])).toBe(false)
  expect(selectionsFor(["a", "missing"], before)).toBeNull()
})

test("build intent key changes with name or selection; request ids are v4 UUIDs", () => {
  const selections = [{ id: "a", revision: 1, preference_revision: 0 }]
  const key = buildIntentKey("Friday ", selections)
  expect(buildIntentKey("Friday", selections)).toBe(key)
  expect(buildIntentKey("Saturday", selections)).not.toBe(key)
  expect(buildIntentKey("Friday", [{ id: "a", revision: 2, preference_revision: 0 }])).not.toBe(key)
  const id = newRequestId()
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(newRequestId()).not.toBe(id)
})

test("coverage overlap lists shortlisted stories that share a group", () => {
  const byId = indexStories([story("a", { group_id: "g" }), story("b", { group_id: "g" }), story("c")])
  expect(coverageOverlap(["a", "c"], byId)).toEqual([])
  expect(coverageOverlap(["a", "b", "c"], byId).sort()).toEqual(["a", "b"])
})

test("curation drafts pin their base: a refresh reports a moved story instead of adopting its version", () => {
  const before = story("a")
  const draft = { ...newCurationDraft(before.preferences), values: { category: "ai-innovation" as const, priority: 2 as const, pinned: false, excluded: false } }
  expect(isCurationDirty(draft)).toBe(true)
  expect(curationMoved(draft, before)).toBe(false)
  const after = story("a", { preferences: { revision: 1, category: "brain-rot", priority: 0, pinned: true, excluded: false } })
  expect(curationMoved(draft, after)).toBe(true)
  const rebased = rebaseCuration(draft, after.preferences)
  expect(rebased.base.revision).toBe(1)
  expect(rebased.values).toEqual(draft.values)
  expect(curationMoved(rebased, after)).toBe(false)
  expect(toPreferencesWire(rebased.values, rebased.base.revision).revision).toBe(1)
})

test("clean drafts are pruned on reload; dirty ones survive", () => {
  const item = story("a")
  const clean = newCurationDraft(item.preferences)
  const dirty = { ...clean, values: { ...clean.values, pinned: true } }
  expect(Object.keys(pruneCleanDrafts({ a: clean, b: dirty }))).toEqual(["b"])
})

test("merging proposal stories replaces known rows in place and appends unknown ones", () => {
  const catalog = [story("a"), story("b", { revision: 1 })]
  const merged = mergeStories(catalog, [story("b", { revision: 2 }), story("new")])
  expect(merged.map((item) => [item.id, item.revision])).toEqual([
    ["a", 1],
    ["b", 2],
    ["new", 1],
  ])
  expect(mergeStories(catalog, [])).toEqual(catalog)
})

test("story counts pluralise", () => {
  expect([storyCount(0), storyCount(1), storyCount(2)]).toEqual(["no stories", "1 story", "2 stories"])
})
