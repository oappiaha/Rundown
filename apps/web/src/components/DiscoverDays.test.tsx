import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import DiscoverView from "./DiscoverView"
import type { InboxItem, Plan, PlanTopic } from "../lib/api"

// Streaming days and capture against an in-memory server: /plans (create,
// detail, revision-guarded update, add-topic with the live-label rule),
// /inbox/capture (write/link) and /attachments (raw upload). Nothing here
// writes the live clock.

type Call = { method: string; url: string; body?: unknown; headers?: Record<string, string> }

const LONG = "Why the long take came back: how one-shot scenes went from stunt to scheduling decision"

let inbox: Map<string, InboxItem>
let plans: Map<string, Plan>
let calls: Call[]
let seq: number

function item(id: string, text: string, patch: Partial<InboxItem> = {}): InboxItem {
  const entry: InboxItem = {
    id, revision: 1, text, duration: 120, notes: "", source_url: "", archived: false, created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z",
    topic: { text, duration: 120, notes: "" }, source: null, presentation: null, editorial: { revision: 0, saved: false, note: "", updated_at: null }, capture: null, ...patch,
  }
  inbox.set(id, entry)
  return entry
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function summary(plan: Plan) {
  return { id: plan.id, name: plan.name, revision: plan.revision, topic_count: plan.topics.length, total_seconds: plan.topics.reduce((sum, t) => sum + t.duration, 0), stream_date: plan.stream_date, created_at: plan.created_at, updated_at: plan.updated_at }
}

function titleOf(entry: InboxItem): string {
  return entry.capture?.display_title || entry.source?.original_title || entry.text
}

async function serve(method: string, url: string, init?: RequestInit): Promise<Response> {
  const parsed = new URL(url, "http://test.local")
  const path = parsed.pathname
  const body = init?.body && typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
  if (path === "/inbox" && method === "GET") return json({ items: Array.from(inbox.values()).reverse() })
  if (path === "/inbox/capture" && method === "POST") {
    const payload = body as { kind: string; title: string; label?: string; note?: string; source_url?: string }
    if (payload.title.length > 30 && !payload.label) return json({ detail: "The title is longer than 30 characters. Choose a live label for it." }, 422)
    const id = `cap${++seq}`
    const created = item(id, payload.label ?? payload.title, {
      source_url: payload.source_url ?? "",
      editorial: { revision: 1, saved: true, note: payload.note ?? "", updated_at: "2026-09-25T00:00:00Z" },
      capture: { kind: payload.kind as "write" | "link", display_title: payload.title, source_text: "", attachments: [], created_at: "2026-09-25T00:00:00Z" },
    })
    return json(created, 201)
  }
  if (path === "/attachments" && method === "POST") {
    const blob = init?.body as Blob
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const title = parsed.searchParams.get("title") ?? ""
    const label = parsed.searchParams.get("label")
    if (bytes.length > 1024 * 1024) return json({ detail: "Files must be at most 1 MB." }, 413)
    if (!(bytes[0] === 0x89 && bytes[1] === 0x50)) return json({ detail: "Use a PNG, JPEG, PDF, TXT or Markdown file." }, 422)
    const id = `up${++seq}`
    const created = item(id, label ?? title, {
      editorial: { revision: 1, saved: true, note: "", updated_at: "2026-09-25T00:00:00Z" },
      capture: { kind: "upload", display_title: title, source_text: "", created_at: "2026-09-25T00:00:00Z", attachments: [{ id: "a".repeat(32), role: "cover", filename: parsed.searchParams.get("filename") ?? "", media_type: "image/png", size: bytes.length, sha256: "", width: 4, height: 3, url: `/attachments/${"a".repeat(32)}`, created_at: "" }] },
    })
    return json(created, 201)
  }
  const editorial = /^\/inbox\/([^/]+)\/editorial$/.exec(path)
  if (editorial && method === "PUT") {
    const entry = inbox.get(editorial[1])!
    const payload = body as { revision: number; saved: boolean; note: string }
    if (payload.revision !== entry.editorial!.revision) return json({ detail: "stale" }, 409)
    const next = { ...entry, editorial: { revision: payload.revision + 1, saved: payload.saved, note: payload.note, updated_at: "" } }
    inbox.set(entry.id, next)
    return json(next)
  }
  if (path === "/plans" && method === "GET") return json({ plans: Array.from(plans.values()).map(summary) })
  if (path === "/plans" && method === "POST") {
    const payload = body as { name: string; stream_date: string }
    const plan: Plan = { id: `plan${++seq}`, name: payload.name, revision: 1, stream_date: payload.stream_date, topics: [], created_at: "", updated_at: "" }
    plans.set(plan.id, plan)
    return json(plan, 201)
  }
  const one = /^\/plans\/([^/]+)$/.exec(path)
  if (one && method === "GET") {
    const plan = plans.get(one[1])
    return plan ? json(plan) : json({ detail: "Saved show not found." }, 404)
  }
  if (one && method === "PUT") {
    const plan = plans.get(one[1])!
    const payload = body as { revision: number; name: string; topics: Array<{ id?: string | null; text: string; duration: number; notes: string }> }
    if (payload.revision !== plan.revision) return json({ detail: "Saved show changed on another screen. Reload it before trying again." }, 409)
    const known = new Map(plan.topics.map((topic) => [topic.id, topic]))
    const topics: PlanTopic[] = payload.topics.map((topic) => ({ id: topic.id ?? `t${++seq}`, text: topic.text, duration: topic.duration, notes: topic.notes, origin: topic.id ? (known.get(topic.id)?.origin ?? null) : null }))
    const next = { ...plan, name: payload.name, revision: plan.revision + 1, topics }
    plans.set(plan.id, next)
    return json(next)
  }
  const add = /^\/plans\/([^/]+)\/topics$/.exec(path)
  if (add && method === "POST") {
    const plan = plans.get(add[1])!
    const payload = body as { revision: number; inbox_topic_id: string; label?: string }
    if (payload.revision !== plan.revision) return json({ detail: "Saved show changed on another screen." }, 409)
    const entry = inbox.get(payload.inbox_topic_id)!
    const title = titleOf(entry)
    if (plan.topics.some((topic) => topic.origin?.inbox_topic_id === entry.id)) return json({ detail: "This idea is already in this day." }, 409)
    if (title.length > 30 && !payload.label) return json({ detail: "The headline is longer than 30 characters. Choose a live label for it." }, 422)
    const topic: PlanTopic = { id: `t${++seq}`, text: payload.label ?? title, duration: entry.duration, notes: entry.editorial?.note ?? "", origin: { inbox_topic_id: entry.id, display_title: title } }
    const next = { ...plan, revision: plan.revision + 1, topics: [...plan.topics, topic] }
    plans.set(plan.id, next)
    return json(next)
  }
  return json({ detail: "Not Found" }, 404)
}

beforeEach(() => {
  inbox = new Map()
  plans = new Map()
  calls = []
  seq = 0
  Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView
  item("yt", "Why the long take came ba", { source: { kind: "youtube", feed_id: "s", feed_name: "AI search", original_title: LONG, body_text: "Body", published_at: null, imported_at: "", truncated: false }, source_url: "https://example.com/yt" })
  item("idea", "My own idea")
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    calls.push({ method, url, body: init?.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined, headers: init?.headers as Record<string, string> })
    return serve(method, url, init)
  }) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
})

