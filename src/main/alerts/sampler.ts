import os from 'node:os'

import type { Aggregator } from '../aggregation/aggregator'
import type { SettingsStore } from '../settings/store'
import type { AlertRepository, RaiseInput } from './alert-repository'

export interface SamplerCallbacks {
  // Called once per fresh raise (not duplicates). Used to fire OS notifications
  // and broadcast to the renderer. Async — sampler doesn't await.
  onRaise: (raises: { title: string; body: string; severity: string }[]) => void
  onAnyChange: () => void
}

// Per-CPU snapshot we diff between samples to compute CPU%. os.cpus() returns
// totals since boot, so a single read is meaningless — we need two snapshots
// across an interval.
interface CpuSnapshot { idle: number; total: number }

function snapshotCpus(): CpuSnapshot[] {
  return os.cpus().map((c) => {
    const total = c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
    return { idle: c.times.idle, total }
  })
}

function cpuPercentBetween(a: CpuSnapshot[], b: CpuSnapshot[]): number {
  let totalDelta = 0
  let idleDelta = 0
  for (let i = 0; i < a.length && i < b.length; i++) {
    totalDelta += b[i]!.total - a[i]!.total
    idleDelta += b[i]!.idle - a[i]!.idle
  }
  if (totalDelta <= 0) return 0
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100))
}

function memPercent(): { pct: number; freeBytes: number; totalBytes: number } {
  const total = os.totalmem()
  const free = os.freemem()
  return { pct: ((total - free) / total) * 100, freeBytes: free, totalBytes: total }
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`
  return `${(n / 1024).toFixed(0)} KB`
}

export class AlertSampler {
  private timer: ReturnType<typeof setInterval> | null = null
  private prevCpu: CpuSnapshot[] | null = null

  constructor(
    private readonly repo: AlertRepository,
    private readonly aggregator: Aggregator,
    private readonly settings: SettingsStore,
    private readonly cb: SamplerCallbacks,
  ) {}

  start(): void {
    if (this.timer !== null) return
    if (!this.settings.get().alerts.enabled) return
    const interval = this.settings.get().alerts.samplingIntervalMs
    // Prime the CPU snapshot so the first tick produces a meaningful delta.
    this.prevCpu = snapshotCpus()
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        console.warn(`alert sampler tick failed: ${(err as Error).message}`)
      })
    }, interval)
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // One sampling pass: collect signals, raise alerts past their thresholds,
  // and fire callbacks for whatever changed.
  async tick(): Promise<void> {
    const settings = this.settings.get()
    if (!settings.alerts.enabled) return

    const unsnoozed = await this.repo.unsnoozeExpired()
    const raises: { title: string; body: string; severity: string }[] = []
    let anyChange = unsnoozed > 0

    // CPU — needs a delta against the previous snapshot.
    const cpuNow = snapshotCpus()
    if (this.prevCpu !== null) {
      const cpuPct = cpuPercentBetween(this.prevCpu, cpuNow)
      if (cpuPct >= settings.alerts.thresholds.cpuPct) {
        const inserted = await this.maybeRaise({
          type: 'system.cpu',
          severity: cpuPct >= 95 ? 'critical' : 'warning',
          title: 'Device CPU usage is elevated',
          body: `helper sampled CPU usage at ${cpuPct.toFixed(0)}%.`,
          signature: 'system.cpu',
          metadata: { cpuPct },
        })
        if (inserted !== null) raises.push(inserted)
      }
    }
    this.prevCpu = cpuNow

    // Memory — single sample is enough (free vs total).
    const mem = memPercent()
    if (mem.pct >= settings.alerts.thresholds.memPct) {
      const inserted = await this.maybeRaise({
        type: 'system.memory',
        // Always warning — modern OSes (especially macOS) report >95% mem
        // routinely thanks to file-cache reuse; that's not a "critical"
        // condition users need to be roused for. Critical is reserved for
        // alerts the user actually wants a popup + tray icon swap on.
        severity: 'warning',
        title: 'Device memory is running low',
        body: `${fmtBytes(mem.freeBytes)} free of ${fmtBytes(mem.totalBytes)} (${mem.pct.toFixed(0)}% used).`,
        signature: 'system.memory',
        metadata: { memPct: mem.pct, freeBytes: mem.freeBytes, totalBytes: mem.totalBytes },
      })
      if (inserted !== null) raises.push(inserted)
    }

    // Cost — uses today's total + monthly forecast from the existing
    // aggregator. Cheap; both are already cached for the snapshot pipeline.
    const snap = await this.aggregator.snapshot()
    const todayUsd = Number(snap.today.costMicroUsd) / 1_000_000

    if (
      settings.alerts.thresholds.dailyCostUsd !== null &&
      todayUsd >= settings.alerts.thresholds.dailyCostUsd
    ) {
      const inserted = await this.maybeRaise({
        type: 'cost.daily',
        severity: 'warning',
        title: 'Daily LLM spend threshold reached',
        body: `today's spend is $${todayUsd.toFixed(2)}, above your $${settings.alerts.thresholds.dailyCostUsd} threshold.`,
        signature: `cost.daily.${new Date().toISOString().slice(0, 10)}`,
        metadata: { todayUsd, threshold: settings.alerts.thresholds.dailyCostUsd },
      })
      if (inserted !== null) raises.push(inserted)
    }

    if (
      settings.alerts.thresholds.monthlyForecastUsd !== null &&
      snap.forecast !== null
    ) {
      const forecastUsd = Number(snap.forecast.estimateMicroUsd) / 1_000_000
      if (forecastUsd >= settings.alerts.thresholds.monthlyForecastUsd) {
        const inserted = await this.maybeRaise({
          type: 'cost.forecast',
          severity: forecastUsd >= settings.alerts.thresholds.monthlyForecastUsd * 1.25
            ? 'critical' : 'warning',
          title: 'Month-end LLM forecast above budget',
          body: `projected spend is ~$${forecastUsd.toFixed(2)}, above your $${settings.alerts.thresholds.monthlyForecastUsd} budget.`,
          signature: `cost.forecast.${new Date().toISOString().slice(0, 7)}`,
          metadata: { forecastUsd, threshold: settings.alerts.thresholds.monthlyForecastUsd },
        })
        if (inserted !== null) raises.push(inserted)
      }
    }

    if (raises.length > 0) {
      this.cb.onRaise(raises)
      anyChange = true
    }
    if (anyChange) this.cb.onAnyChange()
  }

  private async maybeRaise(input: RaiseInput): Promise<{ title: string; body: string; severity: string } | null> {
    const inserted = await this.repo.raiseIfNew(input)
    if (inserted === null) return null
    return { title: inserted.title, body: inserted.body, severity: inserted.severity }
  }
}
