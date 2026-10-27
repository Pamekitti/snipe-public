/**
 * The simulator, against the engine that decided real money.
 *
 * The parity block is the one that matters. `v1/scripts/engine.py` scored every launch the
 * live screen passed and wrote the per-bar outcome to `gate.db obs.bars`; the venue sensor
 * summed that column and halted the wallet on it. This replays 510 of those launches from
 * their own chain logs and asserts the port reproduces every number exactly.
 *
 * EXACTLY, not approximately. Both sides are IEEE-754 doubles evaluated in the same order,
 * so any difference at all is a real divergence rather than rounding. A tolerance here would
 * hide the class of bug this test exists to catch.
 *
 * The fixture pairs INPUTS with the reference's stored OUTPUTS: `gate.db` keeps only what the
 * replay produced, so the curve logs were fetched once and frozen beside the expected bars.
 * See scripts in the plan; the test itself never touches the network.
 */
import { describe, it, expect } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { path, evaluate, scoreLaunch, policyRule, snipeBps, barKey, calibrateReturn, LIVE_PATH, type SimEvent, type SimPath } from '../core/sim.js'
import { observe, openObservation, recordCurveLog } from '../core/observe.js'
import { coldest } from '../core/takeprofit.js'
import { emptyState, type State } from '../core/state.js'
import type { FrozenConfig, GuardSpec } from '../core/config.js'

const FIXTURE = join(new URL('.', import.meta.url).pathname, 'fixtures/sim-parity.json.gz')

/** The bar set the reference scored, and the exit stack it scored them under. */
const BARS = [1.25, 1.36, 1.5, 1.75, 2.0, 2.5, 3.0]
const POLICY = { hardStop: 0.5, deadAfterBlk: 200, deadBelowMultiple: 1.03, holdBlk: 450, pollBlk: 12, exitLagBlk: 6 }
/** The gate's own window, decoupled from the exit clock on purpose. */
const PEAK_WINDOW = 450

type Row = {
  token: string; curve: string; block: number; deployer: string; ctax: number
  expected_peak: number; expected_bars: Record<string, number>; seq: SimEvent[]
}

describe('the simulator reproduces the engine that halted the wallet', () => {
  const rows: Row[] = existsSync(FIXTURE) ? (JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString('utf8')) as Row[]) : []

  it('has its fixture', () => {
    // A silently empty fixture is a green suite that proves nothing, which is the failure
    // mode this whole file exists to prevent.
    expect(rows.length).toBeGreaterThan(400)
  })

  it('reproduces every peak and every bar, exactly', () => {
    let checkedBars = 0
    let noPath = 0
    for (const r of rows) {
      const P = path({ token: r.token, block: r.block, deployer: r.deployer, tx: '' }, 0.01, r.seq, r.ctax, LIVE_PATH)
      if (P === null) { noPath++; continue }
      const got = scoreLaunch(P, BARS, POLICY, PEAK_WINDOW)
      expect(got.peak, `peak for ${r.token}`).toBe(r.expected_peak)
      for (const [k, want] of Object.entries(r.expected_bars)) {
        expect(got.perBar[k], `bar ${k} for ${r.token}`).toBe(want)
        checkedBars++
      }
    }
    // Every row in the fixture was scored by the reference, so every row must produce a path.
    expect(noPath).toBe(0)
    expect(checkedBars).toBeGreaterThan(2_800)
  })

  it('covers the cases where the bars disagree, not just flat coins', () => {
    // A launch that never reaches 1.25 gives all seven bars the same value and exercises one
    // branch. The proof is in the rows where the take profit actually fires at different
    // places, so the fixture has to contain them.
    const spread = rows.filter((r) => new Set(Object.values(r.expected_bars)).size > 1)
    expect(spread.length).toBeGreaterThan(50)
    expect(Math.max(...rows.map((r) => r.expected_peak))).toBeGreaterThan(4)
  })
})

