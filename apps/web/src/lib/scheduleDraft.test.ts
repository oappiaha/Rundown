import { describe, expect, test } from "vitest"
import type { FeedSchedule, ImportRun } from "./api"
import {
  DEFAULT_INTERVAL,
  MAX_INTERVAL,
  MIN_INTERVAL,
  draftFromSchedule,
  dueInLabel,
  dueLabel,
  intervalLabel,
  intervalProblem,
  isScheduleDirty,
  lastAutomaticSummary,
  mergeScheduleDraft,
  scheduleProblem,
  toScheduleWire,
} from "./scheduleDraft"

function schedule(patch: Partial<FeedSchedule> = {}): FeedSchedule {
  return { feed_id: "f1", revision: 0, enabled: false, interval_minutes: DEFAULT_INTERVAL, next_run_at: null, last_run: null, effective: false, reason: "Automatic imports are off for this feed.", server_time: "2026-09-15T10:00:00.000Z", ...patch }
}

function run(patch: Partial<ImportRun> = {}): ImportRun {
  return { id: "r1", feed_id: "f1", status: "succeeded", started_at: "2026-09-15T09:00:00.000Z", finished_at: "2026-09-15T09:00:02.000Z", created: 2, duplicates: 1, skipped: 0, examined: 3, error: null, warnings: [], items: [], ...patch }
}

describe("validation", () => {
  test("interval accepts whole minutes from 15 to 10080 only", () => {
    expect(intervalProblem(MIN_INTERVAL)).toBeNull()
    expect(intervalProblem(MAX_INTERVAL)).toBeNull()
    expect(intervalProblem(60)).toBeNull()
    for (const bad of [14, 10081, 0, -15, 15.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(intervalProblem(bad)).toMatch(/15 to 10080/)
    }
    expect(scheduleProblem({ enabled: false, interval_minutes: 5 })).not.toBeNull()
    expect(scheduleProblem({ enabled: true, interval_minutes: 15 })).toBeNull()
  })
})

describe("draft", () => {
  test("a never-configured feed reads as revision 0, off, 60 minutes and is not dirty", () => {
    const draft = draftFromSchedule(schedule())
    expect(draft).toEqual({ enabled: false, interval_minutes: 60, baseRevision: 0, base: { enabled: false, interval_minutes: 60 } })
    expect(isScheduleDirty(draft)).toBe(false)
    expect(isScheduleDirty({ ...draft, enabled: true })).toBe(true)
    expect(isScheduleDirty({ ...draft, interval_minutes: 61 })).toBe(true)
  })

  test("the wire form is the full strict payload pinned to the base revision", () => {
    const draft = { ...draftFromSchedule(schedule({ revision: 4 })), enabled: true, interval_minutes: 30 }
    expect(toScheduleWire(draft)).toEqual({ revision: 4, enabled: true, interval_minutes: 30 })
    expect(Object.keys(toScheduleWire(draft)).sort()).toEqual(["enabled", "interval_minutes", "revision"])
  })

  test("merge keeps edited settings, takes the other screen's untouched ones and moves to the server revision", () => {
    const draft = { ...draftFromSchedule(schedule({ revision: 1 })), interval_minutes: 45 }
    const latest = schedule({ revision: 2, enabled: true, interval_minutes: 120, next_run_at: "2026-09-15T12:00:00.000Z", effective: true, reason: null })
    const merged = mergeScheduleDraft(draft, latest)
    expect(merged).toMatchObject({ enabled: true, interval_minutes: 45, baseRevision: 2, base: { enabled: true, interval_minutes: 120 } })
    expect(isScheduleDirty(merged)).toBe(true)
    // Nothing edited: the merge is exactly the latest version.
    const clean = mergeScheduleDraft(draftFromSchedule(schedule({ revision: 1 })), latest)
    expect(isScheduleDirty(clean)).toBe(false)
    expect(clean.baseRevision).toBe(2)
  })
})

describe("presentation", () => {
  test("interval labels", () => {
    expect(intervalLabel(15)).toBe("every 15 minutes")
    expect(intervalLabel(60)).toBe("every hour")
    expect(intervalLabel(90)).toBe("every 90 minutes")
    expect(intervalLabel(180)).toBe("every 3 hours")
    expect(intervalLabel(1440)).toBe("every day")
    expect(intervalLabel(10080)).toBe("every 7 days")
  })

  test("due labels use the local zone and count down against the server clock, never the browser's", () => {
    const label = dueLabel("2026-09-15T10:30:00.000Z")
    expect(label).toMatch(/2026/)
    expect(label).not.toBe("2026-09-15T10:30:00.000Z")
    // Zone suffix present (short name such as PDT/GMT+2/UTC).
    expect(label.split(" ").length).toBeGreaterThanOrEqual(4)
    expect(dueLabel("garbage")).toBe("garbage")
    const server = "2026-09-15T10:00:00.000Z"
    expect(dueInLabel("2026-09-15T10:00:30.000Z", server)).toBe("in under a minute")
    expect(dueInLabel("2026-09-15T10:30:00.000Z", server)).toBe("in 30 minutes")
    expect(dueInLabel("2026-09-15T11:00:00.000Z", server)).toBe("in 1 hour")
    expect(dueInLabel("2026-09-18T10:00:00.000Z", server)).toBe("in 3 days")
    expect(dueInLabel("2026-09-15T09:59:00.000Z", server)).toMatch(/due now/)
    expect(dueInLabel("nope", server)).toBe("")
  })

  test("last automatic run summary", () => {
    expect(lastAutomaticSummary(null)).toBe("No automatic import has run yet.")
    expect(lastAutomaticSummary(run())).toBe("Last automatic import: 2 new ideas · 1 duplicate · 0 skipped · 3 examined.")
    expect(lastAutomaticSummary(run({ status: "failed", error: "HTTP 503" }))).toBe("Last automatic import failed: HTTP 503")
    expect(lastAutomaticSummary(run({ status: "running", finished_at: null }))).toBe("An automatic import is running now.")
  })
})
