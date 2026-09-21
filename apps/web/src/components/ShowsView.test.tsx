import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import App from "../App"
import type { SavedShow, ShowState } from "../lib/api"

// Saved-shows view rendered through App so navigation, live-state coupling and
// activation hand-off are exercised the way a user reaches them.

type Call = { method: string; url: string; body?: unknown }
type Topic = { id?: string | null; text: string; duration: number; notes?: string }

let live: ShowState
let saved: Map<string, SavedShow>
let calls: Call[]
let ids: number
/** Requests whose response is held until released, keyed by method+path. */
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

function show(id: string, name: string, topics: Array<{ text: string; duration: number; notes: string }>, revision = 1): SavedShow {
  return {
    id,
    name,
    revision,
    topics: topics.map((topic, index) => ({ id: `${id}-t${index + 1}`, ...topic })),
    created_at: "2026-09-13T00:00:00.000Z",
    updated_at: "2026-09-13T00:00:00.000Z",
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function summaryOf(entry: SavedShow) {
  return {
    id: entry.id,
    name: entry.name,
    revision: entry.revision,
    topic_count: entry.topics.length,
    total_seconds: entry.topics.reduce((sum, topic) => sum + topic.duration, 0),
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  }
}

function materialize(topics: Topic[], existing?: SavedShow) {
  return topics.map((topic) => {
    const prior = topic.id ? existing?.topics.find((row) => row.id === topic.id) : undefined
    return { id: topic.id ?? `new-${++ids}`, text: topic.text, duration: topic.duration, notes: topic.notes ?? prior?.notes ?? "" }
  })
}

function maybeHold(key: string, response: Response): Promise<Response> | Response {
  if (!holdPattern || !holdPattern.test(key)) return response
  return new Promise<Response>((resolve) => {
    const list = holds.get(key) ?? []
    list.push(() => resolve(response))
    holds.set(key, list)
  })
}

function release(key: string, index = 0) {
  const list = holds.get(key) ?? []
  const [fn] = list.splice(index, 1)
  if (!fn) throw new Error(`nothing held for ${key}`)
  fn()
}

function serve(method: string, url: string, body: unknown): Response {
  const path = url.replace(/^https?:\/\/[^/]+/, "")
  if (path === "/rundown/state") return json(live)
  if (path === "/rundown/control" && method === "POST") {
    const payload = body as { revision: number; action: string }
    if (payload.revision !== live.revision) return json({ detail: "stale" }, 409)
    live = { ...live, revision: live.revision + 1, paused: payload.action === "pause" ? true : payload.action === "play" ? false : live.paused }
    return json(live)
  }
  if (path === "/shows" && method === "GET") {
    const list = [...saved.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(summaryOf)
    return json({ shows: list })
  }
  if (path === "/shows" && method === "POST") {
    const payload = body as { name: string; topics?: Topic[] }
    const id = `s${++ids}`
    const created: SavedShow = { id, name: payload.name, revision: 1, topics: materialize(payload.topics ?? []), created_at: "2026-09-14T01:00:00.000Z", updated_at: "2026-09-14T01:00:00.000Z" }
    saved.set(id, created)
    return json(created, 201)
  }
  if (path === "/shows/from-live" && method === "POST") {
    const payload = body as { name: string; live_revision: number }
    if (payload.live_revision !== live.revision) return json({ detail: "Live show changed." }, 409)
    const id = `s${++ids}`
    const created: SavedShow = { id, name: payload.name, revision: 1, topics: materialize(live.topics.map(({ text, duration, notes }) => ({ text, duration, notes }))), created_at: "2026-09-14T02:00:00.000Z", updated_at: "2026-09-14T02:00:00.000Z" }
    saved.set(id, created)
    return json(created, 201)
  }
  const detail = /^\/shows\/([^/]+)$/.exec(path)
  if (detail) {
    const entry = saved.get(detail[1] ?? "")
    if (!entry) return json({ detail: "Saved show not found." }, 404)
    if (method === "GET") return json(entry)
    if (method === "PUT") {
      const payload = body as { revision: number; name: string; topics: Topic[] }
      if (payload.revision !== entry.revision) return json({ detail: "Saved show changed on another screen. Reload it before trying again." }, 409)
      const next: SavedShow = { ...entry, name: payload.name, revision: entry.revision + 1, topics: materialize(payload.topics, entry), updated_at: "2026-09-14T03:00:00.000Z" }
      saved.set(entry.id, next)
      return json(next)
    }
  }
  const action = /^\/shows\/([^/]+)\/(duplicate|activate)$/.exec(path)
  if (action && method === "POST") {
    const entry = saved.get(action[1] ?? "")
    if (!entry) return json({ detail: "Saved show not found." }, 404)
    const payload = body as { revision: number; name?: string; live_revision?: number }
    if (payload.revision !== entry.revision) return json({ detail: "Saved show changed on another screen. Reload it before trying again." }, 409)
    if (action[2] === "duplicate") {
      const id = `s${++ids}`
      const copy: SavedShow = { id, name: payload.name ?? "", revision: 1, topics: materialize(entry.topics.map(({ text, duration, notes }) => ({ text, duration, notes }))), created_at: "2026-09-14T04:00:00.000Z", updated_at: "2026-09-14T04:00:00.000Z" }
      saved.set(id, copy)
      return json(copy, 201)
    }
    if (payload.live_revision !== live.revision) return json({ detail: "Live show changed on another screen." }, 409)
    if (entry.topics.length === 0) return json({ detail: "Add and save at least one topic before activating this show." }, 409)
    const topics = materialize(entry.topics.map(({ text, duration, notes }) => ({ text, duration, notes })))
    live = { revision: live.revision + 1, topics, current_topic_id: topics[0]?.id ?? null, remaining_seconds: topics[0]?.duration ?? 0, paused: true, server_time: "2026-09-14T00:00:09.000Z" }
    return json(live)
  }
  return json({ detail: "Not Found" }, 404)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  live = liveState()
  saved = new Map()
  saved.set("s1", show("s1", "Friday template", [
    { text: "Cold open", duration: 60, notes: "Say hi\nhttps://example.test/a" },
    { text: "Main story", duration: 300, notes: "" },
  ]))
  saved.set("s2", show("s2", "Empty one", []))
  calls = []
  ids = 100
  holds = new Map()
  holdPattern = null
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

async function openShows() {
  fireEvent.click(screen.getByRole("button", { name: "Saved Shows" }))
  await flush()
  expect(screen.getByRole("heading", { name: "Saved Shows" })).toBeVisible()
}

async function openShow(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `Open ${name}` }))
  await flush()
  expect(screen.getByLabelText("Show name")).toHaveValue(name)
}

function posts(pathEnd: string) {
  return calls.filter((call) => call.method === "POST" && call.url.endsWith(pathEnd))
}

function puts() {
  return calls.filter((call) => call.method === "PUT" && call.url.includes("/shows/"))
}

test("navigation keeps the live draft, quick-add text and the saved draft; the live view is untouched by saved edits", async () => {
  await renderLoaded()
  fireEvent.change(screen.getByLabelText("Topic 1 title"), { target: { value: "Opening edited" } })
  fireEvent.change(screen.getByLabelText("New topic title"), { target: { value: "typed but not added" } })
  await openShows()
  expect(screen.getByRole("main", { name: "Saved Shows" })).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "New show" }))
  fireEvent.change(screen.getByLabelText("Show name"), { target: { value: "Half typed" } })
  fireEvent.change(screen.getByLabelText("New saved topic title"), { target: { value: "Segment A" } })
  fireEvent.click(screen.getByRole("button", { name: "Add topic" }))
  expect(screen.getByLabelText("Saved topic 1 title")).toHaveValue("Segment A")

  fireEvent.click(screen.getByRole("button", { name: "Tonight's Show" }))
  await flush()
  expect(screen.getByLabelText("Topic 1 title")).toHaveValue("Opening edited")
  expect(screen.getByLabelText("New topic title")).toHaveValue("typed but not added")
  expect(screen.getByText("Unsaved changes.")).toBeInTheDocument()
  await openShows()
  expect(screen.getByLabelText("Show name")).toHaveValue("Half typed")
  expect(screen.getByLabelText("Saved topic 1 title")).toHaveValue("Segment A")
  // No saved-show request touched the live rundown.
  expect(calls.filter((call) => call.url.includes("/rundown/") && call.method !== "GET")).toEqual([])
})

