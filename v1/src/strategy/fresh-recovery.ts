import { FRESH_POLICY as P } from './fresh-policy.js'
import type { OutcomeValue } from './gate.js'
/** The selected September fresh_s1_w8_b1 state machine. Inputs are net shadow returns. */
export type ShadowOutcome = {
  token: string
  block: number
  launched: number
  available: number
  value: number
}

export type FreshReading = {
  state: 'open' | 'shut'
  sum: number
  recentSum: number
  n: number
  fresh: boolean
  oldestAgeMs: number
  bar: string
  source: 'adaptive-shadow'
  reason: string
  /** the launches behind `sum` and `recentSum`, so the page can show what the guard counted */
  outcomes?: OutcomeValue[]
  recentOutcomes?: OutcomeValue[]
}

export class FreshRecovery {
  private allowed = false
  private cursor: number
  private lastAt = -1
  private last: FreshReading | null = null

  constructor(start: number) { this.cursor = start - 1 }

  snapshot() { return { allowed: this.allowed, cursor: this.cursor, lastAt: this.lastAt, last: this.last } }

  restore(value: ReturnType<FreshRecovery['snapshot']>): void {
    if (typeof value.allowed !== 'boolean' || !Number.isFinite(value.cursor) || !Number.isFinite(value.lastAt)) throw new Error('invalid recovery checkpoint')
    this.allowed = value.allowed; this.cursor = value.cursor; this.lastAt = value.lastAt; this.last = value.last
  }

  /** Operator requests and evidence invalidation require a new publication. */
  pause(at: number): void {
    this.allowed = false
    this.cursor = at
    this.lastAt = -1
  }

  read(records: readonly ShadowOutcome[], at: number): FreshReading {
    if (this.lastAt === at && this.last) return this.last
    const tokens = new Set<string>()
    const invalid = !Number.isFinite(at) || at < this.lastAt || records.some(r => {
      if (!r.token || tokens.has(r.token) || !Number.isFinite(r.value)
        || !Number.isFinite(r.available) || !Number.isFinite(r.launched)
        || !Number.isSafeInteger(r.block) || r.block < 0 || r.available <= r.launched) return true
      tokens.add(r.token)
      return false
    })
    if (invalid) {
      this.pause(at)
      return { state: 'shut', sum: 0, recentSum: 0, n: 0, fresh: false, oldestAgeMs: 0,
        bar: 'adaptive', source: 'adaptive-shadow', reason: 'invalid_evidence' }
    }
    const visible = records.filter(r => r.available <= at)
    const changed = visible.some(r => r.available > this.cursor)
    this.cursor = at
    const twenty = [...visible].sort((a, b) => b.block - a.block || b.token.localeCompare(a.token)).slice(0, P.window)
    const eight = visible.filter(r => at - r.launched <= P.freshMs)
      .sort((a, b) => b.launched - a.launched || b.token.localeCompare(a.token)).slice(0, P.recoveryWindow)
    const oldestAgeMs = twenty.length ? Math.max(...twenty.map(r => at - r.launched)) : 0
    const sum = twenty.reduce((v, r) => v + r.value, 0)
    const recentSum = eight.reduce((v, r) => v + r.value, 0)
    const fresh = twenty.length === P.window && eight.length === P.recoveryWindow && oldestAgeMs <= P.freshMs
    let reason = 'hold'
    if (!fresh) { this.allowed = false; reason = 'stale_or_warmup' }
    else if (this.allowed && sum < P.pauseBelow) { this.allowed = false; reason = 'score_brake' }
    else if (!this.allowed && changed && recentSum > P.recoverAbove) { this.allowed = true; reason = 'fresh_recovery' }
    // The two slices ARE the operator's view of the venue, and until 2026-09-13 only their
    // sums left this function. Hand them out so the page can show the same launches the
    // guard counted, rather than a second query that would drift from it.
    const shown = (rs: readonly ShadowOutcome[]): OutcomeValue[] =>
      rs.map(r => ({ value: r.value, launchedAt: Math.round(r.launched / 1000), token: r.token }))
    this.lastAt = at
    return this.last = { state: this.allowed ? 'open' : 'shut', sum, recentSum, n: twenty.length,
      fresh, oldestAgeMs, bar: 'adaptive', source: 'adaptive-shadow', reason,
      outcomes: shown(twenty), recentOutcomes: shown(eight) }
  }
}
