import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import App from "../App"
import type { Feed, ImportRun, InboxItem, ShowState } from "../lib/api"

// Sources view rendered through App so navigation, the inbox coupling and the
// draft-survival rules are exercised the way a user reaches them. The fetch
// mock is a small in-memory server following the frozen /feeds contract:
// revision guard, immutable URL, 409 on disabled/running/stale imports, a
// finished run answered with 200 whatever its status.

type Call = { method: string; url: string; body?: unknown }

let live: ShowState
let feeds: Map<string, Feed>
let runs: Map<string, ImportRun[]>
let inbox: Map<string, InboxItem>
let calls: Call[]
let ids: number
let clock: number
let holds: Map<string, Array<() => void>>
let holdPattern: RegExp | null
/** What the next POST /feeds/{id}/import produces (after the revision/enabled/lease checks). */
let nextImport: (feed: Feed) => Partial<ImportRun>

function liveState(): ShowState {
  return { revision: 3, topics: [{ id: "a", text: "Opening", duration: 120, notes: "" }], current_topic_id: "a", remaining_seconds: 100, paused: false, server_time: "2026-09-14T00:00:00.000Z" }
}

function stamp(): string {
  clock += 1
  return new Date(Date.UTC(2026, 8, 15, 0, 0, clock)).toISOString()
}

function seedFeed(id: string, name: string, url: string, patch: Partial<Feed> = {}): Feed {
  const at = stamp()
  const entry: Feed = { id, revision: 1, name, url, default_duration: 120, enabled: true, created_at: at, updated_at: at, can_import: true, latest_run: null, ...patch }
  feeds.set(id, entry)
  if (!runs.has(id)) runs.set(id, [])
  return entry
}

