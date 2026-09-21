import { expect, test } from "vitest"
import type { PreparationRun, PreparationView } from "./api"
import { EMPTY_PREP, UUID_RE, adoptView, withRun, appendSuggestion, newRequestId, parsePoints, sameSuggestion, suggestionBlock, suggestionFromRun, suggestionProblem } from "./prepDraft"

function run(patch: Partial<PreparationRun> = {}): PreparationRun {
  return {
    id: "r1",
    topic_id: "i1",
    revision: 2,
    status: "succeeded",
    started_at: "2026-09-15T00:00:00Z",
    finished_at: "2026-09-15T00:00:02Z",
    model: "fixture-model",
    summary: "  A summary.  ",
    talking_points: ["One", "Two", "Three"],
    input_truncated: false,
    input_tokens: 10,
    output_tokens: 5,
    error: null,
    stale: false,
    ...patch,
  }
}

test("only a succeeded run yields an editable suggestion; failed, running and interrupted runs give nothing to review", () => {
  expect(suggestionFromRun(run())).toEqual({ summary: "  A summary.  ", points: ["One", "Two", "Three"] })
  expect(suggestionFromRun(run({ status: "failed", summary: null, talking_points: [] }))).toBeNull()
  expect(suggestionFromRun(run({ status: "running" }))).toBeNull()
  expect(suggestionFromRun(run({ status: "interrupted" }))).toBeNull()
  expect(suggestionFromRun(null)).toBeNull()
})

test("the appended block follows the contract exactly and keeps existing context verbatim", () => {
  const suggestion = { summary: " Why it matters. ", points: ["First point", "Second point", "Third point"] }
  expect(suggestionBlock(suggestion)).toBe("Summary\nWhy it matters.\n\nTalking points\n- First point\n- Second point\n- Third point")
  expect(appendSuggestion("existing notes  \nline two", suggestion)).toBe("existing notes  \nline two\n\nSummary\nWhy it matters.\n\nTalking points\n- First point\n- Second point\n- Third point")
  // Nothing to separate from: no leading blank lines.
  expect(appendSuggestion("", suggestion)).toBe("Summary\nWhy it matters.\n\nTalking points\n- First point\n- Second point\n- Third point")
})

test("talking points parse one per line, ignore blank lines and strip a leading bullet marker", () => {
  expect(parsePoints("- one\n\n* two  \n• three\nfour")).toEqual(["one", "two", "three", "four"])
  expect(parsePoints("")).toEqual([])
})

test("validation: summary 1-1500 characters, 3-5 non-empty points of at most 500 characters", () => {
  const ok = { summary: "s", points: ["a", "b", "c"] }
  expect(suggestionProblem(ok)).toBeNull()
  expect(suggestionProblem({ ...ok, points: ["a", "b", "c", "d", "e"] })).toBeNull()
  expect(suggestionProblem({ ...ok, summary: "   " })).toMatch(/Summary must not be empty/)
  expect(suggestionProblem({ ...ok, summary: "x".repeat(1501) })).toMatch(/at most 1500/)
  expect(suggestionProblem({ ...ok, summary: "é".repeat(1500) })).toBeNull()
  expect(suggestionProblem({ ...ok, points: ["a", "b"] })).toMatch(/3 to 5 lines/)
  expect(suggestionProblem({ ...ok, points: ["a", "b", "c", "d", "e", "f"] })).toMatch(/3 to 5 lines/)
  expect(suggestionProblem({ ...ok, points: ["a", "  ", "c", "d"] })).toBeNull()
  expect(suggestionProblem({ ...ok, points: ["a", "b", "x".repeat(501)] })).toMatch(/point 3 must be at most 500/)
})

test("sameSuggestion compares text and points exactly", () => {
  const a = { summary: "s", points: ["a", "b", "c"] }
  expect(sameSuggestion(a, { summary: "s", points: ["a", "b", "c"] })).toBe(true)
  expect(sameSuggestion(a, { summary: "s ", points: ["a", "b", "c"] })).toBe(false)
  expect(sameSuggestion(a, { summary: "s", points: ["a", "b"] })).toBe(false)
  expect(sameSuggestion(null, null)).toBe(true)
  expect(sameSuggestion(a, null)).toBe(false)
})

test("every deliberate generation gets a fresh RFC 4122 request id", () => {
  const ids = new Set(Array.from({ length: 20 }, () => newRequestId()))
  expect(ids.size).toBe(20)
  for (const id of ids) expect(id).toMatch(UUID_RE)
})


function view(): PreparationView {
  return { topic_id: "i1", revision: 2, input_text: "Saved evidence", input_truncated: false,
    can_generate: true, reason: null, latest_run: run(), settings: {
      enabled: true, ready: true, provider: "Local test fixture", model: "fixture-model",
      daily_limit: 10, used_today: 1, remaining_today: 9, max_input_chars: 12000,
      max_output_tokens: 1200, mode: "fixture", reason: null,
    } }
}

test("finding a lost newer run preserves edits to the older suggestion until explicit replacement", () => {
  const old = withRun({ ...EMPTY_PREP, view: view(), consent: true }, run())
  const next = adoptView({ ...old, ambiguous: { requestId: "r2", revision: 2 },
    suggestion: { summary: "My unsaved edits", points: ["a", "b", "c"] } },
    { ...view(), latest_run: run({ id: "r2", summary: "New provider answer" }) })
  expect(next.ambiguous).toBeNull()
  expect(next.suggestion?.summary).toBe("My unsaved edits")
  expect(next.newerRun?.id).toBe("r2")
})

test("consent resets when provider or model changes even with the same saved input", () => {
  const current = { ...EMPTY_PREP, view: view(), consent: true }
  expect(adoptView(current, view()).consent).toBe(true)
  const changedProvider = { ...view(), settings: { ...view().settings, mode: "anthropic" as const, provider: "Anthropic" } }
  expect(adoptView(current, changedProvider).consent).toBe(false)
  const changedModel = { ...view(), settings: { ...view().settings, model: "another-model" } }
  expect(adoptView(current, changedModel).consent).toBe(false)
})
