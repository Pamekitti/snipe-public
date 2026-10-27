import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RegimeGate, gateAction, type GateReading } from '../src/strategy/gate.js'
import { RiskManager, utcDay } from '../src/strategy/risk.js'
import { RISK } from '../src/config.js'
import { makeGateDb } from './helpers/gatedb.js'

/**
 * These cover the one behaviour that runs unattended against real money: the bot
 * un-halting itself. Every test here is a way that could go wrong at 3am with nobody
 * watching, so they are written as "what must never happen" rather than as coverage.
 */
const open = (rate = 30, n = 20): GateReading => ({ state: 'open', rate, n, dataAgeMs: 0, source: 'live', liveN: n })
const shut = (rate = 10, n = 20): GateReading => ({ state: 'shut', rate, n, dataAgeMs: 0, source: 'live', liveN: n })
const stale = (): GateReading => ({ state: 'shut', rate: 40, n: 20, dataAgeMs: null, source: 'file', liveN: 0, stale: 'gatewatch is not running (45 min since last run)' })

// `gateHalted` is the gate's OWN halt, not the bot's. gateAction stopped being told about
// other kinds on 2026-08-27: it used to take the global boolean and drop a shut reading
// whenever anything else had halted us, which meant a daily cap could lift at midnight into
// a venue that had been shut for hours. Who may lift what now lives in RiskManager.resume,
// the one place that can see every halt at once, and is asserted in the block below.
const call = (o: Partial<Parameters<typeof gateAction>[0]>) =>
  gateAction({ reading: open(), gateHalted: false, ...o })

describe('gateAction: halting', () => {
  it('halts on a shut gate and names the rate', () => {
    const a = call({ reading: shut(12.5) })
    expect(a.do).toBe('halt')
    expect(a.do === 'halt' && a.why).toContain('12.5%')
  })

  it('reports a dead watcher as unreadable, not as a bad venue', () => {
    const a = call({ reading: stale() })
    expect(a.do).toBe('halt')
    // the venue was fine (40%); saying "venue bad" would send the operator the wrong way
    expect(a.do === 'halt' && a.why).toContain('unreadable')
    expect(a.do === 'halt' && a.why).not.toContain('40.0%')
  })

  it('does nothing when there is no watcher at all', () => {
    expect(call({ reading: null, gateHalted: true }).do).toBe('nothing')
    expect(call({ reading: null, gateHalted: false }).do).toBe('nothing')
  })

  it('halting while already halted is a no-op, not a relabel', () => {
    expect(call({ reading: shut(), gateHalted: true }).do).toBe('nothing')
  })

  it('records a shut venue even while the bot is halted for something else', () => {
    // THE HOLE THIS SIGNATURE CLOSED. The old shape returned 'nothing' for a shut reading
    // whenever ANY halt was up, so: daily cap halts at 14:00, venue shuts at 18:00 and
    // nothing anywhere records it, and at 00:00 UTC the cap lifts into a venue that has
    // been shut for six hours. The gate now always places its own halt; whether that
    // actually stops or resumes anything is RiskManager's call.
    expect(call({ reading: shut(8), gateHalted: false }).do).toBe('halt')
  })
})

/**
 * INSTANT RESUME. There is deliberately no timer here any more: at a five-minute scoring
 * tick, "ten minutes of continuously-open readings" was the only way to guarantee two
 * INDEPENDENT samples, so one lucky scoring round could not restart us. Continuous
 * scoring provides that separation directly, and the band does the rest -- reopening
 * demands openAt (25) while staying open only needs shutAt (10).
 *
 * What must NOT change is who may be resumed. These assert exactly that.
 */
describe('gateAction: resuming', () => {
  it('resumes on the first open reading', () => {
    const a = call({ gateHalted: true })
    expect(a.do).toBe('resume')
    expect(a.do === 'resume' && a.why).toContain('30.0%')
  })

  it('has nothing to lift when the halt was not its own', () => {
    // A drawdown stop, a daily cap or HALT=1 leaves gateHalted false, so however open the
    // venue reads there is no gate halt here to lift. The stronger claim -- that an open
    // venue cannot resume a bot held by a stickier kind even when the gate DID also halt
    // it -- is RiskManager.resume's, and is asserted in 'RiskManager halt kinds' below.
    expect(call({ reading: open(90), gateHalted: false }).do).toBe('nothing')
  })

  it('never resumes on a dead watcher, which is the failure that costs money', () => {
    // staleness always reads as shut, so however long it sits there, no resume
    expect(call({ reading: stale(), gateHalted: true }).do).toBe('nothing')
  })

  it('never resumes on no reading at all', () => {
    expect(call({ reading: null, gateHalted: true }).do).toBe('nothing')
  })

  it('does not resume a bot that was never halted', () => {
    expect(call({ gateHalted: false }).do).toBe('nothing')
  })

  it('a flapping venue stays halted while the reading is shut', () => {
    // the protection is the BAND, not a clock: a shut reading is shut, every time
    for (const rd of [shut(), shut(), shut()]) {
      expect(call({ reading: rd, gateHalted: true }).do).toBe('nothing')
    }
  })
})

