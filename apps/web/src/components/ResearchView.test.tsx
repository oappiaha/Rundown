import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import App from "../App"
import type { ResearchItem, ResearchPreferences, SavedShow, ShowState } from "../lib/api"

// Research view rendered through App so navigation, state preservation across
// tabs and the hand-off into Saved Shows are exercised the way a user reaches
// them. The fake server mirrors the frozen /research contract: revision-
// guarded preferences, a pure proposal, snapshot-checked preview and an
// idempotent build keyed by request_id.

type Call = { method: string; url: string; body?: unknown }
type Selection = { id: string; revision: number; preference_revision: number }

let live: ShowState
let stories: Map<string, ResearchItem>
let saved: Map<string, SavedShow>
let builds: Map<string, { hash: string; showId: string }>
let calls: Call[]
let ids: number
/** Requests matching this pattern are held until released. */
let holdPattern: RegExp | null
let held: Array<() => void>
/** When set, POST /research/shows fails at the network level (no response). */
let failBuild: boolean

const CATEGORIES = [
  { id: "fashion-drops", label: "Fashion drops" },
  { id: "fashion-industry", label: "Fashion industry" },
  { id: "fashion-tech", label: "Fashion tech" },
  { id: "ai-innovation", label: "AI innovation" },
  { id: "film-entertainment", label: "Film & entertainment" },
  { id: "brain-rot", label: "Internet culture" },
  { id: "uncategorized", label: "Uncategorized" },
] as const

function prefs(patch: Partial<ResearchPreferences> = {}): ResearchPreferences {
  return { revision: 0, category: null, priority: 0, pinned: false, excluded: false, ...patch }
}

function story(id: string, text: string, category: ResearchItem["category"], patch: Partial<ResearchItem> = {}): ResearchItem {
  return {
    id,
    revision: 1,
    text,
    duration: 120,
    notes: `${text} context`,
    source_url: "",
    archived: false,
    created_at: "2026-09-15T00:00:00Z",
    updated_at: "2026-09-15T00:00:00Z",
    topic: { text, duration: 120, notes: `${text} context` },
    source: null,
    preferences: prefs(),
    category,
    category_origin: "keyword suggestion",
    score: 25,
    reasons: ["Priority 0/3: +0", "Freshness from capture time: +20", "Saved context: +5"],
    full_title: `${text} full headline here`,
    group_id: id,
    related_count: 0,
    ...patch,
  }
}

