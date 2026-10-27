/**
 * THE BOT-BROKEN HALT: are we losing money the venue did not lose?
 *
 * Every real loss this bot has taken in September was a bug in us rather than a market
 * (the 09-04 burned-gas retry loop, the 09-06 same-block log drop), and both were found by
 * a person reading numbers hours later. This is the arithmetic that finds them, so the
 * tests below are about the two ways it could be wrong: firing on a bad market, which
 * would halt a bot that should trade, and staying quiet through a real bug.
 */
import { describe, it, expect } from 'vitest'
import { brokenGap } from '../src/strategy/broken.js'
import { RISK } from '../src/config.js'

const pairs = (real: number, replay: number, n = 20): Array<{ real: number; replay: number }> =>
  Array.from({ length: n }, () => ({ real, replay }))

describe('brokenGap', () => {
  it('reads about zero when we make the historical share of the replay', () => {
    // 0.78 is what real money made per unit of replay over 463 paired trades; a bot
    // performing exactly to that expectation is not broken, however small the returns
    const b = brokenGap(pairs(0.156, 0.2), 0.78)!
    expect(b.gapPp).toBeCloseTo(0, 6)
    expect(b.n).toBe(20)
  })

  it('is deeply negative on the 2026-09-06 shape: the venue paid and we did not', () => {
    // the real numbers from the afternoon of the same-block log drop
    const b = brokenGap(pairs(-0.071, 0.144), 0.78)!
    expect(b.gapPp).toBeCloseTo(-18.3, 1)
    expect(b.realPp).toBeCloseTo(-7.1, 1)
    expect(b.replayPp).toBeCloseTo(14.4, 1)
  })

  it('stays near zero on a BAD MARKET, which must never halt this way', () => {
    // both sides lose together: that is a venue, and the venue pause and the drawdown stop
    // are the ones that answer it. This check must not fire.
    const b = brokenGap(pairs(-0.2, -0.25), 0.78)!
    expect(Math.abs(b.gapPp)).toBeLessThan(RISK.brokenGapPp)
  })

  it('compares the means, so one runner cannot swing the verdict', () => {
    // a per-pair ratio has tails fat enough to be meaningless: recon logged a single 2.36x
    // winner moving a per-trade mean by 215 points of one trade's stake
    const many = [...pairs(0.1, 0.12, 19), { real: 12, replay: 14 }]
    const b = brokenGap(many, 0.78)!
    expect(b.n).toBe(20)
    expect(b.gapPp).toBeGreaterThan(0)   // the runner paid us, and it shows as positive
  })

  it('drops non-finite pairs and has no opinion when nothing is left', () => {
    const b = brokenGap([{ real: NaN, replay: 0.2 }, { real: 0.1, replay: Infinity }, { real: 0.156, replay: 0.2 }], 0.78)!
    expect(b.n).toBe(1)
    expect(brokenGap([{ real: NaN, replay: NaN }], 0.78)).toBe(null)
    expect(brokenGap([], 0.78)).toBe(null)
  })

  it('the shipped threshold separates those two worlds', () => {
    // the whole design in one assertion: a bug halts, a bad market does not
    const bug = brokenGap(pairs(-0.071, 0.144), RISK.brokenFactor)!
    const market = brokenGap(pairs(-0.2, -0.25), RISK.brokenFactor)!
    expect(bug.gapPp).toBeLessThanOrEqual(-RISK.brokenGapPp)
    expect(market.gapPp).toBeGreaterThan(-RISK.brokenGapPp)
  })
})
