import { useCallback, useEffect, useRef, useState } from "react"
import { ApiError, control as controlApi, getState, putSchedule, type ControlAction, type ShowState } from "./lib/api"
import {
  draftFromState,
  draftProblem,
  fromRemote,
  insertTopic,
  isDirty,
  mergeDraft,
  moveTopic,
  sameTopics,
  toWire,
  MAX_TOPICS,
  type Draft,
  type DraftTopic,
} from "./lib/draft"
import { supersedes } from "./lib/snapshot"
import { useMediaQuery } from "./lib/useMediaQuery"
import Deck from "./components/Deck"
import QuickAdd, { type AddOptions, type AddPlacement, type NewTopic } from "./components/QuickAdd"
import TopicRow from "./components/TopicRow"
import ShowsView from "./components/ShowsView"
import InboxView from "./components/InboxView"
import DiscoverView from "./components/DiscoverView"
import SourcesView from "./components/SourcesView"
import ReviewView from "./components/ReviewView"
import ResearchView from "./components/ResearchView"
import type { OpenShowRequest } from "./components/ShowsView"
import InboxPicker, { type PickPlacement } from "./components/InboxPicker"
import type { InboxTopic } from "./lib/api"

const POLL_MS = 1000
const COMPACT_QUERY = "(max-width: 879px)"
const CHANGED_ELSEWHERE = "The show changed on another screen."

type Notice = { kind: "info" | "error"; text: string }
type Conflict = { detail: string }

function countLabel(count: number): string {
  return `${count} topic${count === 1 ? "" : "s"}`
}

