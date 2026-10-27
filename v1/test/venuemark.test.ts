import { describe, expect, it } from 'vitest'
import {
  entryPrice, markToExit, midPrice, reserves, simBuy, PRICE_SCALE,
  type CurveParams, type CurveState,
} from '../src/state/curve.js'
import { touchedBar } from '../src/strategy/cohort.js'

/**
 * The gate has two halves and they must measure the SAME thing.
 *
 * gatewatch.py scores `c.price() / entry_px`: the curve's raw mid over the ETH-per-token we
 * actually paid. Fees, creator tax, snipe tax and slippage are all in the denominator and
 * none of them are in the numerator, so the series starts BELOW 1.0 and a launch has to
 * genuinely run to clear 1.21.
 *
 * The bot's in-process scorer originally used `markToExit / markToExit`. Both sides are net
 * sell proceeds there, so every friction cancels, the series starts at exactly 1.000, and
 * 1.21 becomes a materially looser bar. Measured over 4286 launches on the current tape:
 * gatewatch's entry point is 0.9930 (median), so the bot read 16.8% touch where gatewatch
 * read 16.1%, +0.7pp on an identical venue, in the direction that keeps the gate open.
 *
 * openAt 25 and shutAt 10 were calibrated entirely on gatewatch's distribution. These tests
 * exist so that going back to a friction-cancelling ratio is a red suite rather than a
 * silent loosening discovered in a drawdown.
 */
const params: CurveParams = {
  phantomQuote: 1_680_000_000_000_000_000n,
  launchSupply: 10n ** 27n,
  reservedTokens: (10n ** 27n * 1_680_000_000_000_000_000n) / 5_880_000_000_000_000_000n,
  feeBps: 100n, creatorTaxBps: 100n, snipeTaxStartBps: 9900n, snipeTaxSeconds: 3n,
  launchedAt: 1_000_000n,
}
const genesis: CurveState = {
  trackedQuote: 0n, trackedTokens: 10n ** 27n,
  quoteFeeBalance: 0n, creatorTaxBalance: 0n, graduated: false,
}
/** our live size, and past the snipe-tax window so the tax is the 19bps floor */
const SIZE = 7_500_000_000_000_000n
const LAND = 1_000_002n

/** the multiple as a float, for readability only; the bot compares in bigint */
const mult = (peak: bigint, entry: bigint) => Number((peak * 1_000_000n) / entry) / 1_000_000

describe('midPrice and entryPrice reproduce gatewatch.py exactly', () => {
  it('midPrice is q/t, the raw mid with no fee and no impact', () => {
    const { q, t } = reserves(params, genesis)
    expect(midPrice(params, genesis)).toBe((q * PRICE_SCALE) / t)
  })

  it('entryPrice is gross ETH in over tokens out, so every friction is inside it', () => {
    const sim = simBuy(params, genesis, SIZE, LAND)
    expect(entryPrice(SIZE, sim.tokensOut)).toBe((SIZE * PRICE_SCALE) / sim.tokensOut)
    // strictly worse than the mid we bought against, because we paid the fees
    expect(entryPrice(SIZE, sim.tokensOut)).toBeGreaterThan(midPrice(params, genesis))
  })

  it('is 0 rather than dividing by zero on an empty curve or an unfilled buy', () => {
    expect(midPrice(params, { ...genesis, trackedTokens: 0n })).toBe(0n)
    expect(entryPrice(SIZE, 0n)).toBe(0n)
    expect(entryPrice(0n, 10n ** 18n)).toBe(0n)
  })
})

describe('the gate series starts below 1.0, which is the whole point', () => {
  it('a launch that does nothing scores BELOW the bar, not at it', () => {
    const sim = simBuy(params, genesis, SIZE, LAND)
    const entry = entryPrice(SIZE, sim.tokensOut)
    const peak = midPrice(params, sim.next)
    expect(mult(peak, entry)).toBeLessThan(1)
    // the friction we paid to get in, ~2% on this fixture (100bps fee + 100bps ctax + 19bps snipe)
    expect(mult(peak, entry)).toBeGreaterThan(0.95)
  })

  it('the friction-cancelling ratio starts at exactly 1.000, which is the trap', () => {
    // documents WHY this is wrong rather than just asserting the right answer: both marks
    // are net sell proceeds, so the fees appear in numerator and denominator and vanish
    const sim = simBuy(params, genesis, SIZE, LAND)
    const entryAsExit = markToExit(params, sim.next, sim.tokensOut)
    expect(mult(entryAsExit, entryAsExit)).toBe(1)
    // and it is the LOOSER of the two, so it reads more touches on an identical venue
    const entry = entryPrice(SIZE, sim.tokensOut)
    expect(mult(entryAsExit, entryAsExit)).toBeGreaterThan(mult(midPrice(params, sim.next), entry))
  })

  it('needs a real run to clear 1.21, not just the fees back', () => {
    const sim = simBuy(params, genesis, SIZE, LAND)
    const entry = entryPrice(SIZE, sim.tokensOut)
    // buy the curve up until the mid clears the bar, then check it took a genuine move
    let s = sim.next
    for (let i = 0; i < 200 && mult(midPrice(params, s), entry) < 1.21; i++) {
      s = simBuy(params, s, SIZE, LAND).next
    }
    expect(touchedBar(entry, midPrice(params, s), 1.21)).toBe(true)
    // the mid had to rise well past the entry price, not merely recover the ~2% of friction
    expect(midPrice(params, s)).toBeGreaterThan((midPrice(params, sim.next) * 121n) / 100n)
  })
})

describe('touchedBar on the venue marks', () => {
  it('counts the boundary as a touch, matching gatewatch >=', () => {
    const entry = 1_000_000_000n
    expect(touchedBar(entry, (entry * 121n) / 100n, 1.21)).toBe(true)
    expect(touchedBar(entry, (entry * 121n) / 100n - 1n, 1.21)).toBe(false)
  })

  it('a peak below the entry price is never a touch, however the fees fell', () => {
    const sim = simBuy(params, genesis, SIZE, LAND)
    const entry = entryPrice(SIZE, sim.tokensOut)
    expect(touchedBar(entry, midPrice(params, sim.next), 1.21)).toBe(false)
  })
})
