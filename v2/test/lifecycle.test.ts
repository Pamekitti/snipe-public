/**
 * One position, end to end, through the fold and nothing else.
 *
 * WHY THIS FILE EXISTS. Every other core test checks one pure function. None of them folded a
 * whole trade, and the gap hid a bug that would have stopped the new core trading on its
 * first day: a successful send deleted its own inflight record, so the CurveBuy log that
 * followed had nothing to match against, no position was ever opened, and `risk.reserved` was
 * never released. After 14 buys every launch would have been refused for capacity, forever,
 * with the book showing zero positions open.
 *
 * It was found by the monitor rather than by a test: `risk-capacity` at 10 alongside `open 0`
 * is an impossible pair, and it was on the page. A unit test per function cannot see a defect
 * that lives in the seam between two of them.
 *
 * The sequence below is the real one, in the real order: launch log, curve read, arm, feed
 * block to release it, signature, send result, fill.
 */
import { describe, expect, it } from 'vitest'
import { decide } from '../core/decide.js'
import { templateKey } from '../core/entry.js'
import { emptyState, type Outcome, type State } from '../core/state.js'
import { ADDRESSES, EVENT_TOPICS } from '../core/chain.js'
import { SELL_SETTLE_GIVEUP_MS } from '../core/exit.js'
import type { Event } from '../core/events.js'
import type { BookSpec, FrozenConfig, Switches } from '../core/config.js'

const TOKEN = '0x000000000000000000000000000000000000aaaa'
const CURVE = '0x000000000000000000000000000000000000cccc'
const DEPLOYER = '0x000000000000000000000000000000000000dddd'
const HASH = '0x' + '11'.repeat(32)
/** Somebody else's wallet and somebody else's transaction, so the replay must keep theirs. */
const STRANGER = '0x000000000000000000000000000000000000eeee'
const STRANGER_TX = '0x' + '22'.repeat(32)

const topic = (addr: string): string => '0x' + '00'.repeat(12) + addr.slice(2)
const word = (v: bigint | string): string => BigInt(v).toString(16).padStart(64, '0')

// A book is a COMPLETE POLICY since 2026-09-16: its own size, stop, entry, exit, ladder and
// guard. A fixture that carried only the band would not compile, which is the point.
const BOOK: BookSpec = {
  id: 'only', minCreatorTaxBps: 0, maxCreatorTaxBps: 0, minExemptions: 3, templateLossBlockMs: 3_600_000,
  sizeWei: '5000000000000000', maxDrawdownWei: '15000000000000000',
  entry: { entryDelayMs: 2_000, entryFallbackLateMs: 600, maxEntryPriceMultiple: 4.5, buySlippageBps: 5_000 },
  exit: { maxHoldMs: 45_000, hardStopMultiple: 0.5, deadCoinAfterMs: 20_000, deadCoinBelowMultiple: 1.03, graduationExitAt: 0.12, maxSellAttempts: 20, exitRetryDelayMs: 300, sellFinalMinQuoteOutWei: '1' },
  takeProfit: { otherwise: 1.75, adaptiveWindow: 20, adaptiveBars: [1.25, 1.75] },
  guard: { window: 20, recoveryWindow: 8, openAt: 1, shutAt: -1, settleMs: 52_000, freshMs: 10_800_000, pnlBar: 1.75, maxReadingAgeMs: 10_800_000 },
}

const CFG: FrozenConfig = {
  specVersion: 1, books: [BOOK],
  risk: {
    maxConcurrent: 14, maxTradeSizeWei: '20000000000000000', bankrollWei: '80000000000000000', drawdownStakes: 3,
    maxWalletDrawdownWei: '15000000000000000',
    brokenWindow: 20, brokenFactor: 0.78, brokenGapPp: 15, maxLogsStalenessMs: 3_000, maxOverlayAgeMs: 1_500,
  },
  clock: { periodMs: 250 },
}

const SW: Switches = { sizeWei: 5_000_000_000_000_000n, mode: 'live', at: 0, by: 'test' }

/** Real numbers, read off a launch on the live tape on 2026-09-16. */
const T0 = 1_789_558_000_000
const PARAMS = {
  phantomQuote: '1680000000000000000',
  reservedTokens: '285714285714285714285714285',
  launchSupply: '1000000000000000000000000000',
  feeBps: '100',
  creatorTaxBps: '0',
  snipeTaxStartBps: '9900',
  snipeTaxSeconds: '3',
  launchedAt: String(Math.floor(T0 / 1000)),
}
const CURVE_STATE = {
  trackedQuote: '0', trackedTokens: '1000000000000000000000000000',
  quoteFeeBalance: '0', creatorTaxBalance: '0', graduated: false, block: 100,
}

let seq = 0
const ev = <T extends object>(at: number, kind: string, body: T): Event =>
  ({ seq: ++seq, at, run: 'test', kind, ...body } as unknown as Event)

const launchLog = (block: number) => ({
  address: ADDRESSES.factory,
  topics: [EVENT_TOPICS.TokenLaunched, topic(TOKEN), topic(CURVE), topic(DEPLOYER)],
  // word 0 is the pair token: zero means the ETH pair, which is the one we trade
  data: '0x' + word(0n),
  blockNumber: block, logIndex: 0, transactionIndex: 0,
  transactionHash: '0x' + 'ab'.repeat(32), blockHash: '0x' + 'cd'.repeat(32), removed: false,
})

describe('quiet preparation and the original entry clock', () => {
  function armed() {
    let s = emptyState(CFG, SW)
    s = decide(s, ev(T0, 'logs-status', { healthy: true, mode: 'poll', reason: '', entryReady: false, quietEntryHold: true })).state
    s = decide(s, ev(T0, 'logs', { source: 'poll', lo: 100, hi: 100, logs: [launchLog(100)] })).state
    s = decide(s, ev(T0 + 50, 'chain-read', { request: { kind: 'meta', args: [CURVE, TOKEN] }, result: { params: PARAMS, state: CURVE_STATE, exemptions: 3 } })).state
    return s
  }
  it('keeps a chain-released arm while preparing, without moving its deadline', () => {
    const s = armed(), deadline = s.armed.get(TOKEN)!.armAt
    const out = decide(s, ev(T0 + 2000, 'feed-block', { block: 120, timestamp: Math.floor(T0 / 1000) + 2, txs: [] }))
    expect(out.intents.some(i => i.kind === 'buy')).toBe(false)
    expect(out.state.armed.get(TOKEN)!.armAt).toBe(deadline)
    expect(out.state.armed.get(TOKEN)!.releasedByBlock).toBe(120)
  })
  it('expires at the original fallback time even when preparation remains held', () => {
    let s = armed()
    s = decide(s, ev(T0 + 2000, 'feed-block', { block: 120, timestamp: Math.floor(T0 / 1000) + 2, txs: [] })).state
    const out = decide(s, ev(T0 + 2600, 'clock', {}))
    expect(out.state.armed.has(TOKEN)).toBe(false)
    expect(out.intents.some(i => i.kind === 'buy')).toBe(false)
    expect(out.refusals.some(r => r.bucket === 'risk-logs-unhealthy')).toBe(true)
  })
})

/**
 * Our own buy landing.
 *
 * FOUR WORDS, not two. `settleOwnFill` reads the first two, but `deltaFor` reads all four to
 * move the local reserves. Short data used to throw there (`Cannot convert 0x to a BigInt`)
 * and kill the process; it now returns null and the log is skipped. The layout is
 * `quoteIn, tokensOut, fee, tax`.
 */
const buyLog = (block: number, spent: bigint, tokens: bigint, logIndex = 0) => ({
  address: CURVE,
  topics: [EVENT_TOPICS.CurveBuy, topic(TOKEN), topic(DEPLOYER)],
  data: '0x' + word(spent) + word(tokens) + word(0n) + word(0n),
  blockNumber: block, logIndex, transactionIndex: logIndex,
  transactionHash: HASH, blockHash: '0x' + 'ef'.repeat(32), removed: false,
})

function runToDecided(
  config: FrozenConfig = CFG,
  switches: Switches = SW,
  prepare?: (state: State) => void,
): { state: State; intentId: string; buySizeWei: bigint } {
  let s: State = emptyState(config, switches)
  prepare?.(s)

  // the stream is alive, and so is the feed overlay
  s = decide(s, ev(T0, 'logs-status', { healthy: true, mode: 'ws', reason: 'connected' })).state
  s = decide(s, ev(T0, 'feed-status', { connected: true, reason: 'connected' })).state
  s = decide(s, ev(T0, 'feed-block', { block: 100, timestamp: Math.floor(T0 / 1000), txs: [] })).state

  // the launch, and the read it asks for
  s = decide(s, ev(T0 + 10, 'logs', { logs: [launchLog(101)], source: 'ws', lo: 101, hi: 101 })).state
  s = decide(s, ev(T0 + 60, 'chain-read', {
    request: { kind: 'meta', args: [CURVE, TOKEN] },
    result: { params: PARAMS, state: CURVE_STATE, exemptions: 5 },
    viaKey: true, tries: 1, latencyMs: 0,
  })).state

  /**
   * The arm releases on a feed block past the delay, and the buy intent is raised there.
   *
   * The block is at +5s, not +2.1s, for two reasons that are both rules rather than fixture
   * noise. The release compares against the CHAIN's timestamp, which has one-second
   * granularity, so a block at +2.1s carries +2s and is still short of an arm at +2.06s. And
   * the entry refuses on logs older than 3,000ms, so the stream has to have delivered
   * recently or `risk-logs-stale` takes the decision instead.
   */
  s = decide(s, ev(T0 + 4_900, 'logs', { logs: [], source: 'ws', lo: 102, hi: 102 })).state
  const released = decide(s, ev(T0 + 5_000, 'feed-block', { block: 102, timestamp: Math.floor((T0 + 5_000) / 1000), txs: [] }))
  s = released.state
  const buy = released.intents.find((i) => i.kind === 'buy')
  if (!buy || buy.kind !== 'buy') throw new Error(`no buy intent was raised: ${JSON.stringify(released.refusals)}`)
  return { state: s, intentId: buy.intentId, buySizeWei: buy.sizeWei }
}

