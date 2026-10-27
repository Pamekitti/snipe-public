import { SCENARIO_IDS, SCENARIO_VERSION, type ScenarioId } from './execution-scenarios.js'
import type { ShadowOutcome } from './fresh-recovery.js'

export type GuardPolicy = { freshBrake?: number; minNewOutcomes?: number; cooldownMs?: number; halfLifeMs?: number; positiveCap?: number; participation?: number; id: string; n: number; m: number; off: number; freshOn: number; fullOn: number; ageMs: number; mode: 'fresh' | 'full' | 'both' }
export const BASELINE_GUARD: GuardPolicy = { id: 'matched-baseline-20-8', n: 20, m: 8, off: -1, freshOn: 1, fullOn: 2, ageMs: 10800000, mode: 'fresh' }
export const CONSERVATIVE_GUARD: GuardPolicy = { id: 'conservative-10-5', n: 10, m: 5, off: -2, freshOn: 1, fullOn: 2, ageMs: 10800000, mode: 'both' }
export const SELECTED_GUARD: GuardPolicy = { id: 'n15-m8-b-1.5-r1-h2-fresh', n: 15, m: 8, off: -1.5, freshOn: 1, fullOn: 2, ageMs: 10800000, mode: 'fresh' }
export type ScenarioTape = { id: ScenarioId; outcomes: ShadowOutcome[]; complete: boolean }
export type ScenarioScore = { id: ScenarioId; n: number; recentN: number; sum: number; recentSum: number; fresh: boolean; oldestAgeMs: number; publications?: number; positiveFraction?: number }
export type ScenarioReading = { state: 'open' | 'shut'; reason: string; at: number; policy: GuardPolicy; configId: string; scenarios: ScenarioScore[]; sumRange: [number, number] | null; recentSumRange: [number, number] | null; newEvidence: boolean; source: 'conservative-paper'; version: typeof SCENARIO_VERSION }

export type PreparedScenarioEvidence = {
  at: number; n: number; m: number; ageMs: number; halfLifeMs?: number; positiveCap?: number; invalid: boolean
  latestAvailable: number; scores: ScenarioScore[]; fingerprint: () => string
  allFresh: boolean; sumRange: [number, number] | null; recentSumRange: [number, number] | null
}
function outcomeSum(rows: readonly ShadowOutcome[], at: number, policy: GuardPolicy, n: number): number {
  const value = (r: ShadowOutcome) => policy.positiveCap === undefined ? r.value : Math.min(r.value, policy.positiveCap)
  if (!policy.halfLifeMs) return rows.reduce((sum, r) => sum + value(r), 0)
  const weights = rows.map(r => Math.exp(-Math.LN2 * (at - r.launched) / policy.halfLifeMs!))
  const denominator = weights.reduce((a, b) => a + b, 0)
  return denominator ? n * rows.reduce((sum, r, i) => sum + weights[i]! * value(r), 0) / denominator : 0
}
function summarizeScores(scores: ScenarioScore[]) {
  const range = (key: 'sum' | 'recentSum'): [number, number] | null => scores.length
    ? [Math.min(...scores.map(s => s[key])), Math.max(...scores.map(s => s[key]))] : null
  return { allFresh: scores.every(s => s.fresh), sumRange: range('sum'), recentSumRange: range('recentSum') }
}

/** Policy thresholds share these calculations. The optional lazy fingerprint is
 * for owned immutable offline inputs; ordinary callers snapshot it immediately. */
