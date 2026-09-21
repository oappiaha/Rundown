// Pure draft logic for the discovery-search editor in Sources (YouTube and
// Reddit retrieval). A search draft is a local, unsaved copy of one saved
// search's settings (or a brand-new search), pinned to the revision it was
// taken from. Saving never contacts a platform; collecting is a separate,
// explicit action that spends exactly one provider request per fresh attempt.
import type { RetrievalPlatform, RetrievalRun, RetrievalSource, RetrievalSourceCreate, RetrievalSourceUpdate } from "./api"
import { validDuration, MAX_DURATION, MIN_DURATION } from "./draft"

export const MAX_SEARCH_NAME = 80
export const MAX_QUERY = 200
export const MAX_SCOPE = 80
export const MIN_FRESHNESS_HOURS = 1
export const MAX_FRESHNESS_HOURS = 720
export const MIN_RESULTS = 1
export const MAX_RESULTS = 50

export const PLATFORMS: readonly RetrievalPlatform[] = ["youtube", "reddit"]
export const PLATFORM_LABEL: Record<RetrievalPlatform, string> = { youtube: "YouTube", reddit: "Reddit" }

export type SearchFields = {
  name: string
  platform: RetrievalPlatform
  query: string
  scope: string
  freshness_hours: number
  limit: number
  default_duration: number
  enabled: boolean
}

export type SearchDraft = SearchFields & {
  /** Search id, or null for a search that has never been saved. */
  id: string | null
  /** Revision the draft was taken from; sent with PUT and Collect now so stale writes 409. */
  baseRevision: number
  base: SearchFields
}

export function fieldsOf(source: SearchFields): SearchFields {
  return {
    name: source.name,
    platform: source.platform,
    query: source.query,
    scope: source.scope,
    freshness_hours: source.freshness_hours,
    limit: source.limit,
    default_duration: source.default_duration,
    enabled: source.enabled,
  }
}

export function draftFromSource(source: RetrievalSource): SearchDraft {
  const base = fieldsOf(source)
  return { ...base, id: source.id, baseRevision: source.revision, base }
}

/** A fresh, never-saved search: one week of results, 20 at most, active. */
export function newSearchDraft(duration: number, platform: RetrievalPlatform = "youtube"): SearchDraft {
  const base: SearchFields = { name: "", platform, query: "", scope: "", freshness_hours: 168, limit: 20, default_duration: duration, enabled: true }
  return { ...base, id: null, baseRevision: 0, base }
}

// ---- Validation (mirrors the server's rules so nothing invalid is ever sent) ----

export function searchNameProblem(name: string): string | null {
  const length = Array.from(name.trim()).length
  return length >= 1 && length <= MAX_SEARCH_NAME ? null : `Search name must be 1–${MAX_SEARCH_NAME} characters.`
}

export function queryProblem(query: string): string | null {
  if (Array.from(query).some((c) => c.charCodeAt(0) < 32)) return "Keywords must be a single line."
  return Array.from(query.trim()).length <= MAX_QUERY ? null : `Keywords must be at most ${MAX_QUERY} characters.`
}