test("create a named show with title, duration, notes and order; save posts new rows without ids and reopens as saved", async () => {
  await renderLoaded()
  await openShows()
  fireEvent.click(screen.getByRole("button", { name: "New show" }))
  expect(screen.getByText("New show, not saved yet.")).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText("Show name"), { target: { value: "  Saturday special  " } })
  fireEvent.change(screen.getByLabelText("New saved topic title"), { target: { value: "First" } })
  fireEvent.change(screen.getByLabelText("New saved topic duration"), { target: { value: "45" } })
  fireEvent.click(screen.getByRole("button", { name: "Add topic" }))
  fireEvent.change(screen.getByLabelText("New saved topic title"), { target: { value: "Second" } })
  fireEvent.click(screen.getByRole("button", { name: "Add topic" }))
  fireEvent.click(screen.getByRole("button", { name: "Notes for saved topic 2" }))
  fireEvent.change(screen.getByLabelText("Saved topic 2 notes"), { target: { value: "line one\n  https://example.test/x  " } })
  fireEvent.click(screen.getByRole("button", { name: "Move saved topic 2 up" }))
  expect(screen.getAllByLabelText(/Saved topic \d title/).map((input) => (input as HTMLInputElement).value)).toEqual(["Second", "First"])

  fireEvent.click(screen.getByRole("button", { name: "Save show" }))
  await flush()
  expect(posts("/shows")).toHaveLength(1)
  expect(posts("/shows")[0]?.body).toEqual({
    name: "Saturday special",
    topics: [
      { text: "Second", duration: 45, notes: "line one\n  https://example.test/x  " },
      { text: "First", duration: 45, notes: "" },
    ],
  })
  expect(screen.getByText(/Saved "Saturday special" · 2 topics/)).toBeInTheDocument()
  expect(screen.getByText("Saved · 2 topics · 2 min")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Open Saturday special" })).toHaveAttribute("aria-current", "true")
  expect(screen.getByRole("button", { name: "Activate show…" })).toBeEnabled()
  // The live rundown was not touched by saving.
  expect(live.revision).toBe(3)
})

