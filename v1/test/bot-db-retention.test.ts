import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { sourceLogFloor, pruneSourceLogs, archiveJobs, pruneDecisions, runRetention } from '../src/strategy/bot-db-retention.js'

/**
 * bot.db had no retention at all. Measured on the box 2026-09-15: `shadow_source_logs` 123.4 MB,
 * `shadow_jobs` 114.2 MB across five config ids, `shadow_decisions` 8 MB/day. The two things
 * these tests protect are the two ways this goes wrong: deleting a source log the reorg
 * tripwire would have needed, and blanking a request the certifier reads.
 */

const HOUR = 3_600_000
const schema = (db: Database.Database) => db.exec(`
  CREATE TABLE shadow_source_logs (curve TEXT NOT NULL,block INTEGER NOT NULL,idx INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(curve,block,idx));
  CREATE TABLE shadow_headers (block INTEGER PRIMARY KEY,hash TEXT,timestamp INTEGER);
  CREATE TABLE shadow_jobs (id INTEGER PRIMARY KEY,token TEXT NOT NULL,config TEXT NOT NULL,entry INTEGER NOT NULL,
    intent TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',request TEXT,result TEXT,available INTEGER,published_at INTEGER);
  CREATE TABLE shadow_decisions (config TEXT NOT NULL,at INTEGER NOT NULL,reading TEXT NOT NULL,checkpoint TEXT NOT NULL,PRIMARY KEY(config,at));`)

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'retention-'))
  const db = new Database(join(dir, 'bot.db'))
  schema(db)
  return { db, dir }
}

it('reads the age of a source log from its block header, and deletes nothing without one', async () => {
  const { db, dir } = fresh()
  try {
    const now = 1_000 * HOUR
    // No headers: nothing is old enough to prove, so nothing goes.
    expect(sourceLogFloor(db, now)).toBe(null)
    db.prepare('INSERT INTO shadow_source_logs VALUES (?,?,?,?)').run('0xa', 10, 0, '{}')
    expect(await pruneSourceLogs(db, now, 5_000)).toBe(0)

    const header = db.prepare('INSERT INTO shadow_headers VALUES (?,?,?)')
    for (const [block, hoursAgo] of [[10, 96], [20, 72], [30, 47], [40, 1]] as const)
      header.run(block, '0x' + block, Math.floor((now - hoursAgo * HOUR) / 1000))
    // Block 30 is the first one inside 48 h, so it is the floor and it survives.
    expect(sourceLogFloor(db, now)).toBe(30)

    const put = db.prepare('INSERT INTO shadow_source_logs VALUES (?,?,?,?)')
    db.transaction(() => { for (const b of [20, 30, 40]) put.run('0xa', b, 0, '{}') })()
    expect(await pruneSourceLogs(db, now, 5_000)).toBe(2)
    expect((db.prepare('SELECT block FROM shadow_source_logs ORDER BY block').all() as any[]).map(r => r.block)).toEqual([30, 40])
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('never blanks a job of the live config, which is the one the certifier reads', async () => {
  const { db, dir } = fresh()
  try {
    const now = 1_000 * HOUR
    const put = db.prepare('INSERT INTO shadow_jobs (id,token,config,entry,intent,status,request,result,published_at) VALUES (?,?,?,?,?,?,?,?,?)')
    db.transaction(() => {
      put.run(1, 't1', 'live', now - 90 * HOUR, '{"kernel":1}', 'published', '{"coverage":{}}', '{}', now - 90 * HOUR)
      put.run(2, 't2', 'dead', now - 90 * HOUR, '{"kernel":1}', 'published', '{"coverage":{}}', '{}', now - 90 * HOUR)
      put.run(3, 't3', 'dead', now - 90 * HOUR, '{"kernel":1}', 'rejected', '{"coverage":{}}', '{}', null)
      put.run(4, 't4', 'dead', now - HOUR, '{"kernel":1}', 'published', '{"coverage":{}}', '{}', now - HOUR)
      put.run(5, 't5', 'dead', now - 90 * HOUR, '{"kernel":1}', 'queued', '{"coverage":{}}', null, null)
    })()
    expect(await archiveJobs(db, 'live', now, 5_000)).toBe(2)
    const rows = db.prepare('SELECT id,request,result,intent FROM shadow_jobs ORDER BY id').all() as any[]
    // 1 is the live config, 4 is inside 48 h, 5 is still queued. Every intent survives:
    // dashboard-policy reads it with no time filter.
    expect(rows.map(r => r.request === null)).toEqual([false, true, true, false, false])
    expect(rows.map(r => r.result === null)).toEqual([false, true, true, false, true])
    expect(rows.every(r => r.intent === '{"kernel":1}')).toBe(true)
    // Idempotent: a second sweep finds nothing left to do.
    expect(await archiveJobs(db, 'live', now, 5_000)).toBe(0)
    // An empty live config must archive nothing rather than everything.
    expect(await archiveJobs(db, '', now, 5_000)).toBe(0)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('keeps eight days of decisions, one past the dashboard lookback', async () => {
  const { db, dir } = fresh()
  try {
    const now = 1_000 * HOUR
    const put = db.prepare('INSERT INTO shadow_decisions VALUES (?,?,?,?)')
    db.transaction(() => { for (const days of [9, 8.1, 7, 1, 0]) put.run('c', now - days * 24 * HOUR, '{}', '{}') })()
    expect(await pruneDecisions(db, now, 5_000)).toBe(2)
    expect((db.prepare('SELECT COUNT(*) n FROM shadow_decisions').get() as any).n).toBe(3)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('counts a missing table as a skip rather than throwing at the trading loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retention-')), db = new Database(join(dir, 'bot.db'))
  try {
    const report = await runRetention(db, { now: Date.now(), liveConfig: 'live' })
    expect(report).toEqual({ sourceLogs: 0, jobs: 0, decisions: 0, skipped: 2 })
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})
