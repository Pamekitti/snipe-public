/**
 * Gas the chain proved we paid, and the stop that has to see it.
 *
 * WHY THIS FILE EXISTS. Booked P&L is proceeds minus stake over CLOSED rows, and a bug closes no
 * rows. A sell that reverts moves no proceeds, books nothing, and the chain charges for every
 * attempt — so measured against booked P&L the drawdown stop could not see a gas bleed at all.
 * v1 found that out on 2026-09-04, when one stuck position burned $101 across 945 reverts while
 * both of its caps read the book at +$52 and saw nothing, and added `RiskManager.burned` for it.
 * v2 had `revertedGasWei` on the graduated path as a per-bag 5% ceiling and nothing anywhere near
 * the wallet stop.
 *
 * What is pinned here is the split the runbook requires: `realizedWei` stays booked P&L, exactly
 * what rule 3 defines, and the STOP reads net. Both halves matter. A test that only checked the
 * halt would pass an implementation that quietly redefined the number a person reads.
 */
import { describe, expect, it } from 'vitest'
import { decide } from '../core/decide.js'
import {
  bookLedger, emptyState, ledgerNetWei, walletNetWei, type Position, type State,
} from '../core/state.js'
import { canEnter, drawdownBreach, walletDrawdownBreach } from '../core/risk.js'
import { freshCurve, type CurveParams } from '../core/curve.js'
import type { Event } from '../core/events.js'
import type { BookSpec, FrozenConfig, Switches } from '../core/config.js'
import { buildAlerts } from '../projections/alerts.js'
import { buildReport } from '../projections/report.js'
import { History } from '../projections/history.js'
import { LEVELS } from '../projections/levels.js'

const CURVE = '0x000000000000000000000000000000000000cccc'
const TOKEN = '0x000000000000000000000000000000000000aaaa'
const SELL_HASH = '0x' + '22'.repeat(32)

/** 0.015 ETH, the shipped per-book stop, so the numbers below are the ones the bot really uses. */
const STOP_WEI = 15_000_000_000_000_000n

const BOOK: BookSpec = {
  id: 'only', minCreatorTaxBps: 0, maxCreatorTaxBps: 0, minExemptions: 3, templateLossBlockMs: 3_600_000,
  sizeWei: '5000000000000000', maxDrawdownWei: String(STOP_WEI),
  entry: { entryDelayMs: 2_000, entryFallbackLateMs: 600, maxEntryPriceMultiple: 4.5, buySlippageBps: 5_000 },
  exit: { maxHoldMs: 45_000, hardStopMultiple: 0.5, deadCoinAfterMs: 20_000, deadCoinBelowMultiple: 1.03, graduationExitAt: 0.12, maxSellAttempts: 20, exitRetryDelayMs: 300, sellFinalMinQuoteOutWei: '1' },
  takeProfit: { otherwise: 1.75, adaptiveWindow: 20, adaptiveBars: [1.25, 1.75] },
  guard: { window: 20, recoveryWindow: 8, openAt: 1, shutAt: -1, settleMs: 52_000, freshMs: 10_800_000, pnlBar: 1.75, maxReadingAgeMs: 10_800_000 },
}