test("an empty new show can be saved but not activated", async () => {
  await renderLoaded()
  await openShows()
  fireEvent.click(screen.getByRole("button", { name: "New show" }))
  fireEvent.change(screen.getByLabelText("Show name"), { target: { value: "Blank" } })
  fireEvent.click(screen.getByRole("button", { name: "Save show" }))
  await flush()
  expect(posts("/shows")[0]?.body).toEqual({ name: "Blank", topics: [] })
  expect(screen.getByRole("button", { name: "Activate show…" })).toBeDisabled()
  expect(screen.getByText("Add at least one topic before activating.")).toBeInTheDocument()
})

test("save the live rundown as a named show with the live revision; unsaved live edits are warned about and excluded", async () => {
  await renderLoaded()
  fireEvent.change(screen.getByLabelText("Topic 1 title"), { target: { value: "Not published" } })
  await openShows()
  fireEvent.click(screen.getByRole("button", { name: "Save live rundown as show" }))
  expect(screen.getByText(/Your unsaved live edits are not included/)).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText("Name for the saved live rundown"), { target: { value: "Snapshot" } })
  fireEvent.click(screen.getByRole("button", { name: "Save live rundown" }))
  await flush()
  expect(posts("/shows/from-live")[0]?.body).toEqual({ name: "Snapshot", live_revision: 3 })
  expect(screen.getByLabelText("Show name")).toHaveValue("Snapshot")
  expect(screen.getByLabelText("Saved topic 1 title")).toHaveValue("Opening")
  fireEvent.click(screen.getByRole("button", { name: "Notes for saved topic 2" }))
  expect(screen.getByLabelText("Saved topic 2 notes")).toHaveValue("live note")
  // The lock is released: the copy is editable and can be saved again.
  expect(screen.getByLabelText("Show name")).toBeEnabled()
  fireEvent.change(screen.getByLabelText("Show name"), { target: { value: "Snapshot 2" } })
  expect(screen.getByRole("button", { name: "Save show" })).toBeEnabled()
})

