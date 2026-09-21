// HTTP client for the RUNDOWN API. Same-origin paths; Vite proxies them in dev
// and FastAPI serves the built app itself in production.

export type Topic = {
  text: string
  duration: number
}

/**
 * Server-owned topic: the id is stable across edits and reorders. `notes` is
 * free-form producer context (background, talking points, source URLs) that
 * only the control room shows; it is always a string, "" when none.
 */
export type ShowTopic = Topic & { id: string; notes: string }

export type ShowState = {
  revision: number
  topics: ShowTopic[]
  current_topic_id: string | null
  remaining_seconds: number
  paused: boolean
  server_time: string
}

/**
 * Wire shape for PUT /rundown/schedule. New entries omit `id`. `notes` is sent
 * explicitly and verbatim (newlines and URLs untouched); "" clears it.
 */
export type ScheduleEntry = Topic & { id?: string; notes: string }

export type ControlAction = "play" | "pause" | "next" | "previous" | "reset" | "jump"

export class ApiError extends Error {
  status: number
  detail: string
  constructor(status: number, detail: string) {
    super(`${status}: ${detail}`)
    this.name = "ApiError"
    this.status = status
    this.detail = detail
  }
}

async function detailOf(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (body && typeof body === "object" && "detail" in body) {
      const detail = (body as { detail: unknown }).detail
      if (typeof detail === "string") return detail
      if (Array.isArray(detail)) {
        return detail
          .map((item) => (item && typeof item === "object" && "msg" in item ? String((item as { msg: unknown }).msg) : JSON.stringify(item)))
          .join("; ")
      }
      return JSON.stringify(detail)
    }
  } catch {
    // fall through to a generic message
  }
  return response.statusText || `HTTP ${response.status}`
}

async function expectJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new ApiError(response.status, await detailOf(response))
  return response.json() as Promise<T>
}

/**
 * The contract guarantees `notes` on every topic; a server built before it
 * (or a stub) may still omit the field. Normalise so the rest of the app can
 * rely on a string.
 */
function normalizeState(state: ShowState): ShowState {
  return {
    ...state,
    topics: state.topics.map((topic) => ({ ...topic, notes: typeof topic.notes === "string" ? topic.notes : "" })),
  }
}

async function expectState(response: Response): Promise<ShowState> {
  return normalizeState(await expectJson<ShowState>(response))
}

export async function getState(signal?: AbortSignal): Promise<ShowState> {
  const r = await fetch("/rundown/state", { cache: "no-store", signal })
  return expectState(r)
}

export async function putSchedule(revision: number, topics: ScheduleEntry[]): Promise<ShowState> {
  const r = await fetch("/rundown/schedule", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision, topics }),
  })
  return expectState(r)
}

export async function control(revision: number, action: ControlAction, topicId?: string): Promise<ShowState> {
  const payload: { revision: number; action: ControlAction; topic_id?: string } = { revision, action }
  if (topicId !== undefined) payload.topic_id = topicId
  const r = await fetch("/rundown/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  return expectState(r)
}

// ---- Saved shows (frozen contract) -----------------------------------------
// A saved show is a named topic list prepared separately from the live clock.
// Topic ids are local to their saved show and never shared with the live show.

export type SavedShowSummary = {
  id: string
  name: string
  revision: number
  topic_count: number
  total_seconds: number
  created_at: string
  updated_at: string
}

export type SavedShowTopic = { id: string; text: string; duration: number; notes: string }

export type SavedShow = {
  id: string
  name: string
  revision: number
  topics: SavedShowTopic[]
  created_at: string
  updated_at: string
}

/** Create-topic input: never carries an id. */
export type SavedTopicCreate = { text: string; duration: number; notes?: string }
/** Update-topic input: an existing id keeps the row, null/omitted makes a new row. */
export type SavedTopicUpdate = SavedTopicCreate & { id?: string | null }

function normalizeShow(show: SavedShow): SavedShow {
  return { ...show, topics: show.topics.map((topic) => ({ ...topic, notes: typeof topic.notes === "string" ? topic.notes : "" })) }
}

async function expectShow(response: Response): Promise<SavedShow> {
  return normalizeShow(await expectJson<SavedShow>(response))
}

function jsonInit(method: string, payload: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }
}

export async function listShows(signal?: AbortSignal): Promise<SavedShowSummary[]> {
  const r = await fetch("/shows", { cache: "no-store", signal })
  const body = await expectJson<{ shows: SavedShowSummary[] }>(r)
  return body.shows
}

export async function getShow(id: string, signal?: AbortSignal): Promise<SavedShow> {
  const r = await fetch(`/shows/${encodeURIComponent(id)}`, { cache: "no-store", signal })
  return expectShow(r)
}

export async function createShow(name: string, topics: SavedTopicCreate[]): Promise<SavedShow> {
  const r = await fetch("/shows", jsonInit("POST", { name, topics }))
  return expectShow(r)
}

export async function updateShow(id: string, revision: number, name: string, topics: SavedTopicUpdate[]): Promise<SavedShow> {
  const r = await fetch(`/shows/${encodeURIComponent(id)}`, jsonInit("PUT", { revision, name, topics }))
  return expectShow(r)
}

export async function createShowFromLive(name: string, liveRevision: number): Promise<SavedShow> {
  const r = await fetch("/shows/from-live", jsonInit("POST", { name, live_revision: liveRevision }))
  return expectShow(r)
}

export async function duplicateShow(id: string, revision: number, name: string): Promise<SavedShow> {
  const r = await fetch(`/shows/${encodeURIComponent(id)}/duplicate`, jsonInit("POST", { revision, name }))
  return expectShow(r)
}

/** Replaces the live topic list with the saved show; returns the new live state (first topic cued, paused). */
export async function activateShow(id: string, revision: number, liveRevision: number): Promise<ShowState> {
  const r = await fetch(`/shows/${encodeURIComponent(id)}/activate`, jsonInit("POST", { revision, live_revision: liveRevision }))
  return expectState(r)
}

// ---- Legacy endpoints (kept for compatibility with the v1 bridge) ----------

export type TopicsResponse = {
  topics: Topic[]
  hash: string
}

export type PushResponse = {
  ok: boolean
  rundown_id: number
  topics_count: number
  obs_refreshed: boolean
}

export async function getTopics(): Promise<TopicsResponse> {
  const r = await fetch("/rundown/topics", { cache: "no-store" })
  return expectJson<TopicsResponse>(r)
}

export async function pushToObs(
  topics: Topic[],
  opts: { refresh_obs?: boolean; notes?: string } = {},
): Promise<PushResponse> {
  const r = await fetch("/rundown/push-to-obs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topics, refresh_obs: opts.refresh_obs ?? true, notes: opts.notes }),
  })
  return expectJson<PushResponse>(r)
}

export async function health(): Promise<{ status: string }> {
  const r = await fetch("/health")
  return expectJson<{ status: string }>(r)
}

// ---- Topic inbox (frozen contract) -----------------------------------------
// An inbox item is a captured idea: a title, a default length, free-form
// context and an optional source URL. `topic` is the server's copy-ready
// projection (notes plus a trailing "Source: <url>" line when a URL is set);
// pickers copy it verbatim and never recompose it locally.

export type InboxTopic = { text: string; duration: number; notes: string }

/** Where an imported idea came from: an RSS feed, or a saved YouTube/Reddit discovery search. */
export type InboxSourceKind = "rss" | "youtube" | "reddit"

