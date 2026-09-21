import { describe, expect, test } from "vitest"
import type { ReviewTopic } from "./api"
import {
  actualProblem,
  deltaLabel,
  deltaOf,
  draftFromTopic,
  formatPublished,
  isReviewDirty,
  noteProblem,
  parseActual,
  rebaseDraft,
  reviewProblem,
  toReviewWire,
} from "./reviewDraft"

function topic(patch: Partial<ReviewTopic> = {}): ReviewTopic {
  return { id: 45, text: "Review opening", planned_seconds: 120, context: "PRIVATE", revision: 2, rating: 0, note: "", actual_seconds: null, delta_seconds: null, updated_at: null, ...patch }
}

describe("actual seconds", () => {
  test("blank is unrecorded (null); whole numbers 0–86400 are values; 0 counts as recorded", () => {
    expect(parseActual("")).toBeNull()
    expect(parseActual("   ")).toBeNull()
    expect(parseActual("0")).toBe(0)
    expect(parseActual(" 150 ")).toBe(150)
    expect(parseActual("86400")).toBe(86400)
  })

  test("fractions, negatives, out-of-range and text are invalid and block saving", () => {
    for (const bad of ["90.5", "-1", "86401", "1e3", "abc", "1 2"]) {
      expect(parseActual(bad), bad).toBeUndefined()
      expect(actualProblem(bad), bad).toMatch(/whole number from 0 to 86400/)
    }
    expect(actualProblem("")).toBeNull()
    expect(actualProblem("42")).toBeNull()
  })
})

describe("review draft", () => {
  test("note is limited to 4000 characters (code points)", () => {
    expect(noteProblem("x".repeat(4000))).toBeNull()
    expect(noteProblem("x".repeat(4001))).toMatch(/4000/)
    expect(noteProblem("😀".repeat(4000))).toBeNull()
  })

  test("dirty on rating, note or a changed actual; blank vs 0 differ; whitespace-only actual changes do not", () => {
    const draft = draftFromTopic(topic({ actual_seconds: 150 }), 23)
    expect(isReviewDirty(draft)).toBe(false)
    expect(isReviewDirty({ ...draft, actual: " 150 " })).toBe(false)
    expect(isReviewDirty({ ...draft, actual: "" })).toBe(true)
    expect(isReviewDirty({ ...draft, rating: 1 })).toBe(true)
    expect(isReviewDirty({ ...draft, note: "x" })).toBe(true)
    const blank = draftFromTopic(topic(), 23)
    expect(isReviewDirty({ ...blank, actual: "0" })).toBe(true)
    // An invalid entry is still "work": it must be protected by the guard.
    expect(isReviewDirty({ ...blank, actual: "90.5" })).toBe(true)
  })

  test("problem covers rating, note length and actual", () => {
    const draft = draftFromTopic(topic(), 23)
    expect(reviewProblem(draft)).toBeNull()
    expect(reviewProblem({ ...draft, actual: "-1" })).toMatch(/Actual seconds/)
    expect(reviewProblem({ ...draft, note: "x".repeat(4001) })).toMatch(/Review note/)
  })

  test("wire form is exactly revision, rating, note, actual_seconds; blank actual is null; context is never sent", () => {
    const draft = { ...draftFromTopic(topic({ revision: 7 }), 23), rating: -1 as const, note: "Ran long", actual: "150" }
    expect(toReviewWire(draft)).toEqual({ revision: 7, rating: -1, note: "Ran long", actual_seconds: 150 })
    expect(Object.keys(toReviewWire(draft)).sort()).toEqual(["actual_seconds", "note", "rating", "revision"])
    expect(toReviewWire({ ...draft, actual: "" }).actual_seconds).toBeNull()
    expect(toReviewWire({ ...draft, actual: "0" }).actual_seconds).toBe(0)
    expect(() => toReviewWire({ ...draft, actual: "1.5" })).toThrow()
  })

  test("rebase after a conflict keeps every local value and pins the latest revision", () => {
    const mine = { ...draftFromTopic(topic({ revision: 2 }), 23), rating: 1 as const, note: "mine", actual: "100" }
    const latest = topic({ revision: 9, rating: -1, note: "theirs", actual_seconds: 300, delta_seconds: 180 })
    const rebased = rebaseDraft(mine, latest)
    expect(rebased).toMatchObject({ baseRevision: 9, rating: 1, note: "mine", actual: "100", base: { rating: -1, note: "theirs", actual: "300" } })
    expect(toReviewWire(rebased).revision).toBe(9)
    expect(isReviewDirty(rebased)).toBe(true)
  })
})

describe("presentation", () => {
  test("delta only when recorded, with sign and direction", () => {
    expect(deltaOf(120, "")).toBeNull()
    expect(deltaOf(120, "abc")).toBeNull()
    expect(deltaOf(120, "150")).toBe(30)
    expect(deltaOf(120, 100)).toBe(-20)
    expect(deltaOf(120, null)).toBeNull()
    expect(deltaLabel(30)).toBe("+30 s over plan")
    expect(deltaLabel(-20)).toBe("−20 s under plan")
    expect(deltaLabel(0)).toBe("On plan (0 s)")
  })

  test("published stamp is a local date and time with a zone name; garbage passes through", () => {
    const label = formatPublished("2026-09-15T15:06:33.830779+00:00")
    expect(label).toMatch(/2026/)
    expect(label).toMatch(/\d:\d\d/)
    expect(formatPublished("nope")).toBe("nope")
  })
})
