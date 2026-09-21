import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import InboxView from "./InboxView"
import type { InboxItem, PreparationConfig, PreparationRun, PreparationView } from "../lib/api"
import { UUID_RE } from "../lib/prepDraft"

// The assisted-preparation panel exercised through the real Inbox editor.
// The fetch mock is a small in-memory server following the frozen /inbox and
// /preparation contracts: revision guard, idempotent request ids, blockers
// (503/409/422/429), a failed run as a normal 200 answer, and held responses
// to reproduce slow provider calls.

type Call = { method: string; url: string; body?: unknown }

let inbox: Map<string, InboxItem>
let runs: Map<string, PreparationRun>
let config: PreparationConfig
let calls: Call[]
let clock: number
let holds: Map<string, Array<() => void>>
let holdPattern: RegExp | null
let truncatedIds: Set<string>

const FIXTURE_SUMMARY = "Independent producers can use new tools to reduce repetitive work."
const FIXTURE_POINTS = ["Which tasks take the most time?", "How does access affect smaller teams?", "What needs a human review?"]
const BLOCK = `Summary\n${FIXTURE_SUMMARY}\n\nTalking points\n${FIXTURE_POINTS.map((point) => `- ${point}`).join("\n")}`

function stamp(): string {
  clock += 1
  return new Date(Date.UTC(2026, 8, 15, 0, 0, clock)).toISOString()
}

function project(text: string, duration: number, notes: string, source_url: string) {
  return { text, duration, notes: `${notes}${notes && source_url ? "\n\n" : ""}${source_url ? `Source: ${source_url}` : ""}` }
}

