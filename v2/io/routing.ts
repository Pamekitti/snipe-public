/** Bounded, restart-safe RPC route measurements. This file never enters the trading tape. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CU, CU_PER_BYTE, CU_PER_UNTYPED_REQUEST } from './cu.js'
import type { ApiModeStatus } from './api-mode.js'

export type RpcRoute = 'public' | 'paid'
export type RouteCount = { requests: number; failures: number; fallbacks: number; estimatedComputeUnits: number }
export type RouteMinute = { minute: number; public: RouteCount; paid: RouteCount; traffic?: Record<string, RouteCount> }
export type RpcRoutingStatus = {
  readonly api?: ApiModeStatus & { publicCoverageAgeMs: number | null; failures1h: number; recommendPaid: boolean; reason: string | null }
  readonly paidUsage?: readonly PaidUsageWindow[]
  readonly lastExitRescue?: { at: number; owner: string; method: string } | null
  readonly enabled: boolean
  readonly eligible: boolean
  readonly eligibilityReason: string
  readonly mode: 'disabled' | 'ineligible' | 'public' | 'paid' | 'cooldown' | 'preparing'
  readonly consecutivePublicFailures: number
  readonly cooldownUntil: number
  readonly public: RouteCount
  readonly paid: RouteCount
  readonly recentMinutes: readonly RouteMinute[]
  readonly entryReady?: boolean
  readonly lastPreparation?: { ok: boolean; ms: number; reason: string; at: number } | null
  readonly verifiedCursor?: number
  readonly activeTransport?: 'filter' | 'range'
  readonly filter?: { disabledReason: string | null; repairs: number; polls: number; checked: number }
  readonly cache?: { hits: number; misses: number; invalid: number; shared: number; network: number } | null
  readonly traffic?: Record<string, RouteCount>
  readonly quiet?: { disabledReason: string | null; preparing: boolean }
  readonly comparison?: { used: number; maximum: number } | null
}

type Saved = {
  readonly lastExitRescue?: { at: number; owner: string; method: string } | null
  readonly minutes: RouteMinute[]
  readonly current: RouteMinute
  readonly consecutivePublicFailures: number
  readonly cooldownUntil: number
}

const empty = (): RouteCount => ({ requests: 0, failures: 0, fallbacks: 0, estimatedComputeUnits: 0 })
const fresh = (minute: number): RouteMinute => ({ minute, public: empty(), paid: empty() })
export type PaidUsageWindow = { readonly hours: 24 | 168; readonly label: string; readonly monitoring: { cu: number; requests: number; estimatedUsd: number | null }; readonly rescue: { cu: number; requests: number; estimatedUsd: number | null } }

export class RpcRouteLedger {
  private minutes: RouteMinute[] = []
  private current: RouteMinute
  consecutivePublicFailures = 0
  cooldownUntil = 0
  lastExitRescue: NonNullable<Saved['lastExitRescue']> | null = null
  private usageCache: { at: number; rate: number | null; windows: readonly PaidUsageWindow[] } | null = null

  constructor(private readonly path: string | null, private readonly now: () => number = Date.now, private readonly keep = 10_080) {
    this.current = fresh(this.minute())
    if (!path || !existsSync(path)) return
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8')) as Saved
      if (!Array.isArray(saved.minutes) || !Number.isFinite(saved.current?.minute)) return
      const history = saved.current.minute < this.minute() ? [...saved.minutes, saved.current] : saved.minutes
      this.minutes = history.filter(row => row.minute >= this.minute() - keep * 60_000).slice(-keep)
      this.current = saved.current.minute === this.minute() ? saved.current : fresh(this.minute())
      this.consecutivePublicFailures = Math.max(0, Number(saved.consecutivePublicFailures) || 0)
      this.cooldownUntil = Math.max(0, Number(saved.cooldownUntil) || 0)
      this.lastExitRescue = saved.lastExitRescue ?? null
    } catch { /* a measurement file never blocks the bot */ }
  }

  request(route: RpcRoute, method: string, purpose = 'logs', phase = 'critical', recoveryId?: string): void {
    this.roll()
    this.current[route].requests++
    this.current[route].estimatedComputeUnits += CU[method] ?? CU_PER_UNTYPED_REQUEST
    const row = this.traffic(route, method, purpose, phase)
    row.requests++; row.estimatedComputeUnits += CU[method] ?? CU_PER_UNTYPED_REQUEST
    if (route === 'paid' && purpose === 'exit-rescue' && recoveryId) {
      this.lastExitRescue = { at: this.now(), owner: recoveryId.slice(0, 160), method }
    }
  }

  subscription(bytes: number, phase: string): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return
    this.roll()
    const units = bytes * CU_PER_BYTE
    this.current.paid.estimatedComputeUnits += units
    this.traffic('paid', 'subscription', 'logs', phase).estimatedComputeUnits += units
  }

  paidUsage(usdPerMillion: number | null): readonly PaidUsageWindow[] {
    this.roll()
    const now = this.now()
    if (this.usageCache && this.usageCache.rate === usdPerMillion && now >= this.usageCache.at && now - this.usageCache.at < 1_000) return this.usageCache.windows
    const windows = ([24, 168] as const).map(hours => {
      const monitoring = { cu: 0, requests: 0, estimatedUsd: null as number | null }
      const rescue = { cu: 0, requests: 0, estimatedUsd: null as number | null }
      for (const minute of [...this.minutes, this.current]) {
        if (minute.minute < now - hours * 3_600_000) continue
        if (!minute.traffic) {
          monitoring.cu += minute.paid.estimatedComputeUnits; monitoring.requests += minute.paid.requests
          continue
        }
        for (const [key, row] of Object.entries(minute.traffic ?? {})) {
          const [, purpose, route] = key.split(':')
          if (route !== 'paid') continue
          const bucket = purpose === 'exit-rescue' ? rescue : monitoring
          bucket.cu += row.estimatedComputeUnits; bucket.requests += row.requests
        }
      }
      if (usdPerMillion !== null) {
        monitoring.estimatedUsd = monitoring.cu * usdPerMillion / 1_000_000
        rescue.estimatedUsd = rescue.cu * usdPerMillion / 1_000_000
      }
      return { hours, label: hours === 24 ? '24h' : '7d', monitoring, rescue }
    })
    this.usageCache = { at: now, rate: usdPerMillion, windows }
    return windows
  }

  failure(route: RpcRoute, method = 'unknown', purpose = 'logs', phase = 'critical'): void {
    this.roll(); this.current[route].failures++; this.traffic(route, method, purpose, phase).failures++
  }
  fallback(route: RpcRoute, method = 'unknown', purpose = 'logs', phase = 'critical'): void {
    this.roll(); this.current[route].fallbacks++; this.traffic(route, method, purpose, phase).fallbacks++
  }
  private traffic(route: RpcRoute, method: string, purpose: string, phase: string): RouteCount {
    const clean = (s: string) => /^[a-zA-Z0-9_-]{1,40}$/.test(s) ? s : 'unknown'
    const key = [phase, purpose, route, method].map(clean).join(':')
    this.current.traffic ??= {}
    return this.current.traffic[key] ??= empty()
  }

  publicSuccess(): void {
    if (this.consecutivePublicFailures === 0 && this.cooldownUntil === 0) return
    this.consecutivePublicFailures = 0
    this.cooldownUntil = 0
    this.persist()
  }

  publicFailure(): void {
    this.consecutivePublicFailures++
    if (this.consecutivePublicFailures >= 2) {
      this.cooldownUntil = this.now() + Math.min(60_000, 5_000 * 2 ** Math.min(4, this.consecutivePublicFailures - 2))
    }
    this.persist()
  }

  status(enabled: boolean, eligible: boolean, preparing = false, eligibilityReason = ''): RpcRoutingStatus {
    this.roll()
    const total = (route: RpcRoute): RouteCount => [this.current, ...this.minutes].reduce((sum, row) => ({
      requests: sum.requests + row[route].requests,
      failures: sum.failures + row[route].failures,
      fallbacks: sum.fallbacks + row[route].fallbacks,
      estimatedComputeUnits: sum.estimatedComputeUnits + row[route].estimatedComputeUnits,
    }), empty())
    const mode = preparing ? 'preparing' : !enabled ? 'disabled' : !eligible ? 'ineligible'
      : this.cooldownUntil > this.now() ? 'cooldown' : 'public'
    const traffic: Record<string, RouteCount> = {}
    for (const minute of [...this.minutes, this.current]) for (const [key, row] of Object.entries(minute.traffic ?? {})) {
      const sum = traffic[key] ??= empty()
      sum.requests += row.requests; sum.failures += row.failures; sum.fallbacks += row.fallbacks; sum.estimatedComputeUnits += row.estimatedComputeUnits
    }
    return {
      enabled, eligible, eligibilityReason, mode,
      consecutivePublicFailures: this.consecutivePublicFailures,
      cooldownUntil: this.cooldownUntil,
      public: total('public'), paid: total('paid'),
      recentMinutes: [...this.minutes.slice(-60), this.current],
      traffic,
    }
  }

  flush(): void { this.persist() }

  private minute(): number { return Math.floor(this.now() / 60_000) * 60_000 }

  private roll(): void {
    const minute = this.minute()
    if (minute === this.current.minute) return
    this.minutes.push(this.current)
    this.minutes = this.minutes.filter(row => row.minute >= minute - this.keep * 60_000).slice(-this.keep)
    this.current = fresh(minute)
    this.persist()
  }

  private persist(): void {
    if (!this.path) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temp = `${this.path}.tmp`
      writeFileSync(temp, JSON.stringify({
        minutes: this.minutes, current: this.current,
        consecutivePublicFailures: this.consecutivePublicFailures,
        cooldownUntil: this.cooldownUntil,
        lastExitRescue: this.lastExitRescue,
      } satisfies Saved))
      renameSync(temp, this.path)
    } catch { /* accounting cannot block observation */ }
  }
}
