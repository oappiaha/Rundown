// Pure draft logic for the schedule editor. A draft is a local, unsaved copy
// of the server schedule pinned to the revision it was taken from. Polling
// never touches it; only the user (or a successful publish) does.
import type { ScheduleEntry, ShowState, ShowTopic } from "./api"

export const MIN_DURATION = 15
export const MAX_DURATION = 3600
export const MAX_TITLE = 30
/** Notes limit, counted in Unicode code points to match the server's `max_length`. */
export const MAX_NOTES = 10000
export const MAX_TOPICS = 20
export const DEFAULT_DURATION = 120

export type DraftTopic = {
  /** Stable local key: the server id for existing rows, `new-N` for unsaved rows. */
  key: string
  /** Server id, or null for a row that has never been published. */
  id: string | null
  text: string
  duration: number
  /** Producer context shown only in the control room; "" when none. Kept verbatim. */
  notes: string
}

export type Draft = {
  /** Revision the draft was taken from; sent with PUT so stale writes 409. */
  baseRevision: number
  baseTopics: ShowTopic[]
  topics: DraftTopic[]
}

let newKeyCounter = 0
export function nextNewKey(): string {
  newKeyCounter += 1
  return `new-${newKeyCounter}`
}

export function fromRemote(topics: ShowTopic[]): DraftTopic[] {
  return topics.map((topic) => ({ key: topic.id, id: topic.id, text: topic.text, duration: topic.duration, notes: topic.notes }))
}

export function draftFromState(state: ShowState): Draft {
  return { baseRevision: state.revision, baseTopics: state.topics, topics: fromRemote(state.topics) }
}

export function validDuration(duration: number): boolean {
  return Number.isInteger(duration) && duration >= MIN_DURATION && duration <= MAX_DURATION
}

/** Title limit is counted in Unicode code points, like the server's, so 30 emoji are a legal title. */
export function validTitle(text: string): boolean {
  const length = Array.from(text.trim()).length
  return length >= 1 && length <= MAX_TITLE
}

/** Length in Unicode code points (what the server counts), not UTF-16 units. */
export function notesLength(notes: string): number {
  return Array.from(notes).length
}

export function validNotes(notes: string): boolean {
  return notesLength(notes) <= MAX_NOTES
}

export function notesProblem(notes: string): string | null {
  const length = notesLength(notes)
  if (length > MAX_NOTES) return `Notes must be at most ${MAX_NOTES} characters (currently ${length}).`
  return null
}

export function topicProblem(topic: { text: string; duration: number; notes: string }): string | null {
  if (!validTitle(topic.text)) return `Title must be 1–${MAX_TITLE} characters.`
  if (!validDuration(topic.duration)) return `Duration must be a whole number of seconds from ${MIN_DURATION} to ${MAX_DURATION}.`
  return notesProblem(topic.notes)
}

export function draftProblem(topics: DraftTopic[]): string | null {
  if (topics.length > MAX_TOPICS) return `A show holds at most ${MAX_TOPICS} topics.`
  for (const [index, topic] of topics.entries()) {
    const problem = topicProblem(topic)
    if (problem) return `Topic ${index + 1}: ${problem}`
  }
  return null
}

/**
 * Wire form for PUT /rundown/schedule: new rows omit `id` entirely. Notes are
 * always sent, untrimmed, so "" explicitly clears them on the server.
 */
export function toWire(topics: DraftTopic[]): ScheduleEntry[] {
  return topics.map((topic) => {
    const entry: ScheduleEntry = { text: topic.text.trim(), duration: topic.duration, notes: topic.notes }
    if (topic.id !== null) entry.id = topic.id
    return entry
  })
}

export function sameTopics(a: ShowTopic[], b: ShowTopic[]): boolean {
  if (a.length !== b.length) return false
  return a.every((topic, index) => {
    const other = b[index]
    return (
      other !== undefined && other.id === topic.id && other.text === topic.text && other.duration === topic.duration && other.notes === topic.notes
    )
  })
}

