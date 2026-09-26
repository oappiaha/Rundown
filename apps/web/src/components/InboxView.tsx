import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { FormEvent } from "react"
import { ApiError, createInboxItem, getInboxItem, listInbox, setInboxArchived, updateInboxItem, type InboxItem, type InboxSource } from "../lib/api"
import { DEFAULT_DURATION, MAX_DURATION, MAX_TITLE, MIN_DURATION, formatClock, validTitle } from "../lib/draft"
import {
  MAX_SOURCE_URL,
  draftFromItem,
  hasInboxWork,
  inboxProblem,
  isInboxDirty,
  mergeInboxDraft,
  newInboxDraft,
  safeSourceHref,
  sourceUrlProblem,
  toCreateWire,
  toUpdateWire,
  whenLabel,
  type InboxDraft,
} from "../lib/inboxDraft"
import { NotesPanel, NotesToggle } from "./Notes"
import PreparationPanel from "./PreparationPanel"
import SocialLinkPreview from "./SocialLinkPreview"
import type { TopicPrep } from "../lib/prepDraft"
import { usePreparationStore } from "../lib/prepStore"

type Props = {
  hidden: boolean
  /** Bumped by the owner when something else (a feed import) changed the inbox; the list reloads, the draft is untouched. */
  refreshKey?: number
}

type Filter = "active" | "archived"
type Notice = { kind: "info" | "error"; text: string }
type Pending = "load" | "save" | "archive" | "recover" | null
/** A rejected write. The draft is kept; the user picks the recovery. */
type Conflict = { kind: "save" | "archive" | "stale"; detail: string }
/** A selection that would drop unsaved work; the user confirms first. */
type Guard = { kind: "open"; id: string; text: string } | { kind: "new" } | { kind: "filter"; filter: Filter }

const CHANGED_ELSEWHERE = "This idea changed elsewhere since you opened it."
const NOTES_HINT = "Talking points, background, questions. Never shown on the overlay."

function describeError(error: unknown, what: string): string {
  if (error instanceof ApiError) return `${what} rejected (${error.status}): ${error.detail}`
  return `${what} failed: the RUNDOWN API did not respond.`
}

function hostOf(url: string): string {
  const href = safeSourceHref(url)
  if (href === null) return ""
  try {
    return new URL(href).host
  } catch {
    return ""
  }
}

