/**
 * Halts survive a restart.
 *
 * WHAT WENT WRONG. `RiskManager.halts` was memory-only until 2026-09-16, so every pm2
 * restart built a fresh manager with an empty map and the bot came back trading. Four of
 * the six kinds hid it by re-firing within 30 seconds of boot. The two that do not,
 * 'drawdown' and 'broken', are exactly the two that mean the bot is losing money in a way
 * nobody has explained, and a restart during either left it entering at full size.
 *
 * The cutover makes this acute: switching to the new core IS a restart, and there is no
 * live shadow standing beside it to notice.
 */
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { RiskManager, isDurable, type HaltKind, type HaltRecord } from '../src/strategy/risk.js'
import { HALTS_KEY, clearHalt, readHalts, writeHalts } from '../src/telemetry/halts.js'

const ALL_KINDS: readonly HaltKind[] = ['manual', 'broken', 'drawdown', 'stopped', 'gate', 'venue']

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  db.exec('CREATE TABLE chain_truth (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
})

const mgr = (now = () => 1_000): RiskManager => new RiskManager(10n ** 18n, now)

describe('every kind has answered the durability question', () => {
  /**
   * The compiler already enforces this: DURABILITY is a `Record<HaltKind, boolean>`, so a
   * seventh kind is a type error until someone decides. This test states the property in
   * the suite as well, because a type that is only checked at build time is invisible to
   * the person reading the test file to find out what is guaranteed.
   */
  it('names a durability for all six kinds and no others', () => {
    for (const k of ALL_KINDS) expect(typeof isDurable(k)).toBe('boolean')
    expect(ALL_KINDS.filter(isDurable).sort()).toEqual(['broken', 'drawdown', 'gate', 'stopped', 'venue'])
  })

  it('leaves manual out, because HALT=1 in the file is its own record', () => {
    // A stored copy could only ever disagree with the file. An operator who sets HALT=0
    // and restarts must come back armed, not halted by a row they cannot see.
    expect(isDurable('manual')).toBe(false)
  })
})

describe('the round trip, for every durable kind', () => {
  for (const kind of ALL_KINDS.filter(isDurable)) {
    it(`carries ${kind} across a restart with its reason and its original timestamp`, () => {
      const before = mgr(() => 5_000)
      before.watchHalts((h) => writeHalts(db, h))
      before.halt(`${kind} fired`, kind)

      // the restart: a brand new manager, the way index.ts builds one
      const after = mgr(() => 900_000)
      const placed = after.restoreHalts(readHalts(db))
      expect(placed).toContain(kind)
      expect(after.isHalted(kind)).toBe(true)
      expect(after.haltReasonFor(kind)).toBe(`${kind} fired`)
      // the ORIGINAL at, not the restart's clock: the drawdown self-lift only accepts
      // evidence scored after haltAt, so a re-stamp silently demands a fresh window
      expect(after.haltAt(kind)).toBe(5_000)
    })
  }

  it('does not carry manual across, so the file stays the one-way switch', () => {
    const before = mgr()
    before.watchHalts((h) => writeHalts(db, h))
    before.halt('HALT=1', 'manual')
    expect(readHalts(db)).toEqual([])
    const after = mgr()
    expect(after.restoreHalts(readHalts(db))).toEqual([])
    expect(after.isHalted('manual')).toBe(false)
  })
})

describe('the sink fires on every mutation, not just the first', () => {
  it('records a second kind placed on top of the first', () => {
    const r = mgr()
    r.watchHalts((h) => writeHalts(db, h))
    r.halt('losing while the venue pays', 'broken')
    r.halt('venue shut', 'venue')
    expect(readHalts(db).map((h) => h.kind).sort()).toEqual(['broken', 'venue'])
  })

  it('drops a kind from the row when it is lifted', () => {
    const r = mgr()
    r.watchHalts((h) => writeHalts(db, h))
    r.halt('venue shut', 'venue')
    expect(readHalts(db).map((h) => h.kind)).toEqual(['venue'])
    expect(r.resume('venue')).toBe(true)
    expect(readHalts(db)).toEqual([])
  })

  it('drops the drawdown stop when it lifts itself', () => {
    const r = mgr()
    r.watchHalts((h) => writeHalts(db, h))
    r.halt('down 0.015 ETH from peak', 'drawdown')
    expect(r.liftOnSignal('drawdown', 'venue paid over a post-halt window')).toBe(true)
    expect(readHalts(db)).toEqual([])
  })

  it('drops the drawdown stop when the operator lifts it', () => {
    const r = mgr()
    r.watchHalts((h) => writeHalts(db, h))
    r.halt('down 0.015 ETH from peak', 'drawdown')
    expect(r.liftByOperator('drawdown', 'reset by hand')).toBe(true)
    expect(readHalts(db)).toEqual([])
  })

  it('does not churn the row when the same kind re-halts', () => {
    // checkDrawdown runs on every close, so a re-halt that rewrote the row would replace
    // the FIRST reason with the latest one and move a timestamp the self-lift depends on.
    const r = mgr()
    r.watchHalts((h) => writeHalts(db, h))
    r.halt('first reason', 'drawdown')
    r.halt('second reason', 'drawdown')
    expect(readHalts(db)).toEqual([{ kind: 'drawdown', reason: 'first reason', at: 1_000 }])
  })
})

describe('a bad row cannot stop the bot booting', () => {
  const store = (v: string) => db.prepare('INSERT OR REPLACE INTO chain_truth (key,value) VALUES (?,?)').run(HALTS_KEY, v)

  it('reads an absent row as no halts', () => { expect(readHalts(db)).toEqual([]) })
  it('reads unparseable JSON as no halts', () => { store('{not json'); expect(readHalts(db)).toEqual([]) })
  it('reads a non-array as no halts', () => { store('{"kind":"broken"}'); expect(readHalts(db)).toEqual([]) })

  it('drops a kind it does not recognise, so a rollback can read a newer row', () => {
    store(JSON.stringify([{ kind: 'from-the-future', reason: 'x', at: 1 }, { kind: 'broken', reason: 'y', at: 2 }]))
    expect(readHalts(db).map((h) => h.kind)).toEqual(['broken'])
  })

  it('drops an entry with no usable timestamp', () => {
    store(JSON.stringify([{ kind: 'broken', reason: 'y' }]))
    expect(readHalts(db)).toEqual([])
  })
})

describe('the epoch reset clears the drawdown stop and nothing else', () => {
  it('leaves a broken halt standing', () => {
    const records: HaltRecord[] = [
      { kind: 'drawdown', reason: 'down from peak', at: 10 },
      { kind: 'broken', reason: 'losing while the venue pays', at: 20 },
    ]
    writeHalts(db, records)
    clearHalt(db, 'drawdown')
    expect(readHalts(db)).toEqual([{ kind: 'broken', reason: 'losing while the venue pays', at: 20 }])
  })
})