/**
 * Read-only provenance of an idea an importer created. `body_text` is the
 * retained plain text (RSS entry text, a YouTube video description or a Reddit
 * post body; tags already stripped by the server; rendered as text, never as
 * HTML). `truncated` says the server capped the title or body. For a
 * discovery search, `feed_id`/`feed_name` are the saved search's id and name.
 * Manual ideas carry `source: null`.
 */
export type InboxSource = {
  kind: InboxSourceKind
  feed_id: string
  feed_name: string
  original_title: string
  body_text: string
  published_at: string | null
  imported_at: string
  truncated: boolean
}

export type InboxItem = {
  id: string
  revision: number
  text: string
  duration: number
  notes: string
  source_url: string
  archived: boolean
  created_at: string
  updated_at: string
  topic: InboxTopic
  source: InboxSource | null
}

/** Create input: no id, no archived flag. `notes`/`source_url` may be omitted for "". */
export type InboxCreate = { text: string; duration: number; notes?: string; source_url?: string }
/** Full edit: every field is sent; `revision` guards against stale writes (409). */
export type InboxUpdate = { revision: number; text: string; duration: number; notes: string; source_url: string }

const SOURCE_KINDS: readonly InboxSourceKind[] = ["rss", "youtube", "reddit"]

/** Only a well-formed provenance block of a known kind is kept; anything else (absent, null, an unknown kind) reads as a manual idea. */
function normalizeSource(raw: unknown): InboxSource | null {
  if (!raw || typeof raw !== "object") return null
  const source = raw as Record<string, unknown>
  const kind = SOURCE_KINDS.find((entry) => entry === source.kind)
  if (kind === undefined || typeof source.feed_id !== "string" || typeof source.original_title !== "string") return null
  return {
    kind,
    feed_id: source.feed_id,
    feed_name: typeof source.feed_name === "string" ? source.feed_name : "",
    original_title: source.original_title,
    body_text: typeof source.body_text === "string" ? source.body_text : "",
    published_at: typeof source.published_at === "string" ? source.published_at : null,
    imported_at: typeof source.imported_at === "string" ? source.imported_at : "",
    truncated: source.truncated === true,
  }
}

function normalizeInboxItem(item: InboxItem): InboxItem {
  const notes = typeof item.notes === "string" ? item.notes : ""
  const source_url = typeof item.source_url === "string" ? item.source_url : ""
  const topic = item.topic && typeof item.topic === "object" ? item.topic : { text: item.text, duration: item.duration, notes }
  return {
    ...item,
    notes,
    source_url,
    archived: item.archived === true,
    topic: { ...topic, notes: typeof topic.notes === "string" ? topic.notes : "" },
    source: normalizeSource(item.source),
  }
}

async function expectInboxItem(response: Response): Promise<InboxItem> {
  return normalizeInboxItem(await expectJson<InboxItem>(response))
}

/** Active ideas by default; `archived: true` lists only archived ones. Sorted newest-updated first by the server. */
export async function listInbox(archived = false, signal?: AbortSignal): Promise<InboxItem[]> {
  const r = await fetch(`/inbox?archived=${archived ? "true" : "false"}`, { cache: "no-store", signal })
  const body = await expectJson<{ items: InboxItem[] }>(r)
  return body.items.map(normalizeInboxItem)
}

export async function getInboxItem(id: string, signal?: AbortSignal): Promise<InboxItem> {
  const r = await fetch(`/inbox/${encodeURIComponent(id)}`, { cache: "no-store", signal })
  return expectInboxItem(r)
}

export async function createInboxItem(input: InboxCreate): Promise<InboxItem> {
  const r = await fetch("/inbox", jsonInit("POST", input))
  return expectInboxItem(r)
}

export async function updateInboxItem(id: string, input: InboxUpdate): Promise<InboxItem> {
  const r = await fetch(`/inbox/${encodeURIComponent(id)}`, jsonInit("PUT", input))
  return expectInboxItem(r)
}

/** Archive (`archived: true`) or restore (`archived: false`). Copies already made from the item are untouched. */
export async function setInboxArchived(id: string, revision: number, archived: boolean): Promise<InboxItem> {
  const r = await fetch(`/inbox/${encodeURIComponent(id)}/archive`, jsonInit("POST", { revision, archived }))
  return expectInboxItem(r)
}

// ---- RSS sources (frozen contract) ------------------------------------------
// A feed is a configured RSS/Atom address. Nothing is fetched when a feed is
// created or edited; only "Import now" makes the server read the feed, and it
// answers with the finished run (status "failed" is a normal 200 answer, not
// an HTTP error). The URL never changes after creation.

export type ImportRunStatus = "running" | "succeeded" | "failed"

export type ImportRunItem = { title: string; reason: string }

export type ImportRun = {
  id: string
  feed_id: string
  status: ImportRunStatus
  started_at: string
  finished_at: string | null
  created: number
  duplicates: number
  skipped: number
  examined: number
  error: string | null
  warnings: string[]
  items: ImportRunItem[]
}

export type Feed = {
  id: string
  revision: number
  name: string
  url: string
  default_duration: number
  enabled: boolean
  created_at: string
  updated_at: string
  /** False while disabled or while an import lease is active (here or on another screen). */
  can_import: boolean
  latest_run: ImportRun | null
}

/** Create input: name, address and default length only; new feeds start enabled. */
export type FeedCreate = { name: string; url: string; default_duration: number }
/** Edit input: never carries the URL; `revision` guards against stale writes (409). */
export type FeedUpdate = { revision: number; name: string; default_duration: number; enabled: boolean }

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : []
}

function normalizeRun(run: ImportRun): ImportRun {
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)
  const items = Array.isArray(run.items)
    ? run.items
        .filter((entry): entry is ImportRunItem => !!entry && typeof entry === "object")
        .map((entry) => ({ title: typeof entry.title === "string" ? entry.title : "", reason: typeof entry.reason === "string" ? entry.reason : "" }))
    : []
  const status: ImportRunStatus = run.status === "running" || run.status === "succeeded" ? run.status : "failed"
  return {
    ...run,
    status,
    finished_at: typeof run.finished_at === "string" ? run.finished_at : null,
    created: count(run.created),
    duplicates: count(run.duplicates),
    skipped: count(run.skipped),
    examined: count(run.examined),
    error: typeof run.error === "string" ? run.error : null,
    warnings: stringList(run.warnings),
    items,
  }
}

function normalizeFeed(feed: Feed): Feed {
  return {
    ...feed,
    name: typeof feed.name === "string" ? feed.name : "",
    url: typeof feed.url === "string" ? feed.url : "",
    enabled: feed.enabled === true,
    can_import: feed.can_import === true,
    latest_run: feed.latest_run && typeof feed.latest_run === "object" ? normalizeRun(feed.latest_run) : null,
  }
}

async function expectFeed(response: Response): Promise<Feed> {
  return normalizeFeed(await expectJson<Feed>(response))
}

export async function listFeeds(signal?: AbortSignal): Promise<Feed[]> {
  const r = await fetch("/feeds", { cache: "no-store", signal })
  const body = await expectJson<{ feeds: Feed[] }>(r)
  return (Array.isArray(body.feeds) ? body.feeds : []).map(normalizeFeed)
}