describe('trade-level residual calibration', () => {
  const calibration = { positiveFactor: 0.8844571237124664, negativeFactor: 0.9906639095130271 }

  it('haircuts wins, leaves zero alone, and keeps losses negative', () => {
    expect(calibrateReturn(0.5, calibration)).toBeCloseTo(0.4422285618562332, 15)
    expect(calibrateReturn(0, calibration)).toBe(0)
    expect(calibrateReturn(-0.5, calibration)).toBeCloseTo(-0.49533195475651355, 15)
  })

  it('retains the raw replay beside the calibrated result', () => {
    const P = fakePath([1, 1.5, 1.5])
    const got = scoreLaunch(P, [1.25], { ...POLICY, pollBlk: 1 }, 20, calibration)
    const raw = got.rawPerBar['1.25']!
    const factor = raw > 0 ? calibration.positiveFactor : calibration.negativeFactor
    expect(got.perBar['1.25']).toBeCloseTo(raw * factor, 15)
  })
})

describe('the snipe tax is three plateaus, never a decay', () => {
  it('charges the level the chain charges, by block', () => {
    expect(snipeBps(0.0, 0)).toBe(9700)
    expect(snipeBps(0.4, 0)).toBe(9700)
    expect(snipeBps(0.5, 0)).toBe(618)
    expect(snipeBps(1.0, 0)).toBe(618)
    expect(snipeBps(1.1, 0)).toBe(19)
    expect(snipeBps(2.0, 0)).toBe(19)
    expect(snipeBps(2.3, 0)).toBe(19)
    expect(snipeBps(2.4, 0)).toBe(0)
  })

  it('never charges more than the fees leave room for', () => {
    // 9700 at a 9000bps creator tax would ask for more than the whole stake.
    expect(snipeBps(0.0, 9000)).toBe(10000 - 100 - 9000 - 100)
  })

  it('is 19bps at the entry block, which is where every stored bar was priced', () => {
    expect(snipeBps(LIVE_PATH.entryBlk / 10, 0)).toBe(19)
  })
})

// ---------------------------------------------------------------------------
// The exit walk, on a hand-built path
// ---------------------------------------------------------------------------

/** A path with a chosen mark at each 5-block tick, so the exit rules can be driven directly. */
function fakePath(marks: readonly number[], grad = false): SimPath {
  return {
    token: '0xtest', X: 0.01, tok: 1000, ctax: 0, comp: 0, slotOut: 0, rivalX: 0.01,
    pts: marks.map((m, i) => ({ off: i * 5, m, q: 2, t: 5e8, grad, ev: null })),
  }
}

describe('the exit walk keeps the live bot order', () => {
  it('takes the profit on the same tick the clock expires, not the clock', () => {
    // The clock sits BETWEEN the take profit and the two floors. This boundary case is worth
    // a test because it was the other way round once and it cost every take-profit config.
    const marks = Array(20).fill(1.0)
    marks[10] = 2.0
    const P = fakePath(marks)
    const r = evaluate(P, policyRule({ ...POLICY, takeProfit: 1.75, pollBlk: 1 }), 0, 50)
    expect(r.reason).toBe('tp')
  })

  it('pays the exit lag on a clock exit as well as on a take profit', () => {
    // Selling instantly on the clock while tp/stop/dead waited handed every clock config a
    // free 0.6s head start on a decaying curve. That is a ranking bias, not rounding.
    const P = fakePath(Array(30).fill(1.0))
    const r = evaluate(P, policyRule({ ...POLICY, takeProfit: 99, pollBlk: 1 }), 6, 50)
    expect(r.reason).toBe('time')
    expect(r.off).toBeGreaterThanOrEqual(50 + 6)
  })

  it('lets graduation preempt a queued exit, and never poll-gates it', () => {
    const P = fakePath(Array(20).fill(1.0), true)
    const r = evaluate(P, policyRule({ ...POLICY, takeProfit: 99, pollBlk: 1_000 }), 0, 1_000)
    expect(r.reason).toBe('grad')
  })

  it('cannot act on a price it never saw', () => {
    // A spike that opens and closes between two polls did not happen as far as the bot is
    // concerned. Calibrated over 768 booked trades: -3.0% total error at poll 1, -1.2% at 12.
    const marks = Array(40).fill(1.0)
    marks[1] = 5.0 // one tick only, at off=5, invisible to a 12-block poll that just fired
    const seen = evaluate(fakePath(marks), policyRule({ ...POLICY, takeProfit: 1.75, pollBlk: 1 }), 0, 1_000)
    const blind = evaluate(fakePath(marks), policyRule({ ...POLICY, takeProfit: 1.75, pollBlk: 12 }), 0, 1_000)
    expect(seen.reason).toBe('tp')
    expect(blind.reason).not.toBe('tp')
  })

  it('bails on the peak, not on the current mark', () => {
    // A coin that touched 1.10 and fell back is not a dead coin; one that never moved is.
    const rose = Array(60).fill(1.0); rose[1] = 1.1
    const flat = Array(60).fill(1.0)
    const pol = { ...POLICY, takeProfit: 99, pollBlk: 1, deadAfterBlk: 200, holdBlk: 1_000 }
    expect(evaluate(fakePath(rose), policyRule(pol), 0, 1_000).reason).not.toBe('dead')
    expect(evaluate(fakePath(flat), policyRule(pol), 0, 1_000).reason).toBe('dead')
  })
})

