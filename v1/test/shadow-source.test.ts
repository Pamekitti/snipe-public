import { describe, expect, it } from 'vitest'
import { canonicalSourceLogs, gapVerdict, requireStableSource, scanCandidates, transientDbError } from '../src/strategy/shadow-source.js'
const log={address:'0xab',blockNumber:'0x1',logIndex:'0x0',blockHash:'block',transactionHash:'tx',topics:['topic'],data:'0x00'}
describe('settled historical source', () => {
  it('cannot call an incomplete first scan stable', () => {
    expect(()=>requireStableSource([], [log])).toThrow('still changing')
    expect(()=>requireStableSource([log], [])).toThrow('still changing')
  })
  it('accepts identical events across transports and deduplicates overlap', () => {
    expect(requireStableSource([log,log],[{...log,blockNumber:1,logIndex:0,transactionIndex:'0x2'}])).toEqual(canonicalSourceLogs([log]))
  })
  it('rejects changed, conflicting, removed and invalid events', () => {
    expect(()=>requireStableSource([log],[{...log,data:'0x01'}])).toThrow('still changing')
    expect(()=>canonicalSourceLogs([log,{...log,data:'0x01'}])).toThrow('conflicting')
    expect(()=>canonicalSourceLogs([{...log,removed:true}])).toThrow('invalid')
    expect(()=>canonicalSourceLogs([{...log,blockNumber:undefined}])).toThrow('invalid')
  })
})

describe('what stops the observer, and what does not', () => {
  const floors = { tax: 50, exemptions: 3 }

  it('retries write contention instead of latching the source fault', () => {
    expect(transientDbError(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' }))).toBe(true)
    expect(transientDbError(Object.assign(new Error('x'), { code: 'SQLITE_BUSY_SNAPSHOT' }))).toBe(true)
    expect(transientDbError(new Error('SqliteError: database is locked'))).toBe(true)
    expect(transientDbError('SqliteError: database is locked')).toBe(true)
  })

  it('still latches on anything that makes the replay wrong', () => {
    expect(transientDbError(new Error('chain hash changed; source repair required'))).toBe(false)
    expect(transientDbError(new Error('removed chain log requires source repair'))).toBe(false)
    expect(transientDbError(Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT' }))).toBe(false)
  })

  it('treats a launch the live feed never saw as a feed gap, not a missed admission', () => {
    expect(gapVerdict(undefined, false, floors)).toBe('feed-gap')
  })

  it('still refuses when an admissible launch in the book has no observation', () => {
    expect(gapVerdict({ passed: 1, tax: 120, ex: 4 }, false, floors)).toBe('missed')
  })

  it('passes over launches the entry screen would have declined anyway', () => {
    expect(gapVerdict({ passed: 0, tax: 120, ex: 4 }, false, floors)).toBe('declined')
    expect(gapVerdict({ passed: 1, tax: 20, ex: 4 }, false, floors)).toBe('declined')
    expect(gapVerdict({ passed: 1, tax: 120, ex: 2 }, false, floors)).toBe('declined')
  })

  it('says nothing about a launch it already captured', () => {
    expect(gapVerdict(undefined, true, floors)).toBe('captured')
    expect(gapVerdict({ passed: 1, tax: 120, ex: 4 }, true, floors)).toBe('captured')
  })
})

describe('the replay scan stops where the replay stops reading', () => {
  it('offers tight candidates before the tip, tightest first', () => {
    // a 180 s window from launch: 12/s -> 2,260 blocks, 30/s -> 5,500, 80/s -> 14,500
    const c = scanCandidates(1_000_000, 1_000_000_000, 1_000_180_000, 2_000_000)
    expect(c).toEqual([1_002_260, 1_005_500, 1_014_500, 2_000_000])
  })
  it('never scans past the settled tip and never below it when the tip is close', () => {
    expect(scanCandidates(1_000_000, 1_000_000_000, 1_000_180_000, 1_001_000)).toEqual([1_001_000])
    expect(scanCandidates(1_000_000, 1_000_000_000, 1_000_180_000, 1_003_000)).toEqual([1_002_260, 1_003_000])
  })
  it('falls back to the tip when the launch time cannot be trusted', () => {
    expect(scanCandidates(1_000_000, 0, 1_000_180_000, 2_000_000)).toEqual([2_000_000])
    expect(scanCandidates(1_000_000, NaN, 1_000_180_000, 2_000_000)).toEqual([2_000_000])
    expect(scanCandidates(1_000_000, 1_000_180_000, 1_000_180_000, 2_000_000)).toEqual([2_000_000])
  })
})
