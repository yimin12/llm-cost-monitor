import { useState } from 'react'

import type { AppSettings } from '@shared/ipc-channels'

// "Yield Score" — total AI cost ÷ number of git commits over a
// rolling window. Visual shell ONLY in this PR — the back-end git
// scanner + commit storage + aggregator wiring is the follow-up PR.
//
// Today the card surfaces:
//   - an empty state pointing at Settings → Privacy when the
//     `trackGitActivity` toggle is off (matches CLI Pulse's
//     opt-in pattern);
//   - a "no commits captured yet" empty state when the toggle is
//     on but the scanner hasn't found anything yet.
//
// Once the scanner is wired, this component will gain a real number
// + sparkline. The period selector below is already wired to a
// local useState so the future hookup is a one-line query change.

type Period = '7d' | '30d' | '90d'

const PERIOD_LABEL: Record<Period, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
}

export function YieldScoreCard({
  settings,
}: {
  settings: AppSettings | null
}): JSX.Element {
  const [period, setPeriod] = useState<Period>('30d')
  const enabled = settings?.privacy?.trackGitActivity === true

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
      {enabled ? (
        <div className="yield-card-empty">
          <p>No commits captured yet for the {PERIOD_LABEL[period].toLowerCase()} window.</p>
          <p className="yield-card-sub">
            The git scanner will pick up new commits on the next refresh tick.
          </p>
        </div>
      ) : (
        <div className="yield-card-empty">
          <p>Track AI cost per commit to see your yield score.</p>
          <p className="yield-card-sub">
            Enable in <strong>Settings → Privacy → Track git activity</strong>.
          </p>
        </div>
      )}
    </section>
  )
}