describe('the mark is a proceeds ratio', () => {
  it('starts at exactly 1.0, because both ends pay the same frictions', () => {
    // A spot ratio starts at a median of 0.9930. That 0.7pp is 0.35% of the way to a 2.00
    // bar and 23% of the way to a 1.03 dead-coin bar, and 63% of bailed coins go on to print
    // 1.03x, so the old mark declared dead every coin whose real peak landed in between.
    const seq: SimEvent[] = [
      { b: 100, s: 'B', r: '0xaaa', q: '0x' + (10n ** 16n).toString(16).padStart(64, '0'), t: '0x0', f: '0x0', x: '0x0', tx: '0x1' },
    ]
    const P = path({ token: '0xt', block: 80, deployer: '0xdep', tx: '' }, 0.01, seq, 100, LIVE_PATH)
    expect(P).not.toBeNull()
    expect(P!.pts[0]!.m).toBe(1.0)
  })
})

describe('the bar key', () => {
  it('writes two decimals, so 1.5 and 1.50 cannot become two keys', () => {
    expect(barKey(1.5)).toBe('1.50')
    expect(barKey(2)).toBe('2.00')
    expect(barKey(1.75)).toBe('1.75')
  })
})

/**
 * The fold's own observer, against the same rows.
 *
 * The block above proves `sim.ts` reproduces `engine.py`. This proves the path from a chain
 * log to a cohort row does not lose or reorder anything on the way: the same launch, driven
 * through `openObservation` / `recordCurveLog` / `observe` one log at a time, has to produce
 * the bars `gate.db` stored. A correct simulator wired up wrongly is still a wrong indicator,
 * and that is exactly the defect this whole step exists to fix.
 */
