import { afterEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { Telemetry } from '../src/telemetry/db.js'
import { chartSnapshot } from '../src/telemetry/dashboard.js'

const dbs: Database.Database[] = []
afterEach(() => dbs.splice(0).forEach(db => db.close()))

it('does not substitute legacy estimates when the shared model has no account history', () => {
  const db = new Telemetry(':memory:').raw(); dbs.push(db)
  db.exec(`CREATE TABLE shadow_jobs(id INTEGER PRIMARY KEY,token TEXT,config TEXT,entry INTEGER,
    status TEXT,published_at INTEGER,available INTEGER,close_at INTEGER,pnl TEXT,size TEXT);
    CREATE TABLE shadow_meta(key TEXT PRIMARY KEY,value TEXT)`)
  const now = Date.UTC(2026,8,13,16), at = now - 60000
  db.prepare('INSERT INTO launches(token,detected_at,passed) VALUES (?,?,1)').run('coin', at)
  db.prepare(`INSERT INTO shadow_jobs VALUES (1,'coin','existing-model',?,'published',?,?,?,?,?)`)
    .run(at, at+1000, at+1000, at+1000, '1000000000000000', '20000000000000000')
  const chart: any = chartSnapshot({tel:{raw:()=>db}} as any, '1h', now)
  expect(chart.policy.points).toEqual([])
  expect(chart.paper).toMatchObject({source:'forward-ledger',estimated:true,recordedPnlEth:null,monthToDate:null,n:0})
  expect(chart.paper.points.some((p:any)=>p.eth===0.001)).toBe(false)
  expect(chart.paper.points.every((p:any)=>p.t>=at && p.t<=now)).toBe(true)
  expect(chart.outcomes.buckets).toEqual([])
})

it('does not mix raw launch counts into an empty forward ledger', () => {
  const db = new Telemetry(':memory:').raw(); dbs.push(db)
  const now = Date.now()
  db.prepare('INSERT INTO launches(token,detected_at,passed) VALUES (?,?,?)').run('pass',now-1000,1)
  db.prepare('INSERT INTO launches(token,detected_at,passed) VALUES (?,?,?)').run('reject',now-1000,0)
  const chart:any = chartSnapshot({tel:{raw:()=>db}} as any,'1h',now)
  expect(chart.paper.recordedPnlEth).toBeNull()
  expect(chart.outcomes.buckets).toEqual([])
})