function liveState(): ShowState {
  return { revision: 3, topics: [{ id: "a", text: "Opening", duration: 120, notes: "" }], current_topic_id: "a", remaining_seconds: 100, paused: true, server_time: "2026-09-14T00:00:00.000Z" }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** Server ranking: pins first, then score, then id. The resolved category follows a manual choice. */
function ranked(): ResearchItem[] {
  return [...stories.values()]
    .map((item) => ({
      ...item,
      category: item.preferences.category ?? item.category,
      category_origin: item.preferences.category ? ("manual" as const) : ("keyword suggestion" as const),
      score: item.preferences.priority * 25 + 25,
    }))
    .sort((a, b) => Number(b.preferences.pinned) - Number(a.preferences.pinned) || b.score - a.score || a.id.localeCompare(b.id))
}

function copyNotes(item: ResearchItem): string {
  return item.source_url ? `${item.notes}\nSource: ${item.source_url}` : item.notes
}

function checkSelections(selections: Selection[]): Response | null {
  if (new Set(selections.map((entry) => entry.id)).size !== selections.length) return json({ detail: "Each selected topic must appear only once." }, 422)
  for (const chosen of selections) {
    const item = stories.get(chosen.id)
    if (!item) return json({ detail: "Topic not found." }, 404)
    if (item.revision !== chosen.revision || item.preferences.revision !== chosen.preference_revision) return json({ detail: "Selected research changed. Refresh the shortlist and preview again." }, 409)
    if (item.preferences.excluded) return json({ detail: "An excluded topic cannot be added. Change its curation first." }, 409)
  }
  return null
}

function maybeHold(key: string, response: Response): Promise<Response> | Response {
  if (!holdPattern || !holdPattern.test(key)) return response
  return new Promise<Response>((resolve) => held.push(() => resolve(response)))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  live = liveState()
  stories = new Map(
    [
      story("movie", "New movie trailer", "film-entertainment", { preferences: prefs({ revision: 2, priority: 3, pinned: true }), notes: "Trailer context", source_url: "https://example.com/trailer" }),
      story("ai1", "AI tools for creators", "ai-innovation", { group_id: "ai1", related_count: 1 }),
      story("ai2", "AI tools for creators", "ai-innovation", { group_id: "ai1", related_count: 1, full_title: "AI tools for creators full headline here" }),
      story("sneaker", "Sneaker drop this Friday", "fashion-drops"),
      story("runway", "Runway fashion news", "fashion-industry"),
      story("meme", "Viral meme of the week", "brain-rot"),
      story("textile", "Smart textile update", "fashion-tech"),
      story("audience", "Audience questions", "uncategorized"),
    ].map((item) => [item.id, item]),
  )
  saved = new Map()
  builds = new Map()
  calls = []
  ids = 0
  holdPattern = null
  held = []
  failBuild = false
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
    calls.push({ method, url, body })
    const key = `${method} ${url}`
    if (url.endsWith("/rundown/state")) return json(live)
    if (url === "/research" && method === "GET") return maybeHold(key, json({ categories: CATEGORIES, method: "local-rules-v1", items: ranked() }))
    const prefMatch = /^\/research\/([^/]+)\/preferences$/.exec(url)
    if (prefMatch && method === "PUT") {
      const item = stories.get(decodeURIComponent(prefMatch[1] ?? ""))
      if (!item) return json({ detail: "Topic not found." }, 404)
      const payload = body as ResearchPreferences
      if (payload.pinned && payload.excluded) return json({ detail: "A pinned topic cannot also be excluded." }, 422)
      if (payload.revision !== item.preferences.revision) return json({ detail: "Curation changed on another screen. Reload before saving." }, 409)
      item.preferences = { revision: item.preferences.revision + 1, category: payload.category, priority: payload.priority, pinned: payload.pinned, excluded: payload.excluded }
      return json(item.preferences)
    }
    if (url === "/research/propose" && method === "POST") {
      const payload = body as { count: number; categories: string[] }
      const rows = ranked().filter((item) => !item.preferences.excluded && (payload.categories.length === 0 || payload.categories.includes(item.category)))
      const pins = rows.filter((item) => item.preferences.pinned)
      if (pins.length > payload.count) return json({ detail: "More pinned topics than requested slots. Increase the count or unpin topics." }, 409)
      const selected = [...pins]
      const groups = new Set(selected.map((item) => item.group_id))
      for (const item of rows) {
        if (selected.length >= payload.count) break
        if (item.preferences.pinned || groups.has(item.group_id)) continue
        selected.push(item)
        groups.add(item.group_id)
      }
      const warnings = selected.length < payload.count ? [`Only ${selected.length} distinct eligible stories are available.`] : []
      return json({ items: selected, warnings, method: "local-rules-v1" })
    }
    if (url === "/research/preview" && method === "POST") {
      const payload = body as { selections: Selection[] }
      const rejected = checkSelections(payload.selections)
      if (rejected) return rejected
      const topics = payload.selections.map((chosen) => {
        const item = stories.get(chosen.id)!
        return { text: item.text, duration: item.duration, notes: copyNotes(item) }
      })
      return maybeHold(key, json({ topics, total_seconds: topics.reduce((sum, topic) => sum + topic.duration, 0), method: "saved-context", warnings: ["Uses saved titles, durations and context. No AI text has been generated."] }))
    }
    if (url === "/research/shows" && method === "POST") {
      if (failBuild) throw new TypeError("Failed to fetch")
      const payload = body as { name: string; selections: Selection[]; request_id: string }
      const hash = JSON.stringify({ name: payload.name, selections: payload.selections })
      const previous = builds.get(payload.request_id)
      if (previous) {
        if (previous.hash !== hash) return json({ detail: "This save request was already used for a different draft." }, 409)
        return maybeHold(key, json(saved.get(previous.showId), 201))
      }
      const rejected = checkSelections(payload.selections)
      if (rejected) return rejected
      const id = `show-${++ids}`
      const show: SavedShow = {
        id,
        name: payload.name,
        revision: 1,
        topics: payload.selections.map((chosen, index) => {
          const item = stories.get(chosen.id)!
          return { id: `${id}-t${index + 1}`, text: item.text, duration: item.duration, notes: copyNotes(item) }
        }),
        created_at: "2026-09-15T01:00:00Z",
        updated_at: "2026-09-15T01:00:00Z",
      }
      saved.set(id, show)
      builds.set(payload.request_id, { hash, showId: id })
      return maybeHold(key, json(show, 201))
    }
    if (url === "/shows" && method === "GET") {
      return json({ shows: [...saved.values()].map((show) => ({ id: show.id, name: show.name, revision: show.revision, topic_count: show.topics.length, total_seconds: show.topics.reduce((sum, topic) => sum + topic.duration, 0), created_at: show.created_at, updated_at: show.updated_at })) })
    }
    const showMatch = /^\/shows\/([^/]+)$/.exec(url)
    if (showMatch && method === "GET") {
      const show = saved.get(decodeURIComponent(showMatch[1] ?? ""))
      return show ? json(show) : json({ detail: "Show not found." }, 404)
    }
    if (url.startsWith("/inbox")) return json({ items: [] })
    // AI analysis is off in these tests (the panel only shows its setup state); see ResearchAnalysis.test.tsx for the analysis flow.
    if (url === "/research/ai" && method === "GET") return json({ settings: { ready: false, reason: "AI research is disabled. Enable it in the API configuration.", mode: "anthropic", model: "", daily_limit: 5, used_today: 0, remaining_today: 5, max_stories: 20, max_output_tokens: 5000 }, latest_run: null })
    return json({ detail: "Not Found" }, 404)
  }) as unknown as typeof fetch
})

