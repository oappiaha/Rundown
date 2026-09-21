import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { FormEvent } from "react"
import { ApiError, createFeed, getFeed, importFeed, listFeedRuns, listFeeds, updateFeed, type Feed, type ImportRun } from "../lib/api"
import { DEFAULT_DURATION, MAX_DURATION, MIN_DURATION, formatClock } from "../lib/draft"
import { safeSourceHref } from "../lib/inboxDraft"
import {
  MAX_FEED_NAME,
  MAX_FEED_URL,
  draftFromFeed,
  feedDurationProblem,
  feedHost,
  feedNameProblem,
  feedProblem,
  feedUrlProblem,
  hasFeedWork,
  isFeedDirty,
  mergeFeedDraft,
  newFeedDraft,
  runCounts,
  runSummary,
  stampLabel,
  toFeedCreateWire,
  toFeedUpdateWire,
  type FeedDraft,
} from "../lib/feedDraft"
import { useScheduleStore } from "../lib/scheduleStore"
import FeedSchedulePanel from "./FeedSchedulePanel"
import RetrievalPanel from "./RetrievalPanel"

type Props = {
  hidden: boolean
  /** An import finished (any status): the inbox list elsewhere must be reloaded. */
  onImported: () => void
  /** Jump to the Inbox view to review imported ideas. */
  onOpenInbox: () => void
}

type Notice = { kind: "info" | "error"; text: string }
type Pending = "load" | "save" | "recover" | null
/** A rejected save. The draft is kept; the user picks the recovery. */
type Conflict = { detail: string }
/** A selection that would drop unsaved work; the user confirms first. */
type Guard = { kind: "open"; id: string; name: string } | { kind: "new" }
/** The run an "Import now" pressed here came back with, kept per feed so switching feeds never shows another feed's result. */
type Result = { feedId: string; run: ImportRun }

const POLL_MS = 2000
const CHANGED_ELSEWHERE = "This feed was changed elsewhere since you opened it."

function describeError(error: unknown, what: string): string {
  if (error instanceof ApiError) return `${what} rejected (${error.status}): ${error.detail}`
  return `${what} failed: the RUNDOWN API did not respond.`
}

/**
 * A feed is "importing" while this screen waits for its POST, or while the
 * server still holds a lease for it (latest run running and can_import false).
 * A run left "running" by an interrupted server whose lease has expired is
 * not in progress: can_import is true again and a deliberate retry is allowed.
 */
function inProgress(feed: Feed, importing: ReadonlySet<string>): boolean {
  return importing.has(feed.id) || (feed.latest_run?.status === "running" && feed.enabled && !feed.can_import)
}

function interrupted(feed: Feed): boolean {
  return feed.latest_run?.status === "running" && feed.can_import
}

function statusWord(status: ImportRun["status"]): string {
  return status === "succeeded" ? "Succeeded" : status === "failed" ? "Failed" : "Running"
}

/**
 * Sources: configure RSS/Atom feeds and import their entries into the Inbox
 * on request. Configuration edits never fetch anything; "Import now" is the
 * only network action against a feed. Stays mounted while hidden so an
 * unsaved feed survives a trip to the other views.
 */
