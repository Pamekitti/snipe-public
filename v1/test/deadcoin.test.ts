/**
 * The dead-coin bailout: a coin that has not printed the bar by `afterMs` never will.
 *
 * Measured on a full-path replay of all 291 epoch trades (2026-08-19): 100% of
 * take-profit winners on the filtered book had reached 1.02x (sim scale) by 25s and 98%
 * by 20s, while the farm duds drain the curve to ~0.63 by the 45s clock, with the drain
 * mostly done by 30s. So waiting out the clock on a flat coin pays full price for a
 * verdict that was in at 20s. See STRATEGY.deadCoin for the numbers and the honest cost
 * (win rate falls; this is disaster insurance bought with many small premiums).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { evaluate } from '../src/strategy/exit.js'
import { STRATEGY } from '../src/config.js'
import { mkPosition as mk } from './helpers/position.js'

const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

/**
 * `afterMs` is 0 as of 2026-08-27, which switches the rule OFF. The mechanism is still
 * here and still tested, because it is a knob we expect to want back if the coin
 * lifecycle compresses again. Enabling it for a test means writing through the const
 * assertion on STRATEGY, so it is done in one place with a guaranteed restore.
 */
const withBailout = <T>(afterMs: number, fn: () => T): T => {
  const slot = STRATEGY.deadCoin as { afterMs: number }
  const was = slot.afterMs
  slot.afterMs = afterMs
  try {
    return fn()
  } finally {
    slot.afterMs = was
  }
}
const ON = 20_000

describe('the dead-coin bailout is ON at 20s', () => {
  it('is armed at the value the replay put it at', () => {
    // 0 -> 20_000 on 2026-08-27, reverting the disable. Every live trade booked with this
    // rule on sits in the 795-trade +$161.87 era; every trade booked with it off sits in
    // the 30-trade -$86.46 one. See config.ts deadCoin for why the replay that argued for
    // switching it off was measuring a 1.0373 bar rather than the 1.03 one.
    expect(STRATEGY.deadCoin.afterMs).toBe(20_000)
  })

  it('0 would mean "immediately", which is why the short-circuit exists', () => {
    // The failure this guards, and the reason the disable was spelled as a 0 rather than a
    // deletion: `now - openedAt >= 0` is true on the very first tick, so a bare 0 without
    // exit.ts's short-circuit sells EVERY position instantly. Still true, still guarded.
    withBailout(0, () => {
      expect(evaluate(mk(), 100n, 0, false)).toBeNull()
      expect(evaluate(mk(), 100n, 1, false)).toBeNull()
      expect(evaluate(mk(), 100n, ON, false)).toBeNull()
    })
  })

  it('bails a flat coin at 20s rather than paying the full clock for the same verdict', () => {
    expect(evaluate(mk(), 100n, ON - 1, false)).toBeNull()
    expect(evaluate(mk(), 100n, ON, false)).toBe('dead')
  })
})

describe('the mechanism, exercised with the bailout switched on', () => {
  it('fires on a flat position once afterMs has passed', () => {
    withBailout(ON, () => expect(evaluate(mk(), 100n, ON, false)).toBe('dead'))
  })

  it('does not fire a millisecond early', () => {
    withBailout(ON, () => expect(evaluate(mk(), 100n, ON - 1, false)).toBeNull())
  })

  it('judges the PEAK, not the current mark: a coin that printed the bar and came back is not dead', () => {
    withBailout(ON, () => {
      const p = mk()
      // crossed the bar early (104 > 103), then faded back below it
      expect(evaluate(p, 104n, 5_000, false)).toBeNull()
      expect(evaluate(p, 95n, ON + 5_000, false)).toBeNull()
    })
  })

  it('sits exactly on the bar: at the bar is alive, under it is dead', () => {
    withBailout(ON, () => {
      // belowMult 1.03 on entryMark 100 puts the bar at 103
      expect(evaluate(mk(), 103n, ON, false)).toBeNull()
      expect(evaluate(mk(), 102n, ON, false)).toBe('dead')
    })
  })

  it('never outranks the exits that matter: tp, stop and the clock all win', () => {
    withBailout(ON, () => {
      expect(evaluate(mk(), 125n, 25_000, false)).toBe('tp')
      expect(evaluate(mk(), 50n, 25_000, false)).toBe('stop')
      expect(evaluate(mk(), 100n, STRATEGY.maxHoldMs, false)).toBe('time')
    })
  })

  it('restores the shipped value, so test order cannot leak a live rule change', () => {
    withBailout(0, () => undefined)
    expect(STRATEGY.deadCoin.afterMs).toBe(ON)
  })
})

describe('the parameters stay where the replay put them', () => {
  it('fires inside the hold when enabled, or it is not a bailout', () => {
    expect(ON).toBeLessThan(STRATEGY.maxHoldMs)
  })

  it('keeps the bar low: at a replayed bar of 1.10 the same rule LOSES $25-50', () => {
    // slow winners hover under +10% for 20s+ before popping; only a barely-above-entry
    // bar separates dead coins from them. See STRATEGY.deadCoin.
    expect(STRATEGY.deadCoin.belowMult).toBeGreaterThan(1)
    expect(STRATEGY.deadCoin.belowMult).toBeLessThanOrEqual(1.05)
  })
})

describe('recon replays the rule each row actually ran', () => {
  it('the bot pins the rule onto the position at open, and the row and the runtime read the SAME pin', () => {
    // This used to assert that the row was written from STRATEGY directly, which was half
    // the story and the wrong half: the row said one rule while evaluate() went on reading
    // the globals every tick, so a change mid-hold moved the bot's rule and not the row's.
    // Both now come from one currentExitRules() snapshot taken once at open.
    const bot = src('../src/bot.ts')
    expect(bot).toMatch(/const rules = currentExitRules\(\)/)
    expect(bot).toMatch(/dead_after_ms:\s*rules\.deadCoinAfterMs/)
    expect(bot).toMatch(/dead_below:\s*rules\.deadCoinBelowMult/)
    // and the same object goes onto the position
    expect(bot).toMatch(/newPosition\(\{[\s\S]*?\brules,/)

    // evaluate() reads the pin, never the global: a config change must not move the clock,
    // the hard stop or the bailout under a bag that is already held.
    const exit = src('../src/strategy/exit-evaluation.ts')
    const ev = exit.slice(exit.indexOf('export function evaluate('))
    const body = ev.slice(0, ev.indexOf('\n}'))
    // comments still point at STRATEGY for the evidence; the CODE must not read it
    const code = body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/STRATEGY\./)
    for (const f of ['maxHoldMs', 'hardStopMultiple', 'deadCoinAfterMs', 'deadCoinBelowMult']) {
      expect(body, `evaluate does not read pos.rules.${f}`).toContain(`pos.rules.${f}`)
    }
  })

  it('the schema carries the pinned copy', () => {
    const db = src('../src/telemetry/db.ts')
    expect(db).toMatch(/dead_after_ms/)
    expect(db).toMatch(/dead_below/)
  })

  it('recon.py reads the pinned rule and replays a dead branch from it', () => {
    const rp = src('../scripts/recon.py')
    expect(rp).toMatch(/dead_after_ms/)
    expect(rp).toMatch(/"dead"/)
    // NULL rows predate the bailout and must replay WITHOUT one: no fallback constant
    expect(rp).not.toMatch(/LEGACY_DEAD/)
  })
})
