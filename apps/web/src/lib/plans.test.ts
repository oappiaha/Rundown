import { describe, expect, test } from "vitest"
import { hostOf, labelProblem, linkProblem, moveItem, needsLabel, planLabel, suggestLabel, titleFromFilename, uploadProblem, validDate } from "./plans"

const LONG = "Why the long take came back: how one-shot scenes went from stunt to scheduling decision"

describe("live label", () => {
  test("a headline within 30 characters is its own label", () => {
    expect(needsLabel("  Short   title ")).toBe(false)
    expect(suggestLabel("  Short   title ")).toBe("Short title")
  })
  test("a longer headline needs a label; the suggestion is at most 30 characters and cut at a word", () => {
    expect(needsLabel(LONG)).toBe(true)
    const suggestion = suggestLabel(LONG)
    expect(suggestion.length).toBeLessThanOrEqual(30)
    expect(suggestion).toBe("Why the long take came back:")
    expect(suggestLabel("x".repeat(40))).toBe("x".repeat(30))
  })
  test("label problems are named, never fixed silently", () => {
    expect(labelProblem("   ")).toMatch(/Choose/)
    expect(labelProblem("x".repeat(31))).toMatch(/30/)
    expect(labelProblem("fits")).toBeNull()
  })
})

describe("days and files", () => {
  test("plan labels and list moves", () => {
    expect(planLabel({ name: "Friday", stream_date: "2026-10-02" })).toBe("2026-10-02 · Friday")
    expect(planLabel({ name: "Old", stream_date: null })).toBe("Old · undated")
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"])
    expect(moveItem(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"])
    expect(moveItem(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"])
  })
  test("dates", () => {
    expect(validDate("2026-10-02")).toBe(true)
    expect(validDate("2026-02-30")).toBe(false)
    expect(validDate("2026-1-2")).toBe(false)
  })
  test("upload pre-checks name the problem; the server still decides the type", () => {
    expect(uploadProblem(null)).toMatch(/Choose/)
    expect(uploadProblem({ name: "a.png", size: 0 })).toMatch(/empty/)
    expect(uploadProblem({ name: "a.png", size: 1024 * 1024 + 1 })).toMatch(/1 MB/)
    expect(uploadProblem({ name: "a.svg", size: 10 })).toMatch(/PNG, JPEG/)
    expect(uploadProblem({ name: "A.JPEG", size: 10 })).toBeNull()
    expect(titleFromFilename("my_show-notes.final.md")).toBe("my show notes.final")
  })
  test("links", () => {
    expect(linkProblem("")).toMatch(/Paste/)
    expect(linkProblem("javascript:alert(1)")).toMatch(/http/)
    expect(linkProblem("https://user:pw@example.com/")).toMatch(/credentials/)
    expect(linkProblem("https://example.com/story?x=1")).toBeNull()
    expect(hostOf("https://www.example.com/a")).toBe("example.com")
    expect(hostOf("nope")).toBe("")
  })
})
