import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import type { KeyboardEvent } from "react"
import { ApiError, getInboxItem, listInbox, listPlans, putInboxEditorial, type InboxEditorial, type InboxItem, type PlanSummary } from "../lib/api"
import {
  SOURCE_FILTERS,
  cardOf,
  dateLabel,
  editorialOf,
  formatDuration,
  isTypingTarget,
  matches,
  type Card,
  type SourceFilter,
} from "../lib/discover"
import { MAX_NOTES, notesLength } from "../lib/draft"
import CaptureSheet, { type CaptureResult } from "./CaptureSheet"
import DaysDrawer, { type PendingTopic } from "./DaysDrawer"
import DiscoverArt from "./DiscoverArt"

type Props = {
  hidden: boolean
  /** Bumped by the owner when an import elsewhere finished; the list reloads, drafts are untouched. */
  refreshKey?: number
  /** "Import…" hands over to Sources, where feeds and discovery searches live. */
  onOpenSources: () => void
  /** A streaming day opens in Saved Shows, where the editor and explicit activation live. */
  onOpenShow: (show: { id: string; name: string }) => void
}

type Mode = "focus" | "explore"

/**
 * One topic's unsaved personal note. Keyed by topic id and kept apart from the
 * server list, so a refresh, a filter change or a trip to another view never
 * drops typed text. A rejected save keeps the text and shows why.
 */
type NoteDraft = {
  text: string
  /** Editorial revision and note the text was taken from. A save sends this revision, never a fresher one a refresh brought in. */
  baseRevision: number
  baseNote: string
  open: boolean
  pending: boolean
  error: string | null
  /** The other screen's editorial state after a 409 or a refresh; the draft is kept until the user picks. */
  conflict: InboxEditorial | null
}

const CHANGED_ELSEWHERE = "This note changed on another screen."

function describeError(error: unknown, what: string): string {
  if (error instanceof ApiError) return `${what} rejected (${error.status}): ${error.detail}`
  return `${what} failed: the RUNDOWN API did not respond.`
}

function freshDraft(item: InboxItem): NoteDraft {
  const editorial = editorialOf(item)
  return { text: editorial.note, baseRevision: editorial.revision, baseNote: editorial.note, open: false, pending: false, error: null, conflict: null }
}

function draftFor(item: InboxItem, drafts: Record<string, NoteDraft>): NoteDraft {
  return drafts[item.id] ?? freshDraft(item)
}

function isDirty(draft: NoteDraft): boolean {
  return draft.text !== draft.baseNote
}

/**
 * A list response may have been requested before a save landed. Editorial
 * revisions only ever grow, so the copy with the higher revision is the truth.
 */
function mergeItems(current: InboxItem[] | null, incoming: InboxItem[]): InboxItem[] {
  if (!current) return incoming
  const known = new Map(current.map((item) => [item.id, item]))
  return incoming.map((item) => {
    const mine = known.get(item.id)
    return mine && editorialOf(mine).revision > editorialOf(item).revision ? mine : item
  })
}

/** After a refresh, a dirty draft taken from an older revision is flagged before the user tries to save over the other screen. */
function flagRefreshConflicts(drafts: Record<string, NoteDraft>, items: InboxItem[]): Record<string, NoteDraft> {
  let changed = false
  const next = { ...drafts }
  for (const item of items) {
    const draft = drafts[item.id]
    if (!draft || draft.pending || draft.conflict) continue
    const editorial = editorialOf(item)
    if (editorial.revision === draft.baseRevision) continue
    if (!isDirty(draft)) {
      next[item.id] = { ...draft, text: editorial.note, baseRevision: editorial.revision, baseNote: editorial.note }
    } else {
      next[item.id] = { ...draft, conflict: editorial }
    }
    changed = true
  }
  return changed ? next : drafts
}

// ---- Artwork -----------------------------------------------------------------

/**
 * Lazy thumbnail with one fallback: a missing or failed image becomes
 * deterministic artwork and stays that way (no retry loop, no broken icon).
 * Remounted by the owner (key on the URL) when the address changes.
 */
