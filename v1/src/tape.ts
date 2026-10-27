/**
 * The tape recorder. Pure addition to the live bot: it observes and never decides.
 *
 * WHAT IT IS FOR. The v2 rewrite replays a recorded tape to prove its decisions match what
 * this bot actually did. That is only possible if the tape contains what a decision read, and
 * today the biggest input is recorded nowhere: every entry price and every exit mark comes
 * from confirmed logs PLUS an overlay of unconfirmed sequencer-feed transactions, and the
 * feed stream is not captured anywhere. This file captures it.
 *
 * THE THREE RULES IT LIVES BY, each one a scar on this box.
 *
 *   Never block the trading loop. The queue is bounded and `push` returns immediately. On
 *   overflow it drops, counts, and records a gap. It never awaits, never throws upward.
 *
 *   Never halt trading on a recording failure. Losing an event costs reproducibility, not
 *   correctness: the live process holds its state in memory either way. A shadow-capture
 *   failure being wired to a money halt is a defect this repo already shipped once.
 *
 *   Never fill the disk. The box runs at 76% with 4.5 GB free, and the last capture path that
 *   grew unchecked here wrote 2.2 GB a day and was found by the disk rather than an alert.
 *   Retention is age OR bytes, and beneath both a free-space floor stops recording.
 *
 * The SQLite work happens in a forked writer (`tape-writer.ts`), never in this process.
 */
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Byte-identical to `v2/io/tape.ts`.
 *
 * Two copies exist because the two trees are separate package roots with separate dependency
 * installs, and importing across them would couple the deploy. `v2/test/tape.test.ts` asserts
 * the two are the same text, so the duplication cannot drift.
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

/** Matches v2's Envelope. `at` is stamped here, once, and never re-read downstream. */
export type TapeEvent = { seq: number; at: number; run: string; kind: string; [k: string]: unknown }

/**
 * A queued event BEFORE it has a seq.
 *
 * `at` is stamped here, at the moment the thing happened, and never re-stamped. `seq` is
 * not assigned until the writer has reported the base, which is the whole point: see
 * `flush`.
 */
type Pending = { at: number; kind: string; body: Record<string, unknown> }

export type RecorderHealth = {
  readonly queued: number
  readonly written: number
  readonly dropped: number
  readonly lastWriteAt: number
  readonly lastError: string | null
  /** false once the writer reported the disk floor was hit. Recording only. */
  readonly recording: boolean
  readonly nextSeq: number
}

/**
 * 2,048 events. The same ceiling the existing simulation queue settled on, and for the same
 * reason: large enough to ride out a writer restart, small enough that a stalled writer
 * cannot grow the trading process's heap without bound.
 */
const QUEUE_LIMIT = 2_048
const FLUSH_MS = 25

export class TapeRecorder {
  private queue: Pending[] = []
  private child: ChildProcess | null = null
  private timer: NodeJS.Timeout | null = null
  /**
   * The next seq to hand out, and null until the writer has told us where the tape ends.
   *
   * THE BUG THIS FIXES, found live on 2026-09-16. `seq` started at 0 and `push` incremented
   * it immediately, so every event recorded between `start()` and the writer's `ready`
   * message got a seq counted from zero. On a FRESH tape that is harmless. On a restart
   * into an existing tape those seqs already exist, and the writer's `INSERT OR IGNORE`
   * (which is there so a redelivered batch is idempotent) dropped them without a word. A
   * refusal that writes nothing is the exact fault this whole rewrite exists to remove, and
   * it was in the recorder built to prove the rewrite.
   *
   * Holding the number until the base is known costs nothing: the events keep queueing with
   * their real `at`, and the bounded queue with its recorded gap is what covers a writer
   * that never arrives.
   */
  private seq: number | null = null
  private written = 0
  private dropped = 0
  private lastWriteAt = 0
  private lastError: string | null = null
  private recording = true
  private stopped = false
  /** the lo of the current drop run, so one gap covers a burst rather than one per event */
  private dropFrom = 0

  constructor(private readonly path: string, private readonly run: string) {}

  start(): void {
    if (this.stopped || this.child) return
    const entry = fileURLToPath(new URL('./tape-writer.ts', import.meta.url))
    this.child = fork(entry, [this.path], {
      execArgv: ['--import', 'tsx'],
      // The writer must never be able to sign or send. It gets no key and no live mode, the
      // same belt-and-braces the simulation worker already uses.
      env: { ...process.env, PRIVATE_KEY: '', MODE: 'observe', LIVE: '0' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    this.child.on('message', (m: any) => {
      // Math.max, not assignment: a writer that restarts mid-run must never hand back a seq
      // this recorder has already used.
      if (m?.type === 'ready') { this.seq = Math.max(this.seq ?? 0, Number(m.nextSeq) || 1); this.lastError = null }
      else if (m?.type === 'wrote') { this.written += Number(m.n) || 0; this.lastWriteAt = Number(m.at) || 0 }
      else if (m?.type === 'floor') { this.recording = false; this.lastError = String(m.reason) }
      else if (m?.type === 'resumed') { this.recording = true; this.lastError = null }
      else if (m?.type === 'fault') this.lastError = String(m.error)
    })
    // A dead writer must not take the bot with it, and must not leave the queue growing.
    this.child.on('exit', () => { this.child = null; if (!this.stopped) setTimeout(() => this.start(), 1_000) })
    this.child.on('error', (e) => { this.lastError = String(e) })
    this.timer = setInterval(() => this.flush(), FLUSH_MS)
    this.timer.unref?.()
  }

  /**
   * Record one event. Returns immediately, always.
   *
   * The caller writes `this.tape?.push('feed-block', {...})` and never checks a result: a
   * recorder that can fail a caller is a recorder that can stop a trade.
   */
  push(kind: string, body: Record<string, unknown>): void {
    if (this.stopped || !this.recording) return
    if (this.queue.length >= QUEUE_LIMIT) {
      if (!this.dropped) this.dropFrom = this.seq ?? 0
      this.dropped++
      return
    }
    this.queue.push({ at: Date.now(), kind, body })
  }

  private flush(): void {
    if (!this.child?.connected) return
    // Hold everything until the writer has said where the tape ends. Numbering from zero
    // into an existing tape is silently ignored by the writer's INSERT OR IGNORE, so the
    // events would be gone with no gap to show for them.
    if (this.seq === null) return
    if (this.dropped) {
      // One gap for the whole run of drops, with real bounds, so a reader knows exactly which
      // seq range is not reproducible rather than inferring it from a hole.
      this.child.send({ type: 'gap', stream: 'appender', lo: this.dropFrom, hi: this.seq, reason: `queue overflow, ${this.dropped} events dropped` })
      this.dropped = 0
    }
    if (!this.queue.length) return
    const pending = this.queue
    this.queue = []
    // Numbered here, in arrival order, so the seq a reader folds on is gapless and the `at`
    // it reads is still the moment the event happened rather than the moment it was written.
    const batch: TapeEvent[] = pending.map((e) => ({ seq: this.seq!++, at: e.at, run: this.run, kind: e.kind, ...e.body }))
    this.child.send({ type: 'batch', events: batch })
  }

  health(): RecorderHealth {
    return {
      queued: this.queue.length, written: this.written, dropped: this.dropped,
      lastWriteAt: this.lastWriteAt, lastError: this.lastError,
      recording: this.recording, nextSeq: this.seq ?? 0,
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.flush()
    this.child?.send({ type: 'stop' })
    this.child = null
  }
}
