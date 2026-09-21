import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import App from "../App"
import type { ReviewTopic, ReviewVersion, ShowState } from "../lib/api"

// Show review rendered through App so navigation and draft survival are
// exercised the way a user reaches them. The fetch mock is a small in-memory
// server following the frozen /reviews contract: newest-first cursor pages,
// strict full payload, revision guard (409), unknown version/topic (404).
// Selected responses can be held back to reproduce delayed answers.

type Call = { method: string; url: string; body?: unknown }

let live: ShowState
let versions: Map<number, { published_at: string; topics: ReviewTopic[] }>
let calls: Call[]
let feedbackIds: number
let holds: Map<string, Array<() => void>>
let holdPattern: RegExp | null
/** Force the next matching request to fail with this status (then clears). */
let failNext: { pattern: RegExp; status: number; detail: string } | null

function liveState(): ShowState {
  return { revision: 23, topics: [{ id: "a", text: "Review opening 22", duration: 120, notes: "" }], current_topic_id: "a", remaining_seconds: 120, paused: true, server_time: "2026-09-15T15:00:00.000Z" }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function seedVersions(count: number) {
  for (let id = 1; id <= count; id += 1) {
    const base = id * 2 - 1
    versions.set(id, {
      published_at: `2026-09-15T15:06:${String(id).padStart(2, "0")}.000000+00:00`,
      topics: [
        { id: base, text: `Review opening ${id}`, planned_seconds: 120, context: id === count ? "PRIVATE source context" : "", revision: 0, rating: 0, note: "", actual_seconds: null, delta_seconds: null, updated_at: null },
        { id: base + 1, text: "Audience questions", planned_seconds: 60, context: "", revision: 0, rating: 0, note: "", actual_seconds: null, delta_seconds: null, updated_at: null },
      ],
    })
  }
}

function summary(id: number): ReviewVersion {
  const version = versions.get(id)!
  return { id, published_at: version.published_at, topic_count: version.topics.length, planned_seconds: version.topics.reduce((sum, t) => sum + t.planned_seconds, 0), reviewed_count: version.topics.filter((t) => t.revision > 0).length }
}

/** Server-side save, also used to simulate "another screen". */
function saveOnServer(versionId: number, topicId: number, payload: { revision: number; rating: number; note: string; actual_seconds: number | null }): Response {
  const version = versions.get(versionId)
  if (!version) return json({ detail: "Published version not found." }, 404)
  const index = version.topics.findIndex((t) => t.id === topicId)
  if (index < 0) return json({ detail: "Topic not found in this published version." }, 404)
  const keys = Object.keys(payload).sort()
  if (keys.join(",") !== "actual_seconds,note,rating,revision") return json({ detail: "extra fields" }, 422)
  if (!Number.isInteger(payload.revision) || !Number.isInteger(payload.rating) || payload.rating < -1 || payload.rating > 1) return json({ detail: "invalid" }, 422)
  if (payload.actual_seconds !== null && (!Number.isInteger(payload.actual_seconds) || payload.actual_seconds < 0 || payload.actual_seconds > 86400)) return json({ detail: "invalid actual" }, 422)
  const current = version.topics[index]
  if (payload.revision !== current.revision) return json({ detail: "Review changed on another screen. Reload before saving." }, 409)
  feedbackIds += 3 // not +1: the revision is a feedback id
  const next: ReviewTopic = { ...current, revision: feedbackIds, rating: payload.rating as ReviewTopic["rating"], note: payload.note, actual_seconds: payload.actual_seconds, delta_seconds: payload.actual_seconds === null ? null : payload.actual_seconds - current.planned_seconds, updated_at: `2026-09-15T16:00:${String(feedbackIds % 60).padStart(2, "0")}.000000+00:00` }
  version.topics[index] = next
  return json(next)
}

function serve(method: string, url: string, body: unknown): Response {
  const parsed = new URL(url, "http://test.local")
  const path = parsed.pathname
  if (failNext && failNext.pattern.test(`${method} ${path}${parsed.search}`)) {
    const { status, detail } = failNext
    failNext = null
    return json({ detail }, status)
  }
  if (path === "/rundown/state") return json(live)
  if (path === "/reviews" && method === "GET") {
    const limit = Number(parsed.searchParams.get("limit") ?? "20")
    const before = parsed.searchParams.get("before_id")
    const ids = [...versions.keys()].sort((a, b) => b - a).filter((id) => (before === null ? true : id < Number(before)))
    const page = ids.slice(0, limit)
    return json({ versions: page.map(summary), next_before_id: page.length === limit && ids.length > limit ? page[page.length - 1] : null })
  }
  const detail = path.match(/^\/reviews\/(\d+)$/)
  if (detail && method === "GET") {
    const version = versions.get(Number(detail[1]))
    return version ? json({ id: Number(detail[1]), published_at: version.published_at, topics: version.topics }) : json({ detail: "Published version not found." }, 404)
  }
  const save = path.match(/^\/reviews\/(\d+)\/topics\/(\d+)$/)
  if (save && method === "PUT") return saveOnServer(Number(save[1]), Number(save[2]), body as { revision: number; rating: number; note: string; actual_seconds: number | null })
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
  const list = holds.get(key)
  const fn = list?.shift()
  if (!fn) throw new Error(`nothing held for ${key}`)
  fn()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  live = liveState()
  versions = new Map()
  calls = []
  feedbackIds = 100
  holds = new Map()
  holdPattern = null
  failNext = null
  seedVersions(23)
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

function requests(method: string, pathStart: string) {
  return calls.filter((call) => call.method === method && new URL(call.url, "http://test.local").pathname.startsWith(pathStart))
}

function listRequests() {
  return calls.filter((call) => call.method === "GET" && new URL(call.url, "http://test.local").pathname === "/reviews").map((call) => new URL(call.url, "http://test.local").search)
}

async function renderLoaded() {
  render(<App />)
  await flush()
  expect(await screen.findByDisplayValue("Review opening 22")).toBeInTheDocument()
}

function review() {
  const view = document.querySelector("#review")
  if (!view) throw new Error("review view not rendered")
  return view as HTMLElement
}

async function openReview() {
  fireEvent.click(screen.getByRole("button", { name: "Show review" }))
  await flush()
  expect(screen.getByRole("heading", { name: "Show review" })).toBeVisible()
}

async function openVersion(id: number) {
  fireEvent.click(screen.getByRole("button", { name: `Open version ${id}` }))
  await flush()
}

function reviewStatus() {
  const status = review().querySelector(".review-bar .publish-status")
  if (!status) throw new Error("review status line not rendered")
  return status
}

function ratingButton(name: "Good" | "Neutral" | "Bad") {
  return within(review()).getByRole("button", { name })
}

function editorFields() {
  return {
    rating: review().querySelector(".seg-btn[aria-pressed='true']")?.getAttribute("data-rating"),
    note: (screen.getByLabelText("Review note") as HTMLTextAreaElement).value,
    actual: (screen.getByLabelText("Actual seconds") as HTMLInputElement).value,
  }
}

test("list, pagination, open, explicit save with read-back, delta only when recorded, clearing to null, invalid values blocked", async () => {
  await renderLoaded()
  expect(requests("GET", "/reviews")).toHaveLength(0)
  await openReview()
  expect(review()).toHaveTextContent("not a record of a completed stream")
  expect(screen.getAllByRole("button", { name: /^Open version/ })).toHaveLength(20)
  const newest = screen.getByRole("button", { name: "Open version 23" })
  expect(newest).toHaveTextContent("Version 23 · 2 topics · 3:00 planned")
  expect(newest).toHaveTextContent("Nothing reviewed yet")
  expect(newest).toHaveTextContent(/2026/)
  fireEvent.click(screen.getByRole("button", { name: "Load older versions" }))
  await flush()
  expect(listRequests()).toEqual(["?limit=20", "?limit=20&before_id=4"])
  expect(screen.getAllByRole("button", { name: /^Open version/ })).toHaveLength(23)
  expect(screen.queryByRole("button", { name: "Load older versions" })).not.toBeInTheDocument()
  expect(review()).toHaveTextContent("That is the oldest published version.")

  await openVersion(23)
  expect(screen.getByTestId("review-title")).toHaveTextContent("Review opening 23")
  expect(screen.getByTestId("review-planned")).toHaveTextContent("2:00 (120 s)")
  expect(screen.getByTestId("review-context")).toHaveTextContent("PRIVATE source context")
  expect(review().querySelectorAll(".review-facts input, .review-facts textarea")).toHaveLength(0)
  expect(screen.getByTestId("review-delta")).toHaveTextContent("Not recorded")
  expect(ratingButton("Neutral")).toHaveAttribute("aria-pressed", "true")
  expect(screen.getByRole("button", { name: "Save review" })).toBeDisabled()

  // Typing never saves.
  fireEvent.click(ratingButton("Good"))
  fireEvent.change(screen.getByLabelText("Review note"), { target: { value: "Landed well" } })
  fireEvent.change(screen.getByLabelText("Actual seconds"), { target: { value: "100" } })
  await flush()
  expect(requests("PUT", "/reviews")).toHaveLength(0)
  expect(screen.getByTestId("review-delta")).toHaveTextContent("−20 s under plan")
  expect(reviewStatus()).toHaveTextContent("Unsaved review.")
  fireEvent.click(screen.getByRole("button", { name: "Save review" }))
  await flush()
  const [put] = requests("PUT", "/reviews")
  expect(put?.url).toMatch(/\/reviews\/23\/topics\/45$/)
  expect(put?.body).toEqual({ revision: 0, rating: 1, note: "Landed well", actual_seconds: 100 })
  expect(reviewStatus()).toHaveTextContent('Saved the review of "Review opening 23". The live show is untouched.')
  expect(screen.getByRole("button", { name: "Save review" })).toBeDisabled()
  expect(screen.getByTestId("review-saved")).toHaveTextContent(/^Reviewed /)
  // Counts refreshed from the server; the editor still shows what was saved.
  expect(screen.getByRole("button", { name: "Open version 23" })).toHaveTextContent("1 of 2 reviewed")
  expect(within(review()).getByRole("button", { name: "Review Review opening 23" })).toHaveTextContent("100 s actual · Good")
  expect(editorFields()).toEqual({ rating: "1", note: "Landed well", actual: "100" })
  expect(listRequests().at(-1)).toBe("?limit=20")

  fireEvent.change(screen.getByLabelText("Actual seconds"), { target: { value: "120" } })
  fireEvent.click(screen.getByRole("button", { name: "Save review" }))
  await flush()
  expect(screen.getByTestId("review-delta")).toHaveTextContent("On plan (0 s)")
  fireEvent.change(screen.getByLabelText("Actual seconds"), { target: { value: "150" } })
  fireEvent.click(screen.getByRole("button", { name: "Save review" }))
  await flush()
  expect(screen.getByTestId("review-delta")).toHaveTextContent("+30 s over plan")
  fireEvent.change(screen.getByLabelText("Actual seconds"), { target: { value: "" } })
  expect(screen.getByRole("button", { name: "Save review" })).toBeEnabled()
  fireEvent.click(screen.getByRole("button", { name: "Save review" }))
  await flush()
  expect(requests("PUT", "/reviews").at(-1)?.body).toEqual({ revision: 109, rating: 1, note: "Landed well", actual_seconds: null })
  expect(screen.getByTestId("review-delta")).toHaveTextContent("Not recorded")
  expect(versions.get(23)?.topics[0]).toMatchObject({ actual_seconds: null, delta_seconds: null, rating: 1 })
  fireEvent.change(screen.getByLabelText("Actual seconds"), { target: { value: "0" } })
  fireEvent.click(screen.getByRole("button", { name: "Save review" }))
  await flush()
  expect(requests("PUT", "/reviews").at(-1)?.body).toMatchObject({ actual_seconds: 0 })
  expect(screen.getByTestId("review-delta")).toHaveTextContent("−120 s under plan")

  const puts = requests("PUT", "/reviews").length
  // (A number input sanitises letters to "" in jsdom and browsers alike, so only numeric junk can reach the draft.)
  for (const bad of ["90.5", "-1", "86401", "1e3"]) {
    fireEvent.change(screen.getByLabelText("Actual seconds"), { target: { value: bad } })
    expect(screen.getByLabelText("Actual seconds")).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByRole("button", { name: "Save review" })).toBeDisabled()
    expect(reviewStatus()).toHaveTextContent("Actual seconds must be a whole number from 0 to 86400")
    fireEvent.submit(screen.getByRole("form", { name: "Review of Review opening 23" }))
  }
  fireEvent.change(screen.getByLabelText("Actual seconds"), { target: { value: "5" } })
  fireEvent.change(screen.getByLabelText("Review note"), { target: { value: "x".repeat(4001) } })
  expect(screen.getByRole("button", { name: "Save review" })).toBeDisabled()
  expect(reviewStatus()).toHaveTextContent("Review note is limited to 4000 characters.")
  fireEvent.submit(screen.getByRole("form", { name: "Review of Review opening 23" }))
  await flush()
  expect(requests("PUT", "/reviews")).toHaveLength(puts)
  expect(document.body.textContent).not.toMatch(/revision/i)
})

test("a dirty review survives main navigation; switching version, topic or refreshing is guarded; discarding drops it without a request", async () => {
  await renderLoaded()
  await openReview()
  await openVersion(21)
  fireEvent.click(ratingButton("Bad"))
  fireEvent.change(screen.getByLabelText("Review note"), { target: { value: "draft note" } })
  fireEvent.change(screen.getByLabelText("Actual seconds"), { target: { value: "90" } })
  const want = { rating: "-1", note: "draft note", actual: "90" }

  fireEvent.click(screen.getByRole("button", { name: "Tonight's Show" }))
  await flush()
  expect(review()).not.toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Saved Shows" }))
  await flush()
  await openReview()
  expect(editorFields()).toEqual(want)
  expect(reviewStatus()).toHaveTextContent("Unsaved review.")

  const before = calls.length
  await openVersion(20)
  let dialog = screen.getByRole("dialog")
  expect(dialog).toHaveTextContent('The review of "Review opening 21" has unsaved changes. Opening version 20 will discard them.')
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }))
  await flush()
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Open version 21" })).toHaveAttribute("aria-current", "true")
  expect(editorFields()).toEqual(want)

  fireEvent.click(within(review()).getByRole("button", { name: "Review Audience questions" }))
  await flush()
  dialog = screen.getByRole("dialog")
  expect(dialog).toHaveTextContent("Opening another topic will discard them.")
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }))
  await flush()
  expect(screen.getByTestId("review-title")).toHaveTextContent("Review opening 21")
  expect(editorFields()).toEqual(want)

  fireEvent.click(within(review()).getByRole("button", { name: "Refresh" }))
  await flush()
  dialog = screen.getByRole("dialog")
  expect(dialog).toHaveTextContent("Refreshing will discard them.")
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }))
  await flush()
  expect(editorFields()).toEqual(want)
  expect(calls.length).toBe(before)

  // Discard through the guard: the other topic opens clean, nothing was sent.
  fireEvent.click(within(review()).getByRole("button", { name: "Review Audience questions" }))
  await flush()
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard changes" }))
  await flush()
  expect(screen.getByTestId("review-title")).toHaveTextContent("Audience questions")
  expect(editorFields()).toEqual({ rating: "0", note: "", actual: "" })
  expect(requests("PUT", "/reviews")).toHaveLength(0)
  // Back on the first topic the draft is gone too (it was discarded, not parked).
  fireEvent.click(within(review()).getByRole("button", { name: "Review Review opening 21" }))
  await flush()
  expect(editorFields()).toEqual({ rating: "0", note: "", actual: "" })

  // Discard edits button restores the saved values in place.
  fireEvent.change(screen.getByLabelText("Review note"), { target: { value: "temp" } })
  fireEvent.click(screen.getByRole("button", { name: "Discard edits" }))
  expect(editorFields()).toEqual({ rating: "0", note: "", actual: "" })
  expect(reviewStatus()).toHaveTextContent("Your changes were discarded.")

  // A clean Refresh reloads without a dialog and keeps the open topic.
  fireEvent.click(within(review()).getByRole("button", { name: "Review Audience questions" }))
  await flush()
  fireEvent.click(within(review()).getByRole("button", { name: "Refresh" }))
  await flush()
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  expect(screen.getByTestId("review-title")).toHaveTextContent("Audience questions")
  expect(listRequests().at(-1)).toBe("?limit=20")
})

