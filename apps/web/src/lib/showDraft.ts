// Pure draft logic for the saved-show editor. A show draft is a local, unsaved
// copy of one saved show (or a brand-new show that has never been saved),
// pinned to the revision it was taken from. Nothing here touches the live
// clock: activation is a separate, explicit action handled by the view.
import type { SavedShow, SavedShowTopic, SavedTopicUpdate } from "./api"
import { draftProblem, nextNewKey, type DraftTopic } from "./draft"

export const MAX_NAME = 80

export type ShowDraft = {
  /** Saved show id, or null for a show that has never been saved. */
  id: string | null
  /** Revision the draft was taken from; sent with PUT so stale writes 409. */
  baseRevision: number
  baseName: string
  baseTopics: SavedShowTopic[]
  name: string
  topics: DraftTopic[]
}

export function topicsFromShow(topics: SavedShowTopic[]): DraftTopic[] {
  return topics.map((topic) => ({ key: topic.id, id: topic.id, text: topic.text, duration: topic.duration, notes: topic.notes }))
}

export function draftFromShow(show: SavedShow): ShowDraft {
  return { id: show.id, baseRevision: show.revision, baseName: show.name, baseTopics: show.topics, name: show.name, topics: topicsFromShow(show.topics) }
}

/** A fresh, never-saved show. Empty is allowed. */
export function newShowDraft(name = ""): ShowDraft {
  return { id: null, baseRevision: 0, baseName: name, baseTopics: [], name, topics: [] }
}

/** A row copied from another show (or the live rundown): text/duration/notes only, never the source id. */
export function copiedTopic(source: { text: string; duration: number; notes: string }): DraftTopic {
  return { key: nextNewKey(), id: null, text: source.text, duration: source.duration, notes: source.notes }
}

export function validName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length >= 1 && trimmed.length <= MAX_NAME
}

export function nameProblem(name: string): string | null {
  return validName(name) ? null : `Show name must be 1–${MAX_NAME} characters.`
}

/** First reason the draft cannot be saved, or null when it is valid. */
export function showDraftProblem(draft: Pick<ShowDraft, "name" | "topics">): string | null {
  return nameProblem(draft.name) ?? draftProblem(draft.topics)
}

export function isShowDirty(draft: ShowDraft): boolean {
  if (draft.id === null) return true
  if (draft.name !== draft.baseName) return true
  if (draft.topics.length !== draft.baseTopics.length) return true
  return draft.topics.some((topic, index) => {
    const base = draft.baseTopics[index]
    return base === undefined || topic.id !== base.id || topic.text !== base.text || topic.duration !== base.duration || topic.notes !== base.notes
  })
}

/** True when the user has typed anything worth protecting (a pristine new show is not). */
export function hasUnsavedWork(draft: ShowDraft | null): boolean {
  if (draft === null) return false
  if (draft.id === null) return draft.name.trim().length > 0 || draft.topics.length > 0
  return isShowDirty(draft)
}

/** Wire form for PUT /shows/{id}: existing rows carry their id, new rows omit it. Notes always sent verbatim. */
export function toShowWire(topics: DraftTopic[]): SavedTopicUpdate[] {
  return topics.map((topic) => {
    const entry: SavedTopicUpdate = { text: topic.text.trim(), duration: topic.duration, notes: topic.notes }
    if (topic.id !== null) entry.id = topic.id
    return entry
  })
}

/**
 * Three-way merge of a show draft onto the latest saved version after a 409.
 * Same rules as the live merge: a field the user changed keeps the local
 * value, an untouched field takes the saved value; local additions stay; rows
 * removed in the saved version disappear unless edited locally (kept as new
 * rows); rows added in the saved version are inserted after their saved
 * predecessor. The name follows the same rule.
 */
export function mergeShowDraft(draft: ShowDraft, latest: SavedShow): ShowDraft {
  const baseById = new Map(draft.baseTopics.map((topic) => [topic.id, topic]))
  const latestById = new Map(latest.topics.map((topic) => [topic.id, topic]))
  const merged: DraftTopic[] = []
  for (const topic of draft.topics) {
    if (topic.id === null) {
      merged.push(topic)
      continue
    }
    const base = baseById.get(topic.id)
    const remote = latestById.get(topic.id)
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
  for (const [index, remote] of latest.topics.entries()) {
    if (baseById.has(remote.id) || draftIds.has(remote.id)) continue
    let at = index === 0 ? 0 : merged.length
    for (let i = index - 1; i >= 0; i -= 1) {
      const predecessor = latest.topics[i]
      const position = predecessor ? merged.findIndex((topic) => topic.id === predecessor.id) : -1
      if (position >= 0) {
        at = position + 1
        break
      }
    }
    merged.splice(at, 0, { key: remote.id, id: remote.id, text: remote.text, duration: remote.duration, notes: remote.notes })
  }
  const nameEdited = draft.name !== draft.baseName
  return {
    id: latest.id,
    baseRevision: latest.revision,
    baseName: latest.name,
    baseTopics: latest.topics,
    name: nameEdited ? draft.name : latest.name,
    topics: merged,
  }
}

export function totalSeconds(topics: Array<{ duration: number }>): number {
  return topics.reduce((sum, topic) => sum + (Number.isFinite(topic.duration) ? topic.duration : 0), 0)
}

export function formatMinutes(seconds: number): string {
  return `${Math.ceil(seconds / 60)} min`
}

/** "3 topics", "1 topic", "no topics" */
export function topicCount(count: number): string {
  if (count === 0) return "no topics"
  return `${count} topic${count === 1 ? "" : "s"}`
}
