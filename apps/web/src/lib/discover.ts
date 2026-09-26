// Pure helpers for the Discover surface: what a card shows, how the list is
// filtered, and deterministic artwork for topics without a usable image.
// Nothing here fetches, and nothing here rewrites imported text.
import { NO_EDITORIAL, type InboxAttachment, type InboxEditorial, type InboxItem, type InboxThumbnail } from "./api"
import { safeSourceHref } from "./inboxDraft"
import { hostOf } from "./plans"

export type Kind = "youtube" | "rss" | "reddit" | "manual"
export type SourceFilter = "all" | Kind

export const SOURCE_FILTERS: ReadonlyArray<{ id: SourceFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "youtube", label: "YouTube" },
  { id: "rss", label: "Articles" },
  { id: "reddit", label: "Reddit" },
  { id: "manual", label: "Your ideas" },
]

export const KIND_LABEL: Record<Kind, string> = { youtube: "YouTube", rss: "Article", reddit: "Reddit", manual: "Your idea" }
const CAPTURE_LABEL = { write: "Your idea", link: "Your link", upload: "Your upload" } as const

export const EXCERPT_CHARS = 240

export type Card = {
  id: string
  kind: Kind
  /** Full original headline (never the 30-character live label) when the importer or capture kept one. */
  title: string
  /** The 30-character label the live show would carry. */
  liveLabel: string
  /** "YouTube", "Article", "Your link", "Your upload"… */
  kindLabel: string
  creator: string
  excerpt: string
  /** Retained source text (or the idea's own context) for "Read more"; plain text, rendered as text. */
  fullText: string
  thumbnail: InboxThumbnail | null
  portrait: boolean
  published: string | null
  mediaSeconds: number | null
  href: string | null
  /** An uploaded PDF/TXT/MD kept as the original file, offered for download. */
  document: InboxAttachment | null
}

export function kindOf(item: InboxItem): Kind {
  const kind = item.source?.kind ?? item.presentation?.provider
  return kind === "youtube" || kind === "rss" || kind === "reddit" ? kind : "manual"
}

export function editorialOf(item: InboxItem): InboxEditorial {
  return item.editorial ?? NO_EDITORIAL
}

/** Lines an importer prefixes to retained text; skipped only when the server kept no structured excerpt. */
const PREAMBLE = /^(Video description only|Post title and body only|Channel\/community:)/

function excerptFromText(text: string): string {
  const kept = text
    .split("\n")
    .filter((line) => !PREAMBLE.test(line.trim()))
    .join(" ")
  const flat = kept.replace(/\s+/g, " ").trim()
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1).trimEnd()}…` : flat
}

export function cardOf(item: InboxItem): Card {
  const kind = kindOf(item)
  const card = item.presentation ?? null
  const source = item.source
  const capture = item.capture ?? null
  const cover = capture?.attachments.find((file) => file.role === "cover") ?? null
  const document = capture?.attachments.find((file) => file.role === "document") ?? null
  const fullText = source ? source.body_text : capture?.source_text || item.notes
  const excerpt = card?.excerpt ? excerptFromText(card.excerpt) : excerptFromText(fullText)
  const thumbnail = cover ? { url: cover.url, width: cover.width, height: cover.height } : (card?.thumbnail ?? null)
  const captureCreator = capture?.kind === "upload" ? (capture.attachments[0]?.filename ?? "") : capture?.kind === "link" ? hostOf(item.source_url) : ""
  return {
    id: item.id,
    kind,
    title: capture?.display_title || source?.original_title || item.text,
    liveLabel: item.text,
    kindLabel: capture ? CAPTURE_LABEL[capture.kind] : KIND_LABEL[kind],
    creator: card?.creator || (kind === "rss" ? (source?.feed_name ?? "") : captureCreator),
    excerpt,
    fullText,
    thumbnail,
    document,
    portrait: thumbnail !== null && thumbnail.width !== null && thumbnail.height !== null && thumbnail.height > thumbnail.width,
    published: source?.published_at ?? null,
    mediaSeconds: card?.media_seconds ?? null,
    href: safeSourceHref(item.source_url),
  }
}

export function matches(item: InboxItem, filter: SourceFilter, savedOnly: boolean): boolean {
  if (savedOnly && !editorialOf(item).saved) return false
  return filter === "all" || kindOf(item) === filter
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m)
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`
}

export function dateLabel(iso: string | null): string {
  if (iso === null || iso === "") return ""
  const stamp = Date.parse(iso)
  if (Number.isNaN(stamp)) return ""
  return new Date(stamp).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

/** Small stable hash so the same topic always gets the same artwork. */
export function hashId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

export const ART_KINDS = ["arc", "grid", "orbit", "stripes", "blob", "diagonal"] as const
export type ArtKind = (typeof ART_KINDS)[number]

export function artworkFor(id: string): { kind: ArtKind; palette: number } {
  const h = hashId(id)
  return { kind: ART_KINDS[h % ART_KINDS.length], palette: Math.floor(h / ART_KINDS.length) % 6 }
}

/** True for anything that takes typed input, so card navigation keys never interrupt typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || target.isContentEditable === true
}
