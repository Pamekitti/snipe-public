/** Public observation while every book is halted, with paid preparation before entry. */
import { APPROVE_KEPT_MS, haltedFor, stoppedKey, type State } from '../core/state.js'

export type EconomyEligibility = { readonly eligible: boolean; readonly reason: string }
export type PreparedResume = { readonly resumed: boolean; readonly why: string }

/** Every configured book must be halted. A mix of venue, drawdown and operator stops qualifies. */
export function haltedEconomyEligibility(state: State, startupReconciled: boolean, driverIdle = true): EconomyEligibility {
  if (!state.config.books.length || !state.config.books.every((book) => haltedFor(state.risk, book.id) !== null)) {
    return { eligible: false, reason: 'at least one book can enter' }
  }
  return quietWallet(state, startupReconciled, driverIdle)
}

export function stoppedEconomyEligibility(
  state: State,
  startupReconciled: boolean,
  driverIdle: boolean,
): EconomyEligibility {
  if (!state.risk.halts.has(stoppedKey(null))) return { eligible: false, reason: 'STOP ALL is not set' }
  return quietWallet(state, startupReconciled, driverIdle)
}

export function quietWallet(state: State, startupReconciled: boolean, driverIdle: boolean): EconomyEligibility {
  if (!startupReconciled) return { eligible: false, reason: 'startup reconciliation is incomplete' }
  const open = [...state.positions.values()].filter((position) => !position.closed).length
  if (open > 0) return { eligible: false, reason: `${open} open position(s)` }
  if (state.nonce.inFlight > 0) return { eligible: false, reason: `${state.nonce.inFlight} nonce action(s) unresolved` }
  for (const tx of state.inflight.values()) {
    if (tx.kind !== 'approve' || tx.hash || tx.signedAt > 0 || state.at - tx.raisedAt <= APPROVE_KEPT_MS) {
      return { eligible: false, reason: `${tx.kind} transaction unresolved` }
    }
  }
  if (!driverIdle) return { eligible: false, reason: 'the driver still has queued work' }
  return { eligible: true, reason: 'all books are halted, reconciliation is complete, and the wallet is quiet' }
}

/** Routing changes only after the entry hold has reached the fold. Recovery never clears a halt. */
export class HaltedEconomyController {
  private active = false
  private busy = false
  private generation = 0
  private stopped = false
  private retryAt = 0
  preparing = false
  lastPreparation: { ok: boolean; ms: number; reason: string; at: number } | null = null

  constructor(private readonly opts: {
    enabled: () => boolean
    eligibility: (requireIdle: boolean) => EconomyEligibility
    entryReady: () => boolean
    setReady: (ready: boolean) => Promise<void>
    prepare: (stillCurrent: () => boolean) => Promise<void>
    now?: () => number
  }) {}

  usePublic(): boolean { return this.active && !this.preparing && this.opts.enabled() && this.opts.eligibility(false).eligible }
  cancel(): void { this.generation++; this.retryAt = 0 }
  stop(): void { this.stopped = true; this.cancel() }

  async reconcile(): Promise<void> {
    if (this.busy || this.stopped) return
    this.busy = true
    try {
      if (!this.active && this.opts.enabled() && this.opts.eligibility(false).eligible
        && !this.opts.eligibility(true).eligible) return
      const wanted = this.opts.enabled() && this.opts.eligibility(!this.active).eligible
      if (wanted) {
        if (this.opts.entryReady()) await this.opts.setReady(false)
        this.active = true
        return
      }
      this.active = false
      if (this.opts.entryReady()) return
      const now = this.opts.now ?? Date.now
      if (now() < this.retryAt) return
      const generation = this.generation
      const current = () => !this.stopped && generation === this.generation
      const start = now()
      this.preparing = true
      try {
        await this.opts.prepare(current)
        if (!current()) throw new Error('preparation cancelled by a newer control')
        // A new halt during catch-up keeps the hold and returns to public observation.
        if (this.opts.enabled() && this.opts.eligibility(false).eligible) return
        await this.opts.setReady(true)
        this.lastPreparation = { ok: true, ms: now() - start, reason: 'paid catch-up processed', at: now() }
      } catch (error) {
        this.lastPreparation = { ok: false, ms: now() - start, reason: String((error as Error).message ?? error), at: now() }
        this.retryAt = now() + 1_000
      } finally { this.preparing = false }
    } finally { this.busy = false }
  }
}

/** Lift STOP only after keyed catch-up, driver processing and a final readiness check. */
export async function runPreparedResume(input: {
  readonly prepare: () => Promise<void>
  readonly ready: () => EconomyEligibility
  readonly stillCurrent: () => boolean
  readonly lift: () => Promise<void>
}): Promise<PreparedResume> {
  try {
    await input.prepare()
    if (!input.stillCurrent()) return { resumed: false, why: 'resume preparation was cancelled by a newer STOP' }
    const ready = input.ready()
    if (!ready.eligible) return { resumed: false, why: ready.reason }
    await input.lift()
    if (!input.stillCurrent()) return { resumed: false, why: 'resume preparation was cancelled by a newer STOP' }
    return { resumed: true, why: 'automatic operation resumed after paid catch-up' }
  } catch (error) {
    return { resumed: false, why: String((error as Error).message ?? error) }
  }
}