function runToSent(): { state: State; sent: string } {
  const { state: s0, intentId } = runToDecided()
  let s = s0
  s = decide(s, ev(T0 + 5_100, 'tx-signed', { intentId, txKind: 'buy', hash: HASH, nonce: 7, raw: '0x00' })).state
  s = decide(s, ev(T0 + 5_200, 'tx-send-result', {
    intentId, hash: HASH, ok: true, nonceConsumed: true, uncertain: false,
    statusCode: null, error: null, tSigned: T0 + 5_100, tSent: T0 + 5_200,
  })).state
  return { state: s, sent: intentId }
}

function confirmApproval(s: State, sent: string, hash = '0x' + 'aa'.repeat(32)): State {
  const p = s.positions.get(sent)!
  const id = p.approval!.intentId!
  const at = s.at
  s = decide(s, ev(at + 1, 'tx-signed', { intentId: id, txKind: 'approve', hash, nonce: 8, raw: '0x00' })).state
  s = decide(s, ev(at + 2, 'tx-send-result', { intentId: id, hash, ok: true, nonceConsumed: true, uncertain: false, statusCode: null, error: null, tSigned: at + 1, tSent: at + 2 })).state
  s = decide(s, ev(at + 3, 'receipt', { hash, result: { ok: true, gasWei: '0', proceedsWei: null, remainingWei: null, error: null } })).state
  return decide(s, ev(at + 4, 'chain-read', {
    request: { kind: 'allowance', args: [TOKEN, CURVE, sent] }, result: { allowanceWei: String((1n << 256n) - 1n) },
    viaKey: true, tries: 1, latencyMs: 0,
  })).state
}

describe('the September 23 approval and receipt incident', () => {
  it('charges a successful buy receipt once while its balance evidence is unavailable', () => {
    let {state:s}=runToSent()
    for(let n=0;n<3;n++) s=decide(s,ev(T0+6000+n,'receipt',{
      hash:HASH,result:{ok:true,gasWei:'2000',proceedsWei:null,remainingWei:null,error:'balance read failed'},
    })).state
    expect(s.risk.walletGasWei).toBe(2000n)
    expect(s.risk.reserved).toBe(1)
  })
  it('keeps rejected approvals from consuming sell attempts, then exits after allowance proof', () => {
    let { state: s, sent } = runToOpen(false)
    for (let n = 0; n < 25; n++) {
      const p = s.positions.get(sent)!
      const id = p.approval!.intentId!
      const at = s.at + 1
      s = decide(s, ev(at, 'tx-send-result', {
        intentId: id, hash: '', ok: false, nonceConsumed: false, uncertain: false,
        statusCode: null, error: 'intrinsic gas too low', tSigned: at, tSent: at,
      })).state
      const retry = decide(s, ev(Math.max(T0 + 60_000, p.approval!.retryAt), 'clock', {}))
      expect(retry.intents.filter((i) => i.kind === 'sell')).toHaveLength(0)
      expect(retry.intents.filter((i) => i.kind === 'approve')).toHaveLength(1)
      expect(p.attempts).toBe(0)
      s = retry.state
    }
    s = confirmApproval(s, sent)
    const out = decide(s, ev(s.at + 1, 'clock', {}))
    expect(out.intents.filter((i) => i.kind === 'sell')).toHaveLength(1)
    expect(out.state.positions.get(sent)!.approval!.ready).toBe(true)
  })

  it('does not infer an allowance from an accepted or successful approval transaction', () => {
    let { state: s, sent } = runToOpen(false)
    const id = s.positions.get(sent)!.approval!.intentId!
    const hash = '0x' + 'ac'.repeat(32)
    s = decide(s, ev(s.at + 1, 'tx-send-result', { intentId:id, hash, ok:true, nonceConsumed:true, uncertain:false, statusCode:null, error:null, tSigned:0, tSent:0 })).state
    let out = decide(s, ev(T0 + 60_000, 'clock', {}))
    expect(out.intents.some((i) => i.kind === 'sell')).toBe(false)
    out = decide(out.state, ev(T0 + 60_001, 'receipt', { hash, result:{ok:true,gasWei:'100',proceedsWei:null,remainingWei:null,error:null} }))
    expect(out.intents).toContainEqual({kind:'read',what:'allowance',args:[TOKEN,CURVE,sent]})
    out = decide(out.state, ev(T0 + 60_002, 'chain-read', {request:{kind:'allowance',args:[TOKEN,CURVE,sent]},result:{allowanceWei:'0'},viaKey:true,tries:1,latencyMs:0}))
    expect(out.state.positions.get(sent)!.approval!.ready).toBe(false)
    expect(out.state.positions.get(sent)!.attempts).toBe(0)
    expect(out.state.risk.walletGasWei).toBe(100n)
  })

  it('reads the latest failed sell and ignores duplicate receipts from an earlier attempt', () => {
    let {state:s,sent} = runToOpen()
    const hashes = ['0x'+'b1'.repeat(32),'0x'+'b2'.repeat(32)]
    for (let n=0;n<2;n++) {
      const at=T0+60_000+n*30_000
      const out=decide(s,ev(at,'clock',{}))
      const sell=out.intents.find((i)=>i.kind==='sell')!
      if(sell.kind!=='sell') throw new Error('missing sell')
      s=decide(out.state,ev(at+1,'tx-signed',{intentId:sell.intentId,txKind:'sell',hash:hashes[n],nonce:20+n,raw:'0x00'})).state
      expect(s.positions.get(sent)!.lastSellHash).toBe(hashes[n])
      const timed=decide(s,ev(at+1+SELL_SETTLE_GIVEUP_MS,'clock',{}))
      expect(timed.intents.filter((i)=>i.kind==='read'&&i.what==='receipt')).toEqual([{kind:'read',what:'receipt',args:[hashes[n],TOKEN,CURVE]}])
      expect(timed.intents.some((i)=>i.kind==='sell')).toBe(false)
      expect(timed.state.positions.get(sent)!.attempts).toBe(n)
      if(n===0) {
        const failed=ev(at+2+SELL_SETTLE_GIVEUP_MS,'receipt',{hash:hashes[0],result:{ok:false,gasWei:'100',proceedsWei:null,remainingWei:null,error:'reverted'}})
        s=decide(timed.state,failed).state
        s=confirmApproval(s,sent,'0x'+'a2'.repeat(32))
      } else {
        s=decide(timed.state,ev(at+2+SELL_SETTLE_GIVEUP_MS,'receipt',{hash:hashes[0],result:{ok:false,gasWei:'100',proceedsWei:null,remainingWei:null,error:'reverted'}})).state
        expect(s.risk.walletGasWei).toBe(100n)
        expect(s.positions.get(sent)!.sellReceipts!.has(hashes[1]!)).toBe(true)
        s=decide(s,ev(at+3+SELL_SETTLE_GIVEUP_MS,'receipt',{hash:hashes[1],result:{ok:true,gasWei:'150',proceedsWei:'3000000000000000',remainingWei:'0',error:null}})).state
        expect(s.positions.get(sent)!.closed).toBe(true)
        expect(s.positions.get(sent)!.attempts).toBe(2)
        expect(s.risk.walletGasWei).toBe(250n)
      }
    }
  })
})

