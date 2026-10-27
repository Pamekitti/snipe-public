/**
 * The pure decisions, tested without a chain, a clock or a socket.
 *
 * Every test here is a rule someone paid for. Where a case cites a date, that is the day the
 * behaviour was measured or the day its absence cost money.
 */
import { describe, expect, it } from 'vitest'
import { bookDigest, bookIds, routeBook } from '../core/book.js'
import { admits, templateKey } from '../core/entry.js'
import { adaptiveBar, barKey, coldest, pinTakeProfit } from '../core/takeprofit.js'
import { evaluateExit, exhausted } from '../core/exit.js'
import { venueVerdict, readSensor, pumpCheck, type VenueSums } from '../core/guard.js'
import { decide } from '../core/decide.js'
import { holdPreviouslyOpenStaleVenue, longestSettleMs, observe, openObservation, recordCurveLog, refreshSensors, simPolicy, venueReading } from '../core/observe.js'
import { bookLedger, CURVES_TRACKED, emptyState, haltedFor, POSITIONS_KEPT, type Outcome, type State } from '../core/state.js'
import { canonical, configDigest, fnv1a64, kernelId } from '../core/identity.js'
import { utcDay, drawdownBreach } from '../core/risk.js'
import { freshCurve, type CurveParams } from '../core/curve.js'
import { effectiveBookSizeWei, type BookSpec, type EntrySpec, type ExitSpec, type FrozenConfig, type GuardSpec, type TakeProfitSpec } from '../core/config.js'

/** The four policy tables every test book starts from, matching the shipped spec's defaults. */
const ENTRY: EntrySpec = { entryDelayMs: 2_000, entryFallbackLateMs: 600, maxEntryPriceMultiple: 4.5, buySlippageBps: 5_000 }
const EXIT: ExitSpec = {
  maxHoldMs: 45_000, hardStopMultiple: 0.5, deadCoinAfterMs: 20_000, deadCoinBelowMultiple: 1.03,
  graduationExitAt: 0.12, maxSellAttempts: 20, exitRetryDelayMs: 300, sellFinalMinQuoteOutWei: '1',
}
const TAKE_PROFIT: TakeProfitSpec = { otherwise: 1.75, adaptiveWindow: 20, adaptiveBars: [1.25, 1.36, 1.5, 1.75, 2.0, 2.5, 3.0] }
const GUARD: GuardSpec = { window: 20, recoveryWindow: 8, openAt: 1, shutAt: -1, settleMs: 52_000, freshMs: 10_800_000, pnlBar: 1.75, maxReadingAgeMs: 10_800_000 }

const BOOK = (over: Partial<BookSpec> = {}): BookSpec => ({
  id: 'main', minCreatorTaxBps: 0, maxCreatorTaxBps: 0, minExemptions: 3, templateLossBlockMs: 3_600_000,
  sizeWei: '5000000000000000', maxDrawdownWei: '15000000000000000',
  entry: ENTRY, exit: EXIT, takeProfit: TAKE_PROFIT, guard: GUARD, ...over,
})

const CFG = (books: BookSpec[]): FrozenConfig => ({
  books,
  risk: { drawdownStakes: 3 },
} as unknown as FrozenConfig)

describe('routing: one launch, at most one book', () => {
  const untaxed = BOOK({ id: 'untaxed', minCreatorTaxBps: 0, maxCreatorTaxBps: 0 })
  const taxed = BOOK({ id: 'taxed', minCreatorTaxBps: 100, maxCreatorTaxBps: 200 })

  it('routes an untaxed launch to the untaxed book and a taxed one to the taxed book', () => {
    const cfg = CFG([untaxed, taxed])
    expect((routeBook(1, cfg, '0xt', 0) as { value: BookSpec }).value.id).toBe('untaxed')
    expect((routeBook(1, cfg, '0xt', 150) as { value: BookSpec }).value.id).toBe('taxed')
  })

  it('treats both band bounds as inclusive, which is how untaxed-only is written', () => {
    // 0-0 is a legal one-value band and is the live book's actual policy since 2026-09-15.
    // A floor alone could not express it: a floor of 0 admits every tax from 0 to 200.
    const cfg = CFG([untaxed])
    expect(routeBook(1, cfg, '0xt', 0).ok).toBe(true)
    expect(routeBook(1, cfg, '0xt', 1).ok).toBe(false)
    const both = CFG([taxed])
    expect(routeBook(1, both, '0xt', 100).ok).toBe(true)
    expect(routeBook(1, both, '0xt', 200).ok).toBe(true)
    expect(routeBook(1, both, '0xt', 201).ok).toBe(false)
  })

  it('refuses a tax no band holds, naming every band so the operator can see the hole', () => {
    const r = routeBook(7, CFG([untaxed, taxed]), '0xt', 50)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.refusal.bucket).toBe('entry-no-book')
      expect(r.refusal.reason).toContain('untaxed 0-0')
      expect(r.refusal.reason).toContain('taxed 100-200')
    }
  })

  it('routes identically however the books are ordered in the config', () => {
    // A decision that depends on array order is not reproducible.
    const a = routeBook(1, CFG([untaxed, taxed]), '0xt', 150)
    const b = routeBook(1, CFG([taxed, untaxed]), '0xt', 150)
    expect(a.ok && b.ok && a.value.id === b.value.id).toBe(true)
  })

  it('lists book ids in byte order, never locale order', () => {
    expect(bookIds(CFG([taxed, untaxed]))).toEqual(['taxed', 'untaxed'])
  })

  it('changes the digest when any judged field changes, and not otherwise', () => {
    const base = bookDigest(untaxed)
    expect(bookDigest({ ...untaxed })).toBe(base)
    expect(bookDigest({ ...untaxed, minExemptions: 4 })).not.toBe(base)
    expect(bookDigest({ ...untaxed, maxCreatorTaxBps: 1 })).not.toBe(base)
    expect(bookDigest({ ...untaxed, templateLossBlockMs: 1 })).not.toBe(base)
  })
})

describe('the entry filter, in the order the funnel counts', () => {
  const facts = (over: Partial<Parameters<typeof admits>[2]> = {}) =>
    ({ token: '0xt', creatorTaxBps: 0, devBuyWei: 5n, exemptions: 4, deployer: '0xd', ...over })

  it('admits a launch inside the band with enough exempt wallets', () => {
    const r = admits(1000, BOOK(), facts(), null)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.book).toBe('main')
  })

  it('refuses both sides of the band into ONE bucket', () => {
    // The operator question is "how many did the band refuse", not which side they fell on.
    const lo = admits(1, BOOK({ minCreatorTaxBps: 100, maxCreatorTaxBps: 200 }), facts({ creatorTaxBps: 50 }), null)
    const hi = admits(1, BOOK({ minCreatorTaxBps: 100, maxCreatorTaxBps: 200 }), facts({ creatorTaxBps: 500 }), null)
    expect(lo.ok).toBe(false); expect(hi.ok).toBe(false)
    if (!lo.ok && !hi.ok) expect(lo.refusal.bucket).toBe(hi.refusal.bucket)
  })

  it('distinguishes "no exempt wallets" from "we never learned"', () => {
    // Both decline. Only one is a fault on our side, and a projection that renders them
    // alike hides a broken feed as a quiet market.
    const zero = admits(1, BOOK(), facts({ exemptions: 0 }), null)
    const unknown = admits(1, BOOK(), facts({ exemptions: null }), null)
    expect(zero.ok).toBe(false); expect(unknown.ok).toBe(false)
    if (!zero.ok && !unknown.ok) {
      expect(zero.refusal.bucket).toBe('entry-exempt')
      expect(unknown.refusal.bucket).toBe('entry-exempt')
      expect(unknown.refusal.reason).toContain('never arrived')
      expect(zero.refusal.reason).not.toContain('never arrived')
    }
  })

  it('blocks a template for exactly the configured window, then admits it again', () => {
    const book = BOOK({ templateLossBlockMs: 3_600_000 })
    const lostAt = 1_000_000
    expect(admits(lostAt + 1, book, facts(), lostAt).ok).toBe(false)
    expect(admits(lostAt + 3_599_999, book, facts(), lostAt).ok).toBe(false)
    // at exactly the window it is no longer blocked: the comparison is strict
    expect(admits(lostAt + 3_600_000, book, facts(), lostAt).ok).toBe(true)
  })

  it('keys a template on tax, dev buy and exempts, never on the deployer', () => {
    // A farm uses a fresh wallet per launch (four different deployers on the 09-06 burst),
    // so a key including the deployer would block nothing at all.
    expect(templateKey(0, 5n, 4)).toBe(templateKey(0, 5n, 4))
    expect(templateKey(0, 5n, 4)).not.toBe(templateKey(0, 6n, 4))
    expect(templateKey(0, 5n, null)).not.toBe(templateKey(0, 5n, 0))
  })

  it('checks the band before the exempt floor, so the funnel denominators mean something', () => {
    // Fails both. The bucket must be the EARLIER check.
    const r = admits(1, BOOK({ minCreatorTaxBps: 100 }), facts({ creatorTaxBps: 0, exemptions: 0 }), null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal.bucket).toBe('entry-tax')
  })
})

