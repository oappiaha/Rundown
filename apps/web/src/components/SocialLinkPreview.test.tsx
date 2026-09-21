import { act, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { SocialLinkPreview as Preview } from "../lib/api"
import SocialLinkPreview from "./SocialLinkPreview"

// The panel rendered inside a tiny stand-in for the idea editor: it owns the
// title, context and source URL the way InboxView does and hands edits back
// through the same callbacks. The fetch mock follows the frozen
// /social-links/preview contract (422 unsupported, 502 provider, 429 busy).

type Call = { url: string; body: unknown }
let calls: Call[]
let answer: (url: string) => Promise<Response>

const X_URL = "https://x.com/fixture/status/123"
const TIKTOK_URL = "https://www.tiktok.com/@fixture/video/123"

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function xPreview(patch: Partial<Preview> = {}): Preview {
  const text = "Independent designers discuss AI tools & creative ownership.\nWhat changes for small studios?"
  return {
    platform: "x",
    source_url: X_URL,
    title: "Independent designers discuss AI tools & creative ownership. What changes for small studios?",
    text,
    author: "Fixture researcher",
    context: `X public link\nPublic post text only. Replies, linked articles and attached media were not retrieved.\nAuthor: Fixture researcher\n\n${text}`,
    limitations: "Public post text only. Replies, linked articles and attached media were not retrieved.",
    truncated: false,
    mode: "fixture",
    ...patch,
  }
}

function tiktokPreview(): Preview {
  const text = "A synthetic behind-the-scenes caption about independent filmmaking. #creative"
  return {
    platform: "tiktok",
    source_url: TIKTOK_URL,
    title: text,
    text,
    author: "Fixture creator",
    context: `TikTok public link\nPublic video caption only. Transcript, comments and video content were not retrieved.\nAuthor: Fixture creator\n\n${text}`,
    limitations: "Public video caption only. Transcript, comments and video content were not retrieved.",
    truncated: false,
    mode: "fixture",
  }
}

/** Resolve by URL like the fixture provider: 123 succeeds per platform, 999 is a provider failure, anything else 422. */
function fixtureAnswer(url: string): Promise<Response> {
  if (url === X_URL || url.startsWith("https://twitter.com/fixture/status/123")) return Promise.resolve(json(xPreview()))
  if (url === TIKTOK_URL) return Promise.resolve(json(tiktokPreview()))
  if (url.includes("/999")) return Promise.resolve(json({ detail: "Provider refused the request. Keep the link and add context manually." }, 502))
  return Promise.resolve(json({ detail: [{ msg: "Value error, Paste a full HTTPS X post or TikTok video link." }] }, 422))
}

type HarnessProps = { initialTitle?: string; initialNotes?: string; initialUrl?: string; readOnly?: boolean; archived?: boolean; onApply?: (patch: { text: string; notes: string }) => void }

function Harness({ initialTitle = "Kept title", initialNotes = "My original context", initialUrl = X_URL, readOnly = false, archived = false, onApply }: HarnessProps) {
  const [title, setTitle] = useState(initialTitle)
  const [notes, setNotes] = useState(initialNotes)
  const [url, setUrl] = useState(initialUrl)
  return (
    <div>
      <input aria-label="Idea title" value={title} onChange={(event) => setTitle(event.target.value)} />
      <textarea aria-label="Idea notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
      <input aria-label="Source URL" value={url} onChange={(event) => setUrl(event.target.value)} />
      <SocialLinkPreview
        sourceUrl={url}
        title={title}
        notes={notes}
        readOnly={readOnly}
        archived={archived}
        onApply={(patch) => {
          onApply?.(patch)
          setTitle(patch.text)
          setNotes(patch.notes)
        }}
        onUseCanonical={(next) => setUrl(next)}
      />
    </div>
  )
}

beforeEach(() => {
  calls = []
  answer = fixtureAnswer
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const body = init?.body ? (JSON.parse(String(init.body)) as { url: string }) : { url: "" }
    if (!url.endsWith("/social-links/preview") || init?.method !== "POST") return json({ detail: "Not Found" }, 404)
    calls.push({ url, body })
    return answer(body.url)
  }) as unknown as typeof fetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function fetchButton() {
  return screen.getByRole("button", { name: /Preview link|Previewing…/ })
}

/** Limitations, counts, the canonical link and "Fetch again" sit behind the Details disclosure; open it when a test needs them. */
function openDetails() {
  const toggle = screen.getByRole("button", { name: "Source preview details" })
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle)
  expect(screen.getByTestId("link-preview-details")).toBeInTheDocument()
}