afterEach(() => {
  vi.useRealTimers()
})

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function renderResearch() {
  render(<App />)
  await flush()
  fireEvent.click(screen.getByRole("button", { name: "Research" }))
  await flush()
  expect(await screen.findAllByTestId("story-row")).toHaveLength(8)
}

function research() {
  return within(document.getElementById("research")!)
}

function row(id: string) {
  return within(document.querySelector<HTMLElement>(`[data-testid="story-row"][data-story-id="${id}"]`)!)
}

function status() {
  return screen.getByTestId("research-status").textContent ?? ""
}

function shortlistTitles(): string[] {
  return [...document.querySelectorAll('[data-testid="shortlist-row"] [data-testid="shortlist-title"]')].map((node) => node.textContent ?? "")
}

function requestsTo(method: string, pattern: RegExp) {
  return calls.filter((call) => call.method === method && pattern.test(call.url))
}

function noLiveOrInboxWrites() {
  expect(calls.filter((call) => call.method !== "GET" && (call.url.startsWith("/rundown") || call.url.startsWith("/inbox") || call.url.startsWith("/feeds")))).toEqual([])
}

async function addToShortlist(id: string) {
  fireEvent.click(row(id).getByRole("button", { name: "Add" }))
  await flush()
}

async function previewNow() {
  fireEvent.click(research().getByRole("button", { name: "Preview show" }))
  await flush()
}

async function saveNow() {
  fireEvent.click(research().getByRole("button", { name: "Save as show" }))
  await flush()
}

