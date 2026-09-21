import type { ControlAction, ShowState } from "../lib/api"
import { formatClock } from "../lib/draft"

type Props = {
  state: ShowState | null
  busy: boolean
  variant: "sidebar" | "hero"
  onControl: (action: ControlAction) => void
}

/** The one skeuomorphic object: silver deck with a dark blue LCD. */
export default function Deck({ state, busy, variant, onControl }: Props) {
  const topics = state?.topics ?? []
  const index = state ? topics.findIndex((topic) => topic.id === state.current_topic_id) : -1
  const current = index >= 0 ? topics[index] : undefined
  const empty = topics.length === 0
  const paused = state?.paused ?? true
  const remaining = state?.remaining_seconds ?? 0
  const progress = current && current.duration > 0 ? Math.min(1, Math.max(0, 1 - remaining / current.duration)) : 0
  const disabled = busy || empty || state === null

  return (
    <section className={`deck deck-${variant}`} aria-label="Transport deck">
      <div className="deck-head" aria-hidden="true">
        <span className="deck-brand">BEEZY</span>
        <span className="deck-model">RD-001</span>
      </div>
      <div className="lcd">
        <div className="lcd-np">
          <span className={`lcd-dot${!paused && !empty ? " on" : ""}`} />
          {state === null ? "CONNECTING" : empty ? "NO SHOW LOADED" : paused ? "PAUSED" : "NOW PLAYING"}
        </div>
        <div className="lcd-topic" data-testid="lcd-topic">
          {current ? current.text : empty ? "— — —" : "…"}
        </div>
        <div className="lcd-row">
          <span className="lcd-trk">
            {current ? `TRK ${String(index + 1).padStart(2, "0")}/${String(topics.length).padStart(2, "0")}` : "TRK --/--"}
          </span>
          <span className="lcd-time" data-testid="lcd-time" aria-label="Remaining time">
            {formatClock(remaining)}
          </span>
        </div>
        <div className="lcd-seek" aria-hidden="true">
          <div className="lcd-seek-fill" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>
      <div className="transport" role="group" aria-label="Transport controls">
        <button
          type="button"
          className="deck-btn"
          aria-label="Previous segment"
          disabled={disabled || index <= 0}
          onClick={() => onControl("previous")}
        >
          ⏮
        </button>
        <button
          type="button"
          className="deck-btn big"
          aria-label={paused ? "Play" : "Pause"}
          aria-pressed={!paused}
          disabled={disabled}
          onClick={() => onControl(paused ? "play" : "pause")}
        >
          {paused ? "▶" : "⏸"}
        </button>
        <button
          type="button"
          className="deck-btn"
          aria-label="Next segment"
          disabled={disabled || index < 0 || index >= topics.length - 1}
          onClick={() => onControl("next")}
        >
          ⏭
        </button>
      </div>
      <button type="button" className="deck-reset" disabled={disabled} onClick={() => onControl("reset")}>
        Reset to top
      </button>
    </section>
  )
}
