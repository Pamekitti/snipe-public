/**
 * The append-only tape. One file, one writer, everything else reads.
 *
 * WHY ITS OWN FILE AND NOT THE EXISTING DATABASE. On 2026-09-14 a capture path on this box
 * wrote 2.2 GB a day into the simulation database and nothing noticed until the disk did. The
 * box has 4.5 GB free of 19 GB today. A feed tape is higher volume than the path that caused
 * that, so it gets its own file, its own retention and its own budget, and it can be deleted
 * whole without touching anything that holds money.
 *
 * THREE LIMITS, NOT ONE. Age alone is not a budget: a busy day inside the window can still
 * fill the disk. So retention is age OR bytes, whichever bites first, and beneath both there
 * is a disk floor at which recording stops.
 *
 * RECORDING STOPS. TRADING DOES NOT. Losing an event costs reproducibility, not correctness,
 * because the live process holds its state in memory either way. Turning a measurement
 * failure into a money halt is exactly the defect that let a failed shadow capture halt the
 * old bot, so every limit here writes a gap and raises a counter and none of them touch the
 * trading path.
 *
 * THESE LIMITS ARE NOT LIVE. `prune` is tested and `DEFAULT_LIMITS` is the intended budget,
 * but nothing in `main.ts` (or anywhere else that writes the live tape) calls `prune` or
 * checks `diskFloorBytes`. The file grows until an operator wires that. The runbook for
 * when, and why a snapshot must exist first, is `v1/DEPLOY.md` under "The tape will need
 * a prune; not today".
 */
import Database from 'better-sqlite3'
import type { Event, GapStream } from '../core/events.js'

/**
 * The schema, as one string, because it is a contract between two trees.
 *
 * `v1/src/tape.ts` writes this tape while the old bot is still the one trading, and
 * `test/tape.test.ts` asserts the two copies of this constant are byte-identical. That is
 * cheaper and more honest than a shared import across two package roots with separate
 * dependency trees.
 */
export const TAPE_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq  INTEGER PRIMARY KEY,
  at   INTEGER NOT NULL,
  run  TEXT    NOT NULL,
  kind TEXT    NOT NULL,
  body TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
