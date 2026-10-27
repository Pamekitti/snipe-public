import Database from 'better-sqlite3'
/**
 * Retention for the four `bot.db` tables that nothing reads back after a few days.
 *
 * Measured on the box 2026-09-15, `bot.db` at 538 MB: `shadow_source_logs` 123.4 MB in 123,466
 * rows, `shadow_jobs` 114.2 MB across five config ids, `shadow_decisions` 31.9 MB growing at
 * 8 MB/day. None of it is evidence anyone reads at that age, and none of it was ever pruned.
 *
 * Deliberately NOT in shadow-worker.ts or shadow-account.ts: both are hashed into SHADOW_KERNEL,
 * so a line in either changes every config id and drops the certificate. Deleting rows no reader
 * reads changes no arithmetic. Same reasoning as shadow-coverage.ts and the index in
 * shadow-service.ts.
 *
 * `launches` is not here and must not be. bot.ts:373 seeds the deployer registry from it on every
 * boot, and deployers.json is frozen at block 39,528,127, so the table is the only record of
 * everything since. Dropping a row, passed or rejected, silently lowers `priorLaunches` and
 * reopens the book the filter exists to close. It is also not the problem: 2,500 rows a day at
 * about 266 bytes is 0.7 MB/day.
 */

export const SOURCE_LOG_RETENTION_MS = 48 * 3_600_000
export const DECISION_RETENTION_MS = 8 * 86_400_000
export const JOB_ARCHIVE_MS = 48 * 3_600_000
const CHUNK = 2_000

export type RetentionReport = { sourceLogs: number; jobs: number; decisions: number; skipped: number }

/**
 * `shadow_source_logs` has no timestamp, only (curve, block, idx), so age comes from the block.
 * Returns the lowest block whose header is inside the window, or null when no header qualifies,
 * in which case nothing is deleted.
 */
export function sourceLogFloor(db: Database.Database, now: number, retainMs = SOURCE_LOG_RETENTION_MS): number | null {
  try {
    const row = db.prepare('SELECT MIN(block) b FROM shadow_headers WHERE timestamp>=?')
      .get(Math.floor((now - retainMs) / 1000)) as { b: number | null } | undefined
    return row && Number.isSafeInteger(row.b) ? row.b : null
  } catch { return null }
}

/**
 * Delete in bounded chunks, yielding between them, so a live trading loop never waits on us.
 * `budgetMs` is wall clock and is measured here, not from the caller's `now`: the age predicates
 * take a supplied timestamp so tests can place rows in a fictional past, and mixing the two was
 * a real bug in the first draft of this file.
 */
async function chunked(db: Database.Database, sql: string, params: unknown[], budgetMs: number): Promise<number> {
  const stmt = db.prepare(sql)
  const deadline = Date.now() + budgetMs
  let total = 0
  for (;;) {
    const n = stmt.run(...(params as [])).changes
    total += n
    if (n < CHUNK || Date.now() >= deadline) break
    await new Promise(resolve => setImmediate(resolve))
  }
  return total
}

/**
 * The only reader of `shadow_source_logs` is shadow-worker.ts, which compares a log against a
 * prior copy to catch a reorg. `if (prior && ...)` means a missing row skips the comparison and
 * writes fresh, so deleting one fails open: it cannot throw, cannot latch source_fault, cannot
 * shut the gate. Past 48 h the block is settled and already frozen into a published request.
 */
export async function pruneSourceLogs(db: Database.Database, now: number, budgetMs: number): Promise<number> {
  const floor = sourceLogFloor(db, now)
  if (floor === null) return 0
  return chunked(db, `DELETE FROM shadow_source_logs WHERE rowid IN
    (SELECT rowid FROM shadow_source_logs WHERE block<? LIMIT ${CHUNK})`, [floor], budgetMs)
}

/**
 * Blank the two replay payloads on finished jobs of dead configs. Rows stay, `intent` stays:
 * dashboard-policy.ts reads `intent` with no time filter, and the row itself carries the pnl.
 *
 * Scoped by config, not by age alone, because scripts/verify-shadow.ts selects every published
 * row of the LIVE config with no time window and does JSON.parse(row.request).coverage. A NULL
 * there is a TypeError, not a skip, so that config could never be certified again. Config ids
 * roll over about daily, so the age-only rule freed nothing anyway: zero published rows on the
 * box were older than seven days.
 */
export async function archiveJobs(db: Database.Database, liveConfig: string, now: number, budgetMs: number): Promise<number> {
  if (!liveConfig) return 0
  return chunked(db, `UPDATE shadow_jobs SET request=NULL,result=NULL WHERE id IN
    (SELECT id FROM shadow_jobs WHERE config<>? AND status IN ('published','rejected')
      AND (request IS NOT NULL OR result IS NOT NULL)
      AND COALESCE(published_at,available,entry)<? LIMIT ${CHUNK})`,
    [liveConfig, now - JOB_ARCHIVE_MS], budgetMs)
}

/** The dashboard's longest lookback is seven days (LOOKBACKS in dashboard.ts). Eight is a day of margin. */
export async function pruneDecisions(db: Database.Database, now: number, budgetMs: number): Promise<number> {
  return chunked(db, `DELETE FROM shadow_decisions WHERE rowid IN
    (SELECT rowid FROM shadow_decisions WHERE at<? LIMIT ${CHUNK})`, [now - DECISION_RETENTION_MS], budgetMs)
}

export async function runRetention(db: Database.Database, opts: { now: number; liveConfig: string; budgetMs?: number }): Promise<RetentionReport> {
  const budget = opts.budgetMs ?? 5_000
  const out: RetentionReport = { sourceLogs: 0, jobs: 0, decisions: 0, skipped: 0 }
  // SQLITE_BUSY is the expected outcome when the shadow worker holds the table. Not an error:
  // the rows are still there and the next hour finds them.
  try { out.sourceLogs = await pruneSourceLogs(db, opts.now, budget) } catch { out.skipped++ }
  try { out.jobs = await archiveJobs(db, opts.liveConfig, opts.now, budget) } catch { out.skipped++ }
  try { out.decisions = await pruneDecisions(db, opts.now, budget) } catch { out.skipped++ }
  return out
}
