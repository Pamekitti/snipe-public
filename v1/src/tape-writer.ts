/**
 * The tape's only writer. Forked by `tape.ts`, never the trading process.
 *
 * It owns the SQLite handle, the retention and the disk floor. It imports no signing code and
 * is started with no key, so it cannot send a transaction even by accident.
 *
 * WHY A SEPARATE PROCESS. On 2026-09-12 a 5-second timer running a kind-less index scan took
 * 43 seconds and starved the main process; the dead dashboard and the frozen feed were
 * symptoms of that, not separate faults. Any SQLite work the trading loop shares an event
 * loop with is a latency risk, and a tape is the highest-volume writer on this box.
 */
import Database from 'better-sqlite3'
import { statfs } from 'node:fs'
import { TAPE_SCHEMA } from './tape.js'

const arg = process.argv[2]
// Fail loudly on a missing path rather than exiting: a writer that opened `undefined` would
// silently create a file by that name and record into it forever.
if (arg === undefined) throw new Error('tape-writer needs a database path as argv[2]')
const path: string = arg

const MAX_AGE_MS = 14 * 24 * 3_600_000
/**
 * 2 GB. MEASURED, not guessed: the live tape wrote 0.30 GB a day on 2026-09-16 (23.3
 * events a second, of which the bytes are almost all `logs` at ~1.8 KB a batch and the
 * feed blocks are ~73 bytes each). 2 GB is 6.6 days at that rate.
 *
 * WHY NOT 1 GB, which this was. 1 GB is 80 hours, against a gate that needs 72 hours of
 * CONTINUOUS tape as its minimum and 7 days as its preference. Eight hours of margin is
 * not margin: one busy day and the byte budget prunes the head of the very window the
 * gate is about to read, and a gate that silently reads 68 hours is worse than no gate.
 */
const MAX_BYTES = 2_147_483_648
/**
 * Below 3 GB free, stop recording. Recording only; trading is never touched from here.
 *
 * Strictly above the tape's own budget, so the tape can never be the thing that eats the
 * cushion it is supposed to leave. The box had 8.8 GB free when this was set.
 */
const DISK_FLOOR_BYTES = 3_221_225_472
const PRUNE_EVERY_MS = 3_600_000
const DISK_CHECK_EVERY_MS = 60_000

const db = new Database(path)
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')
db.exec(TAPE_SCHEMA)

const insert = db.prepare('INSERT OR IGNORE INTO events (seq, at, run, kind, body) VALUES (?,?,?,?,?)')
const insertGap = db.prepare('INSERT INTO tape_gaps (stream, lo, hi, reason) VALUES (?,?,?,?)')
const readBytes = db.prepare("SELECT value v FROM tape_meta WHERE name='bytes'")
const bumpBytes = db.prepare(
  "INSERT INTO tape_meta (name, value) VALUES ('bytes', ?) ON CONFLICT(name) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + CAST(excluded.value AS INTEGER) AS TEXT)",
)
if (readBytes.get() === undefined) {
  const { b } = db.prepare('SELECT COALESCE(SUM(LENGTH(body)),0) b FROM events').get() as { b: number }
  db.prepare("INSERT INTO tape_meta (name, value) VALUES ('bytes', ?)").run(String(b))
}
const bytes = () => Number((readBytes.get() as { v: string } | undefined)?.v ?? 0)

const writeBatch = db.transaction((events: Array<Record<string, unknown>>) => {
  let added = 0
  for (const e of events) {
    const { seq, at, run, kind, ...rest } = e as { seq: number; at: number; run: string; kind: string }
    const body = JSON.stringify(rest)
    // INSERT OR IGNORE: a redelivered batch after a writer restart must be idempotent rather
    // than abort the whole transaction on the primary key.
    insert.run(seq, at, run, kind, body)
    added += body.length
  }
  bumpBytes.run(String(added))
})

/**
 * Age first, then bytes, and never to empty.
 *
 * The byte pass finds the exact seq to keep from with one window function. Deleting in blocks
 * was the first shape of this and it overshot: with a budget smaller than one block it
 * emptied the tape entirely.
 */
