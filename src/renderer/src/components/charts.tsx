import { useEffect, useRef, useState } from 'react'

// useAnimatedNumber — eased count-up for hero numbers. Hooks RAF only when the
// target changes; idle cost is zero.
export function useAnimatedNumber(target: number, durationMs = 700): number {
  const [value, setValue] = useState(target)
  const fromRef = useRef(target)
  const startRef = useRef<number | null>(null)
  const targetRef = useRef(target)

  useEffect(() => {
    if (target === targetRef.current) return
    fromRef.current = value
    targetRef.current = target
    startRef.current = null
    let raf = 0
    const tick = (t: number): void => {
      if (startRef.current === null) startRef.current = t
      const p = Math.min(1, (t - startRef.current) / durationMs)
      const eased = 1 - Math.pow(1 - p, 3)
      setValue(fromRef.current + (target - fromRef.current) * eased)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs])

  return value
}

export function AreaChart({ values }: { values: bigint[] }): JSX.Element {
  const w = 320
  const h = 84
  const padX = 4
  const padY = 6
  const innerW = w - padX * 2
  const innerH = h - padY * 2
  if (values.length === 0) return <svg className="area-chart" viewBox={`0 0 ${w} ${h}`} aria-hidden />
  const nums = values.map((v) => Number(v) / 1_000_000)
  const max = Math.max(...nums, 0.001)
  const step = nums.length > 1 ? innerW / (nums.length - 1) : 0
  const pts = nums.map((v, i) => ({ x: padX + i * step, y: padY + innerH - (v / max) * innerH }))

  const linePath = pts
    .map((p, i) => {
      const prev = pts[i - 1]
      if (!prev) return `M${p.x},${p.y}`
      const cpx = (prev.x + p.x) / 2
      return `Q${cpx},${prev.y} ${cpx},${(prev.y + p.y) / 2} T${p.x},${p.y}`
    })
    .join(' ')
  const last = pts[pts.length - 1]!
  const first = pts[0]!
  const areaPath = `${linePath} L${last.x},${padY + innerH} L${first.x},${padY + innerH} Z`
  const guides = [0.25, 0.5, 0.75].map((g) => padY + innerH * g)

  return (
    <svg className="area-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="area-grad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="rgba(99,173,255,0.55)" />
          <stop offset="60%" stopColor="rgba(99,173,255,0.12)" />
          <stop offset="100%" stopColor="rgba(99,173,255,0)" />
        </linearGradient>
        <linearGradient id="line-grad" x1="0" x2="1">
          <stop offset="0%" stopColor="#63adff" />
          <stop offset="100%" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      {guides.map((y, i) => (
        <line key={i} x1={padX} x2={w - padX} y1={y} y2={y}
              stroke="rgba(255,255,255,0.05)" strokeWidth={1} strokeDasharray="2 3" />
      ))}
      <path d={areaPath} fill="url(#area-grad)" />
      <path d={linePath} fill="none" stroke="url(#line-grad)" strokeWidth={1.6}
            strokeLinecap="round" strokeLinejoin="round"
            style={{ filter: 'drop-shadow(0 0 6px rgba(99,173,255,0.45))' }} />
      <circle cx={last.x} cy={last.y} r={3} fill="#a78bfa" stroke="rgba(255,255,255,0.95)" strokeWidth={1} />
      <circle cx={last.x} cy={last.y} r={6} fill="rgba(167,139,250,0.18)">
        <animate attributeName="r" values="3;9;3" dur="2.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.6;0;0.6" dur="2.4s" repeatCount="indefinite" />
      </circle>
    </svg>
  )
}

interface DonutSlice {
  id: string
  value: number
  color: string
}

export function Donut({ slices, centerLabel, centerValue }: {
  slices: DonutSlice[]
  centerLabel: string
  centerValue: string
}): JSX.Element {
  const size = 110
  const cx = size / 2
  const cy = size / 2
  const r = 44
  const stroke = 12
  const total = slices.reduce((a, s) => a + s.value, 0) || 1
  const circ = 2 * Math.PI * r
  let offset = 0
  return (
    <div className="donut-wrap">
      <svg viewBox={`0 0 ${size} ${size}`} className="donut" aria-hidden>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={stroke} />
        {slices.map((s) => {
          const len = (s.value / total) * circ
          const dash = `${len} ${circ - len}`
          const el = (
            <circle key={s.id} cx={cx} cy={cy} r={r} fill="none" stroke={s.color} strokeWidth={stroke}
                    strokeDasharray={dash} strokeDashoffset={-offset}
                    transform={`rotate(-90 ${cx} ${cy})`} strokeLinecap="butt"
                    style={{ transition: 'stroke-dasharray 360ms ease, stroke-dashoffset 360ms ease',
                             filter: `drop-shadow(0 0 4px ${s.color}66)` }} />
          )
          offset += len
          return el
        })}
        <text x={cx} y={cy - 2} textAnchor="middle" className="donut-value">{centerValue}</text>
        <text x={cx} y={cy + 14} textAnchor="middle" className="donut-label">{centerLabel}</text>
      </svg>
    </div>
  )
}

export function ShareBar({ pct, color }: { pct: number; color: string }): JSX.Element {
  return (
    <span className="share-bar" aria-hidden>
      <span className="share-bar-fill"
            style={{ width: `${Math.max(2, Math.min(100, pct))}%`, background: color }} />
    </span>
  )
}
