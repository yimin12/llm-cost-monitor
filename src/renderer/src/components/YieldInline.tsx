import { useCallback, useEffect, useState } from 'react'

import type { AppSettings, YieldScoreSnapshot } from '@shared/ipc-channels'

// Compact "Yield Score" row meant to be tucked into another card
// (today: the Month-end forecast). Same data as YieldScoreCard but
// renders as a single horizontal strip — cost/commit, commits count,
// and a tiny period selector — so the user gets the value without
// the card taking its own slot in the Overview stream.

type Period = '7d' | '30d' | '90d'

const PERIOD_LABEL: Record<Period, string> = {
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
}

function microPerCommitDisplay(microPerCommit: string | null): string {
  if (microPerCommit === null) return '—'
  const cents = Number(BigInt(microPerCommit) / 10_000n) / 100
  if (Math.abs(cents) >= 100) return `$${cents.toFixed(1)}`
  return `$${cents.toFixed(2)}`
}

export function YieldInline({
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

  if (!enabled) {
    return (
      <div className="yield-inline yield-inline-disabled">
        <span className="yield-inline-label">Yield</span>
        <span className="yield-inline-cta">
          Enable in Settings → Privacy → Track git activity to see cost / commit.
        </span>
      </div>
    )
  }

  return (
    <div className="yield-inline">
      <span className="yield-inline-label">Yield</span>
      <span className="yield-inline-metric">
        <strong>{microPerCommitDisplay(snap?.microPerCommit ?? null)}</strong>
        <span className="yield-inline-sub">/ commit</span>
      </span>
      <span className="yield-inline-metric">
        <strong>{snap?.totalCommits ?? '—'}</strong>
        <span className="yield-inline-sub">commits</span>
        {snap !== null && snap.totalMerges > 0 && (
          <span className="yield-inline-sub"> · {snap.totalMerges} merge{snap.totalMerges === 1 ? '' : 's'}</span>
        )}
      </span>
      {snap !== null && snap.repos.length > 0 && (
        <span className="yield-inline-metric">
          <strong>{snap.repos.length}</strong>
          <span className="yield-inline-sub">active repo{snap.repos.length === 1 ? '' : 's'}</span>
        </span>
      )}
      <select
        className="yield-inline-period"
        value={period}
        onChange={(e) => setPeriod(e.currentTarget.value as Period)}
        aria-label="Yield period"
      >
        {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
          <option key={p} value={p}>{PERIOD_LABEL[p]}</option>
        ))}
      </select>
    </div>
  )
}
