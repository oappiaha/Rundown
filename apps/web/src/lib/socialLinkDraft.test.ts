import { describe, expect, test } from "vitest"
import type { SocialLinkPreview } from "./api"
import { MAX_NOTES } from "./draft"
import { appendPreview, applyPreview, applyProblem, previewAlreadyPresent, previewLength, previewMatches, socialLinkPlatform, titleFromPreview } from "./socialLinkDraft"

function preview(patch: Partial<SocialLinkPreview> = {}): SocialLinkPreview {
  const text = patch.text ?? "Independent designers discuss AI tools & creative ownership.\nWhat changes for small studios?"
  return {
    platform: "x",
    source_url: "https://x.com/fixture/status/123",
    title: "Independent designers discuss AI tools & creative ownership. What changes for small studios?",
    text,
    author: "Fixture researcher",
    context: `X public link\nPublic post text only.\nAuthor: Fixture researcher\n\n${text}`,
    limitations: "Public post text only.",
    truncated: false,
    mode: "fixture",
    ...patch,
  }
}

describe("supported permalinks", () => {
  test("full X/Twitter status and TikTok video links are recognised; everything else is not", () => {
    expect(socialLinkPlatform("https://x.com/fixture/status/123")).toBe("x")
    expect(socialLinkPlatform("  https://twitter.com/fixture/status/123?utm_source=test  ")).toBe("x")
    expect(socialLinkPlatform("https://mobile.twitter.com/fixture/status/123/")).toBe("x")
    expect(socialLinkPlatform("https://www.tiktok.com/@fixture/video/123")).toBe("tiktok")
    expect(socialLinkPlatform("https://tiktok.com/@fix.ture_1/video/123?is_from_webapp=1")).toBe("tiktok")
    expect(socialLinkPlatform("")).toBeNull()
    expect(socialLinkPlatform("http://x.com/fixture/status/123")).toBeNull()
    expect(socialLinkPlatform("https://x.com:8443/fixture/status/123")).toBeNull()
    expect(socialLinkPlatform("https://x.com/fixture")).toBeNull()
    expect(socialLinkPlatform("https://t.co/abc123")).toBeNull()
    expect(socialLinkPlatform("https://x.com.evil.test/u/status/123")).toBeNull()
    expect(socialLinkPlatform("https://www.tiktok.com/t/ZT8abc/")).toBeNull()
    expect(socialLinkPlatform("https://example.com/story")).toBeNull()
    expect(socialLinkPlatform("https://user:pw@x.com/fixture/status/123")).toBeNull()
  })
})

describe("appending a preview", () => {
  test("existing context is kept verbatim and the block follows after a blank line; empty context takes the block alone", () => {
    const p = preview()
    expect(appendPreview("", p)).toBe(p.context)
    expect(appendPreview("My original context  \n", p)).toBe(`My original context  \n\n\n${p.context}`)
  })

  test("applying twice appends twice: the caller must gate repeat applies", () => {
    const p = preview()
    const once = applyPreview({ text: "Kept title", notes: "Original" }, p)
    const twice = applyPreview(once, p)
    expect(once.notes).toBe(`Original\n\n${p.context}`)
    expect(twice.notes).toBe(`Original\n\n${p.context}\n\n${p.context}`)
    expect(twice.text).toBe("Kept title")
  })

  test("an existing title is never replaced; a blank one is filled from the preview cut to the title limit", () => {
    const p = preview()
    expect(applyPreview({ text: "Kept title", notes: "" }, p).text).toBe("Kept title")
    expect(applyPreview({ text: "   ", notes: "" }, p).text).toBe("Independent designers discuss")
    expect(Array.from(applyPreview({ text: "", notes: "" }, p).text).length).toBeLessThanOrEqual(30)
    expect(applyPreview({ text: "", notes: "" }, preview({ title: "" })).text).toBe("")
  })

  test("title cutting counts code points and prefers a word boundary only when it is not too early", () => {
    expect(titleFromPreview(preview({ title: "Short title" }))).toBe("Short title")
    expect(titleFromPreview(preview({ title: "  spaced   out\ttitle  " }))).toBe("spaced out title")
    expect(titleFromPreview(preview({ title: "😀".repeat(40) }))).toBe("😀".repeat(30))
    expect(titleFromPreview(preview({ title: `${"a".repeat(28)} ${"b".repeat(20)}` }))).toBe("a".repeat(28))
    expect(titleFromPreview(preview({ title: `abc ${"b".repeat(60)}` }))).toBe(`abc ${"b".repeat(26)}`)
  })

  test("the length hint counts the block in code points", () => {
    const p = preview()
    expect(previewLength(p)).toBe(Array.from(p.context.trim()).length)
  })
})

describe("length guard", () => {
  test("adding is refused, with nothing truncated, when context plus the source line would exceed the notes limit", () => {
    const p = preview()
    const url = "https://x.com/fixture/status/123"
    const sourceLine = `Source: ${url}`.length
    const room = MAX_NOTES - 2 - sourceLine - 2 - p.context.length
    const fits = "x".repeat(room)
    expect(applyProblem(fits, url, p)).toBeNull()
    const over = "x".repeat(room + 1)
    const problem = applyProblem(over, url, p)
    expect(problem).toMatch(/^Not added: context plus the source line would be 10,001 characters, over the 10,000 limit/)
    // The guard reports; it never changes the text it was asked about.
    expect(applyPreview({ text: "t", notes: over }, p).notes.startsWith(over)).toBe(true)
  })

  test("without a source URL only the context itself counts", () => {
    const p = preview()
    const room = MAX_NOTES - 2 - p.context.length
    expect(applyProblem("x".repeat(room), "", p)).toBeNull()
    expect(applyProblem("x".repeat(room + 1), "", p)).not.toBeNull()
  })
})

describe("duplicate guard", () => {
  test("the exact block already in the context (added, refetched, or saved and reopened) is detected; removing it frees the add again", () => {
    const p = preview()
    expect(previewAlreadyPresent("", p)).toBe(false)
    expect(previewAlreadyPresent("My original context", p)).toBe(false)
    const added = appendPreview("My original context", p)
    expect(previewAlreadyPresent(added, p)).toBe(true)
    // Reopened after a save: the same text, possibly with more typed after it.
    expect(previewAlreadyPresent(`${added}\n\nMore notes typed later`, p)).toBe(true)
    // A different post's block (or an edited copy of this one) does not count.
    expect(previewAlreadyPresent(added, preview({ context: "TikTok public link\nCaption only.\nAuthor: Someone\n\nOther text" }))).toBe(false)
    expect(previewAlreadyPresent(added.replace("small studios", "big studios"), p)).toBe(false)
    // Deleting the block lets the user add it again.
    expect(previewAlreadyPresent(added.replace(p.context, "").trimEnd(), p)).toBe(false)
    // An empty block never claims to be present.
    expect(previewAlreadyPresent("anything", preview({ context: "   " }))).toBe(false)
  })
})

describe("stale previews", () => {
  test("a preview only matches the exact trimmed link it was fetched for", () => {
    expect(previewMatches("https://x.com/fixture/status/123", "  https://x.com/fixture/status/123 ")).toBe(true)
    expect(previewMatches("https://x.com/fixture/status/123", "https://x.com/fixture/status/1234")).toBe(false)
    expect(previewMatches("https://x.com/fixture/status/123", "")).toBe(false)
  })
})