export async function getFeed(id: string, signal?: AbortSignal): Promise<Feed> {
  const r = await fetch(`/feeds/${encodeURIComponent(id)}`, { cache: "no-store", signal })
  return expectFeed(r)
}

export async function createFeed(input: FeedCreate): Promise<Feed> {
  const r = await fetch("/feeds", jsonInit("POST", input))
  return expectFeed(r)
}

export async function updateFeed(id: string, input: FeedUpdate): Promise<Feed> {
  const r = await fetch(`/feeds/${encodeURIComponent(id)}`, jsonInit("PUT", input))
  return expectFeed(r)
}

/**
 * Explicit import. Resolves with the finished run once the server has fetched
 * the feed (up to ~20 s); a failed fetch or parse is a 200 with status
 * "failed". Disabled, already running or stale revision reject with 409.
 */
export async function importFeed(id: string, revision: number): Promise<ImportRun> {
  const r = await fetch(`/feeds/${encodeURIComponent(id)}/import`, jsonInit("POST", { revision }))
  return normalizeRun(await expectJson<ImportRun>(r))
}

/** Last 20 runs, newest first. */
export async function listFeedRuns(id: string, signal?: AbortSignal): Promise<ImportRun[]> {
  const r = await fetch(`/feeds/${encodeURIComponent(id)}/runs`, { cache: "no-store", signal })
  const body = await expectJson<{ runs: ImportRun[] }>(r)
  return (Array.isArray(body.runs) ? body.runs : []).map(normalizeRun)
}

// ---- Feed schedules (frozen contract) -----------------------------------------
// One automatic-import schedule per feed, kept apart from the feed's own
// revision. GET returns the current schedule (a never-configured feed reads as
// revision 0, off, 60 minutes). PUT is a full, strict payload guarded by the
// schedule revision: stale writes and writes during an active import 409, an
// unknown field 422, an unknown feed 404. The server runs due imports on its
// own while the API process is up; the browser only reads the outcome.

export type FeedSchedule = {
  feed_id: string
  revision: number
  enabled: boolean
  interval_minutes: number
  /** When the next automatic import is due (UTC ISO), null while off or paused. */
  next_run_at: string | null
  /** The latest automatic run only; manual imports never appear here. */
  last_run: ImportRun | null
  /** True when the schedule, the feed and the server's scheduler are all enabled. */
  effective: boolean
  /** Why the schedule is not effective, or null. */
  reason: string | null
  server_time: string
}

/** Full strict payload for PUT /feeds/{id}/schedule. */
export type FeedScheduleUpdate = { revision: number; enabled: boolean; interval_minutes: number }

function normalizeSchedule(schedule: FeedSchedule): FeedSchedule {
  return {
    ...schedule,
    revision: typeof schedule.revision === "number" && Number.isFinite(schedule.revision) ? schedule.revision : 0,
    enabled: schedule.enabled === true,
    interval_minutes: typeof schedule.interval_minutes === "number" && Number.isFinite(schedule.interval_minutes) ? schedule.interval_minutes : 60,
    next_run_at: typeof schedule.next_run_at === "string" ? schedule.next_run_at : null,
    last_run: schedule.last_run && typeof schedule.last_run === "object" ? normalizeRun(schedule.last_run) : null,
    effective: schedule.effective === true,
    reason: typeof schedule.reason === "string" ? schedule.reason : null,
    server_time: typeof schedule.server_time === "string" ? schedule.server_time : "",
  }
}

export async function getFeedSchedule(id: string, signal?: AbortSignal): Promise<FeedSchedule> {
  const r = await fetch(`/feeds/${encodeURIComponent(id)}/schedule`, { cache: "no-store", signal })
  return normalizeSchedule(await expectJson<FeedSchedule>(r))
}

export async function putFeedSchedule(id: string, input: FeedScheduleUpdate): Promise<FeedSchedule> {
  const r = await fetch(`/feeds/${encodeURIComponent(id)}/schedule`, jsonInit("PUT", input))
  return normalizeSchedule(await expectJson<FeedSchedule>(r))
}

// ---- Assisted preparation (frozen contract) ---------------------------------
// A preparation run asks a configured provider for a summary and talking
// points grounded in the saved title, context and retained source text of one
// inbox idea. Generation is always an explicit user action: nothing here is
// called automatically, and a run never modifies the idea itself. Keys stay in
// the API process environment; the browser only ever sees provider/model names.

export type PreparationMode = "anthropic" | "fixture"

export type PreparationConfig = {
  enabled: boolean
  ready: boolean
  provider: string
  model: string
  daily_limit: number
  used_today: number
  remaining_today: number
  max_input_chars: number
  max_output_tokens: number
  mode: PreparationMode
  /** Why generation is unavailable (not configured, no key, cap reached…), or null when ready. */
  reason: string | null
}

export type PreparationRunStatus = "running" | "succeeded" | "failed" | "interrupted"

export type PreparationRun = {
  id: string
  topic_id: string
  /** Idea revision the input was taken from. */
  revision: number
  status: PreparationRunStatus
  started_at: string
  finished_at: string | null
  model: string
  summary: string | null
  talking_points: string[]
  input_truncated: boolean
  input_tokens: number | null
  output_tokens: number | null
  error: string | null
  /** True once the idea's revision moved on (any save, including appending this result). Never apply a stale result. */
  stale: boolean
}

export type PreparationView = {
  topic_id: string
  /** Current idea revision; the one to send with a generate request. */
  revision: number
  /** The exact plain text the server would send, already capped at `settings.max_input_chars`. */
  input_text: string
  input_truncated: boolean
  can_generate: boolean
  reason: string | null
  latest_run: PreparationRun | null
  settings: PreparationConfig
}

export type PreparationRequest = { revision: number; request_id: string; consent: true }

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function normalizePreparationConfig(raw: PreparationConfig): PreparationConfig {
  return {
    enabled: raw.enabled === true,
    ready: raw.ready === true,
    provider: typeof raw.provider === "string" ? raw.provider : "",
    model: typeof raw.model === "string" ? raw.model : "",
    daily_limit: finiteNumber(raw.daily_limit, 0),
    used_today: finiteNumber(raw.used_today, 0),
    remaining_today: finiteNumber(raw.remaining_today, 0),
    max_input_chars: finiteNumber(raw.max_input_chars, 12000),
    max_output_tokens: finiteNumber(raw.max_output_tokens, 1200),
    mode: raw.mode === "anthropic" ? "anthropic" : "fixture",
    reason: nullableString(raw.reason),
  }
}

function normalizePreparationRun(raw: PreparationRun): PreparationRun {
  const status: PreparationRunStatus = raw.status === "running" || raw.status === "succeeded" || raw.status === "interrupted" ? raw.status : "failed"
  return {
    ...raw,
    id: String(raw.id),
    topic_id: String(raw.topic_id),
    revision: finiteNumber(raw.revision, 0),
    status,
    started_at: typeof raw.started_at === "string" ? raw.started_at : "",
    finished_at: nullableString(raw.finished_at),
    model: typeof raw.model === "string" ? raw.model : "",
    summary: nullableString(raw.summary),
    talking_points: stringList(raw.talking_points),
    input_truncated: raw.input_truncated === true,
    input_tokens: typeof raw.input_tokens === "number" ? raw.input_tokens : null,
    output_tokens: typeof raw.output_tokens === "number" ? raw.output_tokens : null,
    error: nullableString(raw.error),
    stale: raw.stale === true,
  }
}

