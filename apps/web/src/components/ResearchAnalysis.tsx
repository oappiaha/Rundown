import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { FormEvent } from "react"
import {
  ApiError,
  generateResearchAnalysis,
  getResearchAnalysis,
  getResearchAnalysisRun,
  previewResearchAnalysisInput,
  proposeFromResearchAnalysis,
  type AnalysisRun,
  type AnalysisSettings,
  type AnalysisStatus,
  type ResearchCategory,
  type ResearchCategoryId,
  type ResearchItem,
  type ResearchList,
} from "../lib/api"
import { indexStories, storyCount } from "../lib/researchDraft"
import {
  MAX_ANALYSIS,
  MAX_BRIEF,
  MAX_PROPOSE,
  MIN_BRIEF,
  MIN_PROPOSE,
  analysisIntentKey,
  analysisSelections,
  briefProblem,
  choiceProblem,
  choicesFrom,
  defaultProposeCount,
  groupItems,
  previewCurrent,
  rankedItems,
  requestIdFor,
  runProblem,
  titleFor,
  toggleChoice,
  validProposeCount,
  type InputPreview,
  type IntentId,
  type PendingRequest,
} from "../lib/analysisDraft"

type Props = {
  /** The Research view is off screen: keep state, stop polling. */
  hidden: boolean
  /** The loaded catalog (null until the first load); the panel never fetches stories itself. */
  items: ResearchItem[] | null
  categories: ResearchCategory[]
  /** Current shortlist ids, offered as an explicit starting point for the chosen set. */
  shortlist: string[]
  /** The owner is busy (its own requests or this panel's); every action waits. */
  locked: boolean
  /** Reports this panel's in-flight requests so the owner freezes the composer meanwhile. */
  onBusy: (busy: boolean) => void
  /** Reload the catalog (the owner's Refresh); used to catch external changes on demand. */
  onRefreshStories: () => Promise<ResearchList | null>
  /** Hand an AI-ranked proposal to the owner, which adopts it through its guarded replace dialog. */
  onProposal: (proposal: { items: ResearchItem[]; warnings: string[] }) => void
}

type Notice = { kind: "info" | "error"; text: string }
type Pending = "status" | "input" | "generate" | "propose" | null

const POLL_MS = 2000
const count = new Intl.NumberFormat("en-US")

function describeError(error: unknown, what: string): string {
  if (error instanceof ApiError) return `${what} rejected (${error.status}): ${error.detail}`
  return `${what} failed: the RUNDOWN API did not respond.`
}

function providerLabel(settings: AnalysisSettings | null): string {
  if (!settings) return "the configured provider"
  if (settings.mode === "fixture") return "the test fixture"
  return settings.model ? `Anthropic (${settings.model})` : "Anthropic"
}

function whenLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "unknown time"
  return date.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" })
}

function labelFor(categories: ResearchCategory[], id: ResearchCategoryId): string {
  return categories.find((category) => category.id === id)?.label ?? id
}

/**
 * Optional AI analysis inside Research. Separate from the local ranking on
 * the left: the user ticks up to 20 stories, writes a brief, previews the
 * exact text the API would send, ticks consent and only then sends one
 * provider call. The result (scores, suggested categories, same-event groups,
 * reasons) is shown here only; a proposal built from it goes through the
 * owner's guarded shortlist dialog and the existing preview/save. Nothing here
 * edits stories, curation or the live show.
 */
