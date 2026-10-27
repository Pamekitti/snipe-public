/**
 * The two ways an exit can be impossible rather than merely failing.
 *
 * Both shipped as unbounded retry loops. On 2026-08-25 position 749 had sent 32,712 sells
 * against a zero allowance (its approve was lost to a 4ms transport failure and nothing
 * ever re-read it) and position 893 had sent 1,092 against a graduated curve, which
 * reverts CurveGraduated() by construction. Neither is a slippage problem, so the widening
 * ladder could never have fixed either one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bot } from '../src/bot.js'
import { STRATEGY } from '../src/config.js'
import { newPosition, shouldRetry, type Position } from '../src/strategy/exit.js'
import { settle } from './helpers/settle.js'

const TOKEN = '0x2f72288985afc73b21bd160e445b0e2b4273137e'
const CURVE = '0x1111111111111111111111111111111111111111'
const WALLET = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'

/** a curve read shaped like recovery.readCurve's multicall (allowFailure: false) */
const curveRead = (graduated: boolean) => [
  1n, 1n, 10n, 100n, 0n, 9900n, 3n, 1n, 1n, graduated ? 0n : 5n, 0n, 0n, graduated,
]

describe('stuck exits', () => {
  let dir: string
  let bot: Bot
  let sends: string[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stuck-'))
    bot = new Bot({ mode: 'live', dbFile: join(dir, 'bot.db') } as any)
    sends = []
    const any = bot as any
    any.signer = { address: WALLET, sign: async () => ({ hash: '0x' + 'cd'.repeat(32), raw: '0xraw' }) }
    any.nonce = { reserve: () => 1, settle: () => {}, release: () => {}, rejected: () => true }
    any.sender = { send: async () => { sends.push('sent'); return { ok: true, ms: 1, hash: '0x' + 'cd'.repeat(32) } } }
  })
  afterEach(async () => { await settle(); bot.tel.close(); rmSync(dir, { recursive: true, force: true }) })

  const position = (): Position => newPosition({
    id: 1, token: TOKEN, curve: CURVE, tokens: 500n, spendWei: 5_000_000_000_000_000n,
    entryMarkWei: 5_000_000_000_000_000n, openedAt: Date.now(), buyHash: '0x' + 'ab'.repeat(32),
    takeProfitMultiple: 1.25, filled: true,
  })

  const chainSays = (opts: { allowance: bigint; graduated: boolean; balance?: bigint }) => {
    ;(bot as any).client = {
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? (opts.balance ?? 500n) : opts.allowance,
      multicall: async () => curveRead(opts.graduated),
    }
  }

  const healthLines = async () => {
    await settle()
    return (bot.tel.raw()
      .prepare("SELECT detail FROM health WHERE component='exit' ORDER BY id").all() as any[])
      .map((r) => r.detail as string)
  }

  it('re-approves when the allowance is the reason sells revert', async () => {
    chainSays({ allowance: 0n, graduated: false })
    const pos = position()
    await (bot as any).diagnoseStuckSell(pos)
    expect(sends).toHaveLength(1) // the approve went back out
    expect(pos.parked).toBe(false) // still recoverable, so keep selling
    expect((await healthLines()).join(' ')).toContain('allowance is 0')
  })

  it('hands graduation to durable swap management without booking a loss or freeing the holding', async () => {
    chainSays({ allowance: 2n ** 256n - 1n, graduated: true })
    const pos = position()
    pos.exiting = true
    ;(bot as any).positions.set(CURVE, pos)
    const before = bot.risk.dayRealizedPnlWei
    await (bot as any).diagnoseStuckSell(pos)
    expect(pos.graduated).toBe(true)
    expect(pos.parked).toBe(false)
    expect(pos.exitReason).toBe('graduated-swap')
    expect(sends).toHaveLength(0)
    expect((bot as any).positions.has(CURVE)).toBe(true)
    expect(bot.risk.dayRealizedPnlWei).toBe(before)
    expect(bot.tel.raw().prepare('SELECT 1 FROM graduation_exits WHERE position_id=1').get()).toBeTruthy()
    expect((await healthLines()).join(' ')).toContain('handing held tokens to swap exit')
    await (bot as any).diagnoseStuckSell(pos)
    expect(bot.tel.raw().prepare('SELECT COUNT(*) n FROM graduation_exits').get()).toEqual({ n: 1 })
  })

  it('reconciles a pending curve sell immediately when graduation is confirmed', () => {
    const pos = position()
    pos.sellInFlight = true
    pos.sellSentAt = Date.now()
    ;(bot as any).positions.set(CURVE, pos)
    vi.spyOn(bot.state, 'get').mockReturnValue({ confirmed: { graduated: true }, params: {} } as any)
    const reconcile = vi.spyOn(bot as any, 'reconcileSell').mockResolvedValue(undefined)
    ;(bot as any).pumpExits()
    expect(reconcile).toHaveBeenCalledWith(pos, true)
  })

  it('reconciles an unconfirmed buy immediately when its curve has graduated', () => {
    const pos = position()
    pos.filled = false
    ;(bot as any).positions.set(CURVE, pos)
    vi.spyOn(bot.state, 'get').mockReturnValue({ confirmed: { graduated: true }, params: {} } as any)
    const reconcile = vi.spyOn(bot as any, 'reconcileBuy').mockResolvedValue(undefined)
    ;(bot as any).pumpExits()
    expect(reconcile).toHaveBeenCalledWith(pos, true)
  })

  it('hands a ready but unswept curve to graduation completion instead of retrying curve sells', async () => {
    const values = curveRead(false)
    values[9] = 1n // tracked tokens equal reserved tokens
    ;(bot as any).client = { readContract: async () => 500n, multicall: async () => values }
    const pos = position()
    await (bot as any).diagnoseStuckSell(pos)
    expect(pos.graduated).toBe(true)
    expect(sends).toHaveLength(0)
  })

  it('leaves an ordinary slippage revert to the widening ladder', async () => {
    chainSays({ allowance: 2n ** 256n - 1n, graduated: false })
    const pos = position()
    pos.exiting = true
    await (bot as any).diagnoseStuckSell(pos)
    expect(pos.parked).toBe(false)
    expect(sends).toHaveLength(0) // no re-approve: the approval is fine
    expect(shouldRetry(pos, Date.now() + 1_000_000)).toBe(true)
  })

  it('throttles: an RPC call must not ride the retry loop cadence', async () => {
    let reads = 0
    ;(bot as any).client = {
      readContract: async ({ functionName }: { functionName: string }) => {
        reads++
        return functionName === 'balanceOf' ? 500n : 2n ** 256n - 1n
      },
      multicall: async () => curveRead(false),
    }
    const pos = position()
    await (bot as any).diagnoseStuckSell(pos)
    await (bot as any).diagnoseStuckSell(pos)
    await (bot as any).diagnoseStuckSell(pos)
    expect(reads).toBe(2) // one diagnosis = allowance + balance; runs two and three were throttled
  })

  it('a failed diagnosis is not a failed exit', async () => {
    ;(bot as any).client = {
      readContract: async () => { throw new Error('429 Too Many Requests') },
      multicall: async () => { throw new Error('429 Too Many Requests') },
    }
    const pos = position()
    pos.exiting = true
    await expect((bot as any).diagnoseStuckSell(pos)).resolves.toBeUndefined()
    expect(pos.parked).toBe(false)
    expect(shouldRetry(pos, Date.now() + 1_000_000)).toBe(true)
  })

  // ---- 2026-09-04: position 1438, 945 reverted sells, $101 of gas the book never saw ----

  it('sells what the wallet actually holds when the record says more', async () => {
    // the CurveBuy event said 500; the wallet received 498. every sell for 500 reverts on
    // insufficient balance and no slippage bound can fix that. 1438 was 0.26% over.
    chainSays({ allowance: 2n ** 256n - 1n, graduated: false, balance: 498n })
    const pos = position()
    pos.exiting = true
    await (bot as any).diagnoseStuckSell(pos)
    expect(pos.tokens).toBe(498n)
    expect(pos.parked).toBe(false) // correctable, so keep selling: the next attempt is for 498
    expect(shouldRetry(pos, Date.now() + 1_000_000)).toBe(true)
    expect((await healthLines()).join(' ')).toContain('wallet holds 498')
  })

  it('parks when the wallet holds nothing at all', async () => {
    chainSays({ allowance: 2n ** 256n - 1n, graduated: false, balance: 0n })
    const pos = position()
    pos.exiting = true
    await (bot as any).diagnoseStuckSell(pos)
    expect(pos.parked).toBe(true)
    expect(sends).toHaveLength(0)
    expect(shouldRetry(pos, Date.now() + 1_000_000)).toBe(false)
    expect((await healthLines()).join(' ')).toContain('NO-TOKENS')
  })

  it('graduation outranks a short balance: nothing to correct on a curve that cannot sell', async () => {
    chainSays({ allowance: 2n ** 256n - 1n, graduated: true, balance: 498n })
    const pos = position()
    await (bot as any).diagnoseStuckSell(pos)
    expect(pos.graduated).toBe(true)
    expect(pos.tokens).toBe(500n) // untouched: the correction is for a sell that can happen
    expect((await healthLines()).join(' ')).toContain('handing held tokens to swap exit')
  })

  it('stops sending after the attempt cap instead of retrying forever', async () => {
    const pos = position()
    pos.exiting = true
    pos.attempts = STRATEGY.maxSellAttempts
    await (bot as any).fireExit(pos, 'time')
    expect(sends).toHaveLength(0) // the cap is checked BEFORE a sell is built
    expect(pos.parked).toBe(true)
    expect(pos.attempts).toBe(STRATEGY.maxSellAttempts) // and not incremented past it
    expect(shouldRetry(pos, Date.now() + 1_000_000)).toBe(false)
    expect((await healthLines()).join(' ')).toContain('EXHAUSTED')
    // idempotent: a second call must not alert again
    await (bot as any).fireExit(pos, 'time')
    expect((await healthLines()).filter((l) => l.includes('EXHAUSTED'))).toHaveLength(1)
  })

  it('one attempt below the cap still goes out', async () => {
    const pos = position()
    pos.exiting = true
    pos.attempts = STRATEGY.maxSellAttempts - 1
    ;(bot as any).state = { markConfirmed: () => 1_000_000n, isGraduating: () => false }
    await (bot as any).fireExit(pos, 'time')
    expect(sends).toHaveLength(1)
    expect(pos.parked).toBe(false)
  })

  it('books the gas of every reverted attempt into the live ledger, not at close', async () => {
    // a reverted sell still paid for the gas it used. before this, that cost existed on
    // the chain and nowhere in the bot: proceeds were 0 and the backfill only walks
    // buy_hash and exit_hash. 945 of these added up to $101 while the book read +$52.
    const gasUsed = 90_000n, price = 1_000_000_000n
    ;(bot as any).client = {
      getTransactionReceipt: async () => ({ status: 'reverted', gasUsed, effectiveGasPrice: price, logs: [] }),
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? 500n : 2n ** 256n - 1n,
      multicall: async () => curveRead(false),
    }
    const id = bot.tel.openPosition({
      token: TOKEN, curve: CURVE, live: 1, t_detect: 1, t_decide: 2, t_signed: 3, t_sent: 4,
      entry_block: 1, spend_wei: '5000000000000000', min_tokens_out: '1', tokens_held: '500',
      entry_mark_wei: '5000000000000000', buy_hash: '0x' + 'ab'.repeat(32), buy_ok: 1, buy_error: null,
      take_profit: 1.25,
    })
    const pos = position()
    pos.id = id
    pos.exiting = true
    pos.sellInFlight = true
    pos.sellHash = '0x' + 'ee'.repeat(32)
    pos.sellSentAt = Date.now() - 10_000
    const before = bot.risk.realizedPnlWei
    const dayBefore = bot.risk.dayRealizedPnlWei
    await (bot as any).reconcileSell(pos)
    expect(pos.burnedGasWei).toBe(gasUsed * price)
    expect(bot.risk.realizedPnlWei).toBe(before - gasUsed * price)      // the drawdown stop sees it
    expect(bot.risk.dayRealizedPnlWei).toBe(dayBefore - gasUsed * price) // and so does the daily cap
    expect(pos.sellInFlight).toBe(false) // and the ladder carries on
    // and the ROW carries the running total, so the receipt backfill (which only walks the
    // two landed legs) keeps it instead of forgiving it at the next rebuild
    await settle()
    const row = bot.tel.raw().prepare('SELECT burned_gas_wei FROM positions WHERE id=?').get(id) as any
    expect(row.burned_gas_wei).toBe((gasUsed * price).toString())
    // a second revert accumulates rather than overwrites
    pos.sellInFlight = true
    pos.sellSentAt = Date.now() - 10_000
    await (bot as any).reconcileSell(pos)
    await settle()
    const row2 = bot.tel.raw().prepare('SELECT burned_gas_wei FROM positions WHERE id=?').get(id) as any
    expect(row2.burned_gas_wei).toBe((2n * gasUsed * price).toString())
  })

  it('never parks outside live mode', async () => {
    const paper = new Bot({ mode: 'shadow', dbFile: join(dir, 'paper.db') } as any)
    ;(paper as any).client = { readContract: async () => 0n, multicall: async () => curveRead(true) }
    const pos = position()
    await (paper as any).diagnoseStuckSell(pos)
    expect(pos.parked).toBe(false)
    await settle()
    paper.tel.close()
  })
})

