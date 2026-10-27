/**
 * The adaptive take profit: whichever bar earned the most over the trailing window, pinned
 * at open. Three layers, tested separately: the pure argmax, the gate.db read that feeds it,
 * and the bot's pick, which must be a pure function of a cache refreshed off the hot path.
 *
 * Measured 2026-09-05 on 1,746 taxed cohort launches: +4.5% over the best fixed bar,
 * walk-forward, beating 98% of 300 time-shuffles. See STRATEGY.takeProfit.adaptive.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adaptiveTakeProfit, barKey } from '../src/strategy/takeprofit.js'
import { RegimeGate } from '../src/strategy/gate.js'
import { makeGateDb } from './helpers/gatedb.js'
import { Bot } from '../src/bot.js'
import { STRATEGY } from '../src/config.js'
import { settle } from './helpers/settle.js'

const BARS = [1.25, 1.36, 1.50, 1.75, 2.00] as const
const row = (o: Record<string, number>) => o
const flat = (m: Record<number, number>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [barKey(Number(k)), v]))

describe('adaptiveTakeProfit: the argmax', () => {
  it('picks the bar with the highest sum over the window', () => {
    const rows = [
      row(flat({ 1.25: 0.1, 1.36: 0.2, 1.5: 0.3, 1.75: 0.9, 2.0: 0.4 })),
      row(flat({ 1.25: 0.1, 1.36: 0.2, 1.5: 0.3, 1.75: 0.1, 2.0: 0.4 })),
    ]
    expect(adaptiveTakeProfit(rows, 2, BARS, 1.36).multiple).toBe(1.75)
  })
  it('breaks ties toward the LOWEST bar, matching the research and the conservative side', () => {
    const rows = [row(flat({ 1.25: 0.5, 1.36: 0.5, 1.5: 0.5, 1.75: 0.5, 2.0: 0.5 }))]
    expect(adaptiveTakeProfit(rows, 1, BARS, 1.75).multiple).toBe(1.25)
  })
  it('uses only the newest `window` rows: older ones must not vote', () => {
    const rows = [
      row(flat({ 1.25: 0.0, 2.0: 1.0 })),   // newest
      row(flat({ 1.25: 0.0, 2.0: 1.0 })),
      row(flat({ 1.25: 9.0, 2.0: 0.0 })),   // oldest, outside a window of 2
    ]
    expect(adaptiveTakeProfit(rows, 2, BARS, 1.36).multiple).toBe(2.0)
  })
  it('falls back when fewer than `window` rows are scored', () => {
    const rows = [row(flat({ 1.25: 0, 2.0: 5 }))]
    const r = adaptiveTakeProfit(rows, 20, BARS, 1.75)
    expect(r.multiple).toBe(1.75)
    expect(r.why).toContain('1 of 20')
  })
  it('falls back on no reading at all', () => {
    expect(adaptiveTakeProfit(null, 20, BARS, 1.75).multiple).toBe(1.75)
  })
  it('falls back when the rows carry none of the traded bars (bar set changed under them)', () => {
    const rows = [row({ '9.99': 1.0 }), row({ '9.99': 1.0 })]
    const r = adaptiveTakeProfit(rows, 2, BARS, 1.75)
    expect(r.multiple).toBe(1.75)
    expect(r.why).toContain('none of the traded bars')
  })
  it('a bar missing from SOME rows scores zero there, it does not poison the read', () => {
    const rows = [row(flat({ 1.25: 0.1, 2.0: 0.6 })), row(flat({ 1.25: 0.1 }))]
    expect(adaptiveTakeProfit(rows, 2, BARS, 1.36).multiple).toBe(2.0)  // 0.6 > 0.2
  })
  it('barKey pins two decimals so 1.5 and 1.50 are one key', () => {
    expect(barKey(1.5)).toBe('1.50')
    expect(barKey(1.36)).toBe('1.36')
  })
})

describe('RegimeGate.readBars: the window from gate.db', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
  const mk = (rows: Array<{ bars: string | null; block: number; error?: string | null }>) => {
    dir = mkdtempSync(join(tmpdir(), 'adaptive-'))
    const file = join(dir, 'gate.db')
    const g = makeGateDb(file)
    for (const [i, r] of rows.entries()) g.obs({ token: `t${i}`, block: r.block, bars: r.bars, error: r.error ?? null, at: 1 })
    g.state('ran_at', String(Date.now()))
    g.close()
    return file
  }
  it('returns null with no database', () => {
    expect(new RegimeGate('/nonexistent/gate.db').readBars(20)).toBeNull()
  })
  it('skips rows scored before the schema (bars NULL) and returns newest block first', () => {
    const f = mk([
      { block: 1, bars: JSON.stringify({ '1.36': 0.1 }) },
      { block: 2, bars: null },
      { block: 3, bars: JSON.stringify({ '1.36': 0.3 }) },
    ])
    const rows = new RegimeGate(f).readBars(20)!
    expect(rows.map((r) => r['1.36'])).toEqual([0.3, 0.1])
  })
  it('drops a row that fails to parse rather than failing the read', () => {
    const f = mk([{ block: 1, bars: 'not json' }, { block: 2, bars: JSON.stringify({ '1.36': 0.2 }) }])
    expect(new RegimeGate(f).readBars(20)!.map((r) => r['1.36'])).toEqual([0.2])
  })
  it('honours the LIMIT', () => {
    const f = mk([1, 2, 3, 4].map((b) => ({ block: b, bars: JSON.stringify({ '1.36': b }) })))
    expect(new RegimeGate(f).readBars(2)!.length).toBe(2)
  })
  it('excludes errored rows', () => {
    const f = mk([{ block: 1, bars: JSON.stringify({ '1.36': 0.9 }), error: 'boom' }])
    expect(new RegimeGate(f).readBars(20)).toEqual([])
  })
})

describe('Bot.pickTakeProfit rides the cache, off the hot path', () => {
  let dir: string
  let bot: Bot
  afterEach(async () => { await settle(); bot.tel.close(); rmSync(dir, { recursive: true, force: true }) })
  const mkbot = () => {
    dir = mkdtempSync(join(tmpdir(), 'adaptive-bot-'))
    bot = new Bot({ mode: 'shadow', dbFile: join(dir, 'bot.db') } as any)
    return bot as any
  }
  const A = STRATEGY.takeProfit.adaptive
  const fullWindow = (winner: number) => Array.from({ length: A.window }, () =>
    Object.fromEntries(A.bars.map((b) => [barKey(b), b === winner ? 1 : 0])))

  it('uses the adaptive bar when the cache is fresh and full', () => {
    const b = mkbot(); const now = Date.now()
    b.lastBars = { rows: fullWindow(2.5), at: now - 1000 }
    expect(b.pickTakeProfit(now).multiple).toBe(2.5)
  })
  it('falls back to the fixed bar when the cache is older than maxRateAgeMs', () => {
    const b = mkbot(); const now = Date.now()
    b.lastBars = { rows: fullWindow(2.5), at: now - STRATEGY.takeProfit.maxRateAgeMs - 1 }
    expect(b.pickTakeProfit(now).multiple).toBe(STRATEGY.takeProfit.otherwise)
  })
  it('falls back to the fixed bar with no cache at all (fresh boot, watcher not yet run)', () => {
    const b = mkbot()
    expect(b.pickTakeProfit(Date.now()).multiple).toBe(STRATEGY.takeProfit.otherwise)
  })
  it('falls back when the cache is fresh but short of the window', () => {
    const b = mkbot(); const now = Date.now()
    b.lastBars = { rows: fullWindow(2.5).slice(0, A.window - 1), at: now }
    expect(b.pickTakeProfit(now).multiple).toBe(STRATEGY.takeProfit.otherwise)
  })
  it('the shipped bar set is ascending and contains the fixed bar, so ties and fallbacks are coherent', () => {
    const bars = [...A.bars]
    expect([...bars].sort((x, y) => x - y)).toEqual(bars)
    expect(bars).toContain(STRATEGY.takeProfit.otherwise)
    expect(A.window).toBeGreaterThanOrEqual(5)
    expect(A.window).toBeLessThanOrEqual(20)   // N>=25 lost in the research
  })
})
