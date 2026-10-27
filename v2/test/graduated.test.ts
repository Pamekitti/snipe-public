/**
 * After-graduation sell: the four money bugs, then a close.
 *
 * A bag whose curve has closed is sold on the V4 pool, not parked. These pin the rules that
 * would otherwise strand it: a sequenced curve sell is not thrown away, the receipt is read
 * before the budget gives up, a zero balance is lag until it repeats, and the same signed
 * bytes go out again if the receipt is late.
 */
import { describe, expect, it } from 'vitest'
import { decide } from '../core/decide.js'
import { emptyState, freshGradState, type Position, type State } from '../core/state.js'
import { EVENT_TOPICS } from '../core/chain.js'
import { GRAD_BUDGET, GRAD_RESEND_MS, SELL_SETTLE_GIVEUP_MS, nextGraduationStep } from '../core/exit.js'
import { freshCurve, type CurveParams } from '../core/curve.js'
import type { Event } from '../core/events.js'
import type { BookSpec, FrozenConfig, Switches } from '../core/config.js'

const CURVE = '0x000000000000000000000000000000000000cccc'
const TOKEN = '0x000000000000000000000000000000000000aaaa'
const HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044'
const HASH = '0x' + '22'.repeat(32)
const RAW = '0xdead'

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
const LAUNCHED_AT = 1_789_595_729
const PARAMS: CurveParams = {
  phantomQuote: 1_680_000_000_000_000_000n,
  reservedTokens: 285_714_285_714_285_714_285_714_285n,
  launchSupply: 1_000_000_000_000_000_000_000_000_000n,
  feeBps: 100n, creatorTaxBps: 0n, snipeTaxStartBps: 9_900n, snipeTaxSeconds: 3n,
  launchedAt: BigInt(LAUNCHED_AT),
}
const T0 = (LAUNCHED_AT + 60) * 1000
const w = (v: bigint | string): string => BigInt(v).toString(16).padStart(64, '0')

let seq = 0
const ev = <T extends object>(at: number, kind: string, body: T): Event =>
  ({ seq: ++seq, at, run: 'test', kind, ...body } as unknown as Event)

const rules = {
  ...BOOK.exit, takeProfitMultiple: BOOK.takeProfit.otherwise,
  buySlippageBps: BOOK.entry.buySlippageBps,
} as Position['rules']

const pool = {
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: TOKEN,
  fee: 10_000,
  tickSpacing: 200,
  hooks: HOOK,
}

function holding(over: Partial<Position> = {}): State {
  const s = emptyState(CFG, SW)
  const confirmed = { ...freshCurve(PARAMS), graduated: true, trackedTokens: PARAMS.reservedTokens }
  s.curves.set(CURVE, {
    curve: CURVE, token: TOKEN, params: PARAMS,
    confirmed, working: { ...confirmed },
    pending: new Map(), confirmedThrough: 100, degraded: false, workingAt: T0,
  })
  const pos: Position = {
    id: 'buy-1', token: TOKEN, curve: CURVE, book: 'only', bookDigest: 'd', templateKey: 't',
    openedAt: T0 - 60_000, spendWei: 5_000_000_000_000_000n, entryMarkWei: 4_800_000_000_000_000n,
    rules, tokensHeld: 1_000_000_000_000_000_000_000n, peakMarkWei: 4_800_000_000_000_000n,
    proceedsWei: 0n, closedAt: null, abandonedAt: null, abandonReason: null,
    exitReason: null, attempts: 0, inflightIntentId: null,
    lastBuyHash: null, lastSellHash: null, awaitingSellReceipt: null,
    closed: false, venue: 'curve', grad: null, filled: true, ...over,
  }
  s.positions.set(pos.id, pos)
  s.risk.reserved = 1
  s.risk.deployedWei = pos.spendWei
  return { ...s, at: T0, decisions: 10 }
}

const tick = (s: State, at: number) => decide(s, ev(at, 'clock', {}))

