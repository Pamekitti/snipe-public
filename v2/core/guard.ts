/**
 * The last look before a buy, and the venue's own verdict. ONE guard, where there were three.
 *
 * WHAT THE THREE WERE. The old bot had `scenario-guard.ts`, `fresh-recovery.ts` and the
 * regime gate, each with its own vocabulary for "stale", its own window, its own notion of
 * a usable reading, and its own switch. `VENUE_EXECUTION_SCENARIOS` chose between two of
 * them AND separately chose the take-profit source, so flipping it to compare guards also
 * silently changed the exit target and froze the measurement pipeline for 20 minutes.
 *
 * ONE READING SHAPE, ONE STALENESS RULE, ONE WINDOW. A guard that cannot answer says so,
 * with which sensor was silent and how old its last word was. It never falls through to
 * "allowed", and it never falls through to "shut" either: those are different refusals with
 * different buckets, because "we cannot see" and "we can see and it is bad" call for
 * different operator actions.
 *
 * HYSTERESIS IS NOT A TIMER. What stops one lucky scoring round restarting a halted book is
 * the band AND the window it is read over: reopening needs the freshest `recoveryWindow` rows
 * above `openAt`, while staying open needs only the main `window` at or above `shutAt`. A
 * timer would make the guard slower without making it steadier.
 *
 * THE PUMP CHECK RUNS LAST BECAUSE IT COSTS TWO CURVE SIMULATIONS. There is no point paying
 * for them on a launch that eight cheaper checks would have refused.
 */
import { age, no, ok, type Aged, type Ok, type Sensed } from './contracts.js'
import type { GuardSpec } from './config.js'
import { freshCurve, simBuy, type CurveParams, type CurveState } from './curve.js'

/**
 * Read a sensor, or say precisely why you could not.
 *
 * Three distinct refusals, deliberately not collapsed. `unreadable` is our side failing,
 * `no-rows` is the sensor working and having nothing to say, `stale` is a sensor that has
 * stopped updating. The old dashboard rendered all three as a dash and an operator could
 * not tell a dead watcher from a quiet market.
 */
export function readSensor<T>(
  now: number,
  subject: string,
  name: string,
  s: Sensed<T> | null,
  maxAgeMs: number,
): Ok<Aged<T>> {
  if (s === null) return no(now, 'sensor-unreadable', subject, `${name} has never produced a reading`)
  if (s.n !== null && s.n === 0) return no(now, 'sensor-no-rows', subject, `${name} produced a reading over 0 rows`)
  const a = age(now, s)
  if (a.ageMs > maxAgeMs) {
    return no(now, 'sensor-stale', subject, `${name} last read ${Math.round(a.ageMs / 1000)}s ago, over ${Math.round(maxAgeMs / 1000)}s`)
  }
  return ok(a)
}

/**
 * What the two windows say, both drawn from the same rows, newest first.
 *
 * `reachMs` is measured from NOW to the OLDEST row of the main window, not between the rows.
 * A window of fifteen tightly packed launches that stopped arriving two hours ago is stale
 * evidence about right now, and the whole point of the freshness bound is to say so.
 */
export type VenueSums = {
  /** the last `window` scored rows, in stakes */
  readonly mainSum: number
  readonly mainN: number
  /** the last `recoveryWindow` of those same rows, in stakes */
  readonly freshSum: number
  readonly freshN: number
  readonly reachMs: number
}

/**
 * Should a book be open, given what the replay says its launches were worth?
 *
 * THE UNIT IS STAKES, NOT A RATE. Each row is `proceeds / stake - 1` at the take-profit that
 * launch pinned when the watch opened, so a main sum of -2.5 means those launches would have
 * cost two and a half stakes between them. It is a replay result and it can be any sign; a
 * percentage it is not.
 *
 * TWO WINDOWS, ONE BAND. Pausing reads the main window, reopening reads the freshest slice of
 * it. That asymmetry is the selected September 14 rule: a book is paused by a run of bad
 * launches and released by a handful of good RECENT ones, so recovery does not wait for
 * fifteen rows of history to drag itself back above the line.
 *
 * INCOMPLETE EVIDENCE FAILS CLOSED. A book with four scored launches has not shown that
 * the venue is good. Once a complete window has produced a verdict, an old window keeps
 * that verdict instead of treating a quiet period as a loss or as permission to reopen.
 * This does not override the separate log, feed, and cash safety checks at entry.
 *
 * Pure and two-way: the same rule halts and resumes. `isOpen` is an input rather than
 * something inferred, because that is what makes the band asymmetric rather than a single
 * threshold with a dead zone. Both comparisons are STRICT and neither boundary moves
 * anything: exactly at `shutAt` an open book stays open, exactly at `openAt` a shut book
 * stays shut. One lucky scoring round landing on the line must not restart a halted book.
 */