describe('RiskManager halt kinds', () => {
  const rm = () => new RiskManager(BigInt(1e17))

  it('only lets a halt be lifted by its own kind', () => {
    const r = rm()
    r.halt('venue quiet', 'gate')
    expect(r.resume('manual')).toBe(false)
    expect(r.halted).toBe(true)
    expect(r.resume('gate')).toBe(true)
    expect(r.halted).toBe(false)
  })

  it('a drawdown stop is never lifted by resume(), whoever asks', () => {
    const r = rm()
    r.halt('drawdown $75 from peak', 'drawdown')
    // resume() is the venue's door and the drawdown does not open from it. Its own lift
    // (liftOnSignal) carries preconditions resume() cannot express: flat, an epoch reset,
    // evidence scored after the halt, and a daily budget.
    expect(r.resume('drawdown' as never)).toBe(false)
    expect(r.resume('gate')).toBe(false)
    expect(r.resume('manual')).toBe(false)
    expect(r.halted).toBe(true)
  })

  it('a bot-broken halt outranks the drawdown stop and blocks its self-lift', () => {
    const r = rm()
    r.halt('drawdown $75 from peak', 'drawdown')
    r.halt('we made -7% where the coins replayed at +14%', 'broken')
    // the whole point: when the bot is the problem, a paying venue must not talk it back on
    expect(r.haltKind).toBe('broken')
    expect(r.liftOnSignal('drawdown', 'venue paid')).toBe(false)
    expect(r.halted).toBe(true)
    // and nothing lifts 'broken' but a restart
    expect(r.resume('broken' as never)).toBe(false)
    expect(r.resumeOutlook().autoResumes).toBe(false)
  })

  it('lifts the drawdown stop under an operator stop or a venue pause, and leaves those in place', () => {
    const r = rm()
    r.halt('stopped from the dashboard', 'stopped')
    r.halt('drawdown 0.112 ETH from peak', 'drawdown')
    r.halt('venue not paying (-4.10 stakes over 40 scored launches at 1.75x)', 'venue')
    expect(r.haltKind).toBe('drawdown')
    expect(r.liftOnSignal('drawdown', 'venue paid')).toBe(true)
    // the two below it are independent claims and survive
    expect(r.haltKinds).toEqual(['stopped', 'venue'])
    expect(r.halted).toBe(true)
  })

  it('self-lifts the drawdown twice in a day and then waits for a person', () => {
    const DAY = Date.UTC(2026, 8, 7, 14, 0, 0)
    let now = DAY
    const r = new RiskManager(BigInt(1e17), () => now)
    for (const n of [1, 2]) {
      r.halt(`drawdown ${n}`, 'drawdown')
      expect(r.liftOnSignal('drawdown', 'venue paid')).toBe(true)
      expect(r.ddLiftsUsed).toBe(n)
    }
    r.halt('drawdown 3', 'drawdown')
    expect(r.liftOnSignal('drawdown', 'venue paid')).toBe(false)
    expect(r.halted).toBe(true)
    // and it says so: three stops in a day is not something the venue can argue with
    expect(r.resumeOutlook(now).autoResumes).toBe(false)
    now = DAY + 86_400_000
    r.rollDay()
    expect(r.ddLiftsUsed).toBe(0)
    expect(r.liftOnSignal('drawdown', 'venue paid')).toBe(true)
  })

  it('records when each halt was placed, so the resume can demand fresh evidence', () => {
    const AT = Date.UTC(2026, 8, 7, 14, 0, 0)
    let now = AT
    const r = new RiskManager(BigInt(1e17), () => now)
    r.halt('drawdown', 'drawdown')
    expect(r.haltAt('drawdown')).toBe(AT)
    expect(r.haltAt('gate')).toBe(null)
    now = AT + 60_000
    // first-reason-wins, and first-TIME-wins with it: a re-halt must not slide the window
    r.halt('drawdown again', 'drawdown')
    expect(r.haltAt('drawdown')).toBe(AT)
  })

  it('a later gate shut cannot relabel a drawdown halt into a resumable one', () => {
    const r = rm()
    r.halt('drawdown $80 from peak', 'drawdown')
    r.halt('regime gate shut (cohort touch 5.0%)', 'gate')
    expect(r.haltKind).toBe('drawdown')
    expect(r.haltReason).toContain('drawdown')
    expect(r.resume('gate')).toBe(false)
    expect(r.halted).toBe(true)
  })

  it('an operator halt survives the venue recovering', () => {
    const r = rm()
    r.halt('halted by operator (HALT=1)', 'manual')
    expect(r.resume('gate')).toBe(false)
    expect(r.halted).toBe(true)
  })

  it('resume on a running bot is a no-op, not a state change', () => {
    const r = rm()
    expect(r.resume('gate')).toBe(false)
    expect(r.halted).toBe(false)
  })

  it('blocks entries while halted and allows them after a legitimate resume', () => {
    const r = rm()
    const args = { token: '0xa', sizeWei: BigInt(75e14), logsHealthy: true, logsAgeMs: 0 }
    r.halt('regime gate shut', 'gate')
    expect(r.canEnter(args).allow).toBe(false)
    r.resume('gate')
    expect(r.canEnter(args).allow).toBe(true)
  })
})

