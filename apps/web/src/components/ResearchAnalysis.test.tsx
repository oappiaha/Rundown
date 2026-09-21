import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import App from "../App"
import type { AnalysisRun, AnalysisSettings, ResearchItem, ResearchPreferences, ResearchSelection, SavedShow, ShowState } from "../lib/api"

// The optional AI analysis panel exercised through the real Research view.
// The fake server follows the frozen /research/ai contract: an exact input
// preview with a hash, a generate call idempotent per request id (same body
// returns the same run without a second provider call, a different body is a
// 409), input/running/config/limit blockers, a failed run as a normal 200,
// a stale flag on the latest run and a proposal that returns ORIGINAL local
// metadata. Held responses reproduce slow and lost answers.

type Call = { method: string; url: string; body?: unknown }
type StoredRun = { run: AnalysisRun; payload: string }

let live: ShowState
let stories: Map<string, ResearchItem>
let runs: Map<string, StoredRun>
let settings: AnalysisSettings
let providerCalls: number
let calls: Call[]
let holdPattern: RegExp | null
let held: Array<() => void>
/** When set, POST /research/ai/generate fails at the network level (no response); when "swallow", the server still records the run. */
let failGenerate: false | "drop" | "swallow"
let saved: Map<string, SavedShow>
let ids: number

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

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

function checkSelections(selections: ResearchSelection[]): Response | null {
  if (!Array.isArray(selections) || selections.length === 0 || selections.length > 20) return json({ detail: "Choose 1 to 20 topics." }, 422)
  if (new Set(selections.map((entry) => entry.id)).size !== selections.length) return json({ detail: "Each selected topic must appear only once." }, 422)
  for (const chosen of selections) {
    const item = stories.get(chosen.id)
    if (!item) return json({ detail: "Topic not found." }, 404)
    if (item.revision !== chosen.revision || item.preferences.revision !== chosen.preference_revision) return json({ detail: "Selected research changed. Refresh the shortlist and preview again." }, 409)
    if (item.preferences.excluded) return json({ detail: "An excluded topic cannot be added. Change its curation first." }, 409)
  }
  return null
}

function inputText(brief: string, selections: ResearchSelection[]): string {
  return JSON.stringify({ brief, stories: selections.map((chosen) => ({ id: chosen.id, title: stories.get(chosen.id)!.full_title, context: stories.get(chosen.id)!.notes, manual_category: stories.get(chosen.id)!.preferences.category })) })
}

/** A deterministic stand-in for sha256: stable per text, distinct across the texts used here. */
function hashOf(text: string): string {
  let h = 0
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h.toString(16).padStart(8, "0").repeat(8)
}

/** Fixture behaviour: descending scores, the first two grouped, "invalid" in the brief fails. */
function assess(brief: string, selections: ResearchSelection[]): Pick<AnalysisRun, "status" | "items" | "error"> {
  if (brief.toLowerCase().includes("invalid")) return { status: "failed", items: [], error: "Provider returned invalid or incomplete analysis. No stories were changed." }
  return {
    status: "succeeded",
    error: null,
    items: selections.map((chosen, index) => ({ id: chosen.id, score: 95 - index * 3, category: "ai-innovation", group_id: index < 2 ? selections[0]!.id : chosen.id, reason: "Fixture: this saved story matters to independent creators." })),
  }
}

function detail(stored: StoredRun): AnalysisRun {
  const stale = checkSelections(stored.run.selections) !== null || hashOf(inputText(stored.run.brief, stored.run.selections)) !== hashOf(inputText(stored.run.brief, stored.run.selections))
  return { ...stored.run, stale: stale || stored.run.selections.some((chosen) => checkSelections([chosen]) !== null) }
}

function latestRun(): AnalysisRun | null {
  const list = [...runs.values()].sort((a, b) => b.run.started_at.localeCompare(a.run.started_at))
  return list[0] ? detail(list[0]) : null
}

function maybeHold(key: string, response: Response): Promise<Response> | Response {
  if (!holdPattern || !holdPattern.test(key)) return response
  return new Promise<Response>((resolve) => held.push(() => resolve(response)))
}

