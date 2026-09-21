import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { FormEvent } from "react"
import {
  ApiError,
  collectRetrievalSource,
  createRetrievalSource,
  getRetrieval,
  listRetrievalRuns,
  updateRetrievalSource,
  type RetrievalPlatform,
  type RetrievalRun,
  type RetrievalSource,
  type RetrievalStatus,
} from "../lib/api"
import { DEFAULT_DURATION, MAX_DURATION, MIN_DURATION, formatClock } from "../lib/draft"
import { stampLabel } from "../lib/feedDraft"
import { newRequestId } from "../lib/prepDraft"
import {
  MAX_FRESHNESS_HOURS,
  MAX_QUERY,
  MAX_RESULTS,
  MAX_SCOPE,
  MAX_SEARCH_NAME,
  MIN_FRESHNESS_HOURS,
  MIN_RESULTS,
  PLATFORMS,
  PLATFORM_LABEL,
  draftFromSource,
  freshnessProblem,
  hasSearchWork,
  isSearchDirty,
  newSearchDraft,
  queryProblem,
  resultLimitProblem,
  retainedText,
  runCounts,
  runSummary,
  scopeLabel,
  scopePlaceholder,
  scopeProblem,
  searchDurationProblem,
  searchNameProblem,
  searchProblem,
  searchTarget,
  statusWord,
  targetProblem,
  toSearchCreateWire,
  toSearchUpdateWire,
  type CollectAttempt,
  type SearchDraft,
  type SearchFields,
} from "../lib/retrievalDraft"

type Props = {
  hidden: boolean
  /** A collection finished (any status): the inbox list elsewhere must be reloaded. */
  onImported: () => void
  /** Jump to the Inbox view to review collected ideas. */
  onOpenInbox: () => void
}

type Notice = { kind: "info" | "error"; text: string }
type Pending = "save" | "recover" | null
/** A rejected save: the server has a newer revision. The draft is kept until the user reloads explicitly. */
type Conflict = { detail: string }
/** A selection that would drop unsaved work; the user confirms first. */
type Guard = { kind: "open"; id: string; name: string } | { kind: "new" }
/** The run a "Collect now" pressed here came back with, kept per search so switching never shows another search's result. */
type Result = { sourceId: string; run: RetrievalRun }

const POLL_MS = 2000
const CHANGED_ELSEWHERE = "This search was changed elsewhere since you opened it."

function describeError(error: unknown, what: string): string {
  if (error instanceof ApiError) return `${what} rejected (${error.status}): ${error.detail}`
  return `${what} failed: the RUNDOWN API did not respond.`
}

/** A search is collecting while this screen waits for its POST or while the server still reports its latest run as running (an expired lease reads as "interrupted"). */
function inProgress(source: RetrievalSource, collecting: ReadonlySet<string>): boolean {
  return collecting.has(source.id) || source.latest_run?.status === "running"
}

function tone(source: RetrievalSource, collecting: ReadonlySet<string>): string {
  if (inProgress(source, collecting)) return "running"
  const latest = source.latest_run
  if (latest === null) return "none"
  return latest.status === "interrupted" ? "failed" : latest.status
}

/**
 * Discovery searches: saved YouTube and Reddit queries that collect recent
 * results into the Inbox on request. Configuration edits never contact a
 * platform; "Collect now" is the only network action and each fresh attempt
 * spends exactly one provider request. Rendered inside Sources, which stays
 * mounted while hidden, so an unsaved search survives a trip to other views.
 */
