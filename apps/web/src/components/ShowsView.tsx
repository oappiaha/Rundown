import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { FormEvent } from "react"
import {
  ApiError,
  activateShow as activateApi,
  createShow,
  createShowFromLive,
  duplicateShow as duplicateApi,
  getShow,
  listShows,
  updateShow,
  type SavedShow,
  type SavedShowSummary,
  type ShowState,
} from "../lib/api"
import { DEFAULT_DURATION, MAX_DURATION, MAX_TITLE, MAX_TOPICS, MIN_DURATION, formatClock, moveTopic, validDuration, validTitle, type DraftTopic } from "../lib/draft"
import {
  MAX_NAME,
  copiedTopic,
  draftFromShow,
  formatMinutes,
  hasUnsavedWork,
  isShowDirty,
  mergeShowDraft,
  newShowDraft,
  showDraftProblem,
  toShowWire,
  topicCount,
  totalSeconds,
  validName,
  type ShowDraft,
} from "../lib/showDraft"
import TopicRow from "./TopicRow"
import InboxPicker from "./InboxPicker"
import ShowPreparation from "./ShowPreparation"
import { useShowPreparationStore } from "../lib/showPrepStore"
import type { InboxTopic } from "../lib/api"

/** What the saved-shows view needs to know about the live rundown (read-only). */
export type LiveInfo = {
  state: ShowState | null
  /** The live editor has unsaved changes. */
  dirty: boolean
  /** A live publish/transport request is pending or a live conflict is open. */
  busy: boolean
  apiDown: boolean
}

/** A request from another view to open one saved show here; `seq` grows so the same show can be requested twice. */
export type OpenShowRequest = { seq: number; id: string; name: string }

type Props = {
  hidden: boolean
  live: LiveInfo
  /** Open this show when the request arrives (new `seq`). Unsaved work in the editor is guarded, never dropped silently. */
  openRequest?: OpenShowRequest | null
  /** Activation succeeded: the parent adopts the new live state and shows the deck. */
  onActivated: (state: ShowState, show: { name: string; count: number }) => void
  /** An activation request is in flight: the parent holds live transport/publish meanwhile. */
  onActivationPending: (pending: boolean) => void
}

type Notice = { kind: "info" | "error"; text: string }
type Pending = "load" | "save" | "fromLive" | "duplicate" | "activate" | "recover" | null
/**
 * A rejected write, or a server-side change that arrived under unsaved edits
 * (prepared notes saved after a lost answer). The draft is kept; the user
 * picks the recovery explicitly.
 */
type Conflict = { kind: "save" | "duplicate" | "prepared"; detail: string }
/** A selection that would drop unsaved work; the user confirms first. */
type Guard = { kind: "open"; id: string; name: string } | { kind: "new" }
/** Everything the confirmation shows, frozen when the dialog opened. */
type Activation = {
  showId: string
  showRevision: number
  name: string
  count: number
  firstTitle: string
  firstDuration: number
  totalSeconds: number
  liveRevision: number
  liveCount: number
  error: string | null
}

const CHANGED_ELSEWHERE = "This show was changed elsewhere since you opened it."

function describeError(error: unknown, what: string): string {
  if (error instanceof ApiError) return `${what} rejected (${error.status}): ${error.detail}`
  return `${what} failed: the RUNDOWN API did not respond.`
}