test("stories arrive ranked and grouped by category with full titles, reasons and a matching-coverage marker; the shortlist survives a trip to other tabs", async () => {
  await renderResearch()
  expect(research().getByText(/Local ranking: priority, freshness and saved context/)).toBeInTheDocument()
  const groups = screen.getAllByTestId("story-group").map((group) => group.getAttribute("aria-label"))
  expect(groups).toEqual(["Fashion drops", "Fashion industry", "Fashion tech", "AI innovation", "Film & entertainment", "Internet culture", "Uncategorized"])
  // The pinned movie ranks first overall even though its category group comes later.
  expect(row("movie").getByLabelText("Rank 1")).toBeInTheDocument()
  expect(row("movie").getByText("Pinned", { selector: ".story-tag" })).toBeInTheDocument()
  expect(row("movie").getByRole("list", { name: 'Why "New movie trailer full headline here" ranks here' })).toHaveTextContent("Freshness from capture time: +20")
  expect(row("movie").getByTestId("story-title")).toHaveTextContent("New movie trailer full headline here")
  expect(row("movie").getByRole("link", { name: "Source" })).toHaveAttribute("href", "https://example.com/trailer")
  expect(row("ai1").getByTestId("story-coverage")).toHaveTextContent("Matching coverage · 1 other story")
  expect(row("sneaker").queryByTestId("story-coverage")).toBeNull()
  expect(row("sneaker").getByTestId("story-category")).toHaveTextContent("Fashion drops · keyword suggestion")

  await addToShortlist("sneaker")
  await addToShortlist("movie")
  expect(shortlistTitles()).toEqual(["Sneaker drop this Friday full headline here", "New movie trailer full headline here"])
  fireEvent.change(research().getByLabelText("Name for the saved show"), { target: { value: "Friday research" } })

  // Category filter and excluded visibility narrow the list without touching the shortlist.
  fireEvent.click(research().getByRole("button", { name: /^AI innovation · 2/ }))
  expect(screen.getAllByTestId("story-row")).toHaveLength(2)
  fireEvent.click(research().getByRole("button", { name: /^All · 8/ }))

  fireEvent.click(screen.getByRole("button", { name: "Inbox" }))
  fireEvent.click(screen.getByRole("button", { name: "Saved Shows" }))
  fireEvent.click(screen.getByRole("button", { name: "Research" }))
  await flush()
  expect(shortlistTitles()).toEqual(["Sneaker drop this Friday full headline here", "New movie trailer full headline here"])
  expect(research().getByLabelText("Name for the saved show")).toHaveValue("Friday research")
  expect(requestsTo("GET", /^\/research$/)).toHaveLength(1)
  noLiveOrInboxWrites()
})

test("curation: a pinned+excluded mix is blocked before any request; a valid save sends the exact payload with the opened version, reads back as manual and reloads the ranking", async () => {
  await renderResearch()
  fireEvent.click(row("sneaker").getByRole("button", { name: "Curate" }))
  fireEvent.click(row("sneaker").getByLabelText("Pin Sneaker drop this Friday full headline here"))
  fireEvent.click(row("sneaker").getByLabelText("Exclude Sneaker drop this Friday full headline here"))
  expect(row("sneaker").getByText("A pinned story can't also be excluded. Untick one of them.")).toBeInTheDocument()
  expect(row("sneaker").getByRole("button", { name: "Save curation" })).toBeDisabled()
  fireEvent.click(row("sneaker").getByLabelText("Exclude Sneaker drop this Friday full headline here"))
  fireEvent.change(row("sneaker").getByLabelText("Category for Sneaker drop this Friday full headline here"), { target: { value: "fashion-industry" } })
  fireEvent.change(row("sneaker").getByLabelText("Priority for Sneaker drop this Friday full headline here"), { target: { value: "2" } })
  expect(requestsTo("PUT", /preferences$/)).toHaveLength(0)

  await addToShortlist("sneaker")
  fireEvent.click(row("sneaker").getByRole("button", { name: "Save curation" }))
  await flush()
  expect(requestsTo("PUT", /preferences$/).map((call) => [call.url, call.body])).toEqual([["/research/sneaker/preferences", { revision: 0, category: "fashion-industry", priority: 2, pinned: true, excluded: false }]])
  expect(requestsTo("GET", /^\/research$/)).toHaveLength(2)
  expect(status()).toMatch(/Curation saved for "Sneaker drop this Friday full headline here"\. Ranking refreshed; your shortlist is unchanged\./)
  expect(row("sneaker").getByTestId("story-category")).toHaveTextContent("Fashion industry · manual")
  expect(row("sneaker").getByText("Pinned", { selector: ".story-tag" })).toBeInTheDocument()
  expect(row("sneaker").getByText("Saved curation.")).toBeInTheDocument()
  expect(shortlistTitles()).toEqual(["Sneaker drop this Friday full headline here"])
  expect(document.body.textContent).not.toMatch(/\brev(ision)?\b/i)
  noLiveOrInboxWrites()
})