test("duplicate makes an independent copy, switches to it, and leaves the editor usable and activatable", async () => {
  await renderLoaded()
  await openShows()
  await openShow("Friday template")
  fireEvent.click(screen.getByRole("button", { name: "Duplicate" }))
  expect(screen.getByLabelText("Name for the copy")).toHaveValue("Friday template copy")
  fireEvent.click(screen.getByRole("button", { name: "Create copy" }))
  await flush()
  expect(posts("/duplicate")[0]?.body).toEqual({ revision: 1, name: "Friday template copy" })
  expect(screen.getByLabelText("Show name")).toHaveValue("Friday template copy")
  expect(screen.getByText(/"Friday template" is unchanged/)).toBeInTheDocument()
  expect(screen.getByLabelText("Saved topic 1 title")).toBeEnabled()
  expect(screen.getByRole("button", { name: "Activate show…" })).toBeEnabled()
  fireEvent.change(screen.getByLabelText("Saved topic 1 title"), { target: { value: "Cold open (copy)" } })
  fireEvent.click(screen.getByRole("button", { name: "Save show" }))
  await flush()
  expect(puts()).toHaveLength(1)
  expect(puts()[0]?.url).not.toMatch(/\/shows\/s1$/)
  expect(saved.get("s1")?.topics[0]?.text).toBe("Cold open")
})

test("reuse a topic from another show: copied with notes as a new row, saved with the target only, source unchanged", async () => {
  await renderLoaded()
  await openShows()
  await openShow("Empty one")
  fireEvent.click(screen.getByRole("button", { name: "Reuse a topic…" }))
  fireEvent.change(screen.getByLabelText("Source show"), { target: { value: "s1" } })
  await flush()
  const list = screen.getByRole("list", { name: "Topics in Friday template" })
  fireEvent.click(within(list).getByRole("button", { name: 'Copy "Cold open" from Friday template into this show' }))
  expect(screen.getByLabelText("Saved topic 1 title")).toHaveValue("Cold open")
  expect(screen.getByText("1:00 · not saved yet")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Notes for saved topic 1" }))
  expect(screen.getByLabelText("Saved topic 1 notes")).toHaveValue("Say hi\nhttps://example.test/a")
  fireEvent.click(screen.getByRole("button", { name: "Save show" }))
  await flush()
  expect(puts()[0]?.url).toContain("/shows/s2")
  expect(puts()[0]?.body).toEqual({ revision: 1, name: "Empty one", topics: [{ text: "Cold open", duration: 60, notes: "Say hi\nhttps://example.test/a" }] })
  expect(saved.get("s1")?.revision).toBe(1)
  expect(saved.get("s1")?.topics).toHaveLength(2)
})

test("selecting another show with unsaved edits asks first; keep editing keeps the draft, discard opens the other", async () => {
  await renderLoaded()
  await openShows()
  await openShow("Friday template")
  fireEvent.change(screen.getByLabelText("Saved topic 1 title"), { target: { value: "Edited" } })
  fireEvent.click(screen.getByRole("button", { name: "Open Empty one" }))
  const dialog = screen.getByRole("dialog", { name: "Unsaved changes" })
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }))
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  expect(screen.getByLabelText("Saved topic 1 title")).toHaveValue("Edited")
  fireEvent.click(screen.getByRole("button", { name: "Open Empty one" }))
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard and open" }))
  await flush()
  expect(screen.getByLabelText("Show name")).toHaveValue("Empty one")
  expect(puts()).toHaveLength(0)
})

