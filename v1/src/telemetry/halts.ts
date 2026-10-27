/**
 * The halt set, written down.
 *
 * WHY THIS EXISTS. `RiskManager.halts` was memory-only until 2026-09-16. Every pm2 restart
 * and every box reboot built a fresh manager with an empty map, so a bot halted for
 * 'broken' or 'drawdown' came back trading at full size with nothing in the process
 * remembering why it had stopped. Only the operator's stop survived, through its own
 * chain_truth row, and the argument written there ("a stop the operator has to remember to
 * re-apply after every reboot is not a stop") is the same argument for every other kind.
 *
 * What hid it for so long is that four of the six kinds re-fire within 30 seconds: the gate
 * and the venue are re-read on the housekeeping tick, and HALT=1 is re-read from the file.
 * 'drawdown' and 'broken' are the two that do not, and they are precisely the two that mean
 * "this bot is losing money in a way nobody has explained yet".
 *
 * ONE ROW, NOT ONE PER KIND. The halt set is one fact and it is written in one statement,
 * so a crash between two writes cannot leave half a set. It is small (six entries at the
 * absolute most) and read twice per restart.
 *
 * WHAT IT IS NOT. It is not the authority on whether the bot should be halted. Every kind
 * is re-derived from its own source within a tick of boot; this row only covers the gap
 * between the first launch and that tick, and it only ever adds halts. Nothing here can
 * lift one.
 */
import type Database from 'better-sqlite3'
import { isDurable, type HaltKind, type HaltRecord } from '../strategy/risk.js'

/** the chain_truth key. One row, JSON, the whole set. */
export const HALTS_KEY = 'halts'

/** every kind this module is allowed to store, so a typo in the row cannot invent one */
const KNOWN: ReadonlySet<string> = new Set<HaltKind>(['manual', 'broken', 'drawdown', 'stopped', 'gate', 'venue'])

/**
 * Read the stored halt set.
 *
 * A row that will not parse returns empty rather than throwing, and the caller reports it.
 * The alternative is a bot that will not boot because of a corrupt cache row, which trades
 * a gap in coverage for a total outage. Unknown kinds are dropped for the same reason a
 * rolled-back deploy must be able to read a row a newer version wrote.
 */
export function readHalts(db: Database.Database): HaltRecord[] {
  const row = db.prepare('SELECT value FROM chain_truth WHERE key=?').get(HALTS_KEY) as { value: string } | undefined
  if (!row) return []
  let parsed: unknown
  try { parsed = JSON.parse(row.value) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const out: HaltRecord[] = []
  for (const r of parsed as Array<Record<string, unknown>>) {
    const kind = String(r?.kind ?? '')
    if (!KNOWN.has(kind)) continue
    if (!isDurable(kind as HaltKind)) continue
    const at = Number(r?.at)
    if (!Number.isFinite(at) || at <= 0) continue
    out.push({ kind: kind as HaltKind, reason: String(r?.reason ?? ''), at })
  }
  return out
}

/** Replace the stored set. Durable kinds only; the row is the whole truth, so it is a REPLACE. */
export function writeHalts(db: Database.Database, halts: readonly HaltRecord[]): void {
  const durable = halts.filter((h) => isDurable(h.kind))
  db.prepare('INSERT OR REPLACE INTO chain_truth (key,value) VALUES (?,?)').run(HALTS_KEY, JSON.stringify(durable))
}

/**
 * Drop one kind from the stored set, leaving the rest.
 *
 * Used by the epoch reset, which lifts the drawdown stop in a transaction the running
 * process may not be part of (scripts/newepoch.ts runs out of process and the operator
 * restarts afterwards). Without this, a hand reset would be undone by the very next boot.
 */
export function clearHalt(db: Database.Database, kind: HaltKind): void {
  writeHalts(db, readHalts(db).filter((h) => h.kind !== kind))
}