/**
 * THE UTC DAY ROLLOVER, which is now only about the drawdown stop's self-lift budget.
 *
 * The daily loss cap used to live here and was deleted on 2026-09-07: it could not lift
 * before 00:00 UTC, and on 2026-09-05 it would have tripped at 06:35 and sat out $731 of
 * that day's replay. The rollover did NOT go with it. `ddLiftsToday` is what stops the
 * drawdown stop lifting itself more than twice a day, and without a rollover the bot would
 * spend those two lifts and never get them back for the lifetime of the process, which is
 * a bot that needs a person at 3am for the rest of the week.
 */
describe('the UTC day rollover restores the drawdown lift budget', () => {
  const T = Date.UTC(2026, 7, 27, 14, 0, 0)
  const NEXT = (utcDay(T) + 1) * 86_400_000 + 60_000

  it('hands back the two lifts at the rollover, and reports that it did', () => {
    let now = T
    const r = new RiskManager(BigInt(1e17), () => now)
    for (const n of [1, 2]) {
      r.halt(`drawdown ${n}`, 'drawdown')
      expect(r.liftOnSignal('drawdown', 'venue paid')).toBe(true)
    }
    expect(r.ddLiftsExhausted).toBe(true)
    now = NEXT
    expect(r.rollDay()).toBe(true)
    expect(r.ddLiftsExhausted).toBe(false)
    expect(r.ddLiftsUsed).toBe(0)
  })

  it('is a no-op inside the same day, so it can be polled every 30 seconds', () => {
    let now = T
    const r = new RiskManager(BigInt(1e17), () => now)
    expect(r.rollDay()).toBe(false)
    now = T + 3600_000
    expect(r.rollDay()).toBe(false)
  })

  it('reports false at a rollover that had nothing to restore', () => {
    // the return value drives a log line, so a quiet day must not print one
    let now = T
    const r = new RiskManager(BigInt(1e17), () => now)
    now = NEXT
    expect(r.rollDay()).toBe(false)
  })

  it('zeroes the day ledger at the rollover, which the dashboard reads', () => {
    let now = T
    const r = new RiskManager(BigInt(1e17), () => now)
    r.closed(BigInt(2e16), -BigInt(1e16))
    expect(r.dayRealizedPnlWei).toBe(-BigInt(1e16))
    now = NEXT
    r.rollDay()
    expect(r.dayRealizedPnlWei).toBe(0n)
    // the epoch ledger is NOT a day thing and must survive
    expect(r.realizedPnlWei).toBe(-BigInt(1e16))
  })

  it('a rollover cannot lift a drawdown stop, only re-arm its budget', () => {
    // the stop lifts on venue evidence through liftOnSignal and on nothing else. A
    // rollover that cleared halts is how the deleted cap used to behave, and inheriting
    // that would resume a losing bot at midnight for no reason at all.
    let now = T
    const r = new RiskManager(BigInt(1e17), () => now)
    r.halt('drawdown 0.112 ETH from peak', 'drawdown')
    now = NEXT
    r.rollDay()
    expect(r.halted).toBe(true)
    expect(r.haltKind).toBe('drawdown')
  })
})

