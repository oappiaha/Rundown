import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import RetrievalPanel from "./RetrievalPanel"
import type { RetrievalRun, RetrievalSource } from "../lib/api"

// The discovery-search panel against a small in-memory stand-in for the frozen
// /retrieval contract: revision-guarded edits, one run per request id (the same
// id and revision recover the original attempt), 409 for paused/stale, 503 for
// a platform that needs setup.

type Call = { method: string; url: string; body?: unknown }

let sources: Map<string, RetrievalSource>
let runs: Map<string, RetrievalRun>
let calls: Call[]
let ids: number
let clock: number
let youtubeReason: string | null
/** When set, the next POST .../import rejects at the network level (the server never sees it). */
let dropNextImport: boolean
let nextRun: Partial<RetrievalRun>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function stamp(): string {
  clock += 1
  return new Date(Date.UTC(2026, 8, 16, 0, 0, clock)).toISOString()
}

function seed(id: string, patch: Partial<RetrievalSource> = {}): RetrievalSource {
  const at = stamp()
  const source: RetrievalSource = { id, revision: 1, name: `Search ${id}`, platform: "youtube", query: "AI", scope: "", freshness_hours: 168, limit: 20, default_duration: 120, enabled: true, created_at: at, updated_at: at, setup_reason: null, can_import: true, latest_run: null, ...patch }
  sources.set(id, source)
  return source
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function view(source: RetrievalSource): RetrievalSource {
  const reason = source.platform === "youtube" ? youtubeReason : null
  const latest = [...runs.values()].filter((run) => run.source_id === source.id).sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0] ?? null
  return { ...source, setup_reason: reason, can_import: source.enabled && reason === null, latest_run: latest }
}

function serve(method: string, url: string, body: unknown): Response {
  const path = new URL(url, "http://test.local").pathname
  if (path === "/retrieval" && method === "GET") {
    return json({ sources: [...sources.values()].map(view), providers: [{ platform: "youtube", setup_reason: youtubeReason }, { platform: "reddit", setup_reason: null }], daily_limit: 20, used_today: runs.size, mode: "fixture" })
  }
  if (path === "/retrieval" && method === "POST") {
    const payload = body as Omit<RetrievalSource, "id" | "revision">
    return json(view(seed(`s${++ids}`, { ...payload })), 201)
  }
  const detail = /^\/retrieval\/([^/]+)(\/import|\/runs)?$/.exec(path)
  if (detail) {
    const source = sources.get(detail[1] ?? "")
    if (!source) return json({ detail: "Retrieval source not found." }, 404)
    if (method === "GET" && detail[2] === "/runs") return json({ runs: [...runs.values()].filter((run) => run.source_id === source.id).reverse() })
    if (method === "PUT" && !detail[2]) {
      const payload = body as RetrievalSource
      if (payload.revision !== source.revision) return json({ detail: "Source changed elsewhere. Your edits are kept; reload before saving." }, 409)
      const next = { ...source, ...payload, revision: source.revision + 1, updated_at: stamp() }
      sources.set(source.id, next)
      return json(view(next))
    }
    if (method === "POST" && detail[2] === "/import") {
      const payload = body as { revision: number; request_id: string }
      const existing = runs.get(payload.request_id)
      if (existing) return json(existing)
      if (payload.revision !== source.revision) return json({ detail: "Source changed elsewhere. Reload before collecting." }, 409)
      if (!source.enabled) return json({ detail: "Enable this source before collecting." }, 409)
      if (source.platform === "youtube" && youtubeReason) return json({ detail: youtubeReason }, 503)
      const started = stamp()
      const run: RetrievalRun = { id: payload.request_id, source_id: source.id, revision: source.revision, status: "succeeded", started_at: started, finished_at: stamp(), created: 2, duplicates: 1, skipped: 0, error: null, mode: "fixture", ...nextRun }
      runs.set(run.id, run)
      return json(run)
    }
  }
  return json({ detail: "Not Found" }, 404)
}