describe('a sequenced curve sell is not thrown away when the curve graduates', () => {
  it('keeps the inflight sell and does not flip yet', () => {
    const s = holding({ inflightIntentId: 'sell-2' })
    s.inflight.set('sell-2', {
      kind: 'sell', intentId: 'sell-2', token: TOKEN, curve: CURVE, reason: 'time',
      raisedAt: T0, hash: HASH, nonce: 4, signedAt: T0,
    })
    const { state, intents } = tick(s, T0 + 1_000)
    const pos = [...state.positions.values()][0]!
    expect(pos.venue).toBe('curve')
    expect(pos.inflightIntentId).toBe('sell-2')
    expect(intents.some((i) => i.kind === 'read' && i.what === 'grad-pool')).toBe(false)
  })

  it('still closes from the CurveSell that then lands', () => {
    const s = holding({ inflightIntentId: 'sell-2' })
    s.inflight.set('sell-2', {
      kind: 'sell', intentId: 'sell-2', token: TOKEN, curve: CURVE, reason: 'time',
      raisedAt: T0, hash: HASH, nonce: 4, signedAt: T0,
    })
    const out = decide(s, ev(T0 + 500, 'logs', {
      source: 'poll', lo: 101, hi: 101,
      logs: [{
        address: CURVE, topics: [EVENT_TOPICS.CurveSell],
        data: '0x' + w(1_000_000_000_000_000_000_000n) + w(4_000_000_000_000_000n) + w(0n) + w(0n),
        blockNumber: 101, blockHash: '0x' + 'ef'.repeat(32),
        transactionHash: HASH, transactionIndex: 0, logIndex: 0,
      }],
    }))
    const pos = [...out.state.positions.values()][0]!
    expect(pos.closed).toBe(true)
    expect(pos.proceedsWei).toBe(4_000_000_000_000_000n)
  })

  it('flips to V4 once the sequenced sell has been given up, without a curve approve', () => {
    const s = holding({ inflightIntentId: 'sell-2' })
    s.inflight.set('sell-2', {
      kind: 'sell', intentId: 'sell-2', token: TOKEN, curve: CURVE, reason: 'time',
      raisedAt: T0, hash: HASH, nonce: 4, signedAt: T0,
    })
    const { state, intents, refusals } = tick(s, T0 + SELL_SETTLE_GIVEUP_MS + 1_000)
    const pos = [...state.positions.values()][0]!
    expect(pos.venue).toBe('graduated')
    expect(pos.attempts, 'a timeout has no execution verdict yet').toBe(0)
    expect(refusals.some((r) => r.bucket === 'exit-unsettled')).toBe(true)
    expect(intents.some((i) => i.kind === 'approve')).toBe(false)
    expect(intents.some((i) => i.kind === 'read' && i.what === 'grad-pool')).toBe(true)
    expect(pos.lastSellHash).toBe(HASH)
    expect(pos.awaitingSellReceipt).toBe(HASH)
    expect(intents.some((i) => i.kind === 'read' && i.what === 'receipt' && i.args[0] === HASH)).toBe(true)
  })

  it('still closes from a CurveSell that lands after the give-up', () => {
    const s = holding({ inflightIntentId: 'sell-2' })
    s.inflight.set('sell-2', {
      kind: 'sell', intentId: 'sell-2', token: TOKEN, curve: CURVE, reason: 'time',
      raisedAt: T0, hash: HASH, nonce: 4, signedAt: T0,
    })
    const given = tick(s, T0 + SELL_SETTLE_GIVEUP_MS + 1_000).state
    const out = decide(given, ev(T0 + SELL_SETTLE_GIVEUP_MS + 2_000, 'logs', {
      source: 'poll', lo: 101, hi: 101,
      logs: [{
        address: CURVE, topics: [EVENT_TOPICS.CurveSell],
        data: '0x' + w(1_000_000_000_000_000_000_000n) + w(4_000_000_000_000_000n) + w(0n) + w(0n),
        blockNumber: 101, blockHash: '0x' + 'ef'.repeat(32),
        transactionHash: HASH, transactionIndex: 0, logIndex: 0,
      }],
    }))
    const pos = [...out.state.positions.values()][0]!
    expect(pos.closed).toBe(true)
    expect(pos.proceedsWei).toBe(4_000_000_000_000_000n)
    expect(out.state.risk.reserved).toBe(0)
    expect(out.state.risk.deployedWei).toBe(0n)
  })

  it('does not re-approve the curve when its late receipt reverts after graduation', () => {
    const s=holding({inflightIntentId:'sell-2'})
    s.inflight.set('sell-2',{kind:'sell',intentId:'sell-2',token:TOKEN,curve:CURVE,reason:'time',raisedAt:T0,hash:HASH,nonce:4,signedAt:T0})
    const given=tick(s,T0+SELL_SETTLE_GIVEUP_MS+1000).state
    const out=decide(given,ev(T0+SELL_SETTLE_GIVEUP_MS+2000,'receipt',{
      hash:HASH,result:{ok:false,gasWei:'1000',proceedsWei:null,remainingWei:'99',error:'reverted'},
    }))
    expect([...out.state.positions.values()][0]!.venue).toBe('graduated')
    expect(out.intents.some(i=>i.kind==='approve')).toBe(false)
    expect(out.state.risk.walletGasWei).toBe(1000n)
  })
})

