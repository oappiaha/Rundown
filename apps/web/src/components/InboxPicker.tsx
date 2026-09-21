import { useCallback, useEffect, useId, useRef, useState } from "react"
import { ApiError, getInboxItem, listInbox, type InboxItem, type InboxTopic } from "../lib/api"
import { formatClock } from "../lib/draft"
import { safeSourceHref } from "../lib/inboxDraft"

export type PickPlacement = "end" | "next"

type Props = {
  /**
   * Identifies the draft that receives the copy (view, selection, live
   * revision/current segment, draft epoch). The owner passes it as the React
   * `key` too, so any change remounts the panel: a pick whose authoritative
   * fetch finishes after the key changed is dropped (never lands on a
   * different or replaced draft) and `onDropped` reports it.
   */
  targetKey: string
  /** Why adding is unavailable right now (full, locked, conflict…), or null. Re-read when a fetch completes. */
  blockReason: string | null
  /** Live rundown only: offer "Insert next" after the current segment. */
  hasCurrent?: boolean
  /** Visible wording for the placement buttons; `next` omitted hides that option. */
  labels: { end: string; next?: string }
  /** Where the copy goes, for the confirmation line ("the live draft", "this show"). */
  targetName: string
  /**
   * Called with the item's server projection once it is confirmed still
   * active. Returns a failure message when the caller cannot take it right
   * now (its own final check), or null on success.
   */
  onPick: (topic: InboxTopic, source: InboxItem, where: PickPlacement) => string | null
  onClose: () => void
  /** A pick was still loading when the panel closed or its target changed; nothing was added. */
  onDropped?: (text: string) => void
}

type Notice = { kind: "info" | "error"; text: string }

function describeError(error: unknown, what: string): string {
  if (error instanceof ApiError) return `${what} rejected (${error.status}): ${error.detail}`
  return `${what} failed: the RUNDOWN API did not respond.`
}

function hostOf(url: string): string {
  const href = safeSourceHref(url)
  if (href === null) return ""
  try {
    return new URL(href).host
  } catch {
    return ""
  }
}

/**
 * Reusable "copy an idea from the inbox" panel for the live and saved-show
 * editors. Lists active ideas; a pick re-reads the item from the server (so
 * the copy carries the latest context and a since-archived idea is refused)
 * and hands the server's copy-ready projection to the owner of the draft.
 */
