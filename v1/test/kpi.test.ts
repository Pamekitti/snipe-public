import { describe, expect, it } from 'vitest'
import { rollingKpis, windowKpi, median, minutesSinceLastTrade, type TradeRow } from '../src/telemetry/kpi.js'

const NOW = 1_760_000_000_000
const E = 1e18
/** minutesAgo, pnl in ETH, spend in ETH, reason */
const t = (minAgo: number, pnl: number, spend = 0.005, reason = 'time', verified = 1): TradeRow => ({
  exit_at: NOW - minAgo * 60_000,
  pnl: pnl * E,
  spend: spend * E,
  exit_reason: reason,
  verified,
})

describe('median', () => {
  it('is null on empty, the middle on odd, the mean of two on even', () => {
    expect(median([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
  })
})

describe('windowKpi', () => {
  it('counts only trades inside the window', () => {
    const rows = [t(5, 0.001), t(30, 0.001), t(200, 0.001)]
    expect(windowKpi(rows, '1h', 60 * 60_000, NOW).n).toBe(2)
    expect(windowKpi(rows, '4h', 4 * 60 * 60_000, NOW).n).toBe(3)
    expect(windowKpi(rows, '12h', 12 * 60 * 60_000, NOW).n).toBe(3)
  })

  it('returns null rates on an empty window, not zero', () => {
    // "no trades" and "no wins" must never render as the same thing
    const k = windowKpi([], '1h', 60 * 60_000, NOW)
    expect(k.n).toBe(0)
    expect(k.winRate).toBeNull()
    expect(k.lossRate).toBeNull()
    expect(k.popRate).toBeNull()
    expect(k.rotPct).toBeNull()
    expect(k.medianRotPct).toBeNull()
  })

  it('computes ROT as portfolio-level pnl over turnover', () => {
    // two trades, 0.005 each: +0.001 and -0.0005 -> +0.0005 on 0.010 turnover = +5%
    const k = windowKpi([t(1, 0.001), t(2, -0.0005)], '1h', 60 * 60_000, NOW)
    expect(k.rotPct).toBeCloseTo(5, 9)
    expect(k.turnoverUsd).toBeCloseTo(0.01, 9) // still ETH here; caller applies USD
  })

  it('separates the median from the mean when one winner carries the window', () => {
    // one +60% beside four -13%: +0.003 - 4x0.00065 = +0.0004 on 0.025 turnover, so ROT
    // is +1.6% while the typical trade lost money
    const rows = [t(1, 0.003), t(2, -0.00065), t(3, -0.00065), t(4, -0.00065), t(5, -0.00065)]
    const k = windowKpi(rows, '1h', 60 * 60_000, NOW)
    expect(k.rotPct!).toBeGreaterThan(0)
    expect(k.medianRotPct!).toBeLessThan(0) // the drizzle of losses is the typical trade
  })

  it('splits pop, win and loss rates correctly', () => {
    // pop = took profit; win = made money by any exit; they are not the same
    const rows = [
      t(1, 0.001, 0.005, 'tp'),
      t(2, 0.0002, 0.005, 'time'), // a win that did not pop
      t(3, -0.0006, 0.005, 'time'),
      t(4, -0.0006, 0.005, 'time'),
    ]
    const k = windowKpi(rows, '1h', 60 * 60_000, NOW)
    expect(k.popRate).toBe(25)
    expect(k.winRate).toBe(50)
    expect(k.lossRate).toBe(50)
  })

  it('treats an exactly-flat trade as neither a win nor a loss', () => {
    const k = windowKpi([t(1, 0)], '1h', 60 * 60_000, NOW)
    expect(k.winRate).toBe(0)
    expect(k.lossRate).toBe(0)
  })

  it('reports how much of the window is receipt-verified', () => {
    const k = windowKpi([t(1, 0.001, 0.005, 'tp', 1), t(2, 0.001, 0.005, 'tp', 0)], '1h', 60 * 60_000, NOW)
    expect(k.verifiedPct).toBe(50)
  })

  it('includes a trade exactly on the window boundary', () => {
    expect(windowKpi([t(60, 0.001)], '1h', 60 * 60_000, NOW).n).toBe(1)
  })

  it('ignores zero-spend rows when taking the median so they cannot divide by zero', () => {
    const k = windowKpi([t(1, 0.001, 0), t(2, 0.001, 0.005)], '1h', 60 * 60_000, NOW)
    expect(k.medianRotPct).toBeCloseTo(20, 9)
  })
})

describe('rollingKpis', () => {
  it('produces the four agreed windows, widest last', () => {
    // 24h is computed for the report skill and the alert path even though the page shows
    // only the first three; 15m went on 2026-09-12 because it was empty nearly always.
    const k = rollingKpis([], NOW, 2145)
    expect(k.map((x) => x.label)).toEqual(['1h', '4h', '12h', '24h'])
    expect(k[3]!.ms).toBeGreaterThan(k[0]!.ms)
  })

  it('applies the USD price to money but not to rates', () => {
    const k = rollingKpis([t(1, 0.001, 0.005, 'tp')], NOW, 2000)
    expect(k[0]!.pnlUsd).toBeCloseTo(2, 9)
    expect(k[0]!.turnoverUsd).toBeCloseTo(10, 9)
    expect(k[0]!.rotPct).toBeCloseTo(20, 9) // a ratio: unchanged by the price
  })

  it('nests: a trade in the 1h window is in every longer one too', () => {
    const k = rollingKpis([t(2, 0.001)], NOW, 2145)
    expect(k.every((x) => x.n === 1)).toBe(true)
  })
})

describe('minutesSinceLastTrade', () => {
  it('is null with no trades and otherwise measures the newest', () => {
    expect(minutesSinceLastTrade([], NOW)).toBeNull()
    expect(minutesSinceLastTrade([t(40, 0), t(7, 0)], NOW)).toBeCloseTo(7, 9)
  })
})
