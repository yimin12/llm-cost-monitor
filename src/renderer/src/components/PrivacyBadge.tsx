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
      {/* Lucide shield-check */}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    </span>
  )
}
