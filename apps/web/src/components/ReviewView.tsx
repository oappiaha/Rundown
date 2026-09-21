import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { FormEvent } from "react"
import { ApiError, getReview, listReviews, putReview, type ReviewDetail, type ReviewRating, type ReviewTopic, type ReviewVersion } from "../lib/api"
import { formatClock } from "../lib/draft"
import {
  MAX_ACTUAL_SECONDS,
  MAX_REVIEW_NOTE,
  actualProblem,
  deltaLabel,
  deltaOf,
  draftFromTopic,
  formatPublished,
  formatReviewed,
  isReviewDirty,
  noteLength,
  noteProblem,
  ratingLabel,
  rebaseDraft,
  reviewProblem,
  toReviewWire,
  type ReviewDraft,
} from "../lib/reviewDraft"

type Props = { hidden: boolean }

type Notice = { kind: "info" | "error"; text: string }
/** Reads never lock the list; writes (save) and conflict recovery lock everything. */
type Pending = "load" | "save" | "recover" | null
/** A rejected save. Every draft field is kept; the user picks the recovery. */
type Conflict = { detail: string }
/** An action that would drop unsaved review work; the user confirms first. */
type Guard = { kind: "version"; id: number } | { kind: "topic"; id: number } | { kind: "refresh" }
/** A failed list request, retained so Retry repeats exactly that request (the newest page, or the older page before `cursor`). */
type ListFailure = { text: string; retry: "refresh" } | { text: string; retry: "older"; cursor: number }

const PAGE = 20
const RATINGS: ReviewRating[] = [1, 0, -1]
const CHANGED_ELSEWHERE = "This review was saved on another screen since you opened it."