export function prepareScenarioEvidence(tapes: readonly ScenarioTape[], at: number,
  policy: GuardPolicy, fingerprint?: () => string): PreparedScenarioEvidence {
    let invalid = tapes.length !== SCENARIO_IDS.length
      || new Set(tapes.map(t => t.id)).size !== SCENARIO_IDS.length || SCENARIO_IDS.some(id => !tapes.some(t => t.id === id))
    let latestAvailable = -Infinity
    const scores = tapes.map(tape => {
      const seen = new Set<string>()
      invalid ||= !tape.complete
      for (const r of tape.outcomes) {
        const token = r.token.toLowerCase()
        if (!token || seen.has(token) || ![r.value, r.launched, r.available].every(Number.isFinite)
          || !Number.isSafeInteger(r.block) || r.block < 0 || r.available <= r.launched) invalid = true
        seen.add(token)
      }
      const visible = tape.outcomes.filter(r => r.available <= at)
      for (const r of visible) latestAvailable = Math.max(latestAvailable, r.available)
      const main = [...visible].sort((a, b) => b.block - a.block || b.token.localeCompare(a.token)).slice(0, policy.n)
      const recent = visible.filter(r => at - r.launched <= policy.ageMs)
        .sort((a, b) => b.launched - a.launched || b.token.localeCompare(a.token)).slice(0, policy.m)
      const oldestAgeMs = main.length ? Math.max(...main.map(r => at - r.launched)) : 0
      return { id: tape.id, n: main.length, recentN: recent.length, sum: outcomeSum(main, at, policy, policy.n),
        recentSum: outcomeSum(recent, at, policy, policy.m), oldestAgeMs, publications: visible.length, positiveFraction: recent.filter(r => r.value > 0).length / (recent.length || 1),
        fresh: main.length === policy.n && recent.length === policy.m && oldestAgeMs <= policy.ageMs }
    })
    const fixed = fingerprint ? null : JSON.stringify(tapes)
    return { at, n: policy.n, m: policy.m, ageMs: policy.ageMs, halfLifeMs: policy.halfLifeMs, positiveCap: policy.positiveCap, invalid, latestAvailable, scores, ...summarizeScores(scores),
      fingerprint: fingerprint ?? (() => fixed!) }
}

/** Chronological offline evidence uses bounded ordered windows. Every newly
 * published outcome is validated, including outcomes outside those windows. */
export class ScenarioEvidenceIndex {
  private lastAt = -Infinity
  private streams: Array<{
    tape: ScenarioTape; ordered: Array<{ row: ShadowOutcome; ordinal: number }>; cursor: number
    seen: Set<string>; invalid: boolean; main: Array<{ row: ShadowOutcome; ordinal: number }>
    recent: Array<{ row: ShadowOutcome; ordinal: number }>; latest: number
  }>
  constructor(private readonly tapes: readonly ScenarioTape[], private readonly policy: GuardPolicy) {
    this.streams = tapes.map(tape => ({ tape,
      ordered: tape.outcomes.map((row, ordinal) => ({ row, ordinal }))
        .filter(x => Number.isFinite(x.row.available)).sort((a, b) => a.row.available - b.row.available || a.ordinal - b.ordinal),
      cursor: 0, seen: new Set(), invalid: false, main: [], recent: [], latest: -Infinity }))
  }
  prepare(at: number, complete: (id: ScenarioId) => boolean, fingerprint: () => string): PreparedScenarioEvidence {
    if (!Number.isFinite(at) || at < this.lastAt) throw new Error('indexed evidence must advance chronologically')
    this.lastAt = at
    const insert = (rows: Array<{ row: ShadowOutcome; ordinal: number }>, value: typeof rows[number],
      compare: (a: typeof value, b: typeof value) => number, limit: number) => {
      let lo = 0, hi = rows.length
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (compare(rows[mid]!, value) <= 0) lo = mid + 1; else hi = mid }
      rows.splice(lo, 0, value)
      if (rows.length > limit) rows.pop()
    }
    for (const stream of this.streams) {
      while (stream.cursor < stream.ordered.length && stream.ordered[stream.cursor]!.row.available <= at) {
        const value = stream.ordered[stream.cursor++]!, r = value.row, token = r.token.toLowerCase()
        stream.invalid ||= !token || stream.seen.has(token) || ![r.value, r.launched, r.available].every(Number.isFinite)
          || !Number.isSafeInteger(r.block) || r.block < 0 || r.available <= r.launched
        stream.seen.add(token); stream.latest = Math.max(stream.latest, r.available)
        insert(stream.main, value, (a, b) => b.row.block - a.row.block || b.row.token.localeCompare(a.row.token) || a.ordinal - b.ordinal, this.policy.n)
        insert(stream.recent, value, (a, b) => b.row.launched - a.row.launched || b.row.token.localeCompare(a.row.token) || a.ordinal - b.ordinal, this.policy.m)
      }
    }
    // Invalid values retain the scalar diagnostic output as well as its pause.
    if (this.streams.some(s => s.invalid) || this.tapes.length !== SCENARIO_IDS.length
      || new Set(this.tapes.map(t => t.id)).size !== SCENARIO_IDS.length
      || SCENARIO_IDS.some(id => !this.tapes.some(t => t.id === id)))
      return prepareScenarioEvidence(this.tapes.map(t => ({ ...t, complete: t.complete && complete(t.id),
        outcomes: t.outcomes.filter(r => r.available <= at) })), at, this.policy, fingerprint)
    const scores = this.streams.map(s => {
      const main = s.main.map(v => v.row), recent = s.recent.map(v => v.row).filter(r => at - r.launched <= this.policy.ageMs)
      const oldestAgeMs = main.length ? Math.max(...main.map(r => at - r.launched)) : 0
      return { id: s.tape.id, n: main.length, recentN: recent.length, sum: outcomeSum(main, at, this.policy, this.policy.n),
        recentSum: outcomeSum(recent, at, this.policy, this.policy.m), oldestAgeMs, publications: s.cursor, positiveFraction: recent.filter(r => r.value > 0).length / (recent.length || 1),
        fresh: main.length === this.policy.n && recent.length === this.policy.m && oldestAgeMs <= this.policy.ageMs }
    })
    return { at, n: this.policy.n, m: this.policy.m, ageMs: this.policy.ageMs, halfLifeMs: this.policy.halfLifeMs, positiveCap: this.policy.positiveCap, scores, fingerprint, ...summarizeScores(scores),
      latestAvailable: Math.max(...this.streams.map(s => s.latest)),
      invalid: this.streams.some(s => !s.tape.complete || !complete(s.tape.id)) }
  }
}

