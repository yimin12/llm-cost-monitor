import { useCallback, useEffect, useState } from 'react'

import type { AppSettings, YieldScoreSnapshot } from '@shared/ipc-channels'

import { KpiTile } from './KpiTile'

// Yield Score card. CLI-Pulse-style sparse KPI grid — each tile is
// "small icon + short label (UPPERCASE) + big value". Three tiles
// (cost/commit · commits · active repos) keep the card legible at
// a glance without piling on the same number we already show in the
// forecast row above.

// Yield's own window vocabulary is fixed (the git scanner pre-buckets
// at these granularities). The Overview's outer period selector has a
// wider vocabulary (today / 7d / 1m / 6m / 1y); map onto the nearest
// available bucket so the user gets *something* sensible when they
// pick "today" or "6m".
type YieldPeriod = '7d' | '30d' | '90d'

// Outer Overview period — re-declared here so we don't drag the type
// out into shared. Kept in sync with src/renderer/src/tabs/OverviewTab.tsx.
type OuterPeriod = 'today' | '7d' | '1m' | '6m' | '1y'

const PERIOD_LABEL: Record<YieldPeriod, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
}

// Outer → inner mapping. "today" rounds up to 7d because git activity
// over a few hours rarely paints a useful chart; "6m"/"1y" cap at 90d
// (the largest the git scanner pre-buckets).
function outerToYieldPeriod(p: OuterPeriod): YieldPeriod {
  switch (p) {
    case 'today':
    case '7d':
      return '7d'
    case '1m':
      return '30d'
    case '6m':
    case '1y':
      return '90d'
  }
}

function microPerCommitDisplay(microPerCommit: string | null): string {
  if (microPerCommit === null) return '—'
  const cents = Number(BigInt(microPerCommit) / 10_000n) / 100
  if (Math.abs(cents) >= 100) return `$${cents.toFixed(1)}`
  return `$${cents.toFixed(2)}`
}

// Lucide-style line icons sized for the small tile head.
const IconCoin = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v10M9 9.5h4a1.5 1.5 0 1 1 0 3h-2a1.5 1.5 0 1 0 0 3h4" />
  </svg>
)
const IconGitCommit = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="3" />
    <path d="M3 12h6M15 12h6" />
  </svg>
)
const IconFolder = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
)
const IconSpark = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
  </svg>
)

export function YieldScoreCard({
  settings,
  outerPeriod,
}: {
  settings: AppSettings | null
  // When provided, the card follows the Overview's period selector and
  // hides its own dropdown. When omitted, falls back to internal state
  // so older callers (tray-only embeds) keep working.
  outerPeriod?: OuterPeriod
}): JSX.Element {
  const [internalPeriod, setInternalPeriod] = useState<YieldPeriod>('30d')
  const period: YieldPeriod =
    outerPeriod !== undefined ? outerToYieldPeriod(outerPeriod) : internalPeriod
  const [snap, setSnap] = useState<YieldScoreSnapshot | null>(null)
  const enabled = settings?.privacy?.trackGitActivity === true

  const reload = useCallback(async () => {
    setSnap(null)
    const r = await window.api.yieldScore(period)
    setSnap(r)
  }, [period])

  useEffect(() => {
    if (enabled) void reload()
    else setSnap(null)
  }, [enabled, period, reload])

  return (
    <section className="yield-card">
      <header className="yield-card-head">
        <div className="yield-card-title">
          <span className="yield-card-glyph" aria-hidden style={{ color: 'rgba(255, 200, 100, 0.9)' }}>
            {IconSpark}
          </span>
          <span className="yield-card-name">Yield Score</span>
          <span className="yield-card-tag">Estimated</span>
        </div>
        {outerPeriod === undefined ? (
          <select
            className="yield-period"
            value={period}
            onChange={(e) => setInternalPeriod(e.currentTarget.value as YieldPeriod)}
            aria-label="Period"
            disabled={!enabled}
          >
            {(Object.keys(PERIOD_LABEL) as YieldPeriod[]).map((p) => (
              <option key={p} value={p}>{PERIOD_LABEL[p]}</option>
            ))}
          </select>
        ) : (
          // Follows the Overview's outer selector — render a read-only
          // tag so the user can still see which bucket they're in.
          <span className="yield-period-tag" title="Follows the period selector above">
            {PERIOD_LABEL[period]}
          </span>
        )}
      </header>

      {!enabled && (
        <div className="yield-card-empty">
          <p>Track AI cost per commit to see your yield score.</p>
          <p className="yield-card-sub">
            Enable in <strong>Settings → Privacy → Track git activity</strong>.
          </p>
        </div>
      )}

      {enabled && (
        <div className="kpi-grid kpi-grid-3">
          <KpiTile
            icon={IconCoin}
            iconColor="rgba(120, 200, 140, 0.95)"
            label="Cost / commit"
            value={microPerCommitDisplay(snap?.microPerCommit ?? null)}
            sub={snap !== null && snap.totalCommits === 0 ? 'no commits' : ' '}
          />
          <KpiTile
            icon={IconGitCommit}
            iconColor="rgba(120, 170, 255, 0.95)"
            label="Commits"
            value={snap?.totalCommits.toString() ?? '—'}
            sub={
              snap !== null && snap.totalMerges > 0
                ? `${snap.totalMerges} merge${snap.totalMerges === 1 ? '' : 's'}`
                : ' '
            }
          />
          <KpiTile
            icon={IconFolder}
            iconColor="rgba(255, 180, 120, 0.95)"
            label="Repos"
            value={snap?.repos.length.toString() ?? '—'}
            sub="active"
          />
        </div>
      )}
    </section>
  )
}
