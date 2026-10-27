import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bot } from '../src/bot.js'
import { RegimeGate } from '../src/strategy/gate.js'
import { STRATEGY } from '../src/config.js'
import { makeGateDb } from './helpers/gatedb.js'

describe('operator resume uses current recovery evidence before admitting entries', () => {
  let dir: string, bot: any, gateDb: ReturnType<typeof makeGateDb>, now: number
  const bots: any[] = []
  const create = () => {
    const b: any = new Bot({ mode: 'observe', dbFile: join(dir, 'bot.db') } as any)
    b.gate.close()
    b.gate = new RegimeGate(join(dir, 'gate.db'), () => now, null, false, join(dir, 'bot.db'))
    bots.push(b)
    return b
  }
  const fill = (sum: number, n = 20, msAgo = 60_000) => {
    gateDb.db.exec('DELETE FROM obs')
    for (let i = 0; i < n; i++) {
      const token = `0x${i}`
      bot.tel.raw().prepare('INSERT OR REPLACE INTO launches (token,creator_tax_bps,exemptions) VALUES (?,100,3)').run(token)
      gateDb.obs({ token, block: 1000 - i, launched_at: Math.floor((now - msAgo - i * 1000) / 1000),
        at: now - msAgo, touch: 1, bars: JSON.stringify({ '1.75': i === 0 ? sum : 0 }) })
    }
  }
  const allowed = (b = bot) => b.risk.canEnter({ token: '0xnew', sizeWei: 1n, logsHealthy: true, logsAgeMs: 0 }).allow
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'operator-recovery-'))
    now = Date.now()
    gateDb = makeGateDb(join(dir, 'gate.db'))
    gateDb.state('ran_at', String(now))
    bot = create()
    vi.spyOn(STRATEGY.gate, 'pnlPauseOn', 'get').mockReturnValue(2)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    for (const b of bots.splice(0)) { b.gate.close(); b.tel.close() }
    gateDb.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it.each([-2, 0.45, 1, 2])('does not start on fresh %s stakes even when the sensor remembered open', sum => {
    fill(3); bot.checkVenue()
    bot.operatorStop('dashboard stop')
    fill(sum)
    const reply = bot.operatorStart('dashboard resume')
    expect(reply).toContain('entries paused')
    expect(bot.risk.haltKinds).toEqual(['venue'])
    expect(bot.tel.truthGet('operator_stop')).toBe('0')
    expect(bot.tel.truthGet('operator_recovery')).toBe('1')
    expect(bot.venueReading().state).toBe('shut')
    expect(allowed()).toBe(false)
    bot.checkVenue()
    expect(allowed()).toBe(false)
  })

  it('resumes automatically above the threshold without resetting drawdown or its budget', () => {
    bot.risk.seedRealized(-30_000_000_000_000_000n, 0n)
    bot.risk.restoreDdLifts(1)
    fill(1); bot.operatorStop('dashboard stop'); bot.operatorStart('dashboard resume')
    fill(2.01); bot.checkVenue()
    expect(allowed()).toBe(true)
    expect(bot.tel.truthGet('operator_recovery')).toBe('0')
    expect(bot.risk.realizedPnlWei).toBe(-30_000_000_000_000_000n)
    expect(bot.risk.ddLiftsUsed).toBe(1)
    // Normal operation resumes its usual band after the initial recovery passes.
    fill(0.45); bot.checkVenue(); expect(allowed()).toBe(true)
  })

  it('can enable immediately when current recovery evidence already passes', () => {
    fill(3); bot.operatorStop('dashboard stop')
    expect(bot.operatorStart('dashboard resume')).toContain('recovery checks passed')
    expect(allowed()).toBe(true)
  })

  it('keeps a missing reading paused and survives a process restart inside the band', () => {
    bot.operatorStop('dashboard stop'); bot.operatorStart('dashboard resume')
    expect(allowed()).toBe(false)
    const restarted = create()
    restarted.restoreHaltState()
    expect(restarted.risk.haltKinds).toEqual(['venue'])
    fill(1); restarted.checkVenue(); expect(allowed(restarted)).toBe(false)
    fill(3); restarted.checkVenue(); expect(allowed(restarted)).toBe(true)
  })

  it.each([['old', 20, 4 * 3600_000], ['incomplete', 19, 60_000]] as const)(
    'retains the selected stale-data exception for an %s window', (_, n, msAgo) => {
      fill(-2, n, msAgo); bot.operatorStop('dashboard stop'); bot.operatorStart('dashboard resume')
      expect(bot.venueReading().fresh).toBe(false)
      expect(allowed()).toBe(true)
    })

  it('does not carry a fleeting recovery past a higher-priority stop', () => {
    fill(1); bot.operatorStop('dashboard stop'); bot.operatorStart('dashboard resume')
    bot.risk.halt('touch gate holding', 'gate')
    fill(3); bot.checkVenue(); expect(allowed()).toBe(false)
    fill(1); bot.risk.resume('gate'); bot.checkVenue()
    expect(allowed()).toBe(false)
    fill(3); bot.checkVenue(); expect(allowed()).toBe(true)
  })

  it.each(['manual', 'broken', 'drawdown'] as const)('cannot bypass %s or reset its accounting', kind => {
    fill(3); bot.operatorStop('dashboard stop'); bot.risk.halt('higher-priority stop', kind)
    bot.operatorStart('dashboard resume')
    expect(bot.risk.isHalted('stopped')).toBe(true)
    expect(bot.risk.isHalted(kind)).toBe(true)
    expect(bot.tel.truthGet('operator_recovery')).toBeNull()
  })

  it('keeps a second manual stop until the operator resumes again', () => {
    fill(1); bot.operatorStop('dashboard stop'); bot.operatorStart('dashboard resume')
    bot.operatorStop('second stop'); fill(3); bot.checkVenue()
    expect(bot.risk.isHalted('stopped')).toBe(true)
    expect(allowed()).toBe(false)
    fill(1); bot.operatorStart('second resume'); expect(allowed()).toBe(false)
    bot.operatorStart('duplicate resume'); expect(allowed()).toBe(false)
  })

  it('rolls back the resume request if persisting either half fails', () => {
    fill(3); bot.operatorStop('dashboard stop')
    const write = bot.tel.truthSet.bind(bot.tel)
    vi.spyOn(bot.tel, 'truthSet').mockImplementation((key: any, value: any) => {
      if (key === 'operator_stop') throw new Error('write failed')
      write(key, value)
    })
    expect(() => bot.operatorStart('dashboard resume')).toThrow('write failed')
    expect(bot.tel.truthGet('operator_stop')).toBe('1')
    expect(bot.tel.truthGet('operator_recovery')).toBeNull()
    expect(allowed()).toBe(false)
  })

  it('keeps entries paused if persisting successful recovery fails', () => {
    fill(1); bot.operatorStop('dashboard stop'); bot.operatorStart('dashboard resume')
    fill(3)
    vi.spyOn(bot.tel, 'truthSet').mockImplementation(() => { throw new Error('write failed') })
    expect(() => bot.checkVenue()).toThrow('write failed')
    expect(allowed()).toBe(false)
    expect(bot.tel.truthGet('operator_recovery')).toBe('1')
  })
})
