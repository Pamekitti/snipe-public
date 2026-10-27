/**
 * THE VENUE PAUSE: what the bot's own exit rule would have made on the launches it was not
 * holding, and the hysteresis over it (strategy/gate.ts).
 *
 * This is the sensor that decides, unattended and overnight, whether to keep putting money
 * into a venue. Its two failure directions are not symmetric and both are tested here:
 * pausing on a quiet night that is merely thin costs a night of trading, and NOT pausing
 * when the window is genuinely negative is the 2026-08-28 bleed. The freshness rule is
 * what separates them, so most of these cases are about it.
 *
 * Numbers come from the 2026-09-07 measurement over 3,280 replayed launches; see
 * config.ts STRATEGY.gate.pnlBar and the schema docs for what was fitted and how.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeGateDb } from './helpers/gatedb.js'
import { trailingOutcome, stepVenue, venueAction, RegimeGate, type VenueReading } from '../src/strategy/gate.js'
import { STRATEGY } from '../src/config.js'

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0)
const SEC = (msAgo: number): number => Math.floor((NOW - msAgo) / 1000)
/** the live book's floors (config.ts minCreatorTaxBps / minExemptionsToEnter) */
const BOOK = { minTaxBps: 50, maxTaxBps: 10000, minExempt: 3 }
const row = (v: number | null, msAgo = 60_000, at = NOW - msAgo) => ({
  bars: v === null ? '{"2.00":0.1}' : JSON.stringify({ '1.75': v, '2.00': v + 0.01 }),
  launched_at: SEC(msAgo),
  at,
})

describe('trailingOutcome: the window and its freshness', () => {
  const opts = { window: 4, freshMs: 6 * 3600_000, key: '1.75', now: NOW }

  it('sums the newest window and reports the oldest launch it used', () => {
    const t = trailingOutcome([row(0.5, 1000), row(-0.25, 2000), row(0.1, 3000), row(-1, 4000), row(99, 5000)], opts)
    expect(t!.n).toBe(4)
    expect(t!.sum).toBeCloseTo(-0.65, 10)
    // the fifth row is outside the window and must not reach the sum
    expect(t!.oldestAgeMs).toBe(4000)
    expect(t!.fresh).toBe(true)
  })

  it('skips a row missing this bar rather than scoring it flat', () => {
    // gatewatch drops a bar whose replay threw (scripts/gatewatch.py score()). Counting
    // that as 0.0 would pull the sum toward the middle and quietly disarm the sensor.
    const t = trailingOutcome([row(-2, 1000), row(null, 2000), row(-2, 3000), row(-2, 4000), row(-2, 5000)], opts)
    expect(t!.n).toBe(4)
    expect(t!.sum).toBeCloseTo(-8, 10)
  })

  it('ignores an unparseable row and a non-finite value', () => {
    const junk = [
      { bars: 'not json', launched_at: SEC(1000), at: NOW },
      { bars: '{"1.75": null}', launched_at: SEC(1100), at: NOW },
      { bars: '{"1.75": "0.5"}', launched_at: SEC(1200), at: NOW },
      row(0.25, 1300), row(0.25, 1400), row(0.25, 1500), row(0.25, 1600),
    ]
    const t = trailingOutcome(junk, opts)
    expect(t!.n).toBe(4)
    expect(t!.sum).toBeCloseTo(1, 10)
  })

  it('is not fresh when the window reaches back past the limit', () => {
    // August: ~10 launches a day, so 40 of them spanned four days. A window that stretches
    // is measuring a dead era, and the caller must treat it as no opinion.
    const t = trailingOutcome([row(-3, 1000), row(-3, 2000), row(-3, 3000), row(-3, 7 * 3600_000)], opts)
    expect(t!.n).toBe(4)
    expect(t!.fresh).toBe(false)
  })

  it('is not fresh on a short window, however bad it looks', () => {
    const t = trailingOutcome([row(-9, 1000), row(-9, 2000)], opts)
    expect(t!.n).toBe(2)
    expect(t!.fresh).toBe(false)
  })

  it('has no opinion at all on no rows and on rows that carry nothing', () => {
    expect(trailingOutcome([], opts)).toBe(null)
    expect(trailingOutcome([row(null, 1000), row(null, 2000)], opts)).toBe(null)
  })
})

