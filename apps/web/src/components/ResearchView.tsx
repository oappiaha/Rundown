import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { FormEvent } from "react"
import {
  ApiError,
  buildResearchShow,
  getResearch,
  previewResearch,
  proposeResearch,
  putResearchPreferences,
  type ResearchCategory,
  type ResearchCategoryId,
  type ResearchItem,
  type ResearchList,
  type ResearchPreview,
  type ResearchPriority,
  type ResearchSelection,
  type SavedShow,
} from "../lib/api"
import { formatClock } from "../lib/draft"
import ResearchAnalysis from "./ResearchAnalysis"
import { formatMinutes, topicCount } from "../lib/showDraft"
import { safeSourceHref } from "../lib/inboxDraft"
import {
  DEFAULT_SUGGEST,
  MAX_SHORTLIST,
  MAX_SHOW_NAME,
  MAX_SUGGEST,
  MIN_SUGGEST,
  PRIORITY_LABELS,
  addToShortlist,
  buildIntentKey,
  countByCategory,
  coverageOverlap,
  curationMoved,
  curationProblem,
  filterStories,
  groupByCategory,
  indexStories,
  isCurationDirty,
  mergeStories,
  moveInShortlist,
  newCurationDraft,
  newRequestId,
  pruneCleanDrafts,
  rebaseCuration,
  removeFromShortlist,
  sameSelections,
  selectionsFor,
  shortlistProblem,
  shortlistSeconds,
  storyCount,
  toPreferencesWire,
  validCount,
  validShowName,
  type CategoryFilter,
  type CurationDraft,
  type CurationValues,
} from "../lib/researchDraft"

type Props = {
  hidden: boolean
  /** The user asked to open a show this view just saved; the owner switches to Saved Shows and loads it (guarding unsaved work there). */
  onOpenShow: (show: SavedShow) => void
}

type Notice = { kind: "info" | "error"; text: string }
type Pending = "load" | "curate" | "suggest" | "preview" | "save" | null
/** A preview pinned to the exact selections it was made from; `stale` is set when the server rejected a later build against it. */
type Preview = { selections: ResearchSelection[]; result: ResearchPreview; stale: boolean }
/** A curation save rejected as stale; the edited values stay until the user picks a recovery. */
type CurationConflict = { detail: string }
/** A proposal waiting for the user to confirm it replaces the current shortlist. */
type Proposal = { items: ResearchItem[]; warnings: string[] }

const RANKING_NOTE = "Local ranking: priority, freshness and saved context. Categories are editable keyword suggestions. AI analysis is optional and separate: open the panel in the shortlist column to send chosen stories with a brief, only on your explicit click."
const PREVIEW_NOTE = "Uses the saved titles, durations and context. No AI text is generated."

function describeError(error: unknown, what: string): string {
  if (error instanceof ApiError) return `${what} rejected (${error.status}): ${error.detail}`
  return `${what} failed: the RUNDOWN API did not respond.`
}

function labelFor(categories: ResearchCategory[], id: ResearchCategoryId): string {
  return categories.find((category) => category.id === id)?.label ?? id
}

/**
 * Research: the active inbox organised by category and local rank, explicit
 * per-story curation, an ordered shortlist, a read-only preview and one
 * explicit save into an independent Saved Show. Stays mounted while hidden so
 * the shortlist, name and preview survive a trip to the other views.
 */
