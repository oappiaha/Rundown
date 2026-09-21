import { useCallback, useEffect, useId, useRef, useState } from "react"
import { ApiError, generatePreparation, getPreparationStatus, getPreparationView, type PreparationConfig, type PreparationView } from "../lib/api"
import { MAX_NOTES, notesLength } from "../lib/draft"
import { projectedNotesLength } from "../lib/inboxDraft"
import { EMPTY_PREP, MAX_POINT, MAX_POINTS, MAX_SUMMARY, MIN_POINTS, adoptView, appendSuggestion, newRequestId, parsePoints, pointsToText, sameSuggestion, suggestionProblem, withRun, type Suggestion, type TopicPrep } from "../lib/prepDraft"
import type { PreparationStore } from "../lib/prepStore"
import { NotesToggle } from "./Notes"

type Props = {
  /** Per-idea state owned by the Inbox view, so it outlives this panel (see prepStore.ts). */
  store: PreparationStore
  /** Saved idea id, or null for an idea that has never been saved (nothing to prepare yet). */
  topicId: string | null
  /** Revision the idea editor is pinned to. */
  revision: number
  /** Saved context of the idea (as of `revision`). */
  baseNotes: string
  /** Context currently in the editor (may carry unsaved edits). */
  notes: string
  sourceUrl: string
  archived: boolean
  /** The idea editor has unsaved edits in any field. */
  dirty: boolean
  /** The idea editor is busy (opening, saving, archiving); panel actions wait. */
  locked: boolean
  /** The inbox view is not on screen: keep state, stop polling. */
  hidden: boolean
  /** Put this text into the editor's context (an unsaved edit; the user still saves explicitly). */
  onAppend: (notes: string) => void
  /** The server holds a newer revision than the editor: let the owner offer its explicit reload/merge recovery. */
  onOutOfDate: () => void
}

const POLL_MS = 2000
const count = new Intl.NumberFormat("en-US")

function describeError(error: unknown, what: string): string {
  if (error instanceof ApiError) return `${what} rejected (${error.status}): ${error.detail}`
  return `${what} failed: the RUNDOWN API did not respond.`
}

function providerLabel(config: PreparationConfig): string {
  if (config.mode === "fixture") return "the test fixture"
  return config.provider || "the configured provider"
}

/**
 * Why a request must not be (re)sent for this idea right now, or null. Shared
 * by Generate and by resending a request that got no answer: the parent's
 * revision, edits and archived flag and the server's readiness all count.
 */
function sendBlock(view: PreparationView | null, parent: { revision: number; dirty: boolean; archived: boolean }, loadError: string | null): string | null {
  if (view === null) return loadError ?? "Checking this idea's preparation state…"
  if (parent.archived) return "Archived ideas are not prepared. Restore the idea first."
  if (view.revision !== parent.revision) return "This idea changed on another screen. Reload it to continue."
  if (parent.dirty) return "Save or discard your edits to the idea first: drafts are generated from the saved text only."
  if (view.latest_run?.status === "running") return "A draft is being generated for this idea. Waiting for the result…"
  if (!view.can_generate) return view.reason ?? view.settings.reason ?? "Generation is not available right now."
  return null
}

/**
 * Assisted preparation for one saved inbox idea: shows whether a provider is
 * configured, previews the exact text that would be sent, generates a
 * summary and talking points only on an explicit, consented click, and lets
 * the user edit the result before appending it to the idea's context. The
 * idea itself is never changed by generation; appending is a local edit the
 * user still has to save.
 */
