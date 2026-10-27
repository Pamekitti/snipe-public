import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { settle } from './helpers/settle.js'
import { StateEngine } from '../src/state/engine.js'
import { EVENT_TOPICS } from '../src/abi.js'
import { simBuy, type CurveParams, type CurveState } from '../src/state/curve.js'
import type { RawLog } from '../src/logs/subscriber.js'

/**
 * The book the exit rules read, checked against the chain while a position is open. Written
 * after 2026-09-06, when the confirmed book silently dropped 20% of trades for six hours and
 * the only symptom was exits firing at wrong prices.
 */
const CURVE = '0x00000000000000000000000000000000000000c1'
const params: CurveParams = {
  phantomQuote: 1_680_000_000_000_000_000n,
  launchSupply: 10n ** 27n,
  reservedTokens: (10n ** 27n * 1_680_000_000_000_000_000n) / 5_880_000_000_000_000_000n,
  feeBps: 100n, creatorTaxBps: 100n, snipeTaxStartBps: 9900n, snipeTaxSeconds: 3n, launchedAt: 1_000_000n,
}
const genesis: CurveState = { trackedQuote: 0n, trackedTokens: 10n ** 27n, quoteFeeBalance: 0n, creatorTaxBalance: 0n, graduated: false }
const w = (v: bigint) => v.toString(16).padStart(64, '0')
const buyLog = (s: ReturnType<typeof simBuy>, block: number, logIndex = 0): RawLog => ({
  address: CURVE, topics: [EVENT_TOPICS.CurveBuy, '0x'.padEnd(66, '0'), '0x'.padEnd(66, '0')],
  data: '0x' + w(s.spent) + w(s.tokensOut) + w(s.fee + s.snipeTax) + w(s.tax),
  blockNumber: block, logIndex, transactionHash: '0x' + block + logIndex, blockHash: '0x' + block,
})
const feedTx = (hash: string) => ({ hash, to: CURVE, value: 0n, data: '0xdeadbeef', nonce: 0, raw: '0x' }) as any

describe('the confirmed book checked against the chain', () => {
  it('judges a matching read before the next log moves the book', () => {
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, genesis, 1)
    const a = simBuy(params, genesis, 10n ** 16n, 1_000_010n)
    e.applyLog(buyLog(a, 5))
    expect(e.armCheck(CURVE, { state: a.next, block: 6 })).toBe(true)
    const b = simBuy(params, a.next, 2n * 10n ** 16n, 1_000_010n)
    e.applyLog(buyLog(b, 7))
    expect(e.bookChecks).toEqual({ ok: 1, drift: 0, skipped: 0 })
    expect(e.get(CURVE)!.confirmed.trackedQuote).toBe(b.next.trackedQuote)
    expect(e.settleChecks(7)).toEqual([{ curve: CURVE, block: 6, ok: true, detail: '' }])
    expect(e.settleChecks(7)).toEqual([])
  })

  it('judges a quiet curve on the poller head, once it covers the read', () => {
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, genesis, 1)
    const a = simBuy(params, genesis, 10n ** 16n, 1_000_010n)
    e.applyLog(buyLog(a, 5))
    e.armCheck(CURVE, { state: a.next, block: 6 })
    expect(e.settleChecks(5)).toEqual([])
    expect(e.get(CURVE)!.pendingCheck).not.toBeNull()
    expect(e.settleChecks(6).map((r) => r.ok)).toEqual([true])
    expect(e.bookChecks.ok).toBe(1)
  })

  it('folds a log at exactly the read block before comparing', () => {
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, genesis, 1)
    const a = simBuy(params, genesis, 10n ** 16n, 1_000_010n)
    e.armCheck(CURVE, { state: a.next, block: 5 })
    e.applyLog(buyLog(a, 5))
    expect(e.get(CURVE)!.pendingCheck).not.toBeNull()
    const b = simBuy(params, a.next, 10n ** 16n, 1_000_010n)
    e.applyLog(buyLog(b, 6))
    expect(e.bookChecks).toEqual({ ok: 1, drift: 0, skipped: 0 })
  })

  it('drift re-seeds from the chain, keeps the overlay above the read, and folds on', () => {
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, genesis, 1)
    const a = simBuy(params, genesis, 10n ** 16n, 1_000_010n)
    e.applyLog(buyLog(a, 5))
    e.applyFeedTx(CURVE, 6, feedTx('0x1'))
    e.applyFeedTx(CURVE, 8, feedTx('0x2'))
    // the chain holds a trade the book never saw: exactly the 2026-09-06 failure
    const missed = simBuy(params, a.next, 5n * 10n ** 16n, 1_000_010n)
    e.armCheck(CURVE, { state: missed.next, block: 6 })
    const b = simBuy(params, missed.next, 10n ** 16n, 1_000_010n)
    e.applyLog(buyLog(b, 7))
    const c = e.get(CURVE)!
    expect(e.bookChecks).toEqual({ ok: 0, drift: 1, skipped: 0 })
    expect(c.confirmed.trackedQuote).toBe(b.next.trackedQuote)
    expect(c.seedBlock).toBe(6)
    expect(c.confirmedBlock).toBe(7)
    expect(c.pending.map((p) => p.block)).toEqual([8])
    const [v] = e.settleChecks(7) as [import("../src/state/engine.js").BookCheckResult]
    expect(v.ok).toBe(false)
    expect(v.detail).toContain('trackedQuote')
    expect(e.bookDrift1h()).toBe(1)
    expect(e.bookDrift1h(Date.now() + 3_600_001)).toBe(0)
  })

  it('re-seeding shifts the shadow book by the same delta', () => {
    const e = new StateEngine()
    e.track(CURVE, '0xtok', params, genesis, 1)
    const ours = simBuy(params, genesis, 10n ** 16n, 1_000_010n)
    e.openShadow(CURVE, ours.next)
    const c = e.get(CURVE)!
    const gap = c.shadow!.trackedQuote - c.confirmed.trackedQuote
    const missed = simBuy(params, genesis, 5n * 10n ** 16n, 1_000_010n)
    e.armCheck(CURVE, { state: missed.next, block: 6 })
    e.settleChecks(6)
    expect(e.bookChecks.drift).toBe(1)
    expect(e.get(CURVE)!.shadow!.trackedQuote - e.get(CURVE)!.confirmed.trackedQuote).toBe(gap)
  })

  it('never compares a read it cannot judge', () => {
    const e = new StateEngine()
    expect(e.armCheck(CURVE, { state: genesis, block: 5 })).toBe(false)   // not tracked
    expect(e.bookChecks.skipped).toBe(0)
    e.track(CURVE, '0xtok', params, genesis, 1)
    const a = simBuy(params, genesis, 10n ** 16n, 1_000_010n)
    e.applyLog(buyLog(a, 10))
    expect(e.armCheck(CURVE, { state: a.next, block: 8 })).toBe(false)    // the fold is past it
    expect(e.bookChecks.skipped).toBe(1)
    e.armCheck(CURVE, { state: a.next, block: 12 })
    e.armCheck(CURVE, { state: a.next, block: 14 })                       // displaces the first
    expect(e.bookChecks.skipped).toBe(2)
    expect(e.get(CURVE)!.pendingCheck!.block).toBe(14)
    e.untrack(CURVE)
    expect(e.bookChecks).toEqual({ ok: 0, drift: 0, skipped: 3 })
  })
})

