import { useT } from '../i18n/LocaleProvider'

import { LanguagePicker } from './LanguagePicker'

// Tray-panel footer. Mirrors the CLI-Pulse-style chrome row: app
// version on the left, action icons on the right (refresh + language
// + quit). The refresh icon is a duplicate of the header refresh —
// the two surface the same affordance so users who scroll to the
// bottom of a long tab don't have to scroll back up to trigger it.

export interface FooterProps {
  version: string
  refreshing: boolean
  onRefresh: () => void
  onQuit: () => void
}

export function Footer({ version, refreshing, onRefresh, onQuit }: FooterProps): JSX.Element {
  const { t } = useT()
  return (
    <footer className="tray-footer">
      <span className="tray-footer-version">{t('footerVersion', { version })}</span>
      <div className="tray-footer-actions">
        <button
          type="button"
          className="footer-icon-btn"
          title={refreshing ? t('refreshing') : t('refresh')}
          aria-label={t('refresh')}
          disabled={refreshing}
          onClick={onRefresh}
        >
          <span className={`footer-icon-glyph ${refreshing ? 'spin' : ''}`} aria-hidden>↻</span>
        </button>
        <LanguagePicker />
        <button
          type="button"
          className="footer-icon-btn"
          title={t('quit')}
          aria-label={t('quit')}
          onClick={onQuit}
        >
          <span className="footer-icon-glyph" aria-hidden>⏻</span>
        </button>
      </div>
    </footer>
  )
}
