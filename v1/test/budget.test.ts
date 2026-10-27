/** src/rpc/budget.ts: the provider key's compute-unit accounting. */
import { describe, it, expect } from 'vitest'
import { ReadBudget, CU, MIN_OBS_MS } from '../src/rpc/budget.js'

describe('ReadBudget', () => {
  it('is silent before any read, counts by method, and projects to a month', () => {
    let now = 1_000_000
    let socket: number | null = null
    const b = new ReadBudget(24_000_000, () => socket, () => now)
    now += MIN_OBS_MS // past the observation floor; see the test below for before it
    expect(b.readsPerMonth()).toBeNull()
    expect(b.totalPerMonth()).toBeNull()
    expect(b.allow()).toBe(true)
    b.spent('eth_call'); b.spent('eth_getTransactionByHash')
    expect(b.calls).toEqual({ eth_call: 1, eth_getTransactionByHash: 1 })
    // the first minute is not a rate: projected as if the spend took a full minute
    expect(b.readsPerMonth()).toBeCloseTo(((CU.eth_call + CU.eth_getTransactionByHash) / 60_000) * 30 * 86_400_000, 0)
    now += 120_000
    expect(b.readsPerMonth()).toBeCloseTo(((CU.eth_call + CU.eth_getTransactionByHash) / 120_000) * 30 * 86_400_000, 0)
    socket = 5_000_000
    expect(b.totalPerMonth()).toBeCloseTo(5_000_000 + b.readsPerMonth()!, 0)
  })

  it('stops allowing once the projection passes the cap, and resumes as the rate falls', () => {
    let now = 0
    const b = new ReadBudget(1_000, () => null, () => now)
    // 26 CU in the first minute projects to 26/60000*2.592e9 = 1.12M: over a 1,000 cap,
    // but no verdict before ten minutes of observation
    b.spent('eth_call')
    expect(b.allow()).toBe(true)
    now = MIN_OBS_MS
    expect(b.allow()).toBe(false)
    // a month later at the same total spend the rate is tiny
    now = 30 * 86_400_000 * 2
    expect(b.allow()).toBe(true)
  })

  it('the socket alone can exhaust the budget, once settled', () => {
    let now = 0
    const b = new ReadBudget(24_000_000, () => 25_000_000, () => now)
    expect(b.allow()).toBe(true)          // a restart burst is not a pace
    expect(b.totalPerMonth()).toBeNull()  // and the dashboard has nothing to warn about yet
    now = MIN_OBS_MS
    expect(b.allow()).toBe(false)
    expect(b.readsPerMonth()).toBeNull()
    expect(b.totalPerMonth()).toBe(25_000_000)
  })
})

describe('ReadBudget window fraction (2026-09-06, first window)', () => {
  it('projects the in-window rate over the window only, for reads and for the socket', () => {
    let now = MIN_OBS_MS
    const b = new ReadBudget(27_000_000, () => 32_000_000, () => 0, () => 0.5)
    ;(b as any).now = () => now
    expect(b.totalPerMonth()).toBe(16_000_000)  // the socket alone read 32M at a 24h extrapolation
    expect(b.allow()).toBe(true)
    b.spent('eth_call')
    now = MIN_OBS_MS + 60_000
    expect(b.readsPerMonth()).toBeCloseTo((CU.eth_call / 60_000) * 30 * 86_400_000 * 0.5, 0)
  })
  it('entryWindowHours: off is 24, plain and wrap-around windows count their hours', async () => {
    const { entryWindowHours } = await import('../src/strategy/launch.js')
    expect(entryWindowHours(null)).toBe(24)
    expect(entryWindowHours({ from: 12, to: 24 })).toBe(12)
    expect(entryWindowHours({ from: 12, to: 21 })).toBe(9)
    expect(entryWindowHours({ from: 22, to: 4 })).toBe(6)
  })
})
