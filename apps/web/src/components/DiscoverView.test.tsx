import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import App from "../App"
import DiscoverView from "./DiscoverView"
import type { InboxEditorial, InboxItem, InboxPresentation, InboxSource, ShowState } from "../lib/api"

// The Discover surface against a small in-memory /inbox server: the list,
// one item, and the editorial endpoint with its revision guard (409 keeps
// the stored note). Nothing else is ever written by this view.

type Call = { method: string; url: string; body?: unknown }

let inbox: Map<string, InboxItem>
let calls: Call[]
let holdList: boolean
let heldLists: Array<() => void>
let scrolls: ReturnType<typeof vi.fn>

const YT_THUMB = "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"
const YT_TITLE = "Why the long take came back: a full original headline well over thirty characters"

function source(kind: InboxSource["kind"], original_title: string, body_text: string): InboxSource {
  return { kind, feed_id: "src", feed_name: kind === "rss" ? "Studio Journal" : "AI search", original_title, body_text, published_at: "2026-09-20T10:00:00Z", imported_at: "2026-09-25T00:00:00Z", truncated: false }
}

function presentation(patch: Partial<InboxPresentation>): InboxPresentation {
  return { provider: "youtube", creator: "", excerpt: "", thumbnail: null, media_seconds: null, state: "partial", reason: null, fetched_at: "2026-09-25T00:00:00Z", ...patch }
}

function seed(id: string, text: string, patch: Partial<InboxItem> = {}): InboxItem {
  const entry: InboxItem = {
    id, revision: 1, text, duration: 120, notes: `Imported context for ${text}`, source_url: `https://example.com/${id}`, archived: false,
    created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z", topic: { text, duration: 120, notes: "" }, source: null,
    presentation: null, editorial: { revision: 0, saved: false, note: "", updated_at: null }, ...patch,
  }
  inbox.set(id, entry)
  return entry
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function serve(method: string, url: string, body: unknown): Response {
  const path = new URL(url, "http://test.local").pathname
  if (path === "/rundown/state") {
    const live: ShowState = { revision: 3, topics: [{ id: "a", text: "Opening", duration: 120, notes: "" }], current_topic_id: "a", remaining_seconds: 100, paused: false, server_time: "2026-09-14T00:00:00.000Z" }
    return json(live)
  }
  if (path === "/inbox" && method === "GET") return json({ items: Array.from(inbox.values()) })
  const one = /^\/inbox\/([^/]+)$/.exec(path)
  if (one && method === "GET") {
    const item = inbox.get(one[1])
    return item ? json(item) : json({ detail: "Inbox topic not found." }, 404)
  }
  const editorial = /^\/inbox\/([^/]+)\/editorial$/.exec(path)
  if (editorial && method === "PUT") {
    const item = inbox.get(editorial[1])
    if (!item) return json({ detail: "Inbox topic not found." }, 404)
    const payload = body as { revision: number; saved: boolean; note: string }
    const current = item.editorial as InboxEditorial
    if (payload.revision !== current.revision) return json({ detail: "Your note changed on another screen. Your text is kept; reload before retrying." }, 409)
    const next = { ...item, editorial: { revision: current.revision + 1, saved: payload.saved, note: payload.note, updated_at: "2026-09-25T01:00:00Z" } }
    inbox.set(item.id, next)
    return json(next)
  }
  return json({ detail: "Not Found" }, 404)
}

/** Another screen writes the note directly on the server. */
function otherScreenWrites(id: string, note: string, saved = false) {
  const item = inbox.get(id)!
  const current = item.editorial as InboxEditorial
  inbox.set(id, { ...item, editorial: { revision: current.revision + 1, saved, note, updated_at: "2026-09-25T02:00:00Z" } })
}

beforeEach(() => {
  inbox = new Map()
  calls = []
  holdList = false
  heldLists = []
  scrolls = vi.fn()
  Element.prototype.scrollIntoView = scrolls as unknown as typeof Element.prototype.scrollIntoView
  seed("yt", "Why the long take came ba", {
    source: source("youtube", YT_TITLE, "Video description only; transcript and video have not been retrieved.\nChannel/community: Frame & Field\n\nDirectors used to hide cuts inside whip pans."),
    presentation: presentation({ creator: "Frame & Field", excerpt: "Directors used to hide cuts inside whip pans.", thumbnail: { url: YT_THUMB, width: 480, height: 360 }, state: "ready" }),
  })
  seed("art", "Off-white is a decision", {
    source: source("rss", "Off-white is a decision", "Pure white is a lab value; off-white is a temperature."),
    presentation: presentation({ provider: "rss", creator: "Surface Notes", excerpt: "Pure white is a lab value; off-white is a temperature.", reason: "The source offered no usable image." }),
  })
  seed("idea", "My own idea", { source_url: "" })
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
    calls.push({ method, url, body })
    const response = serve(method, url, body)
    if (holdList && method === "GET" && new URL(url, "http://test.local").pathname === "/inbox") {
      return new Promise<Response>((resolve) => heldLists.push(() => resolve(response)))
    }
    return response
  }) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
})

