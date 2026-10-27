/**
 * The gate's measuring stick must not follow the exit policy.
 *
 * Both gatewatch.py and the in-process cohort scorer used to read takeProfitMultiple as
 * the bar for "did the venue produce a winner". It reads well and it is a trap: the ruler
 * then moves whenever the policy moves, so the touch rate stops being comparable with its
 * own history OR with the openAt/shutAt thresholds calibrated against it.
 *
 * Measured over all 485 scored observations before this was split: moving the take profit
 * 1.21 -> 1.25 with the gate thresholds untouched would have taken the share of rolling-20
 * windows below shutAt from 6.9% to 14.8%, and below openAt from 30.3% to 43.6%. The gate
 * roughly doubles its halt rate and no gate setting was edited.
 *
 * These tests exist so that re-coupling them is a red suite rather than a silent regime
 * change discovered days later.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { STRATEGY } from '../src/config.js'
import { touchedBar } from '../src/strategy/cohort.js'

const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

describe('the gate bar is decoupled from the take profit', () => {
  it('exposes its own threshold', () => {
    expect(typeof STRATEGY.gate.touchMultiple).toBe('number')
    expect(STRATEGY.gate.touchMultiple).toBeGreaterThan(1)
  })

  it('stays pinned where openAt and shutAt were calibrated', () => {
    // shutAt 10 sits at the 0th percentile of the 1.21 touch distribution and openAt 25 at
    // the 2.3rd. Move this and those two numbers are measuring something else.
    expect(STRATEGY.gate.touchMultiple).toBe(1.21)
  })

  it('does not silently track the exit policy', () => {
    // they are allowed to be equal by coincidence, but the gate must not be DEFINED as the
    // take profit. This catches the case where someone "simplifies" the config back.
    const cfg = src('../src/config.ts')
    expect(cfg).not.toMatch(/touchMultiple:\s*STRATEGY\.takeProfitMultiple/)
    expect(cfg).not.toMatch(/touchMultiple:\s*takeProfitMultiple/)
  })

  it('scores the cohort against the gate bar, not the take profit', () => {
    const bot = src('../src/bot.ts')
    expect(bot).toMatch(/touchedBar\([^)]*STRATEGY\.gate\.touchMultiple\)/)
    expect(bot).not.toMatch(/touchedBar\([^)]*STRATEGY\.takeProfitMultiple\)/)
  })

  it('publishes the gate bar for gatewatch under its own key', () => {
    const bot = src('../src/bot.ts')
    expect(bot).toMatch(/gateTouchMultiple:\s*STRATEGY\.gate\.touchMultiple/)
  })

  it('gatewatch reads that key and never falls back to the take profit', () => {
    const gw = src('../scripts/gatewatch.py')
    expect(gw).toMatch(/TOUCH\s*=\s*float\(spec\.get\("gateTouchMultiple"/)
    // the old line is what re-introduced the coupling; it must be gone entirely
    expect(gw).not.toMatch(/spec\.get\("takeProfitMultiple"/)
  })
})

/**
 * The bar was only half of it. The gate's ruler has two dimensions, HOW FAR (touchMultiple)
 * and HOW LONG (holdMs), and only the first was decoupled on the first pass. Shortening
 * maxHoldMs from 45s to 30s would have re-measured every touch rate over a shorter window
 * and re-gated the bot against thresholds calibrated at 45s, with nobody editing a gate
 * setting: exactly the failure gateTouchMultiple was split out to prevent.
 */