function describeError(error: unknown, what: string): string {
  if (error instanceof ApiError) return `${what} rejected (${error.status}): ${error.detail}`
  return `${what} failed: the RUNDOWN API did not respond.`
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * Show review: browse published versions (snapshots taken by "Publish
 * schedule", not proven stream sessions) and record a rating, note and
 * hand-entered actual seconds per topic. Every save is explicit and guarded by
 * the feedback revision; nothing here reads or writes the live show. Stays
 * mounted while hidden so an unsaved review survives a trip to other views.
 */
export default function ReviewView({ hidden }: Props) {
  const [versions, setVersions] = useState<ReviewVersion[] | null>(null)
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null)
  const [listError, setListError] = useState<ListFailure | null>(null)
  const [listPending, setListPending] = useState<"refresh" | "older" | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<ReviewDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [draft, setDraftState] = useState<ReviewDraft | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [guard, setGuard] = useState<Guard | null>(null)

  const draftRef = useRef<ReviewDraft | null>(null)
  /** Bumped on every version or topic selection change; a load/save/recover result for an older token is dropped. */
  const selectionSeq = useRef(0)
  /** Bumped on every list reset; an older list page never replaces or extends a newer one. */
  const listSeq = useRef(0)
  const opSeq = useRef(0)
  const loadedOnce = useRef(false)
  const noteId = useId()
  const actualId = useId()
  const dialogId = useId()
  const topicsTitleId = useId()
  const editorTitleId = useId()

  const setDraft = useCallback((next: ReviewDraft | null | ((current: ReviewDraft | null) => ReviewDraft | null)) => {
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

  // ---- Version list -----------------------------------------------------------
  /** Replace the list with the newest page. Only server rows change; the open version, topic and draft are never touched. */
  const refreshList = useCallback((): Promise<void> => {
    const token = ++listSeq.current
    setListPending((current) => current ?? "refresh")
    return listReviews({ limit: PAGE }).then(
      (page) => {
        if (token !== listSeq.current) return
        setVersions(page.versions)
        setNextBeforeId(page.next_before_id)
        setListError(null)
        setListPending(null)
      },
      (error: unknown) => {
        if (token !== listSeq.current) return
        setListError({ text: describeError(error, "Loading the published versions"), retry: "refresh" })
        setListPending(null)
      },
    )
  }, [])

  /** Append the page before the cursor. A reset that happened meanwhile wins: the older page is dropped. */
  function loadOlder(before: number | null = nextBeforeId) {
    const cursor = before
    if (cursor === null || listPending !== null) return
    const token = listSeq.current
    setListPending("older")
    setListError(null)
    listReviews({ limit: PAGE, beforeId: cursor }).then(
      (page) => {
        if (token !== listSeq.current) return
        setVersions((current) => {
          const seen = new Set((current ?? []).map((version) => version.id))
          return [...(current ?? []), ...page.versions.filter((version) => !seen.has(version.id))]
        })
        setNextBeforeId(page.next_before_id)
        setListPending(null)
      },
      (error: unknown) => {
        if (token !== listSeq.current) return
        setListError({ text: describeError(error, "Loading older versions"), retry: "older", cursor })
        setListPending(null)
      },
    )
  }

  /** Repeat exactly the request that failed: never turn a failed refresh into an older-page load or vice versa. */
  function retryList() {
    const failure = listError
    if (!failure || listPending !== null) return
    if (failure.retry === "refresh") void refreshList()
    else loadOlder(failure.cursor)
  }

  // Load the list the first time the view is shown; later visits keep what is there (Refresh is explicit).
  useEffect(() => {
    if (hidden || loadedOnce.current) return
    loadedOnce.current = true
    void refreshList()
  }, [hidden, refreshList])

  // ---- Selection ----------------------------------------------------------------
  const locked = pending === "save" || pending === "recover"
  const dirty = draft !== null && isReviewDirty(draft)

  function replaceDetailTopic(versionId: number, topic: ReviewTopic) {
    setDetail((current) => (current && current.id === versionId ? { ...current, topics: current.topics.map((entry) => (entry.id === topic.id ? topic : entry)) } : current))
  }

  async function loadVersion(id: number, keepTopic: number | null) {
    const token = ++selectionSeq.current
    setSelectedId(id)
    setDetail((current) => (current?.id === id ? current : null))
    setDetailError(null)
    setDraft(null)
    setNotice(null)
    setConflict(null)
    const op = begin("load")
    try {
      const loaded = await getReview(id)
      if (token !== selectionSeq.current) return
      setDetail(loaded)
      const topic = (keepTopic !== null ? loaded.topics.find((entry) => entry.id === keepTopic) : undefined) ?? loaded.topics[0]
      setDraft(topic ? draftFromTopic(topic, loaded.id) : null)
    } catch (error) {
      if (token !== selectionSeq.current) return
      setDetail(null)
      setDetailError(
        error instanceof ApiError && error.status === 404 ? "This published version no longer exists. Refresh the list to see what is available." : describeError(error, "Opening the version"),
      )
    } finally {
      end(op)
    }
  }

  function openVersion(version: ReviewVersion) {
    if (locked) return
    if (selectedId === version.id && detail !== null) return
    if (dirty) {
      setGuard({ kind: "version", id: version.id })
      return
    }
    void loadVersion(version.id, null)
  }

  function openTopic(topicId: number) {
    if (locked || detail === null) return
    if (draft?.topicId === topicId) return
    if (dirty) {
      setGuard({ kind: "topic", id: topicId })
      return
    }
    selectionSeq.current += 1
    setNotice(null)
    setConflict(null)
    const topic = detail.topics.find((entry) => entry.id === topicId)
    setDraft(topic ? draftFromTopic(topic, detail.id) : null)
  }

  /** Reset the list to the newest page and, when nothing is being edited, re-read the open version too. */
  function refreshNow() {
    if (locked) return
    if (dirty) {
      setGuard({ kind: "refresh" })
      return
    }
    setNotice(null)
    void refreshList()
    if (selectedId !== null) void loadVersion(selectedId, draftRef.current?.topicId ?? null)
  }

  function confirmGuard() {
    const next = guard
    setGuard(null)
    if (!next) return
    // Drop the unsaved review explicitly, then continue with what was asked.
    setConflict(null)
    if (next.kind === "version") {
      setDraft(null)
      void loadVersion(next.id, null)
    } else if (next.kind === "topic") {
      setDraft(null)
      setNotice({ kind: "info", text: "Your changes were discarded." })
      if (detail) {
        selectionSeq.current += 1
        const topic = detail.topics.find((entry) => entry.id === next.id)
        setDraft(topic ? draftFromTopic(topic, detail.id) : null)
      }
    } else {
      const topicId = draftRef.current?.topicId ?? null
      setDraft(null)
      void refreshList()
      if (selectedId !== null) void loadVersion(selectedId, topicId)
    }
  }

  // ---- Editing ------------------------------------------------------------------
  const edit = useCallback(
    (patch: Partial<Pick<ReviewDraft, "rating" | "note" | "actual">>) => {
      if (locked) return
      setDraft((current) => (current ? { ...current, ...patch } : current))
      setNotice(null)
    },
    [locked, setDraft],
  )

  function discardEdits() {
    if (!draft || locked) return
    setConflict(null)
    setDraft({ ...draft, ...draft.base })
    setNotice({ kind: "info", text: "Your changes were discarded. Showing the saved review." })
  }

  // ---- Save (explicit; the only write) ---------------------------------------------
  const problem = draft ? reviewProblem(draft) : null

  async function save(event?: FormEvent) {
    event?.preventDefault()
    const target = draftRef.current
    if (!target || locked || pending === "load" || problem !== null || !dirty || conflict !== null) return
    const token = selectionSeq.current
    const op = begin("save")
    setNotice(null)
    try {
      const saved = await putReview(target.versionId, target.topicId, toReviewWire(target))
      // The save is a fact whatever the screen shows now; the counts and the
      // topic row reflect it. The draft is only replaced when it is still the
      // one that was sent, so a late answer never lands on another selection.
      replaceDetailTopic(target.versionId, saved)
      if (token === selectionSeq.current && draftRef.current === target) {
        setDraft(draftFromTopic(saved, target.versionId))
        setConflict(null)
        setNotice({ kind: "info", text: `Saved the review of "${saved.text}". The live show is untouched.` })
      }
      void refreshList()
    } catch (error) {
      if (token !== selectionSeq.current || draftRef.current !== target) return
      if (error instanceof ApiError && error.status === 409) {
        setConflict({ detail: error.detail })
      } else if (error instanceof ApiError && error.status === 404) {
        setNotice({ kind: "error", text: "Not saved: this topic or version no longer exists. Your changes are kept here; refresh the list to see what is available." })
      } else {
        setNotice({ kind: "error", text: describeError(error, "Save") })
      }
    } finally {
      end(op)
    }
  }

  /**
   * Conflict recovery, always explicit. "reload" drops the local values for
   * the saved review; "mine" keeps every local value on top of the latest
   * revision so the next Save review overwrites it deliberately. A failed
   * re-read leaves the draft and the conflict as they were, controls enabled.
   */
  async function recover(mode: "reload" | "mine") {
    const current = draftRef.current
    if (!current || locked) return
    const token = selectionSeq.current
    const op = begin("recover")
    setNotice(null)
    try {
      const latestVersion = await getReview(current.versionId)
      if (token !== selectionSeq.current || draftRef.current !== current) return
      setDetail((existing) => (existing?.id === latestVersion.id || existing === null ? latestVersion : existing))
      const latest = latestVersion.topics.find((entry) => entry.id === current.topicId)
      if (!latest) {
        setNotice({ kind: "error", text: "This topic is no longer part of the published version. Your changes are kept here." })
        return
      }
      setConflict(null)
      if (mode === "reload") {
        setDraft(draftFromTopic(latest, current.versionId))
        setNotice({ kind: "info", text: "Reloaded the saved review. Your changes were discarded." })
      } else {
        const rebased = rebaseDraft(current, latest)
        setDraft(rebased)
        setNotice({
          kind: "info",
          text: isReviewDirty(rebased)
            ? "Kept your values on top of the latest saved review. Press Save review to overwrite it."
            : "Nothing left to save: the latest saved review already matches your values.",
        })
      }
    } catch (error) {
      if (token !== selectionSeq.current || draftRef.current !== current) return
      setNotice({
        kind: "error",
        text:
          error instanceof ApiError && error.status === 404
            ? "This published version no longer exists. Your changes are kept here."
            : `${describeError(error, "Loading the latest review")} Your changes are kept; try again.`,
      })
    } finally {
      end(op)
    }
  }

  // ---- Render ---------------------------------------------------------------------
  const readOnly = locked || pending === "load"
  const selectedVersion = selectedId !== null ? (versions?.find((version) => version.id === selectedId) ?? null) : null
  const actualIssue = draft ? actualProblem(draft.actual) : null
  const noteIssue = draft ? noteProblem(draft.note) : null
  const delta = draft && actualIssue === null ? deltaOf(draft.planned, draft.actual) : null
  const savedTopic = draft && detail ? (detail.topics.find((entry) => entry.id === draft.topicId) ?? null) : null
  const statusText = notice
    ? notice.text
    : problem
      ? problem
      : pending === "save"
        ? "Saving the review…"
        : pending === "recover"
          ? "Loading the latest saved review…"
          : pending === "load"
            ? "Opening…"
            : draft === null
              ? "Pick a topic to review it."
              : dirty
                ? "Unsaved review. Press Save review to keep it."
                : draft.baseRevision === 0
                  ? "Not reviewed yet. Rate it, add a note or record the actual seconds, then save."
                  : "Saved. Edit and save again to record a new revision."

  return (
    <main className="main shows review" id="review" hidden={hidden} aria-labelledby="review-title">
      <header className="main-head">
        <div className="main-eyebrow">
          <span className="head-lbl">Published versions · newest first · rating, note and actual seconds are saved per topic, only when you press Save review</span>
        </div>
        <h1 id="review-title" className="main-title">
          Show review
        </h1>
      </header>

      <p className="review-intro">
        Review a published version after your show. Each version is the snapshot taken when the schedule was published, not a record of a completed
        stream. Actual durations are recorded by hand: nothing is timed automatically, and saving a review never changes the live show.
      </p>

      <div className="shows-layout review-layout">
        <section className="shows-list" aria-labelledby="review-list-title">
          <div className="shows-list-head">
            <h2 id="review-list-title">Published versions</h2>
            <div className="shows-list-actions">
              <button type="button" className="btn" disabled={listPending !== null || locked} onClick={refreshNow} title="Reload the newest versions and the open version from the server">
                {listPending === "refresh" ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>

          {listError ? (
            <div className="banner error" role="alert">
              <p>{listError.text}</p>
              <div className="banner-actions">
                <button type="button" className="btn" disabled={listPending !== null} data-retry={listError.retry} onClick={retryList}>
                  Retry
                </button>
              </div>
            </div>
          ) : null}

          {versions === null ? (
            <div className="empty">{listError ? "The list could not be loaded." : "Loading published versions…"}</div>
          ) : versions.length === 0 ? (
            <div className="empty">No published versions yet. Publish a schedule from Tonight's Show, then come back after the show to review it.</div>
          ) : (
            <ul className="show-cards review-cards" aria-label="Published versions">
              {versions.map((version) => {
                const selected = selectedId === version.id
                return (
                  <li key={version.id}>
                    <button
                      type="button"
                      className={`show-card review-card${selected ? " on" : ""}`}
                      aria-current={selected ? "true" : undefined}
                      aria-label={`Open version ${version.id}`}
                      data-version-id={version.id}
                      disabled={locked}
                      onClick={() => openVersion(version)}
                    >
                      <span className="show-card-name">{formatPublished(version.published_at)}</span>
                      <span className="show-card-meta">
                        Version {version.id} · {plural(version.topic_count, "topic", "topics")} · {formatClock(version.planned_seconds)} planned
                      </span>
                      <span className={`show-card-meta review-count${version.reviewed_count > 0 ? " some" : ""}`} data-reviewed={version.reviewed_count}>
                        {version.reviewed_count === 0 ? "Nothing reviewed yet" : `${version.reviewed_count} of ${version.topic_count} reviewed`}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {versions !== null && nextBeforeId !== null ? (
            <button type="button" className="btn review-older" disabled={listPending !== null || locked} onClick={() => loadOlder()}>
              {listPending === "older" ? "Loading older…" : "Load older versions"}
            </button>
          ) : versions !== null && versions.length > 0 ? (
            <p className="reuse-hint review-end">That is the oldest published version.</p>
          ) : null}
        </section>

        <section className="show-editor review-editor" aria-labelledby={editorTitleId} aria-busy={pending !== null || undefined}>
          <h2 id={editorTitleId} className="visually-hidden">
            Version review
          </h2>

          {selectedId === null ? (
            <div className="empty">Nothing open. Pick a published version on the left.</div>
          ) : detailError ? (
            <div className="banner error" role="alert">
              <p>{detailError}</p>
              <div className="banner-actions">
                <button type="button" className="btn" disabled={pending !== null} onClick={() => void loadVersion(selectedId, null)}>
                  Retry
                </button>
              </div>
            </div>
          ) : detail === null ? (
            <div className="empty">Opening version {selectedId}…</div>
          ) : (
            <>
              <div className="show-editor-head review-head">
                <div className="review-version">
                  <span className="field-label">Version {detail.id}</span>
                  <span className="review-stamp" data-testid="review-published">
                    Published {formatPublished(detail.published_at)}
                  </span>
                </div>
                {selectedVersion ? (
                  <span className="review-summary" data-testid="review-summary">
                    {plural(selectedVersion.topic_count, "topic", "topics")} · {formatClock(selectedVersion.planned_seconds)} planned · {selectedVersion.reviewed_count} reviewed
                  </span>
                ) : null}
              </div>

              <section className="reuse review-topics" aria-labelledby={topicsTitleId}>
                <h3 id={topicsTitleId}>Topics</h3>
                {detail.topics.length === 0 ? (
                  <p className="reuse-hint">This version has no topics.</p>
                ) : (
                  <ol className="reuse-list review-topic-list" aria-label="Topics in this version">
                    {detail.topics.map((topic, index) => {
                      const open = draft?.topicId === topic.id
                      return (
                        <li key={topic.id}>
                          <button
                            type="button"
                            className={`review-topic${open ? " on" : ""}`}
                            aria-current={open ? "true" : undefined}
                            aria-label={`Review ${topic.text}`}
                            data-topic-id={topic.id}
                            data-reviewed={topic.revision > 0 ? "true" : "false"}
                            disabled={readOnly}
                            onClick={() => openTopic(topic.id)}
                          >
                            <span className="review-topic-num" aria-hidden="true">
                              {index + 1}
                            </span>
                            <span className="review-topic-body">
                              <span className="review-topic-title">{topic.text}</span>
                              <span className="review-topic-meta">
                                {formatClock(topic.planned_seconds)} planned
                                {topic.actual_seconds !== null ? ` · ${topic.actual_seconds} s actual` : ""}
                                {topic.revision > 0 ? ` · ${ratingLabel(topic.rating)}` : " · Not reviewed"}
                              </span>
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ol>
                )}
              </section>

              {draft === null ? (
                <footer className="publish-bar show-bar review-bar">
                  <p className={`publish-status${notice?.kind === "error" ? " error" : ""}`} aria-live="polite">
                    {statusText}
                  </p>
                </footer>
              ) : (
                <form className="inbox-form review-form" aria-label={`Review of ${draft.text}`} onSubmit={(event) => void save(event)}>
                  {conflict ? (
                    <div className="banner error" role="alert">
                      <p>
                        <strong>Not saved.</strong> {CHANGED_ELSEWHERE} Your rating, note and actual seconds are kept here. Reloading shows the saved review and
                        discards your changes; using your changes keeps your values and lets you save them over the latest revision.
                      </p>
                      <div className="banner-actions">
                        <button type="button" className="btn primary" disabled={locked} onClick={() => void recover("mine")}>
                          Use my changes on latest revision
                        </button>
                        <button type="button" className="btn" disabled={locked} onClick={() => void recover("reload")}>
                          Reload saved review
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="review-facts">
                    <h3 className="review-topic-heading" data-testid="review-title">
                      {draft.text}
                    </h3>
                    <dl className="review-fact-list">
                      <div className="review-fact">
                        <dt>Planned</dt>
                        <dd data-testid="review-planned">
                          {formatClock(draft.planned)} ({draft.planned} s)
                        </dd>
                      </div>
                      <div className="review-fact">
                        <dt>Actual</dt>
                        <dd data-testid="review-delta">{delta === null ? "Not recorded" : `${deltaLabel(delta)}`}</dd>
                      </div>
                      <div className="review-fact">
                        <dt>Saved</dt>
                        <dd data-testid="review-saved">{formatReviewed(savedTopic?.updated_at ?? null)}</dd>
                      </div>
                    </dl>
                    <div className="review-context">
                      <span className="field-label">Context (private, read-only)</span>
                      {draft.context.length > 0 ? (
                        <pre className="provenance-text review-context-text" data-testid="review-context">
                          {draft.context}
                        </pre>
                      ) : (
                        <p className="reuse-hint" data-testid="review-context">
                          No context was saved with this topic.
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="review-rating">
                    <span className="field-label" id={`${dialogId}-rating`}>
                      Rating
                    </span>
                    <div className="seg review-seg" role="group" aria-labelledby={`${dialogId}-rating`}>
                      {RATINGS.map((rating) => (
                        <button
                          key={rating}
                          type="button"
                          className={`seg-btn${draft.rating === rating ? " on" : ""}`}
                          aria-pressed={draft.rating === rating}
                          data-rating={rating}
                          disabled={readOnly}
                          onClick={() => edit({ rating })}
                        >
                          {ratingLabel(rating)}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="inbox-fields review-fields">
                    <label className="field seconds review-actual" htmlFor={actualId}>
                      <span>Actual seconds</span>
                      <input
                        id={actualId}
                        aria-label="Actual seconds"
                        aria-invalid={actualIssue ? true : undefined}
                        aria-describedby={`${actualId}-hint`}
                        disabled={readOnly}
                        inputMode="numeric"
                        min={0}
                        max={MAX_ACTUAL_SECONDS}
                        step={1}
                        placeholder="blank = not recorded"
                        type="number"
                        value={draft.actual}
                        onChange={(event) => edit({ actual: event.target.value })}
                      />
                    </label>
                    <span id={`${actualId}-hint`} className={actualIssue ? "tproblem review-hint" : "notes-hint review-hint"}>
                      {actualIssue ?? "Optional. Enter the seconds the topic really took, as you timed it; leave blank if you did not record it. 0 is a valid value."}
                    </span>
                  </div>

                  <div className="inbox-context review-note">
                    <label className="field-label" htmlFor={noteId}>
                      Review note
                    </label>
                    <textarea
                      id={noteId}
                      className="notes-text"
                      aria-label="Review note"
                      aria-invalid={noteIssue ? true : undefined}
                      disabled={readOnly}
                      rows={4}
                      placeholder="What worked, what to change next time…"
                      value={draft.note}
                      onChange={(event) => edit({ note: event.target.value })}
                    />
                    <div className="notes-meta">
                      <span className="notes-hint">Optional. Kept with this topic of this version only.</span>
                      <span className={`notes-count${noteIssue ? " over" : ""}`}>
                        {noteLength(draft.note)} / {MAX_REVIEW_NOTE}
                      </span>
                    </div>
                  </div>

                  <footer className="publish-bar show-bar review-bar">
                    <p className={`publish-status${notice?.kind === "error" ? " error" : ""}`} aria-live="polite">
                      {statusText}
                    </p>
                    <div className="publish-actions show-actions">
                      {dirty ? (
                        <button type="button" className="btn" disabled={readOnly} onClick={discardEdits}>
                          Discard edits
                        </button>
                      ) : null}
                      <button type="submit" className="btn primary" disabled={readOnly || !dirty || problem !== null || conflict !== null}>
                        {pending === "save" ? "Saving…" : "Save review"}
                      </button>
                    </div>
                  </footer>
                </form>
              )}
            </>
          )}
        </section>
      </div>

      {guard ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby={`${dialogId}-guard`}>
            <h2 id={`${dialogId}-guard`}>Unsaved review</h2>
            <p>
              {`The review of "${draft?.text ?? "this topic"}" has unsaved changes. `}
              {guard.kind === "version" ? `Opening version ${guard.id} will discard them.` : guard.kind === "topic" ? "Opening another topic will discard them." : "Refreshing will discard them."}
            </p>
            <div className="banner-actions">
              <button type="button" className="btn primary" autoFocus onClick={() => setGuard(null)}>
                Keep editing
              </button>
              <button type="button" className="btn" onClick={confirmGuard}>
                Discard changes
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}
