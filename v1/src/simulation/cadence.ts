/**
 * When the paper report is worth rebuilding.
 *
 * It used to rebuild every 5 s unconditionally. With no index on `kind` that was a 43 s
 * scan running back to back, which starved the trading process on 2026-09-13; with the index
 * it is still 800 ms of every 5 s, 18% of one core forever, and it rewrites a multi-megabyte
 * checkpoint each time on a box with 1.8 GB of page cache to share.
 *
 * Nothing in the report changes unless a capture, a result or a scenario landed, so the
 * rebuild follows the data. The heartbeat does NOT: it still ticks every 5 s, because
 * freshness and validity are different questions and the 15 s staleness bars downstream are
 * asking about the worker being alive, not about the report being recent.
 */
export const REBUILD_FLOOR_MS = 10_000
export const REBUILD_CEILING_MS = 60_000

export type CadenceState = {
  dirty: boolean
  now: number
  builtAt: number
  /** the next moment a `now`-dependent field changes on its own, e.g. a pending job going overdue */
  nextDeadline: number
}

export function shouldRebuild({ dirty, now, builtAt, nextDeadline }: CadenceState): boolean {
  const age = now - builtAt
  if (age < REBUILD_FLOOR_MS) return false
  // The ceiling covers what moves without any write: `through`, the month boundary, and any
  // threshold measured against wall clock rather than against a row.
  return dirty || age >= REBUILD_CEILING_MS || now >= nextDeadline
}
