// Pure logic for the research shortlist and show composer. The shortlist is an
// ordered list of inbox story ids; the revisions a preview or build is pinned
// to are always derived from the latest loaded stories, so a curation save or
// a refresh never leaves a stale snapshot behind silently. Nothing here talks
// to the server or the live clock.
import type { ResearchCategoryId, ResearchItem, ResearchPreferences, ResearchPriority, ResearchSelection } from "./api"

export const MAX_SHORTLIST = 20
export const MIN_SUGGEST = 1
export const MAX_SUGGEST = 20
export const DEFAULT_SUGGEST = 8
export const MAX_SHOW_NAME = 80

/** "3 stories", "1 story", "no stories" */
export function storyCount(count: number): string {
  if (count === 0) return "no stories"
  return `${count} ${count === 1 ? "story" : "stories"}`
}

export const PRIORITY_LABELS: Record<ResearchPriority, string> = { 0: "0 · normal", 1: "1 · some", 2: "2 · high", 3: "3 · top" }

export type CategoryFilter = ResearchCategoryId | "all"

/** The four editable curation fields of one story, without the guarding revision. */
export type CurationValues = { category: ResearchCategoryId | null; priority: ResearchPriority; pinned: boolean; excluded: boolean }

export function curationOf(preferences: ResearchPreferences): CurationValues {
  return { category: preferences.category, priority: preferences.priority, pinned: preferences.pinned, excluded: preferences.excluded }
}

export function sameCuration(a: CurationValues, b: CurationValues): boolean {
  return a.category === b.category && a.priority === b.priority && a.pinned === b.pinned && a.excluded === b.excluded
}

/**
 * One story's curation being edited, pinned to the saved preferences it was
 * opened from. The base never moves on its own: a refresh that brings a newer
 * saved version is reported as a conflict, and only an explicit recovery
 * (reload, or keep my values on the latest version) replaces it.
 */
export type CurationDraft = { base: ResearchPreferences; values: CurationValues }

export function newCurationDraft(preferences: ResearchPreferences): CurationDraft {
  return { base: preferences, values: curationOf(preferences) }
}

export function isCurationDirty(draft: CurationDraft): boolean {
  return !sameCuration(draft.values, curationOf(draft.base))
}

/** True when the story's saved curation moved past the draft's base (another screen saved, or a refresh brought a newer version). */
export function curationMoved(draft: CurationDraft, item: ResearchItem): boolean {
  return item.preferences.revision !== draft.base.revision
}

/** Keep the edited values, take the latest saved version as the new base. The user still saves explicitly afterwards. */
export function rebaseCuration(draft: CurationDraft, latest: ResearchPreferences): CurationDraft {
  return { base: latest, values: draft.values }
}

/** After a reload, drafts with nothing typed are dropped so they follow the fresh data; edited ones keep their pinned base. */
export function pruneCleanDrafts(drafts: Record<string, CurationDraft>): Record<string, CurationDraft> {
  const next: Record<string, CurationDraft> = {}
  for (const [id, draft] of Object.entries(drafts)) if (isCurationDirty(draft)) next[id] = draft
  return next
}

/**
 * Fold freshly returned stories (a proposal) into the loaded catalog: a known
 * id is replaced in place with the newer copy, an unknown one is appended.
 * Ranking order of the known rows is kept; nothing is dropped.
 */
export function mergeStories(items: ResearchItem[], fresh: ResearchItem[]): ResearchItem[] {
  const byId = new Map(fresh.map((item) => [item.id, item]))
  const merged = items.map((item) => byId.get(item.id) ?? item)
  const known = new Set(items.map((item) => item.id))
  for (const item of fresh) if (!known.has(item.id)) merged.push(item)
  return merged
}

/** Why the curation cannot be saved, or null. Mirrors the server's 422 so the button never sends a doomed request. */
export function curationProblem(values: CurationValues): string | null {
  if (values.pinned && values.excluded) return "A pinned story can't also be excluded. Untick one of them."
  if (!Number.isInteger(values.priority) || values.priority < 0 || values.priority > 3) return "Priority must be 0–3."
  return null
}

/** Exact full payload for PUT /research/{id}/preferences. */
export function toPreferencesWire(values: CurationValues, revision: number): ResearchPreferences {
  return { revision, category: values.category, priority: values.priority, pinned: values.pinned, excluded: values.excluded }
}

export function validCount(count: number): boolean {
  return Number.isInteger(count) && count >= MIN_SUGGEST && count <= MAX_SUGGEST
}

export function validShowName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length >= 1 && trimmed.length <= MAX_SHOW_NAME
}

// ---- Story list ------------------------------------------------------------

export type StoryFilter = { category: CategoryFilter; showExcluded: boolean; search: string }

