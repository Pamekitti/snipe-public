import { describe, expect, it, vi } from 'vitest'
import { emptyState } from '../core/state.js'
import type { FrozenConfig, Switches } from '../core/config.js'
import { HaltedEconomyController, haltedEconomyEligibility, runPreparedResume, stoppedEconomyEligibility } from '../io/economy.js'
import { decide } from '../core/decide.js'
import { canEnter } from '../core/risk.js'

const cfg = { books: [], risk: { maxConcurrent: 1 } } as unknown as FrozenConfig
const sw = { sizeWei: 1n, mode: 'live', at: 0, by: 'test' } as Switches

describe('all halted routing', () => {
  it('accepts mixed book stops, but requires every book and a flat reconciled wallet', () => {
    const state = emptyState({ ...cfg, books: [{ id: 'a', guard: { window: 1 } }, { id: 'b', guard: { window: 1 } }] } as unknown as FrozenConfig, sw)
    state.risk.halts.set('venue:a', { kind: 'venue', book: 'a', at: 1, reason: 'test' })
    expect(haltedEconomyEligibility(state, true).eligible).toBe(false)
    state.risk.halts.set('drawdown:b', { kind: 'drawdown', book: 'b', at: 1, reason: 'test' })
    expect(haltedEconomyEligibility(state, true).eligible).toBe(true)
    expect(haltedEconomyEligibility(state, false).eligible).toBe(false)
    state.positions.set('p', { closed: false } as never)
    expect(haltedEconomyEligibility(state, true).eligible).toBe(false)
    state.positions.clear()
    state.inflight.set('tx', { kind: 'sell' } as never)
    expect(haltedEconomyEligibility(state, true).eligible).toBe(false)
    state.inflight.set('tx', { kind: 'approve', hash: 'pending', signedAt: 1, raisedAt: 1 } as never)
    expect(haltedEconomyEligibility(state, true).eligible).toBe(false)
  })

  function fixture(readyAtBoot = true) {
    let eligible = true, ready = readyAtBoot, now = 0
    const events: string[] = []
    const prepare = vi.fn(async (_current: () => boolean) => { events.push('paid scan processed') })
    const controller = new HaltedEconomyController({
      enabled: () => true, eligibility: () => ({ eligible, reason: 'test' }), entryReady: () => ready,
      setReady: async (value) => { events.push(`ready:${value}`); ready = value }, prepare, now: () => now,
    })
    return { controller, events, prepare, ready: () => ready, open: () => { eligible = false }, halt: () => { eligible = true }, advance: () => { now += 1001 } }
  }

  it('holds entries before public routing, then processes paid catch-up before automatic recovery', async () => {
    const f = fixture()
    await f.controller.reconcile()
    expect(f.events).toEqual(['ready:false'])
    expect(f.controller.usePublic()).toBe(true)
    f.open()
    expect(f.controller.usePublic()).toBe(false)
    await f.controller.reconcile()
    expect(f.events).toEqual(['ready:false', 'paid scan processed', 'ready:true'])
  })

  it('keeps the hold after failure, retries, and restores a persisted hold after restart', async () => {
    const f = fixture(false)
    f.open()
    f.prepare.mockRejectedValueOnce(new Error('unavailable'))
    await f.controller.reconcile()
    expect(f.ready()).toBe(false)
    expect(f.controller.lastPreparation?.ok).toBe(false)
    await f.controller.reconcile()
    expect(f.prepare).toHaveBeenCalledTimes(1)
    f.advance()
    await f.controller.reconcile()
    expect(f.ready()).toBe(true)
  })

  it('serializes recovery and a newer STOP cancels release', async () => {
    const f = fixture(false)
    f.open()
    let release!: () => void
    f.prepare.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const pending = f.controller.reconcile()
    await f.controller.reconcile()
    expect(f.prepare).toHaveBeenCalledTimes(1)
    f.controller.cancel()
    f.halt()
    release()
    await pending
    expect(f.ready()).toBe(false)
    await f.controller.reconcile()
    expect(f.controller.usePublic()).toBe(true)
  })

  it('records readiness separately from stream health and keeps it across later log status', () => {
    let state = emptyState({ ...cfg, risk: { ...cfg.risk, maxTradeSizeWei: '10', bankrollWei: '0', maxLogsStalenessMs: 3000, maxOverlayAgeMs: 3000 } } as FrozenConfig, sw)
    const health = { logsHealthy: true, logsAgeMs: 1, overlayAgeMs: 1 }
    expect(canEnter(state, { token: 't', book: 'a', sizeWei: 1n }, health).ok).toBe(true)
    state = decide(state, { kind: 'logs-status', at: 1, seq: 1, run: 'test', healthy: true, mode: 'poll', reason: 'economy', entryReady: false }).state
    expect(state.sensors.logsHealthy).toBeNull()
    state = decide(state, { kind: 'logs-status', at: 2, seq: 2, run: 'test', healthy: true, mode: 'poll', reason: 'healthy' }).state
    expect(state.sensors.logsHealthy?.value).toBe(true)
    expect(canEnter(state, { token: 't', book: 'a', sizeWei: 1n }, health).ok).toBe(false)
    state = decide(state, { kind: 'logs-status', at: 3, seq: 3, run: 'test', healthy: true, mode: 'poll', reason: 'prepared', entryReady: true }).state
    expect(state.sensors.logsHealthy?.at).toBe(2)
    expect(canEnter(state, { token: 't', book: 'a', sizeWei: 1n }, health).ok).toBe(true)
  })
})

