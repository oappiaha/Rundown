import { useEffect, useId, useRef } from "react"
import { ApiError, getFeedSchedule, putFeedSchedule, type Feed, type FeedSchedule } from "../lib/api"
import { stampLabel } from "../lib/feedDraft"
import {
  DEFAULT_INTERVAL,
  MAX_INTERVAL,
  MIN_INTERVAL,
  draftFromSchedule,
  dueInLabel,
  dueLabel,
  intervalLabel,
  intervalProblem,
  isScheduleDirty,
  lastAutomaticSummary,
  localTimeZone,
  mergeScheduleDraft,
  scheduleProblem,
  toScheduleWire,
} from "../lib/scheduleDraft"
import { EMPTY_SLOT, type ScheduleSlot, type ScheduleStore } from "../lib/scheduleStore"

type Props = {
  feedId: string
  feedName: string
  refreshKey: number
  /** The Sources view is not shown: no polling. */
  hidden: boolean
  store: ScheduleStore
  /** Server-side status of the feed from the list (enabled, lease), or null while unknown. */
  feed: Feed | null
  /** The feed editor has unsaved edits: schedule actions wait until they are saved or discarded. */
  parentDirty: boolean
  /** The feed editor is loading, saving or recovering. */
  parentLocked: boolean
  /** A new automatic run finished (any status): reload feeds, history and the inbox. */
  onAutomaticRun: () => void
  /** The feed no longer exists on the server. */
  onFeedGone: () => void
}

const POLL_MS = 5000
const CHANGED_ELSEWHERE = "This schedule was changed elsewhere since you opened it."

function describeError(error: unknown, what: string): string {
  if (error instanceof ApiError) return `${what} rejected (${error.status}): ${error.detail}`
  return `${what} failed: the RUNDOWN API did not respond.`
}

/** A finished automatic run that was not the one shown before: the inbox and history moved. */
function newAutomaticRun(previous: FeedSchedule | null, next: FeedSchedule): boolean {
  if (previous === null) return next.last_run !== null && next.last_run.status !== "running"
  const run = next.last_run
  if (run === null || run.status === "running") return false
  const before = previous.last_run
  return before === null || before.id !== run.id || before.status === "running"
}

/**
 * Automatic imports for one saved feed: on/off and an interval, saved only on
 * request. The server owns the clock and runs due imports itself while the
 * API process is up; this panel reads the outcome (next due time, last
 * automatic run) and refreshes the rest of the Sources view when a new
 * automatic run has finished. Draft settings live in the Sources view's store,
 * keyed by feed, so switching feeds or refreshing never drops an unsaved edit
 * and a slow answer for another feed never lands here.
 */