describe('entry uses the launch block without whole-second rounding', () => {
  function armed() {
    let s=emptyState(CFG,SW)
    s=decide(s,ev(T0,'logs-status',{healthy:true,mode:'poll',reason:'healthy'})).state
    s=decide(s,ev(T0+350,'logs',{logs:[launchLog(100)],source:'poll',lo:100,hi:100})).state
    return decide(s,ev(T0+500,'chain-read',{request:{kind:'meta',args:[CURVE,TOKEN]},result:{params:PARAMS,state:CURVE_STATE,exemptions:5},viaKey:true,tries:1,latencyMs:150}))
  }
  it('buys at block +20 even when the whole-second timestamp has not reached the wall deadline', () => {
    const initial=armed()
    expect(initial.state.armed.get(TOKEN)!.armAt).toBe(T0+2350)
    const early=decide(initial.state,ev(T0+2250,'feed-block',{block:119,timestamp:T0/1000+2,txs:[]}))
    expect(early.intents.some((i)=>i.kind==='buy')).toBe(false)
    const due=decide(early.state,ev(T0+2350,'feed-block',{block:120,timestamp:T0/1000+2,txs:[]}))
    expect(due.intents.filter((i)=>i.kind==='buy')).toHaveLength(1)
  })
  it('cannot buy on automatic recovery until the paid catch-up hold is released', () => {
    const waiting = armed().state
    const held = decide(waiting, ev(T0 + 600, 'logs-status', {
      healthy: true, mode: 'poll', reason: 'all books halted observation', entryReady: false,
    })).state
    // The venue can reopen between metadata and the entry deadline. The transport hold is independent.
    held.risk.halts.clear()
    const due = decide(held, ev(T0 + 2350, 'feed-block', { block: 120, timestamp: T0 / 1000 + 2, txs: [] }))
    expect(due.intents.some(i => i.kind === 'buy')).toBe(false)
    expect(due.refusals.some(r => r.reason.includes('paid log catch-up'))).toBe(true)
    const ready = decide(armed().state, ev(T0 + 600, 'logs-status', {
      healthy: true, mode: 'poll', reason: 'paid catch-up processed', entryReady: true,
    })).state
    const resumed = decide(ready, ev(T0 + 2350, 'feed-block', { block: 120, timestamp: T0 / 1000 + 2, txs: [] }))
    expect(resumed.intents.filter(i => i.kind === 'buy')).toHaveLength(1)
  })
  it('schedules and uses the configured wall-clock fallback with fresh stream evidence', () => {
    const initial=armed()
    expect(initial.intents).toContainEqual({kind:'arm',token:TOKEN,releaseAt:T0+2950})
    const before=decide(initial.state,ev(T0+2900,'feed-block',{block:119,timestamp:T0/1000+2,txs:[]}))
    expect(before.intents.some((i)=>i.kind==='buy')).toBe(false)
    const due=decide(before.state,ev(T0+2950,'clock',{}))
    expect(due.intents.filter((i)=>i.kind==='buy')).toHaveLength(1)
  })
})

function runToOpen(approved = true): { state: State; sent: string } {
  const { state: s0, sent } = runToSent()
  const s = decide(s0, ev(T0 + 5_600, 'logs', {
    logs: [buyLog(103, 5_000_000_000_000_000n, 29_000_000_000_000_000_000_000n)], source: 'ws', lo: 103, hi: 103,
  })).state
  return { state: approved ? confirmApproval(s, sent) : s, sent }
}

describe('one position, from launch to fill', () => {
  it('puts the adaptive weak and strong sizes on the real buy intent', () => {
    const sizing = {
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
      freshMs: 10_800_000,
    } as const
    const adaptiveBook: BookSpec = {
      ...BOOK,
      sizeWei: '10000000000000000',
      maxDrawdownWei: '20000000000000000',
      sizing,
    }
    const config: FrozenConfig = { ...CFG, specVersion: 3, books: [adaptiveBook] }
    const switches: Switches = { ...SW, sizeWei: 2_500_000_000_000_000n }

    expect(runToDecided(config, switches).buySizeWei).toBe(1_250_000_000_000_000n)

    const strong = runToDecided(config, switches, (state) => {
      for (let i = 0; i < 4; i++) {
        const outcome: Outcome = {
          token: `strong-${i}`, book: BOOK.id, at: T0 - (4 - i) * 1_000,
          perBar: {}, stakes: 0.2, sizingStakes: 0.2, peak: 1,
        }
        state.cohort.push(outcome)
      }
    })
    expect(strong.buySizeWei).toBe(3_125_000_000_000_000n)
  })

  it('opens a position when our own buy lands', () => {
    const { state, sent } = runToOpen()
    const pos = state.positions.get(sent)
    expect(pos, `no position was opened. refusals: ${JSON.stringify(state.counters)}`).toBeDefined()
    expect(pos!.token).toBe(TOKEN)
    expect(pos!.book).toBe('only')
    expect(pos!.spendWei).toBe(5_000_000_000_000_000n)
    expect(pos!.tokensHeld).toBe(29_000_000_000_000_000_000_000n)
    expect(pos!.closed).toBe(false)
    expect(pos!.filled).toBe(true)
  })

  it('writes an unconfirmed row on a successful send, not a fill', () => {
    const { state, sent } = runToSent()
    const pos = state.positions.get(sent)
    expect(pos, 'a sent buy must be a row, the way v1 wrote it').toBeDefined()
    expect(pos!.filled).toBe(false)
    expect(pos!.tokensHeld).toBe(0n)
    expect(pos!.closed).toBe(false)
    expect(pos!.entryMarkWei).toBe(0n)
    expect(state.inflight.has(sent), 'the fill still has an owner').toBe(true)
    expect(state.risk.reserved).toBe(1)
  })

  it('does not sell an unconfirmed row', () => {
    const { state, sent } = runToSent()
    const ticked = decide(state, ev(T0 + 60_000, 'clock', {}))
    expect(ticked.intents.some((i) => i.kind === 'sell'), 'a send is not a bag').toBe(false)
    expect(ticked.state.positions.get(sent)!.filled).toBe(false)
    expect(ticked.state.positions.get(sent)!.closed).toBe(false)
  })

  it('confirms the same row when the fill lands', () => {
    const { state, sent } = runToOpen()
    expect(state.positions.size).toBe(1)
    expect(state.positions.get(sent)!.filled).toBe(true)
    expect(state.positions.get(sent)!.tokensHeld).toBe(29_000_000_000_000_000_000_000n)
    expect(state.positions.get(sent)!.entryMarkWei).toBeGreaterThan(0n)
  })

  it('keeps the inflight record across a successful send, so the fill has an owner', () => {
    /**
     * The bug, stated as a test. Deleting the inflight on a send that WORKED left the
     * arriving CurveBuy with nothing to match by hash, so no position opened and
     * `risk.reserved` was never released. Fourteen buys later every launch is refused for
     * capacity with the book showing nothing open.
     */
    let s: State = emptyState(CFG, SW)
    s = decide(s, ev(T0, 'logs-status', { healthy: true, mode: 'ws', reason: 'connected' })).state
    s = decide(s, ev(T0, 'feed-block', { block: 100, timestamp: Math.floor(T0 / 1000), txs: [] })).state
    s = decide(s, ev(T0 + 10, 'logs', { logs: [launchLog(101)], source: 'ws', lo: 101, hi: 101 })).state
    s = decide(s, ev(T0 + 60, 'chain-read', {
      request: { kind: 'meta', args: [CURVE, TOKEN] },
      result: { params: PARAMS, state: CURVE_STATE, exemptions: 5 },
      viaKey: true, tries: 1, latencyMs: 0,
    })).state
    s = decide(s, ev(T0 + 4_900, 'logs', { logs: [], source: 'ws', lo: 102, hi: 102 })).state
    const released = decide(s, ev(T0 + 5_000, 'feed-block', { block: 102, timestamp: Math.floor((T0 + 5_000) / 1000), txs: [] }))
    s = released.state
    const buy = released.intents.find((i) => i.kind === 'buy')!
    if (buy.kind !== 'buy') throw new Error('expected a buy')

    s = decide(s, ev(T0 + 5_100, 'tx-signed', { intentId: buy.intentId, txKind: 'buy', hash: HASH, nonce: 7, raw: '0x00' })).state
    s = decide(s, ev(T0 + 5_200, 'tx-send-result', {
      intentId: buy.intentId, hash: HASH, ok: true, nonceConsumed: true, uncertain: false,
      statusCode: null, error: null, tSigned: 0, tSent: 0,
    })).state
    expect(s.inflight.has(buy.intentId), 'a sent buy is in the air, not finished').toBe(true)
  })

  it('stamps the hash from a send result so a fill can match without a signed event', () => {
    const { state: s0, intentId } = runToDecided()
    let s = decide(s0, ev(T0 + 5_200, 'tx-send-result', {
      intentId, hash: HASH, ok: true, nonceConsumed: true, uncertain: false,
      statusCode: null, error: null, tSigned: T0 + 5_200, tSent: T0 + 5_200,
    })).state
    expect(s.inflight.get(intentId)?.hash).toBe(HASH)
    s = decide(s, ev(T0 + 5_600, 'logs', {
      logs: [buyLog(103, 5_000_000_000_000_000n, 29_000_000_000_000_000_000_000n)], source: 'ws', lo: 103, hi: 103,
    })).state
    expect(s.positions.get(intentId), 'the fill had no hash to match').toBeDefined()
    expect(s.positions.get(intentId)!.filled).toBe(true)
  })

  it('does not let a send-result hash replace the signed hash a fill will match', () => {
    const { state: s0, intentId } = runToDecided()
    let s = decide(s0, ev(T0 + 5_100, 'tx-signed', { intentId, txKind: 'buy', hash: HASH, nonce: 7, raw: '0x00' })).state
    s = decide(s, ev(T0 + 5_200, 'tx-send-result', {
      intentId, hash: '0x' + '99'.repeat(32), ok: true, nonceConsumed: true, uncertain: false,
      statusCode: null, error: null, tSigned: T0 + 5_100, tSent: T0 + 5_200,
    })).state
    expect(s.inflight.get(intentId)?.hash).toBe(HASH)
    s = decide(s, ev(T0 + 5_600, 'logs', {
      logs: [buyLog(103, 5_000_000_000_000_000n, 29_000_000_000_000_000_000_000n)], source: 'ws', lo: 103, hi: 103,
    })).state
    expect(s.positions.get(intentId)?.filled, 'the signed hash still owns the fill').toBe(true)
  })

  it('corrects spend from a late fill log after the receipt already opened the row', () => {
    const { state: s0, sent } = runToSent()
    let s = decide(s0, ev(T0 + 5_500, 'receipt', {
      hash: HASH,
      result: { ok: true, gasWei: '2000', proceedsWei: null, remainingWei: '29000000000000000000000', outOfGas: false, error: null },
    })).state
    expect(s.positions.get(sent)!.filled).toBe(true)
    expect(s.positions.get(sent)!.spendWei).toBe(5_000_000_000_000_000n)
    expect(s.inflight.has(sent)).toBe(false)
    const spent = 4_000_000_000_000_000n
    s = decide(s, ev(T0 + 5_600, 'logs', {
      logs: [buyLog(103, spent, 29_000_000_000_000_000_000_000n)], source: 'ws', lo: 103, hi: 103,
    })).state
    expect(s.positions.get(sent)!.spendWei).toBe(spent)
    expect(s.risk.deployedWei).toBe(spent)
    expect(s.positions.get(sent)!.filled).toBe(true)
  })

  it('releases an unconfirmed row that has no hash and a zero wallet', () => {
    const { state: s0, intentId } = runToDecided()
    let s = decide(s0, ev(T0 + 5_200, 'tx-send-result', {
      intentId, hash: '', ok: true, nonceConsumed: true, uncertain: false,
      statusCode: null, error: null, tSigned: 0, tSent: 0,
    })).state
    expect(s.positions.get(intentId)?.filled).toBe(false)
    const out = decide(s, ev(T0 + 5_300, 'chain-read', {
      request: { kind: 'position-wallet', args: [TOKEN, intentId] },
      result: { balanceWei: '0' },
      viaKey: true, tries: 1, latencyMs: 0,
    }))
    expect(out.state.positions.get(intentId)).toBeUndefined()
    expect(out.state.risk.reserved).toBe(0)
    expect(out.state.risk.deployedWei).toBe(0n)
    expect(out.refusals.some((r) => r.bucket === 'send-rejected')).toBe(true)
  })

  it('books the spent the fill paid, so close can give every wei of it back', () => {
    const { state: s0, sent } = runToSent()
    const spent = 4_000_000_000_000_000n
    const s = decide(s0, ev(T0 + 5_600, 'logs', {
      logs: [buyLog(103, spent, 29_000_000_000_000_000_000_000n)], source: 'ws', lo: 103, hi: 103,
    })).state
    expect(s.positions.get(sent)!.spendWei).toBe(spent)
    expect(s.risk.deployedWei).toBe(spent)
    expect(s.risk.reserved).toBe(1)
  })

  it('releases the slot and books the P&L when the position closes', () => {
    const { state, sent } = runToOpen()
    let s = state
    const pos = s.positions.get(sent)!
    expect(s.risk.reserved).toBe(1)

    // hold past the clock so the exit rules fire, then let the sell land
    const ticked = decide(s, ev(T0 + 60_000, 'clock', {}))
    s = ticked.state
    const sell = ticked.intents.find((i) => i.kind === 'sell')
    expect(sell, `no sell intent was raised: ${JSON.stringify(ticked.refusals)}`).toBeDefined()
    if (!sell || sell.kind !== 'sell') return
    const sellHash = '0x' + '22'.repeat(32)
    s = decide(s, ev(T0 + 60_100, 'tx-signed', { intentId: sell.intentId, txKind: 'sell', hash: sellHash, nonce: 8, raw: '0x00' })).state
    s = decide(s, ev(T0 + 60_200, 'tx-send-result', {
      intentId: sell.intentId, hash: sellHash, ok: true, nonceConsumed: true, uncertain: false,
      statusCode: null, error: null, tSigned: 0, tSent: 0,
    })).state
    s = decide(s, ev(T0 + 60_500, 'logs', {
      logs: [{
        address: CURVE,
        topics: [EVENT_TOPICS.CurveSell, topic(TOKEN), topic(DEPLOYER)],
        data: '0x' + word(pos.tokensHeld) + word(6_000_000_000_000_000n) + word(0n) + word(0n),
        blockNumber: 110, logIndex: 0, transactionIndex: 0,
        transactionHash: sellHash, blockHash: '0x' + 'ef'.repeat(32), removed: false,
      }], source: 'ws', lo: 110, hi: 110,
    })).state

    const closed = s.positions.get(sent)!
    expect(closed.closed).toBe(true)
    expect(closed.proceedsWei).toBe(6_000_000_000_000_000n)
    expect(closed.closedAt).toBe(T0 + 60_500)
    // proceeds minus stake, on the row. Not a balance difference.
    expect(s.risk.walletRealizedWei).toBe(1_000_000_000_000_000n)
    expect(s.risk.reserved, 'the slot goes back when the position does').toBe(0)
  })
})

