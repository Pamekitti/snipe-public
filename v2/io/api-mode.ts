import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { quietWallet, type EconomyEligibility } from './economy.js'
import type { State } from '../core/state.js'

export type ApiMode = 'economy' | 'paid'
export type RecoveryContext = { readonly id: string; readonly valid: () => boolean }
export type ApiModeStatus = {
  readonly selected: ApiMode
  readonly effective: ApiMode
  readonly preparing: boolean
  readonly changedAt: number | null
  readonly error: string | null
  readonly paidExitRescue: 'uncapped'
}

export function apiModeFrom(vars: ReadonlyMap<string, string>): ApiMode {
  const value = vars.get('API_MODE') ?? 'paid'
  if (value !== 'economy' && value !== 'paid') throw new Error('API_MODE must be economy or paid')
  return value
}

export function apiSwitchEligibility(s: State, reconciled: boolean, idle: boolean): EconomyEligibility {
  const quiet = quietWallet(s, reconciled, idle)
  if (!quiet.eligible) return quiet
  if (s.pendingLaunches.size || s.armed.size) return { eligible: false, reason: 'a launch is still being evaluated' }
  return { eligible: true, reason: 'the wallet and driver are clear' }
}

/** An owner is required for paid recovery. A pending new launch is never an owner. */
export function recoveryOwner(s: State, what: string, args: readonly string[]): string | null {
  const positions = [...s.positions.values()].filter(p => !p.closed)
  const signed = [...s.inflight.values()].filter(t => Boolean(t.hash) || t.signedAt > 0)
  if (what === 'nonce' || what === 'exit-gas') return signed[0]?.intentId ?? positions[0]?.id ?? null
  if (what === 'receipt') {
    const hash = args[0]?.toLowerCase()
    if (!hash) return null
    const tx = signed.find(t => t.hash.toLowerCase() === hash)
    if (tx) return tx.intentId
    return positions.find(p => p.approval?.hash?.toLowerCase() === hash
      || p.grad?.awaitingReceipt?.toLowerCase() === hash || p.sellReceipts?.has(hash))?.id ?? null
  }
  if (['position-wallet', 'allowance', 'grad-pool', 'grad-wallet', 'exit-sign'].includes(what)) {
    return positions.find(p => p.token.toLowerCase() === args[0]?.toLowerCase())?.id ?? null
  }
  if (what === 'curve' || (what === 'meta' && !s.pendingLaunches.has(args[0] ?? ''))) {
    return positions.find(p => p.curve.toLowerCase() === args[0]?.toLowerCase())?.id
      ?? signed.find(t => t.kind === 'buy' && t.curve.toLowerCase() === args[0]?.toLowerCase())?.intentId ?? null
  }
  return null
}

export function saveApiMode(path: string, mode: ApiMode): void {
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n').filter(line => !/^\s*API_MODE\s*=/.test(line))
  const temporary = `${path}.api-mode.tmp`
  try {
    writeFileSync(temporary, `${lines.join('\n').trimEnd()}\nAPI_MODE=${mode}\n`, { mode: statSync(path).mode & 0o777 })
    renameSync(temporary, path)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* no partial selection remains */ }
    throw error
  }
}

export class ApiModeController {
  private selected: ApiMode
  private target: ApiMode | null = null
  private generation = 0
  private changedAt: number | null = null
  private error: string | null = null
  private held = false
  private busy = false

  constructor(private readonly path: string, vars: ReadonlyMap<string, string>, private readonly now = Date.now) {
    this.selected = apiModeFrom(vars)
  }

  mode(): ApiMode { return this.target ?? this.selected }
  preparing(): boolean { return this.busy }
  ownsReadiness(): boolean { return this.preparing() || this.held }
  cancel(): void { this.generation++ }
  status(): ApiModeStatus {
    return { selected: this.selected, effective: this.mode(), preparing: this.preparing(),
      changedAt: this.changedAt, error: this.error, paidExitRescue: 'uncapped' }
  }

  /** The paid fallback exists only for an obligation that is still owned when it fails. */
  async request<T>(publicRead: () => Promise<T>, paidRead: (() => Promise<T>) | null, recovery?: RecoveryContext): Promise<T> {
    if (this.mode() === 'paid' && paidRead) {
      try { return await paidRead() } catch { return publicRead() }
    }
    try { return await publicRead() } catch (error) {
      if (!paidRead || !recovery?.valid() || this.mode() !== 'economy') throw error
      return paidRead()
    }
  }

  async change(raw: unknown, hooks: {
    eligibility: () => EconomyEligibility
    hold: (held: boolean) => Promise<void>
    prepare: (mode: ApiMode, current: () => boolean) => Promise<void>
    routingChanged: () => void
  }): Promise<{ do: 'set-api-mode' | 'nothing'; code: number; why: string; apiMode?: ApiMode }> {
    if (raw !== 'economy' && raw !== 'paid') return { do: 'nothing', code: 400, why: 'apiMode must be economy or paid' }
    if (this.preparing()) return { do: 'nothing', code: 409, why: 'an API change is already preparing' }
    if (raw === this.selected && !this.held) return { do: 'nothing', code: 200, why: `already using ${raw}` }
    if (raw === 'economy') {
      const eligible = hooks.eligibility()
      if (!eligible.eligible) return { do: 'nothing', code: 409, why: eligible.reason }
    }
    const generation = ++this.generation
    const current = () => generation === this.generation
    this.held = true
    this.busy = true
    this.error = null
    // Publish preparing before the first await, so a second control cannot enter.
    this.target = raw
    try {
      await hooks.hold(true)
      if (!current()) throw new Error('API change cancelled by STOP')
      hooks.routingChanged()
      await hooks.prepare(raw, current)
      if (!current()) throw new Error('API change cancelled by STOP')
      if (raw === 'economy') {
        const eligible = hooks.eligibility()
        if (!eligible.eligible) throw new Error(eligible.reason)
      }
      saveApiMode(this.path, raw)
      this.selected = raw
      this.changedAt = this.now()
      this.target = null
      hooks.routingChanged()
      await hooks.hold(false)
      this.held = false
      return { do: 'set-api-mode', code: 200, why: `${raw} API routing is ready`, apiMode: raw }
    } catch (error) {
      this.error = String((error as Error).message ?? error).replace(/(?:https?|wss?):\/\/\S+/gi, '[RPC]').slice(0, 160)
      this.target = null
      hooks.routingChanged()
      return { do: 'nothing', code: 409, why: `entries held: ${this.error}` }
    } finally { this.busy = false }
  }

  /** START has performed preparation through the selected mode. */
  ready(): void { this.held = false; this.error = null }
  notReady(reason: string): void { this.held = true; this.error = reason.replace(/(?:https?|wss?):\/\/\S+/gi, '[RPC]').slice(0, 160) }
}