export default function ShowsView({ hidden, live, onActivated, onActivationPending, openRequest = null }: Props) {
  const [shows, setShows] = useState<SavedShowSummary[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [draft, setDraftState] = useState<ShowDraft | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [guard, setGuard] = useState<Guard | null>(null)
  const [activation, setActivation] = useState<Activation | null>(null)
  const [fromLiveOpen, setFromLiveOpen] = useState(false)
  const [fromLiveName, setFromLiveName] = useState("")
  const [duplicateOpen, setDuplicateOpen] = useState(false)
  const [duplicateName, setDuplicateName] = useState("")
  const [reuseOpen, setReuseOpen] = useState(false)
  const [inboxOpen, setInboxOpen] = useState(false)
  /** Mirrors selectionSeq in render so the inbox picker can tell a delayed pick from a newer selection. */
  const [selectionKey, setSelectionKey] = useState(0)
  const [reuseSourceId, setReuseSourceId] = useState("")
  const [reuseSource, setReuseSource] = useState<SavedShow | null>(null)
  const [reuseLoading, setReuseLoading] = useState(false)
  const [addText, setAddText] = useState("")
  const [addDuration, setAddDuration] = useState(DEFAULT_DURATION)
  /** Whole-show preparation state, kept per show id for the lifetime of this view (see showPrepStore.ts). */
  const prepStore = useShowPreparationStore()
  /** A preparation generate/save is in flight: show edits and switching wait so the answer lands on the show it was for. */
  const [prepBusy, setPrepBusy] = useState(false)

  // Refs mirror state synchronously so async results compare against the
  // latest value, not the render they were started from.
  const draftRef = useRef<ShowDraft | null>(null)
  /** Bumped on every selection change; a load/save result for an older token is dropped. */
  const selectionSeq = useRef(0)
  function bumpSelection(): number {
    selectionSeq.current += 1
    setSelectionKey(selectionSeq.current)
    return selectionSeq.current
  }
  /** Bumped on every list refresh; an older list response never replaces a newer one. */
  const listSeq = useRef(0)
  const reuseSeq = useRef(0)
  /** Bumped per request; only the request that took the lock releases it. */
  const opSeq = useRef(0)
  /** Latest live info, for checks made when a request is confirmed rather than when it was rendered. */
  const liveRef = useRef(live)
  useEffect(() => {
    liveRef.current = live
  }, [live])
  const cancelRef = useRef<HTMLButtonElement>(null)
  const nameId = useId()
  const dialogTitleId = useId()
  const dialogBodyId = useId()
  const activateHintId = useId()

  const setDraft = useCallback((next: ShowDraft | null | ((current: ShowDraft | null) => ShowDraft | null)) => {
    const value = typeof next === "function" ? next(draftRef.current) : next
    draftRef.current = value
    setDraftState(value)
  }, [])

  function begin(kind: Exclude<Pending, null>): number {
    const op = ++opSeq.current
    setPending(kind)
    return op
  }

  function end(op: number) {
    if (op === opSeq.current) setPending(null)
  }

  // ---- List ------------------------------------------------------------------
  const refreshList = useCallback(() => {
    const token = ++listSeq.current
    listShows().then(
      (next) => {
        if (token !== listSeq.current) return
        setShows(next)
        setListError(null)
      },
      (error: unknown) => {
        if (token !== listSeq.current) return
        setListError(describeError(error, "Loading saved shows"))
      },
    )
  }, [])

  // Refresh the library whenever the view is shown; the editor draft is untouched.
  useEffect(() => {
    if (hidden) return
    refreshList()
  }, [hidden, refreshList])

  // ---- Selection ------------------------------------------------------------
  const locked = pending !== null || prepBusy
  const dirty = draft !== null && isShowDirty(draft)
  const unsaved = hasUnsavedWork(draft)

  async function loadShow(id: string) {
    const token = bumpSelection()
    const op = begin("load")
    setNotice(null)
    setConflict(null)
    setReuseOpen(false)
    setInboxOpen(false)
    setDuplicateOpen(false)
    try {
      const show = await getShow(id)
      if (token !== selectionSeq.current) return
      setDraft(draftFromShow(show))
    } catch (error) {
      if (token !== selectionSeq.current) return
      setNotice({ kind: "error", text: describeError(error, "Opening the show") })
      if (error instanceof ApiError && error.status === 404) refreshList()
    } finally {
      end(op)
    }
  }

  function openShow(summary: SavedShowSummary) {
    if (locked) return
    if (draft?.id === summary.id && !dirty) return
    if (unsaved) {
      setGuard({ kind: "open", id: summary.id, name: summary.name })
      return
    }
    void loadShow(summary.id)
  }

  function startNew() {
    if (locked) return
    if (unsaved) {
      setGuard({ kind: "new" })
      return
    }
    bumpSelection()
    setDraft(newShowDraft())
    setNotice(null)
    setConflict(null)
    setReuseOpen(false)
    setInboxOpen(false)
    setDuplicateOpen(false)
  }

  /** The latest external-open handler, read by the effect below so it never runs with a stale closure. */
  const openRequestRef = useRef<(request: OpenShowRequest) => void>(() => {})
  useEffect(() => {
    openRequestRef.current = (request) => {
      refreshList()
      if (pending !== null) {
        setNotice({ kind: "error", text: `"${request.name}" is saved and listed in the library. Open it once the current request has finished.` })
        return
      }
      if (hasUnsavedWork(draftRef.current)) {
        setGuard({ kind: "open", id: request.id, name: request.name })
        return
      }
      void loadShow(request.id)
    }
  })
  const handledOpenSeq = useRef(0)
  useEffect(() => {
    if (!openRequest || openRequest.seq === handledOpenSeq.current) return
    handledOpenSeq.current = openRequest.seq
    openRequestRef.current(openRequest)
  }, [openRequest])

  function confirmGuard() {
    const next = guard
    setGuard(null)
    if (!next) return
    // Drop the unsaved work explicitly, then continue with the selection.
    bumpSelection()
    setNotice(null)
    setConflict(null)
    setReuseOpen(false)
    setInboxOpen(false)
    setDuplicateOpen(false)
    if (next.kind === "open") {
      setDraft(null)
      void loadShow(next.id)
    } else {
      setDraft(newShowDraft())
    }
  }

  // ---- Editing --------------------------------------------------------------
  const edit = useCallback(
    (update: (current: ShowDraft) => ShowDraft) => {
      if (pending !== null || prepBusy) return
      setDraft((current) => (current ? update(current) : current))
      setNotice(null)
    },
    [pending, prepBusy, setDraft],
  )

  function changeTopic(key: string, patch: Partial<Pick<DraftTopic, "text" | "duration" | "notes">>) {
    edit((current) => ({ ...current, topics: current.topics.map((topic) => (topic.key === key ? { ...topic, ...patch } : topic)) }))
  }

  function move(key: string, direction: -1 | 1) {
    edit((current) => ({ ...current, topics: moveTopic(current.topics, key, direction) }))
    window.requestAnimationFrame(() => {
      const button = document.getElementById(`move-${direction < 0 ? "up" : "down"}-${key}`)
      if (button instanceof HTMLButtonElement && !button.disabled) button.focus()
      else document.getElementById(`move-${direction < 0 ? "down" : "up"}-${key}`)?.focus()
    })
  }

  function remove(key: string) {
    edit((current) => ({ ...current, topics: current.topics.filter((topic) => topic.key !== key) }))
  }

  function addRow(event: FormEvent) {
    event.preventDefault()
    if (!draft || locked || !validTitle(addText) || !validDuration(addDuration) || draft.topics.length >= MAX_TOPICS) return
    edit((current) => ({ ...current, topics: [...current.topics, copiedTopic({ text: addText.trim(), duration: addDuration, notes: "" })] }))
    setAddText("")
  }

  function reuseTopic(topic: { text: string; duration: number; notes: string }) {
    if (!draft || locked || draft.topics.length >= MAX_TOPICS) return
    edit((current) => ({ ...current, topics: [...current.topics, copiedTopic(topic)] }))
    setNotice({ kind: "info", text: `"${topic.text}" copied into this draft with its notes. Save show to keep it.` })
  }

  /** Why nothing can be copied into this draft right now, or null. */
  const inboxBlock: string | null = !draft
    ? "Open a saved show or start a new one first."
    : locked
      ? "Please wait for the current request to finish."
      : conflict !== null
        ? "Resolve the conflict above first."
        : draft.topics.length >= MAX_TOPICS
          ? `This show is full (${MAX_TOPICS} topics).`
          : null

  /** An inbox idea confirmed active by the picker: append its server projection to the draft (saved only by Save show). */
  function addFromInbox(topic: InboxTopic): string | null {
    const current = draftRef.current
    if (!current) return "no show is open."
    if (pending !== null) return "please wait for the current request to finish."
    if (conflict !== null) return "resolve the conflict above first."
    if (current.topics.length >= MAX_TOPICS) return `this show is full (${MAX_TOPICS} topics).`
    edit((row) => ({ ...row, topics: [...row.topics, copiedTopic(topic)] }))
    setNotice({ kind: "info", text: `"${topic.text}" added to the end from the inbox as an independent copy. Save show to keep it.` })
    return null
  }

  function discardEdits() {
    if (!draft || locked) return
    bumpSelection()
    if (draft.id === null) {
      setDraft(null)
    } else {
      setDraft({ ...draft, name: draft.baseName, topics: draft.baseTopics.map((topic) => ({ key: topic.id, id: topic.id, text: topic.text, duration: topic.duration, notes: topic.notes })) })
    }
    setConflict(null)
    setNotice({ kind: "info", text: "Your edits were discarded. Showing the saved version." })
  }

  // ---- Save -------------------------------------------------------------------
  const problem = draft ? showDraftProblem(draft) : null

  async function save() {
    const target = draftRef.current
    if (!target || locked || problem !== null || !dirty) return
    const token = selectionSeq.current
    const op = begin("save")
    setNotice(null)
    try {
      const saved =
        target.id === null
          ? await createShow(target.name.trim(), toShowWire(target.topics))
          : await updateShow(target.id, target.baseRevision, target.name.trim(), toShowWire(target.topics))
      // Editing is locked while saving, so the draft is what we sent unless the
      // selection moved on; a stale result must never replace a newer draft.
      if (token === selectionSeq.current && draftRef.current === target) {
        setDraft(draftFromShow(saved))
        setConflict(null)
        setNotice({ kind: "info", text: `Saved "${saved.name}" · ${topicCount(saved.topics.length)}. Not live: activate it when you want it on air.` })
      }
      refreshList()
    } catch (error) {
      if (token !== selectionSeq.current) return
      if (error instanceof ApiError && error.status === 409) setConflict({ kind: "save", detail: error.detail })
      else setNotice({ kind: "error", text: describeError(error, "Save") })
    } finally {
      end(op)
    }
  }

  /** Conflict recovery, always explicit: reload the saved version (dropping edits) or merge onto it. */
  async function recover(mode: "reload" | "merge") {
    const current = draftRef.current
    if (!current || current.id === null || locked) return
    const token = selectionSeq.current
    const op = begin("recover")
    setNotice(null)
    try {
      const latest = await getShow(current.id)
      if (token !== selectionSeq.current || draftRef.current !== current) return
      setConflict(null)
      if (mode === "reload") {
        setDraft(draftFromShow(latest))
        setNotice({ kind: "info", text: "Reloaded the saved version. Your edits were discarded." })
      } else {
        const merged = mergeShowDraft(current, latest)
        setDraft(merged)
        setNotice({
          kind: "info",
          text: isShowDirty(merged) ? "Merged the other changes into your draft. Save show when ready." : "Nothing left to save: the saved version already has your changes.",
        })
      }
      refreshList()
    } catch (error) {
      if (token !== selectionSeq.current) return
      setNotice({ kind: "error", text: describeError(error, "Loading the saved version") })
    } finally {
      end(op)
    }
  }

  // ---- Save the published live rundown --------------------------------------
  async function saveFromLive(event: FormEvent) {
    event.preventDefault()
    const liveState = live.state
    if (!liveState || locked || !validName(fromLiveName)) return
    const token = selectionSeq.current
    const op = begin("fromLive")
    setNotice(null)
    try {
      const saved = await createShowFromLive(fromLiveName.trim(), liveState.revision)
      setFromLiveOpen(false)
      setFromLiveName("")
      refreshList()
      if (token === selectionSeq.current && !hasUnsavedWork(draftRef.current)) {
        bumpSelection()
        setDraft(draftFromShow(saved))
        setNotice({ kind: "info", text: `Saved the live rundown as "${saved.name}" · ${topicCount(saved.topics.length)}.` })
      } else if (token === selectionSeq.current) {
        setNotice({ kind: "info", text: `Saved the live rundown as "${saved.name}". It is in the list; your open draft was kept.` })
      }
    } catch (error) {
      if (token !== selectionSeq.current) return
      if (error instanceof ApiError && error.status === 409) {
        setNotice({ kind: "error", text: "Not saved: the live rundown changed just now. Try again to save the current version." })
      } else {
        setNotice({ kind: "error", text: describeError(error, "Saving the live rundown") })
      }
    } finally {
      end(op)
    }
  }

  // ---- Duplicate ----------------------------------------------------------------
  async function duplicate(event: FormEvent) {
    event.preventDefault()
    const source = draftRef.current
    if (!source || source.id === null || dirty || locked || !validName(duplicateName)) return
    const token = selectionSeq.current
    const op = begin("duplicate")
    setNotice(null)
    try {
      const copy = await duplicateApi(source.id, source.baseRevision, duplicateName.trim())
      setDuplicateOpen(false)
      refreshList()
      if (token === selectionSeq.current && draftRef.current === source) {
        bumpSelection()
        setDraft(draftFromShow(copy))
        setNotice({ kind: "info", text: `Duplicated as "${copy.name}". "${source.baseName}" is unchanged; you are now editing the copy.` })
      }
    } catch (error) {
      if (token !== selectionSeq.current) return
      if (error instanceof ApiError && error.status === 409) setConflict({ kind: "duplicate", detail: error.detail })
      else setNotice({ kind: "error", text: describeError(error, "Duplicate") })
    } finally {
      end(op)
    }
  }

  // ---- Reuse a topic from another show ----------------------------------------
  async function chooseSource(id: string) {
    setReuseSourceId(id)
    setReuseSource(null)
    const token = ++reuseSeq.current
    if (!id) {
      setReuseLoading(false)
      return
    }
    setReuseLoading(true)
    try {
      const source = await getShow(id)
      if (token !== reuseSeq.current) return
      setReuseSource(source)
    } catch (error) {
      if (token !== reuseSeq.current) return
      setNotice({ kind: "error", text: describeError(error, "Loading the source show") })
    } finally {
      if (token === reuseSeq.current) setReuseLoading(false)
    }
  }

  // ---- Activate ------------------------------------------------------------------
  const activateBlock: string | null = !draft
    ? "Open a saved show to activate it."
    : draft.id === null
      ? "Save the show first; only a saved version can go live."
      : dirty
        ? "Save your changes first; activation uses the saved version."
        : draft.topics.length === 0
          ? "Add at least one topic before activating."
          : locked
            ? "Please wait for the current request to finish."
            : conflict !== null
              ? "Resolve the conflict above first."
              : live.state === null || live.apiDown
                ? "The live rundown is not reachable right now."
                : live.dirty
                  ? "The live rundown has unsaved edits. Publish or discard them on Tonight's Show first."
                  : live.busy
                    ? "The live rundown is busy. Try again in a moment."
                    : null

  function openActivation() {
    if (!draft || draft.id === null || activateBlock !== null || live.state === null) return
    setActivation({
      showId: draft.id,
      showRevision: draft.baseRevision,
      name: draft.baseName,
      count: draft.topics.length,
      firstTitle: draft.topics[0]?.text ?? "",
      firstDuration: draft.topics[0]?.duration ?? 0,
      totalSeconds: totalSeconds(draft.topics),
      liveRevision: live.state.revision,
      liveCount: live.state.topics.length,
      error: null,
    })
  }

  useEffect(() => {
    if (activation) cancelRef.current?.focus()
  }, [activation])

  /**
   * Why the frozen dialog can no longer be confirmed, or null. Re-checked at
   * confirm time against the latest state, because the dialog can outlive
   * edits made on the other view (unsaved live edits never bump a revision).
   */
  function staleDialogReason(frozen: Activation): string | null {
    const current = draftRef.current
    const now = liveRef.current
    if (!current || current.id !== frozen.showId || current.baseRevision !== frozen.showRevision || isShowDirty(current)) {
      return "Not activated: the saved show changed after this dialog opened. Close it and open Activate again."
    }
    if (now.state === null || now.apiDown) return "Not activated: the live rundown is not reachable right now. Nothing changed."
    if (now.state.revision !== frozen.liveRevision) return "Not activated: the live rundown changed after this dialog opened. Nothing changed; close and try again if you still want it live."
    if (now.dirty) return "Not activated: Tonight's Show has unsaved edits. Publish or discard them first. Nothing changed."
    if (now.busy) return "Not activated: the live rundown is busy. Nothing changed; try again in a moment."
    return null
  }

  async function confirmActivation() {
    const frozen = activation
    if (!frozen || locked) return
    const stale = staleDialogReason(frozen)
    if (stale !== null) {
      setActivation((current) => (current ? { ...current, error: stale } : current))
      return
    }
    const op = begin("activate")
    onActivationPending(true)
    try {
      // Revisions come from the dialog as it was opened, never re-read: a
      // change since then is a 409 the user must look at, not a silent retry.
      const state = await activateApi(frozen.showId, frozen.showRevision, frozen.liveRevision)
      setActivation(null)
      onActivated(state, { name: frozen.name, count: frozen.count })
    } catch (error) {
      const text =
        error instanceof ApiError && error.status === 409
          ? `Not activated: ${error.detail} Nothing changed. Close this dialog, reload the show, and try again if you still want it live.`
          : describeError(error, "Activation")
      setActivation((current) => (current ? { ...current, error: text } : current))
    } finally {
      onActivationPending(false)
      end(op)
    }
  }

  // ---- Whole-show preparation -------------------------------------------------
  /**
   * The server appended reviewed notes and answered with the current
   * authoritative saved show. Adopt it only for the show that is open and
   * clean; a dirty draft keeps its edits (the next save meets the usual
   * conflict recovery), and a different open show is left alone.
   */
  function adoptPrepared(show: SavedShow) {
    const current = draftRef.current
    refreshList()
    if (!current || current.id !== show.id) return
    if (isShowDirty(current)) {
      // Never replace typed edits silently: the usual merge/reload recovery decides.
      setNotice(null)
      setConflict({ kind: "prepared", detail: `Prepared notes were saved into "${show.name}" (revision ${show.revision}).` })
      return
    }
    setDraft(draftFromShow(show))
    setConflict(null)
    setNotice({ kind: "info", text: `Saved prepared notes into "${show.name}" · ${topicCount(show.topics.length)}. Not live: activate it when you want it on air.` })
  }

  async function reloadAfterActivationFailure() {
    const current = draftRef.current
    setActivation(null)
    if (current && current.id !== null) await loadShow(current.id)
  }

  // ---- Render ------------------------------------------------------------------
  const seconds = draft ? totalSeconds(draft.topics) : 0
  // A pristine new show is not "invalid" yet; complain only once the user has typed something.
  const shownProblem = draft && (draft.id !== null || draft.name.length > 0 || draft.topics.length > 0) ? problem : null
  const statusText = notice
    ? notice.text
    : shownProblem
      ? shownProblem
      : pending === "save"
        ? "Saving the show…"
        : pending === "load"
          ? "Opening…"
          : draft === null
            ? "Open a show from the list, start a new one, or save the live rundown."
            : draft.id === null
              ? "New show, not saved yet."
              : dirty
                ? "Unsaved changes."
                : "Saved. Nothing is live until you activate it."

  return (
    <main className="main shows" id="shows" hidden={hidden} aria-labelledby="shows-title">
      <header className="main-head">
        <div className="main-eyebrow">
          <span className="head-lbl">Prepared separately from the live clock · nothing here goes on air until you activate it</span>
        </div>
        <h1 id="shows-title" className="main-title">
          Saved Shows
        </h1>
      </header>

      <div className="shows-layout">
        <section className="shows-list" aria-labelledby="shows-list-title">
          <div className="shows-list-head">
            <h2 id="shows-list-title">Library</h2>
            <div className="shows-list-actions">
              <button type="button" className="btn" disabled={locked} onClick={startNew}>
                New show
              </button>
              <button
                type="button"
                className="btn"
                disabled={locked || live.state === null || live.apiDown}
                aria-expanded={fromLiveOpen}
                onClick={() => {
                  setFromLiveOpen((open) => !open)
                  setNotice(null)
                }}
              >
                Save live rundown as show
              </button>
            </div>
          </div>

          {fromLiveOpen ? (
            <form className="inline-form" aria-label="Save the live rundown as a show" onSubmit={saveFromLive}>
              <p>
                Copies the published live rundown ({topicCount(live.state?.topics.length ?? 0)}) with its notes into a new saved show. The live clock keeps running; nothing on air changes.
                {live.dirty ? " Your unsaved live edits are not included; publish them first if you want them saved." : ""}
              </p>
              <label className="field grow">
                <span>Show name</span>
                <input aria-label="Name for the saved live rundown" maxLength={MAX_NAME} placeholder="e.g. Friday night template" value={fromLiveName} onChange={(event) => setFromLiveName(event.target.value)} />
              </label>
              <div className="inline-form-actions">
                <button type="submit" className="btn primary" disabled={locked || !validName(fromLiveName)}>
                  {pending === "fromLive" ? "Saving…" : "Save live rundown"}
                </button>
                <button type="button" className="btn" disabled={locked} onClick={() => setFromLiveOpen(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          {listError ? (
            <div className="banner error" role="alert">
              <p>{listError}</p>
              <div className="banner-actions">
                <button type="button" className="btn" onClick={() => refreshList()}>
                  Retry
                </button>
              </div>
            </div>
          ) : null}

          {shows === null ? (
            <div className="empty">Loading saved shows…</div>
          ) : shows.length === 0 ? (
            <div className="empty">No saved shows yet. Start a new one or save the live rundown.</div>
          ) : (
            <ul className="show-cards" aria-label="Saved shows">
              {shows.map((summary) => {
                const selected = draft?.id === summary.id
                return (
                  <li key={summary.id}>
                    <button
                      type="button"
                      className={`show-card${selected ? " on" : ""}`}
                      aria-current={selected ? "true" : undefined}
                      aria-label={`Open ${summary.name}`}
                      disabled={locked}
                      onClick={() => openShow(summary)}
                    >
                      <span className="show-card-name">{summary.name}</span>
                      <span className="show-card-meta">
                        {topicCount(summary.topic_count)} · {formatMinutes(summary.total_seconds)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="show-editor" aria-labelledby="show-editor-title" aria-busy={locked || undefined}>
          <h2 id="show-editor-title" className="visually-hidden">
            Show editor
          </h2>
          {draft === null ? (
            <div className="empty">{pending === "load" ? "Opening…" : "Nothing open. Pick a show on the left, start a new one, or save the live rundown as a show."}</div>
          ) : (
            <>
              <div className="show-editor-head">
                <label className="field grow" htmlFor={nameId}>
                  <span>Show name</span>
                  <input
                    id={nameId}
                    aria-label="Show name"
                    aria-invalid={validName(draft.name) ? undefined : true}
                    className="show-name"
                    disabled={locked}
                    maxLength={MAX_NAME}
                    placeholder="Name this show"
                    value={draft.name}
                    onChange={(event) => edit((current) => ({ ...current, name: event.target.value }))}
                  />
                </label>
                <span className="head-lbl show-editor-meta">
                  {draft.id === null ? "Not saved yet" : dirty ? "Unsaved changes" : "Saved"} · {topicCount(draft.topics.length)} · {formatMinutes(seconds)}
                </span>
              </div>

              {conflict ? (
                <div className="banner error" role="alert">
                  <p>
                    <strong>{conflict.kind === "save" ? "Not saved." : conflict.kind === "duplicate" ? "Not duplicated." : "Saved on the server."}</strong>{" "}
                    {conflict.kind === "prepared" ? `${conflict.detail} Your unsaved edits here are kept. Merging keeps what you edited and brings in the prepared notes; reloading discards your edits.` : `${CHANGED_ELSEWHERE} ${conflict.kind === "save" ? "Your edits are kept here. Merging keeps what you edited and brings in what changed there; reloading discards your edits." : "Reload it to see the latest version, then try again."}`}
                  </p>
                  <div className="banner-actions">
                    {conflict.kind !== "duplicate" ? (
                      <button type="button" className="btn primary" disabled={locked} onClick={() => void recover("merge")}>
                        Merge with the saved version
                      </button>
                    ) : null}
                    <button type="button" className="btn" disabled={locked} onClick={() => void recover("reload")}>
                      {conflict.kind !== "duplicate" ? "Reload and discard my edits" : "Reload show"}
                    </button>
                  </div>
                </div>
              ) : null}

              <form className="add-row" aria-label="Add a topic to this show" onSubmit={addRow}>
                <label className="field grow">
                  <span>Title</span>
                  <input aria-label="New saved topic title" maxLength={MAX_TITLE} disabled={locked} placeholder="Segment title" value={addText} onChange={(event) => setAddText(event.target.value)} />
                </label>
                <label className="field seconds">
                  <span>Seconds</span>
                  <input
                    aria-label="New saved topic duration"
                    disabled={locked}
                    inputMode="numeric"
                    min={MIN_DURATION}
                    max={MAX_DURATION}
                    step={1}
                    type="number"
                    value={Number.isNaN(addDuration) ? "" : addDuration}
                    onChange={(event) => setAddDuration(event.target.valueAsNumber)}
                  />
                </label>
                <button type="submit" className="btn" disabled={locked || !validTitle(addText) || !validDuration(addDuration) || draft.topics.length >= MAX_TOPICS}>
                  Add topic
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={locked || draft.topics.length >= MAX_TOPICS}
                  aria-expanded={reuseOpen}
                  onClick={() => setReuseOpen((open) => !open)}
                >
                  Reuse a topic…
                </button>
                <button type="button" className="btn" disabled={locked || draft.topics.length >= MAX_TOPICS} aria-expanded={inboxOpen} onClick={() => setInboxOpen((open) => !open)}>
                  {inboxOpen ? "Hide inbox" : "Add from inbox…"}
                </button>
              </form>

              {inboxOpen && !hidden ? (
                <InboxPicker
                  key={`show:${draft.id ?? "new"}:${selectionKey}`}
                  targetKey={`show:${draft.id ?? "new"}:${selectionKey}`}
                  blockReason={inboxBlock}
                  labels={{ end: "Add to show" }}
                  targetName="this show"
                  onPick={addFromInbox}
                  onClose={() => setInboxOpen(false)}
                  onDropped={(text) => setNotice({ kind: "error", text: `Not added: you moved on while "${text}" was loading from the inbox. Pick it again if you still want it.` })}
                />
              ) : null}

              {reuseOpen ? (
                <section className="reuse" aria-labelledby="reuse-title">
                  <h3 id="reuse-title">Reuse a topic from another show</h3>
                  <p>Copies the title, length and notes into this draft as a new row. The source show is not changed.</p>
                  <label className="field">
                    <span>Source show</span>
                    <select aria-label="Source show" disabled={locked} value={reuseSourceId} onChange={(event) => void chooseSource(event.target.value)}>
                      <option value="">Choose a show…</option>
                      {(shows ?? [])
                        .filter((summary) => summary.id !== draft.id)
                        .map((summary) => (
                          <option key={summary.id} value={summary.id}>
                            {summary.name} ({topicCount(summary.topic_count)})
                          </option>
                        ))}
                    </select>
                  </label>
                  {reuseLoading ? (
                    <p className="reuse-hint">Loading topics…</p>
                  ) : reuseSource ? (
                    reuseSource.topics.length === 0 ? (
                      <p className="reuse-hint">That show has no topics.</p>
                    ) : (
                      <ul className="reuse-list" aria-label={`Topics in ${reuseSource.name}`}>
                        {reuseSource.topics.map((topic) => (
                          <li key={topic.id} className="reuse-row">
                            <span className="reuse-text">
                              <strong>{topic.text}</strong> · {formatClock(topic.duration)}
                              {topic.notes.length > 0 ? <span className="reuse-notes"> · has notes</span> : null}
                            </span>
                            <button
                              type="button"
                              className="btn"
                              disabled={locked || draft.topics.length >= MAX_TOPICS}
                              aria-label={`Copy "${topic.text}" from ${reuseSource.name} into this show`}
                              onClick={() => reuseTopic(topic)}
                            >
                              Copy
                            </button>
                          </li>
                        ))}
                      </ul>
                    )
                  ) : null}
                </section>
              ) : null}

              {draft.topics.length === 0 ? (
                <div className="empty">No topics yet. Add one above or reuse one from another show. An empty show can be saved but not activated.</div>
              ) : (
                <ol className={`trows${locked ? " locked" : ""}`} aria-label="Topics in this show">
                  {draft.topics.map((topic, index) => (
                    <TopicRow
                      key={topic.key}
                      topic={topic}
                      index={index}
                      count={draft.topics.length}
                      locked={locked}
                      labelPrefix="Saved topic"
                      onChange={changeTopic}
                      onMove={move}
                      onRemove={remove}
                    />
                  ))}
                </ol>
              )}

              <ShowPreparation
                store={prepStore}
                showId={draft.id}
                showName={draft.baseName}
                revision={draft.baseRevision}
                topics={draft.baseTopics}
                dirty={dirty}
                locked={pending !== null}
                hidden={hidden}
                onBusy={setPrepBusy}
                onApplied={adoptPrepared}
              />

              {duplicateOpen ? (
                <form className="inline-form" aria-label="Duplicate this show" onSubmit={duplicate}>
                  <p>Makes an independent copy of the saved version with its topics and notes. The original stays as it is.</p>
                  <label className="field grow">
                    <span>Name for the copy</span>
                    <input aria-label="Name for the copy" maxLength={MAX_NAME} value={duplicateName} onChange={(event) => setDuplicateName(event.target.value)} />
                  </label>
                  <div className="inline-form-actions">
                    <button type="submit" className="btn primary" disabled={locked || !validName(duplicateName)}>
                      {pending === "duplicate" ? "Duplicating…" : "Create copy"}
                    </button>
                    <button type="button" className="btn" disabled={locked} onClick={() => setDuplicateOpen(false)}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : null}
            </>
          )}

          <footer className="publish-bar show-bar">
            <p className={`publish-status${notice?.kind === "error" ? " error" : ""}`} aria-live="polite">
              {statusText}
            </p>
            {draft ? (
              <div className="publish-actions show-actions">
                {dirty ? (
                  <button type="button" className="btn" disabled={locked} onClick={discardEdits}>
                    {draft.id === null ? "Discard new show" : "Discard edits"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn"
                  disabled={locked || draft.id === null || dirty}
                  title={draft.id === null || dirty ? "Save the show first, then duplicate the saved version" : "Copy this show under a new name"}
                  onClick={() => {
                    setDuplicateName(`${draft.baseName} copy`)
                    setDuplicateOpen((open) => !open)
                  }}
                >
                  Duplicate
                </button>
                <button type="button" className="btn primary" disabled={locked || !dirty || problem !== null || conflict !== null} onClick={() => void save()}>
                  {pending === "save" ? "Saving…" : "Save show"}
                </button>
                <button type="button" className="btn activate" disabled={activateBlock !== null} aria-describedby={activateHintId} onClick={openActivation}>
                  Activate show…
                </button>
              </div>
            ) : null}
            {draft ? (
              <p id={activateHintId} className="activate-hint">
                {activateBlock ?? "Activate replaces the live rundown with this saved version and cues its first topic, paused."}
              </p>
            ) : null}
          </footer>
        </section>
      </div>

      {guard ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby={`${dialogTitleId}-guard`}>
            <h2 id={`${dialogTitleId}-guard`}>Unsaved changes</h2>
            <p>
              {draft?.id === null ? "Your new show has not been saved." : `"${draft?.name}" has unsaved changes.`}{" "}
              {guard.kind === "open" ? `Opening "${guard.name}" will discard them.` : "Starting a new show will discard them."}
            </p>
            <div className="banner-actions">
              <button type="button" className="btn primary" autoFocus onClick={() => setGuard(null)}>
                Keep editing
              </button>
              <button type="button" className="btn" onClick={confirmGuard}>
                {guard.kind === "open" ? "Discard and open" : "Discard and start new"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {activation ? (
        <div className="modal-backdrop" role="presentation" onKeyDown={(event) => event.key === "Escape" && pending !== "activate" && setActivation(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby={dialogTitleId} aria-describedby={dialogBodyId}>
            <h2 id={dialogTitleId}>Activate "{activation.name}"?</h2>
            <div id={dialogBodyId} className="modal-body">
              <p>
                This replaces the live rundown ({topicCount(activation.liveCount)}) with the saved version of "{activation.name}": {topicCount(activation.count)}, {formatMinutes(activation.totalSeconds)}. The current live list is archived.
              </p>
              <p>
                Topic 1, "{activation.firstTitle}", will be cued at its full {formatClock(activation.firstDuration)} and <strong>paused</strong>. Nothing plays until you press Play on Tonight's Show.
              </p>
              <p>Later edits to the saved show do not change the live rundown, and live edits do not change the saved show.</p>
              {activation.error ? (
                <p className="modal-error" role="alert">
                  {activation.error}
                </p>
              ) : null}
            </div>
            <div className="banner-actions">
              {activation.error ? (
                <>
                  <button type="button" className="btn primary" onClick={() => void reloadAfterActivationFailure()}>
                    Reload show
                  </button>
                  <button ref={cancelRef} type="button" className="btn" onClick={() => setActivation(null)}>
                    Close
                  </button>
                </>
              ) : (
                <>
                  <button ref={cancelRef} type="button" className="btn" disabled={pending === "activate"} onClick={() => setActivation(null)}>
                    Cancel
                  </button>
                  <button type="button" className="btn primary" disabled={pending === "activate"} onClick={() => void confirmActivation()}>
                    {pending === "activate" ? "Activating…" : "Activate and cue paused"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}