describe('the adaptive take-profit bar', () => {
  const spec: TakeProfitSpec = { otherwise: 1.75, adaptiveWindow: 3, adaptiveBars: [1.25, 1.5, 2.0] }
  const row = (o: Record<string, number>) => o

  it('picks the bar that earned most across the window', () => {
    const rows = [row({ '1.25': 0.1, '1.50': 0.3, '2.00': 0.0 }), row({ '1.25': 0.1, '1.50': 0.3, '2.00': 0.0 }), row({ '1.25': 0.1, '1.50': 0.3, '2.00': 0.0 })]
    const r = adaptiveBar(rows, spec)
    expect(r.ready).toBe(true)
    expect(r.multiple).toBe(1.5)
  })

  it('clips outliers before scoring, so one moonshot cannot choose the rung', () => {
    const robust = { ...spec, adaptiveLossCap: 0.5, adaptiveProfitCap: 0.5 }
    const rows = [
      row({ '1.25': 0.3, '1.50': 9, '2.00': 0 }),
      row({ '1.25': 0.3, '1.50': -0.5, '2.00': 0 }),
      row({ '1.25': 0.3, '1.50': -0.5, '2.00': 0 }),
    ]
    expect(adaptiveBar(rows, spec).multiple).toBe(1.5)
    expect(adaptiveBar(rows, robust).multiple).toBe(1.25)
  })

  it('weights newest outcomes using the configured launch half-life', () => {
    const weighted = { ...spec, adaptiveHalfLife: 1 }
    const rows = [
      row({ '1.25': 1, '1.50': 0, '2.00': 0 }),
      row({ '1.25': 0, '1.50': 0.6, '2.00': 0 }),
      row({ '1.25': 0, '1.50': 0.6, '2.00': 0 }),
    ]
    expect(adaptiveBar(rows, spec).multiple).toBe(1.5)
    expect(adaptiveBar(rows, weighted).multiple).toBe(1.25)
    expect(adaptiveBar(rows, weighted).why).toContain('weighted h1')
  })

  it('breaks ties toward the LOWEST bar, which is the conservative direction', () => {
    const rows = [row({ '1.25': 0.2, '1.50': 0.2, '2.00': 0.2 }), row({ '1.25': 0.2, '1.50': 0.2, '2.00': 0.2 }), row({ '1.25': 0.2, '1.50': 0.2, '2.00': 0.2 })]
    expect(adaptiveBar(rows, spec).multiple).toBe(1.25)
  })

  it('takes the fallback, NOT ready, on a short window', () => {
    // Unknown means cold. Falling through to the configured default would put every launch
    // in the first N after a restart on the hottest setting with no evidence at all.
    const r = adaptiveBar([row({ '1.25': 9 })], spec)
    expect(r).toMatchObject({ multiple: 1.75, ready: false })
    expect(r.why).toContain('1 of 3')
  })

  it('takes the fallback when rows carry none of the traded bars', () => {
    const rows = [row({ '3.00': 1 }), row({ '3.00': 1 }), row({ '3.00': 1 })]
    expect(adaptiveBar(rows, spec).ready).toBe(false)
  })

  it('keys a bar so 1.5 and 1.50 cannot become two different keys', () => {
    expect(barKey(1.5)).toBe(barKey(1.50))
    expect(barKey(1.5)).toBe('1.50')
  })

  it('pins the coldest rung for every way of not knowing, each with its reason', () => {
    const cold = coldest(spec)
    expect(pinTakeProfit(null, 0, 1000, spec)).toMatchObject({ multiple: cold, ready: false, why: 'no bars reading' })
    expect(pinTakeProfit({ multiple: 2, ready: false, why: 'short' }, 0, 1000, spec).multiple).toBe(cold)
    expect(pinTakeProfit({ multiple: 2, ready: true, why: 'ok' }, 5000, 1000, spec)).toMatchObject({ multiple: cold, ready: false })
    expect(pinTakeProfit({ multiple: 2, ready: true, why: 'ok' }, null, 1000, spec).multiple).toBe(cold)
  })

  it('passes a fresh, ready reading straight through', () => {
    expect(pinTakeProfit({ multiple: 2, ready: true, why: 'ok' }, 500, 1000, spec).multiple).toBe(2)
  })
})

describe('the exit rules, in the order that decides the ledger', () => {
  const rules = { ...EXIT, takeProfitMultiple: 1.75 }
  const pos = (over: Partial<Parameters<typeof evaluateExit>[0]> = {}) =>
    ({ openedAt: 0, entryMarkWei: 1000n, peakMarkWei: 1000n, rules, attempts: 0, inflightIntentId: null, ...over })

  it('takes graduation before anything else, because a graduated curve refuses every sell', () => {
    // Waiting for graduation to HAPPEN is waiting until it is too late: it cost a whole
    // position that had peaked at 3.65x in the first shadow run.
    expect(evaluateExit(pos(), 5000n, 1_000_000, true)).toBe('graduating')
  })

  it('takes profit before the hold clock when both fire in the same tick', () => {
    // A reordering would silently turn months of `tp` rows into `time` rows.
    expect(evaluateExit(pos(), 1750n, 50_000, false)).toBe('tp')
  })

  it('fires the hold clock and the hard stop at their exact thresholds', () => {
    // A peak above the dead-coin floor, so this isolates the clock: a flat coin at 44,999ms
    // is genuinely `dead` first, which is the rule working, not the clock failing.
    const alive = pos({ peakMarkWei: 1500n })
    expect(evaluateExit(alive, 1000n, 44_999, false)).toBe(null)
    expect(evaluateExit(alive, 1000n, 45_000, false)).toBe('time')
    expect(evaluateExit(alive, 500n, 1, false)).toBe('stop')
    expect(evaluateExit(alive, 501n, 1, false)).toBe(null)
  })

  it('reaches the dead-coin bail before the hold clock on a flat coin', () => {
    // Both are true at 45s on a coin that never moved. `time` is checked first, so the row
    // books as `time`; the bail exists to get out 25 seconds EARLIER than that.
    expect(evaluateExit(pos(), 1000n, 20_000, false)).toBe('dead')
    expect(evaluateExit(pos(), 1000n, 45_000, false)).toBe('time')
  })

  it('bails a dead coin on its PEAK, not its current mark', () => {
    // A coin that spiked and came back is a different animal; the hard stop handles it.
    expect(evaluateExit(pos({ peakMarkWei: 1020n }), 1020n, 20_000, false)).toBe('dead')
    expect(evaluateExit(pos({ peakMarkWei: 1040n }), 1000n, 20_000, false)).toBe(null)
  })

  it('treats deadCoinAfterMs of 0 as OFF, not as "immediately"', () => {
    // `now - openedAt >= 0` is true on the very first tick, so a plain zero would sell every
    // position instantly instead of disabling the rule. The guard is load-bearing.
    const off = { ...rules, deadCoinAfterMs: 0 }
    expect(evaluateExit(pos({ rules: off }), 1000n, 1, false)).toBe(null)
  })

  it('decides nothing while a sell is already in flight', () => {
    expect(evaluateExit(pos({ inflightIntentId: 'sell-1' }), 1n, 10_000_000, true)).toBe(null)
  })

  it('never takes profit or stops out on an unpriced position', () => {
    /**
     * Every price rule is a multiple of `entryMarkWei`, so at zero the take-profit bar is
     * zero and ANY mark clears it: the bot would dump a bag it had never managed to price,
     * at a 1 wei bound, on the first tick it saw. A recovered bag whose curve was not
     * tracked is exactly how a zero gets here.
     */
    const unpriced = pos({ entryMarkWei: 0n, peakMarkWei: 0n })
    expect(evaluateExit(unpriced, 5_000n, 1_000, false)).toBe(null)
    expect(evaluateExit(unpriced, 0n, 1_000, false)).toBe(null)
    // the clock still works, because it needs no mark to mean something
    expect(evaluateExit(unpriced, 5_000n, 45_000, false)).toBe('time')
  })

  it('reports exhaustion only at the cap', () => {
    expect(exhausted(pos({ attempts: 19 }))).toBe(false)
    expect(exhausted(pos({ attempts: 20 }))).toBe(true)
  })
})