/**
 * The bot side: two reads per fill, on the key, charged to the budget, and a health row the
 * moment the chain and the book disagree.
 */
describe('the bot arms a book check on every fill', () => {
  let dir: string
  let bot: any
  const TOKEN = '0x' + '51'.repeat(20)
  const POSCURVE = '0x' + '52'.repeat(20)
  const params2: CurveParams = { phantomQuote: 1n, reservedTokens: 1n, launchSupply: 10n ** 27n, feeBps: 100n, creatorTaxBps: 100n, snipeTaxStartBps: 9900n, snipeTaxSeconds: 3n, launchedAt: 1n }
  const book: CurveState = { trackedQuote: 5n, trackedTokens: 10n ** 27n, quoteFeeBalance: 0n, creatorTaxBalance: 0n, graduated: false }
  // the chain says the book is missing a trade; the last element is the ArbSys block
  const chainRead = [1n, 1n, 10n ** 27n, 100n, 100n, 9900n, 3n, 1n, 999n, 10n ** 27n, 0n, 0n, false, 1010n]

  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { Bot } = await import('../src/bot.js')
    dir = mkdtempSync(join(tmpdir(), 'bookchk-'))
    bot = new Bot({ mode: 'observe', dbFile: join(dir, 'bot.db') } as any)
  })
  afterEach(async () => {
    const { rmSync } = await import('node:fs')
    vi.useRealTimers()
    await settle()
    bot.tel.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads the chain twice per fill on the key, charges the budget, and reports drift once the poller catches up', async () => {
    const { newPosition } = await import('../src/strategy/exit.js')
    let key = 0
    bot.keyClient = { multicall: async () => { key++; return chainRead } }
    bot.state.track(POSCURVE, TOKEN, params2, book, 1003)
    const pos = newPosition({
      id: 1, token: TOKEN, curve: POSCURVE, tokens: 0n, spendWei: 5_000_000_000_000_000n,
      entryMarkWei: 5_000_000_000_000_000n, openedAt: Date.now(), buyHash: '0x' + 'ab'.repeat(32), takeProfitMultiple: 1.25,
    })
    bot.positions.set(POSCURVE, pos)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })   // Telemetry still drains on setImmediate
    bot.adoptFill(pos, 10n ** 24n)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(key).toBe(1)
    expect(bot.readBudget.calls.eth_call).toBe(1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(key).toBe(2)
    expect(bot.state.bookChecks.skipped).toBe(1)                   // the second read displaced the first

    bot.onHead(1010)
    await settle()
    const rows = bot.tel.raw().prepare("SELECT ok, detail FROM health WHERE component='book'").all() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].ok).toBe(0)
    expect(rows[0].detail).toContain('trackedQuote')
    expect(bot.state.bookChecks.drift).toBe(1)

    // a closed position is never read again
    bot.positions.delete(POSCURVE)
    bot.adoptFill(pos, 10n ** 24n)
    await vi.advanceTimersByTimeAsync(21_000)
    expect(key).toBe(2)
  })
})