describe('the gate window is decoupled from the exit clock', () => {
  it('exposes its own hold, pinned where openAt and shutAt were calibrated', () => {
    expect(STRATEGY.gate.holdMs).toBe(45_000)
  })

  it('does not silently track maxHoldMs', () => {
    const cfg = src('../src/config.ts')
    expect(cfg).not.toMatch(/holdMs:\s*STRATEGY\.maxHoldMs/)
    expect(cfg).not.toMatch(/holdMs:\s*maxHoldMs/)
  })

  it('observes the cohort for the gate window, not the exit window', () => {
    const bot = src('../src/bot.ts')
    expect(bot).toMatch(/OBSERVE_MS\s*=\s*STRATEGY\.gate\.holdMs/)
    expect(bot).not.toMatch(/OBSERVE_MS\s*=\s*STRATEGY\.maxHoldMs/)
  })

  it('publishes the gate window for gatewatch under its own key', () => {
    expect(src('../src/bot.ts')).toMatch(/gateHoldMs:\s*STRATEGY\.gate\.holdMs/)
  })

  it('gatewatch derives HOLD from that key and never from the exit clock', () => {
    const gw = src('../scripts/gatewatch.py')
    // HOLD is the gate's observation window, a measurement, and it comes from gateHoldMs
    expect(gw).toMatch(/\bHOLD = int\(\s*round\(float\(spec\.get\("gateHoldMs"/)
    // no assignment to the bare HOLD may mention the exit clock. \b keeps EXIT_HOLD out of
    // this match: _ is a word character, so there is no boundary before its H.
    expect(gw).not.toMatch(/\bHOLD = [^\n]*maxHoldMs/)
    // The adaptive take profit (2026-09-05) replays the bot's EXIT rule per bar, and that
    // replay legitimately runs on the exit clock, read into its own constant. This is the
    // one place gatewatch may read maxHoldMs, and it must never be the window.
    expect(gw).toMatch(/\bEXIT_HOLD = int\(round\(float\(spec\.get\("maxHoldMs"/)
    // and the peak, which IS the gate's measurement, is still taken inside HOLD, not EXIT_HOLD
    expect(gw).toMatch(/max\(p\[1\] for p in P\["pts"\] if p\[0\] <= HOLD\)/)
  })
})

/**
 * The measurement itself, guarded at the source. test/venuemark.test.ts proves WHY the
 * ratio has to be mid-over-entry-price; this proves the bot still computes it that way.
 * A markToExit/markToExit ratio cancels every friction, starts at 1.000 instead of 0.9930,
 * and makes 1.21 a 0.70% looser bar than gate.db's, which is +0.7pp of touch rate on an
 * unchanged venue and always in the direction that keeps the gate open.
 */
describe('the bot scores the venue on gatewatch\'s scale', () => {
  it('anchors on the fee-inclusive entry price, not on a net-of-everything exit mark', () => {
    const bot = src('../src/bot.ts')
    expect(bot).toMatch(/entryMark\s*=\s*entryPrice\(sizeWei,\s*sim\.tokensOut\)/)
    expect(bot).not.toMatch(/entryMark\s*=\s*markToExit\(/)
  })

  it('peaks on the raw mid, the same series gatewatch replays', () => {
    expect(src('../src/bot.ts')).toMatch(/peak\s*=\s*midPrice\(params,\s*sim\.next\)/)
  })
})

/**
 * gatewatch.py is the WRITER of gate.db. Anything that can make it write by accident is a
 * trading-safety problem, not a style one.
 */
describe('importing gatewatch.py cannot make it score', () => {
  it('guards its entry point, so an import does not hit the RPC or write gate.db', () => {
    // found by tripping it: a one-line `import gatewatch` to read TOUCH and HOLD ran a
    // full scoring pass, wrote obs rows, stamped ran_at and rewrote the gate state row,
    // racing the systemd timer for the write lock
    const gw = src('../scripts/gatewatch.py')
    expect(gw).toMatch(/if __name__ == "__main__":\s*\n\s*main\(\)/)
    // and the bare call must be gone, not merely shadowed
    expect(gw).not.toMatch(/^main\(\)\s*$/m)
  })
})

describe('touchedBar is a pure comparison against whatever bar it is handed', () => {
  const entry = 1_000_000_000_000_000_000n

  it('is true only at or above the bar', () => {
    expect(touchedBar(entry, (entry * 121n) / 100n, 1.21)).toBe(true)
    expect(touchedBar(entry, (entry * 120n) / 100n, 1.21)).toBe(false)
  })

  it('gives a different answer for the same launch when the bar moves, which is the point', () => {
    const peak = (entry * 123n) / 100n
    expect(touchedBar(entry, peak, 1.21)).toBe(true)
    expect(touchedBar(entry, peak, 1.25)).toBe(false)
  })
})
