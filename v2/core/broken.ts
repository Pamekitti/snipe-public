/**
 * Is the BOT broken, or is the market bad?
 *
 * Those need opposite answers and nothing else in this repo can tell them apart. Both look
 * identical on every panel: money going out. But a bad market reverses on its own and a bug
 * does not, so one halt lifts itself and the other must never.
 *
 * EVERY REAL LOSS v1 TOOK IN SEPTEMBER WAS THE SECOND KIND. On 09-04 a retry loop burned $101
 * of gas while the book read +$52. On 09-06 the confirmed book dropped every trade after the
 * first in a block, so for five hours the bot sold winners at made-up prices while the same
 * coins were replaying at +14% a launch. Both were found by a person reading numbers, hours in.
 *
 * WHAT MAKES THE MEASUREMENT POSSIBLE. The fold already replays every launch a book would have
 * been allowed to buy, with our own fills stripped, so for any coin we traded there is an
 * independent answer to "what was this worth". If our fills come in far under that answer, the
 * venue paid and we did not.
 *
 * PORTED FROM `v1/src/strategy/broken.ts`, expression for expression, including the choice to
 * compare means rather than pairs. v2 declared `HaltKind` 'broken', ranked it above 'drawdown'
 * in `HALT_RANK`, gave it a `BrokenReading` and a sensor slot, parsed `broken_window` and
 * `broken_factor` — and never computed any of it. A sensor that cannot stop the wallet is not a
 * guard, which is the same defect the venue reading had until 2026-09-16.
 *
 * `factor` is what real money historically makes per unit of replay (0.78 over 463 paired
 * trades in September, 0.80 over 145 in August). The replay pays no gas, no slippage and enters
 * at a fixed block offset, so it is EXPECTED to read high; the alarm is about the residual after
 * that expectation, not about the gap itself. Re-measure it when the stake moves: it was fitted
 * at 0.003-0.01 ETH and the book now trades 0.02.
 */
import { Ring, sensed } from './contracts.js'
import { BROKEN_PAIRS_KEPT } from './config.js'
import { barKey } from './sim.js'
import type { BrokenReading, Position, State } from './state.js'

/** one closed trade beside what the same coin replayed at, both as return on stake */
export type Pair = {
  /** `(proceeds - stake) / stake` for the real trade */
  readonly real: number
  /** the replay's return in stakes at the rung THIS position pinned */
  readonly replay: number
}

/**
 * Compared on the MEANS rather than pair by pair, deliberately.
 *
 * A per-pair gap divided by one trade's stake has tails fat enough to be meaningless: one 2.36x
 * runner moved v1's per-trade mean by 215 points of a single trade's spend. What this asks is
 * whether the BOOK came in under the book the venue offered, which is a question about the sums.
 *
 * Null rather than a number when nothing is usable, because "we cannot measure this" and "the
 * gap is zero" are opposite operator actions.
 */
export function brokenGap(pairs: readonly Pair[], factor: number): BrokenReading | null {
  const usable = pairs.filter((p) => Number.isFinite(p.real) && Number.isFinite(p.replay))
  if (!usable.length) return null
  const mean = (xs: number[]): number => xs.reduce((a, x) => a + x, 0) / xs.length
  const real = mean(usable.map((p) => p.real))
  const replay = mean(usable.map((p) => p.replay))
  return {
    gapPp: 100 * (real - factor * replay),
    n: usable.length,
    realPp: 100 * real,
    replayPp: 100 * replay,
  }
}

/**
 * Pair one closed trade with the replay of the same coin, if both halves exist yet.
 *
 * CALLED FROM BOTH SIDES, FILES EXACTLY ONCE. A trade closes within the hold clock (45s) and its
 * watch settles at `guard.settleMs` (52s), so usually the close is first — but a graduated bag
 * sold through the pool can close long after, and a launch that never settles never pairs. So
 * `closePosition` calls this and so does the settle loop, each looking for the other half. Only
 * the second arrival finds it, and each of the two events happens once per token, so the pair is
 * filed once without needing a seen-set to remember that it was.
 *
 * WHAT IS DELIBERATELY NOT PAIRED:
 *
 *   An ABANDONED row, where a fresh balance read proved the tokens gone with no sale receipt.
 *   Its booked proceeds are zero by design, so pairing it would enter -100 points as though the
 *   coin had been worth nothing, and a boot-time reconciliation of old stranded bags could halt
 *   the wallet on history. Abandonment has its own alert; it is not this measurement's evidence.
 *
 *   A row whose pinned rung is not a column the replay scored, because the bar set moved under
 *   it. Missing data, skipped, exactly as `stakes` is skipped in the venue window.
 */
