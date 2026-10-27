/**
 * THE BOT-BROKEN HALT: are we losing money the venue did not lose?
 *
 * Every real loss v1 took in September was a bug in us rather than a market — the 09-04 burned-gas
 * retry loop, the 09-06 same-block log drop — and both were found by a person reading numbers
 * hours later. This is the arithmetic that finds them, so the tests are about the two ways it
 * could be wrong: firing on a bad market, which would halt a bot that should trade, and staying
 * quiet through a real bug.
 *
 * THE SECOND HALF OF THE FILE IS ABOUT THE WIRING, and that is the half v2 actually needed. The
 * arithmetic was never the missing piece: `HaltKind` declared `broken`, `HALT_RANK` ranked it
 * above `drawdown`, `BrokenReading` had a type and a sensor slot, `broken_window` and
 * `broken_factor` parsed and were documented — and no line of code computed a pair, produced a
 * reading, or raised the halt. A guard nothing raises is a comment.
 */
import { describe, expect, it } from 'vitest'
import { brokenGap, filePair } from '../core/broken.js'
import { decide } from '../core/decide.js'
import { observe, openObservation } from '../core/observe.js'
import { emptyState, type Outcome, type Position, type State } from '../core/state.js'
import { HALT_RANK } from '../core/risk.js'
import { haltedFor } from '../core/state.js'
import { freshCurve, type CurveParams } from '../core/curve.js'
import type { Event } from '../core/events.js'
import type { BookSpec, FrozenConfig, Switches } from '../core/config.js'

const BOOK: BookSpec = {
  id: 'only', minCreatorTaxBps: 0, maxCreatorTaxBps: 0, minExemptions: 3, templateLossBlockMs: 3_600_000,
  sizeWei: '20000000000000000', maxDrawdownWei: '15000000000000000',
  entry: { entryDelayMs: 2_000, entryFallbackLateMs: 600, maxEntryPriceMultiple: 4.5, buySlippageBps: 5_000 },
  exit: { maxHoldMs: 45_000, hardStopMultiple: 0.5, deadCoinAfterMs: 20_000, deadCoinBelowMultiple: 1.03, graduationExitAt: 0.12, maxSellAttempts: 20, exitRetryDelayMs: 300, sellFinalMinQuoteOutWei: '1' },
  takeProfit: { otherwise: 1.75, adaptiveWindow: 20, adaptiveBars: [1.25, 1.75] },
  guard: { window: 20, recoveryWindow: 8, openAt: 1, shutAt: -1, settleMs: 52_000, freshMs: 10_800_000, pnlBar: 1.75, maxReadingAgeMs: 10_800_000 },
}

/** The shipped risk block, so every threshold below is the one real money runs behind. */
const RISK = {
  maxConcurrent: 14, maxTradeSizeWei: '20000000000000000', bankrollWei: '80000000000000000', drawdownStakes: 3,
  maxWalletDrawdownWei: '30000000000000000',
  brokenWindow: 20, brokenFactor: 0.78, brokenGapPp: 15,
  maxLogsStalenessMs: 3_000, maxOverlayAgeMs: 1_500,
}

const CFG: FrozenConfig = { specVersion: 1, books: [BOOK], risk: RISK, clock: { periodMs: 250 } }
const SW: Switches = { sizeWei: 20_000_000_000_000_000n, mode: 'live', at: 0, by: 'test' }

const T0 = 1_789_600_000_000
const STAKE = 20_000_000_000_000_000n

const pairs = (real: number, replay: number, n = RISK.brokenWindow) =>
  Array.from({ length: n }, () => ({ real, replay }))

// ---------------------------------------------------------------------------
// The arithmetic, ported from bot/test/broken.test.ts
// ---------------------------------------------------------------------------

