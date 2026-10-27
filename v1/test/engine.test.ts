import { describe, it, expect } from 'vitest'
import { StateEngine } from '../src/state/engine.js'
import { EVENT_TOPICS } from '../src/abi.js'
import { simBuy, reserves, type CurveParams, type CurveState } from '../src/state/curve.js'
import type { RawLog } from '../src/logs/subscriber.js'

const CURVE = '0x00000000000000000000000000000000000000c1'
const params: CurveParams = {
  phantomQuote: 1_680_000_000_000_000_000n,
  launchSupply: 10n ** 27n,
  reservedTokens: (10n ** 27n * 1_680_000_000_000_000_000n) / (5_880_000_000_000_000_000n),
  feeBps: 100n, creatorTaxBps: 100n, snipeTaxStartBps: 9900n, snipeTaxSeconds: 3n, launchedAt: 1_000_000n,
}
const genesis: CurveState = { trackedQuote: 0n, trackedTokens: 10n ** 27n, quoteFeeBalance: 0n, creatorTaxBalance: 0n, graduated: false }

const w = (v: bigint) => v.toString(16).padStart(64, '0')
function buyLog(quoteIn: bigint, tokensOut: bigint, fee: bigint, tax: bigint, block = 10): RawLog {
  return { address: CURVE, topics: [EVENT_TOPICS.CurveBuy, '0x'.padEnd(66, '0'), '0x'.padEnd(66, '0')],
    data: '0x' + w(quoteIn) + w(tokensOut) + w(fee) + w(tax), blockNumber: block, logIndex: 0,
    transactionHash: '0x', blockHash: '0x' + block }
}

describe('state engine', () => {
  it('folds a CurveBuy into confirmed reserves exactly as the contract does', () => {
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, genesis, 1)
    // what the chain would emit for a 0.01 ETH buy with no snipe tax
    const sim = simBuy(params, genesis, 10n ** 16n, 1_000_010n)
    e.applyLog(buyLog(sim.spent, sim.tokensOut, sim.fee + sim.snipeTax, sim.tax))
    const c = e.get(CURVE)!
    expect(c.confirmed.trackedQuote).toBe(sim.next.trackedQuote)
    expect(c.confirmed.trackedTokens).toBe(sim.next.trackedTokens)
    expect(reserves(params, c.confirmed).q).toBe(reserves(params, sim.next).q)
  })

  it('applies FeesSwept: fee buckets zero and the buyback slice stays tradeable', () => {
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, { ...genesis, trackedQuote: 1000n, quoteFeeBalance: 60n, creatorTaxBalance: 40n }, 1)
    const before = reserves(params, e.get(CURVE)!.confirmed).q
    // protocol 30, buyback 30, creator 40
    e.applyLog({ address: CURVE, topics: [EVENT_TOPICS.FeesSwept], data: '0x' + w(30n) + w(30n) + w(40n),
      blockNumber: 5, logIndex: 0, transactionHash: '0x', blockHash: '0xb' })
    const c = e.get(CURVE)!
    expect(c.confirmed.quoteFeeBalance).toBe(0n)
    expect(c.confirmed.creatorTaxBalance).toBe(0n)
    expect(c.confirmed.trackedQuote).toBe(930n)
    // the 30 wei of buyback stays in the pool as tradeable reserve
    expect(reserves(params, c.confirmed).q - before).toBe(30n)
  })

  it('marks graduation and stops quoting an exit', () => {
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, genesis, 1)
    e.applyLog({ address: CURVE, topics: [EVENT_TOPICS.CurveCompleted], data: '0x' + w(0n) + w(0n),
      blockNumber: 9, logIndex: 0, transactionHash: '0x', blockHash: '0xc' })
    expect(e.isGraduating(CURVE)).toBe(true)
    expect(e.markConfirmed(CURVE, 1000n)).toBe(0n)
  })

  it('shadow book prices our exit against a curve that contains our own buy', () => {
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, genesis, 1)
    const spend = 10n ** 16n
    const ours = simBuy(params, genesis, spend, 1_000_010n)
    e.openShadow(CURVE, ours.next)
    const shadow = e.markShadow(CURVE, ours.tokensOut)
    const naive = e.markConfirmed(CURVE, ours.tokensOut)

    // an instant round trip should return the spend less the two fee legs, both ways
    const ratio = Number(shadow) / Number(spend)
    expect(ratio).toBeGreaterThan(0.94)
    expect(ratio).toBeLessThan(0.97)
    // the naive book has not received our eth, so it under-quotes the exit
    expect(naive).toBeLessThan(shadow)
  })

  it('shadow book keeps tracking as other traders move the curve', () => {
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, genesis, 1)
    const ours = simBuy(params, genesis, 10n ** 16n, 1_000_010n)
    e.openShadow(CURVE, ours.next)
    const before = e.markShadow(CURVE, ours.tokensOut)
    // somebody else buys after us: our position should be worth more
    const theirs = simBuy(params, ours.next, 5n * 10n ** 16n, 1_000_020n)
    e.applyLog(buyLog(theirs.spent, theirs.tokensOut, theirs.fee + theirs.snipeTax, theirs.tax, 12))
    expect(e.markShadow(CURVE, ours.tokensOut)).toBeGreaterThan(before)
  })

  it('drops the optimistic overlay on a feed gap without touching confirmed state', () => {
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, genesis, 1)
    const confirmedBefore = e.get(CURVE)!.confirmed
    e.applyFeedTx(CURVE, 5, { hash: '0x1', to: CURVE, value: 0n, data: '0xdeadbeef', nonce: 0, raw: '0x' } as any)
    e.dropOverlay()
    expect(e.get(CURVE)!.pending).toHaveLength(0)
    expect(e.get(CURVE)!.confirmed).toEqual(confirmedBefore)
  })

  it('folds every log of a block, not only the first (2026-09-06)', () => {
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, genesis, 1)
    const a = simBuy(params, genesis, 10n ** 16n, 1_000_010n)
    const b = simBuy(params, a.next, 2n * 10n ** 16n, 1_000_010n)
    e.applyLog(buyLog(a.spent, a.tokensOut, a.fee + a.snipeTax, a.tax, 10))
    e.applyLog({ ...buyLog(b.spent, b.tokensOut, b.fee + b.snipeTax, b.tax, 10), logIndex: 1 })
    const c = e.get(CURVE)!
    expect(c.confirmed.trackedQuote).toBe(b.next.trackedQuote)
    expect(c.confirmed.trackedTokens).toBe(b.next.trackedTokens)
    expect(reserves(params, c.confirmed).q).toBe(reserves(params, b.next).q)
    expect(c.confirmedBlock).toBe(10)
  })

  it('skips only what the seed already holds; the seed block never moves', () => {
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, genesis, 10)
    const a = simBuy(params, genesis, 10n ** 16n, 1_000_010n)
    e.applyLog(buyLog(a.spent, a.tokensOut, a.fee + a.snipeTax, a.tax, 10))   // inside the read
    expect(e.get(CURVE)!.confirmed.trackedQuote).toBe(0n)
    expect(e.seedSkipped).toBe(1)
    e.applyLog(buyLog(a.spent, a.tokensOut, a.fee + a.snipeTax, a.tax, 11))
    const b = simBuy(params, a.next, 2n * 10n ** 16n, 1_000_010n)
    e.applyLog({ ...buyLog(b.spent, b.tokensOut, b.fee + b.snipeTax, b.tax, 11), logIndex: 1 })
    const c = e.get(CURVE)!
    expect(c.confirmed.trackedQuote).toBe(b.next.trackedQuote)
    expect(c.confirmedBlock).toBe(11)
    expect(c.seedBlock).toBe(10)
    expect(e.seedSkipped).toBe(1)
  })

  it('folding block N prunes the overlay through N and keeps N+1', () => {
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, genesis, 1)
    const junk = { hash: '0x1', to: CURVE, value: 0n, data: '0xdeadbeef', nonce: 0, raw: '0x' } as any
    e.applyFeedTx(CURVE, 10, junk)
    e.applyFeedTx(CURVE, 11, { ...junk, hash: '0x2' })
    const a = simBuy(params, genesis, 10n ** 16n, 1_000_010n)
    e.applyLog(buyLog(a.spent, a.tokensOut, a.fee + a.snipeTax, a.tax, 10))
    expect(e.get(CURVE)!.pending.map((p) => p.block)).toEqual([11])
  })

  it('ignores logs for curves it is not tracking', () => {
    const e = new StateEngine()
    expect(() => e.applyLog(buyLog(1n, 1n, 0n, 0n))).not.toThrow()
  })
})