async function renderDiscover() {
  const onOpenShow = vi.fn()
  render(<DiscoverView hidden={false} onOpenSources={vi.fn()} onOpenShow={onOpenShow} />)
  await screen.findByRole("heading", { name: LONG })
  return onOpenShow
}

function drawer(name: string) {
  return screen.getByRole("dialog", { name })
}

async function createDay(name: string, date: string) {
  const days = drawer("Streaming days")
  fireEvent.change(within(days).getByLabelText("Stream date"), { target: { value: date } })
  fireEvent.change(within(days).getByLabelText("Day name"), { target: { value: name } })
  await act(async () => {
    fireEvent.click(within(days).getByRole("button", { name: "Create day" }))
  })
  await within(days).findByText(name)
}

test("＋ Day on a long headline asks for a visible live label, adds with it, and the day keeps its own order and timing", async () => {
  const onOpenShow = await renderDiscover()
  expect(screen.queryByRole("dialog")).toBeNull()
  const yt = screen.getByRole("article", { name: LONG })
  await act(async () => {
    fireEvent.click(within(yt).getByRole("button", { name: `Add to a streaming day: ${LONG}` }))
  })
  const days = drawer("Streaming days")
  expect(days).toHaveAttribute("aria-modal", "true")
  await createDay("Friday live", "2026-10-02")
  expect(calls.find((call) => call.method === "POST" && call.url === "/plans")?.body).toEqual({ name: "Friday live", stream_date: "2026-10-02" })
  // The pending card shows its full headline plus an editable label, pre-filled and never silently truncated.
  expect(within(days).getByTestId("dsc-pending")).toHaveTextContent(LONG)
  const label = within(days).getByLabelText("Live label") as HTMLInputElement
  expect(label.value).toBe("Why the long take came back:")
  fireEvent.change(label, { target: { value: "x".repeat(31) } })
  await act(async () => {
    fireEvent.click(within(days).getByRole("button", { name: "Add with this label" }))
  })
  expect(within(days).getByRole("status")).toHaveTextContent("at most 30 characters")
  expect(calls.filter((call) => call.url.endsWith("/topics"))).toHaveLength(0)
  fireEvent.change(label, { target: { value: "Long take is back" } })
  await act(async () => {
    fireEvent.click(within(days).getByRole("button", { name: "Add with this label" }))
  })
  expect(calls.find((call) => call.url.endsWith("/topics"))?.body).toEqual({ revision: 1, inbox_topic_id: "yt", label: "Long take is back" })
  const list = within(days).getByRole("list", { name: "Topics in Friday live" })
  expect(within(list).getAllByRole("listitem")).toHaveLength(1)
  expect(list).toHaveTextContent(LONG)
  expect(list).toHaveTextContent("On air as Long take is back")
  expect(within(days).queryByTestId("dsc-pending")).toBeNull()
  // Asking again for the same card shows it is already in this day.
  fireEvent.click(within(days).getByRole("button", { name: "Close streaming days" }))
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Streaming days" })).toBeNull())
  await act(async () => {
    fireEvent.click(within(yt).getByRole("button", { name: `Add to a streaming day: ${LONG}` }))
  })
  expect(within(drawer("Streaming days")).getByRole("button", { name: "Already in this day" })).toBeDisabled()
  expect(within(drawer("Streaming days")).queryByLabelText("Live label")).toBeNull()
  // A second card, then reorder and retime: each action is one revision-guarded PUT.
  fireEvent.click(within(drawer("Streaming days")).getByRole("button", { name: "Close streaming days" }))
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Streaming days" })).toBeNull())
  const idea = screen.getByRole("article", { name: "My own idea" })
  await act(async () => {
    fireEvent.click(within(idea).getByRole("button", { name: "Add to a streaming day: My own idea" }))
  })
  expect(within(drawer("Streaming days")).queryByLabelText("Live label")).toBeNull()
  await act(async () => {
    fireEvent.click(within(drawer("Streaming days")).getByRole("button", { name: "Add to this day" }))
  })
  const items = () => within(drawer("Streaming days")).getAllByTestId("dsc-day-item").map((node) => node.querySelector("h3")?.textContent)
  expect(items()).toEqual([LONG, "My own idea"])
  await act(async () => {
    fireEvent.click(within(drawer("Streaming days")).getByRole("button", { name: "Move up: My own idea" }))
  })
  expect(items()).toEqual(["My own idea", LONG])
  const put = calls.filter((call) => call.method === "PUT" && call.url === "/plans/plan1")
  expect(put).toHaveLength(1)
  expect((put[0].body as { revision: number; topics: Array<{ text: string }> }).revision).toBe(3)
  expect((put[0].body as { topics: Array<{ text: string }> }).topics.map((topic) => topic.text)).toEqual(["My own idea", "Long take is back"])
  const seconds = within(drawer("Streaming days")).getByLabelText("Seconds for My own idea") as HTMLInputElement
  fireEvent.change(seconds, { target: { value: "5" } })
  fireEvent.blur(seconds)
  expect(within(drawer("Streaming days")).getByRole("status")).toHaveTextContent("15 to 3600")
  fireEvent.change(seconds, { target: { value: "600" } })
  await act(async () => {
    fireEvent.blur(seconds)
  })
  expect(plans.get("plan1")!.topics.map((topic) => topic.duration)).toEqual([600, 120])
  await act(async () => {
    fireEvent.click(within(drawer("Streaming days")).getByRole("button", { name: `Remove from this day: ${LONG}` }))
  })
  expect(items()).toEqual(["My own idea"])
  expect(inbox.get("yt")).toBeDefined()
  // Opening hands the day to Saved Shows.
  fireEvent.click(within(drawer("Streaming days")).getByRole("button", { name: "Open in Saved Shows" }))
  expect(onOpenShow).toHaveBeenCalledWith({ id: "plan1", name: "Friday live" })
})