function Artwork({ card, tag }: { card: Card; tag: string | null }) {
  const [failed, setFailed] = useState(false)
  const thumb = card.thumbnail
  return (
    <figure className={`dsc-art${card.portrait ? " portrait" : ""}`} data-state={thumb && !failed ? "image" : "artwork"}>
      {thumb && !failed ? (
        <img
          src={thumb.url}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          width={thumb.width ?? undefined}
          height={thumb.height ?? undefined}
          data-testid="dsc-thumb"
          onError={() => setFailed(true)}
        />
      ) : (
        <DiscoverArt id={card.id} />
      )}
      {tag ? <figcaption className="dsc-tag">{tag}</figcaption> : null}
    </figure>
  )
}

// ---- Card ----------------------------------------------------------------------

type CardProps = {
  item: InboxItem
  index: number
  variant: Mode
  lead: boolean
  draft: NoteDraft
  onSave: (item: InboxItem, patch: { saved?: boolean; note?: string }, revision?: number) => void
  onDraft: (id: string, patch: Partial<NoteDraft>) => void
  onUseTheirs: (id: string, theirs: InboxEditorial) => void
  onFocusCard: (index: number) => void
  /** "＋ Day": add this card to a streaming day (opens the days drawer). */
  onPlan: (topic: PendingTopic) => void
}