describe('brokenGap', () => {
  it('reads about zero when we make the historical share of the replay', () => {
    // 0.78 is what real money made per unit of replay over 463 paired trades; a bot performing
    // exactly to that expectation is not broken, however small the returns.
    const b = brokenGap(pairs(0.156, 0.2), 0.78)!
    expect(b.gapPp).toBeCloseTo(0, 6)
    expect(b.n).toBe(20)
  })

  it('is deeply negative on the 2026-09-06 shape: the venue paid and we did not', () => {
    // The real numbers from the afternoon of the same-block log drop.
    const b = brokenGap(pairs(-0.071, 0.144), 0.78)!
    expect(b.gapPp).toBeCloseTo(-18.3, 1)
    expect(b.realPp).toBeCloseTo(-7.1, 1)
    expect(b.replayPp).toBeCloseTo(14.4, 1)
  })

  it('stays near zero on a BAD MARKET, which must never halt this way', () => {
    // Both sides lose together: that is a venue, and the venue pause and the drawdown stop are
    // the ones that answer it. This check must not fire.
    const b = brokenGap(pairs(-0.2, -0.25), 0.78)!
    expect(Math.abs(b.gapPp)).toBeLessThan(RISK.brokenGapPp)
  })

  it('compares the means, so one runner cannot swing the verdict', () => {
    // A per-pair ratio has tails fat enough to be meaningless: v1 logged a single 2.36x winner
    // moving a per-trade mean by 215 points of one trade's stake.
    const many = [...pairs(0.1, 0.12, 19), { real: 12, replay: 14 }]
    const b = brokenGap(many, 0.78)!
    expect(b.n).toBe(20)
    expect(b.gapPp).toBeGreaterThan(0)
  })

  it('drops non-finite pairs and has no opinion when nothing is left', () => {
    const b = brokenGap([{ real: NaN, replay: 0.2 }, { real: 0.1, replay: Infinity }, { real: 0.156, replay: 0.2 }], 0.78)!
    expect(b.n).toBe(1)
    expect(brokenGap([{ real: NaN, replay: NaN }], 0.78)).toBe(null)
    expect(brokenGap([], 0.78)).toBe(null)
  })

  it('the shipped threshold separates those two worlds', () => {
    // The whole design in one assertion: a bug halts, a bad market does not.
    const bug = brokenGap(pairs(-0.071, 0.144), RISK.brokenFactor)!
    const market = brokenGap(pairs(-0.2, -0.25), RISK.brokenFactor)!
    expect(bug.gapPp).toBeLessThanOrEqual(-RISK.brokenGapPp)
    expect(market.gapPp).toBeGreaterThan(-RISK.brokenGapPp)
  })
})

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------

const tok = (n: number) => '0x' + n.toString(16).padStart(40, 'a')

const rules = {
  ...BOOK.exit, takeProfitMultiple: 1.75, buySlippageBps: BOOK.entry.buySlippageBps,
} as Position['rules']

/** A closed trade: staked `STAKE`, took `proceeds` back, at the 1.75 rung. */
function closedTrade(s: State, token: string, proceeds: bigint, over: Partial<Position> = {}): Position {
  const pos: Position = {
    id: `buy-${token}`, token, curve: token, book: 'only', bookDigest: 'd', templateKey: 't',
    openedAt: T0 - 60_000, spendWei: STAKE, entryMarkWei: STAKE,
    rules, tokensHeld: 0n, peakMarkWei: STAKE,
    proceedsWei: proceeds, closedAt: T0, abandonedAt: null, abandonReason: null,
    exitReason: 'time', attempts: 1, inflightIntentId: null,
    lastBuyHash: null, lastSellHash: null, awaitingSellReceipt: null,
    closed: true, venue: 'curve', grad: null, filled: true,
    ...over,
  }
  s.positions.set(pos.id, pos)
  return pos
}

/** A settled replay of the same coin, worth `stakes` at every bar. */
function settled(s: State, token: string, stakes: number): Outcome {
  const o: Outcome = {
    token, book: 'only', at: T0,
    perBar: { '1.25': stakes, '1.75': stakes },
    stakes, peak: 1 + Math.max(0, stakes),
  }
  s.cohort.push(o)
  return o
}

/**
 * `n` paired trades where we made `realFrac` of a stake and the replay says `replay`.
 *
 * `from` shifts the tokens, because a token is bought at most once ever and a pair is filed at
 * most once per token: a second window has to be a second set of coins, exactly as it is live.
 */
function fileWindow(s: State, realFrac: number, replay: number, n = RISK.brokenWindow, from = 0): State {
  let out = s
  for (let i = from; i < from + n; i++) {
    const t = tok(i)
    closedTrade(out, t, STAKE + BigInt(Math.round(realFrac * Number(STAKE))))
    settled(out, t, replay)
    out = filePair(out, t)
  }
  return out
}

