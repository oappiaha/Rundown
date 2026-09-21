import { useId, useRef, useState } from "react"
import type { FormEvent } from "react"
import { DEFAULT_DURATION, MAX_DURATION, MAX_TITLE, MAX_TOPICS, MIN_DURATION, validDuration, validNotes, validTitle } from "../lib/draft"
import { NotesPanel, NotesToggle } from "./Notes"

export type AddPlacement = "end" | "next"
export type AddOptions = { publishNow: boolean }
export type NewTopic = { text: string; duration: number; notes: string }

type Props = {
  full: boolean
  hasCurrent: boolean
  /** Why adding is unavailable right now, or null when it is allowed. */
  lockedReason: "loading" | "publishing" | null
  /** Whether the "publish immediately" path can run right now (no open conflict, no invalid rows). */
  canPublishNow: boolean
  otherUnsaved: boolean
  onAdd: (topic: NewTopic, where: AddPlacement, options: AddOptions) => void
}

const NOTES_HINT = "Background, talking points, questions, links. Shown here only, never on the overlay."

export default function QuickAdd({ full, hasCurrent, lockedReason, canPublishNow, otherUnsaved, onAdd }: Props) {
  const [text, setText] = useState("")
  const [duration, setDuration] = useState(DEFAULT_DURATION)
  const [notes, setNotes] = useState("")
  const [notesOpen, setNotesOpen] = useState(false)
  const [publishNow, setPublishNow] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const notesId = useId()
  const locked = lockedReason !== null
  const valid = validTitle(text) && validDuration(duration) && validNotes(notes) && !full && !locked
  const immediate = publishNow && canPublishNow

  function submit(where: AddPlacement) {
    if (!valid) return
    // Notes go out verbatim; only the title is trimmed.
    onAdd({ text: text.trim(), duration, notes }, where, { publishNow: immediate })
    setText("")
    setNotes("")
    titleRef.current?.focus()
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    submit("end")
  }

  const hint = full
    ? `Schedule is full (${MAX_TOPICS} topics).`
    : lockedReason === "loading"
      ? "Waiting for the show to load…"
      : lockedReason === "publishing"
        ? "Publishing… adding is paused for a moment."
        : "Drop it at the end, or right after what's playing now."

  const publishHint = !publishNow
    ? "Off: the topic waits in your draft until you press Publish."
    : !canPublishNow
      ? "Can't publish right now; the topic will be added to your draft instead."
      : otherUnsaved
        ? "On: publishes the new topic together with your other unsaved changes."
        : "On: the topic goes live as soon as you add it."

  return (
    <form className="quick-add" aria-labelledby="quick-add-title" onSubmit={onSubmit}>
      <div className="quick-add-copy">
        <h2 id="quick-add-title">Add a topic</h2>
        <p>{hint}</p>
      </div>
      <div className="quick-add-fields">
        <label className="field grow">
          <span>Title</span>
          <input
            ref={titleRef}
            aria-label="New topic title"
            maxLength={MAX_TITLE}
            placeholder="What just happened?"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <label className="field seconds">
          <span>Seconds</span>
          <input
            aria-label="New topic duration"
            inputMode="numeric"
            min={MIN_DURATION}
            max={MAX_DURATION}
            step={1}
            type="number"
            value={Number.isNaN(duration) ? "" : duration}
            onChange={(event) => setDuration(event.target.valueAsNumber)}
          />
        </label>
        <div className="quick-add-actions">
          <button type="submit" className="btn primary" disabled={!valid}>
            {immediate ? "Add & publish" : "Add to end"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!valid || !hasCurrent}
            title={hasCurrent ? "Insert immediately after the current segment" : "Nothing is playing yet"}
            onClick={() => submit("next")}
          >
            {immediate ? "Insert next & publish" : "Insert next"}
          </button>
        </div>
      </div>
      <div className="quick-add-context">
        <NotesToggle
          label="Context for the new topic"
          expanded={notesOpen}
          hasNotes={notes.length > 0}
          panelId={notesId}
          wording={{ empty: "Add context", filled: "Context" }}
          onToggle={() => setNotesOpen((open) => !open)}
        />
        {notesOpen ? (
          <NotesPanel
            id={notesId}
            label="New topic notes"
            value={notes}
            placeholder={"Why it matters, what to say, questions to ask…\nhttps://source.example/article"}
            hint={NOTES_HINT}
            onChange={setNotes}
          />
        ) : null}
      </div>
      <div className="quick-add-publish">
        <label className="check">
          <input type="checkbox" checked={publishNow} disabled={locked} onChange={(event) => setPublishNow(event.target.checked)} />
          <span>Publish immediately</span>
        </label>
        <span className="quick-add-publish-hint">{publishHint}</span>
      </div>
    </form>
  )
}
