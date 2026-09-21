// Pure logic for whole-show preparation review. A note draft is the locally
// editable copy of one generated item (summary + talking points) for one saved
// topic. Nothing here writes to the show: appending the reviewed notes is the
// explicit, revision-guarded "Save prepared notes" action handled by the panel,
// and it happens at most once per run.
import type { SavedShowTopic, ShowPreparationApply, ShowPreparationInput, ShowPreparationItem, ShowPreparationRun, ShowPreparationStatus } from "./api"
import { MAX_NOTES, notesLength } from "./draft"

/** The topic-notes limit the save is checked against (re-exported for tests and hints). */
export const MAX_NOTES_HINT = MAX_NOTES
import { parsePoints, pointsToText } from "./prepDraft"

export const MAX_SHOW_SUMMARY = 800
export const MAX_SHOW_POINT = 300
export const MIN_SHOW_POINTS = 3
export const MAX_SHOW_POINTS = 5
export const MAX_APPLY_ITEMS = 20
/** Heading the server puts above every appended block (contract). */
export const PREPARED_HEADING = "Prepared notes (AI-assisted, reviewed)"

export type NoteDraft = {
  /** Saved topic id the item was generated for. */
  id: string
  summary: string
  /** Textarea buffer, one point per line; `points` is its parsed form. */
  pointsText: string
  points: string[]
  /** Ticked for "Save prepared notes". All ticked by default; review is the explicit save. */
  selected: boolean
}

export function draftsFromRun(run: ShowPreparationRun | null): NoteDraft[] | null {
  if (!run || run.status !== "succeeded") return null
  return run.items.map((item) => ({ id: item.id, summary: item.summary, pointsText: pointsToText(item.talking_points), points: [...item.talking_points], selected: true }))
}

/** Text-only comparison (selection is not an "edit"). */
export function sameNotes(a: NoteDraft[] | null, b: NoteDraft[] | null): boolean {
  if (a === null || b === null) return a === b
  if (a.length !== b.length) return false
  return a.every((draft, index) => {
    const other = b[index]
    return other !== undefined && draft.id === other.id && draft.summary === other.summary && draft.points.length === other.points.length && draft.points.every((point, i) => point === other.points[i])
  })
}

/** First reason one draft cannot be saved as is, or null. Mirrors the server bounds exactly. */
export function noteProblem(draft: Pick<NoteDraft, "summary" | "points">): string | null {
  const summary = draft.summary.trim()
  if (summary.length === 0) return "Summary must not be empty."
  if (notesLength(summary) > MAX_SHOW_SUMMARY) return `Summary must be at most ${MAX_SHOW_SUMMARY} characters (currently ${notesLength(summary)}).`
  const points = draft.points.map((point) => point.trim()).filter((point) => point.length > 0)
  if (points.length < MIN_SHOW_POINTS || points.length > MAX_SHOW_POINTS) return `Talking points: ${MIN_SHOW_POINTS} to ${MAX_SHOW_POINTS} lines, one point per line (currently ${points.length}).`
  const long = points.findIndex((point) => notesLength(point) > MAX_SHOW_POINT)
  if (long >= 0) return `Talking point ${long + 1} must be at most ${MAX_SHOW_POINT} characters.`
  return null
}

/** The block the server appends for one saved item, exactly as the contract spells it. */
export function preparedBlock(item: Pick<ShowPreparationItem, "summary" | "talking_points">): string {
  return `${PREPARED_HEADING}\nSummary: ${item.summary}\nTalking points:\n${item.talking_points.map((point) => `- ${point}`).join("\n")}`
}

/** The topic notes as they will read after apply (existing text verbatim, block after a blank line). */
export function appendedNotes(notes: string, item: Pick<ShowPreparationItem, "summary" | "talking_points">): string {
  const block = preparedBlock(item)
  return notes.length === 0 ? block : `${notes}\n\n${block}`
}

