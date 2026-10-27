/**
 * Open a new accounting epoch: BOTH drawdown stops start from zero.
 *
 * There are two drawdowns and two stores. The session drawdown (strategy/risk.ts, the one
 * `report` prints) sums every closed row with id > chain_truth.epoch_base_id. The chain
 * drawdown (telemetry/truth.ts) compares the wallet with chain_truth.peak_flat_wei.
 * REBASELINE=1 clears the second and leaves the first alone, and on 2026-08-27 and again
 * on 2026-09-06 the first had to be moved by hand.
 *
 * This was scripts/newepoch.cjs, a hand tool, until 2026-09-07. It moved into src/ because
 * the drawdown stop now lifts itself when the venue proves it is paying again
 * (strategy/risk.ts liftOnSignal), and lifting a stop without resetting what it measures
 * would leave it re-firing on the same peak within one trade. The reset IS the lift. The
 * hand tool is still there and still the way an operator does it deliberately; it now
 * imports this rather than owning a second copy of the transaction.
 *
 * Refuses while a position is open: a row that closes after the boundary but was opened
 * before it would land in the new epoch with the old epoch's stake. The in-process caller
 * checks the same thing in memory first; this is the one that is authoritative, because a
 * row can be open in the database while the memory map is already empty (telemetry/db.ts
 * queues closePosition onto setImmediate, and boot recovery leaves unresolvable rows open).
 */
import type Database from 'better-sqlite3'
import { clearHalt } from './halts.js'

/** the chain-side baseline keys, deleted together so the pair can never half-move */
export const CHAIN_KEYS = ['baseline_wei', 'baseline_block', 'baseline_at', 'peak_flat_wei'] as const

export type EpochResult = {
  was: number
  now: number
  chainPrev: Record<string, string | null>
  /** what the epoch that just closed had booked, for the log line and the audit row */
  realizedWei: bigint
  peakWei: bigint
}

/** The health log supplies the one-time migration from the old memory-only counter. */
export function ddResumeBudget(db: Database.Database, nowMs = Date.now()): number {
  const day = Math.floor(nowMs / 86_400_000)
  const row = db.prepare("SELECT value FROM chain_truth WHERE key='dd_resume_budget'").get() as { value: string } | undefined
  if (row) {
    const state = JSON.parse(row.value) as { day: number; used: number }
    if (!Number.isInteger(state.day) || !Number.isInteger(state.used) || state.used < 0 || state.used > 2) {
      throw new Error('invalid persisted drawdown restart budget')
    }
    if (state.day > day) throw new Error('drawdown restart budget is dated in the future')
    return state.day === day ? state.used : 0
  }
  const hasHealth = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='health'").get()
  const health = hasHealth ? (db.prepare(`SELECT COUNT(*) n FROM health
    WHERE component='drawdown' AND ok=1 AND detail LIKE 'auto-resumed:%' AND at>=? AND at<?`)
    .get(day * 86_400_000, (day + 1) * 86_400_000) as { n: number }).n : 0
  const prevRow = db.prepare("SELECT value FROM chain_truth WHERE key='epoch_base_prev'").get() as { value: string } | undefined
  const prev = prevRow ? JSON.parse(prevRow.value) as { at?: number; why?: string } : null
  const last = prev?.why?.startsWith('drawdown auto-resume:') && Math.floor((prev.at ?? 0) / 86_400_000) === day ? 1 : 0
  return Math.min(2, Math.max(health, last))
}

export function newEpoch(db: Database.Database, why: string, nowMs: number = Date.now(), automatic = false): EpochResult {
  if (!why || !why.trim()) throw new Error('a reason is required: npm run newepoch "why"')
  const open = (db.prepare('SELECT COUNT(*) n FROM positions WHERE closed = 0 AND live = 1').get() as { n: number }).n
  if (open > 0) throw new Error(`${open} open position(s): rerun while flat`)

  const get = (k: string): string | null =>
    ((db.prepare('SELECT value FROM chain_truth WHERE key=?').get(k) as { value: string } | undefined)?.value ?? null)
  const set = (k: string, v: string): void => {
    db.prepare('INSERT OR REPLACE INTO chain_truth (key,value) VALUES (?,?)').run(k, v)
  }

  const was = Number(get('epoch_base_id') ?? 0)
  const now = (db.prepare('SELECT COALESCE(MAX(id),0) m FROM positions').get() as { m: number }).m
  // what the closing epoch booked, so the audit row can stand on its own
  let realized = 0n
  let peak = 0n
  for (const r of db.prepare(
    `SELECT COALESCE(onchain_pnl_wei, pnl_wei, '0') p FROM positions
     WHERE id > ? AND live = 1 AND closed = 1 ORDER BY exit_at, id`,
  ).all(was) as Array<{ p: string }>) {
    realized += BigInt(r.p)
    if (realized > peak) peak = realized
  }
  const chainPrev = Object.fromEntries(CHAIN_KEYS.map((k) => [k, get(k)]))

  const tx = db.transaction(() => {
    if (automatic) {
      const used = ddResumeBudget(db, nowMs)
      if (used >= 2) throw new Error('daily drawdown restart budget exhausted')
      set('dd_resume_budget', JSON.stringify({ day: Math.floor(nowMs / 86_400_000), used: used + 1 }))
    }
    set('epoch_base_prev', JSON.stringify({
      was, now, at: nowMs, why,
      realized_wei: realized.toString(), peak_wei: peak.toString(), chain: chainPrev,
    }))
    set('epoch_base_id', String(now))
    set('epoch_note', `epoch ${now} opened ${new Date(nowMs).toISOString()}: ${why}`)
    for (const k of CHAIN_KEYS) db.prepare('DELETE FROM chain_truth WHERE key=?').run(k)
    // The reset IS the lift, so the stored halt set has to lose the drawdown stop in the
    // same transaction. Out of process (scripts/newepoch.ts) there is no RiskManager to
    // announce it, and without this line the operator's hand reset would be undone by the
    // restart that follows it.
    clearHalt(db, 'drawdown')
  })
  tx()
  return { was, now, chainPrev, realizedWei: realized, peakWei: peak }
}
