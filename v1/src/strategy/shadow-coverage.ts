import Database from 'better-sqlite3'
/**
 * Merge `shadow_coverage` into the ranges it actually means.
 *
 * The table records which block ranges the durable source cache has seen per curve, and the
 * only reader (scripts/verify-shadow.ts) walks it in `lo` order asking one question: is
 * [from,to] covered end to end? That answer depends on the UNION of the ranges and on
 * nothing else.
 *
 * The writer, though, inserts one row per pending job per feed poll. The poll runs about
 * 6.7 times a second and the tip advances every time, so a single queued job accrues roughly
 * 24,000 rows an hour describing a window it already covered. On 2026-09-14 the table held
 * 4,884,945 rows for 1,411 curves, one curve with 35,095, and the table plus its primary key
 * came to 628 MB of a 20 GiB disk. Every one of those rows was redundant with the single row
 * the replay writes for the range it verifies.
 *
 * Deliberately NOT in shadow-worker.ts or shadow-account.ts: both are hashed into
 * SHADOW_KERNEL, so a line in either changes every config id, marks queued jobs unavailable
 * and drops the certificate until twenty fresh outcomes land. Merging rows changes no
 * arithmetic, and it should not cost that. Same reasoning as the index in shadow-service.ts.
 */

export type Range = { lo: number; hi: number }

/**
 * Sort by `lo` and merge anything overlapping or touching. Adjacency counts: [1,5] and [6,9]
 * cover [1,9] with no hole, and the verifier's walk (`cursor = max(cursor, hi+1)`) already
 * treats them that way, so merging them changes no verdict.
 */
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const clean = ranges
    .filter(r => Number.isSafeInteger(r.lo) && Number.isSafeInteger(r.hi) && r.hi >= r.lo)
    .sort((a, b) => a.lo - b.lo || a.hi - b.hi)
  const out: Range[] = []
  for (const r of clean) {
    const last = out[out.length - 1]
    if (last && r.lo <= last.hi + 1) last.hi = Math.max(last.hi, r.hi)
    else out.push({ lo: r.lo, hi: r.hi })
  }
  return out
}

/**
 * One curve, one IMMEDIATE transaction. A row the worker inserts between the read and the
 * delete would be lost, so the read has to be inside the write transaction: IMMEDIATE takes
 * the write lock up front and makes that impossible.
 */
export function coalesceCurve(db: Database.Database, curve: string): { before: number; after: number } {
  const read = db.prepare('SELECT lo,hi FROM shadow_coverage WHERE curve=? ORDER BY lo')
  const wipe = db.prepare('DELETE FROM shadow_coverage WHERE curve=?')
  const put = db.prepare('INSERT OR IGNORE INTO shadow_coverage VALUES (?,?,?)')
  return db.transaction(() => {
    const rows = read.all(curve) as Range[]
    const merged = mergeRanges(rows)
    if (merged.length >= rows.length) return { before: rows.length, after: rows.length }
    wipe.run(curve)
    for (const r of merged) put.run(curve, r.lo, r.hi)
    return { before: rows.length, after: merged.length }
  }).immediate()
}

export type CoalesceReport = { curves: number; before: number; after: number; skipped: number }

/**
 * Walk the curves worth merging, one transaction each, yielding between them. The shadow
 * worker writes this table continuously; a curve it happens to be holding is skipped and
 * picked up on the next run rather than waited for, because this runs beside a trading loop.
 */
export async function coalesceCoverage(
  db: Database.Database,
  opts: { minRows?: number; budgetMs?: number; maxCurves?: number } = {},
): Promise<CoalesceReport> {
  const minRows = opts.minRows ?? 8
  const deadline = opts.budgetMs ? Date.now() + opts.budgetMs : Infinity
  const out: CoalesceReport = { curves: 0, before: 0, after: 0, skipped: 0 }
  let targets: Array<{ curve: string }>
  try {
    targets = db.prepare('SELECT curve FROM shadow_coverage GROUP BY curve HAVING COUNT(*)>? ORDER BY COUNT(*) DESC')
      .all(minRows) as Array<{ curve: string }>
  } catch { return out }
  if (opts.maxCurves) targets = targets.slice(0, opts.maxCurves)
  for (const { curve } of targets) {
    if (Date.now() >= deadline) break
    try {
      const r = coalesceCurve(db, curve)
      if (r.after < r.before) { out.curves++; out.before += r.before; out.after += r.after }
    } catch (e) {
      // SQLITE_BUSY is the expected outcome when the worker holds the table. Not an error:
      // the union is unchanged either way, and the next run will find the same curve.
      out.skipped++
    }
    await new Promise(resolve => setImmediate(resolve))
  }
  return out
}

/**
 * The coalescer's own connection. Telemetry's handle waits five seconds on a busy database
 * (db.ts), and inheriting that here would park the trading loop behind the shadow worker.
 * This one gives up in a quarter second and tries again next hour.
 */
export function openCoverageDb(file: string): Database.Database {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 250')
  return db
}
