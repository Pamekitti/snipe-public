import { describe, expect, it } from 'vitest'
import { StateEngine } from '../src/state/engine.js'
import { EVENT_TOPICS } from '../src/abi.js'
import { entryPrice, midPrice, simBuy, type CurveParams, type CurveState } from '../src/state/curve.js'
import { touchedBar } from '../src/strategy/cohort.js'

/**
 * The cohort observation, end to end, in the units the bot actually runs it in.
 *
 * WHY THIS FILE EXISTS. The pieces were each unit-tested and the whole was still wrong.
 * entryMark and peak were moved to PRICE units (scaled by PRICE_SCALE, ~1e9 on these
 * curves) while the per-tick peak update still called markWorking, which returns exit
 * PROCEEDS in wei (~7.5e15). Six orders of magnitude apart, so the wei mark won every
 * `if (mark > o.peak)` on the first tick and pinned the peak there. Live for four minutes
 * on 2026-08-19, reporting peak=2354341.8290 and touch=1 on a launch that did nothing,
 * which is the direction that keeps the gate open in a dead venue.
 *
 * Neither the curve tests nor the cohort tests could catch it: both halves were correct in
 * isolation and the bug lived in the seam. So these tests assert the one property that
 * spans the seam -- a multiple has to look like a multiple.
 */
const CURVE = '0x00000000000000000000000000000000000000c1'
const params: CurveParams = {
  phantomQuote: 1_680_000_000_000_000_000n,
  launchSupply: 10n ** 27n,
  reservedTokens: (10n ** 27n * 1_680_000_000_000_000_000n) / 5_880_000_000_000_000_000n,
  feeBps: 100n, creatorTaxBps: 0n, snipeTaxStartBps: 9900n, snipeTaxSeconds: 3n,
  launchedAt: 1_000_000n,
}
const genesis: CurveState = {
  trackedQuote: 0n, trackedTokens: 10n ** 27n,
  quoteFeeBalance: 0n, creatorTaxBalance: 0n, graduated: false,
}
const SIZE = 7_500_000_000_000_000n
const LAND = 1_000_002n

const w = (v: bigint) => v.toString(16).padStart(64, '0')
function buyLog(quoteIn: bigint, tokensOut: bigint, fee: bigint, tax: bigint, block: number) {
  return {
    address: CURVE, topics: [EVENT_TOPICS.CurveBuy, '0x'.padEnd(66, '0'), '0x'.padEnd(66, '0')],
    data: '0x' + w(quoteIn) + w(tokensOut) + w(fee) + w(tax), blockNumber: block, logIndex: 0,
    transactionHash: '0x', blockHash: '0x' + block,
  }
}

/** exactly what bot.ts startObservation does */
function observe(e: StateEngine) {
  const c = e.get(CURVE)!
  const sim = simBuy(params, c.working, SIZE, LAND)
  return {
    tokens: sim.tokensOut,
    entryMark: entryPrice(SIZE, sim.tokensOut),
    peak: midPrice(params, sim.next),
  }
}
/** exactly what bot.ts pumpObservations does per tick */
function pump(e: StateEngine, o: { peak: bigint }) {
  const mark = e.midWorking(CURVE)
  if (mark > o.peak) o.peak = mark
}
const asMultiple = (o: { peak: bigint; entryMark: bigint }) =>
  Number((o.peak * 1_000_000n) / o.entryMark) / 1_000_000

describe('the observation peak stays in price units', () => {
  it('midWorking and markWorking are NOT interchangeable, by orders of magnitude', () => {
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, genesis, 1)
    const tokens = simBuy(params, genesis, SIZE, LAND).tokensOut
    const mid = e.midWorking(CURVE)
    const proceeds = e.markWorking(CURVE, tokens)
    // the trap in one assertion: swapping these silently multiplies the peak by ~1e6
    expect(proceeds / mid).toBeGreaterThan(1_000_00n)
  })

  it('reports a multiple that looks like a multiple on a curve that never moves', () => {
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, genesis, 1)
    const o = observe(e)
    for (let i = 0; i < 50; i++) pump(e, o)
    const m = asMultiple(o)
    expect(m).toBeGreaterThan(0.9)
    expect(m).toBeLessThan(1.1)
    // and the actual failure: a dead launch must NOT score as a touch
    expect(touchedBar(o.entryMark, o.peak, 1.21)).toBe(false)
  })

  it('never reports an absurd multiple however many ticks run', () => {
    // the guard that fails loudly if the units drift again, whatever the cause
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, genesis, 1)
    const o = observe(e)
    for (let i = 0; i < 200; i++) {
      pump(e, o)
      expect(asMultiple(o)).toBeLessThan(100)
    }
  })
})

describe('the observation tracks a real run-up', () => {
  it('rises as buyers lift the curve, and clears the bar only on a genuine move', () => {
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, genesis, 1)
    const o = observe(e)
    expect(touchedBar(o.entryMark, o.peak, 1.21)).toBe(false)

    // fold real buys in through the same path the feed uses
    let s = e.get(CURVE)!.working
    for (let b = 2; b < 60 && asMultiple(o) < 1.21; b++) {
      const sim = simBuy(params, s, 10n ** 17n, BigInt(1_000_000 + b))
      e.applyLog(buyLog(sim.spent, sim.tokensOut, sim.fee + sim.snipeTax, sim.tax, b))
      s = e.get(CURVE)!.working
      pump(e, o)
    }
    expect(touchedBar(o.entryMark, o.peak, 1.21)).toBe(true)
    expect(asMultiple(o)).toBeGreaterThanOrEqual(1.21)
    expect(asMultiple(o)).toBeLessThan(10)
  })

  it('keeps the high-water mark when the curve falls back', () => {
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, genesis, 1)
    const o = observe(e)
    const sim = simBuy(params, e.get(CURVE)!.working, 5n * 10n ** 17n, 1_000_010n)
    e.applyLog(buyLog(sim.spent, sim.tokensOut, sim.fee + sim.snipeTax, sim.tax, 10))
    pump(e, o)
    const high = o.peak
    expect(high).toBeGreaterThan(o.entryMark)
    // a sell drags the mid back down; the observation must not follow it
    e.track(CURVE, '0xtok', params, genesis, 1)
    pump(e, o)
    expect(o.peak).toBe(high)
  })
})