let clock: number

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  live = { revision: 3, topics: [{ id: "a", text: "Opening", duration: 120, notes: "" }], current_topic_id: "a", remaining_seconds: 100, paused: true, server_time: "2026-09-14T00:00:00.000Z" }
  stories = new Map(
    [
      story("movie", "New movie trailer", "film-entertainment", { preferences: prefs({ revision: 2, priority: 3, pinned: true }) }),
      story("ai1", "AI tools for creators", "ai-innovation"),
      story("ai2", "Creator model unveiled", "ai-innovation"),
      story("sneaker", "Sneaker drop this Friday", "fashion-drops", { preferences: prefs({ revision: 1, category: "fashion-industry" }) }),
      story("meme", "Viral meme of the week", "brain-rot", { preferences: prefs({ revision: 1, excluded: true }) }),
    ].map((item) => [item.id, item]),
  )
  runs = new Map()
  settings = { ready: true, reason: null, mode: "fixture", model: "fixture-model", daily_limit: 5, used_today: 0, remaining_today: 5, max_stories: 20, max_output_tokens: 5000 }
  providerCalls = 0
  calls = []
  holdPattern = null
  held = []
  failGenerate = false
  saved = new Map()
  ids = 0
  clock = 0
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
    calls.push({ method, url, body })
    const key = `${method} ${url}`
    if (url.endsWith("/rundown/state")) return json(live)
    if (url === "/research" && method === "GET") return json({ categories: CATEGORIES, method: "local-rules-v1", items: ranked() })
    if (url === "/research/ai" && method === "GET") return maybeHold(key, json({ settings: { ...settings, remaining_today: Math.max(0, settings.daily_limit - settings.used_today) }, latest_run: latestRun() }))
    const runMatch = /^\/research\/ai\/runs\/([^/]+)$/.exec(url)
    if (runMatch && method === "GET") {
      const stored = runs.get(decodeURIComponent(runMatch[1] ?? ""))
      return stored ? maybeHold(key, json(detail(stored))) : json({ detail: "Analysis not found." }, 404)
    }
    if (url === "/research/ai/input" && method === "POST") {
      const payload = body as { brief: string; selections: ResearchSelection[] }
      if (typeof payload.brief !== "string" || payload.brief.trim().length < 10) return json({ detail: "Describe the show angle in at least 10 characters." }, 422)
      const rejected = checkSelections(payload.selections)
      if (rejected) return rejected
      const text = inputText(payload.brief, payload.selections)
      return maybeHold(key, json({ input_text: text, input_hash: hashOf(text), settings, input_truncated: false }))
    }
    if (url === "/research/ai/generate" && method === "POST") {
      if (failGenerate === "drop") throw new TypeError("Failed to fetch")
      const payload = body as { brief: string; selections: ResearchSelection[]; request_id: string; input_hash: string; consent: unknown }
      const payloadKey = JSON.stringify({ brief: payload.brief, selections: payload.selections, input_hash: payload.input_hash })
      const existing = runs.get(payload.request_id)
      if (existing) {
        if (existing.payload !== payloadKey) return json({ detail: "This request ID belongs to a different analysis." }, 409)
        return maybeHold(key, json(detail(existing)))
      }
      if (payload.consent !== true) return json({ detail: "Explicit consent is required." }, 422)
      const rejected = checkSelections(payload.selections)
      if (rejected) return rejected
      if (hashOf(inputText(payload.brief, payload.selections)) !== payload.input_hash) return json({ detail: "Analysis input changed. Preview the input again." }, 409)
      if (!settings.ready) return json({ detail: settings.reason }, 503)
      if ([...runs.values()].some((stored) => stored.run.status === "running")) return json({ detail: "Another research analysis is running. Refresh its result first." }, 409)
      if (settings.used_today >= settings.daily_limit) return json({ detail: "Daily research analysis limit reached; resets at midnight UTC." }, 429)
      settings.used_today += 1
      providerCalls += 1
      clock += 1
      const run: AnalysisRun = { id: payload.request_id, brief: payload.brief, selections: payload.selections, started_at: `2026-09-15T10:00:${String(clock).padStart(2, "0")}Z`, model: settings.model, mode: settings.mode, stale: false, input_tokens: 300, output_tokens: 150, ...assess(payload.brief, payload.selections) }
      runs.set(payload.request_id, { run, payload: payloadKey })
      if (failGenerate === "swallow") throw new TypeError("Failed to fetch")
      return maybeHold(key, json(detail(runs.get(payload.request_id)!)))
    }
    const proposeMatch = /^\/research\/ai\/runs\/([^/]+)\/propose$/.exec(url)
    if (proposeMatch && method === "POST") {
      const stored = runs.get(decodeURIComponent(proposeMatch[1] ?? ""))
      if (!stored) return json({ detail: "Analysis not found." }, 404)
      const current = detail(stored)
      if (current.status !== "succeeded" || current.stale) return json({ detail: "Analysis is unavailable or stale. Analyze the current stories again." }, 409)
      const payload = body as { count: number }
      const byId = new Map(ranked().map((item) => [item.id, item]))
      const scored = current.items.map((entry) => ({ entry, item: byId.get(entry.id)! })).sort((a, b) => Number(b.item.preferences.pinned) - Number(a.item.preferences.pinned) || b.item.preferences.priority - a.item.preferences.priority || b.entry.score - a.entry.score)
      const groups = new Set<string>()
      const picked: ResearchItem[] = []
      for (const { entry, item } of scored) {
        if (picked.length >= payload.count || groups.has(entry.group_id)) continue
        groups.add(entry.group_id)
        picked.push(item) // ORIGINAL local metadata, never the AI score
      }
      const warnings = picked.length < payload.count ? [`Only ${picked.length} distinct eligible stories are available.`] : []
      warnings.push("AI suggestions need review. Reorder, add or remove stories before saving.")
      return json({ items: picked, warnings, method: "ai-research-v1" })
    }
    if (url === "/research/preview" && method === "POST") {
      const payload = body as { selections: ResearchSelection[] }
      const rejected = checkSelections(payload.selections)
      if (rejected) return rejected
      const topics = payload.selections.map((chosen) => ({ text: stories.get(chosen.id)!.text, duration: 120, notes: stories.get(chosen.id)!.notes }))
      return json({ topics, total_seconds: topics.length * 120, method: "saved-context", warnings: ["Uses saved titles, durations and context. No AI text has been generated."] })
    }
    if (url === "/research/shows" && method === "POST") {
      const payload = body as { name: string; selections: ResearchSelection[]; request_id: string }
      const rejected = checkSelections(payload.selections)
      if (rejected) return rejected
      const id = `show-${++ids}`
      const show: SavedShow = { id, name: payload.name, revision: 1, topics: payload.selections.map((chosen, index) => ({ id: `${id}-t${index + 1}`, text: stories.get(chosen.id)!.text, duration: 120, notes: stories.get(chosen.id)!.notes })), created_at: "2026-09-15T01:00:00Z", updated_at: "2026-09-15T01:00:00Z" }
      saved.set(id, show)
      return json(show, 201)
    }
    if (url === "/shows" && method === "GET") return json({ shows: [] })
    if (url.startsWith("/inbox")) return json({ items: [] })
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
  expect(await screen.findAllByTestId("story-row")).toHaveLength(5)
}

