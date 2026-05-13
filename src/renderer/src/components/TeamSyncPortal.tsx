import { useCallback, useEffect, useState } from 'react'

import type { AuthState } from '@shared/ipc-channels'

// Prominent pre-login banner shown on the Overview tab when team sync is
// configured but the user hasn't signed in yet (or sign-in failed). The
// existing AuthHeader chip in the corner is too small to motivate the
// "you need to sign in to see your other machines" story, so we lift it
// into a full-width card that explains the value first, then offers the
// button. Once the user is signed in this component renders null and
// gets out of the way.

export function TeamSyncPortal({
  // teamSync flag passed in by the parent — when false the portal stays
  // hidden regardless of auth state (the user hasn't opted into team
  // sync, so prompting for sign-in would be noise).
  teamSyncEnabled,
}: {
  teamSyncEnabled: boolean
}): JSX.Element | null {
  const [state, setState] = useState<AuthState>({ kind: 'signed-out' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.authCurrent().then(setState)
    return window.api.onAuthStateChanged(setState)
  }, [])

  const signIn = useCallback(async () => {
    setBusy(true)
    try {
      const next = await window.api.authSignIn()
      setState(next)
    } finally {
      setBusy(false)
    }
  }, [])

  // Render conditions: team sync configured + user not yet signed in.
  // Errors during sign-in attempt also surface here (better than the
  // tiny error chip in AuthHeader).
  if (!teamSyncEnabled) return null
  if (state.kind === 'signed-in') return null

  const errMsg = state.kind === 'error' ? state.message : null

  return (
    <section className="team-portal" role="region" aria-label="Sign in to team sync">
      <div className="team-portal-body">
        <div className="team-portal-icon" aria-hidden>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="1.8"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="9" height="11" rx="2" />
            <rect x="12" y="9" width="9" height="11" rx="2" />
            <path d="M7 19h2M16 19h2" />
          </svg>
        </div>
        <div className="team-portal-text">
          <h3>Sign in to link your devices</h3>
          <p>
            Team sync needs your Google identity to know which machines
            belong to you. Once signed in, every Mac you use this account
            on shows up under one merged total.
          </p>
          {errMsg !== null && (
            <p className="team-portal-error" title={errMsg}>
              Last sign-in attempt failed. Open the menu-bar tray for
              the full error, or try again.
            </p>
          )}
        </div>
      </div>
      <button
        type="button"
        className="team-portal-cta"
        disabled={busy}
        onClick={() => void signIn()}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
          <path fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
          <path fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg>
        {state.kind === 'signing-in' ? 'Signing in…' : 'Sign in with Google'}
      </button>
    </section>
  )
}
