import { useCallback, useEffect, useId, useRef } from "react"
import {
  ApiError,
  applyShowPreparation,
  generateShowPreparation,
  getShowPreparation,
  getShowPreparationRun,
  previewShowPreparationInput,
  type SavedShow,
  type SavedShowTopic,
  type ShowPreparationApply,
  type ShowPreparationRun,
  type ShowPreparationSettings,
} from "../lib/api"
import { notesLength } from "../lib/draft"
import { newRequestId } from "../lib/prepDraft"
import {
  EMPTY_SHOW_PREP,
  MAX_SHOW_POINT,
  MAX_SHOW_POINTS,
  MAX_SHOW_SUMMARY,
  MIN_SHOW_POINTS,
  adoptRun,
  adoptStatus,
  applyPayload,
  consented,
  isEdited,
  noteProblem,
  parseNotePoints,
  runApplied,
  runStale,
  selectionProblem,
  titleFor,
  withRun,
  type NoteDraft,
  type ShowPrep,
} from "../lib/showPrepDraft"
import type { ShowPreparationStore } from "../lib/showPrepStore"

type Props = {
  /** Per-show state owned by the Saved Shows view, so it outlives this panel (see showPrepStore.ts). */
  store: ShowPreparationStore
  /** Saved show id, or null for a show that has never been saved (nothing to prepare yet). */
  showId: string | null
  showName: string
  /** Saved revision the show editor is pinned to. */
  revision: number
  /** Saved topics (as of `revision`): titles for generated ids and current notes for the length check. */
  topics: SavedShowTopic[]
  /** The show editor has unsaved edits: notes are prepared from and saved into the saved version only. */
  dirty: boolean
  /** The show editor itself is busy (opening, saving, activating…); panel requests wait. */
  locked: boolean
  /** The view is not on screen: keep state, stop polling. */
  hidden: boolean
  /** A generate or save request from this panel is in flight; the owner locks show edits and switching meanwhile. */
  onBusy: (busy: boolean) => void
  /** The server answered an apply with the current authoritative saved show; the owner adopts it (after its own checks). */
  onApplied: (show: SavedShow) => void
}

const POLL_MS = 2000
const count = new Intl.NumberFormat("en-US")

function describeError(error: unknown, what: string): string {
  if (error instanceof ApiError) return `${what} rejected (${error.status}): ${error.detail}`
  return `${what} failed: the RUNDOWN API did not respond.`
}

/** A 5xx is as ambiguous as no answer: the server may or may not have recorded the request. */
function ambiguousError(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500
}

function providerLabel(settings: ShowPreparationSettings): string {
  if (settings.mode === "fixture") return "the local test fixture"
  return settings.provider || "the configured provider"
}

function modeLabel(run: ShowPreparationRun): string {
  return run.mode === "fixture" ? "test fixture" : "Anthropic"
}

/**
 * Whole-show assisted preparation for one saved show: shows whether a provider
 * is configured, previews the exact bounded text that would be sent, generates
 * a summary and talking points for every topic in one consented request, and
 * lets the user review, edit and tick notes before an explicit, atomic save
 * appends them to the saved topics. Generation never changes the show; the
 * save is revision-guarded and happens at most once per run.
 */
