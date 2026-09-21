import { MAX_NOTES, notesLength, notesProblem } from "../lib/draft"

const count = new Intl.NumberFormat("en-US")

type ToggleProps = {
  /** Accessible name of the button, e.g. "Notes for topic 2". */
  label: string
  expanded: boolean
  /** Whether there is any text: switches the visible wording and shows the badge. */
  hasNotes: boolean
  /** id of the panel this button controls (only while expanded). */
  panelId: string
  /** Visible wording when empty / filled. */
  wording: { empty: string; filled: string }
  emphasis?: boolean
  onToggle: () => void
}

/** Keyboard-reachable expand/collapse control with a clear "has notes" indicator. */
export function NotesToggle({ label, expanded, hasNotes, panelId, wording, emphasis, onToggle }: ToggleProps) {
  return (
    <button
      type="button"
      className={`notes-toggle${hasNotes ? " has-notes" : ""}${emphasis ? " emphasis" : ""}`}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={expanded ? panelId : undefined}
      onClick={onToggle}
    >
      <span className="notes-chevron" aria-hidden="true">
        {expanded ? "▾" : "▸"}
      </span>
      {hasNotes ? wording.filled : wording.empty}
      {hasNotes ? <span className="notes-badge" aria-hidden="true" /> : null}
    </button>
  )
}

type PanelProps = {
  id: string
  /** Accessible name of the textarea, e.g. "Topic 2 notes". */
  label: string
  value: string
  disabled?: boolean
  placeholder?: string
  hint?: string
  onChange: (value: string) => void
}

/**
 * Plain multiline notes editor. Text is kept verbatim (no trimming, no rich
 * text); the count is in Unicode characters to match the server limit. Enter
 * inserts a newline: a textarea never submits the surrounding form.
 */
export function NotesPanel({ id, label, value, disabled, placeholder, hint, onChange }: PanelProps) {
  const length = notesLength(value)
  const problem = notesProblem(value)
  const metaId = `${id}-meta`
  return (
    <div id={id} className="notes-panel">
      <textarea
        aria-label={label}
        aria-describedby={metaId}
        aria-invalid={problem ? true : undefined}
        className="notes-text"
        disabled={disabled}
        placeholder={placeholder}
        rows={4}
        spellCheck
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <div id={metaId} className="notes-meta">
        <span className={`notes-count${problem ? " over" : ""}`} aria-live={problem ? "polite" : undefined}>
          {problem ?? `${count.format(length)} / ${count.format(MAX_NOTES)} characters`}
        </span>
        {hint ? <span className="notes-hint">{hint}</span> : null}
      </div>
    </div>
  )
}