describe('stepVenue: the band', () => {
  it('shuts below the floor, reopens above the ceiling, and holds inside', () => {
    expect(stepVenue('open', -3.5, -3, 0.5)).toBe('shut')
    expect(stepVenue('open', -3, -3, 0.5)).toBe('open')   // strictly below, so the floor itself holds
    expect(stepVenue('open', -1, -3, 0.5)).toBe('open')
    expect(stepVenue('shut', -1, -3, 0.5)).toBe('shut')   // the band is the hysteresis
    expect(stepVenue('shut', 0.5, -3, 0.5)).toBe('shut')  // strictly above
    expect(stepVenue('shut', 0.6, -3, 0.5)).toBe('open')
  })
})

describe('venueAction', () => {
  const v = (over: Partial<VenueReading> = {}): VenueReading =>
    ({ state: 'open', sum: 1, n: 40, fresh: true, oldestAgeMs: 60_000, bar: '1.75', ...over })

  it('halts on a shut reading and names the number', () => {
    const a = venueAction({ venue: v({ state: 'shut', sum: -4.2 }), venueHalted: false })
    expect(a.do).toBe('halt')
    expect(a.do === 'halt' && a.why).toContain('-4.20 stakes over 40 scored launches at 1.75x')
  })

  it('says nothing when it has already halted, so the reason does not churn', () => {
    expect(venueAction({ venue: v({ state: 'shut' }), venueHalted: true }).do).toBe('nothing')
  })

  it('resumes only a pause it placed', () => {
    expect(venueAction({ venue: v(), venueHalted: true }).do).toBe('resume')
    expect(venueAction({ venue: v(), venueHalted: false }).do).toBe('nothing')
  })

  it('has no opinion with no reading', () => {
    expect(venueAction({ venue: null, venueHalted: true }).do).toBe('nothing')
  })
})

