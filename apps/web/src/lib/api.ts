export type Topic = {
  text: string
  duration: number
}

export type TopicsResponse = {
  topics: Topic[]
  hash: string
}

export type PushResponse = {
  ok: boolean
  rundown_id: number
  topics_count: number
  obs_refreshed: boolean
}

const BASE = "/api"

export async function getTopics(): Promise<TopicsResponse> {
  const r = await fetch(`${BASE}/rundown/topics`, { cache: "no-store" })
  if (!r.ok) throw new Error(`GET /topics ${r.status}`)
  return r.json()
}

export async function pushToObs(
  topics: Topic[],
  opts: { refresh_obs?: boolean; notes?: string } = {},
): Promise<PushResponse> {
  const r = await fetch(`${BASE}/rundown/push-to-obs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topics, refresh_obs: opts.refresh_obs ?? true, notes: opts.notes }),
  })
  if (!r.ok) throw new Error(`POST /push-to-obs ${r.status}`)
  return r.json()
}

export async function health(): Promise<{ status: string }> {
  const r = await fetch(`${BASE}/health`)
  if (!r.ok) throw new Error(`GET /health ${r.status}`)
  return r.json()
}
