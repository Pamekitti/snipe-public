/**
 * THE OPERATOR'S STOP AND START, from the dashboard (POST /api/control).
 *
 * Before 2026-09-07 the only stop was HALT=1 in a file on the box, which meant an ssh
 * session, and the thing people actually reach for when that is too slow is `pm2 stop` --
 * which kills the exit managers and strands every open bag (risk.ts haltPhase).
 *
 * The design constraint is that adding a two-way control must not weaken the one-way one.
 * HALT=1 has four independent layers keeping it un-liftable in-process, and all four stay:
 * the control places its OWN kind, 'stopped', which sits below 'drawdown' and 'broken' in
 * the rank so a start press can only ever undo the operator's own stop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiskManager } from '../src/strategy/risk.js'
import { settle } from './helpers/settle.js'
import { controlAction } from '../src/telemetry/dashboard.js'

describe('controlAction decides, and refuses what is not the operator\'s to lift', () => {
  const st = (stopped: boolean, haltKind: any = stopped ? 'stopped' : null) => ({ stopped, haltKind })

  it('stops a running bot', () => {
    expect(controlAction('stop', st(false))).toMatchObject({ do: 'stop', code: 200 })
  })

  it('starts a bot the operator stopped', () => {
    expect(controlAction('start', st(true))).toMatchObject({ do: 'start', code: 200 })
  })

  it('is a no-op, not an error, when the button matches the state', () => {
    // a double tap, or two tabs open, must not read as a failure
    expect(controlAction('stop', st(true))).toMatchObject({ do: 'nothing', code: 200 })
    expect(controlAction('start', st(false))).toMatchObject({ do: 'nothing', code: 200 })
  })

  it('refuses a start while something stickier holds, and names it', () => {
    // THE safety property. The rank check in RiskManager.resume enforces it too; this
    // duplicate exists only so the page can show a sentence rather than a silent no-op.
    for (const kind of ['drawdown', 'broken', 'manual'] as const) {
      const r = controlAction('start', { stopped: true, haltKind: kind })
      expect(r.do).toBe('nothing')
      expect(r.code).toBe(409)
      expect(r.why).toContain(kind)
    }
  })

  it('refuses a body that is not one of the two actions', () => {
    for (const junk of [undefined, null, '', 'STOP', 'halt', 1, {}, ['stop']]) {
      expect(controlAction(junk, st(false))).toMatchObject({ do: 'nothing', code: 400 })
    }
  })
})

describe('the halt kind the control places', () => {
  const rm = () => new RiskManager(BigInt(1e17))

  it('is liftable by the operator and by nothing else', () => {
    const r = rm()
    r.halt('halted by operator: stopped from the dashboard', 'stopped')
    expect(r.halted).toBe(true)
    expect(r.haltKind).toBe('stopped')
    // no venue reading can lift it: those lift their own kinds, and the rank check refuses
    // a lift of anything that is not the stickiest kind currently held
    expect(r.resume('venue')).toBe(false)
    expect(r.resume('gate')).toBe(false)
    expect(r.halted).toBe(true)
    expect(r.resume('stopped')).toBe(true)
    expect(r.halted).toBe(false)
  })

  it('does not auto-resume, so the page never promises it will', () => {
    // resumeOutlook drives the "auto-resumes" wording in the alert and on the card. An
    // operator stop that claimed it would clear itself would be a lie told at 3am.
    const r = rm()
    r.halt('halted by operator', 'stopped')
    expect(r.resumeOutlook()).toEqual({ autoResumes: false, when: null })
  })

  it('cannot lift a drawdown stop or a broken halt sitting above it', () => {
    for (const kind of ['drawdown', 'broken'] as const) {
      const r = rm()
      r.halt(`${kind} holding`, kind)
      r.halt('halted by operator', 'stopped')
      expect(r.haltKind).toBe(kind)
      expect(r.resume('stopped')).toBe(false)   // not the stickiest kind: refused
      expect(r.halted).toBe(true)
    }
  })

  it('leaves HALT=1 exactly as un-liftable as it was', () => {
    // the file's switch is 'manual', and it is in neither lift set. Adding a two-way
    // control must not have widened that, and this is the test that says so.
    const r = rm()
    r.halt('halted by operator (HALT=1)', 'manual')
    expect(r.resume('manual' as never)).toBe(false)
    expect(r.resume('stopped')).toBe(false)
    expect(r.halted).toBe(true)
  })

  it('a venue pause underneath survives the operator starting again', () => {
    // both are true independently: the operator started, the venue is still not paying.
    // Collapsing them would resume entries into a venue the sensor has already shut.
    const r = rm()
    r.halt('venue not paying', 'venue')
    r.halt('halted by operator', 'stopped')
    expect(r.haltKind).toBe('stopped')
    expect(r.resume('stopped')).toBe(true)
    expect(r.halted).toBe(true)
    expect(r.haltKind).toBe('venue')
  })
})

describe('the stop survives the restart that follows it', () => {
  let dir: string
  let bot: any

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ctl-'))
    const { Bot } = await import('../src/bot.js')
    bot = new Bot({ mode: 'observe', dbFile: join(dir, 'bot.db') } as any)
  })
  afterEach(() => { bot.tel.close(); rmSync(dir, { recursive: true, force: true }) })

  it('records the stop, and a fresh process re-places it before trading', async () => {
    // Without this a pm2 restart or a box reboot puts money back to work silently, which
    // is the same trap the "HALT=0 does not apply live" rule prevents, by another door.
    bot.operatorStop('stopped from the dashboard')
    expect(bot.risk.isHalted('stopped')).toBe(true)
    expect(bot.tel.truthGet('operator_stop')).toBe('1')

    const { Bot } = await import('../src/bot.js')
    const restarted = new Bot({ mode: 'observe', dbFile: join(dir, 'bot.db') } as any)
    expect(restarted.risk.halted).toBe(false)   // nothing halted until it reads the row
    restarted.restoreHaltState()
    expect(restarted.risk.halted).toBe(true)
    expect(restarted.risk.haltKind).toBe('stopped')
    restarted.tel.close()
  })

  it('a start clears the record when the market recovery check passes', async () => {
    // BOTH sensors, because operatorStart runs both: checkRegimeGate unconditionally and
    // checkVenue behind VENUE_FRESH_RECOVERY. Stubbing only the P&L one left the touch gate
    // reading `data/gate.db` off disk, which is empty on a laptop and 13 MB of live
    // observations on the box, so this test passed here and failed there. A unit test must
    // not consult the running bot's data.
    bot.gate.readVenue = () => ({ state: 'open', sum: 3, n: 20, fresh: true, oldestAgeMs: 1000, bar: '1.75' })
    bot.gate.read = () => ({ state: 'open', rate: 0.42, n: 20, dataAgeMs: 1000, source: 'live', liveN: 20 })
    bot.gate.readBars = () => null
    bot.operatorStop('stopped from the dashboard')
    bot.operatorStart('started from the dashboard')
    expect(bot.risk.halted).toBe(false)
    expect(bot.tel.truthGet('operator_stop')).toBe('0')

    const { Bot } = await import('../src/bot.js')
    const restarted = new Bot({ mode: 'observe', dbFile: join(dir, 'bot.db') } as any)
    restarted.restoreHaltState()
    expect(restarted.risk.halted).toBe(false)
    restarted.tel.close()
  })

  it('restore never LIFTS anything, whatever the row says', () => {
    // a stored '0' arriving at boot must not clear a halt placed microseconds earlier by
    // HALT=1 or by the seeded ledger. Clearing halts at boot is how a bot un-halts itself.
    bot.tel.truthSet('operator_stop', '0')
    bot.risk.halt('halted by operator (HALT=1)', 'manual')
    bot.restoreHaltState()
    expect(bot.risk.halted).toBe(true)
    expect(bot.risk.haltKind).toBe('manual')
  })

  it('both actions leave an audit row, which push.py reports', async () => {
    bot.operatorStop('stopped from the dashboard')
    bot.operatorStart('started from the dashboard')
    await settle()   // health rows are queued through Telemetry.push, not written inline
    const rows = bot.tel.raw()
      .prepare("SELECT ok, detail FROM health WHERE component='operator' ORDER BY rowid").all()
    expect(rows.map((r: any) => r.ok)).toEqual([0, 1])
    expect(rows[0].detail).toContain('stopped')
  })

  it('a start that RiskManager refuses writes nothing at all', async () => {
    // the guard against a page that says "started" while the bot is still halted
    bot.risk.halt('drawdown 0.112 ETH from peak', 'drawdown')
    bot.operatorStop('stopped from the dashboard')
    bot.operatorStart('started from the dashboard')
    await settle()
    expect(bot.risk.halted).toBe(true)
    expect(bot.tel.truthGet('operator_stop')).toBe('1')
    const started = bot.tel.raw()
      .prepare("SELECT COUNT(*) n FROM health WHERE component='operator' AND ok=1").get()
    expect(started.n).toBe(0)
  })
})

describe('the page carries the controls', () => {
  it('renders both buttons, with no unspliced placeholders left', async () => {
    const { dashboardHtml } = await import('../src/telemetry/dashboard-page.js')
    const h = dashboardHtml()
    for (const id of ['btnStop', 'btnStart', 'ctlMsg']) {
      expect(h, `${id} is missing from the page`).toContain(`id="${id}"`)
    }
    expect(h).toContain('/api/control')
    // the same invariant configdrift pins: a placeholder that never got spliced renders
    // as literal __FOO__ on a page the operator is trying to read
    expect(h.match(/__[A-Z_]+__/g)).toBeNull()
  })

  it('start is a two-tap control, and stop is not', () => {
    // asserted on the source rather than a DOM, because the behaviour that matters is that
    // stop has no confirm step and start does
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const src = readFileSync(new URL('../src/telemetry/dashboard-page.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/btnStop.*post\('stop'\)/s)
    expect(src).toMatch(/startArmed/)
    expect(src).toMatch(/tap again/)
  })
})

/**
 * THE DRAWDOWN RESET, from the dashboard (POST /api/control {"action":"reset"}).
 *
 * DEPLOY.md documents a hand reset for exactly the cases the automatic lift refuses -- a
 * third stop in one UTC day, or a stop sitting under the operator's own -- and until
 * 2026-09-13 that path was ssh plus `npm run newepoch` plus a pm2 restart. On 2026-09-13 it
 * cost a run of the tape that peaked at 4.75x while entries sat off.
 *
 * The reset is NOT the start button with a flag. Its refusals are different: it is offered
 * precisely when a drawdown stop is holding, which is when start is refused.
 */
