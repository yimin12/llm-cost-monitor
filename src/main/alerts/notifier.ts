import { Notification } from 'electron'

import type { SettingsStore } from '../settings/store'

// Thin wrapper over Electron's Notification. macOS surfaces these as native
// banners; Linux uses libnotify. We only fire once per fresh raise — dedup
// happens upstream in AlertRepository.
export class AlertNotifier {
  constructor(private readonly settings: SettingsStore) {}

  fire(items: { title: string; body: string; severity: string }[]): void {
    if (items.length === 0) return
    if (!this.settings.get().alerts.notifications) return
    if (!Notification.isSupported()) return

    // Only critical alerts surface as OS popups. Warnings live in the
    // dropdown and never interrupt the user — see docs/alerts.md.
    const critical = items.filter((i) => i.severity === 'critical')
    if (critical.length === 0) return

    // If multiple alerts raised in the same tick, collapse into one
    // notification rather than spamming the user. macOS will badge the dock
    // anyway; we don't need 4 banners stacking.
    if (critical.length === 1) {
      const item = critical[0]!
      new Notification({
        title: item.title,
        body: item.body,
        silent: false,
        urgency: 'critical',
      }).show()
      return
    }

    new Notification({
      title: `${critical.length} alerts raised`,
      body: critical.map((i) => `• ${i.title}`).join('\n'),
      silent: false,
    }).show()
  }
}