describe('the guard: two windows, one band, hold stale verdicts', () => {
  const spec: GuardSpec = { window: 15, recoveryWindow: 8, openAt: 1, shutAt: -1.5, settleMs: 52_000, freshMs: 10_800_000, pnlBar: 1.75, maxReadingAgeMs: 10_800_000 }
  /** A complete, fresh pair of windows. `main` pauses, `fresh` reopens. */
  const sums = (main: number, fresh: number, over: Partial<VenueSums> = {}): VenueSums =>
    ({ mainSum: main, mainN: 15, freshSum: fresh, freshN: 8, reachMs: 60_000, ...over })

  it('pauses on the main window and reopens on the fresh one', () => {
    // The asymmetry IS the selected rule: a book is paused by a run of bad launches across
    // the main 15 and released by a handful of good recent ones, so recovery does not wait
    // for old losses to age out. The unit is STAKES, so 0 means those launches would have
    // broken even between them.
    expect(venueVerdict(spec, sums(0, 0), true).open).toBe(true)
    expect(venueVerdict(spec, sums(0, 0), false).open).toBe(false)
    expect(venueVerdict(spec, sums(-9, 1.5), false).open).toBe(true)
    expect(venueVerdict(spec, sums(-2, 9), true).open).toBe(false)
  })

  it('reads the fresh sum to reopen and ignores the main one, and vice versa', () => {
    // Crossed on purpose. A main window still deep in the red must not hold back a recovery
    // the fresh 8 have earned, and a fresh 8 having a good run must not keep a book trading
    // once the main 15 have fallen through the brake.
    expect(venueVerdict(spec, sums(-14, 2), false).open).toBe(true)
    expect(venueVerdict(spec, sums(-2, 5), true).open).toBe(false)
  })

  it('moves on neither boundary, because both comparisons are strict', () => {
    // Exactly at the pause line an open book stays open; exactly at the reopen line a paused
    // book stays paused. A sum that lands on the line is not evidence, and the direction of
    // the tie-break is the conservative one in both cases.
    expect(venueVerdict(spec, sums(-1.5, 0), true).open).toBe(true)
    expect(venueVerdict(spec, sums(0, 1), false).open).toBe(false)
  })

  it('fails closed on a window too short to be the measured one', () => {
    // Until 2026-09-17 a short window HELD the current state, so a book four launches into a
    // restart kept trading on no evidence. A sum over 3 launches and a sum over 15 are
    // different questions and only one of them was fitted.
    expect(venueVerdict(spec, sums(9, 9, { mainN: 3, freshN: 3 }), false).open).toBe(false)
    expect(venueVerdict(spec, sums(9, 9, { mainN: 3, freshN: 3 }), true).open).toBe(false)
    expect(venueVerdict(spec, sums(9, 9, { mainN: 3, freshN: 3 }), true).fresh).toBe(false)
  })

  it('holds the previous verdict when a complete window is too old', () => {
    // An old score cannot pause an open book or reopen a shut one.
    const stale = { reachMs: 4 * 3_600_000 }
    expect(venueVerdict(spec, sums(-9, 9, stale), true).open).toBe(true)
    expect(venueVerdict(spec, sums(9, 9, stale), false).open).toBe(false)
    expect(venueVerdict(spec, sums(9, 9, stale), true).fresh).toBe(false)
  })

  it('separates a dead sensor from a quiet one from a stale one', () => {
    // The old dashboard rendered all three as a dash; an operator could not tell a dead
    // watcher from a quiet market.
    const unreadable = readSensor(1000, '0xt', 'gate', null, 100)
    const norows = readSensor(1000, '0xt', 'gate', { value: 1, at: 1000, source: 'gate.db', n: 0 }, 100)
    const stale = readSensor(1000, '0xt', 'gate', { value: 1, at: 500, source: 'gate.db', n: 5 }, 100)
    const fresh = readSensor(1000, '0xt', 'gate', { value: 1, at: 950, source: 'gate.db', n: 5 }, 100)
    expect(unreadable.ok).toBe(false); expect(norows.ok).toBe(false); expect(stale.ok).toBe(false)
    if (!unreadable.ok) expect(unreadable.refusal.bucket).toBe('sensor-unreadable')
    if (!norows.ok) expect(norows.refusal.bucket).toBe('sensor-no-rows')
    if (!stale.ok) expect(stale.refusal.bucket).toBe('sensor-stale')
    expect(fresh.ok).toBe(true)
    if (fresh.ok) expect(fresh.value.ageMs).toBe(50)
  })
})

describe('stream liveness is measured from delivery, not from a status change', () => {
  /**
   * The defect this pins, found on the live tape on 2026-09-16.
   *
   * `risk-logs-stale` refuses an entry when the log stream is older than 3,000ms, and the
   * clock behind it only moved when a `logs-status` event CHANGED. A healthy subscriber emits
   * one of those at connect and then stays quiet, so three seconds into every run the fold
   * refused every entry while the stream was delivering thirteen batches a second. The
   * dashboard reported it as "the log stream last reported 2105s ago" and it was the stream
   * that was fine and the measurement that was not.
   */
  const cfg = { books: [BOOK()], risk: { maxLogsStalenessMs: 3_000 }, clock: { periodMs: 250 } } as unknown as FrozenConfig
  const base = () => emptyState(cfg, { sizeWei: 1n, mode: 'live', at: 0, by: 'test' })
  const batch = (seq: number, at: number) => ({ seq, at, run: 'r', kind: 'logs' as const, logs: [], source: 'ws' as const, lo: 1, hi: 2 })

  it('a delivered batch refreshes the clock the entry gate reads', () => {
    let s = base()
    s = decide(s, { seq: 1, at: 1_000, run: 'r', kind: 'logs-status', healthy: true, mode: 'ws', reason: 'connected' } as never).state
    s = decide(s, batch(2, 3_600_000) as never).state
    expect(s.sensors.logsHealthy!.at).toBe(3_600_000)
    expect(s.sensors.logsHealthy!.value).toBe(true)
    expect(s.sensors.logsHealthy!.source).toBe('logs')
  })

  it('a batch does not overrule a subscriber that declared itself unhealthy', () => {
    // Delivery says the pipe is open. Only the subscriber can say it has fallen back to
    // polling, and `risk-logs-unhealthy` refuses on the value whatever the timestamp says.
    let s = base()
    s = decide(s, { seq: 1, at: 1_000, run: 'r', kind: 'logs-status', healthy: false, mode: 'poll', reason: 'socket lost' } as never).state
    s = decide(s, batch(2, 2_000) as never).state
    expect(s.sensors.logsHealthy!.value).toBe(false)
  })
})