function normalizePreparationView(raw: PreparationView): PreparationView {
  return {
    topic_id: String(raw.topic_id),
    revision: finiteNumber(raw.revision, 0),
    input_text: typeof raw.input_text === "string" ? raw.input_text : "",
    input_truncated: raw.input_truncated === true,
    can_generate: raw.can_generate === true,
    reason: nullableString(raw.reason),
    latest_run: raw.latest_run && typeof raw.latest_run === "object" ? normalizePreparationRun(raw.latest_run) : null,
    settings: normalizePreparationConfig((raw.settings ?? {}) as PreparationConfig),
  }
}

export async function getPreparationStatus(signal?: AbortSignal): Promise<PreparationConfig> {
  const r = await fetch("/preparation/status", { cache: "no-store", signal })
  return normalizePreparationConfig(await expectJson<PreparationConfig>(r))
}

/** Readiness, exact input preview and the latest retained run for one saved idea (404 when it does not exist). */
export async function getPreparationView(topicId: string, signal?: AbortSignal): Promise<PreparationView> {
  const r = await fetch(`/preparation/topics/${encodeURIComponent(topicId)}`, { cache: "no-store", signal })
  return normalizePreparationView(await expectJson<PreparationView>(r))
}

/**
 * Explicit generation. Resolves with the finished run; a provider failure is a
 * normal 200 answer with status "failed" (never retried here). The same
 * `request_id` on the same idea revision returns the existing run without a
 * second provider call, which is how an ambiguous (lost) response is resolved.
 * Disabled 503, no input 422, archived/stale/overlap 409, daily cap 429.
 */
export async function generatePreparation(topicId: string, input: PreparationRequest): Promise<PreparationRun> {
  const r = await fetch(`/preparation/topics/${encodeURIComponent(topicId)}/generate`, jsonInit("POST", input))
  return normalizePreparationRun(await expectJson<PreparationRun>(r))
}

// ---- Post-show review (frozen contract) -------------------------------------
// A review targets one topic of one published version (a snapshot taken by
// "Publish schedule", not a proven completed stream). Rating, note and the
// hand-entered actual duration are saved together as one explicit feedback
// revision; nothing here is timed, published, copied or scored automatically.

export type ReviewRating = -1 | 0 | 1

export type ReviewVersion = {
  id: number
  published_at: string
  topic_count: number
  planned_seconds: number
  reviewed_count: number
}

export type ReviewTopic = {
  id: number
  text: string
  planned_seconds: number
  /** Private producer context, read-only here and never sent back. */
  context: string
  /** 0 while never reviewed, otherwise the latest feedback id (not necessarily +1 per save). */
  revision: number
  rating: ReviewRating
  note: string
  /** Manually recorded seconds; null (never 0) means unrecorded. */
  actual_seconds: number | null
  /** actual - planned, null while unrecorded. */
  delta_seconds: number | null
  updated_at: string | null
}

export type ReviewDetail = { id: number; published_at: string; topics: ReviewTopic[] }

export type ReviewPage = { versions: ReviewVersion[]; next_before_id: number | null }

/** Exact full payload for PUT /reviews/{version_id}/topics/{item_id}; anything extra is a 422. */
export type ReviewUpdate = { revision: number; rating: ReviewRating; note: string; actual_seconds: number | null }

function normalizeRating(value: unknown): ReviewRating {
  return value === 1 || value === -1 ? value : 0
}

function nullableInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null
}

function normalizeReviewVersion(raw: ReviewVersion): ReviewVersion {
  return {
    id: finiteNumber(raw.id, 0),
    published_at: typeof raw.published_at === "string" ? raw.published_at : "",
    topic_count: finiteNumber(raw.topic_count, 0),
    planned_seconds: finiteNumber(raw.planned_seconds, 0),
    reviewed_count: finiteNumber(raw.reviewed_count, 0),
  }
}

function normalizeReviewTopic(raw: ReviewTopic): ReviewTopic {
  return {
    id: finiteNumber(raw.id, 0),
    text: typeof raw.text === "string" ? raw.text : "",
    planned_seconds: finiteNumber(raw.planned_seconds, 0),
    context: typeof raw.context === "string" ? raw.context : "",
    revision: finiteNumber(raw.revision, 0),
    rating: normalizeRating(raw.rating),
    note: typeof raw.note === "string" ? raw.note : "",
    actual_seconds: nullableInt(raw.actual_seconds),
    delta_seconds: nullableInt(raw.delta_seconds),
    updated_at: nullableString(raw.updated_at),
  }
}

function normalizeReviewDetail(raw: ReviewDetail): ReviewDetail {
  return {
    id: finiteNumber(raw.id, 0),
    published_at: typeof raw.published_at === "string" ? raw.published_at : "",
    topics: (Array.isArray(raw.topics) ? raw.topics : []).map(normalizeReviewTopic),
  }
}

/** Newest first. `beforeId` is exclusive: pass the previous page's `next_before_id` to load older versions. */
export async function listReviews(options: { limit?: number; beforeId?: number | null } = {}, signal?: AbortSignal): Promise<ReviewPage> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 20) })
  if (options.beforeId !== undefined && options.beforeId !== null) params.set("before_id", String(options.beforeId))
  const r = await fetch(`/reviews?${params.toString()}`, { cache: "no-store", signal })
  const body = await expectJson<ReviewPage>(r)
  return {
    versions: (Array.isArray(body.versions) ? body.versions : []).map(normalizeReviewVersion),
    next_before_id: nullableInt(body.next_before_id),
  }
}

export async function getReview(versionId: number, signal?: AbortSignal): Promise<ReviewDetail> {
  const r = await fetch(`/reviews/${encodeURIComponent(String(versionId))}`, { cache: "no-store", signal })
  return normalizeReviewDetail(await expectJson<ReviewDetail>(r))
}

/** Explicit save of one topic's review. Stale revision 409, unknown version/topic 404, malformed payload 422. */
export async function putReview(versionId: number, itemId: number, input: ReviewUpdate): Promise<ReviewTopic> {
  const r = await fetch(`/reviews/${encodeURIComponent(String(versionId))}/topics/${encodeURIComponent(String(itemId))}`, jsonInit("PUT", input))
  return normalizeReviewTopic(await expectJson<ReviewTopic>(r))
}

// ---- Research shortlist and show composer (frozen contract) -----------------
// Research reads the active inbox with per-story curation (an editable
// category, a 0–3 priority, pin, exclude) and a transparent local ranking:
// pins first, then priority, freshness and saved context. Categories are
// keyword suggestions until set by hand. Nothing here is generated, scored by
// an AI or shared with the live clock: a preview is a pure read and a build
// creates one independent Saved Show from the saved titles, durations and
// context of the chosen stories.

export type ResearchCategoryId = "fashion-drops" | "fashion-industry" | "fashion-tech" | "ai-innovation" | "film-entertainment" | "brain-rot" | "uncategorized"

export type ResearchCategory = { id: ResearchCategoryId; label: string }

export type ResearchPriority = 0 | 1 | 2 | 3

/** Saved curation of one story; `revision` 0 means nothing has been saved yet. */
export type ResearchPreferences = {
  revision: number
  /** null = automatic keyword suggestion; "uncategorized" is an explicit manual choice. */
  category: ResearchCategoryId | null
  priority: ResearchPriority
  pinned: boolean
  excluded: boolean
}

