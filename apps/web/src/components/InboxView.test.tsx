import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import App from "../App"
import type { InboxItem, SavedShow, ShowState } from "../lib/api"

// Inbox view and both inbox pickers rendered through App so navigation,
// live-draft coupling and saved-draft coupling are exercised the way a user
// reaches them. The fetch mock is a small in-memory server following the
// frozen /inbox contract (revision guard, archived guard, projection).

type Call = { method: string; url: string; body?: unknown }
type Topic = { id?: string | null; text: string; duration: number; notes?: string }

let live: ShowState
let saved: Map<string, SavedShow>
let inbox: Map<string, InboxItem>
let calls: Call[]
let ids: number
let clock: number
let holds: Map<string, Array<() => void>>
let holdPattern: RegExp | null

function liveState(patch: Partial<ShowState> = {}): ShowState {
  return {
    revision: 3,
    topics: [
      { id: "a", text: "Opening", duration: 120, notes: "" },
      { id: "b", text: "Second", duration: 90, notes: "live note" },
    ],
    current_topic_id: "a",
    remaining_seconds: 100,
    paused: false,
    server_time: "2026-09-14T00:00:00.000Z",
    ...patch,
  }
}

function stamp(): string {
  clock += 1
  return new Date(Date.UTC(2026, 8, 15, 0, 0, clock)).toISOString()
}

function project(text: string, duration: number, notes: string, source_url: string) {
  return { text, duration, notes: `${notes}${notes && source_url ? "\n\n" : ""}${source_url ? `Source: ${source_url}` : ""}` }
}

