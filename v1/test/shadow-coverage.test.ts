import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { mergeRanges, coalesceCurve, coalesceCoverage, openCoverageDb } from '../src/strategy/shadow-coverage.js'

const schema = (db: Database.Database) =>
  db.exec('CREATE TABLE IF NOT EXISTS shadow_coverage (curve TEXT NOT NULL,lo INTEGER NOT NULL,hi INTEGER NOT NULL,PRIMARY KEY(curve,lo,hi));')

/** The verifier's walk, copied from scripts/verify-shadow.ts so the test asks its question. */
const covered = (db: Database.Database, curve: string, from: number, to: number) => {
  let cursor = from
  for (const r of db.prepare('SELECT lo,hi FROM shadow_coverage WHERE curve=? ORDER BY lo').all(curve) as Array<{lo:number;hi:number}>) {
    if (r.lo > cursor) break
    cursor = Math.max(cursor, r.hi + 1)
  }
  return cursor > to
}

it('merges overlapping and touching ranges, and keeps real holes', () => {
  expect(mergeRanges([{ lo: 1, hi: 5 }, { lo: 3, hi: 9 }])).toEqual([{ lo: 1, hi: 9 }])
  expect(mergeRanges([{ lo: 1, hi: 5 }, { lo: 6, hi: 9 }])).toEqual([{ lo: 1, hi: 9 }])
  expect(mergeRanges([{ lo: 1, hi: 5 }, { lo: 7, hi: 9 }])).toEqual([{ lo: 1, hi: 5 }, { lo: 7, hi: 9 }])
  expect(mergeRanges([{ lo: 4, hi: 4 }, { lo: 1, hi: 9 }, { lo: 4, hi: 4 }])).toEqual([{ lo: 1, hi: 9 }])
  expect(mergeRanges([])).toEqual([])
  expect(mergeRanges([{ lo: 9, hi: 1 }, { lo: 1.5, hi: 2 } as any])).toEqual([])
})

it('answers the verifier identically before and after, on a real per-poll table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-')), db = new Database(join(dir, 'bot.db'))
  try {
    schema(db)
    const put = db.prepare('INSERT OR IGNORE INTO shadow_coverage VALUES (?,?,?)')
    // One transaction, like the writer's own (shadow-worker.ts cacheCoverage). Seeding 802
    // rows as 802 commits is 802 fsyncs, which is eight seconds on the box's network disk
    // and was the difference between this passing on a laptop and failing a deploy.
    db.transaction(() => {
      // What the feed poll actually writes: a 2-block window per poll as the tip advances.
      for (let tip = 100; tip < 900; tip += 2) { put.run('0xa', tip, tip + 1); put.run('0xb', tip, tip + 1) }
      put.run('0xa', 5_000, 5_100)                     // the replay's own single row, far away
      put.run('0xb', 2_000, 2_100)                     // a genuine gap for curve b
    })()
    const probes: Array<[string, number, number]> = [
      ['0xa', 100, 899], ['0xa', 150, 400], ['0xa', 99, 200], ['0xa', 5_000, 5_100],
      ['0xa', 890, 910], ['0xb', 100, 899], ['0xb', 100, 2_100], ['0xb', 2_000, 2_100],
    ]
    const before = probes.map(p => covered(db, ...p))
    expect((db.prepare('SELECT COUNT(*) n FROM shadow_coverage').get() as any).n).toBe(802)

    expect(coalesceCurve(db, '0xa')).toEqual({ before: 401, after: 2 })
    coalesceCurve(db, '0xb')
    expect((db.prepare('SELECT COUNT(*) n FROM shadow_coverage').get() as any).n).toBe(4)
    expect(probes.map(p => covered(db, ...p))).toEqual(before)
    // Already minimal: a second pass must not churn the table.
    expect(coalesceCurve(db, '0xa')).toEqual({ before: 2, after: 2 })
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('skips a curve the shadow worker is holding instead of waiting on it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-busy-')), file = join(dir, 'bot.db')
  const owner = new Database(file)
  const reader = openCoverageDb(file)
  try {
    schema(owner)
    const put = owner.prepare('INSERT OR IGNORE INTO shadow_coverage VALUES (?,?,?)')
    owner.transaction(() => { for (let tip = 100; tip < 200; tip += 2) put.run('0xa', tip, tip + 1) })()
    owner.exec('BEGIN IMMEDIATE')                       // the worker, mid-transaction
    const report = await coalesceCoverage(reader, { minRows: 1 })
    expect(report.skipped).toBe(1)
    expect(report.curves).toBe(0)
    owner.exec('ROLLBACK')
    expect((await coalesceCoverage(reader, { minRows: 1 })).curves).toBe(1)
  } finally { reader.close(); owner.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('does nothing at all when the table is absent', async () => {
  const db = new Database(':memory:')
  try { expect(await coalesceCoverage(db)).toEqual({ curves: 0, before: 0, after: 0, skipped: 0 }) } finally { db.close() }
})
