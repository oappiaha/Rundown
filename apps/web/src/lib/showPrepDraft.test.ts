import { describe, expect, test } from "vitest"
import type { SavedShowTopic, ShowPreparationRun, ShowPreparationStatus } from "./api"
import {
  EMPTY_SHOW_PREP,
  MAX_NOTES_HINT,
  adoptRun,
  adoptStatus,
  appendedNotes,
  applyPayload,
  consented,
  draftsFromRun,
  isEdited,
  noteProblem,
  refreshRun,
  runApplied,
  runStale,
  selectionProblem,
  titleFor,
  withRun,
  type ShowPrep,
} from "./showPrepDraft"

const topics: SavedShowTopic[] = [
  { id: "t1", text: "Cold open", duration: 60, notes: "Say hi\nSource: https://example.test/a" },
  { id: "t2", text: "Main story", duration: 300, notes: "" },
]

function run(patch: Partial<ShowPreparationRun> = {}): ShowPreparationRun {
  return {
    id: "run-1",
    show_id: "s1",
    revision: 1,
    status: "succeeded",
    started_at: "2026-09-16T00:00:00+00:00",
    model: "fixture-model",
    mode: "fixture",
    items: [
      { id: "t1", summary: "Summary one", talking_points: ["a", "b", "c"] },
      { id: "t2", summary: "Summary two", talking_points: ["d", "e", "f"] },
    ],
    input_tokens: 400,
    output_tokens: 500,
    stale: false,
    applied_revision: null,
    error: null,
    ...patch,
  }
}

function status(patch: Partial<ShowPreparationStatus> = {}): ShowPreparationStatus {
  return {
    show_id: "s1",
    revision: 1,
    settings: { enabled: true, ready: true, provider: "Local test fixture", model: "fixture-model", daily_limit: 100, used_today: 1, remaining_today: 99, max_input_chars: 12000, max_output_tokens: 16000, mode: "fixture", reason: null, max_topics: 20, max_input_chars_per_topic: 4000 },
    latest_run: null,
    ...patch,
  }
}

describe("drafts and bounds", () => {
  test("a succeeded run becomes editable, all-ticked drafts in saved order; anything else is nothing to review", () => {
    const drafts = draftsFromRun(run())!
    expect(drafts.map((d) => [d.id, d.selected, d.pointsText])).toEqual([["t1", true, "a\nb\nc"], ["t2", true, "d\ne\nf"]])
    expect(draftsFromRun(run({ status: "failed", items: [] }))).toBeNull()
    expect(draftsFromRun(null)).toBeNull()
  })

  test("note bounds mirror the server: summary 1..800, 3..5 non-blank points each <=300", () => {
    expect(noteProblem({ summary: "ok", points: ["a", "b", "c"] })).toBeNull()
    expect(noteProblem({ summary: "  ", points: ["a", "b", "c"] })).toMatch(/Summary must not be empty/)
    expect(noteProblem({ summary: "x".repeat(801), points: ["a", "b", "c"] })).toMatch(/at most 800/)
    expect(noteProblem({ summary: "ok", points: ["a", "b"] })).toMatch(/3 to 5/)
    expect(noteProblem({ summary: "ok", points: ["a", "b", "c", "d", "e", "f"] })).toMatch(/3 to 5/)
    expect(noteProblem({ summary: "ok", points: ["a", " ", "c"] })).toMatch(/3 to 5/)
    expect(noteProblem({ summary: "ok", points: ["a", " ", "c", "d"] })).toBeNull()
    expect(noteProblem({ summary: "ok", points: ["a", "b", "y".repeat(301)] })).toMatch(/point 3 must be at most 300/)
  })

  test("appended notes match the server block exactly and keep existing context verbatim", () => {
    const item = { summary: "S", talking_points: ["p1", "p2", "p3"] }
    expect(appendedNotes("", item)).toBe("Prepared notes (AI-assisted, reviewed)\nSummary: S\nTalking points:\n- p1\n- p2\n- p3")
    expect(appendedNotes("Say hi\nSource: https://example.test/a", item)).toBe("Say hi\nSource: https://example.test/a\n\nPrepared notes (AI-assisted, reviewed)\nSummary: S\nTalking points:\n- p1\n- p2\n- p3")
  })

  test("selection problems: nothing ticked, invalid ticked note, missing topic, and the 10000-character topic limit", () => {
    const drafts = draftsFromRun(run())!
    expect(selectionProblem(drafts, topics)).toBeNull()
    expect(selectionProblem(drafts.map((d) => ({ ...d, selected: false })), topics)).toMatch(/Tick at least one/)
    expect(selectionProblem([{ ...drafts[0]!, summary: "" }, drafts[1]!], topics)).toMatch(/^1\. Cold open: Summary must not be empty/)
    // An unticked invalid note does not block the others.
    expect(selectionProblem([{ ...drafts[0]!, summary: "", selected: false }, drafts[1]!], topics)).toBeNull()
    expect(selectionProblem([{ ...drafts[0]!, id: "gone" }], topics)).toMatch(/no longer in the saved show/)
    const long: SavedShowTopic[] = [{ ...topics[0]!, notes: "n".repeat(9950) }, topics[1]!]
    expect(selectionProblem(drafts, long)).toMatch(/over the 10000 limit/)
    expect(MAX_NOTES_HINT).toBe(10000)
  })

  test("apply payload carries ticked notes only, in generated order, trimmed and without blank points", () => {
    const drafts = draftsFromRun(run())!
    const edited = [{ ...drafts[0]!, summary: "  Edited  ", points: ["x", " ", "y ", "z"] }, { ...drafts[1]!, selected: false }]
    expect(applyPayload(1, edited)).toEqual({ revision: 1, items: [{ id: "t1", summary: "Edited", talking_points: ["x", "y", "z"] }] })
  })

  test("titles come from the saved topics by id; never the raw id", () => {
    expect(titleFor("t2", topics)).toBe("2. Main story")
    expect(titleFor("nope", topics)).toBe("Topic no longer in this show")
  })
})