describe('the market indicator: the fold replays what it watched', () => {
  /**
   * WHAT THIS SENSOR IS. Not a counter. Every launch `admits` would have allowed this book to
   * buy is replayed through `core/sim.ts` against its own chain logs, under the book's own
   * exit rules, at all seven candidate bars. The venue guard sums one of those columns over
   * the trailing window; the take-profit selector takes the argmax across them. One replay,
   * two readings.
   *
   * The 1.21x touch rate this file used to test was `obs.touch`, the SECONDARY safety check.
   * It never paused the live wallet and it is deleted rather than ported.
   *
   * WHY THE FOLD DOES IT. The reading used to come from a separate python process writing a
   * separate database, so it could go stale with nothing noticing and no replay could
   * reproduce it. On 2026-09-16 the market pane drew a tape frozen since 06:58 exactly like a
   * live one. A reading the fold derives is a reading a replay reproduces.
   */
  // The policy lives on the BOOK now, so the fixture is one book carrying a whole one.
  const spec: GuardSpec = GUARD
  const cfg = { books: [BOOK()], risk: { drawdownStakes: 3 }, clock: { periodMs: 250 } } as unknown as FrozenConfig
  const base = (): State => ({
    ...emptyState(cfg, { sizeWei: 5_000_000_000_000_000n, mode: 'live', at: 0, by: 'test' }),
    at: 1_000_000,
  })

  /** `n` settled launches, each worth `each` stakes at the indicator's bar. */
  const fill = (s: State, each: number, n: number, book = 'main'): void => {
    for (let i = 0; i < n; i++) {
      const o: Outcome = {
        token: `0x${i}`, book, at: s.at,
        perBar: { '1.25': each, '1.36': each, '1.50': each, '1.75': each, '2.00': each, '2.50': each, '3.00': each },
        stakes: each, peak: 1 + Math.max(0, each),
      }
      s.cohort.push(o)
    }
  }

  it('freezes the ruler at watch, so a later regime cannot re-pick the column', () => {
    /**
     * THE COUPLING IS ONE-WAY ONLY BECAUSE OF THIS. The selector reads the argmax across the
     * same rows the guard sums, so if the guard re-read today's argmax the ruler would move
     * with the thing it measures. Each watch records the selector's answer at that moment,
     * and settle uses that frozen column however far the argmax has since travelled.
     *
     * THE COLD ANSWER IS THE COLDEST BAR, NOT `pnlBar`, since 2026-09-17. A watch pins through
     * the same `rungNow` a real entry pins through, so warmup freezes 1.25 exactly as an entry
     * in that same minute would. It froze 1.75 before, which meant the first full guard window
     * after every restart — the one deciding whether the book opens at all — was summed at a
     * column no trade of that hour could have used.
     */
    let s = base()
    // Cold: the selector has no window, so the launch pins the coldest rung a trade would.
    openObservation(s, {
      token: '0xa', curve: '0xcold', book: 'main',
      launchBlock: 100, deployer: '0xDEAD', launchTx: '0xTX', creatorTaxBps: 0,
    })
    expect(s.observations.get('0xcold')!.pinnedBar).toBe(coldest(TAKE_PROFIT))
    expect(coldest(TAKE_PROFIT)).not.toBe(spec.pnlBar)

    // Warm, and the argmax is somewhere else entirely. Published through `refreshSensors`,
    // because the stored sensor is what an entry reads and therefore what a watch must read.
    for (let i = 0; i < spec.window + 20; i++) {
      s.cohort.push({
        token: `0x${i}`, book: 'main', at: s.at,
        perBar: { '1.25': 0.01, '1.36': 0.02, '1.50': 0.9, '1.75': 0.03, '2.00': 0.04, '2.50': 0.05, '3.00': 0.06 },
        stakes: 0.03, peak: 1.6,
      })
    }
    s = refreshSensors(s)
    openObservation(s, {
      token: '0xb', curve: '0xhot', book: 'main',
      launchBlock: 100, deployer: '0xDEAD', launchTx: '0xTY', creatorTaxBps: 0,
    })
    expect(s.observations.get('0xhot')!.pinnedBar).toBe(1.5)
    // and the cold one did NOT move when the regime did
    expect(s.observations.get('0xcold')!.pinnedBar).toBe(coldest(TAKE_PROFIT))
  })

  it('pins the coldest rung when the selector is warm but its reading has gone stale', () => {
    /**
     * The other half of the same asymmetry. An entry reads the STORED reading and drops to the
     * coldest rung once it is older than `maxReadingAgeMs`; a watch used to recompute the argmax
     * on the spot and so was never stale. On a quiet venue that let the guard sum a hot column
     * while every real entry in the same minute took 1.25.
     */
    let s = base()
    for (let i = 0; i < TAKE_PROFIT.adaptiveWindow; i++) {
      s.cohort.push({
        token: `0x${i}`, book: 'main', at: s.at,
        perBar: { '1.25': 0.01, '1.36': 0.02, '1.50': 0.9, '1.75': 0.03, '2.00': 0.04, '2.50': 0.05, '3.00': 0.06 },
        stakes: 0.03, peak: 1.6,
      })
    }
    s = refreshSensors(s)
    const stale = { ...s, at: s.at + spec.maxReadingAgeMs + 1 }
    openObservation(stale, {
      token: '0xc', curve: '0xstale', book: 'main',
      launchBlock: 100, deployer: '0xDEAD', launchTx: '0xTZ', creatorTaxBps: 0,
    })
    expect(stale.observations.get('0xstale')!.pinnedBar).toBe(coldest(TAKE_PROFIT))
  })

  it('replays a config recorded before the fresh window existed as one window', () => {
    /**
     * THE TAPE CAN HAND OVER A SHAPE THE TYPE FORBIDS. `config-applied` replaces
     * `state.config` wholesale from the recorded row, with no revalidation, so every hour
     * recorded before `recovery_window` existed restores a guard without one. Falling back
     * to the main window reproduces what those hours actually ran; reading `undefined` as
     * zero would reopen on an empty slice, which is a sum with no denominator.
     */
    const { recoveryWindow: _dropped, ...old } = GUARD
    const s: State = {
      ...base(),
      config: { ...cfg, books: [{ ...BOOK(), guard: old as GuardSpec }] } as FrozenConfig,
    }
    fill(s, +0.5, 20)
    const r = venueReading(s, 'main')!
    expect(r.recoveryWindow).toBe(20)          // the whole window, not 0 and not undefined
    expect(r.recentSum).toBeCloseTo(r.sumStakes, 10)
    expect(r.open).toBe(true)
  })

  it('sums both windows over the same rows, and names no single ruler', () => {
    const s = base()
    fill(s, -0.2, 20)
    const r = venueReading(s, 'main')!
    expect(r.sumStakes).toBeCloseTo(-4, 10)
    expect(r.window).toBe(20)
    // The fresh slice is the head of the same rows, so it is the same per-launch number over
    // `recoveryWindow` of them rather than a second population.
    expect(r.recoveryWindow).toBe(8)
    expect(r.recentSum).toBeCloseTo(-1.6, 10)
    expect(r.bar).toBe('adaptive')  // every row carries the bar it pinned at watch
    expect(r.fresh).toBe(true)
    expect(r.open).toBe(false)      // -4 stakes is below the -1 that pauses
  })

  it('has no opinion at all until something has settled', () => {
    // Not "shut". An empty cohort is a sensor with nothing to say, and the two call for
    // different operator actions.
    expect(venueReading(base(), 'main')).toBe(null)
  })

  it('scores each book on its own launches, because a book is a policy', () => {
    /**
     * THE HOLE THIS CLOSES, and the reason `bot/` refuses to start with two books configured.
     * Its `gateReading` read the whole cohort with no book filter and wrote one verdict, so
     * two policies trading different coins shared one opinion about the market. A book that
     * measures somebody else's coins is not a policy, it is a label.
     */
    const two = { books: [BOOK(), BOOK({ id: 'other', minCreatorTaxBps: 50, maxCreatorTaxBps: 200 })] } as unknown as FrozenConfig
    const s: State = {
      ...emptyState(two, { sizeWei: 5_000_000_000_000_000n, mode: 'live', at: 0, by: 'test' }),
      at: 1_000_000,
    }
    fill(s, -0.5, 20, 'main')
    fill(s, +0.5, 20, 'other')
    expect(venueReading(s, 'main')!.sumStakes).toBeCloseTo(-10, 10)
    expect(venueReading(s, 'other')!.sumStakes).toBeCloseTo(10, 10)
    expect(venueReading(s, 'main')!.open).toBe(false)
    expect(venueReading(s, 'other')!.open).toBe(true)
  })

  it('keeps the rare book\'s window reachable, however lopsided the routing', () => {
    /**
     * A FIXED RING WAS SAFE WITH ONE BOOK AND QUIETLY WRONG WITH TWO. The taxed band sees a
     * small share of launches, so a shared 200-row ring evicts its rows before it ever holds
     * 20, and its guard reads `only 8 of 20 scored` forever while looking healthy. A sensor
     * that can never reach its own window is a sensor that never fires.
     */
    const two = { ...cfg, books: [BOOK(), BOOK({ id: 'rare', minCreatorTaxBps: 50, maxCreatorTaxBps: 200 })] } as FrozenConfig
    const s: State = {
      ...emptyState(two, { sizeWei: 1n, mode: 'live', at: 0, by: 'test' }),
      at: 1_000_000,
    }
    // 19 busy-book launches for every rare one, which is roughly the live split, run until
    // the rare book has the 20 its own window needs.
    for (let i = 0; i < 20; i++) {
      fill(s, -0.5, 19, 'main')
      fill(s, +0.5, 1, 'rare')
    }
    const r = venueReading(s, 'rare')
    expect(r?.window).toBe(20)
    expect(r?.fresh).toBe(true)
  })

  it('carries the hysteresis: the same sum reads differently by what it already was', () => {
    // 0 stakes is above the -1 that pauses and below the +1 that reopens, so it is exactly the
    // sum the band exists to make ambiguous. The answer depends on the previous reading and on
    // nothing else.
    const wasShut = base()
    fill(wasShut, 0, 20)
    const shut: State = { ...wasShut, sensors: { ...wasShut.sensors, venue: new Map([['main', { value: { open: false, sumStakes: -9, window: 20, recentSum: -9, recoveryWindow: 8, bar: 'adaptive', fresh: true, why: 'was paused' }, at: wasShut.at, source: 'fold' as const, n: 20 }]]) } }
    expect(venueReading(shut, 'main')!.open).toBe(false)

    const wasOpen = base()
    fill(wasOpen, 0, 20)
    expect(venueReading(wasOpen, 'main')!.open).toBe(true)   // no prior reading seeds open
  })

  it('a first stale window cannot invent a previous open verdict', () => {
    const s = base()
    fill(s, -5, 20)
    const old: State = { ...s, at: s.at + spec.freshMs + 1 }
    const r = venueReading(old, 'main')!
    expect(r.fresh).toBe(false)
    expect(r.open).toBe(false)
    expect(r.sumStakes).toBeCloseTo(-100, 10)   // the number is still reported
  })

  it('skips a launch whose replay dropped the bar rather than counting it as zero', () => {
    // Missing data is not a flat outcome. Counting it as zero would pull every sum toward the
    // middle by exactly the number of launches the replay could not score.
    const s = base()
    fill(s, -0.5, 19)
    s.cohort.push({ token: '0xmissing', book: 'main', at: s.at, perBar: {}, stakes: null, peak: 1 })
    const r = venueReading(s, 'main')!
    expect(r.window).toBe(19)
    expect(r.fresh).toBe(false)   // 19 of 20 is not the measured window
    expect(r.open).toBe(false)    // and an incomplete window fails closed
  })

  it('picks the take-profit rung from the same rows, one column over', () => {
    // The indicator sums each row's OWN frozen column and the selector takes the argmax
    // across columns. Both read the identical vector, so they cannot disagree about what
    // happened; only about what to do with it.
    const s = base()
    for (let i = 0; i < 20; i++) {
      s.cohort.push({
        token: `0x${i}`, book: 'main', at: s.at,
        perBar: { '1.25': 0.01, '1.36': 0.02, '1.50': 0.9, '1.75': 0.03, '2.00': 0.04, '2.50': 0.05, '3.00': 0.06 },
        stakes: 0.03, peak: 1.6,
      })
    }
    const after = refreshSensors(s)
    expect(after.sensors.bars.get('main')!.value.multiple).toBe(1.5)
    expect(after.sensors.bars.get('main')!.value.ready).toBe(true)
    expect(after.sensors.venue.get('main')!.value.bar).toBe('adaptive')
    expect(after.sensors.venue.get('main')!.value.sumStakes).toBeCloseTo(0.6, 10)
  })

  it('stamps both readings as the fold\'s own, with n', () => {
    const s = base(); fill(s, 0.1, 20)
    const after = refreshSensors(s)
    expect(after.sensors.venue.get('main')!.source).toBe('fold')
    expect(after.sensors.venue.get('main')!.n).toBe(20)
    expect(after.sensors.venue.get('main')!.at).toBe(s.at)
    expect(after.sensors.bars.get('main')!.source).toBe('fold')
  })

  it('raises this book\'s venue halt, and clears it, and touches no other book', () => {
    /**
     * UNTIL 2026-09-16 NOTHING IN v2 RAISED THIS. `HaltKind` declared `venue` and no code path
     * ever set it, so the guard was a number on a page rather than a control. A sensor that
     * cannot stop the wallet is not a guard.
     *
     * The key is `venue:<book>` because `haltedFor` treats a null book as wallet-wide: one
     * policy pausing must not stop the other, which is the whole argument for two books.
     */
    const s = base()
    fill(s, -0.5, 20, 'main')
    fill(s, +0.5, 20, 'other')
    const two = { ...s, config: { ...cfg, books: [BOOK(), BOOK({ id: 'other', minCreatorTaxBps: 50, maxCreatorTaxBps: 200 })] } as FrozenConfig }
    const after = refreshSensors(two)
    expect(after.risk.halts.get('venue:main')?.kind).toBe('venue')
    expect(after.risk.halts.get('venue:main')?.book).toBe('main')
    expect(after.risk.halts.has('venue:other')).toBe(false)
    expect(haltedFor(after.risk, 'other')).toBe(null)

    // The market recovers on `main`: 20 launches at +0.5 is +10 stakes, above the +1 to reopen.
    const back = { ...after, cohort: after.cohort }
    fill(back, +0.5, 20, 'main')
    expect(refreshSensors(back).risk.halts.has('venue:main')).toBe(false)
  })

  it('treats cash drawdown as the other shut trigger: a still-good main window does not keep it open', () => {
    // 0.05 × 20 = +1, above the -1 that would pause an open book. The last 8 are only +0.4,
    // not above the +1 that reopens. Cash drawdown must use that reopen path, or a cash crash
    // the replay has not yet scored as a main-window hole would never pause.
    const s = base()
    fill(s, +0.05, 20)
    s.risk.halts.set('drawdown:main', { kind: 'drawdown', book: 'main', reason: 'down from peak', at: s.at })
    const l = bookLedger(s.risk, 'main')
    l.peakWei = 15_000_000_000_000_000n
    const after = refreshSensors(s)
    expect(venueReading(after, 'main')!.open).toBe(false)
    expect(after.risk.halts.has('drawdown:main')).toBe(true)
    expect(haltedFor(after.risk, 'main')?.kind).toBe('drawdown')
    expect(l.peakWei).toBe(15_000_000_000_000_000n)
  })

  it('reopens cash drawdown on the same 8-fresh +1 that reopens the venue, and zeros the peak', () => {
    const s = base()
    fill(s, +0.05, 12)
    s.risk.halts.set('drawdown:main', { kind: 'drawdown', book: 'main', reason: 'down from peak', at: s.at })
    const l = bookLedger(s.risk, 'main')
    l.peakWei = 15_000_000_000_000_000n
    l.realizedWei = 0n
    fill(s, +0.2, 8)
    const after = refreshSensors(s)
    expect(after.risk.halts.has('drawdown:main')).toBe(false)
    expect(after.risk.halts.has('venue:main')).toBe(false)
    expect(l.peakWei).toBe(0n)
    expect(l.realizedWei).toBe(0n)
    expect(drawdownBreach(after.config, after.risk, 'main', after.switches.sizeWei)).toBeNull()
  })

  it('does not reopen on seven good rows still sitting in an 8-window that is not above +1', () => {
    const s = base()
    fill(s, 0, 13)
    s.risk.halts.set('drawdown:main', { kind: 'drawdown', book: 'main', reason: 'down from peak', at: s.at })
    fill(s, +0.14, 7)
    expect(refreshSensors(s).risk.halts.has('drawdown:main')).toBe(true)
  })

  it('reopens even while a bag on that book is still open', () => {
    // One guard, one reopen. Flat-to-resume was the extra rule that made cash drawdown
    // harder to leave than a venue pause.
    const s = base()
    fill(s, +0.05, 12)
    s.risk.halts.set('drawdown:main', { kind: 'drawdown', book: 'main', reason: 'down from peak', at: s.at })
    s.positions.set('open', {
      id: 'open', token: '0xt', curve: '0xc', book: 'main', bookDigest: 'd',
      templateKey: '0:0:5', openedAt: 1, spendWei: 1n, entryMarkWei: 1n,
      rules: {
        takeProfitMultiple: 1.75, maxHoldMs: 45_000, hardStopMultiple: 0.5,
        deadCoinAfterMs: 20_000, deadCoinBelowMultiple: 1.03, graduationExitAt: 0.12,
        maxSellAttempts: 20, exitRetryDelayMs: 300, sellFinalMinQuoteOutWei: '1',
      } as never,
      tokensHeld: 1n, peakMarkWei: 1n, proceedsWei: 0n,
      closedAt: null, abandonedAt: null, abandonReason: null, exitReason: null,
      attempts: 0, inflightIntentId: null, lastBuyHash: null, lastSellHash: null, awaitingSellReceipt: null,
      closed: false, venue: 'curve', grad: null, filled: true,
    } as never)
    fill(s, +0.2, 8)
    expect(refreshSensors(s).risk.halts.has('drawdown:main')).toBe(false)
  })

  it('does not reopen cash drawdown over a broken halt', () => {
    const s = base()
    fill(s, +0.5, 20)
    s.risk.halts.set('drawdown:main', { kind: 'drawdown', book: 'main', reason: 'down from peak', at: s.at })
    s.risk.halts.set('broken', { kind: 'broken', book: null, reason: 'mispricing', at: s.at })
    expect(refreshSensors(s).risk.halts.has('drawdown:main')).toBe(true)
  })

  it('does not reopen cash drawdown over an operator stop', () => {
    const s = base()
    fill(s, +0.5, 20)
    s.risk.halts.set('drawdown:main', { kind: 'drawdown', book: 'main', reason: 'down from peak', at: s.at })
    s.risk.halts.set('stopped', { kind: 'stopped', book: null, reason: 'stop all', at: s.at })
    expect(refreshSensors(s).risk.halts.has('drawdown:main')).toBe(true)
  })

  it('a stale window keeps the book open or shut as it was', () => {
    const s = base()
    fill(s, +0.5, 20)
    const open = refreshSensors(s)
    expect(open.risk.halts.has('venue:main')).toBe(false)
    const staleOpen = refreshSensors({ ...open, at: open.at + spec.freshMs + 1 })
    expect(staleOpen.sensors.venue.get('main')?.value.fresh).toBe(false)
    expect(staleOpen.risk.halts.has('venue:main')).toBe(false)

    const paused = base()
    fill(paused, -0.5, 20)
    const shut = refreshSensors(paused)
    expect(shut.risk.halts.has('venue:main')).toBe(true)
    const staleShut = refreshSensors({ ...shut, at: shut.at + spec.freshMs + 1 })
    expect(staleShut.sensors.venue.get('main')?.value.fresh).toBe(false)
    expect(staleShut.risk.halts.has('venue:main')).toBe(true)
  })

  it('migrates only a stale halt that arose from an open verdict', () => {
    const s = base()
    fill(s, +0.5, 20)
    const open = refreshSensors(s)
    const old = { ...open, at: open.at + spec.freshMs + 1 }
    const previous = old.sensors.venue.get('main')!
    const reason = 'the window reaches back 181min, over the 180min the spec calls fresh; fail closed'
    const venue = new Map(old.sensors.venue)
    venue.set('main', { ...previous, value: { ...previous.value, open: false, fresh: false, why: reason } })
    old.risk.halts.set('venue:main', { kind: 'venue', book: 'main', reason, at: old.at })
    const snapshot = { ...old, sensors: { ...old.sensors, venue } }

    const migrated = holdPreviouslyOpenStaleVenue(snapshot, 'main')
    expect(migrated?.sensors.venue.get('main')?.value.open).toBe(true)
    expect(migrated?.sensors.venue.get('main')?.value.fresh).toBe(false)
    expect(migrated?.risk.halts.has('venue:main')).toBe(false)

    snapshot.risk.halts.set('drawdown:main', { kind: 'drawdown', book: 'main', reason: 'cash stop', at: old.at })
    expect(holdPreviouslyOpenStaleVenue(snapshot, 'main')).toBeNull()
  })

  it('holds a warmup book shut until its window is full', () => {
    // The case the August rule got wrong: four launches into a restart there is no evidence
    // the venue is good, and holding the book open was reading "we cannot see" as "allowed".
    const s = base()
    fill(s, +5, 4)
    const warm = refreshSensors(s)
    expect(warm.sensors.venue.get('main')!.value.open).toBe(false)
    expect(warm.sensors.venue.get('main')!.value.fresh).toBe(false)
    expect(warm.risk.halts.has('venue:main')).toBe(true)

    // and releases it the moment the window is complete and good
    fill(s, +0.5, 16)
    expect(refreshSensors(s).risk.halts.has('venue:main')).toBe(false)
  })

  it('settles only once the replay window has closed, never earlier', () => {
    /**
     * THE WALK BUYS AT BLOCK 20 AND RUNS 500 BLOCKS PAST THAT, so a launch settled before 52s
     * is scored on a path whose tail never arrived. The error is not noise, it is
     * one-directional: the missing tail is where the winners are, so the indicator would read
     * the market as worse than it is exactly when it is good.
     */
    const s = base()
    s.observations.set('0xc', {
      token: '0xa', curve: '0xc', book: 'main', startedAt: s.at - spec.settleMs + 1,
      launchBlock: 100, deployer: '0xdead', launchTx: '0xtx', creatorTaxBps: 0, events: [],
    })
    expect(observe(s).observations.size).toBe(1)
    const late = observe({ ...s, at: s.at + 1 })
    expect(late.observations.size).toBe(0)
  })

  it('drops a launch the replay cannot enter rather than scoring it flat', () => {
    // `path` returns null when the curve has no sellable supply left by our entry block. That
    // is missing data. Recording it as a zero would pull every sum toward the middle by
    // exactly the number of graduations.
    const s = base()
    s.observations.set('0xc', {
      token: '0xa', curve: '0xc', book: 'main', startedAt: s.at - spec.settleMs,
      launchBlock: 100, deployer: '0xdead', launchTx: '0xtx', creatorTaxBps: 0,
      // One buy big enough to graduate the curve before our entry block arrives.
      events: [{ b: 101, s: 'B', r: '0xdead', q: '0x' + (10n ** 19n).toString(16).padStart(64, '0'), t: '0x0', f: '0x0', x: '0x0' }],
    })
    const done = observe(s)
    expect(done.observations.size).toBe(0)
    expect(done.cohort.size).toBe(0)
  })

  it('ignores a log arriving after the replay horizon', () => {
    // The walk stops at the horizon anyway. A curve that stays busy for an hour would
    // otherwise hold thousands of events nothing will ever read.
    const s = base()
    s.observations.set('0xc', {
      token: '0xa', curve: '0xc', book: 'main', startedAt: s.at,
      launchBlock: 100, deployer: '0xdead', launchTx: '0xtx', creatorTaxBps: 0, events: [],
    })
    recordCurveLog(s, '0xc', { b: 500, s: 'B', q: '0x1' })
    recordCurveLog(s, '0xc', { b: 621, s: 'B', q: '0x1' })
    expect(s.observations.get('0xc')!.events).toHaveLength(1)
  })
})

