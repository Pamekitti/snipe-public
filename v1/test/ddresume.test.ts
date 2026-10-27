/**
 * THE DRAWDOWN STOP LIFTING ITSELF (bot.ts checkDrawdownResume).
 *
 * This is the single most dangerous line of code in the tree: unattended, at 3am, it puts
 * money back to work after the kill switch fired. Until 2026-09-07 only a person could do
 * that, and the reason it may now happen automatically is that every precondition below
 * holds. Each test here is one of those preconditions, written as the thing that must
 * never happen rather than as coverage.
 *
 * The measurement behind it: over the week to 2026-09-06 the stop fired four times on
 * ordinary swings and the venue was paying again within 90 minutes each time, while a
 * stop waiting for a person cost a whole day of trading, and once five days.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeGateDb } from './helpers/gatedb.js'
import { settle } from './helpers/settle.js'
import { STRATEGY, RISK } from '../src/config.js'

const HALT_AT = Date.UTC(2026, 8, 7, 12, 0, 0)
const NOW = HALT_AT + 3600_000

describe('the drawdown stop lifts itself, but only on its own terms', () => {
  let dir: string
  let bot: any
  let gate: ReturnType<typeof makeGateDb>

  /**
   * `n` launches scored `after` the given moment, each worth `each` stakes at 1.75x.
   *
   * touch:1 and a fresh heartbeat, so the TOUCH gate reads open. Without them a stale
   * watcher halts the bot under its own kind and `halted` stays true for a reason that has
   * nothing to do with this rule -- which is correct behaviour and a useless fixture.
   */
  const scored = (n: number, each: number, after: number, taxBps = 100, exempt = 3) => {
    // the launches row goes through the Bot's OWN bot.db: the resume evidence is the
    // newest post-halt launches THE BOOK WOULD BUY, joined on these two columns
    const launch = bot.tel.raw().prepare(
      'INSERT OR REPLACE INTO launches (token, creator_tax_bps, exemptions, passed) VALUES (?,?,?,1)')
    for (let i = 0; i < n; i++) {
      const token = `0xs${after}${i}`
      gate.obs({
        token, block: 10_000 + after / 1000 + i,
        launched_at: Math.floor((after + i * 1000) / 1000),
        at: after + 1000 + i, touch: 1, peak: 1.5, bars: JSON.stringify({ '1.75': each }),
      })
      launch.run(token, taxBps, exempt)
    }
  }
  const watcherAlive = () => { gate.state('ran_at', String(Date.now())); gate.state('gate', 'open') }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ddres-'))
    gate = makeGateDb(join(dir, 'gate.db'))
    // GATE_DB must be set BEFORE the Bot is constructed: RegimeGate captures the path in
    // the constructor, and a missing file latches a 60s retry on the first read
    process.env.GATE_DB = join(dir, 'gate.db')
    const { Bot } = await import('../src/bot.js')
    // observe mode so start() is never needed (a live start signs and hits the network);
    // the pieces checkDrawdownResume actually reads are injected below
    bot = new Bot({ mode: 'observe', dbFile: join(dir, 'bot.db') } as any)
    bot.opts.mode = 'live'
    const { TruthKeeper } = await import('../src/telemetry/truth.js')
    bot.truth = new TruthKeeper(bot.tel.raw(), {} as any, {
      wallet: () => '0xw', openCount: () => bot.positions.size, deployedWei: () => 0n,
      onHalt: (r: string) => bot.risk.halt(r, 'drawdown'),
      health: (c: string, ok: boolean, d: string) => bot.tel.health(c, ok, d),
    })
    bot.truth.boot()
    bot.risk.halt('drawdown $240 from peak', 'drawdown')
    // pin the halt clock: the evidence rule is "scored after THIS"
    ;(bot.risk as any).haltedAt.set('drawdown', HALT_AT)
  })

  afterEach(() => {
    delete process.env.GATE_DB
    bot.tel.close()
    gate.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const winners = () => { scored(STRATEGY.gate.ddResumeWindow, 0.5, HALT_AT); watcherAlive() }
  const chainKeys = () => bot.tel.raw()
    .prepare("SELECT COUNT(*) n FROM chain_truth WHERE key IN ('baseline_wei','baseline_block','baseline_at','peak_flat_wei')")
    .get().n

  it('lifts on a full window of post-halt winners, and resets the accounting with it', async () => {
    bot.tel.raw().prepare("INSERT INTO chain_truth (key,value) VALUES ('peak_flat_wei','999')").run()
    winners()
    gate.close()
    // a loss on the books, so the reset has something to clear
    bot.risk.seedRealized(-BigInt(1e17), 0n)

    await bot.housekeeping()
    await settle()

    expect(bot.risk.halted).toBe(false)
    expect(bot.risk.ddLiftsUsed).toBe(1)
    // the reset IS the lift: a stop lifted with its own peak still standing re-fires on
    // the next trade, which would be an unattended loop rather than a resume
    expect(bot.risk.realizedPnlWei).toBe(0n)
    expect(bot.risk.peakPnlWei).toBe(0n)
    expect(chainKeys()).toBe(0)
    const prev = bot.tel.raw().prepare("SELECT value FROM chain_truth WHERE key='epoch_base_prev'").get()
    expect(JSON.parse(prev.value).why).toContain('drawdown auto-resume')
    const row = bot.tel.raw().prepare("SELECT ok, detail FROM health WHERE component='drawdown'").get()
    expect(row.ok).toBe(1)
    expect(row.detail).toContain('scored since the stop')
  })

  it('never lifts on post-halt launches the book would not buy', async () => {
    // 80% of what gatewatch scores is coins the bot declines at entry (untaxed, or under
    // three exempt wallets). A window of those paying is no evidence about OUR coins.
    scored(STRATEGY.gate.ddResumeWindow, 0.5, HALT_AT, 0, 3) // untaxed winners
    scored(STRATEGY.gate.ddResumeWindow, 0.5, HALT_AT + 100_000, 100, 2) // thin-exempt winners
    watcherAlive()
    gate.close()
    await bot.housekeeping()
    await settle()
    expect(bot.risk.halted).toBe(true)
    expect(bot.risk.haltKind).toBe('drawdown')
  })

  it('never lifts on launches scored BEFORE the stop, however good they look', async () => {
    // The rule that matters most. At the moment a stop fires, the newest scored launches
    // are usually the very coins it fired for; on 2026-09-06 those replayed fine while the
    // bot mispriced them, so a naive window would have resumed straight back into the bug.
    scored(STRATEGY.gate.ddResumeWindow * 2, 5, HALT_AT - 7200_000)
    watcherAlive()
    gate.close()
    await bot.housekeeping()
    expect(bot.risk.halted).toBe(true)
    expect(bot.risk.haltKind).toBe('drawdown')
  })

  it('waits for a FULL window rather than acting on the first few', async () => {
    scored(STRATEGY.gate.ddResumeWindow - 1, 9, HALT_AT)
    watcherAlive()
    gate.close()
    await bot.housekeeping()
    expect(bot.risk.halted).toBe(true)
  })

  it.each([0, 0.25, 1])('does not reset accounting when post-stop return is %s stakes', async (sum) => {
    scored(STRATEGY.gate.ddResumeWindow - 1, 0, HALT_AT)
    scored(1, sum, HALT_AT + 100_000)
    watcherAlive()
    gate.close()
    await bot.housekeeping()
    expect(bot.risk.halted).toBe(true)
    expect(bot.risk.ddLiftsUsed).toBe(0)
    expect(bot.tel.raw().prepare("SELECT value FROM chain_truth WHERE key='epoch_base_prev'").get()).toBeUndefined()
  })

  it('never lifts while a position is open, in memory or in the database', async () => {
    winners()
    gate.close()
    // in memory: the map holds it
    bot.positions.set('0xc', { spendWei: 1n } as any)
    await bot.housekeeping()
    expect(bot.risk.halted).toBe(true)
    bot.positions.clear()

    // reserved but not yet a row: a buy in flight has taken capacity and has no id
    bot.risk.reserve('0xtok', 1n)
    await bot.housekeeping()
    expect(bot.risk.halted).toBe(true)
    bot.risk.unreserve(1n)

    // open in the DATABASE while memory is empty: boot recovery leaves rows it could not
    // resolve, and closePosition lands one macrotask late. newEpoch refuses and says so.
    bot.tel.raw().prepare(
      "INSERT INTO positions (id, token, curve, live, closed, spend_wei) VALUES (9001,'0xz','0xz',1,0,'1')",
    ).run()
    await bot.housekeeping()
    await settle()
    expect(bot.risk.halted).toBe(true)
    const blocked = bot.tel.raw().prepare("SELECT ok, detail FROM health WHERE component='drawdown'").get()
    expect(blocked.ok).toBe(0)
    expect(blocked.detail).toContain('open position')

    // and once that row closes, the same tick that used to fail now lifts
    bot.tel.raw().prepare('UPDATE positions SET closed = 1 WHERE id = 9001').run()
    await bot.housekeeping()
    expect(bot.risk.isHalted('drawdown')).toBe(false)
  })

  it('never lifts under a halt that outranks it', async () => {
    winners()
    gate.close()
    bot.risk.halt('we made -7% where the coins replayed at +14%', 'broken')
    await bot.housekeeping()
    expect(bot.risk.halted).toBe(true)
    expect(bot.risk.haltKind).toBe('broken')
    // the epoch must not have moved either: a blocked lift changes nothing at all
    expect(bot.tel.raw().prepare("SELECT value FROM chain_truth WHERE key='epoch_base_prev'").get()).toBeUndefined()
  })

  it('stops lifting after twice in a day, and says it needs a person', async () => {
    winners()
    gate.close()
    ;(bot.risk as any).ddLiftsToday = 2
    await bot.housekeeping()
    expect(bot.risk.halted).toBe(true)
    expect(bot.risk.resumeOutlook().autoResumes).toBe(false)
  })

  it('does nothing at all in shadow mode, where no money moved', async () => {
    winners()
    gate.close()
    bot.opts.mode = 'shadow'
    await bot.housekeeping()
    expect(bot.risk.halted).toBe(true)
  })

  it('leaves a gate or venue halt alone: it lifts its own kind only', async () => {
    winners()
    gate.close()
    bot.risk.halt('venue not paying', 'venue')
    await bot.housekeeping()
    expect(bot.risk.isHalted('drawdown')).toBe(false)
    expect(bot.risk.isHalted('venue')).toBe(true)
    expect(bot.risk.halted).toBe(true)
  })

  it('the limit it fires at is the operator\'s, read live', () => {
    // no test should encode the bound: MAX_DRAWDOWN_ETH is hot and the suite reads .env.example
    expect(RISK.maxDrawdownEth).toBeGreaterThan(0)
    expect(STRATEGY.gate.ddResumeWindow).toBeGreaterThanOrEqual(5)
  })
})