const base = (): State => ({ ...emptyState(CFG, SW), at: T0 })

describe('a pair completes whichever half arrives second', () => {
  it('files nothing while only the trade exists', () => {
    // The watch settles at 52s and the hold clock is 45s, so this is the ordinary order.
    const s = base()
    closedTrade(s, tok(1), STAKE)
    expect(filePair(s, tok(1)).pairs.size).toBe(0)
  })

  it('files nothing while only the replay exists', () => {
    const s = base()
    settled(s, tok(1), 0.2)
    expect(filePair(s, tok(1)).pairs.size).toBe(0)
  })

  it('files once when the settle arrives after the close', () => {
    const s = base()
    closedTrade(s, tok(1), (STAKE * 3n) / 2n)
    settled(s, tok(1), 0.2)
    const after = filePair(s, tok(1))
    expect(after.pairs.size).toBe(1)
    expect(after.pairs.all()[0]).toMatchObject({ token: tok(1), real: 0.5, replay: 0.2 })
  })

  it('files once when the close arrives after the settle', () => {
    // A bag sold through the pool after graduation closes long after its watch settled.
    const s = base()
    settled(s, tok(1), 0.2)
    closedTrade(s, tok(1), (STAKE * 3n) / 2n)
    expect(filePair(s, tok(1)).pairs.size).toBe(1)
  })

  it('does not file the same trade twice however often it is asked', () => {
    // Both call sites ask, and the ordering argument says only one can ever find both halves. This
    // pins the belt to that braces: one coin counted twice would carry double weight in a mean
    // that is supposed to be one vote per trade.
    const s = base()
    closedTrade(s, tok(1), STAKE)
    settled(s, tok(1), 0.2)
    let after = filePair(s, tok(1))
    expect(after.pairs.size).toBe(1)
    after = filePair(after, tok(1))
    after = filePair(after, tok(1).toUpperCase())
    expect(after.pairs.size).toBe(1)
  })
})

describe('what is deliberately not paired', () => {
  it('skips an ABANDONED row, whose zero proceeds are an accounting decision', () => {
    // The tokens left the wallet with no sale receipt, so booked proceeds are zero BY DESIGN.
    // Pairing it would enter -100 points as though the coin had been worthless, and a boot-time
    // reconciliation of old stranded bags could halt the wallet on history it had already seen.
    const s = base()
    closedTrade(s, tok(1), 0n, { abandonedAt: T0, abandonReason: 'balance was zero, no receipt' })
    settled(s, tok(1), 0.2)
    expect(filePair(s, tok(1)).pairs.size).toBe(0)
  })

  it('skips a row whose pinned rung the replay never scored', () => {
    // The bar set moved under it. That is missing data, and it is skipped exactly as a dropped
    // `stakes` is skipped in the venue window rather than counted as a flat outcome.
    const s = base()
    closedTrade(s, tok(1), STAKE, { rules: { ...rules, takeProfitMultiple: 2.5 } as Position['rules'] })
    settled(s, tok(1), 0.2)
    expect(filePair(s, tok(1)).pairs.size).toBe(0)
  })

  it('skips a trade that staked nothing, rather than dividing by it', () => {
    const s = base()
    closedTrade(s, tok(1), 0n, { spendWei: 0n })
    settled(s, tok(1), 0.2)
    expect(filePair(s, tok(1)).pairs.size).toBe(0)
  })

  it('skips an open position, because a trade in flight has made nothing yet', () => {
    const s = base()
    closedTrade(s, tok(1), 0n, { closed: false, closedAt: null, tokensHeld: 1n })
    settled(s, tok(1), 0.2)
    expect(filePair(s, tok(1)).pairs.size).toBe(0)
  })
})