async function renderDiscover() {
  const onOpenSources = vi.fn()
  render(<DiscoverView hidden={false} onOpenSources={onOpenSources} onOpenShow={vi.fn()} />)
  await screen.findByRole("heading", { name: YT_TITLE })
  return onOpenSources
}

function puts() {
  return calls.filter((call) => call.method === "PUT")
}

function card(title: string) {
  return screen.getByRole("article", { name: title })
}

test("imported topics render as cards: full headline, creator, served thumbnail, artwork when none", async () => {
  await renderDiscover()
  const yt = card(YT_TITLE)
  expect(within(yt).getByText("Frame & Field")).toBeInTheDocument()
  expect(within(yt).getByText("YouTube")).toBeInTheDocument()
  expect(within(yt).getByText("Directors used to hide cuts inside whip pans.")).toBeInTheDocument()
  const img = within(yt).getByTestId("dsc-thumb") as HTMLImageElement
  expect(img.getAttribute("src")).toBe(YT_THUMB)
  expect(img.getAttribute("loading")).toBe("lazy")
  expect(img.getAttribute("referrerpolicy")).toBe("no-referrer")
  expect(within(yt).getByRole("link", { name: /Open original/ })).toHaveAttribute("href", "https://example.com/yt")
  expect(within(yt).getByRole("link", { name: /Open original/ })).toHaveAttribute("rel", "noopener noreferrer")

  const art = card("Off-white is a decision")
  expect(within(art).queryByTestId("dsc-thumb")).toBeNull()
  expect(within(art).getByTestId("dsc-art-generated")).toBeInTheDocument()
  expect(within(art).getByText("Surface Notes")).toBeInTheDocument()
  expect(within(art).getByText("Article")).toBeInTheDocument()

  const idea = card("My own idea")
  // Kicker label plus the artwork caption.
  expect(within(idea).getAllByText("Your idea")).toHaveLength(2)
  expect(within(idea).queryByRole("link", { name: /Open original/ })).toBeNull()
  expect(within(idea).getByTestId("dsc-art-generated")).toBeInTheDocument()
  // "Read more" reveals the retained text as plain text, never as HTML.
  fireEvent.click(within(yt).getByRole("button", { name: "Read more" }))
  expect(within(yt).getByTestId("dsc-full").textContent).toContain("Channel/community: Frame & Field")
})

test("a thumbnail that fails to load falls back to artwork once and keeps the card", async () => {
  await renderDiscover()
  const yt = card(YT_TITLE)
  fireEvent.error(within(yt).getByTestId("dsc-thumb"))
  expect(within(yt).queryByTestId("dsc-thumb")).toBeNull()
  expect(within(yt).getByTestId("dsc-art-generated")).toBeInTheDocument()
  expect(within(yt).getByRole("heading", { name: YT_TITLE })).toBeInTheDocument()
  expect(within(yt).getByRole("figure")).toHaveAttribute("data-state", "artwork")
})

