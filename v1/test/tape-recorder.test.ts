/**
 * The recorder writes what a replay needs, and nothing it does not.
 *
 * THE POINT OF THE TAPE. Every entry price and every exit mark in this bot is computed from
 * confirmed logs PLUS an overlay of unconfirmed sequencer-feed transactions, and the feed
 * was recorded nowhere. That is why no replay has ever reproduced a live decision, and it
 * is the real reason the paper account matched none of 49 real trades: the existing replay
 * rebuilds from eth_getLogs instead, which makes it an independent second opinion rather
 * than a reproduction.
 *
 * THE THREE RULES, each one a scar. Never block the trading loop; never halt trading on a
 * recording failure; never fill the disk. The first two are what these tests pin.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TAPE_SCHEMA, TapeRecorder } from '../src/tape.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rec-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const rec = () => new TapeRecorder(join(dir, 'tape.db'), 'test-run')

describe('push never costs the caller anything', () => {
  it('returns without a writer running, because start() is the caller\'s choice', () => {
    const r = rec()
    expect(() => r.push('feed-block', { block: 1 })).not.toThrow()
    // queued, but NOT numbered: no seq exists until the writer says where the tape ends
    expect(r.health().nextSeq).toBe(0)
    expect(r.health().queued).toBe(1)
  })

  it('drops rather than grows without bound when the writer is not draining', () => {
    // A stalled writer must not be able to grow the trading process's heap. 2,048 is the
    // same ceiling the existing simulation queue settled on, for the same reason.
    const r = rec()
    for (let i = 0; i < 3_000; i++) r.push('clock', {})
    const h = r.health()
    expect(h.queued).toBe(2_048)
    expect(h.dropped).toBe(952)
  })

  it('records nothing once stopped, and stop is idempotent', () => {
    const r = rec()
    r.stop()
    r.push('clock', {})
    expect(r.health().queued).toBe(0)
    expect(() => r.stop()).not.toThrow()
  })
})

describe('seq is never handed out before the writer says where the tape ends', () => {
  /**
   * THE BUG, found live on 2026-09-16 within a minute of the first recording.
   *
   * `seq` started at 0 and `push` incremented it immediately, so events recorded between
   * start() and the writer's `ready` message were numbered from zero. On a fresh tape that
   * is invisible. On a RESTART into an existing tape those seqs already exist, and the
   * writer's `INSERT OR IGNORE` (which is there so a redelivered batch is idempotent)
   * dropped them without a word. A refusal that writes nothing, in the recorder built to
   * prove a rewrite whose whole premise is that refusals must be counted.
   */
  it('queues without numbering until ready, so a restart cannot collide with old seqs', async () => {
    const path = join(dir, 'tape.db')

    // first run: write two events and leave them on the tape
    const first = new TapeRecorder(path, 'run-1')
    first.start()
    try {
      await expect.poll(() => first.health().nextSeq, { timeout: 10_000 }).toBeGreaterThan(0)
      first.push('clock', { n: 1 })
      first.push('clock', { n: 2 })
      await expect.poll(() => first.health().written, { timeout: 10_000 }).toBe(2)
    } finally { first.stop() }

    // second run: push IMMEDIATELY, before the writer can possibly have reported its base
    const second = new TapeRecorder(path, 'run-2')
    second.start()
    second.push('clock', { n: 3 })
    second.push('clock', { n: 4 })
    try {
      await expect.poll(() => second.health().written, { timeout: 10_000 }).toBe(2)
    } finally { second.stop() }

    const db = new Database(path, { readonly: true })
    try {
      const rows = db.prepare('SELECT seq, run, body FROM events ORDER BY seq').all() as Array<{seq:number;run:string;body:string}>
      // all four survived; before the fix the second run's two were silently ignored
      expect(rows.length).toBe(4)
      expect(rows.map((r) => JSON.parse(r.body).n)).toEqual([1, 2, 3, 4])
      expect(rows.map((r) => r.run)).toEqual(['run-1', 'run-1', 'run-2', 'run-2'])
      // and the seqs are strictly increasing across the restart
      expect(rows.map((r) => r.seq)).toEqual([...rows].sort((a, b) => a.seq - b.seq).map((r) => r.seq))
      expect(new Set(rows.map((r) => r.seq)).size).toBe(4)
    } finally { db.close() }
  }, 30_000)

  it('keeps the event\'s own `at`, not the moment it was flushed', async () => {
    const path = join(dir, 'tape.db')
    const r = new TapeRecorder(path, 'run')
    r.start()
    try {
      await expect.poll(() => r.health().nextSeq, { timeout: 10_000 }).toBeGreaterThan(0)
      const before = Date.now()
      r.push('clock', {})
      const after = Date.now()
      await expect.poll(() => r.health().written, { timeout: 10_000 }).toBe(1)
      const db = new Database(path, { readonly: true })
      try {
        const at = (db.prepare('SELECT at FROM events').get() as {at:number}).at
        // stamped when it happened; the flush is up to 25ms later and must not move it
        expect(at).toBeGreaterThanOrEqual(before)
        expect(at).toBeLessThanOrEqual(after)
      } finally { db.close() }
    } finally { r.stop() }
  }, 20_000)
})

describe('the writer is reachable and the schema is the one v2 reads', () => {
  it('writes a feed block end to end, through the forked writer', async () => {
    const path = join(dir, 'tape.db')
    const r = new TapeRecorder(path, 'test-run')
    r.start()
    try {
      // wait for the writer to announce itself rather than sleeping a guessed interval
      await expect.poll(() => r.health().nextSeq, { timeout: 10_000 }).toBeGreaterThan(0)
      r.push('feed-block', { block: 42, timestamp: 999, txs: [{ hash: '0xa', to: '0xb', data: '0xc' }] })
      await expect.poll(() => r.health().written, { timeout: 10_000 }).toBe(1)
    } finally { r.stop() }

    const db = new Database(path, { readonly: true })
    try {
      const row = db.prepare('SELECT seq, run, kind, body FROM events').get() as any
      expect(row).toMatchObject({ run: 'test-run', kind: 'feed-block' })
      const body = JSON.parse(row.body)
      expect(body.block).toBe(42)
      expect(body.txs[0].hash).toBe('0xa')
    } finally { db.close() }
  }, 20_000)

  it('carries the schema v2 asserts against, so two trees read one file', () => {
    // v2/test/tape.test.ts asserts the two copies are byte-identical. This side asserts the
    // string is at least a schema that applies, so a merge cannot leave it syntactically
    // broken and only fail in the other tree.
    const db = new Database(':memory:')
    try {
      expect(() => db.exec(TAPE_SCHEMA)).not.toThrow()
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{name:string}>).map(t => t.name)
      expect(tables).toEqual(['events', 'tape_gaps', 'tape_meta'])
    } finally { db.close() }
  })
})
