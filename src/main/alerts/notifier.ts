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

    // If multiple alerts raised in the same tick, collapse into one
    // notification rather than spamming the user. macOS will badge the dock
    // anyway; we don't need 4 banners stacking.
    if (items.length === 1) {
      const item = items[0]!
      new Notification({
        title: item.title,
        body: item.body,
        silent: false,
        urgency: item.severity === 'critical' ? 'critical' : 'normal',
      }).show()
      return
    }

    new Notification({
      title: `${items.length} alerts raised`,
      body: items.map((i) => `• ${i.title}`).join('\n'),
      silent: false,
    }).show()
  }
}