test("a delayed response for an earlier selection never replaces the newer one (library lock + reuse picker race)", async () => {
  await renderLoaded()
  await openShows()
  holdPattern = /^GET .*\/shows\/s[12]$/
  fireEvent.click(screen.getByRole("button", { name: "Open Friday template" }))
  await flush()
  // While a show is loading the library is locked, so two loads cannot race.
  expect(screen.getByRole("button", { name: "Open Empty one" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "New show" })).toBeDisabled()
  release("GET /shows/s1")
  await flush()
  expect(screen.getByLabelText("Show name")).toHaveValue("Friday template")

  // The reuse picker is not locked: pick s2, then s1, then let s2 answer last.
  fireEvent.click(screen.getByRole("button", { name: "New show" }))
  fireEvent.click(screen.getByRole("button", { name: "Reuse a topic…" }))
  fireEvent.change(screen.getByLabelText("Source show"), { target: { value: "s2" } })
  fireEvent.change(screen.getByLabelText("Source show"), { target: { value: "s1" } })
  await flush()
  release("GET /shows/s1")
  await flush()
  expect(screen.getByRole("list", { name: "Topics in Friday template" })).toBeInTheDocument()
  release("GET /shows/s2")
  await flush()
  expect(screen.getByRole("list", { name: "Topics in Friday template" })).toBeInTheDocument()
  expect(screen.queryByText("That show has no topics.")).not.toBeInTheDocument()
  // Clearing the source while nothing is pending never leaves a stuck "Loading".
  fireEvent.change(screen.getByLabelText("Source show"), { target: { value: "" } })
  expect(screen.queryByText("Loading topics…")).not.toBeInTheDocument()
})