function seedItem(id: string, text: string, notes: string, archived = false, source_url = ""): InboxItem {
  const at = stamp()
  const entry: InboxItem = { id, revision: 1, text, duration: 120, notes, source_url, archived, created_at: at, updated_at: at, topic: project(text, 120, notes, source_url), source: null }
  inbox.set(id, entry)
  return entry
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function inputFor(item: InboxItem): string {
  return `Title: ${item.text}\n\nSaved context:\n${item.notes}`
}

function latestRun(topicId: string): PreparationRun | null {
  const list = [...runs.values()].filter((run) => run.topic_id === topicId).sort((a, b) => b.started_at.localeCompare(a.started_at))
  return list[0] ?? null
}

function detail(run: PreparationRun, item: InboxItem): PreparationRun {
  return { ...run, stale: item.revision !== run.revision || item.archived }
}

function usedToday(): number {
  return runs.size
}

function cfg(): PreparationConfig {
  const used = usedToday()
  return { ...config, used_today: used, remaining_today: Math.max(0, config.daily_limit - used) }
}

function blocker(item: InboxItem): [number, string] | null {
  const c = cfg()
  if (!c.ready) return [503, c.reason ?? "off"]
  if (item.archived) return [409, "Restore this archived idea before generating."]
  if (item.notes.trim().length < 20) return [422, "Add at least 20 characters of context or import source text before generating."]
  const previous = latestRun(item.id)
  if (previous && previous.status === "running") return [409, "A draft is already being generated for this idea. Refresh to see its result."]
  if (c.remaining_today <= 0) return [429, "The daily generation limit has been reached. It resets at midnight UTC."]
  return null
}

function view(item: InboxItem): PreparationView {
  const reason = blocker(item)
  const run = latestRun(item.id)
  return {
    topic_id: item.id,
    revision: item.revision,
    input_text: inputFor(item),
    input_truncated: truncatedIds.has(item.id),
    can_generate: reason === null,
    reason: reason ? reason[1] : null,
    latest_run: run ? detail(run, item) : null,
    settings: cfg(),
  }
}

function serve(method: string, url: string, body: unknown): Response {
  const parsed = new URL(url, "http://test.local")
  const path = parsed.pathname
  if (path === "/inbox" && method === "GET") {
    const archived = parsed.searchParams.get("archived") === "true"
    return json({ items: [...inbox.values()].filter((entry) => entry.archived === archived) })
  }
  const inboxDetail = /^\/inbox\/([^/]+)(\/archive)?$/.exec(path)
  if (inboxDetail) {
    const entry = inbox.get(inboxDetail[1] ?? "")
    if (!entry) return json({ detail: "Inbox item not found." }, 404)
    if (method === "GET" && !inboxDetail[2]) return json(entry)
    if (method === "PUT" && !inboxDetail[2]) {
      const payload = body as { revision: number; text: string; duration: number; notes: string; source_url: string }
      if (payload.revision !== entry.revision) return json({ detail: "Inbox item changed on another screen." }, 409)
      if (typeof payload.notes !== "string" || Array.from(payload.notes).length > 10000) return json({ detail: "notes too long" }, 422)
      const next: InboxItem = { ...entry, revision: entry.revision + 1, text: payload.text, duration: payload.duration, notes: payload.notes, source_url: payload.source_url, updated_at: stamp(), topic: project(payload.text, payload.duration, payload.notes, payload.source_url) }
      inbox.set(entry.id, next)
      return json(next)
    }
  }
  if (path === "/preparation/status" && method === "GET") return json(cfg())
  const prepView = /^\/preparation\/topics\/([^/]+)$/.exec(path)
  if (prepView && method === "GET") {
    const entry = inbox.get(prepView[1] ?? "")
    if (!entry) return json({ detail: "Inbox item not found." }, 404)
    return json(view(entry))
  }
  const generate = /^\/preparation\/topics\/([^/]+)\/generate$/.exec(path)
  if (generate && method === "POST") {
    const entry = inbox.get(generate[1] ?? "")
    if (!entry) return json({ detail: "Inbox item not found." }, 404)
    const payload = body as { revision: unknown; request_id: unknown; consent: unknown }
    if (payload.consent !== true || typeof payload.request_id !== "string" || !UUID_RE.test(payload.request_id) || !Number.isInteger(payload.revision)) return json({ detail: "invalid generate request" }, 422)
    const existing = runs.get(payload.request_id)
    if (existing) {
      if (existing.topic_id !== entry.id || existing.revision !== payload.revision) return json({ detail: "This request ID belongs to a different generation." }, 409)
      return json(detail(existing, entry))
    }
    if (payload.revision !== entry.revision) return json({ detail: "Inbox item changed on another screen." }, 409)
    const reason = blocker(entry)
    if (reason) return json({ detail: reason[1] }, reason[0])
    const failed = entry.notes.includes("FIXTURE_ERROR")
    const run: PreparationRun = {
      id: payload.request_id,
      topic_id: entry.id,
      revision: entry.revision,
      status: failed ? "failed" : "succeeded",
      started_at: stamp(),
      finished_at: stamp(),
      model: config.model,
      summary: failed ? null : FIXTURE_SUMMARY,
      talking_points: failed ? [] : [...FIXTURE_POINTS],
      input_truncated: truncatedIds.has(entry.id),
      input_tokens: failed ? null : 123,
      output_tokens: failed ? null : 87,
      error: failed ? "The provider rejected the request (HTTP 503). Check API configuration or limits before retrying." : null,
      stale: false,
    }
    runs.set(run.id, run)
    return json(detail(run, entry))
  }
  return json({ detail: "Not Found" }, 404)
}

function maybeHold(key: string, response: Response): Promise<Response> | Response {
  if (!holdPattern || !holdPattern.test(key)) return response
  return new Promise<Response>((resolve) => {
    const list = holds.get(key) ?? []
    list.push(() => resolve(response))
    holds.set(key, list)
  })
}

function releaseAll(pattern: RegExp) {
  for (const [key, list] of holds) {
    if (!pattern.test(key)) continue
    for (const fn of list.splice(0)) fn()
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  inbox = new Map()
  runs = new Map()
  calls = []
  clock = 0
  holds = new Map()
  holdPattern = null
  truncatedIds = new Set()
  config = { enabled: true, ready: true, provider: "Local test fixture", model: "fixture-model", daily_limit: 10, used_today: 0, remaining_today: 10, max_input_chars: 12000, max_output_tokens: 1200, mode: "fixture", reason: null }
  seedItem("i1", "Rent strike", "tenants organising across the city\n- who\n- why", false, "https://example.com/rent")
  seedItem("i2", "Bus fares", "fares went up twice this year already")
  seedItem("i3", "Thin idea", "short")
  seedItem("i4", "Old idea", "archived but with plenty of context here", true)
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
    calls.push({ method, url, body })
    return maybeHold(`${method} ${url}`, serve(method, url, body))
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

async function renderInbox() {
  render(<InboxView hidden={false} />)
  await flush()
  expect(screen.getByRole("button", { name: "Open Rent strike" })).toBeInTheDocument()
}

/** The preparation tool is folded by default behind a toggle that carries its state; the panel underneath stays mounted either way. */
function prepToggle() {
  return screen.getByRole("button", { name: /^Assisted preparation/ })
}

/** Unfold the tool once; the open state persists while the Inbox view stays mounted. */
function openPrepTool() {
  if (prepToggle().getAttribute("aria-expanded") !== "true") fireEvent.click(prepToggle())
  expect(prepToggle()).toHaveAttribute("aria-expanded", "true")
}

async function openIdea(text: string) {
  fireEvent.click(screen.getByRole("button", { name: `Open ${text}` }))
  await flush()
  expect(screen.getByLabelText("Idea title")).toHaveValue(text)
  openPrepTool()
}

function panel() {
  return within(screen.getByTestId("preparation-panel"))
}

function prepStatus() {
  return screen.getByTestId("preparation-status")
}

function consent() {
  return panel().getByRole("checkbox")
}

function requests(method: string, pathStart: string) {
  return calls.filter((call) => call.method === method && new URL(call.url, "http://test.local").pathname.startsWith(pathStart))
}

function generateCalls(id = "i1") {
  return requests("POST", `/preparation/topics/${id}/generate`)
}

async function generateFor(id = "i1") {
  fireEvent.click(consent())
  fireEvent.click(screen.getByRole("button", { name: /Generate draft|Generate again|Try again/ }))
  await flush()
  return generateCalls(id)
}

test("saved idea: readiness, fixture badge and counts show; the input preview is the exact GET text; consent gates Generate; the draft is editable and appends exactly once into the local context, saved only by Save idea", async () => {
  await renderInbox()
  await openIdea("Rent strike")
  expect(panel().getByTestId("prep-fixture-badge")).toHaveTextContent("Test fixture")
  expect(panel().getByTestId("prep-ready-badge")).toHaveTextContent("Ready")
  expect(panel().getByTestId("prep-config-meta")).toHaveTextContent("Local test fixture · fixture-model · 0 of 10 requests used today (10 left; failed and interrupted attempts count) · no real provider is called")
  expect(panel().queryByTestId("prep-setup")).not.toBeInTheDocument()

  // Exact input preview, collapsed by default.
  expect(panel().queryByTestId("prep-input-text")).not.toBeInTheDocument()
  fireEvent.click(panel().getByRole("button", { name: "Preview the exact text to send" }))
  expect(panel().getByTestId("prep-input-text")).toHaveTextContent(inputFor(inbox.get("i1")!).replace(/\s+/g, " ").trim())
  expect(panel().getByTestId("prep-input-text").textContent).toBe(inputFor(inbox.get("i1")!))
  expect(panel().queryByTestId("prep-truncated")).not.toBeInTheDocument()

  // Consent is explicit and gates the button.
  const generate = screen.getByRole("button", { name: "Generate draft" })
  expect(generate).toBeDisabled()
  expect(consent()).not.toBeChecked()
  expect(panel().getByText("Send saved title, context and retained source text to the test fixture to generate a draft")).toBeInTheDocument()
  fireEvent.click(consent())
  expect(generate).toBeEnabled()
  fireEvent.click(generate)
  await flush()

  const [post] = generateCalls()
  expect(generateCalls()).toHaveLength(1)
  expect(post?.body).toMatchObject({ revision: 1, consent: true })
  expect((post?.body as { request_id: string }).request_id).toMatch(UUID_RE)

  // Editable result; nothing saved or changed on the idea.
  expect(screen.getByLabelText("Suggested summary")).toHaveValue(FIXTURE_SUMMARY)
  expect(screen.getByLabelText("Suggested talking points")).toHaveValue(FIXTURE_POINTS.join("\n"))
  expect(screen.getByLabelText("Idea notes")).toHaveValue(inbox.get("i1")!.notes)
  expect(requests("PUT", "/inbox")).toHaveLength(0)
  expect(inbox.get("i1")!.revision).toBe(1)
  expect(prepStatus()).toHaveTextContent("Draft ready")
  expect(panel().getByTestId("prep-config-meta")).toHaveTextContent("1 of 10 requests used today (9 left")

  // The folded label reflects the draft waiting for review.
  expect(prepToggle()).toHaveTextContent("Assisted preparation · draft to review")

  // Append into the local context; the existing notes, title, duration and URL stay.
  const before = inbox.get("i1")!.notes
  fireEvent.click(screen.getByRole("button", { name: "Append to context" }))
  expect(screen.getByLabelText("Idea notes")).toHaveValue(`${before}\n\n${BLOCK}`)
  // Once appended, nothing is waiting for review: the label says so instead.
  expect(prepToggle()).toHaveTextContent("Assisted preparation · notes added")
  expect(screen.getByLabelText("Idea title")).toHaveValue("Rent strike")
  expect(screen.getByLabelText("Source URL")).toHaveValue("https://example.com/rent")
  expect(screen.getByRole("button", { name: "Appended" })).toBeDisabled()
  expect(prepStatus()).toHaveTextContent("Appended to the context above. Save idea to keep it")
  expect(screen.getByRole("button", { name: "Generate again" })).toBeDisabled()
  expect(requests("PUT", "/inbox")).toHaveLength(0)

  // Explicit save persists it; the old draft can no longer be appended (revision moved on).
  fireEvent.click(screen.getByRole("button", { name: "Save idea" }))
  await flush()
  const [put] = requests("PUT", "/inbox/i1")
  expect(put?.body).toMatchObject({ revision: 1, notes: `${before}\n\n${BLOCK}`, text: "Rent strike", duration: 120, source_url: "https://example.com/rent" })
  expect(inbox.get("i1")!.revision).toBe(2)
  expect(screen.getByRole("button", { name: "Appended" })).toBeDisabled()
  expect(prepStatus()).toHaveTextContent("Appended and saved into the context above.")
  expect(prepToggle()).toHaveTextContent("Assisted preparation · notes added")
  // Consent was for the previous input; it is asked again.
  expect(consent()).not.toBeChecked()
  expect(generateCalls()).toHaveLength(1)
})

test("setup, no-context, archived, dirty, cap and truncated input are explained; nothing is posted", async () => {
  config = { ...config, enabled: false, ready: false, reason: "AI preparation is disabled. Enable it in the API configuration." }
  await renderInbox()
  await openIdea("Rent strike")
  expect(panel().getByTestId("prep-ready-badge")).toHaveTextContent("Off")
  expect(panel().getByTestId("prep-setup")).toHaveTextContent("AI preparation is disabled.")
  expect(panel().getByTestId("prep-setup")).toHaveTextContent("PREPARATION_ENABLED=true")
  expect(panel().getByTestId("prep-setup")).toHaveTextContent("PREPARATION_MODEL=<model id>")
  expect(panel().getByTestId("prep-setup")).toHaveTextContent("ANTHROPIC_API_KEY=<key>")
  expect(panel().queryByRole("textbox")).not.toBeInTheDocument()
  fireEvent.click(consent())
  expect(screen.getByRole("button", { name: "Generate draft" })).toBeDisabled()
  expect(prepStatus()).toHaveTextContent("AI preparation is disabled.")

  // Refresh status picks up a changed configuration without a reload.
  config = { ...config, enabled: true, ready: true, reason: null }
  fireEvent.click(panel().getByRole("button", { name: "Refresh status" }))
  await flush()
  expect(panel().getByTestId("prep-ready-badge")).toHaveTextContent("Ready")

  // Not enough context.
  await openIdea("Thin idea")
  fireEvent.click(consent())
  expect(screen.getByRole("button", { name: "Generate draft" })).toBeDisabled()
  expect(prepStatus()).toHaveTextContent("Add at least 20 characters of context")

  // Dirty parent: generation only works from saved text.
  await openIdea("Bus fares")
  fireEvent.click(consent())
  expect(screen.getByRole("button", { name: "Generate draft" })).toBeEnabled()
  fireEvent.change(screen.getByLabelText("Idea notes"), { target: { value: "fares went up twice this year already, edited" } })
  expect(screen.getByRole("button", { name: "Generate draft" })).toBeDisabled()
  expect(prepStatus()).toHaveTextContent("Save or discard your edits to the idea first")
  fireEvent.click(screen.getByRole("button", { name: "Discard edits" }))
  await flush()
  expect(screen.getByRole("button", { name: "Generate draft" })).toBeEnabled()

  // Archived: no consent control, no generate button.
  fireEvent.click(screen.getByRole("button", { name: "Archived" }))
  await flush()
  await openIdea("Old idea")
  expect(panel().queryByRole("checkbox")).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Generate draft" })).not.toBeInTheDocument()
  expect(prepStatus()).toHaveTextContent("Archived ideas are not prepared")

  // Daily cap reached and truncated input.
  config = { ...config, daily_limit: 0 }
  truncatedIds.add("i1")
  fireEvent.click(screen.getByRole("button", { name: "Active" }))
  await flush()
  await openIdea("Rent strike")
  expect(panel().getByTestId("prep-truncated")).toHaveTextContent("Some source or context was shortened to fit the 12,000-character limit. The preview below is the exact text that will be sent.")
  fireEvent.click(consent())
  expect(screen.getByRole("button", { name: "Generate draft" })).toBeDisabled()
  expect(prepStatus()).toHaveTextContent("daily generation limit has been reached")
  expect(requests("POST", "/preparation")).toHaveLength(0)
})

test("a failed run (200, status failed) is shown as a failure with an explicit retry; nothing is retried by itself and nothing is appended", async () => {
  seedItem("i5", "Broken", "this context carries the FIXTURE_ERROR marker")
  await renderInbox()
  await openIdea("Broken")
  await generateFor("i5")
  expect(generateCalls("i5")).toHaveLength(1)
  expect(prepStatus()).toHaveTextContent("Generation failed: The provider rejected the request (HTTP 503)")
  expect(prepStatus()).toHaveTextContent("Nothing was changed")
  expect(screen.queryByLabelText("Suggested summary")).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: /Append/ })).not.toBeInTheDocument()
  const retry = screen.getByRole("button", { name: "Try again" })
  expect(retry).toBeEnabled()
  await flush(10000)
  expect(generateCalls("i5")).toHaveLength(1)
  // Explicit retry uses a fresh request id.
  fireEvent.click(retry)
  await flush()
  expect(generateCalls("i5")).toHaveLength(2)
  expect((generateCalls("i5")[0]?.body as { request_id: string }).request_id).not.toBe((generateCalls("i5")[1]?.body as { request_id: string }).request_id)
  expect(screen.getByLabelText("Idea notes")).toHaveValue("this context carries the FIXTURE_ERROR marker")
})

