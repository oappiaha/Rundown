// Pure draft logic for a feed's automatic-import schedule. A schedule draft is
// a local, unsaved copy of the two settings the user controls (on/off and the
// interval), pinned to the schedule revision it was taken from. Saving is
// always explicit and never fetches the feed; the server runs due imports on
// its own. Everything here is presentation and validation: no network, no
// timers, no clock writes.
import type { FeedSchedule, FeedScheduleUpdate, ImportRun } from "./api"
import { runCounts } from "./feedDraft"

export const MIN_INTERVAL = 15
export const MAX_INTERVAL = 10080
export const DEFAULT_INTERVAL = 60

export type ScheduleFields = { enabled: boolean; interval_minutes: number }

export type ScheduleDraft = ScheduleFields & {
  /** Schedule revision the draft was taken from; sent with PUT so stale writes 409. */
  baseRevision: number
  base: ScheduleFields
}

export function scheduleFieldsOf(schedule: ScheduleFields): ScheduleFields {
  return { enabled: schedule.enabled, interval_minutes: schedule.interval_minutes }
}

export function draftFromSchedule(schedule: FeedSchedule): ScheduleDraft {
  const base = scheduleFieldsOf(schedule)
  return { ...base, baseRevision: schedule.revision, base }
}

export function validInterval(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= MIN_INTERVAL && minutes <= MAX_INTERVAL
}

export function intervalProblem(minutes: number): string | null {
  return validInterval(minutes) ? null : `Interval must be a whole number of minutes from ${MIN_INTERVAL} to ${MAX_INTERVAL} (7 days).`
}

/** First reason the draft cannot be saved, or null. The interval is checked even while off so a bad value is never stored. */
export function scheduleProblem(draft: ScheduleFields): string | null {
  return intervalProblem(draft.interval_minutes)
}

export function isScheduleDirty(draft: ScheduleDraft): boolean {
  return draft.enabled !== draft.base.enabled || draft.interval_minutes !== draft.base.interval_minutes
}

/** Wire form for PUT: the full strict payload, nothing else. */
export function toScheduleWire(draft: ScheduleDraft): FeedScheduleUpdate {
  return { revision: draft.baseRevision, enabled: draft.enabled, interval_minutes: draft.interval_minutes }
}

/**
 * Rebase a draft onto a newer server copy after a 409. A setting the user
 * changed keeps the local value; one left alone takes the server's. The result
 * is pinned to the server revision so the next save is not stale. Explicit
 * recovery only: polling never calls this on a dirty draft.
 */
export function mergeScheduleDraft(draft: ScheduleDraft, latest: FeedSchedule): ScheduleDraft {
  const next = draftFromSchedule(latest)
  return {
    ...next,
    enabled: draft.enabled !== draft.base.enabled ? draft.enabled : latest.enabled,
    interval_minutes: draft.interval_minutes !== draft.base.interval_minutes ? draft.interval_minutes : latest.interval_minutes,
  }
}

// ---- Presentation --------------------------------------------------------------

/** "every 15 minutes", "every hour", "every 90 minutes", "every 2 days" … */
export function intervalLabel(minutes: number): string {
  if (!validInterval(minutes)) return `every ${minutes} minutes`
  if (minutes === 60) return "every hour"
  if (minutes % 1440 === 0) {
    const days = minutes / 1440
    return days === 1 ? "every day" : `every ${days} days`
  }
  if (minutes % 60 === 0) return `every ${minutes / 60} hours`
  return `every ${minutes} minutes`
}

/** The browser's IANA time zone, or "" when unknown. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""
  } catch {
    return ""
  }
}

/** Short zone label for the given instant ("PDT", "GMT+2"), or "" when unknown. */
export function zoneLabel(at: Date): string {
  try {
    const part = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(at).find((entry) => entry.type === "timeZoneName")
    return part?.value ?? ""
  } catch {
    return ""
  }
}

/** Full local date-time with the zone, e.g. "Sep 15, 2026, 11:32:10 PDT"; the raw text when it cannot be parsed. */
export function dueLabel(iso: string): string {
  const stamp = Date.parse(iso)
  if (Number.isNaN(stamp)) return iso
  const at = new Date(stamp)
  const text = at.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })
  const zone = zoneLabel(at)
  return zone ? `${text} ${zone}` : text
}

/**
 * "in 58 minutes", "in 2 hours", "in 3 days", "in under a minute", or
 * "overdue: waiting for the server" once the due time has passed. The
 * comparison uses the server's own clock (server_time) so a skewed browser
 * clock never shows a wrong countdown.
 */
export function dueInLabel(nextRunAt: string, serverTime: string): string {
  const due = Date.parse(nextRunAt)
  const now = Date.parse(serverTime)
  if (Number.isNaN(due) || Number.isNaN(now)) return ""
  const seconds = Math.round((due - now) / 1000)
  if (seconds <= 0) return "due now: waiting for the server to run it"
  if (seconds < 60) return "in under a minute"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `in ${hours} ${hours === 1 ? "hour" : "hours"}`
  const days = Math.round(hours / 24)
  return `in ${days} days`
}

/** One line about the latest automatic run: status, counts or error. */
export function lastAutomaticSummary(run: ImportRun | null): string {
  if (run === null) return "No automatic import has run yet."
  if (run.status === "running") return "An automatic import is running now."
  if (run.status === "failed") return `Last automatic import failed: ${run.error ?? "the feed could not be read."}`
  return `Last automatic import: ${runCounts(run)}.`
}
