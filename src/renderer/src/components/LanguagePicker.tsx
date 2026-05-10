import { useEffect, useRef, useState } from 'react'

import {
  LOCALES,
  LOCALE_AUTO_LABEL,
  LOCALE_LABEL,
  type LocaleSetting,
} from '@shared/i18n/locales'

import { useT } from '../i18n/LocaleProvider'

// Globe-icon button + popover. Mirrors the language picker pattern in
// CLI Pulse / similar menubar apps. Closes on outside click and on
// option select.

export function LanguagePicker(): JSX.Element {
  const { setting, locale, setSetting, t } = useT()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Outside-click + Esc to dismiss.
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

  const select = (next: LocaleSetting): void => {
    setSetting(next)
    setOpen(false)
  }

  // "System Default · English" hints at the resolved language so users
  // can tell what 'auto' is currently giving them.
  const autoLabel = `${LOCALE_AUTO_LABEL[locale]} · ${LOCALE_LABEL[locale]}`

  return (
    <div className="lang-picker" ref={rootRef}>
      <button
        type="button"
        className="footer-icon-btn"
        title={t('langPickerTitle')}
        aria-label={t('langPickerTitle')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
        </svg>
      </button>
      {open && (
        <div className="lang-popover" role="menu">
          {LOCALES.map((l) => (
            <button
              key={l}
              role="menuitemradio"
              aria-checked={setting === l}
              type="button"
              className="lang-option"
              onClick={() => select(l)}
            >
              <span className="lang-check" aria-hidden>{setting === l ? '✓' : ''}</span>
              <span>{LOCALE_LABEL[l]}</span>
            </button>
          ))}
          <div className="lang-divider" />
          <button
            role="menuitemradio"
            aria-checked={setting === 'auto'}
            type="button"
            className="lang-option"
            onClick={() => select('auto')}
          >
            <span className="lang-check" aria-hidden>{setting === 'auto' ? '✓' : ''}</span>
            <span>{autoLabel}</span>
          </button>
        </div>
      )}
    </div>
  )
}