export default function PreparationPanel({ store, topicId, revision, baseNotes, notes, sourceUrl, archived, dirty, locked, hidden, onAppend, onOutOfDate }: Props) {
  const { preps, patch, loadSeq } = store
  const [status, setStatus] = useState<PreparationConfig | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const statusSeq = useRef(0)
  /** Latest parent facts for async guards (a resend decided after an await must use the current idea state). */
  const parentRef = useRef({ topicId, revision, dirty, archived })
  parentRef.current = { topicId, revision, dirty, archived }
  const summaryId = useId()
  const pointsId = useId()
  const consentId = useId()
  const inputId = useId()

  const loadView = useCallback(
    async (id: string): Promise<PreparationView | null> => {
      const token = (loadSeq.get(id) ?? 0) + 1
      loadSeq.set(id, token)
      patch(id, (current) => ({ ...current, pending: current.pending ?? "load" }))
      try {
        const view = await getPreparationView(id)
        if (loadSeq.get(id) !== token) return null
        patch(id, (current) => adoptView({ ...current, pending: current.pending === "load" ? null : current.pending }, view))
        return view
      } catch (error) {
        if (loadSeq.get(id) !== token) return null
        patch(id, (current) => ({
          ...current,
          pending: current.pending === "load" ? null : current.pending,
          loadError: error instanceof ApiError && error.status === 404 ? "Preparation is not available for this idea: it no longer exists on the server." : describeError(error, "Loading preparation"),
        }))
        return null
      }
    },
    [patch, loadSeq],
  )

  const loadStatus = useCallback(async () => {
    const token = ++statusSeq.current
    try {
      const config = await getPreparationStatus()
      if (token !== statusSeq.current) return
      setStatus(config)
      setStatusError(null)
    } catch (error) {
      if (token !== statusSeq.current) return
      setStatusError(describeError(error, "Loading preparation status"))
    }
  }, [])

  // Fresh view whenever the selected idea or its saved revision changes (and when the view comes back on screen).
  useEffect(() => {
    if (hidden) return
    if (topicId === null) {
      void loadStatus()
      return
    }
    void loadView(topicId)
  }, [topicId, revision, hidden, loadStatus, loadView])

  const prep: TopicPrep | null = topicId === null ? null : (preps[topicId] ?? EMPTY_PREP)
  const running = prep !== null && (prep.run?.status === "running" || prep.view?.latest_run?.status === "running")

  // A run in progress (started here before a reload, or on another screen) is discovered by polling while visible.
  useEffect(() => {
    if (hidden || topicId === null || !running) return
    const timer = setInterval(() => {
      void loadView(topicId)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [hidden, topicId, running, loadView])

  // ---- Actions ----------------------------------------------------------------
  async function generate(id: string, reuse: { requestId: string; revision: number } | null) {
    const current = store.ref.current[id] ?? EMPTY_PREP
    if (current.pending !== null || current.view === null) return
    const requestId = reuse?.requestId ?? newRequestId()
    const sentRevision = reuse?.revision ?? current.view.revision
    patch(id, (value) => ({ ...value, pending: "generate", notice: null, ambiguous: null }))
    try {
      const run = await generatePreparation(id, { revision: sentRevision, request_id: requestId, consent: true })
      // Keyed by the idea the request was for, never by whatever is selected now.
      patch(id, (value) => {
        const next = withRun({ ...value, pending: null }, run)
        if (run.status === "succeeded") return { ...next, notice: null }
        if (run.status === "running") return { ...next, notice: { kind: "info", text: "Still generating. This panel checks again every few seconds." } }
        return { ...next, notice: { kind: "error", text: run.status === "interrupted" ? "Generation was interrupted (the API stopped while working). Nothing was changed; try again when ready." : `Generation failed: ${run.error ?? "the provider returned no usable draft"}. Nothing was changed; try again when ready.` } }
      })
    } catch (error) {
      if (error instanceof ApiError) {
        const text =
          error.status === 409
            ? `Not generated: ${error.detail} Refresh to see the current state of this idea.`
            : error.status === 503
              ? `Not generated: ${error.detail} See the setup notes above.`
              : error.status === 429 || error.status === 422
                ? `Not generated: ${error.detail}`
                : describeError(error, "Generate")
        patch(id, (value) => ({ ...value, pending: null, notice: { kind: "error", text } }))
      } else {
        patch(id, (value) => ({
          ...value,
          pending: null,
          ambiguous: { requestId, revision: sentRevision },
          notice: { kind: "error", text: "No answer from the RUNDOWN API. The request may still have reached it: check status first; resending uses the same request id, so the provider is never asked twice." },
        }))
      }
    }
    void loadView(id)
  }

  /**
   * Resolve a request that got no answer. Always asks the server first: if the
   * run exists it is adopted and nothing is sent. Otherwise the same id is
   * resent only when the idea is still in the state the request was made for
   * (same saved revision, no unsaved edits, not archived, provider ready).
   */
  async function resend(id: string) {
    const current = store.ref.current[id] ?? EMPTY_PREP
    const request = current.ambiguous
    if (!request || current.pending !== null) return
    const view = await loadView(id)
    const after = store.ref.current[id] ?? EMPTY_PREP
    if (view === null || after.pending !== null) return
    if (after.ambiguous === null) return // the earlier request's run was found and adopted
    const parent = parentRef.current
    if (parent.topicId !== id) return
    const block = request.revision !== view.revision ? "The idea was saved since that request, so it cannot be resent as is." : sendBlock(view, parent, after.loadError)
    if (block !== null) {
      patch(id, (value) => ({ ...value, notice: { kind: "error", text: `Not resent: ${block} The earlier request is kept; check status again later or forget it to start a new generation.` } }))
      return
    }
    await generate(id, request)
  }

  function forgetRequest(id: string) {
    patch(id, (value) => ({ ...value, ambiguous: null, notice: { kind: "info", text: "The unanswered request was set aside. A new generation gets a fresh request id." } }))
  }

  function editSuggestion(id: string, update: (current: Suggestion) => Suggestion, pointsText?: string) {
    patch(id, (value) => {
      if (!value.suggestion) return value
      return { ...value, suggestion: update(value.suggestion), pointsText: pointsText ?? value.pointsText, notice: null }
    })
  }

  function discardSuggestionEdits(id: string) {
    patch(id, (value) => ({ ...value, suggestion: value.base, pointsText: value.base ? pointsToText(value.base.points) : "", notice: { kind: "info", text: "Your edits to the suggestion were discarded. Showing the generated text." } }))
  }

  function showNewerRun(id: string) {
    patch(id, (value) => (value.newerRun ? withRun({ ...value, notice: null }, value.newerRun) : value))
  }

  function apply(id: string) {
    const current = store.ref.current[id] ?? EMPTY_PREP
    const suggestion = current.suggestion
    const run = current.run
    if (!suggestion || !run) return
    const next = appendSuggestion(notes, suggestion)
    const projected = projectedNotesLength(next, sourceUrl)
    if (projected > MAX_NOTES) {
      patch(id, (value) => ({
        ...value,
        notice: { kind: "error", text: `Not appended: context plus the source line would be ${count.format(projected)} characters, over the ${count.format(MAX_NOTES)} limit. Shorten the suggestion or the context first; nothing was changed.` },
      }))
      return
    }
    onAppend(next)
    patch(id, (value) => ({ ...value, applied: { runId: run.id, notes: next }, notice: null }))
  }

  // ---- Render helpers -------------------------------------------------------------
  function renderConfig(config: PreparationConfig) {
    const fixture = config.mode === "fixture"
    return (
      <div className="prep-config">
        <div className="prep-config-line">
          {fixture ? (
            <span className="prep-badge fixture" data-testid="prep-fixture-badge">
              Test fixture
            </span>
          ) : null}
          <span className={`prep-badge ${config.ready ? "ready" : "off"}`} data-testid="prep-ready-badge">
            {config.ready ? "Ready" : config.enabled ? "Not ready" : "Off"}
          </span>
          <span className="prep-config-meta" data-testid="prep-config-meta">
            {config.provider || "no provider"} · {config.model || "no model"} · {count.format(config.used_today)} of {count.format(config.daily_limit)} requests used today ({count.format(config.remaining_today)} left; failed and interrupted attempts count)
            {fixture ? " · no real provider is called" : ""}
          </span>
        </div>
        {!config.ready ? (
          <div className="prep-setup" data-testid="prep-setup">
            <p>
              <strong>Not available:</strong> {config.reason ?? (config.enabled ? "the provider is not fully configured." : "assisted preparation is switched off.")}
            </p>
            <p>To enable it, set these in the API process environment (the API's <code>.env</code>), then restart the API. Keys are never entered or shown here.</p>
            <pre className="prep-env">
              {"PREPARATION_ENABLED=true\nPREPARATION_MODEL=<model id>\nANTHROPIC_API_KEY=<key>   # in the API environment only"}
            </pre>
          </div>
        ) : null}
      </div>
    )
  }

  // ---- Unsaved idea ------------------------------------------------------------------
  if (topicId === null || prep === null) {
    return (
      <section className="prep-panel" aria-label="Assisted preparation" data-testid="preparation-panel">
        <div className="prep-head">
          <span className="field-label">Assisted preparation</span>
          <button type="button" className="btn small" onClick={() => void loadStatus()}>
            Refresh status
          </button>
        </div>
        {statusError ? (
          <p className="prep-status error" role="status">
            {statusError}
          </p>
        ) : status ? (
          renderConfig(status)
        ) : (
          <p className="prep-status">Checking the preparation setup…</p>
        )}
        <p className="prep-status" data-testid="preparation-status" role="status">
          Save the idea first. Drafts are generated from the saved title, context and retained source text.
        </p>
      </section>
    )
  }

  // ---- Saved idea ---------------------------------------------------------------------
  const view = prep.view
  const config = view?.settings ?? null
  const run = prep.run
  const suggestion = prep.suggestion
  const edited = suggestion !== null && !sameSuggestion(suggestion, prep.base)
  const problem = suggestion ? suggestionProblem(suggestion) : null
  const generating = prep.pending === "generate"
  const busy = prep.pending !== null || locked
  const revisionMismatch = view !== null && view.revision !== revision
  const consentLabel = `Send saved title, context and retained source text to ${config ? providerLabel(config) : "the provider"} to generate a draft`

  const parentFacts = { revision, dirty, archived }
  const generateBlock: string | null =
    sendBlock(view, parentFacts, prep.loadError) ??
    (edited
      ? "You edited the suggestion below. Append it or discard the edits before generating again."
      : prep.ambiguous
        ? "The last request got no answer. Check status or resend it (or forget it) before starting a new one."
        : null)
  /** Why the unanswered request cannot be resent right now (checking status is always allowed). */
  const resendBlock: string | null = prep.ambiguous
    ? prep.ambiguous.revision !== revision
      ? "The idea was saved since that request, so it cannot be resent as is."
      : sendBlock(view, parentFacts, prep.loadError) ?? (edited ? "You edited the suggestion below. Discard the edits first." : null)
    : null
  const canGenerate = generateBlock === null && prep.consent && !busy

  const appliedNow = prep.applied !== null && run !== null && prep.applied.runId === run.id && (notes === prep.applied.notes || baseNotes === prep.applied.notes)
  const appliedSaved = appliedNow && prep.applied !== null && baseNotes === prep.applied.notes
  const staleLocal = run !== null && (run.revision !== revision || run.stale)
  const applyBlock: string | null =
    run === null || suggestion === null
      ? null
      : appliedSaved
        ? "Appended and saved into the context above."
        : appliedNow
          ? "Appended to the context above. Save idea to keep it, or Discard edits to take it out again."
          : revisionMismatch
            ? "This idea changed on another screen. Reload it to continue."
            : staleLocal
              ? "This draft was generated for an earlier version of the idea. Generate again to get one for the current text."
            : archived
              ? "Archived ideas are read-only. Restore the idea to append."
              : dirty
                ? "The idea has unsaved edits. Save or discard them first so appending never overwrites what you typed."
                : problem
  const canApply = run !== null && suggestion !== null && applyBlock === null && !busy

  const inputChars = view ? notesLength(view.input_text) : 0
  const statusText = prep.notice
    ? prep.notice.text
    : generating
      ? `Generating a draft with ${config ? providerLabel(config) : "the provider"}…`
      : prep.pending === "load" && view === null
        ? "Checking this idea's preparation state…"
        : running
          ? "Generating… checking every few seconds."
          : run?.status === "failed"
            ? `The last generation failed: ${run.error ?? "no usable draft came back"}. Nothing was changed. Try again when ready.`
            : run?.status === "interrupted"
              ? "The last generation was interrupted. Nothing was changed. Try again when ready."
              : run?.status === "succeeded"
                ? (applyBlock ??
                  (edited
                    ? "Edited draft. Append it to the context, or discard the edits to generate again."
                    : view && !view.can_generate && view.reason
                      ? `Draft ready. Generating again is not available: ${view.reason}`
                      : "Draft ready. Edit it below if you like, then append it to the context."))
                : generateBlock ?? "Ready. Tick the consent box, then Generate draft."

  return (
    <section className="prep-panel" aria-label="Assisted preparation" data-testid="preparation-panel" aria-busy={prep.pending !== null || undefined}>
      <div className="prep-head">
        <span className="field-label">Assisted preparation</span>
        <button type="button" className="btn small" disabled={prep.pending !== null} onClick={() => void loadView(topicId)}>
          Refresh status
        </button>
      </div>

      {view ? renderConfig(view.settings) : prep.loadError ? null : <p className="prep-status">Checking the preparation setup…</p>}

      {prep.loadError ? (
        <div className="banner error" role="status">
          <p>{prep.loadError}</p>
          <div className="banner-actions">
            <button type="button" className="btn" disabled={prep.pending !== null} onClick={() => void loadView(topicId)}>
              Retry
            </button>
          </div>
        </div>
      ) : null}

      {view ? (
        <div className="prep-input">
          <NotesToggle
            label="Preview the exact text to send"
            expanded={prep.inputOpen}
            hasNotes={view.input_text.length > 0}
            panelId={inputId}
            wording={{ empty: "Text to send (nothing yet)", filled: `Text to send · ${count.format(inputChars)} characters` }}
            onToggle={() => patch(topicId, (value) => ({ ...value, inputOpen: !value.inputOpen }))}
          />
          {view.input_truncated ? (
            <p className="provenance-truncated" role="note" data-testid="prep-truncated">
              Some source or context was shortened to fit the {count.format(view.settings.max_input_chars)}-character limit. The preview below is the exact text that will be sent.
            </p>
          ) : null}
          {prep.inputOpen ? (
            <div id={inputId} className="provenance-body">
              <pre className="provenance-text" data-testid="prep-input-text">
                {view.input_text}
              </pre>
              <p className="notes-hint">This is exactly what leaves the API when you generate: the saved title, saved context and any retained source text. Unsaved edits are not included.</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {view && !archived ? (
        <div className="prep-consent">
          <label className="prep-consent-label" htmlFor={consentId}>
            <input
              id={consentId}
              type="checkbox"
              checked={prep.consent}
              disabled={busy}
              onChange={(event) => {
                const checked = event.target.checked
                patch(topicId, (value) => ({ ...value, consent: checked, notice: null }))
              }}
            />
            <span>{consentLabel}</span>
          </label>
        </div>
      ) : null}

      {revisionMismatch ? (
        <div className="banner warn" role="status" data-testid="prep-out-of-date">
          <p>This idea changed on another screen since you opened it. Reload it (or merge your edits) before generating or appending.</p>
          <div className="banner-actions">
            <button type="button" className="btn" disabled={busy} onClick={onOutOfDate}>
              Reload the idea…
            </button>
          </div>
        </div>
      ) : null}

      {prep.ambiguous ? (
        <div className="banner warn" role="alert" data-testid="prep-ambiguous">
          <p>
            The generate request got no answer. It may or may not have reached the API.
            {resendBlock ? ` ${resendBlock}` : " Resending checks the server first and reuses the same request id, so the provider is never asked twice."}
          </p>
          <div className="banner-actions">
            <button type="button" className="btn" disabled={prep.pending !== null} onClick={() => void loadView(topicId)}>
              Check status
            </button>
            <button type="button" className="btn primary" disabled={prep.pending !== null || busy || !prep.consent || resendBlock !== null} title={resendBlock ?? (prep.consent ? undefined : "Tick the consent box first")} onClick={() => void resend(topicId)}>
              Resend the same request
            </button>
            <button type="button" className="btn" disabled={prep.pending !== null} onClick={() => forgetRequest(topicId)}>
              Forget that request
            </button>
          </div>
        </div>
      ) : null}

      {prep.newerRun ? (
        <div className="banner warn" role="status">
          <p>A newer draft exists for this idea (generated elsewhere). You still have unsaved edits below.</p>
          <div className="banner-actions">
            <button type="button" className="btn" onClick={() => showNewerRun(topicId)}>
              Discard my edits and show the newer draft
            </button>
          </div>
        </div>
      ) : null}

      {run && suggestion ? (
        <div className="prep-result" data-testid="prep-result">
          <div className="prep-result-head">
            <span className="field-label">
              Draft · {run.model || "model"}
              {run.input_truncated ? " · from truncated input" : ""}
              {staleLocal && !appliedNow ? " · for an earlier version" : ""}
            </span>
            {edited ? (
              <button type="button" className="btn small" disabled={busy} onClick={() => discardSuggestionEdits(topicId)}>
                Discard suggestion edits
              </button>
            ) : null}
          </div>
          <label className="prep-field" htmlFor={summaryId}>
            <span className="field-label">Summary</span>
            <textarea
              id={summaryId}
              aria-label="Suggested summary"
              aria-invalid={suggestion.summary.trim().length === 0 || notesLength(suggestion.summary.trim()) > MAX_SUMMARY ? true : undefined}
              className="notes-text"
              disabled={busy || archived}
              rows={4}
              spellCheck
              value={suggestion.summary}
              onChange={(event) => {
                const summary = event.target.value
                editSuggestion(topicId, (current) => ({ ...current, summary }))
              }}
            />
            <span className="notes-meta">
              <span className="notes-count">
                {count.format(notesLength(suggestion.summary.trim()))} / {count.format(MAX_SUMMARY)} characters
              </span>
            </span>
          </label>
          <label className="prep-field" htmlFor={pointsId}>
            <span className="field-label">Talking points (one per line)</span>
            <textarea
              id={pointsId}
              aria-label="Suggested talking points"
              className="notes-text"
              disabled={busy || archived}
              rows={5}
              spellCheck
              value={prep.pointsText}
              onChange={(event) => {
                const text = event.target.value
                editSuggestion(topicId, (current) => ({ ...current, points: parsePoints(text) }), text)
              }}
            />
            <span className="notes-meta">
              <span className="notes-count">
                {suggestion.points.length} points · {MIN_POINTS} to {MAX_POINTS}, each up to {MAX_POINT} characters
              </span>
            </span>
          </label>
        </div>
      ) : null}

      <div className="prep-bar">
        <p className={`prep-status${prep.notice?.kind === "error" || run?.status === "failed" || run?.status === "interrupted" ? " error" : ""}`} data-testid="preparation-status" role="status" aria-live="polite">
          {statusText}
        </p>
        <div className="prep-actions">
          {run && suggestion ? (
            <button type="button" className="btn activate" disabled={!canApply} title={applyBlock ?? "Append the summary and talking points to the context above"} onClick={() => apply(topicId)}>
              {appliedNow ? "Appended" : "Append to context"}
            </button>
          ) : null}
          {view && !archived ? (
            <button type="button" className="btn primary" disabled={!canGenerate} title={generateBlock ?? (prep.consent ? undefined : "Tick the consent box first")} onClick={() => void generate(topicId, null)}>
              {generating ? "Generating…" : run?.status === "failed" || run?.status === "interrupted" ? "Try again" : run?.status === "succeeded" ? "Generate again" : "Generate draft"}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  )
}