function seedItem(id: string, text: string, source: InboxItem["source"] = null): InboxItem {
  const at = stamp()
  const entry: InboxItem = { id, revision: 1, text, duration: 120, notes: `notes for ${text}`, source_url: "https://example.com/story", archived: false, created_at: at, updated_at: at, topic: { text, duration: 120, notes: `notes for ${text}\n\nSource: https://example.com/story` }, source }
  inbox.set(id, entry)
  return entry
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function feedProblem(payload: Record<string, unknown>, creating: boolean): string | null {
  const name = typeof payload.name === "string" ? payload.name.trim() : ""
  if (name.length < 1 || name.length > 80) return "name must be 1-80 characters"
  if (!Number.isInteger(payload.default_duration) || (payload.default_duration as number) < 15 || (payload.default_duration as number) > 3600) return "default_duration must be an integer 15-3600"
  if (creating) {
    if (typeof payload.url !== "string" || !/^https?:\/\/[^\s@/]+[^\s]*$/.test(payload.url)) return "url must be an absolute http(s) URL"
    if ("enabled" in payload || "id" in payload || "revision" in payload) return "unexpected field"
  } else if ("url" in payload) return "url is immutable"
  return null
}

function finishRun(feed: Feed, patch: Partial<ImportRun>): ImportRun {
  const started = stamp()
  const created: ImportRun = { id: `run${++ids}`, feed_id: feed.id, status: "succeeded", started_at: started, finished_at: stamp(), created: 0, duplicates: 0, skipped: 0, examined: 0, error: null, warnings: [], items: [], ...patch }
  runs.set(feed.id, [created, ...(runs.get(feed.id) ?? [])].slice(0, 20))
  feeds.set(feed.id, { ...feed, latest_run: created, can_import: feed.enabled })
  return created
}

function serve(method: string, url: string, body: unknown): Response {
  const parsed = new URL(url, "http://test.local")
  const path = parsed.pathname
  if (path === "/rundown/state") return json(live)
  if (path === "/inbox" && method === "GET") {
    const archived = parsed.searchParams.get("archived") === "true"
    return json({ items: [...inbox.values()].filter((entry) => entry.archived === archived) })
  }
  const inboxDetail = /^\/inbox\/([^/]+)$/.exec(path)
  if (inboxDetail) {
    const entry = inbox.get(inboxDetail[1] ?? "")
    if (!entry) return json({ detail: "Inbox item not found." }, 404)
    if (method === "GET") return json(entry)
    if (method === "PUT") {
      const payload = body as { revision: number; text: string; duration: number; notes: string; source_url: string }
      if (payload.revision !== entry.revision) return json({ detail: "changed" }, 409)
      const next: InboxItem = { ...entry, revision: entry.revision + 1, text: payload.text, duration: payload.duration, notes: payload.notes, source_url: payload.source_url, updated_at: stamp(), topic: { text: payload.text, duration: payload.duration, notes: `${payload.notes}\n\nSource: ${payload.source_url}` } }
      inbox.set(entry.id, next)
      return json(next)
    }
  }
  // Discovery searches (YouTube/Reddit) live in the same view; this suite has none configured. Their own behaviour is covered in RetrievalPanel.test.tsx.
  if (path === "/retrieval" && method === "GET") return json({ sources: [], providers: [{ platform: "youtube", setup_reason: null }, { platform: "reddit", setup_reason: null }], daily_limit: 20, used_today: 0, mode: "fixture" })
  if (path === "/feeds" && method === "GET") return json({ feeds: [...feeds.values()] })
  if (path === "/feeds" && method === "POST") {
    const payload = body as Record<string, unknown>
    const problem = feedProblem(payload, true)
    if (problem) return json({ detail: problem }, 422)
    if ([...feeds.values()].some((entry) => entry.url === (payload.url as string).trim())) return json({ detail: "A feed with this URL already exists." }, 409)
    const created = seedFeed(`f${++ids}`, (payload.name as string).trim(), (payload.url as string).trim(), { default_duration: payload.default_duration as number })
    return json(created, 201)
  }
  const detail = /^\/feeds\/([^/]+)(\/import|\/runs|\/schedule)?$/.exec(path)
  if (detail) {
    const entry = feeds.get(detail[1] ?? "")
    if (!entry) return json({ detail: "Feed not found." }, 404)
    if (method === "GET" && !detail[2]) return json(entry)
    // Automatic imports are off for every feed here; the schedule panel has its own suite (FeedSchedulePanel.test.tsx).
    if (method === "GET" && detail[2] === "/schedule") {
      return json({ feed_id: entry.id, revision: 0, enabled: false, interval_minutes: 60, next_run_at: null, last_run: null, effective: false, reason: "Automatic imports are off for this feed.", server_time: stamp() })
    }
    if (method === "GET" && detail[2] === "/runs") return json({ runs: runs.get(entry.id) ?? [] })
    if (method === "PUT" && !detail[2]) {
      const payload = body as Record<string, unknown>
      const problem = feedProblem(payload, false)
      if (problem) return json({ detail: problem }, 422)
      if (payload.revision !== entry.revision) return json({ detail: "Feed changed on another screen." }, 409)
      if (!entry.can_import && entry.enabled) return json({ detail: "This feed is importing. Wait for the result before changing its settings." }, 409)
      const next: Feed = { ...entry, revision: entry.revision + 1, name: (payload.name as string).trim(), default_duration: payload.default_duration as number, enabled: payload.enabled as boolean, updated_at: stamp(), can_import: (payload.enabled as boolean) && entry.latest_run?.status !== "running" }
      feeds.set(entry.id, next)
      return json(next)
    }
    if (method === "POST" && detail[2] === "/import") {
      const payload = body as { revision: number }
      if (payload.revision !== entry.revision) return json({ detail: "Feed changed on another screen." }, 409)
      if (!entry.enabled) return json({ detail: "Feed is disabled." }, 409)
      if (!entry.can_import) return json({ detail: "An import is already running for this feed." }, 409)
      return json(finishRun(entry, nextImport(entry)))
    }
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

function release(key: string) {
  const list = holds.get(key) ?? []
  const fn = list.shift()
  if (!fn) throw new Error(`nothing held for ${key}`)
  fn()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  live = liveState()
  feeds = new Map()
  runs = new Map()
  inbox = new Map()
  calls = []
  ids = 100
  clock = 0
  holds = new Map()
  holdPattern = null
  nextImport = () => ({ created: 2, duplicates: 1, skipped: 1, examined: 4, items: [{ title: "Creative tools", reason: "created" }, { title: "Repeated", reason: "duplicate" }] })
  seedFeed("f1", "Studio research", "http://127.0.0.1:8168/feed.xml")
  seedFeed("f2", "Atom source", "http://127.0.0.1:8168/atom.xml", { default_duration: 90 })
  seedItem("i1", "Manual idea")
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

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function renderLoaded() {
  render(<App />)
  await flush()
  expect(await screen.findByDisplayValue("Opening")).toBeInTheDocument()
}

async function openSources() {
  fireEvent.click(screen.getByRole("button", { name: "Sources" }))
  await flush()
  expect(screen.getByRole("heading", { name: "Sources" })).toBeVisible()
}

async function openFeed(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `Open ${name}` }))
  await flush()
  expect(screen.getByLabelText("Feed name")).toHaveValue(name)
}

function requests(method: string, pathStart: string) {
  return calls.filter((call) => call.method === method && new URL(call.url, "http://test.local").pathname.startsWith(pathStart))
}

function sourcesStatus() {
  const status = document.querySelector("#sources .publish-status")
  if (!status) throw new Error("sources status line not rendered")
  return status
}

function importPanel() {
  const panel = document.querySelector("#sources .import-panel")
  if (!panel) throw new Error("import panel not rendered")
  return panel as HTMLElement
}

test("add a feed: nothing is fetched, the URL becomes fixed, an edit sends the revision without the URL, and disabling blocks import with a reason", async () => {
  await renderLoaded()
  await openSources()
  expect(screen.getByRole("button", { name: "Open Studio research" })).toHaveTextContent("Never imported")
  fireEvent.click(screen.getByRole("button", { name: "New feed" }))
  await flush()
  expect(screen.getByRole("button", { name: "Add feed" })).toBeDisabled()
  fireEvent.change(screen.getByLabelText("Feed name"), { target: { value: "  Local fixture  " } })
  fireEvent.change(screen.getByLabelText("Feed URL"), { target: { value: " http://127.0.0.1:8168/long.xml " } })
  fireEvent.change(screen.getByLabelText("Default duration"), { target: { value: "45" } })
  expect(screen.queryByRole("button", { name: "Import now" })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Add feed" }))
  await flush()
  const [post] = requests("POST", "/feeds")
  expect(post?.body).toEqual({ name: "Local fixture", url: "http://127.0.0.1:8168/long.xml", default_duration: 45 })
  expect(requests("POST", "/feeds/f101/import")).toHaveLength(0)
  expect(sourcesStatus()).toHaveTextContent('Added "Local fixture". Nothing was fetched yet')
  expect(screen.getByRole("button", { name: "Open Local fixture" })).toHaveAttribute("aria-current", "true")
  // The address is now fixed: shown as a safe link, no input.
  expect(screen.queryByLabelText("Feed URL")).not.toBeInTheDocument()
  const link = within(screen.getByTestId("feed-url")).getByRole("link")
  expect(link).toHaveAttribute("href", "http://127.0.0.1:8168/long.xml")
  expect(link).toHaveAttribute("rel", "noopener noreferrer")
  expect(screen.getByText(/The address can't be changed/)).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Import now" })).toBeEnabled()

  // Edit name and disable: PUT carries revision and every editable field, never the URL.
  fireEvent.change(screen.getByLabelText("Feed name"), { target: { value: "Local fixture v2" } })
  expect(screen.getByRole("button", { name: "Import now" })).toBeDisabled()
  expect(within(importPanel()).getByRole("status")).toHaveTextContent("Save or discard your edits before importing.")
  fireEvent.click(screen.getByLabelText("Enabled"))
  fireEvent.click(screen.getByRole("button", { name: "Save feed" }))
  await flush()
  const [put] = requests("PUT", "/feeds/f101")
  expect(put?.body).toEqual({ revision: 1, name: "Local fixture v2", default_duration: 45, enabled: false })
  expect(feeds.get("f101")).toMatchObject({ revision: 2, enabled: false, url: "http://127.0.0.1:8168/long.xml" })
  expect(sourcesStatus()).toHaveTextContent('Saved "Local fixture v2" (disabled). Nothing was fetched.')
  expect(screen.getByRole("button", { name: "Open Local fixture v2" })).toHaveTextContent("Disabled")
  expect(screen.getByRole("button", { name: "Import now" })).toBeDisabled()
  expect(within(importPanel()).getByRole("status")).toHaveTextContent("This feed is disabled.")

  // Re-enable: import is available again. Still no fetch anywhere.
  fireEvent.click(screen.getByLabelText("Enabled"))
  fireEvent.click(screen.getByRole("button", { name: "Save feed" }))
  await flush()
  expect(requests("PUT", "/feeds/f101")[1]?.body).toEqual({ revision: 2, name: "Local fixture v2", default_duration: 45, enabled: true })
  expect(screen.getByRole("button", { name: "Import now" })).toBeEnabled()
  expect(requests("POST", "/feeds/f101/import")).toHaveLength(0)
  expect(document.body.textContent).not.toMatch(/revision/i)
})

test("invalid name, URL or duration is blocked before any request; a loopback fixture address is accepted", async () => {
  await renderLoaded()
  await openSources()
  fireEvent.click(screen.getByRole("button", { name: "New feed" }))
  await flush()
  fireEvent.change(screen.getByLabelText("Feed name"), { target: { value: "Feed" } })
  for (const bad of ["example.com/feed.xml", "ftp://files.example/feed", "https://user:pw@example.com/feed", "https://example.com/a b", "javascript:alert(1)", "https:example.com/feed"]) {
    fireEvent.change(screen.getByLabelText("Feed URL"), { target: { value: bad } })
    expect(screen.getByLabelText("Feed URL")).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByRole("button", { name: "Add feed" })).toBeDisabled()
    expect(sourcesStatus()).toHaveTextContent(/^Feed URL/)
  }
  fireEvent.change(screen.getByLabelText("Feed URL"), { target: { value: "http://127.0.0.1:8168/feed.xml" } })
  expect(screen.getByLabelText("Feed URL")).not.toHaveAttribute("aria-invalid")
  expect(screen.getByRole("button", { name: "Add feed" })).toBeEnabled()
  fireEvent.change(screen.getByLabelText("Default duration"), { target: { value: "5" } })
  expect(screen.getByRole("button", { name: "Add feed" })).toBeDisabled()
  expect(sourcesStatus()).toHaveTextContent("Default length must be a whole number of seconds from 15 to 3600.")
  fireEvent.change(screen.getByLabelText("Default duration"), { target: { value: "3601" } })
  expect(screen.getByRole("button", { name: "Add feed" })).toBeDisabled()
  fireEvent.change(screen.getByLabelText("Default duration"), { target: { value: "60" } })
  fireEvent.change(screen.getByLabelText("Feed name"), { target: { value: "x".repeat(81) } })
  expect(screen.getByRole("button", { name: "Add feed" })).toBeDisabled()
  expect(sourcesStatus()).toHaveTextContent("Feed name must be 1–80 characters.")
  fireEvent.change(screen.getByLabelText("Feed name"), { target: { value: "   " } })
  fireEvent.submit(screen.getByRole("form", { name: "New feed" }))
  await flush()
  expect(requests("POST", "/feeds")).toHaveLength(0)

  // An address that is already configured is refused by the server: the typed feed is kept, no stale-edit banner.
  fireEvent.change(screen.getByLabelText("Feed name"), { target: { value: "Twice" } })
  fireEvent.click(screen.getByRole("button", { name: "Add feed" }))
  await flush()
  expect(requests("POST", "/feeds")).toHaveLength(1)
  expect(sourcesStatus()).toHaveTextContent("Not added: A feed with this URL already exists.")
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  expect(screen.getByLabelText("Feed name")).toHaveValue("Twice")
  expect(screen.getByLabelText("Feed URL")).toHaveValue("http://127.0.0.1:8168/feed.xml")
  expect(screen.getByRole("button", { name: "Add feed" })).toBeEnabled()
})

test("Import now sends the revision, shows the run's counts, records history, reloads the inbox and shows the imported idea with its provenance", async () => {
  await renderLoaded()
  await openSources()
  await openFeed("Studio research")
  expect(screen.getByText("No imports yet.")).toBeInTheDocument()
  // The server creates the inbox idea as part of the run.
  nextImport = (feed) => {
    seedItem("i9", "Creative tools changing", { kind: "rss", feed_id: feed.id, feed_name: feed.name, original_title: "Creative tools changing independent production", body_text: "New creative tools give producers more time.\nQuestions: cost, access, usefulness. <b>literal</b>", published_at: "2026-09-15T09:00:00Z", imported_at: "2026-09-15T09:30:00Z", truncated: true })
    return { created: 1, duplicates: 1, skipped: 2, examined: 4, warnings: ["1 entry had no publish date"], items: [{ title: "Creative tools changing independent production", reason: "created" }, { title: "Repeated creative story", reason: "duplicate: same article" }, { title: "Broken story without link", reason: "skipped: missing link" }] }
  }
  fireEvent.click(screen.getByRole("button", { name: "Import now" }))
  await flush()
  expect(requests("POST", "/feeds/f1/import")[0]?.body).toEqual({ revision: 1 })
  const result = within(importPanel()).getByRole("status")
  expect(result).toHaveTextContent("Imported. 1 new idea · 1 duplicate · 2 skipped · 4 examined.")
  expect(result).toHaveTextContent("1 entry had no publish date")
  expect(result).toHaveAttribute("data-run-status", "succeeded")
  // Feed, history and inbox were reloaded after the run, not assumed.
  expect(requests("GET", "/feeds/f1/runs").length).toBeGreaterThanOrEqual(2)
  expect(requests("GET", "/feeds").filter((call) => new URL(call.url, "http://t").pathname === "/feeds").length).toBeGreaterThanOrEqual(2)
  expect(screen.getByRole("button", { name: "Open Studio research" })).toHaveTextContent("Imported 1 new idea · 1 duplicate · 2 skipped · 4 examined")
  const history = screen.getByRole("list", { name: "Import runs" })
  expect(within(history).getAllByRole("listitem").length).toBeGreaterThanOrEqual(1)
  const row = history.querySelector('[data-run-id="run101"]')!
  expect(row).toHaveTextContent("Succeeded")
  expect(row).toHaveTextContent("1 new idea · 1 duplicate · 2 skipped · 4 examined")
  fireEvent.click(within(row as HTMLElement).getByText("3 entries"))
  expect(row).toHaveTextContent("Repeated creative story — duplicate: same article")
  expect(row).toHaveTextContent("Broken story without link — skipped: missing link")
  expect(screen.getByRole("button", { name: "Import now" })).toBeEnabled()

  // "Open inbox" lands on the reloaded inbox; the imported idea shows its provenance read-only, notes stay editable.
  fireEvent.click(screen.getByRole("button", { name: "Open inbox" }))
  await flush()
  expect(screen.getByRole("heading", { name: "Inbox" })).toBeVisible()
  expect(screen.getByRole("button", { name: "Open Creative tools changing" })).toHaveTextContent("from Studio research")
  expect(screen.getByRole("button", { name: "Open Manual idea" })).not.toHaveTextContent("from")
  fireEvent.click(screen.getByRole("button", { name: "Open Creative tools changing" }))
  await flush()
  const provenance = screen.getByTestId("inbox-provenance")
  // Folded by default: one toggle naming the feed; everything else waits behind it.
  expect(provenance).toHaveTextContent("Imported from Studio research")
  expect(screen.queryByTestId("provenance-body")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Imported from Studio research" })).toHaveAttribute("aria-expanded", "false")
  fireEvent.click(screen.getByRole("button", { name: "Imported from Studio research" }))
  expect(screen.getByRole("button", { name: "Imported from Studio research" })).toHaveAttribute("aria-expanded", "true")
  const body = screen.getByTestId("provenance-body")
  expect(body).toHaveTextContent("Studio research")
  expect(body).toHaveTextContent("Creative tools changing independent production")
  expect(body).toHaveTextContent(/published/)
  expect(body).toHaveTextContent("Truncated: the feed text was longer than the server keeps.")
  expect(body).toHaveTextContent("Original feed text")
  expect(body).toHaveTextContent("New creative tools give producers more time.")
  // Tags are text, never markup.
  expect(body).toHaveTextContent("<b>literal</b>")
  expect(body.querySelector("b")).toBeNull()
  expect(provenance.querySelector("input, textarea")).toBeNull()
  fireEvent.change(screen.getByLabelText("Idea notes"), { target: { value: "my own angle" } })
  fireEvent.click(screen.getByRole("button", { name: "Save idea" }))
  await flush()
  expect(requests("PUT", "/inbox/i9")[0]?.body).toEqual({ revision: 1, text: "Creative tools changing", duration: 120, notes: "my own angle", source_url: "https://example.com/story" })
  expect(screen.getByTestId("provenance-body")).toHaveTextContent("New creative tools give producers more time.")
  // A manual idea shows no provenance block.
  fireEvent.click(screen.getByRole("button", { name: "Open Manual idea" }))
  await flush()
  expect(screen.queryByTestId("inbox-provenance")).not.toBeInTheDocument()
})

test("a failed run is a visible failure, adds nothing, is kept in history, and a retry is only ever deliberate", async () => {
  await renderLoaded()
  await openSources()
  await openFeed("Atom source")
  nextImport = () => ({ status: "failed", error: "Feed returned HTTP 503.", examined: 0 })
  fireEvent.click(screen.getByRole("button", { name: "Import now" }))
  await flush()
  expect(requests("POST", "/feeds/f2/import")).toHaveLength(1)
  const alert = within(importPanel()).getByRole("alert")
  expect(alert).toHaveTextContent("Import failed. Feed returned HTTP 503. Nothing was added to the Inbox.")
  expect(alert).toHaveAttribute("data-run-status", "failed")
  expect(within(importPanel()).queryByRole("status")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Open Atom source" })).toHaveTextContent("Failed: Feed returned HTTP 503.")
  const row = screen.getByRole("list", { name: "Import runs" }).querySelector('[data-run-status="failed"]')!
  expect(row).toHaveTextContent("Failed")
  expect(row).toHaveTextContent("Feed returned HTTP 503.")
  expect(inbox.size).toBe(1)
  // No automatic retry: one request, the button is simply available again.
  await tick(5000)
  expect(requests("POST", "/feeds/f2/import")).toHaveLength(1)
  expect(screen.getByRole("button", { name: "Import now" })).toBeEnabled()

  // A success afterwards replaces the failure banner and both runs stay in history, newest first.
  nextImport = () => ({ created: 1, examined: 1 })
  fireEvent.click(screen.getByRole("button", { name: "Import now" }))
  await flush()
  expect(within(importPanel()).queryByRole("alert")).not.toBeInTheDocument()
  expect(within(importPanel()).getByRole("status")).toHaveTextContent("Imported. 1 new idea")
  const rows = within(screen.getByRole("list", { name: "Import runs" })).getAllByRole("listitem")
  expect(rows[0]).toHaveTextContent("Succeeded")
  expect(rows[1]).toHaveTextContent("Failed")
})

test("a stale save keeps the edits and offers merge or reload; a stale or refused import is reported and reloaded, never retried", async () => {
  await renderLoaded()
  await openSources()
  await openFeed("Studio research")
  // Another screen renames and disables the feed meanwhile.
  feeds.set("f1", { ...feeds.get("f1")!, revision: 2, name: "Renamed elsewhere", enabled: false, can_import: false })
  fireEvent.change(screen.getByLabelText("Default duration"), { target: { value: "300" } })
  fireEvent.click(screen.getByRole("button", { name: "Save feed" }))
  await flush()
  expect(requests("PUT", "/feeds/f1")).toHaveLength(1)
  expect(screen.getByRole("alert")).toHaveTextContent("Not saved.")
  expect(screen.getByLabelText("Default duration")).toHaveValue(300)
  expect(screen.getByRole("button", { name: "Save feed" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Merge with the latest version" }))
  await flush()
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  expect(screen.getByLabelText("Feed name")).toHaveValue("Renamed elsewhere")
  expect(screen.getByLabelText("Default duration")).toHaveValue(300)
  expect(screen.getByLabelText("Enabled")).not.toBeChecked()
  fireEvent.click(screen.getByRole("button", { name: "Save feed" }))
  await flush()
  expect(requests("PUT", "/feeds/f1")[1]?.body).toEqual({ revision: 2, name: "Renamed elsewhere", default_duration: 300, enabled: false })
  expect(feeds.get("f1")?.revision).toBe(3)
  expect(within(importPanel()).getByRole("status")).toHaveTextContent("This feed is disabled.")

  // Reload path: discard explicitly.
  feeds.set("f1", { ...feeds.get("f1")!, revision: 4, default_duration: 99 })
  fireEvent.change(screen.getByLabelText("Default duration"), { target: { value: "150" } })
  fireEvent.click(screen.getByRole("button", { name: "Save feed" }))
  await flush()
  expect(screen.getByRole("alert")).toHaveTextContent("Not saved.")
  fireEvent.click(screen.getByRole("button", { name: "Reload and discard my edits" }))
  await flush()
  expect(screen.getByLabelText("Default duration")).toHaveValue(99)
  expect(requests("PUT", "/feeds/f1")).toHaveLength(3)

  // Import refused because a lease is active elsewhere: reported, feed status reloaded, nothing retried.
  feeds.set("f1", { ...feeds.get("f1")!, enabled: true, can_import: true })
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  await flush()
  expect(screen.getByRole("button", { name: "Import now" })).toBeEnabled()
  feeds.set("f1", { ...feeds.get("f1")!, can_import: false, latest_run: { id: "elsewhere", feed_id: "f1", status: "running", started_at: stamp(), finished_at: null, created: 0, duplicates: 0, skipped: 0, examined: 0, error: null, warnings: [], items: [] } })
  fireEvent.click(screen.getByRole("button", { name: "Import now" }))
  await flush()
  expect(requests("POST", "/feeds/f1/import")).toHaveLength(1)
  expect(sourcesStatus()).toHaveTextContent('Import of "Renamed elsewhere" not started: An import is already running for this feed.')
  expect(screen.getByRole("button", { name: "Import now" })).toBeDisabled()
  expect(within(importPanel()).getByRole("status")).toHaveTextContent("An import is already running for this feed, perhaps from another screen.")
  expect(screen.getByRole("button", { name: "Open Renamed elsewhere" })).toHaveTextContent("Importing…")
  await tick(6000)
  expect(requests("POST", "/feeds/f1/import")).toHaveLength(1)
  expect(document.body.textContent).not.toMatch(/revision/i)

  // Editing while the lease is active is refused by the server: not a stale edit, so no merge banner; the typed value stays.
  fireEvent.change(screen.getByLabelText("Default duration"), { target: { value: "77" } })
  fireEvent.click(screen.getByRole("button", { name: "Save feed" }))
  await flush()
  expect(requests("PUT", "/feeds/f1")).toHaveLength(4)
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  expect(sourcesStatus()).toHaveTextContent("Not saved: This feed is importing. Wait for the result before changing its settings.")
  expect(screen.getByLabelText("Default duration")).toHaveValue(77)
  fireEvent.click(screen.getByRole("button", { name: "Discard edits" }))

  // The lease expires (server recovered): the run still reads "running" but can_import is true again, so a deliberate retry is allowed.
  feeds.set("f1", { ...feeds.get("f1")!, can_import: true })
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  await flush()
  expect(screen.getByRole("button", { name: "Import now" })).toBeEnabled()
  expect(within(importPanel()).getByRole("status")).toHaveTextContent("The last import did not finish")
  expect(screen.getByRole("button", { name: "Open Renamed elsewhere" })).toHaveTextContent("Last import was interrupted · Import now to retry")
  // And polling has stopped: nothing is in progress any more.
  const settled = requests("GET", "/feeds").filter((call) => new URL(call.url, "http://t").pathname === "/feeds").length
  await tick(4000)
  expect(requests("GET", "/feeds").filter((call) => new URL(call.url, "http://t").pathname === "/feeds").length).toBe(settled)
  expect(requests("POST", "/feeds/f1/import")).toHaveLength(1)
})

test("a slow import never locks the other feed or lands on it; its result waits for its own feed; polling runs only while visible and never overrides local edits", async () => {
  await renderLoaded()
  await openSources()
  await openFeed("Studio research")
  holdPattern = /^POST \/feeds\/f1\/import$/
  fireEvent.click(screen.getByRole("button", { name: "Import now" }))
  await flush()
  expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Open Studio research" })).toHaveTextContent("Importing…")

  // Switch to the other feed while the import is pending: its editor is fully usable.
  await openFeed("Atom source")
  expect(screen.getByRole("button", { name: "Import now" })).toBeEnabled()
  expect(screen.getByLabelText("Feed name")).toBeEnabled()
  fireEvent.change(screen.getByLabelText("Feed name"), { target: { value: "Atom edited" } })
  expect(screen.getByRole("button", { name: "Save feed" })).toBeEnabled()

  // Polling (2 s) while a run is in progress reloads server status but never the typed name.
  const listCalls = () => requests("GET", "/feeds").filter((call) => new URL(call.url, "http://t").pathname === "/feeds").length
  const before = listCalls()
  await tick(2000)
  await tick(2000)
  expect(listCalls()).toBe(before + 2)
  expect(screen.getByLabelText("Feed name")).toHaveValue("Atom edited")
  // Hidden view: no polling.
  fireEvent.click(screen.getByRole("button", { name: "Inbox" }))
  await flush()
  const hiddenCount = listCalls()
  await tick(4000)
  expect(listCalls()).toBe(hiddenCount)
  fireEvent.click(screen.getByRole("button", { name: "Sources" }))
  await flush()
  expect(screen.getByLabelText("Feed name")).toHaveValue("Atom edited")

  // The delayed result arrives: it belongs to the first feed only.
  release("POST /feeds/f1/import")
  await flush()
  expect(importPanel()).not.toHaveTextContent("Imported.")
  expect(within(importPanel()).queryByRole("alert")).not.toBeInTheDocument()
  expect(screen.getByLabelText("Feed name")).toHaveValue("Atom edited")
  expect(screen.getByRole("button", { name: "Open Studio research" })).toHaveTextContent("Imported 2 new ideas")
  expect(screen.getByRole("button", { name: "Open Studio research" })).not.toHaveTextContent("Importing…")
  // Once the run is over, polling stops.
  const settled = listCalls()
  await tick(4000)
  expect(listCalls()).toBe(settled)

  // Going back to the first feed (after guarding the unsaved edit) shows its result and history.
  fireEvent.click(screen.getByRole("button", { name: "Open Studio research" }))
  expect(screen.getByRole("dialog", { name: "Unsaved changes" })).toHaveTextContent('"Atom edited" has unsaved changes. Opening "Studio research" will discard them.')
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }))
  expect(screen.getByLabelText("Feed name")).toHaveValue("Atom edited")
  fireEvent.click(screen.getByRole("button", { name: "Open Studio research" }))
  fireEvent.click(screen.getByRole("button", { name: "Discard and open" }))
  await flush()
  expect(screen.getByLabelText("Feed name")).toHaveValue("Studio research")
  expect(within(importPanel()).getByRole("status")).toHaveTextContent("Imported. 2 new ideas · 1 duplicate · 1 skipped · 4 examined.")
  expect(screen.getByRole("list", { name: "Import runs" })).toHaveTextContent("Succeeded")
  expect(feeds.get("f2")?.name).toBe("Atom source")
  // Only one import was ever sent for the first feed, none for the second.
  expect(requests("POST", "/feeds/f1/import")).toHaveLength(1)
  expect(requests("POST", "/feeds/f2/import")).toHaveLength(0)
})

test("a double click sends one import, and navigation keeps an unsaved new feed", async () => {
  await renderLoaded()
  await openSources()
  await openFeed("Studio research")
  holdPattern = /^POST \/feeds\/f1\/import$/
  const button = screen.getByRole("button", { name: "Import now" })
  fireEvent.click(button)
  fireEvent.click(button)
  await flush()
  expect(requests("POST", "/feeds/f1/import")).toHaveLength(1)
  release("POST /feeds/f1/import")
  await flush()
  holdPattern = null

  fireEvent.click(screen.getByRole("button", { name: "New feed" }))
  await flush()
  fireEvent.change(screen.getByLabelText("Feed name"), { target: { value: "Half typed" } })
  fireEvent.change(screen.getByLabelText("Feed URL"), { target: { value: "http://127.0.0.1:8168/atom.xml" } })
  fireEvent.click(screen.getByRole("button", { name: "Tonight's Show" }))
  await flush()
  fireEvent.click(screen.getByRole("button", { name: "Saved Shows" }))
  await flush()
  fireEvent.click(screen.getByRole("button", { name: "Sources" }))
  await flush()
  expect(screen.getByLabelText("Feed name")).toHaveValue("Half typed")
  expect(screen.getByLabelText("Feed URL")).toHaveValue("http://127.0.0.1:8168/atom.xml")
  // Opening another feed with the unsaved new feed asks first.
  fireEvent.click(screen.getByRole("button", { name: "Open Atom source" }))
  expect(screen.getByRole("dialog", { name: "Unsaved changes" })).toHaveTextContent("Your new feed has not been saved.")
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }))
  expect(screen.getByLabelText("Feed name")).toHaveValue("Half typed")
  expect(requests("POST", "/feeds").filter((call) => new URL(call.url, "http://t").pathname === "/feeds")).toHaveLength(0)
  expect(requests("PUT", "/rundown")).toHaveLength(0)
  expect(requests("POST", "/rundown")).toHaveLength(0)
})