export default function ResearchAnalysis({ hidden, items, categories, shortlist, locked, onBusy, onRefreshStories, onProposal }: Props) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<AnalysisStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [choices, setChoices] = useState<string[]>([])
  const [brief, setBrief] = useState("")
  const [preview, setPreview] = useState<InputPreview | null>(null)
  /** Intent key the consent tick was given for; consent never carries over to a different input. */
  const [consentKey, setConsentKey] = useState<string | null>(null)
  const [run, setRun] = useState<AnalysisRun | null>(null)
  /** A run the server refused to propose from (409): treated as stale here until a new analysis. */
  const [rejectedRunId, setRejectedRunId] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [ambiguous, setAmbiguousState] = useState<PendingRequest | null>(null)
  const [proposeCount, setProposeCount] = useState(MIN_PROPOSE)

  const intentRef = useRef<IntentId | null>(null)
  /** Mirror of `ambiguous` for async code that decides after an await. */
  const ambiguousRef = useRef<PendingRequest | null>(null)
  const setAmbiguous = useCallback((next: PendingRequest | null) => {
    ambiguousRef.current = next
    setAmbiguousState(next)
  }, [])
  const statusSeq = useRef(0)
  const loadedOnce = useRef(false)
  const panelId = useId()
  const briefId = useId()
  const consentId = useId()
  const countId = useId()
  const choicesTitleId = useId()

  useEffect(() => {
    onBusy(pending !== null)
  }, [pending, onBusy])

  // ---- Status --------------------------------------------------------------------
  /**
   * Provider readiness and the latest run, never starting a call. By default
   * the latest run is adopted for display (it may have been started elsewhere
   * or before a reload); `adoptRun: false` refreshes the settings only, so a
   * result just recovered by its exact id is not overwritten by a newer,
   * unrelated latest run.
   */
  const loadStatus = useCallback(async (options: { adoptRun: boolean } = { adoptRun: true }): Promise<AnalysisStatus | null> => {
    const token = ++statusSeq.current
    try {
      const next = await getResearchAnalysis()
      if (token !== statusSeq.current) return null
      setStatus(next)
      setStatusError(null)
      loadedOnce.current = true
      if (next.latest_run && options.adoptRun) {
        const latest = next.latest_run
        setRun(latest)
        if (ambiguousRef.current && ambiguousRef.current.requestId === latest.id) {
          intentRef.current = null
          setAmbiguous(null)
          setNotice({ kind: "info", text: "The earlier request had reached the API; its analysis is shown below. Nothing was sent again." })
        }
      }
      return next
    } catch (error) {
      if (token !== statusSeq.current) return null
      setStatusError(describeError(error, "Loading the AI setup"))
      return null
    }
  }, [setAmbiguous])

  useEffect(() => {
    if (hidden || loadedOnce.current) return
    void loadStatus()
  }, [hidden, loadStatus])

  const running = run?.status === "running"

  // A run in progress (started here before a reload, or elsewhere) is followed by polling its id; no provider call is made.
  useEffect(() => {
    if (hidden || !running || run === null) return
    const id = run.id
    const timer = setInterval(() => {
      void getResearchAnalysisRun(id)
        .then((next) => {
          setRun((current) => (current && current.id === id ? next : current))
          if (next.status !== "running") void loadStatus({ adoptRun: false })
        })
        .catch(() => undefined)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [hidden, running, run, loadStatus])

  // ---- Derived --------------------------------------------------------------------
  const byId = indexStories(items ?? [])
  const settings = status?.settings ?? null
  const selections = analysisSelections(choices, byId)
  const choiceProb = choiceProblem(choices, byId)
  const briefProb = briefProblem(brief)
  const key = selections !== null && briefProb === null ? analysisIntentKey(brief, selections) : null
  const previewOk = previewCurrent(preview, key)
  const consent = previewOk && consentKey !== null && consentKey === key
  const excludedCount = (items ?? []).filter((item) => item.preferences.excluded).length
  const busy = locked || pending !== null

  const generateBlock: string | null =
    items === null
      ? "Waiting for the stories to load."
      : status === null
        ? (statusError ?? "Checking the AI setup…")
        : !settings?.ready
          ? (settings?.reason ?? "AI analysis is not available.")
          : settings.remaining_today <= 0
            ? "The daily analysis limit is reached; it resets at midnight UTC."
            : running
              ? "An analysis is running. Wait for its result before starting another."
              : ambiguous
                ? "The last request got no answer. Check status, resend it or forget it before starting a new one."
                : (choiceProb ?? briefProb ?? (!previewOk ? "Preview the exact input before analyzing." : !consent ? "Tick the consent box to send this input." : null))

  const runProb = run !== null && run.id === rejectedRunId ? "The server refused a suggestion from this analysis: the stories changed. Analyze the current stories again." : runProblem(run, byId)
  const proposeBlock: string | null = runProb ?? (!validProposeCount(proposeCount) ? `Ask for ${MIN_PROPOSE}–${MAX_PROPOSE} stories.` : null)

  // ---- Choices and brief ---------------------------------------------------------------
  function toggle(id: string) {
    if (busy) return
    setChoices((ids) => toggleChoice(ids, id))
    setConsentKey(null) // consent belongs to one previewed input; any change asks for it again
    setNotice(null)
  }

  function useShortlist() {
    if (busy) return
    const next = choicesFrom(shortlist, byId)
    setChoices(next)
    setConsentKey(null)
    setNotice({ kind: "info", text: next.length === 0 ? "The shortlist has no story that can be analyzed." : `Ticked the ${storyCount(next.length)} of the shortlist. Nothing is sent until you preview and analyze.` })
  }

  function clearChoices() {
    if (busy) return
    setChoices([])
    setConsentKey(null)
    setNotice(null)
  }

  /** Copy a shown run's brief and stories back into the form, explicitly, so it can be re-analyzed after a change. */
  function reuseRun() {
    if (busy || run === null) return
    setBrief(run.brief)
    setChoices(choicesFrom(run.selections.map((entry) => entry.id), byId))
    setConsentKey(null)
    setNotice({ kind: "info", text: "Brief and stories copied from the analysis. Preview the input and analyze again when ready." })
  }

  // ---- Input preview -----------------------------------------------------------------
  async function makeInput() {
    if (busy || selections === null || key === null || choiceProb !== null || briefProb !== null) return
    const frozenBrief = brief.trim()
    const frozenSelections = selections
    const frozenKey = key
    setPending("input")
    setNotice(null)
    try {
      const result = await previewResearchAnalysisInput(frozenBrief, frozenSelections)
      setPreview({ key: frozenKey, brief: frozenBrief, selections: frozenSelections, inputText: result.input_text, inputHash: result.input_hash, truncated: result.input_truncated, rejected: false })
      setConsentKey(null)
      setStatus((current) => (current ? { ...current, settings: result.settings } : current))
      setNotice({ kind: "info", text: `Input ready · ${count.format(result.input_text.length)} characters for ${storyCount(frozenSelections.length)}. Nothing was sent.` })
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setPreview((current) => (current ? { ...current, rejected: true } : current))
        setNotice({ kind: "error", text: `Input not available: ${error.detail} Your brief and ticks are kept; refreshing the stories now.` })
        await onRefreshStories()
      } else {
        setNotice({ kind: "error", text: describeError(error, "Previewing the input") })
      }
    } finally {
      setPending(null)
    }
  }

  // ---- Generate ------------------------------------------------------------------------
  /** The one explicit provider call, sent with exactly the previewed input; a reuse resends an unanswered request verbatim. */
  async function generate(reuse: PendingRequest | null) {
    if (busy) return
    let body: PendingRequest
    if (reuse) body = reuse
    else {
      if (generateBlock !== null || preview === null || key === null) return
      const intent = requestIdFor(intentRef.current, key, preview.inputHash)
      intentRef.current = intent
      body = { requestId: intent.requestId, key, inputHash: preview.inputHash, brief: preview.brief, selections: preview.selections }
    }
    setPending("generate")
    setNotice(null)
    setAmbiguous(null)
    try {
      const result = await generateResearchAnalysis({ brief: body.brief, selections: body.selections, request_id: body.requestId, input_hash: body.inputHash, consent: true })
      setConsentKey(null) // one tick, one attempt: a residual tick never arms a second click
      setRun(result)
      setRejectedRunId(null)
      if (result.status !== "running") intentRef.current = null
      if (result.status === "succeeded") {
        setProposeCount(defaultProposeCount(result))
        setNotice({ kind: "info", text: `Analysis ready · ${storyCount(result.items.length)} scored by ${providerLabel(settings)}. Suggestions only: nothing was changed or saved.` })
      } else if (result.status === "running") {
        setNotice({ kind: "info", text: "Still analyzing. This panel checks again every few seconds." })
      } else {
        setNotice({ kind: "error", text: result.status === "interrupted" ? "The analysis was interrupted. No stories were changed; start a new analysis when ready." : `The analysis failed: ${result.error ?? "the provider returned no usable result."} Start a new analysis when ready; nothing is retried by itself.` })
      }
      setPending(null)
      await loadStatus({ adoptRun: false }) // usage counters; the run just answered stays on screen
    } catch (error) {
      setConsentKey(null)
      if (error instanceof ApiError) {
        if (error.status === 409) setPreview((current) => (current ? { ...current, rejected: true } : current))
        const text =
          error.status === 409
            ? `Not analyzed: ${error.detail} Your brief and ticks are kept; preview the input again.`
            : error.status === 503 || error.status === 429 || error.status === 422
              ? `Not analyzed: ${error.detail} Your brief and ticks are kept.`
              : describeError(error, "Analyze")
        setNotice({ kind: "error", text })
        setPending(null)
        await loadStatus()
        if (error.status === 409) await onRefreshStories()
      } else {
        setAmbiguous(body)
        setNotice({ kind: "error", text: "No answer from the RUNDOWN API. The request may still have reached it: check status first; resending uses the same request id, so the provider is never asked twice." })
        setPending(null)
      }
    } finally {
      setPending(null)
    }
  }

  /**
   * Look for the unanswered request by its exact id (not merely the latest
   * run: a later analysis may have overtaken it). Found means it reached the
   * API: its result is adopted and shown, whatever the brief is now, with no
   * new call. Returns "found", "missing" (404: it never arrived) or "unknown".
   */
  async function checkAmbiguous(request: PendingRequest): Promise<"found" | "missing" | "unknown"> {
    try {
      const found = await getResearchAnalysisRun(request.requestId)
      setRun(found)
      setRejectedRunId(null)
      intentRef.current = null
      setAmbiguous(null)
      setConsentKey(null)
      if (found.status === "succeeded") setProposeCount(defaultProposeCount(found))
      setNotice({ kind: "info", text: `The earlier request had reached the API; its analysis (${found.status}) is shown below. Nothing was sent again.` })
      void loadStatus({ adoptRun: false }) // usage counters only; the recovered run stays on screen
      return "found"
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setNotice({ kind: "info", text: "That request never reached the API. Resending sends the identical request with the same id; forgetting it starts over." })
        return "missing"
      }
      setNotice({ kind: "error", text: describeError(error, "Checking the earlier request") })
      return "unknown"
    }
  }

  async function checkStatus() {
    const request = ambiguous
    if (!request || busy) return
    setPending("status")
    try {
      await checkAmbiguous(request)
    } finally {
      setPending(null)
    }
  }

  /** Resolve an unanswered request: its exact id is looked up first; only when it never arrived and the input is unchanged is the identical request resent. */
  async function resend() {
    const request = ambiguous
    if (!request || busy) return
    setPending("status")
    let outcome: "found" | "missing" | "unknown"
    let latest: AnalysisStatus | null
    try {
      outcome = await checkAmbiguous(request)
      latest = outcome === "missing" ? await loadStatus() : null
    } finally {
      setPending(null)
    }
    if (outcome !== "missing" || latest === null) return
    if (key !== request.key || !previewOk) {
      setNotice({ kind: "error", text: "Not resent: the brief or the ticked stories changed since that request. Forget it to start a new analysis of the current input." })
      return
    }
    if (!latest.settings.ready || latest.latest_run?.status === "running") {
      setNotice({ kind: "error", text: `Not resent: ${latest.settings.reason ?? "another analysis is running."} The earlier request is kept.` })
      return
    }
    await generate(request)
  }

  function forgetRequest() {
    setAmbiguous(null)
    intentRef.current = null
    setNotice({ kind: "info", text: "The unanswered request was set aside. A new analysis gets a fresh request id." })
  }

  async function refresh() {
    if (busy) return
    setPending("status")
    setNotice(null)
    try {
      await Promise.all([onRefreshStories(), loadStatus()])
    } finally {
      setPending(null)
    }
  }

  // ---- Propose -----------------------------------------------------------------------
  async function propose(event: FormEvent) {
    event.preventDefault()
    if (busy || run === null || proposeBlock !== null) return
    setPending("propose")
    setNotice(null)
    try {
      const result = await proposeFromResearchAnalysis(run.id, proposeCount)
      setNotice({ kind: "info", text: `AI suggestion: ${storyCount(result.items.length)} by AI rank. It replaces the shortlist only after you confirm; nothing is saved.` })
      onProposal({ items: result.items, warnings: result.warnings })
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setRejectedRunId(run.id)
        setNotice({ kind: "error", text: `No AI suggestion: ${error.detail} Your shortlist, brief and ticks are kept.` })
        setPending(null)
        await Promise.all([onRefreshStories(), loadStatus()])
      } else {
        setNotice({ kind: "error", text: describeError(error, "Suggesting from the analysis") })
      }
    } finally {
      setPending(null)
    }
  }

  // ---- Render --------------------------------------------------------------------------
  const fixture = settings?.mode === "fixture"
  const summaryLine = status === null ? (statusError ? "Setup unavailable" : "Checking setup…") : settings?.ready ? `${fixture ? "Test fixture" : "Ready"} · ${settings.model || "no model"}` : "Off"
  const statusText = notice
    ? notice.text
    : pending === "generate"
      ? `Analyzing with ${providerLabel(settings)}…`
      : pending === "input"
        ? "Previewing the exact input…"
        : pending === "propose"
          ? "Asking for an AI-ranked suggestion…"
          : pending === "status"
            ? "Refreshing…"
            : running
              ? "Analyzing… checking every few seconds."
              : (generateBlock ?? "Ready. Analyze sends the previewed input once.")

  function renderConfig(config: AnalysisSettings) {
    return (
      <div className="prep-config">
        <div className="prep-config-line">
          {config.mode === "fixture" ? (
            <span className="prep-badge fixture" data-testid="ai-fixture-badge">
              Test fixture
            </span>
          ) : null}
          <span className={`prep-badge ${config.ready ? "ready" : "off"}`} data-testid="ai-ready-badge">
            {config.ready ? "Ready" : "Off"}
          </span>
          <span className="prep-config-meta" data-testid="ai-config-meta">
            {config.model || "no model"} · {count.format(config.used_today)} of {count.format(config.daily_limit)} analyses used today · {count.format(config.remaining_today)} left · failed and interrupted attempts count · up to {config.max_stories} stories per analysis
            {config.mode === "fixture" ? " · no real provider is called" : ""}
          </span>
        </div>
        {!config.ready ? (
          <div className="prep-setup" data-testid="ai-setup">
            <p>
              <strong>Not available:</strong> {config.reason ?? "AI analysis is not configured."} Ask the server owner to configure the Anthropic key and model on the API; keys are never entered or shown here. Local research keeps working.
            </p>
          </div>
        ) : null}
      </div>
    )
  }

  function renderRun(shown: AnalysisRun) {
    const ranked = rankedItems(shown)
    const groups = groupItems(shown).filter((group) => group.items.length > 1)
    const sizes = new Map(groupItems(shown).map((group) => [group.representativeId, group.items.length]))
    return (
      <section className="ai-run" aria-label="AI analysis result" data-testid="ai-run" data-status={shown.status} data-usable={runProb === null ? "true" : "false"}>
        <div className="prep-result-head">
          <span className="field-label">
            Analysis · {shown.model || "model"} · {shown.mode === "fixture" ? "test fixture, no real provider" : "live provider"} · {shown.status} · {whenLabel(shown.started_at)}
            {shown.input_tokens !== null || shown.output_tokens !== null ? ` · ${count.format(shown.input_tokens ?? 0)} in / ${count.format(shown.output_tokens ?? 0)} out tokens` : ""}
          </span>
          <button type="button" className="btn small" disabled={busy} onClick={reuseRun}>
            Use its brief and stories
          </button>
        </div>
        <p className="ai-brief" data-testid="ai-run-brief">
          <span className="field-label">Brief</span> {shown.brief}
        </p>
        {shown.status === "failed" || shown.status === "interrupted" ? (
          <div className="banner error" role="status" data-testid="ai-run-error">
            <p>
              <strong>{shown.status === "failed" ? "Failed." : "Interrupted."}</strong> {shown.error ?? "No usable result came back. No stories were changed."} Start a new analysis when ready; this one is not retried by itself.
            </p>
          </div>
        ) : null}
        {shown.status === "running" ? <p className="notes-hint">Still running. The result appears here when it is ready; nothing is sent again.</p> : null}
        {shown.status === "succeeded" ? (
          <>
            {runProb ? (
              <div className="banner warn" role="status" data-testid="ai-run-stale">
                <p>{runProb}</p>
              </div>
            ) : null}
            <p className="notes-hint">Scores are editorial suggestions from the brief and the saved text, not facts, popularity or engagement. Your saved categories stay in charge; a differing suggestion is only shown.</p>
            <ol className="ai-ranking" aria-label="AI ranking">
              {ranked.map((entry, index) => {
                const item = byId.get(entry.id)
                const manual = item?.preferences.category ?? null
                const size = sizes.get(entry.group_id) ?? 1
                return (
                  <li key={entry.id} className="ai-row" data-testid="ai-row" data-story-id={entry.id}>
                    <span className="ai-score" aria-label={`Rank ${index + 1}, score ${entry.score}`}>
                      {entry.score}
                    </span>
                    <div className="ai-row-body">
                      <span className="ai-title" data-testid="ai-row-title">
                        {titleFor(entry.id, byId)}
                      </span>
                      <span className="story-meta">
                        {manual !== null ? (
                          <span className="story-tag" data-testid="ai-row-category">
                            Your category: {labelFor(categories, manual)} · kept
                            {manual !== entry.category ? ` (AI suggested ${labelFor(categories, entry.category)})` : ""}
                          </span>
                        ) : (
                          <span className="story-tag" data-testid="ai-row-category">
                            AI suggests {labelFor(categories, entry.category)}
                            {item && item.category !== entry.category ? ` (keyword suggestion: ${labelFor(categories, item.category)})` : ""}
                          </span>
                        )}
                        {item?.preferences.pinned ? <span className="story-tag pinned">Pinned</span> : null}
                        {size > 1 ? (
                          <span className="story-tag coverage" data-testid="ai-row-group">
                            {entry.group_id === entry.id ? `Represents ${storyCount(size)} on the same event` : `Same event as "${titleFor(entry.group_id, byId)}"`}
                          </span>
                        ) : null}
                        {item === undefined ? <span className="story-tag excluded">No longer in the inbox</span> : null}
                      </span>
                      <p className="ai-reason" data-testid="ai-row-reason">
                        {entry.reason}
                      </p>
                    </div>
                  </li>
                )
              })}
            </ol>
            <div className="ai-groups" data-testid="ai-groups">
              <span className="field-label">Same-event groups</span>
              {groups.length === 0 ? (
                <p className="notes-hint">No stories were grouped as reports of the same event.</p>
              ) : (
                <ul className="ai-group-list">
                  {groups.map((group) => (
                    <li key={group.representativeId} data-testid="ai-group">
                      <strong>{titleFor(group.representativeId, byId)}</strong> · {storyCount(group.items.length)}: {group.items.map((entry) => titleFor(entry.id, byId)).join(" · ")}
                    </li>
                  ))}
                </ul>
              )}
              <p className="notes-hint">Grouping is advisory: a suggestion picks one story per group, and nothing is merged or deleted.</p>
            </div>
            <form className="ai-propose" aria-label="Suggest a shortlist from the analysis" onSubmit={propose}>
              <label className="field seconds" htmlFor={countId}>
                <span>AI shortlist size</span>
                <input id={countId} type="number" inputMode="numeric" min={MIN_PROPOSE} max={MAX_PROPOSE} step={1} aria-invalid={validProposeCount(proposeCount) ? undefined : true} disabled={busy} value={Number.isNaN(proposeCount) ? "" : proposeCount} onChange={(event) => setProposeCount(event.target.valueAsNumber)} />
              </label>
              <button type="submit" className="btn primary" disabled={busy || proposeBlock !== null} title={proposeBlock ?? undefined}>
                {pending === "propose" ? "Suggesting…" : "Suggest shortlist from AI"}
              </button>
              <span className="notes-hint">By AI rank within the analyzed stories: pins first, one per same-event group; it may return fewer. Replaces the shortlist only after you confirm, and you can still reorder, add or remove stories.</span>
            </form>
          </>
        ) : null}
      </section>
    )
  }

  return (
    <section className="ai-panel" aria-labelledby={`${panelId}-title`} data-testid="ai-panel" aria-busy={pending !== null || undefined}>
      <div className="ai-head">
        <button type="button" className={`notes-toggle${open ? " has-notes" : ""}`} aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen((value) => !value)}>
          <span className="notes-chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span id={`${panelId}-title`}>AI analysis · optional</span>
        </button>
        <span className="head-lbl" data-testid="ai-summary">
          {summaryLine}
          {running ? " · running" : ""}
        </span>
      </div>

      {open ? (
        <div id={panelId} className="ai-body">
          <p className="ai-intro">
            The list on the left is local research: your curation, freshness and saved context, with keyword categories. This panel is optional AI analysis: tick up to {MAX_ANALYSIS} stories, describe the show angle, preview the exact text that would leave the API, and only then send it with one deliberate click. Scores, categories and groups come back as suggestions shown here; nothing is changed, saved or put on air by itself.
          </p>

          <div className="prep-head">
            <span className="field-label">Setup</span>
            <button type="button" className="btn small" disabled={busy} onClick={() => void refresh()}>
              {pending === "status" ? "Refreshing…" : "Refresh status"}
            </button>
          </div>
          {statusError && status === null ? (
            <div className="banner error" role="status">
              <p>{statusError}</p>
              <div className="banner-actions">
                <button type="button" className="btn" disabled={busy} onClick={() => void loadStatus()}>
                  Retry
                </button>
              </div>
            </div>
          ) : settings ? (
            renderConfig(settings)
          ) : (
            <p className="prep-status">Checking the AI setup…</p>
          )}

          <div className="ai-choose" aria-labelledby={choicesTitleId}>
            <div className="prep-head">
              <span className="field-label" id={choicesTitleId}>
                1 · Choose stories to analyze
              </span>
              <span className="head-lbl" data-testid="ai-choice-count">
                {choices.length} of {MAX_ANALYSIS} ticked
                {excludedCount > 0 ? ` · ${storyCount(excludedCount)} excluded and blocked` : ""}
              </span>
            </div>
            {items === null ? (
              <p className="notes-hint">Loading stories…</p>
            ) : items.length === 0 ? (
              <p className="notes-hint">No active stories to analyze.</p>
            ) : (
              <ul className="ai-choices" aria-label="Stories to analyze">
                {items.map((item) => {
                  const ticked = choices.includes(item.id)
                  const excluded = item.preferences.excluded
                  const full = !ticked && choices.length >= MAX_ANALYSIS
                  return (
                    <li key={item.id} className={`ai-choice${excluded ? " excluded" : ""}`} data-testid="ai-choice" data-story-id={item.id}>
                      <label className="check">
                        <input type="checkbox" aria-label={`Analyze ${item.full_title}`} checked={ticked} disabled={busy || (!ticked && (excluded || full))} onChange={() => toggle(item.id)} />
                        <span className="ai-choice-title">{item.full_title}</span>
                      </label>
                      <span className="story-meta">
                        <span>{labelFor(categories, item.category)}</span>
                        {item.preferences.pinned ? <span className="story-tag pinned">Pinned</span> : null}
                        {excluded ? <span className="story-tag excluded">Excluded · blocked</span> : null}
                        {shortlist.includes(item.id) ? <span className="story-tag">Shortlisted</span> : null}
                      </span>
                    </li>
                  )
                })}
                {choices
                  .filter((id) => !byId.has(id))
                  .map((id) => (
                    <li key={id} className="ai-choice excluded" data-testid="ai-choice" data-story-id={id}>
                      <label className="check">
                        <input type="checkbox" aria-label="Analyze a story that is no longer in the inbox" checked disabled={busy} onChange={() => toggle(id)} />
                        <span className="ai-choice-title">Story no longer in the inbox</span>
                      </label>
                      <span className="story-meta">
                        <span className="story-tag excluded">Missing · untick or refresh</span>
                      </span>
                    </li>
                  ))}
              </ul>
            )}
            <div className="ai-choice-actions">
              <button type="button" className="btn small" disabled={busy || shortlist.length === 0} onClick={useShortlist}>
                Tick the shortlist
              </button>
              <button type="button" className="btn small" disabled={busy || choices.length === 0} onClick={clearChoices}>
                Untick all
              </button>
            </div>
          </div>

          <label className="prep-field" htmlFor={briefId}>
            <span className="field-label">2 · Show brief</span>
            <textarea id={briefId} aria-label="Show brief" className="notes-text" rows={3} maxLength={MAX_BRIEF} placeholder="What is tonight's angle? Who is the audience? What matters, what doesn't?" disabled={busy} value={brief} onChange={(event) => { setBrief(event.target.value); setConsentKey(null) }} aria-invalid={brief.length > 0 && briefProb !== null ? true : undefined} />
            <span className="notes-meta">
              <span className="notes-count">
                {count.format(brief.trim().length)} / {count.format(MAX_BRIEF)} characters · at least {MIN_BRIEF}
              </span>
            </span>
          </label>

          <div className="ai-input">
            <div className="prep-head">
              <span className="field-label">3 · Preview the exact input</span>
              <button type="button" className="btn small" disabled={busy || items === null || choiceProb !== null || briefProb !== null} title={choiceProb ?? briefProb ?? undefined} onClick={() => void makeInput()}>
                {pending === "input" ? "Previewing…" : "Preview AI input"}
              </button>
            </div>
            {preview ? (
              <details className={`ai-input-details${previewOk ? "" : " stale"}`} data-testid="ai-input" data-current={previewOk ? "true" : "false"}>
                <summary>
                  Exact text to send · {count.format(preview.inputText.length)} characters · {storyCount(preview.selections.length)}
                  {previewOk ? "" : " · out of date"}
                </summary>
                {!previewOk ? <p className="provenance-truncated" role="status">{preview.rejected ? "The server rejected this input as changed. " : "The brief or the ticked stories changed since this preview. "}Preview again before analyzing.</p> : null}
                {preview.truncated ? (
                  <p className="provenance-truncated" role="note" data-testid="ai-truncated">
                    Some titles, context or source text were shortened to fit the bounds. The text below is exactly what would be sent.
                  </p>
                ) : null}
                <pre className="provenance-text ai-input-text" data-testid="ai-input-text">
                  {preview.inputText}
                </pre>
                <p className="notes-hint">This is exactly what leaves the API when you analyze: the brief plus each chosen story's saved title, context, source text, link and category. Unsaved curation is not included.</p>
              </details>
            ) : (
              <p className="notes-hint">Nothing is sent by previewing. The preview shows the brief and the saved text of the ticked stories, bounded, exactly as it would leave the API.</p>
            )}
          </div>

          <div className="prep-consent">
            <label className="prep-consent-label" htmlFor={consentId}>
              <input
                id={consentId}
                type="checkbox"
                checked={consent}
                disabled={busy || !previewOk}
                onChange={(event) => {
                  setConsentKey(event.target.checked ? key : null)
                  setNotice(null)
                }}
              />
              <span>4 · Send this exact input to {providerLabel(settings)} for one analysis</span>
            </label>
          </div>

          {ambiguous ? (
            <div className="banner warn" role="alert" data-testid="ai-ambiguous">
              <p>The analyze request got no answer. It may or may not have reached the API. Checking status looks up that exact request and shows its result if it arrived; resending reuses the same request id, so the provider is never asked twice.</p>
              <div className="banner-actions">
                <button type="button" className="btn" disabled={busy} onClick={() => void checkStatus()}>
                  Check status
                </button>
                <button type="button" className="btn primary" disabled={busy} onClick={() => void resend()}>
                  Resend the same request
                </button>
                <button type="button" className="btn" disabled={busy} onClick={forgetRequest}>
                  Forget that request
                </button>
              </div>
            </div>
          ) : null}

          <div className="prep-bar">
            <p className={`prep-status${notice?.kind === "error" ? " error" : ""}`} data-testid="ai-status" role="status" aria-live="polite">
              {statusText}
            </p>
            <div className="prep-actions">
              <button type="button" className="btn primary" disabled={busy || generateBlock !== null} title={generateBlock ?? undefined} onClick={() => void generate(null)}>
                {pending === "generate" ? "Analyzing…" : run && run.status !== "running" ? "Analyze again" : "Analyze with AI"}
              </button>
            </div>
          </div>

          {run ? renderRun(run) : <p className="notes-hint">No analysis yet. The latest one appears here, also after a reload.</p>}
        </div>
      ) : null}
    </section>
  )
}