/** The scope as the server stores it: trimmed; a subreddit loses its "r/" prefix and is lower-cased. */
export function normalizeScope(platform: RetrievalPlatform, scope: string): string {
  const trimmed = scope.trim()
  if (platform !== "reddit") return trimmed
  return trimmed.replace(/^r\//i, "").toLowerCase()
}

export function scopeProblem(platform: RetrievalPlatform, scope: string): string | null {
  const value = normalizeScope(platform, scope)
  if (value.length === 0) return null
  if (platform === "youtube") return /^UC[A-Za-z0-9_-]{22}$/.test(value) ? null : "A YouTube channel ID starts with UC and is 24 characters long (not a channel URL or @handle)."
  return /^[a-z0-9_]{2,21}$/.test(value) ? null : "A subreddit name is 2–21 letters, digits or underscores (with or without r/)."
}

export function targetProblem(query: string, scope: string): string | null {
  return query.trim().length > 0 || scope.trim().length > 0 ? null : "Enter keywords, a channel or subreddit, or both."
}

export function freshnessProblem(hours: number): string | null {
  return Number.isInteger(hours) && hours >= MIN_FRESHNESS_HOURS && hours <= MAX_FRESHNESS_HOURS ? null : `Freshness must be a whole number of hours from ${MIN_FRESHNESS_HOURS} to ${MAX_FRESHNESS_HOURS}.`
}

export function resultLimitProblem(limit: number): string | null {
  return Number.isInteger(limit) && limit >= MIN_RESULTS && limit <= MAX_RESULTS ? null : `Result limit must be a whole number from ${MIN_RESULTS} to ${MAX_RESULTS}.`
}

export function searchDurationProblem(duration: number): string | null {
  return validDuration(duration) ? null : `Default length must be a whole number of seconds from ${MIN_DURATION} to ${MAX_DURATION}.`
}

/** First reason the draft cannot be saved, or null when it is valid. */
export function searchProblem(draft: SearchFields): string | null {
  return (
    searchNameProblem(draft.name) ??
    queryProblem(draft.query) ??
    scopeProblem(draft.platform, draft.scope) ??
    targetProblem(draft.query, draft.scope) ??
    freshnessProblem(draft.freshness_hours) ??
    resultLimitProblem(draft.limit) ??
    searchDurationProblem(draft.default_duration)
  )
}

const FIELD_KEYS: readonly (keyof SearchFields)[] = ["name", "platform", "query", "scope", "freshness_hours", "limit", "default_duration", "enabled"]

export function isSearchDirty(draft: SearchDraft): boolean {
  if (draft.id === null) return true
  return FIELD_KEYS.some((key) => draft[key] !== draft.base[key])
}

/** True when the user has typed anything worth protecting (a pristine new search is not). */
export function hasSearchWork(draft: SearchDraft | null): boolean {
  if (draft === null) return false
  if (draft.id === null) return draft.name.trim().length > 0 || draft.query.trim().length > 0 || draft.scope.trim().length > 0
  return isSearchDirty(draft)
}

/** Wire form for POST /retrieval: text trimmed, scope normalised, every setting present. */
export function toSearchCreateWire(fields: SearchFields): RetrievalSourceCreate {
  return {
    name: fields.name.trim(),
    platform: fields.platform,
    query: fields.query.trim(),
    scope: normalizeScope(fields.platform, fields.scope),
    freshness_hours: fields.freshness_hours,
    limit: fields.limit,
    default_duration: fields.default_duration,
    enabled: fields.enabled,
  }
}

/** Wire form for PUT /retrieval/{id}: the create payload plus the revision the edit was made from. */
export function toSearchUpdateWire(draft: SearchDraft): RetrievalSourceUpdate {
  return { revision: draft.baseRevision, ...toSearchCreateWire(draft) }
}

// ---- Presentation ---------------------------------------------------------------

export function scopeLabel(platform: RetrievalPlatform): string {
  return platform === "youtube" ? "Channel ID (optional)" : "Subreddit (optional)"
}

export function scopePlaceholder(platform: RetrievalPlatform): string {
  return platform === "youtube" ? "UCxxxxxxxxxxxxxxxxxxxxxx" : "technology"
}

/** "keywords “AI tools” · r/technology": what the search asks the platform for. */
export function searchTarget(fields: Pick<SearchFields, "platform" | "query" | "scope">): string {
  const parts: string[] = []
  if (fields.query.trim()) parts.push(`keywords “${fields.query.trim()}”`)
  const scope = normalizeScope(fields.platform, fields.scope)
  if (scope) parts.push(fields.platform === "reddit" ? `r/${scope}` : `channel ${scope}`)
  return parts.join(" · ")
}

/** What is retained from a result, and what is deliberately not retrieved. */
export function retainedText(platform: RetrievalPlatform): string {
  return platform === "youtube"
    ? "Only each video's title and description are kept. Transcripts and the video itself are not retrieved."
    : "Only each post's title and text are kept. Linked articles and comments are not retrieved."
}

/** "2 new ideas · 1 duplicate · 1 skipped" */
export function runCounts(run: Pick<RetrievalRun, "created" | "duplicates" | "skipped">): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  return `${plural(run.created, "new idea", "new ideas")} · ${plural(run.duplicates, "duplicate", "duplicates")} · ${run.skipped} skipped`
}

export function statusWord(status: RetrievalRun["status"]): string {
  return status === "succeeded" ? "Succeeded" : status === "failed" ? "Failed" : status === "interrupted" ? "Interrupted" : "Running"
}

/** One-line status for list rows. */
export function runSummary(run: RetrievalRun | null): string {
  if (run === null) return "Never collected"
  if (run.status === "running") return "Collecting…"
  if (run.status === "interrupted") return "Last collection was interrupted · Collect now to start a new attempt"
  if (run.status === "failed") return `Failed: ${run.error ?? "the platform could not be read."}`
  return `Collected ${runCounts(run)}`
}

/**
 * A repeatable collection request. The UUID is chosen once per attempt and
 * kept until the server answers, so a retry after a dropped connection sends
 * the very same request and never spends a second provider call.
 */
export type CollectAttempt = { requestId: string; revision: number; startedAt: string }
