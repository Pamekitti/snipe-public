/**
 * The take profit is a schedule over the venue now, and this file exists to stop the two
 * ways that can go wrong from going wrong quietly.
 *
 * FAILURE ONE, the fallback direction. Every way of not knowing the regime -- no gate
 * reading, a stale one, a window too short to be the trailing-20, a cached reading that
 * went old -- must take the COLDEST rung. Falling through to the default is the shape the
 * code wants to be written in, and it is wrong in exactly the direction that costs money:
 * it puts every launch in the first 20 after a gate restart on the hottest setting on no
 * evidence at all. The research script shipped that bug first and it affected 20 of 214
 * launches in one window before it was caught.
 *
 * FAILURE TWO, the coupling direction. This deliberately adds gate -> take profit. It must
 * never reintroduce take profit -> gate, which is the measurement contamination
 * test/gatebar.test.ts was written for: the gate's bar is a fixed yardstick at 1.21 and
 * moving it with the exit policy makes the venue's own history uncomparable. The two
 * directions are separate and only one of them is allowed.
 *
 * The rungs themselves are pinned here on purpose. The two COLD rungs (1.25/1.36 at cuts
 * 25/35) were read off a bucket table over 498 replayed launches, not searched, and the
 * paired gap of 1.40 over 1.25 runs -$25.23 cold / +$15.66 warm / +$66.56 hot.
 *
 * The cuts collapsed to ONE at 30 and the hot rung went to 2.50 on 2026-08-19: total ETH is
 * monotone in the take profit across two disjoint 24h windows (587 launches), so the hot
 * band was leaving money on a bar set too low. See STRATEGY.takeProfit for why we stopped
 * at 2.00 rather than removing the bar, which scored higher still and is a pure tail bet.
 * Change a number here and neither measurement describes what is running.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { STRATEGY } from '../src/config.js'
import { evaluate, newPosition } from '../src/strategy/exit.js'
import { coldestTakeProfit, takeProfitFor, takeProfitForRate } from '../src/strategy/takeprofit.js'

const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
/**
 * Source with comments stripped. The assertions below are about what the code READS, and
 * this file is heavily commented about exactly the identifiers it forbids -- matching the
 * raw text makes every one of these tests fail on its own explanation.
 */
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const W = STRATEGY.gate.window
/** a healthy reading of `rate`, so each test varies one thing */
const ok = (rate: number) => ({ rate, n: W, ageMs: 1_000 })

/**
 * A two-rung policy fixture, kept even though the live schedule matches it again.
 *
 * It exists because the fallback DIRECTION -- unknown means COLD -- is a safety property of
 * the function, not of whatever config happens to ship. Between 2026-08-27 and the restore
 * the live schedule was a single flat bar, which made every fallback assertion against
 * STRATEGY vacuous: a broken `takeProfitFor` that always returned the hot rung passed all
 * of them. Testing against a fixture where cold and hot differ keeps those assertions
 * meaningful whatever config does next, and the shipped values are pinned separately below.
 */
const TWO_RUNG = {
  schedule: [{ below: 30, multiple: 1.25 }],
  otherwise: 2.50,
  maxRateAgeMs: STRATEGY.takeProfit.maxRateAgeMs,
}