const CFG: FrozenConfig = {
  specVersion: 1, books: [BOOK],
  risk: {
    maxConcurrent: 14, maxTradeSizeWei: '20000000000000000', bankrollWei: '80000000000000000', drawdownStakes: 3,
    maxWalletDrawdownWei: String(STOP_WEI),
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

let seq = 0
const ev = <T extends object>(at: number, kind: string, body: T): Event =>
  ({ seq: ++seq, at, run: 'test', kind, ...body } as unknown as Event)

const rules = {
  ...BOOK.exit, takeProfitMultiple: BOOK.takeProfit.otherwise,
  buySlippageBps: BOOK.entry.buySlippageBps,
} as Position['rules']

/** One open position with a sell already sequenced: the shape a reverting exit is stuck in. */
function withInflightSell(): State {
  const s = emptyState(CFG, SW)
  s.curves.set(CURVE, {
    curve: CURVE, token: TOKEN, params: PARAMS,
    confirmed: freshCurve(PARAMS), working: freshCurve(PARAMS),
    pending: new Map(), confirmedThrough: 100, degraded: false, workingAt: T0,
  })
  const pos: Position = {
    id: 'buy-1', token: TOKEN, curve: CURVE, book: 'only', bookDigest: 'd', templateKey: 't',
    openedAt: T0 - 60_000, spendWei: 5_000_000_000_000_000n, entryMarkWei: 4_800_000_000_000_000n,
    rules, tokensHeld: 1_000_000_000_000_000_000_000n, peakMarkWei: 4_800_000_000_000_000n,
    proceedsWei: 0n, closedAt: null, abandonedAt: null, abandonReason: null,
    exitReason: null, attempts: 0, inflightIntentId: 'sell-2',
    lastBuyHash: null, lastSellHash: SELL_HASH, awaitingSellReceipt: null,
    closed: false, venue: 'curve', grad: null, filled: true,
  }
  s.positions.set(pos.id, pos)
  s.risk.reserved = 1
  s.risk.deployedWei = pos.spendWei
  s.inflight.set('sell-2', {
    kind: 'sell', intentId: 'sell-2', token: TOKEN, curve: CURVE, reason: 'time',
    raisedAt: T0, hash: SELL_HASH, nonce: 4, signedAt: T0,
  })
  return { ...s, at: T0, decisions: 10 }
}

/** A reverting sell receipt: no proceeds, no row closed, and a gas bill. */
const revertedSell = (at: number, gasWei: bigint): Event => ev(at, 'receipt', {
  hash: SELL_HASH,
  result: { ok: false, gasWei: String(gasWei), proceedsWei: null, remainingWei: null, outOfGas: false, error: 'ERC20InsufficientAllowance' },
})

describe('the two ledgers are different numbers and stay different', () => {
  it('booked P&L carries no gas, and net carries both', () => {
    const s = emptyState(CFG, SW)
    const l = bookLedger(s.risk, 'only')
    l.realizedWei = 1_000n
    l.gasWei = 400n
    expect(l.realizedWei, 'rule 3: the figure a person reads is proceeds minus stake').toBe(1_000n)
    expect(ledgerNetWei(l), 'the figure the stop reads is what left the wallet').toBe(600n)
  })

  it('the wallet has the same split', () => {
    const s = emptyState(CFG, SW)
    s.risk.walletRealizedWei = 1_000n
    s.risk.walletGasWei = 400n
    expect(walletNetWei(s.risk)).toBe(600n)
  })
})

describe('gas alone can reach a stop that booked P&L would never move', () => {
  it('breaches the book stop on gas with the book at break-even', () => {
    const s = emptyState(CFG, SW)
    const l = bookLedger(s.risk, 'only')
    // Never won, never lost, and burned the stop's worth of gas. Booked P&L is 0n throughout,
    // so measured the old way this is not a drawdown at all.
    l.realizedWei = 0n
    l.peakWei = 0n
    l.gasWei = STOP_WEI
    expect(drawdownBreach(CFG, s.risk, 'only', s.switches.sizeWei)).toMatchObject({ downWei: STOP_WEI, limitWei: STOP_WEI })
  })

  it('breaches the wallet stop the same way', () => {
    const s = emptyState(CFG, SW)
    s.risk.walletGasWei = STOP_WEI
    expect(walletDrawdownBreach(CFG, s.risk, s.switches.sizeWei)).toMatchObject({ downWei: STOP_WEI })
  })

  it('says nothing while the gas is still under the limit', () => {
    const s = emptyState(CFG, SW)
    bookLedger(s.risk, 'only').gasWei = STOP_WEI - 1n
    expect(drawdownBreach(CFG, s.risk, 'only', s.switches.sizeWei)).toBeNull()
    expect(walletDrawdownBreach(CFG, s.risk, s.switches.sizeWei)).toBeNull()
  })

  it('does not halt an unfunded book: a zero stop is not halt-on-contact', () => {
    const unfunded: FrozenConfig = {
      ...CFG,
      books: [{ ...CFG.books[0]!, sizeWei: '0', maxDrawdownWei: '0' }],
      risk: { ...CFG.risk, maxWalletDrawdownWei: '0' },
    }
    const s = emptyState(unfunded, SW)
    expect(drawdownBreach(unfunded, s.risk, 'only', s.switches.sizeWei)).toBeNull()
    expect(walletDrawdownBreach(unfunded, s.risk, s.switches.sizeWei)).toBeNull()
  })
})

describe('a reverting sell is charged the moment its receipt says so', () => {
  it('charges the gas, books no proceeds and closes no row', () => {
    const out = decide(withInflightSell(), revertedSell(T0 + 1, 49_028n))
    const l = bookLedger(out.state.risk, 'only')
    expect(l.gasWei, 'the chain charged for the attempt, so the ledger does').toBe(49_028n)
    expect(out.state.risk.walletGasWei).toBe(49_028n)
    expect(l.realizedWei, 'booked P&L is untouched: nothing closed and no proceeds moved').toBe(0n)
    expect(out.state.positions.get('buy-1')?.closed, 'a reverting sell must leave the row open').toBe(false)
  })

  it('charged when the receipt lands, not when the position eventually closes', () => {
    // The whole point. A bleeding position may never close, so waiting for the close is waiting
    // for an event that a stuck row never produces.
    const out = decide(withInflightSell(), revertedSell(T0 + 1, 49_028n))
    expect(out.state.positions.get('buy-1')?.closedAt).toBeNull()
    expect(bookLedger(out.state.risk, 'only').gasWei).toBeGreaterThan(0n)
  })

  it('halts the book once the burn reaches the stop', () => {
    // One receipt stands in for the accumulation: v1's real case was 945 reverts, and the
    // mechanism under test is that the charge reaches the session stop at all.
    const out = decide(withInflightSell(), revertedSell(T0 + 1, STOP_WEI))
    expect(out.state.risk.halts.has('drawdown:only'), 'gas that reaches the limit must halt the book').toBe(true)
  })

  it('moves no slot and no capital, because gas says nothing about the tokens', () => {
    const before = withInflightSell()
    const out = decide(before, revertedSell(T0 + 1, 49_028n))
    expect(out.state.risk.reserved).toBe(before.risk.reserved)
    expect(out.state.risk.deployedWei).toBe(before.risk.deployedWei)
  })
})

describe('the peak tracks net, so ordinary gas is not read as a drawdown', () => {
  it('does not treat a charge against a fresh peak as a breach of an older one', () => {
    /**
     * The trap this guards. If the peak were taken on booked P&L while the drawdown were taken
     * on net, then every wei of gas would read as a fall from a high-water mark that never
     * existed, and a profitable book would drift into its own stop on friction alone.
     */
    const s = emptyState(CFG, SW)
    const l = bookLedger(s.risk, 'only')
    l.realizedWei = STOP_WEI * 2n
    l.gasWei = STOP_WEI
    // The peak is the peak of NET, which is what a close would have set it to.
    l.peakWei = ledgerNetWei(l)
    expect(drawdownBreach(CFG, s.risk, 'only', s.switches.sizeWei), 'at its own high-water mark, nothing is down').toBeNull()
  })
})

describe('a reset clears the gas with everything else the stop measures', () => {
  const charged = (): State => {
    const s = decide(withInflightSell(), revertedSell(T0 + 1, STOP_WEI)).state
    s.risk.halts.set('stopped', { kind: 'stopped', book: null, reason: 'operator', at: T0 })
    return s
  }

  it('the operator reset zeroes gas, so the stop does not re-fire on the old burn', () => {
    const s = charged()
    expect(bookLedger(s.risk, 'only').gasWei).toBe(STOP_WEI)
    const out = decide(s, ev(T0 + 2, 'operator', { action: 'reset', why: 'operator cleared the stop' }))
    expect(bookLedger(out.state.risk, 'only').gasWei).toBe(0n)
    expect(out.state.risk.walletGasWei).toBe(0n)
    expect(drawdownBreach(CFG, out.state.risk, 'only', out.state.switches.sizeWei), 'a reset that leaves the gas has not reset').toBeNull()
  })

  it('a wallet drawdown is a bar, not a halt', () => {
    const s = charged()
    expect(s.risk.halts.has('wallet'), 'the wallet freeze is gone; a book stop is the halt').toBe(false)
    expect(walletDrawdownBreach(CFG, s.risk, s.switches.sizeWei), 'the bar still sees the bleed').not.toBeNull()
    const out = decide(s, ev(T0 + 2, 'operator', { action: 'reset', why: 'operator cleared the stop' }))
    expect(walletDrawdownBreach(CFG, out.state.risk, out.state.switches.sizeWei)).toBeNull()
  })

  it('the epoch reset does the same', () => {
    const out = decide(charged(), ev(T0 + 2, 'epoch-reset', {}))
    expect(bookLedger(out.state.risk, 'only').gasWei).toBe(0n)
    expect(out.state.risk.walletGasWei).toBe(0n)
    expect(out.state.risk.halts.has('wallet')).toBe(false)
  })

  it('a book stop is scoped, and a book reset leaves the wallet peak', () => {
    const stopped = decide(emptyState(CFG, SW), ev(T0, 'operator', { action: 'stop', why: 'park', book: 'only' })).state
    expect(stopped.risk.halts.get('stopped:only')?.book).toBe('only')
    expect(stopped.risk.halts.has('stopped')).toBe(false)
    const s = charged()
    const gas = s.risk.walletGasWei
    const peak = s.risk.walletPeakWei
    const out = decide(s, ev(T0 + 2, 'operator', { action: 'reset', why: 'this book only', book: 'only' }))
    expect(bookLedger(out.state.risk, 'only').gasWei).toBe(0n)
    expect(out.state.risk.walletGasWei).toBe(gas)
    expect(out.state.risk.walletPeakWei).toBe(peak)
  })
})

describe('bankroll and slots are optional', () => {
  const HEALTH = { logsHealthy: true, logsAgeMs: 0, overlayAgeMs: 0 }
  const SIZE = 5_000_000_000_000_000n

  it('a zero bankroll is not a cap, so leftover deployed capital cannot sit out a launch', () => {
    const s = emptyState({ ...CFG, risk: { ...CFG.risk, bankrollWei: '0' } }, SW)
    s.risk.deployedWei = 80_000_000_000_000_000n
    expect(canEnter(s, { token: TOKEN, book: 'only', sizeWei: SIZE }, HEALTH).ok).toBe(true)
  })

  it('a finite bankroll still refuses when deployed plus size would pass it', () => {
    const s = emptyState(CFG, SW)
    s.risk.deployedWei = 80_000_000_000_000_000n
    const r = canEnter(s, { token: TOKEN, book: 'only', sizeWei: SIZE }, HEALTH)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal.bucket).toBe('risk-bankroll')
  })

  it('a zero slot ceiling is not a cap, so leftover reserved cannot sit out a launch', () => {
    const s = emptyState({ ...CFG, risk: { ...CFG.risk, maxConcurrent: 0, bankrollWei: '0' } }, SW)
    s.risk.reserved = 99
    expect(canEnter(s, { token: TOKEN, book: 'only', sizeWei: SIZE }, HEALTH).ok).toBe(true)
  })

  it('a finite slot ceiling still refuses when reserved is full', () => {
    const s = emptyState(CFG, SW)
    s.risk.reserved = CFG.risk.maxConcurrent
    const r = canEnter(s, { token: TOKEN, book: 'only', sizeWei: SIZE }, HEALTH)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal.bucket).toBe('risk-capacity')
  })
})