function prune(now: number): void {
  const cutoff = now - MAX_AGE_MS
  const agedBytes = (db.prepare('SELECT COALESCE(SUM(LENGTH(body)),0) b FROM events WHERE at < ?').get(cutoff) as { b: number }).b
  const byAge = db.prepare('DELETE FROM events WHERE at < ?').run(cutoff).changes
  if (byAge) bumpBytes.run(String(-agedBytes))

  let byBytes = 0
  if (bytes() > MAX_BYTES) {
    const edge = db.prepare(
      'SELECT seq FROM (SELECT seq, SUM(LENGTH(body)) OVER (ORDER BY seq DESC) AS running FROM events) WHERE running <= ? ORDER BY seq LIMIT 1',
    ).get(MAX_BYTES) as { seq: number } | undefined
    const keepFrom = edge?.seq ?? (db.prepare('SELECT MAX(seq) s FROM events').get() as { s: number | null }).s
    if (keepFrom !== null && keepFrom !== undefined) {
      const dropBytes = (db.prepare('SELECT COALESCE(SUM(LENGTH(body)),0) b FROM events WHERE seq < ?').get(keepFrom) as { b: number }).b
      byBytes = db.prepare('DELETE FROM events WHERE seq < ?').run(keepFrom).changes
      if (byBytes) bumpBytes.run(String(-dropBytes))
    }
  }
  // A prune is a real loss of reproducibility, so it is recorded as one rather than left for
  // a reader to infer from a hole in the seq range.
  if (byAge + byBytes > 0) {
    const floor = (db.prepare('SELECT MIN(seq) s FROM events').get() as { s: number | null }).s
    insertGap.run('writer', 0, floor === null ? 0 : floor - 1, `retention dropped ${byAge} by age and ${byBytes} by budget`)
  }
}

let recording = true
function checkDisk(): void {
  statfs(path, (err, st) => {
    if (err) return
    const free = Number(st.bavail) * Number(st.bsize)
    if (recording && free < DISK_FLOOR_BYTES) {
      recording = false
      insertGap.run('writer', 0, 0, `disk floor: ${(free / 1e9).toFixed(2)} GB free, below the ${(DISK_FLOOR_BYTES / 1e9).toFixed(1)} GB floor`)
      process.send?.({ type: 'floor', reason: `${(free / 1e9).toFixed(2)} GB free; recording paused, trading unaffected` })
    } else if (!recording && free > DISK_FLOOR_BYTES * 1.25) {
      // Hysteresis, so a disk hovering at the floor does not flap the recorder on and off.
      recording = true
      process.send?.({ type: 'resumed' })
    }
  })
}

process.on('message', (m: any) => {
  try {
    if (m?.type === 'batch') {
      if (!recording) return
      writeBatch(m.events as Array<Record<string, unknown>>)
      process.send?.({ type: 'wrote', n: m.events.length, at: Date.now() })
    } else if (m?.type === 'gap') {
      insertGap.run(String(m.stream), Number(m.lo), Number(m.hi), String(m.reason))
    } else if (m?.type === 'stop') {
      db.close()
      process.exit(0)
    }
  } catch (e) {
    // A write failure is reported and swallowed. The parent counts it; nothing upstream of
    // here may fail because of it.
    process.send?.({ type: 'fault', error: String(e) })
  }
})

const pruneTimer = setInterval(() => { try { prune(Date.now()) } catch (e) { process.send?.({ type: 'fault', error: String(e) }) } }, PRUNE_EVERY_MS)
const diskTimer = setInterval(checkDisk, DISK_CHECK_EVERY_MS)
pruneTimer.unref?.()
diskTimer.unref?.()

// Check the floor BEFORE announcing readiness, so the very first byte is written only if
// there is room for it.
checkDisk()
const { n } = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events').get() as { n: number }
process.send?.({ type: 'ready', nextSeq: n })

// A dead parent must not leave an orphan writer holding the file.
process.on('disconnect', () => process.exit(0))
