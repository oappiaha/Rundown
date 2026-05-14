import { useEffect, useState } from "react"
import { getTopics, health, type Topic } from "./lib/api"

export default function App() {
  const [topics, setTopics] = useState<Topic[]>([])
  const [hash, setHash] = useState("")
  const [status, setStatus] = useState<"loading" | "ok" | "down">("loading")

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        await health()
        const t = await getTopics()
        if (cancelled) return
        setTopics(t.topics)
        setHash(t.hash)
        setStatus("ok")
      } catch {
        if (!cancelled) setStatus("down")
      }
    }
    load()
    const id = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  return (
    <main className="min-h-screen p-8">
      <header className="flex items-baseline justify-between border-b border-white/10 pb-4">
        <h1 className="font-mono text-3xl tracking-wider">RUNDOWN</h1>
        <span className="text-xs uppercase tracking-widest opacity-60">
          api: {status} · hash: {hash || "—"}
        </span>
      </header>

      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-widest opacity-60">Current rundown</h2>
        {topics.length === 0 ? (
          <p className="mt-4 opacity-60">No topics yet.</p>
        ) : (
          <ol className="mt-4 space-y-2">
            {topics.map((t, i) => (
              <li
                key={`${t.text}-${i}`}
                className="flex justify-between rounded border border-white/10 bg-white/5 px-4 py-3 font-mono"
              >
                <span>
                  <span className="opacity-50 mr-3">{String(i + 1).padStart(2, "0")}</span>
                  {t.text}
                </span>
                <span className="opacity-60">{t.duration}s</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  )
}