describe('exit lifecycle guards', () => {
  it('never retries while a sell is already in flight', async () => {
    const { newPosition, shouldRetry } = await import('../src/strategy/exit.js')
    const p = newPosition({ id: 1, token: '0xt', curve: '0xc', tokens: 10n, spendWei: 1n, entryMarkWei: 1n, openedAt: 0, takeProfitMultiple: 1.25, buyHash: '0xb', filled: true })
    p.exiting = true
    p.lastAttemptAt = 0
    p.sellInFlight = true
    expect(shouldRetry(p, 10_000)).toBe(false)
    // only once the in-flight sell resolves does another attempt become legal
    p.sellInFlight = false
    expect(shouldRetry(p, 10_000)).toBe(true)
  })

  it('backs off once a position is marked stuck', async () => {
    const { newPosition, shouldRetry } = await import('../src/strategy/exit.js')
    const p = newPosition({ id: 1, token: '0xt', curve: '0xc', tokens: 10n, spendWei: 1n, entryMarkWei: 1n, openedAt: 0, takeProfitMultiple: 1.25, buyHash: '0xb', filled: true })
    p.exiting = true
    p.lastAttemptAt = 0
    p.stuck = true
    expect(shouldRetry(p, 500)).toBe(false)   // would have retried if not stuck
    expect(shouldRetry(p, 4_000)).toBe(true)  // still retries, just slower
  })

  it('a live position starts unfilled: sequenced is not executed', async () => {
    const { newPosition } = await import('../src/strategy/exit.js')
    const p = newPosition({ id: 1, token: '0xt', curve: '0xc', tokens: 10n, spendWei: 1n, entryMarkWei: 1n, openedAt: 0, takeProfitMultiple: 1.25, buyHash: '0xb' })
    expect(p.filled).toBe(false)
  })
})
