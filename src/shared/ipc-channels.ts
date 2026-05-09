import type { AggregateSnapshot } from './aggregates'
import type { Alert, AlertFilter, AlertSummary } from './alerts'
import type { AuthState } from './auth'
import type { AppSettings } from './settings'

export const IPC = {
  PING: 'ping',
  PRICING_INFO: 'pricing:info',
  STORAGE_INFO: 'storage:info',
  AGGREGATES: 'aggregates:snapshot',
  PROVIDERS_LIST: 'providers:list',
  PROVIDERS_REFRESH: 'providers:refresh',
  SETTINGS_GET: 'settings:get',
  AUTH_CURRENT: 'auth:current',
  AUTH_SIGNIN: 'auth:signin',
  AUTH_SIGNOUT: 'auth:signout',
  APP_QUIT: 'app:quit',
  DASHBOARD_URL: 'dashboard:url',
  DASHBOARD_OPEN: 'dashboard:open',
  ALERTS_LIST: 'alerts:list',
  ALERTS_SUMMARY: 'alerts:summary',
  ALERTS_ACK: 'alerts:ack',
  ALERTS_RESOLVE: 'alerts:resolve',
  ALERTS_SNOOZE: 'alerts:snooze',
  ALERTS_RESOLVE_ALL: 'alerts:resolveAll',
} as const

export const EVENT = {
  USAGE_UPDATED: 'usage:updated',
  AUTH_STATE_CHANGED: 'auth:state-changed',
  ALERTS_UPDATED: 'alerts:updated',
} as const

export interface PricingInfo {
  snapshotVersion: string
  modelCount: number
}

export interface StorageInfo {
  eventCount: number
}

export interface ProviderListEntry {
  id: string
  name: string
  isEnabled: boolean
  isAvailable: boolean
  cliCommand: string | null
  dashboardUrl: string | null
}

export interface ProviderRefreshResult {
  provider: string
  eventsCount: number
  error: string | null
}

export type { AggregateSnapshot, Alert, AlertFilter, AlertSummary, AppSettings, AuthState }