function seedItem(id: string, text: string, duration: number, notes: string, source_url: string, archived = false): InboxItem {
  const at = stamp()
  const entry: InboxItem = { id, revision: 1, text, duration, notes, source_url, archived, created_at: at, updated_at: at, topic: project(text, duration, notes, source_url), source: null }
  inbox.set(id, entry)
  return entry
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function validateInbox(payload: Record<string, unknown>): string | null {
  const text = typeof payload.text === "string" ? payload.text.trim() : ""
  if (Array.from(text).length < 1 || Array.from(text).length > 30) return "text must be 1-30 characters"
  if (!Number.isInteger(payload.duration) || (payload.duration as number) < 15 || (payload.duration as number) > 3600) return "duration must be an integer 15-3600"
  const notes = payload.notes ?? ""
  if (typeof notes !== "string" || Array.from(notes).length > 10000) return "notes too long"
  const url = payload.source_url ?? ""
  if (typeof url !== "string") return "bad url"
  if (url.length > 0 && !/^https?:\/\/[^\s@/]+[^\s]*$/.test(url)) return "source_url must be an absolute http(s) URL"
  if ("id" in payload || "archived" in payload) return "unexpected field"
  return null
}

function serve(method: string, url: string, body: unknown): Response {
  const parsed = new URL(url, "http://test.local")
  const path = parsed.pathname
  if (path === "/rundown/state") return json(live)
  if (path === "/rundown/schedule" && method === "PUT") {
    const payload = body as { revision: number; topics: Topic[] }
    if (payload.revision !== live.revision) return json({ detail: "stale" }, 409)
    const topics = payload.topics.map((topic) => ({ id: topic.id ?? `lt${++ids}`, text: topic.text, duration: topic.duration, notes: topic.notes ?? "" }))
    live = { ...live, revision: live.revision + 1, topics, server_time: stamp() }
    return json(live)
  }
  if (path === "/rundown/control" && method === "POST") {
    live = { ...live, revision: live.revision + 1 }
    return json(live)
  }
  if (path === "/shows" && method === "GET") {
    return json({ shows: [...saved.values()].map((entry) => ({ id: entry.id, name: entry.name, revision: entry.revision, topic_count: entry.topics.length, total_seconds: 0, created_at: entry.created_at, updated_at: entry.updated_at })) })
  }
  if (path === "/shows" && method === "POST") {
    const payload = body as { name: string; topics?: Topic[] }
    const id = `s${++ids}`
    const created: SavedShow = { id, name: payload.name, revision: 1, topics: (payload.topics ?? []).map((topic) => ({ id: `st${++ids}`, text: topic.text, duration: topic.duration, notes: topic.notes ?? "" })), created_at: stamp(), updated_at: stamp() }
    saved.set(id, created)
    return json(created, 201)
  }
  const showDetail = /^\/shows\/([^/]+)$/.exec(path)
  if (showDetail) {
    const entry = saved.get(showDetail[1] ?? "")
    if (!entry) return json({ detail: "Saved show not found." }, 404)
    if (method === "GET") return json(entry)
    if (method === "PUT") {
      const payload = body as { revision: number; name: string; topics: Topic[] }
      if (payload.revision !== entry.revision) return json({ detail: "Saved show changed." }, 409)
      const next: SavedShow = { ...entry, name: payload.name, revision: entry.revision + 1, topics: payload.topics.map((topic) => ({ id: topic.id ?? `st${++ids}`, text: topic.text, duration: topic.duration, notes: topic.notes ?? "" })), updated_at: stamp() }
      saved.set(entry.id, next)
      return json(next)
    }
  }
  if (path === "/inbox" && method === "GET") {
    const archived = parsed.searchParams.get("archived") === "true"
    const items = [...inbox.values()].filter((entry) => entry.archived === archived).sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
    return json({ items })
  }
  if (path === "/inbox" && method === "POST") {
    const payload = body as Record<string, unknown>
    const problem = validateInbox(payload)
    if (problem) return json({ detail: problem }, 422)
    const id = `i${++ids}`
    const text = (payload.text as string).trim()
    const created = seedItem(id, text, payload.duration as number, (payload.notes as string | undefined) ?? "", ((payload.source_url as string | undefined) ?? "").trim())
    return json(created, 201)
  }
  const inboxDetail = /^\/inbox\/([^/]+)(\/archive)?$/.exec(path)
  if (inboxDetail) {
    const entry = inbox.get(inboxDetail[1] ?? "")
    if (!entry) return json({ detail: "Inbox item not found." }, 404)
    if (method === "GET" && !inboxDetail[2]) return json(entry)
    if (method === "PUT" && !inboxDetail[2]) {
      const payload = body as Record<string, unknown>
      const problem = validateInbox(payload)
      if (problem) return json({ detail: problem }, 422)
      if (payload.revision !== entry.revision) return json({ detail: "Inbox item changed on another screen." }, 409)
      if (entry.archived) return json({ detail: "Inbox item is archived; restore it before editing." }, 409)
      const text = (payload.text as string).trim()
      const source_url = (payload.source_url as string).trim()
      const next: InboxItem = { ...entry, revision: entry.revision + 1, text, duration: payload.duration as number, notes: payload.notes as string, source_url, updated_at: stamp(), topic: project(text, payload.duration as number, payload.notes as string, source_url) }
      inbox.set(entry.id, next)
      return json(next)
    }
    if (method === "POST" && inboxDetail[2]) {
      const payload = body as { revision: number; archived: boolean }
      if (payload.revision !== entry.revision) return json({ detail: "Inbox item changed on another screen." }, 409)
      if (payload.archived === entry.archived) return json(entry)
      const next: InboxItem = { ...entry, revision: entry.revision + 1, archived: payload.archived, updated_at: stamp() }
      inbox.set(entry.id, next)
      return json(next)
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
  saved = new Map()
  inbox = new Map()
  calls = []
  ids = 100
  clock = 0
  holds = new Map()
  holdPattern = null
  saved.set("s1", { id: "s1", name: "Friday template", revision: 1, topics: [{ id: "s1-t1", text: "Cold open", duration: 60, notes: "" }], created_at: "2026-09-13T00:00:00.000Z", updated_at: "2026-09-13T00:00:00.000Z" })
  seedItem("i1", "Rent strike", 180, "tenants organising\n- who\n- why", "https://example.com/rent")
  seedItem("i2", "Old idea", 60, "", "", true)
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

async function renderLoaded() {
  render(<App />)
  await flush()
  expect(await screen.findByDisplayValue("Opening")).toBeInTheDocument()
}

async function openInbox() {
  fireEvent.click(screen.getByRole("button", { name: "Inbox" }))
  await flush()
  expect(screen.getByRole("heading", { name: "Inbox" })).toBeVisible()
}

async function openIdea(text: string) {
  fireEvent.click(screen.getByRole("button", { name: `Open ${text}` }))
  await flush()
  expect(screen.getByLabelText("Idea title")).toHaveValue(text)
}

function requests(method: string, pathStart: string) {
  return calls.filter((call) => call.method === method && new URL(call.url, "http://test.local").pathname.startsWith(pathStart))
}

function inboxStatus() {
  const status = document.querySelector("#inbox .publish-status")
  if (!status) throw new Error("inbox status line not rendered")
  return status
}

const RENT_PROJECTION = "tenants organising\n- who\n- why\n\nSource: https://example.com/rent"

test("capture an idea with title, duration, context and source; it saves without an id, reopens, and renders a safe source link", async () => {
  await renderLoaded()
  await openInbox()
  expect(screen.getByRole("button", { name: "Open Rent strike" })).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Open Old idea" })).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "New idea" }))
  await flush()
  fireEvent.change(screen.getByLabelText("Idea title"), { target: { value: "  Bus fares  " } })
  fireEvent.change(screen.getByLabelText("Idea duration"), { target: { value: "240" } })
  fireEvent.change(screen.getByLabelText("Idea notes"), { target: { value: "line one\n\nline two  " } })
  fireEvent.change(screen.getByLabelText("Source URL"), { target: { value: " https://news.example/fares?x=1 " } })
  const link = screen.getByRole("link", { name: "Open original ↗" })
  expect(link).toHaveAttribute("href", "https://news.example/fares?x=1")
  expect(link).toHaveAttribute("target", "_blank")
  expect(link).toHaveAttribute("rel", "noopener noreferrer")

  fireEvent.click(screen.getByRole("button", { name: "Save idea" }))
  await flush()
  const [post] = requests("POST", "/inbox")
  expect(post?.body).toEqual({ text: "Bus fares", duration: 240, notes: "line one\n\nline two  ", source_url: "https://news.example/fares?x=1" })
  expect(inboxStatus()).toHaveTextContent('Saved "Bus fares"')
  expect(screen.getByLabelText("Idea title")).toHaveValue("Bus fares")
  expect(screen.getByLabelText("Idea notes")).toHaveValue("line one\n\nline two  ")
  expect(screen.getByRole("button", { name: "Open Bus fares" })).toHaveAttribute("aria-current", "true")
  expect(screen.getByRole("button", { name: "Save idea" })).toBeDisabled()
  // Nothing live was touched.
  expect(requests("PUT", "/rundown").length + requests("POST", "/rundown").length).toBe(0)
})

test("unsafe or malformed source URLs are refused before saving and never rendered as links", async () => {
  await renderLoaded()
  await openInbox()
  fireEvent.click(screen.getByRole("button", { name: "New idea" }))
  await flush()
  fireEvent.change(screen.getByLabelText("Idea title"), { target: { value: "Bad link" } })
  for (const bad of ["javascript:alert(1)", "ftp://files.example/x", "example.com/story", "https://user:pw@example.com/", "https://@example.com/", "https:example.com", "https://example.com/a\\b"]) {
    fireEvent.change(screen.getByLabelText("Source URL"), { target: { value: bad } })
    expect(screen.queryByRole("link", { name: "Open original ↗" })).not.toBeInTheDocument()
    expect(screen.getByLabelText("Source URL")).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByRole("button", { name: "Save idea" })).toBeDisabled()
  }
  fireEvent.change(screen.getByLabelText("Idea duration"), { target: { value: "5" } })
  fireEvent.change(screen.getByLabelText("Source URL"), { target: { value: "" } })
  expect(screen.getByRole("button", { name: "Save idea" })).toBeDisabled()
  expect(inboxStatus()).toHaveTextContent("Duration must be a whole number")
  expect(requests("POST", "/inbox")).toHaveLength(0)
})

test("edit sends the full record with its revision; archive hides it from Active, shows it under Archived, restore brings it back", async () => {
  await renderLoaded()
  await openInbox()
  await openIdea("Rent strike")
  fireEvent.change(screen.getByLabelText("Idea notes"), { target: { value: "updated context" } })
  expect(screen.getByRole("button", { name: "Archive" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Save idea" }))
  await flush()
  const [put] = requests("PUT", "/inbox/i1")
  expect(put?.body).toEqual({ revision: 1, text: "Rent strike", duration: 180, notes: "updated context", source_url: "https://example.com/rent" })
  expect(inbox.get("i1")?.revision).toBe(2)

  fireEvent.click(screen.getByRole("button", { name: "Archive" }))
  await flush()
  const [archive] = requests("POST", "/inbox/i1/archive")
  expect(archive?.body).toEqual({ revision: 2, archived: true })
  expect(inboxStatus()).toHaveTextContent('Archived "Rent strike"')
  expect(screen.queryByRole("button", { name: "Open Rent strike" })).not.toBeInTheDocument()
  expect(screen.getByLabelText("Idea title")).toBeDisabled()
  expect(screen.queryByRole("button", { name: "Save idea" })).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "Archived" }))
  await flush()
  expect(screen.getByRole("button", { name: "Open Rent strike" })).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Open Old idea" })).toBeInTheDocument()
  await openIdea("Rent strike")
  fireEvent.click(screen.getByRole("button", { name: "Restore" }))
  await flush()
  expect(requests("POST", "/inbox/i1/archive")[1]?.body).toEqual({ revision: 3, archived: false })
  expect(inbox.get("i1")?.archived).toBe(false)
  expect(screen.getByLabelText("Idea title")).toBeEnabled()
  expect(inboxStatus()).toHaveTextContent('Restored "Rent strike"')
})

test("changing idea, filter or starting new with unsaved edits asks first; keep editing keeps everything, discard proceeds", async () => {
  await renderLoaded()
  await openInbox()
  await openIdea("Rent strike")
  fireEvent.change(screen.getByLabelText("Idea title"), { target: { value: "Rent strike v2" } })

  fireEvent.click(screen.getByRole("button", { name: "Archived" }))
  expect(screen.getByRole("dialog", { name: "Unsaved changes" })).toHaveTextContent("Switching to archived ideas will discard them.")
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }))
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  expect(screen.getByLabelText("Idea title")).toHaveValue("Rent strike v2")
  expect(screen.getByRole("button", { name: "Active" })).toHaveAttribute("aria-pressed", "true")

  fireEvent.click(screen.getByRole("button", { name: "New idea" }))
  expect(screen.getByRole("dialog", { name: "Unsaved changes" })).toHaveTextContent("Starting a new idea will discard them.")
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }))
  expect(screen.getByLabelText("Idea title")).toHaveValue("Rent strike v2")

  fireEvent.click(screen.getByRole("button", { name: "Archived" }))
  fireEvent.click(screen.getByRole("button", { name: "Discard and switch" }))
  await flush()
  expect(screen.getByRole("button", { name: "Archived" })).toHaveAttribute("aria-pressed", "true")
  expect(screen.queryByLabelText("Idea title")).not.toBeInTheDocument()
  expect(requests("PUT", "/inbox")).toHaveLength(0)
  expect(inbox.get("i1")?.text).toBe("Rent strike")
})