test("fetch shows the plain text once without touching the draft; add appends once, keeps title and link, and stays blocked while the block is present", async () => {
  const onApply = vi.fn()
  render(<Harness onApply={onApply} />)
  expect(screen.queryByTestId("link-preview-result")).toBeNull()
  expect(screen.getByRole("link", { name: "Open original ↗" })).toHaveAttribute("href", X_URL)
  expect(calls).toHaveLength(0)

  fireEvent.click(fetchButton())
  await flush()
  expect(calls).toEqual([{ url: "/social-links/preview", body: { url: X_URL } }])
  const result = screen.getByTestId("link-preview-result")
  expect(result).toHaveAttribute("data-platform", "x")
  expect(screen.getByTestId("link-preview-text")).toHaveTextContent("Independent designers discuss AI tools & creative ownership.")
  // The caption is shown exactly once: no separate title line repeating it.
  expect(screen.getAllByText(/Independent designers discuss AI tools/)).toHaveLength(1)
  expect(screen.getByTestId("link-preview-fixture")).toHaveTextContent("Test data")
  expect(screen.getByTestId("link-preview-scope")).toHaveTextContent("Post text only")
  expect(screen.getByText("Author: Fixture researcher")).toBeInTheDocument()
  // Limitations and counts are folded away until asked for.
  expect(screen.queryByTestId("link-preview-limits")).toBeNull()
  expect(screen.getByRole("button", { name: "Source preview details" })).toHaveAttribute("aria-expanded", "false")
  openDetails()
  expect(screen.getByTestId("link-preview-limits")).toHaveTextContent("Public post text only.")
  expect(screen.getByTestId("link-preview-counts")).toHaveTextContent(/^Adds [\d,]+ characters to notes\.$/)
  // Fetching is not applying: nothing changed in the editor.
  expect(onApply).not.toHaveBeenCalled()
  expect(screen.getByLabelText("Idea notes")).toHaveValue("My original context")
  expect(screen.getByLabelText("Idea title")).toHaveValue("Kept title")

  const add = screen.getByTestId("link-preview-add")
  expect(add).toBeEnabled()
  fireEvent.click(add)
  fireEvent.click(add)
  fireEvent.click(add)
  expect(onApply).toHaveBeenCalledTimes(1)
  const expected = `My original context\n\n${xPreview().context}`
  expect(onApply).toHaveBeenCalledWith({ text: "Kept title", notes: expected })
  expect(screen.getByLabelText("Idea notes")).toHaveValue(expected)
  expect(screen.getByLabelText("Idea title")).toHaveValue("Kept title")
  expect(screen.getByLabelText("Source URL")).toHaveValue(X_URL)
  expect(screen.getByTestId("link-preview-add")).toBeDisabled()
  expect(screen.getByTestId("link-preview-add")).toHaveTextContent("Already in notes")
  expect(screen.getByTestId("link-preview-status")).toHaveTextContent("Added to notes.")

  // Fetch again (from Details) for the same link: the block is still in the notes, so adding stays blocked with the reason.
  openDetails()
  fireEvent.click(screen.getByRole("button", { name: "Fetch again" }))
  await flush()
  expect(calls).toHaveLength(2)
  expect(screen.getByTestId("link-preview-add")).toBeDisabled()
  expect(screen.getByTestId("link-preview-status")).toHaveTextContent("Already in notes. Remove it there to add it again.")
  expect(onApply).toHaveBeenCalledTimes(1)

  // Removing the block from the notes makes the preview addable again, exactly once more.
  fireEvent.change(screen.getByLabelText("Idea notes"), { target: { value: "My original context, rewritten" } })
  expect(screen.getByTestId("link-preview-add")).toBeEnabled()
  expect(screen.getByTestId("link-preview-add")).toHaveTextContent("Add to notes")
  fireEvent.click(screen.getByTestId("link-preview-add"))
  expect(onApply).toHaveBeenCalledTimes(2)
  expect(screen.getByLabelText("Idea notes")).toHaveValue(`My original context, rewritten\n\n${xPreview().context}`)
  expect(screen.getByTestId("link-preview-add")).toBeDisabled()
})