function panel() {
  return within(screen.getByTestId("ai-panel"))
}

function research() {
  return within(document.getElementById("research")!)
}

async function openPanel() {
  fireEvent.click(panel().getByRole("button", { name: /AI analysis · optional/ }))
  await flush()
}

function aiStatus() {
  return screen.getByTestId("ai-status").textContent ?? ""
}

function shortlistTitles(): string[] {
  return [...document.querySelectorAll('[data-testid="shortlist-row"] [data-testid="shortlist-title"]')].map((node) => node.textContent ?? "")
}

function requestsTo(method: string, pattern: RegExp) {
  return calls.filter((call) => call.method === method && pattern.test(call.url))
}

function generateBodies() {
  return requestsTo("POST", /\/research\/ai\/generate$/).map((call) => call.body as { brief: string; selections: ResearchSelection[]; request_id: string; input_hash: string; consent: unknown })
}

function noWritesOutsideResearch() {
  expect(calls.filter((call) => call.method !== "GET" && !call.url.startsWith("/research"))).toEqual([])
}

function tick(title: string) {
  fireEvent.click(panel().getByLabelText(`Analyze ${title}`))
}

async function setBrief(text: string) {
  fireEvent.change(panel().getByLabelText("Show brief"), { target: { value: text } })
  await flush()
}

async function previewInput() {
  fireEvent.click(panel().getByRole("button", { name: "Preview AI input" }))
  await flush()
}

function consent() {
  fireEvent.click(panel().getByLabelText(/4 · Send this exact input/))
}

function analyzeButton() {
  return panel().getByRole("button", { name: /^(Analyze with AI|Analyze again|Analyzing…)$/ })
}

async function analyze() {
  fireEvent.click(analyzeButton())
  await flush()
}

async function readyToAnalyze(brief = "Tonight: AI news that matters to independent creators") {
  tick("AI tools for creators full headline here")
  tick("Creator model unveiled full headline here")
  tick("Sneaker drop this Friday full headline here")
  await setBrief(brief)
  await previewInput()
  consent()
  await flush()
}

const SELECTIONS: ResearchSelection[] = [
  { id: "ai1", revision: 1, preference_revision: 0 },
  { id: "ai2", revision: 1, preference_revision: 0 },
  { id: "sneaker", revision: 1, preference_revision: 1 },
]

