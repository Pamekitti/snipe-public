/**
 * The feed overlay: real transactions, folded.
 *
 * WHY THIS FILE EXISTS. Every `feed-block` in the rest of the suite carried `txs: []`. The one
 * code path that turns a sequenced-but-unconfirmed transaction into a price had never seen a
 * transaction, in 312 passing tests, and it was wrong in a way no amount of reading would
 * catch: it mapped the call's selector onto the topic the call's execution WOULD emit, then
 * read the calldata with a log's offsets.
 *
 * What that cost, on 2026-09-16, the first evening v2 held the wallet: the calldata's 4-byte
 * selector shifted every word, so `quoteIn` came out about 4e61 times too large, and the
 * fourth word — which exists in the LOG and not in the CALL — ran off the end and threw
 * `Cannot convert 0x to a BigInt` inside the fold, killing the process 38 times. The bot spent
 * the evening either crashing or pricing entries off a poisoned book.
 *
 * So these tests use REAL CALLDATA, byte for byte the shape the sequencer feed delivers:
 * `0x` + 8 hex of selector + three 32-byte words, 202 characters. Anything that passes a
 * hand-made log-shaped buffer in here has stopped testing the thing that broke.
 */
import { describe, expect, it } from 'vitest'
import { decide } from '../core/decide.js'
import { emptyState, type State, type TrackedCurve } from '../core/state.js'
import { callWord, decodeCurveCall, SELECTORS } from '../core/chain.js'
import { freshCurve, simBuy, simSell, type CurveParams } from '../core/curve.js'
import type { Event } from '../core/events.js'
import type { BookSpec, FrozenConfig, Switches } from '../core/config.js'

const CURVE = '0x000000000000000000000000000000000000cccc'
const TOKEN = '0x000000000000000000000000000000000000aaaa'
const BUYER = '0x000000000000000000000000000000000000eeee'

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

/** A launch off the live tape, 2026-09-16. Untaxed, which is the book that trades. */
const LAUNCHED_AT = 1_789_595_729
const PARAMS: CurveParams = {
  phantomQuote: 1_680_000_000_000_000_000n,
  reservedTokens: 285_714_285_714_285_714_285_714_285n,
  launchSupply: 1_000_000_000_000_000_000_000_000_000n,
  feeBps: 100n,
  creatorTaxBps: 0n,
  snipeTaxStartBps: 9_900n,
  snipeTaxSeconds: 3n,
  launchedAt: BigInt(LAUNCHED_AT),
}

/** Past the snipe-tax window, so the tax is not what these assertions are about. */
const BLOCK_TS = LAUNCHED_AT + 60
const AT = BLOCK_TS * 1000

const w = (v: bigint | string): string => BigInt(v).toString(16).padStart(64, '0')

/**
 * Calldata exactly as the feed delivers it: selector then three static words. 202 characters,
 * which is the length every real `buy` and `sell` on the tape had.
 */
const buyCall = (quoteIn: bigint, minTokensOut: bigint): string =>
  SELECTORS.buy + w(quoteIn) + w(minTokensOut) + w(BUYER)
const sellCall = (tokensIn: bigint, minQuoteOut: bigint): string =>
  SELECTORS.sell + w(tokensIn) + w(minQuoteOut) + w(BUYER)

let seq = 0
const ev = <T extends object>(at: number, kind: string, body: T): Event =>
  ({ seq: ++seq, at, run: 'test', kind, ...body } as unknown as Event)

function tracked(): { s: State; c: TrackedCurve } {
  const s = emptyState(CFG, SW)
  const c: TrackedCurve = {
    curve: CURVE, token: TOKEN, params: PARAMS,
    confirmed: freshCurve(PARAMS), working: freshCurve(PARAMS),
    pending: new Map(), confirmedThrough: 100, degraded: false, workingAt: 0,
  }
  s.curves.set(CURVE, c)
  return { s, c }
}

/** Fold one feed block carrying these transactions, and hand back the curve it touched. */
function fold(txs: Array<{ hash: string; to: string; data: string }>): { state: State; curve: TrackedCurve } {
  const { s } = tracked()
  const out = decide(s, ev(AT, 'feed-block', { block: 101, timestamp: BLOCK_TS, txs }))
  return { state: out.state, curve: out.state.curves.get(CURVE)! }
}

const tx = (data: string, hash = '0x' + '11'.repeat(32)) => ({ hash, to: CURVE, data })