describe('a rival buy in the same block does not hide our fill', () => {
  /**
   * 2026-09-17 buy-3684. A stranger's CurveBuy and ours landed in one block. Folding the
   * stranger first moved `confirmedThrough` to that block, then the skip treated our fill as
   * already inside the seed. No position, no approve, no sell. The skip is still needed: a
   * chain-read snapshot already contains every log up to its block. Compare against the
   * watermark as it stood at the START of the batch, not after each log.
   */
  const rivalBuy = (block: number, logIndex: number) => ({
    address: CURVE,
    topics: [EVENT_TOPICS.CurveBuy, topic(STRANGER), topic(STRANGER)],
    data: '0x' + word(1_000_000_000_000_000n) + word(7n) + word(0n) + word(0n),
    blockNumber: block, logIndex, transactionIndex: logIndex,
    transactionHash: STRANGER_TX, blockHash: '0x' + 'cd'.repeat(32), removed: false,
  })

  it('opens our position when a rival fill is processed first in the same block', () => {
    const { state: s0, sent } = runToSent()
    const s = decide(s0, ev(T0 + 5_600, 'logs', {
      logs: [
        rivalBuy(103, 11),
        buyLog(103, 5_000_000_000_000_000n, 29_000_000_000_000_000_000_000n, 17),
      ],
      source: 'ws', lo: 103, hi: 103,
    })).state
    const pos = s.positions.get(sent)
    expect(pos, 'our fill was skipped because a rival in the same block moved the watermark').toBeDefined()
    expect(pos!.spendWei).toBe(5_000_000_000_000_000n)
    expect(pos!.tokensHeld).toBe(29_000_000_000_000_000_000_000n)
    expect(s.inflight.has(sent), 'the buy inflight is gone; the leftover is the approve the fill raised').toBe(false)
  })

  it('still skips a log that was already inside the seed, on a later batch', () => {
    const { state, sent } = runToOpen()
    const again = decide(state, ev(T0 + 5_700, 'logs', {
      logs: [buyLog(103, 5_000_000_000_000_000n, 29_000_000_000_000_000_000_000n)],
      source: 'ws', lo: 103, hi: 103,
    })).state
    expect(again.positions.get(sent)!.spendWei).toBe(5_000_000_000_000_000n)
    expect(again.positions.size).toBe(1)
  })
})

describe('a short log cannot stop the bot', () => {
  /**
   * The 42-crash loop of 2026-09-17. `deltaFor` used `word()`, which throws
   * `Cannot convert 0x to a BigInt` on a short slice. That throw is inside `decide`, so
   * nothing catches it: pm2 restarts, the tape replays, it throws again. Overlay calldata
   * was one source; a short FeesSwept on the logs path is the other. Short data is a log
   * we cannot apply, not a crash.
   */
  it('folds a short FeesSwept without throwing', () => {
    const { state: s0, sent } = runToOpen()
    const short = {
      address: CURVE,
      topics: [EVENT_TOPICS.FeesSwept],
      data: '0x' + word(1n),
      blockNumber: 104, logIndex: 0, transactionIndex: 0,
      transactionHash: '0x' + '33'.repeat(32), blockHash: '0x' + '44'.repeat(32), removed: false,
    }
    expect(() => decide(s0, ev(T0 + 5_800, 'logs', { logs: [short], source: 'ws', lo: 104, hi: 104 }))).not.toThrow()
    const s = decide(s0, ev(T0 + 5_800, 'logs', { logs: [short], source: 'ws', lo: 104, hi: 104 })).state
    expect(s.positions.get(sent)?.closed).toBe(false)
  })

  it('folds an empty log data field without throwing', () => {
    const { state: s0 } = runToOpen()
    const empty = {
      address: CURVE,
      topics: [EVENT_TOPICS.CurveBuy, topic(STRANGER), topic(STRANGER)],
      data: '0x',
      blockNumber: 104, logIndex: 0, transactionIndex: 0,
      transactionHash: STRANGER_TX, blockHash: '0x' + '44'.repeat(32), removed: false,
    }
    expect(() => decide(s0, ev(T0 + 5_800, 'logs', { logs: [empty], source: 'ws', lo: 104, hi: 104 }))).not.toThrow()
  })
})