test("the panel is separate from local research: collapsed with its setup line, no ticks by default, excluded stories blocked, the bound enforced, the brief validated, and no analysis request until the flow is followed", async () => {
  await renderResearch()
  expect(research().getByText(/AI analysis is optional and separate/)).toBeInTheDocument()
  expect(screen.getByTestId("ai-summary")).toHaveTextContent("Test fixture · fixture-model")
  expect(requestsTo("GET", /^\/research\/ai$/)).toHaveLength(1)
  await openPanel()
  expect(screen.getByTestId("ai-fixture-badge")).toBeInTheDocument()
  expect(screen.getByTestId("ai-config-meta")).toHaveTextContent("fixture-model · 0 of 5 analyses used today · 5 left")
  expect(screen.getByTestId("ai-choice-count")).toHaveTextContent("0 of 20 ticked · 1 story excluded and blocked")
  expect(panel().getAllByRole("checkbox", { name: /^Analyze / }).filter((box) => (box as HTMLInputElement).checked)).toHaveLength(0)
  expect(panel().getByLabelText("Analyze Viral meme of the week full headline here")).toBeDisabled()
  expect(analyzeButton()).toBeDisabled()
  expect(aiStatus()).toBe("Tick at least one story to analyze.")

  tick("AI tools for creators full headline here")
  expect(aiStatus()).toBe("Describe the show angle in at least 10 characters.")
  expect(panel().getByRole("button", { name: "Preview AI input" })).toBeDisabled()
  await setBrief("too short")
  expect(panel().getByRole("button", { name: "Preview AI input" })).toBeDisabled()
  await setBrief("A long enough brief for tonight")
  expect(aiStatus()).toBe("Preview the exact input before analyzing.")
  expect(panel().getByLabelText(/4 · Send this exact input/)).toBeDisabled()
  expect(requestsTo("POST", /\/research\/ai/)).toHaveLength(0)

  // The bound: 20 more stories exist after a refresh; the 21st box is disabled, ticked ones stay editable.
  for (let index = 0; index < 22; index += 1) stories.set(`extra${index}`, story(`extra${index}`, `Extra story ${index}`, "uncategorized"))
  fireEvent.click(research().getByRole("button", { name: "Refresh" }))
  await flush()
  for (let index = 0; index < 19; index += 1) tick(`Extra story ${index} full headline here`)
  expect(screen.getByTestId("ai-choice-count")).toHaveTextContent("20 of 20 ticked")
  expect(panel().getByLabelText("Analyze Extra story 19 full headline here")).toBeDisabled()
  expect(panel().getByLabelText("Analyze Extra story 3 full headline here")).toBeEnabled()
  fireEvent.click(panel().getByRole("button", { name: "Untick all" }))
  expect(screen.getByTestId("ai-choice-count")).toHaveTextContent("0 of 20 ticked")
  noWritesOutsideResearch()
})

test("switched off: the reason is shown without any key or setup code, the flow up to the preview still works, and Analyze stays blocked with no generate request", async () => {
  settings = { ...settings, ready: false, reason: "Configure an Anthropic API key on the API server.", mode: "anthropic", model: "claude-sonnet-5" }
  await renderResearch()
  expect(screen.getByTestId("ai-summary")).toHaveTextContent("Off")
  await openPanel()
  expect(screen.getByTestId("ai-ready-badge")).toHaveTextContent("Off")
  expect(screen.getByTestId("ai-setup")).toHaveTextContent("Not available: Configure an Anthropic API key on the API server. Ask the server owner to configure the Anthropic key and model on the API")
  expect(document.body.textContent).not.toMatch(/ANTHROPIC_API_KEY|\.env/)
  tick("AI tools for creators full headline here")
  await setBrief("A long enough brief for tonight")
  await previewInput()
  expect(screen.getByTestId("ai-input")).toHaveAttribute("data-current", "true")
  expect(panel().getByLabelText(/4 · Send this exact input to Anthropic \(claude-sonnet-5\)/)).toBeEnabled()
  consent()
  expect(analyzeButton()).toBeDisabled()
  expect(analyzeButton()).toHaveAttribute("title", "Configure an Anthropic API key on the API server.")
  expect(requestsTo("POST", /generate$/)).toHaveLength(0)
  noWritesOutsideResearch()
})