function TopicCard({ item, index, variant, lead, draft, onSave, onDraft, onUseTheirs, onFocusCard, onPlan }: CardProps) {
  const card = cardOf(item)
  const editorial = editorialOf(item)
  const [expanded, setExpanded] = useState(false)
  const noteId = useId()
  const dirty = isDirty(draft)
  const hasNote = editorial.note.trim().length > 0 || (dirty && draft.text.trim().length > 0)
  const overLimit = notesLength(draft.text) > MAX_NOTES
  const when = dateLabel(card.published)
  const duration = card.mediaSeconds !== null ? formatDuration(card.mediaSeconds) : null
  const tag = card.kind === "youtube" ? `Video${duration ? ` · ${duration}` : ""}` : card.sourceKind === "tiktok" ? "Video" : card.sourceKind === "article" ? "Article" : card.kind === "manual" ? "Your idea" : card.kind === "reddit" ? "Thread" : null
  const canReadMore = card.fullText.trim().length > 0 && card.fullText.trim() !== card.excerpt
  const status = draft.pending
    ? "Saving…"
    : draft.conflict
      ? CHANGED_ELSEWHERE
      : draft.error
        ? draft.error
        : overLimit
          ? `Notes must be at most ${MAX_NOTES} characters.`
          : dirty
            ? "Unsaved · Save note to keep it"
            : editorial.note.length > 0
              ? "Saved"
              : ""

  return (
    <article
      className={`dsc-card${variant === "explore" ? " dsc-tile" : ""}${lead ? " lead" : ""}`}
      data-id={item.id}
      data-index={index}
      tabIndex={-1}
      aria-label={card.title}
      onFocus={() => onFocusCard(index)}
    >
      <div className="dsc-card-inner">
        <Artwork key={card.thumbnail?.url ?? "none"} card={card} tag={tag} />
        <div className="dsc-body">
          <div className="dsc-kicker">
            <span className="dsc-src">{card.kindLabel}</span>
            {card.creator ? (
              <>
                <span className="dsc-dot" aria-hidden="true" />
                <span className="dsc-creator">{card.creator}</span>
              </>
            ) : null}
            {when ? (
              <>
                <span className="dsc-dot" aria-hidden="true" />
                <span>{when}</span>
              </>
            ) : null}
            {duration ? (
              <>
                <span className="dsc-dot" aria-hidden="true" />
                <span>{duration}</span>
              </>
            ) : null}
          </div>
          <h2 className="dsc-title">{card.title}</h2>
          {card.liveLabel !== card.title ? (
            <p className="dsc-live-label">
              On air as <b>{card.liveLabel}</b>
            </p>
          ) : null}
          {card.excerpt ? <p className="dsc-dek">{card.excerpt}</p> : null}
          {expanded ? (
            <pre className="dsc-full" data-testid="dsc-full">
              {card.fullText}
            </pre>
          ) : null}
          <div className="dsc-actions">
            {canReadMore ? (
              <button type="button" className="dsc-act dsc-read" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
                {expanded ? "Less" : "Read more"}
              </button>
            ) : null}
            <button
              type="button"
              className="dsc-act dsc-save"
              aria-pressed={editorial.saved}
              aria-label={`${editorial.saved ? "Remove bookmark" : "Bookmark"}: ${card.title}`}
              disabled={draft.pending || draft.conflict !== null}
              onClick={() => onSave(item, { saved: !editorial.saved })}
            >
              <span aria-hidden="true">{editorial.saved ? "★" : "☆"}</span> {editorial.saved ? "Saved" : "Save"}
            </button>
            <button
              type="button"
              className={`dsc-act dsc-note-btn${hasNote ? " has-note" : ""}`}
              aria-expanded={draft.open}
              aria-controls={draft.open ? noteId : undefined}
              aria-label={`Note: ${card.title}`}
              onClick={() => onDraft(item.id, { open: !draft.open })}
            >
              <span aria-hidden="true">✎</span> Note{hasNote ? <span className="notes-badge" aria-hidden="true" /> : null}
            </button>
            <button type="button" className="dsc-act dsc-plan" aria-label={`Add to a streaming day: ${card.title}`} onClick={() => onPlan({ id: item.id, title: card.title })}>
              <span aria-hidden="true">＋</span> Day
            </button>
            {card.href ? (
              <a className="dsc-act dsc-open" href={card.href} target="_blank" rel="noopener noreferrer">
                Open original <span aria-hidden="true">↗</span>
              </a>
            ) : null}
            {card.document ? (
              <a className="dsc-act dsc-open" href={`${card.document.url}?download=1`} download={card.document.filename}>
                Download {card.document.filename} <span aria-hidden="true">↓</span>
              </a>
            ) : null}
          </div>
          {draft.open ? (
            <div id={noteId} className="dsc-note">
              <textarea
                aria-label={`Your note for ${card.title}`}
                className="notes-text dsc-note-text"
                rows={2}
                placeholder="A line for future you…"
                value={draft.text}
                disabled={draft.pending}
                aria-invalid={overLimit || undefined}
                onChange={(event) => onDraft(item.id, { text: event.target.value, error: null })}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && dirty && !overLimit && !draft.pending) {
                    event.preventDefault()
                    onSave(item, { note: draft.text })
                  }
                }}
              />
              <div className="dsc-note-bar">
                <span className={`dsc-note-status${draft.error || draft.conflict ? " error" : dirty ? " unsaved" : ""}`} role="status">
                  {status}
                </span>
                <div className="dsc-note-actions">
                  {dirty ? (
                    <button type="button" className="btn small" disabled={draft.pending} onClick={() => onDraft(item.id, { text: editorial.note, baseRevision: editorial.revision, baseNote: editorial.note, error: null, conflict: null })}>
                      Discard
                    </button>
                  ) : null}
                  <button type="button" className="btn small primary" disabled={!dirty || overLimit || draft.pending || draft.conflict !== null} onClick={() => onSave(item, { note: draft.text })}>
                    Save note
                  </button>
                </div>
              </div>
              {draft.conflict ? (
                <div className="banner warn dsc-conflict" role="alert">
                  <p>
                    {CHANGED_ELSEWHERE} Your text is kept above. Theirs: {draft.conflict.note.length > 0 ? <q>{draft.conflict.note}</q> : <em>(empty)</em>}
                  </p>
                  <div className="banner-actions">
                    <button type="button" className="btn" disabled={draft.pending} onClick={() => onSave(item, { note: draft.text }, draft.conflict?.revision)}>
                      Keep mine and save again
                    </button>
                    <button type="button" className="btn" disabled={draft.pending} onClick={() => onUseTheirs(item.id, draft.conflict as InboxEditorial)}>
                      Use theirs
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  )
}

// ---- View --------------------------------------------------------------------------

/**
 * Discover: imported and captured topics as visual cards. Focus shows one card
 * per screen with scroll snap; Explore is a grid. Bookmark and note go to the
 * editorial endpoint only; imported text and context notes are never edited
 * here. The view stays mounted while hidden so drafts survive navigation.
 */
export default function DiscoverView({ hidden, refreshKey = 0, onOpenSources, onOpenShow }: Props) {
  const [mode, setMode] = useState<Mode>("focus")
  const [filter, setFilter] = useState<SourceFilter>("all")
  const [savedOnly, setSavedOnly] = useState(false)
  const [items, setItems] = useState<InboxItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, NoteDraft>>({})
  const [current, setCurrent] = useState(0)
  /** Height of whatever sits above this view (the compact top bar); the stage fills the rest of the viewport. */
  const [above, setAbove] = useState(0)
  const rootRef = useRef<HTMLElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  /** Mirrors `items` synchronously so a save landing between renders merges against the latest list. */
  const itemsRef = useRef<InboxItem[] | null>(null)
  const listSeq = useRef(0)
  const titleId = useId()
  // ---- Streaming days and capture (drawers) ---------------------------------
  const [daysOpen, setDaysOpen] = useState(false)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [captureForDay, setCaptureForDay] = useState(false)
  const [plans, setPlans] = useState<PlanSummary[] | null>(null)
  const [plansError, setPlansError] = useState<string | null>(null)
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [planRefreshKey, setPlanRefreshKey] = useState(0)
  const [pending, setPending] = useState<PendingTopic | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const plansSeq = useRef(0)

  const commitItems = useCallback((next: InboxItem[]) => {
    itemsRef.current = next
    setItems(next)
  }, [])

  // ---- List ---------------------------------------------------------------
  const load = useCallback(() => {
    const token = ++listSeq.current
    listInbox(false).then(
      (next) => {
        if (token !== listSeq.current) return
        const merged = mergeItems(itemsRef.current, next)
        commitItems(merged)
        setDrafts((all) => flagRefreshConflicts(all, merged))
        setLoadError(null)
        setLoading(false)
      },
      (error: unknown) => {
        if (token !== listSeq.current) return
        setLoadError(describeError(error, "Loading topics"))
        setLoading(false)
      },
    )
  }, [commitItems])

  function refreshList() {
    setLoading(true)
    load()
  }

  const loadPlans = useCallback(() => {
    const token = ++plansSeq.current
    listPlans().then(
      (next) => {
        if (token !== plansSeq.current) return
        setPlans(next)
        setPlansError(null)
      },
      (error: unknown) => {
        if (token !== plansSeq.current) return
        setPlansError(describeError(error, "Loading streaming days"))
      },
    )
  }, [])

  // The day list is only fetched once the user reaches for it.
  useEffect(() => {
    if (daysOpen || captureOpen) loadPlans()
  }, [daysOpen, captureOpen, loadPlans])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 6000)
    return () => window.clearTimeout(timer)
  }, [toast])

  function openDays(topic: PendingTopic | null) {
    setCaptureOpen(false)
    if (topic) setPending(topic)
    setDaysOpen(true)
  }

  function openCapture(forDay: boolean) {
    setDaysOpen(false)
    setCaptureForDay(forDay)
    setCaptureOpen(true)
  }

  function created(result: CaptureResult) {
    setCaptureOpen(false)
    refreshList()
    if (result.plan) setPlanRefreshKey((key) => key + 1)
    if (result.unsavedNote !== null) setDraft(result.item.id, { text: result.unsavedNote, baseRevision: editorialOf(result.item).revision, baseNote: editorialOf(result.item).note, open: true })
    setToast(result.warning ?? (result.plan ? `Topic created and added to ${result.plan.stream_date ?? ""} ${result.plan.name}`.replace("  ", " ") : "Topic created · saved to your library"))
    if (result.plan) setDaysOpen(true)
  }

  // Reload whenever the view is shown or an import elsewhere finished; drafts are untouched.
  useEffect(() => {
    if (hidden) return
    load()
  }, [hidden, refreshKey, load])

  // ---- Layout: the stage is the scroll container, sized to the viewport ----
  useLayoutEffect(() => {
    if (hidden) return
    const measure = () => {
      const root = rootRef.current
      if (!root) return
      setAbove(Math.max(0, Math.round(root.getBoundingClientRect().top + window.scrollY)))
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [hidden, mode])

  // ---- Focus position (which card fills the screen) ------------------------
  const visible = (items ?? []).filter((item) => matches(item, filter, savedOnly))
  const visibleKey = visible.map((item) => item.id).join("\u0000")
  useEffect(() => {
    const stage = stageRef.current
    if (hidden || mode !== "focus" || !stage || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            const index = Number((entry.target as HTMLElement).dataset.index)
            if (Number.isInteger(index)) setCurrent(index)
          }
        }
      },
      { root: stage, threshold: [0.5] },
    )
    stage.querySelectorAll<HTMLElement>(".dsc-card").forEach((card) => observer.observe(card))
    return () => observer.disconnect()
  }, [hidden, mode, visibleKey])

  function goTo(index: number) {
    const cards = stageRef.current?.querySelectorAll<HTMLElement>(".dsc-card") ?? []
    if (cards.length === 0) return
    const next = Math.max(0, Math.min(cards.length - 1, index))
    const target = cards[next]
    setCurrent(next)
    if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: mode === "focus" ? "start" : "nearest", behavior: "smooth" })
    if (mode === "explore") target.focus({ preventScroll: true })
  }

  function onKey(event: KeyboardEvent<HTMLElement>) {
    if (daysOpen || captureOpen || isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return
    const next = event.key === "ArrowDown" || event.key === "j" || (mode === "explore" && event.key === "ArrowRight")
    const prev = event.key === "ArrowUp" || event.key === "k" || (mode === "explore" && event.key === "ArrowLeft")
    if (!next && !prev) return
    event.preventDefault()
    goTo(current + (next ? 1 : -1))
  }

  // ---- Editorial writes -----------------------------------------------------
  const setDraft = useCallback((id: string, patch: Partial<NoteDraft>) => {
    setDrafts((all) => {
      const item = (itemsRef.current ?? []).find((entry) => entry.id === id)
      const base = all[id] ?? (item ? freshDraft(item) : { text: "", baseRevision: 0, baseNote: "", open: false, pending: false, error: null, conflict: null })
      return { ...all, [id]: { ...base, ...patch } }
    })
  }, [])

  function replaceItem(next: InboxItem) {
    const all = itemsRef.current
    if (all) commitItems(all.map((entry) => (entry.id === next.id ? next : entry)))
  }

  /**
   * Send the complete editorial state. A bookmark toggle carries the stored
   * note (never the draft) so it cannot save or lose unsaved text. A 409
   * reloads the other screen's state, keeps the draft and asks the user.
   */
  async function save(item: InboxItem, patch: { saved?: boolean; note?: string }, revision?: number) {
    const editorial = editorialOf(item)
    const draft = draftFor(item, drafts)
    // A note save is pinned to the revision the text was typed against; a
    // bookmark toggle carries the stored note and the item's own revision.
    const base = revision ?? (patch.note !== undefined ? draft.baseRevision : editorial.revision)
    const wire = { revision: base, saved: patch.saved ?? editorial.saved, note: patch.note ?? editorial.note }
    setDraft(item.id, { pending: true, error: null, conflict: null })
    try {
      const next = await putInboxEditorial(item.id, wire)
      replaceItem(next)
      const latest = editorialOf(next)
      // Our own write is now the newest state: re-pin the draft to it, keeping typed text after a bookmark toggle.
      setDraft(item.id, { pending: false, error: null, conflict: null, baseRevision: latest.revision, baseNote: latest.note, ...(patch.note !== undefined ? { text: latest.note } : {}) })
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        try {
          const latest = await getInboxItem(item.id)
          replaceItem(latest)
          setDraft(item.id, { pending: false, error: null, conflict: editorialOf(latest), open: true })
        } catch (reload) {
          setDraft(item.id, { pending: false, error: describeError(reload, "Reloading the note"), conflict: null, open: true })
        }
        return
      }
      setDraft(item.id, { pending: false, error: describeError(error, patch.note !== undefined ? "Saving the note" : "Bookmarking"), open: patch.note !== undefined ? true : undefined })
    }
  }

  function useTheirs(id: string, theirs: InboxEditorial) {
    setDraft(id, { text: theirs.note, baseRevision: theirs.revision, baseNote: theirs.note, conflict: null, error: null })
  }

  const savedCount = (items ?? []).filter((item) => editorialOf(item).saved).length
  const unsavedDrafts = Object.entries(drafts).filter(([id, draft]) => (items ?? []).some((entry) => entry.id === id) && isDirty(draft)).length

  return (
    <section
      ref={rootRef}
      className="main discover"
      id="discover"
      hidden={hidden}
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKey}
      style={{ height: `calc(100dvh - ${above}px)` }}
    >
      <header className="dsc-top">
        <div className="dsc-brand">
          <h1 id={titleId} className="dsc-h1">
            Discover
          </h1>
          <span className="dsc-count" aria-live="polite">
            {items === null ? "" : `${visible.length} of ${items.length}`}
            {unsavedDrafts > 0 ? ` · ${unsavedDrafts} unsaved note${unsavedDrafts === 1 ? "" : "s"}` : ""}
          </span>
        </div>
        <div className="dsc-modes" role="tablist" aria-label="Layout">
          <button type="button" role="tab" aria-selected={mode === "focus"} className="dsc-mode" onClick={() => setMode("focus")}>
            Focus
          </button>
          <button type="button" role="tab" aria-selected={mode === "explore"} className="dsc-mode" onClick={() => setMode("explore")}>
            Explore
          </button>
        </div>
        <div className="dsc-tools">
          <button type="button" className="btn small" aria-label="New topic" aria-expanded={captureOpen} aria-controls="dsc-capture" onClick={() => openCapture(false)}>
            <span aria-hidden="true">＋</span> New
          </button>
          <button type="button" className="btn small" aria-label="Streaming days" aria-expanded={daysOpen} aria-controls="dsc-days" onClick={() => openDays(null)}>
            Days
          </button>
          <button type="button" className="btn small" aria-label="Refresh topics" disabled={loading} onClick={refreshList}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button type="button" className="btn small" onClick={onOpenSources}>
            Import…
          </button>
        </div>
      </header>
      <nav className="dsc-chips" aria-label="Filters">
        {SOURCE_FILTERS.map((chip) => (
          <button key={chip.id} type="button" className="dsc-chip" aria-pressed={filter === chip.id} onClick={() => setFilter(chip.id)}>
            {chip.label}
          </button>
        ))}
        <span className="dsc-chip-gap" aria-hidden="true" />
        <button type="button" className="dsc-chip dsc-chip-saved" aria-pressed={savedOnly} onClick={() => setSavedOnly((value) => !value)}>
          Saved{savedCount > 0 ? ` · ${savedCount}` : ""}
        </button>
      </nav>
      {loadError ? (
        <div className="banner error dsc-banner" role="alert">
          <p>{loadError}</p>
        </div>
      ) : null}
      <div ref={stageRef} className="dsc-stage" data-mode={mode} aria-label="Topics">
        {items === null && loadError === null ? (
          <div className="empty dsc-empty">Loading Discover…</div>
        ) : visible.length === 0 ? (
          <div className="empty dsc-empty">
            {items !== null && items.length === 0 ? "Nothing here yet. Import a feed or a discovery search from Sources, or capture an idea in the Inbox." : savedOnly ? "No saved topics match this filter." : "No topics match this filter."}
          </div>
        ) : mode === "focus" ? (
          <div className="dsc-feed">
            {visible.map((item, index) => (
              <TopicCard key={item.id} item={item} index={index} variant="focus" lead={false} draft={draftFor(item, drafts)} onSave={(target, patch, revision) => void save(target, patch, revision)} onDraft={setDraft} onUseTheirs={useTheirs} onFocusCard={setCurrent} onPlan={openDays} />
            ))}
          </div>
        ) : (
          <div className="dsc-grid">
            {visible.map((item, index) => (
              <TopicCard key={item.id} item={item} index={index} variant="explore" lead={index === 0} draft={draftFor(item, drafts)} onSave={(target, patch, revision) => void save(target, patch, revision)} onDraft={setDraft} onUseTheirs={useTheirs} onFocusCard={setCurrent} onPlan={openDays} />
            ))}
          </div>
        )}
      </div>
      {mode === "focus" && visible.length > 1 ? (
        <div className="dsc-progress" aria-hidden="true">
          <span className="n">
            {Math.min(current, visible.length - 1) + 1} / {visible.length}
          </span>
          {visible.map((item, index) => (
            <i key={item.id} className={index === Math.min(current, visible.length - 1) ? "on" : ""} />
          ))}
        </div>
      ) : null}
      {toast ? (
        <div className="dsc-toast" role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}
      <DaysDrawer
        open={daysOpen}
        onClose={() => setDaysOpen(false)}
        plans={plans}
        plansError={plansError}
        selectedId={selectedPlanId}
        onSelect={setSelectedPlanId}
        onPlansChanged={loadPlans}
        refreshKey={planRefreshKey}
        pending={pending}
        onPendingDone={() => setPending(null)}
        onOpenShow={(show) => {
          setDaysOpen(false)
          onOpenShow(show)
        }}
        onNewTopic={() => openCapture(true)}
      />
      <CaptureSheet open={captureOpen} onClose={() => setCaptureOpen(false)} selectedPlan={plans?.find((plan) => plan.id === selectedPlanId) ?? null} forDay={captureForDay} onCreated={created} />
    </section>
  )
}
