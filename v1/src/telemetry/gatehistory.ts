/**
 * Regime gate history, reconstructed from gate.db's `obs` table.
 *
 * There are TWO different questions in here and they have different answers, different
 * time axes, and different amounts of history. Conflating them produces a confident,
 * wrong picture, which is exactly what happened on the first attempt at this file.
 *
 *   venueRate()  "was the venue paying?"      x-axis launched_at, spans all history
 *   replayGate() "was the bot allowed to trade?"  x-axis at, spans only since gatewatch ran
 *
 * The venue rate is a real measurement of the market and is valid for every launch ever
 * scored, whenever we got around to scoring it. The gate STATE is a path-dependent state
 * machine, so it only means anything over the period the watcher was actually running.
 *
 * On 2026-08-18 those spanned 24.7h and 6.1h respectively, because 145 of 412 rows were
 * scored in one backfill pass. Drawing the state machine across the backfill produced 20
 * transitions that never happened, including two same-minute flaps. The real answer over
 * the period the gate was live: 61 passes, zero transitions, open throughout.
 *
 * Verified against the live watcher: the newest rate reproduces `gatewatch.py --status`
 * to the decimal. test/gatehistory.test.ts pins that equality.
 *
 * HONEST LIMIT: both replay under the thresholds passed in, not necessarily the ones in
 * force at the time. Threshold changes are recorded in chain_truth.filter_changes, and
 * the dashboard marks them so the seam is visible rather than silent.
 */

/** one scored launch. `at` is when gatewatch SCORED it, in ms; launched_at is seconds. */
import { stepGate } from '../strategy/gate.js'

export type GateObs = { block: number; launched_at: number; at: number; touch: number }
export type GatePoint = { t: number; rate: number; state: 'open' | 'shut'; n: number }
export type Interval = { from: number; to: number | null; label?: string }
export type GateCfg = { window: number; openAt: number; shutAt: number }

/**
 * a pass writes its rows ~0.5s apart (gatewatch.py PAUSE); the next pass is a timer away.
 *
 * 60s -> 20s on 2026-09-07, when the watcher's timer went from 5 minutes to 1. A pass of
 * 25 launches takes ~13s, which at a 1-minute cadence leaves gaps of ~47s: at the old
 * threshold consecutive passes merged into one cluster and this replay stepped the
 * hysteresis once where the real code stepped it twice. 20s still comfortably exceeds the
 * within-pass spacing and comfortably undercuts the between-pass one.
 */
const PASS_GAP_MS = 20_000

/**
 * Replay the gate's verdict over history.
 *
 * ONE HYSTERESIS STEP PER PASS, not per observation. gatewatch.py scores a batch of up to
 * 25 launches and then calls status() exactly once (`main()` -> `status(gate)`), so the
 * state machine only ever advances once per 5-minute run, against the rate computed after
 * the whole batch has landed. Stepping per row instead invents transitions that never
 * happened: it can cross a threshold in the middle of a batch and cross back before the
 * real code ever looked. That produced a plausible-but-wrong timeline with same-minute
 * flaps in it, which is exactly the kind of artifact an operator would act on.
 *
 * Passes are recovered by clustering on `at`, the scoring timestamp. `at` is also the
 * right x-axis: it is when the verdict became KNOWABLE. Plotting against launched_at
 * would draw the gate reacting to launches up to a minute before it could have seen them.
 */
export function replayGate(rows: GateObs[], cfg: GateCfg): GatePoint[] {
  if (!rows.length) return []
  const w = Math.max(1, cfg.window)
  // scoring order is the order the gate learned things, which is what drives the machine
  const byAt = [...rows].sort((a, b) => a.at - b.at)
  const out: GatePoint[] = []
  let state: 'open' | 'shut' = 'shut'
  // The trailing top-w-by-block among everything scored so far -- the ranking
  // gatewatch's rolling() uses -- maintained incrementally with a bounded insertion.
  // The first version re-sorted the whole prefix inside the loop, O(passes x n log n)
  // over a table that only grows, on a 5s tick inside the trading process.
  const top: GateObs[] = []
  const admit = (r: GateObs): void => {
    if (top.length === w && r.block <= top[top.length - 1]!.block) return
    let k = top.length
    while (k > 0 && top[k - 1]!.block < r.block) k--
    top.splice(k, 0, r)
    if (top.length > w) top.pop()
  }
  let i = 0
  while (i < byAt.length) {
    let j = i
    while (j + 1 < byAt.length && byAt[j + 1]!.at - byAt[j]!.at <= PASS_GAP_MS) j++
    for (let k = i; k <= j; k++) admit(byAt[k]!)
    const rate = (100 * top.reduce((a, r) => a + r.touch, 0)) / top.length
    state = stepGate(state, rate, cfg.openAt, cfg.shutAt)
    out.push({ t: byAt[j]!.at, rate, state, n: top.length })
    i = j + 1
  }
  return out
}

/**
 * The venue's touch rate through time: for every launch, the trailing rate over the last
 * `window` launches, plotted on the venue's own clock.
 *
 * No state machine. A rate is a measurement and stays true regardless of when we computed
 * it, so unlike replayGate this is meaningful across backfilled rows and covers the full
 * history. This is the line that answers "is the venue paying", which is the question an
 * operator is actually asking during a drawdown.
 */
export function venueRate(rows: GateObs[], window: number): Array<{ t: number; rate: number; n: number }> {
  const w = Math.max(1, window)
  const byLaunch = [...rows].sort((a, b) => a.block - b.block)
  const out: Array<{ t: number; rate: number; n: number }> = []
  let hits = 0
  for (let i = 0; i < byLaunch.length; i++) {
    hits += byLaunch[i]!.touch
    if (i >= w) hits -= byLaunch[i - w]!.touch // rolling sum, stays linear
    const n = Math.min(i + 1, w)
    out.push({ t: byLaunch[i]!.launched_at * 1000, rate: (100 * hits) / n, n })
  }
  return out
}

/** Collapse a point series into the spans where it held one state, for chart shading. */
export function toIntervals(points: GatePoint[], want: 'open' | 'shut'): Interval[] {
  const out: Interval[] = []
  let open: Interval | null = null
  for (const p of points) {
    if (p.state === want && !open) open = { from: p.t, to: null }
    else if (p.state !== want && open) { open.to = p.t; out.push(open); open = null }
  }
  if (open) out.push(open) // still in this state at the newest observation
  return out
}

/**
 * Halted spans, from health rows written on every halt/resume transition.
 *
 * The gate is only one of three things that can stop entries (operator HALT=1 and the
 * drawdown stop are the others), so gate history alone would draw a bot that looks like
 * it was trading through a halt. `ok` is inverted on purpose: ok=0 means halted, matching
 * the rest of the health table where ok=0 is the bad state.
 */
export function haltIntervals(rows: Array<{ at: number; ok: number; detail: string }>): Interval[] {
  const out: Interval[] = []
  let open: Interval | null = null
  for (const r of rows) {
    if (r.ok === 0 && !open) open = { from: r.at, to: null, label: r.detail }
    else if (r.ok === 1 && open) { open.to = r.at; out.push(open); open = null }
  }
  if (open) out.push(open) // still halted right now
  return out
}

/** Thin a series to at most `max` points, always keeping the newest one. */
export function thin<T>(rows: T[], max = 400): T[] {
  if (rows.length <= max) return rows
  const step = Math.ceil(rows.length / max)
  return rows.filter((_, i) => i % step === 0 || i === rows.length - 1)
}