test("editing is locked while a save is pending; the result applies and unlocks", async () => {
  await renderLoaded()
  await openShows()
  await openShow("Friday template")
  fireEvent.change(screen.getByLabelText("Show name"), { target: { value: "Friday v2" } })
  holdPattern = /^PUT /
  fireEvent.click(screen.getByRole("button", { name: "Save show" }))
  await flush()
  expect(screen.getByText("Saving the show…")).toBeInTheDocument()
  expect(screen.getByLabelText("Show name")).toBeDisabled()
  expect(screen.getByLabelText("Saved topic 1 title")).toBeDisabled()
  expect(screen.getByRole("button", { name: "Open Empty one" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Activate show…" })).toBeDisabled()
  release("PUT /shows/s1")
  await flush()
  expect(screen.getByLabelText("Show name")).toBeEnabled()
  expect(screen.getByLabelText("Show name")).toHaveValue("Friday v2")
  expect(screen.getByText(/Saved "Friday v2"/)).toBeInTheDocument()
})

test("a stale save keeps the draft and offers merge or reload; nothing is retried on its own", async () => {
  await renderLoaded()
  await openShows()
  await openShow("Friday template")
  fireEvent.change(screen.getByLabelText("Saved topic 1 title"), { target: { value: "Cold open v2" } })
  // Another screen renames the show and edits topic 2 meanwhile.
  const other = saved.get("s1")!
  saved.set("s1", { ...other, revision: 2, name: "Friday renamed", topics: [other.topics[0]!, { ...other.topics[1]!, duration: 240 }] })
  fireEvent.click(screen.getByRole("button", { name: "Save show" }))
  await flush()
  expect(puts()).toHaveLength(1)
  expect(screen.getByRole("alert")).toHaveTextContent("Not saved.")
  expect(screen.getByLabelText("Saved topic 1 title")).toHaveValue("Cold open v2")
  expect(screen.getByRole("button", { name: "Save show" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Merge with the saved version" }))
  await flush()
  expect(puts()).toHaveLength(1)
  expect(screen.getByLabelText("Show name")).toHaveValue("Friday renamed")
  expect(screen.getByLabelText("Saved topic 1 title")).toHaveValue("Cold open v2")
  expect(screen.getByLabelText("Saved topic 2 duration")).toHaveValue(240)
  expect(screen.getByText(/Merged the other changes/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Save show" }))
  await flush()
  expect(puts()).toHaveLength(2)
  expect(puts()[1]?.body).toMatchObject({ revision: 2, name: "Friday renamed" })
  expect(screen.getByText(/Saved "Friday renamed"/)).toBeInTheDocument()
})

test("reload after a conflict discards local edits explicitly", async () => {
  await renderLoaded()
  await openShows()
  await openShow("Friday template")
  fireEvent.change(screen.getByLabelText("Saved topic 1 title"), { target: { value: "Mine" } })
  saved.set("s1", { ...saved.get("s1")!, revision: 2 })
  fireEvent.click(screen.getByRole("button", { name: "Save show" }))
  await flush()
  fireEvent.click(screen.getByRole("button", { name: "Reload and discard my edits" }))
  await flush()
  expect(screen.getByLabelText("Saved topic 1 title")).toHaveValue("Cold open")
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  expect(puts()).toHaveLength(1)
})

test("activation: blocked while the live editor is dirty or a saved edit is unsaved; confirm posts frozen revisions and cues paused", async () => {
  await renderLoaded()
  fireEvent.change(screen.getByLabelText("Topic 1 title"), { target: { value: "Live edit" } })
  await openShows()
  await openShow("Friday template")
  expect(screen.getByRole("button", { name: "Activate show…" })).toBeDisabled()
  expect(screen.getByText(/The live rundown has unsaved edits/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Tonight's Show" }))
  fireEvent.click(screen.getByRole("button", { name: "Discard" }))
  await openShows()
  expect(screen.getByRole("button", { name: "Activate show…" })).toBeEnabled()
  fireEvent.change(screen.getByLabelText("Saved topic 1 title"), { target: { value: "Cold open!" } })
  expect(screen.getByRole("button", { name: "Activate show…" })).toBeDisabled()
  expect(screen.getByText("Save your changes first; activation uses the saved version.")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Discard edits" }))

  fireEvent.click(screen.getByRole("button", { name: "Activate show…" }))
  const dialog = screen.getByRole("dialog", { name: 'Activate "Friday template"?' })
  expect(dialog).toHaveTextContent("replaces the live rundown (2 topics) with the saved version")
  expect(dialog).toHaveTextContent("2 topics, 6 min")
  expect(dialog).toHaveTextContent('Topic 1, "Cold open", will be cued at its full 1:00 and paused')
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus()
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  expect(posts("/activate")).toHaveLength(0)

  fireEvent.click(screen.getByRole("button", { name: "Activate show…" }))
  fireEvent.click(screen.getByRole("button", { name: "Activate and cue paused" }))
  await flush()
  expect(posts("/activate")).toHaveLength(1)
  expect(posts("/activate")[0]?.url).toContain("/shows/s1/activate")
  expect(posts("/activate")[0]?.body).toEqual({ revision: 1, live_revision: 3 })
  // Back on the live view with the new list cued and paused.
  expect(screen.getByRole("heading", { name: "Tonight's Rundown" })).toBeVisible()
  expect(screen.getByText(/"Friday template" is live · 2 topics, first topic cued and paused/)).toBeInTheDocument()
  expect(screen.getByLabelText("Topic 1 title")).toHaveValue("Cold open")
  expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument()
  expect(screen.getByTestId("lcd-time")).toHaveTextContent("1:00")
  fireEvent.click(screen.getByRole("button", { name: "Notes for topic 1" }))
  expect(screen.getByLabelText("Topic 1 notes")).toHaveValue("Say hi\nhttps://example.test/a")
})

test("a stale activation is shown, never retried, and the live rundown stays as it was", async () => {
  await renderLoaded()
  await openShows()
  await openShow("Friday template")
  fireEvent.click(screen.getByRole("button", { name: "Activate show…" }))
  // Someone else touched the live clock after the dialog opened; the poll has
  // not caught up yet, so the frozen live_revision is rejected by the server.
  live = { ...live, revision: 4 }
  fireEvent.click(screen.getByRole("button", { name: "Activate and cue paused" }))
  await flush()
  expect(posts("/activate")).toHaveLength(1)
  const dialog = screen.getByRole("dialog")
  expect(within(dialog).getByRole("alert")).toHaveTextContent("Not activated")
  expect(within(dialog).queryByRole("button", { name: "Activate and cue paused" })).not.toBeInTheDocument()
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
  expect(posts("/activate")).toHaveLength(1)
  expect(live.topics[0]?.text).toBe("Opening")
  expect(screen.getByRole("heading", { name: "Saved Shows" })).toBeVisible()
})

test("an activation dialog that outlived a live edit refuses to post", async () => {
  await renderLoaded()
  await openShows()
  await openShow("Friday template")
  fireEvent.click(screen.getByRole("button", { name: "Activate show…" }))
  fireEvent.click(screen.getByRole("button", { name: "Tonight's Show" }))
  fireEvent.change(screen.getByLabelText("Topic 2 title"), { target: { value: "Changed while dialog open" } })
  fireEvent.click(screen.getByRole("button", { name: "Saved Shows" }))
  await flush()
  fireEvent.click(screen.getByRole("button", { name: "Activate and cue paused" }))
  await flush()
  expect(posts("/activate")).toHaveLength(0)
  expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("unsaved edits")
})

test("live transport is held while an activation request is pending", async () => {
  await renderLoaded()
  await openShows()
  await openShow("Friday template")
  holdPattern = /activate$/
  fireEvent.click(screen.getByRole("button", { name: "Activate show…" }))
  fireEvent.click(screen.getByRole("button", { name: "Activate and cue paused" }))
  await flush()
  expect(screen.getByRole("button", { name: "Activating…" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Tonight's Show" }))
  expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled()
  expect(screen.getByLabelText("Topic 1 title")).toBeDisabled()
  release("POST /shows/s1/activate")
  await flush()
  expect(screen.getByRole("button", { name: "Play" })).toBeEnabled()
  expect(screen.getByLabelText("Topic 1 title")).toHaveValue("Cold open")
})

test("no revision jargon is shown to the user", async () => {
  await renderLoaded()
  await openShows()
  await openShow("Friday template")
  fireEvent.click(screen.getByRole("button", { name: "Activate show…" }))
  expect(document.body.textContent).not.toMatch(/\brev(ision)?\b/i)
})

test("a delayed activation result cannot replace a newer live snapshot already polled", async () => {
  await renderLoaded()
  await openShows()
  await openShow("Friday template")
  holdPattern = /activate$/
  fireEvent.click(screen.getByRole("button", { name: "Activate show…" }))
  fireEvent.click(screen.getByRole("button", { name: "Activate and cue paused" }))
  await flush()
  // Another producer advances after activation; polling sees the newer state
  // while the activation response is still held in flight.
  live = { ...live, revision: live.revision + 1, current_topic_id: live.topics[1]!.id, paused: false, remaining_seconds: 280 }
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(screen.getByLabelText("API connection")).toHaveAttribute("data-revision", String(live.revision))
  release("POST /shows/s1/activate")
  await flush()
  expect(screen.getByLabelText("API connection")).toHaveAttribute("data-revision", String(live.revision))
  expect(screen.getByTestId("lcd-topic")).toHaveTextContent("Main story")
  expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled()
  expect(screen.getByText('"Friday template" was activated. Showing the latest live state.')).toBeInTheDocument()
})
