import type { AggregateSnapshot } from './aggregates'
import type { AuthState } from './auth'

export const IPC = {
  PING: 'ping',
  PRICING_INFO: 'pricing:info',
  STORAGE_INFO: 'storage:info',
  AGGREGATES: 'aggregates:snapshot',
  PROVIDERS_LIST: 'providers:list',
  PROVIDERS_REFRESH: 'providers:refresh',
  AUTH_CURRENT: 'auth:current',
  AUTH_SIGNIN: 'auth:signin',
  AUTH_SIGNOUT: 'auth:signout',
  APP_QUIT: 'app:quit',
} as const

export const EVENT = {
  USAGE_UPDATED: 'usage:updated',
  AUTH_STATE_CHANGED: 'auth:state-changed',
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

export type { AggregateSnapshot, AuthState }