test("a blank title is filled from the preview, cut to the title limit; the notes are appended as usual", async () => {
  render(<Harness initialTitle="" initialNotes="" />)
  fireEvent.click(fetchButton())
  await flush()
  openDetails()
  expect(screen.getByTestId("link-preview-counts")).toHaveTextContent(/Fills the empty title with "Independent designers discuss" \(cut to 30 characters\)\./)
  fireEvent.click(screen.getByTestId("link-preview-add"))
  expect(screen.getByLabelText("Idea title")).toHaveValue("Independent designers discuss")
  expect(screen.getByLabelText("Idea notes")).toHaveValue(xPreview().context)
})

test("an answer that arrives after the link changed is dropped; the next link gets its own preview and only that text can be added", async () => {
  let resolveSlow: (response: Response) => void = () => {}
  answer = (url) => (url === X_URL ? new Promise<Response>((resolve) => (resolveSlow = resolve)) : fixtureAnswer(url))
  render(<Harness />)
  fireEvent.click(fetchButton())
  await flush()
  expect(screen.getByTestId("link-preview-status")).toHaveTextContent("Fetching the public text…")

  // The user pastes another link while the first answer is still in flight.
  fireEvent.change(screen.getByLabelText("Source URL"), { target: { value: TIKTOK_URL } })
  expect(screen.getByTestId("link-preview")).toHaveAttribute("data-state", "idle")
  await act(async () => {
    resolveSlow(json(xPreview()))
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(screen.queryByTestId("link-preview-result")).toBeNull()
  expect(screen.queryByTestId("link-preview-add")).toBeNull()
  expect(screen.getByLabelText("Idea notes")).toHaveValue("My original context")

  fireEvent.click(fetchButton())
  await flush()
  expect(screen.getByTestId("link-preview-result")).toHaveAttribute("data-platform", "tiktok")
  fireEvent.click(screen.getByTestId("link-preview-add"))
  const notes = (screen.getByLabelText("Idea notes") as HTMLTextAreaElement).value
  expect(notes).toContain("TikTok public link")
  expect(notes).not.toContain("X public link")
})

test("editing the link (even back to the same text) discards the preview and requires a fresh fetch", async () => {
  render(<Harness />)
  fireEvent.click(fetchButton())
  await flush()
  expect(screen.getByTestId("link-preview-result")).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText("Source URL"), { target: { value: `${X_URL}4` } })
  expect(screen.queryByTestId("link-preview-result")).toBeNull()
  fireEvent.change(screen.getByLabelText("Source URL"), { target: { value: X_URL } })
  expect(screen.queryByTestId("link-preview-result")).toBeNull()
  expect(screen.getByRole("button", { name: "Preview link" })).toBeEnabled()
})

test("a provider failure is shown in plain words, the draft is untouched and a manual retry is possible", async () => {
  render(<Harness initialUrl="https://x.com/fixture/status/999" />)
  fireEvent.click(fetchButton())
  await flush()
  expect(screen.getByTestId("link-preview-status")).toHaveTextContent("The platform did not return a public preview: Provider refused the request. Keep the link and add context manually.")
  expect(screen.getByTestId("link-preview-status")).toHaveClass("error")
  expect(screen.queryByTestId("link-preview-result")).toBeNull()
  expect(screen.getByLabelText("Idea notes")).toHaveValue("My original context")
  expect(screen.getByLabelText("Idea title")).toHaveValue("Kept title")
  expect(screen.getByRole("button", { name: "Preview link" })).toBeEnabled()
  fireEvent.click(screen.getByRole("button", { name: "Preview link" }))
  await flush()
  expect(calls).toHaveLength(2)
})

test("a 422 from the server is shown as not fetched; an unsupported link never sends a request and explains why", async () => {
  render(<Harness initialUrl="https://example.com/story" />)
  expect(screen.getByRole("button", { name: "Preview link" })).toBeDisabled()
  expect(screen.getByText("Preview unavailable for this link.")).toBeInTheDocument()
  // A plain link still opens; nothing is fetched for it.
  expect(screen.getByRole("link", { name: "Open original ↗" })).toHaveAttribute("href", "https://example.com/story")
  expect(calls).toHaveLength(0)

  // The server stays authoritative: a link the client accepts but the server refuses reads as "Not fetched".
  fireEvent.change(screen.getByLabelText("Source URL"), { target: { value: "https://x.com/fixture/status/555" } })
  fireEvent.click(screen.getByRole("button", { name: "Preview link" }))
  await flush()
  expect(screen.getByTestId("link-preview-status")).toHaveTextContent("Not fetched: Value error, Paste a full HTTPS X post or TikTok video link.")
  expect(screen.getByLabelText("Idea notes")).toHaveValue("My original context")
})

test("adding is refused without truncation when context plus the source line would exceed the limit", async () => {
  const onApply = vi.fn()
  const long = "x".repeat(9900)
  render(<Harness initialNotes={long} onApply={onApply} />)
  fireEvent.click(fetchButton())
  await flush()
  expect(screen.getByTestId("link-preview-add")).toBeDisabled()
  expect(screen.getByTestId("link-preview-problem")).toHaveTextContent(/^Not added: context plus the source line would be 10,1\d\d characters, over the 10,000 limit/)
  fireEvent.click(screen.getByTestId("link-preview-add"))
  expect(onApply).not.toHaveBeenCalled()
  expect(screen.getByLabelText("Idea notes")).toHaveValue(long)
})

test("archived or busy editors cannot fetch or add", async () => {
  const { rerender } = render(<Harness archived readOnly />)
  expect(screen.getByRole("button", { name: "Preview link" })).toBeDisabled()
  expect(screen.getByText("Archived ideas are read-only. Restore the idea to preview its link.")).toBeInTheDocument()
  rerender(<Harness readOnly />)
  expect(screen.getByRole("button", { name: "Preview link" })).toBeDisabled()
  expect(calls).toHaveLength(0)
})

test("a pasted twitter.com link with tracking keeps its attribution; the canonical link is applied only on an explicit click and the preview survives it", async () => {
  const pasted = "https://twitter.com/fixture/status/123?utm_source=test"
  render(<Harness initialUrl={pasted} />)
  fireEvent.click(fetchButton())
  await flush()
  expect(calls[0]?.body).toEqual({ url: pasted })
  expect(screen.getByLabelText("Source URL")).toHaveValue(pasted)
  expect(screen.queryByText(`Canonical: ${X_URL}`)).toBeNull()
  openDetails()
  expect(screen.getByText(`Canonical: ${X_URL}`)).toBeInTheDocument()
  fireEvent.click(screen.getByTestId("link-preview-add"))
  expect(screen.getByLabelText("Source URL")).toHaveValue(pasted)
  fireEvent.click(screen.getByRole("button", { name: "Use canonical link" }))
  expect(screen.getByLabelText("Source URL")).toHaveValue(X_URL)
  expect(screen.getByTestId("link-preview-result")).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Use canonical link" })).toBeNull()
  expect(screen.queryByText(/^Canonical:/)).toBeNull()
  expect(calls).toHaveLength(1)
})