export default function InboxPicker({ targetKey, blockReason, hasCurrent = false, labels, targetName, onPick, onClose, onDropped }: Props) {
  const [items, setItems] = useState<InboxItem[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  /** A manual refresh is in flight (the first load shows "Loading ideas…" instead). */
  const [loading, setLoading] = useState(false)
  /** Item whose authoritative fetch is in flight; every Add button is disabled meanwhile (no double copies). */
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const listSeq = useRef(0)
  const pickSeq = useRef(0)
  /** Synchronous in-flight lock: two clicks in one tick cannot both start a copy. */
  const inflightRef = useRef<{ id: string; text: string } | null>(null)
  const headingId = useId()
  // Latest props for checks made when a response arrives, not when the click was rendered.
  // The owner mounts the picker only while it is open, so "still mounted" means "still open".
  const mountedRef = useRef(true)
  const targetRef = useRef(targetKey)
  const blockRef = useRef(blockReason)
  const onPickRef = useRef(onPick)
  const onDroppedRef = useRef(onDropped)
  useEffect(() => {
    targetRef.current = targetKey
    blockRef.current = blockReason
    onPickRef.current = onPick
    onDroppedRef.current = onDropped
  }, [targetKey, blockReason, onPick, onDropped])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      // Closing the panel (or a target change remounting it) drops any pick
      // still loading: its result must not reach the draft.
      mountedRef.current = false
      pickSeq.current += 1
      listSeq.current += 1
      const dropped = inflightRef.current
      inflightRef.current = null
      if (dropped) onDroppedRef.current?.(dropped.text)
    }
  }, [])

  const refresh = useCallback(() => {
    const token = ++listSeq.current
    listInbox(false).then(
      (next) => {
        if (token !== listSeq.current) return
        setItems(next)
        setListError(null)
        setLoading(false)
      },
      (error: unknown) => {
        if (token !== listSeq.current) return
        setListError(describeError(error, "Loading the inbox"))
        setLoading(false)
      },
    )
  }, [])

  // Fresh list every time the panel opens (it is mounted only while open).
  useEffect(() => {
    refresh()
  }, [refresh])

  function refreshNow() {
    setLoading(true)
    setNotice(null)
    refresh()
  }

  async function pick(item: InboxItem, where: PickPlacement) {
    if (inflightRef.current !== null || pendingId !== null || blockReason !== null) return
    const key = targetKey
    const token = ++pickSeq.current
    inflightRef.current = { id: item.id, text: item.text }
    setPendingId(item.id)
    setNotice(null)
    try {
      // Authoritative read: the list may be stale, and the copy must carry the
      // latest context and source exactly as the server projects them.
      const latest = await getInboxItem(item.id)
      if (token !== pickSeq.current || !mountedRef.current) return
      if (targetRef.current !== key) {
        setNotice({ kind: "error", text: `Not added: what you were editing changed while "${latest.text}" was loading. Pick it again if you still want it.` })
        return
      }
      if (blockRef.current !== null) {
        setNotice({ kind: "error", text: `Not added: ${blockRef.current}` })
        return
      }
      if (latest.archived) {
        setNotice({ kind: "error", text: `Not added: "${latest.text}" was archived on another screen just now. Restore it in the Inbox if you still want it.` })
        refresh()
        return
      }
      const failure = onPickRef.current(latest.topic, latest, where)
      if (failure !== null) {
        setNotice({ kind: "error", text: `Not added: ${failure}` })
        return
      }
      const placed = where === "next" ? "inserted after the current segment" : "added to the end"
      setNotice({
        kind: "info",
        text: `"${latest.text}" ${placed} of ${targetName} with its context${latest.source_url ? " and source" : ""}. It is an independent copy: editing or archiving the idea later will not change it.`,
      })
      if (latest.revision !== item.revision) refresh()
    } catch (error) {
      if (token !== pickSeq.current || !mountedRef.current) return
      if (error instanceof ApiError && error.status === 404) {
        setNotice({ kind: "error", text: `Not added: "${item.text}" no longer exists in the inbox.` })
        refresh()
      } else {
        setNotice({ kind: "error", text: describeError(error, `Loading "${item.text}"`) })
      }
    } finally {
      if (token === pickSeq.current && mountedRef.current) {
        inflightRef.current = null
        setPendingId(null)
      }
    }
  }

  const disabled = blockReason !== null || pendingId !== null

  return (
    <section className="reuse inbox-picker" aria-labelledby={headingId} aria-busy={pendingId !== null || undefined}>
      <div className="inbox-picker-head">
        <h3 id={headingId}>Add from inbox</h3>
        <div className="inline-form-actions">
          <button type="button" className="btn" disabled={loading} onClick={refreshNow}>
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <p>
        Copies the idea's title, length and full context (with its source line) into {targetName} as a new row. The inbox idea stays where it is and later
        changes to either side do not affect the other.
      </p>
      {blockReason ? (
        <p className="reuse-hint inbox-picker-block" role="status">
          {blockReason}
        </p>
      ) : null}
      {notice ? (
        <p className={`inbox-picker-notice${notice.kind === "error" ? " error" : ""}`} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.text}
        </p>
      ) : null}
      {listError ? (
        <div className="banner error" role="alert">
          <p>{listError}</p>
          <div className="banner-actions">
            <button type="button" className="btn" onClick={refresh}>
              Retry
            </button>
          </div>
        </div>
      ) : items === null ? (
        <p className="reuse-hint">Loading ideas…</p>
      ) : items.length === 0 ? (
        <p className="reuse-hint">No active ideas. Capture one in the Inbox first.</p>
      ) : (
        <ul className="reuse-list" aria-label="Active inbox ideas">
          {items.map((item) => {
            const host = hostOf(item.source_url)
            const busy = pendingId === item.id
            return (
              <li key={item.id} className="reuse-row inbox-pick-row">
                <span className="reuse-text">
                  <strong>{item.text}</strong> · {formatClock(item.duration)}
                  {item.notes.length > 0 ? <span className="reuse-notes"> · has context</span> : null}
                  {host ? <span className="reuse-notes"> · source: {host}</span> : null}
                </span>
                <span className="inbox-pick-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={disabled}
                    aria-label={`${labels.end}: "${item.text}"`}
                    onClick={() => void pick(item, "end")}
                  >
                    {busy ? "Adding…" : labels.end}
                  </button>
                  {labels.next ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={disabled || !hasCurrent}
                      title={hasCurrent ? "Insert immediately after the current segment" : "Nothing is playing yet"}
                      aria-label={`${labels.next}: "${item.text}"`}
                      onClick={() => void pick(item, "next")}
                    >
                      {labels.next}
                    </button>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