describe('RegimeGate.readVenue against a real gate.db', () => {
  const dirs: string[] = []
  const mk = () => {
    const d = mkdtempSync(join(tmpdir(), 'venue-'))
    dirs.push(d)
    const book = join(d, 'bot.db')
    return { file: join(d, 'gate.db'), book, g: makeGateDb(join(d, 'gate.db'), book) }
  }
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  const CFG = { window: 4, off: -3, on: 0.5, freshMs: 6 * 3600_000, bar: '1.75', book: BOOK }

  const fill = (g: ReturnType<typeof makeGateDb>, vals: number[], msAgo = 60_000) => {
    vals.forEach((v, i) => g.obs({
      token: `0x${i}`, block: 1000 - i, launched_at: SEC(msAgo + i * 1000),
      at: NOW - msAgo - i * 1000, bars: JSON.stringify({ '1.75': v }),
    }))
  }

  it('reads the newest rows by block and applies the band', () => {
    const { file, book, g } = mk()
    fill(g, [-1, -1, -1, -1])
    g.close()
    const gate = new RegimeGate(file, () => NOW, null, true, book)
    const r = gate.readVenue(CFG)!
    expect(r.n).toBe(4)
    expect(r.sum).toBeCloseTo(-4, 10)
    expect(r.state).toBe('shut')
    gate.close()
  })

  it('seeds OPEN inside the band, so a restart does not park the bot', () => {
    // deliberately unlike the touch gate, which seeds shut. This band's neutral point is
    // zero and its resume line is +0.5: seeding shut would hold a restarted bot off until
    // the venue had actively made money, which is a different claim from "it is bad".
    const { file, book, g } = mk()
    fill(g, [0, 0, 0, 0])
    g.close()
    const gate = new RegimeGate(file, () => NOW, null, true, book)
    expect(gate.readVenue(CFG)!.state).toBe('open')
    gate.close()
  })

  it('seeds SHUT when the first window it ever sees is below the floor', () => {
    const { file, book, g } = mk()
    fill(g, [-2, -2, -2, -2])
    g.close()
    const gate = new RegimeGate(file, () => NOW, null, true, book)
    expect(gate.readVenue(CFG)!.state).toBe('shut')
    gate.close()
  })

  it('a dry spell reads open and does not disturb the state it had', () => {
    // The pause must survive the night that starves it: with the window unfilled there is
    // no measurement, and refusing to trade on absent evidence would have stopped the bot
    // every night of August. The remembered state comes back when the data does.
    const { file, book, g } = mk()
    fill(g, [-2, -2, -2, -2])
    g.close()
    const gate = new RegimeGate(file, () => NOW, null, true, book)
    expect(gate.readVenue(CFG)!.state).toBe('shut')
    // now ask with a window bigger than the file holds: unfresh, so open and no opinion
    const thin = gate.readVenue({ ...CFG, window: 10 })!
    expect(thin.fresh).toBe(false)
    expect(thin.state).toBe('open')
    // and the pause is still there underneath
    expect(gate.readVenue(CFG)!.state).toBe('shut')
    gate.close()
  })

  it('drops rows with no launch clock instead of reading them as 1970', () => {
    // obs.launched_at is nullable and is written as 0 on one path. One such row inside the
    // window would make oldestAgeMs 56 years and freeze the sensor at "not fresh".
    const { file, book, g } = mk()
    fill(g, [1, 1, 1, 1])
    g.obs({ token: '0xnull', block: 2000, launched_at: null, at: NOW, bars: '{"1.75":-9}' })
    g.obs({ token: '0xzero', block: 2001, launched_at: 0, at: NOW, bars: '{"1.75":-9}' })
    g.close()
    const gate = new RegimeGate(file, () => NOW, null, true, book)
    const r = gate.readVenue(CFG)!
    expect(r.fresh).toBe(true)
    expect(r.sum).toBeCloseTo(4, 10)  // the two clockless rows are gone, not summed
    gate.close()
  })

  it('over-fetches so rows missing the bar do not shrink the window', () => {
    const { file, book, g } = mk()
    // newest four carry only 2.00; the four behind them carry 1.75
    ;[0, 1, 2, 3].forEach((i) => g.obs({
      token: `0xa${i}`, block: 2000 - i, launched_at: SEC(1000 + i), at: NOW, bars: '{"2.00":0.5}',
    }))
    fill(g, [0.5, 0.5, 0.5, 0.5], 5000)
    g.close()
    const gate = new RegimeGate(file, () => NOW, null, true, book)
    const r = gate.readVenue(CFG)!
    expect(r.n).toBe(4)
    expect(r.fresh).toBe(true)
    gate.close()
  })

  it('counts only launches the book would buy: untaxed and thin-exempt coins are invisible', () => {
    // The 2026-09-06 23:46 pause. gatewatch scores every coin the screen passes, on
    // purpose (the declined ones are the control group), and 80% of those are coins the
    // bot declines at entry. That night the 40 newest scored coins summed -3.63 and paused
    // the bot, while the 6 buyable ones among them summed +0.40 and the 40 newest BUYABLE
    // coins +13.20. The tapes every threshold was fitted on carried the book, so this join
    // is what makes the live number the fitted one.
    const { file, book, g } = mk()
    fill(g, [1, 1, 1, 1], 120_000) // four buyable coins, older
    ;[0, 1, 2, 3, 4, 5].forEach((i) => g.obs({
      token: `0xun${i}`, block: 3000 - i, launched_at: SEC(1000 + i), at: NOW, bars: '{"1.75":-3}', tax: 0,
    }))
    ;[0, 1].forEach((i) => g.obs({
      token: `0xthin${i}`, block: 2500 - i, launched_at: SEC(2000 + i), at: NOW, bars: '{"1.75":-3}', ex: 2,
    }))
    g.close()
    const gate = new RegimeGate(file, () => NOW, null, true, book)
    const r = gate.readVenue(CFG)!
    expect(r.n).toBe(4)
    expect(r.sum).toBeCloseTo(4, 10)
    expect(r.state).toBe('open')
    gate.close()
  })

  it('takes the floors from the caller, so a book change moves the sensor with it', () => {
    const { file, book, g } = mk()
    fill(g, [1, 1, 1, 1]) // 100 bps, 3 wallets each
    g.close()
    const gate = new RegimeGate(file, () => NOW, null, true, book)
    expect(gate.readVenue({ ...CFG, book: { minTaxBps: 50, maxTaxBps: 10000, minExempt: 3 } })!.n).toBe(4)
    expect(gate.readVenue({ ...CFG, book: { minTaxBps: 50, maxTaxBps: 10000, minExempt: 5 } })).toBe(null)
    expect(gate.readVenue({ ...CFG, book: { minTaxBps: 150, maxTaxBps: 10000, minExempt: 3 } })).toBe(null)
    gate.close()
  })

  it('has no opinion without a book to join, never the whole scored set', () => {
    // the failure this guards: a caller that forgets bot.db must not get yesterday's
    // sensor back, the one that paused on coins the bot never held
    const { file, g } = mk()
    fill(g, [-2, -2, -2, -2])
    g.close()
    const gate = new RegimeGate(file, () => NOW)
    expect(gate.readVenue(CFG)).toBe(null)
    expect(gate.readResume(2, '1.75', NOW - 3600_000, BOOK)).toBe(null)
    gate.close()
  })

  it('has no opinion when gate.db is missing or predates the per-bar column', () => {
    expect(new RegimeGate('/nonexistent/gate.db', () => NOW).readVenue(CFG)).toBe(null)
    const d = mkdtempSync(join(tmpdir(), 'venue-old-')); dirs.push(d)
    const file = join(d, 'gate.db')
    const book = join(d, 'bot.db')
    const db = makeGateDb(file, book).db
    db.exec('DROP TABLE obs; CREATE TABLE obs (token TEXT PRIMARY KEY, block INTEGER, launched_at INTEGER, at INTEGER, error TEXT)')
    db.close()
    const gate = new RegimeGate(file, () => NOW, null, true, book)
    expect(gate.readVenue(CFG)).toBe(null)
    // and the touch gate still works, which is the 2026-09-06 lesson about one broken
    // statement nulling every other one
    expect(gate.read(20, 25, 10)).toBe(null)
    gate.close()
  })
})