test("a slow generation cannot land on another idea or overwrite typing: switching ideas keeps the result with its own idea, and edits made meanwhile block Apply with an explanation", async () => {
  await renderInbox()
  await openIdea("Rent strike")
  holdPattern = /POST .*\/generate$/
  fireEvent.click(consent())
  fireEvent.click(screen.getByRole("button", { name: "Generate draft" }))
  await flush()
  expect(screen.getByRole("button", { name: "Generating…" })).toBeDisabled()
  // Double click while pending: still one request.
  fireEvent.click(screen.getByRole("button", { name: "Generating…" }))
  expect(generateCalls()).toHaveLength(1)

  // Switch to another idea while the provider is slow.
  await openIdea("Bus fares")
  expect(screen.queryByLabelText("Suggested summary")).not.toBeInTheDocument()
  releaseAll(/POST .*\/generate$/)
  await flush()
  expect(screen.queryByLabelText("Suggested summary")).not.toBeInTheDocument()
  expect(screen.getByLabelText("Idea notes")).toHaveValue("fares went up twice this year already")
  expect(requests("PUT", "/inbox")).toHaveLength(0)

  // Back on the first idea the result is there, untouched, and applies cleanly.
  await openIdea("Rent strike")
  expect(screen.getByLabelText("Suggested summary")).toHaveValue(FIXTURE_SUMMARY)
  expect(screen.getByRole("button", { name: "Append to context" })).toBeEnabled()

  // Second scenario: type into the context while a generation is pending.
  holdPattern = /POST .*\/generate$/
  fireEvent.click(consent())
  fireEvent.click(screen.getByRole("button", { name: "Generate again" }))
  await flush()
  fireEvent.change(screen.getByLabelText("Idea notes"), { target: { value: "typed while waiting for the provider" } })
  releaseAll(/POST .*\/generate$/)
  await flush()
  expect(screen.getByLabelText("Idea notes")).toHaveValue("typed while waiting for the provider")
  expect(screen.getByLabelText("Suggested summary")).toHaveValue(FIXTURE_SUMMARY)
  expect(screen.getByRole("button", { name: "Append to context" })).toBeDisabled()
  expect(prepStatus()).toHaveTextContent("The idea has unsaved edits. Save or discard them first")
  fireEvent.click(screen.getByRole("button", { name: "Discard edits" }))
  await flush()
  expect(screen.getByRole("button", { name: "Append to context" })).toBeEnabled()
})

