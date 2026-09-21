import { useId, useRef, useState } from "react"
import { ApiError, previewSocialLink, type SocialLinkPreview as Preview } from "../lib/api"
import { MAX_TITLE } from "../lib/draft"
import { safeSourceHref } from "../lib/inboxDraft"
import { applyPreview, applyProblem, previewAlreadyPresent, previewLength, socialLinkPlatform, titleFromPreview, titleIsEmpty } from "../lib/socialLinkDraft"
import { NotesToggle } from "./Notes"

type Props = {
  /** The editor's Source URL field, as typed. */
  sourceUrl: string
  /** The editor's title, as typed; filled from the preview only when blank. */
  title: string
  /** The editor's notes, as typed; the preview is appended after them, never in place of them. */
  notes: string
  /** The editor is busy or the idea is archived: fetching and adding wait. */
  readOnly: boolean
  archived: boolean
  /** Put the appended notes (and a title, when the field was blank) into the editor as an unsaved edit. */
  onApply: (patch: { text: string; notes: string }) => void
  /** Replace the Source URL with the canonical permalink the server resolved; only on an explicit click. */
  onUseCanonical: (url: string) => void
}

type Attempt =
  | { url: string; token: number; status: "loading" }
  | { url: string; token: number; status: "ready"; preview: Preview; applied: boolean }
  | { url: string; token: number; status: "error"; message: string }

const count = new Intl.NumberFormat("en-US")

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 422) return `Not fetched: ${error.detail}`
    if (error.status === 429) return `Not fetched yet: ${error.detail}`
    if (error.status === 502) return `The platform did not return a public preview: ${error.detail}`
    return `Link preview rejected (${error.status}): ${error.detail}`
  }
  return "Link preview failed: the RUNDOWN API did not respond. Your draft is unchanged."
}

/**
 * The source card of the idea editor. Before any fetch it offers "Preview
 * link" for a public X post or TikTok video in the Source URL field and a
 * plain "Open original" link. After an explicit click it shows the public
 * text once, with platform, author and what the preview covers; "Add to
 * notes" appends it to the idea's notes (and fills a blank title), and the
 * user still saves the idea as usual. Limitations, counts, the canonical link
 * and a refetch sit behind "Details". The draft is never changed by fetching,
 * a stale answer (link or idea changed meanwhile) is dropped, and the same
 * preview is added once.
 */