export default function RetrievalPanel({ hidden, onImported, onOpenInbox }: Props) {
  const [status, setStatus] = useState<RetrievalStatus | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [draft, setDraftState] = useState<SearchDraft | null>(null)
  const [runs, setRuns] = useState<RetrievalRun[] | null>(null)
  const [runsError, setRunsError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [collecting, setCollecting] = useState<ReadonlySet<string>>(() => new Set())
  const [attempts, setAttempts] = useState<Readonly<Record<string, CollectAttempt>>>({})
  const [result, setResult] = useState<Result | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [guard, setGuard] = useState<Guard | null>(null)

  const draftRef = useRef<SearchDraft | null>(null)
  /** Bumped on every selection change; a save/runs result for an older token is dropped. */
  const selectionSeq = useRef(0)
  /** Bumped on every list refresh; an older list response never replaces a newer one. */
  const listSeq = useRef(0)
  /** Bumped per runs load; an older runs response never replaces a newer one. */
  const runsSeq = useRef(0)
  const opSeq = useRef(0)
  /** Synchronous mirror of `collecting`: two clicks in one tick cannot both start a collection. */
  const collectingRef = useRef<Set<string>>(new Set())
  /** Synchronous mirror of `attempts`: the request id of an unanswered attempt, per search, for an exact retry. */
  const attemptsRef = useRef<Record<string, CollectAttempt>>({})
  const onImportedRef = useRef(onImported)
  useEffect(() => {
    onImportedRef.current = onImported
  }, [onImported])
  const nameRef = useRef<HTMLInputElement>(null)
  const nameId = useId()
  const platformId = useId()
  const queryId = useId()
  const scopeId = useId()
  const freshnessId = useId()
  const limitId = useId()
  const durationId = useId()
  const enabledId = useId()
  const titleId = useId()
  const listTitleId = useId()
  const editorTitleId = useId()
  const collectTitleId = useId()
  const historyTitleId = useId()
  const dialogTitleId = useId()

  const setDraft = useCallback((next: SearchDraft | null | ((current: SearchDraft | null) => SearchDraft | null)) => {
    const value = typeof next === "function" ? next(draftRef.current) : next
    draftRef.current = value
    setDraftState(value)
  }, [])

  function setAttempt(sourceId: string, attempt: CollectAttempt | null) {
    if (attempt) attemptsRef.current = { ...attemptsRef.current, [sourceId]: attempt }
    else {
      const next = { ...attemptsRef.current }
      delete next[sourceId]
      attemptsRef.current = next
    }
    setAttempts(attemptsRef.current)
  }

  function begin(kind: Exclude<Pending, null>): number {
    const op = ++opSeq.current
    setPending(kind)
    return op
  }

  function end(op: number) {
    if (op === opSeq.current) setPending(null)
  }

  // ---- List and run history ---------------------------------------------------
  /** Reload every search's server status. Only server status is replaced; the draft's fields are never touched. Resolves with the status, or null when it failed or was superseded. */
  const refreshList = useCallback((): Promise<RetrievalStatus | null> => {
    const token = ++listSeq.current
    return getRetrieval().then(
      (next) => {
        setRefreshing(false)
        if (token !== listSeq.current) return null
        setStatus(next)
        setListError(null)
        return next
      },
      (error: unknown) => {
        setRefreshing(false)
        if (token !== listSeq.current) return null
        setListError(describeError(error, "Loading the discovery searches"))
        return null
      },
    )
  }, [])

  /** Reload the run history of the open search; dropped if the selection moved on. An unanswered attempt whose run shows up here is resolved from the history. */
  const refreshRuns = useCallback((sourceId: string): Promise<void> => {
    const token = ++runsSeq.current
    const selection = selectionSeq.current
    return listRetrievalRuns(sourceId).then(
      (next) => {
        if (token !== runsSeq.current || selection !== selectionSeq.current) return
        setRuns(next)
        setRunsError(null)
        const attempt = attemptsRef.current[sourceId]
        if (attempt && !collectingRef.current.has(sourceId)) {
          const found = next.find((run) => run.id === attempt.requestId)
          if (found && found.status !== "running") {
            const rest = { ...attemptsRef.current }
            delete rest[sourceId]
            attemptsRef.current = rest
            setAttempts(rest)
            setResult({ sourceId, run: found })
            setNotice({ kind: "info", text: "The earlier request had reached the server after all. Its result is shown below; nothing was sent again." })
          }
        }
      },
      (error: unknown) => {
        if (token !== runsSeq.current || selection !== selectionSeq.current) return
        setRunsError(describeError(error, "Loading the collection history"))
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
    setRefreshing(true)
    setNotice(null)
    refreshAll()
  }

  // Poll while a collection is in progress (here or on another screen) and the view is visible.
  const sources = status?.sources ?? []
  const anyRunning = collecting.size > 0 || sources.some((source) => inProgress(source, collecting))
  useEffect(() => {
    if (hidden || !anyRunning) return
    let inflight = false
    const timer = window.setInterval(() => {
      if (inflight) return
      inflight = true
      const current = draftRef.current
      const jobs: Promise<unknown>[] = [refreshList()]
      if (current?.id) jobs.push(refreshRuns(current.id))
      void Promise.all(jobs).finally(() => {
        inflight = false
      })
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [hidden, anyRunning, refreshList, refreshRuns])

  // ---- Selection ------------------------------------------------------------
  const locked = pending !== null
  const dirty = draft !== null && isSearchDirty(draft)
  const unsaved = hasSearchWork(draft)
  /** Server-side status of the open search (paused, setup, lease, latest run), from the list, never from the draft. */
  const info: RetrievalSource | null = draft?.id ? (sources.find((source) => source.id === draft.id) ?? null) : null

  function upsertSource(source: RetrievalSource) {
    setStatus((current) => {
      if (current === null) return { sources: [source], providers: [], daily_limit: 0, used_today: 0, mode: "live" }
      const index = current.sources.findIndex((entry) => entry.id === source.id)
      const next = [...current.sources]
      if (index < 0) next.unshift(source)
      else next[index] = source
      return { ...current, sources: next }
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

  function openSource(source: RetrievalSource) {
    if (locked) return
    if (draft?.id === source.id && !dirty) return
    if (unsaved) {
      setGuard({ kind: "open", id: source.id, name: source.name })
      return
    }
    load(source)
  }

  function load(source: RetrievalSource) {
    clearSelection()
    setDraft(draftFromSource(source))
    void refreshRuns(source.id)
  }

  function startNew() {
    if (locked) return
    if (unsaved) {
      setGuard({ kind: "new" })
      return
    }
    clearSelection()
    setDraft(newSearchDraft(DEFAULT_DURATION))
    window.requestAnimationFrame(() => nameRef.current?.focus())
  }

  function confirmGuard() {
    const next = guard
    setGuard(null)
    if (!next) return
    if (next.kind === "open") {
      const source = sources.find((entry) => entry.id === next.id)
      setDraft(null)
      if (source) load(source)
      else {
        clearSelection()
        void refreshList()
      }
    } else {
      clearSelection()
      setDraft(newSearchDraft(DEFAULT_DURATION))
    }
  }

  // ---- Editing --------------------------------------------------------------
  const edit = useCallback(
    (patch: Partial<SearchFields>) => {
      if (pending !== null) return
      // Settings stay fixed while this search's collection is on its way: the server collected against the saved revision.
      if (draftRef.current?.id && collectingRef.current.has(draftRef.current.id)) return
      setDraft((current) => (current ? { ...current, ...patch } : current))
      setNotice(null)
    },
    [pending, setDraft],
  )

  function discardEdits() {
    if (!draft || locked) return
    setNotice(null)
    if (draft.id === null) {
      clearSelection()
      setDraft(null)
    } else {
      setDraft({ ...draft, ...draft.base })
      setNotice({ kind: "info", text: conflict ? "Your edits were discarded. Reload to see the newer version saved elsewhere." : "Your edits were discarded. Showing the saved search." })
    }
  }

  // ---- Save (never contacts a platform) ---------------------------------------------
  const problem = draft ? searchProblem(draft) : null

  async function save(event?: FormEvent) {
    event?.preventDefault()
    const target = draftRef.current
    if (!target || locked || problem !== null || !dirty || conflict !== null) return
    const token = selectionSeq.current
    const op = begin("save")
    setNotice(null)
    try {
      const saved = target.id === null ? await createRetrievalSource(toSearchCreateWire(target)) : await updateRetrievalSource(target.id, toSearchUpdateWire(target))
      upsertSource(saved)
      // Editing is locked while saving, so the draft is what we sent unless the selection moved on; a stale result must never replace a newer draft.
      if (token === selectionSeq.current && draftRef.current === target) {
        setDraft(draftFromSource(saved))
        setConflict(null)
        setNotice({
          kind: "info",
          text:
            target.id === null
              ? `Saved "${saved.name}". Nothing was collected yet: press Collect now to query ${PLATFORM_LABEL[saved.platform]} once.`
              : `Saved "${saved.name}"${saved.enabled ? "" : " (paused)"}. Nothing was collected.`,
        })
        void refreshRuns(saved.id)
      }
      void refreshList()
    } catch (error) {
      if (token !== selectionSeq.current) return
      if (error instanceof ApiError && error.status === 409 && target.id !== null) {
        // Stale edit, or refused because a collection of this search is running? Only a newer server revision needs the reload recovery.
        const latest = await refreshList()
        if (token !== selectionSeq.current || draftRef.current !== target) return
        const server = latest?.sources.find((entry) => entry.id === target.id)
        if (server === undefined || server.revision !== target.baseRevision) setConflict({ detail: error.detail })
        else setNotice({ kind: "error", text: `Not saved: ${error.detail} Your edits are kept here.` })
      } else if (error instanceof ApiError && error.status === 404) {
        setNotice({ kind: "error", text: "Not saved: this search no longer exists. Your edits are kept here; add a new search to keep them." })
        void refreshList()
      } else setNotice({ kind: "error", text: describeError(error, "Save") })
    } finally {
      end(op)
    }
  }

  /** Conflict recovery, always explicit: reload the server's version and drop the local edits. */
  async function reloadLatest() {
    const current = draftRef.current
    if (!current || current.id === null || locked) return
    const token = selectionSeq.current
    const op = begin("recover")
    setNotice(null)
    try {
      const latest = await refreshList()
      if (token !== selectionSeq.current || draftRef.current !== current) return
      const server = latest?.sources.find((entry) => entry.id === current.id)
      if (latest === null) {
        setNotice({ kind: "error", text: "Could not load the latest version. Your edits are kept here; try again." })
        return
      }
      if (server === undefined) {
        setNotice({ kind: "error", text: "This search no longer exists. Your edits are kept here; add a new search to keep them." })
        return
      }
      setConflict(null)
      setDraft(draftFromSource(server))
      setNotice({ kind: "info", text: "Reloaded the latest version. Your edits were discarded." })
      void refreshRuns(server.id)
    } finally {
      end(op)
    }
  }

  // ---- Collect (the only network action against a platform) ------------------------
  function markCollecting(sourceId: string, on: boolean) {
    if (on) collectingRef.current.add(sourceId)
    else collectingRef.current.delete(sourceId)
    setCollecting(new Set(collectingRef.current))
  }

  const providerReason = (platform: RetrievalPlatform): string | null => status?.providers.find((entry) => entry.platform === platform)?.setup_reason ?? null
  const dailyExhausted = status !== null && status.daily_limit > 0 && status.used_today >= status.daily_limit
  const openAttempt: CollectAttempt | null = draft?.id ? (attempts[draft.id] ?? null) : null

  const collectBlock: string | null =
    draft === null || draft.id === null
      ? "Save the search first."
      : collecting.has(draft.id)
        ? "Collecting… one request is on its way to the platform."
        : conflict !== null
          ? "Resolve the conflict above first."
          : dirty
            ? "Save or discard your edits before collecting."
            : info === null
              ? "Waiting for the search's status…"
              : info.setup_reason
                ? `${PLATFORM_LABEL[info.platform]} is not set up: ${info.setup_reason} You can keep editing searches meanwhile.`
                : !info.enabled
                  ? "This search is paused. Turn it on and save to collect."
                  : info.latest_run?.status === "running"
                    ? "A collection of this search is running, perhaps from another screen. Refresh to see its result."
                    : !info.can_import
                      ? "Another collection is running. Refresh its status before trying again."
                      : dailyExhausted
                        ? `Today's allowance of ${status?.daily_limit ?? 0} collection attempts is used up; it resets at midnight UTC.`
                        : null

  /**
   * One deliberate collection. A fresh press mints a new request id; a retry
   * after an unanswered request reuses the stored one, so the server either
   * returns the original attempt or starts the one that never arrived. It
   * never spends two provider requests for one press.
   */
  async function collect(mode: "fresh" | "retry") {
    const current = draftRef.current
    if (!current || current.id === null) return
    const sourceId = current.id
    const name = current.base.name
    const platform = current.base.platform
    if (collectingRef.current.has(sourceId)) return
    const stored = attemptsRef.current[sourceId]
    if (mode === "retry" && !stored) return
    if (mode === "fresh" && (stored || collectBlock !== null)) return
    const attempt: CollectAttempt = stored ?? { requestId: newRequestId(), revision: current.baseRevision, startedAt: new Date().toISOString() }
    setAttempt(sourceId, attempt)
    markCollecting(sourceId, true)
    setNotice(null)
    setResult((previous) => (previous?.sourceId === sourceId ? null : previous))
    try {
      const run = await collectRetrievalSource(sourceId, { revision: attempt.revision, request_id: attempt.requestId })
      // Whatever the outcome, the run is a fact now: show it for this search only, and the attempt is settled.
      setAttempt(sourceId, null)
      setResult({ sourceId, run })
    } catch (error) {
      // Only a 4xx is a definitive "nothing started under this id". A 5xx (a gateway
      // 503 included) may follow a committed import, so the request id is kept for
      // an exact retry; the history reload below settles it if the run exists.
      const definitive = error instanceof ApiError && error.status < 500
      if (definitive) setAttempt(sourceId, null)
      const text =
        error instanceof ApiError && error.status === 429
          ? `Collection of "${name}" not started: ${error.detail}`
          : error instanceof ApiError && error.status === 503
            ? `Collection of "${name}" not started: ${PLATFORM_LABEL[platform]} is not set up. ${error.detail}`
            : error instanceof ApiError && error.status === 409
              ? `Collection of "${name}" not started: ${error.detail}`
              : error instanceof ApiError && error.status === 404
                ? `Collection not started: "${name}" no longer exists.`
                : error instanceof ApiError && definitive
                  ? describeError(error, `Collection of "${name}"`)
                  : error instanceof ApiError
                    ? `Collection of "${name}" got an incomplete answer (${error.status}): ${error.detail} It may still have run. Nothing is retried on its own: use "Retry the same request" below (same request id, so no extra platform request) or Check history.`
                    : `Collection of "${name}" did not get an answer from the RUNDOWN API. It may still have run. Nothing is retried on its own: use "Retry the same request" below (same request id, so no extra platform request) or Check history.`
      if (draftRef.current?.id === sourceId) setNotice({ kind: "error", text })
      if (error instanceof ApiError && error.status === 409) {
        // Refused by a lease, a pause or a changed configuration. Only the latter needs explicit draft recovery; never retry automatically.
        const latest = await refreshList()
        const server = latest?.sources.find((entry) => entry.id === sourceId)
        if (draftRef.current === current && server && server.revision !== current.baseRevision) setConflict({ detail: error.detail })
      }
    } finally {
      markCollecting(sourceId, false)
      // Never trust the POST alone: reload the search's status, its history and the inbox.
      void refreshList()
      if (draftRef.current?.id === sourceId) void refreshRuns(sourceId)
      onImportedRef.current()
    }
  }

  function dropAttempt() {
    const current = draftRef.current
    if (!current?.id || collectingRef.current.has(current.id)) return
    setAttempt(current.id, null)
    setNotice({ kind: "info", text: "The unanswered request was set aside. The next Collect now starts a new attempt, which counts against today's allowance." })
  }

  // ---- Render ------------------------------------------------------------------
  const readOnly = locked || (draft?.id !== null && draft?.id !== undefined && collecting.has(draft.id))
  // The result of a press made here, superseded by the newer copy of the same run from
  // polled history or the list once the server has finished it (a POST that came back
  // "running" would otherwise stay "running" here forever).
  const pressed = result && draft?.id === result.sourceId ? result.run : null
  const copies = pressed ? [pressed, info?.latest_run, runs?.find((run) => run.id === pressed.id)]
    .filter((run): run is RetrievalRun => !!run && run.id === pressed.id) : []
  // A terminal result wins even when the other read endpoint is delayed or unavailable.
  const shownResult = copies.find((run) => run.status !== "running") ?? pressed
  const nameProblem = draft ? searchNameProblem(draft.name) : null
  const keywordsProblem = draft ? queryProblem(draft.query) : null
  const scopeIssue = draft ? scopeProblem(draft.platform, draft.scope) : null
  const targetIssue = draft ? targetProblem(draft.query, draft.scope) : null
  const freshnessIssue = draft ? freshnessProblem(draft.freshness_hours) : null
  const limitIssue = draft ? resultLimitProblem(draft.limit) : null
  const durationIssue = draft ? searchDurationProblem(draft.default_duration) : null
  // A pristine new search is not "invalid" yet; complain only once the user has typed something.
  const shownProblem = draft && (draft.id !== null || hasSearchWork(draft)) ? problem : null
  const statusText = notice
    ? notice.text
    : shownProblem
      ? shownProblem
      : pending === "save"
        ? "Saving the search…"
        : pending === "recover"
          ? "Reloading…"
          : draft === null
            ? "Open a search from the list or add a new one."
            : draft.id === null
              ? "New search, not saved yet. Saving never contacts the platform."
              : dirty
                ? "Unsaved changes."
                : "Saved. Collect now queries the platform once and adds new results to the Inbox."

  const mode = status?.mode ?? null
  const fixture = mode === "fixture"

  return (
    <section className="retrieval" aria-labelledby={titleId} data-testid="retrieval" data-mode={mode ?? undefined}>
      <header className="retrieval-head">
        <div className="retrieval-title-row">
          <h2 id={titleId}>Discovery searches</h2>
          {mode ? (
            <span className={`retrieval-mode ${mode}`} data-testid="retrieval-mode" title={fixture ? "Results come from a local test fixture, not from YouTube or Reddit." : "Each Collect now sends one real request to the platform."}>
              {fixture ? "Fixture mode" : "Live mode"}
            </span>
          ) : null}
        </div>
        <p>
          Saved YouTube and Reddit queries. Collect now queries the platform once and adds results it has not seen before to the Inbox as ideas, with the original text kept. Nothing is ranked, prepared or published on its own: review the ideas in the Inbox, then rank them in Research (its AI ranking runs only when you ask for it there).
        </p>
        <div className="retrieval-meta">
          {fixture ? <span className="retrieval-fixture-note">Fixture mode: results are synthetic test data, not from YouTube or Reddit.</span> : null}
          {status ? (
            <span className="retrieval-quota" data-testid="retrieval-quota">
              Attempts today: {status.used_today} of {status.daily_limit}
            </span>
          ) : null}
          {status ? (
            <ul className="retrieval-providers" aria-label="Platform setup">
              {status.providers.map((provider) => (
                <li key={provider.platform} className={`retrieval-provider${provider.setup_reason ? " needs-setup" : ""}`} data-platform={provider.platform}>
                  {PLATFORM_LABEL[provider.platform]}: {provider.setup_reason ? `needs setup — ${provider.setup_reason}` : "ready"}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </header>

      <div className="shows-layout retrieval-layout">
        <section className="shows-list" aria-labelledby={listTitleId}>
          <div className="shows-list-head">
            <h2 id={listTitleId}>Searches</h2>
            <div className="shows-list-actions">
              <button type="button" className="btn primary" disabled={locked} onClick={startNew}>
                New search
              </button>
              <button type="button" className="btn" disabled={refreshing} onClick={refreshNow} title="Reload search status and collection history from the server">
                {refreshing ? "Refreshing…" : "Refresh status"}
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

          {status === null ? (
            <div className="empty">{listError ? "Searches unavailable." : "Loading searches…"}</div>
          ) : sources.length === 0 ? (
            <div className="empty">No searches yet. Add the first YouTube or Reddit search.</div>
          ) : (
            <ul className="show-cards feed-cards retrieval-cards" aria-label="Discovery searches">
              {sources.map((source) => {
                const selected = draft?.id === source.id
                const running = inProgress(source, collecting)
                const rowTone = tone(source, collecting)
                const latest = source.latest_run
                return (
                  <li key={source.id}>
                    <button
                      type="button"
                      className={`show-card feed-card retrieval-card${selected ? " on" : ""}`}
                      aria-current={selected ? "true" : undefined}
                      aria-label={`Open ${source.name}`}
                      disabled={locked}
                      onClick={() => openSource(source)}
                    >
                      <span className="show-card-name">
                        <span className={`retrieval-tag platform-${source.platform}`}>{PLATFORM_LABEL[source.platform]}</span>
                        {source.name}
                        {source.enabled ? null : <span className="feed-tag">Paused</span>}
                        {source.setup_reason ? <span className="feed-tag">Needs setup</span> : null}
                      </span>
                      <span className="show-card-meta retrieval-target">
                        {searchTarget(source)} · {formatClock(source.default_duration)}
                      </span>
                      <span className={`show-card-meta feed-status ${rowTone}`} data-status={rowTone}>
                        {running ? "Collecting…" : runSummary(latest)}
                        {latest && !running ? ` · ${stampLabel(latest.finished_at ?? latest.started_at)}` : ""}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="show-editor sources-editor retrieval-editor" aria-labelledby={editorTitleId} aria-busy={locked || undefined}>
          <h2 id={editorTitleId} className="visually-hidden">
            Search editor
          </h2>
          {draft === null ? (
            <>
              <div className="empty">Nothing open. Pick a search on the left or add a new one.</div>
              <footer className="publish-bar show-bar sources-bar">
                <p className={`publish-status${notice?.kind === "error" ? " error" : ""}`} aria-live="polite">
                  {statusText}
                </p>
              </footer>
            </>
          ) : (
            <>
              <form className="inbox-form feed-form retrieval-form" aria-label={draft.id === null ? "New search" : "Edit search"} onSubmit={(event) => void save(event)}>
                {conflict ? (
                  <div className="banner error" role="alert">
                    <p>
                      <strong>Not saved.</strong> {CHANGED_ELSEWHERE} Your edits are kept here and nothing is overwritten. Reloading shows the newer version and discards your edits; keep editing to copy what you need first.
                    </p>
                    <div className="banner-actions">
                      <button type="button" className="btn" disabled={locked} onClick={() => void reloadLatest()}>
                        Reload and discard my edits
                      </button>
                      <button type="button" className="btn" disabled={locked} onClick={() => setConflict(null)}>
                        Keep editing
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="inbox-fields retrieval-grid">
                  <label className="field grow" htmlFor={nameId}>
                    <span>Search name</span>
                    <input
                      id={nameId}
                      ref={nameRef}
                      aria-label="Search name"
                      aria-invalid={nameProblem ? true : undefined}
                      className="show-name"
                      disabled={readOnly}
                      maxLength={MAX_SEARCH_NAME * 2}
                      placeholder="How the search appears in the Inbox"
                      value={draft.name}
                      onChange={(event) => edit({ name: event.target.value })}
                    />
                  </label>
                  <label className="field retrieval-platform" htmlFor={platformId}>
                    <span>Platform</span>
                    <select id={platformId} aria-label="Platform" disabled={readOnly} value={draft.platform} onChange={(event) => edit({ platform: event.target.value === "reddit" ? "reddit" : "youtube" })}>
                      {PLATFORMS.map((platform) => (
                        <option key={platform} value={platform}>
                          {PLATFORM_LABEL[platform]}
                          {providerReason(platform) ? " (needs setup)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="inbox-fields retrieval-grid">
                  <label className="field grow" htmlFor={queryId}>
                    <span>Keywords</span>
                    <input
                      id={queryId}
                      aria-label="Keywords"
                      aria-invalid={keywordsProblem || (targetIssue && hasSearchWork(draft)) ? true : undefined}
                      disabled={readOnly}
                      maxLength={MAX_QUERY * 2}
                      placeholder={draft.platform === "youtube" ? "AI fashion tools" : "AI creative tools"}
                      value={draft.query}
                      onChange={(event) => edit({ query: event.target.value })}
                    />
                  </label>
                  <label className="field grow" htmlFor={scopeId}>
                    <span>{scopeLabel(draft.platform)}</span>
                    <input
                      id={scopeId}
                      aria-label={draft.platform === "youtube" ? "Channel ID" : "Subreddit"}
                      aria-invalid={scopeIssue ? true : undefined}
                      disabled={readOnly}
                      maxLength={MAX_SCOPE * 2}
                      placeholder={scopePlaceholder(draft.platform)}
                      spellCheck={false}
                      value={draft.scope}
                      onChange={(event) => edit({ scope: event.target.value })}
                    />
                  </label>
                </div>
                <div className="inbox-source-meta">
                  <span className="notes-hint">
                    {draft.platform === "youtube"
                      ? "Keywords, a channel ID, or both. Channel URLs and @handles are not resolved: paste the UC… ID."
                      : "Keywords, a subreddit, or both. Subreddit URLs are not resolved: type the name, with or without r/."}
                  </span>
                </div>

                <div className="inbox-fields retrieval-grid">
                  <label className="field seconds retrieval-number" htmlFor={freshnessId}>
                    <span>Newer than (hours)</span>
                    <input
                      id={freshnessId}
                      aria-label="Freshness in hours"
                      aria-invalid={freshnessIssue ? true : undefined}
                      disabled={readOnly}
                      inputMode="numeric"
                      min={MIN_FRESHNESS_HOURS}
                      max={MAX_FRESHNESS_HOURS}
                      step={1}
                      type="number"
                      value={Number.isNaN(draft.freshness_hours) ? "" : draft.freshness_hours}
                      onChange={(event) => edit({ freshness_hours: event.target.valueAsNumber })}
                    />
                  </label>
                  <label className="field seconds retrieval-number" htmlFor={limitId}>
                    <span>Result limit</span>
                    <input
                      id={limitId}
                      aria-label="Result limit"
                      aria-invalid={limitIssue ? true : undefined}
                      disabled={readOnly}
                      inputMode="numeric"
                      min={MIN_RESULTS}
                      max={MAX_RESULTS}
                      step={1}
                      type="number"
                      value={Number.isNaN(draft.limit) ? "" : draft.limit}
                      onChange={(event) => edit({ limit: event.target.valueAsNumber })}
                    />
                  </label>
                  <label className="field seconds retrieval-number" htmlFor={durationId}>
                    <span>Default seconds</span>
                    <input
                      id={durationId}
                      aria-label="Default duration"
                      aria-invalid={durationIssue ? true : undefined}
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

                <label className="check feed-enabled" htmlFor={enabledId}>
                  <input id={enabledId} type="checkbox" aria-label="Active" disabled={readOnly} checked={draft.enabled} onChange={(event) => edit({ enabled: event.target.checked })} />
                  Active
                  <span className="quick-add-publish-hint">{draft.enabled ? "Collect now is available once saved." : "Paused: collections are refused until it is turned on again."}</span>
                </label>

                <p className="retrieval-limits notes-hint">{retainedText(draft.platform)} Source links are kept so you can open the original.</p>

                <footer className="publish-bar show-bar sources-bar">
                  <p className={`publish-status${notice?.kind === "error" ? " error" : ""}`} aria-live="polite">
                    {statusText}
                  </p>
                  <div className="publish-actions show-actions">
                    {dirty ? (
                      <button type="button" className="btn" disabled={locked} onClick={discardEdits}>
                        {draft.id === null ? "Discard new search" : "Discard edits"}
                      </button>
                    ) : null}
                    <button type="submit" className="btn primary" disabled={locked || !dirty || problem !== null || conflict !== null}>
                      {pending === "save" ? "Saving…" : draft.id === null ? "Add search" : "Save search"}
                    </button>
                  </div>
                </footer>
              </form>

              {draft.id !== null ? (
                <>
                  <section className="reuse import-panel retrieval-collect" aria-labelledby={collectTitleId} aria-busy={collecting.has(draft.id) || undefined}>
                    <h3 id={collectTitleId}>Collect</h3>
                    <p>
                      Sends one request to {PLATFORM_LABEL[draft.base.platform]} for {searchTarget(draft.base) || "this search"} and adds results it has not seen before to the Inbox as ideas, with the original text and link kept. {retainedText(draft.base.platform)} Results may be empty. Next step: review them in the Inbox, then rank them in Research.
                    </p>
                    <div className="inline-form-actions import-actions">
                      <button type="button" className="btn primary" disabled={collectBlock !== null || openAttempt !== null} onClick={() => void collect("fresh")}>
                        {collecting.has(draft.id) ? "Collecting…" : "Collect now"}
                      </button>
                      {collectBlock ? (
                        <span className="reuse-hint import-block" role="status">
                          {collectBlock}
                        </span>
                      ) : null}
                    </div>
                    {openAttempt && !collecting.has(draft.id) ? (
                      <div className="banner warn retrieval-attempt" role="status" data-testid="retrieval-attempt">
                        <p>
                          <strong>Unconfirmed request.</strong> The request started {stampLabel(openAttempt.startedAt)} got no confirmed answer, so it may or may not have run. Retrying sends the very same request id: the server returns the original attempt if it ran, or starts it if it never arrived. Either way only one platform request is spent.
                        </p>
                        <div className="banner-actions">
                          <button type="button" className="btn primary" onClick={() => void collect("retry")}>
                            Retry the same request
                          </button>
                          <button type="button" className="btn" onClick={() => draft.id && void refreshRuns(draft.id)}>
                            Check history
                          </button>
                          <button type="button" className="btn" onClick={dropAttempt}>
                            Set aside
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {info && info.latest_run?.status === "interrupted" && !shownResult && !openAttempt ? (
                      <div className="banner warn" role="status">
                        <p>The last collection did not finish within its two-minute lease (the server may have been interrupted). Nothing is retried on its own: press Collect now to start a new attempt.</p>
                      </div>
                    ) : null}
                    {shownResult ? (
                      shownResult.status === "failed" ? (
                        <div className="banner error import-result" role="alert" data-run-status="failed">
                          <p>
                            <strong>Collection failed.</strong> {shownResult.error ?? "The platform could not be read."} Nothing was added to the Inbox. Nothing is retried on its own.
                          </p>
                        </div>
                      ) : shownResult.status === "running" || shownResult.status === "interrupted" ? (
                        <div className="banner warn import-result" role="status" data-run-status={shownResult.status}>
                          <p>{shownResult.status === "running" ? "The collection is still running. Press Refresh status to see its result." : "That attempt was interrupted before it finished. Press Collect now to start a new one."}</p>
                        </div>
                      ) : (
                        <div className={`banner ${shownResult.created > 0 ? "success" : "warn"} import-result`} role="status" data-run-status="succeeded">
                          <p>
                            <strong>{shownResult.created > 0 ? "Collected." : "Nothing new."}</strong> {runCounts(shownResult)}.{" "}
                            {shownResult.created > 0
                              ? `New ideas are waiting in the Inbox with the original ${draft.base.platform === "youtube" ? "video description" : "post text"} and link. Review them there, then rank them in Research.`
                              : shownResult.duplicates > 0
                                ? "Every result was already in the Inbox."
                                : "The platform returned no results for this search."}
                            {shownResult.mode === "fixture" ? " (Fixture data.)" : ""}
                          </p>
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

                  <section className="reuse run-history retrieval-history" aria-labelledby={historyTitleId}>
                    <h3 id={historyTitleId}>Collection history</h3>
                    <p>Last 20 attempts, newest first. Every attempt is kept, including failures and interrupted ones.</p>
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
                      <p className="reuse-hint">No collections yet.</p>
                    ) : (
                      <ol className="run-list" aria-label="Collection runs">
                        {runs.map((run) => (
                          <li key={run.id} className={`run-row ${run.status === "interrupted" ? "failed" : run.status}`} data-run-id={run.id} data-run-status={run.status}>
                            <div className="run-head">
                              <span className={`run-status ${run.status === "interrupted" ? "failed" : run.status}`}>
                                {statusWord(run.status)}
                                {run.mode === "fixture" ? <span className="feed-tag run-tag">Fixture</span> : null}
                              </span>
                              <span className="run-when">
                                {stampLabel(run.started_at)}
                                {run.finished_at ? ` → ${stampLabel(run.finished_at)}` : run.status === "running" ? " · still running" : ""}
                              </span>
                            </div>
                            <div className="run-counts">{runCounts(run)}</div>
                            {run.error ? <p className="run-error">{run.error}</p> : null}
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

      {guard ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby={`${dialogTitleId}-guard`}>
            <h2 id={`${dialogTitleId}-guard`}>Unsaved changes</h2>
            <p>
              {draft?.id === null ? "Your new search has not been saved." : `"${draft?.name}" has unsaved changes.`}{" "}
              {guard.kind === "open" ? `Opening "${guard.name}" will discard them.` : "Starting a new search will discard them."}
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
    </section>
  )
}
