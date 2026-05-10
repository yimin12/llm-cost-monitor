import { useEffect, useState } from 'react'

import type { AuthState } from '@shared/ipc-channels'

// Tiny shield icon that hosts the full "on-device only" trust
// statement in its tooltip. Replaces the multi-line PrivacyBanner —
// the message is important enough to surface but it almost never
// changes, so a hover-revealed tooltip is the right footprint.

export function PrivacyBadge(): JSX.Element {
  const [state, setState] = useState<AuthState>({ kind: 'signed-out' })

  useEffect(() => {
    void window.api.authCurrent().then(setState)
    return window.api.onAuthStateChanged(setState)
  }, [])

  const signedInEmail = state.kind === 'signed-in' ? state.user.email : null

  const tooltip =
    signedInEmail !== null
      ? `On-device only. Session logs scanned locally; no telemetry, no cloud sync.\nSigned in as ${signedInEmail} for identity only — no usage data is uploaded.`
      : 'On-device only. Session logs scanned locally; no telemetry, no cloud sync.'

  return (
    <span
      className="privacy-badge"
      title={tooltip}
      aria-label={tooltip}
      role="img"
    >
      {/* Lucide help-circle. Reads as "more info on hover" — the
          shield-check at 12px was hard to recognise and looked like
          a question mark anyway, so we lean into that semantic. */}
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
        <line x1="12" x2="12.01" y1="17" y2="17" />
      </svg>
    </span>
  )
}