describe('the reading, and the halt it raises', () => {
  it('has no opinion until the window is full, and does not fail closed', () => {
    // NOT the venue's rule, deliberately. "We have not paired twenty trades yet" is not evidence
    // that the bot is mispricing, and a detector that halted on its own warmup would stop the
    // wallet after every restart for a reason it had not measured.
    const s = fileWindow(base(), -0.5, 0.4, RISK.brokenWindow - 1)
    expect(s.pairs.size).toBe(RISK.brokenWindow - 1)
    expect(s.sensors.broken).toBeNull()
    expect(s.risk.halts.has('broken')).toBe(false)
  })

  it('publishes the reading once the window is full', () => {
    const s = fileWindow(base(), 0.156, 0.2)
    expect(s.sensors.broken!.value.n).toBe(RISK.brokenWindow)
    expect(s.sensors.broken!.value.gapPp).toBeCloseTo(0, 6)
    expect(s.sensors.broken!.source, 'derived here, so a replay reproduces it').toBe('fold')
    expect(s.sensors.broken!.at).toBe(T0)
    expect(s.risk.halts.has('broken')).toBe(false)
  })

  it('HALTS THE WALLET on the 09-06 shape', () => {
    const s = fileWindow(base(), -0.071, 0.144)
    const halt = s.risk.halts.get('broken')!
    expect(halt).toBeTruthy()
    expect(halt.kind).toBe('broken')
    expect(halt.book, 'wallet-wide: a mispricing bug is in the code, not in a band').toBeNull()
    expect(halt.reason).toContain('adjusted gap')
    // and it stops entries on every book, which is what `book: null` has to mean
    expect(haltedFor(s.risk, 'only')?.kind).toBe('broken')
  })

  it('does NOT halt when the market took it and the replay agrees', () => {
    const s = fileWindow(base(), -0.2, -0.25)
    expect(s.sensors.broken!.value.gapPp).toBeGreaterThan(-RISK.brokenGapPp)
    expect(s.risk.halts.has('broken')).toBe(false)
  })

  it('never lifts itself, however far the gap recovers', () => {
    // The asymmetry that separates this from the venue pause. A bad market reverses on its own; a
    // bug does not, and a gap that drifted back inside the band is a bug that got quieter.
    let s = fileWindow(base(), -0.071, 0.144)
    expect(s.risk.halts.has('broken')).toBe(true)
    const at = s.risk.halts.get('broken')!.at
    s = fileWindow({ ...s, at: T0 + 600_000 }, 0.5, 0.2, RISK.brokenWindow, RISK.brokenWindow)
    expect(s.sensors.broken!.value.gapPp, 'the gap is healthy again').toBeGreaterThan(0)
    expect(s.risk.halts.has('broken'), 'and the halt is still there').toBe(true)
    expect(s.risk.halts.get('broken')!.at, 'with its original reason and time').toBe(at)
  })

  it('is lifted by the operator, and the lift takes the evidence with it', () => {
    /**
     * THE CLEAR IS THE LIFT. Leaving the window in place would let the next settled trade
     * recompute the same twenty pairs and re-raise the halt within one launch, which is exactly
     * why the drawdown reset clears what its own stop measures.
     */
    const s = fileWindow(base(), -0.071, 0.144)
    expect(s.risk.halts.has('broken')).toBe(true)
    const out = decide(s, ev(T0 + 1, 'operator', { action: 'clear-broken', why: 'found the log drop' }))
    expect(out.state.risk.halts.has('broken')).toBe(false)
    expect(out.state.pairs.size, 'the window described code that is no longer running').toBe(0)
    expect(out.state.sensors.broken, 'and there is no reading over no evidence').toBeNull()
  })

  it('refuses the lift while a position is open, whatever the control layer said', () => {
    // The fold repeats the guard because the tape is the authority and can be replayed without the
    // control layer. Lifting with money on the table puts an undiagnosed bot back onto open bags.
    const s = fileWindow(base(), -0.071, 0.144)
    closedTrade(s, tok(99), 0n, { closed: false, closedAt: null, tokensHeld: 5n })
    const out = decide(s, ev(T0 + 1, 'operator', { action: 'clear-broken', why: 'impatient' }))
    expect(out.state.risk.halts.has('broken')).toBe(true)
    expect(out.refusals.some((r) => r.reason.includes('still open'))).toBe(true)
  })

  it('outranks the drawdown it causes, so the drawdown cannot self-lift over it', () => {
    // A mispricing bot's drawdown is a SYMPTOM. If `drawdown` outranked `broken`, the
    // shared guard reopen would run while the cause was still true and put the money straight back.
    expect(HALT_RANK.indexOf('broken')).toBeLessThan(HALT_RANK.indexOf('drawdown'))
  })
})