export type ResearchItem = InboxItem & {
  preferences: ResearchPreferences
  /** Resolved category: the manual choice when set, otherwise the keyword suggestion. */
  category: ResearchCategoryId
  category_origin: "manual" | "keyword suggestion"
  score: number
  reasons: string[]
  full_title: string
  /** Stories with the same exact full headline (4+ words) or the same source URL share a group. */
  group_id: string
  related_count: number
}

export type ResearchList = { categories: ResearchCategory[]; method: string; items: ResearchItem[] }

/** Exact full payload for PUT /research/{id}/preferences; anything extra is a 422, pinned+excluded is a 422. */
export type ResearchPreferencesUpdate = ResearchPreferences

export type ResearchProposal = { items: ResearchItem[]; warnings: string[]; method: string }

/** One chosen story pinned to the revisions it was chosen at; the server 409s when either moved. */
export type ResearchSelection = { id: string; revision: number; preference_revision: number }

export type ResearchPreviewTopic = { text: string; duration: number; notes: string }

export type ResearchPreview = { topics: ResearchPreviewTopic[]; total_seconds: number; method: string; warnings: string[] }

export const RESEARCH_CATEGORY_IDS: ResearchCategoryId[] = ["fashion-drops", "fashion-industry", "fashion-tech", "ai-innovation", "film-entertainment", "brain-rot", "uncategorized"]

function normalizeCategoryId(value: unknown): ResearchCategoryId | null {
  return typeof value === "string" && (RESEARCH_CATEGORY_IDS as string[]).includes(value) ? (value as ResearchCategoryId) : null
}

function normalizePriority(value: unknown): ResearchPriority {
  return value === 1 || value === 2 || value === 3 ? value : 0
}

export function normalizeResearchPreferences(raw: unknown): ResearchPreferences {
  const pref = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  return {
    revision: finiteNumber(pref.revision, 0),
    category: normalizeCategoryId(pref.category),
    priority: normalizePriority(pref.priority),
    pinned: pref.pinned === true,
    excluded: pref.excluded === true,
  }
}

function normalizeResearchItem(raw: ResearchItem): ResearchItem {
  const base = normalizeInboxItem(raw)
  const preferences = normalizeResearchPreferences(raw.preferences)
  return {
    ...base,
    preferences,
    category: normalizeCategoryId(raw.category) ?? preferences.category ?? "uncategorized",
    category_origin: raw.category_origin === "manual" ? "manual" : "keyword suggestion",
    score: finiteNumber(raw.score, 0),
    reasons: stringList(raw.reasons),
    full_title: typeof raw.full_title === "string" && raw.full_title.length > 0 ? raw.full_title : base.text,
    group_id: typeof raw.group_id === "string" && raw.group_id.length > 0 ? raw.group_id : base.id,
    related_count: Math.max(0, Math.trunc(finiteNumber(raw.related_count, 0))),
  }
}

function normalizeCategories(raw: unknown): ResearchCategory[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const categories: ResearchCategory[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const id = normalizeCategoryId((entry as { id?: unknown }).id)
    if (id === null || seen.has(id)) continue
    seen.add(id)
    const label = (entry as { label?: unknown }).label
    categories.push({ id, label: typeof label === "string" && label.length > 0 ? label : id })
  }
  return categories
}

/** Every active inbox story (excluded ones included) in server ranking order, with the category list. */
export async function getResearch(signal?: AbortSignal): Promise<ResearchList> {
  const r = await fetch("/research", { cache: "no-store", signal })
  const body = await expectJson<ResearchList>(r)
  return {
    categories: normalizeCategories(body.categories),
    method: typeof body.method === "string" ? body.method : "",
    items: (Array.isArray(body.items) ? body.items : []).map(normalizeResearchItem),
  }
}

/** Explicit curation save. Stale revision or archived story 409, unknown story 404, malformed payload 422. */
export async function putResearchPreferences(id: string, input: ResearchPreferencesUpdate): Promise<ResearchPreferences> {
  const r = await fetch(`/research/${encodeURIComponent(id)}/preferences`, jsonInit("PUT", input))
  return normalizeResearchPreferences(await expectJson<unknown>(r))
}

/**
 * Pure read: a category-balanced pick of `count` stories, every pin inside the
 * filter first, one per matching-coverage group. Nothing is stored or added;
 * the caller decides whether to adopt the proposal. More pins than slots 409.
 */
export async function proposeResearch(count: number, categories: ResearchCategoryId[] = []): Promise<ResearchProposal> {
  const r = await fetch("/research/propose", jsonInit("POST", { count, categories }))
  const body = await expectJson<ResearchProposal>(r)
  return {
    items: (Array.isArray(body.items) ? body.items : []).map(normalizeResearchItem),
    warnings: stringList(body.warnings),
    method: typeof body.method === "string" ? body.method : "",
  }
}

function normalizePreview(raw: ResearchPreview): ResearchPreview {
  const topics = (Array.isArray(raw.topics) ? raw.topics : []).map((topic) => ({
    text: typeof topic?.text === "string" ? topic.text : "",
    duration: finiteNumber(topic?.duration, 0),
    notes: typeof topic?.notes === "string" ? topic.notes : "",
  }))
  return {
    topics,
    total_seconds: finiteNumber(raw.total_seconds, topics.reduce((sum, topic) => sum + topic.duration, 0)),
    method: typeof raw.method === "string" ? raw.method : "",
    warnings: stringList(raw.warnings),
  }
}

/** Read-only composition of the chosen stories in the given order. Changed/archived/excluded 409, missing 404, duplicates 422. */
export async function previewResearch(selections: ResearchSelection[]): Promise<ResearchPreview> {
  const r = await fetch("/research/preview", jsonInit("POST", { selections }))
  return normalizePreview(await expectJson<ResearchPreview>(r))
}

/**
 * Creates one independent Saved Show (201). The same `request_id` with the
 * identical payload returns the same show again, which is how a lost response
 * or a double press is resolved without a duplicate; the same id with a
 * different payload is a 409.
 */
export async function buildResearchShow(name: string, selections: ResearchSelection[], requestId: string): Promise<SavedShow> {
  const r = await fetch("/research/shows", jsonInit("POST", { name, selections, request_id: requestId }))
  return expectShow(r)
}

// ---- AI research analysis (frozen contract, /research/ai) -------------------
// Optional, explicit and bounded: the user chooses up to 20 saved stories and a
// show brief, previews the exact text the API would send, and only a consented
// click starts one provider call (a loopback fixture in tests). A run never
// changes stories, curation, shortlists or the live show; its scores are
// editorial suggestions shown apart from the local ranking. A proposal built
// from a run returns the ORIGINAL local metadata of the chosen stories, so it
// merges into the catalog without mislabelling AI scores as local ones.

export type AnalysisMode = "anthropic" | "fixture"

export type AnalysisSettings = {
  ready: boolean
  /** Why analysis is unavailable (disabled, no model, no key…), or null when ready. */
  reason: string | null
  mode: AnalysisMode
  model: string
  daily_limit: number
  used_today: number
  remaining_today: number
  max_stories: number
  max_output_tokens: number
}

export type AnalysisRunStatus = "running" | "succeeded" | "failed" | "interrupted"

/** One assessed story. `group_id` names the representative story of a same-event group (itself when alone). */
export type AnalysisItem = { id: string; score: number; category: ResearchCategoryId; group_id: string; reason: string }