test("a stale save (409) keeps every field and offers reload or keeping my values; a failed recovery leaves the controls usable", async () => {
  await renderLoaded()
  await openReview()
  await openVersion(21)
  fireEvent.click(ratingButton("Bad"))
  fireEvent.change(screen.getByLabelText("Review note"), { target: { value: "draft note" } })
  fireEvent.change(screen.getByLabelText("Actual seconds"), { target: { value: "90" } })
  const want = { rating: "-1", note: "draft note", actual: "90" }
  // Another screen saves first.
  saveOnServer(21, 41, { revision: 0, rating: 1, note: "other screen", actual_seconds: 200 })
  fireEvent.click(screen.getByRole("button", { name: "Save review" }))
  await flush()
  const alert = within(review()).getByRole("alert")
  expect(alert).toHaveTextContent("Not saved. This review was saved on another screen since you opened it.")
  expect(editorFields()).toEqual(want)
  expect(screen.getByRole("button", { name: "Save review" })).toBeDisabled()

  failNext = { pattern: /^GET \/reviews\/21$/, status: 503, detail: "Fixture outage" }
  fireEvent.click(screen.getByRole("button", { name: "Use my changes on latest revision" }))
  await flush()
  expect(reviewStatus()).toHaveTextContent("Loading the latest review rejected (503): Fixture outage Your changes are kept; try again.")
  expect(within(review()).getByRole("alert")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Use my changes on latest revision" })).toBeEnabled()
  expect(screen.getByRole("button", { name: "Reload saved review" })).toBeEnabled()
  expect(editorFields()).toEqual(want)

  fireEvent.click(screen.getByRole("button", { name: "Use my changes on latest revision" }))
  await flush()
  expect(within(review()).queryByRole("alert")).not.toBeInTheDocument()
  expect(reviewStatus()).toHaveTextContent("Kept your values on top of the latest saved review. Press Save review to overwrite it.")
  expect(editorFields()).toEqual(want)
  expect(screen.getByRole("button", { name: "Save review" })).toBeEnabled()
  fireEvent.click(screen.getByRole("button", { name: "Save review" }))
  await flush()
  const puts = requests("PUT", "/reviews")
  expect(puts).toHaveLength(2)
  expect(puts[0]?.body).toMatchObject({ revision: 0 })
  expect(puts[1]?.body).toEqual({ revision: 103, rating: -1, note: "draft note", actual_seconds: 90 })
  expect(versions.get(21)?.topics[0]).toMatchObject({ rating: -1, note: "draft note", actual_seconds: 90, revision: 106 })
  expect(reviewStatus()).toHaveTextContent("Saved the review")

  // Reload path takes the other screen's values and clears the conflict.
  fireEvent.change(screen.getByLabelText("Actual seconds"), { target: { value: "95" } })
  saveOnServer(21, 41, { revision: 106, rating: 0, note: "second external", actual_seconds: 300 })
  fireEvent.click(screen.getByRole("button", { name: "Save review" }))
  await flush()
  expect(within(review()).getByRole("alert")).toBeInTheDocument()
  expect(editorFields()).toEqual({ rating: "-1", note: "draft note", actual: "95" })
  fireEvent.click(screen.getByRole("button", { name: "Reload saved review" }))
  await flush()
  expect(editorFields()).toEqual({ rating: "0", note: "second external", actual: "300" })
  expect(within(review()).queryByRole("alert")).not.toBeInTheDocument()
  expect(reviewStatus()).toHaveTextContent("Reloaded the saved review. Your changes were discarded.")
  expect(screen.getByRole("button", { name: "Save review" })).toBeDisabled()

  // Nothing-to-save case: my values already match the latest.
  fireEvent.change(screen.getByLabelText("Actual seconds"), { target: { value: "310" } })
  saveOnServer(21, 41, { revision: 109, rating: 0, note: "second external", actual_seconds: 310 })
  fireEvent.click(screen.getByRole("button", { name: "Save review" }))
  await flush()
  fireEvent.click(screen.getByRole("button", { name: "Use my changes on latest revision" }))
  await flush()
  expect(reviewStatus()).toHaveTextContent("Nothing left to save: the latest saved review already matches your values.")
  expect(screen.getByRole("button", { name: "Save review" })).toBeDisabled()
})

test("a delayed version response never replaces a newer selection, and a delayed older page never lands on a reset list", async () => {
  await renderLoaded()
  await openReview()
  holdPattern = /^GET .*\/reviews\/22$/
  await openVersion(22)
  expect(review()).toHaveTextContent("Opening version 22…")
  // The list is not locked by a read: pick another version while 22 is still loading.
  await openVersion(21)
  expect(screen.getByTestId("review-title")).toHaveTextContent("Review opening 21")
  fireEvent.change(screen.getByLabelText("Review note"), { target: { value: "typed on 21" } })
  release(`GET /reviews/22`)
  await flush()
  expect(screen.getByTestId("review-title")).toHaveTextContent("Review opening 21")
  expect(editorFields().note).toBe("typed on 21")
  expect(screen.getByRole("button", { name: "Open version 21" })).toHaveAttribute("aria-current", "true")
  expect(screen.getByRole("button", { name: "Open version 22" })).not.toHaveAttribute("aria-current")

  // Older page held while a save completes: the save's list refresh resets the
  // list, so the late older page must be dropped (Refresh itself is disabled
  // while the older page loads, but a save is not).
  holdPattern = /^GET .*\/reviews\?limit=20&before_id=4$/
  fireEvent.click(screen.getByRole("button", { name: "Load older versions" }))
  await flush()
  expect(screen.getByRole("button", { name: "Loading older…" })).toBeDisabled()
  expect(within(review()).getByRole("button", { name: "Refresh" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Save review" }))
  await flush()
  expect(reviewStatus()).toHaveTextContent("Saved the review")
  expect(listRequests().at(-1)).toBe("?limit=20")
  expect(screen.getAllByRole("button", { name: /^Open version/ })).toHaveLength(20)
  release("GET /reviews?limit=20&before_id=4")
  await flush()
  expect(screen.getAllByRole("button", { name: /^Open version/ })).toHaveLength(20)
  expect(screen.getByRole("button", { name: "Load older versions" })).toBeEnabled()
  expect(editorFields().note).toBe("typed on 21")
})

test("controls are disabled while a save is pending; a delayed save answer is applied only to the draft it came from", async () => {
  await renderLoaded()
  await openReview()
  await openVersion(21)
  fireEvent.change(screen.getByLabelText("Actual seconds"), { target: { value: "70" } })
  holdPattern = /^PUT /
  fireEvent.click(screen.getByRole("button", { name: "Save review" }))
  await flush()
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled()
  expect(screen.getByLabelText("Actual seconds")).toBeDisabled()
  expect(screen.getByLabelText("Review note")).toBeDisabled()
  expect(ratingButton("Good")).toBeDisabled()
  expect(screen.getByRole("button", { name: "Open version 20" })).toBeDisabled()
  expect(within(review()).getByRole("button", { name: "Review Audience questions" })).toBeDisabled()
  expect(within(review()).getByRole("button", { name: "Refresh" })).toBeDisabled()
  expect(reviewStatus()).toHaveTextContent("Saving the review…")
  release("PUT /reviews/21/topics/41")
  await flush()
  expect(reviewStatus()).toHaveTextContent("Saved the review")
  expect(screen.getByLabelText("Actual seconds")).toBeEnabled()
  expect(editorFields()).toEqual({ rating: "0", note: "", actual: "70" })
  expect(screen.getByRole("button", { name: "Open version 21" })).toHaveTextContent("1 of 2 reviewed")
})

test("list errors are shown with Retry that repeats exactly the failed request; empty and 404 states are explained", async () => {
  await renderLoaded()
  await openReview()
  expect(screen.getAllByRole("button", { name: /^Open version/ })).toHaveLength(20)
  // A failed Refresh must retry the newest page, never the older page (the cursor is 4 here).
  failNext = { pattern: /^GET \/reviews\?limit=20$/, status: 503, detail: "Fixture outage" }
  fireEvent.click(within(review()).getByRole("button", { name: "Refresh" }))
  await flush()
  expect(within(review()).getByRole("alert")).toHaveTextContent("Loading the published versions rejected (503): Fixture outage")
  expect(screen.getAllByRole("button", { name: /^Open version/ })).toHaveLength(20)
  fireEvent.click(within(review()).getByRole("button", { name: "Retry" }))
  await flush()
  expect(listRequests().slice(-2)).toEqual(["?limit=20", "?limit=20"])
  expect(within(review()).queryByRole("alert")).not.toBeInTheDocument()
  // A failed older page retries that page with the same cursor.
  failNext = { pattern: /^GET \/reviews\?limit=20&before_id=4$/, status: 503, detail: "Older outage" }
  fireEvent.click(screen.getByRole("button", { name: "Load older versions" }))
  await flush()
  expect(within(review()).getByRole("alert")).toHaveTextContent("Loading older versions rejected (503): Older outage")
  fireEvent.click(within(review()).getByRole("button", { name: "Retry" }))
  await flush()
  expect(listRequests().slice(-2)).toEqual(["?limit=20&before_id=4", "?limit=20&before_id=4"])
  expect(screen.getAllByRole("button", { name: /^Open version/ })).toHaveLength(23)

  // A version that vanished explains itself and can be retried.
  versions.delete(3)
  await openVersion(3)
  expect(within(review()).getByRole("alert")).toHaveTextContent("This published version no longer exists.")
  seedVersions(3)
  fireEvent.click(within(review()).getByRole("button", { name: "Retry" }))
  await flush()
  expect(screen.getByTestId("review-title")).toHaveTextContent("Review opening 3")

  // Empty list.
  versions.clear()
  fireEvent.click(within(review()).getByRole("button", { name: "Refresh" }))
  await flush()
  expect(review()).toHaveTextContent("No published versions yet.")
})