test("full flow: the exact input is previewed for the ticked stories, consent gates a single deliberate generate with a request id and the previewed hash, the result shows titles, kept manual categories, groups and reasons, and an AI proposal goes through the replace dialog with original local metadata", async () => {
  await renderResearch()
  await openPanel()
  tick("AI tools for creators full headline here")
  tick("Creator model unveiled full headline here")
  tick("Sneaker drop this Friday full headline here")
  await setBrief("  Tonight: AI news that matters to independent creators  ")
  expect(screen.getByTestId("ai-choice-count")).toHaveTextContent("3 of 20 ticked")
  await previewInput()
  expect(requestsTo("POST", /\/research\/ai\/input$/).map((call) => call.body)).toEqual([{ brief: "Tonight: AI news that matters to independent creators", selections: SELECTIONS }])
  const input = screen.getByTestId("ai-input")
  expect(input).toHaveAttribute("data-current", "true")
  expect(within(input).getByText(/Exact text to send · \d+ characters · 3 stories/)).toBeInTheDocument()
  expect(screen.getByTestId("ai-input-text")).toHaveTextContent('"brief":"Tonight: AI news that matters to independent creators"')
  expect(screen.getByTestId("ai-input-text")).toHaveTextContent("Sneaker drop this Friday full headline here")
  expect(aiStatus()).toMatch(/^Input ready · \d+ characters for 3 stories\. Nothing was sent\./)
  expect(analyzeButton()).toBeDisabled()
  expect(analyzeButton()).toHaveAttribute("title", "Tick the consent box to send this input.")

  consent()
  expect(analyzeButton()).toBeEnabled()
  expect(requestsTo("POST", /generate$/)).toHaveLength(0)
  await analyze()
  const sent = generateBodies()
  expect(sent).toHaveLength(1)
  expect(sent[0]).toEqual({ brief: "Tonight: AI news that matters to independent creators", selections: SELECTIONS, request_id: sent[0]!.request_id, input_hash: hashOf(inputText("Tonight: AI news that matters to independent creators", SELECTIONS)), consent: true })
  expect(sent[0]!.request_id).toMatch(/^[0-9a-f-]{36}$/)
  expect(providerCalls).toBe(1)
  expect(aiStatus()).toBe("Analysis ready · 3 stories scored by the test fixture. Suggestions only: nothing was changed or saved.")
  // Consent is spent: a second press cannot happen from the residual tick.
  expect(panel().getByLabelText(/4 · Send this exact input/)).not.toBeChecked()
  expect(analyzeButton()).toBeDisabled()

  const run = screen.getByTestId("ai-run")
  expect(run).toHaveAttribute("data-status", "succeeded")
  expect(run).toHaveAttribute("data-usable", "true")
  expect(run).toHaveTextContent("Analysis · fixture-model · test fixture, no real provider · succeeded")
  expect(run).toHaveTextContent("300 in / 150 out tokens")
  expect(screen.getByTestId("ai-run-brief")).toHaveTextContent("Tonight: AI news that matters to independent creators")
  const rows = screen.getAllByTestId("ai-row")
  expect(rows.map((row) => within(row).getByTestId("ai-row-title").textContent)).toEqual(["AI tools for creators full headline here", "Creator model unveiled full headline here", "Sneaker drop this Friday full headline here"])
  expect(rows[0]).toHaveTextContent("95")
  expect(within(rows[0]!).getByTestId("ai-row-category")).toHaveTextContent("AI suggests AI innovation")
  expect(within(rows[0]!).getByTestId("ai-row-group")).toHaveTextContent("Represents 2 stories on the same event")
  expect(within(rows[1]!).getByTestId("ai-row-group")).toHaveTextContent('Same event as "AI tools for creators full headline here"')
  expect(within(rows[2]!).queryByTestId("ai-row-group")).toBeNull()
  // The manual category wins in the display; the AI's differing suggestion is only shown.
  expect(within(rows[2]!).getByTestId("ai-row-category")).toHaveTextContent("Your category: Fashion industry · kept (AI suggested AI innovation)")
  expect(within(rows[0]!).getByTestId("ai-row-reason")).toHaveTextContent("Fixture: this saved story matters to independent creators.")
  expect(screen.getByTestId("ai-groups")).toHaveTextContent("AI tools for creators full headline here · 2 stories: AI tools for creators full headline here · Creator model unveiled full headline here")
  expect(document.body.textContent).not.toMatch(/\brev(ision)?\b/i)
  // The local ranking on the left is untouched by the analysis.
  expect(within(document.querySelector<HTMLElement>('[data-testid="story-row"][data-story-id="ai1"]')!).getByText("score 25")).toBeInTheDocument()

  // Propose from AI with a shortlist already there: the same guarded dialog; Keep leaves it alone, Replace adopts original metadata.
  fireEvent.click(within(document.querySelector<HTMLElement>('[data-testid="story-row"][data-story-id="movie"]')!).getByRole("button", { name: "Add" }))
  expect(shortlistTitles()).toEqual(["New movie trailer full headline here"])
  expect(panel().getByLabelText("AI shortlist size")).toHaveValue(3)
  fireEvent.change(panel().getByLabelText("AI shortlist size"), { target: { value: "2" } })
  fireEvent.click(panel().getByRole("button", { name: "Suggest shortlist from AI" }))
  await flush()
  expect(requestsTo("POST", /propose$/).map((call) => [call.url, call.body])).toEqual([[`/research/ai/runs/${sent[0]!.request_id}/propose`, { count: 2 }]])
  const dialog = screen.getByRole("dialog")
  expect(dialog).toHaveTextContent("Replace the shortlist?")
  expect(dialog).toHaveTextContent("AI suggestions need review. Reorder, add or remove stories before saving.")
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep my shortlist" }))
  expect(shortlistTitles()).toEqual(["New movie trailer full headline here"])
  fireEvent.click(panel().getByRole("button", { name: "Suggest shortlist from AI" }))
  await flush()
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Replace shortlist" }))
  await flush()
  // AI rank, one per same-event group: ai1 (95) then sneaker (89); ai2 shares ai1's group.
  expect(shortlistTitles()).toEqual(["AI tools for creators full headline here", "Sneaker drop this Friday full headline here"])
  expect(within(document.querySelector<HTMLElement>('[data-testid="story-row"][data-story-id="ai1"]')!).getByText("score 25")).toBeInTheDocument()

  // The existing composer takes over: reorder, preview and save through the existing show API.
  fireEvent.click(research().getByRole("button", { name: "Move shortlist item 2 up" }))
  fireEvent.change(research().getByLabelText("Name for the saved show"), { target: { value: "AI assisted" } })
  fireEvent.click(research().getByRole("button", { name: "Preview show" }))
  await flush()
  expect(screen.getAllByTestId("preview-row")[0]).toHaveTextContent("Sneaker drop this Friday")
  fireEvent.click(research().getByRole("button", { name: "Save as show" }))
  await flush()
  expect(saved.size).toBe(1)
  expect([...saved.values()][0]!.topics.map((topic) => topic.text)).toEqual(["Sneaker drop this Friday", "AI tools for creators"])
  expect(live.revision).toBe(3)
  expect(providerCalls).toBe(1)
  noWritesOutsideResearch()
})

