import { useEffect, useRef, useState } from 'react'

import type { AuthState } from '@shared/ipc-channels'

// Click-to-reveal privacy info. Used to be a hover-tooltip but native
// title= tooltips have ~1s delay + only appear after you sit still on
// the icon. A click affordance is more obvious and keeps the popover
// open as long as the user needs to read it.

export function PrivacyBadge(): JSX.Element {
  const [state, setState] = useState<AuthState>({ kind: 'signed-out' })
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    void window.api.authCurrent().then(setState)
    return window.api.onAuthStateChanged(setState)
  }, [])

  // Outside-click + Esc to dismiss — same pattern as LanguagePicker.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent): void => {
      if (rootRef.current === null) return
      if (!rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const signedInEmail = state.kind === 'signed-in' ? state.user.email : null

  return (
    <span className="privacy-badge-wrap" ref={rootRef}>
      <button
        type="button"
        className="privacy-badge"
        aria-label="Privacy info"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {/* Lucide help-circle */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" x2="12.01" y1="17" y2="17" />
        </svg>
      </button>
      {open && (
        <div className="privacy-popover" role="dialog">
          <p className="privacy-popover-line">
            <strong>On-device only.</strong> Session logs scanned locally; no
            telemetry, no cloud sync.
          </p>
          {signedInEmail !== null && (
            <p className="privacy-popover-line subtle">
              Signed in as <code>{signedInEmail}</code> for identity only — no
              usage data is uploaded.
            </p>
          )}
        </div>
      )}
    </span>
  )
}
