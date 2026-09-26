import { describe, expect, test } from "vitest"
import type { InboxItem } from "./api"
import { artworkFor, cardOf, editorialOf, formatDuration, hashId, isTypingTarget, kindOf, matches } from "./discover"

function item(patch: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "t1", revision: 3, text: "Short live label", duration: 120, notes: "Context", source_url: "https://example.com/story",
    archived: false, created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z",
    topic: { text: "Short live label", duration: 120, notes: "Context\n\nSource: https://example.com/story" }, source: null, ...patch,
  }
}

describe("cardOf", () => {
  test("uses the full original headline, structured creator and server excerpt when present", () => {
    const card = cardOf(item({
      source: { kind: "youtube", feed_id: "s", feed_name: "AI search", original_title: "A full original headline longer than thirty characters", body_text: "Video description only; transcript and video have not been retrieved.\nChannel/community: Frame & Field\n\nThe description.", published_at: "2026-09-20T10:00:00Z", imported_at: "2026-09-25T00:00:00Z", truncated: false },
      presentation: { provider: "youtube", creator: "Frame & Field", excerpt: "The description.", thumbnail: { url: "https://i.ytimg.com/vi/x/hq.jpg", width: 480, height: 360 }, media_seconds: 702, state: "ready", reason: null, fetched_at: "" },
    }))
    expect(card.title).toBe("A full original headline longer than thirty characters")
    expect(card.creator).toBe("Frame & Field")
    expect(card.excerpt).toBe("The description.")
    expect(card.thumbnail?.url).toBe("https://i.ytimg.com/vi/x/hq.jpg")
    expect(card.portrait).toBe(false)
    expect(card.mediaSeconds).toBe(702)
    expect(card.href).toBe("https://example.com/story")
  })

  test("falls back for pre-slice imports: excerpt skips importer preamble lines, creator never parsed from notes", () => {
    const card = cardOf(item({
      source: { kind: "youtube", feed_id: "s", feed_name: "AI search", original_title: "Old import", body_text: "Video description only; transcript and video have not been retrieved.\nChannel/community: Somebody\n\nReal description here.", published_at: null, imported_at: "", truncated: false },
    }))
    expect(card.excerpt).toBe("Real description here.")
    expect(card.creator).toBe("")
    expect(card.thumbnail).toBeNull()
    expect(kindOf(item())).toBe("manual")
  })

  test("manual ideas show their label and context; unsafe links are not linked", () => {
    const card = cardOf(item({ notes: "  Some context to read  ", source_url: "javascript:alert(1)" }))
    expect(card.kind).toBe("manual")
    expect(card.title).toBe("Short live label")
    expect(card.excerpt).toBe("Some context to read")
    expect(card.href).toBeNull()
    expect(editorialOf(item())).toEqual({ revision: 0, saved: false, note: "", updated_at: null })
  })

  test("long excerpts are clipped with an ellipsis and portrait images are detected", () => {
    const long = "word ".repeat(100).trim()
    const card = cardOf(item({ notes: long, presentation: { provider: "rss", creator: "", excerpt: "", thumbnail: { url: "https://cdn.example.com/p.jpg", width: 90, height: 160 }, media_seconds: null, state: "ready", reason: null, fetched_at: "" } }))
    expect(card.excerpt.length).toBeLessThanOrEqual(240)
    expect(card.excerpt.endsWith("…")).toBe(true)
    expect(card.portrait).toBe(true)
  })
})

test("matches applies source and saved filters", () => {
  const yt = item({ id: "a", source: { kind: "youtube", feed_id: "s", feed_name: "", original_title: "t", body_text: "", published_at: null, imported_at: "", truncated: false }, editorial: { revision: 1, saved: true, note: "", updated_at: null } })
  const manual = item({ id: "b" })
  expect(matches(yt, "all", false) && matches(yt, "youtube", false) && matches(yt, "youtube", true)).toBe(true)
  expect(matches(yt, "rss", false)).toBe(false)
  expect(matches(manual, "manual", false)).toBe(true)
  expect(matches(manual, "all", true)).toBe(false)
})

test("formatting and deterministic artwork", () => {
  expect(formatDuration(702)).toBe("11:42")
  expect(formatDuration(41)).toBe("0:41")
  expect(formatDuration(3723)).toBe("1:02:03")
  expect(artworkFor("same-id")).toEqual(artworkFor("same-id"))
  expect(hashId("a")).not.toBe(hashId("b"))
  const kinds = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => artworkFor(id).kind))
  expect(kinds.size).toBeGreaterThan(1)
})

test("isTypingTarget covers inputs, textareas and editable elements only", () => {
  const textarea = document.createElement("textarea")
  const button = document.createElement("button")
  const div = document.createElement("div")
  expect(isTypingTarget(textarea)).toBe(true)
  expect(isTypingTarget(button)).toBe(false)
  expect(isTypingTarget(div)).toBe(false)
  expect(isTypingTarget(null)).toBe(false)
})
