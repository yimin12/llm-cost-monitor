import { useCallback, useEffect, useState } from 'react'

import type { AuthUser } from '@shared/auth'
import type { AuthState } from '@shared/ipc-channels'

// Window.api typing lives in App.tsx (single source of truth across renderer).
interface AuthHeaderProps {
  className?: string
}

// Stable hue per email so the fallback letter avatar is consistent for the
// same user across launches. Cheap hash → 0..359°.
function hueForEmail(email: string): number {
  let h = 0
  for (let i = 0; i < email.length; i++) {
    h = (h * 31 + email.charCodeAt(i)) >>> 0
  }
  return h % 360
}

function Avatar({ user }: { user: AuthUser }): JSX.Element {
  const [imgFailed, setImgFailed] = useState(false)
  const initial = (user.name?.charAt(0) ?? user.email.charAt(0)).toUpperCase()
  const hue = hueForEmail(user.email)
  const fallbackBg = `linear-gradient(135deg, hsl(${hue} 65% 55%), hsl(${(hue + 40) % 360} 65% 45%))`

  // Tooltip-on-hover surfaces the email/name when the inline variant
  // hides the .auth-identity column — without this, a user with two
  // accounts can't tell who's signed in from the avatar alone.
  const tooltip =
    user.name !== null && user.name !== user.email
      ? `${user.name} (${user.email})`
      : user.email

  if (user.pictureUrl !== null && !imgFailed) {
    return (
      <img
        className="auth-avatar"
        src={user.pictureUrl}
        alt={user.name ?? user.email}
        title={tooltip}
        // Google sometimes serves the image with referrer-blocked headers; if
        // the load fails we fall back to the colored letter so we never show
        // a broken-image icon.
        onError={() => setImgFailed(true)}
        referrerPolicy="no-referrer"
        // Crossorigin avoids a CORB warning some Electron versions log when
        // loading lh3.googleusercontent.com without explicit consent.
        crossOrigin="anonymous"
      />
    )
  }
  return (
    <span
      className="auth-avatar auth-avatar-fallback"
      style={{ background: fallbackBg }}
      aria-label={tooltip}
      title={tooltip}
    >
      {initial}
    </span>
  )
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
      <div className={`auth-header signed-in ${className ?? ''}`}>
        <Avatar user={state.user} />
        <div className="auth-identity">
          {state.user.name !== null && (
            <span className="auth-name" title={state.user.name}>
              {state.user.name}
            </span>
          )}
          <span className="auth-email" title={state.user.email}>
            {state.user.email}
          </span>
        </div>
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
        className="auth-btn auth-btn-primary"
        disabled={busy}
        onClick={() => void signIn()}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg>
        {state.kind === 'signing-in' ? 'Signing in…' : 'Sign in with Google'}
      </button>
    </div>
  )
}