export type AnalysisRun = {
  id: string
  status: AnalysisRunStatus
  brief: string
  selections: ResearchSelection[]
  started_at: string
  model: string
  mode: AnalysisMode
  /** True once any analysed story, its curation or the input text moved on; a stale run cannot propose. */
  stale: boolean
  items: AnalysisItem[]
  input_tokens: number | null
  output_tokens: number | null
  error: string | null
}

export type AnalysisStatus = { settings: AnalysisSettings; latest_run: AnalysisRun | null }

/** Exact text that POST /research/ai/generate would send, with the hash that pins a generate request to it. */
export type AnalysisInput = { input_text: string; input_hash: string; settings: AnalysisSettings; input_truncated: boolean }

export type AnalysisRequest = { brief: string; selections: ResearchSelection[]; request_id: string; input_hash: string; consent: true }

function normalizeAnalysisSettings(raw: unknown): AnalysisSettings {
  const cfg = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  return {
    ready: cfg.ready === true,
    reason: nullableString(cfg.reason),
    mode: cfg.mode === "anthropic" ? "anthropic" : "fixture",
    model: typeof cfg.model === "string" ? cfg.model : "",
    daily_limit: finiteNumber(cfg.daily_limit, 0),
    used_today: finiteNumber(cfg.used_today, 0),
    remaining_today: finiteNumber(cfg.remaining_today, 0),
    max_stories: finiteNumber(cfg.max_stories, 20),
    max_output_tokens: finiteNumber(cfg.max_output_tokens, 5000),
  }
}

function normalizeSelections(raw: unknown): ResearchSelection[] {
  if (!Array.isArray(raw)) return []
  const out: ResearchSelection[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const sel = entry as Record<string, unknown>
    if (typeof sel.id !== "string" || sel.id.length === 0) continue
    out.push({ id: sel.id, revision: finiteNumber(sel.revision, 0), preference_revision: finiteNumber(sel.preference_revision, 0) })
  }
  return out
}

function normalizeAnalysisItems(raw: unknown): AnalysisItem[] {
  if (!Array.isArray(raw)) return []
  const out: AnalysisItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const item = entry as Record<string, unknown>
    if (typeof item.id !== "string" || item.id.length === 0) continue
    const score = Math.min(100, Math.max(0, Math.round(finiteNumber(item.score, 0))))
    out.push({
      id: item.id,
      score,
      category: normalizeCategoryId(item.category) ?? "uncategorized",
      group_id: typeof item.group_id === "string" && item.group_id.length > 0 ? item.group_id : item.id,
      reason: typeof item.reason === "string" ? item.reason : "",
    })
  }
  return out
}

function normalizeAnalysisRun(raw: unknown): AnalysisRun {
  const run = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const status: AnalysisRunStatus = run.status === "running" || run.status === "succeeded" || run.status === "interrupted" ? run.status : "failed"
  return {
    id: String(run.id ?? ""),
    status,
    brief: typeof run.brief === "string" ? run.brief : "",
    selections: normalizeSelections(run.selections),
    started_at: typeof run.started_at === "string" ? run.started_at : "",
    model: typeof run.model === "string" ? run.model : "",
    mode: run.mode === "anthropic" ? "anthropic" : "fixture",
    stale: run.stale === true,
    items: normalizeAnalysisItems(run.items),
    input_tokens: typeof run.input_tokens === "number" && Number.isFinite(run.input_tokens) ? run.input_tokens : null,
    output_tokens: typeof run.output_tokens === "number" && Number.isFinite(run.output_tokens) ? run.output_tokens : null,
    error: nullableString(run.error),
  }
}

/** Provider readiness and the latest run (any status), recovered across reloads. Never starts a provider call. */
export async function getResearchAnalysis(signal?: AbortSignal): Promise<AnalysisStatus> {
  const r = await fetch("/research/ai", { cache: "no-store", signal })
  const body = await expectJson<Record<string, unknown>>(r)
  return { settings: normalizeAnalysisSettings(body.settings), latest_run: body.latest_run && typeof body.latest_run === "object" ? normalizeAnalysisRun(body.latest_run) : null }
}

/** One run by id (404 when unknown). A pure read: a running run is reported, never restarted. */
export async function getResearchAnalysisRun(runId: string, signal?: AbortSignal): Promise<AnalysisRun> {
  const r = await fetch(`/research/ai/runs/${encodeURIComponent(runId)}`, { cache: "no-store", signal })
  return normalizeAnalysisRun(await expectJson<unknown>(r))
}

/**
 * The exact bounded text a generate request would send for this brief and
 * these stories, plus its hash. No provider call. Changed/archived/excluded
 * stories 409, malformed brief or selections 422.
 */
export async function previewResearchAnalysisInput(brief: string, selections: ResearchSelection[]): Promise<AnalysisInput> {
  const r = await fetch("/research/ai/input", jsonInit("POST", { brief, selections }))
  const body = await expectJson<Record<string, unknown>>(r)
  return {
    input_text: typeof body.input_text === "string" ? body.input_text : "",
    input_hash: typeof body.input_hash === "string" ? body.input_hash : "",
    settings: normalizeAnalysisSettings(body.settings),
    input_truncated: body.input_truncated === true,
  }
}

/**
 * The one explicit provider call. The same `request_id` with the identical
 * body returns the same run again (running or terminal) without a second
 * provider call; the same id with a different body is a 409. Changed input
 * 409, another run in progress 409, not configured 503, daily cap 429,
 * malformed 422. A failed run comes back as a normal 200 with status "failed".
 */
export async function generateResearchAnalysis(input: AnalysisRequest): Promise<AnalysisRun> {
  const r = await fetch("/research/ai/generate", jsonInit("POST", input))
  return normalizeAnalysisRun(await expectJson<unknown>(r))
}

/**
 * A pure read: `count` stories chosen by AI rank within the analysed set (pins
 * first, manual categories and priority honoured, one per AI group). Items
 * carry their ORIGINAL local metadata. Unavailable or stale run 409.
 */
export async function proposeFromResearchAnalysis(runId: string, count: number): Promise<ResearchProposal> {
  const r = await fetch(`/research/ai/runs/${encodeURIComponent(runId)}/propose`, jsonInit("POST", { count }))
  const body = await expectJson<ResearchProposal>(r)
  return {
    items: (Array.isArray(body.items) ? body.items : []).map(normalizeResearchItem),
    warnings: stringList(body.warnings),
    method: typeof body.method === "string" ? body.method : "",
  }
}

// ---- Whole-show preparation (frozen contract, /preparation/shows) -----------
// One explicit, consented provider call prepares a summary and talking points
// for every topic of a saved show at once. Nothing is written to the show by
// generation; only an explicit apply appends the reviewed notes, guarded by the
// saved revision and applied at most once per run. Settings, the daily quota and
// the failure count are shared with single-topic preparation. Keys stay in the
// API process environment; the browser only ever sees provider/model names.

export type ShowPreparationSettings = PreparationConfig & {
  max_topics: number
  max_input_chars_per_topic: number
}

export type ShowPreparationItem = { id: string; summary: string; talking_points: string[] }

export type ShowPreparationRun = {
  id: string
  show_id: string
  /** Saved-show revision the input was taken from; apply is only valid while the show is still at it. */
  revision: number
  status: PreparationRunStatus
  started_at: string
  model: string
  mode: PreparationMode
  /** One entry per saved topic, in saved order (empty until succeeded). */
  items: ShowPreparationItem[]
  input_tokens: number | null
  output_tokens: number | null
  /** The show's saved revision moved on since this run (any save, including applying it). */
  stale: boolean
  /** Revision the show reached when this run was applied, or null when never applied. */
  applied_revision: number | null
  error: string | null
}