test("bookmarking sends the complete editorial state and the Saved filter follows it", async () => {
  await renderDiscover()
  const yt = card(YT_TITLE)
  await act(async () => {
    fireEvent.click(within(yt).getByRole("button", { name: `Bookmark: ${YT_TITLE}` }))
  })
  expect(puts()).toEqual([{ method: "PUT", url: "/inbox/yt/editorial", body: { revision: 0, saved: true, note: "" } }])
  expect(within(yt).getByRole("button", { name: `Remove bookmark: ${YT_TITLE}` })).toHaveAttribute("aria-pressed", "true")
  fireEvent.click(screen.getByRole("button", { name: "Saved · 1" }))
  expect(screen.getByRole("heading", { name: YT_TITLE })).toBeInTheDocument()
  expect(screen.queryByRole("heading", { name: "Off-white is a decision" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Articles" }))
  expect(screen.getByText("No saved topics match this filter.")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Saved · 1" }))
  expect(screen.getByRole("heading", { name: "Off-white is a decision" })).toBeInTheDocument()
  // Nothing but the editorial endpoint was written.
  expect(calls.filter((c) => c.method !== "GET").every((c) => c.url.endsWith("/editorial"))).toBe(true)
})

test("a note draft survives mode switch, filter and refresh; explicit save persists it; arrows never move cards", async () => {
  await renderDiscover()
  const yt = card(YT_TITLE)
  fireEvent.click(within(yt).getByRole("button", { name: `Note: ${YT_TITLE}` }))
  const box = within(yt).getByRole("textbox", { name: `Your note for ${YT_TITLE}` })
  fireEvent.change(box, { target: { value: "Ask about the long take" } })
  expect(within(yt).getByRole("status")).toHaveTextContent("Unsaved")
  fireEvent.keyDown(box, { key: "ArrowDown" })
  fireEvent.keyDown(box, { key: "j" })
  expect(scrolls).not.toHaveBeenCalled()
  // Card navigation still works from outside the note.
  fireEvent.keyDown(yt, { key: "ArrowDown" })
  expect(scrolls).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getByRole("tab", { name: "Explore" }))
  expect(screen.getByRole("textbox", { name: `Your note for ${YT_TITLE}` })).toHaveValue("Ask about the long take")
  fireEvent.click(screen.getByRole("button", { name: "YouTube" }))
  fireEvent.click(screen.getByRole("button", { name: "All" }))
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Refresh topics" }))
  })
  expect(screen.getByRole("textbox", { name: `Your note for ${YT_TITLE}` })).toHaveValue("Ask about the long take")
  expect(screen.getByText(/1 unsaved note/)).toBeInTheDocument()
  expect(puts()).toEqual([])

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save note" }))
  })
  expect(puts()).toEqual([{ method: "PUT", url: "/inbox/yt/editorial", body: { revision: 0, saved: false, note: "Ask about the long take" } }])
  expect(screen.getByRole("status")).toHaveTextContent("Saved")
  expect(screen.queryByText(/unsaved note/)).toBeNull()
  expect(inbox.get("yt")!.editorial).toMatchObject({ revision: 1, note: "Ask about the long take", saved: false })
  // Imported context and source text were never touched.
  expect(inbox.get("yt")!.notes).toBe("Imported context for Why the long take came ba")
  expect(inbox.get("yt")!.source!.body_text).toContain("Directors used to hide cuts")
})

test("a stale note save is refused with 409; the draft is kept and can be resubmitted against the newer revision", async () => {
  await renderDiscover()
  const yt = card(YT_TITLE)
  fireEvent.click(within(yt).getByRole("button", { name: `Note: ${YT_TITLE}` }))
  fireEvent.change(within(yt).getByRole("textbox", { name: `Your note for ${YT_TITLE}` }), { target: { value: "mine" } })
  otherScreenWrites("yt", "theirs")
  await act(async () => {
    fireEvent.click(within(yt).getByRole("button", { name: "Save note" }))
  })
  expect(puts().at(-1)!.body).toEqual({ revision: 0, saved: false, note: "mine" })
  expect(within(yt).getByRole("alert")).toHaveTextContent("changed on another screen")
  expect(within(yt).getByRole("alert")).toHaveTextContent("theirs")
  expect(within(yt).getByRole("textbox", { name: `Your note for ${YT_TITLE}` })).toHaveValue("mine")
  expect(inbox.get("yt")!.editorial!.note).toBe("theirs")
  await act(async () => {
    fireEvent.click(within(yt).getByRole("button", { name: "Keep mine and save again" }))
  })
  expect(puts().at(-1)!.body).toEqual({ revision: 1, saved: false, note: "mine" })
  expect(within(yt).queryByRole("alert")).toBeNull()
  expect(within(yt).getByRole("status")).toHaveTextContent("Saved")
  expect(inbox.get("yt")!.editorial).toMatchObject({ revision: 2, note: "mine" })
})