describe('a fill the watermark would skip still opens our position', () => {
  it('opens when our CurveBuy is in the seed block', () => {
    /**
     * `confirmedThrough` is max(launch block, seed block) = 101 here. Skipping settle
     * because the log is at or below that watermark is how a fill inside its own seed
     * spent ETH and never became a position. The skip is for reserves, not for ownership.
     */
    const { state: s0, sent } = runToSent()
    const s = decide(s0, ev(T0 + 5_600, 'logs', {
      logs: [buyLog(101, 5_000_000_000_000_000n, 29_000_000_000_000_000_000_000n)],
      source: 'ws', lo: 101, hi: 101,
    })).state
    expect(s.positions.get(sent), 'the seed watermark ate the fill').toBeDefined()
    expect(s.positions.get(sent)!.tokensHeld).toBe(29_000_000_000_000_000_000_000n)
  })

  it('opens from the first two words when fee and tax are missing', () => {
    const { state: s0, sent } = runToSent()
    const shortBuy = {
      address: CURVE,
      topics: [EVENT_TOPICS.CurveBuy, topic(TOKEN), topic(DEPLOYER)],
      data: '0x' + word(5_000_000_000_000_000n) + word(29_000_000_000_000_000_000_000n),
      blockNumber: 103, logIndex: 0, transactionIndex: 0,
      transactionHash: HASH, blockHash: '0x' + 'ef'.repeat(32), removed: false,
    }
    const s = decide(s0, ev(T0 + 5_600, 'logs', { logs: [shortBuy], source: 'ws', lo: 103, hi: 103 })).state
    expect(s.positions.get(sent), 'a short CurveBuy skipped settle as well as the delta').toBeDefined()
  })
})

describe('a sent buy with no fill is recovered from the wallet', () => {
  const later = T0 + 5_100 + SELL_SETTLE_GIVEUP_MS + 1_000

  it('asks the chain after the fill has had time to arrive', () => {
    const { state: s0, sent } = runToSent()
    const out = decide(s0, ev(later, 'clock', {}))
    const read = out.intents.find((i) => i.kind === 'read' && i.what === 'position-wallet')
    expect(read, 'an orphan buy must be read off the chain, not left reserved forever').toBeDefined()
    if (read && read.kind === 'read') expect(read.args).toEqual([TOKEN, sent])
  })

  it('opens and approves when the wallet still holds the tokens', () => {
    const { state: s0, sent } = runToSent()
    const asked = decide(s0, ev(later, 'clock', {})).state
    const s = decide(asked, ev(later + 1, 'chain-read', {
      request: { kind: 'position-wallet', args: [TOKEN, sent] },
      result: { balanceWei: '29000000000000000000000' },
      viaKey: true, tries: 1, latencyMs: 0,
    }))
    expect(s.state.positions.get(sent)?.tokensHeld).toBe(29_000_000_000_000_000_000_000n)
    expect(s.intents.some((i) => i.kind === 'approve')).toBe(true)
  })

  /**
   * A zero balance USED TO release the slot here, and that was a way to strand a bag.
   *
   * The buy is answered by the sequencer and this balance comes from a read endpoint, so the
   * read can be a block or two behind the transaction it is being asked about. Releasing on it
   * also deleted the in-flight record, which is the thing an arriving `CurveBuy` matches on, so
   * a real bag became permanently invisible with real tokens in the wallet.
   */
  const askedZero = (): { state: ReturnType<typeof decide>['state']; sent: string } => {
    const { state: s0, sent } = runToSent()
    const asked = decide(s0, ev(later, 'clock', {})).state
    return {
      state: decide(asked, ev(later + 1, 'chain-read', {
        request: { kind: 'position-wallet', args: [TOKEN, sent] },
        result: { balanceWei: '0' },
        viaKey: true, tries: 1, latencyMs: 0,
      })).state,
      sent,
    }
  }

  it('pulls the receipt instead of concluding, when the wallet holds nothing', () => {
    const { state: s0, sent } = runToSent()
    const asked = decide(s0, ev(later, 'clock', {})).state
    const out = decide(asked, ev(later + 1, 'chain-read', {
      request: { kind: 'position-wallet', args: [TOKEN, sent] },
      result: { balanceWei: '0' },
      viaKey: true, tries: 1, latencyMs: 0,
    }))
    const read = out.intents.find((i) => i.kind === 'read' && i.what === 'receipt')
    expect(read, 'a zero balance is not proof the buy failed; the receipt is').toBeDefined()
    if (read && read.kind === 'read') expect(read.args).toEqual([HASH, TOKEN, '', 'buy'])
    // Nothing settled, so nothing is given back yet.
    expect(out.state.risk.reserved).toBe(1)
    expect(out.state.inflight.has(sent)).toBe(true)
  })

  it('gives the slot back when the receipt proves the buy reverted', () => {
    const { state, sent } = askedZero()
    const s = decide(state, ev(later + 2, 'receipt', {
      hash: HASH,
      result: { ok: false, gasWei: '49028', proceedsWei: null, remainingWei: '0', outOfGas: false, error: 'the transaction reverted' },
    })).state
    expect(s.positions.get(sent)).toBeUndefined()
    expect(s.risk.reserved).toBe(0)
    expect(s.inflight.has(sent)).toBe(false)
  })

  it('blames our own gas ceiling, not the venue, when the buy burned the whole limit', () => {
    const { state } = askedZero()
    const out = decide(state, ev(later + 2, 'receipt', {
      hash: HASH,
      result: { ok: false, gasWei: '49028', proceedsWei: null, remainingWei: '0', outOfGas: true, error: 'burned its whole 400000 gas limit' },
    }))
    const r = out.refusals.find((x) => x.bucket === 'send-rejected')
    expect(r, 'an out-of-gas buy must still land in the bucket the funnel counts and the crit watches').toBeDefined()
    expect(r?.reason).toMatch(/OUR ceiling/)
  })

  it('opens the bag the wallet read could not see, from the receipt`s own block', () => {
    const { state, sent } = askedZero()
    const out = decide(state, ev(later + 2, 'receipt', {
      hash: HASH,
      result: { ok: true, gasWei: '2000', proceedsWei: null, remainingWei: '29000000000000000000000', outOfGas: false, error: null },
    }))
    expect(out.state.positions.get(sent)?.tokensHeld).toBe(29_000_000_000_000_000_000_000n)
    expect(out.intents.some((i) => i.kind === 'approve'), 'a recovered bag needs its allowance').toBe(true)
  })

  it('settles nothing when the receipt landed but its balance could not be read', () => {
    const { state, sent } = askedZero()
    const s = decide(state, ev(later + 2, 'receipt', {
      hash: HASH,
      result: { ok: true, gasWei: '2000', proceedsWei: null, remainingWei: null, outOfGas: false, error: null },
    })).state
    expect(s.risk.reserved, 'an unreadable balance is not evidence either way').toBe(1)
    expect(s.inflight.has(sent)).toBe(true)
  })

  /**
   * The box's own tape carries 52 receipt events and 15 of them have no `result` key at all:
   * they were written before the verdict was decoded in `io/`, in the older `{hash, receipt}`
   * shape. A guard written as `=== null` walks past a missing key, and the field read that
   * follows threw inside the fold, which `main.ts` treats as a refuse-to-boot. So an old event
   * shape on the tape stopped the bot from starting. Found by replaying that tape, not by a test.
   */
  it('reads a receipt event with no verdict at all as no verdict, rather than throwing', () => {
    const { state, sent } = askedZero()
    const old = ev(later + 2, 'receipt', { hash: HASH, receipt: { status: 'success' } })
    let out!: ReturnType<typeof decide>
    expect(() => { out = decide(state, old) }, 'a throw here is a refuse-to-boot').not.toThrow()
    expect(out.state.risk.reserved, 'no verdict settles nothing, so the slot is still held').toBe(1)
    expect(out.state.inflight.has(sent), 'and the buy is still there to be asked about again').toBe(true)
  })

  it('asks for the curve instead of opening a bag it cannot price', () => {
    /**
     * A restart, or `forgetOldRows` before the position existed, leaves the curve untracked.
     * Opening the bag anyway put it on the book at an entry mark of zero, and
     * `markPositions` skips a row whose curve is missing, so it was held forever with no
     * exit rule ever looking at it.
     */
    const { state: s0, sent } = runToSent()
    s0.curves.delete(CURVE)
    const asked = decide(s0, ev(later, 'clock', {})).state
    const out = decide(asked, ev(later + 1, 'chain-read', {
      request: { kind: 'position-wallet', args: [TOKEN, sent] },
      result: { balanceWei: '29000000000000000000000' },
      viaKey: true, tries: 1, latencyMs: 0,
    }))
    const pos = out.state.positions.get(sent)
    expect(pos, 'the send already wrote a row').toBeDefined()
    expect(pos!.filled, 'an unpriceable bag must not be booked as a fill').toBe(false)
    expect(pos!.tokensHeld).toBe(0n)
    const meta = out.intents.find((i) => i.kind === 'read' && i.what === 'meta')
    expect(meta, 'it has to ask for the curve it needs').toBeDefined()
    if (meta && meta.kind === 'read') expect(meta.args).toEqual([CURVE, TOKEN])
  })

  it('re-seeds that curve from the read and then opens the bag against a real mark', () => {
    const { state: s0, sent } = runToSent()
    s0.curves.delete(CURVE)
    let s = decide(s0, ev(later, 'clock', {})).state
    s = decide(s, ev(later + 1, 'chain-read', {
      request: { kind: 'position-wallet', args: [TOKEN, sent] },
      result: { balanceWei: '29000000000000000000000' },
      viaKey: true, tries: 1, latencyMs: 0,
    })).state
    // The meta read comes back with no pending launch behind it: a price for something we
    // already bought, not a launch to judge.
    const watchedBefore = s.observations.size
    s = decide(s, ev(later + 2, 'chain-read', {
      request: { kind: 'meta', args: [CURVE, TOKEN] },
      result: { params: PARAMS, state: CURVE_STATE, exemptions: 5 },
      viaKey: true, tries: 1, latencyMs: 0,
    })).state
    expect(s.curves.has(CURVE), 'the curve is tracked again').toBe(true)
    expect(s.armed.size, 'it is a price, not a launch: nothing arms').toBe(0)
    expect(s.observations.size, 'and nothing new is watched').toBe(watchedBefore)

    const opened = decide(s, ev(later + 3, 'chain-read', {
      request: { kind: 'position-wallet', args: [TOKEN, sent] },
      result: { balanceWei: '29000000000000000000000' },
      viaKey: true, tries: 1, latencyMs: 0,
    })).state
    const pos = opened.positions.get(sent)
    expect(pos, 'the second read opens it, now that it can be priced').toBeDefined()
    expect(pos!.entryMarkWei, 'and it is priced, not zero').toBeGreaterThan(0n)
  })

  it('raises the same read on recovery-start, which is what boot now does', () => {
    const { state: s0, sent } = runToSent()
    const out = decide(s0, ev(later, 'recovery-start', { reason: 'boot' }))
    const read = out.intents.find((i) => i.kind === 'read' && i.what === 'position-wallet')
    expect(read).toBeDefined()
    if (read && read.kind === 'read') expect(read.args[1]).toBe(sent)
    expect(out.state.inflight.has(sent), 'a hashed buy is still in the air').toBe(true)
    expect(out.state.risk.reserved, 'the slot stays reserved because the ETH may already be gone').toBe(1)
    expect(out.refusals.some((r) => r.bucket === 'send-rejected')).toBe(false)
  })

  /**
   * The leftover the dashboard showed as `signing` forever. A buy reserved at decide time
   * and never signed is rebuilt by replay with an empty hash. Boot does not re-queue the
   * intent, and the orphan path skips a record with no hash, so the slot sat until the
   * next 14 leftovers filled the book.
   */
  it('releases an unsigned buy on recovery-start, so a leftover cannot occupy a slot forever', () => {
    const { state: s0, intentId } = runToDecided()
    expect(s0.risk.reserved).toBe(1)
    expect(s0.risk.deployedWei).toBe(5_000_000_000_000_000n)
    expect(s0.risk.everEntered.has(TOKEN)).toBe(true)
    const out = decide(s0, ev(T0 + 5_100, 'recovery-start', { reason: 'boot' }))
    expect(out.state.inflight.has(intentId), 'nothing was sequenced, so there is nothing to settle').toBe(false)
    expect(out.state.risk.reserved, 'the slot goes back').toBe(0)
    expect(out.state.risk.deployedWei, 'and the capital with it').toBe(0n)
    expect(out.refusals.some((r) => r.bucket === 'send-rejected')).toBe(true)
    expect(out.state.risk.everEntered.has(TOKEN), 'the coin is not bought again late').toBe(true)
    expect(out.intents.some((i) => i.kind === 'read' && i.what === 'position-wallet')).toBe(false)
  })

  it('slows down and tells the operator once when the read keeps failing', () => {
    /**
     * The read returns `null` when the RPC cannot answer, which changes nothing, so the
     * unthrottled version asked again every fifteen seconds for as long as the process ran.
     * It now says so once and drops to the slow interval. It does NOT release the slot: the
     * ETH is already spent, so freeing the capital would let the wallet commit it twice.
     */
    const { state, sent } = runToSent()
    let s = state
    let told = 0
    let reads = 0
    // Four fast windows: three raise reads, the fourth is inside the slow interval.
    for (let i = 1; i <= 4; i++) {
      const at = T0 + 5_100 + i * (SELL_SETTLE_GIVEUP_MS + 1_000)
      const out = decide(s, ev(at, 'clock', {}))
      s = out.state
      if (out.intents.some((x) => x.kind === 'read' && x.what === 'position-wallet')) reads++
      told += out.refusals.filter((r) => r.bucket === 'exit-stuck').length
      s = decide(s, ev(at + 1, 'chain-read', {
        request: { kind: 'position-wallet', args: [TOKEN, sent] },
        result: null, viaKey: true, tries: 1, latencyMs: 0,
      })).state
    }
    expect(reads, 'the fast interval stops at the cap').toBe(3)
    expect(told, 'the operator is told exactly once').toBe(1)
    expect(s.risk.reserved, 'the slot stays reserved because the ETH is gone').toBe(1)
    expect(s.inflight.has(sent), 'the record is kept, so an arriving fill still has an owner').toBe(true)
  })

  it('asks the chain about an open row, so a bag we already sold is not sold again', () => {
    const { state, sent } = runToOpen()
    const out = decide(state, ev(T0 + 5_600, 'recovery-start', { reason: 'boot' }))
    const read = out.intents.find((i) => i.kind === 'read' && i.what === 'position-wallet' && i.args[1] === sent)
    expect(read).toBeDefined()
  })

  it('abandons an open row the chain says is empty when no sell was ever sequenced', () => {
    const { state, sent } = runToOpen()
    const s = decide(state, ev(T0 + 5_601, 'chain-read', {
      request: { kind: 'position-wallet', args: [TOKEN, sent] },
      result: { balanceWei: '0' },
      viaKey: true, tries: 1, latencyMs: 0,
    })).state
    const pos = s.positions.get(sent)!
    expect(pos.closed).toBe(true)
    expect(pos.abandonedAt).toBe(T0 + 5_601)
    expect(s.risk.reserved).toBe(0)
  })
})