describe('the observer feeds the simulator what the chain gave it', () => {
  const rows: Row[] = existsSync(FIXTURE) ? (JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString('utf8')) as Row[]) : []

  const GUARD: GuardSpec = {
    window: 20, recoveryWindow: 8, openAt: 1, shutAt: -1, settleMs: 52_000, freshMs: 10_800_000,
    pnlBar: 1.75, maxReadingAgeMs: 10_800_000,
  }
  // One book carrying the exact policy the reference scored under: the same bar set, the same
  // exit stack, the same clock. The fold has no other source for any of them.
  const CFG = {
    books: [{
      id: 'untaxed', minCreatorTaxBps: 0, maxCreatorTaxBps: 0, minExemptions: 3, templateLossBlockMs: 3_600_000,
      sizeWei: '5000000000000000', maxDrawdownWei: '15000000000000000',
      entry: { entryDelayMs: 2_000, entryFallbackLateMs: 600, maxEntryPriceMultiple: 4.5, buySlippageBps: 5_000 },
      exit: {
        maxHoldMs: 45_000, hardStopMultiple: 0.5, deadCoinAfterMs: 20_000, deadCoinBelowMultiple: 1.03,
        graduationExitAt: 0.12, maxSellAttempts: 20, exitRetryDelayMs: 300, sellFinalMinQuoteOutWei: '1',
      },
      takeProfit: { otherwise: 1.75, adaptiveWindow: 20, adaptiveBars: BARS },
      guard: GUARD,
    }],
    risk: {}, clock: { periodMs: 250 },
  } as unknown as FrozenConfig

  /** Watch one launch, feed it its logs one at a time, then let the window close. */
  function foldOne(r: Row, config: FrozenConfig = CFG): State {
    let s: State = {
      ...emptyState(config, { sizeWei: 5_000_000_000_000_000n, mode: 'live', at: 0, by: 'test' }),
      at: 1_000_000,
    }
    openObservation(s, {
      token: r.token, curve: r.curve, book: 'untaxed',
      launchBlock: r.block, deployer: r.deployer, launchTx: '', creatorTaxBps: r.ctax,
    })
    for (const e of r.seq) recordCurveLog(s, r.curve, e)
    s = { ...s, at: s.at + GUARD.settleMs }
    return observe(s)
  }

  it('reproduces gate.db\'s bars end to end, through the fold, on launches that disagree', () => {
    // Launches whose bars differ from each other are the ones that exercise the exit walk.
    // A flat coin gives all seven bars the same number and would pass a broken wiring too.
    const spread = rows.filter((r) => new Set(Object.values(r.expected_bars)).size > 1).slice(0, 40)
    expect(spread.length).toBeGreaterThan(20)

    let checked = 0
    for (const r of spread) {
      const after = foldOne(r)
      const got = after.cohort.all()
      expect(got, `no outcome for ${r.token}`).toHaveLength(1)
      const o = got[0]!
      for (const [k, want] of Object.entries(r.expected_bars)) {
        expect(o.perBar[k], `bar ${k} for ${r.token}`).toBe(want)
        checked++
      }
      expect(o.peak, `peak for ${r.token}`).toBe(r.expected_peak)
      // The indicator's column is lifted out at settle, so a projection with no config still
      // draws the number that halted the wallet rather than picking a bar of its own. Each
      // fold here starts from an empty cohort, so the selector is cold and the watch pins the
      // coldest rung — the same one a real entry would have taken in that state.
      expect(o.stakes).toBe(r.expected_bars[barKey(coldest(CFG.books[0]!.takeProfit))])
      expect(o.book).toBe('untaxed')
    }
    expect(checked).toBeGreaterThan(140)
  })

  it('feeds calibrated outcomes to paper and the guard while retaining raw detector evidence', () => {
    const r = rows.find((x) => new Set(Object.values(x.expected_bars)).size > 1)!
    const calibration = { model: 'test-calibrated', positiveFactor: 0.8, negativeFactor: 0.9 }
    const config = { ...CFG, simulation: calibration }
    const o = foldOne(r, config).cohort.all()[0]!
    expect(o.simulationModel).toBe(calibration.model)
    for (const [key, raw] of Object.entries(r.expected_bars)) {
      expect(o.rawPerBar?.[key]).toBe(raw)
      expect(o.perBar[key]).toBeCloseTo(raw * (raw > 0 ? calibration.positiveFactor : raw < 0 ? calibration.negativeFactor : 1), 15)
    }
    expect(o.stakes).toBe(o.perBar[barKey(coldest(config.books[0]!.takeProfit))])
  })

  it('drops a log past the horizon without disturbing the score', () => {
    // The walk stops at the horizon, so a late log must change nothing. If it did, a busy
    // curve and a quiet one would score differently for a reason nothing measured.
    const r = rows.find((x) => new Set(Object.values(x.expected_bars)).size > 1)!
    const late = { ...r, seq: [...r.seq, { b: r.block + 5_000, s: 'B', q: '0x' + (10n ** 17n).toString(16).padStart(64, '0'), t: '0x0', f: '0x0', x: '0x0' } as SimEvent] }
    const a = foldOne(r).cohort.all()[0]!
    const b = foldOne(late).cohort.all()[0]!
    expect(b.perBar).toEqual(a.perBar)
    expect(b.peak).toBe(a.peak)
  })
})
