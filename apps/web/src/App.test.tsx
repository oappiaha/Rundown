import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import App from "./App"
import type { ShowState } from "./lib/api"

type Call = { method: string; url: string; body?: unknown }

let server: ShowState
let calls: Call[]
let nextPutResponse: (() => Response | Promise<Response>) | null
let holdGets: boolean
let heldGets: Array<() => void>

function state(patch: Partial<ShowState> = {}): ShowState {
  return {
    revision: 3,
    topics: [
      { id: "a", text: "Opening", duration: 120, notes: "" },
      { id: "b", text: "Second", duration: 90, notes: "" },
      { id: "c", text: "Closing", duration: 60, notes: "" },
    ],
    current_topic_id: "a",
    remaining_seconds: 100,
    paused: false,
    server_time: "2026-09-14T00:00:00.000Z",
    ...patch,
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** Deferred response: the promise resolves only when `release()` is called. */
function deferred() {
  let release: (response: Response) => void = () => {}
  const promise = new Promise<Response>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function releaseGets() {
  const pending = heldGets
  heldGets = []
  for (const release of pending) release()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  server = state()
  calls = []
  nextPutResponse = null
  holdGets = false
  heldGets = []
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
    calls.push({ method, url, body })
    if (url.endsWith("/rundown/state")) {
      // The snapshot is taken when the request is served; delivery may be delayed.
      const response = jsonResponse(server)
      if (!holdGets) return response
      return new Promise<Response>((resolve) => heldGets.push(() => resolve(response)))
    }
    if (url.endsWith("/rundown/schedule") && method === "PUT") {
      if (nextPutResponse) {
        const response = nextPutResponse()
        nextPutResponse = null
        return response
      }
      const payload = body as { revision: number; topics: Array<{ id?: string; text: string; duration: number; notes?: string }> }
      if (payload.revision !== server.revision) return jsonResponse({ detail: "Show changed. Reload the latest schedule before saving." }, 409)
      let n = 0
      server = {
        ...server,
        revision: server.revision + 1,
        server_time: "2026-09-14T00:00:05.000Z",
        // Mirrors the server: an omitted `notes` keeps the stored value, "" clears it.
        topics: payload.topics.map((topic) => ({
          id: topic.id ?? `new${++n}`,
          text: topic.text,
          duration: topic.duration,
          notes: topic.notes ?? server.topics.find((existing) => existing.id === topic.id)?.notes ?? "",
        })),
      }
      return jsonResponse(server)
    }
    if (url.endsWith("/rundown/control") && method === "POST") {
      const payload = body as { revision: number; action: string }
      if (payload.revision !== server.revision) return jsonResponse({ detail: "stale revision" }, 409)
      if (payload.action === "play") server = { ...server, revision: server.revision + 1, paused: false, server_time: "2026-09-14T00:00:05.000Z" }
      if (payload.action === "pause") server = { ...server, revision: server.revision + 1, paused: true, server_time: "2026-09-14T00:00:05.000Z" }
      return jsonResponse(server)
    }
    return jsonResponse({ detail: "Not Found" }, 404)
  }) as unknown as typeof fetch
})

afterEach(() => {
  vi.useRealTimers()
})

async function renderLoaded() {
  render(<App />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(await screen.findByDisplayValue("Opening")).toBeInTheDocument()
}

async function tick(ms = 1000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function puts() {
  return calls.filter((call) => call.method === "PUT")
}

function expectNoRevisionJargon() {
  expect(document.body.textContent).not.toMatch(/\brev(ision)?\b/i)
}

test("insert-next places the new topic after the current segment and publishes without an id", async () => {
  await renderLoaded()
  expect(screen.getByRole("status", { name: "API connection" })).toHaveTextContent("Connected")
  expect(screen.getByText("Everything is published.")).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText("New topic title"), { target: { value: "Breaking drop" } })
  fireEvent.change(screen.getByLabelText("New topic duration"), { target: { value: "45" } })
  fireEvent.click(screen.getByRole("button", { name: "Insert next" }))

  const titles = screen.getAllByLabelText(/Topic \d title/).map((input) => (input as HTMLInputElement).value)
  expect(titles).toEqual(["Opening", "Breaking drop", "Second", "Closing"])
  expect(screen.getByLabelText("New topic title")).toHaveFocus()
  expect(screen.getByText('"Breaking drop" inserted after the current segment. Publish to make it live.')).toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "Publish schedule" }))
  await tick(0)
  expect(puts()[0]?.body).toEqual({
    revision: 3,
    topics: [
      { id: "a", text: "Opening", duration: 120, notes: "" },
      { text: "Breaking drop", duration: 45, notes: "" },
      { id: "b", text: "Second", duration: 90, notes: "" },
      { id: "c", text: "Closing", duration: 60, notes: "" },
    ],
  })
  expect(await screen.findByText("Published · 4 topics.")).toBeInTheDocument()
  expectNoRevisionJargon()
})

