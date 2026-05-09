import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installBrowserStub } from './browser-stub'
import { WebDashboard } from './WebDashboard'
import './styles.css'
import './web.css'

// Detect Electron vs browser. Electron sets userAgent to include "Electron";
// in a regular browser tab we get a normal Chrome/Safari/Firefox UA. The
// renderer ships exactly one of two surfaces:
//   - Electron tray:  compact 390×720 multi-tab dropdown panel (App.tsx)
//   - Browser tab:    full-page responsive dashboard (WebDashboard.tsx)
const isElectron = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent)

if (!isElectron) {
  // Browser-only: tag <html> so web.css can claim the page chrome (full-bleed
  // dark background, no tray-panel sizing constraints) without affecting the
  // Electron build.
  document.documentElement.classList.add('web')
  installBrowserStub()
}

const rootEl = document.getElementById('root')
if (rootEl === null) {
  throw new Error('Root element not found')
}

createRoot(rootEl).render(
  <StrictMode>
    {isElectron ? <App /> : <WebDashboard />}
  </StrictMode>,
)
