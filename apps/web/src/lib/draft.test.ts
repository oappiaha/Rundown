import { expect, test } from "vitest"
import type { ShowState } from "./api"
import { MAX_NOTES, draftFromState, insertTopic, isDirty, mergeDraft, moveTopic, notesLength, notesProblem, sameTopics, toWire, topicProblem } from "./draft"

const base: ShowState = {
  revision: 5,
  topics: [
    { id: "a", text: "A", duration: 60, notes: "" },
    { id: "b", text: "B", duration: 60, notes: "" },
  ],
  current_topic_id: "a",
  remaining_seconds: 30,
  paused: false,
  server_time: "",
}

test("insertTopic places rows after the current id or at the end, with stable new keys", () => {
  const draft = draftFromState(base)
  const next = insertTopic(draft.topics, { text: " X ", duration: 20, notes: "" }, { afterId: "a" })
  expect(next.map((topic) => topic.text)).toEqual(["A", "X", "B"])
  expect(next[1]?.id).toBeNull()
  expect(next[1]?.key).toMatch(/^new-\d+$/)
  const end = insertTopic(next, { text: "Y", duration: 20, notes: "" }, "end")
  expect(end.map((topic) => topic.text)).toEqual(["A", "X", "B", "Y"])
  expect(end[1]?.key).toBe(next[1]?.key)
  expect(toWire(end)).toEqual([
    { id: "a", text: "A", duration: 60, notes: "" },
    { text: "X", duration: 20, notes: "" },
    { id: "b", text: "B", duration: 60, notes: "" },
    { text: "Y", duration: 20, notes: "" },
  ])
})

test("moveTopic is a no-op at the edges and isDirty tracks changes", () => {
  const draft = draftFromState(base)
  expect(isDirty(draft)).toBe(false)
  expect(moveTopic(draft.topics, "a", -1)).toBe(draft.topics)
  const moved = moveTopic(draft.topics, "a", 1)
  expect(moved.map((topic) => topic.id)).toEqual(["b", "a"])
  expect(isDirty({ ...draft, topics: moved })).toBe(true)
})

test("mergeDraft keeps local work, accepts remote removals of untouched rows, and places remote additions", () => {
  const draft = draftFromState(base)
  draft.topics = insertTopic(draft.topics, { text: "Mine", duration: 45, notes: "" }, { afterId: "a" })
  draft.topics = draft.topics.filter((topic) => topic.id !== "b")
  const remote: ShowState = {
    ...base,
    revision: 9,
    topics: [
      { id: "b", text: "B", duration: 60, notes: "" },
      { id: "c", text: "Remote add", duration: 30, notes: "" },
    ],
  }
  const merged = mergeDraft(draft, remote)
  expect(merged.baseRevision).toBe(9)
  // "A" was untouched locally and removed remotely -> gone. "b" was removed
  // locally -> stays removed. "Mine" is new -> kept. "c" is a remote addition.
  expect(merged.topics.map((topic) => [topic.id, topic.text])).toEqual([
    [null, "Mine"],
    ["c", "Remote add"],
  ])
})

test("mergeDraft merges per field: edited fields stay local, untouched fields take the server value", () => {
  const draft = draftFromState(base)
  draft.topics = draft.topics.map((topic) => (topic.id === "a" ? { ...topic, text: "A edited" } : topic))
  const remote: ShowState = {
    ...base,
    revision: 7,
    topics: [
      { id: "a", text: "A", duration: 99, notes: "" }, // duration changed remotely, text untouched remotely
      { id: "x", text: "Inserted next", duration: 20, notes: "" }, // remote insert-next after a
      { id: "b", text: "B renamed", duration: 60, notes: "" },
    ],
  }
  const merged = mergeDraft(draft, remote)
  expect(merged.topics.map((topic) => [topic.id, topic.text, topic.duration])).toEqual([
    ["a", "A edited", 99],
    ["x", "Inserted next", 20],
    ["b", "B renamed", 60],
  ])
  expect(isDirty(merged)).toBe(true)
  expect(merged.topics[0]?.key).toBe("a")
})

test("mergeDraft keeps a locally edited row that vanished remotely as a new row", () => {
  const draft = draftFromState(base)
  draft.topics = draft.topics.map((topic) => (topic.id === "b" ? { ...topic, duration: 75 } : topic))
  const remote: ShowState = { ...base, revision: 6, topics: [{ id: "a", text: "A", duration: 60, notes: "" }] }
  const merged = mergeDraft(draft, remote)
  expect(toWire(merged.topics)).toEqual([
    { id: "a", text: "A", duration: 60, notes: "" },
    { text: "B", duration: 75, notes: "" },
  ])
  expect(merged.topics[1]?.key).toBe("b")
})

