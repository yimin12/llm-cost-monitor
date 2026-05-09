import { useEffect, useState } from 'react'

import type { AuthState } from '@shared/ipc-channels'

// Footer privacy banner. Adapts to auth state — when signed-in, surfaces the
// "no usage data uploaded" promise alongside the user's email so the trust
// statement is exactly where the user expects it.
export function PrivacyBanner(): JSX.Element {
  const [state, setState] = useState<AuthState>({ kind: 'signed-out' })

  useEffect(() => {
    void window.api.authCurrent().then(setState)
    return window.api.onAuthStateChanged(setState)
  }, [])

  const signedInEmail = state.kind === 'signed-in' ? state.user.email : null

  return (
    <section className="privacy">
      <p className="privacy-line">
        <strong>On-device only.</strong> Session logs scanned locally; no
        telemetry, no cloud sync.
      </p>
      {signedInEmail !== null && (
        <p className="privacy-line subtle">
          Signed in as <code>{signedInEmail}</code> for identity only — no
          usage data is uploaded.
        </p>
      )}
    </section>
  )
}