test("a curation saved on another screen is never overwritten: a refresh shows the conflict with no request, a blind save gets a 409, and recovery keeps my values on the latest version before an explicit save", async () => {
  await renderResearch()
  fireEvent.click(row("meme").getByRole("button", { name: "Curate" }))
  fireEvent.change(row("meme").getByLabelText("Priority for Viral meme of the week full headline here"), { target: { value: "3" } })

  // Another screen saves first; the user refreshes the stories.
  stories.get("meme")!.preferences = prefs({ revision: 1, category: "film-entertainment", priority: 1 })
  fireEvent.click(research().getByRole("button", { name: "Refresh" }))
  await flush()
  expect(row("meme").getByTestId("story-category")).toHaveTextContent("Film & entertainment · manual")
  expect(row("meme").getByLabelText("Priority for Viral meme of the week full headline here")).toHaveValue("3")
  expect(row("meme").getByTestId("curation-conflict")).toBeInTheDocument()
  expect(row("meme").getByRole("button", { name: "Save curation" })).toBeDisabled()
  expect(requestsTo("PUT", /preferences$/)).toHaveLength(0)

  fireEvent.click(row("meme").getByRole("button", { name: "Use my changes on the latest" }))
  await flush()
  expect(row("meme").queryByTestId("curation-conflict")).toBeNull()
  expect(row("meme").getByLabelText("Priority for Viral meme of the week full headline here")).toHaveValue("3")
  expect(row("meme").getByLabelText("Category for Viral meme of the week full headline here")).toHaveValue("")
  expect(requestsTo("PUT", /preferences$/)).toHaveLength(0)
  fireEvent.click(row("meme").getByRole("button", { name: "Save curation" }))
  await flush()
  expect(requestsTo("PUT", /preferences$/).map((call) => call.body)).toEqual([{ revision: 1, category: null, priority: 3, pinned: false, excluded: false }])
  expect(stories.get("meme")!.preferences).toEqual({ revision: 2, category: null, priority: 3, pinned: false, excluded: false })

  // Without a refresh in between, a stale save is refused by the server and recovered the same way; reloading discards the edit.
  fireEvent.click(row("textile").getByRole("button", { name: "Curate" }))
  fireEvent.click(row("textile").getByLabelText("Exclude Smart textile update full headline here"))
  stories.get("textile")!.preferences = prefs({ revision: 1, pinned: true })
  fireEvent.click(row("textile").getByRole("button", { name: "Save curation" }))
  await flush()
  expect(requestsTo("PUT", /textile\/preferences$/).map((call) => call.body)).toEqual([{ revision: 0, category: null, priority: 0, pinned: false, excluded: true }])
  expect(row("textile").getByTestId("curation-conflict")).toBeInTheDocument()
  expect(row("textile").getByText("Pinned", { selector: ".story-tag" })).toBeInTheDocument()
  expect(stories.get("textile")!.preferences.excluded).toBe(false)
  fireEvent.click(row("textile").getByRole("button", { name: "Reload latest" }))
  await flush()
  expect(row("textile").queryByTestId("curation-conflict")).toBeNull()
  expect(row("textile").getByLabelText("Exclude Smart textile update full headline here")).not.toBeChecked()
  expect(row("textile").getByLabelText("Pin Smart textile update full headline here")).toBeChecked()
  expect(requestsTo("PUT", /textile\/preferences$/)).toHaveLength(1)
  noLiveOrInboxWrites()
})

