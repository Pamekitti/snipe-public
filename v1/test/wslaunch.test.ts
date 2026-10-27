/**
 * A launch that arrives over the SOCKET, end to end through the bot.
 *
 * Review, 2026-09-06: the socket delivered TokenLaunched alone, bot.ts read the creator's
 * buy from the batch, every socket-first launch screened as "dev buy 0" and the poller's
 * copy was deduped. Fixed by reading the dev buy from the launch calldata and by waiting
 * for the public rpc, which is ~0.85s behind the socket, instead of failing the read.
 * Pinned here: the row is written with the calldata dev buy and passed=1, the curve read
 * was retried until it answered, and the poller path is unchanged either way.
 *
 * Also the state engine guard that the socket path needs: a book seeded from a read at
 * block B must not fold in a log from block <= B, or the creator's own buy lands twice.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bot } from '../src/bot.js'
import { StateEngine } from '../src/state/engine.js'
import { ADDRESSES, STRATEGY } from '../src/config.js'
import { setConfigForTest } from '../src/config/store.js'
import { EVENT_TOPICS } from '../src/abi.js'
import { settle } from './helpers/settle.js'

const pad = (addr: string) => '0x' + addr.slice(2).toLowerCase().padStart(64, '0')
const word = (n: bigint) => n.toString(16).padStart(64, '0')
const TOKEN = '0x' + '51'.repeat(20)
const CURVE = '0x' + '52'.repeat(20)
// a fresh deployer per test: the deployer registry is process-wide, so the same address
// across tests reads as a serial launcher by the fourth test and the book rejects it
let devN = 0
const DEV = () => '0x' + (0x5300 + devN).toString(16).padStart(40, '0')
const TX = '0x' + 'ab'.repeat(32)
const launchLog = (viaWs: boolean) => ({
  address: ADDRESSES.factory.toLowerCase(), topics: [EVENT_TOPICS.TokenLaunched, pad(TOKEN), pad(CURVE), pad(DEV())],
  data: pad(ADDRESSES.ethPair), blockNumber: 1000, logIndex: 1, transactionHash: TX, blockHash: '0x' + 'cd'.repeat(32),
  ...(viaWs ? { viaWs: true } : {}),
})
const DEV_BUY = 50_000_000_000_000_000n // 0.05 ETH, above the book's 0.01 floor
const buyLog = () => ({
  address: CURVE, topics: [EVENT_TOPICS.CurveBuy], data: '0x' + word(DEV_BUY) + word(10n ** 24n) + word(0n) + word(0n),
  blockNumber: 1000, logIndex: 2, transactionHash: TX, blockHash: '0x' + 'cd'.repeat(32),
})
/** the thirteen curve values plus the block the read executed at */
// launchedAt well in the future, or the entry arms at once and the armed map is already
// empty by the time the assertion looks (the fallback timer fires on the next tick)
const curveRead = [1n, 1n, 10n ** 27n, 100n, 100n, 9900n, 3n, BigInt(Math.floor(Date.now() / 1000) + 600), 1n, 10n ** 27n, 0n, 0n, false, 1003n]
const meta = {
  name: 'X', symbol: 'X', logo: '', hasTwitter: true, hasWebsite: false, hasTelegram: false,
  descriptionLen: 10, exemptions: 5, buybackEnabled: false, quoteInWei: DEV_BUY,
}

