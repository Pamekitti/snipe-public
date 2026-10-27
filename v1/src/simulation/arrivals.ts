/**
 * When the bot SAW each log, kept in memory and written out once per opportunity.
 *
 * Until 2026-09-14 every chain log was captured as its own immutable row: 935,876 rows and
 * 719 MB in twenty hours, 50,418 distinct addresses. The replay reads back one thing from
 * them (processor.ts, `arrivals`): the wall-clock arrival of `transactionHash:logIndex` for
 * ONE curve over the four minutes around its launch. Log bodies come from eth_getLogs, not
 * from here. So 84% of those bytes were never read, and the 16% that were are three numbers
 * per log.
 *
 * The ring holds the last half hour of arrivals in the main process. When an opportunity's
 * window closes its curve's slice is promoted into a single `curve-arrivals` capture, which
 * is what the replay reads. Nothing is deleted from `captures`: the immutability triggers in
 * store.ts stay intact, because the volume never enters that table in the first place.
 */

/** [transactionHash, logIndex, observedAtMs] */
export type ArrivalTuple = [string, number, number]

export type CurveArrivals = {
  version: 1
  curve: string
  from: number
  through: number
  /** true when the process was stopping and the window had not closed yet */
  partial: boolean
  horizonMs: number
  n: number
  arrivals: ArrivalTuple[]
}

/**
 * The window closes at entry + 180 s (processor.ts `endAt`); promote five seconds later so
 * the write lands before the job becomes eligible at +190 s.
 *
 * The old query also read a 60 s tail past `endAt`, which only ever caught logs the feed
 * delivered late during a stall. Those windows are already marked incomplete through `gaps`,
 * and waiting for the tail would delay every paper result by another minute, so the tail is
 * deliberately dropped: an unmatched log falls back to a modeled arrival exactly as before.
 */
export const ARRIVAL_PROMOTE_MS = 185_000
/** How long the replay waits for a promotion before accepting modeled arrivals. */
export const ARRIVAL_GRACE_MS = 15_000
export const ARRIVAL_HORIZON_MS = 30 * 60_000

type Entry = { address: string; tx: string; index: number; at: number }

/**
 * Arrival-ordered, pruned from the head. `at` comes from the feed batch, so it is
 * non-decreasing in practice; the prune tolerates a stamp that goes backwards by keeping
 * everything within `horizonMs` of the newest stamp seen.
 */
export class ArrivalRing {
  private entries: Entry[] = []
  private newest = 0
  constructor(readonly horizonMs = ARRIVAL_HORIZON_MS) {}

  get size(): number { return this.entries.length }

  push(address: string, tx: string, logIndex: number, at: number): void {
    if (!address || !tx || !Number.isFinite(logIndex) || !Number.isFinite(at)) return
    this.entries.push({ address: address.toLowerCase(), tx, index: Number(logIndex), at })
    if (at > this.newest) this.newest = at
    const floor = this.newest - this.horizonMs
    let drop = 0
    while (drop < this.entries.length && this.entries[drop]!.at < floor) drop++
    if (drop) this.entries.splice(0, drop)
  }

  /**
   * Earliest arrival per `tx:logIndex`, matching the old `ORDER BY at` plus first-seen-wins
   * read. A log redelivered by a backfill must not overwrite the live observation.
   */
  window(address: string, from: number, through: number): ArrivalTuple[] {
    const want = String(address).toLowerCase()
    const best = new Map<string, ArrivalTuple>()
    for (const e of this.entries) {
      if (e.address !== want || e.at < from || e.at > through) continue
      const key = e.tx + ':' + e.index
      const prior = best.get(key)
      if (!prior || e.at < prior[2]) best.set(key, [e.tx, e.index, e.at])
    }
    return [...best.values()].sort((a, b) => a[2] - b[2] || a[1] - b[1])
  }
}

export function promoteArrivals(ring: ArrivalRing, curve: string, from: number, through: number, partial: boolean): CurveArrivals {
  const arrivals = ring.window(curve, from, through)
  return { version: 1, curve, from, through, partial, horizonMs: ring.horizonMs, n: arrivals.length, arrivals }
}

/** The shape the replay wants: `transactionHash:logIndex` to the moment the bot saw it. */
export function arrivalMap(payload: CurveArrivals | null | undefined): Map<string, number> {
  const out = new Map<string, number>()
  if (!payload || payload.version !== 1 || !Array.isArray(payload.arrivals)) return out
  for (const row of payload.arrivals) {
    if (!Array.isArray(row) || row.length < 3) continue
    const [tx, index, at] = row
    if (typeof tx !== 'string' || !Number.isFinite(index) || !Number.isFinite(at)) continue
    const key = tx + ':' + Number(index)
    if (!out.has(key)) out.set(key, Number(at))
  }
  return out
}
