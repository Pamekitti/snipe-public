import type Database from 'better-sqlite3'
import type { BookFloors } from '../strategy/gate.js'

/**
 * Is the paper collector still collecting? Separate from whether the trading guard uses
 * paper outcomes, which is VENUE_EXECUTION_SCENARIOS and a different question entirely.
 *
 * THE BAND IS PASSED IN, NOT COMPILED IN. Until 2026-09-16 the `missing` query read
 * `creator_tax_bps>=50 AND exemptions>=3`, the defaults from the era it was written in. The
 * book moved to untaxed-only (0-0 bps) on 2026-09-15, so the filter admitted none of the
 * launches the bot actually buys and `missing` was structurally zero: the one number that
 * says "the collector has stopped seeing coins" could not rise. A sensor is its query, and
 * a query with the book's floors baked into it stops measuring the book the day the book
 * moves. See the same lesson in telemetry/gatehistory.ts and memory "venue sensor measures
 * the book".
 */
export function paperHealth(db: Database.Database, now: number, floors: BookFloors) {
  try {
    const fault = (db.prepare("SELECT value FROM shadow_meta WHERE key='source_fault'").get() as any)?.value ?? null
    const jobs = db.prepare(`SELECT MAX(entry) latest, MAX(close_at) closed,
      SUM(CASE WHEN status IN ('queued','source-error','modeled','unavailable') THEN 1 ELSE 0 END) pending,
      MIN(CASE WHEN status IN ('queued','source-error','unavailable') THEN entry END) oldest
      FROM shadow_jobs`).get() as any
    // Launches the book WOULD have bought that the collector never enqueued. Bounded above
    // by `now-180000` so a coin that launched seconds ago is not counted as missed.
    const missing = jobs.latest == null ? 0 : (db.prepare(`SELECT COUNT(*) n FROM launches l
      WHERE l.launched_at*1000>? AND l.launched_at*1000<? AND l.passed=1
      AND l.creator_tax_bps>=? AND l.creator_tax_bps<=? AND l.exemptions>=?
      AND NOT EXISTS(SELECT 1 FROM shadow_jobs s WHERE s.token=l.token)`)
      .get(jobs.latest, now-180000, floors.minTaxBps, floors.maxTaxBps, floors.minExempt) as any).n
    const repaired = (db.prepare("SELECT value FROM shadow_meta WHERE key='capture_repair'").get() as any)?.value
    return { fault, missing, pending:jobs.pending??0, lastClose:jobs.closed??null,
      stalled:!!fault || missing>0 || (jobs.oldest!=null && now-jobs.oldest>180000),
      historicalCaptureRepair:repaired?JSON.parse(repaired):null }
  } catch { return {fault:'Paper collection status unavailable',missing:0,pending:0,lastClose:null,stalled:true,historicalCaptureRepair:null} }
}