/**
 * ONE NUMBER, THREE READERS.
 *
 * The point of `ledgerNetWei`/`walletNetWei` is that the stop, the alert and the report cannot
 * drift into three opinions about how close the wallet is to halting. They drifted anyway: the
 * per-book figure was moved to net in all three places and the WALLET-WIDE one was moved only in
 * `core/risk.ts`, so `buildReport` and `buildAlerts` kept reporting booked P&L. On a gas bleed the
 * `report` skill would have shown the wallet comfortably clear of a stop that was about to fire,
 * which is the same blindness this whole file exists to remove, one layer up.
 */
describe('the stop, the report and the alert agree how close the wallet is', () => {
  /** Peak set, then gas burned and nothing booked: drawdown that is ENTIRELY gas. */
  const bled = (gasWei: bigint): State => {
    const s = emptyState(CFG, SW)
    s.risk.walletPeakWei = 0n
    s.risk.walletGasWei = gasWei
    return { ...s, at: T0 }
  }

  it('the wallet bar measures the gas, and does not freeze entries', () => {
    const s = bled(STOP_WEI)
    expect(walletDrawdownBreach(CFG, s.risk, s.switches.sizeWei), 'gas alone must move the wallet bar').not.toBeNull()
    expect(s.risk.halts.has('wallet')).toBe(false)
    expect(canEnter(s, { token: TOKEN, book: 'only', sizeWei: 1_000_000_000_000_000n }, {
      logsHealthy: true, logsAgeMs: 0, overlayAgeMs: 0,
    }).ok, 'the bar is not a halt').toBe(true)
    const under = bled(STOP_WEI - 1n)
    expect(walletDrawdownBreach(CFG, under.risk, under.switches.sizeWei)).toBeNull()
  })

  it('the report shows the same drawdown the bar measures', () => {
    const half = STOP_WEI / 2n
    const r = buildReport(bled(half), new History(), null)
    expect(BigInt(Math.round(r.drawdownEth * 1e18)), 'the number a person reads is the number the bar measures').toBe(half)
  })

  it('the wallet alert fires on gas, so the warning is not later than the halt', () => {
    // Just past the crit fraction, where booked-P&L-only arithmetic would say zero.
    const deep = (STOP_WEI * BigInt(Math.round(LEVELS.drawdownCritFraction * 100))) / 100n
    const alerts = buildAlerts(bled(deep), new History())
    const a = alerts.find((x) => x.id === 'drawdown-wallet')
    expect(a, 'a wallet drawdown made entirely of gas must still raise the alert').toBeDefined()
    expect(a!.sev).toBe('crit')
  })

  it('says nothing when no gas has been burned, so the alert is not always on', () => {
    expect(buildAlerts(bled(0n), new History()).some((x) => x.id === 'drawdown-wallet')).toBe(false)
  })
})