export function venueVerdict(
  spec: GuardSpec,
  sums: VenueSums,
  isOpen: boolean,
): { readonly open: boolean; readonly why: string; readonly fresh: boolean } {
  if (sums.mainN < spec.window) {
    return { open: false, fresh: false, why: `only ${sums.mainN} of ${spec.window} scored; fail closed` }
  }
  if (sums.reachMs > spec.freshMs) {
    return {
      open: isOpen, fresh: false,
      why: `the window reaches back ${Math.round(sums.reachMs / 60_000)}min, over the `
        + `${Math.round(spec.freshMs / 60_000)}min the spec calls fresh; holding the previous ${isOpen ? 'open' : 'shut'} verdict`,
    }
  }
  const main = sums.mainSum.toFixed(2)
  if (isOpen) {
    return sums.mainSum < spec.shutAt
      ? { open: false, fresh: true, why: `${main} stakes over ${sums.mainN}, below the ${spec.shutAt} that pauses` }
      : { open: true, fresh: true, why: `${main} stakes over ${sums.mainN}, at or above the ${spec.shutAt} that pauses` }
  }
  const fresh = sums.freshSum.toFixed(2)
  return sums.freshSum > spec.openAt
    ? { open: true, fresh: true, why: `${fresh} stakes over the last ${sums.freshN}, above the ${spec.openAt} that reopens` }
    : { open: false, fresh: true, why: `${fresh} stakes over the last ${sums.freshN}, not above the ${spec.openAt} needed to reopen` }
}

/**
 * Has this curve already been pumped past what we are willing to pay?
 *
 * The ratio is what a fresh curve would give us for this stake against what the live curve
 * gives us. A launch already four and a half times its opening price is one we are late to,
 * and the measured cost of entering late is the whole reason this check exists.
 *
 * BOTH SIDES COME FROM THE SAME SIMULATION. `simBuy` on `freshCurve(params)` and `simBuy` on
 * the live state, same stake, same timestamp. Comparing a simulated fill against a spot
 * price would cancel no frictions on one side and all of them on the other.
 *
 * A curve that reverts is `guard-sim-failed`, never "allowed": a simulation we could not run
 * is not evidence that the price is fine.
 */
export function pumpCheck(
  now: number,
  token: string,
  params: CurveParams,
  live: CurveState,
  stakeWei: bigint,
  blockTimestamp: bigint,
  maxMultiple: number,
): Ok<{ readonly multiple: number; readonly freshTokens: bigint; readonly liveTokens: bigint }> {
  let freshTokens: bigint
  let liveTokens: bigint
  try {
    freshTokens = simBuy(params, freshCurve(params), stakeWei, blockTimestamp).tokensOut
    liveTokens = simBuy(params, live, stakeWei, blockTimestamp).tokensOut
  } catch (e) {
    return no(now, 'guard-sim-failed', token, `curve simulation reverted: ${String((e as Error).message ?? e)}`)
  }
  if (liveTokens <= 0n) return no(now, 'guard-sim-failed', token, 'the live curve would return zero tokens for this stake')

  // Integer first, float only to report. The comparison is a bigint cross-multiplication so
  // that operands near 1e27 cannot lose precision: the old bot did this division in float64
  // (bot.ts:941) and that is one of the four known bugs the gate reproduces before fixing.
  const scaled = BigInt(Math.round(maxMultiple * 1000))
  const multiple = Number((freshTokens * 1000n) / liveTokens) / 1000
  if (freshTokens * 1000n > liveTokens * scaled) {
    return no(now, 'guard-pumped', token,
      `already ${multiple.toFixed(2)}x its opening price, over the ${maxMultiple}x ceiling`)
  }
  return ok({ multiple, freshTokens, liveTokens })
}