/**
 * The hole the boot reconcile opened, stated as tests.
 *
 * A sell that was sequenced and whose `CurveSell` never reached the tape leaves the wallet
 * holding no tokens and the ETH for them already banked. Reading that zero as an abandonment
 * books NO proceeds and deletes the record the arriving log would have matched, so the wallet
 * is right and the book is short by a whole sale.
 */
describe('a zero balance under a sequenced sell is settled from the receipt', () => {
  const SELL_HASH = '0x' + '77'.repeat(32)

  /** Open, then raise and sign a sell, so the row has a sequenced sell in the air. */
  function runToSellSent(): { state: State; sent: string; sellId: string } {
    const { state, sent } = runToOpen()
    const ticked = decide(state, ev(T0 + 60_000, 'clock', {}))
    const sell = ticked.intents.find((i) => i.kind === 'sell')
    if (!sell || sell.kind !== 'sell') throw new Error('no sell intent was raised')
    let s = decide(ticked.state, ev(T0 + 60_100, 'tx-signed', {
      intentId: sell.intentId, txKind: 'sell', hash: SELL_HASH, nonce: 8, raw: '0x00',
    })).state
    s = decide(s, ev(T0 + 60_200, 'tx-send-result', {
      intentId: sell.intentId, hash: SELL_HASH, ok: true, nonceConsumed: true, uncertain: false,
      statusCode: null, error: null, tSigned: 0, tSent: 0,
    })).state
    return { state: s, sent, sellId: sell.intentId }
  }

  function askWallet(s: State, sent: string) {
    return decide(s, ev(T0 + 60_500, 'chain-read', {
      request: { kind: 'position-wallet', args: [TOKEN, sent] },
      result: { balanceWei: '0' },
      viaKey: true, tries: 1, latencyMs: 0,
    }))
  }

  it('pulls the sell receipt instead of closing the row', () => {
    const { state, sent } = runToSellSent()
    const out = askWallet(state, sent)
    const read = out.intents.find((i) => i.kind === 'read' && i.what === 'receipt')
    expect(read, 'a zero balance under a sequenced sell must ask for the receipt').toBeDefined()
    if (read && read.kind === 'read') expect(read.args).toEqual([SELL_HASH, TOKEN, CURVE])
    expect(out.state.positions.get(sent)!.closed, 'the row must not be abandoned on a guess').toBe(false)
  })

  it('books the proceeds the receipt proves, so the wallet and the book agree', () => {
    const { state, sent } = runToSellSent()
    const asked = askWallet(state, sent).state
    const s = decide(asked, ev(T0 + 60_600, 'receipt', {
      hash: SELL_HASH,
      result: { ok: true, gasWei: '1000', proceedsWei: '6000000000000000', remainingWei: '0', error: null },
    })).state
    const pos = s.positions.get(sent)!
    expect(pos.closed).toBe(true)
    expect(pos.proceedsWei).toBe(6_000_000_000_000_000n)
    // proceeds 0.006 against a 0.005 stake, exactly as the live log path books it
    expect(s.risk.walletRealizedWei).toBe(1_000_000_000_000_000n)
    expect(s.risk.reserved).toBe(0)
  })

  it('frees the position and re-approves when the receipt says it reverted', () => {
    const { state, sent } = runToSellSent()
    const asked = askWallet(state, sent).state
    const out = decide(asked, ev(T0 + 60_600, 'receipt', {
      hash: SELL_HASH,
      result: { ok: false, gasWei: '49028', proceedsWei: null, remainingWei: '0', error: 'the transaction reverted' },
    }))
    const pos = out.state.positions.get(sent)!
    expect(pos.closed, 'a reverted sell settles nothing').toBe(false)
    expect(pos.inflightIntentId, 'the position is free to try again').toBeNull()
    expect(pos.attempts, 'the chain executed it and charged for it').toBe(1)
    expect(out.intents.some((i) => i.kind === 'approve')).toBe(true)
  })

  it('keeps the row open when the proceeds cannot be proved, rather than booking a guess', () => {
    const { state, sent } = runToSellSent()
    const asked = askWallet(state, sent).state
    const out = decide(asked, ev(T0 + 60_600, 'receipt', {
      hash: SELL_HASH,
      result: { ok: true, gasWei: '1000', proceedsWei: null, remainingWei: '0', error: 'no CurveSell found' },
    }))
    expect(out.state.positions.get(sent)!.closed).toBe(false)
    expect(out.state.risk.walletRealizedWei).toBe(0n)
    expect(out.refusals.some((r) => r.bucket === 'exit-stuck')).toBe(true)
  })

  it('leaves everything alone when the receipt is not available yet', () => {
    const { state, sent, sellId } = runToSellSent()
    const asked = askWallet(state, sent).state
    const s = decide(asked, ev(T0 + 60_600, 'receipt', { hash: SELL_HASH, result: null })).state
    expect(s.positions.get(sent)!.inflightIntentId).toBe(sellId)
    expect(s.positions.get(sent)!.closed).toBe(false)
  })

  /** The same old tape shape on the sell side, where a throw would strand a real bag. */
  it('leaves everything alone when the receipt event carries no verdict field at all', () => {
    const { state, sent, sellId } = runToSellSent()
    const asked = askWallet(state, sent).state
    const old = ev(T0 + 60_600, 'receipt', { hash: SELL_HASH, receipt: { status: 'success' } })
    let out!: ReturnType<typeof decide>
    expect(() => { out = decide(asked, old) }, 'a throw here is a refuse-to-boot').not.toThrow()
    expect(out.state.positions.get(sent)!.inflightIntentId).toBe(sellId)
    expect(out.state.positions.get(sent)!.closed).toBe(false)
  })

  it('takes a partial sale as partial, keeping the rest of the bag open', () => {
    const { state, sent } = runToSellSent()
    const asked = askWallet(state, sent).state
    const s = decide(asked, ev(T0 + 60_600, 'receipt', {
      hash: SELL_HASH,
      result: { ok: true, gasWei: '1000', proceedsWei: '2000000000000000', remainingWei: '5000000000000000000000', error: null },
    })).state
    const pos = s.positions.get(sent)!
    expect(pos.closed).toBe(false)
    expect(pos.tokensHeld).toBe(5_000_000_000_000_000_000_000n)
    expect(pos.proceedsWei).toBe(2_000_000_000_000_000n)
  })

  it('retries incomplete receipt evidence without charging gas or counting an attempt twice', () => {
    const {state,sent}=runToSellSent()
    const first=decide(state,ev(T0+60_600,'receipt',{
      hash:SELL_HASH,result:{ok:true,gasWei:'1000',proceedsWei:'6000000000000000',remainingWei:null,error:'balance unavailable'},
    })).state
    expect(first.positions.get(sent)!.closed).toBe(false)
    expect(first.positions.get(sent)!.sellReceipts!.has(SELL_HASH)).toBe(true)
    const complete=decide(first,ev(T0+61_000,'receipt',{
      hash:SELL_HASH,result:{ok:true,gasWei:'1000',proceedsWei:'6000000000000000',remainingWei:'0',error:null},
    })).state
    expect(complete.positions.get(sent)!.closed).toBe(true)
    expect(complete.positions.get(sent)!.attempts).toBe(1)
    expect(complete.risk.walletGasWei).toBe(1000n)
    expect(complete.risk.walletRealizedWei).toBe(1_000_000_000_000_000n)
  })
})