describe('the drawdown stop still fires and stays fired', () => {
  it('halts on breach and refuses every resume afterwards', () => {
    const r = new RiskManager(BigInt(1e17))
    // Peak, then fall past the CONFIGURED drawdown limit. Sized from RISK rather than a
    // fixed wei figure: the suite reads .env.example, and a fixed -$107 loss stopped
    // breaching the stop on 2026-09-06 when the limit moved. In ETH since 2026-09-07,
    // which also removes the price from the arithmetic.
    const loss = BigInt(Math.round(RISK.maxDrawdownEth * 1.1 * 1e18))
    r.seedRealized(loss, loss)
    expect(r.halted).toBe(false)
    r.closed(BigInt(75e14), -loss)
    expect(r.halted).toBe(true)
    expect(r.haltKind).toBe('drawdown')
    expect(r.resume('gate')).toBe(false)
    // and it does not lift itself on nothing: liftOnSignal is the only door, and its
    // preconditions are the caller's to prove (bot.ts checkDrawdownResume)
    expect(r.resume('drawdown' as never)).toBe(false)
  })
})

describe('RegimeGate.read fallback when the watcher wrote no verdict', () => {
  // found in review: the fallback used shutAt, the permissive end of the band, so a rate
  // inside 20-25 read as open even though it was never good enough to open the gate
  const mk = (touchPct: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-fallback-'))
    const file = join(dir, 'gate.db')
    const g = makeGateDb(file)
    for (let i = 0; i < 20; i++) g.obs({ token: `t${i}`, curve: `c${i}`, block: i,
      launched_at: 1, peak: 1.3, touch: i < touchPct / 5 ? 1 : 0, at: Date.now() })
    // heartbeat present, but deliberately NO 'gate' verdict row
    g.state('ran_at', String(Date.now()))
    g.close()
    return file
  }

  it('reads shut inside the hysteresis band, where the two thresholds disagree', () => {
    const g = new RegimeGate(mk(20), () => Date.now())
    const r = g.read(20, 25, 10) // openAt, shutAt
    g.close()
    expect(r?.rate).toBe(20)
    expect(r?.state).toBe('shut')
  })

  it('still reads open on a rate that clears the open threshold', () => {
    const g = new RegimeGate(mk(35), () => Date.now())
    const r = g.read(20, 25, 10)
    g.close()
    expect(r?.state).toBe('open')
  })
})

describe('the dashboard gate card must not contradict the bot', () => {
  // found in review: the card replayed `obs` with no heartbeat check, so a watcher that
  // died at 60% touch rendered GATE OPEN in green while the bot sat halted for staleness
  it('reads shut when the watcher has gone quiet, however good the frozen rate looks', async () => {
    const { gateCardState } = await import('../src/telemetry/dashboard.js')
    expect(gateCardState('open', 31 * 60_000)).toEqual({ state: 'shut', stale: true })
    expect(gateCardState('open', null)).toEqual({ state: 'shut', stale: true })
  })

  it('passes the replayed state through while the watcher is alive', async () => {
    const { gateCardState } = await import('../src/telemetry/dashboard.js')
    expect(gateCardState('open', 4 * 60_000)).toEqual({ state: 'open', stale: false })
    expect(gateCardState('shut', 4 * 60_000)).toEqual({ state: 'shut', stale: false })
  })

  it('says nothing rather than shut when there is no history at all', async () => {
    const { gateCardState } = await import('../src/telemetry/dashboard.js')
    expect(gateCardState(null, 4 * 60_000).state).toBeNull()
  })

  /**
   * Second time around the same failure. The card stopped contradicting the bot on the
   * STATE, then dropped the bot's REASON: the live branch hardcoded stale: null, so a halt
   * caused by a stopped systemd job rendered as an ordinary venue shut at whatever rate
   * was frozen in obs when the watcher died. Whoever is on call goes after the venue
   * instead of the watcher, which is the expensive way to spend a night.
   */
  it('carries the bot reason when the bot halted on a dead watcher, not on the venue', async () => {
    const { gateSnapshotFrom } = await import('../src/telemetry/dashboard.js')
    const snap = gateSnapshotFrom({
      state: 'shut', rate: 40, n: 20, dataAgeMs: 1000, source: 'live', liveN: 20,
      at: Date.now(), stale: 'gatewatch is not running (45 min since last run)',
    })
    expect(snap.stale).toBe(true)
    expect(snap.staleReason).toMatch(/not running/)
  })

  it('says not-stale, with no reason, on an ordinary venue shut', async () => {
    const { gateSnapshotFrom } = await import('../src/telemetry/dashboard.js')
    const snap = gateSnapshotFrom({
      state: 'shut', rate: 5, n: 20, dataAgeMs: 1000, source: 'live', liveN: 20, at: Date.now(),
    })
    expect(snap.stale).toBe(false)
    expect(snap.staleReason).toBeNull()
  })
})