test("a stale save keeps the draft and offers merge or reload; nothing is retried on its own", async () => {
  await renderLoaded()
  await openInbox()
  await openIdea("Rent strike")
  // Another screen edits the same idea meanwhile.
  const other = inbox.get("i1")!
  inbox.set("i1", { ...other, revision: 2, notes: "changed elsewhere", updated_at: stamp(), topic: project(other.text, other.duration, "changed elsewhere", other.source_url) })

  fireEvent.change(screen.getByLabelText("Idea title"), { target: { value: "Rent strike now" } })
  fireEvent.click(screen.getByRole("button", { name: "Save idea" }))
  await flush()
  expect(requests("PUT", "/inbox/i1")).toHaveLength(1)
  expect(screen.getByRole("alert")).toHaveTextContent("Not saved.")
  expect(screen.getByLabelText("Idea title")).toHaveValue("Rent strike now")
  expect(screen.getByRole("button", { name: "Save idea" })).toBeDisabled()
  expect(document.body.textContent).not.toMatch(/revision/i)

  fireEvent.click(screen.getByRole("button", { name: "Merge with the latest version" }))
  await flush()
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  expect(screen.getByLabelText("Idea title")).toHaveValue("Rent strike now")
  expect(screen.getByLabelText("Idea notes")).toHaveValue("changed elsewhere")
  fireEvent.click(screen.getByRole("button", { name: "Save idea" }))
  await flush()
  expect(requests("PUT", "/inbox/i1")[1]?.body).toMatchObject({ revision: 2, text: "Rent strike now", notes: "changed elsewhere" })
  expect(inbox.get("i1")?.revision).toBe(3)

  // Reload path: discard explicitly.
  inbox.set("i1", { ...inbox.get("i1")!, revision: 4, text: "Server title" })
  fireEvent.change(screen.getByLabelText("Idea title"), { target: { value: "Local again" } })
  fireEvent.click(screen.getByRole("button", { name: "Save idea" }))
  await flush()
  expect(screen.getByRole("alert")).toHaveTextContent("Not saved.")
  fireEvent.click(screen.getByRole("button", { name: "Reload and discard my edits" }))
  await flush()
  expect(screen.getByLabelText("Idea title")).toHaveValue("Server title")
  expect(requests("PUT", "/inbox/i1")).toHaveLength(3)
})

