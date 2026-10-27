import { describe, expect, it } from 'vitest'
import { operatorState, type OperatorInput } from '../src/telemetry/operator-state.js'
const input = (patch: Partial<OperatorInput> = {}): OperatorInput => ({
  now: 100000, mode: 'live', kinds: [], reasons: [], drawdownEth: 0.048, limitEth: 0.06,
  open: 0, databaseOpen: 0, capacity: 14, deployedEth: 0, bankrollEth: 0.3, tradeSizeEth: 0.02,
  logsHealthy: true, logsAgeMs: 100, logsLimitMs: 1000, lastEntryAt: 99000,
  market: { sum: 1.2, n: 60, fresh: true, oldestAgeMs: 3600000, ageMs: 1000, state: 'open' },
  marketWindow: 60, marketOff: -4, marketOn: 0.5, marketFreshMs: 10800000,
  touch: { rate: 65, n: 20, state: 'open', dataAgeMs: 1000, ageMs: 1000 }, touchWindow: 20, touchOff: 10, touchOn: 25,
  execution: { gapPp: -3, n: 20, at: 99000 }, executionWindow: 20, executionLimit: 15,
  recovery: { n: 20, sum: 0.1, at: 99000 }, recoveryWindow: 20, recoveryOn: 0, liftsUsed: 1, liftsLimit: 2, ...patch,
})
describe('operator view of the real guards', () => {
  it('shows drawdown headroom without claiming a future halt time', () => {
    const s = operatorState(input())
    expect(s.status).toBe('enabled')
    expect(s.guards.find(g => g.id === 'drawdown')).toMatchObject({ status: 'watch', stopAt: 0.06 })
    expect(s.guards.find(g => g.id === 'drawdown')!.margin).toBeCloseTo(0.012)
    expect(s.outlook).toContain('0.0120 ETH')
  })
  it('keeps an unfresh open market reading unknown, while respecting any placed halt', () => {
    const x = input(); x.market!.fresh = false; x.kinds = ['venue']
    const guard = operatorState(x).guards.find(g => g.id === 'venue')!
    expect(guard).toMatchObject({ status: 'unknown', blocking: true, margin: null })
    expect(guard.detail).toContain('release the market pause')
  })
  it('distinguishes no opportunity to enter from a latched halt', () => {
    expect(operatorState(input({ open: 14 })).status).toBe('waiting')
    expect(operatorState(input({ logsAgeMs: 1001 })).why).toContain('logs are stale')
    expect(operatorState(input({ bankrollEth: 0.01 })).why).toContain('capital')
    expect(operatorState(input({ kinds: ['stopped'] })).status).toBe('needs-you')
  })
  it('requires a full positive post-stop window, flat book and remaining recovery allowance', () => {
    const x = input({ kinds: ['drawdown'] })
    expect(operatorState(x).recovery!.canClear).toBe(true)
    for (const patch of [{ recovery: { n: 17, sum: 1, at: 99000 } }, { recovery: { n: 20, sum: 0, at: 99000 } },
      { open: 1 }, { databaseOpen: 1 }, { liftsUsed: 2 }, { mode: 'shadow' }, { kinds: ['manual', 'drawdown'] as OperatorInput['kinds'] }]) {
      expect(operatorState({ ...x, ...patch }).recovery!.canClear).toBe(false)
    }
  })
  it('clearing drawdown does not imply entries resume beneath an operator stop', () => {
    const s = operatorState(input({ kinds: ['drawdown', 'stopped'] }))
    expect(s.recovery!.canClear).toBe(true)
    expect(s.recovery!.remainingBlockers).toEqual(['stopped'])
    expect(s.status).toBe('needs-you')
    expect(s.controls.canStart).toBe(false)
    expect(operatorState(input({ kinds: ['stopped', 'venue'] })).controls.canStart).toBe(true)
  })
})