describe('a book is a complete policy, not a filter with shared rules behind it', () => {
  /**
   * THE HOLE THIS CLOSES. Until 2026-09-16 `entry`, `exit`, `take_profit` and `guard` were
   * top-level tables and every book shared them, so two policies trading different coins had
   * one arm delay, one clock, one hard stop, one ladder and one market guard between them.
   * Changing a key for the control arm changed it for the book holding the money. That is the
   * same defect as the shared venue sensor, one layer down.
   */
  it('gives each book its own exit stack, its own ladder and its own guard', () => {
    const fast = BOOK({ id: 'fast', exit: { ...EXIT, maxHoldMs: 20_000, hardStopMultiple: 0.7 } })
    const slow = BOOK({
      id: 'slow', minCreatorTaxBps: 50, maxCreatorTaxBps: 200,
      exit: { ...EXIT, maxHoldMs: 90_000 },
      guard: { ...GUARD, shutAt: -3, window: 40 },
      takeProfit: { ...TAKE_PROFIT, otherwise: 2.5 },
    })
    expect(fast.exit.maxHoldMs).not.toBe(slow.exit.maxHoldMs)
    expect(fast.guard.shutAt).not.toBe(slow.guard.shutAt)
    // And the digest separates them, so a closed row says which policy admitted it rather than
    // which policy happens to be loaded when someone reads the row back.
    expect(bookDigest(fast)).not.toBe(bookDigest(slow))
    expect(bookDigest(fast)).toBe(bookDigest(BOOK({ id: 'fast', exit: { ...EXIT, maxHoldMs: 20_000, hardStopMultiple: 0.7 } })))
  })

  it('moves the digest when any part of the policy moves, not just the band', () => {
    // A digest that covered only the filter would let the exit stack change under a book with
    // every stored row still claiming the old digest, which is the exact failure the pinning
    // exists to prevent, one level up.
    const base = BOOK()
    const moved = [
      BOOK({ sizeWei: '1' }),
      BOOK({ maxDrawdownWei: '1' }),
      BOOK({ entry: { ...ENTRY, entryDelayMs: 1 } }),
      BOOK({ exit: { ...EXIT, graduationExitAt: 0.2 } }),
      BOOK({ takeProfit: { ...TAKE_PROFIT, adaptiveBars: [1.25, 2.0] } }),
      BOOK({ guard: { ...GUARD, freshMs: 60_000 } }),
    ]
    for (const m of moved) expect(bookDigest(m), JSON.stringify(m).slice(0, 80)).not.toBe(bookDigest(base))
  })

  it('replays each book\'s launches under that book\'s own exit stack', () => {
    /**
     * The market indicator is the simulator, so a book with a different clock is a book whose
     * launches are worth a different number. If the replay read one shared exit stack, the
     * control arm would be scored on the funded book's rules and could not answer the one
     * question it exists to answer.
     */
    const fast = BOOK({ id: 'fast', exit: { ...EXIT, maxHoldMs: 20_000 } })
    const slow = BOOK({ id: 'slow', minCreatorTaxBps: 50, maxCreatorTaxBps: 200, exit: { ...EXIT, maxHoldMs: 44_000 } })
    expect(simPolicy(fast).holdBlk).toBe(200)
    expect(simPolicy(slow).holdBlk).toBe(440)
    expect(simPolicy(fast).deadAfterBlk).toBe(200)
  })

  it('waits the LONGEST settle window before dropping a launch with no metadata', () => {
    // The sweep runs before the read tells us the creator tax, so it does not yet know which
    // book the launch belongs to. Taking the maximum means no book's launch is dropped early;
    // taking the minimum would silently starve whichever book watches longest.
    const cfgTwo = {
      books: [BOOK({ guard: { ...GUARD, settleMs: 52_000 } }), BOOK({ id: 'slow', minCreatorTaxBps: 50, maxCreatorTaxBps: 200, guard: { ...GUARD, settleMs: 300_000 } })],
    } as unknown as FrozenConfig
    const s = emptyState(cfgTwo, { sizeWei: 1n, mode: 'live', at: 0, by: 'test' })
    expect(longestSettleMs(s)).toBe(300_000)
  })
})

