import { useId, useRef, useState } from "react"
import { ApiError, addPlanTopic, captureInboxTopic, getPlan, putInboxEditorial, uploadInboxTopic, type InboxItem, type Plan, type PlanSummary } from "../lib/api"
import { MAX_NOTES, notesLength } from "../lib/draft"
import { DEFAULT_DURATION, MAX_LABEL, MAX_TITLE, UPLOAD_ACCEPT, cleanTitle, labelProblem, linkProblem, needsLabel, planLabel, suggestLabel, titleFromFilename, uploadProblem } from "../lib/plans"
import Drawer from "./Drawer"

export type CaptureMode = "write" | "link" | "upload"

export type CaptureResult = {
  item: InboxItem
  /** The day it was added to, when the box was ticked and the add succeeded. */
  plan: Plan | null
  /** Why the note (uploads) or the add-to-day step did not land; the topic itself exists. */
  warning: string | null
  /** A note that was typed but could not be saved with an upload; the owner keeps it as the card's draft. */
  unsavedNote: string | null
}

type Props = {
  open: boolean
  onClose: () => void
  /** The day currently chosen in the days drawer, if any. */
  selectedPlan: PlanSummary | null
  /** Tick "Add to day" when the sheet was opened from the day itself. */
  forDay: boolean
  onCreated: (result: CaptureResult) => void
}

function describe(error: unknown, what: string): string {
  if (error instanceof ApiError) return `${what} rejected (${error.status}): ${error.detail}`
  return `${what} failed: the RUNDOWN API did not respond.`
}

/**
 * New topic: write it, paste a link (stored, never fetched) or upload a file
 * (the server decides the type from its bytes). A headline longer than the
 * 30-character live limit shows an editable label; nothing is truncated
 * silently. A failed request keeps everything typed.
 */