export function filterStories(items: ResearchItem[], filter: StoryFilter): ResearchItem[] {
  const needle = filter.search.trim().toLocaleLowerCase()
  return items.filter((item) => {
    if (!filter.showExcluded && item.preferences.excluded) return false
    if (filter.category !== "all" && item.category !== filter.category) return false
    if (needle.length > 0) {
      const haystack = `${item.full_title}\n${item.text}\n${item.notes}\n${item.source_url}`.toLocaleLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
}

/** Stories grouped in category order (only non-empty groups), each group keeping the server's ranking order. */
export function groupByCategory<T extends { category: ResearchCategoryId }>(items: T[], categories: Array<{ id: ResearchCategoryId; label: string }>): Array<{ id: ResearchCategoryId; label: string; items: T[] }> {
  const known = new Map(categories.map((category) => [category.id, category.label]))
  const order: ResearchCategoryId[] = [...categories.map((category) => category.id)]
  for (const item of items) if (!known.has(item.category)) {
    known.set(item.category, item.category)
    order.push(item.category)
  }
  return order
    .map((id) => ({ id, label: known.get(id) ?? id, items: items.filter((item) => item.category === id) }))
    .filter((group) => group.items.length > 0)
}

export function countByCategory(items: ResearchItem[]): Map<ResearchCategoryId, number> {
  const counts = new Map<ResearchCategoryId, number>()
  for (const item of items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
  return counts
}

// ---- Shortlist -------------------------------------------------------------

/** Append once; a duplicate or a full list leaves the input untouched. */
export function addToShortlist(ids: string[], id: string): string[] {
  if (ids.includes(id) || ids.length >= MAX_SHORTLIST) return ids
  return [...ids, id]
}

export function removeFromShortlist(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((entry) => entry !== id) : ids
}

export function moveInShortlist(ids: string[], id: string, direction: -1 | 1): string[] {
  const from = ids.indexOf(id)
  const to = from + direction
  if (from < 0 || to < 0 || to >= ids.length) return ids
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

export type StoryIndex = ReadonlyMap<string, ResearchItem>

export function indexStories(items: ResearchItem[]): Map<string, ResearchItem> {
  return new Map(items.map((item) => [item.id, item]))
}

/**
 * First reason the shortlist cannot be previewed or saved, or null. A story
 * that vanished (archived elsewhere) or was excluded since it was chosen stays
 * in the list and is named here rather than dropped behind the user's back.
 */
export function shortlistProblem(ids: string[], byId: StoryIndex): string | null {
  if (ids.length === 0) return "Add at least one story to the shortlist."
  if (ids.length > MAX_SHORTLIST) return `A show can hold at most ${MAX_SHORTLIST} stories.`
  if (new Set(ids).size !== ids.length) return "Each story can appear only once."
  for (const id of ids) {
    const item = byId.get(id)
    if (!item) return "A shortlisted story is no longer in the active inbox. Remove it or refresh the stories."
    if (item.preferences.excluded) return `"${item.full_title}" is excluded. Remove it from the shortlist or change its curation.`
  }
  return null
}

/** Selections pinned to the currently loaded revisions; null when any story is missing. */
export function selectionsFor(ids: string[], byId: StoryIndex): ResearchSelection[] | null {
  const selections: ResearchSelection[] = []
  for (const id of ids) {
    const item = byId.get(id)
    if (!item) return null
    selections.push({ id: item.id, revision: item.revision, preference_revision: item.preferences.revision })
  }
  return selections
}

export function sameSelections(a: ResearchSelection[], b: ResearchSelection[]): boolean {
  if (a.length !== b.length) return false
  return a.every((entry, index) => {
    const other = b[index]
    return other !== undefined && entry.id === other.id && entry.revision === other.revision && entry.preference_revision === other.preference_revision
  })
}

/** Stable identity of one save intent: the trimmed name plus the exact selections. A new intent gets a new request id. */
export function buildIntentKey(name: string, selections: ResearchSelection[]): string {
  return JSON.stringify({ name: name.trim(), selections: selections.map((entry) => [entry.id, entry.revision, entry.preference_revision]) })
}

/** Ids of shortlisted stories that share matching coverage (same headline or source URL) with another shortlisted story. */
export function coverageOverlap(ids: string[], byId: StoryIndex): string[] {
  const groups = new Map<string, string[]>()
  for (const id of ids) {
    const item = byId.get(id)
    if (!item) continue
    const list = groups.get(item.group_id) ?? []
    list.push(id)
    groups.set(item.group_id, list)
  }
  return [...groups.values()].filter((list) => list.length > 1).flat()
}

export function shortlistSeconds(ids: string[], byId: StoryIndex): number {
  return ids.reduce((sum, id) => sum + (byId.get(id)?.duration ?? 0), 0)
}

/** One id per save intent; crypto.randomUUID is standard in every supported browser, with a fallback for odd test hosts. */
export function newRequestId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === "function") return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes)
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