test("suggest shortlist: adopts directly when empty, asks before replacing, respects the category filter, and folds a story captured after the first load into the catalog so it can be previewed", async () => {
  await renderResearch()
  fireEvent.change(research().getByLabelText("How many"), { target: { value: "3" } })
  fireEvent.click(research().getByRole("button", { name: "Suggest shortlist" }))
  await flush()
  expect(requestsTo("POST", /propose$/).map((call) => call.body)).toEqual([{ count: 3, categories: [] }])
  // Pins first, then one per matching-coverage group in ranking order (ai2 shares ai1's group and is skipped).
  expect(shortlistTitles()).toEqual(["New movie trailer full headline here", "AI tools for creators full headline here", "Audience questions full headline here"])
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(saved.size).toBe(0)

  // A story captured on another screen after the first load: unknown here until the proposal brings it.
  stories.set("fresh", story("fresh", "Fresh streetwear collab", "fashion-drops", { revision: 4, preferences: prefs({ revision: 1, priority: 3 }) }))
  fireEvent.click(research().getByLabelText("Draw from Fashion drops"))
  fireEvent.change(research().getByLabelText("How many"), { target: { value: "2" } })
  fireEvent.click(research().getByRole("button", { name: "Suggest shortlist" }))
  await flush()
  expect(requestsTo("POST", /propose$/)[1]?.body).toEqual({ count: 2, categories: ["fashion-drops"] })
  const dialog = screen.getByRole("dialog")
  expect(dialog).toHaveTextContent("Replace the shortlist?")
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep my shortlist" }))
  expect(shortlistTitles()).toHaveLength(3)
  fireEvent.click(research().getByRole("button", { name: "Suggest shortlist" }))
  await flush()
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Replace shortlist" }))
  await flush()
  expect(shortlistTitles()).toEqual(["Fresh streetwear collab full headline here", "Sneaker drop this Friday full headline here"])
  expect(screen.getAllByTestId("story-row")).toHaveLength(9)

  await previewNow()
  expect(requestsTo("POST", /preview$/).map((call) => call.body)).toEqual([
    {
      selections: [
        { id: "fresh", revision: 4, preference_revision: 1 },
        { id: "sneaker", revision: 1, preference_revision: 0 },
      ],
    },
  ])
  expect(screen.getByTestId("preview")).toHaveAttribute("data-current", "true")
  expect(screen.getAllByTestId("preview-row")[0]).toHaveTextContent("Fresh streetwear collab")
  noLiveOrInboxWrites()
})

test("manual shortlist: add, reorder and remove; preview keeps the order and shows context, source line and total; changing the selection invalidates the preview until previewed again", async () => {
  await renderResearch()
  await addToShortlist("runway")
  await addToShortlist("movie")
  await addToShortlist("audience")
  fireEvent.click(research().getByRole("button", { name: "Move shortlist item 2 up" }))
  fireEvent.click(research().getByRole("button", { name: "Remove shortlist item 3" }))
  expect(shortlistTitles()).toEqual(["New movie trailer full headline here", "Runway fashion news full headline here"])
  expect(screen.getByTestId("shortlist-total")).toHaveTextContent("2 stories · 4 min · 18 slots left")
  expect(row("movie").getByRole("button", { name: "Remove" })).toBeInTheDocument()
  expect(research().getByRole("button", { name: "Save as show" })).toBeDisabled()

  await previewNow()
  expect(requestsTo("POST", /preview$/)[0]?.body).toEqual({
    selections: [
      { id: "movie", revision: 1, preference_revision: 2 },
      { id: "runway", revision: 1, preference_revision: 0 },
    ],
  })
  const preview = within(screen.getByTestId("preview"))
  const rows = preview.getAllByTestId("preview-row")
  expect(rows[0]).toHaveTextContent("New movie trailer")
  expect(rows[0]).toHaveTextContent("Trailer context")
  expect(rows[0]).toHaveTextContent("Source: https://example.com/trailer")
  expect(rows[1]).toHaveTextContent("Runway fashion news")
  expect(preview.getByText(/2 topics · 4 min · 4:00 total/)).toBeInTheDocument()
  expect(preview.getByText("Uses saved titles, durations and context. No AI text has been generated.")).toBeInTheDocument()
  expect(saved.size).toBe(0)

  // Name is still missing: save is blocked by validation, not by the preview.
  expect(research().getByRole("button", { name: "Save as show" })).toBeDisabled()
  fireEvent.change(research().getByLabelText("Name for the saved show"), { target: { value: "  Two stories  " } })
  expect(research().getByRole("button", { name: "Save as show" })).toBeEnabled()

  // A reorder makes the preview stale; the old content stays visible but is marked, and save is blocked.
  fireEvent.click(research().getByRole("button", { name: "Move shortlist item 2 up" }))
  expect(screen.getByTestId("preview")).toHaveAttribute("data-current", "false")
  expect(screen.getByTestId("preview")).toHaveTextContent("The shortlist changed since this preview was made. Preview again before saving.")
  expect(research().getByRole("button", { name: "Save as show" })).toBeDisabled()
  expect(status()).toBe("The shortlist changed since the preview. Preview again before saving.")
  await previewNow()
  expect(screen.getByTestId("preview")).toHaveAttribute("data-current", "true")
  expect(within(screen.getByTestId("preview")).getAllByTestId("preview-row")[0]).toHaveTextContent("Runway fashion news")
  noLiveOrInboxWrites()
})

