// Pure logic for the assisted-preparation review flow. A suggestion is the
// locally editable copy of one generated run (summary + talking points). It
// never touches the saved idea by itself: appending it into the idea's context
// is a separate explicit action, and saving that context is another one.
import type { PreparationRun, PreparationView } from "./api"
import { notesLength } from "./draft"

export const MAX_SUMMARY = 1500
export const MIN_POINTS = 3
export const MAX_POINTS = 5
export const MAX_POINT = 500

export type Suggestion = {
  summary: string
  /** One talking point per entry, as typed (a leading bullet marker is stripped when parsed from a textarea). */
  points: string[]
}

/** Editable copy of a succeeded run, or null for anything else (nothing to review). */
export function suggestionFromRun(run: PreparationRun | null): Suggestion | null {
  if (!run || run.status !== "succeeded") return null
  return { summary: run.summary ?? "", points: [...run.talking_points] }
}

export function sameSuggestion(a: Suggestion | null, b: Suggestion | null): boolean {
  if (a === null || b === null) return a === b
  return a.summary === b.summary && a.points.length === b.points.length && a.points.every((point, index) => point === b.points[index])
}

/** Textarea representation of the points: one per line. */
export function pointsToText(points: string[]): string {
  return points.join("\n")
}

/**
 * Points from a textarea: one per non-blank line, trimmed, with a leading
 * "- ", "* " or "• " marker removed so the appended block never shows "- - x".
 */
export function parsePoints(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/^[-*•]\s+/, "").trim())
    .filter((line) => line.length > 0)
}

/** First reason the suggestion cannot be appended, or null when it is valid. */
export function suggestionProblem(suggestion: Suggestion): string | null {
  const summary = suggestion.summary.trim()
  if (summary.length === 0) return "Summary must not be empty."
  if (notesLength(summary) > MAX_SUMMARY) return `Summary must be at most ${MAX_SUMMARY} characters (currently ${notesLength(summary)}).`
  const points = suggestion.points.map((point) => point.trim()).filter((point) => point.length > 0)
  if (points.length < MIN_POINTS || points.length > MAX_POINTS) return `Talking points: ${MIN_POINTS} to ${MAX_POINTS} lines, one point per line (currently ${points.length}).`
  const long = points.findIndex((point) => notesLength(point) > MAX_POINT)
  if (long >= 0) return `Talking point ${long + 1} must be at most ${MAX_POINT} characters.`
  return null
}

/** The block that "Append to context" adds, exactly as the contract spells it. */
export function suggestionBlock(suggestion: Suggestion): string {
  const points = suggestion.points.map((point) => point.trim()).filter((point) => point.length > 0)
  return `Summary\n${suggestion.summary.trim()}\n\nTalking points\n${points.map((point) => `- ${point}`).join("\n")}`
}

/**
 * Current notes with the suggestion appended after a blank line. Existing
 * text is kept verbatim; only the separator is dropped when there is nothing
 * to separate from.
 */
export function appendSuggestion(notes: string, suggestion: Suggestion): string {
  const block = suggestionBlock(suggestion)
  return notes.length === 0 ? block : `${notes}\n\n${block}`
}

/** A fresh idempotency key for one deliberate generation click. */
export function newRequestId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === "function") return c.randomUUID()
  // RFC 4122 v4 layout from getRandomValues (older WebViews); never Math.random alone when a CSPRNG exists.
  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes)
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// ---- Per-idea review state ------------------------------------------------------
// What the panel remembers about one idea. Kept per idea, for the lifetime of
// the Inbox view (see prepStore.ts), so switching ideas, filters or views never
// drops an edited suggestion and a slow answer always lands on the idea it was
// requested for.


export type PrepNotice = { kind: "info" | "error"; text: string }

export type TopicPrep = {
  view: PreparationView | null
  loadError: string | null
  pending: "load" | "generate" | null
  /** The run under review: from our own generate answer or the server's latest. */
  run: PreparationRun | null
  /** As generated; edits are compared against it. */
  base: Suggestion | null
  /** Locally edited copy. */
  suggestion: Suggestion | null
  /** Textarea buffer for the points (one per line), parsed into `suggestion.points`. */
  pointsText: string
  consent: boolean
  notice: PrepNotice | null
  /** Context produced by "Append to context" for `run.id`, so the panel recognises its own edit in the parent. */
  applied: { runId: string; notes: string } | null
  /** A generate request that got no answer (network); resending reuses the same id so the server cannot run it twice. */
  ambiguous: { requestId: string; revision: number } | null
  inputOpen: boolean
  /** The server reported a newer run while local edits were pending. */
  newerRun: PreparationRun | null
}

export const EMPTY_PREP: TopicPrep = {
  view: null,
  loadError: null,
  pending: null,
  run: null,
  base: null,
  suggestion: null,
  pointsText: "",
  consent: false,
  notice: null,
  applied: null,
  ambiguous: null,
  inputOpen: false,
  newerRun: null,
}

/** Replace the run under review (and its editable copy); a pending append or newer-run note no longer applies. */
export function withRun(prep: TopicPrep, run: PreparationRun | null): TopicPrep {
  const base = suggestionFromRun(run)
  return { ...prep, run, base, suggestion: base, pointsText: base ? pointsToText(base.points) : "", applied: null, newerRun: null }
}

/**
 * Fold a fresh GET into what the panel already holds without dropping local
 * edits or an in-flight generate. Consent covers one exact input, so a changed
 * revision or text asks for it again. A lost request whose run turns out to
 * exist on the server is adopted here, which ends the ambiguity without a
 * second send.
 */
export function adoptView(prep: TopicPrep, view: PreparationView): TopicPrep {
  const inputChanged = prep.view !== null && (prep.view.revision !== view.revision || prep.view.input_text !== view.input_text
    || prep.view.settings.provider !== view.settings.provider || prep.view.settings.mode !== view.settings.mode
    || prep.view.settings.model !== view.settings.model)
  const next: TopicPrep = { ...prep, view, loadError: null, consent: inputChanged ? false : prep.consent }
  if (prep.pending === "generate") return next
  const latest = view.latest_run
  if (latest === null) return prep.run === null ? next : { ...next, run: prep.run }
  if (prep.ambiguous && latest.id === prep.ambiguous.requestId) {
    next.ambiguous = null
    next.notice = { kind: "info", text: "Found the result of the earlier request. Nothing was sent again." }
    // Continue normal adoption so finding a run never discards edited text.
  }
  if (prep.run && prep.run.id === latest.id) {
    // Same run: take the server's status/stale flags, keep the edited text.
    if (prep.run.status === "succeeded" && latest.status === "succeeded") return { ...next, run: { ...prep.run, stale: latest.stale } }
    return withRun(next, latest)
  }
  const edited = prep.suggestion !== null && !sameSuggestion(prep.suggestion, prep.base)
  if (edited) return { ...next, newerRun: latest }
  return withRun(next, latest)
}
