/**
 * The daily edge check as the dashboard sees it: parsing what scripts/edgecheck.py wrote,
 * and the alerts a rule that stopped paying turns into. The script itself is Python and
 * is smoke-tested on the box; what this pins is that the page can never throw on it and
 * never invents a verdict.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { HaltKind } from '../src/strategy/risk.js'

const doc = (over: Record<string, unknown> = {}) => JSON.stringify({
  ran_at: Date.now() - 3600_000, bar: 1.75, main_neg_streak: 0,
  verdicts: [
    { rule: 'main-book', ok: true, why: '7d real: n=300 $+108.00 win 48%' },
    { rule: 'exempt-floor', ok: true, why: '...' },
    { rule: 'clock', ok: true, why: '...' },
  ],
  windows: { '7d': { real_main: { n: 300, pnl_usd: 108, win: 48 } } },
  ...over,
})

describe('parseEdge', () => {
  it('parses a good document and computes its age', async () => {
    const { parseEdge } = await import('../src/telemetry/dashboard.js')
    const e = parseEdge(doc(), Date.now())!
    expect(e.verdicts).toHaveLength(3)
    expect(e.ageMs).toBeGreaterThanOrEqual(3600_000 - 1000)
    expect(e.bar).toBe(1.75)
    expect((e.windows as any)['7d'].real_main.n).toBe(300)
  })

  it('returns null, never throws, on every degenerate shape', async () => {
    const { parseEdge } = await import('../src/telemetry/dashboard.js')
    for (const raw of [null, undefined, '', '<html>', '42', '"x"', '[]', '{}', JSON.stringify({ ran_at: 'yesterday' })]) {
      expect(() => parseEdge(raw as any)).not.toThrow()
      expect(parseEdge(raw as any)).toBeNull()
    }
  })

  it('drops malformed verdicts instead of inventing them', async () => {
    const { parseEdge } = await import('../src/telemetry/dashboard.js')
    const e = parseEdge(doc({ verdicts: [{ rule: 'main-book', ok: false, why: 'x' }, { rule: 7 }, null, { ok: true }] }))!
    expect(e.verdicts).toEqual([{ rule: 'main-book', ok: false, why: 'x' }])
    expect(parseEdge(doc({ verdicts: 'none' }))!.verdicts).toEqual([])
  })
})

describe('buildAlerts, the edge check', () => {
  const base = {
    halted: false, haltReason: '', haltKind: null as HaltKind | null,
    autoResumes: false, resumesWhen: null as string | null,
    dayPnlUsd: 0, dayLossLimitUsd: 30,
    feedConnected: true, feedAgeMs: 0,
    logsHealthy: true, logsAgeMs: 0, logsStaleLimit: 3_000,
    drawdownUsd: 0, drawdownLimitUsd: 75,
    gateState: 'open' as const, gateRate: 40, gateHeartbeatMs: 0, gateDataAgeMs: 0,
    minsSinceTrade: 1, upMs: 3_600_000,
    rot1h: 0, n1h: 0,
    stuck: 0, stranded: 0, exitFailures: 0,
    buyFails: 0, buyAttempts: 0, buyOutOfGas: 0, buyGasHeadroom: null as number | null,
  }
  const ids = async (over: Record<string, unknown>) => {
    const { buildAlerts } = await import('../src/telemetry/dashboard.js')
    return buildAlerts({ ...base, ...over } as any).map((x) => `${x.id}:${x.sev}`)
  }

  it('is silent when not asked, and says so when the check has never run', async () => {
    expect(await ids({})).toEqual([])
    expect(await ids({ edgeAgeMs: null })).toEqual(['edgestale:warn'])
  })

  it('warns when the check is stale', async () => {
    expect(await ids({ edgeAgeMs: 12 * 3600_000 })).toEqual([])
    expect(await ids({ edgeAgeMs: 37 * 3600_000 })).toEqual(['edgestale:warn'])
  })

  it('one line per rule that stopped paying, and the main book escalates after three runs', async () => {
    const verdicts = [
      { rule: 'main-book', ok: false, why: 'n=40 $-12.00' },
      { rule: 'exempt-floor', ok: false, why: '1-2 beats 3+' },
      { rule: 'clock', ok: true, why: 'fine' },
    ]
    expect(await ids({ edgeAgeMs: 1000, edgeVerdicts: verdicts, edgeMainStreak: 1 }))
      .toEqual(['edge-main-book:warn', 'edge-exempt-floor:warn'])
    expect(await ids({ edgeAgeMs: 1000, edgeVerdicts: verdicts, edgeMainStreak: 3 }))
      .toEqual(['edge-main-book:crit', 'edge-exempt-floor:warn'])
    // the streak only escalates the main book, never a filter verdict
    expect(await ids({ edgeAgeMs: 1000, edgeVerdicts: [verdicts[1]!], edgeMainStreak: 5 }))
      .toEqual(['edge-exempt-floor:warn'])
  })

  it('all rules paying is no alert', async () => {
    expect(await ids({ edgeAgeMs: 1000, edgeVerdicts: [{ rule: 'main-book', ok: true, why: '' }] })).toEqual([])
  })
})

describe('scripts/edgecheck.py', () => {
  const py = readFileSync(new URL('../scripts/edgecheck.py', import.meta.url), 'utf8')

  it('reads the live strategy rather than keeping its own copy, and replays nothing itself', () => {
    // the only-simulator rule (configdrift.test.ts): it must join gatewatch's obs.bars, not
    // call engine.evaluate and become a fourth replay
    expect(py).toMatch(/WHERE key='strategy_json'/)
    for (const k of ['takeProfitOtherwise', 'takeProfitAdaptiveBars', 'takeProfitAdaptiveWindow', 'minExemptionsToEnter', 'minCreatorTaxBps']) {
      expect(py, `edgecheck.py does not read ${k}`).toContain(k)
    }
    expect(py).not.toMatch(/engine\.evaluate/)
    expect(py).not.toMatch(/import engine/)
    expect(py).toMatch(/bars IS NOT NULL/)
  })

  it('keeps the non-trade list in step with telemetry/db.ts', () => {
    expect(py).toMatch(/NON_TRADE = \("recovered-flat", "buy-reverted", "buy-never-mined"\)/)
  })

  it('exits 0 on any exception: a monitor that crashes is worse than one that prints less', () => {
    expect(py).toMatch(/except Exception as e:[\s\S]*sys\.exit\(0\)/)
  })
})
