import { artworkFor, type ArtKind } from "../lib/discover"

// Deterministic artwork for a topic without a usable image, in the control
// room's own light/blue/silver palette. Same id, same picture, no network.
const PALETTES = [
  { bg: "#e8eef7", a: "#0071e3", b: "#1d1d1f", c: "#ffffff" },
  { bg: "#1d1d1f", a: "#f5f5f7", b: "#0071e3", c: "#78c8e8" },
  { bg: "#dfe3ea", a: "#0055b3", b: "#1d1d1f", c: "#ffffff" },
  { bg: "#0071e3", a: "#f5f5f7", b: "#1d1d1f", c: "#78c8e8" },
  { bg: "#f5f5f7", a: "#1d1d1f", b: "#0071e3", c: "#c4c4c4" },
  { bg: "#0a1520", a: "#78c8e8", b: "#f5f5f7", c: "#0071e3" },
]

const W = 400
const H = 300

function shapes(kind: ArtKind, p: (typeof PALETTES)[number]) {
  switch (kind) {
    case "arc":
      return (
        <>
          <path d={`M-20 ${H * 0.95} A ${W * 0.62} ${W * 0.62} 0 0 1 ${W * 1.1} ${H * 0.95} Z`} fill={p.a} />
          <circle cx={W * 0.72} cy={H * 0.3} r={H * 0.14} fill={p.b} />
          <line x1={W * 0.08} y1={H * 0.22} x2={W * 0.5} y2={H * 0.22} stroke={p.b} strokeWidth="2" />
          <line x1={W * 0.08} y1={H * 0.3} x2={W * 0.42} y2={H * 0.3} stroke={p.b} strokeWidth="2" />
          <circle cx={W * 0.28} cy={H * 0.62} r={H * 0.06} fill={p.c} />
        </>
      )
    case "grid":
      return (
        <>
          {Array.from({ length: 7 }, (_, i) => (
            <line key={`v${i}`} x1={(W * (i + 1)) / 8} y1="0" x2={(W * (i + 1)) / 8} y2={H} stroke={p.a} strokeOpacity=".35" />
          ))}
          {Array.from({ length: 5 }, (_, j) => (
            <line key={`h${j}`} x1="0" y1={(H * (j + 1)) / 6} x2={W} y2={(H * (j + 1)) / 6} stroke={p.a} strokeOpacity=".35" />
          ))}
          <rect x={W / 8} y={H / 6} width={W / 4} height={H / 3} fill={p.a} />
          <rect x={(W * 5) / 8} y={(H * 3) / 6} width={W / 8} height={H / 3} fill={p.b} />
          <rect x={(W * 4) / 8} y={H / 6} width={W / 8} height={H / 6} fill={p.c} />
          <circle cx={(W * 6) / 8} cy={(H * 2) / 6} r={H / 12} fill={p.a} />
        </>
      )
    case "orbit":
      return (
        <>
          <circle cx={W * 0.5} cy={H * 0.55} r={H * 0.42} fill="none" stroke={p.a} strokeWidth="2" />
          <circle cx={W * 0.5} cy={H * 0.55} r={H * 0.28} fill="none" stroke={p.a} strokeWidth="2" strokeDasharray="6 8" />
          <circle cx={W * 0.5} cy={H * 0.55} r={H * 0.12} fill={p.b} />
          <circle cx={W * 0.5 + H * 0.42 * 0.71} cy={H * 0.55 - H * 0.42 * 0.71} r={H * 0.05} fill={p.c} />
          <circle cx={W * 0.5 - H * 0.28} cy={H * 0.55} r={H * 0.035} fill={p.a} />
        </>
      )
    case "stripes":
      return (
        <>
          {Array.from({ length: 18 }, (_, k) => k - 4).map((i) => (
            <line key={i} x1={(W * i) / 10} y1={H} x2={(W * i) / 10 + H * 0.6} y2="0" stroke={p.a} strokeOpacity=".5" strokeWidth="3" />
          ))}
          <rect x={W * 0.18} y={H * 0.22} width={W * 0.36} height={H * 0.56} fill={p.b} />
          <rect x={W * 0.6} y={H * 0.5} width={W * 0.22} height={H * 0.28} fill={p.c} />
        </>
      )
    case "blob":
      return (
        <>
          <path
            d={`M${W * 0.2} ${H * 0.5} C ${W * 0.15} ${H * 0.15}, ${W * 0.6} ${H * 0.05}, ${W * 0.75} ${H * 0.3} C ${W * 0.92} ${H * 0.55}, ${W * 0.75} ${H * 0.95}, ${W * 0.45} ${H * 0.9} C ${W * 0.22} ${H * 0.86}, ${W * 0.24} ${H * 0.75}, ${W * 0.2} ${H * 0.5} Z`}
            fill={p.a}
          />
          <rect x={W * 0.55} y={H * 0.55} width={W * 0.32} height={H * 0.32} fill={p.b} />
          <circle cx={W * 0.3} cy={H * 0.32} r={H * 0.07} fill={p.c} />
        </>
      )
    default:
      return (
        <>
          <polygon points={`0,${H} ${W},0 ${W},${H}`} fill={p.a} />
          <circle cx={W * 0.3} cy={H * 0.32} r={H * 0.2} fill={p.b} />
          <rect x={W * 0.62} y={H * 0.58} width={W * 0.2} height={W * 0.2} fill={p.c} transform={`rotate(12 ${W * 0.72} ${H * 0.68})`} />
        </>
      )
  }
}

export default function DiscoverArt({ id }: { id: string }) {
  const { kind, palette } = artworkFor(id)
  const p = PALETTES[palette]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" role="img" aria-label="Generated artwork" data-testid="dsc-art-generated" data-art-kind={kind}>
      <rect width={W} height={H} fill={p.bg} />
      {shapes(kind, p)}
    </svg>
  )
}