export type ShowPreparationStatus = {
  show_id: string
  revision: number
  settings: ShowPreparationSettings
  latest_run: ShowPreparationRun | null
}

/** The exact bounded text a generate request sends (from the saved show only), plus its hash. No provider call. */
export type ShowPreparationInput = {
  show_id: string
  revision: number
  input_text: string
  input_hash: string
  input_truncated: boolean
  settings: ShowPreparationSettings
}

export type ShowPreparationRequest = { revision: number; input_hash: string; request_id: string; consent: true }

export type ShowPreparationApply = { revision: number; items: ShowPreparationItem[] }

function normalizeShowPreparationSettings(raw: unknown): ShowPreparationSettings {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  return {
    ...normalizePreparationConfig(source as unknown as PreparationConfig),
    max_topics: finiteNumber(source.max_topics, 20),
    max_input_chars_per_topic: finiteNumber(source.max_input_chars_per_topic, 4000),
  }
}

function normalizeShowPreparationItem(raw: unknown): ShowPreparationItem | null {
  if (!raw || typeof raw !== "object") return null
  const item = raw as Record<string, unknown>
  if (typeof item.id !== "string") return null
  return { id: item.id, summary: typeof item.summary === "string" ? item.summary : "", talking_points: stringList(item.talking_points) }
}

function normalizeShowPreparationRun(raw: unknown): ShowPreparationRun {
  const run = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const status: PreparationRunStatus = run.status === "running" || run.status === "succeeded" || run.status === "interrupted" ? run.status : "failed"
  return {
    id: String(run.id ?? ""),
    show_id: String(run.show_id ?? ""),
    revision: finiteNumber(run.revision, 0),
    status,
    started_at: typeof run.started_at === "string" ? run.started_at : "",
    model: typeof run.model === "string" ? run.model : "",
    mode: run.mode === "anthropic" ? "anthropic" : "fixture",
    items: Array.isArray(run.items) ? run.items.map(normalizeShowPreparationItem).filter((item): item is ShowPreparationItem => item !== null) : [],
    input_tokens: typeof run.input_tokens === "number" ? run.input_tokens : null,
    output_tokens: typeof run.output_tokens === "number" ? run.output_tokens : null,
    stale: run.stale === true,
    applied_revision: typeof run.applied_revision === "number" ? run.applied_revision : null,
    error: nullableString(run.error),
  }
}

/** Settings, current saved revision and the latest retained run for one saved show (404 when unknown). */
export async function getShowPreparation(showId: string, signal?: AbortSignal): Promise<ShowPreparationStatus> {
  const r = await fetch(`/preparation/shows/${encodeURIComponent(showId)}`, { cache: "no-store", signal })
  const body = await expectJson<Record<string, unknown>>(r)
  return {
    show_id: String(body.show_id ?? showId),
    revision: finiteNumber(body.revision, 0),
    settings: normalizeShowPreparationSettings(body.settings),
    latest_run: body.latest_run && typeof body.latest_run === "object" ? normalizeShowPreparationRun(body.latest_run) : null,
  }
}

/** One run by id, exactly as stored (404 when unknown). A pure read: it never restarts anything. */
export async function getShowPreparationRun(showId: string, runId: string, signal?: AbortSignal): Promise<ShowPreparationRun> {
  const r = await fetch(`/preparation/shows/${encodeURIComponent(showId)}/runs/${encodeURIComponent(runId)}`, { cache: "no-store", signal })
  return normalizeShowPreparationRun(await expectJson<unknown>(r))
}

/** Exact input for the saved show at `revision`: stale 409, empty show 422. Nothing is sent to a provider. */
export async function previewShowPreparationInput(showId: string, revision: number): Promise<ShowPreparationInput> {
  const r = await fetch(`/preparation/shows/${encodeURIComponent(showId)}/input`, jsonInit("POST", { revision }))
  const body = await expectJson<Record<string, unknown>>(r)
  return {
    show_id: String(body.show_id ?? showId),
    revision: finiteNumber(body.revision, revision),
    input_text: typeof body.input_text === "string" ? body.input_text : "",
    input_hash: typeof body.input_hash === "string" ? body.input_hash : "",
    input_truncated: body.input_truncated === true,
    settings: normalizeShowPreparationSettings(body.settings),
  }
}

/**
 * Explicit, consented generation for every topic in one provider call. The same
 * request id with the same body returns the existing run (running or finished)
 * without a second provider call; a different body under a known id is 409.
 * Stale revision or changed input 409, disabled 503, quota 429, malformed 422.
 * A provider failure is a normal answer with status "failed".
 */
export async function generateShowPreparation(showId: string, input: ShowPreparationRequest): Promise<ShowPreparationRun> {
  const r = await fetch(`/preparation/shows/${encodeURIComponent(showId)}/generate`, jsonInit("POST", input))
  return normalizeShowPreparationRun(await expectJson<unknown>(r))
}

/**
 * Append the selected, reviewed notes to the saved show atomically; answers the
 * CURRENT authoritative saved show. Replaying the exact same payload after a
 * lost answer returns that current show again without appending twice; a
 * different payload for an already-applied run is 409. Stale revision 409,
 * over-long resulting notes 422 (nothing applied).
 */
export async function applyShowPreparation(showId: string, runId: string, payload: ShowPreparationApply): Promise<SavedShow> {
  const r = await fetch(`/preparation/shows/${encodeURIComponent(showId)}/runs/${encodeURIComponent(runId)}/apply`, jsonInit("POST", payload))
  return expectShow(r)
}

// ---- Discovery searches: YouTube and Reddit retrieval (frozen contract) -------
// A saved search is configuration only: creating or editing it never contacts
// a platform. "Collect now" is the one network action: it sends exactly one
// provider request per fresh attempt and answers with the finished run (a
// failed collection is a normal 200 answer with status "failed"). Every attempt
// carries a client UUID; repeating the same UUID with the same revision
// recovers the original attempt instead of spending another request.

export type RetrievalPlatform = "youtube" | "reddit"

export type RetrievalRunStatus = "running" | "succeeded" | "failed" | "interrupted"

export type RetrievalMode = "fixture" | "live"

export type RetrievalRun = {
  id: string
  source_id: string
  revision: number
  status: RetrievalRunStatus
  started_at: string
  finished_at: string | null
  created: number
  duplicates: number
  skipped: number
  error: string | null
  mode: RetrievalMode
}

export type RetrievalSource = {
  id: string
  revision: number
  name: string
  platform: RetrievalPlatform
  query: string
  scope: string
  freshness_hours: number
  limit: number
  default_duration: number
  enabled: boolean
  created_at: string
  updated_at: string
  /** Why this platform cannot be queried right now (credentials missing), or null when it is ready. */
  setup_reason: string | null
  /** False while paused, while the platform needs setup, or while any collection holds the global lease. Daily allowance is not included. */
  can_import: boolean
  latest_run: RetrievalRun | null
}

export type RetrievalProvider = { platform: RetrievalPlatform; setup_reason: string | null }

export type RetrievalStatus = {
  sources: RetrievalSource[]
  providers: RetrievalProvider[]
  daily_limit: number
  used_today: number
  mode: RetrievalMode
}

