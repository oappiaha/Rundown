import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import App from "../App"
import type { Feed, FeedSchedule, ImportRun, InboxItem, ShowState } from "../lib/api"

// The automatic-imports panel rendered through App so navigation, the inbox
// coupling and draft survival are exercised the way a user reaches them. The
// fetch mock is a small in-memory server following the frozen /feeds and
// /feeds/{id}/schedule contracts: separate schedule revision starting at 0,
// strict payload, 409 on stale or active-import writes, reanchoring on change,
// effective/reason derived from the schedule, the feed and a global switch.

type Call = { method: string; url: string; body?: unknown }
type Stored = { revision: number; enabled: boolean; interval_minutes: number; next_run_at: number | null; last_run: ImportRun | null }

let live: ShowState
let feeds: Map<string, Feed>
let runs: Map<string, ImportRun[]>
let inbox: Map<string, InboxItem>
let schedules: Map<string, Stored>
let calls: Call[]
let ids: number
let clock: number
/** The server's clock in ms; advanced by tests, never read from the browser. */
let serverNow: number
let schedulerEnabled: boolean
let holds: Map<string, Array<() => void>>
let holdPattern: RegExp | null

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

function seedItem(id: string, text: string): InboxItem {
  const at = stamp()
  const entry: InboxItem = { id, revision: 1, text, duration: 120, notes: "", source_url: "", archived: false, created_at: at, updated_at: at, topic: { text, duration: 120, notes: "" }, source: null }
  inbox.set(id, entry)
  return entry
}

function stored(id: string): Stored {
  let entry = schedules.get(id)
  if (!entry) {
    entry = { revision: 0, enabled: false, interval_minutes: 60, next_run_at: null, last_run: null }
    schedules.set(id, entry)
  }
  return entry
}

function scheduleDetail(feed: Feed): FeedSchedule {
  const entry = stored(feed.id)
  const reason = !entry.enabled ? "Automatic imports are off for this feed." : !feed.enabled ? "This feed is disabled. Enable the feed to resume automatic imports." : !schedulerEnabled ? "Automatic imports are paused in the API configuration." : null
  return {
    feed_id: feed.id,
    revision: entry.revision,
    enabled: entry.enabled,
    interval_minutes: entry.interval_minutes,
    next_run_at: entry.next_run_at === null ? null : new Date(entry.next_run_at).toISOString(),
    last_run: entry.last_run,
    effective: reason === null,
    reason,
    server_time: new Date(serverNow).toISOString(),
  }
}