describe('nextGraduationStep order', () => {
  function graduated(over: Partial<NonNullable<Position['grad']>> = {}): Position {
    const s = holding()
    const pos = [...s.positions.values()][0]!
    pos.venue = 'graduated'
    pos.grad = { ...freshGradState(), ...over }
    return pos
  }

  it('reads a pending receipt before it gives up on the budget', () => {
    const pos = graduated({
      sends: GRAD_BUDGET.maxSends, awaitingReceipt: HASH, pendingRaw: RAW, pendingAt: T0,
    })
    expect(nextGraduationStep(pos, T0 + 200)).toEqual({ kind: 'read-receipt', hash: HASH })
  })

  it('respects receipt backoff even when the send budget is exhausted', () => {
    const pos=graduated({sends:GRAD_BUDGET.maxSends,awaitingReceipt:HASH,pendingRaw:RAW,pendingAt:T0,retryAt:T0+150})
    expect(nextGraduationStep(pos,T0+100)).toEqual({kind:'wait'})
    expect(nextGraduationStep(pos,T0+150)).toEqual({kind:'read-receipt',hash:HASH})
  })

  it('resends the same bytes after a second without a receipt', () => {
    const pos = graduated({
      sends: 1, awaitingReceipt: HASH, pendingRaw: RAW, pendingAt: T0,
    })
    expect(nextGraduationStep(pos, T0 + GRAD_RESEND_MS)).toEqual({
      kind: 'resend', hash: HASH, raw: RAW,
    })
  })

  it('does not give up on the first zero-balance read', () => {
    const pos = graduated({
      pool, phase: 2,
      wallet: {
        balanceWei: 0n, erc20AllowanceWei: 0n, permitAmountWei: 0n, permitExpiry: 0, at: T0,
      },
    })
    expect(nextGraduationStep(pos, T0 + 1).kind).toBe('empty')
  })
})

describe('a zero balance is lag until it repeats', () => {
  function onPool(): State {
    const s = holding({ venue: 'graduated', grad: freshGradState() })
    const pos = [...s.positions.values()][0]!
    pos.venue = 'graduated'
    pos.grad = freshGradState()
    return decide(s, ev(T0 + 1, 'chain-read', {
      request: { kind: 'grad-pool', args: [TOKEN, CURVE] },
      result: { ok: true, phase: 2, pool },
      viaKey: false, tries: 1, latencyMs: 0,
    })).state
  }

  it('backs off instead of blocking', () => {
    const s = onPool()
    const folded = decide(s, ev(T0 + 2, 'chain-read', {
      request: { kind: 'grad-wallet', args: [TOKEN] },
      result: { balanceWei: '0', erc20AllowanceWei: '0', permitAmountWei: '0', permitExpiry: 0 },
      viaKey: false, tries: 1, latencyMs: 0,
    }))
    const { state, refusals } = tick(folded.state, T0 + 3)
    const pos = [...state.positions.values()][0]!
    expect(pos.closed).toBe(false)
    expect(pos.grad?.gaveUp).toBe(false)
    expect(refusals.some((r) => r.bucket === 'exit-grad-blocked')).toBe(false)
    expect(pos.grad?.emptyReads).toBe(1)
  })
})