// ---- Notes / context --------------------------------------------------------

const NOTES = "Background line\nhttps://example.com/very/long/url?with=query&and=more\n\n<b>literal</b>  trailing  "

test("notes travel verbatim through toWire and count as Unicode characters", () => {
  const draft = draftFromState(base)
  draft.topics = insertTopic(draft.topics, { text: "N", duration: 30, notes: NOTES }, "end")
  expect(toWire(draft.topics)).toEqual([
    { id: "a", text: "A", duration: 60, notes: "" },
    { id: "b", text: "B", duration: 60, notes: "" },
    { text: "N", duration: 30, notes: NOTES },
  ])
  expect(notesLength("héllo")).toBe(5)
  expect(notesLength("😀".repeat(3))).toBe(3) // 6 UTF-16 units, 3 characters
  expect(notesProblem("x".repeat(MAX_NOTES))).toBeNull()
  expect(notesProblem("😀".repeat(MAX_NOTES))).toBeNull()
  expect(notesProblem("x".repeat(MAX_NOTES + 1))).toMatch(/at most 10000 characters \(currently 10001\)/)
  expect(topicProblem({ text: "ok", duration: 60, notes: "x".repeat(MAX_NOTES + 1) })).toMatch(/Notes must be/)
})

test("notes participate in isDirty and sameTopics, and reorder/insert keep them", () => {
  const withNotes: ShowState = { ...base, topics: [{ ...base.topics[0]!, notes: "keep me" }, base.topics[1]!] }
  const draft = draftFromState(withNotes)
  expect(isDirty(draft)).toBe(false)
  const edited = { ...draft, topics: draft.topics.map((topic) => (topic.id === "a" ? { ...topic, notes: "changed" } : topic)) }
  expect(isDirty(edited)).toBe(true)
  const cleared = { ...draft, topics: draft.topics.map((topic) => (topic.id === "a" ? { ...topic, notes: "" } : topic)) }
  expect(isDirty(cleared)).toBe(true)
  expect(sameTopics(withNotes.topics, base.topics)).toBe(false)
  expect(sameTopics(withNotes.topics, [{ id: "a", text: "A", duration: 60, notes: "keep me" }, base.topics[1]!])).toBe(true)

  let topics = insertTopic(draft.topics, { text: "New", duration: 20, notes: "new notes" }, { afterId: "a" })
  topics = moveTopic(topics, "a", 1)
  topics = moveTopic(topics, "b", -1)
  expect(topics.map((topic) => [topic.text, topic.notes])).toEqual([
    ["New", "new notes"],
    ["B", ""],
    ["A", "keep me"],
  ])
})

test("mergeDraft: locally edited notes win; remote notes survive an unrelated local title edit; cleared notes stay cleared", () => {
  const withNotes: ShowState = {
    ...base,
    topics: [
      { id: "a", text: "A", duration: 60, notes: "old a" },
      { id: "b", text: "B", duration: 60, notes: "old b" },
    ],
  }
  const draft = draftFromState(withNotes)
  draft.topics = draft.topics.map((topic) =>
    topic.id === "a" ? { ...topic, notes: "mine" } : { ...topic, text: "B renamed here" },
  )
  const remote: ShowState = {
    ...withNotes,
    revision: 8,
    topics: [
      { id: "a", text: "A", duration: 60, notes: "theirs" },
      { id: "b", text: "B", duration: 60, notes: "remote b notes" },
    ],
  }
  const merged = mergeDraft(draft, remote)
  expect(merged.topics.map((topic) => [topic.id, topic.text, topic.notes])).toEqual([
    ["a", "A", "mine"],
    ["b", "B renamed here", "remote b notes"],
  ])

  // Cleared locally ("" is a real edit) stays cleared even if the other screen wrote notes.
  const clearing = draftFromState(withNotes)
  clearing.topics = clearing.topics.map((topic) => (topic.id === "a" ? { ...topic, notes: "" } : topic))
  expect(mergeDraft(clearing, remote).topics[0]?.notes).toBe("")

  // A row edited only in its notes and removed remotely is kept as a new row with its notes.
  const gone: ShowState = { ...withNotes, revision: 9, topics: [withNotes.topics[1]!] }
  const kept = mergeDraft(draft, gone)
  expect(toWire(kept.topics)).toEqual([
    { text: "A", duration: 60, notes: "mine" },
    { id: "b", text: "B renamed here", duration: 60, notes: "old b" },
  ])
})