describe('approve retry', () => {
  let dir: string
  let bot: Bot

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'appr-'))
    bot = new Bot({ mode: 'live', dbFile: join(dir, 'bot.db') } as any)
    ;(bot as any).signer = { address: WALLET, sign: async () => ({ hash: '0x' + 'cd'.repeat(32), raw: '0xraw' }) }
  })
  afterEach(async () => { await settle(); bot.tel.close(); rmSync(dir, { recursive: true, force: true }) })

  const nonces = () => {
    const seen = { released: 0, settled: 0 }
    ;(bot as any).nonce = {
      reserve: () => 1, settle: () => { seen.settled++ }, release: () => { seen.released++ },
      // a rejection IS a release (NonceManager.rejected calls release); the resync it can
      // trigger on "nonce too high" is tested in noncerunaway.test.ts
      rejected: () => { seen.released++; return true },
    }
    return seen
  }

  const health = async () => {
    await settle()
    return bot.tel.raw()
      .prepare("SELECT ok, detail FROM health WHERE component='approve' ORDER BY id").all() as any[]
  }

  it('retries a failed send and reports the recovery', async () => {
    const seen = nonces()
    let n = 0
    ;(bot as any).sender = { send: async () => (++n === 1 ? { ok: false, ms: 4 } : { ok: true, ms: 20 }) }
    await expect((bot as any).approve(TOKEN, CURVE)).resolves.toBe(true)
    expect(n).toBe(2)
    expect(seen.released).toBe(1) // the failed nonce went back
    expect((await health())[0]!.ok).toBe(1)
  })

  it('gives up loudly rather than silently, so the position is not stranded in the dark', async () => {
    nonces()
    let n = 0
    ;(bot as any).sender = { send: async () => { n++; return { ok: false, ms: 4 } } }
    await expect((bot as any).approve(TOKEN, CURVE)).resolves.toBe(false)
    expect(n).toBe(3)
    const h = await health()
    expect(h).toHaveLength(1)
    expect(h[0]!.ok).toBe(0)
    expect(h[0]!.detail).toContain('cannot sell')
  })

  it('does not retry when the nonce was consumed: that send may have landed', async () => {
    const seen = nonces()
    let n = 0
    ;(bot as any).sender = { send: async () => { n++; return { ok: false, nonceConsumed: true, ms: 4 } } }
    await expect((bot as any).approve(TOKEN, CURVE)).resolves.toBe(true)
    expect(n).toBe(1)
    expect(seen.settled).toBe(1)
    expect(seen.released).toBe(0)
  })

  it('is silent on the happy path', async () => {
    nonces()
    ;(bot as any).sender = { send: async () => ({ ok: true, ms: 20 }) }
    await (bot as any).approve(TOKEN, CURVE)
    expect(await health()).toHaveLength(0)
  })
})