export default function ShowPreparation({ store, showId, showName, revision, topics, dirty, locked, hidden, onBusy, onApplied }: Props) {
  const { preps, patch, loadSeq } = store
  const parentRef = useRef({ showId, revision, dirty })
  parentRef.current = { showId, revision, dirty }
  const fieldId = useId()

  const loadStatus = useCallback(
    async (id: string): Promise<void> => {
      const token = (loadSeq.get(id) ?? 0) + 1
      loadSeq.set(id, token)
      patch(id, (current) => ({ ...current, pending: current.pending ?? "load" }))
      try {
        const status = await getShowPreparation(id)
        if (loadSeq.get(id) !== token) return
        patch(id, (current) => adoptStatus({ ...current, pending: current.pending === "load" ? null : current.pending }, status))
      } catch (error) {
        if (loadSeq.get(id) !== token) return
        patch(id, (current) => ({ ...current, pending: current.pending === "load" ? null : current.pending, loadError: describeError(error, "Loading the preparation state") }))
      }
    },
    [patch, loadSeq],
  )

  // Fresh status whenever the open show or its saved revision changes, and when the view comes back on screen.
  useEffect(() => {
    if (hidden || showId === null) return
    void loadStatus(showId)
  }, [showId, revision, hidden, loadStatus])

  const prep: ShowPrep | null = showId === null ? null : (preps[showId] ?? EMPTY_SHOW_PREP)
  const run = prep?.run ?? null
  const running = run !== null && run.status === "running"

  // A run in progress (recovered after a reload, or started elsewhere) is followed by reading that exact run while visible.
  useEffect(() => {
    if (hidden || showId === null || run === null || !running) return
    const runId = run.id
    const timer = setInterval(() => {
      getShowPreparationRun(showId, runId).then(
        (latest) => patch(showId, (current) => (current.pending === "generate" ? current : adoptRun(current, latest))),
        () => {
          /* transient; the next tick or a manual refresh tries again */
        },
      )
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [hidden, showId, run, running, patch])

  // The owner locks show edits and switching while our own generate/save is in flight; never for reads.
  const heavy = prep !== null && (prep.pending === "generate" || prep.pending === "apply")
  useEffect(() => {
    onBusy(heavy)
    return () => onBusy(false)
  }, [heavy, onBusy])

  // ---- Actions ----------------------------------------------------------------
  async function preview(id: string) {
    const current = store.ref.current[id] ?? EMPTY_SHOW_PREP
    if (current.pending !== null) return
    const sentRevision = parentRef.current.revision
    patch(id, (value) => ({ ...value, pending: "input", notice: null }))
    try {
      const input = await previewShowPreparationInput(id, sentRevision)
      patch(id, (value) => ({ ...value, pending: null, input, consentHash: null, inputOpen: true }))
    } catch (error) {
      const text =
        error instanceof ApiError && error.status === 409
          ? `Not previewed: ${error.detail} Reload the show to continue.`
          : error instanceof ApiError && error.status === 422
            ? `Not previewed: ${error.detail}`
            : describeError(error, "Preview")
      patch(id, (value) => ({ ...value, pending: null, notice: { kind: "error", text } }))
    }
  }

  async function generate(id: string, reuse: { requestId: string; revision: number; inputHash: string } | null) {
    const current = store.ref.current[id] ?? EMPTY_SHOW_PREP
    if (current.pending !== null) return
    if (reuse === null && !consented(current, parentRef.current.revision)) return
    const requestId = reuse?.requestId ?? newRequestId()
    const sentRevision = reuse?.revision ?? current.input!.revision
    const inputHash = reuse?.inputHash ?? current.input!.input_hash
    // Consent covers one attempt: it is spent now, whatever the answer.
    patch(id, (value) => ({ ...value, pending: "generate", notice: null, ambiguous: null, consentHash: null, confirmReplace: false }))
    try {
      const answer = await generateShowPreparation(id, { revision: sentRevision, input_hash: inputHash, request_id: requestId, consent: true })
      // Keyed by the show the request was for, never by whatever is open now.
      patch(id, (value) => {
        const next = withRun({ ...value, pending: null }, answer)
        if (answer.status === "succeeded") return { ...next, notice: { kind: "info", text: `Prepared notes for ${count.format(answer.items.length)} topics. Review and edit them below, then save the ones you want; nothing is in the show yet.` } }
        if (answer.status === "running") return { ...next, notice: { kind: "info", text: "Still preparing. This panel checks again every few seconds." } }
        return { ...next, notice: { kind: "error", text: answer.status === "interrupted" ? `Preparation was interrupted: ${answer.error ?? "the API stopped while working"}. Nothing was written to the show.` : `Preparation failed: ${answer.error ?? "the provider returned no usable notes"}. Nothing was written to the show.` } }
      })
    } catch (error) {
      if (ambiguousError(error)) {
        patch(id, (value) => ({
          ...value,
          pending: null,
          ambiguous: { requestId, revision: sentRevision, inputHash },
          notice: { kind: "error", text: "No definite answer from the RUNDOWN API. The request may still have reached it and used quota: recover it below. Nothing is sent twice under the same request id." },
        }))
      } else {
        const api = error as ApiError
        const text =
          api.status === 409
            ? `Not generated: ${api.detail} Preview the saved show again.`
            : api.status === 503
              ? `Not generated: ${api.detail} See the setup note above.`
              : `Not generated: ${api.detail}`
        patch(id, (value) => ({ ...value, pending: null, notice: { kind: "error", text } }))
      }
    }
    void loadStatus(id)
  }

  /** Read the exact run of a request that got no definite answer; found runs are adopted, nothing is sent. */
  async function recoverRequest(id: string) {
    const current = store.ref.current[id] ?? EMPTY_SHOW_PREP
    const request = current.ambiguous
    if (!request || current.pending !== null) return
    patch(id, (value) => ({ ...value, pending: "recover", notice: null }))
    try {
      const found = await getShowPreparationRun(id, request.requestId)
      patch(id, (value) => ({ ...adoptRun({ ...value, pending: null }, found), notice: { kind: "info", text: "Found the result of the earlier request. Nothing was sent again." } }))
    } catch (error) {
      const missing = error instanceof ApiError && error.status === 404
      patch(id, (value) => ({
        ...value,
        pending: null,
        notice: missing
          ? { kind: "info", text: "The API has no record of that request, so nothing was used. You can resend the same request, or set it aside." }
          : { kind: "error", text: describeError(error, "Checking the earlier request") },
      }))
    }
  }

  /** Resend the frozen request under its own id: the server answers the existing run or starts exactly one. */
  async function resendRequest(id: string) {
    const current = store.ref.current[id] ?? EMPTY_SHOW_PREP
    const request = current.ambiguous
    if (!request || current.pending !== null) return
    if (request.revision !== parentRef.current.revision || parentRef.current.dirty) {
      patch(id, (value) => ({ ...value, notice: { kind: "error", text: "Not resent: the show changed since that request. Recover its result, or set it aside and preview again." } }))
      return
    }
    await generate(id, request)
  }

  function forgetRequest(id: string) {
    patch(id, (value) => ({ ...value, ambiguous: null, notice: { kind: "info", text: "The unanswered request was set aside. A new preparation gets a fresh request id." } }))
  }

  function editDraft(id: string, itemId: string, update: (draft: NoteDraft) => NoteDraft) {
    patch(id, (value) => (value.drafts ? { ...value, drafts: value.drafts.map((draft) => (draft.id === itemId ? update(draft) : draft)), notice: null } : value))
  }

  function setAll(id: string, selected: boolean) {
    patch(id, (value) => (value.drafts ? { ...value, drafts: value.drafts.map((draft) => ({ ...draft, selected })), notice: null } : value))
  }

  function discardNoteEdits(id: string) {
    patch(id, (value) => ({ ...value, drafts: value.base, notice: { kind: "info", text: "Your edits to the prepared notes were discarded. Showing the generated text." } }))
  }

  function showNewerRun(id: string) {
    patch(id, (value) => (value.newerRun ? withRun({ ...value, notice: null }, value.newerRun) : value))
  }

  function dismissNewerRun(id: string) {
    patch(id, (value) => ({ ...value, newerRun: null }))
  }

  async function sendApply(id: string, runId: string, payload: ShowPreparationApply, retry: boolean) {
    // Frozen before sending, so a lost answer can be retried with this exact body.
    patch(id, (value) => ({ ...value, pending: "apply", pendingApply: { runId, payload }, notice: null }))
    try {
      const show = await applyShowPreparation(id, runId, payload)
      patch(id, (value) => ({
        ...value,
        pending: null,
        pendingApply: null,
        applied: { runId, revision: show.revision },
        run: value.run && value.run.id === runId ? { ...value.run, stale: true, applied_revision: value.run.applied_revision ?? show.revision } : value.run,
        notice: {
          kind: "info",
          text: retry
            ? `The save is confirmed: "${show.name}" is at revision ${count.format(show.revision)} with the prepared notes. Nothing was appended twice.`
            : `Saved prepared notes for ${count.format(payload.items.length)} ${payload.items.length === 1 ? "topic" : "topics"} into "${show.name}" (now revision ${count.format(show.revision)}). Not live: activate the show when you want it on air.`,
        },
      }))
      onApplied(show)
    } catch (error) {
      if (ambiguousError(error)) {
        patch(id, (value) => ({
          ...value,
          pending: null,
          notice: { kind: "error", text: "No definite answer from the RUNDOWN API. The notes may or may not have been saved: retry the same save below. The server appends them at most once." },
        }))
      } else {
        const api = error as ApiError
        patch(id, (value) => ({
          ...value,
          pending: null,
          pendingApply: null,
          notice: { kind: "error", text: `Not saved: ${api.detail}${api.status === 409 || api.status === 422 ? " Your edited notes are kept here." : ""}` },
        }))
      }
    }
    void loadStatus(id)
  }

  function apply(id: string) {
    const current = store.ref.current[id] ?? EMPTY_SHOW_PREP
    if (current.pending !== null || !current.run || !current.drafts || current.pendingApply) return
    const parent = parentRef.current
    if (parent.showId !== id || parent.dirty || runStale(current.run, parent.revision) || runApplied(current, current.run)) return
    if (selectionProblem(current.drafts, topics) !== null) return
    void sendApply(id, current.run.id, applyPayload(current.run.revision, current.drafts), false)
  }

  function retryApply(id: string) {
    const current = store.ref.current[id] ?? EMPTY_SHOW_PREP
    if (current.pending !== null || !current.pendingApply) return
    void sendApply(id, current.pendingApply.runId, current.pendingApply.payload, true)
  }

  function forgetApply(id: string) {
    patch(id, (value) => ({ ...value, pendingApply: null, notice: { kind: "info", text: "The unanswered save was set aside. Refresh status: if the server recorded it, this run shows as saved." } }))
  }

  // ---- Render helpers -------------------------------------------------------------
  function renderConfig(settings: ShowPreparationSettings) {
    const fixture = settings.mode === "fixture"
    return (
      <div className="prep-config">
        <div className="prep-config-line">
          {fixture ? (
            <span className="prep-badge fixture" data-testid="show-prep-fixture-badge">
              Test fixture
            </span>
          ) : null}
          <span className={`prep-badge ${settings.ready ? "ready" : "off"}`} data-testid="show-prep-ready-badge">
            {settings.ready ? "Ready" : settings.enabled ? "Not ready" : "Off"}
          </span>
          <span className="prep-config-meta" data-testid="show-prep-config-meta">
            {settings.provider || "no provider"} · {settings.model || "no model"} · {count.format(settings.used_today)} of {count.format(settings.daily_limit)} requests used today ({count.format(settings.remaining_today)} left; shared with single-idea preparation, failed attempts count) · up to {count.format(settings.max_topics)} topics, {count.format(settings.max_input_chars_per_topic)} characters of context each
            {fixture ? " · no real provider is called" : ""}
          </span>
        </div>
        {!settings.ready ? (
          <div className="prep-setup" data-testid="show-prep-setup">
            <p>
              <strong>Not available:</strong> {settings.reason ?? (settings.enabled ? "the provider is not fully configured." : "assisted preparation is switched off.")} Enable and configure it in the API process environment, then restart the API. Keys are never entered or shown here.
            </p>
          </div>
        ) : null}
      </div>
    )
  }

  // ---- Unsaved show -------------------------------------------------------------------
  if (showId === null || prep === null) {
    return (
      <section className="prep-panel show-prep" aria-label="Prepare the whole show" data-testid="show-preparation">
        <div className="prep-head">
          <span className="field-label">Prepare the whole show</span>
        </div>
        <p className="prep-status" data-testid="show-prep-status" role="status">
          Save the show first. Notes are prepared from the saved title, context and length of every topic.
        </p>
      </section>
    )
  }

  // ---- Saved show ---------------------------------------------------------------------
  const id: string = showId
  const status = prep.status
  // Current status first: usage counters move after every attempt; the preview carries settings only as a fallback.
  const settings = status?.settings ?? prep.input?.settings ?? null
  const drafts = prep.drafts
  const edited = isEdited(prep)
  const generating = prep.pending === "generate"
  const applying = prep.pending === "apply"
  const busy = prep.pending !== null || locked
  const input = prep.input !== null && prep.input.revision === revision ? prep.input : null
  const hasConsent = consented(prep, revision)
  const stale = run !== null && runStale(run, revision)
  const applied = run !== null && runApplied(prep, run)
  const savedTopics = topics.length

  /** Why nothing may be sent for this show right now (preview or generate), or null. */
  const sendBlock: string | null =
    status === null
      ? (prep.loadError ?? "Checking this show's preparation state…")
      : dirty
        ? "Save or discard your show edits first: notes are prepared from the saved version only."
        : status.revision !== revision
          ? "This show changed elsewhere. Reload it to continue."
          : savedTopics === 0
            ? "Add and save at least one topic before preparing the show."
            : running
              ? "A preparation is running for this show. Waiting for its result…"
              : prep.ambiguous
                ? "The last request got no definite answer. Recover it or set it aside first."
                : prep.pendingApply
                  ? "A save is waiting for an answer. Retry it or set it aside first."
                  : !status.settings.ready
                    ? (status.settings.reason ?? "Preparation is not available right now.")
                    : status.settings.remaining_today <= 0
                      ? "The daily preparation limit is used up; it resets at midnight UTC."
                      : null
  const generateBlock: string | null = sendBlock ?? (input === null ? "Preview what will be sent first." : hasConsent ? null : "Tick the consent box first.")
  const canGenerate = generateBlock === null && !busy
  const applyBlock: string | null =
    run === null || run.status !== "succeeded" || drafts === null
      ? "Prepare the show first."
      : dirty
        ? "Save or discard your show edits first; prepared notes are saved into the saved version."
        : prep.pendingApply
          ? "A save is waiting for an answer. Retry it or set it aside first."
          : applied
            ? "These notes are already in the show. Generate again for new ones."
            : stale
              ? "The show changed since these notes were prepared. Read them here, but generate again before saving."
              : busy
                ? "Please wait for the current request to finish."
                : selectionProblem(drafts, topics)
  const canApply = applyBlock === null
  const tickedCount = drafts ? drafts.filter((draft) => draft.selected).length : 0

  const consentLabel = `Send the saved version of "${showName}" (${count.format(savedTopics)} ${savedTopics === 1 ? "topic" : "topics"}: titles, context and lengths) to ${settings ? providerLabel(settings) : "the provider"} to prepare notes`

  const statusText = prep.notice
    ? prep.notice.text
    : generating
      ? "Preparing notes for the whole show… one request, up to a minute."
      : applying
        ? "Saving the prepared notes into the show…"
        : prep.pending === "input"
          ? "Previewing the exact text that would be sent…"
          : prep.pending === "recover"
            ? "Checking the earlier request…"
            : prep.pending === "load"
              ? "Checking this show's preparation state…"
              : run && run.status === "succeeded"
                ? applied
                  ? `These notes were saved into the show${run.applied_revision !== null ? ` (revision ${count.format(run.applied_revision)})` : ""}. Generate again for new ones.`
                  : stale
                    ? "These notes are from an earlier saved version. Read them here; generate again before saving."
                    : (applyBlock ?? `${count.format(tickedCount)} of ${count.format(drafts?.length ?? 0)} topics ticked. Review the notes, then save them into the show.`)
                : input
                  ? hasConsent
                    ? "Consent given for this exact text. Generate when ready."
                    : "This is the exact text that would be sent. Tick the box to consent, then generate."
                  : (sendBlock ?? "Preview what would be sent, consent, then prepare notes for every topic in one request.")

  function generateAgain() {
    if (!canGenerate) return
    if (edited && !applied) {
      patch(id, (value) => ({ ...value, confirmReplace: true }))
      return
    }
    void generate(id, null)
  }

  return (
    <section className="prep-panel show-prep" aria-label="Prepare the whole show" data-testid="show-preparation" aria-busy={prep.pending !== null || undefined}>
      <div className="prep-head">
        <span className="field-label">Prepare the whole show</span>
        <button type="button" className="btn small" disabled={prep.pending !== null} onClick={() => void loadStatus(id)}>
          Refresh status
        </button>
      </div>

      {prep.loadError && status === null ? (
        <p className="prep-status error" role="status">
          {prep.loadError}
        </p>
      ) : settings ? (
        renderConfig(settings)
      ) : (
        <p className="prep-status">Checking the preparation setup…</p>
      )}

      <p className="ai-intro">
        One request prepares a summary and {MIN_SHOW_POINTS}–{MAX_SHOW_POINTS} talking points for every saved topic, from the saved context only. Nothing is written to the show until you review the notes and save the ones you want. The model can be uncertain or wrong: review before saving.
      </p>

      <div className="prep-input">
        <div className="prep-actions">
          <button type="button" className="btn" disabled={sendBlock !== null || busy} title={sendBlock ?? "Show the exact text that would be sent; nothing is sent yet"} onClick={() => void preview(id)}>
            {prep.pending === "input" ? "Previewing…" : input ? "Preview again" : "Preview what will be sent"}
          </button>
        </div>
        {input ? (
          <>
            <details className={`ai-input-details${input.input_truncated ? " stale" : ""}`} open={prep.inputOpen} onToggle={(event) => patch(id, (value) => ({ ...value, inputOpen: (event.target as HTMLDetailsElement).open }))}>
              <summary data-testid="show-prep-input-summary">
                Exact text to send · {count.format(notesLength(input.input_text))} characters · saved revision {count.format(input.revision)}
                {input.input_truncated ? " · long context was shortened (source lines at the end are kept)" : ""}
              </summary>
              <pre className="prep-env ai-input-text" data-testid="show-prep-input-text">
                {input.input_text}
              </pre>
            </details>
            <div className="prep-consent">
              <label className="prep-consent-label" htmlFor={`${fieldId}-consent`}>
                <input
                  id={`${fieldId}-consent`}
                  type="checkbox"
                  aria-label="Consent to send the saved show"
                  checked={hasConsent}
                  disabled={busy || sendBlock !== null}
                  onChange={(event) => {
                    const hash = event.target.checked ? input.input_hash : null
                    patch(id, (value) => ({ ...value, consentHash: hash, notice: null }))
                  }}
                />
                <span>{consentLabel}</span>
              </label>
              <span className="notes-hint">Consent covers this exact text once. Any change to the saved show asks again.</span>
            </div>
          </>
        ) : null}
      </div>

      {prep.ambiguous ? (
        <div className="banner warn" role="status" data-testid="show-prep-ambiguous">
          <p>An earlier preparation request got no definite answer. It may have run and used quota. Recover it here; nothing is sent twice under the same request id.</p>
          <div className="banner-actions">
            <button type="button" className="btn primary" disabled={prep.pending !== null} onClick={() => void recoverRequest(id)}>
              Recover the result
            </button>
            <button type="button" className="btn" disabled={prep.pending !== null || locked} onClick={() => void resendRequest(id)}>
              Resend the same request
            </button>
            <button type="button" className="btn" disabled={prep.pending !== null} onClick={() => forgetRequest(id)}>
              Set it aside
            </button>
          </div>
        </div>
      ) : null}

      {prep.pendingApply ? (
        <div className="banner warn" role="status" data-testid="show-prep-pending-apply">
          <p>
            A save of {count.format(prep.pendingApply.payload.items.length)} prepared {prep.pendingApply.payload.items.length === 1 ? "note" : "notes"} got no definite answer. Retrying sends exactly the same save; the server appends it at most once and answers with the current show.
            {run && run.id === prep.pendingApply.runId && run.applied_revision !== null ? ` The server records it as saved (revision ${count.format(run.applied_revision)}); retry to load the updated show.` : ""}
          </p>
          <div className="banner-actions">
            <button type="button" className="btn primary" disabled={prep.pending !== null || locked} onClick={() => retryApply(id)}>
              Retry the same save
            </button>
            <button type="button" className="btn" disabled={prep.pending !== null} onClick={() => void loadStatus(id)}>
              Check status
            </button>
            <button type="button" className="btn" disabled={prep.pending !== null} onClick={() => forgetApply(id)}>
              Set it aside
            </button>
          </div>
        </div>
      ) : null}

      {prep.newerRun ? (
        <div className="banner warn" role="status" data-testid="show-prep-newer">
          <p>The server holds a different preparation for this show ({prep.newerRun.status}). The notes below are kept as they are until you choose.</p>
          <div className="banner-actions">
            <button type="button" className="btn" disabled={prep.pending !== null} onClick={() => showNewerRun(id)}>
              {edited ? "Discard my edits and show it" : "Show it"}
            </button>
            <button type="button" className="btn" onClick={() => dismissNewerRun(id)}>
              Keep these notes
            </button>
          </div>
        </div>
      ) : null}

      {run ? (
        <div className={`prep-result show-prep-result${run.status === "failed" || run.status === "interrupted" ? " failed" : ""}`} data-testid="show-prep-result" data-status={run.status} data-stale={stale ? "true" : "false"} data-applied={applied ? "true" : "false"}>
          <div className="prep-result-head">
            <span className="field-label" data-testid="show-prep-result-meta">
              Prepared notes · {modeLabel(run)} · {run.model || "model"} · for saved revision {count.format(run.revision)}
              {run.input_tokens !== null && run.output_tokens !== null ? ` · ${count.format(run.input_tokens)} in / ${count.format(run.output_tokens)} out tokens` : ""}
              {applied ? " · saved into the show" : stale ? " · from an earlier saved version" : ""}
            </span>
            {drafts && edited && !applied ? (
              <button type="button" className="btn small" disabled={busy} onClick={() => discardNoteEdits(id)}>
                Discard note edits
              </button>
            ) : null}
          </div>

          {run.status === "failed" || run.status === "interrupted" ? (
            <div className="banner error" role="status" data-testid="show-prep-run-error">
              <p>
                <strong>{run.status === "interrupted" ? "Interrupted." : "Failed."}</strong> {run.error ?? "The provider returned no usable notes."} Nothing was written to the show. You can generate again when ready.
              </p>
            </div>
          ) : run.status === "running" ? (
            <p className="prep-status">Still preparing… this panel checks the run every few seconds.</p>
          ) : drafts ? (
            <>
              {!applied && !stale ? (
                <div className="show-prep-select">
                  <span className="notes-hint">All topics are ticked by default. Untick any you do not want saved; only ticked notes are appended.</span>
                  <div className="prep-actions">
                    <button type="button" className="btn small" disabled={busy || tickedCount === drafts.length} onClick={() => setAll(id, true)}>
                      Tick all
                    </button>
                    <button type="button" className="btn small" disabled={busy || tickedCount === 0} onClick={() => setAll(id, false)}>
                      Untick all
                    </button>
                  </div>
                </div>
              ) : null}
              <ol className="show-prep-items" aria-label="Prepared notes by topic">
                {drafts.map((draft) => {
                  const title = titleFor(draft.id, topics)
                  const problem = noteProblem(draft)
                  const summaryId = `${fieldId}-summary-${draft.id}`
                  const pointsId = `${fieldId}-points-${draft.id}`
                  const editable = !busy && !applied
                  return (
                    <li key={draft.id} className={`show-prep-item${draft.selected ? "" : " unticked"}`} data-testid="show-prep-item" data-topic-id={draft.id}>
                      <label className="check show-prep-check">
                        <input type="checkbox" aria-label={`Save notes for ${title}`} checked={draft.selected} disabled={busy || applied || stale} onChange={(event) => editDraft(id, draft.id, (current) => ({ ...current, selected: event.target.checked }))} />
                        <span className="show-prep-title">{title}</span>
                      </label>
                      <label className="prep-field" htmlFor={summaryId}>
                        <span className="field-label">Summary</span>
                        <textarea
                          id={summaryId}
                          aria-label={`Summary for ${title}`}
                          aria-invalid={draft.summary.trim().length === 0 || notesLength(draft.summary.trim()) > MAX_SHOW_SUMMARY ? true : undefined}
                          className="notes-text"
                          disabled={!editable}
                          rows={3}
                          spellCheck
                          value={draft.summary}
                          onChange={(event) => {
                            const summary = event.target.value
                            editDraft(id, draft.id, (current) => ({ ...current, summary }))
                          }}
                        />
                        <span className="notes-meta">
                          <span className={`notes-count${notesLength(draft.summary.trim()) > MAX_SHOW_SUMMARY ? " over" : ""}`}>
                            {count.format(notesLength(draft.summary.trim()))} / {count.format(MAX_SHOW_SUMMARY)} characters
                          </span>
                        </span>
                      </label>
                      <label className="prep-field" htmlFor={pointsId}>
                        <span className="field-label">Talking points (one per line)</span>
                        <textarea
                          id={pointsId}
                          aria-label={`Talking points for ${title}`}
                          className="notes-text"
                          disabled={!editable}
                          rows={4}
                          spellCheck
                          value={draft.pointsText}
                          onChange={(event) => {
                            const text = event.target.value
                            editDraft(id, draft.id, (current) => ({ ...current, pointsText: text, points: parseNotePoints(text) }))
                          }}
                        />
                        <span className="notes-meta">
                          <span className="notes-count">
                            {count.format(draft.points.length)} points · {MIN_SHOW_POINTS} to {MAX_SHOW_POINTS}, each up to {MAX_SHOW_POINT} characters
                          </span>
                        </span>
                      </label>
                      {problem && draft.selected && !applied ? (
                        <p className="prep-status error" role="status">
                          {problem}
                        </p>
                      ) : null}
                    </li>
                  )
                })}
              </ol>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="prep-bar">
        <p className={`prep-status${prep.notice?.kind === "error" || run?.status === "failed" || run?.status === "interrupted" ? " error" : ""}`} data-testid="show-prep-status" role="status" aria-live="polite">
          {statusText}
        </p>
        <div className="prep-actions">
          {run && run.status === "succeeded" && drafts ? (
            <button type="button" className="btn activate" disabled={!canApply} title={applyBlock ?? "Append the ticked notes to their topics in the saved show"} onClick={() => apply(id)}>
              {applying ? "Saving…" : applied ? "Saved into the show" : "Save prepared notes"}
            </button>
          ) : null}
          <button type="button" className="btn primary" disabled={!canGenerate} title={generateBlock ?? undefined} onClick={generateAgain}>
            {generating ? "Preparing…" : run ? (run.status === "failed" || run.status === "interrupted" ? "Try again" : "Generate again") : "Prepare the show"}
          </button>
        </div>
      </div>

      {prep.confirmReplace ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby={`${fieldId}-replace-title`}>
            <h2 id={`${fieldId}-replace-title`}>Replace your edited notes?</h2>
            <p>You edited the prepared notes below and have not saved them into the show. Generating again replaces them with a new result.</p>
            <div className="banner-actions">
              <button type="button" className="btn primary" autoFocus onClick={() => patch(id, (value) => ({ ...value, confirmReplace: false }))}>
                Keep my notes
              </button>
              <button type="button" className="btn" onClick={() => void generate(id, null)}>
                Discard and generate again
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