test("a refresh that reveals another screen's newer note flags the conflict instead of letting the old draft overwrite it", async () => {
  await renderDiscover()
  const yt = card(YT_TITLE)
  fireEvent.click(within(yt).getByRole("button", { name: `Note: ${YT_TITLE}` }))
  fireEvent.change(within(yt).getByRole("textbox", { name: `Your note for ${YT_TITLE}` }), { target: { value: "mine" } })
  otherScreenWrites("yt", "theirs", true)
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Refresh topics" }))
  })
  // The refreshed bookmark shows, the draft stays, and the conflict is visible before any save.
  expect(within(yt).getByRole("button", { name: `Remove bookmark: ${YT_TITLE}` })).toBeDisabled()
  expect(within(yt).getByRole("textbox", { name: `Your note for ${YT_TITLE}` })).toHaveValue("mine")
  expect(within(yt).getByRole("alert")).toHaveTextContent("theirs")
  expect(within(yt).getByRole("button", { name: "Save note" })).toBeDisabled()
  expect(puts()).toEqual([])
  fireEvent.click(within(yt).getByRole("button", { name: "Use theirs" }))
  expect(within(yt).getByRole("textbox", { name: `Your note for ${YT_TITLE}` })).toHaveValue("theirs")
  expect(within(yt).queryByRole("alert")).toBeNull()
  fireEvent.change(within(yt).getByRole("textbox", { name: `Your note for ${YT_TITLE}` }), { target: { value: "theirs, plus mine" } })
  await act(async () => {
    fireEvent.click(within(yt).getByRole("button", { name: "Save note" }))
  })
  expect(puts()).toEqual([{ method: "PUT", url: "/inbox/yt/editorial", body: { revision: 1, saved: true, note: "theirs, plus mine" } }])
  expect(inbox.get("yt")!.editorial).toMatchObject({ revision: 2, saved: true, note: "theirs, plus mine" })
})

test("a list response requested before a save cannot roll the saved state back", async () => {
  await renderDiscover()
  holdList = true
  fireEvent.click(screen.getByRole("button", { name: "Refresh topics" }))
  expect(heldLists).toHaveLength(1)
  const yt = card(YT_TITLE)
  await act(async () => {
    fireEvent.click(within(yt).getByRole("button", { name: `Bookmark: ${YT_TITLE}` }))
  })
  expect(within(yt).getByRole("button", { name: `Remove bookmark: ${YT_TITLE}` })).toBeInTheDocument()
  await act(async () => {
    heldLists.forEach((release) => release())
  })
  expect(within(yt).getByRole("button", { name: `Remove bookmark: ${YT_TITLE}` })).toHaveAttribute("aria-pressed", "true")
  expect(screen.getByRole("button", { name: "Refresh topics" })).toBeEnabled()
})

test("a rejected save keeps the text and explains; Import hands over to Sources", async () => {
  const onOpenSources = await renderDiscover()
  globalThis.fetch = vi.fn(async () => json({ detail: "Notes must be at most 10000 characters." }, 422)) as unknown as typeof fetch
  const yt = card(YT_TITLE)
  fireEvent.click(within(yt).getByRole("button", { name: `Note: ${YT_TITLE}` }))
  fireEvent.change(within(yt).getByRole("textbox", { name: `Your note for ${YT_TITLE}` }), { target: { value: "keep me" } })
  await act(async () => {
    fireEvent.click(within(yt).getByRole("button", { name: "Save note" }))
  })
  expect(within(yt).getByRole("status")).toHaveTextContent("rejected (422)")
  expect(within(yt).getByRole("textbox", { name: `Your note for ${YT_TITLE}` })).toHaveValue("keep me")
  fireEvent.click(screen.getByRole("button", { name: "Import…" }))
  expect(onOpenSources).toHaveBeenCalledTimes(1)
})

test("Discover is in the sidebar, the live show stays the starting view, and the note survives the round trip", async () => {
  render(<App />)
  expect(await screen.findByDisplayValue("Opening")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Tonight's Show" })).toHaveAttribute("aria-current", "page")
  const nav = screen.getByRole("navigation", { name: "Sections" })
  expect(within(nav).getAllByRole("button").map((button) => button.textContent?.trim())[0]).toContain("Discover")
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Discover" }))
  })
  expect(await screen.findByRole("heading", { name: YT_TITLE })).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Discover" })).toHaveAttribute("aria-current", "page")
  const yt = card(YT_TITLE)
  fireEvent.click(within(yt).getByRole("button", { name: `Note: ${YT_TITLE}` }))
  fireEvent.change(within(yt).getByRole("textbox", { name: `Your note for ${YT_TITLE}` }), { target: { value: "draft across views" } })
  fireEvent.click(screen.getByRole("button", { name: "Tonight's Show" }))
  expect(screen.getByRole("heading", { name: "Tonight's Rundown" })).toBeInTheDocument()
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Discover" }))
  })
  expect(screen.getByRole("textbox", { name: `Your note for ${YT_TITLE}` })).toHaveValue("draft across views")
})
