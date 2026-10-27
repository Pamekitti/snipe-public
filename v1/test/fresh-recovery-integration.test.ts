import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bot } from '../src/bot.js'
import * as store from '../src/config/store.js'

const bots: any[]=[]
afterEach(() => { vi.restoreAllMocks(); for (const b of bots.splice(0)) { b.gate.close(); b.tel.close() } })
function bot() {
  const b: any=new Bot({ mode:'observe',dbFile:':memory:' }); bots.push(b)
  vi.spyOn(store,'config').mockReturnValue({ ...store.config(), venueFreshRecovery:true })
  b.shadow={ read:vi.fn(() => ({ source:'adaptive-shadow',state:'open',sum:3,recentSum:2,n:20,fresh:true,oldestAgeMs:1000,bar:'adaptive' })) }
  return b
}
describe('fresh market recovery respects other account stops', () => {
  it.each(['manual','broken','drawdown','stopped','gate'])('cannot lift %s', kind => {
    const b=bot(); b.risk.halt('other stop',kind); b.risk.halt('market pause','venue')
    b.checkVenue()
    expect(b.risk.isHalted(kind)).toBe(true)
    expect(b.risk.isHalted('venue')).toBe(true)
    expect(b.risk.halted).toBe(true)
  })
  it('lifts only the venue pause when no higher-priority stop holds', () => {
    const b=bot(); b.risk.halt('market pause','venue'); b.checkVenue()
    expect(b.risk.halted).toBe(false)
  })
  it('never falls back to fixed-bar readings if the shadow service fails', () => {
    const b=bot(); b.shadow.read.mockImplementation(() => { throw new Error('database unreadable') })
    const legacy=vi.spyOn(b.gate,'readVenue')
    b.checkVenue()
    expect(legacy).not.toHaveBeenCalled(); expect(b.risk.isHalted('venue')).toBe(true)
  })
  it('presentation reads do not advance the guard', () => {
    const b=bot(); b.checkVenue(); const n=b.shadow.read.mock.calls.length
    b.venueReading(); b.venueReading()
    expect(b.shadow.read).toHaveBeenCalledTimes(n)
  })
})

// Adaptive evidence must remain the entry authority throughout warmup.
describe('the adaptive sensor while its window is still filling', () => {
  const warming = (over: any = {}) => ({ source:'adaptive-shadow',state:'shut',sum:0,recentSum:0,n:3,
    fresh:false,oldestAgeMs:1000,bar:'adaptive',reason:'stale_or_warmup',observerError:'shadow observer starting',
    verified:false, ...over })

  it('keeps entries paused through warmup after a restart', () => {
    const b=bot(); b.shadow.read.mockReturnValue(warming({ verified:true }))
    const legacy=vi.spyOn(b.gate,'readVenue').mockReturnValue(
      { state:'open',sum:2.7,n:20,fresh:true,oldestAgeMs:1000,bar:'1.75' } as any)
    b.risk.halt('market pause','venue')
    b.checkVenue()
    expect(legacy).not.toHaveBeenCalled()
    expect(b.risk.halted).toBe(true)
  })

  it('shows the adaptive warmup reason without switching the indicator', () => {
    const b=bot(); b.shadow.read.mockReturnValue(warming({ verified:true }))
    vi.spyOn(b.gate,'readVenue').mockReturnValue(
      { state:'open',sum:2.7,n:20,fresh:true,oldestAgeMs:1000,bar:'1.75' } as any)
    b.checkVenue()
    expect(b.venueReading().source).toBe('adaptive-shadow')
    expect(b.venueReading().reason).toBe('stale_or_warmup')
    expect(b.venueReading().state).toBe('shut')
  })

  it('still refuses to fall back when the observer is FAULTING, not warming', () => {
    const b=bot(); b.shadow.read.mockReturnValue(warming({ observerError:'shadow worker heartbeat stale' }))
    const legacy=vi.spyOn(b.gate,'readVenue')
    b.checkVenue()
    expect(legacy).not.toHaveBeenCalled()
    expect(b.risk.isHalted('venue')).toBe(true)
  })

  it('does not let gatewatch argue with a fresh adaptive pause', () => {
    // a full, verified, fresh window that says shut is a real pause
    const b=bot(); b.shadow.read.mockReturnValue(
      { source:'adaptive-shadow',state:'shut',sum:-3,recentSum:-2,n:20,fresh:true,oldestAgeMs:1000,bar:'adaptive',reason:'score_brake' })
    const legacy=vi.spyOn(b.gate,'readVenue')
    b.checkVenue()
    expect(legacy).not.toHaveBeenCalled()
    expect(b.risk.isHalted('venue')).toBe(true)
  })
})
