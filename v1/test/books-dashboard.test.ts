/**
 * Phase 3: the two-book dashboard.
 *
 * Every test here is about a way the page could quietly lie. The arithmetic ones (sampleSd,
 * bookSummary) are cheap; the ones that matter are the four that pin a shape the rest of the
 * system reads: `kpis` staying the wallet sum, `rejects` staying wallet-level and whole, the
 * delta gate living on the server, and the reject funnel refusing to attribute a launch whose
 * creator tax could not be read.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { sampleSd } from '../src/telemetry/kpi.js'
import { bookSummary, bookRejectFunnel, bookDelta, unstampedBook, DELTA_MIN_N } from '../src/telemetry/dashboard.js'
import type { TradeRow } from '../src/telemetry/kpi.js'

const row = (pnl: number, spend = 1e18, book = 'main'): TradeRow =>
  ({ exit_at: 1, spend, pnl, exit_reason: 'tp', verified: 1, book })

describe('sampleSd', () => {
  it('is the n-1 sample deviation and is null below two samples', () => {
    expect(sampleSd([])).toBeNull()
    // one trade has no spread. 0 would read as "perfectly consistent", which is a different claim.
    expect(sampleSd([5])).toBeNull()
    // hand-checked: mean 4, ss = 4+0+4 = 8, 8/2 = 4, sqrt = 2
    expect(sampleSd([2, 4, 6])).toBe(2)
    // n-1, not n: with n it would be sqrt(8/3) = 1.633
    expect(sampleSd([2, 4, 6])).not.toBeCloseTo(Math.sqrt(8 / 3), 6)
  })
})

describe('bookSummary', () => {
  it('reports the portfolio return AND the per-trade distribution, never one alone', () => {
    // +45% once against three -13% losers: the portfolio number is positive and the median
    // is negative. That disagreement is the whole reason both are printed.
    const rows = [row(0.45e18), row(-0.13e18), row(-0.13e18), row(-0.13e18)]
    const s = bookSummary(rows, 2000)
    expect(s.n).toBe(4)
    expect(s.rotPct).toBeCloseTo(1.5, 6)
    expect(s.medianRotPct).toBeCloseTo(-13, 6)
    expect(s.medianRotPct!).toBeLessThan(0)
    expect(s.rotPct!).toBeGreaterThan(0)
    // and the spread is what says which of the two to believe: 29 points of sd on n=4
    expect(s.sdRotPct).toBeCloseTo(29, 6)
  })

  it('carries sd and n beside the median, and USD off the passed price', () => {
    const rows = [row(0.1e18), row(-0.1e18)]
    const s = bookSummary(rows, 2000)
    expect(s.pnlEth).toBeCloseTo(0, 9)
    expect(s.pnlUsd).toBeCloseTo(0, 6)
    expect(s.sdRotPct).toBeCloseTo(Math.sqrt(((10 - 0) ** 2 + (-10 - 0) ** 2) / 1), 6)
    expect(s.winRate).toBe(50)
  })

  it('returns null rates on an empty book rather than zeroes', () => {
    const s = bookSummary([], 2000)
    expect(s.n).toBe(0)
    // "no trades" and "no wins" must not render as the same cell.
    expect(s.rotPct).toBeNull()
    expect(s.winRate).toBeNull()
    expect(s.sdRotPct).toBeNull()
  })
})

describe('the post-band reject funnel', () => {
  const books = [{ id: 'untaxed', minTaxBps: 0, maxTaxBps: 0 }, { id: 'taxed', minTaxBps: 50, maxTaxBps: 10000 }]
  const make = () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE launches (token TEXT PRIMARY KEY, creator_tax_bps INTEGER,
      detected_at INTEGER, passed INTEGER, entry_reject TEXT)`)
    return db
  }
  const put = (db: Database.Database, token: string, tax: number | null, reject: string | null, passed = 1, at = 500) =>
    db.prepare('INSERT INTO launches VALUES (?,?,?,?,?)').run(token, tax, at, passed, reject)

  it('routes each launch to exactly one book and keeps the denominators apart', () => {
    const db = make()
    try {
      put(db, 'a', 0, null); put(db, 'b', 0, 'exempt 1 < 3'); put(db, 'c', 0, 'halted: venue')
      put(db, 'd', 500, null); put(db, 'e', 500, 'tax 500 > 0')
      const f = bookRejectFunnel(db, books, 0, 1000)
      expect(f.get('untaxed')).toMatchObject({ n: 3, entered: 1, buckets: { exempt: 1, 'halted:': 1 } })
      expect(f.get('taxed')).toMatchObject({ n: 2, entered: 1, buckets: { tax: 1 } })
      // disjoint bands: nothing is counted twice, so the two denominators sum to the input
      expect(f.get('untaxed')!.n + f.get('taxed')!.n).toBe(5)
    } finally { db.close() }
  })

  it('gives an unreadable creator tax to NO book', () => {
    const db = make()
    try {
      // -1 is the failed-read sentinel and null is a row written before the column. A book
      // with a floor of 0 must not inherit every launch whose tax the RPC refused to answer.
      put(db, 'a', -1, null); put(db, 'b', null, null); put(db, 'c', 0, null)
      const f = bookRejectFunnel(db, books, 0, 1000)
      expect(f.get('untaxed')!.n).toBe(1)
      expect(f.get('taxed')!.n).toBe(0)
    } finally { db.close() }
  })

  it('counts only launches that passed the book screen, and only inside the window', () => {
    const db = make()
    try {
      put(db, 'a', 0, null, 0)              // failed the screen: belongs to no book's funnel
      put(db, 'b', 0, null, 1, 5_000)       // outside the window
      put(db, 'c', 0, null, 1, 500)
      const f = bookRejectFunnel(db, books, 0, 1000)
      expect(f.get('untaxed')!.n).toBe(1)
    } finally { db.close() }
  })

  it('buckets on the FIRST WORD of the reject reason', () => {
    const db = make()
    try {
      // bumpReject's first word is the bucket and the rest is the detail. Splitting on
      // anything else shatters ten buckets into hundreds, one per distinct detail string.
      put(db, 'a', 0, 'exempt 1 < 3'); put(db, 'b', 0, 'exempt 2 < 3'); put(db, 'c', 0, 'exempt 0 < 3')
      const f = bookRejectFunnel(db, books, 0, 1000)
      expect(f.get('untaxed')!.buckets).toEqual({ exempt: 3 })
    } finally { db.close() }
  })

  it('returns empty slots rather than throwing when the launches table has no entry_reject', () => {
    const db = new Database(':memory:')
    try {
      db.exec('CREATE TABLE launches (token TEXT PRIMARY KEY)')
      const f = bookRejectFunnel(db, books, 0, 1000)
      expect([...f.keys()]).toEqual(['untaxed', 'taxed'])
      expect(f.get('untaxed')).toMatchObject({ n: 0, entered: 0 })
    } finally { db.close() }
  })
})

describe('the delta gate', () => {
  const block = (id: string, n: number, rotPct: number, winRate = 50) =>
    ({ id, trades: { n, rotPct, medianRotPct: rotPct, winRate } })

  it('refuses to compare a single book', () => {
    const d = bookDelta([block('main', 400, 5)])
    expect(d.ready).toBe(false)
    expect(d.b).toBeNull()
    expect(d.rotPct).toBeUndefined()
  })

  it('holds the difference back until BOTH books clear 30 closed trades, and says which is short', () => {
    expect(DELTA_MIN_N).toBe(30)
    const d = bookDelta([block('untaxed', 40, 5), block('taxed', 7, -2)])
    expect(d.ready).toBe(false)
    // the sentence names the book and the count, because "not enough data" is not actionable
    expect(d.why).toContain('taxed has 7 of 30')
    // and NO number is published, or a reader downstream would print what the page is greying
    expect(d.rotPct).toBeUndefined()
  })

  it('publishes a minus b once both sides clear the gate', () => {
    const d = bookDelta([block('untaxed', 30, 5.0, 60), block('taxed', 31, -2.0, 25)])
    expect(d.ready).toBe(true)
    expect(d.why).toBeNull()
    expect(d.rotPct).toBeCloseTo(7, 9)
    expect(d.winRate).toBeCloseTo(35, 9)
    expect(d.nA).toBe(30); expect(d.nB).toBe(31)
  })

  it('returns null for a metric either side could not compute, never zero', () => {
    const d = bookDelta([
      { id: 'a', trades: { n: 30, rotPct: 5, medianRotPct: null, winRate: 50 } },
      { id: 'b', trades: { n: 30, rotPct: 1, medianRotPct: 2, winRate: 50 } },
    ])
    expect(d.ready).toBe(true)
    // a missing median is not a median of zero, and a zero difference is a real finding
    expect(d.medianRotPct).toBeNull()
    expect(d.winRate).toBe(0)
  })
})

describe('the page the books render into', () => {
  it('keeps exactly four uPlot panes, so the rejects funnel has to be HTML', async () => {
    const { dashboardHtml } = await import('../src/telemetry/dashboard-page.js')
    const html = dashboardHtml()
    // A ten-bucket named-category funnel has no time axis, so it does not belong in the
    // cursor-sync group anyway; #outcomeCard is the direct precedent. A fifth canvas would
    // break four-chart-ledger.test.ts, both browser suites and chartpage.test.ts at once.
    expect([...html.matchAll(/class="pane" id="(pane\w+)"/g)].map((m) => m[1]))
      .toEqual(['paneWallet', 'panePaper', 'paneVenue', 'paneVolume'])
    expect(html).toContain('id="bookRejects"')
    expect(html).not.toMatch(/class="pane" id="paneRejects"/)
  })

  it('names no book in the template and renders the tabs from the payload', async () => {
    const { dashboardHtml } = await import('../src/telemetry/dashboard-page.js')
    const html = dashboardHtml()
    // Book labels are operator config and change without a deploy. A spliced placeholder
    // goes stale silently, which is the warning at the head of dashboard-page.ts.
    const bar = html.slice(html.indexOf('id="bookTabs"'))
    expect(bar.slice(0, bar.indexOf('</div>'))).not.toMatch(/data-book="[a-z]/)
    expect(html).toContain('data-book="')  // only inside the runtime renderer
  })

  it('uses data-book and never data-h for the book tabs', async () => {
    const { dashboardHtml } = await import('../src/telemetry/dashboard-page.js')
    const { LOOKBACKS } = await import('../src/telemetry/dashboard.js')
    const html = dashboardHtml()
    // dashboard.test.ts collects data-h DOCUMENT-WIDE and asserts it equals the lookbacks,
    // so a book tab carrying data-h would read as a seventh lookback the API does not know.
    expect([...html.matchAll(/data-h="([^"]+)"/g)].map((m) => m[1]!).sort()).toEqual(Object.keys(LOOKBACKS).sort())
  })

  it('gives every new DOM id an alphanumeric name', async () => {
    const { dashboardHtml } = await import('../src/telemetry/dashboard-page.js')
    const html = dashboardHtml()
    // scripts/chart-smoke.mjs discovers elements with /\bid="([a-zA-Z0-9]+)"/g, so an id
    // with a dash or an underscore is invisible to the smoke harness rather than failing it.
    for (const id of ['bookCard', 'bookStrip', 'bookKpi', 'bookKpiHead', 'bookKpiBody', 'bookRejects', 'bookTabs', 'bookNote', 'emptyVolume', 'volumeTitle']) {
      expect(html, id).toContain('id="' + id + '"')
      expect(/^[a-zA-Z0-9]+$/.test(id), id).toBe(true)
    }
  })
})

describe('what an unstamped row belongs to', () => {
  it('belongs to the one book when one is configured', () => {
    // "which book traded this" has exactly one answer, so the per-book table equals the
    // wallet table, which is what a single-book operator should see.
    expect(unstampedBook([{ id: 'main' }])).toBe('main')
    expect(unstampedBook([{ id: 'untaxed' }])).toBe('untaxed')
  })

  it('belongs to NEITHER book once two are configured', () => {
    // Guessing from the band would claim a book traded rows opened before it existed, under a
    // stake, a take-profit schedule and an exit rule that were not its own. Measured on a real
    // capture: 993 closed trades from the 50-10000 era would have landed in a book named
    // `untaxed` whose band is 0-0. Books start their accounting at the cutover instead.
    expect(unstampedBook([{ id: 'untaxed' }, { id: 'taxed' }])).toBeNull()
  })

  it('has no book at all to fall back to when none are configured', () => {
    expect(unstampedBook([])).toBeNull()
  })
})

describe('the recent exits table', () => {
  it('carries every column, and the empty state and detail span all of them', async () => {
    const { dashboardHtml } = await import('../src/telemetry/dashboard-page.js')
    const html = dashboardHtml()
    const head = html.slice(html.indexOf('<table id="rec">'))
    const cols = [...head.slice(0, head.indexOf('</tr>')).matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]!.trim())
    // Five of these (Max, Exit, Kept, Dev buy, Exempt) were dropped between 8a54a32 and
    // a042ee9 with no note, which left the table unable to answer the one question an
    // operator asks about a losing trade: was there a run here and did we give it back.
    expect(cols).toEqual(['Time', 'Coin', 'P&amp;L · $ / ETH', 'Reason', 'Hold', 'Pinned TP',
      'Max 45s', 'Exit', 'Kept', 'Dev buy', 'Exempt', ''])
    // colspans must track the column count or the empty state and the expanded detail
    // both stop spanning the table, which reads as a broken layout rather than a bug.
    expect(html).toContain('colspan="12" class="empty"')
    const src = (await import('node:fs')).readFileSync('src/telemetry/dashboard-page.ts', 'utf8')
    expect(src).toContain('<td class="det" colspan="12">')
    // every #rec colspan, static and rendered, moves together; the two '4's are #kpi's
    expect([...src.matchAll(/colspan="(\d+)"/g)].map((m) => m[1])).toEqual(['4', '12', '4', '12', '12'])
  })

  it('takes the observation window from the running gate, not a number typed into the page', async () => {
    const { dashboardHtml } = await import('../src/telemetry/dashboard-page.js')
    // The header names the GATE's window, which is the bot's own holdMs. A literal here
    // goes stale the day that moves and then labels the column with a window nobody ran.
    expect(dashboardHtml({ holdMs: 90_000 })).toContain('Max 90s')
    expect(dashboardHtml({ holdMs: 90_000 })).not.toContain('Max 45s')
    expect(dashboardHtml()).toContain('Max 45s')
  })

  it('keeps the capture bar styles the Kept column needs', async () => {
    const { dashboardHtml } = await import('../src/telemetry/dashboard-page.js')
    const html = dashboardHtml()
    // The column came back once already without its CSS, which renders as an invisible
    // cell rather than as a missing feature.
    for (const rule of ['.capt{', '.capt u,.capt b{', '.capt u{']) expect(html, rule).toContain(rule)
  })
})

describe('the indicator pipeline cannot go dark when another sensor drives the take profit', () => {
  it('replays the target the bot actually traded, whatever chose it', async () => {
    const { capturedTarget } = await import('../src/simulation/selector.js')
    // THE 2026-09-16 FREEZE. pickTakeProfit switches source on VENUE_EXECUTION_SCENARIOS, so
    // flipping that guard off to get the bot trading made every capture mismatch the shared
    // selector. Measured on the box: 132 admissions eligible to 06:55:22, then every one
    // `pinned_target_mismatch` and not one scenario bundle written after 06:58:35. The paper
    // wallet, the coins strip and the indicator's evidence tape all froze while the dashboard
    // went on drawing them as live.
    const capture = {
      config: { targetPolicy: { adaptive: { window: 2, bars: [1.25, 1.75] }, otherwise: 1.75, maxRateAgeMs: 300_000 } },
      // an EVIDENCE-BACKED decision from the gatewatch bar, not the shared selector
      takeProfit: { multiple: 1.25, ready: true, why: 'adaptive: best of last 2 = 1.25' },
      selector: null, selectorHeartbeatAt: 1000,
    }
    const t = capturedTarget(capture, 1001)
    expect(t.ready).toBe(true)
    // and it replays THAT multiple, not the selector's, because the whole point is to measure
    // the book the bot actually ran
    expect(t.multiple).toBe(1.25)
    expect(t.source).toBe('live-take-profit')
  })

  it('still refuses a FALLBACK target, which is a guess and not a measurement', async () => {
    const { capturedTarget } = await import('../src/simulation/selector.js')
    const base = { config: { targetPolicy: { adaptive: { window: 2, bars: [1.25, 1.75] }, otherwise: 1.75, maxRateAgeMs: 300_000 } }, selector: null, selectorHeartbeatAt: 1000 }
    // ready:false is adaptiveTakeProfit saying it had no evidence and used the flat bar. The
    // guard's thresholds were fitted on measured targets; letting guesses into the tape is
    // how a guard starts holding an opinion it never earned.
    expect(capturedTarget({ ...base, takeProfit: { multiple: 1.75, ready: false } }, 1001).ready).toBe(false)
    // and a capture with no definite multiple at all is still refused
    expect(capturedTarget({ ...base, takeProfit: { ready: true } }, 1001).ready).toBe(false)
    expect(capturedTarget({ ...base, takeProfit: null }, 1001).ready).toBe(false)
  })

  it('reports readiness from adaptiveTakeProfit itself, so the replay cannot re-derive it wrong', async () => {
    const { adaptiveTakeProfit } = await import('../src/strategy/takeprofit.js')
    const rows = [{ '1.25': 0.4, '1.75': 0.1 }, { '1.25': 0.3, '1.75': 0.2 }] as never
    expect(adaptiveTakeProfit(rows, 2, [1.25, 1.75], 1.75)).toMatchObject({ multiple: 1.25, ready: true })
    // too few rows: the flat bar, and NOT ready
    expect(adaptiveTakeProfit([rows[0]!] as never, 2, [1.25, 1.75], 1.75)).toMatchObject({ multiple: 1.75, ready: false })
    expect(adaptiveTakeProfit(null, 2, [1.25, 1.75], 1.75)).toMatchObject({ multiple: 1.75, ready: false })
  })
})

describe('the market pane says which guard it is drawing', () => {
  it('flags the pane when the drawn tape is not the guard gating entries', async () => {
    const src = (await import('node:fs')).readFileSync('src/telemetry/dashboard-page.ts', 'utf8')
    // On 2026-09-16 the bot was gated on the legacy gatewatch sensor while this pane drew the
    // scenario tape, frozen since 06:58, under "pause below -1.00 / recover above +2.00".
    // Those are the scenario policy's numbers and nothing was using them.
    expect(src).toContain('NOT THE LIVE GUARD')
    expect(src).toContain('Market Indicator · STALE')
    expect(src).toContain('representsLiveGuard')
  })

  it('computes the flag on the SERVER, from the running config', async () => {
    const src = (await import('node:fs')).readFileSync('src/telemetry/dashboard.ts', 'utf8')
    // The page must not re-derive which guard is live from its own copy of the config: that
    // is how the thresholds and the tape drifted apart in the first place.
    expect(src).toContain('representsLiveGuard')
    expect(src).toContain("activeGuardId = liveConfig().venueExecutionScenarios ? 'conservative-paper'")
    expect(src).toContain('drawnGuard')
  })
})
