import { describe, expect, test } from "vitest"
import type { InboxItem } from "./api"
import {
  draftFromItem,
  hasInboxWork,
  inboxProblem,
  isInboxDirty,
  mergeInboxDraft,
  newInboxDraft,
  projectedNotesLength,
  safeSourceHref,
  sourceUrlProblem,
  toCreateWire,
  toUpdateWire,
} from "./inboxDraft"

function item(patch: Partial<InboxItem> = {}): InboxItem {
  const notes = patch.notes ?? "why it matters"
  const source_url = patch.source_url ?? "https://example.com/story"
  return {
    id: "i1",
    revision: 2,
    text: "Rent strike",
    duration: 180,
    notes,
    source_url,
    archived: false,
    created_at: "2026-09-15T00:00:00Z",
    updated_at: "2026-09-15T00:00:00Z",
    topic: { text: patch.text ?? "Rent strike", duration: patch.duration ?? 180, notes: `${notes}${notes && source_url ? "\n\n" : ""}${source_url ? `Source: ${source_url}` : ""}` },
    source: null,
    ...patch,
  }
}

describe("source URL rules", () => {
  test("empty is allowed; absolute http(s) without credentials or whitespace is accepted after trimming", () => {
    expect(sourceUrlProblem("")).toBeNull()
    expect(sourceUrlProblem("   ")).toBeNull()
    expect(sourceUrlProblem("  https://example.com/a?b=1#c  ")).toBeNull()
    expect(sourceUrlProblem("http://localhost:8000/x")).toBeNull()
    expect(safeSourceHref("  https://example.com/a  ")).toBe("https://example.com/a")
  })

  test("non-web schemes, relative paths, credentials, spaces and oversize are refused and never rendered as links", () => {
    for (const bad of ["javascript:alert(1)", "ftp://files.example/x", "example.com/story", "/relative", "https://user:pw@example.com/", "https://user@example.com/", "https://@example.com/", "https:example.com", "https:/example.com", "https://exa mple.com", "https://example.com/a\\b", "https://example.com/a\u0000b", "https://example.com/a\u007fb", "mailto:x@y.z", "https://", `https://example.com/${"a".repeat(2048)}`]) {
      expect(sourceUrlProblem(bad), bad).not.toBeNull()
      expect(safeSourceHref(bad), bad).toBeNull()
    }
  })
})

describe("validation", () => {
  test("titles are limited in Unicode code points, so 30 emoji pass and 31 do not", () => {
    expect(inboxProblem({ text: "🎙️".repeat(15), duration: 120, notes: "", source_url: "" })).toBeNull()
    expect(inboxProblem({ text: "😀".repeat(30), duration: 120, notes: "", source_url: "" })).toBeNull()
    expect(inboxProblem({ text: "😀".repeat(31), duration: 120, notes: "", source_url: "" })).toMatch(/Title/)
  })

  test("combined context plus source line must fit the notes limit", () => {
    expect(projectedNotesLength("", "")).toBe(0)
    expect(projectedNotesLength("abc", "")).toBe(3)
    expect(projectedNotesLength("", "https://a.b")).toBe("Source: https://a.b".length)
    expect(projectedNotesLength("abc", "https://a.b")).toBe(3 + 2 + "Source: https://a.b".length)
    const url = "https://example.com/story"
    const room = 10000 - 2 - `Source: ${url}`.length
    expect(inboxProblem({ text: "ok", duration: 120, notes: "x".repeat(room), source_url: url })).toBeNull()
    expect(inboxProblem({ text: "ok", duration: 120, notes: "x".repeat(room + 1), source_url: url })).toMatch(/must fit/)
  })

  test("title, duration and URL problems are reported in order", () => {
    expect(inboxProblem({ text: " ", duration: 120, notes: "", source_url: "" })).toMatch(/Title/)
    expect(inboxProblem({ text: "ok", duration: 10, notes: "", source_url: "" })).toMatch(/Duration/)
    expect(inboxProblem({ text: "ok", duration: 120.5, notes: "", source_url: "" })).toMatch(/Duration/)
    expect(inboxProblem({ text: "ok", duration: 120, notes: "", source_url: "nope" })).toMatch(/Source URL/)
    expect(inboxProblem({ text: "ok", duration: 3600, notes: "", source_url: "" })).toBeNull()
  })
})

describe("draft lifecycle", () => {
  test("a pristine new idea is not worth guarding; typing makes it so", () => {
    const fresh = newInboxDraft(120)
    expect(hasInboxWork(fresh)).toBe(false)
    expect(isInboxDirty(fresh)).toBe(true)
    expect(hasInboxWork({ ...fresh, source_url: " https://x.y " })).toBe(true)
    expect(hasInboxWork({ ...fresh, notes: "n" })).toBe(true)
  })

  test("a loaded idea is dirty only when a field differs from the server copy (URL compared trimmed)", () => {
    const draft = draftFromItem(item())
    expect(isInboxDirty(draft)).toBe(false)
    expect(isInboxDirty({ ...draft, source_url: " https://example.com/story " })).toBe(false)
    expect(isInboxDirty({ ...draft, notes: "changed" })).toBe(true)
    expect(isInboxDirty({ ...draft, duration: 181 })).toBe(true)
  })

  test("wire forms trim title and URL, keep notes verbatim, carry the base revision and never an id or archived flag", () => {
    const draft = { ...draftFromItem(item()), text: "  Rent strike  ", notes: "  keep\n\nthis  ", source_url: " https://example.com/story " }
    expect(toCreateWire(draft)).toEqual({ text: "Rent strike", duration: 180, notes: "  keep\n\nthis  ", source_url: "https://example.com/story" })
    expect(toUpdateWire(draft)).toEqual({ revision: 2, text: "Rent strike", duration: 180, notes: "  keep\n\nthis  ", source_url: "https://example.com/story" })
  })

  test("merge keeps locally edited fields, takes the latest server value for untouched ones, and re-pins the revision", () => {
    const draft = { ...draftFromItem(item()), notes: "my new notes" }
    const latest = item({ revision: 5, text: "Renamed elsewhere", source_url: "https://example.com/v2", archived: true })
    const merged = mergeInboxDraft(draft, latest)
    expect(merged).toMatchObject({ id: "i1", baseRevision: 5, archived: true, text: "Renamed elsewhere", notes: "my new notes", source_url: "https://example.com/v2" })
    expect(merged.base).toEqual({ text: "Renamed elsewhere", duration: 180, notes: "why it matters", source_url: "https://example.com/v2" })
    expect(isInboxDirty(merged)).toBe(true)
  })
})