export default function ResearchView({ hidden, onOpenShow }: Props) {
  const [categories, setCategories] = useState<ResearchCategory[]>([])
  const [items, setItems] = useState<ResearchItem[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [filter, setFilter] = useState<CategoryFilter>("all")
  const [showExcluded, setShowExcluded] = useState(true)
  const [search, setSearch] = useState("")
  const [pending, setPending] = useState<Pending>(null)
  /** The AI analysis panel has a request in flight; the composer and curation wait so its input stays frozen. */
  const [aiBusy, setAiBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  // Curation: one editable draft per story, opened on demand and pinned to
  // the saved version it was opened from (see CurationDraft).
  const [curateOpen, setCurateOpen] = useState<Record<string, boolean>>({})
  const [curation, setCuration] = useState<Record<string, CurationDraft>>({})
  /** Saves the server refused as stale; cleared only by an explicit recovery. */
  const [curationConflict, setCurationConflict] = useState<Record<string, CurationConflict>>({})

  // Composer.
  const [shortlist, setShortlist] = useState<string[]>([])
  const [name, setName] = useState("")
  const [suggestCount, setSuggestCount] = useState(DEFAULT_SUGGEST)
  const [suggestCategories, setSuggestCategories] = useState<ResearchCategoryId[]>([])
  const [suggestWarnings, setSuggestWarnings] = useState<string[]>([])
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [saved, setSaved] = useState<{ show: SavedShow; key: string } | null>(null)

  /** Bumped on every list load; an older response never replaces a newer one. */
  const loadSeq = useRef(0)
  const opSeq = useRef(0)
  const loadedOnce = useRef(false)
  /** One request id per save intent (name + exact selections); reused verbatim after a failed or doubled attempt. */
  const intentRef = useRef<{ key: string; requestId: string } | null>(null)
  const storiesTitleId = useId()
  const composerTitleId = useId()
  const nameId = useId()
  const countId = useId()
  const searchId = useId()
  const dialogTitleId = useId()
  const keepRef = useRef<HTMLButtonElement>(null)

  function begin(kind: Exclude<Pending, null>): number {
    const op = ++opSeq.current
    setPending(kind)
    return op
  }

  function end(op: number) {
    if (op === opSeq.current) setPending(null)
  }

  // ---- Loading -----------------------------------------------------------------
  /**
   * Reload the catalog. Drafts with edits keep their pinned base (a newer
   * saved version then shows as a conflict); untouched drafts are dropped so
   * they follow the fresh data. Returns the list, or null when it failed or
   * was superseded by a newer load.
   */
  const load = useCallback(async (): Promise<ResearchList | null> => {
    const token = ++loadSeq.current
    const op = ++opSeq.current
    setPending("load")
    try {
      const list = await getResearch()
      if (token !== loadSeq.current) return null
      setCategories(list.categories)
      setItems(list.items)
      setCuration(pruneCleanDrafts)
      setListError(null)
      loadedOnce.current = true
      return list
    } catch (error) {
      if (token !== loadSeq.current) return null
      setListError(describeError(error, "Loading stories"))
      return null
    } finally {
      if (op === opSeq.current) setPending(null)
    }
  }, [])

  // First visit loads the stories; later visits keep what is on screen (the
  // shortlist and preview are pinned to it) until the user refreshes.
  useEffect(() => {
    if (hidden || loadedOnce.current) return
    void load()
  }, [hidden, load])

  useEffect(() => {
    if (proposal) keepRef.current?.focus()
  }, [proposal])

  const locked = pending !== null || aiBusy
  const byId = indexStories(items ?? [])
  const visible = filterStories(items ?? [], { category: filter, showExcluded, search })
  const grouped = groupByCategory(visible, categories)
  const counts = countByCategory(items ?? [])
  const excludedCount = (items ?? []).filter((item) => item.preferences.excluded).length
  const selections = selectionsFor(shortlist, byId)
  const problem = shortlistProblem(shortlist, byId)
  const previewCurrent = preview !== null && !preview.stale && selections !== null && sameSelections(preview.selections, selections)
  const overlap = new Set(coverageOverlap(shortlist, byId))
  const intentKey = selections ? buildIntentKey(name, selections) : null
  const savedCurrent = saved !== null && intentKey !== null && saved.key === intentKey

  // ---- Curation ------------------------------------------------------------------
  function toggleCurate(item: ResearchItem) {
    setCurateOpen((open) => ({ ...open, [item.id]: !open[item.id] }))
    setCuration((drafts) => (drafts[item.id] ? drafts : { ...drafts, [item.id]: newCurationDraft(item.preferences) }))
  }

  function editCuration(item: ResearchItem, patch: Partial<CurationValues>) {
    if (locked) return
    setCuration((drafts) => {
      const base = drafts[item.id] ?? newCurationDraft(item.preferences)
      return { ...drafts, [item.id]: { ...base, values: { ...base.values, ...patch } } }
    })
    setNotice(null)
  }

  function forgetConflict(id: string) {
    setCurationConflict((conflicts) => {
      if (!(id in conflicts)) return conflicts
      const next = { ...conflicts }
      delete next[id]
      return next
    })
  }

  /** Reset: drop the edits and start again from the story's current saved version. */
  function resetCuration(item: ResearchItem) {
    setCuration((drafts) => ({ ...drafts, [item.id]: newCurationDraft(item.preferences) }))
    forgetConflict(item.id)
  }

  /**
   * Explicit save of one story's curation against the version the draft was
   * opened from (never the freshest one seen, which could paper over another
   * screen's save). On success the ranking is reloaded; the shortlist keeps
   * its ids and the preview is re-checked against the new versions.
   */
  async function saveCuration(item: ResearchItem) {
    const draft = curation[item.id]
    if (!draft || locked || !isCurationDirty(draft) || curationProblem(draft.values) !== null || curationMoved(draft, item) || item.id in curationConflict) return
    const op = begin("curate")
    setNotice(null)
    try {
      await putResearchPreferences(item.id, toPreferencesWire(draft.values, draft.base.revision))
      setCuration((drafts) => {
        const next = { ...drafts }
        delete next[item.id]
        return next
      })
      end(op)
      const reloaded = await load()
      setNotice({
        kind: reloaded ? "info" : "error",
        text: reloaded ? `Curation saved for "${item.full_title}". Ranking refreshed; your shortlist is unchanged.` : `Curation saved for "${item.full_title}", but the stories could not be reloaded. Refresh to see the new ranking.`,
      })
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setCurationConflict((conflicts) => ({ ...conflicts, [item.id]: { detail: error.detail } }))
        end(op)
        // Show what the other screen saved next to the kept edits; the draft's base stays pinned.
        await load()
      } else {
        setNotice({ kind: "error", text: describeError(error, "Saving curation") })
      }
    } finally {
      end(op)
    }
  }

  /**
   * Conflict recovery, always explicit and never a write: "reload" drops the
   * edits and shows the latest saved curation; "mine" keeps every edited
   * value on top of the latest saved version, and the user then presses
   * Save curation again.
   */
  async function recoverCuration(item: ResearchItem, mode: "reload" | "mine") {
    if (locked) return
    const list = await load()
    if (!list) {
      setNotice({ kind: "error", text: "Could not load the latest curation. Your edits are kept; try again." })
      return
    }
    const latest = list.items.find((entry) => entry.id === item.id)
    if (!latest) {
      setNotice({ kind: "error", text: `"${item.full_title}" is no longer in the active inbox. Your edits were kept but cannot be saved.` })
      return
    }
    forgetConflict(item.id)
    if (mode === "reload") {
      setCuration((drafts) => ({ ...drafts, [item.id]: newCurationDraft(latest.preferences) }))
      setNotice({ kind: "info", text: `Reloaded the latest curation of "${item.full_title}". Your edits were discarded.` })
    } else {
      setCuration((drafts) => {
        const draft = drafts[item.id]
        return { ...drafts, [item.id]: draft ? rebaseCuration(draft, latest.preferences) : newCurationDraft(latest.preferences) }
      })
      setNotice({ kind: "info", text: `Kept your edits for "${item.full_title}" on top of the latest saved curation. Press Save curation to save them.` })
    }
  }

  // ---- Shortlist -----------------------------------------------------------------
  function add(item: ResearchItem) {
    if (locked || item.preferences.excluded) return
    setShortlist((ids) => addToShortlist(ids, item.id))
    setNotice(null)
  }

  function remove(id: string) {
    if (locked) return
    setShortlist((ids) => removeFromShortlist(ids, id))
    setNotice(null)
  }

  function move(id: string, direction: -1 | 1) {
    if (locked) return
    setShortlist((ids) => moveInShortlist(ids, id, direction))
    setNotice(null)
    window.requestAnimationFrame(() => {
      const button = document.getElementById(`shortlist-${direction < 0 ? "up" : "down"}-${id}`)
      if (button instanceof HTMLButtonElement && !button.disabled) button.focus()
      else document.getElementById(`shortlist-${direction < 0 ? "down" : "up"}-${id}`)?.focus()
    })
  }

  function clearShortlist() {
    if (locked) return
    setShortlist([])
    setSuggestWarnings([])
    setNotice({ kind: "info", text: "Shortlist cleared. Nothing was saved or changed elsewhere." })
  }

  function toggleSuggestCategory(id: ResearchCategoryId) {
    setSuggestCategories((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]))
  }

  /** Ask the server for a balanced pick; it is adopted only after confirmation when a shortlist already exists. */
  async function suggest(event: FormEvent) {
    event.preventDefault()
    if (locked || !validCount(suggestCount)) return
    const op = begin("suggest")
    setNotice(null)
    try {
      const result = await proposeResearch(suggestCount, suggestCategories)
      const next: Proposal = { items: result.items, warnings: result.warnings }
      if (shortlist.length > 0) setProposal(next)
      else adoptProposal(next)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setNotice({ kind: "error", text: `No suggestion: ${error.detail}` })
      } else {
        setNotice({ kind: "error", text: describeError(error, "Suggesting a shortlist") })
      }
    } finally {
      end(op)
    }
  }

  /** A proposal from the AI panel takes the same guarded path as a local one: confirmation first when a shortlist exists. */
  function receiveProposal(next: Proposal) {
    if (shortlist.length > 0) setProposal(next)
    else adoptProposal(next)
  }

  /** Adopt a proposal: its fresh stories join the catalog (known rows updated in place, new ones appended) so every id can be previewed. */
  function adoptProposal(next: Proposal) {
    setProposal(null)
    setItems((current) => mergeStories(current ?? [], next.items))
    setShortlist(next.items.map((item) => item.id).slice(0, MAX_SHORTLIST))
    setSuggestWarnings(next.warnings)
    setNotice({ kind: "info", text: next.items.length === 0 ? "No eligible stories matched. The shortlist is now empty." : `Suggested ${topicCount(next.items.length)}. Nothing is saved until you preview and save the show.` })
  }

  // ---- Preview -------------------------------------------------------------------
  async function makePreview() {
    if (locked || selections === null || problem !== null) return
    const frozen = selections
    const op = begin("preview")
    setNotice(null)
    try {
      const result = await previewResearch(frozen)
      setPreview({ selections: frozen, result, stale: false })
      setNotice({ kind: "info", text: `Preview ready · ${topicCount(result.topics.length)} · ${formatMinutes(result.total_seconds)}. Not saved yet.` })
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setPreview((current) => (current ? { ...current, stale: true } : current))
        setNotice({ kind: "error", text: `Preview not possible: ${error.detail} Refresh the stories, check the shortlist and preview again.` })
      } else {
        setNotice({ kind: "error", text: describeError(error, "Preview") })
      }
    } finally {
      end(op)
    }
  }

  // ---- Save ----------------------------------------------------------------------
  const saveBlock: string | null =
    items === null
      ? "Waiting for the stories to load."
      : problem !== null
        ? problem
        : !validShowName(name)
          ? `Name the show (1–${MAX_SHOW_NAME} characters).`
          : preview === null
            ? "Preview the show before saving it."
            : !previewCurrent
              ? "The shortlist changed since the preview. Preview again before saving."
              : savedCurrent
                ? `Saved as "${saved.show.name}". Change the shortlist or the name to save another show.`
                : null

  async function save() {
    if (locked || selections === null || saveBlock !== null || intentKey === null || preview === null) return
    // Send exactly what was previewed (proved equal above), never a fresher snapshot.
    const frozen = preview.selections
    const trimmed = name.trim()
    if (!intentRef.current || intentRef.current.key !== intentKey) intentRef.current = { key: intentKey, requestId: newRequestId() }
    const requestId = intentRef.current.requestId
    const op = begin("save")
    setNotice(null)
    try {
      const show = await buildResearchShow(trimmed, frozen, requestId)
      setSaved({ show, key: intentKey })
      setNotice({ kind: "info", text: `Saved "${show.name}" · ${topicCount(show.topics.length)} as an independent show. Not live: open it in Saved Shows to edit or activate it.` })
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setPreview((current) => (current ? { ...current, stale: true } : current))
        setNotice({ kind: "error", text: `Not saved: ${error.detail} Your shortlist and name are kept. Refresh the stories and preview again.` })
      } else if (error instanceof ApiError) {
        setNotice({ kind: "error", text: describeError(error, "Save") })
      } else {
        setNotice({ kind: "error", text: "Save failed: the RUNDOWN API did not respond. Try again; the same request is retried, so no duplicate show is created." })
      }
    } finally {
      end(op)
    }
  }

  // ---- Render --------------------------------------------------------------------
  const totalSeconds = shortlistSeconds(shortlist, byId)
  const statusText = notice
    ? notice.text
    : pending === "load"
      ? "Loading stories…"
      : pending === "preview"
        ? "Building the preview…"
        : pending === "save"
          ? "Saving the show…"
          : shortlist.length === 0
            ? "Add stories from the list or ask for a suggestion. Nothing here touches tonight's show."
            : saveBlock ?? "Ready to save. This creates a separate saved show; nothing goes live."

  function renderStory(item: ResearchItem, rank: number) {
    const chosen = shortlist.includes(item.id)
    const excluded = item.preferences.excluded
    const open = curateOpen[item.id] === true
    const draft = curation[item.id] ?? newCurationDraft(item.preferences)
    const values = draft.values
    const dirty = isCurationDirty(draft)
    const curateProblem = curationProblem(values)
    // A refused save, or a fresher saved version seen since the draft was opened: recovery is explicit.
    const conflict = item.id in curationConflict || curationMoved(draft, item)
    const href = safeSourceHref(item.source_url)
    const full = !chosen && shortlist.length >= MAX_SHORTLIST
    return (
      <li key={item.id} className={`story-row${chosen ? " on" : ""}${excluded ? " excluded" : ""}`} data-story-id={item.id} data-testid="story-row">
        <div className="story-main">
          <span className="story-rank" aria-label={`Rank ${rank}`}>
            {rank}
          </span>
          <div className="story-body">
            <p className="story-title" data-testid="story-title">
              {item.full_title}
              {item.full_title !== item.text ? <span className="story-short"> · shown as "{item.text}"</span> : null}
            </p>
            <p className="story-meta">
              <span>{formatClock(item.duration)}</span>
              <span>score {item.score}</span>
              <span className="story-tag" data-testid="story-category">
                {labelFor(categories, item.category)} · {item.category_origin}
              </span>
              {item.preferences.priority > 0 ? <span className="story-tag">priority {item.preferences.priority}</span> : null}
              {item.preferences.pinned ? <span className="story-tag pinned">Pinned</span> : null}
              {excluded ? <span className="story-tag excluded">Excluded</span> : null}
              {item.related_count > 0 ? (
                <span className="story-tag coverage" data-testid="story-coverage">
                  Matching coverage · {item.related_count} other {item.related_count === 1 ? "story" : "stories"}
                </span>
              ) : null}
              {href ? (
                <a className="source-link" href={href} target="_blank" rel="noopener noreferrer">
                  Source
                </a>
              ) : null}
            </p>
            {item.reasons.length > 0 ? (
              <ul className="story-reasons" aria-label={`Why "${item.full_title}" ranks here`}>
                {item.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="story-actions">
            <button
              type="button"
              className={`btn small${chosen ? "" : " primary"}`}
              disabled={locked || (!chosen && (excluded || full))}
              title={excluded ? "Excluded stories can't be shortlisted; change the curation first." : full ? `The shortlist is full (${MAX_SHORTLIST}).` : undefined}
              onClick={() => (chosen ? remove(item.id) : add(item))}
            >
              {chosen ? "Remove" : "Add"}
            </button>
            <button type="button" className={`btn small${open ? " on" : ""}`} aria-expanded={open} onClick={() => toggleCurate(item)}>
              Curate
            </button>
          </div>
        </div>
        {open ? (
          <form
            className="curate"
            aria-label={`Curation for ${item.full_title}`}
            onSubmit={(event) => {
              event.preventDefault()
              void saveCuration(item)
            }}
          >
            <div className="curate-fields">
              <label className="field">
                <span>Category</span>
                <select aria-label={`Category for ${item.full_title}`} disabled={locked} value={values.category ?? ""} onChange={(event) => editCuration(item, { category: event.target.value === "" ? null : (event.target.value as ResearchCategoryId) })}>
                  <option value="">Automatic (keyword suggestion)</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Priority</span>
                <select aria-label={`Priority for ${item.full_title}`} disabled={locked} value={values.priority} onChange={(event) => editCuration(item, { priority: Number(event.target.value) as ResearchPriority })}>
                  {([0, 1, 2, 3] as ResearchPriority[]).map((priority) => (
                    <option key={priority} value={priority}>
                      {PRIORITY_LABELS[priority]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check">
                <input type="checkbox" aria-label={`Pin ${item.full_title}`} disabled={locked} checked={values.pinned} onChange={(event) => editCuration(item, { pinned: event.target.checked })} />
                Pin
              </label>
              <label className="check">
                <input type="checkbox" aria-label={`Exclude ${item.full_title}`} disabled={locked} checked={values.excluded} onChange={(event) => editCuration(item, { excluded: event.target.checked })} />
                Exclude
              </label>
            </div>
            {conflict ? (
              <div className="banner error" role="alert" data-testid="curation-conflict">
                <p>
                  <strong>Not saved.</strong> Curation for this story was saved on another screen since you opened it. Your edits are kept here; the story above shows the latest saved version. Reloading discards your edits; keeping them puts your values on the latest version so you can save them.
                </p>
                <div className="banner-actions">
                  <button type="button" className="btn" disabled={locked} onClick={() => void recoverCuration(item, "reload")}>
                    Reload latest
                  </button>
                  <button type="button" className="btn primary" disabled={locked} onClick={() => void recoverCuration(item, "mine")}>
                    Use my changes on the latest
                  </button>
                </div>
              </div>
            ) : null}
            <div className="curate-bar">
              <span className={`curate-status${curateProblem ? " error" : ""}`} aria-live="polite">
                {curateProblem ?? (dirty ? "Unsaved curation." : item.preferences.revision === 0 ? "Not curated yet; defaults shown." : "Saved curation.")}
              </span>
              <div className="curate-actions">
                <button type="button" className="btn small" disabled={locked || (!dirty && !conflict)} onClick={() => resetCuration(item)}>
                  Reset
                </button>
                <button type="submit" className="btn small primary" disabled={locked || !dirty || curateProblem !== null || conflict}>
                  {pending === "curate" ? "Saving…" : "Save curation"}
                </button>
              </div>
            </div>
          </form>
        ) : null}
      </li>
    )
  }

  return (
    <main className="main research" id="research" hidden={hidden} aria-labelledby="research-title">
      <header className="main-head">
        <div className="main-eyebrow">
          <span className="head-lbl">Shortlist active inbox stories and save them as a separate show · nothing here goes on air</span>
        </div>
        <h1 id="research-title" className="main-title">
          Research
        </h1>
      </header>

      <p className="research-intro">{RANKING_NOTE}</p>

      <div className="research-layout">
        <section className="research-stories" aria-labelledby={storiesTitleId}>
          <div className="research-tools">
            <h2 id={storiesTitleId}>Stories</h2>
            <div className="research-tools-row">
              <div className="seg research-filter" role="group" aria-label="Category filter">
                <button type="button" className={`seg-btn${filter === "all" ? " on" : ""}`} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
                  All · {items?.length ?? 0}
                </button>
                {categories.map((category) => (
                  <button key={category.id} type="button" className={`seg-btn${filter === category.id ? " on" : ""}`} aria-pressed={filter === category.id} onClick={() => setFilter(category.id)}>
                    {category.label} · {counts.get(category.id) ?? 0}
                  </button>
                ))}
              </div>
            </div>
            <div className="research-tools-row">
              <label className="check">
                <input type="checkbox" checked={showExcluded} onChange={(event) => setShowExcluded(event.target.checked)} />
                Show excluded{excludedCount > 0 ? ` (${excludedCount})` : ""}
              </label>
              <label className="field grow" htmlFor={searchId}>
                <span className="visually-hidden">Search stories</span>
                <input id={searchId} type="search" placeholder="Search titles and context" value={search} onChange={(event) => setSearch(event.target.value)} />
              </label>
              <button type="button" className="btn small" disabled={locked} onClick={() => void load()}>
                {pending === "load" ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>

          {listError ? (
            <div className="banner error" role="alert">
              <p>{listError}</p>
              <div className="banner-actions">
                <button type="button" className="btn" disabled={locked} onClick={() => void load()}>
                  Retry
                </button>
              </div>
            </div>
          ) : null}

          {items === null ? (
            <div className="empty">{listError ? "Stories could not be loaded." : "Loading stories…"}</div>
          ) : items.length === 0 ? (
            <div className="empty">No active stories. Capture ideas in the Inbox or import a feed first.</div>
          ) : visible.length === 0 ? (
            <div className="empty">No stories match this filter.</div>
          ) : (
            grouped.map((group) => (
              <section key={group.id} className="story-group" aria-label={group.label} data-testid="story-group">
                <h3 className="story-group-title">
                  {group.label} <span className="story-group-count">· {storyCount(group.items.length)}</span>
                </h3>
                <ul className="story-list">{group.items.map((item) => renderStory(item, (items?.indexOf(item) ?? 0) + 1))}</ul>
              </section>
            ))
          )}
        </section>

        <section className="research-composer" aria-labelledby={composerTitleId} aria-busy={locked || undefined}>
          <h2 id={composerTitleId}>Shortlist</h2>

          <form className="suggest" aria-label="Suggest a shortlist" onSubmit={suggest}>
            <div className="suggest-fields">
              <label className="field seconds" htmlFor={countId}>
                <span>How many</span>
                <input id={countId} type="number" inputMode="numeric" min={MIN_SUGGEST} max={MAX_SUGGEST} step={1} aria-invalid={validCount(suggestCount) ? undefined : true} disabled={locked} value={Number.isNaN(suggestCount) ? "" : suggestCount} onChange={(event) => setSuggestCount(event.target.valueAsNumber)} />
              </label>
              <fieldset className="suggest-categories">
                <legend className="field-label">Draw from</legend>
                {categories.map((category) => (
                  <label key={category.id} className="check">
                    <input type="checkbox" aria-label={`Draw from ${category.label}`} disabled={locked} checked={suggestCategories.includes(category.id)} onChange={() => toggleSuggestCategory(category.id)} />
                    {category.label}
                  </label>
                ))}
                <span className="notes-hint">{suggestCategories.length === 0 ? "None ticked: all categories." : `${suggestCategories.length} ticked.`}</span>
              </fieldset>
            </div>
            <div className="suggest-actions">
              <button type="submit" className="btn" disabled={locked || items === null || !validCount(suggestCount)}>
                {pending === "suggest" ? "Suggesting…" : "Suggest shortlist"}
              </button>
              <button type="button" className="btn" disabled={locked || shortlist.length === 0} onClick={clearShortlist}>
                Clear shortlist
              </button>
              <span className="notes-hint">Balanced by category, pins first, one per matching-coverage group. Replaces the shortlist only after you confirm.</span>
            </div>
          </form>

          <ResearchAnalysis hidden={hidden} items={items} categories={categories} shortlist={shortlist} locked={locked} onBusy={setAiBusy} onRefreshStories={load} onProposal={receiveProposal} />

          {suggestWarnings.length > 0 ? (
            <ul className="run-warnings" aria-label="Suggestion warnings">
              {suggestWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}

          {shortlist.length === 0 ? (
            <div className="empty">No stories shortlisted yet.</div>
          ) : (
            <ol className="shortlist" aria-label="Shortlist">
              {shortlist.map((id, index) => {
                const item = byId.get(id)
                const title = item?.full_title ?? "Story no longer in the inbox"
                return (
                  <li key={id} className={`shortlist-row${item === undefined || item.preferences.excluded ? " invalid" : ""}`} data-story-id={id} data-testid="shortlist-row">
                    <span className="tnum" aria-hidden="true">
                      {index + 1}
                    </span>
                    <div className="shortlist-body">
                      <span className="shortlist-title" data-testid="shortlist-title">
                        {title}
                      </span>
                      <span className="story-meta">
                        {item ? <span>{formatClock(item.duration)}</span> : null}
                        {item ? <span>{labelFor(categories, item.category)}</span> : null}
                        {item?.preferences.pinned ? <span className="story-tag pinned">Pinned</span> : null}
                        {item?.preferences.excluded ? <span className="story-tag excluded">Excluded · remove or re-curate</span> : null}
                        {item === undefined ? <span className="story-tag excluded">Missing · remove or refresh</span> : null}
                        {overlap.has(id) ? <span className="story-tag coverage">Matching coverage with another pick</span> : null}
                      </span>
                    </div>
                    <div className="tactions">
                      <button type="button" className="icon-btn" id={`shortlist-up-${id}`} aria-label={`Move shortlist item ${index + 1} up`} disabled={locked || index === 0} onClick={() => move(id, -1)}>
                        ↑
                      </button>
                      <button type="button" className="icon-btn" id={`shortlist-down-${id}`} aria-label={`Move shortlist item ${index + 1} down`} disabled={locked || index === shortlist.length - 1} onClick={() => move(id, 1)}>
                        ↓
                      </button>
                      <button type="button" className="icon-btn danger" aria-label={`Remove shortlist item ${index + 1}`} disabled={locked} onClick={() => remove(id)}>
                        ×
                      </button>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
          <p className="head-lbl shortlist-total" data-testid="shortlist-total">
            {storyCount(shortlist.length)} · {formatMinutes(totalSeconds)} · {MAX_SHORTLIST - shortlist.length} slots left
          </p>

          <div className="compose-fields">
            <label className="field grow" htmlFor={nameId}>
              <span>Name for the saved show</span>
              <input id={nameId} className="show-name" maxLength={MAX_SHOW_NAME} placeholder="Name the saved show" aria-invalid={name.length > 0 && !validShowName(name) ? true : undefined} disabled={locked} value={name} onChange={(event) => setName(event.target.value)} />
            </label>
          </div>

          <div className="compose-actions">
            <button type="button" className="btn" disabled={locked || selections === null || problem !== null} onClick={() => void makePreview()}>
              {pending === "preview" ? "Previewing…" : "Preview show"}
            </button>
            <button type="button" className="btn primary" disabled={locked || saveBlock !== null} title={saveBlock ?? undefined} onClick={() => void save()}>
              {pending === "save" ? "Saving…" : "Save as show"}
            </button>
          </div>

          <p className={`publish-status compose-status${notice?.kind === "error" ? " error" : ""}`} aria-live="polite" data-testid="research-status">
            {statusText}
          </p>

          {preview ? (
            <section className={`preview${previewCurrent ? "" : " stale"}`} aria-label="Show preview" data-testid="preview" data-current={previewCurrent ? "true" : "false"}>
              <div className="preview-head">
                <h3>Preview</h3>
                <span className="head-lbl">
                  {topicCount(preview.result.topics.length)} · {formatMinutes(preview.result.total_seconds)} · {formatClock(preview.result.total_seconds)} total
                </span>
              </div>
              {!previewCurrent ? (
                <div className="banner warn" role="status">
                  <p>{preview.stale ? "The server rejected a save against this preview: the stories changed. " : "The shortlist changed since this preview was made. "}Preview again before saving.</p>
                </div>
              ) : null}
              <p className="notes-hint">{PREVIEW_NOTE} Titles, durations and context can be edited in Saved Shows after saving.</p>
              {preview.result.warnings.length > 0 ? (
                <ul className="run-warnings" aria-label="Preview notes">
                  {preview.result.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
              <ol className="preview-list">
                {preview.result.topics.map((topic, index) => (
                  <li key={`${index}-${topic.text}`} className="preview-row" data-testid="preview-row">
                    <div className="preview-row-head">
                      <span className="tnum" aria-hidden="true">
                        {index + 1}
                      </span>
                      <span className="preview-title">{topic.text}</span>
                      <span className="preview-duration">{formatClock(topic.duration)}</span>
                    </div>
                    {topic.notes.length > 0 ? <pre className="preview-notes">{topic.notes}</pre> : <p className="notes-hint">No saved context.</p>}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {saved ? (
            <section className="banner success saved-card" role="status" aria-label="Saved show" data-testid="saved-card" data-show-id={saved.show.id}>
              <p>
                <strong>Saved "{saved.show.name}"</strong> · {topicCount(saved.show.topics.length)} · {formatMinutes(saved.show.topics.reduce((sum, topic) => sum + topic.duration, 0))}. It is an independent saved show; nothing is live.
              </p>
              <div className="banner-actions">
                <button type="button" className="btn primary" disabled={locked} onClick={() => onOpenShow(saved.show)}>
                  Open saved show
                </button>
              </div>
            </section>
          ) : null}
        </section>
      </div>

      {proposal ? (
        <div className="modal-backdrop" role="presentation" onKeyDown={(event) => event.key === "Escape" && setProposal(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby={dialogTitleId}>
            <h2 id={dialogTitleId}>Replace the shortlist?</h2>
            <p>
              The suggestion has {storyCount(proposal.items.length)}. Adopting it replaces your current {storyCount(shortlist.length)}; nothing is saved either way.
            </p>
            {proposal.warnings.length > 0 ? (
              <ul className="run-warnings">
                {proposal.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            <div className="banner-actions">
              <button type="button" className="btn primary" ref={keepRef} onClick={() => setProposal(null)}>
                Keep my shortlist
              </button>
              <button type="button" className="btn" onClick={() => adoptProposal(proposal)}>
                Replace shortlist
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}