describe('the schedule is where the measurement put it', () => {
  it('is a FLAT bar: no rungs, 1.75 for every launch', () => {
    // EMPTIED 2026-08-28. The two-rung schedule was restored on 08-27 because it owned the
    // only positive live record (795 trades, +$161.87) and because the cold rung's loss was
    // confounded: rungs are assigned BY the gate rate, so 1.25 only ever fired in cold
    // regimes. That confound is now resolved. Replaying every closed live trade against
    // gatewatch's independent 45s peak applies each bar to the SAME 267 taxed trades, and
    // flat 2.50 nets $370.55 against 1.25's $133.59 with one MORE positive day (7/10 vs
    // 6/10). Day-block bootstrap on the difference: +$236.96, 90% CI [+$42, +$467].
    //
    // Pinned deliberately, and this is the ONE place the shipped numbers are written down:
    // the property tests below derive from config, so changing a bar means editing
    // config.ts and this line, never chasing literals through the suite.
    expect(STRATEGY.takeProfit.schedule).toEqual([])
    expect(STRATEGY.takeProfit.otherwise).toBe(1.75)
  })

  it('with no rungs the gate rate routes nothing: every rate, and every way of not knowing, takes the flat bar', () => {
    // The point of emptying the schedule is that the sensor stops steering the exit. This
    // is the assertion that says so: no reading, a stale reading, a cold one and a hot one
    // all land on the same bar, so a gate that freezes or starves cannot move our exits.
    const flat = STRATEGY.takeProfit.otherwise
    expect(coldestTakeProfit()).toBe(flat)
    for (const rate of [0, 20, 29.999, 30, 50, 100]) expect(takeProfitForRate(rate)).toBe(flat)
    expect(takeProfitFor(null, W).multiple).toBe(flat)
    expect(takeProfitFor(ok(0), W).multiple).toBe(flat)
    expect(takeProfitFor(ok(80), W).multiple).toBe(flat)
  })

  it('the cut splits the rate line, and cold is the bar an unknown rate gets', () => {
    // The SHAPE of a one-cut schedule, asserted on the fixture so it keeps its meaning now
    // that the shipped schedule is empty: below the cut takes the rung, at or above takes
    // `otherwise`, and anything unknown takes the cold end. This is what would have to hold
    // again the day a rung comes back.
    const cut = TWO_RUNG.schedule[0]!
    const hot = TWO_RUNG.otherwise
    expect(cut.multiple).toBeLessThan(hot)
    expect(coldestTakeProfit(TWO_RUNG)).toBe(cut.multiple)
    // half-open from below: a rate sitting exactly on the cut takes the WARMER side
    for (const rate of [0, 20, cut.below - 0.001]) expect(takeProfitForRate(rate, TWO_RUNG)).toBe(cut.multiple)
    for (const rate of [cut.below, 50, 100]) expect(takeProfitForRate(rate, TWO_RUNG)).toBe(hot)
    // and every way of not knowing lands on the cold rung, never on the hot one
    expect(takeProfitFor(null, W, TWO_RUNG).multiple).toBe(cut.multiple)
    expect(takeProfitFor(ok(80), W, TWO_RUNG).multiple).toBe(hot)
  })

  it('is ordered coldest first, which is what every fallback depends on', () => {
    // asserted on the fixture too, so it stays meaningful if the shipped schedule is ever
    // emptied again (an empty schedule makes this vacuous)
    for (const p of [STRATEGY.takeProfit, TWO_RUNG]) {
      const cuts = p.schedule.map((r) => r.below)
      expect([...cuts].sort((a, b) => a - b)).toEqual(cuts)
      const mults = p.schedule.map((r) => r.multiple)
      expect([...mults].sort((a, b) => a - b)).toEqual(mults)
      if (mults.length) expect(p.otherwise).toBeGreaterThan(mults[mults.length - 1]!)
    }
    expect(coldestTakeProfit(TWO_RUNG)).toBe(1.25)
  })
})

describe('picking a rung from a known rate', () => {
  it('takes the rung the bucket table says', () => {
    expect(takeProfitForRate(0, TWO_RUNG)).toBe(1.25)
    expect(takeProfitForRate(20, TWO_RUNG)).toBe(1.25)
    expect(takeProfitForRate(29.999, TWO_RUNG)).toBe(1.25)
    expect(takeProfitForRate(50, TWO_RUNG)).toBe(2.50)
    expect(takeProfitForRate(100, TWO_RUNG)).toBe(2.50)
  })

  it('puts a rate sitting exactly on a cut on the warmer side', () => {
    // `rate < below`, matching tpwhy.py (archive/purged-sims-20260827.tar.gz) term for term. Arbitrary, but it has
    // the SAME arbitrary choice as the script or the live book and the study disagree on
    // every launch that lands on the cut exactly, which at window 20 is a fifth of them.
    expect(takeProfitForRate(29.999, TWO_RUNG)).toBe(1.25)
    expect(takeProfitForRate(30, TWO_RUNG)).toBe(2.50)
  })
})

