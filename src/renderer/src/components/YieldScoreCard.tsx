import { useCallback, useEffect, useState } from 'react'

import type { AppSettings, YieldScoreSnapshot } from '@shared/ipc-channels'

import { KpiTile } from './KpiTile'

// Yield Score card. CLI-Pulse-style sparse KPI grid — each tile is
// "small icon + short label (UPPERCASE) + big value". Three tiles
// (cost/commit · commits · active repos) keep the card legible at
// a glance without piling on the same number we already show in the
// forecast row above.

type Period = '7d' | '30d' | '90d'

const PERIOD_LABEL: Record<Period, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
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
}: {
  settings: AppSettings | null
}): JSX.Element {
  const [period, setPeriod] = useState<Period>('30d')
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
        <select
          className="yield-period"
          value={period}
          onChange={(e) => setPeriod(e.currentTarget.value as Period)}
          aria-label="Period"
          disabled={!enabled}
        >
          {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
            <option key={p} value={p}>{PERIOD_LABEL[p]}</option>
          ))}
        </select>
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
