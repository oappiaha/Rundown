// Per-show preparation state owned by the Saved Shows view. The panel that
// renders it is mounted only while a saved show is open, so switching shows,
// starting a new one or navigating away would otherwise throw away edited
// notes or misplace a slow answer. The store lives as long as the view does
// (the view is hidden, not unmounted, on navigation); every update is keyed by
// show id and read through a ref, so an answer that arrives after the panel
// unmounted or the selection moved still lands on its own show.
import { useCallback, useRef, useState } from "react"
import { EMPTY_SHOW_PREP, type ShowPrep } from "./showPrepDraft"

export type ShowPreparationStore = {
  preps: Record<string, ShowPrep>
  /** Latest state, for async code that must not read a stale render. */
  ref: { readonly current: Record<string, ShowPrep> }
  patch: (id: string, update: (current: ShowPrep) => ShowPrep) => void
  /** Per-show sequence so an older status GET never overwrites a newer one. */
  loadSeq: Map<string, number>
}

export function useShowPreparationStore(): ShowPreparationStore {
  const [preps, setPreps] = useState<Record<string, ShowPrep>>({})
  const ref = useRef(preps)
  const [loadSeq] = useState(() => new Map<string, number>())
  const patch = useCallback((id: string, update: (current: ShowPrep) => ShowPrep) => {
    const next = { ...ref.current, [id]: update(ref.current[id] ?? EMPTY_SHOW_PREP) }
    ref.current = next
    setPreps(next)
  }, [])
  return { preps, ref, patch, loadSeq }
}