/** One common permission state. A scenario cannot reopen independently of its peers. */
export class ScenarioGuard {
  private allowed = false
  private pausedAt = -Infinity
  private pauseCounts = new Map<ScenarioId, number>()
  private cursor: number
  private lastAt = -1
  private last: ScenarioReading | null = null
  private configId = ''
  private fingerprint: () => string = () => ''
  constructor(start: number, readonly policy: GuardPolicy = BASELINE_GUARD) {
    if (!policy.id || !Number.isInteger(policy.n) || !Number.isInteger(policy.m) || policy.m < 1 || policy.n < policy.m
      || ![policy.off, policy.freshOn, policy.fullOn, policy.ageMs].every(Number.isFinite) || policy.ageMs <= 0
      || !['fresh', 'full', 'both'].includes(policy.mode)
      || policy.minNewOutcomes !== undefined && (!Number.isInteger(policy.minNewOutcomes) || policy.minNewOutcomes < 1)
      || policy.cooldownMs !== undefined && (!Number.isFinite(policy.cooldownMs) || policy.cooldownMs < 0)
      || policy.halfLifeMs !== undefined && (!Number.isFinite(policy.halfLifeMs) || policy.halfLifeMs <= 0)
      || policy.positiveCap !== undefined && (!Number.isFinite(policy.positiveCap) || policy.positiveCap <= 0)
      || policy.freshBrake !== undefined && !Number.isFinite(policy.freshBrake)
      || policy.participation !== undefined && (!Number.isFinite(policy.participation) || policy.participation < 0 || policy.participation > 1)) throw new Error('invalid guard policy')
    this.cursor = start - 1
  }
  snapshot() { return { version: SCENARIO_VERSION, policy: this.policy, allowed: this.allowed, cursor: this.cursor, lastAt: this.lastAt, configId: this.configId, last: this.last, fingerprint: this.fingerprint(), pausedAt: Number.isFinite(this.pausedAt) ? this.pausedAt : null, pauseCounts: [...this.pauseCounts] } }
  restore(s: ReturnType<ScenarioGuard['snapshot']>) {
    if (s.version !== SCENARIO_VERSION || JSON.stringify(s.policy) !== JSON.stringify(this.policy)
      || typeof s.allowed !== 'boolean' || !Number.isFinite(s.cursor) || !Number.isFinite(s.lastAt)) throw new Error('incompatible guard checkpoint')
    const fingerprint = s.fingerprint ?? ''
    this.pausedAt = s.pausedAt ?? -Infinity; this.pauseCounts = new Map(s.pauseCounts ?? [])
    this.allowed = s.allowed; this.cursor = s.cursor; this.lastAt = s.lastAt; this.configId = s.configId; this.last = s.last; this.fingerprint = () => fingerprint
  }
  pause(at: number) { this.pausedAt = at; this.allowed = false; this.cursor = at; this.lastAt = -1; this.last = null }
  read(tapes: readonly ScenarioTape[], at: number, configId: string): ScenarioReading {
    return this.readPrepared(prepareScenarioEvidence(tapes, at, this.policy), configId)
  }
  readPrepared(evidence: PreparedScenarioEvidence, configId: string): ScenarioReading {
    const { at, scores } = evidence
    if (evidence.n !== this.policy.n || evidence.m !== this.policy.m || evidence.ageMs !== this.policy.ageMs || evidence.halfLifeMs !== this.policy.halfLifeMs || evidence.positiveCap !== this.policy.positiveCap)
      throw new Error('incompatible prepared guard evidence')
    if (this.lastAt === at && this.last && configId === this.configId && evidence.fingerprint() === this.fingerprint()) return this.last
    const conflictingCheck = this.lastAt === at && this.last !== null && configId === this.configId
    if (this.configId && this.configId !== configId) { this.pause(at); this.pauseCounts = new Map(scores.map(s => [s.id, s.publications ?? 0])) }
    this.configId = configId
    const invalid = evidence.invalid || conflictingCheck || !configId || !Number.isFinite(at) || at < this.lastAt
    const changed = evidence.latestAvailable > this.cursor
    const wasAllowed = this.allowed
    let reason = 'hold'
    if (invalid) { this.allowed = false; reason = 'invalid_or_incomplete_scenario_evidence' }
    else if (!evidence.allFresh) { this.allowed = false; reason = 'stale_or_warmup' }
    else if (this.allowed && scores.some(s => s.sum < this.policy.off || this.policy.freshBrake !== undefined && s.recentSum < this.policy.freshBrake)) { this.allowed = false; reason = 'scenario_loss_brake' }
    else if (!this.allowed && changed && at - this.pausedAt >= (this.policy.cooldownMs ?? 0) && scores.every(s =>
      (this.policy.minNewOutcomes === undefined || (s.publications ?? 0) - (this.pauseCounts.get(s.id) ?? 0) >= this.policy.minNewOutcomes)
      && (this.policy.participation === undefined || (s.positiveFraction ?? 0) >= this.policy.participation) &&
      (this.policy.mode === 'full' || s.recentSum > this.policy.freshOn)
      && (this.policy.mode === 'fresh' || s.sum > this.policy.fullOn))) { this.allowed = true; reason = 'all_scenarios_recovered' }
    else if (!this.allowed) reason = changed ? 'scenario_recovery_disagreement' : 'waiting_new_publication'
    if (wasAllowed && !this.allowed) { this.pausedAt = at; this.pauseCounts = new Map(scores.map(s => [s.id, s.publications ?? 0])) }
    this.cursor = Math.max(this.cursor, Number.isFinite(at) ? at : this.cursor)
    this.lastAt = Math.max(this.lastAt, Number.isFinite(at) ? at : this.lastAt)
    this.fingerprint = evidence.fingerprint
    return this.last = { state: this.allowed ? 'open' : 'shut', reason, at, policy: this.policy, configId, scenarios: scores,
      sumRange: invalid ? null : evidence.sumRange, recentSumRange: invalid ? null : evidence.recentSumRange,
      newEvidence: changed, source: 'conservative-paper', version: SCENARIO_VERSION }
  }
}
