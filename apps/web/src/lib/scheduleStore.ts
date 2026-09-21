// Per-feed schedule state owned by the Sources view. The schedule panel is
// mounted only while a saved feed is open, so switching feeds, a refresh or
// the unsaved-feed guard would otherwise drop an edited-but-unsaved schedule
// or misplace a slow answer. The store lives as long as the Sources view does;
// every update is keyed by feed id and read through a ref, so a response that
// arrives after the panel unmounted (or after another feed was opened) still
// lands on its own feed and never on the one now open.
import { useCallback, useRef, useState } from "react"
import type { FeedSchedule } from "./api"
import type { ScheduleDraft } from "./scheduleDraft"

export type ScheduleNotice = { kind: "info" | "error"; text: string }
export type SchedulePending = "load" | "save" | "recover" | null

export type ScheduleSlot = {
  /** Latest server copy, null until the first successful read. */
  schedule: FeedSchedule | null
  /** Local settings pinned to a revision; null until loaded. Survives feed switching. */
  draft: ScheduleDraft | null
  loadError: string | null
  pending: SchedulePending
  notice: ScheduleNotice | null
  /** A rejected save because the schedule changed elsewhere; the draft is kept until the user picks a recovery. */
  conflict: { detail: string } | null
}

export const EMPTY_SLOT: ScheduleSlot = { schedule: null, draft: null, loadError: null, pending: null, notice: null, conflict: null }

export type ScheduleStore = {
  slots: Record<string, ScheduleSlot>
  /** Latest state, for async code that must not read a stale render. */
  ref: { readonly current: Record<string, ScheduleSlot> }
  patch: (feedId: string, update: (current: ScheduleSlot) => ScheduleSlot) => void
  /** Per-feed sequence so an older read never overwrites a newer one. */
  seq: Map<string, number>
}

export function useScheduleStore(): ScheduleStore {
  const [slots, setSlots] = useState<Record<string, ScheduleSlot>>({})
  const ref = useRef(slots)
  // A stable map, not a ref: it is handed out during render and only mutated by async code.
  const [seq] = useState(() => new Map<string, number>())
  const patch = useCallback((feedId: string, update: (current: ScheduleSlot) => ScheduleSlot) => {
    const next = { ...ref.current, [feedId]: update(ref.current[feedId] ?? EMPTY_SLOT) }
    ref.current = next
    setSlots(next)
  }, [])
  return { slots, ref, patch, seq }
}