export default function App() {
  const [remote, setRemote] = useState<ShowState | null>(null)
  const [apiStatus, setApiStatus] = useState<"connecting" | "ok" | "down">("connecting")
  const [draft, setDraftState] = useState<Draft | null>(null)
  const [busy, setBusy] = useState<"publish" | "control" | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  // Both views stay mounted; switching only hides one, so live and saved
  // drafts (and anything typed into quick-add) survive navigation.
  // Discover is listed first but the live show stays the starting view: it is
  // what a producer opens the control room for, and every existing screen
  // (and its tests) is reached from it.
  const [view, setView] = useState<"live" | "discover" | "shows" | "inbox" | "research" | "sources" | "review">("live")
  /** A show the research composer just saved and the user asked to open; Saved Shows loads it (guarding its own unsaved draft). */
  const [openShowRequest, setOpenShowRequest] = useState<OpenShowRequest | null>(null)
  const [inboxOpen, setInboxOpen] = useState(false)
  /** Bumped when a feed import finishes so the inbox list reloads even while it is the visible view. */
  const [inboxRefreshKey, setInboxRefreshKey] = useState(0)
  /** Bumped whenever the live draft is replaced wholesale (discard, publish, activation, merge) so a pending inbox copy cannot land on it. */
  const [draftEpoch, setDraftEpoch] = useState(0)
  /** A saved-show activation is in flight: hold live publish/transport so nothing races it. */
  const [activating, setActivating] = useState(false)
  const compact = useMediaQuery(COMPACT_QUERY)

  // Refs mirror state synchronously so back-to-back adoptions and edits inside
  // one tick compare against the latest value, not a stale render.
  const remoteRef = useRef<ShowState | null>(null)
  const draftRef = useRef<Draft | null>(null)

  const setDraft = useCallback((next: Draft | null | ((current: Draft | null) => Draft | null)) => {
    const value = typeof next === "function" ? next(draftRef.current) : next
    draftRef.current = value
    setDraftState(value)
  }, [])

  /**
   * Adopt a server snapshot unless it is older than what we already show.
   * Returns false when the snapshot was ignored (delayed poll after a mutation).
   */
  const adopt = useCallback((state: ShowState): boolean => {
    if (!supersedes(remoteRef.current, state)) return false
    remoteRef.current = state
    setRemote(state)
    return true
  }, [])

  // ---- Polling: refreshes server state only; never touches the draft. -----
  useEffect(() => {
    let cancelled = false
    let inflight = false
    const controller = new AbortController()
    async function poll() {
      if (inflight || cancelled) return
      inflight = true
      try {
        const state = await getState(controller.signal)
        if (!cancelled) {
          adopt(state)
          setApiStatus("ok")
        }
      } catch {
        if (!cancelled) setApiStatus("down")
      } finally {
        inflight = false
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(timer)
    }
  }, [adopt])

  // ---- Draft editing ------------------------------------------------------
  const locked = busy === "publish" || activating
  const anyBusy = busy !== null || activating

  /** Current draft, or a fresh one taken from the server state; null before the first load. */
  function baseDraft(): Draft | null {
    return draftRef.current ?? (remoteRef.current ? draftFromState(remoteRef.current) : null)
  }

  const edit = useCallback(
    (update: (topics: DraftTopic[]) => DraftTopic[]) => {
      if (busy === "publish") return
      setDraft((current) => {
        const base = current ?? (remoteRef.current ? draftFromState(remoteRef.current) : null)
        if (!base) return current
        return { ...base, topics: update(base.topics) }
      })
      setNotice(null)
    },
    [busy, setDraft],
  )

  const topics: DraftTopic[] = draft ? draft.topics : remote ? fromRemote(remote.topics) : []
  const currentId = remote?.current_topic_id ?? null
  const dirty = draft !== null && isDirty(draft)
  const problem = draft ? draftProblem(draft.topics) : null
  const remoteMoved = draft !== null && remote !== null && remote.revision !== draft.baseRevision
  const totalSeconds = topics.reduce((sum, topic) => sum + (Number.isFinite(topic.duration) ? topic.duration : 0), 0)
  const playing = remote !== null && !remote.paused && remote.topics.length > 0
  const canPublishNow = remote !== null && busy === null && !activating && conflict === null && problem === null

  /** Why nothing can be added to the live draft right now, or null. */
  const addBlock: string | null =
    remote === null
      ? "Waiting for the show to load…"
      : locked
        ? "Publishing… adding is paused for a moment."
        : conflict !== null
          ? "Resolve the publish conflict below first."
          : topics.length >= MAX_TOPICS
            ? `Schedule is full (${MAX_TOPICS} topics).`
            : null

  /** Put a new row into the draft (never published here). Returns the failure reason, or null with the new draft applied. */
  function insertIntoDraft(topic: NewTopic, where: AddPlacement): { draft: Draft; placed: string } | string {
    if (locked) return "publishing is in progress."
    if (where === "next" && (remoteRef.current?.current_topic_id ?? null) === null) return "nothing is playing to insert after."
    const base = baseDraft()
    if (!base) return "the show has not loaded yet."
    if (base.topics.length >= MAX_TOPICS) return `the schedule is full (${MAX_TOPICS} topics).`
    const afterId = remoteRef.current?.current_topic_id ?? null
    const next: Draft = { ...base, topics: insertTopic(base.topics, topic, where === "end" ? "end" : { afterId }) }
    setDraft(next)
    const placed = where === "next" ? `"${topic.text}" inserted after the current segment` : `"${topic.text}" added to the end`
    return { draft: next, placed }
  }

  function addTopic(topic: NewTopic, where: AddPlacement, options: AddOptions) {
    const result = insertIntoDraft(topic, where)
    if (typeof result === "string") return
    if (options.publishNow && canPublishNow && draftProblem(result.draft.topics) === null) {
      void publishDraft(result.draft, `${result.placed} and published.`)
      return
    }
    setNotice({ kind: "info", text: `${result.placed}. Publish to make it live.` })
  }

  /** An inbox idea confirmed active by the picker: copy its server projection into the draft, never publish. */
  function addFromInbox(topic: InboxTopic, _source: unknown, where: PickPlacement): string | null {
    if (conflict !== null) return "resolve the publish conflict first."
    const result = insertIntoDraft({ text: topic.text, duration: topic.duration, notes: topic.notes }, where)
    if (typeof result === "string") return result
    setNotice({ kind: "info", text: `${result.placed} from the inbox as an independent copy. Publish to make it live.` })
    return null
  }

  function changeTopic(key: string, patch: Partial<Pick<DraftTopic, "text" | "duration" | "notes">>) {
    edit((current) => current.map((topic) => (topic.key === key ? { ...topic, ...patch } : topic)))
  }

  function move(key: string, direction: -1 | 1) {
    edit((current) => moveTopic(current, key, direction))
    // Keep keyboard focus on the button that was pressed after the row moves.
    window.requestAnimationFrame(() => {
      const button = document.getElementById(`move-${direction < 0 ? "up" : "down"}-${key}`)
      if (button instanceof HTMLButtonElement && !button.disabled) button.focus()
      else document.getElementById(`move-${direction < 0 ? "down" : "up"}-${key}`)?.focus()
    })
  }

  function remove(key: string) {
    const index = topics.findIndex((topic) => topic.key === key)
    edit((current) => current.filter((topic) => topic.key !== key))
    window.requestAnimationFrame(() => {
      const rows = document.querySelectorAll<HTMLElement>("li.trow")
      const next = rows[Math.min(index, rows.length - 1)]
      const target = next?.querySelector<HTMLButtonElement>("button.danger:not(:disabled)") ?? next?.querySelector<HTMLInputElement>("input")
      ;(target ?? document.querySelector<HTMLInputElement>('input[aria-label="New topic title"]'))?.focus()
    })
  }

  function discardDraft() {
    setDraft(null)
    setDraftEpoch((epoch) => epoch + 1)
    setConflict(null)
    setNotice({ kind: "info", text: "Your changes were discarded. Showing the published show." })
  }

  // ---- Publish --------------------------------------------------------------
  async function publishDraft(target: Draft, successText?: string) {
    setBusy("publish")
    setNotice(null)
    try {
      const state = await putSchedule(target.baseRevision, toWire(target.topics))
      adopt(state)
      // Editing is locked while the request is pending, so the draft should be
      // exactly what we sent. If anything did slip in, carry it onto the new
      // base instead of dropping it.
      setDraft((current) => (current === null || current === target ? null : mergeDraft(current, state)))
      setDraftEpoch((epoch) => epoch + 1)
      setConflict(null)
      setNotice({ kind: "info", text: successText ?? `Published · ${countLabel(state.topics.length)}.` })
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict({ detail: error.detail })
      } else if (error instanceof ApiError) {
        setNotice({ kind: "error", text: `Publish rejected (${error.status}): ${error.detail}` })
      } else {
        setNotice({ kind: "error", text: "Publish failed: the RUNDOWN API did not respond." })
      }
    } finally {
      setBusy(null)
    }
  }

  function publish() {
    if (!draft || problem) return
    void publishDraft(draft)
  }

  /** Fetch the latest show, merge the draft onto it, and optionally publish the result. */
  async function mergeLatest(thenPublish: boolean) {
    const current = draftRef.current
    if (!current) return
    setBusy("publish")
    setNotice(null)
    let latest: ShowState
    try {
      latest = await getState()
    } catch {
      setBusy(null)
      setNotice({ kind: "error", text: "Could not load the latest show to merge with." })
      return
    }
    adopt(latest)
    const base = remoteRef.current ?? latest
    const merged = mergeDraft(current, base)
    setDraftEpoch((epoch) => epoch + 1)
    setConflict(null)
    if (!isDirty(merged)) {
      setDraft(null)
      setBusy(null)
      setNotice({ kind: "info", text: "Nothing left to publish: the other screen already has these changes." })
      return
    }
    setDraft(merged)
    if (thenPublish) {
      await publishDraft(merged)
    } else {
      setBusy(null)
      setNotice({ kind: "info", text: "Merged the other screen's changes into your draft. Publish when ready." })
    }
  }

  // ---- Transport ------------------------------------------------------------
  async function control(action: ControlAction, topicId?: string) {
    const base = remoteRef.current
    if (!base) return
    setBusy("control")
    setNotice(null)
    try {
      const state = await controlApi(base.revision, action, topicId)
      adopt(state)
      // A transport action is our own known mutation: if the server's topic
      // list is unchanged, re-pin the draft so the next publish is not stale.
      setDraft((current) => (current && sameTopics(state.topics, current.baseTopics) ? { ...current, baseRevision: state.revision, baseTopics: state.topics } : current))
    } catch (error) {
      if (error instanceof ApiError) {
        setNotice({ kind: "error", text: `Transport "${action}" rejected (${error.status}): ${error.detail}` })
      } else {
        setNotice({ kind: "error", text: `Transport "${action}" failed: the RUNDOWN API did not respond.` })
      }
    } finally {
      setBusy(null)
    }
  }

  /** A saved show went live: adopt the returned state and show the deck so Play is one press away. */
  function activated(state: ShowState, show: { name: string; count: number }) {
    // A poll can already have observed another producer's newer transport
    // action while this activation response was still in flight.
    const adopted = adopt(state)
    setDraft(null)
    setDraftEpoch((epoch) => epoch + 1)
    setConflict(null)
    setView("live")
    setNotice({ kind: "info", text: adopted
      ? `"${show.name}" is live · ${countLabel(show.count)}, first topic cued and paused. Press Play when ready.`
      : `"${show.name}" was activated. Showing the latest live state.` })
  }

  /** The research composer asks for its saved show to be opened: switch to Saved Shows and hand over the request. */
  function openSavedShow(show: { id: string; name: string }) {
    setOpenShowRequest((current) => ({ seq: (current?.seq ?? 0) + 1, id: show.id, name: show.name }))
    setView("shows")
  }

  const liveLabel = remote === null ? "Connecting" : remote.topics.length === 0 ? "Empty" : remote.paused ? "Paused" : "Live"
  const statusText = notice
    ? notice.text
    : problem
      ? problem
      : locked
        ? "Publishing…"
        : dirty
          ? remoteMoved
            ? `Unsaved changes. ${CHANGED_ELSEWHERE}`
            : "Unsaved changes."
          : remote === null
            ? "Waiting for the show…"
            : "Everything is published."

  // Target identity for an inbox copy: the live view, the server revision and
  // current segment the copy would be placed against, and the draft epoch.
  const liveTargetKey = `live:${remote?.revision ?? "none"}:${currentId ?? "none"}:${draftEpoch}`

  const deck = <Deck state={remote} busy={anyBusy} variant={compact ? "hero" : "sidebar"} onControl={(action) => void control(action)} />

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-logo" aria-hidden="true">R</span>
          <span className="brand-name">Rundown</span>
        </div>
        <nav aria-label="Sections">
          <button type="button" className={`side-item${view === "discover" ? " on" : ""}`} aria-current={view === "discover" ? "page" : undefined} onClick={() => setView("discover")}>
            <span className="side-icon" aria-hidden="true">◎</span> Discover
          </button>
          <button type="button" className={`side-item${view === "live" ? " on" : ""}`} aria-current={view === "live" ? "page" : undefined} onClick={() => setView("live")}>
            <span className="side-icon" aria-hidden="true">≣</span> Tonight's Show
          </button>
          <button type="button" className={`side-item${view === "shows" ? " on" : ""}`} aria-current={view === "shows" ? "page" : undefined} onClick={() => setView("shows")}>
            <span className="side-icon" aria-hidden="true">▤</span> Saved Shows
          </button>
          <button type="button" className={`side-item${view === "inbox" ? " on" : ""}`} aria-current={view === "inbox" ? "page" : undefined} onClick={() => setView("inbox")}>
            <span className="side-icon" aria-hidden="true">✎</span> Inbox
          </button>
          <button type="button" className={`side-item${view === "research" ? " on" : ""}`} aria-current={view === "research" ? "page" : undefined} onClick={() => setView("research")}>
            <span className="side-icon" aria-hidden="true">⌕</span> Research
          </button>
          <button type="button" className={`side-item${view === "sources" ? " on" : ""}`} aria-current={view === "sources" ? "page" : undefined} onClick={() => setView("sources")}>
            <span className="side-icon" aria-hidden="true">✦</span> Sources
          </button>
          <button type="button" className={`side-item${view === "review" ? " on" : ""}`} aria-current={view === "review" ? "page" : undefined} onClick={() => setView("review")}>
            <span className="side-icon" aria-hidden="true">✓</span> Show review
          </button>
        </nav>
        <div className={`api-pill api-${apiStatus}`} role="status" aria-label="API connection" data-revision={remote?.revision ?? ""}>
          <span className="api-dot" />
          {apiStatus === "ok" ? "Connected" : apiStatus === "down" ? "Offline" : "Connecting…"}
        </div>
        <div className="side-spacer" />
        {compact ? null : <div className="deck-slot-sidebar">{deck}</div>}
      </aside>

      <main className="main" id="schedule" hidden={view !== "live"}>
        <header className="main-head">
          <div className="main-eyebrow">
            <span className={`live-pip ${liveLabel.toLowerCase()}`}>
              <span className="live-dot" />
              {liveLabel}
            </span>
            <span className="head-lbl">
              Tonight's Show · {countLabel(topics.length)} · {Math.ceil(totalSeconds / 60)} min
            </span>
          </div>
          <h1 className="main-title">Tonight's Rundown</h1>
        </header>

        {compact ? <div className="deck-slot-hero">{deck}</div> : null}

        <QuickAdd
          full={topics.length >= MAX_TOPICS}
          hasCurrent={currentId !== null}
          lockedReason={remote === null ? "loading" : locked ? "publishing" : null}
          canPublishNow={canPublishNow}
          otherUnsaved={dirty}
          onAdd={addTopic}
        />

        <div className="live-tools">
          <button type="button" className="btn" aria-expanded={inboxOpen} aria-controls={inboxOpen ? "live-inbox-picker" : undefined} onClick={() => setInboxOpen((open) => !open)}>
            {inboxOpen ? "Hide inbox" : "Add from inbox…"}
          </button>
          <span className="live-tools-hint">Copies a captured idea with its context into your draft. Nothing goes live until you publish.</span>
        </div>
        <div id="live-inbox-picker" className="live-picker-slot">
          {inboxOpen && view === "live" ? (
            <InboxPicker
              key={liveTargetKey}
              targetKey={liveTargetKey}
              blockReason={addBlock}
              hasCurrent={currentId !== null}
              labels={{ end: "Add to end", next: "Insert next" }}
              targetName="tonight's draft"
              onPick={addFromInbox}
              onClose={() => setInboxOpen(false)}
              onDropped={(text) => setNotice({ kind: "error", text: `Not added: the show changed while "${text}" was loading from the inbox. Pick it again if you still want it.` })}
            />
          ) : null}
        </div>

        {conflict ? (
          <div className="banner error" role="alert">
            <p>
              <strong>Not published.</strong> {CHANGED_ELSEWHERE} Your changes are kept here. Merging keeps what you edited and brings in what changed there.
            </p>
            <div className="banner-actions">
              <button type="button" className="btn primary" disabled={anyBusy} onClick={() => void mergeLatest(true)}>
                Merge and publish
              </button>
              <button type="button" className="btn" disabled={anyBusy} onClick={() => void mergeLatest(false)}>
                Merge, don't publish yet
              </button>
              <button type="button" className="btn" disabled={anyBusy} onClick={discardDraft}>
                Discard my changes
              </button>
            </div>
          </div>
        ) : remoteMoved ? (
          <div className="banner warn" role="status">
            <p>{CHANGED_ELSEWHERE} Publishing will ask you to merge; you can also merge now and keep editing.</p>
            <div className="banner-actions">
              <button type="button" className="btn" disabled={anyBusy} onClick={() => void mergeLatest(false)}>
                Merge now
              </button>
            </div>
          </div>
        ) : null}

        {apiStatus === "down" ? (
          <div className="banner error" role="alert">
            <p>The RUNDOWN API is unreachable. Showing the last known state; edits stay local.</p>
          </div>
        ) : null}

        <section className="list" aria-labelledby="list-title">
          <h2 id="list-title" className="visually-hidden">Schedule</h2>
          {remote === null && apiStatus === "connecting" ? (
            <div className="empty">Loading show state…</div>
          ) : topics.length === 0 ? (
            <div className="empty">No topics yet. Add the first segment above.</div>
          ) : (
            <ol className={`trows${locked ? " locked" : ""}`} aria-busy={locked || undefined}>
              {topics.map((topic, index) => (
                <TopicRow
                  key={topic.key}
                  topic={topic}
                  index={index}
                  count={topics.length}
                  isCurrent={topic.id !== null && topic.id === currentId}
                  playing={playing}
                  transportBusy={anyBusy}
                  locked={locked}
                  onChange={changeTopic}
                  onMove={move}
                  onRemove={remove}
                  onJump={(id) => void control("jump", id)}
                />
              ))}
            </ol>
          )}
        </section>

        <footer className="publish-bar">
          <p className={`publish-status${notice?.kind === "error" ? " error" : ""}`} aria-live="polite">
            {statusText}
          </p>
          <div className="publish-actions">
            {draft ? (
              <button type="button" className="btn" disabled={anyBusy} onClick={discardDraft}>
                Discard
              </button>
            ) : null}
            <button type="button" className="btn primary publish" disabled={!dirty || problem !== null || anyBusy || conflict !== null} onClick={publish}>
              {busy === "publish" ? "Publishing…" : "Publish schedule"}
            </button>
          </div>
        </footer>
      </main>

      <ShowsView
        hidden={view !== "shows"}
        live={{ state: remote, dirty, busy: anyBusy || conflict !== null, apiDown: apiStatus === "down" }}
        onActivated={activated}
        onActivationPending={setActivating}
        openRequest={openShowRequest}
      />

      <DiscoverView hidden={view !== "discover"} refreshKey={inboxRefreshKey} onOpenSources={() => setView("sources")} onOpenShow={openSavedShow} />

      <InboxView hidden={view !== "inbox"} refreshKey={inboxRefreshKey} />

      <ResearchView hidden={view !== "research"} onOpenShow={openSavedShow} />

      <SourcesView hidden={view !== "sources"} onImported={() => setInboxRefreshKey((key) => key + 1)} onOpenInbox={() => setView("inbox")} />

      <ReviewView hidden={view !== "review"} />
    </div>
  )
}