test("a stale day edit is refused with 409; this screen's order is kept and can be saved again or dropped", async () => {
  await renderDiscover()
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Streaming days" }))
  })
  await createDay("Friday live", "2026-10-02")
  const days = drawer("Streaming days")
  for (const name of ["Add to a streaming day: My own idea", `Add to a streaming day: ${LONG}`]) {
    fireEvent.click(within(days).getByRole("button", { name: "Close streaming days" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name }))
    })
    await act(async () => {
      fireEvent.click(within(drawer("Streaming days")).getByRole("button", { name: /Add (to this day|with this label)/ }))
    })
  }
  // Another screen moves the day on.
  const plan = plans.get("plan1")!
  plans.set(plan.id, { ...plan, revision: plan.revision + 1, name: "Renamed elsewhere" })
  await act(async () => {
    fireEvent.click(within(drawer("Streaming days")).getByRole("button", { name: "Move up: " + LONG }))
  })
  const alert = within(drawer("Streaming days")).getByRole("alert")
  expect(alert).toHaveTextContent("changed on another screen")
  const items = () => within(drawer("Streaming days")).getAllByTestId("dsc-day-item").map((node) => node.querySelector("h3")?.textContent)
  expect(items()).toEqual([LONG, "My own idea"])
  expect(within(drawer("Streaming days")).getByRole("button", { name: "Move up: My own idea" })).toBeDisabled()
  await act(async () => {
    fireEvent.click(within(alert).getByRole("button", { name: "Keep mine and save again" }))
  })
  expect(plans.get("plan1")!.topics.map((topic) => topic.origin?.display_title)).toEqual([LONG, "My own idea"])
  expect(within(drawer("Streaming days")).queryByRole("alert")).toBeNull()
  expect(items()).toEqual([LONG, "My own idea"])
})