describe('reconcileBuy backoff (2026-09-06)', () => {
  it('a pending buy is re-checked with a doubling backoff and one health row per verdict, not on every 50ms pump', async () => {
    const { vi } = await import('vitest')
    const dir = mkdtempSync(join(tmpdir(), 'rb-'))
    const bot = new Bot({ mode: 'live', dbFile: join(dir, 'bot.db') } as any)
    try {
      ;(bot as any).signer = { address: WALLET }
      let reads = 0
      ;(bot as any).client = { readContract: async () => { reads++; return 0n } }
      ;(bot as any).inspectBuy = async () => ({ kind: 'pending' })
      const pos = newPosition({
        id: 1, token: TOKEN, curve: CURVE, tokens: 0n, spendWei: 5_000_000_000_000_000n,
        entryMarkWei: 5_000_000_000_000_000n, openedAt: Date.now(), buyHash: '0x' + 'ab'.repeat(32), takeProfitMultiple: 1.25,
      })
      // fake the clock only: Telemetry drains its write queue on setImmediate
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(1_000_000)
      await (bot as any).reconcileBuy(pos)
      expect(reads).toBe(1)
      expect(pos.reconcileBackoffMs).toBe(500)
      // the pump comes back every 50ms: no round trip until the backoff has passed
      for (let i = 0; i < 9; i++) { vi.setSystemTime(1_000_000 + 50 * (i + 1)); await (bot as any).reconcileBuy(pos) }
      expect(reads).toBe(1)
      vi.setSystemTime(1_000_600)
      await (bot as any).reconcileBuy(pos)
      expect(reads).toBe(2)
      expect(pos.reconcileBackoffMs).toBe(1000)
      vi.setSystemTime(1_010_000)
      await (bot as any).reconcileBuy(pos)
      vi.setSystemTime(1_020_000)
      await (bot as any).reconcileBuy(pos)
      expect(pos.reconcileBackoffMs).toBe(4000) // capped
      vi.useRealTimers()
      await settle()
      const rows = bot.tel.raw().prepare("SELECT detail FROM health WHERE component='buy'").all() as any[]
      expect(rows).toHaveLength(1) // the same verdict four times: one row
      expect(rows[0].detail).toContain('no receipt yet')
    } finally {
      vi.useRealTimers()
      await settle()
      bot.tel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('refused sends do not consume the attempt cap (2026-09-06)', () => {
  let dir: string
  let bot: Bot
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ref-'))
    bot = new Bot({ mode: 'live', dbFile: join(dir, 'bot.db') } as any)
    const any = bot as any
    any.signer = { address: WALLET, sign: async () => ({ hash: '0x' + 'cd'.repeat(32), raw: '0xraw' }) }
    any.nonce = { reserve: () => 1, settle: () => {}, release: () => {}, rejected: () => true }
    any.state = { markConfirmed: () => 1_000_000n, isGraduating: () => false }
  })
  afterEach(async () => { await settle(); bot.tel.close(); rmSync(dir, { recursive: true, force: true }) })

  it('a 30s refusal burst leaves the position selling, backing off, never parked', async () => {
    // the 09-05 shape: twenty "nonce too high" refusals in thirty seconds. With the cap
    // counting them the position parked with its tokens in hand and the hard stop was off.
    let sends = 0
    ;(bot as any).sender = { send: async () => { sends++; return { ok: false, error: 'nonce too high', ms: 1, via: 'seq', nonceConsumed: false } } }
    const pos = newPosition({
      id: 1, token: TOKEN, curve: CURVE, tokens: 500n, spendWei: 5_000_000_000_000_000n,
      entryMarkWei: 5_000_000_000_000_000n, openedAt: Date.now(), buyHash: '0x' + 'ab'.repeat(32), takeProfitMultiple: 1.25, filled: true,
    })
    pos.exiting = true
    for (let i = 0; i < 25; i++) {
      pos.retryNotBefore = 0 // the clock has passed; what matters here is the count, not the wait
      await (bot as any).fireExit(pos, 'time')
    }
    expect(sends).toBe(25)
    expect(pos.attempts).toBe(0)            // none of them counted
    expect(pos.refusals).toBe(25)
    expect(pos.parked).toBe(false)
    expect(pos.retryNotBefore).toBeGreaterThan(Date.now() + 9_000) // capped at 10s
    expect(shouldRetry(pos, Date.now())).toBe(false)               // waits it out
    expect(shouldRetry(pos, pos.retryNotBefore + 1)).toBe(true)     // then tries again
    await settle()
    const lines = (bot.tel.raw().prepare("SELECT detail FROM health WHERE component='exit'").all() as any[]).map((r) => r.detail)
    expect(lines.filter((l) => l.includes('refused'))).toHaveLength(3) // 1st, 10th, 20th
    expect(lines.some((l) => l.includes('EXHAUSTED'))).toBe(false)
  })

  it('a sequenced sell still counts, so a revert loop still parks at the cap', async () => {
    ;(bot as any).sender = { send: async () => ({ ok: true, ms: 1, hash: '0x' + 'cd'.repeat(32) }) }
    const pos = newPosition({
      id: 1, token: TOKEN, curve: CURVE, tokens: 500n, spendWei: 5_000_000_000_000_000n,
      entryMarkWei: 5_000_000_000_000_000n, openedAt: Date.now(), buyHash: '0x' + 'ab'.repeat(32), takeProfitMultiple: 1.25, filled: true,
    })
    pos.exiting = true
    for (let i = 0; i < STRATEGY.maxSellAttempts + 1; i++) { pos.sellInFlight = false; await (bot as any).fireExit(pos, 'time') }
    expect(pos.attempts).toBe(STRATEGY.maxSellAttempts)
    expect(pos.parked).toBe(true)
  })
})