test("changing the ticks or the brief invalidates the preview and the consent; the request is frozen to the previewed input; a different body with the same request id never goes out", async () => {
  await renderResearch()
  await openPanel()
  await readyToAnalyze()
  expect(analyzeButton()).toBeEnabled()
  tick("New movie trailer full headline here")
  expect(screen.getByTestId("ai-input")).toHaveAttribute("data-current", "false")
  expect(screen.getByTestId("ai-input")).toHaveTextContent("out of date")
  expect(panel().getByLabelText(/4 · Send this exact input/)).not.toBeChecked()
  expect(panel().getByLabelText(/4 · Send this exact input/)).toBeDisabled()
  expect(analyzeButton()).toBeDisabled()
  expect(aiStatus()).toBe("Preview the exact input before analyzing.")
  tick("New movie trailer full headline here")
  // Back to the previewed input: the preview applies again, consent is asked again.
  expect(screen.getByTestId("ai-input")).toHaveAttribute("data-current", "true")
  expect(analyzeButton()).toBeDisabled()
  await setBrief("Tonight: AI news that matters to independent creators!")
  expect(screen.getByTestId("ai-input")).toHaveAttribute("data-current", "false")
  await previewInput()
  consent()
  await analyze()
  expect(generateBodies()[0]!.brief).toBe("Tonight: AI news that matters to independent creators!")
  expect(providerCalls).toBe(1)

  // A new deliberate analysis of a changed input uses a fresh request id (the old one stays terminal on the server).
  await setBrief("Tonight: AI news that matters to independent creators")
  await previewInput()
  consent()
  await analyze()
  const bodies = generateBodies()
  expect(bodies).toHaveLength(2)
  expect(bodies[1]!.request_id).not.toBe(bodies[0]!.request_id)
  expect(providerCalls).toBe(2)
  noWritesOutsideResearch()
})