// ---------------------------------------------------------------------------
// Through the fold
// ---------------------------------------------------------------------------

const LAUNCHED_AT = 1_789_595_729
const PARAMS: CurveParams = {
  phantomQuote: 1_680_000_000_000_000_000n,
  reservedTokens: 285_714_285_714_285_714_285_714_285n,
  launchSupply: 1_000_000_000_000_000_000_000_000_000n,
  feeBps: 100n, creatorTaxBps: 0n, snipeTaxStartBps: 9_900n, snipeTaxSeconds: 3n,
  launchedAt: BigInt(LAUNCHED_AT),
}

let seq = 0
const ev = <T extends object>(at: number, kind: string, body: T): Event =>
  ({ seq: ++seq, at, run: 'test', kind, ...body } as unknown as Event)

const SELL_HASH = '0x' + '77'.repeat(32)

describe('the fold files the pair when the settle is what completes it', () => {
  it('pairs at settle, for the trade that closed before its watch did', () => {
    // The ordinary order: the hold clock is 45s and the watch settles at 52s. If the settle loop
    // did not file, that would be EVERY normal trade, and the detector would only ever see the
    // graduated stragglers.
    const s = emptyState(CFG, SW)
    const token = tok(3)
    const curve = tok(4)
    openObservation(s, {
      token, curve, book: 'only',
      launchBlock: 100, deployer: tok(5), launchTx: '0x' + '11'.repeat(32), creatorTaxBps: 0,
    })
    closedTrade(s, token, STAKE * 2n, { curve })

    const after = observe({ ...s, at: T0 + BOOK.guard.settleMs })
    expect(after.cohort.size, 'the watch settled').toBe(1)
    expect(after.pairs.size, 'and the pair was filed from the settle side').toBe(1)
    expect(after.pairs.all()[0]).toMatchObject({ token, real: 1 })
    // The replay half is the simulator's answer for the pinned column, whatever it is: the point
    // of the test is the wiring, and pinning a curve number here would pin `sim.ts` twice.
    expect(Number.isFinite(after.pairs.all()[0]!.replay)).toBe(true)
  })
})

describe('the fold files the pair on the way past a close', () => {
  it('pairs a real close, through decide, without anything else asking it to', () => {
    /**
     * `closePosition` is the one place a row is booked closed and it is where the filing hangs, so
     * this goes through `decide` rather than calling `filePair` directly. If the call were only in
     * the settle loop, every trade that closed AFTER its watch settled — which is every graduated
     * bag sold through the pool — would never be measured, and those are exactly the trades most
     * likely to reveal a broken exit.
     */
    const s = emptyState(CFG, SW)
    const token = tok(7)
    const curve = tok(8)
    s.curves.set(curve, {
      curve, token, params: PARAMS,
      confirmed: freshCurve(PARAMS), working: freshCurve(PARAMS),
      pending: new Map(), confirmedThrough: 100, degraded: false, workingAt: T0,
    })
    // The replay landed first, so the close is the second half.
    settled(s, token, 0.2)
    const pos = closedTrade(s, token, 0n, {
      curve, closed: false, closedAt: null, tokensHeld: 1_000n, exitReason: null,
      inflightIntentId: 'sell-1',
    })
    s.risk.reserved = 1
    s.risk.deployedWei = pos.spendWei
    s.inflight.set('sell-1', {
      kind: 'sell', intentId: 'sell-1', token, curve, reason: 'time',
      raisedAt: T0, hash: SELL_HASH, nonce: 4, signedAt: T0,
    })

    const out = decide({ ...s, at: T0 }, ev(T0 + 1, 'receipt', {
      hash: SELL_HASH,
      result: { ok: true, gasWei: '0', proceedsWei: String(STAKE * 2n), remainingWei: '0', outOfGas: false, error: null },
    }))
    expect(out.state.positions.get(pos.id)!.closed, 'the receipt closed the row').toBe(true)
    expect(out.state.pairs.size, 'and the pair was filed on the way past').toBe(1)
    // Staked one, took two back: one whole stake of profit against a replay that says 0.2.
    expect(out.state.pairs.all()[0]).toMatchObject({ token, real: 1, replay: 0.2 })
  })
})