export default function CaptureSheet({ open, onClose, selectedPlan, forDay, onCreated }: Props) {
  const [mode, setMode] = useState<CaptureMode>("write")
  const [title, setTitle] = useState("")
  const [label, setLabel] = useState("")
  const [labelTouched, setLabelTouched] = useState(false)
  const [url, setUrl] = useState("")
  const [note, setNote] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [addToDay, setAddToDay] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const ids = useId()

  const long = needsLabel(title)
  const effectiveLabel = labelTouched ? label : suggestLabel(title)
  const tick = addToDay ?? (forDay && selectedPlan !== null)
  const overNotes = notesLength(note) > MAX_NOTES

  function changeTitle(value: string) {
    setTitle(value)
    setError(null)
  }

  function pickFile(next: File | null) {
    setFile(next)
    setError(null)
    if (next && !cleanTitle(title)) setTitle(titleFromFilename(next.name))
  }

  function reset() {
    setTitle("")
    setLabel("")
    setLabelTouched(false)
    setUrl("")
    setNote("")
    setFile(null)
    setAddToDay(null)
    setError(null)
    if (fileRef.current) fileRef.current.value = ""
  }

  async function submit() {
    const clean = cleanTitle(title)
    if (!clean) {
      setError("Give this topic a title.")
      return
    }
    if (clean.length > MAX_TITLE) {
      setError(`Titles must be at most ${MAX_TITLE} characters.`)
      return
    }
    const chosen = long ? cleanTitle(effectiveLabel) : undefined
    if (long) {
      const problem = labelProblem(effectiveLabel)
      if (problem) {
        setError(problem)
        return
      }
    }
    if (overNotes) {
      setError(`Notes must be at most ${MAX_NOTES} characters.`)
      return
    }
    let link = ""
    if (mode === "link") {
      const problem = linkProblem(url)
      if (problem) {
        setError(problem)
        return
      }
      link = url.trim()
    }
    if (mode === "upload") {
      const problem = uploadProblem(file)
      if (problem) {
        setError(problem)
        return
      }
    }
    setBusy(true)
    setError(null)
    let item: InboxItem
    let warning: string | null = null
    let unsavedNote: string | null = null
    try {
      if (mode === "upload" && file) {
        item = await uploadInboxTopic({ file, filename: file.name, title: clean, label: chosen, duration: DEFAULT_DURATION })
        if (note.trim()) {
          try {
            item = await putInboxEditorial(item.id, { revision: item.editorial?.revision ?? 1, saved: true, note })
          } catch (noteError) {
            warning = `Uploaded, but the note was not saved: ${describe(noteError, "Saving the note")} It is kept on the card as a draft.`
            unsavedNote = note
          }
        }
      } else {
        item = await captureInboxTopic({ kind: mode === "link" ? "link" : "write", title: clean, label: chosen, note, source_url: link || undefined, duration: DEFAULT_DURATION })
      }
    } catch (createError) {
      setError(describe(createError, mode === "upload" ? "Uploading" : "Creating the topic"))
      setBusy(false)
      return
    }
    let plan: Plan | null = null
    if (tick && selectedPlan) {
      try {
        // The drawer may have moved the day on; always add against its current revision.
        const current = await getPlan(selectedPlan.id)
        plan = await addPlanTopic(current.id, { revision: current.revision, inbox_topic_id: item.id, ...(chosen !== undefined ? { label: chosen } : {}) })
      } catch (addError) {
        warning = `${warning ? `${warning} ` : ""}Created, but not added to ${planLabel(selectedPlan)}: ${describe(addError, "Adding to the day")} Use ＋ Day on the card.`
      }
    }
    setBusy(false)
    reset()
    onCreated({ item, plan, warning, unsavedNote })
  }

  return (
    <Drawer id="dsc-capture" open={open} title="New topic" onClose={onClose}>
      <div className="dsc-tabs" role="group" aria-label="Topic input">
        {(["write", "link", "upload"] as const).map((entry) => (
          <button key={entry} type="button" className="dsc-act dsc-tab" aria-pressed={mode === entry} disabled={busy} onClick={() => setMode(entry)}>
            {entry === "write" ? "Write" : entry === "link" ? "Link" : "Upload"}
          </button>
        ))}
      </div>
      <form
        className="dsc-form"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {mode === "link" ? (
          <label className="dsc-field">
            Source link
            <input type="url" aria-label="Source link" value={url} placeholder="https://…" disabled={busy} onChange={(event) => (setUrl(event.target.value), setError(null))} />
            <span className="dsc-hint">Link only · nothing is fetched</span>
          </label>
        ) : null}
        {mode === "upload" ? (
          <label className="dsc-field">
            File
            <input ref={fileRef} type="file" aria-label="Topic file" accept={UPLOAD_ACCEPT} disabled={busy} onChange={(event) => pickFile(event.target.files?.[0] ?? null)} />
            <span className="dsc-hint">PNG, JPEG, PDF, TXT or Markdown · up to 1 MB · kept as the original file</span>
          </label>
        ) : null}
        <label className="dsc-field">
          Title
          <input type="text" aria-label="Topic title" value={title} maxLength={MAX_TITLE} placeholder="What do you want to talk about?" disabled={busy} onChange={(event) => changeTitle(event.target.value)} />
        </label>
        {long ? (
          <label className="dsc-field">
            Live label · {cleanTitle(effectiveLabel).length}/{MAX_LABEL}
            <input
              type="text"
              aria-label="Live label"
              value={effectiveLabel}
              maxLength={MAX_LABEL + 10}
              disabled={busy}
              aria-invalid={labelProblem(effectiveLabel) !== null || undefined}
              onChange={(event) => {
                setLabelTouched(true)
                setLabel(event.target.value)
                setError(null)
              }}
            />
            <span className="dsc-hint">Longer than {MAX_LABEL} characters: this shorter label goes on air, the full title stays on the card.</span>
          </label>
        ) : null}
        <label className="dsc-field">
          Your note
          <textarea aria-label="Personal note" className="notes-text" rows={3} value={note} placeholder="Your angle, a question, a reminder…" disabled={busy} aria-invalid={overNotes || undefined} onChange={(event) => (setNote(event.target.value), setError(null))} />
        </label>
        {selectedPlan ? (
          <label className="dsc-check">
            <input type="checkbox" checked={tick} disabled={busy} onChange={(event) => setAddToDay(event.target.checked)} />
            <span>Add to {planLabel(selectedPlan)}</span>
          </label>
        ) : (
          <p className="dsc-hint" id={`${ids}-noday`}>
            Choose a streaming day in Days to add it there.
          </p>
        )}
        {error ? (
          <p className="dsc-form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? (mode === "upload" ? "Uploading…" : "Creating…") : "Create topic"}
        </button>
      </form>
    </Drawer>
  )
}