test("blockers keep the brief and ticks: a stale input (409) marks the preview and refreshes the stories, the daily limit (429) and a switched-off provider (503) are explained, a failed run is shown with its error and never retried by itself, and a stale proposal (409) leaves the shortlist alone", async () => {
  await renderResearch()
  await openPanel()
  await readyToAnalyze()
  // The story moved on another screen after the preview.
  stories.get("ai1")!.revision = 2
  await analyze()
  expect(aiStatus()).toBe("Not analyzed: Selected research changed. Refresh the shortlist and preview again. Your brief and ticks are kept; preview the input again.")
  expect(screen.getByTestId("ai-input")).toHaveAttribute("data-current", "false")
  expect(panel().getByLabelText("Show brief")).toHaveValue("Tonight: AI news that matters to independent creators")
  expect(screen.getByTestId("ai-choice-count")).toHaveTextContent("3 of 20 ticked")
  expect(requestsTo("GET", /^\/research$/)).toHaveLength(2)
  expect(providerCalls).toBe(0)
  await previewInput()
  expect(screen.getByTestId("ai-input")).toHaveAttribute("data-current", "true")

  settings.used_today = 5
  consent()
  await analyze()
  expect(aiStatus()).toBe("Not analyzed: Daily research analysis limit reached; resets at midnight UTC. Your brief and ticks are kept.")
  expect(screen.getByTestId("ai-config-meta")).toHaveTextContent("5 of 5 analyses used today · 0 left")
  expect(analyzeButton()).toHaveAttribute("title", "The daily analysis limit is reached; it resets at midnight UTC.")
  settings.used_today = 0
  settings = { ...settings, ready: false, reason: "AI research is disabled. Enable it in the API configuration." }
  fireEvent.click(panel().getByRole("button", { name: "Refresh status" }))
  await flush()
  expect(analyzeButton()).toHaveAttribute("title", "AI research is disabled. Enable it in the API configuration.")
  settings = { ...settings, ready: true, reason: null }
  fireEvent.click(panel().getByRole("button", { name: "Refresh status" }))
  await flush()
  expect(providerCalls).toBe(0)

  // A failed run comes back as a normal answer: shown, not retried; Analyze again needs consent and gets a new id.
  await setBrief("Invalid analysis for testing")
  await previewInput()
  consent()
  await analyze()
  expect(providerCalls).toBe(1)
  expect(screen.getByTestId("ai-run")).toHaveAttribute("data-status", "failed")
  expect(screen.getByTestId("ai-run-error")).toHaveTextContent("Failed. Provider returned invalid or incomplete analysis. No stories were changed. Start a new analysis when ready; this one is not retried by itself.")
  expect(aiStatus()).toMatch(/^The analysis failed: Provider returned invalid or incomplete analysis/)
  expect(panel().queryByRole("button", { name: "Suggest shortlist from AI" })).toBeNull()
  expect(panel().getByLabelText("Show brief")).toHaveValue("Invalid analysis for testing")
  await flush(5000)
  expect(providerCalls).toBe(1)
  expect(analyzeButton()).toHaveTextContent("Analyze again")
  expect(analyzeButton()).toBeDisabled()
  consent()
  await analyze()
  expect(providerCalls).toBe(2)
  const bodies = generateBodies()
  expect(bodies[bodies.length - 1]!.request_id).not.toBe(bodies[bodies.length - 2]!.request_id)

  // A good run, then the analysed story is curated elsewhere: the server refuses the proposal, the shortlist stays.
  await setBrief("Tonight: AI news that matters to independent creators")
  await previewInput()
  consent()
  await analyze()
  expect(screen.getByTestId("ai-run")).toHaveAttribute("data-usable", "true")
  fireEvent.click(within(document.querySelector<HTMLElement>('[data-testid="story-row"][data-story-id="movie"]')!).getByRole("button", { name: "Add" }))
  stories.get("sneaker")!.preferences = prefs({ revision: 2, category: "fashion-industry", priority: 1 })
  fireEvent.click(panel().getByRole("button", { name: "Suggest shortlist from AI" }))
  await flush()
  expect(aiStatus()).toBe("No AI suggestion: Analysis is unavailable or stale. Analyze the current stories again. Your shortlist, brief and ticks are kept.")
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(shortlistTitles()).toEqual(["New movie trailer full headline here"])
  expect(screen.getByTestId("ai-run")).toHaveAttribute("data-usable", "false")
  expect(screen.getByTestId("ai-run-stale")).toBeInTheDocument()
  expect(panel().getByRole("button", { name: "Suggest shortlist from AI" })).toBeDisabled()
  expect(panel().getByLabelText("Show brief")).toHaveValue("Tonight: AI news that matters to independent creators")
  expect(screen.getByTestId("ai-choice-count")).toHaveTextContent("3 of 20 ticked")
  expect(providerCalls).toBe(3)
  noWritesOutsideResearch()
})

