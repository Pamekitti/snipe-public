import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { State } from '../core/state.js'
import { haltedEconomyEligibility, quietWallet, type EconomyEligibility } from './economy.js'

export function quietEconomyEligibility(s: State, reconciled: boolean, idle: boolean, socketUp: boolean): EconomyEligibility {
  if (!reconciled) return { eligible: false, reason: 'startup reconciliation is incomplete' }
  if (!idle) return { eligible: false, reason: 'driver has queued work' }
  if (!socketUp || s.sensors.feedConnected?.value !== true || s.sensors.logsHealthy?.value !== true) return { eligible: false, reason: 'a detection stream is unhealthy' }
  if (s.pendingLaunches.size || s.armed.size) return { eligible: false, reason: 'a launch is being evaluated' }
  const settled = quietWallet(s, reconciled, idle)
  if (!settled.eligible) return settled
  if (haltedEconomyEligibility(s, true).eligible) return { eligible: false, reason: 'halted economy owns readiness' }
  return { eligible: true, reason: 'flat between opportunities with healthy paid launch detection' }
}

/** The hold is queued synchronously before a launch reaches the driver. */
export class QuietEconomy {
  private active = false
  private generation = 0
  private work: Promise<void> | null = null
  disabledReason: string | null = null
  lastPreparation: { ok: boolean; ms: number; reason: string; at: number } | null = null
  constructor(private readonly opts: {
    enabled: () => boolean
    eligible: () => EconomyEligibility
    hold: (held: boolean) => void
    prepare: (current: () => boolean) => Promise<void>
    path?: string
    now?: () => number
  }) {
    if (opts.path && existsSync(opts.path)) {
      try { this.disabledReason = JSON.parse(readFileSync(opts.path, 'utf8')).disabledReason ?? null }
      catch { this.disabledReason = 'quiet routing state is unreadable' }
    }
  }
  ownsReadiness(): boolean { return this.active || this.work !== null }
  usePublic(): boolean { return this.active && this.opts.enabled() && !this.disabledReason && this.opts.eligible().eligible }
  preparing(): boolean { return this.work !== null }
  reconcile(): void {
    if (this.work) return
    if (this.active) {
      if (!this.usePublic()) this.interrupt('quiet eligibility ended')
      return
    }
    if (this.opts.enabled() && !this.disabledReason && this.opts.eligible().eligible) {
      this.active = true
      this.opts.hold(true)
    }
  }
  interrupt(reason: string): void {
    if (!this.active || this.work) return
    this.active = false
    const generation = this.generation, now = this.opts.now ?? Date.now, started = now()
    const current = () => generation === this.generation
    // Defer starting IO until this promise is assigned; ingress itself remains synchronous.
    this.work = Promise.resolve().then(() => this.opts.prepare(current)).then(() => {
      if (!current()) return
      this.opts.hold(false)
      this.lastPreparation = { ok: true, ms: now() - started, reason, at: now() }
    }).catch(e => {
      if (!current()) return
      this.disable(`quiet preparation failed: ${String((e as Error).message ?? e)}`)
      this.lastPreparation = { ok: false, ms: now() - started, reason: this.disabledReason!, at: now() }
    }).finally(() => { this.work = null })
  }
  cancel(): void { this.generation++; this.active = false }
  disable(reason: string): void {
    this.disabledReason = reason.replace(/(?:https?|wss?):\/\/\S+/gi, '[RPC]').slice(0, 160)
    this.active = false
    if (this.opts.path) {
      try { writeFileSync(`${this.opts.path}.tmp`, JSON.stringify({ disabledReason: this.disabledReason })); renameSync(`${this.opts.path}.tmp`, this.opts.path) }
      catch { /* routing remains disabled in memory */ }
    }
  }
}
