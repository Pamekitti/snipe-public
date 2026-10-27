import { describe, expect, it } from 'vitest'
import { FreshRecovery, type ShadowOutcome } from '../src/strategy/fresh-recovery.js'
import fixtures from './fixtures/fresh-recovery-parity.json'

const tape = (values: number[], available = 1000): ShadowOutcome[] => values.map((value, i) => ({
  token: String(i).padStart(3, '0'), block: i, launched: 100 + i, available, value,
}))

describe('selected September fresh_s1_w8_b1', () => {
  it('matches the Python research rule on frozen early/late September tapes and delayed publication', () => {
    for (const fixture of fixtures) {
      const guard = new FreshRecovery(fixture.start)
      for (const [at, allowed, score, recent, fresh] of fixture.expected) {
        const reading = guard.read(fixture.records, at as number)
        expect(reading.state === 'open', `${fixture.source} at ${at}`).toBe(allowed)
        expect(reading.fresh).toBe(fresh)
        // Research reports mean * 20 even before warmup. Production exposes the actual sum.
        if (score !== null) expect(reading.sum).toBeCloseTo((score as number) * reading.n / 20, 10)
        expect(reading.recentSum).toBeCloseTo(recent as number, 10)
      }
    }
  })
  it('waits for twenty outcomes and strictly more than one stake over the latest eight', () => {
    const guard = new FreshRecovery(1000)
    expect(guard.read(tape(Array(19).fill(1)), 1000).state).toBe('shut')
    expect(guard.read(tape(Array(20).fill(0.125), 1001), 1001).state).toBe('shut')
    expect(guard.read(tape(Array(20).fill(0.126), 1002), 1002).state).toBe('open')
  })

  it('does not use a future publication or reopen on unchanged evidence', () => {
    const guard = new FreshRecovery(1000)
    const rows = tape(Array(20).fill(1), 1001)
    expect(guard.read(rows, 1000).n).toBe(0)
    expect(guard.read(rows, 1001).state).toBe('open')
    guard.pause(1002)
    expect(guard.read(rows, 1003).state).toBe('shut')
  })

  it('stale evidence holds a pause and cannot reopen it when an old loss expires', () => {
    const guard = new FreshRecovery(1000)
    const rows = tape(Array(20).fill(1))
    expect(guard.read(rows, 1000).state).toBe('open')
    expect(guard.read(rows, 10_900_000).state).toBe('shut')
    expect(guard.read(rows, 10_900_001).fresh).toBe(false)
  })

  it('publishes a batch atomically regardless of input order', () => {
    const rows = tape([...Array(12).fill(0), ...Array(4).fill(1), ...Array(4).fill(-1)])
    expect(new FreshRecovery(1000).read(rows, 1000)).toEqual(new FreshRecovery(1000).read([...rows].reverse(), 1000))
    expect(new FreshRecovery(1000).read(rows, 1000).state).toBe('shut')
  })

  it('preserves the researched conflicting-brake behavior instead of silently changing the policy', () => {
    const guard = new FreshRecovery(1000)
    const rows = tape([...Array(12).fill(-1), ...Array(8).fill(0.2)])
    const reopened = guard.read(rows, 1000)
    expect(reopened.sum).toBeLessThan(-1)
    expect(reopened.state).toBe('open')
    expect(guard.read(rows, 1000)).toBe(reopened)
    expect(guard.read(rows, 1001).state).toBe('shut')
    expect(guard.read(rows, 1002).state).toBe('shut')
  })

  it('keeps the strict minus-one brake boundary', () => {
    const guard = new FreshRecovery(1000)
    guard.read(tape(Array(20).fill(1)), 1000)
    const rows = tape([-1, ...Array(19).fill(0)], 1001)
    expect(guard.read(rows, 1001).state).toBe('open')
    rows[0]!.value = -1.001
    expect(guard.read(rows, 1002).state).toBe('shut')
  })

  it('refuses duplicate or invalid outcomes rather than counting them toward recovery', () => {
    for (const rows of [tape(Array(20).fill(NaN)), Array(20).fill(tape([1])[0]),
      tape(Array(20).fill(1)).map(r => ({ ...r, available: r.launched }))]) {
      const reading = new FreshRecovery(1000).read(rows, 1000)
      expect(reading.state).toBe('shut')
      expect(reading.reason).toBe('invalid_evidence')
    }
  })
})