test("lost answer: a double press sends one request; a dropped answer is recovered by looking up the exact request id (found: adopted with no new call; missing: resent verbatim with the same id), and forgetting it gives the next analysis a fresh id", async () => {
  await renderResearch()
  await openPanel()
  await readyToAnalyze()

  // Case A: the answer is slow; a double press does not send twice and the composer is frozen meanwhile.
  holdPattern = /^POST \/research\/ai\/generate$/
  fireEvent.click(analyzeButton())
  fireEvent.click(analyzeButton())
  await flush()
  expect(analyzeButton()).toHaveTextContent("Analyzing…")
  expect(panel().getByLabelText("Analyze New movie trailer full headline here")).toBeDisabled()
  expect(panel().getByLabelText("Show brief")).toBeDisabled()
  expect(research().getByRole("button", { name: "Suggest shortlist" })).toBeDisabled()
  expect(held).toHaveLength(1)
  held.forEach((release) => release())
  held = []
  await flush()
  expect(generateBodies()).toHaveLength(1)
  expect(providerCalls).toBe(1)
  expect(screen.getByTestId("ai-run")).toHaveAttribute("data-status", "succeeded")
  holdPattern = null

  // Case B: the request reached the server but the answer was lost. Check status finds it by id and adopts it.
  await setBrief("Second brief for the very same stories")
  await previewInput()
  consent()
  failGenerate = "swallow"
  await analyze()
  failGenerate = false
  expect(screen.getByTestId("ai-ambiguous")).toBeInTheDocument()
  expect(aiStatus()).toMatch(/^No answer from the RUNDOWN API/)
  expect(analyzeButton()).toBeDisabled()
  const lostId = generateBodies()[1]!.request_id
  // Another analysis became the latest on another screen meanwhile: the exact id is still what gets looked up.
  runs.set("elsewhere", { run: { id: "elsewhere", brief: "Made elsewhere", selections: SELECTIONS, started_at: "2026-09-15T11:00:00Z", model: "fixture-model", mode: "fixture", stale: false, input_tokens: 1, output_tokens: 1, ...assess("Made elsewhere", SELECTIONS) }, payload: "x" })
  fireEvent.click(panel().getByRole("button", { name: "Check status" }))
  await flush()
  expect(requestsTo("GET", new RegExp(`/research/ai/runs/${lostId}$`))).toHaveLength(1)
  expect(panel().queryByTestId("ai-ambiguous")).toBeNull()
  expect(screen.getByTestId("ai-run-brief")).toHaveTextContent("Second brief for the very same stories")
  expect(aiStatus()).toBe("The earlier request had reached the API; its analysis (succeeded) is shown below. Nothing was sent again.")
  expect(providerCalls).toBe(2)
  expect(generateBodies()).toHaveLength(2)

  // Case C: the request never reached the server. Resend looks it up (404) and then sends the identical body with the same id.
  await setBrief("Third brief for the very same stories")
  await previewInput()
  consent()
  failGenerate = "drop"
  await analyze()
  failGenerate = false
  const droppedId = generateBodies()[2]!.request_id
  fireEvent.click(panel().getByRole("button", { name: "Resend the same request" }))
  await flush()
  expect(requestsTo("GET", new RegExp(`/research/ai/runs/${droppedId}$`))).toHaveLength(1)
  const bodies = generateBodies()
  expect(bodies).toHaveLength(4)
  expect(bodies[3]).toEqual(bodies[2])
  expect(bodies[3]!.request_id).toBe(droppedId)
  expect(panel().queryByTestId("ai-ambiguous")).toBeNull()
  expect(screen.getByTestId("ai-run-brief")).toHaveTextContent("Third brief for the very same stories")
  expect(providerCalls).toBe(3)

  // Case D: input changed since the dropped request: resend refused, forget gives a fresh id.
  await setBrief("Fourth brief for the very same stories")
  await previewInput()
  consent()
  failGenerate = "drop"
  await analyze()
  failGenerate = false
  const fourthId = generateBodies()[4]!.request_id
  await setBrief("Fourth brief for the very same stories, edited")
  fireEvent.click(panel().getByRole("button", { name: "Resend the same request" }))
  await flush()
  expect(aiStatus()).toBe("Not resent: the brief or the ticked stories changed since that request. Forget it to start a new analysis of the current input.")
  expect(generateBodies()).toHaveLength(5)
  fireEvent.click(panel().getByRole("button", { name: "Forget that request" }))
  await previewInput()
  consent()
  await analyze()
  expect(generateBodies()).toHaveLength(6)
  expect(generateBodies()[5]!.request_id).not.toBe(fourthId)
  expect(providerCalls).toBe(4)
  noWritesOutsideResearch()
})

test("a running analysis left from before a reload is recovered from status and followed by reading its id, never by a new generate; when it finishes the result is adopted and the brief can be reused explicitly", async () => {
  const running: AnalysisRun = { id: "left-running", status: "running", brief: "Started before the reload", selections: SELECTIONS, started_at: "2026-09-15T09:00:00Z", model: "fixture-model", mode: "fixture", stale: false, items: [], input_tokens: null, output_tokens: null, error: null }
  runs.set("left-running", { run: running, payload: "x" })
  await renderResearch()
  expect(screen.getByTestId("ai-summary")).toHaveTextContent("running")
  await openPanel()
  expect(screen.getByTestId("ai-run")).toHaveAttribute("data-status", "running")
  expect(aiStatus()).toBe("Analyzing… checking every few seconds.")
  expect(panel().getByLabelText(/4 · Send this exact input/)).toBeDisabled()
  await flush(4100)
  expect(requestsTo("GET", /\/research\/ai\/runs\/left-running$/)).toHaveLength(2)
  expect(requestsTo("POST", /generate$/)).toHaveLength(0)
  runs.set("left-running", { run: { ...running, ...assess(running.brief, SELECTIONS), input_tokens: 300, output_tokens: 150 }, payload: "x" })
  await flush(2100)
  expect(screen.getByTestId("ai-run")).toHaveAttribute("data-status", "succeeded")
  expect(screen.getAllByTestId("ai-row")).toHaveLength(3)
  await flush(4100)
  expect(requestsTo("GET", /\/research\/ai\/runs\/left-running$/)).toHaveLength(3)
  expect(providerCalls).toBe(0)

  // Nothing was ticked or typed by itself; the brief and stories are copied only on request.
  expect(screen.getByTestId("ai-choice-count")).toHaveTextContent("0 of 20 ticked")
  expect(panel().getByLabelText("Show brief")).toHaveValue("")
  fireEvent.click(panel().getByRole("button", { name: "Use its brief and stories" }))
  expect(panel().getByLabelText("Show brief")).toHaveValue("Started before the reload")
  expect(screen.getByTestId("ai-choice-count")).toHaveTextContent("3 of 20 ticked")
  expect(panel().getByLabelText("Analyze Sneaker drop this Friday full headline here")).toBeChecked()
  noWritesOutsideResearch()
})
