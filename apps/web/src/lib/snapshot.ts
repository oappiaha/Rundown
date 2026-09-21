// Ordering guard for server snapshots. Every place that adopts a ShowState
// (poll, publish result, transport result, merge fetch) must go through this
// so a delayed, older GET response cannot regress state after a mutation.
import type { ShowState } from "./api"

function stamp(state: ShowState): number {
  const parsed = Date.parse(state.server_time)
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
}

/**
 * True when `next` may replace `previous`: a higher revision always wins; for
 * the same revision the snapshot with the later (or equal) server_time wins.
 * A lower revision is always stale.
 */
export function supersedes(previous: ShowState | null, next: ShowState): boolean {
  if (previous === null) return true
  if (next.revision !== previous.revision) return next.revision > previous.revision
  const a = stamp(previous)
  const b = stamp(next)
  if (a === Number.NEGATIVE_INFINITY || b === Number.NEGATIVE_INFINITY) return next.server_time >= previous.server_time
  return b >= a
}