/** Wire item from a draft: trimmed summary, non-blank trimmed points. */
export function itemFromDraft(draft: NoteDraft): ShowPreparationItem {
  return { id: draft.id, summary: draft.summary.trim(), talking_points: draft.points.map((point) => point.trim()).filter((point) => point.length > 0) }
}

/**
 * Why the ticked notes cannot be saved right now, or null. Bounds are checked
 * per ticked note and the resulting topic notes against the 10000-character
 * topic limit, so the server's 422 is anticipated instead of discovered.
 */
export function selectionProblem(drafts: NoteDraft[], topics: SavedShowTopic[]): string | null {
  const ticked = drafts.filter((draft) => draft.selected)
  if (ticked.length === 0) return "Tick at least one topic's notes to save."
  if (ticked.length > MAX_APPLY_ITEMS) return `At most ${MAX_APPLY_ITEMS} topics can be saved at once.`
  if (new Set(ticked.map((draft) => draft.id)).size !== ticked.length) return "Each topic can be saved once."
  for (const draft of ticked) {
    const title = titleFor(draft.id, topics)
    const problem = noteProblem(draft)
    if (problem !== null) return `${title}: ${problem}`
    const topic = topics.find((row) => row.id === draft.id)
    if (!topic) return `${title}: this topic is no longer in the saved show.`
    const length = notesLength(appendedNotes(topic.notes, itemFromDraft(draft)))
    if (length > MAX_NOTES) return `${title}: notes would be ${length} characters, over the ${MAX_NOTES} limit. Shorten the notes or untick this topic.`
  }
  return null
}

/** Exact apply body: ticked notes in generated (saved) order. */
export function applyPayload(revision: number, drafts: NoteDraft[]): ShowPreparationApply {
  return { revision, items: drafts.filter((draft) => draft.selected).map(itemFromDraft) }
}

/** Human title for a generated id; never shows the raw UUID. */
export function titleFor(id: string, topics: SavedShowTopic[]): string {
  const index = topics.findIndex((topic) => topic.id === id)
  if (index < 0) return "Topic no longer in this show"
  return `${index + 1}. ${topics[index]?.text ?? ""}`
}

export function parseNotePoints(text: string): string[] {
  return parsePoints(text)
}

// ---- Per-show review state -----------------------------------------------------
// Everything the panel remembers about one saved show. Kept per show id for the
// lifetime of the Saved Shows view (see showPrepStore.ts) so changing views,
// switching shows and status refreshes never drop an edited note or misplace a
// slow answer.

export type PrepNotice = { kind: "info" | "error"; text: string }

export type ShowPrep = {
  status: ShowPreparationStatus | null
  loadError: string | null
  pending: "load" | "input" | "generate" | "apply" | "recover" | null
  /** Exact input previewed for `input.revision`; consent covers `input.input_hash` only. */
  input: ShowPreparationInput | null
  /** Hash the user consented to send, or null. Reset per attempt and whenever the input changes. */
  consentHash: string | null
  /** The run under review: our own answer, a recovered request, or the server's latest. */
  run: ShowPreparationRun | null
  /** As generated; edits are compared against it. */
  base: NoteDraft[] | null
  /** Locally edited copy. */
  drafts: NoteDraft[] | null
  notice: PrepNotice | null
  /** A generate request that got no definite answer; recovery reads or resends this exact identity. */
  ambiguous: { requestId: string; revision: number; inputHash: string } | null
  /** An apply that got no definite answer: frozen exact body and run identity, retried verbatim. */
  pendingApply: { runId: string; payload: ShowPreparationApply } | null
  /** This run was applied from here; the show reached `revision`. */
  applied: { runId: string; revision: number } | null
  /** The server reported a different run than the one under review; shown, never adopted silently. */
  newerRun: ShowPreparationRun | null
  inputOpen: boolean
  /** "Generate again" asked while notes are edited; the user confirms replacement first. */
  confirmReplace: boolean
}

