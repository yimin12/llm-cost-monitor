import type { ReactNode } from 'react'

// CLI-Pulse-style sparse KPI tile primitive — small icon + short
// label above a large numeric value, optional smaller subtitle.
//
// Centered horizontally. All three rows are single-line by design so
// a row of tiles always lines up vertically (no "this one wraps and
// stretches everyone else" problem). If you have a longer sub copy,
// shorten it — wrapping is intentional friction.

export interface KpiTileProps {
  /** Small Lucide-style svg, currentColor inherits from iconColor. */
  icon?: ReactNode
  iconColor?: string
  /** UPPERCASE-ish short label (renders Title Case, our CSS doesn't
   *  force a case). */
  label: string
  /** Big number / cost / "—" when unknown. */
  value: ReactNode
  /** Optional small caption under the value. Single-line. */
  sub?: ReactNode
}

export function KpiTile({
  icon,
  iconColor,
  label,
  value,
  sub,
}: KpiTileProps): JSX.Element {
  return (
    <div className="kpi-tile">
      <div className="kpi-tile-head">
        {icon !== undefined && (
          <span className="kpi-tile-icon" style={iconColor === undefined ? undefined : { color: iconColor }}>
            {icon}
          </span>
        )}
        <span className="kpi-tile-label">{label}</span>
      </div>
      <div className="kpi-tile-value">{value}</div>
      {sub !== undefined && sub !== null && <div className="kpi-tile-sub">{sub}</div>}
    </div>
  )
}