describe("folding server state without losing local work", () => {
  const generated: ShowPrep = withRun(EMPTY_SHOW_PREP, run())
  const edited: ShowPrep = { ...generated, drafts: generated.drafts!.map((d, i) => (i === 0 ? { ...d, summary: "Edited" } : d)) }

  test("a status refresh of the same run keeps edited text and takes stale/applied facts", () => {
    const next = adoptStatus(edited, status({ revision: 2, latest_run: run({ stale: true, applied_revision: 2 }) }))
    expect(next.drafts![0]!.summary).toBe("Edited")
    expect(next.run!.stale).toBe(true)
    expect(next.run!.applied_revision).toBe(2)
    expect(isEdited(next)).toBe(true)
  })

  test("a different latest run is announced, never adopted silently", () => {
    const other = run({ id: "run-2", revision: 2 })
    const next = adoptStatus(edited, status({ revision: 2, latest_run: other }))
    expect(next.run!.id).toBe("run-1")
    expect(next.newerRun!.id).toBe("run-2")
    expect(next.drafts![0]!.summary).toBe("Edited")
    // Same for an unedited recovered run: identity is kept until the user chooses.
    expect(adoptStatus(generated, status({ latest_run: other })).run!.id).toBe("run-1")
  })

  test("a revision change drops the previewed input and its consent; same revision keeps both", () => {
    const withInput: ShowPrep = { ...EMPTY_SHOW_PREP, input: { show_id: "s1", revision: 1, input_text: "x", input_hash: "h", input_truncated: false, settings: status().settings }, consentHash: "h" }
    expect(consented(withInput, 1)).toBe(true)
    expect(consented(withInput, 2)).toBe(false)
    const same = adoptStatus(withInput, status())
    expect(same.input).not.toBeNull()
    expect(same.consentHash).toBe("h")
    const moved = adoptStatus(withInput, status({ revision: 2 }))
    expect(moved.input).toBeNull()
    expect(moved.consentHash).toBeNull()
  })

  test("a lost generate whose run appears on the server is adopted and the ambiguity ends", () => {
    const lost: ShowPrep = { ...EMPTY_SHOW_PREP, ambiguous: { requestId: "run-9", revision: 1, inputHash: "h" } }
    const found = run({ id: "run-9" })
    const viaStatus = adoptStatus(lost, status({ latest_run: found }))
    expect(viaStatus.ambiguous).toBeNull()
    expect(viaStatus.run!.id).toBe("run-9")
    expect(viaStatus.drafts).toHaveLength(2)
    const viaRun = adoptRun(lost, found)
    expect(viaRun.ambiguous).toBeNull()
    expect(viaRun.run!.id).toBe("run-9")
    // A different id on the server does not end the ambiguity.
    expect(adoptStatus(lost, status({ latest_run: run({ id: "run-8" }) })).ambiguous).not.toBeNull()
  })

  test("while our generate is in flight a status refresh never touches the run under review", () => {
    const busy: ShowPrep = { ...edited, pending: "generate" }
    const next = adoptStatus(busy, status({ latest_run: run({ id: "run-2" }) }))
    expect(next.run!.id).toBe("run-1")
    expect(next.newerRun).toBeNull()
    expect(next.status).not.toBeNull()
  })

  test("a frozen apply survives status refreshes, same-run polls and local edits", () => {
    const frozen: ShowPrep = { ...edited, pendingApply: { runId: "run-1", payload: applyPayload(1, edited.drafts!) } }
    const refreshed = adoptStatus(frozen, status({ revision: 2, latest_run: run({ stale: true, applied_revision: 2 }) }))
    expect(refreshed.pendingApply).toEqual(frozen.pendingApply)
    expect(refreshed.drafts![0]!.summary).toBe("Edited")
    const polled = refreshRun(frozen, run({ applied_revision: 2 }))
    expect(polled.pendingApply).toEqual(frozen.pendingApply)
    const other = adoptStatus(frozen, status({ latest_run: run({ id: "run-2" }) }))
    expect(other.pendingApply).toEqual(frozen.pendingApply)
    expect(other.run!.id).toBe("run-1")
  })

  test("a running run that finishes gets a fresh editable copy; stale and applied are read from run and revision", () => {
    const pending = withRun(EMPTY_SHOW_PREP, run({ status: "running", items: [] }))
    expect(pending.drafts).toBeNull()
    const done = refreshRun(pending, run())
    expect(done.drafts).toHaveLength(2)
    expect(runStale(run(), 1)).toBe(false)
    expect(runStale(run(), 2)).toBe(true)
    expect(runStale(run({ stale: true }), 1)).toBe(true)
    expect(runApplied(EMPTY_SHOW_PREP, run())).toBe(false)
    expect(runApplied(EMPTY_SHOW_PREP, run({ applied_revision: 2 }))).toBe(true)
    expect(runApplied({ applied: { runId: "run-1", revision: 2 } }, run())).toBe(true)
  })
})