test("add-to-end, edit, reorder and remove keep stable keys and publish the ordered draft", async () => {
  await renderLoaded()
  fireEvent.change(screen.getByLabelText("New topic title"), { target: { value: "Encore" } })
  fireEvent.click(screen.getByRole("button", { name: "Add to end" }))
  fireEvent.change(screen.getByLabelText("Topic 2 title"), { target: { value: "Second act" } })
  fireEvent.change(screen.getByLabelText("Topic 2 duration"), { target: { value: "75" } })
  fireEvent.click(screen.getByLabelText("Move topic 4 up"))
  fireEvent.click(screen.getByLabelText("Remove topic 4"))
  expect(screen.getByLabelText("Remove topic 1")).toBeDisabled()

  fireEvent.click(screen.getByRole("button", { name: "Publish schedule" }))
  await tick(0)
  expect(puts()[0]?.body).toEqual({
    revision: 3,
    topics: [
      { id: "a", text: "Opening", duration: 120, notes: "" },
      { id: "b", text: "Second act", duration: 75, notes: "" },
      { text: "Encore", duration: 120, notes: "" },
    ],
  })
})

test("a remote change while drafting keeps the draft; merge-and-publish keeps local edits, remote field changes and remote additions", async () => {
  await renderLoaded()
  fireEvent.change(screen.getByLabelText("Topic 3 title"), { target: { value: "Closing remarks" } })
  // Another screen: renamed topic 1, changed topic 2's duration, inserted a row after topic 2.
  server = state({
    revision: 9,
    remaining_seconds: 40,
    server_time: "2026-09-14T00:00:03.000Z",
    topics: [
      { id: "a", text: "Opening (other)", duration: 120, notes: "" },
      { id: "b", text: "Second", duration: 100, notes: "" },
      { id: "d", text: "Remote add", duration: 30, notes: "" },
      { id: "c", text: "Closing", duration: 60, notes: "" },
    ],
  })
  await tick(1000)
  await tick(1000)

  expect(screen.getByDisplayValue("Closing remarks")).toBeInTheDocument()
  expect(screen.queryByDisplayValue("Remote add")).not.toBeInTheDocument()
  expect(screen.getByDisplayValue("Opening")).toBeInTheDocument()
  expect(screen.getByText(/The show changed on another screen\. Publishing will ask you to merge/)).toBeInTheDocument()
  expect(screen.getByText("0:40")).toBeInTheDocument()
  expectNoRevisionJargon()

  fireEvent.click(screen.getByRole("button", { name: "Publish schedule" }))
  await tick(0)
  expect((puts()[0]?.body as { revision: number }).revision).toBe(3)
  const alert = await screen.findByRole("alert")
  expect(alert).toHaveTextContent("Not published. The show changed on another screen. Your changes are kept here.")
  expect(alert).not.toHaveTextContent(/revision/i)
  expect(screen.getByDisplayValue("Closing remarks")).toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "Merge and publish" }))
  await tick(0)
  expect(puts()).toHaveLength(2)
  expect(puts()[1]?.body).toEqual({
    revision: 9,
    topics: [
      { id: "a", text: "Opening (other)", duration: 120, notes: "" },
      { id: "b", text: "Second", duration: 100, notes: "" },
      { id: "d", text: "Remote add", duration: 30, notes: "" },
      { id: "c", text: "Closing remarks", duration: 60, notes: "" },
    ],
  })
  expect(await screen.findByText("Published · 4 topics.")).toBeInTheDocument()
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  expectNoRevisionJargon()
})

