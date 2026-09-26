import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import CaptureSheet from "./CaptureSheet"
import type { InboxItem, LinkPreview } from "../lib/api"

// The Link tab's explicit Preview against a scripted /link-previews/preview and
// /inbox/capture. Nothing is fetched until Preview is pressed; the token is the
// only provider data the client ever sends back.

type Call = { url: string; body: Record<string, unknown> }
let calls: Call[]
let previewResponses: Array<() => Promise<Response>>

const ARTICLE = "http://127.0.0.1:8192/articles/offwhite.html"
const HEADLINE = "Off-white is a decision: paper makers, gallery painters and screen designers on the colour nobody thinks they chose"
const LONG = `${"A very long fictional headline about how a small coastal newsroom rebuilt its entire archive by hand over eleven winters, "}and what the people who did it say they would tell anyone starting the same job today without a budget, a plan or a deadline`

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function preview(url: string, patch: Partial<LinkPreview> = {}): LinkPreview {
  return { kind: "article", source_url: url, resolved_url: url, title: HEADLINE, description: "Pure white is a lab value; off-white is a temperature.", site_name: "Surface Notes", creator: "Tomas Reyes", published_at: "2026-09-22T09:00:00Z", thumbnail: { url: "http://127.0.0.1:8192/thumbs/offwhite.png", width: 1200, height: 630 }, truncated: false, token: `tok-${url}`, expires_at: "2026-09-26T23:00:00Z", mode: "fixture", ...patch }
}

function created(body: Record<string, unknown>): InboxItem {
  const title = String(body.title)
  return {
    id: "new1", revision: 1, text: String(body.label ?? title), duration: 120, notes: "", source_url: String(body.source_url ?? ""), archived: false, created_at: "", updated_at: "",
    topic: { text: title, duration: 120, notes: "" }, source: body.preview ? { kind: "article", feed_id: "", feed_name: "Surface Notes", original_title: HEADLINE, body_text: "", published_at: null, imported_at: "", truncated: false } : null,
    presentation: null, editorial: { revision: 1, saved: true, note: String(body.note ?? ""), updated_at: null },
    capture: { kind: "link", display_title: title, source_text: "", attachments: [], created_at: "" },
  }
}