describe('a proven swap closes the position', () => {
  function awaiting(over: Partial<NonNullable<Position['grad']>> = {}): State {
    const g = { ...freshGradState(), pool, phase: 2, sends: 3, awaitingReceipt: HASH, pendingRaw: RAW, pendingAt: T0, ...over }
    const s = holding({ venue: 'graduated', grad: g })
    const pos = [...s.positions.values()][0]!
    pos.venue = 'graduated'
    pos.grad = g
    return s
  }

  it('books proceeds minus stake and frees the slot', () => {
    const out = decide(awaiting(), ev(T0 + 10, 'receipt', {
      hash: HASH,
      result: { ok: true, gasWei: '1000', proceedsWei: '6000000000000000', remainingWei: '0', error: null },
    }))
    const pos = [...out.state.positions.values()][0]!
    expect(pos.closed).toBe(true)
    expect(pos.exitReason).toBe('graduated-swap')
    expect(pos.proceedsWei).toBe(6_000_000_000_000_000n)
    expect(out.state.risk.reserved).toBe(0)
    expect(out.state.risk.walletRealizedWei).toBe(1_000_000_000_000_000n)
  })

  it('keeps the bag open when the swap left tokens behind', () => {
    const out = decide(awaiting(), ev(T0 + 10, 'receipt', {
      hash: HASH,
      result: { ok: true, gasWei: '1000', proceedsWei: '1000', remainingWei: '99', error: null },
    }))
    const pos = [...out.state.positions.values()][0]!
    expect(pos.closed).toBe(false)
    expect(pos.grad?.proven).toBe(null)
    expect(pos.proceedsWei).toBe(1000n)
    expect(pos.tokensHeld).toBe(99n)
  })

  it('keeps an incomplete successful swap receipt until its remaining balance is proved', () => {
    let s=decide(awaiting(),ev(T0+10,'receipt',{
      hash:HASH,result:{ok:true,gasWei:'1000',proceedsWei:'6000000000000000',remainingWei:null,error:'balance unavailable'},
    })).state
    expect([...s.positions.values()][0]!.grad!.awaitingReceipt).toBe(HASH)
    s=decide(s,ev(T0+200,'receipt',{
      hash:HASH,result:{ok:true,gasWei:'1000',proceedsWei:'6000000000000000',remainingWei:'0',error:null},
    })).state
    expect([...s.positions.values()][0]!.closed).toBe(true)
    expect(s.risk.walletGasWei).toBe(1000n)
    expect(s.risk.walletRealizedWei).toBe(1_000_000_000_000_000n)
  })

  it('does not mistake an unproved swap for a completed approval leg', () => {
    const s=decide(awaiting({pendingStep:'swap'}),ev(T0+10,'receipt',{
      hash:HASH,result:{ok:true,gasWei:'1000',proceedsWei:null,remainingWei:'0',error:'sale proof unavailable'},
    })).state
    const p=[...s.positions.values()][0]!
    expect(p.closed).toBe(false)
    expect(p.grad!.awaitingReceipt).toBe(HASH)
    expect(p.grad!.pendingRaw).toBeNull()
    expect(p.grad!.lastError).toContain('not yet proved')
  })

  it('includes partial swap proceeds when the final swap closes the bag', () => {
    let s=decide(awaiting(),ev(T0+10,'receipt',{
      hash:HASH,result:{ok:true,gasWei:'1000',proceedsWei:'2000000000000000',remainingWei:'99',error:null},
    })).state
    const p=[...s.positions.values()][0]!
    const finalHash='0x'+'91'.repeat(32)
    p.grad!.awaitingReceipt=finalHash
    s=decide(s,ev(T0+200,'receipt',{
      hash:finalHash,result:{ok:true,gasWei:'1500',proceedsWei:'4000000000000000',remainingWei:'0',error:null},
    })).state
    expect(p.proceedsWei).toBe(6_000_000_000_000_000n)
    expect(s.risk.walletRealizedWei).toBe(1_000_000_000_000_000n)
  })
})

describe('the same signed bytes go out again if the receipt is late', () => {
  it('raises a broadcast, not a new nonce', () => {
    const g = {
      ...freshGradState(), pool, phase: 2, sends: 1,
      awaitingReceipt: HASH, pendingRaw: RAW, pendingAt: T0,
    }
    const s = holding({ venue: 'graduated', grad: g })
    const pos = [...s.positions.values()][0]!
    pos.venue = 'graduated'
    pos.grad = g
    const { intents } = tick(s, T0 + GRAD_RESEND_MS)
    expect(intents).toContainEqual({ kind: 'broadcast', hash: HASH, raw: RAW })
    expect(intents.some((i) => i.kind === 'grad')).toBe(false)
  })
})

describe('a bag on the pool is swapped, not parked', () => {
  it('raises a swap once the wallet and both allowances are known', () => {
    const g = {
      ...freshGradState(), pool, phase: 2,
      wallet: {
        balanceWei: 1_000n, erc20AllowanceWei: 1_000n, permitAmountWei: 1_000n,
        permitExpiry: Math.floor(T0 / 1000) + 1_000, at: T0,
      },
    }
    const s = holding({ venue: 'graduated', grad: g })
    const pos = [...s.positions.values()][0]!
    pos.venue = 'graduated'
    pos.grad = g
    const { intents } = tick(s, T0 + 1)
    const i = intents.find((x) => x.kind === 'grad')
    expect(i).toMatchObject({ kind: 'grad', step: 'swap', token: TOKEN, amountWei: 1_000n })
  })
})
