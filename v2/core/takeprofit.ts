/**
 * Which take-profit rung a position opens with.
 *
 * TWO RULES, AND THEY ARE THE SAME RULE.
 *
 *   UNKNOWN MEANS COLD. No reading, a stale one, or a window too short to be the trailing-N
 *   all take the coldest bar. Falling through to the configured default is the tempting
 *   shape and it is wrong in the one direction that costs money: it puts every launch in
 *   the first N after a restart on the hottest setting with no evidence at all.
 *
 *   PINNED AT OPEN. The rung is chosen once and stored on the position. Re-reading it per
 *   tick would let a regime that flips mid-hold move the exit target under an open bag,
 *   which is neither what was measured nor something a test can pin down.
 *
 * DIRECTION OF THE COUPLING MATTERS. This is indicator -> take profit, a deliberate policy
 * input. It must never become take profit -> indicator, and what keeps it one-way is that
 * the guard's column is FROZEN PER LAUNCH: each watch records the answer this selector gave
 * at that moment and the venue sum adds up those frozen columns. Re-reading today's argmax
 * across yesterday's rows is the circular version, where the ruler moves with the thing it
 * measures. `guard.pnlBar` is no longer in that path at all: since 2026-09-17 a watch pins
 * through `rungNow` exactly as an entry does, so warmup takes the coldest bar on both sides
 * and `pnlBar` survives only as the column `tools/genesis.ts` seeds historic rows at.
 *
 * `ready` is returned from HERE, beside the two conditions that decide it, because the
 * replay needs the same answer and a second copy of these conditions elsewhere is exactly
 * how a limit and its filter drift apart. A fallback multiple is a guess, and a guess must
 * never enter a guard's tape as though it were a measured target.
 */
import { age, type Sensed } from './contracts.js'
import type { BookSpec, TakeProfitSpec } from './config.js'
import type { BarsReading } from './state.js'
import { barKey } from './sim.js'

/** one scored launch's return at each bar, keyed by `barKey`: {"1.36": 0.052, ...} */
export type BarOutcomes = Readonly<Record<string, number>>

/**
 * Re-exported, not redefined. There was a second copy of `b.toFixed(2)` here and one in
 * `sim.ts`, which is two places for a rule whose whole job is that a bar has exactly one key.
 */
export { barKey }

/**
 * THE ADAPTIVE BAR: whichever bar earned the most across the trailing window.
 *
 * Every way of not knowing returns the fallback with `ready: false`: no rows, fewer than
 * `window` of them, or rows carrying none of the bars currently traded (the bar set changed
 * under them).
 *
 * Ties go to the LOWEST bar. `sum > bestSum` is strict and the bars are ascending, so the
 * first one wins. That matches the research's Python `max()` over an ascending list and it
 * is also the conservative direction, which is why the strictness is not an accident.
 */
export function adaptiveBar(
  rows: readonly BarOutcomes[] | null,
  spec: TakeProfitSpec,
): BarsReading {
  const { adaptiveWindow: window, adaptiveBars: bars, otherwise: fallback } = spec
  const halfLife = spec.adaptiveHalfLife ?? 0
  const lossCap = spec.adaptiveLossCap ?? 0
  const profitCap = spec.adaptiveProfitCap ?? 0
  if (!rows || rows.length < window) {
    return { multiple: fallback, ready: false, why: `only ${rows?.length ?? 0} of ${window} scored` }
  }
  const recent = rows.slice(0, window)
  const keys = bars.map(barKey)
  if (!recent.every((r) => keys.some((k) => Number.isFinite(r[k])))) {
    return { multiple: fallback, ready: false, why: 'rows carry none of the traded bars' }
  }
  let best = bars[0]!
  let bestSum = -Infinity
  let weightSum = 0
  for (let i = 0; i < recent.length; i++) weightSum += halfLife > 0 ? 2 ** (-i / halfLife) : 1
  for (let i = 0; i < bars.length; i++) {
    const k = keys[i]!
    let sum = 0
    for (let rowIndex = 0; rowIndex < recent.length; rowIndex++) {
      const r = recent[rowIndex]!
      const raw = Number.isFinite(r[k]) ? r[k]! : 0
      const clippedLow = lossCap > 0 ? Math.max(-lossCap, raw) : raw
      const clipped = profitCap > 0 ? Math.min(profitCap, clippedLow) : clippedLow
      const weight = halfLife > 0 ? 2 ** (-rowIndex / halfLife) : 1
      sum += clipped * weight
    }
    sum /= weightSum
    if (sum > bestSum) { bestSum = sum; best = bars[i]! }
  }
  const method = halfLife > 0 || lossCap > 0 || profitCap > 0
    ? `weighted h${halfLife || 'off'}, clip -${lossCap || 'off'}/+${profitCap || 'off'}`
    : 'raw equal-weight'
  return { multiple: best, ready: true, why: `best of last ${window} = ${best.toFixed(2)} (${bestSum.toFixed(3)}/launch, ${method})` }
}

/** The coldest rung, which is also the answer whenever the regime is unknown. */
export function coldest(spec: TakeProfitSpec): number {
  return spec.adaptiveBars.length ? Math.min(...spec.adaptiveBars) : spec.otherwise
}

/**
 * The rung a position opening right now should pin, given the sensor and its age.
 *
 * `ageMs` and `maxAgeMs` are passed rather than read from a clock, because core/ has no
 * clock: the caller holds `state.at` and the reading holds its own `at`.
 *
 * A reading that is not `ready` is not merely ignored, it is reported as the coldest rung
 * WITH its reason, so the funnel and the projection can both say why a cold bar was taken.
 */
export function pinTakeProfit(
  reading: BarsReading | null,
  ageMs: number | null,
  maxAgeMs: number,
  spec: TakeProfitSpec,
): BarsReading {
  const cold = coldest(spec)
  if (reading === null) return { multiple: cold, ready: false, why: 'no bars reading' }
  if (!reading.ready) return { multiple: cold, ready: false, why: reading.why }
  if (ageMs === null || !(ageMs >= 0)) return { multiple: cold, ready: false, why: 'bars reading has no usable age' }
  if (ageMs > maxAgeMs) return { multiple: cold, ready: false, why: `bars reading ${Math.round(ageMs / 1000)}s old, over ${Math.round(maxAgeMs / 1000)}s` }
  return reading
}

/**
 * THE RUNG THIS BOOK WOULD PIN RIGHT NOW. One implementation, two callers, and that is the
 * whole point of the function existing.
 *
 * A REAL ENTRY AND A WATCH MUST PIN THE SAME NUMBER. The entry pins it onto the position and
 * the watch freezes it as the column the venue sum will read, so if the two disagree the
 * indicator is measuring a policy the bot does not trade. They DID disagree until 2026-09-17:
 * `decide` called `pinTakeProfit` (unknown means cold, 1.25) while `openObservation` fell
 * through to `guard.pnlBar` (1.75). With `guard.window` 15 and `adaptiveWindow` 20, every row
 * of the first window after a restart is pinned during warmup, so the guard's first verdict —
 * the one deciding whether the book opens at all — was taken entirely at a bar no entry in
 * that same hour would have used.
 *
 * `now` is `state.at`, never a clock, which is why the age is computed here and not inside
 * `pinTakeProfit`.
 */
export function rungNow(
  now: number,
  reading: Sensed<BarsReading> | null,
  book: BookSpec,
): BarsReading {
  return pinTakeProfit(
    reading?.value ?? null,
    reading === null ? null : age(now, reading).ageMs,
    book.guard.maxReadingAgeMs,
    book.takeProfit,
  )
}