CREATE TABLE IF NOT EXISTS tape_gaps (
  id     INTEGER PRIMARY KEY,
  stream TEXT    NOT NULL,
  lo     INTEGER NOT NULL,
  hi     INTEGER NOT NULL,
  reason TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS tape_meta (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`.trim()

export type TapeLimits = {
  /** drop events older than this. 14 days. */
  readonly maxAgeMs: number
  /** drop oldest events past this many bytes of body, whichever bites first. */
  readonly maxBytes: number
  /** stop recording below this much free disk. Recording only; trading is never touched. */
  readonly diskFloorBytes: number
}

export const DEFAULT_LIMITS: TapeLimits = {
  maxAgeMs: 14 * 24 * 3_600_000,
  // 2 GB. MEASURED on 2026-09-16: the live tape wrote 0.30 GB a day (23.3 events a second,
  // almost all of the bytes being `logs` batches at ~1.8 KB, feed blocks being ~73 bytes).
  // 2 GB is 6.6 days at that rate. It was 1 GB, which is 80 hours, against a gate whose
  // MINIMUM is 72 continuous hours and whose preference is 7 days. Eight hours is not
  // margin: one busy day prunes the head of the window the gate is about to read.
  maxBytes: 2_147_483_648,
  // Below 3 GB free, stop recording. Strictly above the tape's own budget, so the tape can
  // never be the thing that eats the cushion it exists to leave. The box had 8.8 GB free.
  diskFloorBytes: 3_221_225_472,
}

export type TapeStats = {
  readonly rows: number
  readonly bytes: number
  readonly firstSeq: number | null
  readonly lastSeq: number | null
  readonly firstAt: number | null
  readonly lastAt: number | null
}

/** What `append` did, so the caller can count rather than guess. */
export type AppendResult = { readonly written: number; readonly firstSeq: number | null; readonly lastSeq: number | null }

export class Tape {
  readonly db: Database.Database
  private readonly insert: Database.Statement
  private readonly insertGap: Database.Statement
  private readonly readBytes: Database.Statement
  private readonly bumpBytes: Database.Statement

  constructor(path: string, readonly limits: TapeLimits = DEFAULT_LIMITS) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    // The writer is a separate process from the trading loop, so a busy tape must wait rather
    // than throw. Five seconds, matching what the old telemetry writer settled on after a
    // 1,000 ms timeout took the observer down on 2026-09-12.
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(TAPE_SCHEMA)
    this.insert = this.db.prepare('INSERT INTO events (seq, at, run, kind, body) VALUES (?,?,?,?,?)')
    this.insertGap = this.db.prepare('INSERT INTO tape_gaps (stream, lo, hi, reason) VALUES (?,?,?,?)')
    this.readBytes = this.db.prepare("SELECT COALESCE(value,'0') v FROM tape_meta WHERE name='bytes'")
    this.bumpBytes = this.db.prepare(
      "INSERT INTO tape_meta (name, value) VALUES ('bytes', ?) ON CONFLICT(name) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + CAST(excluded.value AS INTEGER) AS TEXT)",
    )
    // A tape written before the counter existed, or one whose counter drifted, is repaired
    // once at open. This is the only full scan in the file and it happens at startup, not on
    // any hot path.
    if (this.readBytes.get() === undefined) {
      const { b } = this.db.prepare('SELECT COALESCE(SUM(LENGTH(body)),0) b FROM events').get() as { b: number }
      this.db.prepare("INSERT INTO tape_meta (name, value) VALUES ('bytes', ?)").run(String(b))
    }
  }

  /** The next seq this tape will hand out. Gapless and monotonic, from the tape itself. */
  nextSeq(): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events').get() as { n: number }
    return r.n
  }

  /**
   * Append a batch in one transaction. Either all of it lands or none of it does.
   *
   * Events arrive already stamped with `seq` and `at` by the appender, because the stamp is
   * what the fold orders on and it must not depend on when the writer happened to flush.
   */
  append(events: readonly Event[]): AppendResult {
    if (!events.length) return { written: 0, firstSeq: null, lastSeq: null }
    const run = this.db.transaction((batch: readonly Event[]) => {
      let added = 0
      for (const e of batch) {
        const { seq, at, run: r, kind, ...rest } = e as Event & Record<string, unknown>
        const body = JSON.stringify(rest)
        this.insert.run(seq, at, r, kind, body)
        added += body.length
      }
      // Inside the transaction, so a rolled-back batch cannot leave the counter claiming
      // bytes the tape does not hold.
      this.bumpBytes.run(String(added))
    })
    run(events)
    return { written: events.length, firstSeq: events[0]!.seq, lastSeq: events[events.length - 1]!.seq }
  }

  /** Read forward from a seq. The replay driver's only entry point. */
  read(fromSeq: number, limit = 10_000): Event[] {
    const rows = this.db
      .prepare('SELECT seq, at, run, kind, body FROM events WHERE seq >= ? ORDER BY seq LIMIT ?')
      .all(fromSeq, limit) as Array<{ seq: number; at: number; run: string; kind: string; body: string }>
    return rows.map((r) => ({ seq: r.seq, at: r.at, run: r.run, kind: r.kind, ...JSON.parse(r.body) }) as Event)
  }

  gap(stream: GapStream, lo: number, hi: number, reason: string): void {
    this.insertGap.run(stream, lo, hi, reason)
  }

  stats(): TapeStats {
    const r = this.db
      .prepare('SELECT COUNT(*) rows, MIN(seq) firstSeq, MAX(seq) lastSeq, MIN(at) firstAt, MAX(at) lastAt FROM events')
      .get() as Omit<TapeStats, 'bytes'>
    return { ...r, bytes: this.bytes() }
  }

  /** Body bytes currently held, O(1) from the counter rather than a scan. */
  bytes(): number {
    const r = this.readBytes.get() as { v: string } | undefined
    return r ? Number(r.v) : 0
  }

  /**
   * Age first, then bytes, and never to empty.
   *
   * The byte pass finds the exact seq to keep from with one window function rather than
   * deleting in blocks. Blocks were the first shape of this and they overshot: with a budget
   * smaller than one block, a block-at-a-time delete emptied the tape entirely. The test that
   * caught it is `keeps the newest events when the byte budget bites`.
   *
   * Returns the highest seq dropped, so the caller can record a gap with real bounds instead
   * of discovering later that a range is missing.
   */
  prune(now: number): { readonly byAge: number; readonly byBytes: number; readonly droppedThroughSeq: number | null } {
    const minSeq = () => (this.db.prepare('SELECT MIN(seq) s FROM events').get() as { s: number | null }).s
    const maxSeq = () => (this.db.prepare('SELECT MAX(seq) s FROM events').get() as { s: number | null }).s
    const before = minSeq()

    const cutoff = now - this.limits.maxAgeMs
    const agedBytes = (this.db.prepare('SELECT COALESCE(SUM(LENGTH(body)),0) b FROM events WHERE at < ?').get(cutoff) as { b: number }).b
    const byAge = this.db.prepare('DELETE FROM events WHERE at < ?').run(cutoff).changes
    if (byAge) this.bumpBytes.run(String(-agedBytes))

    let byBytes = 0
    if (this.bytes() > this.limits.maxBytes) {
      // The oldest seq we can keep while staying inside the budget, counting backwards from
      // the newest. Undefined when even the newest single event exceeds the budget, in which
      // case we keep that one event: a tape that deletes everything is worse than one over
      // budget by one row, and the disk floor is the real backstop.
      const edge = this.db.prepare(
        'SELECT seq FROM (SELECT seq, SUM(LENGTH(body)) OVER (ORDER BY seq DESC) AS running FROM events) WHERE running <= ? ORDER BY seq LIMIT 1',
      ).get(this.limits.maxBytes) as { seq: number } | undefined
      const keepFrom = edge?.seq ?? maxSeq()
      if (keepFrom !== null && keepFrom !== undefined) {
        const dropBytes = (this.db.prepare('SELECT COALESCE(SUM(LENGTH(body)),0) b FROM events WHERE seq < ?').get(keepFrom) as { b: number }).b
        byBytes = this.db.prepare('DELETE FROM events WHERE seq < ?').run(keepFrom).changes
        if (byBytes) this.bumpBytes.run(String(-dropBytes))
      }
    }

    const dropped = byAge + byBytes
    if (!dropped) return { byAge, byBytes, droppedThroughSeq: null }
    const after = minSeq()
    // Everything below the new floor is gone; with an empty tape, everything up to the old
    // high-water mark is.
    return { byAge, byBytes, droppedThroughSeq: after !== null ? after - 1 : (before ?? 1) + dropped - 1 }
  }

  close(): void { this.db.close() }
}