export const EMPTY_SHOW_PREP: ShowPrep = {
  status: null,
  loadError: null,
  pending: null,
  input: null,
  consentHash: null,
  run: null,
  base: null,
  drafts: null,
  notice: null,
  ambiguous: null,
  pendingApply: null,
  applied: null,
  newerRun: null,
  inputOpen: false,
  confirmReplace: false,
}

export function isEdited(prep: Pick<ShowPrep, "base" | "drafts">): boolean {
  return prep.drafts !== null && !sameNotes(prep.drafts, prep.base)
}

/** Replace the run under review and its editable copy. A frozen apply for another run is kept: it is its own identity. */
export function withRun(prep: ShowPrep, run: ShowPreparationRun | null): ShowPrep {
  const base = draftsFromRun(run)
  return { ...prep, run, base, drafts: base, newerRun: null, confirmReplace: false }
}

/**
 * Same run, fresh copy from the server: take its status/stale/applied facts,
 * keep the edited text. A run that only now finished gets a fresh copy.
 */
export function refreshRun(prep: ShowPrep, latest: ShowPreparationRun): ShowPrep {
  if (!prep.run || prep.run.id !== latest.id) return prep
  if (prep.run.status === "succeeded" && latest.status === "succeeded" && prep.drafts !== null) return { ...prep, run: { ...prep.run, stale: latest.stale, applied_revision: latest.applied_revision, error: latest.error } }
  return withRun(prep, latest)
}

/**
 * Fold a status GET into what the panel holds without dropping local edits, a
 * frozen request or an in-flight generate. A changed saved revision invalidates
 * the previewed input (and with it the consent). A lost generate whose run
 * turns out to exist is adopted here, ending the ambiguity without a resend. A
 * different latest run is only announced: the run under review stays.
 */
export function adoptStatus(prep: ShowPrep, status: ShowPreparationStatus): ShowPrep {
  const input = prep.input !== null && prep.input.revision === status.revision ? prep.input : null
  const next: ShowPrep = { ...prep, status, loadError: null, input, consentHash: input === null ? null : prep.consentHash }
  if (prep.pending === "generate") return next
  const latest = status.latest_run
  if (latest === null) return next
  if (prep.ambiguous && latest.id === prep.ambiguous.requestId) {
    next.ambiguous = null
    next.notice = { kind: "info", text: "Found the result of the earlier request. Nothing was sent again." }
    return prep.run && prep.run.id === latest.id ? refreshRun(next, latest) : withRun(next, latest)
  }
  if (prep.run === null) return withRun(next, latest)
  if (prep.run.id === latest.id) return refreshRun(next, latest)
  return { ...next, newerRun: latest }
}

/** A recovered run by exact id: adopt it (same id refreshes, otherwise it replaces the run under review). */
export function adoptRun(prep: ShowPrep, run: ShowPreparationRun): ShowPrep {
  const cleared: ShowPrep = prep.ambiguous && prep.ambiguous.requestId === run.id ? { ...prep, ambiguous: null } : prep
  return cleared.run && cleared.run.id === run.id ? refreshRun(cleared, run) : withRun(cleared, run)
}

/** The consent box covers exactly the previewed input at the show's current saved revision. */
export function consented(prep: Pick<ShowPrep, "input" | "consentHash">, revision: number): boolean {
  return prep.input !== null && prep.input.revision === revision && prep.consentHash === prep.input.input_hash
}

/** The run cannot be applied any more: the show moved on (including by applying it) or the server says so. */
export function runStale(run: ShowPreparationRun, revision: number): boolean {
  return run.stale || run.revision !== revision
}

export function runApplied(prep: Pick<ShowPrep, "applied">, run: ShowPreparationRun): boolean {
  return run.applied_revision !== null || (prep.applied !== null && prep.applied.runId === run.id)
}