export default function SourcesView({ hidden, onImported, onOpenInbox }: Props) {
  const [feeds, setFeeds] = useState<Feed[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [draft, setDraftState] = useState<FeedDraft | null>(null)
  const [runs, setRuns] = useState<ImportRun[] | null>(null)
  const [runsError, setRunsError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [importing, setImporting] = useState<ReadonlySet<string>>(() => new Set())
  const [result, setResult] = useState<Result | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [guard, setGuard] = useState<Guard | null>(null)
  /** Automatic-import schedules, keyed by feed, kept for the life of this view so an unsaved schedule survives feed switching. */
  const [scheduleRefreshKey, setScheduleRefreshKey] = useState(0)
  const scheduleStore = useScheduleStore()

  const draftRef = useRef<FeedDraft | null>(null)
  /** Bumped on every selection change; a load/save/runs result for an older token is dropped. */
  const selectionSeq = useRef(0)
  /** Bumped on every list refresh; an older list response never replaces a newer one. */
  const listSeq = useRef(0)
  /** Bumped per runs load; an older runs response never replaces a newer one. */
  const runsSeq = useRef(0)
  const opSeq = useRef(0)
  /** Synchronous mirror of `importing`: two clicks in one tick cannot both start an import. */
  const importingRef = useRef<Set<string>>(new Set())
  const hiddenRef = useRef(hidden)
  const onImportedRef = useRef(onImported)
  useEffect(() => {
    hiddenRef.current = hidden
    onImportedRef.current = onImported
  }, [hidden, onImported])
  const nameRef = useRef<HTMLInputElement>(null)
  const nameId = useId()
  const urlId = useId()
  const durationId = useId()
  const enabledId = useId()
  const dialogTitleId = useId()
  const importTitleId = useId()
  const historyTitleId = useId()

  const setDraft = useCallback((next: FeedDraft | null | ((current: FeedDraft | null) => FeedDraft | null)) => {
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

  // ---- List and run history ---------------------------------------------------
  /** Reload the feed list. Only server status is replaced; the draft's fields are never touched. */
  const refreshList = useCallback((): Promise<void> => {
    const token = ++listSeq.current
    return listFeeds().then(
      (next) => {
        if (token !== listSeq.current) return
        setFeeds(next)
        setListError(null)
        setRefreshing(false)
      },
      (error: unknown) => {
        if (token !== listSeq.current) return
        setListError(describeError(error, "Loading the feeds"))
        setRefreshing(false)
      },
    )
  }, [])

  /** Reload the run history of the feed that is open; dropped if the selection moved on meanwhile. */
  const refreshRuns = useCallback((feedId: string): Promise<void> => {
    const token = ++runsSeq.current
    const selection = selectionSeq.current
    return listFeedRuns(feedId).then(
      (next) => {
        if (token !== runsSeq.current || selection !== selectionSeq.current) return
        setRuns(next)
        setRunsError(null)
      },
      (error: unknown) => {
        if (token !== runsSeq.current || selection !== selectionSeq.current) return
        setRunsError(describeError(error, "Loading the import history"))
      },
    )
  }, [])

  const refreshAll = useCallback(() => {
    const current = draftRef.current
    void refreshList()
    if (current?.id) void refreshRuns(current.id)
  }, [refreshList, refreshRuns])

  // Refresh whenever the view is shown; the editor draft is untouched.
  useEffect(() => {
    if (hidden) return
    refreshAll()
  }, [hidden, refreshAll])

  function refreshNow() {
    setScheduleRefreshKey((value) => value + 1)
    setRefreshing(true)
    setNotice(null)
    refreshAll()
  }

  // Poll while a run is in progress (here or on another screen) and the view is visible.
  const anyRunning = importing.size > 0 || (feeds?.some((feed) => inProgress(feed, importing)) ?? false)
  useEffect(() => {
    if (hidden || !anyRunning) return
    let inflight = false
    const timer = window.setInterval(() => {
      if (inflight) return
      inflight = true
      const current = draftRef.current
      const jobs = [refreshList()]
      if (current?.id) jobs.push(refreshRuns(current.id))
      void Promise.all(jobs).finally(() => {
        inflight = false
      })
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [hidden, anyRunning, refreshList, refreshRuns])

  // ---- Selection ------------------------------------------------------------
  const locked = pending !== null
  const dirty = draft !== null && isFeedDirty(draft)
  const unsaved = hasFeedWork(draft)
  /** Server-side status of the open feed (enabled, lease, latest run), from the list, never from the draft. */
  const feedInfo: Feed | null = draft?.id ? (feeds?.find((feed) => feed.id === draft.id) ?? null) : null

  function upsertFeed(feed: Feed) {
    setFeeds((current) => {
      if (current === null) return [feed]
      const index = current.findIndex((entry) => entry.id === feed.id)
      if (index < 0) return [feed, ...current]
      const next = [...current]
      next[index] = feed
      return next
    })
  }

  function clearSelection() {
    selectionSeq.current += 1
    runsSeq.current += 1
    setRuns(null)
    setRunsError(null)
    setNotice(null)
    setConflict(null)
  }

  async function loadFeed(id: string) {
    clearSelection()
    const token = selectionSeq.current
    const op = begin("load")
    try {
      const [feed] = await Promise.all([getFeed(id), refreshRuns(id)])
      if (token !== selectionSeq.current) return
      upsertFeed(feed)
      setDraft(draftFromFeed(feed))
    } catch (error) {
      if (token !== selectionSeq.current) return
      setNotice({ kind: "error", text: describeError(error, "Opening the feed") })
      if (error instanceof ApiError && error.status === 404) void refreshList()
    } finally {
      end(op)
    }
  }

  function openFeed(feed: Feed) {
    if (locked) return
    if (draft?.id === feed.id && !dirty) return
    if (unsaved) {
      setGuard({ kind: "open", id: feed.id, name: feed.name })
      return
    }
    void loadFeed(feed.id)
  }

  function startNew() {
    if (locked) return
    if (unsaved) {
      setGuard({ kind: "new" })
      return
    }
    clearSelection()
    setDraft(newFeedDraft(DEFAULT_DURATION))
    window.requestAnimationFrame(() => nameRef.current?.focus())
  }

  function confirmGuard() {
    const next = guard
    setGuard(null)
    if (!next) return
    // Drop the unsaved work explicitly, then continue with the selection.
    if (next.kind === "open") {
      setDraft(null)
      void loadFeed(next.id)
    } else {
      clearSelection()
      setDraft(newFeedDraft(DEFAULT_DURATION))
    }
  }

  // ---- Editing --------------------------------------------------------------
  const edit = useCallback(
    (patch: Partial<Pick<FeedDraft, "name" | "url" | "default_duration" | "enabled">>) => {
      if (pending !== null) return
      // The address of a saved feed is immutable; never let it change locally either.
      setDraft((current) => (current ? { ...current, ...patch, url: current.id === null ? (patch.url ?? current.url) : current.url } : current))
      setNotice(null)
    },
    [pending, setDraft],
  )

  function discardEdits() {
    if (!draft || locked) return
    setNotice(null)
    setConflict(null)
    if (draft.id === null) {
      clearSelection()
      setDraft(null)
    } else {
      setDraft({ ...draft, ...draft.base })
      setNotice({ kind: "info", text: "Your edits were discarded. Showing the saved feed." })
    }
  }

  // ---- Save (never fetches the feed) ---------------------------------------------
  const problem = draft ? feedProblem(draft) : null

  async function save(event?: FormEvent) {
    event?.preventDefault()
    const target = draftRef.current
    if (!target || locked || problem !== null || !dirty || conflict !== null) return
    const token = selectionSeq.current
    const op = begin("save")
    setNotice(null)
    try {
      const saved = target.id === null ? await createFeed(toFeedCreateWire(target)) : await updateFeed(target.id, toFeedUpdateWire(target))
      upsertFeed(saved)
      // Editing is locked while saving, so the draft is what we sent unless the
      // selection moved on; a stale result must never replace a newer draft.
      if (token === selectionSeq.current && draftRef.current === target) {
        setDraft(draftFromFeed(saved))
        setConflict(null)
        if (target.id === null) setRuns([])
        setNotice({
          kind: "info",
          text:
            target.id === null
              ? `Added "${saved.name}". Nothing was fetched yet: press Import now to read the feed.`
              : `Saved "${saved.name}"${saved.enabled ? "" : " (disabled)"}. Nothing was fetched.`,
        })
      }
      void refreshList()
    } catch (error) {
      if (token !== selectionSeq.current) return
      if (error instanceof ApiError && error.status === 409 && target.id === null) {
        // A new feed cannot be stale: the server refused it (an address that is already configured). Keep what was typed.
        setNotice({ kind: "error", text: `Not added: ${error.detail}` })
        void refreshList()
      } else if (error instanceof ApiError && error.status === 409) {
        // Stale edit, or refused for another reason (an import holds the feed)? Only a newer server version needs the merge/reload recovery.
        let stale = true
        try {
          const latest = await getFeed(target.id ?? "")
          upsertFeed(latest)
          stale = latest.revision !== target.baseRevision
        } catch {
          // Cannot tell: offer the explicit recovery, which re-reads anyway.
        }
        if (token !== selectionSeq.current) return
        if (stale) setConflict({ detail: error.detail })
        else setNotice({ kind: "error", text: `Not saved: ${error.detail} Your edits are kept here.` })
      } else if (error instanceof ApiError && error.status === 404) {
        setNotice({ kind: "error", text: "Not saved: this feed no longer exists. Your edits are kept here; add a new feed to keep them." })
        void refreshList()
      } else setNotice({ kind: "error", text: describeError(error, "Save") })
    } finally {
      end(op)
    }
  }

  /** Conflict recovery, always explicit: reload the latest version (dropping edits) or merge onto it. */
  async function recover(mode: "reload" | "merge") {
    const current = draftRef.current
    if (!current || current.id === null || locked) return
    const token = selectionSeq.current
    const op = begin("recover")
    setNotice(null)
    try {
      const latest = await getFeed(current.id)
      if (token !== selectionSeq.current || draftRef.current !== current) return
      upsertFeed(latest)
      setConflict(null)
      if (mode === "reload") {
        setDraft(draftFromFeed(latest))
        setNotice({ kind: "info", text: "Reloaded the latest version. Your edits were discarded." })
      } else {
        const merged = mergeFeedDraft(current, latest)
        setDraft(merged)
        setNotice({
          kind: "info",
          text: isFeedDirty(merged) ? "Merged the other changes into your draft. Save feed when ready." : "Nothing left to save: the latest version already has your changes.",
        })
      }
      void refreshRuns(current.id)
    } catch (error) {
      if (token !== selectionSeq.current) return
      if (error instanceof ApiError && error.status === 404) {
        setNotice({ kind: "error", text: "This feed no longer exists. Your edits are kept here; add a new feed to keep them." })
        void refreshList()
      } else setNotice({ kind: "error", text: describeError(error, "Loading the latest version") })
    } finally {
      end(op)
    }
  }

  // ---- Import (the only network action against a feed) ---------------------------
  function markImporting(feedId: string, on: boolean) {
    if (on) importingRef.current.add(feedId)
    else importingRef.current.delete(feedId)
    setImporting(new Set(importingRef.current))
  }

  const currentSchedule = draft?.id ? scheduleStore.slots[draft.id]?.schedule : null
  const scheduledRun = currentSchedule?.last_run
  const scheduledImportRunning = scheduledRun?.status === "running" && currentSchedule !== null && currentSchedule !== undefined
    && Date.parse(currentSchedule.server_time) - Date.parse(scheduledRun.started_at) < 120_000

  const importBlock: string | null =
    draft === null || draft.id === null
      ? "Save the feed first."
      : importing.has(draft.id) || scheduledImportRunning
        ? "Importing… this can take up to 20 seconds."
        : conflict !== null
          ? "Resolve the conflict above first."
          : dirty
            ? "Save or discard your edits before importing."
            : feedInfo === null
              ? "Waiting for the feed's status…"
              : !feedInfo.enabled
                ? "This feed is disabled. Enable it and save to import."
                : !feedInfo.can_import
                  ? "An import is already running for this feed, perhaps from another screen. Refresh to see its result."
                  : null

  async function importNow() {
    const current = draftRef.current
    if (!current || current.id === null || importBlock !== null) return
    const feedId = current.id
    const feedName = current.base.name
    if (importingRef.current.has(feedId)) return
    markImporting(feedId, true)
    setNotice(null)
    setResult((previous) => (previous?.feedId === feedId ? null : previous))
    try {
      const run = await importFeed(feedId, current.baseRevision)
      // Whatever the outcome, the run is a fact now: show it for this feed only.
      setResult({ feedId, run })
    } catch (error) {
      const text =
        error instanceof ApiError && error.status === 409
          ? `Import of "${feedName}" not started: ${error.detail}`
          : error instanceof ApiError && error.status === 404
            ? `Import not started: "${feedName}" no longer exists.`
            : error instanceof ApiError
              ? describeError(error, `Import of "${feedName}"`)
              : `Import of "${feedName}" did not get an answer from the RUNDOWN API. It may still be running: press Refresh to see its result. Nothing is retried on its own.`
      if (draftRef.current?.id === feedId) setNotice({ kind: "error", text })
      if (error instanceof ApiError && error.status === 409) {
        // Import can be refused by a lease or a changed configuration. Only
        // the latter needs explicit draft recovery; never retry automatically.
        try {
          const latest = await getFeed(feedId)
          upsertFeed(latest)
          if (draftRef.current === current && latest.revision !== current.baseRevision) {
            setConflict({ detail: error.detail })
          }
        } catch {
          if (draftRef.current === current) setConflict({ detail: error.detail })
        }
      }
    } finally {
      markImporting(feedId, false)
      // Never trust the POST alone: reload the feed's status, its history and the inbox.
      void refreshList()
      if (draftRef.current?.id === feedId) void refreshRuns(feedId)
      onImportedRef.current()
    }
  }

  /** A new automatic run finished on the server: reload status, history and the inbox. The feed draft is untouched. */
  const onAutomaticRun = useCallback(() => {
    void refreshList()
    const current = draftRef.current
    if (current?.id) void refreshRuns(current.id)
    onImportedRef.current()
  }, [refreshList, refreshRuns])

  const onFeedGone = useCallback(() => {
    void refreshList()
  }, [refreshList])

  // ---- Render ------------------------------------------------------------------
  const readOnly = locked
  const shownResult = result && draft?.id === result.feedId ? result.run : null
  /** The latest automatic run of the open feed, so history can mark it (runs carry no trigger field). */
  const automaticRunId = draft?.id ? (scheduleStore.slots[draft.id]?.schedule?.last_run?.id ?? null) : null
  const nameProblem = draft ? feedNameProblem(draft.name) : null
  const urlProblem = draft && draft.id === null ? feedUrlProblem(draft.url) : null
  const durationProblem = draft ? feedDurationProblem(draft.default_duration) : null
  const savedHref = draft && draft.id !== null ? safeSourceHref(draft.url) : null
  // A pristine new feed is not "invalid" yet; complain only once the user has typed something.
  const shownProblem = draft && (draft.id !== null || draft.name.length > 0 || draft.url.length > 0) ? problem : null
  const statusText = notice
    ? notice.text
    : shownProblem
      ? shownProblem
      : pending === "save"
        ? "Saving the feed…"
        : pending === "load"
          ? "Opening…"
          : draft === null
            ? "Open a feed from the list or add a new one."
            : draft.id === null
              ? "New feed, not saved yet. Saving never fetches the address."
              : dirty
                ? "Unsaved changes."
                : "Saved. Import now reads the feed and adds new entries to the Inbox."

  return (
    <main className="main shows sources" id="sources" hidden={hidden} aria-labelledby="sources-title">
      <header className="main-head">
        <div className="main-eyebrow">
          <span className="head-lbl">RSS and Atom feeds, YouTube and Reddit searches · results reach the Inbox only when you press Import now or Collect now, or when a feed schedule you turned on runs</span>
        </div>
        <h1 id="sources-title" className="main-title">
          Sources
        </h1>
      </header>

      <div className="shows-layout sources-layout">
        <section className="shows-list" aria-labelledby="sources-list-title">
          <div className="shows-list-head">
            <h2 id="sources-list-title">Feeds</h2>
            <div className="shows-list-actions">
              <button type="button" className="btn primary" disabled={locked} onClick={startNew}>
                New feed
              </button>
              <button type="button" className="btn" disabled={refreshing} onClick={refreshNow} title="Reload feed status and import history from the server">
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>

          {listError ? (
            <div className="banner error" role="alert">
              <p>{listError}</p>
              <div className="banner-actions">
                <button type="button" className="btn" onClick={refreshNow}>
                  Retry
                </button>
              </div>
            </div>
          ) : null}

          {feeds === null ? (
            <div className="empty">Loading feeds…</div>
          ) : feeds.length === 0 ? (
            <div className="empty">No feeds yet. Add the first RSS or Atom address.</div>
          ) : (
            <ul className="show-cards feed-cards" aria-label="Feeds">
              {feeds.map((feed) => {
                const selected = draft?.id === feed.id
                const running = inProgress(feed, importing)
                const latest = feed.latest_run
                const tone = running ? "running" : interrupted(feed) ? "failed" : latest === null ? "none" : latest.status
                return (
                  <li key={feed.id}>
                    <button
                      type="button"
                      className={`show-card feed-card${selected ? " on" : ""}`}
                      aria-current={selected ? "true" : undefined}
                      aria-label={`Open ${feed.name}`}
                      disabled={locked}
                      onClick={() => openFeed(feed)}
                    >
                      <span className="show-card-name">
                        {feed.name}
                        {feed.enabled ? null : <span className="feed-tag">Disabled</span>}
                      </span>
                      <span className="show-card-meta">
                        {feedHost(feed.url)} · {formatClock(feed.default_duration)}
                      </span>
                      <span className={`show-card-meta feed-status ${tone}`} data-status={tone}>
                        {running ? "Importing…" : interrupted(feed) ? "Last import was interrupted · Import now to retry" : runSummary(latest)}
                        {latest && !running ? ` · ${stampLabel(latest.finished_at ?? latest.started_at)}` : ""}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="show-editor sources-editor" aria-labelledby="sources-editor-title" aria-busy={locked || undefined}>
          <h2 id="sources-editor-title" className="visually-hidden">
            Feed editor
          </h2>
          {draft === null ? (
            <>
              <div className="empty">{pending === "load" ? "Opening…" : "Nothing open. Pick a feed on the left or add a new one."}</div>
              <footer className="publish-bar show-bar sources-bar">
                <p className={`publish-status${notice?.kind === "error" ? " error" : ""}`} aria-live="polite">
                  {statusText}
                </p>
              </footer>
            </>
          ) : (
            <>
              <form className="inbox-form feed-form" aria-label={draft.id === null ? "New feed" : "Edit feed"} onSubmit={(event) => void save(event)}>
                {conflict ? (
                  <div className="banner error" role="alert">
                    <p>
                      <strong>Not saved.</strong> {CHANGED_ELSEWHERE} Your edits are kept here. Merging keeps what you edited and brings in what changed there; reloading discards your edits.
                    </p>
                    <div className="banner-actions">
                      <button type="button" className="btn primary" disabled={locked} onClick={() => void recover("merge")}>
                        Merge with the latest version
                      </button>
                      <button type="button" className="btn" disabled={locked} onClick={() => void recover("reload")}>
                        Reload and discard my edits
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="inbox-fields">
                  <label className="field grow" htmlFor={nameId}>
                    <span>Feed name</span>
                    <input
                      id={nameId}
                      ref={nameRef}
                      aria-label="Feed name"
                      aria-invalid={nameProblem ? true : undefined}
                      className="show-name"
                      disabled={readOnly}
                      maxLength={MAX_FEED_NAME * 2}
                      placeholder="How the feed appears in the Inbox"
                      value={draft.name}
                      onChange={(event) => edit({ name: event.target.value })}
                    />
                  </label>
                  <label className="field seconds" htmlFor={durationId}>
                    <span>Default seconds</span>
                    <input
                      id={durationId}
                      aria-label="Default duration"
                      aria-invalid={durationProblem ? true : undefined}
                      disabled={readOnly}
                      inputMode="numeric"
                      min={MIN_DURATION}
                      max={MAX_DURATION}
                      step={1}
                      type="number"
                      value={Number.isNaN(draft.default_duration) ? "" : draft.default_duration}
                      onChange={(event) => edit({ default_duration: event.target.valueAsNumber })}
                    />
                  </label>
                </div>

                <div className="inbox-source feed-url">
                  {draft.id === null ? (
                    <>
                      <label className="field grow" htmlFor={urlId}>
                        <span>Feed URL</span>
                        <input
                          id={urlId}
                          aria-label="Feed URL"
                          aria-invalid={urlProblem && draft.url.length > 0 ? true : undefined}
                          aria-describedby={`${urlId}-hint`}
                          disabled={readOnly}
                          inputMode="url"
                          maxLength={MAX_FEED_URL * 2}
                          placeholder="https://example.com/feed.xml"
                          spellCheck={false}
                          type="text"
                          value={draft.url}
                          onChange={(event) => edit({ url: event.target.value })}
                        />
                      </label>
                      <div id={`${urlId}-hint`} className="inbox-source-meta">
                        {urlProblem && draft.url.length > 0 ? (
                          <span className="tproblem">{urlProblem}</span>
                        ) : (
                          <span className="notes-hint">The address is fixed once the feed is saved. Nothing is fetched until you press Import now.</span>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <span className="field-label">Feed URL</span>
                      <div className="feed-url-fixed" data-testid="feed-url">
                        {savedHref ? (
                          <a className="source-link feed-url-text" href={savedHref} target="_blank" rel="noopener noreferrer">
                            {draft.url}
                          </a>
                        ) : (
                          <span className="feed-url-text">{draft.url}</span>
                        )}
                      </div>
                      <div className="inbox-source-meta">
                        <span className="notes-hint">The address can't be changed. To use a different address, add a new feed.</span>
                      </div>
                    </>
                  )}
                </div>

                {draft.id === null ? (
                  <p className="notes-hint">New feeds start enabled. You can disable a feed after saving it.</p>
                ) : (
                  <label className="check feed-enabled" htmlFor={enabledId}>
                    <input id={enabledId} type="checkbox" aria-label="Enabled" disabled={readOnly} checked={draft.enabled} onChange={(event) => edit({ enabled: event.target.checked })} />
                    Enabled
                    <span className="quick-add-publish-hint">{draft.enabled ? "Import now is available once saved." : "Disabled: imports are refused until it is enabled again."}</span>
                  </label>
                )}

                <footer className="publish-bar show-bar sources-bar">
                  <p className={`publish-status${notice?.kind === "error" ? " error" : ""}`} aria-live="polite">
                    {statusText}
                  </p>
                  <div className="publish-actions show-actions">
                    {dirty ? (
                      <button type="button" className="btn" disabled={locked} onClick={discardEdits}>
                        {draft.id === null ? "Discard new feed" : "Discard edits"}
                      </button>
                    ) : null}
                    <button type="submit" className="btn primary" disabled={locked || !dirty || problem !== null || conflict !== null}>
                      {pending === "save" ? "Saving…" : draft.id === null ? "Add feed" : "Save feed"}
                    </button>
                  </div>
                </footer>
              </form>

              {draft.id !== null ? (
                <>
                  <section className="reuse import-panel" aria-labelledby={importTitleId} aria-busy={importing.has(draft.id) || undefined}>
                    <h3 id={importTitleId}>Import</h3>
                    <p>Reads the feed once and adds entries it has not seen before to the Inbox as ideas, with the original text kept for review. Automatic imports, when turned on below, follow the same rules.</p>
                    <div className="inline-form-actions import-actions">
                      <button type="button" className="btn primary" disabled={importBlock !== null} onClick={() => void importNow()}>
                        {importing.has(draft.id) ? "Importing…" : "Import now"}
                      </button>
                      {importBlock ? (
                        <span className="reuse-hint import-block" role="status">
                          {importBlock}
                        </span>
                      ) : null}
                    </div>
                    {feedInfo && interrupted(feedInfo) && !shownResult ? (
                      <div className="banner warn" role="status">
                        <p>The last import did not finish (the server may have been interrupted). Nothing is retried on its own: press Import now when ready.</p>
                      </div>
                    ) : null}
                    {shownResult ? (
                      shownResult.status === "failed" ? (
                        <div className="banner error import-result" role="alert" data-run-status="failed">
                          <p>
                            <strong>Import failed.</strong> {shownResult.error ?? "The feed could not be read."} Nothing was added to the Inbox. Check the address, then press Import now again when ready.
                          </p>
                          {shownResult.warnings.length > 0 ? (
                            <ul className="run-warnings">
                              {shownResult.warnings.map((warning, index) => (
                                <li key={index}>{warning}</li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      ) : shownResult.status === "running" ? (
                        <div className="banner warn import-result" role="status" data-run-status="running">
                          <p>The import is still running. Press Refresh to see its result.</p>
                        </div>
                      ) : (
                        <div className={`banner ${shownResult.created > 0 ? "success" : "warn"} import-result`} role="status" data-run-status="succeeded">
                          <p>
                            <strong>{shownResult.created > 0 ? "Imported." : "Nothing new."}</strong> {runCounts(shownResult)}.{" "}
                            {shownResult.created > 0 ? "New ideas are waiting in the Inbox with their original text." : shownResult.examined > 0 ? "Every entry was already in the Inbox or was skipped." : "The feed had no entries."}
                          </p>
                          {shownResult.warnings.length > 0 ? (
                            <ul className="run-warnings">
                              {shownResult.warnings.map((warning, index) => (
                                <li key={index}>{warning}</li>
                              ))}
                            </ul>
                          ) : null}
                          {shownResult.created > 0 ? (
                            <div className="banner-actions">
                              <button type="button" className="btn" onClick={onOpenInbox}>
                                Open inbox
                              </button>
                            </div>
                          ) : null}
                        </div>
                      )
                    ) : null}
                  </section>

                  <FeedSchedulePanel
                    refreshKey={scheduleRefreshKey}
                    key={draft.id}
                    feedId={draft.id}
                    feedName={draft.base.name}
                    hidden={hidden}
                    store={scheduleStore}
                    feed={feedInfo}
                    parentDirty={dirty}
                    parentLocked={locked}
                    onAutomaticRun={onAutomaticRun}
                    onFeedGone={onFeedGone}
                  />

                  <section className="reuse run-history" aria-labelledby={historyTitleId}>
                    <h3 id={historyTitleId}>Import history</h3>
                    <p>Last 20 runs, newest first, from Import now and from the schedule. Every run is kept, including failures.</p>
                    {runsError ? (
                      <div className="banner error" role="alert">
                        <p>{runsError}</p>
                        <div className="banner-actions">
                          <button type="button" className="btn" onClick={() => draft.id && void refreshRuns(draft.id)}>
                            Retry
                          </button>
                        </div>
                      </div>
                    ) : runs === null ? (
                      <p className="reuse-hint">Loading history…</p>
                    ) : runs.length === 0 ? (
                      <p className="reuse-hint">No imports yet.</p>
                    ) : (
                      <ol className="run-list" aria-label="Import runs">
                        {runs.map((run) => (
                          <li key={run.id} className={`run-row ${run.status}`} data-run-id={run.id} data-run-status={run.status}>
                            <div className="run-head">
                              <span className={`run-status ${run.status}`}>
                                {statusWord(run.status)}
                                {run.id === automaticRunId ? <span className="feed-tag run-tag">Automatic</span> : null}
                              </span>
                              <span className="run-when">
                                {stampLabel(run.started_at)}
                                {run.finished_at ? ` → ${stampLabel(run.finished_at)}` : run.status === "running" ? " · still running" : ""}
                              </span>
                            </div>
                            <div className="run-counts">{runCounts(run)}</div>
                            {run.error ? <p className="run-error">{run.error}</p> : null}
                            {run.warnings.length > 0 ? (
                              <ul className="run-warnings">
                                {run.warnings.map((warning, index) => (
                                  <li key={index}>{warning}</li>
                                ))}
                              </ul>
                            ) : null}
                            {run.items.length > 0 ? (
                              <details className="run-items">
                                <summary>
                                  {run.items.length} {run.items.length === 1 ? "entry" : "entries"}
                                </summary>
                                <ul>
                                  {run.items.map((item, index) => (
                                    <li key={index}>
                                      <span className="run-item-title">{item.title || "(untitled)"}</span>
                                      <span className="run-item-reason"> — {item.reason}</span>
                                    </li>
                                  ))}
                                </ul>
                              </details>
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>
                </>
              ) : null}
            </>
          )}
        </section>
      </div>

      <RetrievalPanel hidden={hidden} onImported={onImported} onOpenInbox={onOpenInbox} />

      {guard ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby={`${dialogTitleId}-guard`}>
            <h2 id={`${dialogTitleId}-guard`}>Unsaved changes</h2>
            <p>
              {draft?.id === null ? "Your new feed has not been saved." : `"${draft?.name}" has unsaved changes.`}{" "}
              {guard.kind === "open" ? `Opening "${guard.name}" will discard them.` : "Starting a new feed will discard them."}
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
    </main>
  )
}