export default function SocialLinkPreview({ sourceUrl, title, notes, readOnly, archived, onApply, onUseCanonical }: Props) {
  const [attempt, setAttemptState] = useState<Attempt | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const seq = useRef(0)
  const statusId = useId()
  const detailsId = useId()

  const currentUrl = sourceUrl.trim()
  const platform = socialLinkPlatform(currentUrl)
  const href = safeSourceHref(currentUrl)

  // The preview belongs to one exact link. When the field changes (typed
  // over, cleared, or another idea's link) the attempt is discarded during
  // this render, so an answer still in flight lands on nothing.
  if (attempt !== null && attempt.url !== currentUrl) {
    setAttemptState(null)
  }
  const live = attempt !== null && attempt.url === currentUrl ? attempt : null
  const loading = live?.status === "loading"
  const ready = live?.status === "ready" ? live : null
  /** The block is already in the notes (added, refetched, or saved and reopened): adding again would only duplicate it. */
  const present = ready !== null && previewAlreadyPresent(notes, ready.preview)
  const problem = ready && !present ? applyProblem(notes, sourceUrl, ready.preview) : null
  const canonical = ready && ready.preview.source_url !== currentUrl ? ready.preview.source_url : null
  const fillsTitle = ready !== null && titleIsEmpty(title)
  const filledTitle = ready && fillsTitle ? titleFromPreview(ready.preview) : ""

  const hint = archived
    ? "Archived ideas are read-only. Restore the idea to preview its link."
    : currentUrl.length === 0
      ? "Preview an X or TikTok link."
      : platform === null
        ? "Preview unavailable for this link."
        : platform === "x"
          ? "Post text only"
          : "Caption only"

  async function fetchPreview() {
    const url = currentUrl
    if (readOnly || loading || platform === null) return
    const token = ++seq.current
    setAttemptState({ url, token, status: "loading" })
    try {
      const preview = await previewSocialLink(url)
      // Only the answer to the newest request for the link still in the field is shown.
      setAttemptState((current) => (current && current.status === "loading" && current.token === token && current.url === url ? { url, token, status: "ready", preview, applied: false } : current))
    } catch (error) {
      setAttemptState((current) => (current && current.status === "loading" && current.token === token && current.url === url ? { url, token, status: "error", message: describeError(error) } : current))
    }
  }

  function apply() {
    // Re-check against the notes as they are now, so a double click or a repeat after a refetch never appends twice.
    if (!ready || readOnly || problem !== null || previewAlreadyPresent(notes, ready.preview)) return
    onApply(applyPreview({ text: title, notes }, ready.preview))
    setAttemptState((current) => (current && current.status === "ready" && current.token === ready.token ? { ...current, applied: true } : current))
  }

  function useCanonical() {
    if (!ready || readOnly || canonical === null) return
    // Re-key the attempt to the canonical link in the same update as the field change so the preview survives it.
    setAttemptState((current) => (current && current.token === ready.token ? { ...current, url: canonical } : current))
    onUseCanonical(canonical)
  }

  const statusText = loading
    ? "Fetching the public text…"
    : live?.status === "error"
      ? live.message
      : ready?.applied && present
        ? "Added to notes."
        : present
          ? "Already in notes. Remove it there to add it again."
          : null

  const preview = ready?.preview ?? null
  const scope = preview ? (preview.platform === "x" ? "Post text only" : "Caption only") : null

  return (
    <section className="link-preview" aria-label="Source preview" data-testid="link-preview" data-state={live?.status ?? "idle"}>
      <div className="link-preview-head">
        {preview ? (
          <div className="link-preview-meta" data-testid="link-preview-result" data-platform={preview.platform} data-mode={preview.mode}>
            <span className={`link-tag platform-${preview.platform}`}>{preview.platform === "x" ? "X post" : "TikTok video"}</span>
            {preview.mode === "fixture" ? (
              <span className="prep-badge fixture" data-testid="link-preview-fixture">
                Test data
              </span>
            ) : null}
            {preview.truncated ? <span className="feed-tag">Truncated</span> : null}
            <span className="link-preview-author">{preview.author ? `Author: ${preview.author}` : "Author not provided"}</span>
            <span className="link-preview-scope" data-testid="link-preview-scope">
              {scope}
            </span>
          </div>
        ) : (
          <span className="field-label">Source preview</span>
        )}
        {preview ? null : (
          <button type="button" className="btn small" disabled={readOnly || loading || platform === null} aria-describedby={statusId} onClick={() => void fetchPreview()}>
            {loading ? "Previewing…" : "Preview link"}
          </button>
        )}
      </div>

      {preview ? null : <p className="notes-hint link-preview-hint">{hint}</p>}

      {preview ? (
        <pre className="link-preview-text" data-testid="link-preview-text">
          {preview.text}
        </pre>
      ) : null}

      <p id={statusId} className={`link-preview-status${live?.status === "error" ? " error" : ""}`} role="status" aria-live="polite" data-testid="link-preview-status">
        {statusText}
      </p>

      {problem ? (
        <p className="tproblem" role="alert" data-testid="link-preview-problem">
          {problem}
        </p>
      ) : null}

      {preview || href ? (
        <div className="link-preview-actions">
          {preview ? (
            <button
              type="button"
              className="btn primary small"
              disabled={readOnly || present || problem !== null}
              title={present ? "Already in notes; remove it there to add it again" : undefined}
              data-testid="link-preview-add"
              onClick={apply}
            >
              {present ? "Already in notes" : "Add to notes"}
            </button>
          ) : null}
          {href ? (
            <a className="source-link" href={href} target="_blank" rel="noopener noreferrer" data-testid="link-preview-open">
              Open original ↗
            </a>
          ) : null}
          {preview ? (
            <NotesToggle
              label="Source preview details"
              expanded={detailsOpen}
              hasNotes={false}
              panelId={detailsId}
              wording={{ empty: "Details", filled: "Details" }}
              onToggle={() => setDetailsOpen((value) => !value)}
            />
          ) : null}
        </div>
      ) : null}

      {preview && detailsOpen ? (
        <div id={detailsId} className="link-preview-details" data-testid="link-preview-details">
          {preview.limitations ? (
            <p className="notes-hint" role="note" data-testid="link-preview-limits">
              {preview.limitations}
            </p>
          ) : null}
          {preview.truncated ? (
            <p className="provenance-truncated" role="note">
              Truncated: the platform text was longer than the server keeps. Open the original for the full post.
            </p>
          ) : null}
          <p className="notes-hint" data-testid="link-preview-counts">
            Adds {count.format(previewLength(preview))} characters to notes.
            {fillsTitle && filledTitle ? ` Fills the empty title with "${filledTitle}"${titleFromPreview(preview) !== preview.title ? ` (cut to ${MAX_TITLE} characters)` : ""}.` : ""}
          </p>
          {canonical !== null ? <p className="link-preview-canonical">Canonical: {canonical}</p> : null}
          <div className="link-preview-tools">
            {canonical !== null ? (
              <button type="button" className="btn small" disabled={readOnly} title={canonical} onClick={useCanonical}>
                Use canonical link
              </button>
            ) : null}
            <button type="button" className="btn small" disabled={readOnly || loading} onClick={() => void fetchPreview()}>
              Fetch again
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