describe('decoding a curve call', () => {
  it('reads past the selector, which is the whole bug', () => {
    const call = decodeCurveCall(buyCall(1_000_000_000_000_000n, 7n))
    expect(call).toEqual({ kind: 'buy', quoteIn: 1_000_000_000_000_000n, minTokensOut: 7n })
  })

  it('does not read the selector as part of the first number', () => {
    // The old path returned 40553527948863839132015179082756437644191781899461656834683879375544574115492
    // for this call: `0x59a87bc1` sitting in the top bits of what should be 0.001 ETH.
    const call = decodeCurveCall(buyCall(1_000_000_000_000_000n, 0n))
    expect(call?.kind).toBe('buy')
    expect(call && call.kind === 'buy' && call.quoteIn).toBe(1_000_000_000_000_000n)
  })

  it('reads a sell the same way', () => {
    const call = decodeCurveCall(sellCall(500n, 4n))
    expect(call).toEqual({ kind: 'sell', tokensIn: 500n, minQuoteOut: 4n })
  })

  it('is null, never a throw, for everything it cannot read', () => {
    const short = SELECTORS.buy + w(1n) // one word where three belong
    expect(decodeCurveCall(short)).toBeNull()
    expect(decodeCurveCall('0x')).toBeNull()
    expect(decodeCurveCall('')).toBeNull()
    expect(decodeCurveCall(SELECTORS.buy)).toBeNull()
    expect(decodeCurveCall('0xdeadbeef' + w(1n) + w(2n) + w(3n))).toBeNull()
    // The exact shape that threw: a word that is present but not whole.
    expect(decodeCurveCall(SELECTORS.buy + w(1n) + 'abcd')).toBeNull()
  })

  it('refuses a word that is not hex rather than coercing it', () => {
    expect(callWord(SELECTORS.buy + 'z'.repeat(64), 0)).toBeNull()
  })
})

describe('the overlay simulates the transaction rather than reading its numbers', () => {
  const QUOTE_IN = 10_000_000_000_000_000n // 0.01 ETH, a normal rival buy

  it('moves the book by exactly what the curve math says, to the wei', () => {
    const { curve } = fold([tx(buyCall(QUOTE_IN, 0n))])
    const expected = simBuy(PARAMS, freshCurve(PARAMS), QUOTE_IN, BigInt(BLOCK_TS), { minTokensOut: 0n }).next
    expect(curve.working).toEqual(expected)
  })

  it('moves it by an amount that is the size of the trade, not 1e61 times it', () => {
    const { curve } = fold([tx(buyCall(QUOTE_IN, 0n))])
    // The old path added ~4e61 wei of quote to a curve whose whole supply is 1e27.
    expect(curve.working.trackedQuote).toBe(QUOTE_IN)
    expect(curve.working.trackedQuote).toBeLessThan(PARAMS.launchSupply)
    expect(curve.working.trackedTokens).toBeLessThan(PARAMS.launchSupply)
    expect(curve.working.trackedTokens).toBeGreaterThan(0n)
  })

  it('leaves confirmed alone: the overlay is a prediction, not evidence', () => {
    const { curve } = fold([tx(buyCall(QUOTE_IN, 0n))])
    expect(curve.confirmed).toEqual(freshCurve(PARAMS))
    expect(curve.working).not.toEqual(curve.confirmed)
  })

  it('applies a sell in the other direction', () => {
    const { s, c } = tracked()
    // Sell needs tokens to have left the curve first, so seed a book that has traded.
    const after = simBuy(PARAMS, freshCurve(PARAMS), QUOTE_IN, BigInt(BLOCK_TS)).next
    c.confirmed = after
    c.working = after
    const tokensIn = 1_000_000_000_000_000_000_000n
    const out = decide(s, ev(AT, 'feed-block', {
      block: 101, timestamp: BLOCK_TS, txs: [tx(sellCall(tokensIn, 0n))],
    }))
    const curve = out.state.curves.get(CURVE)!
    expect(curve.working).toEqual(simSell(PARAMS, after, tokensIn, { minQuoteOut: 0n }).next)
    expect(curve.working.trackedTokens).toBeGreaterThan(after.trackedTokens)
  })

  it('stacks two transactions in order, each onto the last', () => {
    const { curve } = fold([
      tx(buyCall(QUOTE_IN, 0n), '0x' + 'aa'.repeat(32)),
      tx(buyCall(QUOTE_IN, 0n), '0x' + 'bb'.repeat(32)),
    ])
    const one = simBuy(PARAMS, freshCurve(PARAMS), QUOTE_IN, BigInt(BLOCK_TS), { minTokensOut: 0n }).next
    const two = simBuy(PARAMS, one, QUOTE_IN, BigInt(BLOCK_TS), { minTokensOut: 0n }).next
    expect(curve.working).toEqual(two)
  })
})