test("an idea archived elsewhere: the save is refused, edits are kept, restore then save keeps them", async () => {
  await renderLoaded()
  await openInbox()
  await openIdea("Rent strike")
  inbox.set("i1", { ...inbox.get("i1")!, revision: 2, archived: true })
  fireEvent.change(screen.getByLabelText("Idea notes"), { target: { value: "still mine" } })
  fireEvent.click(screen.getByRole("button", { name: "Save idea" }))
  await flush()
  expect(screen.getByRole("alert")).toHaveTextContent("Not saved.")
  fireEvent.click(screen.getByRole("button", { name: "Merge with the latest version" }))
  await flush()
  expect(inboxStatus()).toHaveTextContent("archived meanwhile. Restore it to save them.")
  expect(screen.getByLabelText("Idea notes")).toBeDisabled()
  expect(screen.getByLabelText("Idea notes")).toHaveValue("still mine")
  fireEvent.click(screen.getByRole("button", { name: "Restore" }))
  await flush()
  expect(requests("POST", "/inbox/i1/archive")[0]?.body).toEqual({ revision: 2, archived: false })
  expect(screen.getByLabelText("Idea notes")).toHaveValue("still mine")
  fireEvent.click(screen.getByRole("button", { name: "Save idea" }))
  await flush()
  expect(inbox.get("i1")).toMatchObject({ revision: 4, archived: false, notes: "still mine" })
})

