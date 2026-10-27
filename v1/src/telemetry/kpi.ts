/**
 * Rolling-window trade KPIs.
 *
 * The dashboard used to answer only "how has it gone since launch". That number is the
 * wrong one for an operator: on 2026-08-18 the venue's touch rate fell from ~70% to 12.5%
 * and the bot traded down the slope for eight hours, while the cumulative figure stayed
 * green the whole time because of the days that came before it. The same database today
 * reads -$35 all-time, +$24 this epoch and +$13 for the last hour. Only the last one says
 * anything about now.
 *
 * So every headline number here is windowed, and the windows sit side by side on purpose:
 * one column falling while the longer ones still look fine IS the early warning.
 *
 * Pure functions over plain rows, so the arithmetic can be tested without a database.
 */

/** the trade shape the dashboard query produces; pnl and spend are wei as REAL */
export type TradeRow = {
  exit_at: number
  spend: number
  pnl: number
  exit_reason: string
  verified: number
  /** which book opened the row. Absent on rows the query did not ask for it. */
  book?: string
}

export type Kpi = {
  label: string
  ms: number
  n: number
  pnlUsd: number
  turnoverUsd: number
  rotPct: number | null
  medianRotPct: number | null
  popRate: number | null
  winRate: number | null
  lossRate: number | null
  verifiedPct: number | null
}

/**
 * 1h is the column that moves first; 15m was dropped on 2026-09-12 because at ~27 trades a
 * day it held zero or one trade and rendered as dashes. 24h stays computed for the `rot`
 * alert's neighbour (`dashboard.ts` needs 1h) and for the report skill, which reads its n;
 * the page shows 1h / 4h / 12h and leaves the calendar day to the Today card.
 */
export const WINDOWS: Array<{ label: string; ms: number }> = [
  { label: '1h', ms: 60 * 60_000 },
  { label: '4h', ms: 4 * 60 * 60_000 },
  { label: '12h', ms: 12 * 60 * 60_000 },
  { label: '24h', ms: 24 * 60 * 60_000 },
]

export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/**
 * Sample standard deviation, n-1 in the denominator, null below two samples.
 *
 * The house rule is "never a mean alone: median, sd and n", and until the book comparison
 * landed there was no sd helper anywhere in src/, so every mean the page printed was printed
 * alone. n-1 rather than n because these are samples of a process that keeps running, not a
 * finished population, and at the n the book table gates on (30) the two differ by 1.7%.
 *
 * Returns null at n<2 rather than 0. A single trade has no spread, and rendering that as
 * "sd 0.0" reads as "perfectly consistent" instead of "one data point".
 */
export function sampleSd(xs: number[]): number | null {
  if (xs.length < 2) return null
  const mean = xs.reduce((a, x) => a + x, 0) / xs.length
  const ss = xs.reduce((a, x) => a + (x - mean) * (x - mean), 0)
  return Math.sqrt(ss / (xs.length - 1))
}

/**
 * One window's numbers. Rates return null rather than 0 on an empty window, because "no
 * trades" and "no wins" must not render as the same thing on a page you glance at.
 *
 * ROT is portfolio-level (sum pnl / sum spend), which is what the strategy earns per
 * dollar put at risk. The median is per-trade and answers a different question: a +4%
 * mean carried by one +45% winner beside a crowd of -13% losers is a different business
 * from an even drizzle, and no single average separates those.
 */
export function windowKpi(rows: TradeRow[], label: string, ms: number, now: number): Kpi {
  const cut = now - ms
  const w = rows.filter((r) => r.exit_at >= cut)
  const n = w.length
  const pnl = w.reduce((a, r) => a + r.pnl, 0)
  const spend = w.reduce((a, r) => a + r.spend, 0)
  const rots = w.filter((r) => r.spend > 0).map((r) => (r.pnl / r.spend) * 100)
  return {
    label,
    ms,
    n,
    pnlUsd: pnl / 1e18,
    turnoverUsd: spend / 1e18,
    rotPct: spend > 0 ? (pnl / spend) * 100 : null,
    medianRotPct: median(rots),
    popRate: n ? (100 * w.filter((r) => r.exit_reason === 'tp').length) / n : null,
    winRate: n ? (100 * w.filter((r) => r.pnl > 0).length) / n : null,
    lossRate: n ? (100 * w.filter((r) => r.pnl < 0).length) / n : null,
    verifiedPct: n ? (100 * w.filter((r) => r.verified).length) / n : null,
  }
}

/** USD conversion is applied by the caller so this stays unit-agnostic and testable. */
export function rollingKpis(rows: TradeRow[], now: number, ethUsd: number): Kpi[] {
  return WINDOWS.map((s) => {
    const k = windowKpi(rows, s.label, s.ms, now)
    return { ...k, pnlUsd: k.pnlUsd * ethUsd, turnoverUsd: k.turnoverUsd * ethUsd }
  })
}

/**
 * Minutes since the last closed trade. A bot that has quietly stopped entering looks
 * exactly like a quiet market on every other panel, so this is the number that catches a
 * dead filter, a starved log stream, or a screen that rejects everything.
 */
export function minutesSinceLastTrade(rows: TradeRow[], now: number): number | null {
  if (!rows.length) return null
  const last = rows.reduce((a, r) => Math.max(a, r.exit_at), 0)
  return (now - last) / 60_000
}