describe('RegimeGate.readResume: evidence scored since the stop', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  const mk = () => {
    const d = mkdtempSync(join(tmpdir(), 'ddres-')); dirs.push(d)
    const file = join(d, 'gate.db')
    const book = join(d, 'bot.db')
    return { file, book, g: makeGateDb(file, book) }
  }

  it('counts only launches scored after the halt, and needs a full window of them', () => {
    // THE point of the rule: at the moment a drawdown stop fires, the newest scored
    // launches are usually the coins it fired for. On 2026-09-06 those replayed fine while
    // the bot mispriced them, so the naive version would have lifted the stop back into the
    // bug within a minute.
    const { file, book, g } = mk()
    const HALT = NOW - 3600_000
    ;[0, 1, 2].forEach((i) => g.obs({
      token: `0xold${i}`, block: 900 - i, launched_at: SEC(2 * 3600_000), at: HALT - 60_000, bars: '{"1.75":5}',
    }))
    ;[0, 1].forEach((i) => g.obs({
      token: `0xnew${i}`, block: 1000 - i, launched_at: SEC(600_000), at: HALT + 60_000, bars: '{"1.75":0.4}',
    }))
    g.close()
    const gate = new RegimeGate(file, () => NOW, null, true, book)
    // three post-halt rows required, only two exist: no verdict, whatever the old ones say
    expect(gate.readResume(3, '1.75', HALT, BOOK)).toBe(null)
    const r = gate.readResume(2, '1.75', HALT, BOOK)!
    expect(r.n).toBe(2)
    expect(r.sum).toBeCloseTo(0.8, 10)
    gate.close()
  })

  it('has no freshness rule: a thin night still resolves 20 real outcomes', () => {
    const { file, book, g } = mk()
    const HALT = NOW - 8 * 3600_000
    ;[0, 1, 2].forEach((i) => g.obs({
      token: `0x${i}`, block: 1000 - i, launched_at: SEC(7 * 3600_000 + i * 1000), at: HALT + 1000 + i, bars: '{"1.75":1}',
    }))
    g.close()
    const gate = new RegimeGate(file, () => NOW, null, true, book)
    expect(gate.readResume(3, '1.75', HALT, BOOK)!.sum).toBeCloseTo(3, 10)
    gate.close()
  })
})