describe('the pump guard', () => {
  const params: CurveParams = {
    phantomQuote: 10n ** 18n, reservedTokens: 0n, launchSupply: 10n ** 27n,
    feeBps: 100n, creatorTaxBps: 0n, snipeTaxStartBps: 0n, snipeTaxSeconds: 60n, launchedAt: 0n,
  }

  it('admits a fresh curve, where fresh and live are the same book', () => {
    const r = pumpCheck(1, '0xt', params, freshCurve(params), 10n ** 16n, 100n, 4.5)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.multiple).toBeCloseTo(1, 2)
  })

  it('refuses a curve already pumped past the ceiling', () => {
    // Heavily bought: the live curve returns far fewer tokens for the same stake.
    const pumped = { trackedQuote: 50n * 10n ** 18n, trackedTokens: 10n ** 26n, quoteFeeBalance: 0n, creatorTaxBalance: 0n, graduated: false }
    const r = pumpCheck(1, '0xt', params, pumped, 10n ** 16n, 100n, 4.5)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal.bucket).toBe('guard-pumped')
  })

  it('refuses rather than allows when the simulation cannot run', () => {
    // A simulation we could not run is not evidence that the price is fine.
    const dead = { trackedQuote: 0n, trackedTokens: 0n, quoteFeeBalance: 0n, creatorTaxBalance: 0n, graduated: true }
    const r = pumpCheck(1, '0xt', params, dead, 10n ** 16n, 100n, 4.5)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal.bucket).toBe('guard-sim-failed')
  })
})