test("merge without publishing brings the other screen's changes into the draft and keeps editing open", async () => {
  await renderLoaded()
  fireEvent.change(screen.getByLabelText("Topic 1 title"), { target: { value: "Opening edited" } })
  server = state({ revision: 4, topics: [...server.topics, { id: "d", text: "Remote add", duration: 30, notes: "" }] })
  await tick(1000)
  fireEvent.click(await screen.findByRole("button", { name: "Merge now" }))
  await tick(0)
  expect(await screen.findByDisplayValue("Remote add")).toBeInTheDocument()
  expect(screen.getByDisplayValue("Opening edited")).toBeInTheDocument()
  expect(screen.getByText(/Merged the other screen's changes into your draft/)).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Publish schedule" })).toBeEnabled()
  expect(puts()).toHaveLength(0)
})

test("discarding after a conflict restores the published show", async () => {
  await renderLoaded()
  fireEvent.change(screen.getByLabelText("Topic 1 title"), { target: { value: "Changed" } })
  nextPutResponse = () => jsonResponse({ detail: "stale revision" }, 409)
  fireEvent.click(screen.getByRole("button", { name: "Publish schedule" }))
  await tick(0)
  expect(await screen.findByRole("alert")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Discard my changes" }))
  expect(screen.getByDisplayValue("Opening")).toBeInTheDocument()
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})

test("editing, adding, reordering and removing are locked while a publish is pending", async () => {
  await renderLoaded()
  fireEvent.change(screen.getByLabelText("Topic 2 title"), { target: { value: "Second act" } })
  const pending = deferred()
  nextPutResponse = () => pending.promise
  fireEvent.click(screen.getByRole("button", { name: "Publish schedule" }))
  await tick(0)

  expect(screen.getByRole("button", { name: "Publishing…" })).toBeDisabled()
  expect(screen.getByLabelText("Topic 2 title")).toBeDisabled()
  expect(screen.getByLabelText("Topic 2 duration")).toBeDisabled()
  expect(screen.getByLabelText("Move topic 2 up")).toBeDisabled()
  expect(screen.getByLabelText("Remove topic 2")).toBeDisabled()
  expect(screen.getByLabelText("Jump to topic 2")).toBeDisabled()
  expect(screen.getByText("Publishing… adding is paused for a moment.")).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText("New topic title"), { target: { value: "Late add" } })
  expect(screen.getByRole("button", { name: "Add to end" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Insert next" })).toBeDisabled()
  expect(screen.getByRole("checkbox", { name: "Publish immediately" })).toBeDisabled()
  // Even a programmatic change event cannot alter the draft while locked.
  fireEvent.change(screen.getByLabelText("Topic 2 title"), { target: { value: "Should not stick" } })
  expect(screen.getByLabelText("Topic 2 title")).toHaveValue("Second act")

  const published = state({ revision: 4, topics: [server.topics[0]!, { id: "b", text: "Second act", duration: 90, notes: "" }, server.topics[2]!], server_time: "2026-09-14T00:00:05.000Z" })
  server = published
  pending.release(jsonResponse(published))
  await tick(0)
  expect(await screen.findByText("Published · 3 topics.")).toBeInTheDocument()
  expect(screen.getByLabelText("Topic 2 title")).toBeEnabled()
  expect(screen.getByLabelText("Topic 2 title")).toHaveValue("Second act")
  expect(screen.getByLabelText("Move topic 2 up")).toBeEnabled()
  // The quick-add text typed during the lock survived and is now usable.
  expect(screen.getByLabelText("New topic title")).toHaveValue("Late add")
  expect(screen.getByRole("button", { name: "Add to end" })).toBeEnabled()
  expect(screen.queryByRole("button", { name: "Discard" })).not.toBeInTheDocument()
})

test("quick-add is unavailable until the show has loaded and keeps what was typed", async () => {
  holdGets = true
  render(<App />)
  await tick(0)
  expect(screen.getByText("Loading show state…")).toBeInTheDocument()
  expect(screen.getByText("Waiting for the show to load…")).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText("New topic title"), { target: { value: "Early bird" } })
  expect(screen.getByRole("button", { name: "Add to end" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Insert next" })).toBeDisabled()
  fireEvent.submit(screen.getByRole("form", { name: "Add a topic" }))
  expect(screen.getByLabelText("New topic title")).toHaveValue("Early bird")
  expect(screen.queryByLabelText(/Topic \d title/)).not.toBeInTheDocument()

  holdGets = false
  releaseGets()
  await tick(0)
  expect(await screen.findByDisplayValue("Opening")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Add to end" })).toBeEnabled()
  fireEvent.click(screen.getByRole("button", { name: "Add to end" }))
  expect(screen.getByLabelText("Topic 4 title")).toHaveValue("Early bird")
  expect(screen.getByLabelText("New topic title")).toHaveValue("")
})

test("a delayed older GET snapshot cannot regress state adopted from a transport action", async () => {
  await renderLoaded()
  holdGets = true
  await tick(1000) // poll #2 is served now (revision 3, playing) but delivered later
  expect(heldGets).toHaveLength(1)

  fireEvent.click(screen.getByRole("button", { name: "Pause" }))
  await tick(0)
  expect(await screen.findByRole("button", { name: "Play" })).toBeInTheDocument()
  expect(screen.getByRole("status", { name: "API connection" })).toHaveAttribute("data-revision", "4")

  releaseGets()
  await tick(0)
  // The stale snapshot (revision 3, not paused) must be ignored.
  expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument()
  expect(screen.getByRole("status", { name: "API connection" })).toHaveAttribute("data-revision", "4")

  // A genuinely newer poll is still adopted.
  holdGets = false
  server = { ...server, remaining_seconds: 42, server_time: "2026-09-14T00:00:06.000Z" }
  await tick(1000)
  expect(await screen.findByText("0:42")).toBeInTheDocument()
})

test("a delayed older GET snapshot cannot undo a publish result", async () => {
  await renderLoaded()
  fireEvent.change(screen.getByLabelText("Topic 1 title"), { target: { value: "Opening edited" } })
  holdGets = true
  await tick(1000) // stale poll: revision 3 with the old title
  fireEvent.click(screen.getByRole("button", { name: "Publish schedule" }))
  await tick(0)
  expect(await screen.findByText("Published · 3 topics.")).toBeInTheDocument()
  releaseGets()
  await tick(0)
  expect(screen.getByLabelText("Topic 1 title")).toHaveValue("Opening edited")
  expect(screen.getByRole("status", { name: "API connection" })).toHaveAttribute("data-revision", "4")
  expect(screen.getByText("Published · 3 topics.")).toBeInTheDocument()
})

test("publish immediately adds and publishes in one action, and stays conflict-safe", async () => {
  await renderLoaded()
  fireEvent.click(screen.getByRole("checkbox", { name: "Publish immediately" }))
  expect(screen.getByRole("button", { name: "Insert next & publish" })).toBeDisabled()
  fireEvent.change(screen.getByLabelText("New topic title"), { target: { value: "Breaking" } })
  fireEvent.change(screen.getByLabelText("New topic duration"), { target: { value: "30" } })
  fireEvent.click(screen.getByRole("button", { name: "Insert next & publish" }))
  await tick(0)
  expect(puts()[0]?.body).toEqual({
    revision: 3,
    topics: [
      { id: "a", text: "Opening", duration: 120, notes: "" },
      { text: "Breaking", duration: 30, notes: "" },
      { id: "b", text: "Second", duration: 90, notes: "" },
      { id: "c", text: "Closing", duration: 60, notes: "" },
    ],
  })
  expect(await screen.findByText('"Breaking" inserted after the current segment and published.')).toBeInTheDocument()
  expect(screen.getByLabelText("New topic title")).toHaveValue("")
  expect(screen.queryByRole("button", { name: "Discard" })).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Publish schedule" })).toBeDisabled()

  // A draft pinned to this revision exists; another screen moves on; an
  // immediate publish now conflicts, but neither the draft nor the new row is lost.
  fireEvent.change(screen.getByLabelText("Topic 1 title"), { target: { value: "Opening edited" } })
  server = state({ revision: 9, topics: [...server.topics, { id: "z", text: "Remote add", duration: 20, notes: "" }] })
  await tick(1000)
  expect(screen.getByText("On: publishes the new topic together with your other unsaved changes.")).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText("New topic title"), { target: { value: "Late" } })
  fireEvent.click(screen.getByRole("button", { name: "Add & publish" }))
  await tick(0)
  expect(await screen.findByRole("alert")).toHaveTextContent("Not published.")
  expect(screen.getByDisplayValue("Late")).toBeInTheDocument()
  expect(screen.getByText("Can't publish right now; the topic will be added to your draft instead.")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Merge and publish" }))
  await tick(0)
  const last = puts().at(-1)?.body as { revision: number; topics: Array<{ text: string }> }
  expect(last.revision).toBe(9)
  expect(last.topics.map((topic) => topic.text)).toEqual(["Opening edited", "Breaking", "Second", "Closing", "Remote add", "Late"])
  expect(await screen.findByText("Published · 6 topics.")).toBeInTheDocument()
})

test("transport buttons call the control endpoint with the live revision and surface errors", async () => {
  await renderLoaded()
  expect(screen.getByTestId("lcd-topic")).toHaveTextContent("Opening")
  expect(screen.getByTestId("lcd-time")).toHaveTextContent("1:40")

  fireEvent.click(screen.getByRole("button", { name: "Pause" }))
  await tick(0)
  const post = calls.find((call) => call.method === "POST")
  expect(post?.body).toEqual({ revision: 3, action: "pause" })
  expect(await screen.findByRole("button", { name: "Play" })).toBeInTheDocument()

  server = { ...server, revision: 42 }
  fireEvent.click(screen.getByRole("button", { name: "Play" }))
  await tick(0)
  expect(await screen.findByText(/Transport "play" rejected \(409\)/)).toBeInTheDocument()
})

test("empty show disables transport and quick-add stays usable", async () => {
  server = state({ topics: [], current_topic_id: null, remaining_seconds: 0, paused: true, revision: 0 })
  render(<App />)
  await tick(0)
  expect(await screen.findByText(/No topics yet/)).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Play" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Insert next" })).toBeDisabled()
  fireEvent.change(screen.getByLabelText("New topic title"), { target: { value: "First" } })
  expect(screen.getByRole("button", { name: "Add to end" })).toBeEnabled()
  fireEvent.click(screen.getByRole("button", { name: "Add to end" }))
  expect(screen.getByDisplayValue("First")).toBeInTheDocument()
})

test("rejects invalid quick-add input", async () => {
  await renderLoaded()
  expect(screen.getByRole("button", { name: "Add to end" })).toBeDisabled()
  fireEvent.change(screen.getByLabelText("New topic title"), { target: { value: "Valid" } })
  fireEvent.change(screen.getByLabelText("New topic duration"), { target: { value: "10" } })
  expect(screen.getByRole("button", { name: "Add to end" })).toBeDisabled()
})

// ---- Notes / context --------------------------------------------------------

const CONTEXT = "Why it matters: the drop sold out in 4 minutes.\nAsk: was it restocked?\nhttps://example.com/news/drop?ref=rundown&x=1\n"

function openRowNotes(n: number) {
  fireEvent.click(screen.getByRole("button", { name: `Notes for topic ${n}` }))
  return screen.getByLabelText(`Topic ${n} notes`) as HTMLTextAreaElement
}

test("quick-add context: expand, type multiline notes with a URL, insert next and publish immediately; a fresh load reads them back", async () => {
  await renderLoaded()
  expect(screen.queryByLabelText("New topic notes")).not.toBeInTheDocument()
  const toggle = screen.getByRole("button", { name: "Context for the new topic" })
  expect(toggle).toHaveAttribute("aria-expanded", "false")
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute("aria-expanded", "true")
  const notes = screen.getByLabelText("New topic notes") as HTMLTextAreaElement
  expect(toggle).toHaveAttribute("aria-controls", notes.closest(".notes-panel")?.id)
  fireEvent.change(notes, { target: { value: CONTEXT } })
  expect(screen.getByText(/^\d+ \/ 10,000 characters$/)).toBeInTheDocument()
  expect(toggle).toHaveTextContent("Context")

  // Enter inside the textarea must not submit the form.
  fireEvent.keyDown(notes, { key: "Enter", code: "Enter" })
  fireEvent.keyPress(notes, { key: "Enter", code: "Enter", charCode: 13 })
  expect(puts()).toHaveLength(0)
  expect(screen.queryByLabelText(/Topic 4 title/)).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole("checkbox", { name: "Publish immediately" }))
  fireEvent.change(screen.getByLabelText("New topic title"), { target: { value: "Sold-out drop" } })
  fireEvent.change(screen.getByLabelText("New topic duration"), { target: { value: "45" } })
  fireEvent.click(screen.getByRole("button", { name: "Insert next & publish" }))
  await tick(0)
  expect(puts()[0]?.body).toEqual({
    revision: 3,
    topics: [
      { id: "a", text: "Opening", duration: 120, notes: "" },
      { text: "Sold-out drop", duration: 45, notes: CONTEXT },
      { id: "b", text: "Second", duration: 90, notes: "" },
      { id: "c", text: "Closing", duration: 60, notes: "" },
    ],
  })
  expect(await screen.findByText('"Sold-out drop" inserted after the current segment and published.')).toBeInTheDocument()
  expect(screen.getByLabelText("New topic title")).toHaveValue("")
  expect(screen.getByLabelText("New topic notes")).toHaveValue("")
  expect(toggle).toHaveTextContent("Add context")
  // The row that came back carries the notes and says so before it is expanded.
  expect(screen.getByRole("button", { name: "Notes for topic 2" })).toHaveTextContent("Notes")
  expect(screen.getByRole("button", { name: "Notes for topic 1" })).toHaveTextContent("Add notes")

  // Fresh page load: the server still has the notes; the row shows them on demand.
  cleanup()
  render(<App />)
  await tick(0)
  expect(await screen.findByDisplayValue("Sold-out drop")).toBeInTheDocument()
  expect(openRowNotes(2)).toHaveValue(CONTEXT)
  expect(screen.getByRole("button", { name: "Notes for topic 2" })).toHaveAttribute("aria-expanded", "true")
  expect(screen.getByText("Everything is published.")).toBeInTheDocument()
})

test("title-only quick-add still works and sends empty notes", async () => {
  await renderLoaded()
  fireEvent.change(screen.getByLabelText("New topic title"), { target: { value: "Plain" } })
  fireEvent.click(screen.getByRole("button", { name: "Add to end" }))
  fireEvent.click(screen.getByRole("button", { name: "Publish schedule" }))
  await tick(0)
  expect((puts()[0]?.body as { topics: unknown[] }).topics.at(-1)).toEqual({ text: "Plain", duration: 120, notes: "" })
  expect(await screen.findByText("Published · 4 topics.")).toBeInTheDocument()
})

test("existing row notes: edit and publish, then clear and publish; notes drive the dirty check and survive reorders", async () => {
  server = state({ topics: [{ ...server.topics[0]!, notes: "" }, { ...server.topics[1]!, notes: "Existing <b>notes</b>" }, server.topics[2]!] })
  await renderLoaded()
  expect(screen.getByRole("button", { name: "Notes for topic 2" })).toHaveTextContent("Notes")
  const notes = openRowNotes(2)
  expect(notes).toHaveValue("Existing <b>notes</b>")
  expect(document.querySelector("b")).toBeNull() // literal HTML stays literal
  expect(screen.getByRole("button", { name: "Publish schedule" })).toBeDisabled()

  fireEvent.change(notes, { target: { value: "Existing <b>notes</b>\nplus a line" } })
  expect(screen.getByText("Unsaved changes.")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Publish schedule" })).toBeEnabled()
  fireEvent.change(notes, { target: { value: "Existing <b>notes</b>" } })
  expect(screen.getByRole("button", { name: "Publish schedule" })).toBeDisabled()
  fireEvent.change(notes, { target: { value: "  edited, untrimmed  " } })

  // Reorder with the editor open: the notes and the expanded editor follow the row.
  fireEvent.click(screen.getByLabelText("Move topic 2 down"))
  expect(screen.getByLabelText("Topic 3 title")).toHaveValue("Second")
  expect(screen.getByLabelText("Topic 3 notes")).toHaveValue("  edited, untrimmed  ")
  expect(screen.queryByLabelText("Topic 2 notes")).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "Publish schedule" }))
  await tick(0)
  expect(puts()[0]?.body).toEqual({
    revision: 3,
    topics: [
      { id: "a", text: "Opening", duration: 120, notes: "" },
      { id: "c", text: "Closing", duration: 60, notes: "" },
      { id: "b", text: "Second", duration: 90, notes: "  edited, untrimmed  " },
    ],
  })
  expect(await screen.findByText("Published · 3 topics.")).toBeInTheDocument()
  expect(screen.getByLabelText("Topic 3 notes")).toHaveValue("  edited, untrimmed  ")

  // Clearing sends "" explicitly and drops the indicator.
  fireEvent.change(screen.getByLabelText("Topic 3 notes"), { target: { value: "" } })
  expect(screen.getByRole("button", { name: "Notes for topic 3" })).toHaveTextContent("Add notes")
  fireEvent.click(screen.getByRole("button", { name: "Publish schedule" }))
  await tick(0)
  expect((puts()[1]?.body as { topics: Array<{ id?: string; notes: string }> }).topics[2]).toEqual({ id: "b", text: "Second", duration: 90, notes: "" })
  expect(await screen.findByText("Published · 3 topics.")).toBeInTheDocument()
  expect(server.topics[2]?.notes).toBe("")
})

test("notes never reach the LCD, and the title stays a separate short field", async () => {
  server = state({ topics: [{ ...server.topics[0]!, notes: "SECRET PRODUCER NOTES" }, server.topics[1]!, server.topics[2]!] })
  await renderLoaded()
  expect(screen.getByTestId("lcd-topic")).toHaveTextContent("Opening")
  expect(screen.getByTestId("lcd-topic")).not.toHaveTextContent("SECRET")
  expect(document.querySelector(".lcd")?.textContent).not.toMatch(/SECRET/)
  expect(document.querySelector(".deck")?.textContent).not.toMatch(/SECRET/)
  expect(screen.queryByText(/SECRET PRODUCER NOTES/)).not.toBeInTheDocument() // collapsed by default
  expect(openRowNotes(1)).toHaveValue("SECRET PRODUCER NOTES")
  expect(screen.getByTestId("lcd-topic")).not.toHaveTextContent("SECRET")
  expect(screen.getByLabelText("Topic 1 title")).toHaveAttribute("maxlength", "30")
})

test("notes over 10,000 characters are rejected with feedback; exactly 10,000 is fine; the quick-add limit blocks adding", async () => {
  await renderLoaded()
  const notes = openRowNotes(1)
  fireEvent.change(notes, { target: { value: "x".repeat(10000) } })
  expect(screen.getByText("10,000 / 10,000 characters")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Publish schedule" })).toBeEnabled()
  fireEvent.change(notes, { target: { value: "x".repeat(10001) } })
  expect(notes).toHaveAttribute("aria-invalid", "true")
  expect(screen.getAllByText("Notes must be at most 10000 characters (currently 10001).").length).toBeGreaterThan(0)
  expect(screen.getByText("Topic 1: Notes must be at most 10000 characters (currently 10001).")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Publish schedule" })).toBeDisabled()
  expect(puts()).toHaveLength(0)

  fireEvent.click(screen.getByRole("button", { name: "Context for the new topic" }))
  fireEvent.change(screen.getByLabelText("New topic title"), { target: { value: "Too much" } })
  fireEvent.change(screen.getByLabelText("New topic notes"), { target: { value: "😀".repeat(10001) } })
  expect(screen.getByRole("button", { name: "Add to end" })).toBeDisabled()
  fireEvent.change(screen.getByLabelText("New topic notes"), { target: { value: "😀".repeat(10000) } })
  expect(screen.getByText("10,000 / 10,000 characters")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Add to end" })).toBeEnabled()
})

test("notes are locked during a pending publish, quick-add notes typed meanwhile survive, and a stale save keeps draft notes", async () => {
  server = state({ topics: [server.topics[0]!, { ...server.topics[1]!, notes: "before" }, server.topics[2]!] })
  await renderLoaded()
  const notes = openRowNotes(2)
  fireEvent.change(notes, { target: { value: "during-lock draft" } })
  const pending = deferred()
  nextPutResponse = () => pending.promise
  fireEvent.click(screen.getByRole("button", { name: "Publish schedule" }))
  await tick(0)
  expect(notes).toBeDisabled()
  fireEvent.change(notes, { target: { value: "should not stick" } })
  expect(notes).toHaveValue("during-lock draft")
  // Quick-add context typed while the publish is pending is kept.
  fireEvent.click(screen.getByRole("button", { name: "Context for the new topic" }))
  fireEvent.change(screen.getByLabelText("New topic notes"), { target: { value: "next topic notes\nhttps://x.example" } })
  fireEvent.change(screen.getByLabelText("New topic title"), { target: { value: "Next up" } })
  expect(screen.getByRole("button", { name: "Add to end" })).toBeDisabled()

  const published = state({ revision: 4, topics: [server.topics[0]!, { ...server.topics[1]!, notes: "during-lock draft" }, server.topics[2]!], server_time: "2026-09-14T00:00:05.000Z" })
  server = published
  pending.release(jsonResponse(published))
  await tick(0)
  expect(await screen.findByText("Published · 3 topics.")).toBeInTheDocument()
  expect(notes).toBeEnabled()
  expect(notes).toHaveValue("during-lock draft")
  expect(screen.getByLabelText("New topic notes")).toHaveValue("next topic notes\nhttps://x.example")
  expect(screen.getByLabelText("New topic title")).toHaveValue("Next up")
  fireEvent.click(screen.getByRole("button", { name: "Add to end" }))
  expect(screen.getByLabelText("Topic 4 title")).toHaveValue("Next up")
  expect(openRowNotes(4)).toHaveValue("next topic notes\nhttps://x.example")

  // Stale save: the other screen wrote notes on topic 1 and renamed topic 2; we edited topic 2's notes.
  fireEvent.change(notes, { target: { value: "mine wins" } })
  server = state({
    revision: 9,
    topics: [{ ...server.topics[0]!, notes: "remote notes on 1" }, { ...server.topics[1]!, text: "Second (other)", notes: "theirs" }, server.topics[2]!],
  })
  fireEvent.click(screen.getByRole("button", { name: "Publish schedule" }))
  await tick(0)
  expect(await screen.findByRole("alert")).toHaveTextContent("Not published.")
  expect(notes).toHaveValue("mine wins")
  expect(screen.getByLabelText("Topic 4 notes")).toHaveValue("next topic notes\nhttps://x.example")
  fireEvent.click(screen.getByRole("button", { name: "Merge and publish" }))
  await tick(0)
  expect(puts().at(-1)?.body).toEqual({
    revision: 9,
    topics: [
      { id: "a", text: "Opening", duration: 120, notes: "remote notes on 1" },
      { id: "b", text: "Second (other)", duration: 90, notes: "mine wins" },
      { id: "c", text: "Closing", duration: 60, notes: "" },
      { text: "Next up", duration: 120, notes: "next topic notes\nhttps://x.example" },
    ],
  })
  expect(await screen.findByText("Published · 4 topics.")).toBeInTheDocument()
  expect(screen.getByLabelText("Topic 1 title")).toHaveValue("Opening")
  expect(openRowNotes(1)).toHaveValue("remote notes on 1")
})

test("notes editors are keyboard operable: Enter/Space on the toggle expands, and the toggle regains focus after collapse", async () => {
  await renderLoaded()
  const toggle = screen.getByRole("button", { name: "Notes for topic 1" })
  toggle.focus()
  expect(toggle).toHaveFocus()
  fireEvent.click(toggle) // what Enter/Space produce on a native button
  expect(screen.getByLabelText("Topic 1 notes")).toBeInTheDocument()
  expect(toggle).toHaveAttribute("aria-expanded", "true")
  fireEvent.click(toggle)
  expect(screen.queryByLabelText("Topic 1 notes")).not.toBeInTheDocument()
  expect(toggle).toHaveAttribute("aria-expanded", "false")
  expect(toggle).toHaveFocus()
})