test("live picker: a copy carries the server projection into the draft only; Insert next lands after the current segment; a double click adds one row", async () => {
  await renderLoaded()
  fireEvent.click(screen.getByRole("button", { name: "Add from inbox…" }))
  await flush()
  expect(screen.getByRole("list", { name: "Active inbox ideas" })).toHaveTextContent("Rent strike")
  expect(screen.queryByText("Old idea")).not.toBeInTheDocument()

  const insertNext = screen.getByRole("button", { name: 'Insert next: "Rent strike"' })
  fireEvent.click(insertNext)
  fireEvent.click(insertNext)
  await flush()
  expect(requests("GET", "/inbox/i1")).toHaveLength(1)
  const titles = screen.getAllByLabelText(/^Topic \d title$/).map((input) => (input as HTMLInputElement).value)
  expect(titles).toEqual(["Opening", "Rent strike", "Second"])
  expect(screen.getByLabelText("Topic 2 duration")).toHaveValue(180)
  fireEvent.click(screen.getByRole("button", { name: "Notes for topic 2" }))
  expect(screen.getByLabelText("Topic 2 notes")).toHaveValue(RENT_PROJECTION)
  expect(within(document.getElementById("live-inbox-picker")!).getByRole("status")).toHaveTextContent("independent copy")
  expect(screen.getByText(/inserted after the current segment from the inbox as an independent copy/)).toBeInTheDocument()
  // Draft only: nothing published, no transport action.
  expect(requests("PUT", "/rundown/schedule")).toHaveLength(0)
  expect(requests("POST", "/rundown/control")).toHaveLength(0)
  expect(screen.getByRole("button", { name: "Publish schedule" })).toBeEnabled()

  // Publish carries the copied notes verbatim; the inbox item is untouched.
  fireEvent.click(screen.getByRole("button", { name: "Publish schedule" }))
  await flush()
  const [publish] = requests("PUT", "/rundown/schedule")
  expect((publish?.body as { topics: Topic[] }).topics[1]).toEqual({ text: "Rent strike", duration: 180, notes: RENT_PROJECTION })
  expect(inbox.get("i1")).toMatchObject({ revision: 1, archived: false })
  expect(requests("PUT", "/inbox")).toHaveLength(0)
})