describe('stopped economy eligibility', () => {
  it('requires the wallet-wide operator stop, not automatic or per-book halts', () => {
    const state = emptyState(cfg, sw)
    state.risk.halts.set('venue:alpha', { kind: 'venue', book: 'alpha', at: 1, reason: 'test' })
    state.risk.halts.set('stopped:alpha', { kind: 'stopped', book: 'alpha', at: 1, reason: 'test' })
    expect(stoppedEconomyEligibility(state, true, true).eligible).toBe(false)
    state.risk.halts.set('stopped', { kind: 'stopped', book: null, at: 2, reason: 'test' })
    expect(stoppedEconomyEligibility(state, true, true).eligible).toBe(true)
  })

  it('requires reconciliation, a flat wallet, no transaction work and an idle driver', () => {
    const state = emptyState(cfg, sw)
    state.risk.halts.set('stopped', { kind: 'stopped', book: null, at: 1, reason: 'test' })
    expect(stoppedEconomyEligibility(state, false, true).reason).toMatch(/reconciliation/)
    expect(stoppedEconomyEligibility(state, true, false).reason).toMatch(/queued/)
    state.nonce.inFlight = 1
    expect(stoppedEconomyEligibility(state, true, true).reason).toMatch(/nonce/)
  })
})

describe('prepared resume', () => {
  it('never lifts STOP before preparation and readiness succeed', async () => {
    const order: string[] = []
    const result = await runPreparedResume({
      prepare: async () => { order.push('prepare') },
      ready: () => { order.push('ready'); return { eligible: true, reason: 'ready' } },
      stillCurrent: () => true,
      lift: async () => { order.push('lift') },
    })
    expect(result.resumed).toBe(true)
    expect(order).toEqual(['prepare', 'ready', 'lift'])
  })

  it('does not lift after failed preparation or a newer STOP', async () => {
    let lifted = false
    expect((await runPreparedResume({
      prepare: async () => { throw new Error('paid catch-up failed') },
      ready: () => ({ eligible: true, reason: 'ready' }), stillCurrent: () => true,
      lift: async () => { lifted = true },
    })).resumed).toBe(false)
    expect((await runPreparedResume({
      prepare: async () => {}, ready: () => ({ eligible: true, reason: 'ready' }), stillCurrent: () => false,
      lift: async () => { lifted = true },
    })).why).toMatch(/newer STOP/)
    expect(lifted).toBe(false)
  })
})
