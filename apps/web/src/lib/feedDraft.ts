// Pure draft logic for the Sources (RSS feed) editor. A feed draft is a local,
// unsaved copy of one feed's configuration (or a brand-new feed that has never
// been saved), pinned to the revision it was taken from. Saving a draft never
// fetches the feed; importing is a separate, explicit action. The address of
// an existing feed is immutable: it is shown, never edited.
import type { Feed, FeedCreate, FeedUpdate, ImportRun } from "./api"
import { validDuration, MAX_DURATION, MIN_DURATION } from "./draft"
import { sourceUrlProblem } from "./inboxDraft"

export const MAX_FEED_NAME = 80
export const MAX_FEED_URL = 2048

export type FeedFields = { name: string; url: string; default_duration: number; enabled: boolean }

export type FeedDraft = FeedFields & {
  /** Feed id, or null for a feed that has never been saved. */
  id: string | null
  /** Revision the draft was taken from; sent with PUT and import so stale writes 409. */
  baseRevision: number
  base: FeedFields
}

export function fieldsOf(feed: FeedFields): FeedFields {
  return { name: feed.name, url: feed.url, default_duration: feed.default_duration, enabled: feed.enabled }
}

export function draftFromFeed(feed: Feed): FeedDraft {
  const base = fieldsOf(feed)
  return { ...base, id: feed.id, baseRevision: feed.revision, base }
}

/** A fresh, never-saved feed. New feeds start enabled (the server decides; create sends no flag). */
export function newFeedDraft(duration: number): FeedDraft {
  const base: FeedFields = { name: "", url: "", default_duration: duration, enabled: true }
  return { ...base, id: null, baseRevision: 0, base }
}

export function validFeedName(name: string): boolean {
  const length = Array.from(name.trim()).length
  return length >= 1 && length <= MAX_FEED_NAME
}

export function feedNameProblem(name: string): string | null {
  return validFeedName(name) ? null : `Feed name must be 1–${MAX_FEED_NAME} characters.`
}

/**
 * Why a feed address is not acceptable, or null. Syntax only: an absolute
 * http(s) address without credentials, whitespace or backslashes. Whether the
 * host may be fetched (private ranges, loopback) is the server's decision at
 * import time, so a local test address is accepted here.
 */
export function feedUrlProblem(raw: string): string | null {
  const url = raw.trim()
  if (url.length === 0) return "Feed URL is required: the full address of an RSS or Atom feed."
  const problem = sourceUrlProblem(url)
  if (problem === null) return null
  return problem.replace(/^Source URL/, "Feed URL")
}

export function feedDurationProblem(duration: number): string | null {
  return validDuration(duration) ? null : `Default length must be a whole number of seconds from ${MIN_DURATION} to ${MAX_DURATION}.`
}

/** First reason the draft cannot be saved, or null when it is valid. The URL is only checked for a new feed (it is immutable afterwards). */
export function feedProblem(draft: Pick<FeedDraft, "id" | "name" | "url" | "default_duration">): string | null {
  const name = feedNameProblem(draft.name)
  if (name) return name
  if (draft.id === null) {
    const url = feedUrlProblem(draft.url)
    if (url) return url
  }
  return feedDurationProblem(draft.default_duration)
}

export function isFeedDirty(draft: FeedDraft): boolean {
  if (draft.id === null) return true
  return draft.name !== draft.base.name || draft.default_duration !== draft.base.default_duration || draft.enabled !== draft.base.enabled
}

/** True when the user has typed anything worth protecting (a pristine new feed is not). */
export function hasFeedWork(draft: FeedDraft | null): boolean {
  if (draft === null) return false
  if (draft.id === null) return draft.name.trim().length > 0 || draft.url.trim().length > 0
  return isFeedDirty(draft)
}

/** Wire form for POST /feeds: name and URL trimmed, never an id or enabled flag. */
export function toFeedCreateWire(draft: FeedFields): FeedCreate {
  return { name: draft.name.trim(), url: draft.url.trim(), default_duration: draft.default_duration }
}

/** Wire form for PUT /feeds/{id}: revision plus every editable field; the URL is never sent. */
export function toFeedUpdateWire(draft: FeedDraft): FeedUpdate {
  return { revision: draft.baseRevision, name: draft.name.trim(), default_duration: draft.default_duration, enabled: draft.enabled }
}

/**
 * Rebase a draft onto a newer server copy of the same feed after a 409. A
 * field the user changed keeps the local value; a field left alone takes the
 * server's current value. The result is pinned to the server revision so the
 * next save is not stale. Explicit recovery only: polling never calls this.
 */
export function mergeFeedDraft(draft: FeedDraft, latest: Feed): FeedDraft {
  const next = draftFromFeed(latest)
  return {
    ...next,
    name: draft.name !== draft.base.name ? draft.name : latest.name,
    default_duration: draft.default_duration !== draft.base.default_duration ? draft.default_duration : latest.default_duration,
    enabled: draft.enabled !== draft.base.enabled ? draft.enabled : latest.enabled,
  }
}

// ---- Run presentation --------------------------------------------------------

/** "3 new · 2 duplicates · 1 skipped · 6 examined" */
export function runCounts(run: Pick<ImportRun, "created" | "duplicates" | "skipped" | "examined">): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  return `${plural(run.created, "new idea", "new ideas")} · ${plural(run.duplicates, "duplicate", "duplicates")} · ${run.skipped} skipped · ${run.examined} examined`
}

/** One-line status for list rows and the latest-run banner. */
export function runSummary(run: ImportRun | null): string {
  if (run === null) return "Never imported"
  if (run.status === "running") return "Importing…"
  if (run.status === "failed") return `Failed: ${run.error ?? "the feed could not be read."}`
  return `Imported ${runCounts(run)}`
}

/** Short absolute date-time for run history rows. */
export function stampLabel(iso: string | null): string {
  if (iso === null) return "—"
  const stamp = Date.parse(iso)
  if (Number.isNaN(stamp)) return iso
  return new Date(stamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

/** Hostname of a feed for compact rows, or "" when unparsable. */
export function feedHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ""
  }
}