beforeEach(() => {
  sources = new Map()
  runs = new Map()
  calls = []
  ids = 0
  clock = 0
  youtubeReason = null
  dropNextImport = false
  nextRun = {}
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
    calls.push({ method, url, body })
    if (dropNextImport && method === "POST" && url.endsWith("/import")) {
      dropNextImport = false
      throw new TypeError("Failed to fetch")
    }
    return serve(method, url, body)
  }) as unknown as typeof fetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

function imports(): Array<{ revision: number; request_id: string }> {
  return calls.filter((call) => call.method === "POST" && call.url.endsWith("/import")).map((call) => call.body as { revision: number; request_id: string })
}

function panel() {
  return screen.getByTestId("retrieval")
}

async function renderPanel(props: Partial<Parameters<typeof RetrievalPanel>[0]> = {}) {
  const onImported = vi.fn()
  const onOpenInbox = vi.fn()
  render(<RetrievalPanel hidden={false} onImported={onImported} onOpenInbox={onOpenInbox} {...props} />)
  await screen.findByText("Fixture mode")
  return { onImported, onOpenInbox }
}

test("add a Reddit search (nothing collected), collect once with a UUID and the revision, see the counts, and hand off to the Inbox", async () => {
  const { onImported, onOpenInbox } = await renderPanel()
  fireEvent.click(screen.getByRole("button", { name: "New search" }))
  fireEvent.change(screen.getByLabelText("Search name"), { target: { value: " Reddit AI " } })
  fireEvent.change(screen.getByLabelText("Platform"), { target: { value: "reddit" } })
  fireEvent.change(screen.getByLabelText("Keywords"), { target: { value: "AI" } })
  fireEvent.change(screen.getByLabelText("Subreddit"), { target: { value: "r/Technology" } })
  fireEvent.click(screen.getByRole("button", { name: "Add search" }))
  await screen.findByText(/Saved "Reddit AI"\. Nothing was collected yet/)
  const created = calls.find((call) => call.method === "POST" && call.url === "/retrieval")
  expect(created?.body).toEqual({ name: "Reddit AI", platform: "reddit", query: "AI", scope: "technology", freshness_hours: 168, limit: 20, default_duration: 120, enabled: true })
  expect(imports()).toHaveLength(0)

  fireEvent.click(screen.getByRole("button", { name: "Collect now" }))
  expect(await screen.findByText(/^Collected\.$/)).toBeInTheDocument()
  expect(panel().querySelector(".import-result")).toHaveTextContent("2 new ideas · 1 duplicate · 0 skipped")
  expect(imports()).toHaveLength(1)
  expect(imports()[0]?.revision).toBe(1)
  expect(imports()[0]?.request_id).toMatch(UUID)
  expect(onImported).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole("button", { name: "Open inbox" }))
  expect(onOpenInbox).toHaveBeenCalledTimes(1)
  expect(await within(panel()).findByRole("list", { name: "Collection runs" })).toHaveTextContent("Succeeded")
})