test("excluded stories cannot be shortlisted; one excluded after being picked stays listed, is named, and blocks preview instead of vanishing", async () => {
  await renderResearch()
  stories.get("meme")!.preferences = prefs({ revision: 1, excluded: true })
  fireEvent.click(research().getByRole("button", { name: "Refresh" }))
  await flush()
  expect(row("meme").getByRole("button", { name: "Add" })).toBeDisabled()
  expect(row("meme").getByText("Excluded")).toBeInTheDocument()
  fireEvent.click(research().getByLabelText(/Show excluded/))
  expect(screen.getAllByTestId("story-row")).toHaveLength(7)
  fireEvent.click(research().getByLabelText(/Show excluded/))

  await addToShortlist("sneaker")
  fireEvent.click(row("sneaker").getByRole("button", { name: "Curate" }))
  fireEvent.click(row("sneaker").getByLabelText("Exclude Sneaker drop this Friday full headline here"))
  fireEvent.click(row("sneaker").getByRole("button", { name: "Save curation" }))
  await flush()
  expect(shortlistTitles()).toEqual(["Sneaker drop this Friday full headline here"])
  expect(screen.getByTestId("shortlist-row")).toHaveTextContent("Excluded · remove or re-curate")
  expect(research().getByRole("button", { name: "Preview show" })).toBeDisabled()
  expect(research().getByRole("button", { name: "Save as show" })).toHaveAttribute("title", '"Sneaker drop this Friday full headline here" is excluded. Remove it from the shortlist or change its curation.')
  fireEvent.click(research().getByRole("button", { name: "Remove shortlist item 1" }))
  expect(status()).toMatch(/Add stories from the list/)
  noLiveOrInboxWrites()
})

test("save: one request id per intent, reused after a network failure and across a double press so no duplicate is made; a new name means a new id; the saved show opens in Saved Shows and a dirty draft there is guarded", async () => {
  await renderResearch()
  await addToShortlist("movie")
  await addToShortlist("runway")
  fireEvent.change(research().getByLabelText("Name for the saved show"), { target: { value: "Friday research" } })
  await previewNow()

  failBuild = true
  await saveNow()
  expect(status()).toBe("Save failed: the RUNDOWN API did not respond. Try again; the same request is retried, so no duplicate show is created.")
  expect(screen.queryByTestId("saved-card")).toBeNull()
  expect(shortlistTitles()).toHaveLength(2)
  failBuild = false

  holdPattern = /^POST \/research\/shows$/
  const saveButton = research().getByRole("button", { name: "Save as show" })
  fireEvent.click(saveButton)
  fireEvent.click(saveButton)
  await flush()
  expect(saveButton).toBeDisabled()
  expect(saveButton).toHaveTextContent("Saving…")
  expect(held).toHaveLength(1)
  held.forEach((release) => release())
  held = []
  await flush()
  const attempts = requestsTo("POST", /^\/research\/shows$/).map((call) => call.body as { name: string; request_id: string; selections: Selection[] })
  expect(attempts).toHaveLength(2)
  expect(attempts[0]?.request_id).toBe(attempts[1]?.request_id)
  expect(attempts[1]?.request_id).toMatch(/^[0-9a-f-]{36}$/)
  expect(attempts[1]?.name).toBe("Friday research")
  expect(attempts[1]?.selections).toEqual([
    { id: "movie", revision: 1, preference_revision: 2 },
    { id: "runway", revision: 1, preference_revision: 0 },
  ])
  expect(saved.size).toBe(1)
  const card = screen.getByTestId("saved-card")
  expect(card).toHaveTextContent('Saved "Friday research" · 2 topics · 4 min')
  expect(status()).toMatch(/Saved "Friday research" · 2 topics as an independent show\. Not live/)
  expect(research().getByRole("button", { name: "Save as show" })).toBeDisabled()
  expect(shortlistTitles()).toHaveLength(2)

  // Pressing save again with the identical intent reuses the id (idempotent on the server); a new name is a new intent.
  holdPattern = null
  fireEvent.change(research().getByLabelText("Name for the saved show"), { target: { value: "Friday research v2" } })
  expect(research().getByRole("button", { name: "Save as show" })).toBeEnabled()
  await saveNow()
  const third = requestsTo("POST", /^\/research\/shows$/)[2]?.body as { request_id: string }
  expect(third.request_id).not.toBe(attempts[0]?.request_id)
  expect(saved.size).toBe(2)

  // Open in Saved Shows: the exact show loads there. The live rundown was never touched.
  fireEvent.click(within(screen.getByTestId("saved-card")).getByRole("button", { name: "Open saved show" }))
  await flush()
  const shows = within(document.getElementById("shows")!)
  expect(document.getElementById("shows")).not.toHaveAttribute("hidden")
  expect(shows.getByLabelText("Show name")).toHaveValue("Friday research v2")
  expect(shows.getByLabelText("Saved topic 1 title")).toHaveValue("New movie trailer")
  expect(shows.getByLabelText("Saved topic 2 title")).toHaveValue("Runway fashion news")
  expect(shows.getByRole("button", { name: "Open Friday research" })).toBeInTheDocument()
  expect(live.revision).toBe(3)

  // Dirty the saved draft, then ask to open again from research: guarded, never dropped.
  fireEvent.change(shows.getByLabelText("Show name"), { target: { value: "Edited by hand" } })
  fireEvent.click(screen.getByRole("button", { name: "Research" }))
  fireEvent.click(within(screen.getByTestId("saved-card")).getByRole("button", { name: "Open saved show" }))
  await flush()
  const guard = screen.getByRole("dialog")
  expect(guard).toHaveTextContent("Unsaved changes")
  fireEvent.click(within(guard).getByRole("button", { name: "Keep editing" }))
  expect(shows.getByLabelText("Show name")).toHaveValue("Edited by hand")
  noLiveOrInboxWrites()
})

