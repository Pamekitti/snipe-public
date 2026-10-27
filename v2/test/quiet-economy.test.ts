import { describe, expect, it, vi } from 'vitest'
import { QuietEconomy, quietEconomyEligibility } from '../io/quiet-economy.js'
import { emptyState } from '../core/state.js'
import type { FrozenConfig, Switches } from '../core/config.js'

const cfg = { id: 'test', books: [{ id: 'a', guard: { window: 1 } }], risk: {}, clock: {} } as unknown as FrozenConfig
const switches = { mode: 'shadow', tradeSizeWei: '1' } as unknown as Switches
describe('quiet routing', () => {
  it('ignores only expired unsigned approvals, never signed or recent transaction work', () => {
    const initial = emptyState(cfg, switches)
    const s = { ...initial, at: 1_000_000,
      sensors: { ...initial.sensors, feedConnected: { value: true }, logsHealthy: { value: true } } as any }
    s.inflight.set('old', { kind: 'approve', hash: null, signedAt: 0, raisedAt: 1 } as never)
    expect(quietEconomyEligibility(s, true, true, true).eligible).toBe(true)
    for (const transaction of [
      { kind: 'approve', hash: 'pending', signedAt: 1, raisedAt: 1 },
      { kind: 'approve', hash: null, signedAt: 0, raisedAt: 999_999 },
      { kind: 'buy', hash: null, signedAt: 0, raisedAt: 1 },
    ]) {
      s.inflight.set('old', transaction as never)
      expect(quietEconomyEligibility(s, true, true, true).eligible).toBe(false)
    }
  })
  it('requires no pending opportunities, settled transactions and healthy detectors', () => {
    const initial = emptyState(cfg, switches)
    const s = { ...initial, sensors: { ...initial.sensors, feedConnected: { value: true }, logsHealthy: { value: true } } as any }
    expect(quietEconomyEligibility(s, true, true, true).eligible).toBe(true)
    for (const args of [[false, true, true], [true, false, true], [true, true, false]]) {
      expect(quietEconomyEligibility(s, args[0]!, args[1]!, args[2]!).eligible).toBe(false)
    }
    s.pendingLaunches.set('c', {} as never)
    expect(quietEconomyEligibility(s, true, true, true).eligible).toBe(false)
    s.pendingLaunches.clear(); s.nonce.inFlight = 1
    expect(quietEconomyEligibility(s, true, true, true).eligible).toBe(false)
  })
  it('holds synchronously, prepares once for simultaneous launches, then releases', async () => {
    let finish!: () => void
    const hold = vi.fn(), prepare = vi.fn(() => new Promise<void>(r => { finish = r }))
    const c = new QuietEconomy({ enabled: () => true, eligible: () => ({ eligible: true, reason: 'quiet' }), hold, prepare })
    c.reconcile(); expect(hold).toHaveBeenCalledWith(true)
    c.interrupt('launch'); c.interrupt('another launch')
    expect(c.usePublic()).toBe(false)
    await Promise.resolve(); expect(prepare).toHaveBeenCalledTimes(1)
    finish(); await vi.waitFor(() => expect(hold).toHaveBeenLastCalledWith(false))
  })
  it('never releases after a newer STOP', async () => {
    let finish!: () => void
    const hold = vi.fn()
    const c = new QuietEconomy({ enabled: () => true, eligible: () => ({ eligible: true, reason: '' }), hold,
      prepare: () => new Promise<void>(r => { finish = r }) })
    c.reconcile(); c.interrupt('launch'); await Promise.resolve()
    c.cancel(); finish(); await vi.waitFor(() => expect(c.preparing()).toBe(false))
    expect(hold.mock.calls).toEqual([[true]])
  })
  it('leaves readiness held and disables itself on failed preparation', async () => {
    const hold = vi.fn()
    const c = new QuietEconomy({ enabled: () => true, eligible: () => ({ eligible: true, reason: '' }), hold,
      prepare: async () => { throw new Error('deadline') } })
    c.reconcile(); c.interrupt('stream failure')
    await vi.waitFor(() => expect(c.disabledReason).toMatch(/deadline/))
    c.reconcile(); expect(hold.mock.calls).toEqual([[true]])
  })
})