/** The server's scheduler ran this feed: a finished run lands in history and on the schedule, the cursor moves on. */
function automaticRun(feedId: string, patch: Partial<ImportRun> = {}): ImportRun {
  const feed = feeds.get(feedId)!
  const entry = stored(feedId)
  const started = stamp()
  const created: ImportRun = { id: `run${++ids}`, feed_id: feedId, status: "succeeded", started_at: started, finished_at: stamp(), created: 1, duplicates: 0, skipped: 0, examined: 1, error: null, warnings: [], items: [{ title: "Scheduled entry", reason: "created" }], ...patch }
  runs.set(feedId, [created, ...(runs.get(feedId) ?? [])].slice(0, 20))
  feeds.set(feedId, { ...feed, latest_run: created, can_import: feed.enabled })
  entry.last_run = created
  entry.next_run_at = serverNow + entry.interval_minutes * 60_000
  if (created.created > 0) seedItem(`i${ids}`, `Scheduled idea ${ids}`)
  return created
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function serve(method: string, url: string, body: unknown): Response {
  const parsed = new URL(url, "http://test.local")
  const path = parsed.pathname
  if (path === "/rundown/state") return json(live)
  if (path === "/inbox" && method === "GET") {
    const archived = parsed.searchParams.get("archived") === "true"
    return json({ items: [...inbox.values()].filter((entry) => entry.archived === archived) })
  }
  if (path === "/feeds" && method === "GET") return json({ feeds: [...feeds.values()] })
  const detail = /^\/feeds\/([^/]+)(\/import|\/runs|\/schedule)?$/.exec(path)
  if (detail) {
    const entry = feeds.get(detail[1] ?? "")
    if (!entry) return json({ detail: "Feed not found." }, 404)
    if (method === "GET" && !detail[2]) return json(entry)
    if (method === "GET" && detail[2] === "/runs") return json({ runs: runs.get(entry.id) ?? [] })
    if (method === "GET" && detail[2] === "/schedule") return json(scheduleDetail(entry))
    if (method === "PUT" && !detail[2]) {
      const payload = body as { revision: number; name: string; default_duration: number; enabled: boolean }
      if (payload.revision !== entry.revision) return json({ detail: "Feed settings changed on another screen. Reload before retrying." }, 409)
      const next: Feed = { ...entry, revision: entry.revision + 1, name: payload.name.trim(), default_duration: payload.default_duration, enabled: payload.enabled, updated_at: stamp(), can_import: payload.enabled }
      feeds.set(entry.id, next)
      const schedule = stored(entry.id)
      if (schedule.enabled) schedule.next_run_at = payload.enabled ? serverNow + schedule.interval_minutes * 60_000 : null
      return json(next)
    }
    if (method === "PUT" && detail[2] === "/schedule") {
      const payload = body as Record<string, unknown>
      const keys = Object.keys(payload).sort()
      if (keys.join(",") !== "enabled,interval_minutes,revision") return json({ detail: "Extra inputs are not permitted" }, 422)
      if (!Number.isInteger(payload.revision) || (payload.revision as number) < 0) return json({ detail: "revision must be an integer >= 0" }, 422)
      if (typeof payload.enabled !== "boolean") return json({ detail: "enabled must be a boolean" }, 422)
      if (!Number.isInteger(payload.interval_minutes) || (payload.interval_minutes as number) < 15 || (payload.interval_minutes as number) > 10080) return json({ detail: "interval_minutes must be an integer 15-10080" }, 422)
      const schedule = stored(entry.id)
      if (payload.revision !== schedule.revision) return json({ detail: "Automatic import settings changed on another screen. Reload before saving." }, 409)
      if (entry.enabled && !entry.can_import) return json({ detail: "This feed is importing. Wait for the result before changing its schedule." }, 409)
      const enabled = payload.enabled as boolean
      const interval = payload.interval_minutes as number
      const changed = schedule.enabled !== enabled || schedule.interval_minutes !== interval
      schedule.enabled = enabled
      schedule.interval_minutes = interval
      if (!enabled || !entry.enabled) schedule.next_run_at = null
      else if (changed || schedule.next_run_at === null) schedule.next_run_at = serverNow + interval * 60_000
      schedule.revision += 1
      return json(scheduleDetail(entry))
    }
    if (method === "POST" && detail[2] === "/import") throw new Error("no manual import is expected in this suite")
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
  schedules = new Map()
  calls = []
  ids = 100
  clock = 0
  serverNow = Date.UTC(2026, 8, 15, 10, 0, 0)
  schedulerEnabled = true
  holds = new Map()
  holdPattern = null
  seedFeed("f1", "Studio research", "http://127.0.0.1:8182/feed.xml")
  seedFeed("f2", "Atom source", "http://127.0.0.1:8182/atom.xml", { default_duration: 90 })
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
  await flush()
}

function requests(method: string, pathStart: string) {
  return calls.filter((call) => call.method === method && new URL(call.url, "http://test.local").pathname.startsWith(pathStart))
}

function panel() {
  const node = document.querySelector("#sources .schedule-panel")
  if (!node) throw new Error("schedule panel not rendered")
  return node as HTMLElement
}

function scheduleStatus() {
  return within(panel()).getByTestId("schedule-status")
}

function saveButton() {
  return within(panel()).getByRole("button", { name: /Save schedule|Saving…/ })
}

test("default off; enabling with an interval saves the full strict payload, reads back the next due time in the local zone, and never posts an import", async () => {
  await renderLoaded()
  await openSources()
  await openFeed("Studio research")
  expect(requests("GET", "/feeds/f1/schedule")).toHaveLength(1)
  expect(screen.getByLabelText("Automatic imports")).not.toBeChecked()
  expect(screen.getByLabelText("Interval minutes")).toHaveValue(60)
  expect(saveButton()).toBeDisabled()
  expect(within(panel()).getByTestId("schedule-next")).toHaveTextContent("Not scheduled")
  expect(within(panel()).getByTestId("schedule-last")).toHaveTextContent("No automatic import has run yet.")
  expect(scheduleStatus()).toHaveTextContent("Off. Imports happen only when you press Import now.")
  expect(panel()).toHaveAttribute("data-schedule-revision", "0")

  fireEvent.click(screen.getByLabelText("Automatic imports"))
  fireEvent.change(screen.getByLabelText("Interval minutes"), { target: { value: "30" } })
  expect(scheduleStatus()).toHaveTextContent("Unsaved schedule changes.")
  expect(panel()).toHaveAttribute("data-schedule-dirty", "true")
  // Nothing is written until Save schedule.
  expect(requests("PUT", "/feeds/f1/schedule")).toHaveLength(0)
  fireEvent.click(saveButton())
  await flush()
  const [put] = requests("PUT", "/feeds/f1/schedule")
  expect(put?.body).toEqual({ revision: 0, enabled: true, interval_minutes: 30 })
  expect(requests("POST", "/feeds")).toHaveLength(0)
  expect(schedules.get("f1")).toMatchObject({ revision: 1, enabled: true, interval_minutes: 30 })
  expect(panel()).toHaveAttribute("data-schedule-revision", "1")
  expect(panel()).toHaveAttribute("data-schedule-effective", "true")
  expect(scheduleStatus()).toHaveTextContent("Schedule saved: on, every 30 minutes. Next automatic import")
  const next = within(panel()).getByTestId("schedule-next")
  expect(next).toHaveTextContent("in 30 minutes")
  expect(next).toHaveTextContent(new Date(serverNow + 30 * 60_000).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric" }))
  expect(next.textContent).not.toMatch(/Z\b|T10:/)
  expect(within(panel()).getByTestId("schedule-zone").textContent?.length).toBeGreaterThan(0)
  expect(saveButton()).toBeDisabled()
  expect(document.body.textContent).not.toMatch(/revision/i)

  // Saving the same settings again is a no-op; turning off clears the due time.
  fireEvent.click(screen.getByLabelText("Automatic imports"))
  fireEvent.click(saveButton())
  await flush()
  expect(requests("PUT", "/feeds/f1/schedule")[1]?.body).toEqual({ revision: 1, enabled: false, interval_minutes: 30 })
  expect(within(panel()).getByTestId("schedule-next")).toHaveTextContent("Not scheduled")
  expect(scheduleStatus()).toHaveTextContent("Schedule saved: off.")
  expect(schedules.get("f1")?.next_run_at).toBeNull()
})

test("an invalid interval is blocked before any request with the reason; a clean draft cannot be saved", async () => {
  await renderLoaded()
  await openSources()
  await openFeed("Studio research")
  fireEvent.click(screen.getByLabelText("Automatic imports"))
  expect(saveButton()).toBeEnabled()
  for (const bad of ["5", "20000", "", "15.5"]) {
    fireEvent.change(screen.getByLabelText("Interval minutes"), { target: { value: bad } })
    expect(saveButton()).toBeDisabled()
    expect(screen.getByLabelText("Interval minutes")).toHaveAttribute("aria-invalid", "true")
    expect(within(panel()).getByRole("status")).toHaveTextContent("Interval must be a whole number of minutes from 15 to 10080")
  }
  fireEvent.change(screen.getByLabelText("Interval minutes"), { target: { value: "15" } })
  expect(saveButton()).toBeEnabled()
  expect(screen.getByLabelText("Interval minutes")).not.toHaveAttribute("aria-invalid")
  fireEvent.click(within(panel()).getByRole("button", { name: "Discard schedule edits" }))
  expect(screen.getByLabelText("Automatic imports")).not.toBeChecked()
  expect(screen.getByLabelText("Interval minutes")).toHaveValue(60)
  expect(requests("PUT", "/feeds/f1/schedule")).toHaveLength(0)
})

test("an unsaved schedule survives switching feeds, other views, Refresh and New feed; feed edits block schedule actions with a reason", async () => {
  await renderLoaded()
  await openSources()
  await openFeed("Studio research")
  fireEvent.change(screen.getByLabelText("Interval minutes"), { target: { value: "45" } })
  fireEvent.click(screen.getByLabelText("Automatic imports"))
  expect(saveButton()).toBeEnabled()

  // Another feed has its own, untouched schedule.
  await openFeed("Atom source")
  expect(screen.getByLabelText("Interval minutes")).toHaveValue(60)
  expect(screen.getByLabelText("Automatic imports")).not.toBeChecked()
  expect(saveButton()).toBeDisabled()
  await openFeed("Studio research")
  expect(screen.getByLabelText("Interval minutes")).toHaveValue(45)
  expect(screen.getByLabelText("Automatic imports")).toBeChecked()
  expect(saveButton()).toBeEnabled()

  // Away to Live and back.
  fireEvent.click(screen.getByRole("button", { name: "Tonight's Show" }))
  await flush()
  await openSources()
  expect(screen.getByLabelText("Interval minutes")).toHaveValue(45)

  // Sources refresh and a schedule refresh keep the edits; the server copy is re-read.
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  await flush()
  expect(screen.getByLabelText("Interval minutes")).toHaveValue(45)
  const before = requests("GET", "/feeds/f1/schedule").length
  fireEvent.click(within(panel()).getByRole("button", { name: "Refresh schedule" }))
  await flush()
  expect(requests("GET", "/feeds/f1/schedule").length).toBe(before + 1)
  expect(screen.getByLabelText("Interval minutes")).toHaveValue(45)
  expect(scheduleStatus()).toHaveTextContent("Schedule refreshed. Your unsaved schedule edits are kept.")

  // New feed (pristine, no guard) then reopening restores the schedule draft.
  fireEvent.click(screen.getByRole("button", { name: "New feed" }))
  await flush()
  expect(document.querySelector("#sources .schedule-panel")).toBeNull()
  await openFeed("Studio research")
  expect(screen.getByLabelText("Interval minutes")).toHaveValue(45)
  expect(saveButton()).toBeEnabled()

  // Feed edits block schedule actions until saved or discarded.
  fireEvent.change(screen.getByLabelText("Feed name"), { target: { value: "Studio research 2" } })
  expect(saveButton()).toBeDisabled()
  expect(within(panel()).getByRole("button", { name: "Refresh schedule" })).toBeDisabled()
  expect(within(panel()).getByRole("status")).toHaveTextContent("Save or discard your feed edits before changing the schedule.")
  fireEvent.click(screen.getByRole("button", { name: "Discard edits" }))
  expect(saveButton()).toBeEnabled()
  fireEvent.click(saveButton())
  await flush()
  expect(requests("PUT", "/feeds/f1/schedule")[0]?.body).toEqual({ revision: 0, enabled: true, interval_minutes: 45 })
  expect(requests("PUT", "/feeds/f2/schedule")).toHaveLength(0)
})

test("a stale save keeps the edits and offers merge or reload; a save refused during an import is a plain refusal that never strands the panel", async () => {
  await renderLoaded()
  await openSources()
  await openFeed("Studio research")
  // Another screen turns the schedule on at 120 minutes meanwhile.
  const other = stored("f1")
  other.enabled = true
  other.interval_minutes = 120
  other.next_run_at = serverNow + 120 * 60_000
  other.revision = 1
  fireEvent.change(screen.getByLabelText("Interval minutes"), { target: { value: "20" } })
  fireEvent.click(saveButton())
  await flush()
  expect(requests("PUT", "/feeds/f1/schedule")).toHaveLength(1)
  const alert = within(panel()).getByRole("alert")
  expect(alert).toHaveTextContent("Schedule not saved.")
  expect(alert).toHaveTextContent("changed elsewhere")
  expect(screen.getByLabelText("Interval minutes")).toHaveValue(20)
  expect(saveButton()).toBeDisabled()
  expect(within(panel()).getByRole("status")).toHaveTextContent("Resolve the schedule conflict above first.")
  fireEvent.click(within(panel()).getByRole("button", { name: "Merge with the latest schedule" }))
  await flush()
  expect(within(panel()).queryByRole("alert")).not.toBeInTheDocument()
  expect(screen.getByLabelText("Automatic imports")).toBeChecked()
  expect(screen.getByLabelText("Interval minutes")).toHaveValue(20)
  expect(scheduleStatus()).toHaveTextContent("Merged the other changes into your schedule edits.")
  fireEvent.click(saveButton())
  await flush()
  expect(requests("PUT", "/feeds/f1/schedule")[1]?.body).toEqual({ revision: 1, enabled: true, interval_minutes: 20 })
  expect(schedules.get("f1")).toMatchObject({ revision: 2, enabled: true, interval_minutes: 20 })
  expect(within(panel()).getByTestId("schedule-next")).toHaveTextContent("in 20 minutes")

  // Stale again, this time reload: the edits are dropped for the latest version.
  other.interval_minutes = 240
  other.revision = 3
  fireEvent.change(screen.getByLabelText("Interval minutes"), { target: { value: "25" } })
  fireEvent.click(saveButton())
  await flush()
  expect(within(panel()).getByRole("alert")).toHaveTextContent("Schedule not saved.")
  fireEvent.click(within(panel()).getByRole("button", { name: "Reload and discard my schedule edits" }))
  await flush()
  expect(screen.getByLabelText("Interval minutes")).toHaveValue(240)
  expect(saveButton()).toBeDisabled()
  expect(scheduleStatus()).toHaveTextContent("Reloaded the latest schedule. Your edits were discarded.")

  // An import holds the feed: the server refuses with the same revision. No merge banner, edits kept, button live again.
  feeds.set("f1", { ...feeds.get("f1")!, can_import: false, latest_run: { id: "lease", feed_id: "f1", status: "running", started_at: stamp(), finished_at: null, created: 0, duplicates: 0, skipped: 0, examined: 0, error: null, warnings: [], items: [] } })
  fireEvent.change(screen.getByLabelText("Interval minutes"), { target: { value: "35" } })
  fireEvent.click(saveButton())
  await flush()
  expect(within(panel()).queryByRole("alert")).not.toBeInTheDocument()
  expect(scheduleStatus()).toHaveTextContent("Not saved: This feed is importing. Wait for the result before changing its schedule. Your schedule edits are kept here")
  expect(screen.getByLabelText("Interval minutes")).toHaveValue(35)
  expect(saveButton()).toBeEnabled()
  expect(requests("PUT", "/feeds/f1/schedule")).toHaveLength(4)
  // The import finished elsewhere: the same click now lands.
  feeds.set("f1", { ...feeds.get("f1")!, can_import: true, latest_run: null })
  fireEvent.click(saveButton())
  await flush()
  expect(schedules.get("f1")).toMatchObject({ revision: 4, interval_minutes: 35 })
  expect(scheduleStatus()).toHaveTextContent("Schedule saved: on, every 35 minutes.")
})

test("while a schedule is effective the panel polls every 5 s; a finished automatic run reloads history, feed status and the inbox without touching the draft; off or hidden it does not poll", async () => {
  await renderLoaded()
  await openSources()
  await openFeed("Studio research")
  // Off: no polling at all.
  await tick(11_000)
  expect(requests("GET", "/feeds/f1/schedule")).toHaveLength(1)

  fireEvent.click(screen.getByLabelText("Automatic imports"))
  fireEvent.click(saveButton())
  await flush()
  expect(panel()).toHaveAttribute("data-schedule-effective", "true")
  const inboxBefore = requests("GET", "/inbox").length
  const runsBefore = requests("GET", "/feeds/f1/runs").length
  // Leave an unsaved edit in place: polling must not overwrite it.
  fireEvent.change(screen.getByLabelText("Interval minutes"), { target: { value: "90" } })
  await tick(5_000)
  expect(requests("GET", "/feeds/f1/schedule")).toHaveLength(2)
  expect(requests("GET", "/inbox").length).toBe(inboxBefore)
  expect(screen.getByLabelText("Interval minutes")).toHaveValue(90)

  // The server's scheduler runs the feed: the next poll notices the new run.
  serverNow += 60 * 60_000
  automaticRun("f1", { created: 2, duplicates: 1, examined: 3 })
  await tick(5_000)
  expect(requests("GET", "/feeds/f1/schedule")).toHaveLength(3)
  expect(within(panel()).getByTestId("schedule-last")).toHaveTextContent("Last automatic import: 2 new ideas · 1 duplicate · 0 skipped · 3 examined.")
  expect(within(panel()).getByTestId("schedule-last")).toHaveAttribute("data-run-status", "succeeded")
  expect(within(panel()).getByTestId("schedule-next")).toHaveTextContent("in 1 hour")
  expect(requests("GET", "/feeds/f1/runs").length).toBe(runsBefore + 1)
  expect(requests("POST", "/feeds/f1/import")).toHaveLength(0)
  expect(screen.getByLabelText("Interval minutes")).toHaveValue(90)
  expect(saveButton()).toBeEnabled()
  // History marks the automatic run; the feed card shows its counts.
  const history = screen.getByRole("list", { name: "Import runs" })
  expect(history.querySelectorAll("li.run-row")).toHaveLength(1)
  expect(within(history).getByText("Automatic")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Open Studio research" })).toHaveTextContent("Imported 2 new ideas")
  // The same run seen again is not a new run: no extra history reload.
  await tick(5_000)
  expect(requests("GET", "/feeds/f1/runs").length).toBe(runsBefore + 1)
  // The inbox (hidden, so it reloads when shown) picks up the scheduled idea without any manual import.
  expect(requests("GET", "/inbox").length).toBe(inboxBefore)
  fireEvent.click(screen.getByRole("button", { name: "Inbox" }))
  await flush()
  expect(requests("GET", "/inbox").length).toBe(inboxBefore + 1)
  expect(screen.getByRole("heading", { name: "Inbox" })).toBeVisible()
  expect(screen.getByText("Scheduled idea 101")).toBeInTheDocument()
  await openSources()
  expect(screen.getByLabelText("Interval minutes")).toHaveValue(90)

  // A failed automatic run is visible as a failure with its error; the next time stays in the future.
  serverNow += 60 * 60_000
  automaticRun("f1", { status: "failed", error: "The feed returned HTTP 503.", created: 0, examined: 0, items: [] })
  await tick(5_000)
  expect(within(panel()).getByTestId("schedule-last")).toHaveTextContent("Last automatic import failed: The feed returned HTTP 503.")
  expect(within(panel()).getByTestId("schedule-last")).toHaveAttribute("data-run-status", "failed")
  expect(within(panel()).getByTestId("schedule-next")).toHaveTextContent("in 1 hour")
  expect(screen.getByRole("list", { name: "Import runs" }).querySelectorAll("li.run-row")).toHaveLength(2)

  // Hidden: no polling. Shown again: one silent re-read that notices a run finished meanwhile.
  fireEvent.click(screen.getByRole("button", { name: "Tonight's Show" }))
  await flush()
  const hiddenCount = requests("GET", "/feeds/f1/schedule").length
  await tick(15_000)
  expect(requests("GET", "/feeds/f1/schedule").length).toBe(hiddenCount)
  serverNow += 60 * 60_000
  automaticRun("f1")
  await openSources()
  await flush()
  expect(requests("GET", "/feeds/f1/schedule").length).toBe(hiddenCount + 1)
  expect(screen.getByRole("list", { name: "Import runs" }).querySelectorAll("li.run-row")).toHaveLength(3)
  expect(screen.getByLabelText("Interval minutes")).toHaveValue(90)
  const inboxNow = requests("GET", "/inbox").length
  fireEvent.click(screen.getByRole("button", { name: "Inbox" }))
  await flush()
  expect(requests("GET", "/inbox").length).toBe(inboxNow + 1)
  expect(screen.getByText("Scheduled idea 103")).toBeInTheDocument()
})

test("disabling the feed pauses the schedule with the reason and no due time; re-enabling gives a fresh future time; a paused server never promises a fetch", async () => {
  await renderLoaded()
  await openSources()
  await openFeed("Studio research")
  fireEvent.click(screen.getByLabelText("Automatic imports"))
  fireEvent.click(saveButton())
  await flush()
  expect(within(panel()).getByTestId("schedule-next")).toHaveTextContent("in 1 hour")

  fireEvent.click(screen.getByLabelText("Enabled"))
  fireEvent.click(screen.getByRole("button", { name: "Save feed" }))
  await flush()
  fireEvent.click(within(panel()).getByRole("button", { name: "Refresh schedule" }))
  await flush()
  expect(panel()).toHaveAttribute("data-schedule-effective", "false")
  expect(within(panel()).getByTestId("schedule-next")).toHaveTextContent("Paused: This feed is disabled. Enable the feed to resume automatic imports.")
  expect(scheduleStatus()).toHaveTextContent("On, but paused: This feed is disabled.")
  expect(screen.getByLabelText("Automatic imports")).toBeChecked()
  // Paused: no polling.
  const count = requests("GET", "/feeds/f1/schedule").length
  await tick(10_000)
  expect(requests("GET", "/feeds/f1/schedule").length).toBe(count)

  fireEvent.click(screen.getByLabelText("Enabled"))
  fireEvent.click(screen.getByRole("button", { name: "Save feed" }))
  await flush()
  fireEvent.click(within(panel()).getByRole("button", { name: "Refresh schedule" }))
  await flush()
  expect(within(panel()).getByTestId("schedule-next")).toHaveTextContent("in 1 hour")
  expect(panel()).toHaveAttribute("data-schedule-effective", "true")

  // The API's global switch is off while a due time is still stored: shown as paused, never as "due now".
  schedulerEnabled = false
  stored("f1").next_run_at = serverNow - 60_000
  fireEvent.click(within(panel()).getByRole("button", { name: "Refresh schedule" }))
  await flush()
  expect(within(panel()).getByTestId("schedule-next")).toHaveTextContent("Paused: Automatic imports are paused in the API configuration.")
  expect(within(panel()).getByTestId("schedule-next")).not.toHaveTextContent("due now")
})

test("a late answer for one feed never lands on another; a 404 on the schedule reloads the list", async () => {
  await renderLoaded()
  await openSources()
  stored("f1").enabled = true
  stored("f1").interval_minutes = 300
  stored("f1").revision = 7
  holdPattern = /GET \/feeds\/f1\/schedule/
  await openFeed("Studio research")
  expect(scheduleStatus()).toHaveTextContent("Loading the schedule…")
  await openFeed("Atom source")
  fireEvent.change(screen.getByLabelText("Interval minutes"), { target: { value: "75" } })
  release("GET /feeds/f1/schedule")
  holdPattern = null
  await flush()
  // Atom source is untouched by Studio research's late schedule.
  expect(panel()).toHaveAttribute("data-feed-id", "f2")
  expect(screen.getByLabelText("Interval minutes")).toHaveValue(75)
  expect(panel()).toHaveAttribute("data-schedule-revision", "0")
  await openFeed("Studio research")
  expect(screen.getByLabelText("Interval minutes")).toHaveValue(300)
  expect(panel()).toHaveAttribute("data-schedule-revision", "7")

  // The feed vanished elsewhere.
  feeds.delete("f1")
  const lists = requests("GET", "/feeds").length
  fireEvent.click(within(panel()).getByRole("button", { name: "Refresh schedule" }))
  await flush()
  expect(scheduleStatus()).toHaveTextContent("Loading the schedule rejected (404): Feed not found.")
  expect(requests("GET", "/feeds").length).toBeGreaterThanOrEqual(lists + 1)
})
