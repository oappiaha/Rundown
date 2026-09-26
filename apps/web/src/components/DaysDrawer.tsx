import { useEffect, useId, useRef, useState } from "react"
import { ApiError, addPlanTopic, createPlan, getPlan, updatePlan, type Plan, type PlanSummary, type PlanTopic } from "../lib/api"
import { formatClock } from "../lib/draft"
import { MAX_LABEL, displayTitleOf, formatMinutes, isoToday, labelProblem, moveItem, needsLabel, planLabel, suggestLabel, totalSeconds, validDate } from "../lib/plans"
import Drawer from "./Drawer"

export type PendingTopic = { id: string; title: string }

type Props = {
  open: boolean
  onClose: () => void
  plans: PlanSummary[] | null
  plansError: string | null
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** The owner reloads the day list (after a create here or a change elsewhere). */
  onPlansChanged: () => void
  /** Bumped by the owner when the selected day changed outside this drawer (capture sheet added a topic). */
  refreshKey: number
  /** A card the user wants to add to the selected day. */
  pending: PendingTopic | null
  onPendingDone: () => void
  /** Hand the day to Saved Shows, where activation lives. */
  onOpenShow: (show: { id: string; name: string }) => void
  /** "Create a topic for this day" opens the capture sheet. */
  onNewTopic: () => void
}

type Conflict = { theirs: Plan; mine: PlanTopic[] }

const CHANGED_ELSEWHERE = "This day changed on another screen."

function describe(error: unknown, what: string): string {
  if (error instanceof ApiError) return `${what} rejected (${error.status}): ${error.detail}`
  return `${what} failed: the RUNDOWN API did not respond.`
}

function wire(topics: PlanTopic[]) {
  return topics.map((topic) => ({ id: topic.id, text: topic.text, duration: topic.duration, notes: topic.notes }))
}

/**
 * Streaming days: pick or create a dated day, add the pending card (with a
 * visible, editable live label when the headline is longer than 30
 * characters), reorder, retime and remove. Every change is one
 * revision-guarded write; a 409 keeps this screen's order and asks.
 */
