import { useCallback, useEffect, useState } from 'react'

import type { AppSettings, YieldScoreSnapshot } from '@shared/ipc-channels'

import { microToUsd } from '../lib/format'

// Yield Score = total AI cost ÷ git commits over a rolling window.
//
// When `settings.privacy.trackGitActivity` is on, the renderer pulls a
// snapshot from the main process (which runs the git scanner +
// queries usage_events for the same window). When off, the card
// renders the opt-in CTA without ever calling the IPC.

type Period = '7d' | '30d' | '90d'

const PERIOD_LABEL: Record<Period, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
}

function microPerCommitDisplay(microPerCommit: string | null): string {
  if (microPerCommit === null) return '—'
  // micro USD → dollars with 2 decimals (commits-per-day means cost
  // is usually in the cents–dollars range; 4 decimals would be noisy).
  const cents = Number(BigInt(microPerCommit) / 10_000n) / 100
  if (Math.abs(cents) >= 100) return `$${cents.toFixed(1)}`
  return `$${cents.toFixed(2)}`
}

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
          <span className="yield-card-glyph" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
          </span>
          <span className="yield-card-name">Yield Score</span>
          <span className="yield-card-tag">Estimated</span>
        </div>
        <select
          className="yield-period"
          value={period}
          onChange={(e) => setPeriod(e.currentTarget.value as Period)}
          aria-label="Period"
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

      {enabled && snap === null && (
        <div className="yield-card-empty">
          <p>scanning your repos…</p>
        </div>
      )}

      {enabled && snap !== null && snap.totalCommits === 0 && (
        <div className="yield-card-empty">
          <p>No commits in the {PERIOD_LABEL[period].toLowerCase()} window.</p>
          <p className="yield-card-sub">
            Scanned {snap.repos.length} repo{snap.repos.length === 1 ? '' : 's'} under your home
            directory in {snap.durationMs}ms.
          </p>
        </div>
      )}

      {enabled && snap !== null && snap.totalCommits > 0 && (
        <>
          <div className="yield-kpis">
            <div className="yield-kpi yield-kpi-hero">
              <span className="yield-kpi-label">cost / commit</span>
              <span className="yield-kpi-value">{microPerCommitDisplay(snap.microPerCommit)}</span>
            </div>
            <div className="yield-kpi">
              <span className="yield-kpi-label">total cost</span>
              <span className="yield-kpi-value">{microToUsd(BigInt(snap.costMicroUsd))}</span>
            </div>
            <div className="yield-kpi">
              <span className="yield-kpi-label">commits</span>
              <span className="yield-kpi-value">
                {snap.totalCommits}
                {snap.totalMerges > 0 && (
                  <span className="yield-kpi-sub"> · {snap.totalMerges} merge{snap.totalMerges === 1 ? '' : 's'}</span>
                )}
              </span>
            </div>
          </div>

          <details className="yield-breakdown">
            <summary>
              {snap.repos.length} active repo{snap.repos.length === 1 ? '' : 's'} this window
            </summary>
            <ul className="yield-repo-list">
              {snap.repos.slice(0, 8).map((r) => (
                <li key={r.path}>
                  <span className="yield-repo-name" title={r.path}>{r.name}</span>
                  <span className="yield-repo-count">{r.commits}</span>
                </li>
              ))}
              {snap.repos.length > 8 && (
                <li className="yield-repo-more">+ {snap.repos.length - 8} more</li>
              )}
            </ul>
          </details>
        </>
      )}
    </section>
  )
}
