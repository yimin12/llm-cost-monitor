// Standalone Vite config for the renderer — used when serving the WebDashboard
// surface directly via `vite dev` (no Electron). The full Electron build still
// goes through electron-vite at the repo root; this file only mirrors the
// renderer-side aliases so `@shared/*` resolves the same way.
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, '../shared'),
    },
  },
})
