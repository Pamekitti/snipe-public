import { describe, it, expect } from 'vitest'
import { buildBuy, buildSell, buildApprove, classifyFailedTx } from '../src/tx/builder.js'
import { GAS, STRATEGY } from '../src/config.js'

const ADDR = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1' as const
const args = { nonce: 1, chainId: 4663 }

describe('gas limits', () => {
  it('each leg bids its configured limit', () => {
    expect(buildBuy({ curve: ADDR, quoteIn: 7_500_000_000_000_000n, minTokensOut: 1n, recipient: ADDR, ...args }).gas)
      .toBe(GAS.limits.buy)
    expect(buildSell({ curve: ADDR, tokensIn: 1n, minQuoteOut: 1n, recipient: ADDR, ...args }).gas)
      .toBe(GAS.limits.sell)
    expect(buildApprove({ token: ADDR, spender: ADDR, ...args }).gas)
      .toBe(GAS.limits.approve)
  })

  /**
   * THE REGRESSION GUARD, and the reason this file exists.
   *
   * On 2026-08-19 the book widened to admit creator-tax launches, which cost more gas to
   * buy. Nobody revisited limits.buy, it sat at 150_000 against a ~100_000 median, and six
   * buys in four hours burned the entire ceiling and reverted. Buy failures went 2.0% ->
   * 37.5%, p=5.6e-10.
   *
   * Asserting the literal 400_000 would only restate the config. Tying the limit to measured
   * usage is the assertion that would actually have failed when the population moved, which
   * is the whole point: unused gas is refunded, so a limit near the median is all downside.
   */
  it('every limit keeps 3x headroom over measured usage', () => {
    expect(GAS.limits.buy).toBeGreaterThanOrEqual(3n * GAS.used.buy)
    expect(GAS.limits.sell).toBeGreaterThanOrEqual(3n * GAS.used.sell)
    // approve is a fixed ERC20 write with no population behind it to drift, so 1.5x is
    // honest here where 3x would be cargo-culted from the two that do drift
    expect(GAS.limits.approve).toBeGreaterThanOrEqual((3n * GAS.used.approve) / 2n)
  })

  describe('classifyFailedTx', () => {
    // observed out-of-gas buys landed at 149,856-150,000 against a 150,000 limit: a failing
    // call can leave a few units on the table, so the band is 98% rather than exact equality
    it('calls a tx that burned the whole limit out-of-gas', () => {
      expect(classifyFailedTx(150_000n, 150_000n)).toBe('out-of-gas')
      expect(classifyFailedTx(149_856n, 150_000n)).toBe('out-of-gas')
      expect(classifyFailedTx(147_000n, 150_000n)).toBe('out-of-gas') // exactly 98%
    })

    it('calls a tx that reverted with gas to spare a revert', () => {
      // a real slippage revert: it did the work, then failed the final require
      expect(classifyFailedTx(118_040n, 150_000n)).toBe('reverted')
      // and the cheap early-guard reverts, which were 53,177 twice on the same day
      expect(classifyFailedTx(53_177n, 150_000n)).toBe('reverted')
    })

    it('scales with the limit rather than assuming 150k', () => {
      expect(classifyFailedTx(150_000n, 400_000n)).toBe('reverted')
      expect(classifyFailedTx(399_000n, 400_000n)).toBe('out-of-gas')
    })
  })
})

/**
 * The buy slippage bound is a fuse, not a friction setting.
 *
 * 2026-08-26: measured at 5000 (see config.ts for the working). The guard here is only
 * that it stays a real bound. Uncapped, a mispriced `expected` fills at any price and the
 * hard stop becomes the only thing between us and the whole position -- and the measurement
 * says uncapped is $3.26 WORSE than 50% anyway, so there is never a reason to remove it.
 */
describe('buy slippage bound', () => {
  it('still refuses an absurd fill', () => {
    expect(STRATEGY.buySlippageBps).toBeGreaterThan(0)
    // past ~50% the rescued trades are all losers: they have already spent their move
    expect(STRATEGY.buySlippageBps).toBeLessThanOrEqual(5000)
  })

  it('accepts a fill inside the bound and refuses one outside it', () => {
    const expected = 1_000_000n
    const minOut = (expected * BigInt(10_000 - STRATEGY.buySlippageBps)) / 10_000n
    // the contract's check is a ratio bound; here it reduces to tokensOut >= minTokensOut
    expect(expected * 55n / 100n >= minOut).toBe(true)  // 45% slip: inside the measured band
    expect(expected * 25n / 100n >= minOut).toBe(false) // 75% slip: refused, and rightly
  })
})