describe('identity is behaviour, not file contents', () => {
  it('canonicalises key order, so a reordered object is the same policy', () => {
    // The old configId turned on JSON.stringify's insertion order and changed without the
    // config changing.
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }))
  })

  it('renders bigints as decimal strings rather than throwing', () => {
    expect(canonical({ wei: 10n ** 18n })).toBe('{"wei":"1000000000000000000"}')
  })

  it('changes the kernel id when a decision changes, and not when only wording does', () => {
    const a = kernelId('cfg', ['buy 0xa', 'refuse 0xb'])
    expect(kernelId('cfg', ['buy 0xa', 'refuse 0xb'])).toBe(a)
    expect(kernelId('cfg', ['buy 0xa', 'refuse 0xc'])).not.toBe(a)
    // the same decisions under a different config are a different decider
    expect(kernelId('cfg2', ['buy 0xa', 'refuse 0xb'])).not.toBe(a)
  })

  it('digests a config by its values, so a reformat resets nothing', () => {
    expect(configDigest({ a: 1, b: [1, 2] })).toBe(configDigest({ b: [1, 2], a: 1 }))
    expect(configDigest({ a: 1 })).not.toBe(configDigest({ a: 2 }))
  })

  it('hashes deterministically and identically for the same input', () => {
    expect(fnv1a64('abc')).toBe(fnv1a64('abc'))
    expect(fnv1a64('abc')).not.toBe(fnv1a64('abd'))
  })
})

describe('the UTC day', () => {
  it('is exactly 86.4e6 ms, because unix time has no leap seconds', () => {
    expect(utcDay(0)).toBe(0)
    expect(utcDay(86_399_999)).toBe(0)
    expect(utcDay(86_400_000)).toBe(1)
  })
})

describe('genesis seeds are folded state, not invented logs', () => {
  const cfg = { books: [BOOK()], risk: { maxLogsStalenessMs: 3_000 }, clock: { periodMs: 250 } } as unknown as FrozenConfig
  const base = () => emptyState(cfg, { sizeWei: 1n, mode: 'live', at: 0, by: 'test' })

  it('a ledger seed sets the book and the wallet from the same numbers', () => {
    const out = decide(base(), {
      seq: 1, at: 1, run: 'g', kind: 'seed', what: 'ledger',
      rows: [{ book: 'main', realizedWei: '1000', peakWei: '2000' }],
    })
    expect(bookLedger(out.state.risk, 'main').realizedWei).toBe(1000n)
    expect(bookLedger(out.state.risk, 'main').peakWei).toBe(2000n)
    expect(out.state.risk.walletRealizedWei).toBe(1000n)
    expect(out.state.risk.walletPeakWei).toBe(2000n)
  })

  it('an outcomes seed fills the venue so a restart is not blind', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      token: `0x${i.toString(16).padStart(40, '0')}`, book: 'main', at: 1_000_000,
      perBar: { '1.75': -0.2 }, stakes: -0.2, peak: 1.1,
    }))
    const out = decide(base(), { seq: 1, at: 1_000_000, run: 'g', kind: 'seed', what: 'outcomes', rows })
    const v = out.state.sensors.venue.get('main')
    expect(v?.value.window).toBe(20)
    expect(v?.value.sumStakes).toBeCloseTo(-4)
    expect(v?.value.fresh).toBe(true)
    expect(v?.value.open).toBe(false)
    expect(haltedFor(out.state.risk, 'main')?.kind).toBe('venue')
  })
})

describe('the switches a .env edit moves', () => {
  /**
   * WHAT THESE PIN. Since the switches file is watched, `TRADE_SIZE_ETH` reaches the fold
   * without a restart, and a restart is the thing the runbook forbids while positions are
   * open. That makes the fold, not `main.ts`, the last place a stake can be checked: the type's
   * own comment has always said the size is "bounded by spec.risk.maxTradeSizeWei at apply
   * time", and until now the bound was applied at boot and nowhere else.
   */
  const cfg = {
    books: [BOOK(), BOOK({ id: 'other', minCreatorTaxBps: 50, maxCreatorTaxBps: 200 })],
    risk: { maxTradeSizeWei: '5000000000000000', drawdownStakes: 2 },
    clock: { periodMs: 250 },
  } as unknown as FrozenConfig
  const base = () => emptyState(cfg, { sizeWei: 1_000_000_000_000_000n, mode: 'live', at: 0, by: 'boot' })
  const set = (value: unknown) => ({ seq: 1, at: 10, run: 'r', kind: 'switch-set' as const, name: 'x', value, by: 'file' })

  it('a leftover file-halt row on the tape changes nothing', () => {
    const out = decide(base(), set({ kind: 'halt', on: true }) as never)
    expect(out.state.switches).toEqual(base().switches)
    expect(out.refusals).toHaveLength(0)
  })

  it('a stake under the ceiling is taken as written', () => {
    const out = decide(base(), set({ kind: 'size', wei: '2000000000000000' }) as never)
    expect(out.state.switches.sizeWei).toBe(2_000_000_000_000_000n)
    expect(out.refusals).toHaveLength(0)
  })

  it('sets and clears one book without moving the other book or the global default', () => {
    const setBook = decide(base(), set({ kind: 'book-size', book: 'main', wei: '2000000000000000' }) as never)
    expect(setBook.state.switches.sizeWei).toBe(1_000_000_000_000_000n)
    expect(setBook.state.switches.bookSizes?.get('main')?.sizeWei).toBe(2_000_000_000_000_000n)
    expect(effectiveBookSizeWei(cfg.books[0]!, setBook.state.switches)).toBe(2_000_000_000_000_000n)
    expect(effectiveBookSizeWei(cfg.books[1]!, setBook.state.switches)).toBe(1_000_000_000_000_000n)

    const cleared = decide(setBook.state, { ...set({ kind: 'book-size', book: 'main', wei: null }), seq: 2 } as never)
    expect(cleared.state.switches.bookSizes?.has('main')).toBe(false)
    expect(effectiveBookSizeWei(cfg.books[0]!, cleared.state.switches)).toBe(1_000_000_000_000_000n)
  })

  it('keeps a book override when the global default changes', () => {
    const book = decide(base(), set({ kind: 'book-size', book: 'main', wei: '2000000000000000' }) as never).state
    const global = decide(book, { ...set({ kind: 'size', wei: '3000000000000000' }), seq: 2 } as never).state
    expect(effectiveBookSizeWei(cfg.books[0]!, global.switches)).toBe(2_000_000_000_000_000n)
    expect(effectiveBookSizeWei(cfg.books[1]!, global.switches)).toBe(3_000_000_000_000_000n)
  })

  it('refuses an unsafe book-size event without partially applying it', () => {
    const tiny = decide(base(), set({ kind: 'book-size', book: 'main', wei: '400000000000000' }) as never)
    expect(tiny.state.switches.bookSizes?.size ?? 0).toBe(0)
    expect(tiny.refusals[0]?.bucket).toBe('switch-refused')

    const unknown = decide(base(), set({ kind: 'book-size', book: 'ghost', wei: '1000000000000000' }) as never)
    expect(unknown.state.switches.bookSizes?.size ?? 0).toBe(0)
    expect(unknown.refusals[0]?.subject).toBe('ghost')
  })

  it('lowers an override when config lowers the ceiling and drops removed books', () => {
    let state = decide(base(), set({ kind: 'book-size', book: 'main', wei: '4000000000000000' }) as never).state
    state = decide(state, { ...set({ kind: 'book-size', book: 'other', wei: '2000000000000000' }), seq: 2 } as never).state
    const next = { ...cfg, books: [BOOK({ sizeWei: '1500000000000000' })] }
    const out = decide(state, {
      seq: 3, at: 30, run: 'r', kind: 'config-applied', specVersion: 1,
      digest: 'next', values: next, changed: ['books'], source: 'file',
    } as never)
    expect(out.state.switches.bookSizes?.get('main')?.sizeWei).toBe(1_500_000_000_000_000n)
    expect(out.state.switches.bookSizes?.has('other')).toBe(false)
    expect(out.refusals.some((r) => r.bucket === 'switch-refused')).toBe(true)
  })

  it('a stake over the ceiling is clamped and refused out loud, not silently honoured', () => {
    // The typo this exists for: 0.05 where 0.005 was meant, saved into a watched file, with
    // nobody at the keyboard to notice that the bot agreed to it.
    const out = decide(base(), set({ kind: 'size', wei: '50000000000000000' }) as never)
    expect(out.state.switches.sizeWei).toBe(5_000_000_000_000_000n)
    expect(out.refusals[0]?.bucket).toBe('switch-refused')
    expect(out.refusals[0]?.reason).toContain('5000000000000000')
  })

  it('a negative stake is zero, which refuses every entry rather than inverting one', () => {
    const out = decide(base(), set({ kind: 'size', wei: '-1' }) as never)
    expect(out.state.switches.sizeWei).toBe(0n)
  })
})

