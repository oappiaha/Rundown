import { useId, useState } from "react"
import { MAX_DURATION, MAX_TITLE, MIN_DURATION, formatClock, topicProblem, type DraftTopic } from "../lib/draft"
import { NotesPanel, NotesToggle } from "./Notes"

type Props = {
  topic: DraftTopic
  index: number
  count: number
  isCurrent?: boolean
  playing?: boolean
  transportBusy?: boolean
  /** True while a publish is in flight: every editor in the row is disabled so nothing typed can be lost. */
  locked: boolean
  /** Prefix for accessible names, e.g. "Saved topic"; defaults to "Topic". */
  labelPrefix?: string
  onChange: (key: string, patch: Partial<Pick<DraftTopic, "text" | "duration" | "notes">>) => void
  onMove: (key: string, direction: -1 | 1) => void
  onRemove: (key: string) => void
  /** Live rundown only: make this the current segment. Omitted in the saved-show editor (no jump control). */
  onJump?: (id: string) => void
}

export default function TopicRow({
  topic,
  index,
  count,
  isCurrent = false,
  playing = false,
  transportBusy = false,
  locked,
  labelPrefix = "Topic",
  onChange,
  onMove,
  onRemove,
  onJump,
}: Props) {
  const problem = topicProblem(topic)
  const n = index + 1
  const live = onJump !== undefined
  const status = !live
    ? topic.id === null
      ? "not saved yet"
      : "saved"
    : isCurrent
      ? playing
        ? "playing now"
        : "cued"
      : topic.id === null
        ? "unsaved"
        : "up next"
  // Expanded state lives with the row's stable key, so it survives reorders.
  const [notesOpen, setNotesOpen] = useState(false)
  const notesId = useId()
  const hasNotes = topic.notes.length > 0

  return (
    <li className={`trow${isCurrent ? " current" : ""}${problem ? " invalid" : ""}`} data-key={topic.key} aria-current={isCurrent ? "true" : undefined}>
      <span className={`tnum${isCurrent ? " on" : ""}`} aria-hidden="true">
        {n}
      </span>
      <div className="tbody">
        <input
          aria-label={`${labelPrefix} ${n} title`}
          aria-invalid={problem ? true : undefined}
          className="ttl"
          disabled={locked}
          maxLength={MAX_TITLE}
          value={topic.text}
          onChange={(event) => onChange(topic.key, { text: event.target.value })}
        />
        <div className="tsub">
          <span>
            {formatClock(topic.duration)} · {status}
            {problem ? <span className="tproblem"> · {problem}</span> : null}
          </span>
          <NotesToggle
            label={`Notes for ${labelPrefix.toLowerCase()} ${n}`}
            expanded={notesOpen}
            hasNotes={hasNotes}
            panelId={notesId}
            wording={{ empty: "Add notes", filled: "Notes" }}
            emphasis={isCurrent}
            onToggle={() => setNotesOpen((open) => !open)}
          />
        </div>
      </div>
      <label className="tdur">
        <input
          aria-label={`${labelPrefix} ${n} duration`}
          aria-invalid={problem ? true : undefined}
          disabled={locked}
          inputMode="numeric"
          min={MIN_DURATION}
          max={MAX_DURATION}
          step={1}
          type="number"
          value={Number.isNaN(topic.duration) ? "" : topic.duration}
          onChange={(event) => onChange(topic.key, { duration: event.target.valueAsNumber })}
        />
        <span aria-hidden="true">s</span>
      </label>
      <div className="tactions">
        {live ? (
          <button
            type="button"
            className="icon-btn jump"
            aria-label={`Jump to topic ${n}`}
            title={topic.id === null ? "Publish first to jump here" : "Make this the current segment"}
            disabled={topic.id === null || isCurrent || transportBusy || locked}
            onClick={() => topic.id !== null && onJump(topic.id)}
          >
            ▶
          </button>
        ) : null}
        <button type="button" className="icon-btn" id={`move-up-${topic.key}`} aria-label={`Move ${labelPrefix.toLowerCase()} ${n} up`} disabled={locked || index === 0} onClick={() => onMove(topic.key, -1)}>
          ↑
        </button>
        <button type="button" className="icon-btn" id={`move-down-${topic.key}`} aria-label={`Move ${labelPrefix.toLowerCase()} ${n} down`} disabled={locked || index === count - 1} onClick={() => onMove(topic.key, 1)}>
          ↓
        </button>
        <button
          type="button"
          className="icon-btn danger"
          aria-label={`Remove ${labelPrefix.toLowerCase()} ${n}`}
          title={isCurrent ? "The current segment can't be removed; jump to another first" : "Remove"}
          disabled={isCurrent || locked}
          onClick={() => onRemove(topic.key)}
        >
          ×
        </button>
      </div>
      {notesOpen ? (
        <div className="tnotes">
          <NotesPanel
            id={notesId}
            label={`${labelPrefix} ${n} notes`}
            value={topic.notes}
            disabled={locked}
            placeholder="Background, talking points, questions, links…"
            hint="Control room only; the overlay shows just the title."
            onChange={(notes) => onChange(topic.key, { notes })}
          />
        </div>
      ) : null}
    </li>
  )
}
