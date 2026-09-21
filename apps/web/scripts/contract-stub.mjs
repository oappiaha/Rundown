// Local, in-memory stand-in for the frozen show-state contract in
// docs/plans/2026-09-14-visual-control-room.md. Development aid only: it lets
// the control room be exercised before/without the FastAPI backend.
//
//   node scripts/contract-stub.mjs [port]      (default 8151)
//
// Not a substitute for backend acceptance. Nothing is persisted.
//
// Topic `notes` (control-room context) follow the frozen contract: always a
// string on read, <= 10000 Unicode characters, "" clears, an omitted `notes`
// on an existing entry keeps the stored value (older clients).
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"

const port = Number(process.argv[2] ?? process.env.PORT ?? 8151)

const state = {
  revision: 0,
  topics: [],
  current_topic_id: null,
  remaining_seconds: 0,
  paused: true,
}
let lastTick = Date.now()

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function snapshot() {
  return { ...state, topics: state.topics.map((t) => ({ ...t })), server_time: new Date().toISOString() }
}

function currentIndex() {
  return state.topics.findIndex((t) => t.id === state.current_topic_id)
}

function select(index, { paused } = {}) {
  const topic = state.topics[index]
  state.current_topic_id = topic ? topic.id : null
  state.remaining_seconds = topic ? topic.duration : 0
  if (paused !== undefined) state.paused = paused
}

// Server-owned clock: advance elapsed time on demand (called before every read).
function tick() {
  const now = Date.now()
  const elapsed = Math.floor((now - lastTick) / 1000)
  if (elapsed <= 0) return
  lastTick += elapsed * 1000
  if (state.paused || state.current_topic_id === null) return
  let left = elapsed
  while (left > 0) {
    if (state.remaining_seconds > left) {
      state.remaining_seconds -= left
      left = 0
    } else {
      left -= state.remaining_seconds
      const idx = currentIndex()
      if (idx < state.topics.length - 1) {
        select(idx + 1)
        state.revision += 1
      } else {
        state.remaining_seconds = 0
        state.paused = true
        state.revision += 1
        left = 0
      }
    }
  }
}

function validateTopics(topics) {
  if (!Array.isArray(topics) || topics.length > 20) return "topics must be a list of 0-20 entries"
  const seen = new Set()
  for (const t of topics) {
    if (typeof t !== "object" || t === null) return "topic must be an object"
    if (typeof t.text !== "string" || t.text.trim().length < 1 || t.text.trim().length > 30) return "text must be 1-30 characters"
    if (!Number.isInteger(t.duration) || t.duration < 15 || t.duration > 3600) return "duration must be an integer 15-3600"
    if (t.notes !== undefined && (typeof t.notes !== "string" || [...t.notes].length > 10000)) return "notes must be a string of at most 10000 characters"
    if (t.id !== undefined && t.id !== null) {
      if (!state.topics.some((s) => s.id === t.id)) return `unknown topic id ${t.id}`
      if (seen.has(t.id)) return `duplicate topic id ${t.id}`
      seen.add(t.id)
    }
  }
  return null
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error("bad json"))
      }
    })
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1")
  tick()
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { status: "ok" })
  if (req.method === "GET" && url.pathname === "/rundown/state") return json(res, 200, snapshot())
  if (req.method === "GET" && url.pathname === "/rundown/topics") {
    return json(res, 200, { topics: state.topics.map(({ text, duration }) => ({ text, duration })), hash: `rev${state.revision}` })
  }

  let body
  try {
    body = await readBody(req)
  } catch {
    return json(res, 422, { detail: "invalid JSON" })
  }

  if (req.method === "PUT" && url.pathname === "/rundown/schedule") {
    if (!Number.isInteger(body.revision)) return json(res, 422, { detail: "revision required" })
    const problem = validateTopics(body.topics)
    if (problem) return json(res, 422, { detail: problem })
    if (body.revision !== state.revision) return json(res, 409, { detail: `stale revision ${body.revision}; server is at ${state.revision}` })
    const hadCurrent = state.current_topic_id !== null
    if (hadCurrent && !body.topics.some((t) => t.id === state.current_topic_id)) {
      return json(res, 409, { detail: "cannot remove the current segment; select another segment first" })
    }
    state.topics = body.topics.map((t) => {
      const existing = t.id ? state.topics.find((s) => s.id === t.id) : undefined
      const notes = t.notes !== undefined ? t.notes : (existing?.notes ?? "")
      return { id: t.id ?? randomUUID(), text: t.text.trim(), duration: t.duration, notes }
    })
    state.revision += 1
    if (!hadCurrent) {
      select(state.topics.length ? 0 : -1, { paused: true })
    } else {
      const cur = state.topics.find((t) => t.id === state.current_topic_id)
      if (state.remaining_seconds > cur.duration) state.remaining_seconds = cur.duration
    }
    return json(res, 200, snapshot())
  }

  if (req.method === "POST" && url.pathname === "/rundown/control") {
    const actions = ["play", "pause", "next", "previous", "reset", "jump"]
    if (!Number.isInteger(body.revision)) return json(res, 422, { detail: "revision required" })
    if (!actions.includes(body.action)) return json(res, 422, { detail: "unknown action" })
    if (body.revision !== state.revision) return json(res, 409, { detail: `stale revision ${body.revision}; server is at ${state.revision}` })
    if (state.topics.length === 0) return json(res, 409, { detail: "show is empty; transport disabled" })
    const idx = currentIndex()
    switch (body.action) {
      case "play":
        if (state.remaining_seconds === 0) state.remaining_seconds = state.topics[idx].duration
        state.paused = false
        break
      case "pause":
        state.paused = true
        break
      case "next":
        if (idx < state.topics.length - 1) select(idx + 1)
        break
      case "previous":
        if (idx > 0) select(idx - 1)
        break
      case "reset":
        select(0, { paused: true })
        break
      case "jump": {
        const target = state.topics.findIndex((t) => t.id === body.topic_id)
        if (target < 0) return json(res, 422, { detail: "unknown topic_id" })
        select(target)
        break
      }
    }
    lastTick = Date.now()
    state.revision += 1
    return json(res, 200, snapshot())
  }

  json(res, 404, { detail: "Not Found" })
})

server.listen(port, "127.0.0.1", () => {
  console.log(`contract stub listening on http://127.0.0.1:${port}`)
})