test("Write and Link create real cards with note and source; a long title shows the live label; the sheet keeps its text on failure", async () => {
  await renderDiscover()
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "New topic" }))
  })
  const sheet = drawer("New topic")
  fireEvent.click(within(sheet).getByRole("button", { name: "Link" }))
  fireEvent.change(within(sheet).getByLabelText("Source link"), { target: { value: "ftp://example.com/x" } })
  fireEvent.change(within(sheet).getByLabelText("Topic title"), { target: { value: "  A long headline that will not fit the live label limit at all " } })
  expect((within(sheet).getByLabelText("Live label") as HTMLInputElement).value).toBe("A long headline that will not")
  fireEvent.change(within(sheet).getByLabelText("Personal note"), { target: { value: "My angle" } })
  await act(async () => {
    fireEvent.click(within(sheet).getByRole("button", { name: "Create topic" }))
  })
  expect(within(sheet).getByRole("alert")).toHaveTextContent("http or https")
  expect((within(sheet).getByLabelText("Personal note") as HTMLTextAreaElement).value).toBe("My angle")
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(0)
  fireEvent.change(within(sheet).getByLabelText("Source link"), { target: { value: "https://example.com/story" } })
  fireEvent.change(within(sheet).getByLabelText("Live label"), { target: { value: "Long headline" } })
  await act(async () => {
    fireEvent.click(within(sheet).getByRole("button", { name: "Create topic" }))
  })
  expect(calls.find((call) => call.url === "/inbox/capture")?.body).toEqual({ kind: "link", title: "A long headline that will not fit the live label limit at all", label: "Long headline", note: "My angle", source_url: "https://example.com/story", duration: 120 })
  const card = await screen.findByRole("article", { name: "A long headline that will not fit the live label limit at all" })
  expect(within(card).getByText("Your link")).toBeInTheDocument()
  expect(within(card).getByText("example.com")).toBeInTheDocument()
  expect(within(card).getByRole("link", { name: /Open original/ })).toHaveAttribute("href", "https://example.com/story")
  expect(within(card).getByText("Long headline")).toBeInTheDocument()
  expect(within(card).getByRole("button", { name: /Remove bookmark/ })).toBeInTheDocument()
  expect(document.querySelector(".dsc-toast")).toHaveTextContent("saved to your library")
  // Write: short title, no label field, no url.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "New topic" }))
  })
  fireEvent.click(within(drawer("New topic")).getByRole("button", { name: "Write" }))
  fireEvent.change(within(drawer("New topic")).getByLabelText("Topic title"), { target: { value: "Plain idea" } })
  expect(within(drawer("New topic")).queryByLabelText("Live label")).toBeNull()
  await act(async () => {
    fireEvent.click(within(drawer("New topic")).getByRole("button", { name: "Create topic" }))
  })
  expect(calls.filter((call) => call.url === "/inbox/capture").at(-1)?.body).toEqual({ kind: "write", title: "Plain idea", note: "", duration: 120 })
  await screen.findByRole("article", { name: "Plain idea" })
})