test("live picker: a delayed authoritative fetch is dropped after navigating away, refused after archive elsewhere, and blocked when full", async () => {
  await renderLoaded()
  fireEvent.click(screen.getByRole("button", { name: "Add from inbox…" }))
  await flush()

  // 1. Navigate away while the fetch is pending: nothing lands in the live draft, even after coming back.
  holdPattern = /^GET \/inbox\/i1$/
  fireEvent.click(screen.getByRole("button", { name: 'Add to end: "Rent strike"' }))
  await flush()
  fireEvent.click(screen.getByRole("button", { name: "Saved Shows" }))
  await flush()
  fireEvent.click(screen.getByRole("button", { name: "Tonight's Show" }))
  await flush()
  release("GET /inbox/i1")
  await flush()
  expect(screen.getAllByLabelText(/^Topic \d title$/)).toHaveLength(2)
  expect(document.querySelector("#schedule .publish-status")).toHaveTextContent('Not added: the show changed while "Rent strike" was loading')
  expect(screen.getByRole("button", { name: 'Add to end: "Rent strike"' })).toBeEnabled()

  // 1b. The live show moves on (another screen presses Next) while the fetch is pending: dropped, never inserted against a stale segment.
  fireEvent.click(screen.getByRole("button", { name: 'Insert next: "Rent strike"' }))
  await flush()
  live = { ...live, revision: live.revision + 1, current_topic_id: "b", server_time: "2026-09-14T00:00:01.000Z" }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  release("GET /inbox/i1")
  await flush()
  expect(screen.getAllByLabelText(/^Topic \d title$/)).toHaveLength(2)
  expect(screen.getByRole("button", { name: 'Insert next: "Rent strike"' })).toBeEnabled()
  holdPattern = null

  // 2. Archived on another screen between the list and the pick: refused, list refreshed.
  inbox.set("i1", { ...inbox.get("i1")!, revision: 2, archived: true })
  fireEvent.click(screen.getByRole("button", { name: 'Add to end: "Rent strike"' }))
  await flush()
  expect(screen.getAllByLabelText(/^Topic \d title$/)).toHaveLength(2)
  expect(within(document.getElementById("live-inbox-picker")!).getByRole("alert")).toHaveTextContent("was archived on another screen")
  expect(screen.queryByRole("button", { name: 'Add to end: "Rent strike"' })).not.toBeInTheDocument()

  // 3. Full schedule: the picker is blocked and says so.
  inbox.set("i1", { ...inbox.get("i1")!, archived: false })
  seedItem("i3", "Fresh", 30, "", "")
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  await flush()
  for (let n = 0; n < 18; n += 1) {
    fireEvent.change(screen.getByLabelText("New topic title"), { target: { value: `Filler ${n}` } })
    fireEvent.click(screen.getByRole("button", { name: "Add to end" }))
  }
  expect(screen.getAllByLabelText(/^Topic \d+ title$/)).toHaveLength(20)
  expect(screen.getByRole("button", { name: 'Add to end: "Fresh"' })).toBeDisabled()
  expect(within(document.getElementById("live-inbox-picker")!).getByRole("status")).toHaveTextContent("Schedule is full (20 topics).")
  expect(requests("GET", "/inbox/i3")).toHaveLength(0)
})

test("saved picker: the copy joins the saved draft, Save show posts it, and later inbox edits or archive leave the saved copy unchanged", async () => {
  await renderLoaded()
  fireEvent.click(screen.getByRole("button", { name: "Saved Shows" }))
  await flush()
  fireEvent.click(screen.getByRole("button", { name: "Open Friday template" }))
  await flush()
  expect(screen.getByLabelText("Show name")).toHaveValue("Friday template")
  fireEvent.click(screen.getByRole("button", { name: "Add from inbox…" }))
  await flush()
  fireEvent.click(screen.getByRole("button", { name: 'Add to show: "Rent strike"' }))
  await flush()
  expect(screen.getAllByLabelText(/^Saved topic \d title$/).map((input) => (input as HTMLInputElement).value)).toEqual(["Cold open", "Rent strike"])
  fireEvent.click(screen.getByRole("button", { name: "Notes for saved topic 2" }))
  expect(screen.getByLabelText("Saved topic 2 notes")).toHaveValue(RENT_PROJECTION)
  expect(requests("PUT", "/shows/s1")).toHaveLength(0)
  expect(saved.get("s1")?.topics).toHaveLength(1)

  fireEvent.click(screen.getByRole("button", { name: "Save show" }))
  await flush()
  const [put] = requests("PUT", "/shows/s1")
  expect((put?.body as { topics: Topic[] }).topics[1]).toEqual({ text: "Rent strike", duration: 180, notes: RENT_PROJECTION })
  expect(saved.get("s1")?.topics[1]?.notes).toBe(RENT_PROJECTION)

  // Independence: change and archive the inbox idea afterwards; the saved copy is what it was.
  await openInbox()
  await openIdea("Rent strike")
  fireEvent.change(screen.getByLabelText("Idea notes"), { target: { value: "rewritten later" } })
  fireEvent.click(screen.getByRole("button", { name: "Save idea" }))
  await flush()
  fireEvent.click(screen.getByRole("button", { name: "Archive" }))
  await flush()
  expect(inbox.get("i1")).toMatchObject({ archived: true, notes: "rewritten later" })
  expect(saved.get("s1")?.topics[1]?.notes).toBe(RENT_PROJECTION)
  expect(live.topics.map((topic) => topic.text)).toEqual(["Opening", "Second"])
})