describe('the wallet balance is the chain, and only the chain', () => {
  /**
   * WHAT THIS EXISTS FOR. The dashboard rendered cumulative booked P&L under the heading
   * "TOTAL REAL WALLET / chain, not rebased", and the machine report shipped the same number
   * as `walletEth`. Both were a label attached to a different quantity: P&L does not move when
   * gas is burnt, when ETH is deposited, or while a position is still held as tokens.
   */
  const cfg = { books: [BOOK()], risk: {}, clock: { periodMs: 250 } } as unknown as FrozenConfig
  const base = () => emptyState(cfg, { sizeWei: 1n, mode: 'live', at: 0, by: 'test' })
  const read = (result: unknown) => ({
    seq: 1, at: 5_000, run: 'r', kind: 'chain-read' as const,
    request: { kind: 'balance' as const, args: ['0xabc'] }, result, viaKey: true, tries: 1, latencyMs: 0,
  })

  it('stores what the chain answered, with the time it was answered', () => {
    const out = decide(base(), read('123456789012345678') as never)
    expect(out.state.walletBalance?.value).toBe(123_456_789_012_345_678n)
    expect(out.state.walletBalance?.at).toBe(5_000)
    expect(out.state.walletBalance?.source).toBe('chain')
    // n is null: a balance is one answer, not a sample. A 0 here would mean "looked, found none".
    expect(out.state.walletBalance?.n).toBeNull()
  })

  it('changes no decision: no intent, no refusal, nothing but the number', () => {
    // Deliberate. A balance moves with gas and with money sent in or out, none of which is the
    // bot's edge, and the drawdown rule keeps reading booked P&L. This also keeps the kernel id
    // untouched, because the decision stream is unchanged.
    const out = decide(base(), read('1') as never)
    expect(out.intents).toHaveLength(0)
    expect(out.refusals).toHaveLength(0)
    expect(out.state.risk.walletRealizedWei).toBe(0n)
  })

  it('a failed read leaves the last reading in place to age, rather than blinking to unavailable', () => {
    let s = decide(base(), read('900') as never).state
    s = decide(s, { ...read(null), seq: 2, at: 9_000 } as never).state
    expect(s.walletBalance?.value).toBe(900n)
    expect(s.walletBalance?.at).toBe(5_000)
  })

  it('refuses a result that is not a wei string instead of coercing one', () => {
    const s = decide(base(), read(1.5) as never).state
    expect(s.walletBalance).toBeNull()
  })

  it('refuses a ReadOutcome object ingested as the result, which is how the live card went stale', () => {
    // main.ts used to pass world.read's return value straight through. After the read started
    // reporting cost, that value was `{ result, tries, latencyMs, viaKey, error }`, not wei,
    // and every boot/hourly balance was dropped while the card kept the last good string.
    const s = decide(base(), read({
      result: '123456789012345678', tries: 1, latencyMs: 40, viaKey: true, error: null,
    }) as never).state
    expect(s.walletBalance).toBeNull()
  })
})

describe('a process that runs for weeks forgets the right rows', () => {
  /**
   * `positions` and `curves` were the two maps nothing ever removed from. Every launch this bot
   * had ever watched stayed in `curves`, and `markPositions` walked every position ever opened
   * on every clock tick and every feed block. The migration plan named `positions` under "still
   * not fixed"; `curves` was the same defect one line down.
   *
   * The floor is what makes eviction safe, and it is what these check: an open position whose
   * curve was dropped would mark against a curve that is not there, `markPositions` would skip
   * it, and the bot would hold a bag it had stopped pricing.
   */
  const cfg = { books: [BOOK()], risk: {}, clock: { periodMs: 250 } } as unknown as FrozenConfig
  const tick = (seq: number) => ({ seq, at: 1_000 + seq, run: 'r', kind: 'clock' as const })

  const pos = (i: number, closed: boolean) => ({
    id: `p${i}`, token: `0xt${i}`, curve: `0xc${i}`, book: 'main', bookDigest: 'd',
    templateKey: '0:0:5', openedAt: 1, spendWei: 1n, entryMarkWei: 1n,
    rules: {
      takeProfitMultiple: 1.75, maxHoldMs: 45_000, hardStopMultiple: 0.5,
      deadCoinAfterMs: 20_000, deadCoinBelowMultiple: 1.03, graduationExitAt: 0.12,
      maxSellAttempts: 20, exitRetryDelayMs: 300, sellFinalMinQuoteOutWei: '1',
    } as never,
    tokensHeld: closed ? 0n : 1n, peakMarkWei: 1n, proceedsWei: 0n,
    closedAt: closed ? 2 : null, abandonedAt: null, abandonReason: null,
    attempts: 0, inflightIntentId: null, closed, filled: true,
  })

  it('evicts closed positions once the map is over its ceiling, and never an open one', () => {
    const s = emptyState(cfg, { sizeWei: 1n, mode: 'live', at: 0, by: 't' })
    for (let i = 0; i < POSITIONS_KEPT + 500; i++) s.positions.set(`p${i}`, pos(i, true) as never)
    // One open position, and it is the OLDEST, which is exactly what age-based eviction takes.
    s.positions.set('open', pos(99_999, false) as never)

    const out = decide(s, tick(1) as never)
    expect(out.state.positions.size).toBeLessThanOrEqual(POSITIONS_KEPT)
    expect(out.state.positions.has('open')).toBe(true)
  })

  it('keeps every curve that something still needs, however old it is', () => {
    const params: CurveParams = {
      phantomQuote: 10n ** 18n, reservedTokens: 0n, launchSupply: 10n ** 27n,
      feeBps: 100n, creatorTaxBps: 0n, snipeTaxStartBps: 0n, snipeTaxSeconds: 60n, launchedAt: 0n,
    }
    const tracked = () => ({
      params, confirmed: freshCurve(params), working: freshCurve(params),
      pending: new Map(), confirmedThrough: 0, degraded: false, rebasedAt: 0,
    })
    const s = emptyState(cfg, { sizeWei: 1n, mode: 'live', at: 0, by: 't' })
    // The curve an open position is marking against, inserted first so age would evict it first.
    s.curves.set('0xheld', tracked() as never)
    s.positions.set('open', { ...pos(1, false), curve: '0xheld' } as never)
    for (let i = 0; i < CURVES_TRACKED + 500; i++) s.curves.set(`0xc${i}`, tracked() as never)

    const out = decide(s, tick(1) as never)
    expect(out.state.curves.size).toBeLessThanOrEqual(CURVES_TRACKED)
    expect(out.state.curves.has('0xheld')).toBe(true)
  })

  it('forgets nothing while everything is under the ceiling', () => {
    const s = emptyState(cfg, { sizeWei: 1n, mode: 'live', at: 0, by: 't' })
    for (let i = 0; i < 10; i++) s.positions.set(`p${i}`, pos(i, true) as never)
    expect(decide(s, tick(1) as never).state.positions.size).toBe(10)
  })
})
