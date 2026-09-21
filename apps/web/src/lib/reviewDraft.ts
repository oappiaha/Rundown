// Pure draft logic for the post-show review editor. A review draft is the
// local, unsaved rating/note/actual-seconds for one topic of one published
// version, pinned to the feedback revision it was taken from. Saving is always
// explicit and sends the exact full payload; the title, planned length and
// context are shown but never edited or sent.
import type { ReviewRating, ReviewTopic, ReviewUpdate } from "./api"

export const MAX_REVIEW_NOTE = 4000
export const MAX_ACTUAL_SECONDS = 86400

/** The editable fields. `actual` is the text as typed; "" means unrecorded (null on the wire). */
export type ReviewFields = { rating: ReviewRating; note: string; actual: string }

export type ReviewDraft = ReviewFields & {
  versionId: number
  topicId: number
  /** Revision sent with PUT so a save over a newer review is refused (409). */
  baseRevision: number
  base: ReviewFields
  /** Immutable facts shown beside the editor. */
  text: string
  planned: number
  context: string
}

export function actualText(seconds: number | null): string {
  return seconds === null ? "" : String(seconds)
}

export function fieldsOf(topic: Pick<ReviewTopic, "rating" | "note" | "actual_seconds">): ReviewFields {
  return { rating: topic.rating, note: topic.note, actual: actualText(topic.actual_seconds) }
}

export function draftFromTopic(topic: ReviewTopic, versionId: number): ReviewDraft {
  const base = fieldsOf(topic)
  return { ...base, versionId, topicId: topic.id, baseRevision: topic.revision, base, text: topic.text, planned: topic.planned_seconds, context: topic.context }
}

/**
 * Parse the actual-seconds field: null for blank (unrecorded), the integer for
 * a whole number 0–86400, undefined for anything else (fraction, negative,
 * out of range, not a number). 0 is a valid recorded value.
 */
export function parseActual(raw: string): number | null | undefined {
  const text = raw.trim()
  if (text.length === 0) return null
  if (!/^[+-]?\d+$/.test(text)) return undefined
  const value = Number(text)
  if (!Number.isInteger(value) || value < 0 || value > MAX_ACTUAL_SECONDS) return undefined
  return value
}

export function actualProblem(raw: string): string | null {
  return parseActual(raw) === undefined ? `Actual seconds must be a whole number from 0 to ${MAX_ACTUAL_SECONDS}, or left blank when not recorded.` : null
}

export function noteLength(note: string): number {
  return Array.from(note).length
}

export function noteProblem(note: string): string | null {
  return noteLength(note) <= MAX_REVIEW_NOTE ? null : `Review note is limited to ${MAX_REVIEW_NOTE} characters.`
}

export function validRating(rating: number): rating is ReviewRating {
  return rating === -1 || rating === 0 || rating === 1
}

/** First reason the draft cannot be saved, or null when it is valid. */
export function reviewProblem(draft: ReviewFields): string | null {
  if (!validRating(draft.rating)) return "Rating must be Good, Neutral or Bad."
  return noteProblem(draft.note) ?? actualProblem(draft.actual)
}

/** True when a field differs from the saved review. A blank and "0" actual differ (unrecorded vs zero seconds). */
export function isReviewDirty(draft: ReviewDraft): boolean {
  if (draft.rating !== draft.base.rating || draft.note !== draft.base.note) return true
  const mine = parseActual(draft.actual)
  const theirs = parseActual(draft.base.actual)
  if (mine === undefined) return draft.actual !== draft.base.actual
  return mine !== theirs
}

/** Exact wire form: revision plus the three fields, nothing else; blank actual becomes null. Throws on an invalid draft. */
export function toReviewWire(draft: ReviewDraft): ReviewUpdate {
  const actual = parseActual(draft.actual)
  if (actual === undefined) throw new Error("Invalid actual seconds")
  return { revision: draft.baseRevision, rating: draft.rating, note: draft.note, actual_seconds: actual }
}

/**
 * Keep the local values but pin the draft to a newer server copy of the same
 * topic after a 409. Explicit recovery only: the user still presses Save.
 */
export function rebaseDraft(draft: ReviewDraft, latest: ReviewTopic): ReviewDraft {
  return { ...draftFromTopic(latest, draft.versionId), rating: draft.rating, note: draft.note, actual: draft.actual }
}

// ---- Presentation -------------------------------------------------------------

export function ratingLabel(rating: ReviewRating): string {
  return rating === 1 ? "Good" : rating === -1 ? "Bad" : "Neutral"
}

/** Actual minus planned, or null while unrecorded/invalid. */
export function deltaOf(planned: number, actual: string | number | null): number | null {
  const value = typeof actual === "string" ? parseActual(actual) : actual
  if (value === null || value === undefined) return null
  return value - planned
}

/** "+30 s over plan", "−20 s under plan", "On plan (0 s)". */
export function deltaLabel(delta: number): string {
  if (delta === 0) return "On plan (0 s)"
  return delta > 0 ? `+${delta} s over plan` : `−${Math.abs(delta)} s under plan`
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time"
  } catch {
    return "local time"
  }
}

/** Local date and time with the short zone name, e.g. "Sep 15, 2026, 8:06 AM PDT". */
export function formatPublished(iso: string): string {
  const stamp = Date.parse(iso)
  if (Number.isNaN(stamp)) return iso || "unknown time"
  return new Date(stamp).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
}

export function formatReviewed(iso: string | null): string {
  if (iso === null) return "Not reviewed yet"
  const stamp = Date.parse(iso)
  if (Number.isNaN(stamp)) return `Reviewed ${iso}`
  return `Reviewed ${new Date(stamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
}
