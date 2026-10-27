/**
 * The tape's storage contract.
 *
 * Two things are being protected. First, that the limits actually bite: the box has 4.5 GB
 * free of 19 GB, and the last time a capture path grew unchecked on this machine it wrote
 * 2.2 GB a day and was found by the disk, not by an alert. Second, that the schema stays
 * identical to the copy the live bot writes with, because for the length of the rewrite two
 * trees write and read the same file.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, TAPE_SCHEMA, Tape, type TapeLimits } from '../io/tape.js'
import type { Event } from '../core/events.js'

let dir: string
let tape: Tape

const open = (limits: TapeLimits = DEFAULT_LIMITS) => new Tape(join(dir, 'tape.db'), limits)

const ev = (seq: number, at: number, kind: Event['kind'] = 'clock', extra: Record<string, unknown> = {}): Event =>
  ({ seq, at, run: 'test', kind, ...extra }) as Event

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tape-')); tape = open() })
afterEach(() => { tape.close(); rmSync(dir, { recursive: true, force: true }) })

describe('append and read', () => {
  it('round-trips an event with its fields intact', () => {
    tape.append([ev(1, 1000, 'feed-block', { block: 42, timestamp: 999, txs: [{ hash: '0xa', to: '0xb', data: '0xc' }] })])
    const [back] = tape.read(1)
    expect(back).toMatchObject({ seq: 1, at: 1000, run: 'test', kind: 'feed-block', block: 42 })
    expect((back as any).txs[0].hash).toBe('0xa')
  })

  it('hands out gapless seqs from the tape itself, so a restart cannot reuse one', () => {
    expect(tape.nextSeq()).toBe(1)
    tape.append([ev(1, 1000), ev(2, 1001)])
    expect(tape.nextSeq()).toBe(3)
    tape.close()
    tape = open()
    expect(tape.nextSeq()).toBe(3)
  })

  it('reads in seq order regardless of insertion order', () => {
    tape.append([ev(1, 5000), ev(2, 1000), ev(3, 3000)])
    expect(tape.read(1).map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('is all-or-nothing on a batch', () => {
    tape.append([ev(1, 1000)])
    // A duplicate seq violates the primary key. The first event of the batch must not survive.
    expect(() => tape.append([ev(2, 1001), ev(1, 1002)])).toThrow()
    expect(tape.stats().rows).toBe(1)
  })
})

describe('the limits actually bite', () => {
  it('drops by age and reports the range that is no longer reproducible', () => {
    const t = open({ ...DEFAULT_LIMITS, maxAgeMs: 1000 })
    const now = 100_000
    t.append([ev(1, now - 5000), ev(2, now - 4000), ev(3, now - 100), ev(4, now)])
    const pruned = t.prune(now)
    expect(pruned.byAge).toBe(2)
    expect(pruned.droppedThroughSeq).toBe(2)
    expect(t.read(1).map((e) => e.seq)).toEqual([3, 4])
    t.close()
  })

  it('drops by bytes even when everything is inside the age window', () => {
    // The case age alone cannot cover: a busy day inside the window still fills the disk.
    const t = open({ ...DEFAULT_LIMITS, maxAgeMs: 24 * 3_600_000, maxBytes: 4_000 })
    const big = 'x'.repeat(500)
    t.append(Array.from({ length: 2_000 }, (_, i) => ev(i + 1, 1_000 + i, 'clock', { pad: big })))
    const before = t.stats()
    expect(before.bytes).toBeGreaterThan(4_000)
    const pruned = t.prune(2_000)
    expect(pruned.byAge).toBe(0)
    expect(pruned.byBytes).toBeGreaterThan(0)
    expect(t.stats().bytes).toBeLessThanOrEqual(4_000)
    t.close()
  })

  it('keeps the newest events when the byte budget bites, never the oldest', () => {
    const t = open({ ...DEFAULT_LIMITS, maxAgeMs: 24 * 3_600_000, maxBytes: 4_000 })
    const big = 'x'.repeat(500)
    t.append(Array.from({ length: 2_000 }, (_, i) => ev(i + 1, 1_000 + i, 'clock', { pad: big })))
    t.prune(2_000)
    const kept = t.read(1, 10_000)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept[kept.length - 1]!.seq).toBe(2_000)
    t.close()
  })

  it('prunes nothing and reports nothing when inside both limits', () => {
    tape.append([ev(1, 1000), ev(2, 1001)])
    expect(tape.prune(2000)).toEqual({ byAge: 0, byBytes: 0, droppedThroughSeq: null })
  })

  it('has a disk floor well above zero, because the box runs at 76 percent', () => {
    expect(DEFAULT_LIMITS.diskFloorBytes).toBeGreaterThanOrEqual(1_073_741_824)
    expect(DEFAULT_LIMITS.maxBytes).toBeLessThan(DEFAULT_LIMITS.diskFloorBytes)
  })
})

describe('query plans', () => {
  /**
   * Assert the index NAME, not the absence of SCAN.
   *
   * The old repo learned this the hard way: a query that reads as a SEARCH can still walk
   * every row if it picked the wrong index, so "no SCAN in the plan" is not the property
   * anyone actually wanted.
   */
  const plan = (sql: string, ...args: unknown[]) =>
    (tape.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as any[])) as Array<{ detail: string }>)
      .map((r) => r.detail).join(' | ')

  it('reads forward on the primary key', () => {
    expect(plan('SELECT seq FROM events WHERE seq >= ? ORDER BY seq LIMIT ?', 1, 10)).toMatch(/USING INTEGER PRIMARY KEY/)
  })

  it('deletes by age on events_at, which is the query that actually runs', () => {
    // Assert the index NAME. A plan that says SEARCH can still walk every row if it chose the
    // wrong index, so "no SCAN" was never the property anyone wanted.
    expect(plan('DELETE FROM events WHERE at < ?', 0)).toMatch(/USING INDEX events_at/)
  })

  it('finds the byte-budget boundary without touching the hot path', () => {
    // This one IS a scan, and deliberately so: it runs only when the budget is already
    // exceeded, in the writer process, never in the trading loop. The O(1) counter is what
    // decides whether to run it at all.
    tape.append([ev(1, 1000)])
    expect(tape.bytes()).toBeGreaterThan(0)
    expect(plan("SELECT value FROM tape_meta WHERE name='bytes'")).toMatch(/sqlite_autoindex_tape_meta_1/)
  })
})

describe('schema parity with the live recorder', () => {
  /**
   * For the length of the rewrite, `v1/src/tape.ts` writes this file and v2 reads it. Two
   * copies of one schema is a DRY violation the two package roots force, so it is made safe
   * the only way it can be: a test that fails the moment they differ.
   */
  const here = dirname(fileURLToPath(import.meta.url))
  const recorderCandidates = [
    join(here, '../../v1/src/tape.ts'),
    join(here, '../../snipe/v1/src/tape.ts'),
  ]
  const RECORDER = recorderCandidates.find((p) => existsSync(p))

  it('the live recorder carries a byte-identical copy of TAPE_SCHEMA', () => {
    if (!RECORDER) {
      expect.fail(`the live recorder is not written yet: tried ${recorderCandidates.join(', ')}`)
      return
    }
    const src = readFileSync(RECORDER, 'utf8')
    const m = /export const TAPE_SCHEMA = `\n([\s\S]*?)`\.trim\(\)/.exec(src)
    expect(m, 'v1/src/tape.ts must export TAPE_SCHEMA as a template literal').not.toBeNull()
    expect(m![1]!.trim()).toBe(TAPE_SCHEMA)
  })
})
