import { useCallback, useEffect, useState } from 'react'

import type { AuthState } from '@shared/ipc-channels'

// Window.api typing lives in App.tsx (single source of truth across renderer).
interface AuthHeaderProps {
  className?: string
}

export function AuthHeader({ className }: AuthHeaderProps): JSX.Element {
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

  const signOut = useCallback(async () => {
    setBusy(true)
    try {
      const next = await window.api.authSignOut()
      setState(next)
    } finally {
      setBusy(false)
    }
  }, [])

  if (state.kind === 'signed-in') {
    return (
      <div className={`auth-header ${className ?? ''}`}>
        {state.user.pictureUrl !== null && (
          <img className="auth-avatar" src={state.user.pictureUrl} alt="" />
        )}
        <span className="auth-email" title={state.user.email}>
          {state.user.email}
        </span>
        <button
          type="button"
          className="auth-btn"
          disabled={busy}
          onClick={() => void signOut()}
        >
          Sign out
        </button>
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className={`auth-header ${className ?? ''}`}>
        <span className="auth-error" title={state.message}>
          ⚠ {state.message}
        </span>
        <button
          type="button"
          className="auth-btn"
          disabled={busy}
          onClick={() => void signIn()}
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className={`auth-header ${className ?? ''}`}>
      <button
        type="button"
        className="auth-btn"
        disabled={busy}
        onClick={() => void signIn()}
      >
        {state.kind === 'signing-in' ? 'Signing in…' : 'Sign in with Google'}
      </button>
    </div>
  )
}