test("a running run left from before a reload is polled while visible and adopted when it finishes; a revision changed elsewhere disables generate and apply until the idea is reloaded", async () => {
  runs.set("11111111-1111-4111-8111-111111111111", {
    id: "11111111-1111-4111-8111-111111111111",
    topic_id: "i1",
    revision: 1,
    status: "running",
    started_at: stamp(),
    finished_at: null,
    model: "fixture-model",
    summary: null,
    talking_points: [],
    input_truncated: false,
    input_tokens: null,
    output_tokens: null,
    error: null,
    stale: false,
  })
  await renderInbox()
  await openIdea("Rent strike")
  expect(prepStatus()).toHaveTextContent("Generating… checking every few seconds.")
  fireEvent.click(consent())
  expect(screen.getByRole("button", { name: "Generate draft" })).toBeDisabled()
  const viewsBefore = requests("GET", "/preparation/topics/i1").length
  await flush(2000)
  expect(requests("GET", "/preparation/topics/i1").length).toBe(viewsBefore + 1)
  runs.set("11111111-1111-4111-8111-111111111111", { ...runs.get("11111111-1111-4111-8111-111111111111")!, status: "succeeded", finished_at: stamp(), summary: FIXTURE_SUMMARY, talking_points: [...FIXTURE_POINTS] })
  await flush(2000)
  expect(screen.getByLabelText("Suggested summary")).toHaveValue(FIXTURE_SUMMARY)
  expect(screen.getByRole("button", { name: "Append to context" })).toBeEnabled()
  const polled = requests("GET", "/preparation/topics/i1").length
  await flush(4000)
  expect(requests("GET", "/preparation/topics/i1").length).toBe(polled)

  // The idea moves on elsewhere: the next status refresh sees a newer revision than the editor holds.
  const current = inbox.get("i1")!
  inbox.set("i1", { ...current, revision: 2, notes: `${current.notes}\nchanged on another screen`, updated_at: stamp() })
  fireEvent.click(panel().getByRole("button", { name: "Refresh status" }))
  await flush()
  expect(screen.getByRole("button", { name: "Append to context" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Generate again" })).toBeDisabled()
  expect(prepStatus()).toHaveTextContent("This idea changed on another screen")
  expect(generateCalls()).toHaveLength(0)
  fireEvent.click(screen.getByRole("button", { name: "Reload the idea…" }))
  expect(screen.getByRole("alert")).toHaveTextContent("Out of date. This idea changed elsewhere since you opened it. Reload it to see the latest version.")
  fireEvent.click(screen.getByRole("button", { name: "Reload the latest version" }))
  await flush()
  expect(screen.getByLabelText("Idea notes")).toHaveValue(`${current.notes}\nchanged on another screen`)
  expect(screen.queryByTestId("prep-out-of-date")).not.toBeInTheDocument()
  // The retained run now belongs to an earlier revision: never applied, regenerate offered.
  expect(screen.getByRole("button", { name: "Append to context" })).toBeDisabled()
  expect(prepStatus()).toHaveTextContent("generated for an earlier version")
  fireEvent.click(consent())
  expect(screen.getByRole("button", { name: "Generate again" })).toBeEnabled()
})

test("a too-long append is refused with the draft intact; suggestion edits survive a status refresh and block regeneration until discarded; a lost answer that reached the server resolves on the next status check", async () => {
  const long = "x".repeat(9900)
  inbox.set("i2", { ...inbox.get("i2")!, notes: long, topic: project("Bus fares", 120, long, "") })
  await renderInbox()
  await openIdea("Bus fares")
  await generateFor("i2")
  fireEvent.click(screen.getByRole("button", { name: "Append to context" }))
  expect(prepStatus()).toHaveTextContent("Not appended: context plus the source line would be")
  expect(prepStatus()).toHaveTextContent("over the 10,000 limit")
  expect(screen.getByLabelText("Idea notes")).toHaveValue(long)
  expect(screen.getByRole("button", { name: "Append to context" })).toBeEnabled()

  // Edit the suggestion; a refresh keeps the edits and regeneration is blocked.
  fireEvent.change(screen.getByLabelText("Suggested summary"), { target: { value: "My own shorter summary" } })
  fireEvent.change(screen.getByLabelText("Suggested talking points"), { target: { value: "- one\n- two\n- three\n- four" } })
  fireEvent.click(panel().getByRole("button", { name: "Refresh status" }))
  await flush()
  expect(screen.getByLabelText("Suggested summary")).toHaveValue("My own shorter summary")
  expect(screen.getByLabelText("Suggested talking points")).toHaveValue("- one\n- two\n- three\n- four")
  // Consent stays given: the input did not change.
  expect(consent()).toBeChecked()
  expect(screen.getByRole("button", { name: "Generate again" })).toBeDisabled()
  expect(prepStatus()).toHaveTextContent("Edited draft. Append it to the context, or discard the edits to generate again.")
  // Invalid edit (too few points) blocks Apply with the reason.
  fireEvent.change(screen.getByLabelText("Suggested talking points"), { target: { value: "- one\n- two" } })
  expect(screen.getByRole("button", { name: "Append to context" })).toBeDisabled()
  expect(prepStatus()).toHaveTextContent("Talking points: 3 to 5 lines")
  fireEvent.click(screen.getByRole("button", { name: "Discard suggestion edits" }))
  expect(screen.getByLabelText("Suggested summary")).toHaveValue(FIXTURE_SUMMARY)
  expect(screen.getByRole("button", { name: "Generate again" })).toBeEnabled()

  // Lost answer, case A: the request reached the server. The panel's own status check after the failure finds the run;
  // nothing is sent again and no banner is left behind.
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
  fetchMock.mockImplementationOnce(async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method: init?.method ?? "GET", url: String(input), body })
    serve(init?.method ?? "GET", String(input), body)
    throw new TypeError("Failed to fetch")
  })
  const postsBefore = generateCalls("i2").length
  fireEvent.click(screen.getByRole("button", { name: "Generate again" }))
  await flush()
  const lostA = generateCalls("i2").at(-1)?.body as { request_id: string }
  expect(generateCalls("i2")).toHaveLength(postsBefore + 1)
  expect(screen.queryByTestId("prep-ambiguous")).not.toBeInTheDocument()
  expect(prepStatus()).toHaveTextContent("Found the result of the earlier request. Nothing was sent again.")
  expect(screen.getByLabelText("Suggested summary")).toHaveValue(FIXTURE_SUMMARY)
  expect(runs.get(lostA.request_id)?.topic_id).toBe("i2")
  expect(screen.getByRole("button", { name: "Generate again" })).toBeEnabled()
})

