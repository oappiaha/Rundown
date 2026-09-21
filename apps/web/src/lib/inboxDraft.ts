// Pure draft logic for the topic inbox editor. An inbox draft is a local,
// unsaved copy of one captured idea (or a brand-new idea that has never been
// saved), pinned to the revision it was taken from. Nothing here touches the
// live clock or any saved show: copying an idea into a show is a separate,
// explicit action handled by the pickers.
import type { InboxCreate, InboxItem, InboxSource, InboxUpdate } from "./api"
import { MAX_NOTES, notesLength, notesProblem, topicProblem, validDuration, validTitle } from "./draft"

export const MAX_SOURCE_URL = 2048

export type InboxFields = { text: string; duration: number; notes: string; source_url: string }

export type InboxDraft = InboxFields & {
  /** Inbox item id, or null for an idea that has never been saved. */
  id: string | null
  /** Revision the draft was taken from; sent with PUT so stale writes 409. */
  baseRevision: number
  base: InboxFields
  /** Server-side archived flag as of `baseRevision`; archived ideas are read-only until restored. */
  archived: boolean
  /** Server copy-ready projection as of `baseRevision` (used for display only; pickers re-fetch). */
  topic: InboxItem["topic"] | null
  /** Read-only feed provenance for an imported idea; null for a manual one. Never edited or sent. */
  source: InboxSource | null
}

export function fieldsOf(item: InboxFields): InboxFields {
  return { text: item.text, duration: item.duration, notes: item.notes, source_url: item.source_url }
}

export function draftFromItem(item: InboxItem): InboxDraft {
  const base = fieldsOf(item)
  return { ...base, id: item.id, baseRevision: item.revision, base, archived: item.archived, topic: item.topic, source: item.source }
}

/** A fresh, never-saved idea. */
export function newInboxDraft(duration: number): InboxDraft {
  const base: InboxFields = { text: "", duration, notes: "", source_url: "" }
  return { ...base, id: null, baseRevision: 0, base, archived: false, topic: null, source: null }
}

/**
 * Why a source URL is not acceptable, or null. Empty is allowed. Otherwise
 * the trimmed value must be an absolute http(s) URL without embedded
 * credentials or whitespace, at most MAX_SOURCE_URL characters: the same
 * rules the server applies, checked here so the field can explain itself.
 */
export function sourceUrlProblem(raw: string): string | null {
  const url = raw.trim()
  if (url.length === 0) return null
  if (notesLength(url) > MAX_SOURCE_URL) return `Source URL must be at most ${MAX_SOURCE_URL} characters.`
  // eslint-disable-next-line no-control-regex -- control bytes are exactly what must be refused
  if (/[\s\\\u0000-\u001f\u007f]/.test(url)) return "Source URL must not contain spaces, control characters or backslashes."
  // Literal "scheme://authority" only: "https:example.com" is not absolute even
  // though the browser's URL() would quietly canonicalise it.
  const match = /^(https?):\/\/([^/?#]*)(?:[/?#].*)?$/i.exec(url)
  if (!match) return "Source URL must be a full web address starting with http:// or https://."
  const authority = match[2] ?? ""
  if (authority.includes("@")) return "Source URL must not include a username or password."
  if (authority.length === 0) return "Source URL needs a host, like https://example.com/story."
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return "Source URL is not a valid web address."
  }
  if (parsed.hostname.length === 0) return "Source URL needs a host, like https://example.com/story."
  return null
}

/**
 * Link target for rendering: the URL itself when it is a safe absolute
 * http(s) address, otherwise null (render as plain text, never as a link).
 */
export function safeSourceHref(raw: string): string | null {
  const url = raw.trim()
  if (url.length === 0 || sourceUrlProblem(url) !== null) return null
  return url
}

/**
 * Length of the copy-ready notes the server will build (notes plus a
 * "Source: <url>" line). The combined text must fit the notes limit, or the
 * server rejects the save with 422; check it here so the editor can say so.
 */
export function projectedNotesLength(notes: string, sourceUrl: string): number {
  const url = sourceUrl.trim()
  if (url.length === 0) return notesLength(notes)
  return notesLength(notes) + (notes.length > 0 ? 2 : 0) + notesLength(`Source: ${url}`)
}

/** First reason the draft cannot be saved, or null when it is valid. */
export function inboxProblem(fields: InboxFields): string | null {
  const base = topicProblem({ text: fields.text, duration: fields.duration, notes: fields.notes })
  if (base) return base
  const url = sourceUrlProblem(fields.source_url)
  if (url) return url
  if (projectedNotesLength(fields.notes, fields.source_url) > MAX_NOTES) {
    return `Context plus the source line must fit in ${MAX_NOTES} characters; shorten the context.`
  }
  return null
}

export function validInbox(fields: InboxFields): boolean {
  return validTitle(fields.text) && validDuration(fields.duration) && notesProblem(fields.notes) === null && inboxProblem(fields) === null
}

export function isInboxDirty(draft: InboxDraft): boolean {
  if (draft.id === null) return true
  return (
    draft.text !== draft.base.text ||
    draft.duration !== draft.base.duration ||
    draft.notes !== draft.base.notes ||
    draft.source_url.trim() !== draft.base.source_url
  )
}

/** True when the user has typed anything worth protecting (a pristine new idea is not). */
export function hasInboxWork(draft: InboxDraft | null): boolean {
  if (draft === null) return false
  if (draft.id === null) return draft.text.trim().length > 0 || draft.notes.length > 0 || draft.source_url.trim().length > 0
  return isInboxDirty(draft)
}

/** Wire form for POST /inbox: title and URL trimmed, notes verbatim, never an id. */
export function toCreateWire(fields: InboxFields): InboxCreate {
  return { text: fields.text.trim(), duration: fields.duration, notes: fields.notes, source_url: fields.source_url.trim() }
}

/** Wire form for PUT /inbox/{id}: every field plus the revision the draft was taken from. */
export function toUpdateWire(draft: InboxDraft): InboxUpdate {
  return { revision: draft.baseRevision, text: draft.text.trim(), duration: draft.duration, notes: draft.notes, source_url: draft.source_url.trim() }
}

/**
 * Rebase a draft onto a newer server copy of the same idea (after a 409, or
 * after an archive/restore round-trip). A field the user changed keeps the
 * local value; a field left alone takes the server's current value. The
 * result is pinned to the server revision so the next save is not stale.
 */
export function mergeInboxDraft(draft: InboxDraft, latest: InboxItem): InboxDraft {
  const next = draftFromItem(latest)
  return {
    ...next,
    text: draft.text !== draft.base.text ? draft.text : latest.text,
    duration: draft.duration !== draft.base.duration ? draft.duration : latest.duration,
    notes: draft.notes !== draft.base.notes ? draft.notes : latest.notes,
    source_url: draft.source_url.trim() !== draft.base.source_url ? draft.source_url : latest.source_url,
  }
}

/** Short relative-ish description of when an idea was last updated, for list rows. */
export function whenLabel(iso: string, now: number = Date.now()): string {
  const stamp = Date.parse(iso)
  if (Number.isNaN(stamp)) return ""
  const minutes = Math.round((now - stamp) / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 14) return `${days} d ago`
  return new Date(stamp).toLocaleDateString()
}