export function filePair(s: State, token: string): State {
  const t = token.toLowerCase()
  // Both call sites ask, and the argument above says only one can find both halves. This is the
  // belt to that braces: a pair counted twice would weight one coin double in a mean, and the
  // cost of being sure is a scan of a 200-entry ring on a path that runs once a trade.
  for (const p of s.pairs.all()) if (p.token === t) return s
  const pos = closedTradeFor(s, t)
  if (pos === null) return s
  const spend = Number(pos.spendWei)
  if (!(spend > 0)) return s

  // Newest first: a token is entered at most once ever, so the first match is the only one.
  const all = s.cohort.all()
  let replay: number | undefined
  for (let i = all.length - 1; i >= 0; i--) {
    const o = all[i]!
    if (o.token.toLowerCase() !== t) continue
    // The market indicator consumes calibrated outcomes. This detector retains its own
    // independently fitted 0.78 expectation, so feeding it the calibrated value would apply
    // execution friction twice and make a broken bot look healthy.
    const key = barKey(pos.rules.takeProfitMultiple)
    replay = o.rawPerBar?.[key] ?? o.perBar[key]
    break
  }
  if (typeof replay !== 'number' || !Number.isFinite(replay)) return s

  const real = Number(pos.proceedsWei - pos.spendWei) / spend
  s.pairs.push({ token: t, at: s.at, real, replay })
  return refreshBroken(s)
}

/**
 * The closed, proceeds-bearing position for this token, or null.
 *
 * A token is bought at most once ever (`risk.everEntered`), so there is at most one.
 */
function closedTradeFor(s: State, token: string): Position | null {
  for (const p of s.positions.values()) {
    if (!p.closed || p.abandonedAt !== null) continue
    if (p.token.toLowerCase() === token) return p
  }
  return null
}

/**
 * Recompute the reading from the newest window and move the halt.
 *
 * IN THE FOLD, beside the evidence, for the reason the venue verdict is: the old bot's version
 * of this lived in a method that read a database on a timer, so it could go quiet without
 * anything noticing and no replay could reproduce what it had said.
 *
 * A SHORT WINDOW HAS NO OPINION, and that is NOT the venue's fail-closed rule. "We have not
 * paired twenty trades yet" is not evidence that the bot is mispricing, and a detector that
 * halted on its own warmup would stop the wallet every restart for a reason it had not measured.
 * The venue guard fails closed because thin evidence about a MARKET is a reason not to bet; thin
 * evidence about OURSELVES is just thin.
 */
export function refreshBroken(s: State): State {
  const window = s.config.risk.brokenWindow
  const recent = s.pairs.last(window)
  if (recent.length < window) return s
  const reading = brokenGap(recent, s.config.risk.brokenFactor)
  if (reading === null) return s
  stepHalt(s, reading)
  return { ...s, sensors: { ...s.sensors, broken: sensed(reading, s.at, 'fold', reading.n) } }
}

/**
 * Raise the halt, and never clear it.
 *
 * WALLET-WIDE (`book: null`), because a bot that mispriced its exits mispriced them for every
 * policy: the fault is in the code, not in a band. `HALT_RANK` already puts it directly above
 * `drawdown` so that the shared guard reopen cannot run while the cause of the
 * drawdown is still true.
 *
 * IT DOES NOT LIFT ITSELF, AT ALL, and that asymmetry is the whole point of separating this from
 * the venue pause. A bad market reverses on its own; a bug does not, and a gap that drifted back
 * inside the band is a bug that got quieter, not a bug that got fixed. The lift is an explicit
 * operator action, on the tape, with a reason — `clear-broken` in `decide.ts`.
 */
function stepHalt(s: State, r: BrokenReading): void {
  if (s.risk.halts.has('broken')) return
  if (r.gapPp > -s.config.risk.brokenGapPp) return
  const why = `wallet-wide execution gap across ${r.n} paired trades: actual ${r.realPp.toFixed(1)}%, `
    + `modeled replay ${r.replayPp.toFixed(1)}%, adjusted gap ${r.gapPp.toFixed(1)} points; diagnosis required`
  s.risk.halts.set('broken', { kind: 'broken', book: null, reason: why, at: s.at })
}

/**
 * The operator's lift, which takes the evidence with it.
 *
 * THE CLEAR IS THE LIFT, for exactly the reason the drawdown reset clears what its stop measures:
 * leaving the paired window in place would let the next trade to settle recompute the same twenty
 * pairs and re-raise the halt within one launch.
 *
 * THE WINDOW IS DROPPED, NOT ZEROED. Those pairs were measured against a bot that has since been
 * changed, so they describe code that is no longer running, and carrying them into the next window
 * would mix two eras in one mean. The detector starts over and needs a full window of the fixed
 * bot before it can say anything again, which is the honest cost of having said something as
 * strong as "the bot is broken".
 *
 * The caller owns the flat check. This function is the arithmetic of forgetting.
 */
export function clearBroken(s: State): State {
  s.risk.halts.delete('broken')
  return { ...s, pairs: new Ring(BROKEN_PAIRS_KEPT), sensors: { ...s.sensors, broken: null } }
}