test("lost answer, case B: the request never reached the server; resending is blocked while the idea has unsaved edits, then reuses the same request id once the idea is clean", async () => {
  await renderInbox()
  await openIdea("Bus fares")
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
  fetchMock.mockImplementationOnce(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    throw new TypeError("Failed to fetch")
  })
  fireEvent.click(consent())
  fireEvent.click(screen.getByRole("button", { name: "Generate draft" }))
  await flush()
  const lost = generateCalls("i2").at(-1)?.body as { request_id: string }
  expect(runs.size).toBe(0)
  expect(screen.getByTestId("prep-ambiguous")).toHaveTextContent("Resending checks the server first")
  // Parent edits: resend is refused with the reason; checking status stays available.
  fireEvent.change(screen.getByLabelText("Idea notes"), { target: { value: "fares went up twice this year already, and again" } })
  expect(screen.getByRole("button", { name: "Resend the same request" })).toBeDisabled()
  expect(screen.getByTestId("prep-ambiguous")).toHaveTextContent("Save or discard your edits to the idea first")
  fireEvent.click(screen.getByRole("button", { name: "Check status" }))
  await flush()
  expect(screen.getByTestId("prep-ambiguous")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Discard edits" }))
  await flush()
  expect(screen.getByRole("button", { name: "Resend the same request" })).toBeEnabled()
  fireEvent.click(screen.getByRole("button", { name: "Resend the same request" }))
  await flush()
  const resent = generateCalls("i2").filter((call) => (call.body as { request_id: string }).request_id === lost.request_id)
  expect(resent).toHaveLength(2)
  expect(runs.size).toBe(1)
  expect(screen.getByLabelText("Suggested summary")).toHaveValue(FIXTURE_SUMMARY)
  expect(screen.queryByTestId("prep-ambiguous")).not.toBeInTheDocument()
})

