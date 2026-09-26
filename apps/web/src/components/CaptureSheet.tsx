import { useId, useRef, useState } from "react"
import { ApiError, addPlanTopic, captureInboxTopic, getPlan, previewLink, putInboxEditorial, uploadInboxTopic, type InboxItem, type LinkPreview, type Plan, type PlanSummary } from "../lib/api"
import { MAX_NOTES, notesLength } from "../lib/draft"
import { DEFAULT_DURATION, MAX_LABEL, MAX_TITLE, UPLOAD_ACCEPT, boundedTitle, cleanTitle, labelProblem, linkProblem, needsLabel, planLabel, suggestLabel, titleFromFilename, uploadProblem } from "../lib/plans"
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

const PREVIEW_DEK = 200

function describe(error: unknown, what: string): string {
  if (error instanceof ApiError) return `${what} rejected (${error.status}): ${error.detail}`
  return `${what} failed: the RUNDOWN API did not respond.`
}

function previewFailure(error: unknown): string {
  if (error instanceof ApiError) return error.detail
  return "the RUNDOWN API did not respond."
}

/** The compact review card for an accepted preview: thumbnail (one fallback, no retry), headline, publisher, short description. */
function PreviewCard({ preview, onRemove, disabled }: { preview: LinkPreview; onRemove: () => void; disabled: boolean }) {
  const [failed, setFailed] = useState(false)
  const thumb = preview.thumbnail
  const showImage = thumb !== null && !failed
  const portrait = thumb !== null && thumb.width !== null && thumb.height !== null && thumb.height > thumb.width
  const who = preview.creator || preview.site_name
  const dek = preview.description.length > PREVIEW_DEK ? `${preview.description.slice(0, PREVIEW_DEK - 1).trimEnd()}…` : preview.description
  return (
    <div className={`dsc-preview${showImage ? "" : " no-image"}`} data-testid="dsc-preview" data-kind={preview.kind} data-mode={preview.mode}>
      {showImage ? <img src={thumb.url} alt="" className={portrait ? "portrait" : undefined} loading="lazy" decoding="async" referrerPolicy="no-referrer" width={thumb.width ?? undefined} height={thumb.height ?? undefined} data-testid="dsc-preview-thumb" onError={() => setFailed(true)} /> : null}
      <div className="dsc-preview-body">
        <span className="dsc-preview-kicker">
          {preview.kind === "tiktok" ? "TikTok" : "Article"}
          {who ? ` · ${who}` : ""}
          {preview.mode === "fixture" ? " · fixture" : ""}
        </span>
        <strong className="dsc-preview-title" data-testid="dsc-preview-title">
          {preview.title}
        </strong>
        {dek ? <p className="dsc-preview-dek">{dek}</p> : null}
        <button type="button" className="dsc-act" disabled={disabled} onClick={onRemove}>
          Remove preview
        </button>
      </div>
    </div>
  )
}

