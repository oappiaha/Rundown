// Per-idea preparation state owned by the Inbox view. The panel that renders
// it is mounted only while an idea is open, so a filter switch, "New idea" or
// a discard would otherwise throw away an edited suggestion or misplace a
// slow answer. The store lives as long as the Inbox view does; every update
// is keyed by idea id and read through a ref, so an answer that arrives after
// the panel unmounted still lands on its own idea.
import { useCallback, useRef, useState } from "react"
import { EMPTY_PREP, type TopicPrep } from "./prepDraft"

export type PreparationStore = {
  preps: Record<string, TopicPrep>
  /** Latest state, for async code that must not read a stale render. */
  ref: { readonly current: Record<string, TopicPrep> }
  patch: (id: string, update: (current: TopicPrep) => TopicPrep) => void
  /** Per-idea sequence so an older GET never overwrites a newer one. */
  loadSeq: Map<string, number>
}

export function usePreparationStore(): PreparationStore {
  const [preps, setPreps] = useState<Record<string, TopicPrep>>({})
  const ref = useRef(preps)
  // A stable map, not a ref: it is handed out during render and only mutated by async code.
  const [loadSeq] = useState(() => new Map<string, number>())
  const patch = useCallback((id: string, update: (current: TopicPrep) => TopicPrep) => {
    const next = { ...ref.current, [id]: update(ref.current[id] ?? EMPTY_PREP) }
    ref.current = next
    setPreps(next)
  }, [])
  return { preps, ref, patch, loadSeq }
}
