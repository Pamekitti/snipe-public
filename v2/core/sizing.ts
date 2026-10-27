/** Pure, replayable adaptive trade sizing from one book's fixed-stake outcome tape. */
import type { BookSpec, SizingSpec } from './config.js'
import type { Outcome, State } from './state.js'

export type SizingState = 'disabled' | 'warming' | 'stale' | 'weak' | 'normal' | 'strong'

export type SizingReading = {
  readonly state: SizingState
  readonly multiplierBps: number
  readonly n: number
  readonly score: number | null
  readonly recentScore: number | null
  readonly ageMs: number | null
  readonly ready: boolean
  readonly why: string
}

const clipped = (value: number, cap: number): number => Math.max(-cap, Math.min(cap, value))

function mean(rows: readonly Outcome[], spec: SizingSpec): number {
  return rows.reduce((sum, row) => sum + clipped(row.sizingStakes!, spec.clipStakes), 0) / rows.length
}

export function sizingReading(state: Pick<State, 'at' | 'cohort'>, book: BookSpec): SizingReading {
  const spec = book.sizing
  if (!spec?.enabled) return {
    state: 'disabled', multiplierBps: 10_000, n: 0, score: null, recentScore: null,
    ageMs: null, ready: true, why: 'adaptive sizing disabled',
  }
  const rows: Outcome[] = []
  const all = state.cohort.all()
  const needed = spec.window + spec.confirmations - 1
  for (let i = all.length - 1; i >= 0 && rows.length < needed; i--) {
    const row = all[i]!
    if (row.book === book.id && Number.isFinite(row.sizingStakes)) rows.push(row)
  }
  if (rows.length < spec.window) return {
    state: 'warming', multiplierBps: spec.weakBps, n: rows.length, score: null, recentScore: null,
    ageMs: rows.length ? state.at - rows[0]!.at : null, ready: false,
    why: `only ${rows.length} of ${spec.window} sizing outcomes; weak size`,
  }
  const current = rows.slice(0, spec.window)
  const ageMs = state.at - current[current.length - 1]!.at
  const score = mean(current, spec)
  const recentScore = mean(current.slice(0, spec.recentWindow), spec)
  if (ageMs > spec.freshMs) return {
    state: 'stale', multiplierBps: spec.weakBps, n: current.length, score, recentScore, ageMs,
    ready: false, why: `sizing window reaches ${Math.round(ageMs / 1000)}s, over ${Math.round(spec.freshMs / 1000)}s; weak size`,
  }
  let strong = rows.length >= needed
  for (let offset = 0; strong && offset < spec.confirmations; offset++) {
    const sample = rows.slice(offset, offset + spec.window)
    strong = sample.length === spec.window
      && mean(sample, spec) >= spec.strongThreshold
      && mean(sample.slice(0, spec.recentWindow), spec) > 0
  }
  if (strong) return {
    state: 'strong', multiplierBps: spec.strongBps, n: current.length, score, recentScore, ageMs,
    ready: true, why: `${spec.confirmations} qualifying publications at ${score.toFixed(3)} stakes/launch`,
  }
  if (score > 0) return {
    state: 'normal', multiplierBps: 10_000, n: current.length, score, recentScore, ageMs,
    ready: true, why: `${score.toFixed(3)} stakes/launch is positive but not strong`,
  }
  return {
    state: 'weak', multiplierBps: spec.weakBps, n: current.length, score, recentScore, ageMs,
    ready: true, why: `${score.toFixed(3)} stakes/launch is not positive`,
  }
}

export function sizedEntryWei(baseWei: bigint, reading: SizingReading, maxTradeSizeWei: string): bigint {
  const wanted = (baseWei * BigInt(reading.multiplierBps)) / 10_000n
  const ceiling = BigInt(maxTradeSizeWei)
  return wanted < ceiling ? wanted : ceiling
}