/**
 * New topic: write it, paste a link (stored; fetched once only when the user
 * presses Preview) or upload a file (the server decides the type from its
 * bytes). A headline longer than the 30-character live limit shows an
 * editable label; nothing is truncated silently. A failed request keeps
 * everything typed. A preview never overwrites a typed title or note, is
 * dropped when the link changes, and is saved only through the server-issued
 * token sent with "Create with preview".
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
  const [preview, setPreview] = useState<LinkPreview | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewNote, setPreviewNote] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  /**
   * Latest typed title and the title the last preview suggested, read after
   * the preview's await: the closure's `title` is stale by then, and only an
   * empty field or the previous suggestion may be replaced, never typed text.
   */
  const titleRef = useRef("")
  const suggestedRef = useRef("")
  const requestRef = useRef<{ url: string; controller: AbortController } | null>(null)
  const ids = useId()

  const long = needsLabel(title)
  const effectiveLabel = labelTouched ? label : suggestLabel(title)
  const tick = addToDay ?? (forDay && selectedPlan !== null)
  const overNotes = notesLength(note) > MAX_NOTES
  const attached = mode === "link" && preview !== null && preview.source_url === url.trim()

  function applyTitle(value: string) {
    titleRef.current = value
    setTitle(value)
  }

  function changeTitle(value: string) {
    applyTitle(value)
    setError(null)
  }

  function pickFile(next: File | null) {
    setFile(next)
    setError(null)
    if (next && !cleanTitle(title)) applyTitle(titleFromFilename(next.name))
  }

  function dropPreview(reason: string | null) {
    requestRef.current?.controller.abort()
    requestRef.current = null
    setPreviewBusy(false)
    setPreview(null)
    setPreviewError(null)
    setPreviewNote(reason)
  }

  function changeUrl(value: string) {
    setUrl(value)
    setError(null)
    if (value.trim() !== url.trim() && (preview !== null || previewBusy || previewError !== null)) dropPreview(preview !== null ? "Link changed · preview removed" : null)
  }

  function changeMode(next: CaptureMode) {
    setMode(next)
    setError(null)
    if (next !== "link" && (preview !== null || previewBusy)) dropPreview(null)
  }

  async function runPreview() {
    const problem = linkProblem(url)
    if (problem) {
      setPreviewError(problem)
      return
    }
    const target = url.trim()
    requestRef.current?.controller.abort()
    const controller = new AbortController()
    const request = { url: target, controller }
    requestRef.current = request
    setPreviewBusy(true)
    setPreviewError(null)
    setPreviewNote(null)
    setPreview(null)
    let result: LinkPreview
    try {
      result = await previewLink(target, controller.signal)
    } catch (previewFailed) {
      if (requestRef.current !== request) return
      requestRef.current = null
      setPreviewBusy(false)
      if (previewFailed instanceof DOMException && previewFailed.name === "AbortError") return
      setPreviewError(previewFailure(previewFailed))
      return
    }
    // A response for a link that is no longer in the field is ignored.
    if (requestRef.current !== request) return
    requestRef.current = null
    setPreviewBusy(false)
    if (result.source_url !== target) {
      setPreviewError("The preview answered for a different link. Try again.")
      return
    }
    setPreview(result)
    const current = cleanTitle(titleRef.current)
    if (current === "" || current === suggestedRef.current) {
      const next = boundedTitle(result.title)
      applyTitle(next)
      suggestedRef.current = next
      setPreviewNote(result.title.length > MAX_TITLE ? `Headline shortened to ${MAX_TITLE} characters for the title · the full headline is kept with the source` : null)
    } else {
      setPreviewNote("Your title was kept · the fetched headline is saved with the source")
    }
  }

  function reset() {
    applyTitle("")
    setLabel("")
    setLabelTouched(false)
    setUrl("")
    setNote("")
    setFile(null)
    setAddToDay(null)
    setError(null)
    dropPreview(null)
    suggestedRef.current = ""
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
    if (previewBusy) {
      setError("Wait for the preview to finish, or remove it.")
      return
    }
    const token = attached && preview ? preview.token : undefined
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
        item = await captureInboxTopic({ kind: mode === "link" ? "link" : "write", title: clean, label: chosen, note, source_url: link || undefined, duration: DEFAULT_DURATION, ...(token !== undefined ? { preview: token } : {}) })
      }
    } catch (createError) {
      if (token !== undefined && createError instanceof ApiError && createError.status === 409) {
        // The server refused the preview (expired, tampered or for another link); the form is intact and saves without it.
        setPreview(null)
        setPreviewNote(null)
        setError(`Preview not saved: ${createError.detail} Everything you typed is kept; press Create topic to save without the preview.`)
      } else {
        setError(describe(createError, mode === "upload" ? "Uploading" : "Creating the topic"))
      }
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
          <button key={entry} type="button" className="dsc-act dsc-tab" aria-pressed={mode === entry} disabled={busy} onClick={() => changeMode(entry)}>
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
          <>
            <label className="dsc-field">
              Source link
              <input type="url" aria-label="Source link" value={url} placeholder="https://…" disabled={busy} onChange={(event) => changeUrl(event.target.value)} />
              <span className="dsc-hint">Nothing is fetched until you press Preview</span>
            </label>
            <div className="dsc-preview-row">
              <button type="button" className="dsc-act" disabled={busy || previewBusy || !url.trim()} aria-busy={previewBusy || undefined} onClick={() => void runPreview()}>
                {previewBusy ? "Fetching preview…" : "Preview"}
              </button>
              {!preview && !previewBusy && !previewError ? <span className="dsc-hint">Optional · fetches the page title, publisher and image once</span> : null}
              {previewBusy ? (
                <span className="dsc-hint" role="status">
                  Fetching the page metadata…
                </span>
              ) : null}
            </div>
            {previewError ? (
              <p className="dsc-form-error" role="alert" data-testid="dsc-preview-error">
                Preview failed: {previewError} Save the link without it.
              </p>
            ) : null}
            {previewNote ? (
              <p className="dsc-hint" role="status" data-testid="dsc-preview-note">
                {previewNote}
              </p>
            ) : null}
            {preview ? <PreviewCard key={preview.token} preview={preview} disabled={busy} onRemove={() => dropPreview(null)} /> : null}
          </>
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
          {busy ? (mode === "upload" ? "Uploading…" : "Creating…") : attached ? "Create with preview" : "Create topic"}
        </button>
      </form>
    </Drawer>
  )
}