function dateLabel(iso: string | null): string {
  if (iso === null) return ""
  const stamp = Date.parse(iso)
  if (Number.isNaN(stamp)) return iso
  return new Date(stamp).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

/** Provenance wording per importer. RSS keeps its original labels; discovery searches say what was and was not retrieved. */
const PROVENANCE_WORDING: Record<InboxSource["kind"], { panel: string; fallbackName: string; text: string; none: string; truncated: string; empty: string; readOnly: string; limits: string | null }> = {
  rss: {
    panel: "Imported from feed",
    fallbackName: "RSS feed",
    text: "Original feed text",
    none: "Original feed text (none retained)",
    truncated: "Truncated: the feed text was longer than the server keeps. Follow the source link for the full article.",
    empty: "The feed entry carried no text beyond its title.",
    readOnly: "Read-only copy from the feed; your notes above are separate.",
    limits: null,
  },
  youtube: {
    panel: "Imported from YouTube search",
    fallbackName: "YouTube search",
    text: "Original video description",
    none: "Original video description (none retained)",
    truncated: "Truncated: the description was longer than the server keeps. Follow the source link for the full video page.",
    empty: "The video carried no description beyond its title.",
    readOnly: "Read-only copy from the video page; your notes above are separate.",
    limits: "Description only: the transcript and the video itself were not retrieved. Open the source link to watch it.",
  },
  article: {
    panel: "Previewed from the linked page",
    fallbackName: "linked page",
    text: "Original page headline and description",
    none: "Original page description (none offered)",
    truncated: "Truncated: the page metadata was longer than the server keeps. Follow the source link for the full page.",
    empty: "The page offered no description beyond its headline.",
    readOnly: "Read-only page metadata fetched once when you previewed the link; your notes above are separate.",
    limits: "Head metadata only: the article text and images were not retrieved. Open the source link to read it.",
  },
  tiktok: {
    panel: "Previewed from TikTok",
    fallbackName: "TikTok",
    text: "Original video caption",
    none: "Original video caption (none retained)",
    truncated: "Truncated: the caption was longer than the server keeps. Follow the source link for the full video page.",
    empty: "The video carried no caption.",
    readOnly: "Read-only caption from TikTok's public preview; your notes above are separate.",
    limits: "Caption only: the transcript, comments and video were not retrieved. Open the source link to watch it.",
  },
  reddit: {
    panel: "Imported from Reddit search",
    fallbackName: "Reddit search",
    text: "Original post text",
    none: "Original post text (none retained)",
    truncated: "Truncated: the post was longer than the server keeps. Follow the source link for the full post.",
    empty: "The post carried no text beyond its title.",
    readOnly: "Read-only copy from the post; your notes above are separate.",
    limits: "Post title and text only: linked articles and comments were not retrieved. Open the source link to read the thread.",
  },
}

/**
 * Read-only provenance of an imported idea, collapsed behind one disclosure:
 * which feed, when, the full original title and the retained plain text.
 * Everything is rendered as text (React escapes it; the server already
 * stripped tags), never as HTML. The editable notes above are independent.
 */
function SourcePanel({ source, panelId }: { source: InboxSource; panelId: string }) {
  const [open, setOpen] = useState(false)
  const published = dateLabel(source.published_at)
  const imported = dateLabel(source.imported_at)
  const words = PROVENANCE_WORDING[source.kind]
  const label = `Imported from ${source.feed_name || words.fallbackName}`
  return (
    <section className="inbox-provenance inbox-tool" aria-label={words.panel} data-testid="inbox-provenance" data-source-kind={source.kind}>
      <NotesToggle label={label} expanded={open} hasNotes={source.body_text.length > 0} panelId={panelId} wording={{ empty: label, filled: label }} onToggle={() => setOpen((value) => !value)} />
      {open ? (
        <div id={panelId} className="provenance-body" data-testid="provenance-body">
          <p className="provenance-meta">
            <strong className="provenance-feed">{source.feed_name || words.fallbackName}</strong>
            {published ? ` · published ${published}` : " · no publish date"}
            {imported ? ` · imported ${imported}` : ""}
          </p>
          <p className="provenance-title" data-testid="provenance-title">
            <span className="field-label">Original title</span> {source.original_title}
          </p>
          {words.limits ? (
            <p className="provenance-limits notes-hint" role="note" data-testid="provenance-limits">
              {words.limits}
            </p>
          ) : null}
          {source.truncated ? (
            <p className="provenance-truncated" role="note">
              {words.truncated}
            </p>
          ) : null}
          <span className="field-label">{source.body_text.length > 0 ? words.text : words.none}</span>
          {source.body_text.length > 0 ? <pre className="provenance-text">{source.body_text}</pre> : <p className="notes-hint">{words.empty}</p>}
          <p className="notes-hint">{words.readOnly}</p>
        </div>
      ) : null}
    </section>
  )
}

/**
 * Collapsed-state label for the assisted preparation tool, so a run in
 * progress, a draft waiting for review or an unanswered request stays
 * discoverable while the panel is folded away.
 */
function prepSummary(prep: TopicPrep | undefined, draft: InboxDraft): { text: string; active: boolean } {
  const base = "Assisted preparation"
  if (draft.id === null) return { text: `${base} · after saving`, active: false }
  if (draft.archived || !prep) return { text: base, active: false }
  const run = prep.run ?? prep.view?.latest_run ?? null
  if (prep.pending === "generate" || run?.status === "running") return { text: `${base} · generating…`, active: true }
  if (prep.ambiguous) return { text: `${base} · request unanswered`, active: true }
  // The appended draft is in the notes (unsaved or saved): nothing is waiting for review.
  if (prep.applied && (prep.applied.notes === draft.notes || prep.applied.notes === draft.base.notes)) return { text: `${base} · notes added`, active: false }
  if (prep.suggestion) return { text: `${base} · draft to review`, active: true }
  if (prep.loadError) return { text: `${base} · unavailable`, active: false }
  if (prep.view) return { text: `${base} · ${prep.view.settings.ready ? "ready" : prep.view.settings.enabled ? "not ready" : "off"}`, active: false }
  return { text: base, active: false }
}

/**
 * Topic inbox: capture an idea with its context and source, keep it until it
 * is copied into a show, archive it when done. Stays mounted while hidden so
 * an unsaved idea survives a trip to the other views.
 */
export default function InboxView({ hidden, refreshKey = 0 }: Props) {
  const [filter, setFilterState] = useState<Filter>("active")
  const [items, setItems] = useState<InboxItem[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [draft, setDraftState] = useState<InboxDraft | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [guard, setGuard] = useState<Guard | null>(null)
  /** The assisted preparation tool is folded by default; the panel stays mounted underneath so nothing in it is lost. */
  const [prepOpen, setPrepOpen] = useState(false)

  const draftRef = useRef<InboxDraft | null>(null)
  /** Per-idea preparation state (drafts under review, in-flight answers); outlives the panel, which unmounts with the form. */
  const prepStore = usePreparationStore()
  /** Bumped on every selection change; a load/save result for an older token is dropped. */
  const selectionSeq = useRef(0)
  /** Bumped on every list refresh; an older list response never replaces a newer one. */
  const listSeq = useRef(0)
  const filterRef = useRef<Filter>("active")
  const opSeq = useRef(0)
  const titleRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const durationId = useId()
  const notesId = useId()
  const urlId = useId()
  const dialogTitleId = useId()
  const provenanceId = useId()
  const prepId = useId()

  const setDraft = useCallback((next: InboxDraft | null | ((current: InboxDraft | null) => InboxDraft | null)) => {
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

  // ---- List ------------------------------------------------------------------
  const refreshList = useCallback(() => {
    const token = ++listSeq.current
    const archived = filterRef.current === "archived"
    listInbox(archived).then(
      (next) => {
        if (token !== listSeq.current) return
        setItems(next)
        setListError(null)
      },
      (error: unknown) => {
        if (token !== listSeq.current) return
        setListError(describeError(error, "Loading the inbox"))
      },
    )
  }, [])

  // Refresh the list whenever the view is shown or an import elsewhere finished; the editor draft is untouched.
  useEffect(() => {
    if (hidden) return
    refreshList()
  }, [hidden, refreshKey, refreshList])

  // ---- Selection ------------------------------------------------------------
  const locked = pending !== null
  const dirty = draft !== null && isInboxDirty(draft)
  const unsaved = hasInboxWork(draft)

  function clearSelection() {
    selectionSeq.current += 1
    setNotice(null)
    setConflict(null)
  }

  async function loadItem(id: string) {
    const token = ++selectionSeq.current
    const op = begin("load")
    setNotice(null)
    setConflict(null)
    try {
      const item = await getInboxItem(id)
      if (token !== selectionSeq.current) return
      setDraft(draftFromItem(item))
    } catch (error) {
      if (token !== selectionSeq.current) return
      setNotice({ kind: "error", text: describeError(error, "Opening the idea") })
      if (error instanceof ApiError && error.status === 404) refreshList()
    } finally {
      end(op)
    }
  }

  function openItem(item: InboxItem) {
    if (locked) return
    if (draft?.id === item.id && !dirty) return
    if (unsaved) {
      setGuard({ kind: "open", id: item.id, text: item.text })
      return
    }
    void loadItem(item.id)
  }

  function startNew() {
    if (locked) return
    if (unsaved) {
      setGuard({ kind: "new" })
      return
    }
    clearSelection()
    setDraft(newInboxDraft(DEFAULT_DURATION))
    window.requestAnimationFrame(() => titleRef.current?.focus())
  }

  function applyFilter(next: Filter) {
    filterRef.current = next
    setFilterState(next)
    setItems(null)
    setListError(null)
    clearSelection()
    setDraft(null)
    refreshList()
  }

  function chooseFilter(next: Filter) {
    if (locked || next === filter) return
    if (unsaved) {
      setGuard({ kind: "filter", filter: next })
      return
    }
    applyFilter(next)
  }

  function confirmGuard() {
    const next = guard
    setGuard(null)
    if (!next) return
    // Drop the unsaved work explicitly, then continue with the selection.
    clearSelection()
    if (next.kind === "open") {
      setDraft(null)
      void loadItem(next.id)
    } else if (next.kind === "new") {
      setDraft(newInboxDraft(DEFAULT_DURATION))
    } else {
      applyFilter(next.filter)
    }
  }

  // ---- Editing --------------------------------------------------------------
  const edit = useCallback(
    (patch: Partial<Pick<InboxDraft, "text" | "duration" | "notes" | "source_url">>) => {
      if (pending !== null) return
      setDraft((current) => (current && !current.archived ? { ...current, ...patch } : current))
      setNotice(null)
    },
    [pending, setDraft],
  )

  function discardEdits() {
    if (!draft || locked) return
    clearSelection()
    if (draft.id === null) {
      setDraft(null)
    } else {
      setDraft({ ...draft, ...draft.base })
    }
    setNotice({ kind: "info", text: "Your edits were discarded. Showing the saved idea." })
  }

  // ---- Save -------------------------------------------------------------------
  const problem = draft ? inboxProblem(draft) : null

  async function save(event?: FormEvent) {
    event?.preventDefault()
    const target = draftRef.current
    if (!target || locked || problem !== null || !dirty || target.archived || conflict !== null) return
    const token = selectionSeq.current
    const op = begin("save")
    setNotice(null)
    try {
      const saved = target.id === null ? await createInboxItem(toCreateWire(target)) : await updateInboxItem(target.id, toUpdateWire(target))
      // Editing is locked while saving, so the draft is what we sent unless the
      // selection moved on; a stale result must never replace a newer draft.
      if (token === selectionSeq.current && draftRef.current === target) {
        setDraft(draftFromItem(saved))
        setConflict(null)
        setNotice({ kind: "info", text: `Saved "${saved.text}" · ${formatClock(saved.duration)}.` })
      }
      refreshList()
    } catch (error) {
      if (token !== selectionSeq.current) return
      if (error instanceof ApiError && error.status === 409) setConflict({ kind: "save", detail: error.detail })
      else if (error instanceof ApiError && error.status === 404) {
        setNotice({ kind: "error", text: "Not saved: this idea no longer exists. Your edits are kept here; start a new idea to keep them." })
        refreshList()
      } else setNotice({ kind: "error", text: describeError(error, "Save") })
    } finally {
      end(op)
    }
  }

  /** Conflict recovery, always explicit: reload the latest version (dropping edits) or merge onto it. */
  async function recover(mode: "reload" | "merge") {
    const current = draftRef.current
    if (!current || current.id === null || locked) return
    const token = selectionSeq.current
    const op = begin("recover")
    setNotice(null)
    try {
      const latest = await getInboxItem(current.id)
      if (token !== selectionSeq.current || draftRef.current !== current) return
      setConflict(null)
      if (mode === "reload") {
        setDraft(draftFromItem(latest))
        const dropped = isInboxDirty(current) ? " Your edits were discarded." : ""
        setNotice({ kind: "info", text: latest.archived ? `Reloaded the latest version: it is archived now.${dropped}` : `Reloaded the latest version.${dropped}` })
      } else {
        const merged = mergeInboxDraft(current, latest)
        setDraft(merged)
        setNotice({
          kind: "info",
          text: latest.archived
            ? "Merged your edits onto the latest version, which was archived meanwhile. Restore it to save them."
            : isInboxDirty(merged)
              ? "Merged the other changes into your draft. Save idea when ready."
              : "Nothing left to save: the latest version already has your changes.",
        })
      }
      refreshList()
    } catch (error) {
      if (token !== selectionSeq.current) return
      if (error instanceof ApiError && error.status === 404) {
        setNotice({ kind: "error", text: "This idea no longer exists. Your edits are kept here; start a new idea to keep them." })
        refreshList()
      } else setNotice({ kind: "error", text: describeError(error, "Loading the latest version") })
    } finally {
      end(op)
    }
  }

  // ---- Archive / restore ------------------------------------------------------
  async function setArchived(archived: boolean) {
    const current = draftRef.current
    if (!current || current.id === null || locked || conflict !== null) return
    // Archiving with unsaved edits would silently lose them (archived ideas are read-only).
    if (archived && dirty) return
    const token = selectionSeq.current
    const op = begin("archive")
    setNotice(null)
    try {
      const item = await setInboxArchived(current.id, current.baseRevision, archived)
      if (token !== selectionSeq.current || draftRef.current !== current) return
      // Keep any local edits (a restore-before-save keeps what was typed).
      setDraft(mergeInboxDraft(current, item))
      setConflict(null)
      setNotice({
        kind: "info",
        text: item.archived
          ? `Archived "${item.text}". Copies already added to shows are unchanged. Find it under Archived.`
          : `Restored "${item.text}". It is active again and can be added to shows.`,
      })
      refreshList()
    } catch (error) {
      if (token !== selectionSeq.current) return
      if (error instanceof ApiError && error.status === 409) setConflict({ kind: "archive", detail: error.detail })
      else if (error instanceof ApiError && error.status === 404) {
        setNotice({ kind: "error", text: "This idea no longer exists." })
        refreshList()
      } else setNotice({ kind: "error", text: describeError(error, archived ? "Archive" : "Restore") })
    } finally {
      end(op)
    }
  }

  // ---- Render ------------------------------------------------------------------
  const readOnly = locked || (draft?.archived ?? false)
  const urlProblem = draft ? sourceUrlProblem(draft.source_url) : null
  const prepLabel = draft ? prepSummary(draft.id === null ? undefined : prepStore.preps[draft.id], draft) : { text: "Assisted preparation", active: false }
  // A pristine new idea is not "invalid" yet; complain only once the user has typed something.
  const shownProblem = draft && (draft.id !== null || draft.text.length > 0 || draft.notes.length > 0 || draft.source_url.length > 0) ? problem : null
  const statusText = notice
    ? notice.text
    : shownProblem
      ? shownProblem
      : pending === "save"
        ? "Saving the idea…"
        : pending === "load"
          ? "Opening…"
          : draft === null
            ? "Nothing open."
            : draft.archived
              ? "Archived. Restore it to edit or add it to a show."
              : draft.id === null
                ? "New idea, not saved yet."
                : dirty
                  ? "Unsaved changes."
                  : "Saved."

  return (
    <main className="main shows inbox" id="inbox" hidden={hidden} aria-labelledby="inbox-title">
      <header className="main-head">
        <div className="main-eyebrow">
          <span className="head-lbl">Ideas for later · nothing goes on air until you add it to a show</span>
        </div>
        <h1 id="inbox-title" className="main-title">
          Inbox
        </h1>
      </header>

      <div className="shows-layout inbox-layout">
        <section className="shows-list" aria-labelledby="inbox-list-title">
          <div className="shows-list-head">
            <h2 id="inbox-list-title">Ideas</h2>
            <div className="shows-list-actions">
              <button type="button" className="btn primary" disabled={locked} onClick={startNew}>
                New idea
              </button>
              <div className="seg" role="group" aria-label="Show ideas">
                <button type="button" className={`seg-btn${filter === "active" ? " on" : ""}`} aria-pressed={filter === "active"} disabled={locked} onClick={() => chooseFilter("active")}>
                  Active
                </button>
                <button type="button" className={`seg-btn${filter === "archived" ? " on" : ""}`} aria-pressed={filter === "archived"} disabled={locked} onClick={() => chooseFilter("archived")}>
                  Archived
                </button>
              </div>
            </div>
          </div>

          {listError ? (
            <div className="banner error" role="alert">
              <p>{listError}</p>
              <div className="banner-actions">
                <button type="button" className="btn" onClick={() => refreshList()}>
                  Retry
                </button>
              </div>
            </div>
          ) : null}

          {items === null ? (
            <div className="empty">Loading ideas…</div>
          ) : items.length === 0 ? (
            <div className="empty">{filter === "active" ? "No active ideas. Capture the first one." : "Nothing archived yet."}</div>
          ) : (
            <ul className="show-cards inbox-cards" aria-label={filter === "active" ? "Active ideas" : "Archived ideas"}>
              {items.map((item) => {
                const selected = draft?.id === item.id
                const host = hostOf(item.source_url)
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={`show-card${selected ? " on" : ""}`}
                      aria-current={selected ? "true" : undefined}
                      aria-label={`Open ${item.text}`}
                      disabled={locked}
                      onClick={() => openItem(item)}
                    >
                      <span className="show-card-name">{item.text}</span>
                      <span className="show-card-meta">
                        {formatClock(item.duration)}
                        {item.notes.length > 0 ? " · notes" : ""}
                        {item.source ? ` · from ${item.source.feed_name || PROVENANCE_WORDING[item.source.kind].fallbackName}` : ""}
                        {host ? ` · ${host}` : ""}
                        {" · "}
                        {whenLabel(item.updated_at)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="show-editor inbox-editor" aria-labelledby="inbox-editor-title" aria-busy={locked || undefined}>
          <h2 id="inbox-editor-title" className="visually-hidden">
            Idea editor
          </h2>
          {draft === null ? (
            <div className="empty">{pending === "load" ? "Opening…" : "Pick an idea on the left or start a new one."}</div>
          ) : (
            <form className="inbox-form" aria-label={draft.id === null ? "New idea" : "Edit idea"} onSubmit={(event) => void save(event)}>
              {draft.archived ? (
                <div className="banner warn" role="status">
                  <p>Archived and read-only. Restore it to edit it or add it to a show; copies already in shows are unaffected.</p>
                </div>
              ) : null}

              {conflict ? (
                <div className="banner error" role="alert">
                  <p>
                    <strong>{conflict.kind === "save" ? "Not saved." : conflict.kind === "archive" ? "Not changed." : "Out of date."}</strong> {CHANGED_ELSEWHERE}{" "}
                    {dirty ? "Your edits are kept here. Merging keeps what you edited and brings in what changed there; reloading discards your edits." : "Reload it to see the latest version."}
                  </p>
                  <div className="banner-actions">
                    {dirty ? (
                      <button type="button" className="btn primary" disabled={locked} onClick={() => void recover("merge")}>
                        Merge with the latest version
                      </button>
                    ) : null}
                    <button type="button" className={`btn${dirty ? "" : " primary"}`} disabled={locked} onClick={() => void recover("reload")}>
                      {dirty ? "Reload and discard my edits" : "Reload the latest version"}
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="inbox-fields">
                <label className="field grow" htmlFor={titleId}>
                  <span>Title</span>
                  <input
                    id={titleId}
                    ref={titleRef}
                    aria-label="Idea title"
                    aria-invalid={validTitle(draft.text) ? undefined : true}
                    className="show-name"
                    disabled={readOnly}
                    maxLength={MAX_TITLE * 2}
                    placeholder="What is the segment?"
                    value={draft.text}
                    onChange={(event) => edit({ text: event.target.value })}
                  />
                </label>
                <label className="field seconds" htmlFor={durationId}>
                  <span>Seconds</span>
                  <input
                    id={durationId}
                    aria-label="Idea duration"
                    disabled={readOnly}
                    inputMode="numeric"
                    min={MIN_DURATION}
                    max={MAX_DURATION}
                    step={1}
                    type="number"
                    value={Number.isNaN(draft.duration) ? "" : draft.duration}
                    onChange={(event) => edit({ duration: event.target.valueAsNumber })}
                  />
                </label>
              </div>

              <div className="inbox-context">
                <span className="field-label">Notes</span>
                <NotesPanel
                  id={notesId}
                  label="Idea notes"
                  value={draft.notes}
                  disabled={readOnly}
                  placeholder={"Why it matters, what to say, questions to ask…"}
                  hint={NOTES_HINT}
                  onChange={(notes) => edit({ notes })}
                />
              </div>

              <div className="inbox-source">
                <label className="field grow" htmlFor={urlId}>
                  <span>Source URL (optional)</span>
                  <input
                    id={urlId}
                    aria-label="Source URL"
                    aria-invalid={urlProblem ? true : undefined}
                    aria-describedby={urlProblem ? `${urlId}-hint` : undefined}
                    disabled={readOnly}
                    inputMode="url"
                    maxLength={MAX_SOURCE_URL * 2}
                    placeholder="https://example.com/story"
                    spellCheck={false}
                    type="text"
                    value={draft.source_url}
                    onChange={(event) => edit({ source_url: event.target.value })}
                  />
                </label>
                {urlProblem ? (
                  <div id={`${urlId}-hint`} className="inbox-source-meta">
                    <span className="tproblem">{urlProblem}</span>
                  </div>
                ) : null}
                <SocialLinkPreview
                  key={`social-link:${draft.id ?? "new"}`}
                  sourceUrl={draft.source_url}
                  title={draft.text}
                  notes={draft.notes}
                  readOnly={readOnly}
                  archived={draft.archived}
                  onApply={(patch) => edit(patch)}
                  onUseCanonical={(source_url) => edit({ source_url })}
                />
              </div>

              {draft.source ? <SourcePanel key={draft.id ?? "new"} source={draft.source} panelId={provenanceId} /> : null}

              <div className="inbox-tool" data-testid="inbox-prep-tool">
                <NotesToggle
                  label={prepLabel.text}
                  expanded={prepOpen}
                  hasNotes={prepLabel.active}
                  panelId={prepId}
                  wording={{ empty: prepLabel.text, filled: prepLabel.text }}
                  onToggle={() => setPrepOpen((value) => !value)}
                />
                <div id={prepId} hidden={!prepOpen}>
                  <PreparationPanel
                    store={prepStore}
                    topicId={draft.id}
                    revision={draft.baseRevision}
                    baseNotes={draft.base.notes}
                    notes={draft.notes}
                    sourceUrl={draft.source_url}
                    archived={draft.archived}
                    dirty={dirty}
                    locked={locked}
                    hidden={hidden}
                    onAppend={(notes) => edit({ notes })}
                    onOutOfDate={() => setConflict({ kind: "stale", detail: CHANGED_ELSEWHERE })}
                  />
                </div>
              </div>

              <footer className="publish-bar show-bar inbox-bar">
                <p className={`publish-status${notice?.kind === "error" ? " error" : ""}`} aria-live="polite">
                  {statusText}
                </p>
                <div className="publish-actions show-actions">
                  {dirty && !draft.archived ? (
                    <button type="button" className="btn" disabled={locked} onClick={discardEdits}>
                      {draft.id === null ? "Discard new idea" : "Discard edits"}
                    </button>
                  ) : null}
                  {draft.id !== null ? (
                    draft.archived ? (
                      <button type="button" className="btn activate" disabled={locked || conflict !== null} onClick={() => void setArchived(false)}>
                        {pending === "archive" ? "Restoring…" : "Restore"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        disabled={locked || dirty || conflict !== null}
                        title={dirty ? "Save or discard your edits first" : "Move this idea out of the active list; copies in shows are unaffected"}
                        onClick={() => void setArchived(true)}
                      >
                        {pending === "archive" ? "Archiving…" : "Archive"}
                      </button>
                    )
                  ) : null}
                  {draft.archived ? null : (
                    <button type="submit" className="btn primary" disabled={locked || !dirty || problem !== null || conflict !== null}>
                      {pending === "save" ? "Saving…" : "Save idea"}
                    </button>
                  )}
                </div>
              </footer>
            </form>
          )}
          {draft === null ? (
            <footer className="publish-bar show-bar inbox-bar">
              <p className={`publish-status${notice?.kind === "error" ? " error" : ""}`} aria-live="polite">
                {statusText}
              </p>
            </footer>
          ) : null}
        </section>
      </div>

      {guard ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby={`${dialogTitleId}-guard`}>
            <h2 id={`${dialogTitleId}-guard`}>Unsaved changes</h2>
            <p>
              {draft?.id === null ? "Your new idea has not been saved." : `"${draft?.text}" has unsaved changes.`}{" "}
              {guard.kind === "open" ? `Opening "${guard.text}" will discard them.` : guard.kind === "new" ? "Starting a new idea will discard them." : `Switching to ${guard.filter} ideas will discard them.`}
            </p>
            <div className="banner-actions">
              <button type="button" className="btn primary" autoFocus onClick={() => setGuard(null)}>
                Keep editing
              </button>
              <button type="button" className="btn" onClick={confirmGuard}>
                {guard.kind === "open" ? "Discard and open" : guard.kind === "new" ? "Discard and start new" : "Discard and switch"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}