describe('controlAction: the drawdown reset', () => {
  const st = (o: Partial<{ stopped: boolean; haltKind: any; open: number; drawdownEth: number }> = {}) =>
    ({ stopped: false, haltKind: 'drawdown' as any, open: 0, drawdownEth: 0.06, ...o })

  it('resets while the drawdown stop is the thing holding', () => {
    expect(controlAction('reset', st())).toMatchObject({ do: 'reset', code: 200 })
  })

  it('resets under the operator\'s own stop, which does not outrank the drawdown', () => {
    // HALT_RANK puts 'drawdown' above 'stopped', so haltKind reads 'drawdown' when both
    // hold. This is the 2026-09-13 case exactly: stopped from the page AND drawn down.
    expect(controlAction('reset', st({ stopped: true, haltKind: 'drawdown' })))
      .toMatchObject({ do: 'reset', code: 200 })
    expect(controlAction('reset', st({ stopped: true, haltKind: 'stopped' })))
      .toMatchObject({ do: 'reset', code: 200 })
  })

  it('refuses while a position is open, because the epoch boundary would split it', () => {
    // newEpoch throws on this too (telemetry/epoch.ts); refusing here gives the page a
    // sentence instead of a 500, and it is the same rule, not a looser one.
    const r = controlAction('reset', st({ open: 2 }))
    expect(r).toMatchObject({ do: 'nothing', code: 409 })
    expect(r.why).toContain('flat')
  })

  it('refuses under broken and manual, which are not the operator\'s to wave away', () => {
    // 'broken' is "we are losing where the venue paid". No button clears that.
    for (const kind of ['broken', 'manual'] as const) {
      const r = controlAction('reset', st({ haltKind: kind }))
      expect(r).toMatchObject({ do: 'nothing', code: 409 })
      expect(r.why).toContain(kind)
    }
  })

  it('is a no-op, not an error, when there is no drawdown to reset', () => {
    expect(controlAction('reset', st({ drawdownEth: 0, haltKind: null })))
      .toMatchObject({ do: 'nothing', code: 200 })
  })

  it('still rejects an unknown action', () => {
    expect(controlAction('wipe', st())).toMatchObject({ do: 'nothing', code: 400 })
  })
})