export default function FeedSchedulePanel({ feedId, feedName, refreshKey, hidden, store, feed, parentDirty, parentLocked, onAutomaticRun, onFeedGone }: Props) {
  const slot: ScheduleSlot = store.slots[feedId] ?? EMPTY_SLOT
  const { patch, ref, seq } = store
  const titleId = useId()
  const enabledId = useId()
  const intervalId = useId()
  const onAutomaticRunRef = useRef(onAutomaticRun)
  const onFeedGoneRef = useRef(onFeedGone)
  useEffect(() => {
    onAutomaticRunRef.current = onAutomaticRun
    onFeedGoneRef.current = onFeedGone
  }, [onAutomaticRun, onFeedGone])

  // ---- Reading -------------------------------------------------------------------
  /**
   * Re-read the schedule. Server state (next due, last automatic run,
   * revision) always lands. The draft's fields are never touched by a poll;
   * an explicit read (first open, Refresh schedule) replaces the draft only
   * when it has no unsaved edits, so a dirty draft is never overwritten and a
   * stale clean one is caught by the revision guard on save. Dropped when a
   * newer read for the same feed started meanwhile.
   */
  function load(mode: "initial" | "refresh" | "poll"): Promise<void> {
    if ((ref.current[feedId]?.pending ?? null) !== null) return Promise.resolve()
    const token = (seq.get(feedId) ?? 0) + 1
    seq.set(feedId, token)
    if (mode !== "poll") patch(feedId, (current) => ({ ...current, pending: "load", loadError: null, ...(mode === "refresh" ? { notice: null } : {}) }))
    return getFeedSchedule(feedId).then(
      (next) => {
        if (seq.get(feedId) !== token) return
        const previous = ref.current[feedId] ?? EMPTY_SLOT
        const arrived = newAutomaticRun(previous.schedule, next)
        patch(feedId, (current) => {
          const keep = mode === "poll" ? current.draft !== null : current.draft !== null && isScheduleDirty(current.draft)
          return {
            ...current,
            schedule: next,
            draft: keep ? current.draft : draftFromSchedule(next),
            loadError: null,
            pending: mode === "poll" ? current.pending : null,
            notice: mode === "refresh" ? (keep ? { kind: "info", text: "Schedule refreshed. Your unsaved schedule edits are kept." } : null) : current.notice,
          }
        })
        if (arrived) onAutomaticRunRef.current()
      },
      (error: unknown) => {
        if (seq.get(feedId) !== token) return
        patch(feedId, (current) => ({
          ...current,
          loadError: mode === "poll" && current.schedule !== null ? current.loadError : describeError(error, "Loading the schedule"),
          pending: mode === "poll" ? current.pending : null,
        }))
        if (error instanceof ApiError && error.status === 404) onFeedGoneRef.current()
      },
    )
  }
  const loadRef = useRef(load)
  loadRef.current = load

  // First read for a feed whose schedule has not been seen yet; a silent
  // re-read whenever the panel is shown again for a feed already read, so an
  // automatic run that finished while the view was hidden (or another feed was
  // open) is noticed and the inbox/history reloaded on reopen.
  useEffect(() => {
    if (hidden || parentLocked) return
    const current = ref.current[feedId] ?? EMPTY_SLOT
    if (current.pending !== null) return
    if (current.schedule === null) {
      if (current.loadError === null) void loadRef.current("initial")
      return
    }
    void loadRef.current("poll")
  }, [feedId, hidden, ref, feed?.enabled, parentLocked, refreshKey])

  // Poll while visible and the server may run an import on its own (effective schedule) or one is running.
  const polling = !hidden && slot.schedule !== null && (slot.schedule.effective || slot.schedule.last_run?.status === "running")
  useEffect(() => {
    if (!polling) return
    let inflight = false
    const timer = window.setInterval(() => {
      if (inflight) return
      inflight = true
      void loadRef.current("poll").finally(() => {
        inflight = false
      })
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [polling, feedId])

  // ---- Editing -------------------------------------------------------------------
  const locked = slot.pending !== null || parentLocked
  const draft = slot.draft
  const dirty = draft !== null && isScheduleDirty(draft)
  const problem = draft ? scheduleProblem(draft) : null

  function edit(update: Partial<Pick<NonNullable<ScheduleSlot["draft"]>, "enabled" | "interval_minutes">>) {
    if (locked) return
    patch(feedId, (current) => (current.draft ? { ...current, draft: { ...current.draft, ...update }, notice: null } : current))
  }

  function discardEdits() {
    if (locked) return
    patch(feedId, (current) => (current.draft ? { ...current, draft: { ...current.draft, ...current.draft.base }, conflict: null, notice: { kind: "info", text: "Your schedule edits were discarded. Showing the saved schedule." } } : current))
  }

  // ---- Saving (explicit, never fetches the feed) -------------------------------------
  const saveBlock: string | null =
    slot.pending === "save"
      ? "Saving the schedule…"
      : locked
        ? "Wait for the feed to finish loading or saving."
        : draft === null
          ? "Waiting for the schedule…"
          : parentDirty
            ? "Save or discard your feed edits before changing the schedule."
            : slot.conflict !== null
              ? "Resolve the schedule conflict above first."
              : problem !== null
                ? problem
                : null

  async function save() {
    const target = ref.current[feedId]?.draft ?? null
    if (!target || saveBlock !== null || !isScheduleDirty(target) || ref.current[feedId]?.pending !== null) return
    seq.set(feedId, (seq.get(feedId) ?? 0) + 1)
    patch(feedId, (current) => ({ ...current, pending: "save", notice: null }))
    try {
      const saved = await putFeedSchedule(feedId, toScheduleWire(target))
      const previous = ref.current[feedId]?.schedule ?? null
      const arrived = newAutomaticRun(previous, saved)
      patch(feedId, (current) => ({
        ...current,
        schedule: saved,
        // Editing is locked while saving, so the draft is what we sent unless a recovery replaced it.
        draft: current.draft === target ? draftFromSchedule(saved) : current.draft,
        conflict: null,
        pending: null,
        notice: {
          kind: "info",
          text: saved.enabled
            ? saved.effective && saved.next_run_at
              ? `Schedule saved: on, ${intervalLabel(saved.interval_minutes)}. Next automatic import ${dueLabel(saved.next_run_at)}.`
              : `Schedule saved: on, ${intervalLabel(saved.interval_minutes)}, but paused${saved.reason ? `: ${saved.reason}` : "."}`
            : "Schedule saved: off. Imports happen only when you press Import now.",
        },
      }))
      if (arrived) onAutomaticRunRef.current()
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // Stale revision, or refused while an import holds the feed? Only a newer server version needs the merge/reload recovery.
        let stale = true
        let latest: FeedSchedule | null = null
        try {
          latest = await getFeedSchedule(feedId)
          stale = latest.revision !== target.baseRevision
        } catch {
          // Cannot tell: offer the explicit recovery, which re-reads anyway.
        }
        const detail = error.detail
        patch(feedId, (current) => ({
          ...current,
          schedule: latest ?? current.schedule,
          pending: null,
          conflict: stale ? { detail } : current.conflict,
          notice: stale ? null : { kind: "error", text: `Not saved: ${detail} Your schedule edits are kept here; press Save schedule again when the import has finished.` },
        }))
      } else if (error instanceof ApiError && error.status === 404) {
        patch(feedId, (current) => ({ ...current, pending: null, notice: { kind: "error", text: "Not saved: this feed no longer exists." } }))
        onFeedGoneRef.current()
      } else {
        const text = error instanceof ApiError && error.status === 422 ? `Not saved: ${error.detail}` : describeError(error, "Saving the schedule")
        patch(feedId, (current) => ({ ...current, pending: null, notice: { kind: "error", text } }))
      }
    }
  }

  /** Conflict recovery, always explicit: reload the latest version (dropping edits) or merge onto it. */
  async function recover(mode: "reload" | "merge") {
    const current = ref.current[feedId]?.draft ?? null
    if (!current || locked) return
    const token = (seq.get(feedId) ?? 0) + 1
    seq.set(feedId, token)
    patch(feedId, (slotNow) => ({ ...slotNow, pending: "recover", notice: null }))
    try {
      const latest = await getFeedSchedule(feedId)
      if (seq.get(feedId) !== token) return
      const merged = mode === "merge" ? mergeScheduleDraft(current, latest) : draftFromSchedule(latest)
      patch(feedId, (slotNow) => ({
        ...slotNow,
        schedule: latest,
        draft: slotNow.draft === current ? merged : slotNow.draft,
        conflict: null,
        pending: null,
        loadError: null,
        notice: {
          kind: "info",
          text:
            mode === "reload"
              ? "Reloaded the latest schedule. Your edits were discarded."
              : isScheduleDirty(merged)
                ? "Merged the other changes into your schedule edits. Save schedule when ready."
                : "Nothing left to save: the latest schedule already has your changes.",
        },
      }))
    } catch (error) {
      if (seq.get(feedId) !== token) return
      patch(feedId, (slotNow) => ({ ...slotNow, pending: null, notice: { kind: "error", text: error instanceof ApiError && error.status === 404 ? "This feed no longer exists." : describeError(error, "Loading the latest schedule") } }))
      if (error instanceof ApiError && error.status === 404) onFeedGoneRef.current()
    }
  }

  // ---- Render ---------------------------------------------------------------------
  const schedule = slot.schedule
  const refreshBlock: string | null = slot.pending !== null ? "Working…" : parentLocked ? "Wait for the feed to finish loading or saving." : parentDirty ? "Save or discard your feed edits first." : null
  const shownProblem = draft ? intervalProblem(draft.interval_minutes) : null
  const zone = localTimeZone()
  const feedDisabled = feed !== null && !feed.enabled
  const statusText = slot.notice
    ? slot.notice.text
    : slot.pending === "save"
      ? "Saving the schedule…"
      : slot.pending === "recover"
        ? "Loading the latest schedule…"
        : slot.pending === "load"
          ? "Loading the schedule…"
          : slot.loadError
            ? slot.loadError
            : schedule === null || draft === null
              ? "Loading the schedule…"
          : dirty
            ? "Unsaved schedule changes. Nothing changes until you press Save schedule."
            : schedule.enabled && schedule.effective
              ? `On, ${intervalLabel(schedule.interval_minutes)}. The RUNDOWN API imports on its own while it is running; nothing runs while it is stopped.`
              : schedule.enabled
                ? `On, but paused${schedule.reason ? `: ${schedule.reason}` : "."}`
                : "Off. Imports happen only when you press Import now."
  // A paused schedule (feed disabled, scheduler off) promises nothing, even if a due time is still stored.
  const nextText =
    schedule === null
      ? "—"
      : !schedule.enabled
        ? "Not scheduled"
        : !schedule.effective
          ? `Paused${schedule.reason ? `: ${schedule.reason}` : ""}`
          : schedule.next_run_at
            ? `${dueLabel(schedule.next_run_at)} · ${dueInLabel(schedule.next_run_at, schedule.server_time)}`
            : "Waiting for the server to set the next time"

  return (
    <section
      className="reuse schedule-panel"
      aria-labelledby={titleId}
      aria-busy={slot.pending !== null || undefined}
      data-feed-id={feedId}
      data-schedule-revision={schedule?.revision ?? ""}
      data-schedule-effective={schedule ? String(schedule.effective) : ""}
      data-schedule-dirty={String(dirty)}
    >
      <h3 id={titleId}>Schedule</h3>
      <p>
        Imports this feed on a fixed interval, with the same rules as Import now, while the RUNDOWN API is running. Nothing changes until you press Save schedule; saving never fetches the feed.
      </p>

      {slot.loadError && schedule === null ? (
        <div className="banner error" role="alert">
          <p>{slot.loadError}</p>
          <div className="banner-actions">
            <button type="button" className="btn" disabled={slot.pending !== null} onClick={() => void load("refresh")}>
              Retry
            </button>
          </div>
        </div>
      ) : null}

      {slot.conflict ? (
        <div className="banner error" role="alert">
          <p>
            <strong>Schedule not saved.</strong> {CHANGED_ELSEWHERE} Your edits are kept here. Merging keeps what you edited and brings in what changed there; reloading discards your edits.
          </p>
          <div className="banner-actions">
            <button type="button" className="btn primary" disabled={locked} onClick={() => void recover("merge")}>
              Merge with the latest schedule
            </button>
            <button type="button" className="btn" disabled={locked} onClick={() => void recover("reload")}>
              Reload and discard my schedule edits
            </button>
          </div>
        </div>
      ) : null}

      <div className="schedule-fields">
        <label className="check schedule-enabled" htmlFor={enabledId}>
          <input id={enabledId} type="checkbox" aria-label="Automatic imports" disabled={locked || draft === null} checked={draft?.enabled ?? false} onChange={(event) => edit({ enabled: event.target.checked })} />
          Automatic imports
          <span className="quick-add-publish-hint">{draft?.enabled ? (feedDisabled ? "The feed is disabled: automatic imports wait until it is enabled and saved." : "Runs while the RUNDOWN API is up.") : "Off: nothing is imported unless you press Import now."}</span>
        </label>
        <label className="field schedule-interval" htmlFor={intervalId}>
          <span>Every (minutes)</span>
          <input
            id={intervalId}
            aria-label="Interval minutes"
            aria-invalid={shownProblem ? true : undefined}
            aria-describedby={`${intervalId}-hint`}
            disabled={locked || draft === null}
            inputMode="numeric"
            min={MIN_INTERVAL}
            max={MAX_INTERVAL}
            step={1}
            type="number"
            value={draft === null ? DEFAULT_INTERVAL : Number.isNaN(draft.interval_minutes) ? "" : draft.interval_minutes}
            onChange={(event) => edit({ interval_minutes: event.target.valueAsNumber })}
          />
        </label>
        <span id={`${intervalId}-hint`} className={shownProblem ? "tproblem schedule-hint" : "reuse-hint schedule-hint"}>
          {shownProblem ?? `${MIN_INTERVAL} minutes to ${MAX_INTERVAL} minutes (7 days)${draft ? ` · ${intervalLabel(draft.interval_minutes)}` : ""}`}
        </span>
      </div>

      <div className="inline-form-actions schedule-actions">
        <button type="button" className="btn primary" disabled={saveBlock !== null || !dirty} onClick={() => void save()}>
          {slot.pending === "save" ? "Saving…" : "Save schedule"}
        </button>
        {dirty ? (
          <button type="button" className="btn" disabled={locked} onClick={discardEdits}>
            Discard schedule edits
          </button>
        ) : null}
        <button type="button" className="btn" disabled={refreshBlock !== null} onClick={() => void load("refresh")} title="Re-read the schedule and the next due time from the server">
          Refresh schedule
        </button>
        {saveBlock && dirty ? (
          <span className="reuse-hint import-block" role="status">
            {saveBlock}
          </span>
        ) : refreshBlock && !dirty ? (
          <span className="reuse-hint import-block" role="status">
            {refreshBlock}
          </span>
        ) : null}
      </div>

      <dl className="schedule-status" aria-label={`Schedule status for ${feedName}`}>
        <div className="schedule-row">
          <dt>Next automatic import</dt>
          <dd data-testid="schedule-next">{nextText}</dd>
        </div>
        <div className="schedule-row">
          <dt>Times shown in</dt>
          <dd data-testid="schedule-zone">{zone || "your browser's time zone"}</dd>
        </div>
        <div className="schedule-row">
          <dt>Last automatic import</dt>
          <dd data-testid="schedule-last" data-run-status={schedule?.last_run?.status ?? "none"}>
            {schedule === null ? "—" : lastAutomaticSummary(schedule.last_run)}
            {schedule?.last_run ? ` · ${stampLabel(schedule.last_run.finished_at ?? schedule.last_run.started_at)}` : ""}
          </dd>
        </div>
      </dl>

      <p className={`publish-status schedule-line${slot.notice?.kind === "error" || (slot.loadError && schedule === null) ? " error" : ""}`} aria-live="polite" data-testid="schedule-status">
        {statusText}
      </p>
    </section>
  )
}