test("an upload sends the raw file with the title in the query, saves the note afterwards, and can be added to the chosen day", async () => {
  await renderDiscover()
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Streaming days" }))
  })
  await createDay("Sunday recap", "2026-10-04")
  await act(async () => {
    fireEvent.click(within(drawer("Streaming days")).getByRole("button", { name: "＋ Create a topic for this day" }))
  })
  const sheet = drawer("New topic")
  fireEvent.click(within(sheet).getByRole("button", { name: "Upload" }))
  const bad = new File([new Uint8Array([1, 2, 3])], "vector.svg", { type: "image/svg+xml" })
  fireEvent.change(within(sheet).getByLabelText("Topic file"), { target: { files: [bad] } })
  expect((within(sheet).getByLabelText("Topic title") as HTMLInputElement).value).toBe("vector")
  await act(async () => {
    fireEvent.click(within(sheet).getByRole("button", { name: "Create topic" }))
  })
  expect(within(sheet).getByRole("alert")).toHaveTextContent("PNG, JPEG")
  expect(calls.filter((call) => call.url.startsWith("/attachments"))).toHaveLength(0)
  const good = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])], "cover art.png", { type: "image/png" })
  fireEvent.change(within(sheet).getByLabelText("Topic file"), { target: { files: [good] } })
  fireEvent.change(within(sheet).getByLabelText("Topic title"), { target: { value: "Cover art" } })
  fireEvent.change(within(sheet).getByLabelText("Personal note"), { target: { value: "Show this first" } })
  expect(within(sheet).getByRole("checkbox", { name: "Add to 2026-10-04 · Sunday recap" })).toBeChecked()
  await act(async () => {
    fireEvent.click(within(sheet).getByRole("button", { name: "Create topic" }))
  })
  const upload = calls.find((call) => call.url.startsWith("/attachments?"))!
  const query = new URL(upload.url, "http://test.local").searchParams
  expect([query.get("title"), query.get("filename"), query.get("label")]).toEqual(["Cover art", "cover art.png", null])
  expect(upload.headers).toEqual({ "content-type": "image/png" })
  const created = Array.from(inbox.values()).find((entry) => entry.capture?.kind === "upload")!
  expect(calls.find((call) => call.url === `/inbox/${created.id}/editorial`)?.body).toEqual({ revision: 1, saved: true, note: "Show this first" })
  expect(calls.find((call) => call.url === "/plans/plan1/topics")?.body).toEqual({ revision: 1, inbox_topic_id: created.id })
  const card = await screen.findByRole("article", { name: "Cover art" })
  expect(within(card).getByText("Your upload")).toBeInTheDocument()
  expect(within(card).getByText("cover art.png")).toBeInTheDocument()
  expect((within(card).getByTestId("dsc-thumb") as HTMLImageElement).getAttribute("src")).toBe(`/attachments/${"a".repeat(32)}`)
  expect(within(drawer("Streaming days")).getByRole("list", { name: "Topics in Sunday recap" })).toHaveTextContent("Cover art")
  expect(document.querySelector(".dsc-toast")).toHaveTextContent("added to")
})