test("lost answer, case C: the idea was saved since the request; resend is refused, Forget that request allows a fresh generation", async () => {
  await renderInbox()
  await openIdea("Bus fares")
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
  fetchMock.mockImplementationOnce(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    throw new TypeError("Failed to fetch")
  })
  fireEvent.click(consent())
  fireEvent.click(screen.getByRole("button", { name: "Generate draft" }))
  await flush()
  const lost = generateCalls("i2").at(-1)?.body as { request_id: string }
  fireEvent.change(screen.getByLabelText("Idea notes"), { target: { value: "fares went up twice this year already, saved edit" } })
  fireEvent.click(screen.getByRole("button", { name: "Save idea" }))
  await flush()
  expect(inbox.get("i2")?.revision).toBe(2)
  expect(screen.getByTestId("prep-ambiguous")).toHaveTextContent("The idea was saved since that request, so it cannot be resent as is.")
  expect(screen.getByRole("button", { name: "Resend the same request" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Forget that request" }))
  expect(screen.queryByTestId("prep-ambiguous")).not.toBeInTheDocument()
  fireEvent.click(consent())
  fireEvent.click(screen.getByRole("button", { name: "Generate draft" }))
  await flush()
  const fresh = generateCalls("i2").at(-1)?.body as { request_id: string; revision: number }
  expect(fresh.request_id).not.toBe(lost.request_id)
  expect(fresh.revision).toBe(2)
  expect(screen.getByLabelText("Suggested summary")).toHaveValue(FIXTURE_SUMMARY)
})

test("edited suggestions survive the panel unmounting: Archived → Active → reopen, New idea → back, and Discard new idea all keep the typed summary and points", async () => {
  await renderInbox()
  await openIdea("Rent strike")
  await generateFor("i1")
  fireEvent.change(screen.getByLabelText("Suggested summary"), { target: { value: "My edited summary for tonight." } })
  fireEvent.change(screen.getByLabelText("Suggested talking points"), { target: { value: "- alpha\n- beta\n- gamma" } })

  fireEvent.click(screen.getByRole("button", { name: "Archived" }))
  await flush()
  expect(screen.queryByTestId("preparation-panel")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Active" }))
  await flush()
  await openIdea("Rent strike")
  expect(screen.getByLabelText("Suggested summary")).toHaveValue("My edited summary for tonight.")
  expect(screen.getByLabelText("Suggested talking points")).toHaveValue("- alpha\n- beta\n- gamma")
  expect(screen.getByRole("button", { name: "Generate again" })).toBeDisabled()

  fireEvent.click(screen.getByRole("button", { name: "New idea" }))
  await flush()
  expect(prepStatus()).toHaveTextContent("Save the idea first")
  await openIdea("Rent strike")
  expect(screen.getByLabelText("Suggested summary")).toHaveValue("My edited summary for tonight.")

  fireEvent.click(screen.getByRole("button", { name: "New idea" }))
  await flush()
  fireEvent.change(screen.getByLabelText("Idea title"), { target: { value: "Scratch" } })
  fireEvent.click(screen.getByRole("button", { name: "Discard new idea" }))
  await flush()
  await openIdea("Rent strike")
  expect(screen.getByLabelText("Suggested summary")).toHaveValue("My edited summary for tonight.")
  // The edited draft still appends as edited.
  fireEvent.click(screen.getByRole("button", { name: "Append to context" }))
  expect(screen.getByLabelText("Idea notes")).toHaveValue(`${inbox.get("i1")!.notes}\n\nSummary\nMy edited summary for tonight.\n\nTalking points\n- alpha\n- beta\n- gamma`)
  expect(generateCalls("i1")).toHaveLength(1)
})

test("a slow answer arriving while nothing is selected still lands on its own idea only", async () => {
  await renderInbox()
  await openIdea("Rent strike")
  holdPattern = /POST .*\/generate$/
  fireEvent.click(consent())
  fireEvent.click(screen.getByRole("button", { name: "Generate draft" }))
  await flush()
  fireEvent.click(screen.getByRole("button", { name: "Archived" }))
  await flush()
  expect(screen.queryByTestId("preparation-panel")).not.toBeInTheDocument()
  releaseAll(/POST .*\/generate$/)
  await flush()
  fireEvent.click(screen.getByRole("button", { name: "Active" }))
  await flush()
  await openIdea("Bus fares")
  expect(screen.queryByLabelText("Suggested summary")).not.toBeInTheDocument()
  expect(screen.getByLabelText("Idea notes")).toHaveValue("fares went up twice this year already")
  await openIdea("Rent strike")
  expect(screen.getByLabelText("Suggested summary")).toHaveValue(FIXTURE_SUMMARY)
  expect(screen.getByRole("button", { name: "Append to context" })).toBeEnabled()
  expect(generateCalls("i1")).toHaveLength(1)
  expect(requests("PUT", "/inbox")).toHaveLength(0)
})

test("an unsaved new idea shows the setup state and asks to save first; no preparation calls are made for it", async () => {
  await renderInbox()
  fireEvent.click(screen.getByRole("button", { name: "New idea" }))
  await flush()
  // Folded by default, and the toggle says why there is nothing to do yet.
  expect(prepToggle()).toHaveAttribute("aria-expanded", "false")
  expect(prepToggle()).toHaveTextContent("Assisted preparation · after saving")
  expect(screen.queryByRole("button", { name: "Refresh status" })).not.toBeInTheDocument()
  openPrepTool()
  expect(screen.getByRole("button", { name: "Refresh status" })).toBeInTheDocument()
  expect(prepStatus()).toHaveTextContent("Save the idea first")
  expect(panel().getByTestId("prep-fixture-badge")).toBeInTheDocument()
  expect(requests("GET", "/preparation/status")).toHaveLength(1)
  expect(requests("GET", "/preparation/topics")).toHaveLength(0)
  expect(panel().queryByRole("checkbox")).not.toBeInTheDocument()
})
