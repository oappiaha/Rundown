// Pure logic for the public X/TikTok link preview in the inbox editor. A
// preview is read-only text fetched on explicit request for the link in the
// Source URL field. Nothing here touches the draft by itself: putting the text
// into the idea's context is a separate explicit action, and saving that
// context is another one (the ordinary Save idea).
import type { SocialLinkPlatform, SocialLinkPreview } from "./api"
import { MAX_NOTES, MAX_TITLE, notesLength } from "./draft"
import { projectedNotesLength, sourceUrlProblem } from "./inboxDraft"

const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"])
const TIKTOK_HOSTS = new Set(["tiktok.com", "www.tiktok.com"])

/**
 * Which platform a Source URL looks like a full public permalink for, or null.
 * Mirrors the server's rule (HTTPS X/Twitter `/user/status/id`, TikTok
 * `/@user/video/id`) so the Fetch control can explain itself before a request
 * is sent; the server stays authoritative and still answers 422 for anything
 * else.
 */
export function socialLinkPlatform(raw: string): SocialLinkPlatform | null {
  const url = raw.trim()
  if (url.length === 0 || sourceUrlProblem(url) !== null) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== "https:" || parsed.port !== "") return null
  const host = parsed.hostname.toLowerCase()
  if (X_HOSTS.has(host) && /^\/[A-Za-z0-9_]{1,15}\/status\/[0-9]{1,25}\/?$/.test(parsed.pathname)) return "x"
  if (TIKTOK_HOSTS.has(host) && /^\/@[A-Za-z0-9_.]{1,24}\/video\/[0-9]{1,25}\/?$/.test(parsed.pathname)) return "tiktok"
  return null
}

export function platformName(platform: SocialLinkPlatform): string {
  return platform === "x" ? "X" : "TikTok"
}

/**
 * The text "Add to context" appends: the server's ready-made block (platform
 * line, limitations, author, post text) exactly as returned, plain text.
 */
export function previewBlock(preview: SocialLinkPreview): string {
  return preview.context.trim()
}

/**
 * Current context with the preview appended after a blank line. Existing
 * text is kept verbatim (never trimmed, never replaced); only the separator
 * is dropped when there is nothing to separate from.
 */
export function appendPreview(notes: string, preview: SocialLinkPreview): string {
  const block = previewBlock(preview)
  return notes.length === 0 ? block : `${notes}\n\n${block}`
}

/**
 * A title for an idea that has none yet: the preview title cut to the title
 * limit (in Unicode code points, like the server counts), preferring a word
 * boundary when one is reasonably close. Empty when the preview has no title.
 */
export function titleFromPreview(preview: SocialLinkPreview): string {
  const flat = preview.title.replace(/\s+/g, " ").trim()
  const points = Array.from(flat)
  if (points.length <= MAX_TITLE) return flat
  const hard = points.slice(0, MAX_TITLE).join("")
  const boundary = hard.lastIndexOf(" ")
  const cut = boundary >= Math.floor(MAX_TITLE / 2) ? hard.slice(0, boundary) : hard
  return cut.trim()
}

/** True when the editor's title is blank, so applying a preview may fill it. */
export function titleIsEmpty(text: string): boolean {
  return text.trim().length === 0
}

/**
 * Why the preview cannot be added right now, or null. The combined context
 * plus the "Source: <url>" line the server adds must fit the notes limit;
 * nothing is truncated silently, the user shortens something first.
 */
export function applyProblem(notes: string, sourceUrl: string, preview: SocialLinkPreview): string | null {
  const next = appendPreview(notes, preview)
  const projected = projectedNotesLength(next, sourceUrl)
  if (projected > MAX_NOTES) {
    return `Not added: context plus the source line would be ${projected.toLocaleString("en-US")} characters, over the ${MAX_NOTES.toLocaleString("en-US")} limit. Shorten the context first; nothing was changed.`
  }
  return null
}

/**
 * The draft fields after an explicit "Add to context": context appended,
 * title filled only when it was blank, source URL untouched. Throws nothing;
 * callers check `applyProblem` first.
 */
export function applyPreview(fields: { text: string; notes: string }, preview: SocialLinkPreview): { text: string; notes: string } {
  const notes = appendPreview(fields.notes, preview)
  const filled = titleIsEmpty(fields.text) ? titleFromPreview(preview) : ""
  return { text: filled.length > 0 ? filled : fields.text, notes }
}

/**
 * True when the exact block this preview would add is already somewhere in
 * the context: after "Add to context", after a refetch of the same link, or
 * after saving and reopening the idea. Adding again would only duplicate it;
 * deleting the block from the context makes it addable again.
 */
export function previewAlreadyPresent(notes: string, preview: SocialLinkPreview): boolean {
  const block = previewBlock(preview)
  return block.length > 0 && notes.includes(block)
}

/** Length of the block a preview would add, for the "will add N characters" hint. */
export function previewLength(preview: SocialLinkPreview): number {
  return notesLength(previewBlock(preview))
}

/** True when the fetched preview still belongs to the link in the field (same trimmed text). */
export function previewMatches(requestedUrl: string, currentUrl: string): boolean {
  return requestedUrl === currentUrl.trim()
}