test("a build refused as stale keeps the shortlist and name, marks the preview, and a refused re-preview marks it too", async () => {
  await renderResearch()
  await addToShortlist("sneaker")
  fireEvent.change(research().getByLabelText("Name for the saved show"), { target: { value: "Stale check" } })
  await previewNow()
  // The story is edited on another screen after the preview.
  stories.get("sneaker")!.revision = 2
  await saveNow()
  expect(status()).toBe("Not saved: Selected research changed. Refresh the shortlist and preview again. Your shortlist and name are kept. Refresh the stories and preview again.")
  expect(screen.getByTestId("preview")).toHaveAttribute("data-current", "false")
  expect(screen.getByTestId("preview")).toHaveTextContent("The server rejected a save against this preview")
  expect(shortlistTitles()).toEqual(["Sneaker drop this Friday full headline here"])
  expect(research().getByLabelText("Name for the saved show")).toHaveValue("Stale check")
  expect(saved.size).toBe(0)

  // Previewing again without refreshing is refused as well; the old preview stays marked, not silently replaced.
  await previewNow()
  expect(status()).toMatch(/^Preview not possible: Selected research changed/)
  expect(screen.getByTestId("preview")).toHaveAttribute("data-current", "false")
  fireEvent.click(research().getByRole("button", { name: "Refresh" }))
  await flush()
  await previewNow()
  expect(screen.getByTestId("preview")).toHaveAttribute("data-current", "true")
  expect(research().getByRole("button", { name: "Save as show" })).toBeEnabled()
  noLiveOrInboxWrites()
})

test("more pins than slots is reported, never partially applied", async () => {
  await renderResearch()
  await addToShortlist("audience")
  fireEvent.change(research().getByLabelText("How many"), { target: { value: "0" } })
  expect(research().getByRole("button", { name: "Suggest shortlist" })).toBeDisabled()
  stories.get("runway")!.preferences = prefs({ revision: 1, pinned: true })
  fireEvent.change(research().getByLabelText("How many"), { target: { value: "1" } })
  fireEvent.click(research().getByRole("button", { name: "Suggest shortlist" }))
  await flush()
  expect(status()).toBe("No suggestion: More pinned topics than requested slots. Increase the count or unpin topics.")
  expect(shortlistTitles()).toEqual(["Audience questions full headline here"])
  expect(screen.queryByRole("dialog")).toBeNull()
})