describe('a launch over the socket', () => {
  let dir: string
  let bot: Bot
  beforeEach(() => {
    devN++
    dir = mkdtempSync(join(tmpdir(), 'wsl-'))
    bot = new Bot({ mode: 'observe', dbFile: join(dir, 'bot.db') } as any)
  })
  afterEach(async () => {
    for (const a of (bot as any).armed.values()) clearTimeout(a.fallback)
    await settle()
    bot.tel.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const row = async () => {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 20))
      await settle()
      const r = bot.tel.raw().prepare('SELECT passed, reject_reason, dev_buy_wei, detect_source FROM launches WHERE token=?').get(TOKEN) as any
      if (r) return r
    }
    throw new Error('no launches row')
  }

  it('screens with the dev buy from the calldata, after waiting for the public rpc to have the block', async () => {
    let reads = 0
    ;(bot as any).client = {
      // the public rpc is behind the socket: the first two reads find no contract there
      multicall: async () => { reads++; if (reads < 3) throw new Error('returned no data ("0x")'); return curveRead },
      getTransaction: async () => { throw new Error('should not be asked: the feed had the calldata') },
    }
    ;(bot as any).launchMetaByTx.set(TX, meta)
    ;(bot as any).onLogs([launchLog(true)])
    const r = await row()
    expect(r.passed).toBe(1)
    expect(r.dev_buy_wei).toBe(DEV_BUY.toString())
    expect(r.detect_source).toBe('ws') // so the two transports can be compared in the launches table
    expect(reads).toBe(3)
    expect((bot as any).armed.has(CURVE)).toBe(true)
    // and the tracked book knows which block it was read at, so the poller's later copy of
    // the creator's buy (block 1000 <= 1003) is not folded in a second time
    const before = (bot as any).state.get(CURVE).confirmed.trackedQuote
    ;(bot as any).state.applyLog(buyLog())
    expect((bot as any).state.get(CURVE).confirmed.trackedQuote).toBe(before)
  })

  it('reads the calldata from the chain when the feed did not carry it, retrying until it is there', async () => {
    let txReads = 0
    ;(bot as any).client = {
      multicall: async () => curveRead,
      getTransaction: async () => { txReads++; if (txReads < 2) throw new Error('TransactionNotFound'); return { input: '0x' } },
    }
    ;(bot as any).onLogs([launchLog(true)])
    const r = await row()
    // '0x' parses to no metadata, so this one is rejected: but by its real reason, and only
    // after the chain was asked more than once
    expect(r.passed).toBe(0)
    expect(r.reject_reason).toBe('no launch metadata (ws)')
    expect(txReads).toBe(2)
  })

  it('the poller path is unchanged: dev buy from the batch, and a bare poller launch still reads dev buy 0', async () => {
    ;(bot as any).client = { multicall: async () => curveRead, getTransaction: async () => { throw new Error('x') } }
    ;(bot as any).launchMetaByTx.set(TX, meta)
    ;(bot as any).onLogs([launchLog(false), buyLog()])
    const r = await row()
    expect(r.passed).toBe(1)
    expect(r.dev_buy_wei).toBe(DEV_BUY.toString())
    bot.tel.raw().prepare('DELETE FROM launches WHERE token=?').run(TOKEN)
    ;(bot as any).state.untrack(CURVE)
    ;(bot as any).launchMetaByTx.set(TX, meta)
    ;(bot as any).onLogs([launchLog(false)])
    const r2 = await row()
    expect(r2.passed).toBe(0)
    expect(r2.reject_reason).toBe('dev buy 0')
  })
})

describe('StateEngine.applyLog block guard', () => {
  const params = { phantomQuote: 1n, reservedTokens: 1n, launchSupply: 10n ** 27n, feeBps: 100n, creatorTaxBps: 100n, snipeTaxStartBps: 9900n, snipeTaxSeconds: 3n, launchedAt: 1n }
  const state = { trackedQuote: 5n, trackedTokens: 10n ** 27n, quoteFeeBalance: 0n, creatorTaxBalance: 0n, graduated: false }
  it('skips a log the seeded read already contained, applies every later one, including the rest of a block', () => {
    const e = new StateEngine()
    e.track(CURVE, TOKEN, params as any, state, 1003)
    e.applyLog({ ...buyLog(), blockNumber: 1003 } as any)
    expect(e.get(CURVE)!.confirmed.trackedQuote).toBe(5n)
    e.applyLog({ ...buyLog(), blockNumber: 1004 } as any)
    expect(e.get(CURVE)!.confirmed.trackedQuote).toBe(5n + DEV_BUY)
    expect(e.get(CURVE)!.confirmedBlock).toBe(1004)
    // the second trade of block 1004 is not "already in the seed": it folds too (2026-09-06)
    e.applyLog({ ...buyLog(), blockNumber: 1004, logIndex: 3 } as any)
    expect(e.get(CURVE)!.confirmed.trackedQuote).toBe(5n + 2n * DEV_BUY)
    expect(e.get(CURVE)!.seedBlock).toBe(1003)
  })
})

