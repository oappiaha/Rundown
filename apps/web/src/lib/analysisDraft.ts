// Pure logic for the optional AI research analysis panel. Nothing here talks
// to the server or the clock. The panel's state is: an explicit set of chosen
// story ids (bounded, never pre-filled), a brief, an input preview pinned to
// the exact intent it was made from, and the run being shown. Every request
// body is derived from the loaded stories at the moment the user acts, never
// from a stale snapshot, and the intent key below decides when a preview,
// consent or request id stops applying.
import type { AnalysisItem, AnalysisRun, ResearchSelection } from "./api"
import { newRequestId, selectionsFor, sameSelections, type StoryIndex } from "./researchDraft"

export const MIN_BRIEF = 10
export const MAX_BRIEF = 1000
export const MAX_ANALYSIS = 20
export const MIN_PROPOSE = 1
export const MAX_PROPOSE = 20

export { newRequestId }

/** Why the brief cannot be sent, or null. Mirrors the server's 422 so a doomed request is never made. */
export function briefProblem(brief: string): string | null {
  const trimmed = brief.trim()
  if (trimmed.length < MIN_BRIEF) return `Describe the show angle in at least ${MIN_BRIEF} characters.`
  if (brief.length > MAX_BRIEF) return `The brief can hold at most ${MAX_BRIEF} characters.`
  return null
}

/** Toggle one story in the chosen set; adding beyond the bound leaves the set untouched. */
export function toggleChoice(ids: string[], id: string): string[] {
  if (ids.includes(id)) return ids.filter((entry) => entry !== id)
  if (ids.length >= MAX_ANALYSIS) return ids
  return [...ids, id]
}

/** Copy an ordered list of ids (e.g. the shortlist) into the chosen set, skipping unknown or excluded stories, bounded. */
export function choicesFrom(ids: string[], byId: StoryIndex): string[] {
  const out: string[] = []
  for (const id of ids) {
    const item = byId.get(id)
    if (!item || item.preferences.excluded || out.includes(id)) continue
    if (out.length >= MAX_ANALYSIS) break
    out.push(id)
  }
  return out
}


/** First reason the chosen stories cannot be analysed, or null. */
export function choiceProblem(ids: string[], byId: StoryIndex): string | null {
  if (ids.length === 0) return "Tick at least one story to analyze."
  if (ids.length > MAX_ANALYSIS) return `At most ${MAX_ANALYSIS} stories can be analyzed at once.`
  if (new Set(ids).size !== ids.length) return "Each story can be chosen only once."
  for (const id of ids) {
    const item = byId.get(id)
    if (!item) return "A chosen story is no longer in the active inbox. Untick it or refresh the stories."
    if (item.preferences.excluded) return `"${item.full_title}" is excluded. Untick it or change its curation.`
  }
  return null
}

/** Selections for the chosen stories at the currently loaded versions; null when any is missing. */
export function analysisSelections(ids: string[], byId: StoryIndex): ResearchSelection[] | null {
  return selectionsFor(ids, byId)
}

/**
 * Stable identity of one analysis intent: the trimmed brief plus the exact
 * selections (ids and versions). An input preview, a consent tick and a
 * request id all belong to one intent; when the key moves, they no longer
 * apply and the user previews and consents again.
 */
export function analysisIntentKey(brief: string, selections: ResearchSelection[]): string {
  return JSON.stringify({ brief: brief.trim(), selections: selections.map((entry) => [entry.id, entry.revision, entry.preference_revision]) })
}

/** The exact input the server showed for one intent, kept until the intent moves or the server rejects it. */
export type InputPreview = { key: string; brief: string; selections: ResearchSelection[]; inputText: string; inputHash: string; truncated: boolean; rejected: boolean }

export function previewCurrent(preview: InputPreview | null, key: string | null): boolean {
  return preview !== null && key !== null && preview.key === key && !preview.rejected
}

/** A generate request that got no answer. Resolved only by checking status, resending the identical body with the same id, or forgetting it. */
export type PendingRequest = { requestId: string; key: string; inputHash: string; brief: string; selections: ResearchSelection[] }

/**
 * One request id per intent + input hash. A lost answer or a double press
 * reuses it verbatim (the server then returns the same run without a second
 * provider call). After a terminal answer the intent is consumed: a deliberate
 * new analysis of the same stories gets a fresh id, because a failed or
 * interrupted id stays terminal on the server.
 */
export type IntentId = { key: string; inputHash: string; requestId: string }

export function requestIdFor(current: IntentId | null, key: string, inputHash: string): IntentId {
  if (current && current.key === key && current.inputHash === inputHash) return current
  return { key, inputHash, requestId: newRequestId() }
}

/**
 * Whether a run can be used for a proposal right now, judged locally against
 * the loaded stories in addition to the server's `stale` flag: every analysed
 * story must still exist at the analysed versions and not be excluded. Returns
 * the reason it cannot, or null.
 */
export function runProblem(run: AnalysisRun | null, byId: StoryIndex): string | null {
  if (run === null) return "No analysis yet."
  if (run.status === "running") return "The analysis is still running."
  if (run.status === "failed") return "The last analysis failed, so it cannot suggest a shortlist."
  if (run.status === "interrupted") return "The last analysis was interrupted, so it cannot suggest a shortlist."
  if (run.stale) return "The stories changed since this analysis. Analyze the current stories again to use it."
  const current = selectionsFor(
    run.selections.map((entry) => entry.id),
    byId,
  )
  if (current === null) return "An analyzed story is no longer in the active inbox. Refresh the stories and analyze again."
  if (!sameSelections(run.selections, current)) return "An analyzed story or its curation changed since this analysis. Analyze again to use it."
  for (const entry of run.selections) if (byId.get(entry.id)?.preferences.excluded) return "An analyzed story was excluded since this analysis. Analyze again to use it."
  return null
}

/** Analysed stories in AI rank order: score descending, then id, so equal scores are stable. */
export function rankedItems(run: AnalysisRun): AnalysisItem[] {
  return [...run.items].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}

export type AnalysisGroup = { representativeId: string; items: AnalysisItem[] }

/** Same-event groups by representative id, each ordered by score; groups ordered by their best score. Singletons included. */
export function groupItems(run: AnalysisRun): AnalysisGroup[] {
  const groups = new Map<string, AnalysisItem[]>()
  for (const item of rankedItems(run)) {
    const list = groups.get(item.group_id) ?? []
    list.push(item)
    groups.set(item.group_id, list)
  }
  return [...groups.entries()]
    .map(([representativeId, items]) => ({ representativeId, items }))
    .sort((a, b) => (b.items[0]?.score ?? 0) - (a.items[0]?.score ?? 0) || a.representativeId.localeCompare(b.representativeId))
}

/** Human title for an analysed story; never a raw id on screen. */
export function titleFor(id: string, byId: StoryIndex): string {
  return byId.get(id)?.full_title ?? "Story no longer in the inbox"
}

export function validProposeCount(count: number): boolean {
  return Number.isInteger(count) && count >= MIN_PROPOSE && count <= MAX_PROPOSE
}

/** Default suggestion size for a run: every analysed story, within the bound. */
export function defaultProposeCount(run: AnalysisRun): number {
  return Math.min(MAX_PROPOSE, Math.max(MIN_PROPOSE, run.items.length))
}