beforeEach(() => {
  calls = []
  previewResponses = []
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const body = init?.body && typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    calls.push({ url, body })
    if (url === "/link-previews/preview") {
      const next = previewResponses.shift()
      if (!next) throw new Error("unexpected preview call")
      return next()
    }
    if (url === "/inbox/capture") {
      if (body.preview === "tok-expired") return json({ detail: "The preview expired. Preview the link again, or save it without the preview." }, 409)
      return json(created(body), 201)
    }
    throw new Error(`unexpected ${url}`)
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mount() {
  const onCreated = vi.fn()
  render(<CaptureSheet open onClose={() => {}} selectedPlan={null} forDay={false} onCreated={onCreated} />)
  const sheet = screen.getByRole("dialog", { name: "New topic" })
  fireEvent.click(within(sheet).getByRole("button", { name: "Link" }))
  return { sheet, onCreated }
}

test("Preview is explicit: typing a link fetches nothing; Preview fills an empty title, shows the review card and saves the token with the same URL", async () => {
  const { sheet, onCreated } = mount()
  const link = within(sheet).getByLabelText("Source link")
  fireEvent.change(link, { target: { value: ARTICLE } })
  fireEvent.change(within(sheet).getByLabelText("Personal note"), { target: { value: "my angle" } })
  expect(calls.filter((c) => c.url === "/link-previews/preview")).toHaveLength(0)
  previewResponses.push(async () => json(preview(ARTICLE)))
  fireEvent.click(within(sheet).getByRole("button", { name: "Preview" }))
  await waitFor(() => expect(within(sheet).getByTestId("dsc-preview")).toBeTruthy())
  expect(calls.at(-1)).toEqual({ url: "/link-previews/preview", body: { url: ARTICLE } })
  expect(within(sheet).getByTestId("dsc-preview-title").textContent).toBe(HEADLINE)
  expect(within(sheet).getByTestId("dsc-preview").textContent).toContain("Article · Tomas Reyes · fixture")
  const thumb = within(sheet).getByTestId("dsc-preview-thumb") as HTMLImageElement
  expect(thumb.getAttribute("referrerpolicy")).toBe("no-referrer")
  expect((within(sheet).getByLabelText("Topic title") as HTMLInputElement).value).toBe(HEADLINE)
  expect((within(sheet).getByLabelText("Live label") as HTMLInputElement).value.length).toBeLessThanOrEqual(30)
  expect((within(sheet).getByLabelText("Personal note") as HTMLTextAreaElement).value).toBe("my angle")
  fireEvent.click(within(sheet).getByRole("button", { name: "Create with preview" }))
  await waitFor(() => expect(onCreated).toHaveBeenCalled())
  const save = calls.find((c) => c.url === "/inbox/capture")!
  expect(save.body).toEqual({ kind: "link", title: HEADLINE, label: expect.any(String), note: "my angle", source_url: ARTICLE, duration: 120, preview: `tok-${ARTICLE}` })
})

test("a title typed while the preview is in flight is never overwritten; a stale response for an edited link is ignored", async () => {
  const { sheet } = mount()
  const link = within(sheet).getByLabelText("Source link")
  const title = within(sheet).getByLabelText("Topic title") as HTMLInputElement
  fireEvent.change(link, { target: { value: ARTICLE } })
  let release: (() => void) | undefined
  previewResponses.push(() => new Promise<Response>((resolve) => { release = () => resolve(json(preview(ARTICLE))) }))
  fireEvent.click(within(sheet).getByRole("button", { name: "Preview" }))
  expect(within(sheet).getByRole("button", { name: "Fetching preview…" })).toBeTruthy()
  fireEvent.change(title, { target: { value: "Typed while fetching" } })
  release!()
  await waitFor(() => expect(within(sheet).getByTestId("dsc-preview")).toBeTruthy())
  expect(title.value).toBe("Typed while fetching")
  expect(within(sheet).getByTestId("dsc-preview-note").textContent).toContain("Your title was kept")
  // Edit the link: the preview is dropped and the submit label falls back to a plain create.
  fireEvent.change(link, { target: { value: `${ARTICLE}?v=2` } })
  expect(within(sheet).queryByTestId("dsc-preview")).toBeNull()
  expect(within(sheet).getByTestId("dsc-preview-note").textContent).toContain("Link changed")
  expect(within(sheet).getByRole("button", { name: "Create topic" })).toBeTruthy()
  // A response that arrives after the link changed again is ignored.
  let releaseStale: (() => void) | undefined
  previewResponses.push(() => new Promise<Response>((resolve) => { releaseStale = () => resolve(json(preview(`${ARTICLE}?v=2`, { title: "Stale headline" }))) }))
  fireEvent.click(within(sheet).getByRole("button", { name: "Preview" }))
  fireEvent.change(link, { target: { value: `${ARTICLE}?v=3` } })
  releaseStale!()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(within(sheet).queryByTestId("dsc-preview")).toBeNull()
  expect(title.value).toBe("Typed while fetching")
  expect(calls.filter((c) => c.url === "/inbox/capture")).toHaveLength(0)
})

test("a failed preview keeps manual save available and sends no token; a long headline prefills a bounded editable title", async () => {
  const { sheet, onCreated } = mount()
  const link = within(sheet).getByLabelText("Source link")
  fireEvent.change(link, { target: { value: `${ARTICLE}?forbidden` } })
  previewResponses.push(async () => json({ detail: "The site refused the request (HTTP 403). Save the link and add a title manually." }, 502))
  fireEvent.click(within(sheet).getByRole("button", { name: "Preview" }))
  await waitFor(() => expect(within(sheet).getByTestId("dsc-preview-error").textContent).toContain("HTTP 403"))
  fireEvent.change(within(sheet).getByLabelText("Topic title"), { target: { value: "Manual title" } })
  fireEvent.click(within(sheet).getByRole("button", { name: "Create topic" }))
  await waitFor(() => expect(onCreated).toHaveBeenCalled())
  expect(calls.find((c) => c.url === "/inbox/capture")!.body).toEqual({ kind: "link", title: "Manual title", note: "", source_url: `${ARTICLE}?forbidden`, duration: 120 })
  // Long headline: the title field gets at most 200 characters, the card shows the full headline.
  cleanup()
  const again = mount()
  fireEvent.change(within(again.sheet).getByLabelText("Source link"), { target: { value: `${ARTICLE}?long` } })
  previewResponses.push(async () => json(preview(`${ARTICLE}?long`, { title: LONG, thumbnail: null })))
  fireEvent.click(within(again.sheet).getByRole("button", { name: "Preview" }))
  await waitFor(() => expect(within(again.sheet).getByTestId("dsc-preview")).toBeTruthy())
  const value = (within(again.sheet).getByLabelText("Topic title") as HTMLInputElement).value
  expect(value.length).toBeLessThanOrEqual(200)
  expect(LONG.startsWith(value)).toBe(true)
  expect(within(again.sheet).getByTestId("dsc-preview-title").textContent).toBe(LONG)
  expect(within(again.sheet).getByTestId("dsc-preview-note").textContent).toContain("shortened to 200")
  expect(within(again.sheet).queryByTestId("dsc-preview-thumb")).toBeNull()
})

test("a refused token (409) keeps everything typed and the same form saves without the preview", async () => {
  const { sheet, onCreated } = mount()
  fireEvent.change(within(sheet).getByLabelText("Source link"), { target: { value: ARTICLE } })
  previewResponses.push(async () => json(preview(ARTICLE, { token: "tok-expired" })))
  fireEvent.click(within(sheet).getByRole("button", { name: "Preview" }))
  await waitFor(() => expect(within(sheet).getByTestId("dsc-preview")).toBeTruthy())
  fireEvent.change(within(sheet).getByLabelText("Live label"), { target: { value: "Off-white" } })
  fireEvent.change(within(sheet).getByLabelText("Personal note"), { target: { value: "keep me" } })
  fireEvent.click(within(sheet).getByRole("button", { name: "Create with preview" }))
  await waitFor(() => expect(within(sheet).getByRole("alert").textContent).toContain("Preview not saved: The preview expired."))
  expect(onCreated).not.toHaveBeenCalled()
  expect(within(sheet).queryByTestId("dsc-preview")).toBeNull()
  expect((within(sheet).getByLabelText("Personal note") as HTMLTextAreaElement).value).toBe("keep me")
  expect((within(sheet).getByLabelText("Live label") as HTMLInputElement).value).toBe("Off-white")
  fireEvent.click(within(sheet).getByRole("button", { name: "Create topic" }))
  await waitFor(() => expect(onCreated).toHaveBeenCalled())
  const bodies = calls.filter((c) => c.url === "/inbox/capture").map((c) => c.body)
  expect(bodies[0].preview).toBe("tok-expired")
  expect(bodies[1]).toEqual({ kind: "link", title: HEADLINE, label: "Off-white", note: "keep me", source_url: ARTICLE, duration: 120 })
})