describe('a transaction that would revert never touches the book', () => {
  it('skips a buy whose own slippage bound cannot be met', () => {
    // Asking for more tokens than the curve can possibly give: this reverts on chain, emits
    // no log, and moves nothing. Rival bots racing each other do this constantly.
    const impossible = PARAMS.launchSupply
    const { curve } = fold([tx(buyCall(10_000_000_000_000_000n, impossible))])
    expect(curve.working).toEqual(freshCurve(PARAMS))
  })

  it('skips a zero-amount call instead of dividing by it', () => {
    const { curve } = fold([tx(buyCall(0n, 0n))])
    expect(curve.working).toEqual(freshCurve(PARAMS))
  })

  it('keeps folding the rest of the block after one reverts', () => {
    const good = 10_000_000_000_000_000n
    const { curve } = fold([
      tx(buyCall(good, PARAMS.launchSupply), '0x' + 'aa'.repeat(32)), // reverts
      tx(buyCall(good, 0n), '0x' + 'bb'.repeat(32)), // lands
    ])
    expect(curve.working).toEqual(simBuy(PARAMS, freshCurve(PARAMS), good, BigInt(BLOCK_TS), { minTokensOut: 0n }).next)
  })
})

describe('malformed calldata cannot stop the bot', () => {
  /**
   * The regression that matters. Before the fix this exact fold threw inside `decide`, which
   * is not caught anywhere: pm2 restarted the process, the tape replayed, and it threw again.
   */
  it('folds a truncated buy without throwing, and prices nothing off it', () => {
    const short = SELECTORS.buy + w(1_000_000_000_000_000n) // one word, not three
    expect(() => fold([tx(short)])).not.toThrow()
    expect(fold([tx(short)]).curve.working).toEqual(freshCurve(PARAMS))
  })

  it('folds an empty data field without throwing', () => {
    expect(() => fold([tx('0x')])).not.toThrow()
  })

  it('survives a block full of rubbish', () => {
    const rubbish = [
      tx(SELECTORS.buy, '0x' + 'a1'.repeat(32)),
      tx(SELECTORS.sell + 'ff', '0x' + 'a2'.repeat(32)),
      tx('0x' + 'ab'.repeat(200), '0x' + 'a3'.repeat(32)),
    ]
    expect(() => fold(rubbish)).not.toThrow()
    expect(fold(rubbish).curve.working).toEqual(freshCurve(PARAMS))
  })

  /**
   * A selector the fold does not know is a ROUTING DISAGREEMENT, not a malformed call: the
   * live run put this transaction on the tape as one it routed to a tracked curve, and the
   * fold would not have. It is recorded rather than dropped, because a replay that quietly
   * disagrees with the run it replays is worse than one that says so.
   */
  it('records an unknown selector as a routing divergence instead of ignoring it', () => {
    const { s } = tracked()
    const out = decide(s, ev(AT, 'feed-block', {
      block: 101, timestamp: BLOCK_TS, txs: [tx('0x3729bb9a' + w(1n))],
    }))
    expect(out.refusals.map((r) => r.bucket)).toContain('feed-routing-divergence')
  })
})

describe('the overlay is replayable, which means it never reads a clock', () => {
  /**
   * The snipe tax is a function of how long ago the curve launched, so the timestamp the
   * overlay simulates at changes the answer. It has to come from the sequenced block, not from
   * `Date.now()`: v1 used the wall clock here, and a replay of v1's tape could not reproduce
   * its own overlay because of it.
   */
  it('takes the snipe tax from the block being folded, not from now', () => {
    const inTax = LAUNCHED_AT + 1 // inside snipeTaxSeconds, so the tax bites
    const { s } = tracked()
    const out = decide(s, ev(inTax * 1000, 'feed-block', {
      block: 101, timestamp: inTax, txs: [tx(buyCall(10_000_000_000_000_000n, 0n))],
    }))
    const curve = out.state.curves.get(CURVE)!
    const taxed = simBuy(PARAMS, freshCurve(PARAMS), 10_000_000_000_000_000n, BigInt(inTax), { minTokensOut: 0n }).next
    const untaxed = simBuy(PARAMS, freshCurve(PARAMS), 10_000_000_000_000_000n, BigInt(BLOCK_TS), { minTokensOut: 0n }).next
    expect(curve.working).toEqual(taxed)
    // If it were reading a clock, or ignoring the timestamp, it would land on the other one.
    expect(taxed).not.toEqual(untaxed)
  })

  it('folds the same block twice to the same book', () => {
    const a = fold([tx(buyCall(10_000_000_000_000_000n, 0n))]).curve.working
    const b = fold([tx(buyCall(10_000_000_000_000_000n, 0n))]).curve.working
    expect(a).toEqual(b)
  })
})