export function isDirty(draft: Draft): boolean {
  if (draft.topics.length !== draft.baseTopics.length) return true
  return draft.topics.some((topic, index) => {
    const base = draft.baseTopics[index]
    return base === undefined || topic.id !== base.id || topic.text !== base.text || topic.duration !== base.duration || topic.notes !== base.notes
  })
}

export function insertTopic(
  topics: DraftTopic[],
  topic: Omit<DraftTopic, "key" | "id" | "notes"> & { notes?: string },
  position: "end" | { afterId: string | null },
): DraftTopic[] {
  const row: DraftTopic = { key: nextNewKey(), id: null, text: topic.text.trim(), duration: topic.duration, notes: topic.notes ?? "" }
  if (position === "end" || position.afterId === null) return [...topics, row]
  const index = topics.findIndex((entry) => entry.id === position.afterId)
  if (index < 0) return [...topics, row]
  return [...topics.slice(0, index + 1), row, ...topics.slice(index + 1)]
}

export function moveTopic(topics: DraftTopic[], key: string, direction: -1 | 1): DraftTopic[] {
  const index = topics.findIndex((topic) => topic.key === key)
  const target = index + direction
  if (index < 0 || target < 0 || target >= topics.length) return topics
  const next = [...topics]
  const [moved] = next.splice(index, 1)
  if (moved) next.splice(target, 0, moved)
  return next
}

/**
 * Three-way merge of a draft onto a newer server state (after a 409, or on
 * request while the other screen keeps changing). Per row and per field:
 * a field the user changed keeps the local value; a field the user left
 * alone takes the server's current value. Rows the user added stay (still
 * without ids). Rows removed on the other screen disappear unless the user
 * edited them here, in which case they are kept as new rows. Rows added on
 * the other screen are inserted after their server-side predecessor. Draft
 * order otherwise wins.
 */
export function mergeDraft(draft: Draft, state: ShowState): Draft {
  const baseById = new Map(draft.baseTopics.map((topic) => [topic.id, topic]))
  const remoteById = new Map(state.topics.map((topic) => [topic.id, topic]))
  const merged: DraftTopic[] = []
  for (const topic of draft.topics) {
    if (topic.id === null) {
      merged.push(topic)
      continue
    }
    const base = baseById.get(topic.id)
    const remote = remoteById.get(topic.id)
    const textEdited = base !== undefined && topic.text !== base.text
    const durationEdited = base !== undefined && topic.duration !== base.duration
    const notesEdited = base !== undefined && topic.notes !== base.notes
    if (remote === undefined) {
      if (textEdited || durationEdited || notesEdited) merged.push({ ...topic, id: null })
      continue
    }
    merged.push({
      ...topic,
      text: textEdited ? topic.text : remote.text,
      duration: durationEdited ? topic.duration : remote.duration,
      notes: notesEdited ? topic.notes : remote.notes,
    })
  }
  const draftIds = new Set(draft.topics.map((topic) => topic.id))
  for (const [index, remote] of state.topics.entries()) {
    if (baseById.has(remote.id) || draftIds.has(remote.id)) continue
    // Place after the nearest server-side predecessor still present; a row the
    // other screen put first goes first, otherwise fall back to the end.
    let at = index === 0 ? 0 : merged.length
    for (let i = index - 1; i >= 0; i -= 1) {
      const predecessor = state.topics[i]
      const position = predecessor ? merged.findIndex((topic) => topic.id === predecessor.id) : -1
      if (position >= 0) {
        at = position + 1
        break
      }
    }
    merged.splice(at, 0, { key: remote.id, id: remote.id, text: remote.text, duration: remote.duration, notes: remote.notes })
  }
  return { baseRevision: state.revision, baseTopics: state.topics, topics: merged }
}

export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safe / 60)
  const rest = safe % 60
  return `${minutes}:${String(rest).padStart(2, "0")}`
}
