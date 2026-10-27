import { describe, expect, it } from 'vitest'
import { Ring } from '../core/contracts.js'
import { sizedEntryWei, sizingReading } from '../core/sizing.js'
import type { BookSpec, SizingSpec } from '../core/config.js'
import type { Outcome } from '../core/state.js'

const SPEC: SizingSpec = {
  enabled: true,
  referenceSizeWei: '5000000000000000',
  window: 3,
  recentWindow: 2,
  confirmations: 2,
  clipStakes: 0.5,
  strongThreshold: 0.1,
  weakBps: 5000,
  strongBps: 12500,
  maxBaseSizeWei: '2500000000000000',
  freshMs: 10_000,
}
const BOOK = { id: 'untaxed', sizing: SPEC } as BookSpec
const outcome = (at: number, sizingStakes: number | null, book = 'untaxed'): Outcome => ({
  token: `t${at}`, book, at, perBar: {}, stakes: 0, sizingStakes, peak: 1,
})
const state = (values: Array<[number, number | null]>, at = 5_000) => {
  const cohort = new Ring<Outcome>(100)
  for (const [when, value] of values) cohort.push(outcome(when, value))
  return { at, cohort }
}

describe('adaptive trade sizing', () => {
  it('uses weak size while the fixed-reference tape warms', () => {
    expect(sizingReading(state([[1, 0.3], [2, 0.3]]), BOOK)).toMatchObject({
      state: 'warming', multiplierBps: 5000, n: 2, ready: false,
    })
  })

  it('reduces immediately on a non-positive clipped mean', () => {
    expect(sizingReading(state([[1, -9], [2, 0.2], [3, 0.2]]), BOOK)).toMatchObject({
      state: 'weak', multiplierBps: 5000,
    })
  })

  it('uses normal size when positive evidence lacks two strong confirmations', () => {
    expect(sizingReading(state([[1, -0.2], [2, 0.2], [3, 0.2]]), BOOK)).toMatchObject({
      state: 'normal', multiplierBps: 10_000,
    })
  })

  it('requires consecutive strong windows and a positive latest slice', () => {
    const reading = sizingReading(state([[1, 0.2], [2, 0.2], [3, 0.2], [4, 9]]), BOOK)
    expect(reading).toMatchObject({ state: 'strong', multiplierBps: 12_500, n: 3, ready: true })
    expect(reading.score).toBeCloseTo(0.3)
  })

  it('falls back to weak size when the full window is stale', () => {
    expect(sizingReading(state([[1, 0.2], [2, 0.2], [3, 0.2], [4, 0.2]], 20_000), BOOK)).toMatchObject({
      state: 'stale', multiplierBps: 5000, ready: false,
    })
  })

  it('uses exact integer basis-point arithmetic and the wallet ceiling', () => {
    const base = 2_500_000_000_000_000n
    expect(sizedEntryWei(base, { ...sizingReading(state([], 0), BOOK), multiplierBps: 5000 }, '20000000000000000')).toBe(1_250_000_000_000_000n)
    expect(sizedEntryWei(base, { ...sizingReading(state([], 0), BOOK), multiplierBps: 12_500 }, '20000000000000000')).toBe(3_125_000_000_000_000n)
  })
})