describe('every way of not knowing takes the coldest rung', () => {
  it('no reading at all', () => {
    expect(takeProfitFor(null, W, TWO_RUNG).multiple).toBe(1.25)
  })

  it('a reading with no rate', () => {
    expect(takeProfitFor({ rate: null, n: W, ageMs: 0 }, W, TWO_RUNG).multiple).toBe(1.25)
  })

  it('a gate the watcher stopped heartbeating for', () => {
    // the rate is hot AND present; only `stale` says not to trust it. If this ever returns
    // the hot rung the bot is running its hottest setting off a frozen number, which is the
    // 2026-08-18 failure with a new coat of paint.
    expect(takeProfitFor({ ...ok(80), stale: true }, W, TWO_RUNG).multiple).toBe(1.25)
  })

  it('a window too short to be the trailing-20', () => {
    expect(takeProfitFor({ rate: 80, n: W - 1, ageMs: 0 }, W, TWO_RUNG).multiple).toBe(1.25)
    expect(takeProfitFor({ rate: 80, n: 3, ageMs: 0 }, W, TWO_RUNG).multiple).toBe(1.25)
    expect(takeProfitFor({ rate: 80, n: W, ageMs: 0 }, W, TWO_RUNG).multiple).toBe(2.50)
  })

  it('a cached reading that went old', () => {
    const max = TWO_RUNG.maxRateAgeMs
    expect(takeProfitFor({ rate: 80, n: W, ageMs: max }, W, TWO_RUNG).multiple).toBe(2.50)
    expect(takeProfitFor({ rate: 80, n: W, ageMs: max + 1 }, W, TWO_RUNG).multiple).toBe(1.25)
  })

  it('a clock that went backwards', () => {
    // a negative age is not "very fresh", it is a clock we cannot reason about
    expect(takeProfitFor({ rate: 80, n: W, ageMs: -1 }, W, TWO_RUNG).multiple).toBe(1.25)
  })

  it('a rate that is not a number', () => {
    expect(takeProfitFor({ rate: NaN, n: W, ageMs: 0 }, W, TWO_RUNG).multiple).toBe(1.25)
    expect(takeProfitFor({ rate: Infinity, n: W, ageMs: 0 }, W, TWO_RUNG).multiple).toBe(1.25)
  })

  it('says why, because a book silently stuck on the cold rung looks exactly like a cold venue', () => {
    expect(takeProfitFor(null, W).why).toMatch(/no gate reading/)
    expect(takeProfitFor({ ...ok(80), stale: true }, W).why).toMatch(/stale/)
    expect(takeProfitFor({ rate: 80, n: 3, ageMs: 0 }, W).why).toMatch(/3 of 20/)
    expect(takeProfitFor(ok(80), W).why).toMatch(/80\.0%/)
  })
})

describe('the rung is pinned to the position, not read from config', () => {
  const pos = (tp: number) => newPosition({
    id: 1, token: '0xt', curve: '0xc', tokens: 1n, spendWei: 1n,
    entryMarkWei: 1_000_000n, openedAt: 0, takeProfitMultiple: tp, buyHash: '0x', filled: true,
  })

  it('two bags open at once can exit on different rungs', () => {
    const mark = 1_400_000n
    expect(evaluate(pos(1.25), mark, 1, false)).toBe('tp')
    expect(evaluate(pos(1.36), mark, 1, false)).toBe('tp')
    expect(evaluate(pos(1.50), mark, 1, false)).toBeNull()
  })

  it('evaluate never reads the config scalar', () => {
    const ex = code('../src/strategy/exit-evaluation.ts')
    expect(ex).toMatch(/pos\.takeProfitMultiple/)
    expect(ex).not.toMatch(/STRATEGY\.takeProfit/)
  })

  it('the entry path chooses once and hands the same value to the row and the position', () => {
    const bot = code('../src/bot.ts')
    expect(bot).toMatch(/const tp = this\.pickTakeProfit\(openedAt\)/)
    expect(bot).toMatch(/take_profit: tp\.multiple/)
    expect(bot).toMatch(/takeProfitMultiple: tp\.multiple/)
  })
})

describe('the coupling runs one way only', () => {
  it('the gate bar is still a fixed 1.21 and no rung touches it', () => {
    expect(STRATEGY.gate.touchMultiple).toBe(1.21)
    const cfg = code('../src/config.ts')
    expect(cfg).not.toMatch(/touchMultiple:\s*STRATEGY\.takeProfit/)
    expect(cfg).not.toMatch(/touchMultiple:\s*takeProfit/)
  })

  it('the take-profit policy never reaches into the gate thresholds', () => {
    // it may read gate.window, which is the size of the window it is being handed. It may
    // NOT read openAt/shutAt: those are halt thresholds, and a take profit that moved with
    // them would make one number do two unrelated jobs.
    const tp = code('../src/strategy/takeprofit.ts')
    expect(tp).not.toMatch(/gate\.openAt/)
    expect(tp).not.toMatch(/gate\.shutAt/)
    expect(tp).not.toMatch(/gate\.touchMultiple/)
  })

  it('the cuts are not derived from the gate thresholds even though they collide', () => {
    // openAt is 25 and the first cut is 25. That is a coincidence of two separate
    // calibrations and it must stay a coincidence: writing `below: STRATEGY.gate.openAt`
    // would silently re-tune the exit policy the next time the gate is tuned.
    const cfg = code('../src/config.ts')
    expect(cfg).not.toMatch(/below:\s*STRATEGY\.gate/)
    expect(cfg).not.toMatch(/below:\s*gate\./)
  })
})