/**
 * THE OPERATOR'S OWN LIFT (risk.liftByOperator), added 2026-09-13 for the dashboard reset.
 *
 * A third door beside resume() and liftOnSignal(), and the reason it is a third door rather
 * than a flag on liftOnSignal is the daily budget. That budget exists to stop the AUTOMATIC
 * rule trading through a day nobody has proven. A budget that also blocked the operator
 * would make DEPLOY.md's hand reset ("a third stop in one day") impossible from the page --
 * the one case it was written for.
 */
describe('liftByOperator: the reset button\'s door', () => {
  it('lifts a drawdown stop without spending a self-lift', () => {
    const r = new RiskManager(BigInt(1e17))
    r.halt('drawdown 0.061 ETH from peak', 'drawdown')
    const before = r.ddLiftsUsed
    expect(r.liftByOperator('drawdown', 'operator reset')).toBe(true)
    expect(r.halted).toBe(false)
    expect(r.ddLiftsUsed).toBe(before)
  })

  it('works when the automatic budget is exhausted, which is the whole point', () => {
    const r = new RiskManager(BigInt(1e17))
    for (let i = 0; i < 2; i++) {
      r.halt('drawdown', 'drawdown')
      expect(r.liftOnSignal('drawdown', 'venue paid')).toBe(true)
    }
    expect(r.ddLiftsExhausted).toBe(true)
    r.halt('drawdown, third of the day', 'drawdown')
    expect(r.liftOnSignal('drawdown', 'venue paid')).toBe(false)   // automatic rule is done
    expect(r.liftByOperator('drawdown', 'operator reset')).toBe(true)
    expect(r.halted).toBe(false)
  })

  it('refuses under broken and manual, which outrank it', () => {
    for (const kind of ['broken', 'manual'] as const) {
      const r = new RiskManager(BigInt(1e17))
      r.halt('drawdown', 'drawdown')
      r.halt('stickier', kind)
      expect(r.liftByOperator('drawdown', 'operator reset')).toBe(false)
      expect(r.halted).toBe(true)
    }
  })

  it('does not lift the operator\'s own stop as a side effect', () => {
    // the reset clears what the stop MEASURES; resuming is still the start button
    const r = new RiskManager(BigInt(1e17))
    r.halt('drawdown', 'drawdown')
    r.halt('stopped from the dashboard', 'stopped')
    expect(r.liftByOperator('drawdown', 'operator reset')).toBe(true)
    expect(r.halted).toBe(true)
    expect(r.haltKind).toBe('stopped')
  })
})