describe('a refused send gives back everything it took', () => {
  /**
   * `tryEnter` claims a slot AND the capital in the same breath, before the intent leaves.
   * Until 2026-09-16 a clean rejection returned only the slot, so bankroll drained with
   * nothing deployed and, sixteen rejections later, every launch was refused for
   * `risk-bankroll`. The monitor rejects every send by construction and hit the wall inside
   * an hour, which is how this was found.
   */
  it('returns the slot and the capital on a clean rejection', () => {
    let s: State = emptyState(CFG, SW)
    s = decide(s, ev(T0, 'logs-status', { healthy: true, mode: 'ws', reason: 'connected' })).state
    s = decide(s, ev(T0, 'feed-block', { block: 100, timestamp: Math.floor(T0 / 1000), txs: [] })).state
    s = decide(s, ev(T0 + 10, 'logs', { logs: [launchLog(101)], source: 'ws', lo: 101, hi: 101 })).state
    s = decide(s, ev(T0 + 60, 'chain-read', {
      request: { kind: 'meta', args: [CURVE, TOKEN] },
      result: { params: PARAMS, state: CURVE_STATE, exemptions: 5 },
      viaKey: true, tries: 1, latencyMs: 0,
    })).state
    s = decide(s, ev(T0 + 4_900, 'logs', { logs: [], source: 'ws', lo: 102, hi: 102 })).state
    const released = decide(s, ev(T0 + 5_000, 'feed-block', { block: 102, timestamp: Math.floor((T0 + 5_000) / 1000), txs: [] }))
    s = released.state
    const buy = released.intents.find((i) => i.kind === 'buy')!
    if (buy.kind !== 'buy') throw new Error('expected a buy')

    expect(s.risk.reserved).toBe(1)
    expect(s.risk.deployedWei).toBe(SW.sizeWei)

    s = decide(s, ev(T0 + 5_200, 'tx-send-result', {
      intentId: buy.intentId, hash: '', ok: false, nonceConsumed: false, uncertain: false,
      statusCode: null, error: 'sequencer said no', tSigned: 0, tSent: 0,
    })).state

    expect(s.risk.reserved, 'the slot goes back').toBe(0)
    expect(s.risk.deployedWei, 'and so does the capital').toBe(0n)
    expect(s.inflight.size, 'a clean rejection is terminal').toBe(0)
    expect(s.counters['send-rejected']).toBe(1)
  })
})

/**
 * The path from a chain log to the market indicator's input.
 *
 * `sim.test.ts` proves the simulator reproduces `gate.db`, and proves the observer feeds it
 * correctly once it holds the events. This is the step before that: turning a raw log into
 * the simulator's event shape, at the right word offsets, for the right launches, and not
 * for our own fills. A word offset that is one out produces a plausible number nothing can
 * check, which is the failure mode the whole port is guarded against.
 */
describe('a chain log becomes the replay\'s input', () => {
  /** Somebody else buying the same curve. Topics are [event, sender, recipient]. */
  const strangerBuy = (block: number, spent: bigint, tokens: bigint, fee: bigint, tax: bigint) => ({
    address: CURVE,
    topics: [EVENT_TOPICS.CurveBuy, topic(STRANGER), topic(STRANGER)],
    data: '0x' + word(spent) + word(tokens) + word(fee) + word(tax),
    blockNumber: block, logIndex: 1, transactionIndex: 1,
    transactionHash: STRANGER_TX, blockHash: '0x' + 'cd'.repeat(32), removed: false,
  })

  function watched(extra: ReturnType<typeof strangerBuy>[] = []) {
    let s: State = emptyState(CFG, SW)
    s = decide(s, ev(T0, 'logs-status', { healthy: true, mode: 'ws', reason: 'connected' })).state
    // The launch and the buys in its own batch: the creator's buy rides the launch
    // transaction, so it arrives before anything knows the curve's parameters.
    s = decide(s, ev(T0 + 10, 'logs', { logs: [launchLog(101), ...extra], source: 'ws', lo: 101, hi: 101 })).state
    return s
  }

  it('collects the curve\'s logs from the launch block, before the metadata read returns', () => {
    /**
     * WITHOUT THIS THE REPLAY STARTS FROM AN EMPTY CURVE THE MARKET HAD ALREADY MOVED. The
     * observation cannot open until `onCurveParams`, which is one chain read later, and the
     * single largest move any curve ever sees lands before then.
     */
    const s = watched([strangerBuy(101, 3_000_000_000_000_000n, 7n, 11n, 13n)])
    const pending = s.pendingLaunches.get(CURVE)!
    expect(pending.events).toHaveLength(1)
    expect(pending.tx).toBe(('0x' + 'ab'.repeat(32)).toLowerCase())

    const e = pending.events[0]!
    expect(e.s).toBe('B')
    expect(e.b).toBe(101)
    // The word layout is `quoteIn, tokensOut, fee, tax`, and the replay subtracts the last two
    // from the first rather than re-deriving them. One offset out is a plausible wrong number.
    expect(BigInt(e.q)).toBe(3_000_000_000_000_000n)
    expect(BigInt(e.t!)).toBe(7n)
    expect(BigInt(e.f!)).toBe(11n)
    expect(BigInt(e.x!)).toBe(13n)
    expect(e.r).toBe(STRANGER)
  })

  it('hands them to the observation the moment admits passes', () => {
    let s = watched([strangerBuy(101, 3_000_000_000_000_000n, 7n, 11n, 13n)])
    s = decide(s, ev(T0 + 60, 'chain-read', {
      request: { kind: 'meta', args: [CURVE, TOKEN] },
      result: { params: PARAMS, state: CURVE_STATE, exemptions: 5 },
      viaKey: true, tries: 1, latencyMs: 0,
    })).state
    // Keyed by CURVE, because that is what a chain log carries.
    const o = s.observations.get(CURVE)!
    expect(o.token).toBe(TOKEN)
    expect(o.launchBlock).toBe(101)
    expect(o.deployer).toBe(DEPLOYER)
    expect(o.creatorTaxBps).toBe(Number(PARAMS.creatorTaxBps))
    expect(o.events).toHaveLength(1)
    expect(s.pendingLaunches.has(CURVE)).toBe(false)

    // And it keeps collecting after the observation is open.
    s = decide(s, ev(T0 + 200, 'logs', {
      logs: [strangerBuy(103, 1_000_000_000_000_000n, 5n, 0n, 0n)], source: 'ws', lo: 103, hi: 103,
    })).state
    expect(s.observations.get(CURVE)!.events).toHaveLength(2)
  })

  it('leaves our own fill out, because the replay measures the venue and not our size', () => {
    /**
     * `chainio.decode_seq` dropped every log whose sender or recipient was our wallet, and
     * every stored row in `gate.db` was produced under that rule. Leaving our own buy in would
     * make the replay price a curve we had already moved, and the size switch would then move
     * the indicator: the ruler would change whenever the thing it measures did.
     */
    const { state, sent } = runToOpen()
    // The fill DID land: a position is open on it.
    expect(state.positions.get(sent)?.tokensHeld).toBe(29_000_000_000_000_000_000_000n)
    // And the only curve log in that run was ours, so the observation has collected nothing.
    const o = state.observations.get(CURVE)
    expect(o).toBeDefined()
    expect(o!.events).toHaveLength(0)
  })
})