test("a stale save keeps the edits until an explicit reload; a paused search and a platform that needs setup cannot collect, with the reason shown", async () => {
  seed("s1", { name: "Studio", platform: "reddit", scope: "technology" })
  await renderPanel()
  fireEvent.click(await screen.findByRole("button", { name: "Open Studio" }))
  fireEvent.change(screen.getByLabelText("Keywords"), { target: { value: "AI creative" } })
  // Changed elsewhere meanwhile.
  sources.set("s1", { ...sources.get("s1")!, revision: 2, name: "Studio (renamed elsewhere)" })
  fireEvent.click(screen.getByRole("button", { name: "Save search" }))
  const alert = await screen.findByRole("alert")
  expect(alert).toHaveTextContent("Not saved.")
  expect(screen.getByLabelText("Keywords")).toHaveValue("AI creative")
  expect(screen.getByLabelText("Search name")).toHaveValue("Studio")
  expect(screen.getByRole("button", { name: "Save search" })).toBeDisabled()
  expect(within(panel()).getByText("Resolve the conflict above first.")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Reload and discard my edits" }))
  await screen.findByText("Reloaded the latest version. Your edits were discarded.")
  expect(screen.getByLabelText("Search name")).toHaveValue("Studio (renamed elsewhere)")
  expect(screen.getByLabelText("Keywords")).toHaveValue("AI")

  // Pause it: collection is refused locally with the reason, no request is sent.
  fireEvent.click(screen.getByLabelText("Active"))
  fireEvent.click(screen.getByRole("button", { name: "Save search" }))
  await screen.findByText(/\(paused\)\. Nothing was collected\./)
  expect(screen.getByRole("button", { name: "Collect now" })).toBeDisabled()
  expect(within(panel()).getByText("This search is paused. Turn it on and save to collect.")).toBeInTheDocument()

  // A platform that needs setup: searches stay editable, Collect is off with the reason.
  youtubeReason = "YouTube API key is not configured."
  seed("s2", { name: "Tube" })
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }))
  expect(await screen.findByText(/YouTube: needs setup — YouTube API key is not configured\./)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Open Tube" }))
  expect(screen.getByRole("button", { name: "Collect now" })).toBeDisabled()
  expect(within(panel()).getByText(/YouTube is not set up: YouTube API key is not configured\./)).toBeInTheDocument()
  expect(screen.getByLabelText("Keywords")).toBeEnabled()
  expect(imports()).toHaveLength(0)
})

test("a dropped collect keeps its request id for an exact retry, a 5xx keeps it too, and a double click sends one request", async () => {
  seed("s1", { name: "Studio" })
  await renderPanel()
  fireEvent.click(await screen.findByRole("button", { name: "Open Studio" }))
  await within(panel()).findByText("No collections yet.")

  dropNextImport = true
  fireEvent.click(screen.getByRole("button", { name: "Collect now" }))
  const banner = await screen.findByTestId("retrieval-attempt")
  expect(banner).toHaveTextContent("Unconfirmed request.")
  expect(screen.getByRole("button", { name: "Collect now" })).toBeDisabled()
  expect(imports()).toHaveLength(1)
  const lost = imports()[0]!

  fireEvent.click(screen.getByRole("button", { name: "Retry the same request" }))
  expect(await screen.findByText(/^Collected\.$/)).toBeInTheDocument()
  expect(imports()).toHaveLength(2)
  expect(imports()[1]).toEqual(lost)
  expect(runs.size).toBe(1)
  expect(screen.queryByTestId("retrieval-attempt")).not.toBeInTheDocument()

  // A gateway-style 5xx may follow a committed import: the id is kept, not minted afresh.
  const original = globalThis.fetch
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if ((init?.method ?? "GET") === "POST" && url.endsWith("/import")) {
      calls.push({ method: "POST", url, body: JSON.parse(String(init?.body)) })
      return json({ detail: "Bad gateway" }, 502)
    }
    return original(input, init)
  }) as unknown as typeof fetch
  fireEvent.click(screen.getByRole("button", { name: "Collect now" }))
  expect(await screen.findByTestId("retrieval-attempt")).toBeInTheDocument()
  expect(imports()).toHaveLength(3)
  const gateway = imports()[2]!
  expect(gateway.request_id).not.toBe(lost.request_id)
  globalThis.fetch = original
  fireEvent.click(screen.getByRole("button", { name: "Retry the same request" }))
  await waitFor(() => expect(imports()).toHaveLength(4))
  expect(imports()[3]).toEqual(gateway)
  await waitFor(() => expect(screen.queryByTestId("retrieval-attempt")).not.toBeInTheDocument())

  // Two clicks in one tick: one request.
  await waitFor(() => expect(screen.getByRole("button", { name: "Collect now" })).toBeEnabled())
  const button = screen.getByRole("button", { name: "Collect now" })
  fireEvent.click(button)
  fireEvent.click(button)
  await waitFor(() => expect(screen.getByRole("button", { name: "Collect now" })).toBeEnabled())
  expect(imports()).toHaveLength(5)
  expect(new Set(imports().map((entry) => entry.request_id)).size).toBe(3)
})
