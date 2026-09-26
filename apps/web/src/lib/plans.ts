// Pure helpers for streaming days and topic capture: the 30-character live
// label next to a full headline, day labels, list moves and client-side
// upload pre-checks. The server is the authority for every limit repeated here.
import type { PlanSummary, PlanTopic } from "./api"

export const MAX_LABEL = 30
export const MAX_TITLE = 200
export const MAX_UPLOAD_BYTES = 1024 * 1024
export const UPLOAD_ACCEPT = ".png,.jpg,.jpeg,.pdf,.txt,.md,.markdown"
export const DEFAULT_DURATION = 120
const UPLOAD_SUFFIXES = UPLOAD_ACCEPT.split(",")

export function cleanTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/** A headline longer than the live limit needs a label the user has seen and can edit. */
export function needsLabel(title: string): boolean {
  return cleanTitle(title).length > MAX_LABEL
}

/** Suggested live label: the first 30 characters, cut back to a word boundary when one is near the end. Never longer than 30. */
export function suggestLabel(title: string): string {
  const clean = cleanTitle(title)
  if (clean.length <= MAX_LABEL) return clean
  const head = clean.slice(0, MAX_LABEL)
  const space = head.lastIndexOf(" ")
  return (space >= 18 ? head.slice(0, space) : head).trim()
}

export function labelProblem(label: string): string | null {
  const clean = cleanTitle(label)
  if (clean.length === 0) return "Choose a live label."
  if (clean.length > MAX_LABEL) return `The live label must be at most ${MAX_LABEL} characters.`
  return null
}

export function planLabel(plan: Pick<PlanSummary, "name" | "stream_date">): string {
  return plan.stream_date ? `${plan.stream_date} · ${plan.name}` : `${plan.name} · undated`
}

export function displayTitleOf(topic: PlanTopic): string {
  return topic.origin?.display_title || topic.text
}

export function totalSeconds(topics: ReadonlyArray<{ duration: number }>): number {
  return topics.reduce((sum, topic) => sum + (Number.isFinite(topic.duration) ? topic.duration : 0), 0)
}

export function formatMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  return `${minutes} min`
}

/** A new array with the item at `index` moved one step; unchanged at the edges. */
export function moveItem<T>(list: ReadonlyArray<T>, index: number, direction: -1 | 1): T[] {
  const target = index + direction
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list]
  const next = [...list]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

export function isoToday(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** Client-side pre-check only (size and accepted suffix); the server decides the real type from the bytes. */
export function uploadProblem(file: { name: string; size: number } | null): string | null {
  if (!file) return "Choose a file."
  if (file.size === 0) return "That file is empty."
  if (file.size > MAX_UPLOAD_BYTES) return "Choose a file smaller than 1 MB."
  const lower = file.name.toLowerCase()
  if (!UPLOAD_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return "Use a PNG, JPEG, PDF, TXT or Markdown file."
  return null
}

/** The bare file name, without its extension, as a starting title (bounded). */
export function titleFromFilename(name: string): string {
  return cleanTitle(name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ")).slice(0, MAX_TITLE)
}

export function linkProblem(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return "Paste a link."
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return "Use a complete http or https link."
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Use an http or https link."
  if (parsed.username || parsed.password) return "Links cannot carry credentials."
  if (/\s/.test(trimmed)) return "Links cannot contain spaces."
  return null
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}