test("saved picker: a pick that resolves after the selection changed is dropped", async () => {
  await renderLoaded()
  fireEvent.click(screen.getByRole("button", { name: "Saved Shows" }))
  await flush()
  fireEvent.click(screen.getByRole("button", { name: "New show" }))
  await flush()
  fireEvent.click(screen.getByRole("button", { name: "Add from inbox…" }))
  await flush()
  holdPattern = /^GET \/inbox\/i1$/
  fireEvent.click(screen.getByRole("button", { name: 'Add to show: "Rent strike"' }))
  await flush()
  // The pristine new show is not guarded, so opening another show replaces it (and closes the picker).
  fireEvent.click(screen.getByRole("button", { name: "Open Friday template" }))
  await flush()
  release("GET /inbox/i1")
  await flush()
  expect(screen.getByLabelText("Show name")).toHaveValue("Friday template")
  expect(screen.getAllByLabelText(/^Saved topic \d title$/)).toHaveLength(1)
  expect(document.querySelector("#shows .publish-status")).toHaveTextContent('Not added: you moved on while "Rent strike" was loading')

  // Away and back while a pick is loading: the hidden saved draft is never mutated.
  fireEvent.click(screen.getByRole("button", { name: "Add from inbox…" }))
  await flush()
  fireEvent.click(screen.getByRole("button", { name: 'Add to show: "Rent strike"' }))
  await flush()
  fireEvent.click(screen.getByRole("button", { name: "Tonight's Show" }))
  await flush()
  fireEvent.click(screen.getByRole("button", { name: "Saved Shows" }))
  await flush()
  release("GET /inbox/i1")
  await flush()
  expect(screen.getAllByLabelText(/^Saved topic \d title$/)).toHaveLength(1)
  expect(requests("PUT", "/shows")).toHaveLength(0)
})

test("navigation keeps unsaved inbox, live and saved drafts plus quick-add text; no transport action is ever sent", async () => {
  await renderLoaded()
  fireEvent.change(screen.getByLabelText("Topic 1 title"), { target: { value: "Opening edited" } })
  fireEvent.change(screen.getByLabelText("New topic title"), { target: { value: "typed but not added" } })
  await openInbox()
  fireEvent.click(screen.getByRole("button", { name: "New idea" }))
  await flush()
  fireEvent.change(screen.getByLabelText("Idea title"), { target: { value: "Half typed" } })
  fireEvent.change(screen.getByLabelText("Source URL"), { target: { value: "https://x.example/y" } })
  fireEvent.click(screen.getByRole("button", { name: "Saved Shows" }))
  await flush()
  fireEvent.click(screen.getByRole("button", { name: "New show" }))
  await flush()
  fireEvent.change(screen.getByLabelText("Show name"), { target: { value: "Draft show" } })
  fireEvent.click(screen.getByRole("button", { name: "Tonight's Show" }))
  await flush()
  expect(screen.getByLabelText("Topic 1 title")).toHaveValue("Opening edited")
  expect(screen.getByLabelText("New topic title")).toHaveValue("typed but not added")
  await openInbox()
  expect(screen.getByLabelText("Idea title")).toHaveValue("Half typed")
  expect(screen.getByLabelText("Source URL")).toHaveValue("https://x.example/y")
  fireEvent.click(screen.getByRole("button", { name: "Saved Shows" }))
  await flush()
  expect(screen.getByLabelText("Show name")).toHaveValue("Draft show")
  expect(requests("POST", "/rundown/control")).toHaveLength(0)
  expect(requests("PUT", "/rundown/schedule")).toHaveLength(0)
  expect(requests("POST", "/inbox")).toHaveLength(0)
})