/** Create input: every setting; a payload identical to an existing search recovers that search. */
export type RetrievalSourceCreate = {
  name: string
  platform: RetrievalPlatform
  query: string
  scope: string
  freshness_hours: number
  limit: number
  default_duration: number
  enabled: boolean
}

/** Edit input: full fields plus the revision the edit was made from (stale writes 409). */
export type RetrievalSourceUpdate = RetrievalSourceCreate & { revision: number }

/** One collection attempt: the revision collected against and a client-chosen UUID that makes the attempt repeatable. */
export type RetrievalCollectRequest = { revision: number; request_id: string }

function normalizeRetrievalRun(run: RetrievalRun): RetrievalRun {
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)
  const status: RetrievalRunStatus = run.status === "running" || run.status === "succeeded" || run.status === "interrupted" ? run.status : "failed"
  return {
    ...run,
    status,
    finished_at: typeof run.finished_at === "string" ? run.finished_at : null,
    created: count(run.created),
    duplicates: count(run.duplicates),
    skipped: count(run.skipped),
    error: typeof run.error === "string" ? run.error : null,
    mode: run.mode === "fixture" ? "fixture" : "live",
  }
}

function normalizeRetrievalSource(source: RetrievalSource): RetrievalSource {
  const number = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback)
  return {
    ...source,
    name: typeof source.name === "string" ? source.name : "",
    platform: source.platform === "reddit" ? "reddit" : "youtube",
    query: typeof source.query === "string" ? source.query : "",
    scope: typeof source.scope === "string" ? source.scope : "",
    freshness_hours: number(source.freshness_hours, 168),
    limit: number(source.limit, 20),
    default_duration: number(source.default_duration, 120),
    enabled: source.enabled === true,
    setup_reason: typeof source.setup_reason === "string" ? source.setup_reason : null,
    can_import: source.can_import === true,
    latest_run: source.latest_run && typeof source.latest_run === "object" ? normalizeRetrievalRun(source.latest_run) : null,
  }
}

async function expectRetrievalSource(response: Response): Promise<RetrievalSource> {
  return normalizeRetrievalSource(await expectJson<RetrievalSource>(response))
}

/** Every saved search with its latest run, platform readiness, today's attempt counter and whether results come from a fixture. */
export async function getRetrieval(signal?: AbortSignal): Promise<RetrievalStatus> {
  const r = await fetch("/retrieval", { cache: "no-store", signal })
  const body = await expectJson<RetrievalStatus>(r)
  const providers = Array.isArray(body.providers) ? body.providers : []
  return {
    sources: (Array.isArray(body.sources) ? body.sources : []).map(normalizeRetrievalSource),
    providers: providers
      .filter((entry): entry is RetrievalProvider => !!entry && typeof entry === "object" && (entry.platform === "youtube" || entry.platform === "reddit"))
      .map((entry) => ({ platform: entry.platform, setup_reason: typeof entry.setup_reason === "string" ? entry.setup_reason : null })),
    daily_limit: typeof body.daily_limit === "number" && Number.isFinite(body.daily_limit) ? body.daily_limit : 0,
    used_today: typeof body.used_today === "number" && Number.isFinite(body.used_today) ? body.used_today : 0,
    mode: body.mode === "fixture" ? "fixture" : "live",
  }
}

export async function createRetrievalSource(input: RetrievalSourceCreate): Promise<RetrievalSource> {
  const r = await fetch("/retrieval", jsonInit("POST", input))
  return expectRetrievalSource(r)
}

export async function updateRetrievalSource(id: string, input: RetrievalSourceUpdate): Promise<RetrievalSource> {
  const r = await fetch(`/retrieval/${encodeURIComponent(id)}`, jsonInit("PUT", input))
  return expectRetrievalSource(r)
}

/**
 * Explicit collection. Resolves with the finished run; a failed collection is
 * a 200 with status "failed". Stale revision, paused search or another running
 * collection reject with 409, missing credentials with 503, the two-second
 * spacing or the daily allowance with 429. The same UUID and revision always
 * answer with the original attempt, whatever its outcome.
 */
export async function collectRetrievalSource(id: string, input: RetrievalCollectRequest): Promise<RetrievalRun> {
  const r = await fetch(`/retrieval/${encodeURIComponent(id)}/import`, jsonInit("POST", input))
  return normalizeRetrievalRun(await expectJson<RetrievalRun>(r))
}

/** Last 20 runs, newest first. */
export async function listRetrievalRuns(id: string, signal?: AbortSignal): Promise<RetrievalRun[]> {
  const r = await fetch(`/retrieval/${encodeURIComponent(id)}/runs`, { cache: "no-store", signal })
  const body = await expectJson<{ runs: RetrievalRun[] }>(r)
  return (Array.isArray(body.runs) ? body.runs : []).map(normalizeRetrievalRun)
}

// ---- Public social-link context (frozen contract) ----------------------------
// An explicit, read-only preview of one public X post or TikTok video through
// the platform's official oEmbed endpoint. The server never stores anything
// for it: the text only reaches an idea when the user adds it to the context
// and saves the idea as usual.

export type SocialLinkPlatform = "x" | "tiktok"

export type SocialLinkPreview = {
  platform: SocialLinkPlatform
  /** Canonical permalink the server resolved the pasted link to (tracking stripped). */
  source_url: string
  /** Single-line title, at most 1000 characters. */
  title: string
  /** Post text or video caption, plain text, at most 6000 characters. */
  text: string
  /** Author display name, at most 200 characters; "" when the provider gave none. */
  author: string
  /** Ready-to-append context block (platform line, limitations, author, text), at most 7500 characters. */
  context: string
  /** What was and was not retrieved, in plain words. */
  limitations: string
  /** The server capped the title, text or author. */
  truncated: boolean
  /** "fixture" when the API answers from synthetic provider data instead of the real platform. */
  mode: "live" | "fixture"
}

/** Only a complete, text-only preview is accepted; anything else counts as a malformed provider answer (502). */
function normalizeSocialLinkPreview(raw: unknown): SocialLinkPreview {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null
  const platform = body?.platform === "x" || body?.platform === "tiktok" ? body.platform : null
  if (!body || platform === null || typeof body.source_url !== "string" || typeof body.context !== "string" || body.context.trim().length === 0) {
    throw new ApiError(502, "The link preview answer was incomplete. Keep the link and add context manually.")
  }
  return {
    platform,
    source_url: body.source_url,
    title: typeof body.title === "string" ? body.title : "",
    text: typeof body.text === "string" ? body.text : "",
    author: typeof body.author === "string" ? body.author : "",
    context: body.context,
    limitations: typeof body.limitations === "string" ? body.limitations : "",
    truncated: body.truncated === true,
    mode: body.mode === "fixture" ? "fixture" : "live",
  }
}

/**
 * Fetch the public text behind a full X post or TikTok video link. Unsupported
 * or malformed links reject with 422, a provider that is down, private or
 * answering garbage with 502, a second preview inside two seconds (or one
 * already running) with 429. Nothing is written server-side.
 */
export async function previewSocialLink(url: string, signal?: AbortSignal): Promise<SocialLinkPreview> {
  const r = await fetch("/social-links/preview", { ...jsonInit("POST", { url }), signal })
  return normalizeSocialLinkPreview(await expectJson<unknown>(r))
}