/**
 * The provider key is used only inside WS_HOURS.
 *
 * This was the entry window (ENTRY_UTC_HOURS) until 2026-09-07, doing two jobs at once: a
 * trading filter that declined night launches, and the only throttle the 30M-a-month key
 * has ever had. The trading half is deleted; this half is not, and it is now its own
 * restart-only switch. It gates WHERE a launch is read from, never WHETHER it is traded.
 */
describe('the two per-launch reads route to the provider key inside WS_HOURS', () => {
  let dir: string
  let bot: Bot
  const wsWas = process.env.WS_HOURS
  beforeEach(() => {
    devN++
    dir = mkdtempSync(join(tmpdir(), 'wsk-'))
    bot = new Bot({ mode: 'observe', dbFile: join(dir, 'bot.db') } as any)
  })
  afterEach(async () => {
    if (wsWas === undefined) delete process.env.WS_HOURS
    else process.env.WS_HOURS = wsWas
    for (const a of (bot as any).armed.values()) clearTimeout(a.fallback)
    await settle()
    bot.tel.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const row = async () => {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 20))
      await settle()
      const r = bot.tel.raw().prepare('SELECT passed, reject_reason, dev_buy_wei, launched_at, creator_tax_bps, exemptions FROM launches WHERE token=?').get(TOKEN) as any
      if (r) return r
    }
    throw new Error('no launches row')
  }
  const h = new Date().getUTCHours()

  it('window open: both reads go to the key once each, the public client is not asked, the budget is charged', async () => {
    delete process.env.WS_HOURS // blank means always, which is the live setting
    let pub = 0, key = 0, keyTx = 0
    ;(bot as any).client = { multicall: async () => { pub++; return curveRead }, getTransaction: async () => { pub++; return { input: '0x' } } }
    ;(bot as any).keyClient = { multicall: async () => { key++; return curveRead }, getTransaction: async () => { keyTx++; return { input: '0x' } } }
    ;(bot as any).onLogs([launchLog(true)])
    const r = await row()
    expect(r.reject_reason).toBe('no launch metadata (ws)') // '0x' is not launchAndBuy; the routing is what this test is about
    expect(key).toBe(1)
    expect(keyTx).toBe(1)
    expect(pub).toBe(0)
    expect(bot.meters.keyReads).toBe(2)
    expect(bot.readBudget.calls).toEqual({ eth_call: 1, eth_getTransactionByHash: 1 })
  })

  it('the key fails: the public rpc takes over exactly as before, and the fallback is counted', async () => {
    delete process.env.WS_HOURS
    let pub = 0
    ;(bot as any).client = { multicall: async () => { pub++; return curveRead }, getTransaction: async () => { pub++; return { input: '0x' } } }
    ;(bot as any).keyClient = { multicall: async () => { throw new Error('http 500') }, getTransaction: async () => { throw new Error('http 500') } }
    ;(bot as any).launchMetaByTx.set(TX, meta)
    ;(bot as any).onLogs([launchLog(true)])
    const r = await row()
    expect(r.passed).toBe(1)
    expect(pub).toBe(1)                              // readCurve on the public rpc (the feed had the calldata)
    expect(bot.meters.keyReadFallbacks).toBe(1)
    expect(bot.meters.keyReads).toBe(3)              // three quick tries on the key
  })

  it('outside the hours: the public rpc, and the key is never charged', async () => {
    process.env.WS_HOURS = `${(h + 2) % 24}-${(h + 3) % 24}`
    let pub = 0, key = 0
    ;(bot as any).client = { multicall: async () => { pub++; return curveRead }, getTransaction: async () => { throw new Error('x') } }
    ;(bot as any).keyClient = { multicall: async () => { key++; return curveRead }, getTransaction: async () => { throw new Error('x') } }
    ;(bot as any).launchMetaByTx.set(TX, meta)
    ;(bot as any).onLogs([launchLog(false), buyLog()])
    await row()
    expect(pub).toBe(1)
    expect(key).toBe(0)
    expect(bot.readBudget.calls).toEqual({})
  })

  it('over budget: the reads STAY on the key; a projection never moves them', async () => {
    // 2026-09-06 evening: 99% of pace with 1% of the month spent, in the busiest hour of
    // the week, and the gate would have sent the reads to a public rpc refusing 1,100
    // polls an hour. Only a provider that actually refuses (the test above) moves them.
    delete process.env.WS_HOURS
    ;(bot as any).readBudget = { allow: () => false, spent: () => {}, calls: {} }
    let pub = 0, key = 0
    ;(bot as any).client = { multicall: async () => { pub++; return curveRead }, getTransaction: async () => { throw new Error('x') } }
    ;(bot as any).keyClient = { multicall: async () => { key++; return curveRead }, getTransaction: async () => { throw new Error('x') } }
    ;(bot as any).launchMetaByTx.set(TX, meta)
    ;(bot as any).onLogs([launchLog(true)])
    await row()
    expect(key).toBe(1)
    expect(pub).toBe(0)
  })

  it('calldata the feed already delivered rejects a launch before any paid read', async () => {
    // 35% of socket launches in the four hours before this shipped paid for a curve read
    // and were then rejected on the calldata alone.
    delete process.env.WS_HOURS
    let pub = 0, key = 0
    ;(bot as any).client = { multicall: async () => { pub++; return curveRead }, getTransaction: async () => { pub++; return { input: '0x' } } }
    ;(bot as any).keyClient = { multicall: async () => { key++; return curveRead }, getTransaction: async () => { key++; return { input: '0x' } } }
    ;(bot as any).launchMetaByTx.set(TX, { ...meta, exemptions: 0 })
    ;(bot as any).launchTsByTx.set(TX, 1_700_000_000)
    ;(bot as any).onLogs([launchLog(true)])
    const r = await row()
    expect(r.passed).toBe(0)
    expect(r.reject_reason).toBe('no exempt wallets (0)')
    expect(r.launched_at).toBe(1_700_000_000)  // the feed's block stamp, not a guess
    expect(r.creator_tax_bps).toBeNull()       // never read; the row says so
    expect(r.exemptions).toBe(0)
    expect(key).toBe(0)
    expect(pub).toBe(0)
    expect(bot.meters.preScreened).toBe(1)
  })

  it('a launch through another contract, seen on the feed, costs no read at all', async () => {
    // 22% of socket launches: the feed saw the tx to the launcher but it is not
    // launchAndBuy. They used to pay for two reads to be rejected the same way.
    delete process.env.WS_HOURS
    let pub = 0, key = 0
    ;(bot as any).client = { multicall: async () => { pub++; return curveRead }, getTransaction: async () => { pub++; return { input: '0x' } } }
    ;(bot as any).keyClient = { multicall: async () => { key++; return curveRead }, getTransaction: async () => { key++; return { input: '0x' } } }
    ;(bot as any).launchTxUnparseable.add(TX)
    ;(bot as any).onLogs([launchLog(true)])
    const r = await row()
    expect(r.reject_reason).toBe('no launch metadata (ws)')
    expect(key + pub).toBe(0)
  })
})