export default function DaysDrawer({ open, onClose, plans, plansError, selectedId, onSelect, onPlansChanged, refreshKey, pending, onPendingDone, onOpenShow, onNewTopic }: Props) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState("")
  const [newDate, setNewDate] = useState(isoToday)
  const [newError, setNewError] = useState<string | null>(null)
  /** The live label typed for the pending card; a different pending card starts from a fresh suggestion. */
  const [labelDraft, setLabelDraft] = useState<{ for: string; value: string } | null>(null)
  const [seconds, setSeconds] = useState<Record<string, string>>({})
  const ids = useId()
  const loadSeq = useRef(0)

  const selected = plans?.find((entry) => entry.id === selectedId) ?? null
  const noPlans = plans !== null && plans.length === 0
  const showNew = newOpen || noPlans
  const label = pending ? (labelDraft?.for === pending.id ? labelDraft.value : suggestLabel(pending.title)) : ""

  // The selected day's topics, reloaded when the drawer opens, the selection changes or the owner says it changed.
  useEffect(() => {
    if (!open || !selectedId) return
    const token = ++loadSeq.current
    getPlan(selectedId).then(
      (next) => {
        if (token !== loadSeq.current) return
        setPlan(next)
        setPlanError(null)
        setSeconds({})
      },
      (error: unknown) => {
        if (token !== loadSeq.current) return
        setPlanError(describe(error, "Loading the day"))
      },
    )
  }, [open, selectedId, refreshKey])

  async function commit(next: PlanTopic[], what: string) {
    if (!plan) return
    setBusy(true)
    setStatus(null)
    try {
      const saved = await updatePlan(plan.id, plan.revision, plan.name, wire(next))
      setPlan(saved)
      setConflict(null)
      onPlansChanged()
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        try {
          const theirs = await getPlan(plan.id)
          setConflict({ theirs, mine: next })
        } catch (reload) {
          setStatus(describe(reload, "Reloading the day"))
        }
      } else {
        setStatus(describe(error, what))
      }
    } finally {
      setBusy(false)
    }
  }

  async function saveMineAgain() {
    if (!conflict) return
    const { theirs, mine } = conflict
    setBusy(true)
    try {
      const known = new Set(theirs.topics.map((topic) => topic.id))
      // A row the other screen removed cannot be sent back with its old id; it is re-added as a fresh row.
      const saved = await updatePlan(theirs.id, theirs.revision, theirs.name, wire(mine).map((topic) => (known.has(topic.id) ? topic : { ...topic, id: null })))
      setPlan(saved)
      setConflict(null)
      onPlansChanged()
    } catch (error) {
      setStatus(describe(error, "Saving your order"))
    } finally {
      setBusy(false)
    }
  }

  function useTheirs() {
    if (!conflict) return
    setPlan(conflict.theirs)
    setConflict(null)
    setSeconds({})
  }

  async function create() {
    const name = newName.trim()
    if (!name) {
      setNewError("Give the day a name.")
      return
    }
    if (!validDate(newDate)) {
      setNewError("Choose a date.")
      return
    }
    setBusy(true)
    setNewError(null)
    try {
      const created = await createPlan(name, newDate)
      setNewName("")
      setNewOpen(false)
      onSelect(created.id)
      onPlansChanged()
    } catch (error) {
      setNewError(describe(error, "Creating the day"))
    } finally {
      setBusy(false)
    }
  }

  async function addPending() {
    if (!plan || !pending) return
    const long = needsLabel(pending.title)
    if (long) {
      const problem = labelProblem(label)
      if (problem) {
        setStatus(problem)
        return
      }
    }
    setBusy(true)
    setStatus(null)
    try {
      const saved = await addPlanTopic(plan.id, { revision: plan.revision, inbox_topic_id: pending.id, ...(long ? { label: label.trim() } : {}) })
      setPlan(saved)
      setStatus(`Added to ${planLabel(saved)}.`)
      onPendingDone()
      onPlansChanged()
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && plan) {
        try {
          const theirs = await getPlan(plan.id)
          setPlan(theirs)
          setStatus(theirs.topics.some((topic) => topic.origin?.inbox_topic_id === pending.id) ? "Already in this day." : `${CHANGED_ELSEWHERE} Reloaded it; add again if you still want to.`)
        } catch (reload) {
          setStatus(describe(reload, "Reloading the day"))
        }
      } else {
        setStatus(describe(error, "Adding to the day"))
      }
    } finally {
      setBusy(false)
    }
  }

  function commitSeconds(topic: PlanTopic) {
    const raw = seconds[topic.id]
    if (raw === undefined) return
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 15 || value > 3600) {
      setStatus("Use a whole number of seconds from 15 to 3600.")
      return
    }
    setSeconds((all) => {
      const next = { ...all }
      delete next[topic.id]
      return next
    })
    if (value === topic.duration || !plan) return
    void commit(
      plan.topics.map((entry) => (entry.id === topic.id ? { ...entry, duration: value } : entry)),
      "Changing the time",
    )
  }

  const alreadyIn = pending !== null && plan !== null && plan.topics.some((topic) => topic.origin?.inbox_topic_id === pending.id)
  const pendingLong = pending !== null && needsLabel(pending.title)
  const total = plan ? totalSeconds(plan.topics) : 0

  return (
    <Drawer id="dsc-days" open={open} title="Streaming days" onClose={onClose}>
      {plansError ? (
        <div className="banner error dsc-inline-banner" role="alert">
          <p>{plansError}</p>
        </div>
      ) : null}
      {plans === null && !plansError ? <p className="dsc-hint">Loading days…</p> : null}
      {plans && plans.length > 0 ? (
        <label className="dsc-field">
          Streaming day
          <select aria-label="Streaming day" value={selectedId ?? ""} disabled={busy} onChange={(event) => onSelect(event.target.value || null)}>
            <option value="">Choose a day…</option>
            {plans.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {planLabel(entry)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="dsc-new-day">
        <button type="button" className="dsc-linklike" aria-expanded={showNew} aria-controls={`${ids}-new`} disabled={noPlans} onClick={() => setNewOpen((value) => !value)}>
          ＋ New streaming day
        </button>
        {showNew ? (
          <form
            id={`${ids}-new`}
            className="dsc-form"
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <label className="dsc-field">
              Date
              <input type="date" aria-label="Stream date" value={newDate} required disabled={busy} onChange={(event) => setNewDate(event.target.value)} />
            </label>
            <label className="dsc-field">
              Name
              <input type="text" aria-label="Day name" value={newName} maxLength={80} placeholder="Friday live" required disabled={busy} onChange={(event) => setNewName(event.target.value)} />
            </label>
            {newError ? (
              <p className="dsc-form-error" role="alert">
                {newError}
              </p>
            ) : null}
            <button type="submit" className="btn primary small" disabled={busy}>
              Create day
            </button>
          </form>
        ) : null}
      </div>

      {planError ? (
        <div className="banner error dsc-inline-banner" role="alert">
          <p>{planError}</p>
        </div>
      ) : null}

      {selected && plan && plan.id === selected.id ? (
        <>
          <div className="dsc-deck" data-testid="dsc-deck">
            <span className="dsc-deck-date">{plan.stream_date ?? "Undated"}</span>
            <strong className="dsc-deck-name">{plan.name}</strong>
            <span className="dsc-deck-lcd">
              {plan.topics.length} {plan.topics.length === 1 ? "topic" : "topics"} · {formatMinutes(total)} · rev {plan.revision}
            </span>
          </div>

          {pending ? (
            <div className="dsc-pending" data-testid="dsc-pending">
              <p className="dsc-pending-title">{pending.title}</p>
              {pendingLong && !alreadyIn ? (
                <label className="dsc-field">
                  Live label · {label.trim().length}/{MAX_LABEL}
                  <input type="text" aria-label="Live label" value={label} maxLength={MAX_LABEL + 10} disabled={busy} aria-invalid={labelProblem(label) !== null || undefined} onChange={(event) => setLabelDraft({ for: pending.id, value: event.target.value })} />
                  <span className="dsc-hint">The headline is longer than {MAX_LABEL} characters; this shorter label is what goes on air. The full headline stays on the card.</span>
                </label>
              ) : null}
              <button type="button" className="btn primary small" disabled={busy || alreadyIn} onClick={() => void addPending()}>
                {alreadyIn ? "Already in this day" : pendingLong ? "Add with this label" : "Add to this day"}
              </button>
            </div>
          ) : null}

          {conflict ? (
            <div className="banner warn dsc-inline-banner" role="alert">
              <p>{CHANGED_ELSEWHERE} Your order is kept here; theirs now has {conflict.theirs.topics.length} topics.</p>
              <div className="banner-actions">
                <button type="button" className="btn small" disabled={busy} onClick={() => void saveMineAgain()}>
                  Keep mine and save again
                </button>
                <button type="button" className="btn small" disabled={busy} onClick={useTheirs}>
                  Use theirs
                </button>
              </div>
            </div>
          ) : null}

          {plan.topics.length === 0 ? (
            <p className="dsc-day-empty">
              A little room for good topics.
              <span>Browse and press ＋ Day on a card, or create a topic for this day.</span>
            </p>
          ) : (
            <ol className="dsc-day-list" aria-label={`Topics in ${plan.name}`}>
              {(conflict ? conflict.mine : plan.topics).map((topic, index, list) => {
                const title = displayTitleOf(topic)
                return (
                  <li key={topic.id} className="dsc-day-item" data-testid="dsc-day-item">
                    <span className="dsc-day-num">{String(index + 1).padStart(2, "0")}</span>
                    <div className="dsc-day-body">
                      <h3 className="dsc-day-title">{title}</h3>
                      {topic.text !== title ? (
                        <p className="dsc-day-label">
                          On air as <b>{topic.text}</b>
                        </p>
                      ) : null}
                      <label className="dsc-day-seconds">
                        <input
                          type="number"
                          inputMode="numeric"
                          min={15}
                          max={3600}
                          step={1}
                          aria-label={`Seconds for ${title}`}
                          value={seconds[topic.id] ?? String(topic.duration)}
                          disabled={busy || conflict !== null}
                          onChange={(event) => setSeconds((all) => ({ ...all, [topic.id]: event.target.value }))}
                          onBlur={() => commitSeconds(topic)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault()
                              commitSeconds(topic)
                            }
                          }}
                        />
                        <span>s · {formatClock(topic.duration)}</span>
                      </label>
                    </div>
                    <div className="dsc-day-controls">
                      <button type="button" className="icon-btn" aria-label={`Move up: ${title}`} disabled={busy || conflict !== null || index === 0} onClick={() => void commit(moveItem(list, index, -1), "Reordering")}>
                        ↑
                      </button>
                      <button type="button" className="icon-btn" aria-label={`Move down: ${title}`} disabled={busy || conflict !== null || index === list.length - 1} onClick={() => void commit(moveItem(list, index, 1), "Reordering")}>
                        ↓
                      </button>
                      <button type="button" className="icon-btn danger" aria-label={`Remove from this day: ${title}`} disabled={busy || conflict !== null} onClick={() => void commit(list.filter((entry) => entry.id !== topic.id), "Removing")}>
                        ×
                      </button>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}

          <div className="dsc-day-actions">
            <button type="button" className="btn small" disabled={busy} onClick={onNewTopic}>
              ＋ Create a topic for this day
            </button>
            <button type="button" className="btn small" disabled={busy} onClick={() => onOpenShow({ id: plan.id, name: plan.name })}>
              Open in Saved Shows
            </button>
          </div>
          <p className={`dsc-note-status${status && /rejected|failed|Use a whole|Choose|at most|changed on another/.test(status) ? " error" : ""}`} role="status" aria-live="polite">
            {busy ? "Saving…" : status ?? ""}
          </p>
        </>
      ) : selected ? null : plans && plans.length > 0 ? (
        <p className="dsc-hint">Keep a separate running order for each stream.</p>
      ) : null}
    </Drawer>
  )
}
