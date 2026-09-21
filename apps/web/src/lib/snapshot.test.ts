import { expect, test } from "vitest"
import type { ShowState } from "./api"
import { supersedes } from "./snapshot"

function snap(revision: number, server_time: string): ShowState {
  return { revision, topics: [], current_topic_id: null, remaining_seconds: 0, paused: true, server_time }
}

test("a higher revision always supersedes, a lower one never does", () => {
  expect(supersedes(null, snap(1, "2026-09-14T00:00:00Z"))).toBe(true)
  expect(supersedes(snap(3, "2026-09-14T00:00:05Z"), snap(4, "2026-09-14T00:00:01Z"))).toBe(true)
  expect(supersedes(snap(4, "2026-09-14T00:00:01Z"), snap(3, "2026-09-14T00:00:09Z"))).toBe(false)
})

test("same revision: later or equal server_time supersedes, earlier does not", () => {
  const shown = snap(3, "2026-09-15T01:29:12.053479+00:00")
  expect(supersedes(shown, snap(3, "2026-09-15T01:29:13.001000+00:00"))).toBe(true)
  expect(supersedes(shown, snap(3, "2026-09-15T01:29:12.053479+00:00"))).toBe(true)
  expect(supersedes(shown, snap(3, "2026-09-15T01:29:11.900000+00:00"))).toBe(false)
})

test("unparseable server_time falls back to string order", () => {
  expect(supersedes(snap(2, "b"), snap(2, "a"))).toBe(false)
  expect(supersedes(snap(2, "a"), snap(2, "b"))).toBe(true)
})