/**
 * Funding, which is now a spec decision and not a switch.
 *
 * `book.sizeWei` is the reviewed ceiling. The global switch supplies the default and an
 * optional per-book override replaces that default. The effective stake still cannot exceed
 * the book's declaration or fund a size-0 book.
 */
describe('a book trades the lower of its declared size and the live switch', () => {
  function enterWith(bookSizeWei: string, switchWei: bigint, overrideWei?: bigint) {
    const cfg: FrozenConfig = { ...CFG, books: [{ ...BOOK, sizeWei: bookSizeWei }] }
    const sw: Switches = {
      ...SW,
      sizeWei: switchWei,
      ...(overrideWei === undefined ? {} : {
        bookSizes: new Map([[BOOK.id, { sizeWei: overrideWei, at: T0, by: 'dashboard' }]]),
      }),
    }
    let s: State = emptyState(cfg, sw)
    s = decide(s, ev(T0, 'logs-status', { healthy: true, mode: 'ws', reason: 'connected' })).state
    s = decide(s, ev(T0, 'feed-status', { connected: true, reason: 'connected' })).state
    s = decide(s, ev(T0, 'feed-block', { block: 100, timestamp: Math.floor(T0 / 1000), txs: [] })).state
    s = decide(s, ev(T0 + 10, 'logs', { logs: [launchLog(101)], source: 'ws', lo: 101, hi: 101 })).state
    s = decide(s, ev(T0 + 60, 'chain-read', {
      request: { kind: 'meta', args: [CURVE, TOKEN] },
      result: { params: PARAMS, state: CURVE_STATE, exemptions: 5 },
      viaKey: true, tries: 1, latencyMs: 0,
    })).state
    s = decide(s, ev(T0 + 4_900, 'logs', { logs: [], source: 'ws', lo: 102, hi: 102 })).state
    return decide(s, ev(T0 + 5_000, 'feed-block', { block: 102, timestamp: Math.floor((T0 + 5_000) / 1000), txs: [] }))
  }

  it('stakes the declared size when the switch is above it', () => {
    const r = enterWith('3000000000000000', 5_000_000_000_000_000n)
    const buy = r.intents.find((i) => i.kind === 'buy')
    expect(buy && buy.kind === 'buy' && buy.sizeWei).toBe(3_000_000_000_000_000n)
  })

  it('stakes the switch when the operator has reduced below the declared size', () => {
    // The 3am action. It reduces and it does nothing else.
    const r = enterWith('5000000000000000', 1_000_000_000_000_000n)
    const buy = r.intents.find((i) => i.kind === 'buy')
    expect(buy && buy.kind === 'buy' && buy.sizeWei).toBe(1_000_000_000_000_000n)
  })

  it('stakes this book\'s dashboard override instead of the global default', () => {
    const r = enterWith('5000000000000000', 2_500_000_000_000_000n, 1_000_000_000_000_000n)
    const buy = r.intents.find((i) => i.kind === 'buy')
    expect(buy && buy.kind === 'buy' && buy.sizeWei).toBe(1_000_000_000_000_000n)
  })

  it('never raises a book above what the spec declared, whatever the switch says', () => {
    // Raising the switch is not a way to fund a book. That decision is reviewed and versioned.
    const r = enterWith('2000000000000000', 20_000_000_000_000_000n)
    const buy = r.intents.find((i) => i.kind === 'buy')
    expect(buy && buy.kind === 'buy' && buy.sizeWei).toBe(2_000_000_000_000_000n)
  })

  it('declares an unfunded book without trading it, and says which one and why', () => {
    // A book at size 0 still routes, still observes and still scores. It just never buys, and
    // the funnel says so in its own bucket rather than leaving the operator to infer it.
    const r = enterWith('0', 5_000_000_000_000_000n)
    expect(r.intents.find((i) => i.kind === 'buy')).toBeUndefined()
    const refused = r.refusals.find((x) => x.bucket === 'risk-size')
    expect(refused?.reason).toContain('not funded')
    expect(refused?.reason).toContain('only')
  })

  it('does not resize a position that is already open', () => {
    const { state, sent } = runToOpen()
    const before = state.positions.get(sent)!
    const out = decide(state, ev(state.at + 1, 'switch-set', {
      name: 'book-size', value: { kind: 'book-size', book: BOOK.id, wei: '1000000000000000' }, by: 'dashboard',
    }))
    expect(out.state.positions.get(sent)?.spendWei).toBe(before.spendWei)
    expect(out.state.positions.get(sent)?.rules).toEqual(before.rules)
    expect(out.state.switches.bookSizes?.get(BOOK.id)?.sizeWei).toBe(1_000_000_000_000_000n)
  })
})

/**
 * The watch is the coins `admits` would buy: tax band, exempt floor, template-loss.
 * Halt and size stay sit-outs. Until 2026-09-17 a tax-routed launch opened an observation
 * before `admits`, so the guard scored coins live would refuse.
 */
describe('the watch is the coins admits would buy', () => {
  function judge(exemptions: number | null, seeds: Event[] = []) {
    let s: State = emptyState(CFG, SW)
    s = decide(s, ev(T0, 'logs-status', { healthy: true, mode: 'ws', reason: 'connected' })).state
    s = decide(s, ev(T0, 'feed-status', { connected: true, reason: 'connected' })).state
    s = decide(s, ev(T0, 'feed-block', { block: 100, timestamp: Math.floor(T0 / 1000), txs: [] })).state
    for (const e of seeds) s = decide(s, e).state
    s = decide(s, ev(T0 + 10, 'logs', { logs: [launchLog(101)], source: 'ws', lo: 101, hi: 101 })).state
    return decide(s, ev(T0 + 60, 'chain-read', {
      request: { kind: 'meta', args: [CURVE, TOKEN] },
      result: { params: PARAMS, state: CURVE_STATE, exemptions },
      viaKey: true, tries: 1, latencyMs: 0,
    }))
  }

  function notInCohort(s: State) {
    const later = decide(s, ev(T0 + 60_000, 'clock', {}))
    expect(later.state.observations.size).toBe(0)
    expect(later.state.cohort.size).toBe(0)
  }

  it('refuses 0 exempts and does not open an observation', () => {
    const r = judge(0)
    expect(r.refusals.some((x) => x.bucket === 'entry-exempt')).toBe(true)
    expect(r.state.observations.size).toBe(0)
    expect(r.state.armed.size).toBe(0)
    notInCohort(r.state)
  })

  it('refuses 2 exempts and does not open an observation', () => {
    const r = judge(2)
    expect(r.refusals.some((x) => x.bucket === 'entry-exempt')).toBe(true)
    expect(r.state.observations.size).toBe(0)
    expect(r.state.armed.size).toBe(0)
    notInCohort(r.state)
  })

  it('refuses a live template-loss block and does not open an observation', () => {
    const key = templateKey(Number(PARAMS.creatorTaxBps), 0n, 5)
    const r = judge(5, [ev(T0, 'seed', { what: 'template-losses', rows: [[key, T0 - 60_000]] })])
    expect(r.refusals.some((x) => x.bucket === 'entry-template-loss')).toBe(true)
    expect(r.state.observations.size).toBe(0)
    expect(r.state.armed.size).toBe(0)
    notInCohort(r.state)
  })
})
