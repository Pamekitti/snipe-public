/**
 * Which take profit a launch gets, given the venue.
 *
 * Pure, and separate from both the gate and the exit loop, because it is a policy
 * decision that has to be argued about on its own. See STRATEGY.takeProfit for the
 * measurement; the short version is that raising the bar only pays when enough coins that
 * clear the low bar go on to clear the high one, the trailing gate rate forecasts that
 * conversion rate, and below ~25% the trade inverts and a high bar loses money.
 *
 * TWO RULES, and both of them are the same rule:
 *
 *   UNKNOWN MEANS COLD. No reading, a stale one, or a window too short to be the
 *   trailing-20 all take the coldest rung. Falling through to the default is the tempting
 *   shape and it is wrong in the one direction that costs money: it puts every launch in
 *   the first 20 after a gate restart on the hottest setting on no evidence at all.
 *
 *   PINNED AT OPEN. The rung is chosen once, when the position opens, and stored on the
 *   position. It must not be re-read per tick: a regime that flips mid-hold would move the
 *   exit target under an open bag, which is neither what was measured nor something a test
 *   can pin down.
 *
 * DIRECTION OF THE COUPLING MATTERS. This adds gate -> take profit, which is a deliberate
 * policy input. It must never reintroduce take profit -> gate, which was the measurement
 * contamination split out in STRATEGY.gate.touchMultiple: the gate's bar stays pinned at
 * 1.21 whatever any rung here says, or the ruler moves with the thing it is measuring.
 * test/gatebar.test.ts and test/dyntp.test.ts guard the two directions separately.
 */
import { STRATEGY } from '../config.js'

export type TakeProfitPolicy = {
  readonly schedule: ReadonlyArray<{ readonly below: number; readonly multiple: number }>
  readonly otherwise: number
  readonly maxRateAgeMs: number
}

/** what the caller knows about the venue at the moment a position opens */
export type RateSample = {
  /** trailing touch rate in percent, or null for no opinion */
  rate: number | null
  /** how many launches that rate was computed over */
  n: number
  /**
   * Age of the READING, ms: how long since we last asked the gate. Deliberately NOT
   * GateReading.dataAgeMs, the age of the newest launch inside the window.
   *
   * The distinction decides how often the fallback fires and it is easy to get backwards.
   * gatewatch only scores launches that PASSED the book, so a dry spell starves the window
   * while everything stays healthy: dataAgeMs was measured at 151 minutes on 2026-08-19
   * 05:00 with nothing wrong. Bounding on that would drop us to the coldest rung through
   * every quiet stretch.
   *
   * More importantly it would not match the study. The research attaches to each launch
   * the 20 observations strictly before its block with no time bound at all (see
   * tpwhy.py rate_at, in archive/purged-sims-20260827.tar.gz), so "the trailing 20, however old" IS the quantity
   * the cuts at 25/35 were fitted on. Bounding it here would make the live rung selection
   * a different rule from the measured one.
   *
   * What this bound is actually for is the cache in bot.ts: a reading refreshed on every
   * settle and every 30s housekeeping tick that suddenly stops refreshing means the gate
   * loop itself has stalled, and that IS a reason to distrust the number.
   */
  ageMs: number
  /** the gate could not be read at all (watcher down, file missing) */
  stale?: boolean
}

/** one scored launch's outcome at each bar: {"1.36": 0.052, ...}, mult minus 1 */
export type BarOutcomes = Readonly<Record<string, number>>

/** the key gatewatch writes for a bar, so 1.5 and 1.50 cannot become two keys */
export const barKey = (b: number): string => b.toFixed(2)

/**
 * THE ADAPTIVE BAR. Whichever bar earned the most across the trailing window, pinned at
 * open. Every way of not knowing returns `fallback`: no reading, fewer than `window` rows
 * scored under this schema (the column is NULL on rows from before it existed), or rows
 * that carry none of the bars we trade (the bar set changed under them). Ties go to the
 * lowest bar, which is what the research's Python max() did on an ascending list, and
 * which is also the conservative direction. See STRATEGY.takeProfit.adaptive.
 */
export function adaptiveTakeProfit(
  rows: ReadonlyArray<BarOutcomes> | null,
  window: number,
  bars: ReadonlyArray<number>,
  fallback: number,
  // `ready` says the multiple came from EVIDENCE rather than from the flat fallback. It is
  // returned from HERE, beside the two conditions that decide it, because the replay needs
  // the same answer and a second copy of these conditions elsewhere is how a limit and its
  // filter drift apart. A fallback multiple is a guess, and a guess must never enter the
  // guard's tape as though it were a measured target.
): { multiple: number; why: string; ready: boolean } {
  if (!rows || rows.length < window) {
    return { multiple: fallback, why: `adaptive: only ${rows?.length ?? 0} of ${window} scored`, ready: false }
  }
  const recent = rows.slice(0, window)
  const keys = bars.map(barKey)
  if (!recent.every((r) => keys.some((k) => Number.isFinite(r[k])))) {
    return { multiple: fallback, why: 'adaptive: rows carry none of the traded bars', ready: false }
  }
  let best = bars[0]!, bestSum = -Infinity
  for (let i = 0; i < bars.length; i++) {
    const k = keys[i]!
    let sum = 0
    for (const r of recent) sum += Number.isFinite(r[k]) ? r[k]! : 0
    if (sum > bestSum) { bestSum = sum; best = bars[i]! }   // strict: first (lowest) wins ties
  }
  return { multiple: best, why: `adaptive: best of last ${window} = ${best.toFixed(2)} (${(bestSum / window).toFixed(3)}/launch)`, ready: true }
}

/** the coldest rung, which is also the answer whenever we do not know the regime */
export function coldestTakeProfit(p: TakeProfitPolicy = STRATEGY.takeProfit): number {
  return p.schedule.length ? p.schedule[0]!.multiple : p.otherwise
}

/**
 * The rung for a known rate. Rungs are half-open from below: `rate < below` takes that
 * rung, so a rate sitting exactly on a cut takes the WARMER side. Arbitrary but fixed, and
 * fixed is the part that matters -- the research script uses the identical comparison.
 */
export function takeProfitForRate(rate: number, p: TakeProfitPolicy = STRATEGY.takeProfit): number {
  for (const step of p.schedule) if (rate < step.below) return step.multiple
  return p.otherwise
}

/**
 * The whole decision, including every way of not knowing.
 *
 * `window` is the window the rate is supposed to cover (STRATEGY.gate.window). A rate over
 * 3 launches and a rate over 20 are different questions, and the cuts at 25/35 were
 * measured on the trailing 20, so a short window is treated as no answer rather than
 * blended in. Same argument RegimeGate.read() already makes about its own fallback.
 */
export function takeProfitFor(
  s: RateSample | null,
  window: number,
  p: TakeProfitPolicy = STRATEGY.takeProfit,
): { multiple: number; why: string } {
  const cold = coldestTakeProfit(p)
  if (!s || s.rate == null) return { multiple: cold, why: 'no gate reading' }
  if (s.stale) return { multiple: cold, why: 'gate stale' }
  if (!Number.isFinite(s.rate)) return { multiple: cold, why: 'gate rate not finite' }
  if (s.n < window) return { multiple: cold, why: `only ${s.n} of ${window} scored` }
  if (!(s.ageMs >= 0) || s.ageMs > p.maxRateAgeMs) {
    return { multiple: cold, why: `reading ${Math.round(s.ageMs / 1000)}s old` }
  }
  return { multiple: takeProfitForRate(s.rate, p), why: `gate ${s.rate.toFixed(1)}%` }
}
