import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { paperHealth } from '../src/telemetry/paper-health.js'
import type { BookFloors } from '../src/strategy/gate.js'

/** the band the test launches sit inside, so the existing cases keep testing what they did */
const WIDE: BookFloors = { minTaxBps: 50, maxTaxBps: 10_000, minExempt: 3 }

const seed = () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE shadow_meta(key TEXT,value TEXT);
    CREATE TABLE shadow_jobs(token TEXT,entry INTEGER,close_at INTEGER,status TEXT);
    CREATE TABLE launches(token TEXT,launched_at INTEGER,passed INTEGER,creator_tax_bps INTEGER,exemptions INTEGER);
    INSERT INTO shadow_jobs VALUES('old',1000,2000,'published');`)
  return db
}

it('distinguishes quiet trading from a missing capture and a latched collector fault', () => {
  const db = seed()
  try {
    expect(paperHealth(db,600000,WIDE).stalled).toBe(false)
    db.exec("INSERT INTO launches VALUES('missed',10,1,200,4)")
    expect(paperHealth(db,600000,WIDE)).toMatchObject({stalled:true,missing:1,lastClose:2000})
    db.exec("INSERT INTO shadow_jobs VALUES('missed',10000,NULL,'queued')")
    expect(paperHealth(db,600000,WIDE)).toMatchObject({stalled:true,missing:0,pending:1})
    db.exec("UPDATE shadow_jobs SET status='published',close_at=11000 WHERE token='missed'")
    expect(paperHealth(db,600000,WIDE).stalled).toBe(false)
    db.exec("INSERT INTO shadow_meta VALUES('source_fault','missing source')")
    expect(paperHealth(db,600000,WIDE)).toMatchObject({stalled:true,fault:'missing source'})
  } finally { db.close() }
})

describe('the missing count follows the book, which is what broke it', () => {
  /**
   * The live regression, 2026-09-15 to 2026-09-16. The band moved to untaxed-only (0-0 bps)
   * and the query still said `creator_tax_bps>=50`, so it admitted none of the launches the
   * bot buys and `missing` could not rise off zero. The collector could have stopped seeing
   * every coin in the book and this sensor would have said it was fine.
   */
  it('counts an untaxed launch the collector skipped when the book is untaxed-only', () => {
    const db = seed()
    try {
      db.exec("INSERT INTO launches VALUES('untaxed',10,1,0,4)")
      expect(paperHealth(db, 600000, { minTaxBps: 0, maxTaxBps: 0, minExempt: 3 })).toMatchObject({ missing: 1, stalled: true })
      // and the old hardcoded band is exactly the one that misses it
      expect(paperHealth(db, 600000, WIDE)).toMatchObject({ missing: 0, stalled: false })
    } finally { db.close() }
  })

  it('ignores a launch above the book ceiling, so a wider market cannot raise a false alarm', () => {
    const db = seed()
    try {
      db.exec("INSERT INTO launches VALUES('taxed',10,1,500,4)")
      expect(paperHealth(db, 600000, { minTaxBps: 0, maxTaxBps: 0, minExempt: 3 })).toMatchObject({ missing: 0, stalled: false })
    } finally { db.close() }
  })

  it('ignores a launch below the exempt floor', () => {
    const db = seed()
    try {
      db.exec("INSERT INTO launches VALUES('thin',10,1,0,2)")
      expect(paperHealth(db, 600000, { minTaxBps: 0, maxTaxBps: 0, minExempt: 3 })).toMatchObject({ missing: 0, stalled: false })
    } finally { db.close() }
  })
})