describe('the sensor bar is a yardstick, not the policy', () => {
  it('is one of the bars gatewatch actually scores', () => {
    // gatewatch replays exactly the bars published in takeProfitAdaptiveBars and no
    // others, so a pnlBar outside that set would leave the sensor permanently blind while
    // every other panel looked healthy.
    expect(STRATEGY.takeProfit.adaptive.bars).toContain(STRATEGY.gate.pnlBar)
  })

  it('does not move with the take profit', () => {
    // the same invariant test/gatebar.test.ts pins for the touch gate: a regime detector
    // whose ruler follows the policy cannot tell you whether the venue moved or you did
    expect(STRATEGY.gate.pnlBar).toBe(1.75)
  })
})

/**
 * THE OUTCOME SERIES THE DASHBOARD SHOWS (2026-09-13).
 *
 * The page shows the individual launches behind the venue sum, because a single number
 * cannot tell an operator whether a pause is a run of small losses or one disaster. The
 * whole safety property is that the strip and the sum are THE SAME ROWS: `obs` is roughly
 * 80% coins the book would never buy (memory: venue-sensor-measures-the-book), so a second
 * query without the book-floor join would quietly disagree with the guard it explains.
 *
 * These lock that together: the values come off the sum's own loop, so they cannot drift.
 */
describe('trailingOutcome hands back the rows it counted', () => {
  it('returns one value per counted row, and they add up to the sum', () => {
    const rows = [row(0.9), row(-0.4), row(0.25), row(-0.1)]
    const t = trailingOutcome(rows, { window: 20, freshMs: 3.6e6, key: '1.75', now: NOW })!
    expect(t.values).toHaveLength(t.n)
    expect(t.values.reduce((a, o) => a + o.value, 0)).toBeCloseTo(t.sum, 10)
    expect(t.values.map(o => o.value)).toEqual([0.9, -0.4, 0.25, -0.1])   // newest first
  })

  it('skips exactly the rows the sum skipped, so the strip cannot show a phantom launch', () => {
    // a row missing THIS bar is missing data, not a flat outcome; it is not counted and so
    // must not be drawn either
    const rows = [row(0.5), row(null), row(-0.2)]
    const t = trailingOutcome(rows, { window: 20, freshMs: 3.6e6, key: '1.75', now: NOW })!
    expect(t.n).toBe(2)
    expect(t.values).toHaveLength(2)
    expect(t.values.reduce((a, o) => a + o.value, 0)).toBeCloseTo(t.sum, 10)
  })

  it('stops at the window, like the sum does', () => {
    const rows = Array.from({ length: 30 }, () => row(0.1))
    const t = trailingOutcome(rows, { window: 20, freshMs: 3.6e6, key: '1.75', now: NOW })!
    expect(t.n).toBe(20)
    expect(t.values).toHaveLength(20)
    expect(t.values.reduce((a, o) => a + o.value, 0)).toBeCloseTo(t.sum, 10)
  })
})
