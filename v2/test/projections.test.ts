/**
 * The display layer, and the rules that keep it honest.
 *
 *   It may not reach a decision function.                          test/rings.test.ts
 *   It may not hold a threshold inline.                            test/rings.test.ts
 *   The renderer may not import anything that computes.            test/rings.test.ts
 *   The browser may not format anything.                           test/rings.test.ts
 *   A value that was never measured may not render as a number.    here
 *   N books render, for any N.                                     here
 *   The machine contract does not move when the page does.         here
 *   Every cell is labelled, so the phone layout cannot lose one.   here
 *
 * All of them are the old dashboard's defects turned into checks. It re-derived eleven
 * decisions the bot had already made, it carried four colour thresholds nobody could find, and
 * it drew a tape frozen since 06:58 exactly like a live one.
 *
 * BOOK NAMES HERE ARE FABRICATED ON PURPOSE. A test that asserts `untaxed` passes on the day
 * somebody hardcodes `untaxed`. The only place the live names are allowed is the shipped-spec
 * assertion in config.test.ts, whose whole job is to match reality.
 */
import { describe, expect, it } from 'vitest'
import { buildAlerts } from '../projections/alerts.js'
import { History, READ_LATENCIES_KEPT, BUCKETS_KEPT, BUCKET_MS } from '../projections/history.js'
import { LEVELS } from '../projections/levels.js'
import { buildReport, REPORT_SCHEMA } from '../projections/report.js'
import { project, LOOKBACKS, WINDOWS, PAPER_START_ETH, PAPER_STAKE_ETH, type ProjectOptions, type ViewModel } from '../projections/viewmodel.js'
import { REGIONS, renderPage, renderRegions } from '../projections/render/page.js'
import { loadVendor } from '../projections/vendor.js'
import { bookLedger, emptyState, freshGradState, type Position } from '../core/state.js'
import { freshCurve } from '../core/curve.js'
import type { BookSpec, FrozenConfig, Switches } from '../core/config.js'

const band = (id: string, lo: number, hi: number, over: Partial<BookSpec> = {}): BookSpec => ({
  id, minCreatorTaxBps: lo, maxCreatorTaxBps: hi, minExemptions: 3, templateLossBlockMs: 3_600_000,
  sizeWei: '5000000000000000', maxDrawdownWei: '15000000000000000',
  entry: { entryDelayMs: 2_000, entryFallbackLateMs: 600, maxEntryPriceMultiple: 4.5, buySlippageBps: 5_000 },
  exit: { maxHoldMs: 45_000, hardStopMultiple: 0.5, deadCoinAfterMs: 20_000, deadCoinBelowMultiple: 1.03, graduationExitAt: 0.12, maxSellAttempts: 20, exitRetryDelayMs: 300, sellFinalMinQuoteOutWei: '1' },
  takeProfit: { otherwise: 1.75, adaptiveWindow: 20, adaptiveBars: [1.25, 1.75] },
  guard: { window: 20, recoveryWindow: 8, openAt: 1, shutAt: -1, settleMs: 52_000, freshMs: 10_800_000, pnlBar: 1.75, maxReadingAgeMs: 10_800_000 },
  ...over,
})

const cfg = (books: BookSpec[]): FrozenConfig => ({
  specVersion: 1, books,
  risk: {
    maxConcurrent: 14, maxTradeSizeWei: '20000000000000000', bankrollWei: '80000000000000000', drawdownStakes: 3,
    maxWalletDrawdownWei: '60000000000000000',
    brokenWindow: 20, brokenFactor: 0.78, brokenGapPp: 15, maxLogsStalenessMs: 3000, maxOverlayAgeMs: 1500,
  },
  clock: { periodMs: 250 },
})

const TWO = [band('alpha', 0, 0), band('bravo', 50, 200)]
const SW: Switches = { sizeWei: 5_000_000_000_000_000n, mode: 'live', at: 0, by: 'test' }

const st = (books: BookSpec[] = TWO) => ({ ...emptyState(cfg(books), SW), at: 1_000_000 })

/** Everything measurable. The live driver's options at cutover. */
const FULL: ProjectOptions = { unavailable: {}, ethUsd: { value: 2000, source: 'test' } }
/** Nothing measurable. The monitor's options while it folds another process's tape. */
const NONE: ProjectOptions = {
  unavailable: {
    money: 'this core did not place these trades',
    account: 'no balance read is on this tape',
    paper: 'no paper account',
    truePeak: 'no independent peak',
  },
  ethUsd: null,
}

const model = (s = st(), o: ProjectOptions = FULL, h = new History()) => project(s, h, o)

function withPlumbing(s: ReturnType<typeof st>) {
  return {
    ...s,
    overlayAt: s.at,
    sensors: {
      ...s.sensors,
      logsHealthy: { value: true, at: s.at, source: 'logs' as const, n: null },
    },
  }
}

function openPos(over: Partial<Position> = {}): Position {
  return {
    id: 'p1', token: '0xtoken', curve: '0xcurve', book: 'alpha', bookDigest: 'd',
    templateKey: '0:1000000000000000:4', openedAt: 990_000,
    spendWei: 5_000_000_000_000_000n, entryMarkWei: 1_000_000n,
    rules: {
      maxHoldMs: 45_000, hardStopMultiple: 0.5, deadCoinAfterMs: 20_000, deadCoinBelowMultiple: 1.03,
      graduationExitAt: 0.12, maxSellAttempts: 20, takeProfitMultiple: 1.75, sellFinalMinQuoteOutWei: '1',
    },
    tokensHeld: 1n, peakMarkWei: 1_200_000n, proceedsWei: 0n,
    closedAt: null, abandonedAt: null, abandonReason: null,
    exitReason: null, attempts: 0, inflightIntentId: null,
    lastBuyHash: null, lastSellHash: null, awaitingSellReceipt: null, closed: false,
    venue: 'curve', grad: null, filled: true,
    ...over,
  }
}

/** Every `Shown` and `Bar` reachable from the model, so a rule can be asserted over all of them. */
function walkValues(node: unknown, out: { text: string; missing: string | null }[] = []): { text: string; missing: string | null }[] {
  if (node === null || typeof node !== 'object') return out
  const o = node as Record<string, unknown>
  if (typeof o.text === 'string' && 'missing' in o) {
    out.push({ text: o.text, missing: (o.missing as string | null) ?? null })
    return out
  }
  for (const v of Object.values(o)) {
    if (Array.isArray(v)) v.forEach((x) => walkValues(x, out))
    else walkValues(v, out)
  }
  return out
}

// ---------------------------------------------------------------------------

describe('thresholds live in exactly one place', () => {
  it('exposes every display threshold it applies, and every one is a finite number', () => {
    const numbers: number[] = []
    const collect = (v: unknown): void => {
      if (typeof v === 'number') numbers.push(v)
      else if (Array.isArray(v)) v.forEach(collect)
      else if (v !== null && typeof v === 'object') Object.values(v).forEach(collect)
    }
    collect(LEVELS)
    expect(numbers.length).toBeGreaterThan(0)
    for (const n of numbers) expect(Number.isFinite(n)).toBe(true)
  })

  it('does not keep its own copy of a threshold the bot acts on', () => {
    // These three were hand-copied out of the spec until 2026-09-16, so tuning the spec moved
    // the moment entries refuse without moving the moment the operator is told.
    const keys = Object.keys(LEVELS)
    expect(keys).not.toContain('logsStaleWarnMs')
    expect(keys).not.toContain('overlayStaleWarnMs')
    expect(keys).not.toContain('sensorStaleWarnMs')
  })

  it('warns about a stale log stream at exactly the number the spec refuses at', () => {
    const s = st()
    const c = s.config
    const fresh = { ...s, sensors: { ...s.sensors, logsHealthy: { value: true, at: s.at - c.risk.maxLogsStalenessMs, source: 'logs' as const, n: null } } }
    const stale = { ...s, sensors: { ...s.sensors, logsHealthy: { value: true, at: s.at - c.risk.maxLogsStalenessMs - 1, source: 'logs' as const, n: null } } }
    expect(buildAlerts(fresh, new History()).some((a) => a.id === 'logs')).toBe(false)
    expect(buildAlerts(stale, new History()).some((a) => a.id === 'logs')).toBe(true)
  })
})

describe('books are N, never two', () => {
  it('reports every configured book in byte order, before any of them has traded', () => {
    expect(model().bookTabs.map((b) => b.id)).toEqual(['alpha', 'bravo'])
  })

  it('renders one book, three books and six books without a layout that assumes two', () => {
    for (const n of [1, 3, 6]) {
      const books = Array.from({ length: n }, (_, i) => band(`b${i}`, i * 100, i * 100 + 50))
      const m = model(st(books))
      expect(m.bookTabs).toHaveLength(n)
      expect(m.kpis).toHaveLength(8)
      expect(m.kpis.every((r) => r.cells.length === 3)).toBe(true)
      expect(renderPage(m, []).length).toBeGreaterThan(0)
    }
  })

  it('draws one book at a time, never two books in one chart', () => {
    const m = model()
    expect(m.selectedBook).toBe('alpha')
    expect(m.chartPayload.book).toBe('alpha')
    expect(m.chartPayload.panes.map((p) => p.id)).toEqual(['virtual', 'paper', 'market', 'coins'])
    expect(m.walletPayload.panes.map((p) => p.id)).toEqual(['wallet'])
  })

  it('offers the four History panes and not a set of mixed charts', () => {
    const m = model()
    expect(m.chartPayload.panes).toHaveLength(4)
    expect(m.lookbacks).toEqual(['1h', '4h', '12h', '24h', '3d', '7d'])
    expect(m.lookback).toBe('4h')
    expect(m.rollingWindows).toEqual(['1h', '4h', '12h'])
  })

  it('prefers a funded book when none is asked for, so the first view is not an empty one', () => {
    const books = [band('unfunded', 0, 0, { sizeWei: '0' }), band('zfunded', 50, 200)]
    expect(model(st(books)).selectedBook).toBe('zfunded')
  })

  it('falls back to the first book when every book is unfunded, rather than drawing nothing', () => {
    const books = [band('alpha', 0, 0, { sizeWei: '0' }), band('bravo', 50, 200, { sizeWei: '0' })]
    expect(model(st(books)).selectedBook).toBe('alpha')
  })

  it('never blends two policies into one indicator', () => {
    const m = model()
    expect(m.chartPayload.book).toBe('alpha')
    const coins = m.chartPayload.panes.find((p) => p.id === 'coins')!
    expect(coins.subtitle).toContain('0–0')
    const bravo = project(st(), new History(), { ...FULL, selectedBook: 'bravo' })
    expect(bravo.chartPayload.book).toBe('bravo')
    const other = bravo.chartPayload.panes.find((p) => p.id === 'coins')!
    expect(other.subtitle).toContain('50–200')
  })

  it('sends a stacked coins pane, not a single launch-count series', () => {
    const m = model()
    const coins = m.chartPayload.panes.find((p) => p.id === 'coins')!
    expect(coins.kind).toBe('stack')
    expect(m.chartPayload.bucketSec).toBe(300)
    expect(coins.stack.length).toBeGreaterThan(0)
    expect(renderPage(m, [])).toContain('Paper win')
  })

  it('keeps live chart words out of the shell, so a stream tick cannot destroy the canvases', () => {
    const m = model()
    const coins = m.chartPayload.panes.find((p) => p.id === 'coins')!
    const shell = renderRegions(m, []).charts
    expect(coins.subtitle.length).toBeGreaterThan(0)
    expect(shell).not.toContain(coins.subtitle)
    expect(m.chartPayload.bookHeader.length).toBeGreaterThan(0)
    expect(shell).not.toContain(m.chartPayload.bookHeader)
    expect(shell).toContain('id="chart-bookhead"')
    expect(shell).toContain('id="sub-coins"')
  })

  it('does not change the chart shell when only the clock moved', () => {
    const a = st()
    const b = { ...a, at: a.at + 1_000, seq: a.seq + 1 }
    expect(renderRegions(project(a, new History(), FULL), []).charts)
      .toBe(renderRegions(project(b, new History(), FULL), []).charts)
  })

  it('pins the x range to the lookback even when the tape is a few hours old', () => {
    const h = new History()
    const start = 10_000_000
    const s = { ...st(), at: start }
    h.observe({ kind: 'clock', at: start, seq: 1 } as never, s, [], [])
    const now = start + 4 * 3_600_000
    const seven = LOOKBACKS.find((w) => w.label === '7d')!
    const payload = project({ ...s, at: now, seq: 2 }, h, { ...FULL, windowLabel: '7d' }).chartPayload
    expect(payload.to - payload.from).toBe(seven.ms / 1000)
    expect(payload.bucketSec).toBe(seven.bucketMs / 1000)
    const coins = payload.panes.find((p) => p.id === 'coins')!
    expect(coins.stack.length).toBeGreaterThan(30)
    expect(coins.stack.length).toBeLessThan(50)
  })
})

describe('the coins stack is the sim, keyed to the launch minute', () => {
  const token = '0x' + 'ab'.repeat(20)
  const curve = '0x' + 'cd'.repeat(20)
  const openAt = 1_000_000
  const bookAt = (h: History, at: number) => h.window(at, at)[0]!.books.get('alpha')

  const watching = (s: ReturnType<typeof st>, at: number) => {
    s.observations.set(curve, {
      token, curve, book: 'alpha', startedAt: at,
      launchBlock: 1, deployer: '0xdev', launchTx: '0xtx', creatorTaxBps: 0, events: [],
    } as never)
  }

  it('counts a launch as pending the moment the observation opens', () => {
    const h = new History()
    const s = st()
    watching(s, openAt)
    h.observe({ kind: 'chain-read', at: openAt, seq: 1 } as never, s, [], [])
    const row = bookAt(h, openAt)!
    expect(row.launches).toBe(1)
    expect(row.simPending).toBe(1)
    expect(row.simWin).toBe(0)
  })

  it('files the sign in the launch minute even when settle is a minute later', () => {
    const h = new History()
    const s = st()
    watching(s, openAt)
    h.observe({ kind: 'chain-read', at: openAt, seq: 1 } as never, s, [], [])
    s.observations.delete(curve)
    s.cohort.push({ token, book: 'alpha', at: openAt + 80_000, perBar: { '1.75': 0.4 }, stakes: 0.4, peak: 1.2 })
    h.observe({ kind: 'clock', at: openAt + 80_000, seq: 2 } as never, s, [], [])
    const launched = bookAt(h, openAt)!
    expect(launched.simPending).toBe(0)
    expect(launched.simWin).toBe(1)
    expect(launched.simNet).toBeCloseTo(0.4)
    expect(launched.scored).toBe(0)
    const settled = bookAt(h, openAt + 80_000)!
    expect(settled.scored).toBe(1)
    expect(settled.stakes).toBeCloseTo(0.4)
    expect(settled.simWin).toBe(0)
  })

  it('counts a replay that produced no number as dropped, not as pending forever', () => {
    const h = new History()
    const s = st()
    watching(s, openAt)
    h.observe({ kind: 'chain-read', at: openAt, seq: 1 } as never, s, [], [])
    s.observations.delete(curve)
    h.observe({ kind: 'clock', at: openAt + 80_000, seq: 2 } as never, s, [], [])
    const row = bookAt(h, openAt)!
    expect(row.simPending).toBe(0)
    expect(row.simDropped).toBe(1)
    expect(row.simN).toBe(0)
  })

  it('the grey coins slice is leftover launches, not a filter', () => {
    const h = new History()
    const s = st()
    watching(s, openAt)
    h.observe({ kind: 'chain-read', at: openAt, seq: 1 } as never, s, [], [])
    s.observations.delete(curve)
    const later = { ...s, at: openAt + 80_000 }
    h.observe({ kind: 'clock', at: later.at, seq: 2 } as never, later, [], [])
    const coins = project(later, h, { ...FULL, windowLabel: '1h' }).chartPayload.panes.find((p) => p.id === 'coins')!
    const bar = coins.stack.find((x) => x.notSimulated > 0)
    expect(bar).toBeTruthy()
    expect(bar!.notSimulated).toBe(1)
    expect(bar!.win + bar!.loss + bar!.pending + bar!.flat + bar!.notSimulated).toBe(1)
  })

  it('counts an entry-filter refusal as seen even though no observation opened', () => {
    const h = new History()
    const s = st()
    h.observe({ kind: 'chain-read', at: openAt, seq: 1 } as never, s, [], [
      { at: openAt, bucket: 'entry-exempt', subject: '0x' + '44'.repeat(20), reason: '2 exempt wallets' },
      { at: openAt, bucket: 'entry-template-loss', subject: '0x' + '55'.repeat(20), reason: 'lost 1m ago' },
    ] as never)
    const min = h.window(openAt, openAt)[0]!
    expect(min.seen).toBe(2)
    expect(min.books.size).toBe(0)
    const coins = project(s, h, { ...FULL, windowLabel: '1h', selectedBook: 'alpha' })
      .chartPayload.panes.find((p) => p.id === 'coins')!
    const bar = coins.stack.find((x) => x.height > 0)
    expect(bar).toBeTruthy()
    expect(bar!.filtered).toBe(2)
    expect(bar!.pending + bar!.win + bar!.loss + bar!.flat + bar!.notSimulated).toBe(0)
  })

  it('the grey filtered slice is every launch this book did not take', () => {
    const h = new History()
    const s = st()
    watching(s, openAt)
    h.observe({ kind: 'chain-read', at: openAt, seq: 1 } as never, s, [], [])
    s.observations.set('0xc2', {
      token: '0x' + '22'.repeat(20), curve: '0xc2', book: 'bravo', startedAt: openAt,
      launchBlock: 2, deployer: '0xdev', launchTx: '0xty', creatorTaxBps: 50, events: [],
    } as never)
    h.observe({ kind: 'chain-read', at: openAt, seq: 2 } as never, s, [], [])
    h.observe({ kind: 'logs', at: openAt, seq: 3 } as never, s, [], [
      { at: openAt, bucket: 'screen-pair', subject: '0x' + '33'.repeat(20), reason: 'not eth' },
    ] as never)
    const coins = project(s, h, { ...FULL, windowLabel: '1h', selectedBook: 'alpha' })
      .chartPayload.panes.find((p) => p.id === 'coins')!
    const bar = coins.stack.find((x) => x.height > 0)
    expect(bar).toBeTruthy()
    expect(bar!.pending + bar!.notSimulated).toBe(1)
    expect(bar!.filtered).toBe(2)
  })

  it('rolls two launch minutes into one lookback bar and colours the strip from their net', () => {
    const h = new History()
    const s = st()
    const a = '0x' + '11'.repeat(20)
    const b = '0x' + '22'.repeat(20)
    s.observations.set('0xc1', {
      token: a, curve: '0xc1', book: 'alpha', startedAt: openAt,
      launchBlock: 1, deployer: '0xdev', launchTx: '0xtx', creatorTaxBps: 0, events: [],
    } as never)
    h.observe({ kind: 'chain-read', at: openAt, seq: 1 } as never, s, [], [])
    s.observations.set('0xc2', {
      token: b, curve: '0xc2', book: 'alpha', startedAt: openAt + 60_000,
      launchBlock: 2, deployer: '0xdev', launchTx: '0xty', creatorTaxBps: 0, events: [],
    } as never)
    h.observe({ kind: 'chain-read', at: openAt + 60_000, seq: 2 } as never, s, [], [])
    s.observations.clear()
    s.cohort.push({ token: a, book: 'alpha', at: openAt + 90_000, perBar: { '1.75': 0.5 }, stakes: 0.5, peak: 1.2 })
    s.cohort.push({ token: b, book: 'alpha', at: openAt + 90_000, perBar: { '1.75': -0.2 }, stakes: -0.2, peak: 1.0 })
    const later = { ...s, at: openAt + 90_000 }
    h.observe({ kind: 'clock', at: later.at, seq: 3 } as never, later, [], [])

    const coins = project(later, h, { ...FULL, windowLabel: '1h' }).chartPayload.panes.find((p) => p.id === 'coins')!
    const bar = coins.stack.find((x) => x.win + x.loss > 0)
    expect(bar).toBeTruthy()
    expect(bar!.win).toBe(1)
    expect(bar!.loss).toBe(1)
    expect(bar!.net).toBeCloseTo(0.3)
    expect(bar!.netText).toBe('+0.3')
    expect(bar!.stripTone).toBe('good')
  })
})

describe('a value that was never measured never renders as a number', () => {
  it('carries a sentence, not a zero, for every capability the run cannot produce', () => {
    const m = model(st(), NONE)
    expect(m.notices.map((n) => n.id).sort()).toEqual(['account', 'money', 'paper', 'truePeak'])
    for (const n of m.notices) expect(n.reason.length).toBeGreaterThan(0)
  })

  it('never prints a bare 0 where the reason is that nothing was read', () => {
    const m = model(st(), NONE)
    for (const v of walkValues(m)) {
      if (v.missing !== null) expect(v.text).not.toMatch(/^[-+]?0(\.0+)?$/)
    }
  })

  it('says why the paper chart is empty when paper is marked unavailable', () => {
    const paper = model(st(), NONE).chartPayload.panes.find((p) => p.id === 'paper')!
    expect(paper.missing).toBe('no paper account')
    expect(paper.t).toHaveLength(0)
    expect(paper.y).toHaveLength(0)
  })

  it('distinguishes a book that is unfunded from one that has simply not traded', () => {
    const books = [band('alpha', 0, 0, { sizeWei: '0' }), band('bravo', 50, 200)]
    const s = st(books)
    expect(model(s).bookTabs.find((b) => b.id === 'alpha')!.funded).toBe(false)
    expect(model(s).bookTabs.find((b) => b.id === 'bravo')!.funded).toBe(true)
    expect(buildAlerts(s, new History()).some((a) => a.id === 'unfunded-alpha')).toBe(true)
    expect(buildAlerts(s, new History()).some((a) => a.id === 'unfunded-bravo')).toBe(false)
  })
})

describe('the paper wallet is the ungated sim of one book', () => {
  const openAt = 1_000_000
  const alphaTok = (n: number) => '0x' + n.toString(16).padStart(40, 'a')
  const settle = (h: History, s: ReturnType<typeof st>, rows: Array<{ token: string; book: string; stakes: number }>, at: number, halted = false) => {
    if (halted) s.risk.halts.set('venue:alpha', { kind: 'venue', book: 'alpha', reason: 'paused', at })
    for (const r of rows) {
      s.cohort.push({ token: r.token, book: r.book, at, perBar: { '1.75': r.stakes }, stakes: r.stakes, peak: 1 + r.stakes })
    }
    h.observe({ kind: 'clock', at, seq: at } as never, s, [], [])
  }
  const paperOf = (h: History, s: ReturnType<typeof st>, book = 'alpha') =>
    project(s, h, { ...FULL, selectedBook: book }).chartPayload.panes.find((p) => p.id === 'paper')!

  it('starts at 0 and adds every scored launch at 0.02 ETH', () => {
    const h = new History()
    const s = st()
    settle(h, s, [
      { token: alphaTok(1), book: 'alpha', stakes: 1.0 },
      { token: alphaTok(2), book: 'alpha', stakes: 0.5 },
    ], openAt)
    const paper = paperOf(h, s)
    expect(paper.missing).toBeNull()
    expect(paper.y.at(-1)).toBeCloseTo(PAPER_START_ETH + 1.5 * PAPER_STAKE_ETH)
    expect(paper.subtitle).toContain('counterfactual')
    expect(paper.subtitle).toContain('ungated')
    expect(paper.subtitle).toContain('no venue, no DD')
    expect(paper.subtitle).toContain('from 0')
  })

  it('still books a launch in a halted minute, because sitting out is what it measures against', () => {
    const h = new History()
    const s = st()
    settle(h, s, [{ token: alphaTok(1), book: 'alpha', stakes: 1.5 }], openAt, true)
    expect(h.window(openAt, openAt)[0]!.halted).toBe(true)
    expect(paperOf(h, s).y.at(-1)).toBeCloseTo(PAPER_START_ETH + 1.5 * PAPER_STAKE_ETH)
  })

  it('does not let another book\'s score move this book\'s line', () => {
    const h = new History()
    const s = st()
    settle(h, s, [{ token: alphaTok(1), book: 'bravo', stakes: 9 }], openAt)
    expect(paperOf(h, s, 'alpha').y.at(-1)).toBeCloseTo(PAPER_START_ETH)
    expect(paperOf(h, s, 'bravo').y.at(-1)).toBeCloseTo(PAPER_START_ETH + 9 * PAPER_STAKE_ETH)
  })
})

describe('the rendered page', () => {
  it('produces every region the stream can replace, and each one is non-empty HTML', () => {
    const r = renderRegions(model(), [])
    expect(Object.keys(r).sort()).toEqual([...REGIONS].sort())
    expect(REGIONS).toContain('walletchart')
    expect(REGIONS).toContain('walletpayload')
    expect(REGIONS).toContain('books')
    expect(REGIONS.indexOf('walletchart')).toBeLessThan(REGIONS.indexOf('books'))
    expect(REGIONS.indexOf('books')).toBeLessThan(REGIONS.indexOf('charts'))
    expect(REGIONS.indexOf('charts')).toBeLessThan(REGIONS.indexOf('kpis'))
    expect(REGIONS.indexOf('kpis')).toBeLessThan(REGIONS.indexOf('open'))
    expect(REGIONS.indexOf('open')).toBe(REGIONS.indexOf('exits') - 1)
    for (const id of REGIONS) expect(r[id].length).toBeGreaterThan(0)
  })

  it('places every region into the document with the id the client looks for', () => {
    const html = renderPage(model(), [])
    for (const id of REGIONS) expect(html).toContain(`id="r-${id}"`)
  })

  it('does not reload itself', () => {
    // The whole reason this rewrite exists. A page that reloads cannot keep a selected tab, a
    // scroll position or an expanded row, and on a phone it re-parses the document 1,800 times
    // an hour to watch a clock.
    const html = renderPage(model(), [])
    expect(html).not.toContain('location.reload')
    expect(html).not.toContain('http-equiv="refresh"')
  })

  it('does not let a stream tick re-fit the time axis to the data', () => {
    // setData's default is resetScales=true, which snaps x to the first and last point.
    // The lookback ends at "now", a minute past that last point, so the line bounced.
    const html = renderPage(model(), [])
    expect(html).toContain('x:{time:true,auto:false}')
    expect(html).toContain('setData([pane.t.slice(),pane.y.slice()],false)')
    expect(html).toContain('setData([[],[]],false)')
  })

  it('refuses to rebuild chart panes that already exist, and puts the scroll back if a swap moved it', () => {
    const html = renderPage(model(), [])
    expect(html).toContain("getElementById('pane-virtual')")
    expect(html).toContain("getElementById('pane-wallet')")
    expect(html).toContain('data-window')
    expect(html).not.toContain('data-wallet-window')
    expect(html).not.toContain('dataset.walletWindow')
    expect(html).toContain('scrollTo')
  })

  it('paints coins with v1 teal and salmon, not a different green and red', () => {
    const html = renderPage(model(), [])
    expect(html).toContain('--good:#66bea5')
    expect(html).toContain('--bad:#ed8c82')
  })

  it('makes the chart legend buttons, so a click can hide a layer without the server deciding', () => {
    const html = renderPage(model(), [])
    for (const seg of ['filtered', 'win', 'loss', 'pending', 'flat', 'notSimulated', 'net', 'trades', 'halts']) {
      expect(html).toContain(`data-seg="${seg}"`)
    }
    expect(html).toContain('Trading paused')
    expect(html).toContain('snipe.chartHidden')
    expect(html).toContain("hidden.add('filtered')")
    expect(html).toContain('Filtered out')
  })

  it('keeps break-even and no-estimate off the legend until a bar actually has one', () => {
    const html = renderPage(model(), [])
    expect(html).toMatch(/data-seg="flat"[^>]*\shidden/)
    expect(html).toMatch(/data-seg="notSimulated"[^>]*\shidden/)
    expect(html).toContain('No estimate')
    expect(html).not.toContain('Passed, no estimate')
    expect(html).toContain("k==='flat'")
    expect(html).toContain("k==='notSimulated'")
  })

  it('labels every table cell, so the phone layout cannot silently drop one', () => {
    // Under 860px the stylesheet hides the header row and prints `data-label` instead. A cell
    // without one becomes a value with no name on every phone.
    const html = renderPage(model(), [])
    const cells = html.match(/<td[^>]*>/g) ?? []
    expect(cells.length).toBeGreaterThan(0)
    for (const c of cells) expect(c).toMatch(/data-label="/)
  })

  it('inlines uPlot, draws five pane ids, and ships no external request', () => {
    const vendor = loadVendor()
    expect(vendor.js.length).toBeGreaterThan(1000)
    expect(vendor.js).toContain('uPlot')
    const html = renderPage(model(), [], vendor)
    expect(html).not.toMatch(/<script[^>]+src=/)
    // Styles and scripts stay inlined. The only <link>s are same-origin icons: without
    // them iOS Add to Home Screen pins the letter of the title.
    const links = html.match(/<link\b[^>]*>/g) ?? []
    expect(links.length).toBeGreaterThan(0)
    for (const l of links) {
      expect(l).toMatch(/rel="(?:icon|apple-touch-icon|manifest)"/)
      expect(l).toMatch(/href="\/[A-Za-z0-9._-]+"/)
      expect(l).not.toMatch(/href="https?:/)
      expect(l).not.toMatch(/href="\/\//)
    }
    expect(html).toContain('id="pane-wallet"')
    expect(html).toContain('id="pane-virtual"')
    expect(html).toContain('id="pane-paper"')
    expect(html).toContain('id="pane-market"')
    expect(html).toContain('id="pane-coins"')
    expect(html).toContain(vendor.js.slice(0, 80))
  })

  it('tells the phone to pin a real icon, not the letter of the title', () => {
    const html = renderPage(model(), [])
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"')
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"')
    expect(html).toContain('name="apple-mobile-web-app-title" content="PONS"')
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"')
    expect(html).toContain('name="theme-color" content="#101317"')
  })

  it('degrades to empty panes when the vendor file is missing, and does not throw', () => {
    expect(() => renderPage(model(), [], { js: '', css: '' })).not.toThrow()
    const html = renderPage(model(), [], { js: '', css: '' })
    expect(html).toContain('id="pane-wallet"')
    expect(html).toContain('id="pane-virtual"')
    expect(html).toContain('id="pane-coins"')
  })

  it('puts stroke, decimals and rules on the payload so the browser never chooses a cut', () => {
    const payload = JSON.parse(renderRegions(model(), []).chartpayload) as {
      panes: { id: string; stroke: string; yDecimals: number; rules: { label: string; value: number; stroke: string }[] }[]
    }
    expect(payload.panes).toHaveLength(4)
    for (const pane of payload.panes) {
      expect(pane.stroke).toMatch(/^(good|bad|warn|plain|muted)$/)
      expect(typeof pane.yDecimals).toBe('number')
      expect(Array.isArray(pane.rules)).toBe(true)
    }
    const market = payload.panes.find((p) => p.id === 'market')!
    expect(market.rules).toEqual([
      { label: 'pause below -1', value: -1, stroke: 'bad' },
      { label: 'reopen last 8 above 1', value: 1, stroke: 'good' },
    ])
    const html = renderPage(model(), [])
    expect(html).not.toMatch(/>=\s*50\b/)
    expect(html).not.toMatch(/>=\s*25\b/)
    expect(html).not.toMatch(/>=\s*99\b/)
  })

  it('escapes a book name that contains markup', () => {
    const books = [band('<img src=x onerror=alert(1)>', 0, 0)]
    const html = renderPage(model(st(books)), [])
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })

  it('offers control only when the process can actually halt the bot', () => {
    expect(renderPage(model(st(), { ...FULL, canControl: true }), [])).toContain('data-action="stop"')
    const readonlyPage = renderPage(model(st(), { ...FULL, canControl: false }), [])
    expect(readonlyPage).not.toContain('data-action="stop"')
    expect(readonlyPage).toContain('read only')
  })

  it('does not paint the whole bot stopped when one book\'s venue is shut', () => {
    /**
     * 2026-09-17: the strip took the first halt in the map. Untaxed sat at -1.45, the header
     * said STOPPED, and the button still said STOP ALL because it only showed START on the
     * file switch. Clicking it set the dashboard stop and halted taxed, which was open.
     */
    const s = st()
    s.risk.halts.set('venue:bravo', { kind: 'venue', book: 'bravo', reason: 'paused', at: s.at })
    const vm = model(s, { ...FULL, canControl: true })
    expect(vm.trading.state.value).toBe('normal')
    expect(vm.trading.controlAction).toBe('stop')
    expect(renderPage(vm, [])).toContain('data-action="stop"')
    expect(buildReport(s, new History(), null).halted).toBe(false)
  })

  it('shows START only for the dashboard stop, which is what the button actually lifts', () => {
    const s = st()
    s.risk.halts.set('stopped', { kind: 'stopped', book: null, reason: 'stopped from the dashboard', at: s.at })
    s.risk.halts.set('venue:bravo', { kind: 'venue', book: 'bravo', reason: 'paused', at: s.at })
    const vm = model(s, { ...FULL, canControl: true })
    expect(vm.trading.state.value).toBe('stopped')
    expect(vm.trading.controlAction).toBe('start')
    expect(renderPage(vm, [])).toContain('data-action="start"')
    expect(renderPage(vm, [])).toContain('START')
  })

  it('always offers STOP ALL when the dashboard has not stopped it', () => {
    const vm = model(st(), { ...FULL, canControl: true })
    expect(vm.trading.controlAction).toBe('stop')
    expect(renderPage(vm, [])).toContain('data-action="stop"')
    expect(renderPage(vm, [])).toContain('STOP ALL')
    expect(renderPage(vm, [])).toContain('data-control-book="alpha"')
    expect(renderPage(vm, [])).toContain('RESET DD')
    expect(renderPage(vm, [])).not.toContain('halt is in .env')
  })

  it('offers AUTO on a parked book and STOP on a live one', () => {
    const s = st()
    s.risk.halts.set('stopped:alpha', { kind: 'stopped', book: 'alpha', reason: 'park', at: s.at })
    const vm = model(s, { ...FULL, canControl: true })
    expect(vm.bookTabs.find((t) => t.id === 'alpha')!.controlLabel).toBe('AUTO')
    expect(vm.bookTabs.find((t) => t.id === 'bravo')!.controlLabel).toBe('STOP')
    const html = renderPage(vm, [])
    expect(html).toContain('data-action="start"')
    expect(html).toContain('data-control-book="alpha"')
    expect(html).toContain('STOP ALL')
  })

  it('renders one exact numeric size control per funded book and labels custom overrides', () => {
    const base = st()
    const s = {
      ...base,
      switches: {
        ...base.switches,
        bookSizes: new Map([['alpha', { sizeWei: 1_000_000_000_000_000n, at: base.at, by: 'dashboard' }]]),
      },
    }
    const vm = model(s, { ...FULL, canControl: true })
    const alpha = vm.bookTabs.find((t) => t.id === 'alpha')!
    const bravo = vm.bookTabs.find((t) => t.id === 'bravo')!
    expect(alpha).toMatchObject({ stakeEth: '0.0010', sizeSource: 'book', minimumEth: '0.0005' })
    expect(bravo).toMatchObject({ stakeEth: '0.0050', sizeSource: 'default' })
    const html = renderPage(vm, [])
    expect(html).toContain('data-size-input="alpha"')
    expect(html).toContain('value="0.0010"')
    expect(html).toContain('max="0.0050"')
    expect(html).toContain('data-size-default="alpha"')
    expect(html).not.toContain('data-size-default="bravo"')
    expect(html).toContain("action:useDefault?'preview-default':'preview-size'")
    expect(html).toContain('Open positions keep their original size.')
    expect(html).toContain('sizeDrafts')
    expect(html).toContain("if(k==='books'){patchBooks(el,regions[k]);continue;}")
    expect(html).toContain('Replacing that node closes the phone keyboard')

    const report = buildReport(s, new History(), null)
    expect(report.books.find((b) => b.id === 'alpha')).toMatchObject({
      stakeEth: 0.001, drawdownLimitEth: 0.003, sizeSource: 'book', sizeBy: 'dashboard',
    })
    expect(report.drawdownLimitEth).toBe(0.018)
  })

  it('shows the adaptive next stake and full pilot range beside the editable base', () => {
    const adaptive = band('alpha', 0, 0, {
      sizeWei: '10000000000000000',
      maxDrawdownWei: '30000000000000000',
      sizing: {
        enabled: true, referenceSizeWei: '5000000000000000', window: 15,
        recentWindow: 8, confirmations: 2, clipStakes: 0.5, strongThreshold: 0.1,
        weakBps: 5000, strongBps: 12500, maxBaseSizeWei: '2500000000000000', freshMs: 10_800_000,
      },
    })
    const s = st([adaptive])
    const vm = model(s, { ...FULL, canControl: true })
    expect(vm.bookTabs[0]).toMatchObject({
      stakeEth: '0.0025', nextStakeEth: '0.0013', sizingMultiplier: '0.50x',
      sizingState: 'warming', sizingRangeEth: '0.0013–0.0031', sizingN: 0,
    })
    const html = renderPage(vm, [])
    expect(html).toContain('next 0.0013 · 0.50x warming · range 0.0013–0.0031 · n0')
    expect(buildReport(s, new History(), null).books[0]).toMatchObject({
      stakeEth: 0.0025, nextStakeEth: 0.00125, sizingMultiplier: 0.5, sizingState: 'warming', sizingN: 0,
    })
  })

  it('hides every size writer on a read-only dashboard', () => {
    const html = renderPage(model(st(), { ...FULL, canControl: false }), [])
    expect(html).not.toContain('data-size-input=')
    expect(html).not.toContain('data-size-set=')
  })

  it('defaults to a funded book that can enter, not the first one that is shut', () => {
    const s = st()
    s.risk.halts.set('venue:alpha', { kind: 'venue', book: 'alpha', reason: 'paused', at: s.at })
    expect(model(s).selectedBook).toBe('bravo')
  })

  it('names the selected book when venue is what is refusing entries', () => {
    const s = withPlumbing(st())
    s.risk.halts.set('venue:alpha', { kind: 'venue', book: 'alpha', reason: 'paused', at: s.at })
    const vm = project(s, new History(), { ...FULL, selectedBook: 'alpha' })
    expect(vm.streams.blocking).toBe('entries refuse: alpha venue')
  })

  it('labels the header size as the default, not a per-book override', () => {
    const vm = model()
    expect(vm.trading.size.source).toBe('switch')
    expect(renderPage(vm, [])).toContain('default ')
  })

  it('shows closed and entered without More metrics, and titles the virtual pane', () => {
    const vm = model()
    expect(vm.kpis.find((r) => r.key === 'n')!.label).toBe('closed')
    expect(vm.kpis.find((r) => r.key === 'entered')!.extra).toBe(false)
    expect(vm.chartPayload.panes.find((p) => p.id === 'virtual')!.title).toBe('Virtual wallet')
    expect(vm.walletPayload.panes.find((p) => p.id === 'wallet')!.title).toBe('Total wallet')
  })

  it('hides dollar cells when no ETH price was supplied', () => {
    const html = renderPage(model(st(), NONE), [])
    expect(html).toContain('P&amp;L · ETH')
    expect(html).not.toContain('P&amp;L · $')
  })

  it('keeps the open card on the page while flat, so a fill has a place to land', () => {
    const html = renderRegions(model(), []).open
    expect(html).toContain('id="open"')
    expect(html).toContain('nothing open')
    expect(html).not.toMatch(/<section[^>]*\shidden\s*>/)
  })

  it('renders rolling as metric rows by 1h/4h/12h, and exits as a compact scan', () => {
    const r = renderRegions(model(), [])
    expect(r.books).toContain('data-book="alpha"')
    expect(r.kpis).not.toContain('data-book=')
    const kpis = r.kpis
    expect(kpis).toContain('Rolling performance')
    expect(kpis).toContain('More metrics')
    expect(kpis).toContain('id="kpi"')
    expect(kpis).toContain('return on turnover')
    const exits = renderRegions(model(), []).exits
    expect(exits).toContain('id="rec"')
    expect(exits).not.toContain('class="grid exits"')
  })

  it('prints a dash, not a zero, for P&L and win rate when a window is empty', () => {
    const m = model()
    for (const key of ['pnlUsd', 'rotPct', 'winRate'] as const) {
      const row = m.kpis.find((r) => r.key === key)!
      for (const c of row.cells) {
        expect(c.missing).not.toBeNull()
        expect(c.text).toBe('–')
      }
    }
  })
})

describe('the recent exits scan', () => {
  const token = `0x${'ab'.repeat(20)}`
  const spend = 1_000_000_000_000_000n

  const closeHeld = (h: History, s: ReturnType<typeof st>) => {
    s.positions.set('p1', openPos({
      token, book: 'alpha',
      spendWei: spend, entryMarkWei: spend,
      peakMarkWei: 2n * spend,
      proceedsWei: 15n * spend / 10n,
      tokensHeld: 0n, closed: true, closedAt: s.at,
    }))
    h.observe({ kind: 'logs', at: s.at, seq: 1 } as never, s, [], [])
  }

  const settlePeak = (h: History, s: ReturnType<typeof st>, peak: number) => {
    s.cohort.push({ token, book: 'alpha', at: s.at, perBar: { '1.75': 0.4 }, stakes: 0.4, peak })
    h.observe({ kind: 'clock', at: s.at, seq: 2 } as never, s, [], [])
  }

  it('Peak and Kept are dashes until the cohort settles', () => {
    const h = new History()
    const s = st()
    closeHeld(h, s)
    const [e] = project(s, h, FULL).exits
    expect(e).toBeDefined()
    expect(e!.truePeak.missing).not.toBeNull()
    expect(e!.truePeak.text).toBe('–')
    expect(e!.kept.missing).not.toBeNull()
    expect(e!.heldPeak.value).toBe(2)
    expect(e!.exit.value).toBe(1.5)
  })

  it('Kept uses the observer peak, not the peak while we held', () => {
    const h = new History()
    const s = st()
    closeHeld(h, s)
    const later = { ...s, at: s.at + 1 }
    settlePeak(h, later, 3)
    const [e] = project(later, h, FULL).exits
    expect(e!.truePeak.missing).toBeNull()
    expect(e!.truePeak.value).toBe(3)
    expect(e!.kept.missing).toBeNull()
    // (1.5 − 1) / (3 − 1) = 0.25. Held peak is 2.0×, which would have been 50%.
    expect(e!.kept.fraction).toBeCloseTo(0.25)
    expect(e!.heldPeak.value).toBe(2)
  })

  it('draws a 0% grey track when the coin never rose, not a dash', () => {
    const h = new History()
    const s = st()
    closeHeld(h, s)
    const later = { ...s, at: s.at + 1 }
    settlePeak(h, later, 1)
    const vm = project(later, h, FULL)
    const [e] = vm.exits
    expect(e!.truePeak.value).toBe(1)
    expect(e!.kept.missing).toBeNull()
    expect(e!.kept.fraction).toBe(0)
    expect(e!.kept.tone).toBe('muted')
    const html = renderRegions(vm, []).exits
    expect(html).toContain('class="capt"')
    expect(html).toContain('width:0%')
  })

  it('picks up a peak that settled before the close', () => {
    const h = new History()
    const s = st()
    settlePeak(h, s, 3)
    const later = { ...s, at: s.at + 1 }
    closeHeld(h, later)
    const [e] = project(later, h, FULL).exits
    expect(e!.truePeak.value).toBe(3)
    expect(e!.kept.fraction).toBeCloseTo(0.25)
  })

  it('titles Max 45s from the spec, and drops the seconds when books disagree', () => {
    expect(model().exitsMaxHoldLabel).toBe('Max 45s')
    expect(renderRegions(model(), []).exits).toContain('Replay max 45s')
    const long = band('bravo', 50, 200)
    const mixed = st([band('alpha', 0, 0), { ...long, exit: { ...long.exit, maxHoldMs: 90_000 } }])
    expect(project(mixed, new History(), FULL).exitsMaxHoldLabel).toBe('Max')
    expect(project(mixed, new History(), { ...FULL, exitsBook: 'alpha' }).exitsMaxHoldLabel).toBe('Max 45s')
  })

  it('carries every v1 scan column, and the empty state and detail span all of them', () => {
    const html = renderRegions(model(), []).exits
    const head = html.slice(html.indexOf('<table id="rec">'))
    const cols = [...head.slice(0, head.indexOf('</tr>')).matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]!.trim())
    expect(cols).toEqual([
      'Time', 'Coin', 'P&amp;L · ETH / $', 'Reason', 'Hold', 'Pinned TP',
      'Replay max 45s', 'Exit', 'Kept', 'Dev buy', 'Exempt', '',
    ])
    expect(html).toContain('colspan="12"')
  })

  it('keeps the capture bar styles the Kept column needs', () => {
    const html = renderPage(model(), [])
    for (const rule of ['.capt{', '.capt u,.capt b{', '.capt u{']) expect(html, rule).toContain(rule)
  })

  it('keeps only the asked book in the exits scan, and names the book on the row', () => {
    const h = new History()
    const s = st()
    s.positions.set('p1', openPos({
      token: `0x${'aa'.repeat(20)}`, book: 'alpha',
      spendWei: spend, entryMarkWei: spend, peakMarkWei: spend,
      proceedsWei: spend, tokensHeld: 0n, closed: true, closedAt: s.at,
    }))
    s.positions.set('p2', openPos({
      id: 'p2', token: `0x${'bb'.repeat(20)}`, book: 'bravo',
      spendWei: spend, entryMarkWei: spend, peakMarkWei: spend,
      proceedsWei: spend, tokensHeld: 0n, closed: true, closedAt: s.at,
    }))
    h.observe({ kind: 'logs', at: s.at, seq: 1 } as never, s, [], [])
    const all = project(s, h, FULL)
    expect(all.exits.map((e) => e.book).sort()).toEqual(['alpha', 'bravo'])
    const only = project(s, h, { ...FULL, exitsBook: 'bravo' })
    expect(only.exits).toHaveLength(1)
    expect(only.exits[0]!.book).toBe('bravo')
    const html = renderRegions(only, []).exits
    expect(html).toContain('book-badge')
    expect(html.match(/data-book="[^"]+"/g)).toEqual(['data-book="bravo"'])
    expect(html).toContain('pnl-eth')
    expect(html).toContain('data-exits-book="bravo"')
    expect(html).toContain('class="tab on"')
  })

  it('opens the rest of the trade on a click, including the explorer links', () => {
    const h = new History()
    const s = st()
    closeHeld(h, s)
    settlePeak(h, { ...s, at: s.at + 1 }, 3)
    const html = renderRegions(project({ ...s, at: s.at + 1 }, h, FULL), []).exits
    expect(html).toContain('left after we sold')
    expect(html).toContain('peak while held')
    expect(html).toContain('>chart</a>')
    expect(html).toContain('robinhoodchain.blockscout.com/token/')
  })

  it('records a close seen only on a receipt, and does not count it again on the next logs batch', () => {
    const h = new History()
    const s = st()
    s.positions.set('p1', openPos({
      token, book: 'alpha',
      spendWei: spend, entryMarkWei: spend, peakMarkWei: spend,
      proceedsWei: spend, tokensHeld: 0n, closed: true, closedAt: s.at,
      exitReason: 'tp',
    }))
    h.observe({ kind: 'receipt', at: s.at, seq: 1, hash: '0x1', result: null } as never, s, [], [])
    expect(h.recentExits()).toHaveLength(1)
    expect(h.recentExits()[0]!.reason).toBe('tp')
    expect(h.totals.closed).toBe(1)
    h.observe({ kind: 'logs', at: s.at + 1, seq: 2 } as never, s, [], [])
    expect(h.recentExits()).toHaveLength(1)
    expect(h.totals.closed).toBe(1)
  })

  it('records a close seen only on a clock tick, and does not count it again on the next feed block', () => {
    const h = new History()
    const s = st()
    s.positions.set('p1', openPos({
      token, book: 'alpha',
      spendWei: spend, entryMarkWei: spend, peakMarkWei: spend,
      proceedsWei: spend, tokensHeld: 0n, closed: true, closedAt: s.at,
      exitReason: 'graduated-swap',
    }))
    h.observe({ kind: 'clock', at: s.at, seq: 1 } as never, s, [], [])
    expect(h.recentExits()).toHaveLength(1)
    expect(h.recentExits()[0]!.reason).toBe('graduated-swap')
    expect(h.totals.closed).toBe(1)
    h.observe({ kind: 'feed-block', at: s.at + 1, seq: 2 } as never, s, [], [])
    expect(h.recentExits()).toHaveLength(1)
    expect(h.totals.closed).toBe(1)
  })

  it('catchUp fills a close no event scan saw, and a second call does not double-count', () => {
    const h = new History()
    const s = st()
    s.positions.set('p1', openPos({
      token, book: 'alpha',
      spendWei: spend, entryMarkWei: spend, peakMarkWei: spend,
      proceedsWei: spend, tokensHeld: 0n, closed: true, closedAt: s.at,
      exitReason: 'stop',
    }))
    expect(h.recentExits()).toHaveLength(0)
    h.catchUp(s)
    expect(h.recentExits()).toHaveLength(1)
    expect(h.recentExits()[0]!.reason).toBe('stop')
    expect(h.totals.closed).toBe(1)
    h.catchUp(s)
    expect(h.recentExits()).toHaveLength(1)
    expect(h.totals.closed).toBe(1)
  })

  it('names the scan Last 40 exits', () => {
    expect(renderRegions(model(), []).exits).toContain('Last 40 exits')
  })
})

describe('the machine contract', () => {
  /**
   * THE FIELD NAMES BELOW ARE READ BY `pull.sh`. Renaming one breaks the phone report silently,
   * which is exactly what the v2 cutover did: the skill asked for `risk.open` and `money.today`
   * and got nothing, so it printed `unavailable` for the wallet and for booked P&L.
   */
  const REQUIRED = [
    'schema', 'at', 'seq', 'specVersion', 'simulationModel', 'simulationPositiveFactor', 'simulationNegativeFactor', 'zeroAt',
    'mode', 'sending', 'stopped', 'halted', 'haltKind', 'haltReason',
    'sizeEth', 'openN', 'capacity',
    'walletEth', 'walletWei', 'walletUsd', 'priceUsd', 'priceSource',
    'drawdownEth', 'drawdownLimitEth',
    'windows', 'books', 'streams', 'alerts',
  ]

  it('carries every field the report skill reads', () => {
    const r = buildReport(st(), new History(), { value: 2000, source: 'test' }) as unknown as Record<string, unknown>
    for (const k of REQUIRED) expect(Object.keys(r)).toContain(k)
  })

  it('declares a schema the consumer can refuse', () => {
    expect(buildReport(st(), new History(), null).schema).toBe(REPORT_SCHEMA)
  })

  it('reports one window per offered window, and one row per book', () => {
    const r = buildReport(st(), new History(), null)
    expect(r.windows.map((w) => w.label)).toEqual(WINDOWS.map((w) => w.label))
    expect(r.books.map((b) => b.id)).toEqual(['alpha', 'bravo'])
  })

  it('keeps every drawdown limit at the configured stake multiple after a hot size reduction', () => {
    const books = [
      band('alpha', 0, 0, { sizeWei: '10000000000000000', maxDrawdownWei: '30000000000000000' }),
      band('bravo', 50, 200, { sizeWei: '10000000000000000', maxDrawdownWei: '30000000000000000' }),
    ]
    const r = buildReport(st(books), new History(), null)
    expect(r.sizeEth).toBe(0.005)
    expect(r.books.map((b) => b.drawdownLimitEth)).toEqual([0.015, 0.015])
    expect(r.drawdownLimitEth).toBe(0.03)
  })

  it('uses null and never zero for a number that was not measured', () => {
    const r = buildReport(st(), new History(), null)
    expect(r.walletUsd).toBeNull()
    expect(r.priceUsd).toBeNull()
    for (const w of r.windows) {
      expect(w.winPct).toBeNull()
      expect(w.medianMultiple).toBeNull()
    }
    for (const b of r.books) {
      expect(b.venueStakes).toBeNull()
      expect(b.venueState).toBeNull()
      expect(b.takeProfit).toBeNull()
    }
  })

  it('says plainly whether this process is sending, because shadow looks identical otherwise', () => {
    const shadow = { ...st(), switches: { ...SW, mode: 'shadow' as const } }
    expect(buildReport(shadow, new History(), null).sending).toBe(false)
    expect(buildReport(st(), new History(), null).sending).toBe(true)
  })

  it('serialises to JSON with no bigint left in it', () => {
    const r = buildReport(st(), new History(), { value: 2000, source: 'test' })
    expect(() => JSON.stringify(r)).not.toThrow()
    expect(typeof JSON.parse(JSON.stringify(r)).bookedPnlWei).toBe('string')
  })

  it('ships the chain balance as the wallet, and booked P&L under its own name', () => {
    /**
     * SCHEMA 2. Under schema 1 `walletEth` was cumulative booked P&L wearing the wallet's name,
     * and `pull.sh` printed it as `wallet_eth`, so the phone report showed a number that did
     * not move when gas was burnt or when ETH was deposited. The two are now separate fields
     * and the one called wallet is the one the chain answered.
     */
    const withBalance = {
      ...st(),
      risk: { ...st().risk, walletRealizedWei: 7_000_000_000_000_000n },
      walletBalance: { value: 123_000_000_000_000_000n, at: 1_000, source: 'chain' as const, n: null },
    }
    const r = buildReport(withBalance, new History(), { value: 2000, source: 'test' })
    expect(r.walletWei).toBe('123000000000000000')
    expect(r.walletEth).toBeCloseTo(0.123)
    expect(r.walletAt).toBe(1_000)
    expect(r.bookedPnlWei).toBe('7000000000000000')
    expect(r.bookedPnlEth).toBeCloseTo(0.007)
  })

  it('reports null, not zero, when no balance has ever been read', () => {
    // Observe mode has no key, so it has no address, so there is nothing to ask the chain.
    // A 0.0000 here would read as a drained wallet, which is the one thing it must not do.
    const r = buildReport(st(), new History(), null)
    expect(r.walletEth).toBeNull()
    expect(r.walletWei).toBeNull()
    expect(r.walletAt).toBeNull()
  })
})

describe('the window selector', () => {
  it('accepts every lookback it offers and falls back rather than throwing on a bad one', () => {
    for (const w of LOOKBACKS) {
      expect(project(st(), new History(), { ...FULL, windowLabel: w.label }).lookback).toBe(w.label)
    }
    expect(project(st(), new History(), { ...FULL, windowLabel: 'nonsense' }).lookback).toBe(model().lookback)
  })

  it('uses one lookback for Total wallet and History, and still honours a leftover ?wh=', () => {
    const vm = project(st(), new History(), { ...FULL, windowLabel: '1h' })
    expect(vm.lookback).toBe('1h')
    expect(vm.chartPayload.lookback).toBe('1h')
    expect(vm.walletPayload.lookback).toBe('1h')
    expect(vm.walletPayload.from).toBe(vm.chartPayload.from)
    expect(vm.walletPayload.to).toBe(vm.chartPayload.to)
    const html = renderPage(vm, [])
    expect(html).toContain('data-window="1h"')
    expect(html).not.toContain('data-wallet-window')
    expect(html).toContain('aria-label="lookback"')
    expect(html).not.toContain('aria-label="wallet lookback"')
    expect(html).toContain("dataset.window=q.get('wh')")
    const regions = renderRegions(vm, [])
    expect(regions.walletchart).toContain('data-window="1h"')
    expect(regions.charts).not.toContain('data-window')
  })

  it('falls back rather than throwing on a book that does not exist', () => {
    const m = project(st(), new History(), { ...FULL, selectedBook: 'ghost' })
    expect(m.selectedBook).toBe('alpha')
  })
})

describe('coverage of the band space', () => {
  it('says out loud which creator-tax values route to no book', () => {
    // alpha takes 0-0 and bravo takes 50-200, so 1-49 is observed and then refused
    // `entry-no-book`, which on the funnel looks the same as a launch rejected on merit.
    expect(model().unrouted).toContain('1–49')
  })

  it('says nothing when the declared bands tile the range', () => {
    const books = [band('alpha', 0, 49), band('bravo', 50, 200)]
    expect(model(st(books)).unrouted).toBeNull()
  })
})

describe('what the operator is told about mode', () => {
  it('names shadow, because a page full of decisions looks the same as live', () => {
    const s = { ...st(), switches: { ...SW, mode: 'shadow' as const } }
    expect(buildAlerts(s, new History()).some((a) => a.id === 'mode')).toBe(true)
    expect(buildAlerts(st(), new History()).some((a) => a.id === 'mode')).toBe(false)
  })

  it('calls an entry-gate funnel a filter, not a jam', () => {
    const h = new History()
    const s = st()
    const refusals = Array.from({ length: LEVELS.bucketDominanceMinimum }, (_, i) => ({
      at: s.at, bucket: 'entry-exempt' as const, subject: `0x${i}`, reason: '2 exempt wallets',
    }))
    h.observe({ kind: 'clock', at: s.at, seq: 1 } as never, s, [], refusals as never)
    const a = buildAlerts(s, h).find((x) => x.id === 'funnel-entry-exempt')
    expect(a?.msg).toContain('entry filter')
    expect(a?.msg).not.toContain('stopping everything')
  })

  it('does not tell the operator that gaps leave trading unaffected', () => {
    const s = { ...st(), gaps: [{ stream: 'logs' as const, lo: 1, hi: 2, reason: 'drop' }] }
    const a = buildAlerts(s, new History()).find((x) => x.id === 'gaps')
    expect(a?.msg).toContain('cannot be replayed')
    expect(a?.msg).not.toContain('unaffected')
  })
})

// A model with something in it, so the assertions above are not all about an empty tape.
describe('a page with content', () => {
  const withOpen = (): ViewModel => {
    const s = st()
    s.positions.set('p1', openPos())
    return model(s)
  }

  it('shows the open table once something is open, with its age and its pinned rules', () => {
    const m = withOpen()
    expect(m.positions).toHaveLength(1)
    expect(m.positions[0]!.takeProfit.text).toBe('1.75x')
    expect(m.positions[0]!.state.value).toBe('held')
    const html = renderRegions(m, []).open
    expect(html).not.toMatch(/<section[^>]*\shidden\s*>/)
    expect(html).toContain('id="open"')
    expect(html).toContain('class="card wide live"')
    expect(html).toContain('Open positions')
    expect(html).toContain('Est. return')
    expect(html).toContain('Supply left')
    expect(renderPage(m, [])).not.toMatch(/#open\.live\{[^}]*position:sticky/)
  })

  it('prints remaining supply and a reached TP on the open row', () => {
    const params = {
      phantomQuote: 10n ** 18n, reservedTokens: 0n, launchSupply: 10n ** 27n,
      feeBps: 100n, creatorTaxBps: 0n, snipeTaxStartBps: 0n, snipeTaxSeconds: 3n,
      launchedAt: 0n,
    }
    const s = st()
    s.curves.set('0xcurve', {
      curve: '0xcurve', token: '0xtoken', params,
      confirmed: { ...freshCurve(params), trackedTokens: params.launchSupply / 2n },
      working: { ...freshCurve(params), trackedTokens: params.launchSupply / 2n },
      pending: new Map(), confirmedThrough: 1, degraded: false, workingAt: s.at,
    })
    s.positions.set('p1', openPos({
      tokensHeld: 10n ** 18n,
      spendWei: 1n,
      entryMarkWei: 1n,
    }))
    const row = model(s).positions[0]!
    expect(row.supplyLeft.missing).toBeNull()
    expect(row.supplyLeft.text).toBe('50.0%')
    expect(row.takeProfit.text).toContain('reached')
    const html = renderRegions(model(s), []).open
    expect(html).toContain('50.0%')
    expect(html).toContain('before gas')
  })

  it('shows a signed buy that has not filled yet as opening', () => {
    const s = st()
    s.inflight.set('buy-1', {
      kind: 'buy', intentId: 'buy-1', token: '0xtoken', curve: '0xcurve', book: 'alpha', bookDigest: 'd',
      templateKey: '0:1000000000000000:4', sizeWei: 5_000_000_000_000_000n, rules: openPos().rules,
      hash: '0xhash', nonce: 3, signedAt: s.at - 1_000, walletReadAt: 0, walletReads: 0,
    })
    const vm = model(s)
    expect(vm.positions).toHaveLength(1)
    expect(vm.positions[0]!.state.value).toBe('opening')
    expect(vm.positions[0]!.multiple.missing).not.toBeNull()
    expect(vm.trading.open.text).toBe('1 opening')
    expect(renderRegions(vm, []).open).toContain('opening')
  })

  it('counts an unconfirmed row as opening, not a second live bag', () => {
    const s = st()
    s.positions.set('buy-1', openPos({
      id: 'buy-1', filled: false, tokensHeld: 0n, entryMarkWei: 0n, peakMarkWei: 0n,
    }))
    s.inflight.set('buy-1', {
      kind: 'buy', intentId: 'buy-1', token: '0xtoken', curve: '0xcurve', book: 'alpha', bookDigest: 'd',
      templateKey: '0:1000000000000000:4', sizeWei: 5_000_000_000_000_000n, rules: openPos().rules,
      hash: '0xhash', nonce: 3, signedAt: s.at - 1_000, walletReadAt: 0, walletReads: 0,
    })
    const vm = model(s)
    expect(vm.positions).toHaveLength(1)
    expect(vm.positions[0]!.state.value).toBe('opening')
    expect(vm.trading.open.text).toBe('1 opening')
    expect(vm.trading.openLive).toBe(0)
    expect(vm.trading.openOpening).toBe(1)
  })

  it('shows an unsigned buy as signing', () => {
    const s = st()
    s.inflight.set('buy-1', {
      kind: 'buy', intentId: 'buy-1', token: '0xtoken', curve: '0xcurve', book: 'alpha', bookDigest: 'd',
      templateKey: '0:1000000000000000:4', sizeWei: 5_000_000_000_000_000n, rules: openPos().rules,
      hash: '', nonce: -1, signedAt: 0, walletReadAt: 0, walletReads: 0,
    })
    expect(model(s).positions[0]!.state.value).toBe('signing')
  })

  it('counts an open position against capacity in the strip', () => {
    expect(withOpen().trading.open.text).toBe('1')
  })

  it('does not print a slot ceiling of zero', () => {
    const s = st()
    s.config = { ...s.config, risk: { ...s.config.risk, maxConcurrent: 0 } }
    const vm = model(s)
    expect(vm.trading.occupancy).toBe('0')
    expect(vm.trading.occupancyOf).toBe('0')
    expect(renderPage(vm, [])).toContain('open <b>0</b>')
    expect(renderPage(vm, [])).not.toContain(' / 0')
    expect(renderRegions(vm, []).open).not.toContain(' of 0')
  })

  it('still names the ceiling when one is set', () => {
    const vm = model()
    expect(vm.trading.occupancy).toBe('0 / 14')
    expect(vm.trading.occupancyOf).toBe('0 of 14')
    expect(renderPage(vm, [])).toContain('open <b>0 / 14</b>')
  })

  it('calls exhausted and empty bags stuck, not held, and splits the strip', () => {
    const s = st()
    s.positions.set('live', openPos({ id: 'live' }))
    s.positions.set('spent', openPos({ id: 'spent', attempts: 20 }))
    s.positions.set('gave', openPos({ id: 'gave', grad: { ...freshGradState(), gaveUp: true } }))
    s.positions.set('zero', openPos({ id: 'zero', tokensHeld: 0n }))
    const vm = model(s)
    expect(vm.positions.find((p) => p.id === 'live')!.state.value).toBe('held')
    expect(vm.positions.find((p) => p.id === 'spent')!.state.value).toBe('stuck')
    expect(vm.positions.find((p) => p.id === 'gave')!.state.value).toBe('stuck')
    expect(vm.positions.find((p) => p.id === 'zero')!.state.value).toBe('empty')
    expect(vm.trading.openLive).toBe(1)
    expect(vm.trading.openStuck).toBe(3)
    expect(vm.trading.open.text).toBe('1 live · 3 stuck')
  })

  it('explains an exhausted exit and labels a shared safety stop without blaming one book', () => {
    const s = st()
    s.positions.set('spent', openPos({id:'spent',attempts:20}))
    s.risk.halts.set('broken',{kind:'broken',book:null,reason:'execution gap',at:s.at})
    const vm = model(s)
    expect(vm.bookTabs.every(b=>b.state.text==='WALLET SAFETY STOP')).toBe(true)
    expect(vm.positions[0]!.stateDetail).toContain('20 sell attempts exhausted')
    expect(vm.positions[0]!.canRetryExit).toBe(true)
    expect(buildAlerts(s,new History()).some(a=>a.id==='stuck-spent')).toBe(true)
  })

  it('shows approval rejection as the reason a position cannot sell', () => {
    const s=st()
    s.positions.set('pending',openPos({id:'pending',approval:{ready:false,intentId:null,hash:null,awaitingAllowance:false,retryAt:s.at+1000,failures:1,reverts:0,gasWei:0n,lastError:'intrinsic gas too low',gaveUp:false}}))
    const vm=model(s)
    expect(vm.positions[0]!.state.text).toBe('approval pending')
    expect(renderRegions(vm,[]).open).toContain('intrinsic gas too low')
    expect(buildAlerts(s,new History()).find(a=>a.id==='approval-pending')?.msg).toContain('0 sell attempts used')
  })

  it('alerts when approval evidence or sale receipts remain unresolved without an explicit error', () => {
    const s=st()
    const p=openPos({id:'pending',openedAt:s.at-90_000,approval:{ready:false,intentId:null,hash:'0xhash',awaitingAllowance:false,retryAt:s.at+1000,failures:0,reverts:0,gasWei:0n,lastError:null,gaveUp:false}})
    s.positions.set(p.id,p)
    expect(buildAlerts(s,new History()).find(a=>a.id==='approval-pending')?.msg).toContain('evidence is unavailable')
    delete p.approval
    p.sellReceipts=new Map([['0xhash',{reason:'time',readAt:s.at}]])
    expect(buildAlerts(s,new History()).find(a=>a.id==='receipt-pending')?.msg).toContain('unresolved sale receipt')
  })

  it('calls a graduated bag graduating, and an inflight one selling', () => {
    const s = st()
    s.positions.set('g', openPos({ id: 'g', venue: 'graduated', grad: freshGradState() }))
    s.positions.set('s', openPos({ id: 's', inflightIntentId: 'sell-1' }))
    const vm = model(s)
    expect(vm.positions.find((p) => p.id === 'g')!.state.value).toBe('graduating')
    expect(vm.positions.find((p) => p.id === 's')!.state.value).toBe('selling')
  })

  it('puts current mark in ×, not peak', () => {
    const params = {
      phantomQuote: 10n ** 18n, reservedTokens: 0n, launchSupply: 10n ** 27n,
      feeBps: 100n, creatorTaxBps: 0n, snipeTaxStartBps: 0n, snipeTaxSeconds: 3n,
      launchedAt: 0n,
    }
    const s = st()
    s.curves.set('0xcurve', {
      curve: '0xcurve', token: '0xtoken', params,
      confirmed: freshCurve(params), working: freshCurve(params),
      pending: new Map(), confirmedThrough: 1, degraded: false, workingAt: s.at,
    })
    s.positions.set('p1', openPos({
      tokensHeld: 10n ** 18n,
      entryMarkWei: 1_000_000_000_000_000n,
      peakMarkWei: 2_000_000_000_000_000n,
    }))
    const row = model(s).positions[0]!
    expect(row.peakText).toBe('peak 2.00x')
    expect(row.multiple.missing).toBeNull()
    expect(row.multiple.value).not.toBe(2)
  })

  it('does not paint a green 1.00× on a bag that holds nothing', () => {
    const s = st()
    s.positions.set('p1', openPos({ tokensHeld: 0n, peakMarkWei: 1_000_000n }))
    const row = model(s).positions[0]!
    expect(row.state.value).toBe('empty')
    expect(row.multiple.missing).not.toBeNull()
    expect(row.multiple.text).toBe('–')
  })

  it('draws Total as flat 0 when nothing has closed, even with no chain read', () => {
    const h = new History()
    const s = st()
    h.observe({ kind: 'clock', at: s.at, seq: 1 } as never, s, [], [])
    const payload = project(s, h, { ...NONE, windowLabel: '4h' }).walletPayload
    const account = payload.panes.find((p) => p.id === 'wallet')!
    expect(account.missing).toBeNull()
    expect(account.subtitle).toContain('from 0')
    expect(account.t[0]).toBe(payload.from)
    expect(account.y[0]).toBe(0)
    expect(account.y.at(-1)).toBe(0)
    expect(payload.trades).toEqual([])
  })

  it('starts the Total line at the left of the lookback at 0', () => {
    const h = new History()
    const s = st()
    h.observe({ kind: 'clock', at: s.at, seq: 1 } as never, s, [], [])
    const payload = project(s, h, { ...FULL, windowLabel: '12h' }).walletPayload
    const account = payload.panes.find((p) => p.id === 'wallet')!
    expect(account.t[0]).toBe(payload.from)
    expect(account.y[0]).toBe(0)
  })

  it('a later abandonment takes the dead spend off earlier Total minutes', () => {
    // Live 4h pane, 2026-09-18: leftover bags kept tokensHeld > 0 until the noon
    // position-wallet read, so every earlier minute was chain + corpses and the line
    // cliffed when discovery landed. The fold has to restate those minutes.
    const h = new History()
    const wei = 268_000_000_000_000_000n
    const spend = 10_000_000_000_000_000n
    const t0 = 1_000_000
    const s = {
      ...st(), at: t0,
      walletBalance: { value: wei, at: t0, source: 'chain' as const, n: null },
    }
    s.positions.set('p1', openPos({
      id: 'p1', openedAt: t0 - 60_000, spendWei: spend, tokensHeld: 1n, filled: true,
    }))
    h.observe({
      kind: 'chain-read', at: t0, seq: 1, run: 't',
      request: { kind: 'balance', args: ['0x'] }, result: wei.toString(),
      viaKey: true, tries: 1, latencyMs: 0,
    } as never, s, [], [])
    const mid = { ...s, at: t0 + 60_000 }
    h.observe({ kind: 'clock', at: mid.at, seq: 2 } as never, mid, [], [])
    expect(project(mid, h, FULL).walletPayload.panes.find((p) => p.id === 'wallet')!.y.at(-1)).toBe(0)

    s.positions.set('p1', openPos({
      id: 'p1', openedAt: t0 - 60_000, spendWei: spend, tokensHeld: 0n, filled: true,
      closed: true, closedAt: t0 + 120_000,
      abandonedAt: t0 + 120_000, abandonReason: 'zero tokens',
    }))
    const dead = { ...s, at: t0 + 120_000 }
    h.observe({
      kind: 'chain-read', at: dead.at, seq: 3, run: 't',
      request: { kind: 'position-wallet', args: ['0xtoken', 'p1'] },
      result: { balanceWei: '0' }, viaKey: true, tries: 1, latencyMs: 0,
    } as never, dead, [], [])

    for (const b of h.window(t0, dead.at)) {
      if (b.openCostWei !== null) expect(b.openCostWei).toBe(0n)
    }
    const total = project(dead, h, FULL).walletPayload.panes.find((p) => p.id === 'wallet')!
    expect(total.y[0]).toBe(0)
    expect(total.y.at(-1)).toBeCloseTo(-0.01, 6)
  })

  it('keeps a bag on Total through a later token confirm, then drops the minutes after', () => {
    const h = new History()
    const wei = 268_000_000_000_000_000n
    const spend = 10_000_000_000_000_000n
    const t0 = 1_000_000
    const s = {
      ...st(), at: t0,
      walletBalance: { value: wei, at: t0, source: 'chain' as const, n: null },
    }
    const live = openPos({
      id: 'p1', openedAt: t0 - 60_000, spendWei: spend, tokensHeld: 1n, filled: true,
    })
    s.positions.set('p1', live)
    h.observe({
      kind: 'chain-read', at: t0, seq: 1, run: 't',
      request: { kind: 'balance', args: ['0x'] }, result: wei.toString(),
      viaKey: true, tries: 1, latencyMs: 0,
    } as never, s, [], [])
    const confirmedAt = t0 + 60_000
    h.observe({
      kind: 'chain-read', at: confirmedAt, seq: 2, run: 't',
      request: { kind: 'position-wallet', args: ['0xtoken', 'p1'] },
      result: { balanceWei: '1' }, viaKey: true, tries: 1, latencyMs: 0,
    } as never, { ...s, at: confirmedAt }, [], [])
    const quiet = { ...s, at: t0 + 120_000 }
    h.observe({ kind: 'clock', at: quiet.at, seq: 3 } as never, quiet, [], [])

    s.positions.set('p1', openPos({
      id: 'p1', openedAt: t0 - 60_000, spendWei: spend, tokensHeld: 0n, filled: true,
      closed: true, closedAt: t0 + 180_000,
      abandonedAt: t0 + 180_000, abandonReason: 'zero tokens',
    }))
    const dead = { ...s, at: t0 + 180_000 }
    h.observe({
      kind: 'chain-read', at: dead.at, seq: 4, run: 't',
      request: { kind: 'position-wallet', args: ['0xtoken', 'p1'] },
      result: { balanceWei: '0' }, viaKey: true, tries: 1, latencyMs: 0,
    } as never, dead, [], [])

    const costs = h.window(t0, dead.at).filter((b) => b.openCostWei !== null)
    expect(costs.some((b) => b.at <= confirmedAt && b.openCostWei === spend)).toBe(true)
    expect(costs.filter((b) => b.at > confirmedAt).every((b) => b.openCostWei === 0n)).toBe(true)
  })
})

describe('the virtual wallet is this book\'s booked closes', () => {
  const t0 = 1_000_000
  const closed = (over: Partial<Position> = {}): Position => openPos({
    closed: true, closedAt: t0 + 60_000, tokensHeld: 0n,
    spendWei: 5_000_000_000_000_000n, proceedsWei: 7_000_000_000_000_000n,
    ...over,
  })

  it('starts at 0 and steps on a real close of that book, not the other book', () => {
    const h = new History()
    const s = st()
    h.observe({ kind: 'clock', at: t0, seq: 1 } as never, s, [], [])
    s.positions.set('p1', closed({ book: 'alpha' }))
    bookLedger(s.risk, 'alpha').realizedWei = 2_000_000_000_000_000n
    const mid = { ...s, at: t0 + 60_000 }
    h.observe({ kind: 'logs', at: mid.at, seq: 2 } as never, mid, [], [])
    const later = { ...s, at: t0 + 120_000 }
    h.observe({ kind: 'clock', at: later.at, seq: 3 } as never, later, [], [])

    const alpha = project(later, h, { ...FULL, selectedBook: 'alpha' }).chartPayload
    const bravo = project(later, h, { ...FULL, selectedBook: 'bravo' }).chartPayload
    const aLine = alpha.panes.find((p) => p.id === 'virtual')!
    const bLine = bravo.panes.find((p) => p.id === 'virtual')!
    expect(aLine.y[0]).toBeCloseTo(PAPER_START_ETH)
    expect(aLine.y.at(-1)).toBeCloseTo(PAPER_START_ETH + 0.002)
    expect(bLine.y.at(-1)).toBeCloseTo(PAPER_START_ETH)
    expect(aLine.subtitle).toContain('from 0')
    expect(alpha.trades).toHaveLength(1)
    expect(bravo.trades).toHaveLength(0)
  })

  it('a drawdown reset does not rewind the virtual line to 0', () => {
    const h = new History()
    const s = st()
    h.observe({ kind: 'clock', at: t0, seq: 1 } as never, s, [], [])
    s.positions.set('p1', closed({ book: 'alpha' }))
    bookLedger(s.risk, 'alpha').realizedWei = 2_000_000_000_000_000n
    const mid = { ...s, at: t0 + 60_000 }
    h.observe({ kind: 'logs', at: mid.at, seq: 2 } as never, mid, [], [])
    bookLedger(s.risk, 'alpha').realizedWei = 0n
    bookLedger(s.risk, 'alpha').peakWei = 0n
    const later = { ...s, at: t0 + 180_000 }
    h.observe({ kind: 'clock', at: later.at, seq: 3 } as never, later, [], [])
    const aLine = project(later, h, { ...FULL, selectedBook: 'alpha' }).chartPayload.panes.find((p) => p.id === 'virtual')!
    expect(aLine.y.at(-1)).toBeCloseTo(PAPER_START_ETH + 0.002)
  })

  it('a close outside the window does not lift a 1h view off 0, and 4h includes it', () => {
    const h = new History()
    const s = st()
    h.observe({ kind: 'clock', at: t0, seq: 1 } as never, s, [], [])
    s.positions.set('p1', closed({ book: 'alpha' }))
    const mid = { ...s, at: t0 + 60_000 }
    h.observe({ kind: 'logs', at: mid.at, seq: 2 } as never, mid, [], [])
    const later = { ...s, at: t0 + 3 * 3_600_000 }
    h.observe({ kind: 'clock', at: later.at, seq: 3 } as never, later, [], [])

    const oneHour = project(later, h, { ...FULL, selectedBook: 'alpha', windowLabel: '1h' })
    const fourHour = project(later, h, { ...FULL, selectedBook: 'alpha', windowLabel: '4h' })
    const v1 = oneHour.chartPayload.panes.find((p) => p.id === 'virtual')!
    const t1 = oneHour.walletPayload.panes.find((p) => p.id === 'wallet')!
    const v4 = fourHour.chartPayload.panes.find((p) => p.id === 'virtual')!
    const t4 = fourHour.walletPayload.panes.find((p) => p.id === 'wallet')!
    expect(v1.y[0]).toBe(0)
    expect(v1.y.at(-1)).toBe(0)
    expect(t1.y[0]).toBe(0)
    expect(t1.y.at(-1)).toBe(0)
    expect(oneHour.chartPayload.trades).toHaveLength(0)
    expect(oneHour.walletPayload.trades).toHaveLength(0)
    expect(v4.y[0]).toBe(0)
    expect(v4.y.at(-1)).toBeCloseTo(0.002)
    expect(t4.y.at(-1)).toBeCloseTo(0.002)
    expect(fourHour.chartPayload.trades).toHaveLength(1)
    expect(fourHour.walletPayload.trades).toHaveLength(1)
  })

  it('a close that left the minute ring does not lift a 1h view off 0', () => {
    const h = new History()
    const s = st()
    h.observe({ kind: 'clock', at: t0, seq: 1 } as never, s, [], [])
    s.positions.set('p1', closed({ book: 'alpha' }))
    const mid = { ...s, at: t0 + 60_000 }
    h.observe({ kind: 'logs', at: mid.at, seq: 2 } as never, mid, [], [])
    const start = Math.floor(mid.at / BUCKET_MS) + 1
    for (let i = 0; i < BUCKETS_KEPT; i++) {
      const at = (start + i) * BUCKET_MS
      h.observe({ kind: 'clock', at, seq: 3 + i } as never, { ...s, at }, [], [])
    }
    expect(h.equityPrefix('alpha').pnlWei).toBe(2_000_000_000_000_000n)
    const now = (start + BUCKETS_KEPT - 1) * BUCKET_MS
    const later = { ...s, at: now }
    const aLine = project(later, h, { ...FULL, selectedBook: 'alpha', windowLabel: '1h' })
      .chartPayload.panes.find((p) => p.id === 'virtual')!
    expect(aLine.y[0]).toBe(0)
    expect(aLine.y.at(-1)).toBe(0)
  })

  it('an abandoned bag steps this book by minus the spend, and leaves the other book flat', () => {
    const h = new History()
    const s = st()
    h.observe({ kind: 'clock', at: t0, seq: 1 } as never, s, [], [])
    s.positions.set('p1', closed({
      book: 'alpha', proceedsWei: 0n,
      abandonedAt: t0 + 60_000, abandonReason: 'zero tokens',
    }))
    const mid = { ...s, at: t0 + 60_000 }
    h.observe({ kind: 'logs', at: mid.at, seq: 2 } as never, mid, [], [])
    const later = { ...s, at: t0 + 120_000 }
    h.observe({ kind: 'clock', at: later.at, seq: 3 } as never, later, [], [])
    const aLine = project(later, h, { ...FULL, selectedBook: 'alpha' }).chartPayload.panes.find((p) => p.id === 'virtual')!
    const bLine = project(later, h, { ...FULL, selectedBook: 'bravo' }).chartPayload.panes.find((p) => p.id === 'virtual')!
    const trades = project(later, h, { ...FULL, selectedBook: 'alpha' }).chartPayload.trades
    expect(aLine.y[0]).toBe(0)
    expect(aLine.y.at(-1)).toBeCloseTo(PAPER_START_ETH - 0.005)
    expect(bLine.y.at(-1)).toBe(0)
    expect(trades).toHaveLength(1)
    expect(trades[0]!.reason).toBe('abandoned')
    expect(trades[0]!.t).toBe(990_000 / 1000)
  })

  it('a drawdown reset does not rewind an abandoned bag off the virtual line', () => {
    const h = new History()
    const s = st()
    h.observe({ kind: 'clock', at: t0, seq: 1 } as never, s, [], [])
    s.positions.set('p1', closed({
      book: 'alpha', proceedsWei: 0n,
      abandonedAt: t0 + 60_000, abandonReason: 'zero tokens',
    }))
    const mid = { ...s, at: t0 + 60_000 }
    h.observe({ kind: 'logs', at: mid.at, seq: 2 } as never, mid, [], [])
    bookLedger(s.risk, 'alpha').realizedWei = 0n
    bookLedger(s.risk, 'alpha').peakWei = 0n
    const later = { ...s, at: t0 + 180_000 }
    h.observe({ kind: 'clock', at: later.at, seq: 3 } as never, later, [], [])
    const aLine = project(later, h, { ...FULL, selectedBook: 'alpha' }).chartPayload.panes.find((p) => p.id === 'virtual')!
    expect(aLine.y.at(-1)).toBeCloseTo(PAPER_START_ETH - 0.005)
  })

  it('books an abandon on the position-wallet read, without waiting for logs', () => {
    const h = new History()
    const s = st()
    h.observe({ kind: 'clock', at: t0, seq: 1 } as never, s, [], [])
    s.positions.set('p1', closed({
      book: 'alpha', proceedsWei: 0n,
      abandonedAt: t0 + 60_000, abandonReason: 'zero tokens',
    }))
    const mid = { ...s, at: t0 + 60_000 }
    h.observe({
      kind: 'chain-read', at: mid.at, seq: 2, run: 't',
      request: { kind: 'position-wallet', args: ['0xtoken', 'p1'] },
      result: { balanceWei: '0' }, viaKey: true, tries: 1, latencyMs: 0,
    } as never, mid, [], [])
    const aLine = project(mid, h, { ...FULL, selectedBook: 'alpha' }).chartPayload.panes.find((p) => p.id === 'virtual')!
    expect(aLine.y[0]).toBe(0)
    expect(aLine.y.at(-1)).toBeCloseTo(PAPER_START_ETH - 0.005)
    expect(project(mid, h, { ...FULL, selectedBook: 'alpha' }).chartPayload.trades[0]!.t).toBe(990_000 / 1000)
  })

  it('puts every book\'s close on Total, and a book click does not change those dots', () => {
    const h = new History()
    const s = st()
    h.observe({ kind: 'clock', at: t0, seq: 1 } as never, s, [], [])
    s.positions.set('p1', closed({ book: 'alpha' }))
    bookLedger(s.risk, 'alpha').realizedWei = 2_000_000_000_000_000n
    const mid = { ...s, at: t0 + 60_000 }
    h.observe({ kind: 'logs', at: mid.at, seq: 2 } as never, mid, [], [])
    const alpha = project(mid, h, { ...FULL, selectedBook: 'alpha' })
    const bravo = project(mid, h, { ...FULL, selectedBook: 'bravo' })
    expect(alpha.walletPayload.book).toBeNull()
    expect(alpha.walletPayload.bands).toEqual([])
    expect(alpha.walletPayload.panes).toHaveLength(1)
    expect(alpha.walletPayload.panes[0]!.id).toBe('wallet')
    expect(alpha.walletPayload.trades).toHaveLength(1)
    expect(alpha.walletPayload.trades[0]!.book).toBe('alpha')
    expect(bravo.walletPayload.trades).toEqual(alpha.walletPayload.trades)
    expect(bravo.walletPayload.panes[0]!.y).toEqual(alpha.walletPayload.panes[0]!.y)
    expect(alpha.chartPayload.trades).toHaveLength(1)
    expect(bravo.chartPayload.trades).toEqual([])
  })

  it('Total is the sum of both books and Virtual dots are a subset', () => {
    const h = new History()
    const s = st()
    h.observe({ kind: 'clock', at: t0, seq: 1 } as never, s, [], [])
    s.positions.set('p1', closed({ id: 'p1', token: '0xa', book: 'alpha' }))
    const mid = { ...s, at: t0 + 60_000 }
    h.observe({ kind: 'logs', at: mid.at, seq: 2 } as never, mid, [], [])
    s.positions.set('p2', closed({
      id: 'p2', token: '0xb', book: 'bravo',
      spendWei: 5_000_000_000_000_000n, proceedsWei: 8_000_000_000_000_000n,
      closedAt: t0 + 90_000,
    }))
    const later = { ...s, at: t0 + 90_000 }
    h.observe({ kind: 'logs', at: later.at, seq: 3 } as never, later, [], [])
    const alpha = project(later, h, { ...FULL, selectedBook: 'alpha' })
    const bravo = project(later, h, { ...FULL, selectedBook: 'bravo' })
    const total = alpha.walletPayload.panes.find((p) => p.id === 'wallet')!
    const vA = alpha.chartPayload.panes.find((p) => p.id === 'virtual')!
    const vB = bravo.chartPayload.panes.find((p) => p.id === 'virtual')!
    expect(vA.y.at(-1)).toBeCloseTo(0.002)
    expect(vB.y.at(-1)).toBeCloseTo(0.003)
    expect(total.y.at(-1)).toBeCloseTo(0.005)
    expect(alpha.walletPayload.trades).toHaveLength(2)
    const virtualTs = new Set(alpha.chartPayload.trades.map((t) => `${t.t}:${t.book}`))
    expect(virtualTs.size).toBe(1)
    expect(alpha.walletPayload.trades.some((t) => virtualTs.has(`${t.t}:${t.book}`))).toBe(true)
    expect(bravo.chartPayload.trades).toHaveLength(1)
    expect(bravo.chartPayload.trades[0]!.book).toBe('bravo')
  })

  it('a drawdown reset does not rewind the Total line', () => {
    const h = new History()
    const s = st()
    h.observe({ kind: 'clock', at: t0, seq: 1 } as never, s, [], [])
    s.positions.set('p1', closed({ book: 'alpha' }))
    bookLedger(s.risk, 'alpha').realizedWei = 2_000_000_000_000_000n
    const mid = { ...s, at: t0 + 60_000 }
    h.observe({ kind: 'logs', at: mid.at, seq: 2 } as never, mid, [], [])
    bookLedger(s.risk, 'alpha').realizedWei = 0n
    bookLedger(s.risk, 'alpha').peakWei = 0n
    s.risk.walletRealizedWei = 0n
    const later = { ...s, at: t0 + 180_000 }
    h.observe({ kind: 'clock', at: later.at, seq: 3 } as never, later, [], [])
    const total = project(later, h, { ...FULL, selectedBook: 'alpha' }).walletPayload.panes.find((p) => p.id === 'wallet')!
    expect(total.y[0]).toBe(0)
    expect(total.y.at(-1)).toBeCloseTo(0.002)
  })

  it('drops a close older than 7d from the chart list after later traffic', () => {
    const h = new History()
    const s = st()
    h.observe({ kind: 'clock', at: t0, seq: 1 } as never, s, [], [])
    s.positions.set('p1', closed({ book: 'alpha' }))
    const mid = { ...s, at: t0 + 60_000 }
    h.observe({ kind: 'logs', at: mid.at, seq: 2 } as never, mid, [], [])
    const laterAt = t0 + 60_000 + LEVELS.chartTradesHorizonMs + 60_000
    h.observe({ kind: 'clock', at: laterAt, seq: 3 } as never, { ...s, at: laterAt }, [], [])
    expect(h.tradesIn(laterAt - LEVELS.chartTradesHorizonMs, laterAt)).toHaveLength(0)
    const week = project({ ...s, at: laterAt }, h, { ...FULL, selectedBook: 'alpha', windowLabel: '7d' })
    expect(week.walletPayload.trades).toHaveLength(0)
    expect(week.chartPayload.trades).toHaveLength(0)
    expect(week.walletPayload.panes[0]!.y.at(-1)).toBe(0)
  })

  it('paints a venue halt on the selected book as warn, and does not give it to the other book', () => {
    const h = new History()
    const s = st()
    h.observe({ kind: 'clock', at: t0, seq: 1 } as never, s, [], [])
    s.risk.halts.set('venue:alpha', { kind: 'venue', book: 'alpha', reason: 'paused', at: t0 + 180_000 })
    const later = { ...s, at: t0 + 180_000 }
    h.observe({ kind: 'clock', at: later.at, seq: 2 } as never, later, [], [])
    const minute = h.window(later.at, later.at)[0]!
    expect(minute.halted).toBe(true)
    expect(minute.haltStamps).toEqual([{ kind: 'venue', book: 'alpha' }])
    const gap = h.window(t0, later.at).find((b) => b.haltStamps === null)
    expect(gap).toBeDefined()

    const alpha = project(later, h, { ...FULL, selectedBook: 'alpha' }).chartPayload
    const bravo = project(later, h, { ...FULL, selectedBook: 'bravo' }).chartPayload
    expect(alpha.bands.some((b) => b.stroke === 'warn')).toBe(true)
    expect(bravo.bands.some((b) => b.stroke === 'warn')).toBe(false)
  })

  it('greys the virtual pane on a wallet-wide dashboard stop', () => {
    const h = new History()
    const s = st()
    s.risk.halts.set('stopped', { kind: 'stopped', book: null, reason: 'stopped from the dashboard', at: s.at })
    h.observe({ kind: 'clock', at: t0, seq: 1 } as never, s, [], [])
    const minute = h.window(t0, t0)[0]!
    expect(minute.halted).toBe(true)
    expect(minute.haltStamps).toEqual([{ kind: 'stopped', book: null }])
    const alpha = project(s, h, { ...FULL, selectedBook: 'alpha' }).chartPayload
    const bravo = project(s, h, { ...FULL, selectedBook: 'bravo' }).chartPayload
    expect(alpha.bands.some((b) => b.stroke === 'muted')).toBe(true)
    expect(bravo.bands.some((b) => b.stroke === 'muted')).toBe(true)
  })
})

describe('totals are totals, not the last forty trades', () => {
  /**
   * WHAT THIS PINS. `history.recentExits()` is capped at `LEVELS.exitsKept` because it carries
   * whole trades for the exits table. It was also the only input to the KPI table and to every
   * window in the machine report, so past 40 closes the page said "40" for a 24h window and the
   * phone report printed that as the day's trade count and the day's P&L. The minute buckets
   * have counted every close per book for seven days the whole time.
   *
   * The medians are deliberately still the capped sample: a median needs the trades themselves.
   * They carry their own n so the difference is visible rather than implied.
   */
  const N = 100
  const pos = (i: number) => ({
    id: `p${i}`, token: `0x${i.toString(16).padStart(40, '0')}`, curve: `0xc${i}`,
    book: 'alpha', bookDigest: 'd', templateKey: '0:0:5',
    // Inside coverage: the view clamps its window to the first event ever folded, so a trade
    // stamped before that is outside the window by construction and not what is being tested.
    openedAt: 1_000_000 + i, spendWei: 1_000_000_000_000_000n, entryMarkWei: 1_000_000_000_000_000n,
    rules: { takeProfitMultiple: 1.75 } as never,
    tokensHeld: 0n, peakMarkWei: 2_000_000_000_000_000n,
    // Half win a tenth of the stake, half lose a twentieth: net is positive and checkable.
    proceedsWei: i % 2 === 0 ? 1_100_000_000_000_000n : 950_000_000_000_000n,
    closedAt: 1_000_000 + i, abandonedAt: null, abandonReason: null,
    attempts: 1, inflightIntentId: null, closed: true, filled: true,
  })

  const filled = () => {
    const h = new History()
    const s = st()
    for (let i = 0; i < N; i++) s.positions.set(`p${i}`, pos(i) as never)
    h.observe({ kind: 'logs', at: 1_000_000, seq: 1 } as never, s, [], [])
    return { h, s }
  }

  const NET = 50n * 100_000_000_000_000n - 50n * 50_000_000_000_000n // +0.0025 ETH over 100 trades

  it('the exits table is still capped, which is what makes the rest of this necessary', () => {
    const { h } = filled()
    expect(h.recentExits()).toHaveLength(LEVELS.exitsKept)
    expect(h.totals.closed).toBe(N)
    expect(h.totals.wins).toBe(N / 2)
  })

  it('the virtual pane keeps a sized dot for every close, not just the forty in the table', () => {
    const { h, s } = filled()
    const later = { ...s, at: 1_000_000 + N }
    const payload = project(later, h, FULL).chartPayload
    expect(payload.trades).toHaveLength(N)
    expect(payload.trades.every((t) => t.r >= LEVELS.chartDotMinPx)).toBe(true)
    expect(payload.trades.some((t) => t.tone === 'good')).toBe(true)
    expect(payload.trades.some((t) => t.tone === 'bad')).toBe(true)
  })

  it('rings a take-profit close', () => {
    const h = new History()
    const token = `0x${'ab'.repeat(20)}`
    const s = st()
    h.observe({ kind: 'clock', at: 1_000_000, seq: 1 } as never, s, [
      { kind: 'sell', token, reason: 'tp' },
    ] as never, [])
    s.positions.set('p1', { ...pos(0), token } as never)
    h.observe({ kind: 'logs', at: 1_000_000, seq: 2 } as never, s, [], [])
    const [tp] = project(s, h, FULL).chartPayload.trades
    expect(tp?.ring).toBe(true)
    expect(tp?.reason).toBe('tp')
  })

  it('the rolling table counts every close in the window and nets every one of them', () => {
    const { h, s } = filled()
    const vm = project(s, h, FULL)
    const n = vm.kpis.find((r) => r.key === 'n')!
    expect(n.cells.every((c) => c.value === N)).toBe(true)
    const win = vm.kpis.find((r) => r.key === 'winRate')!
    expect(win.cells[0]!.value).toBeCloseTo(50)
    const pnl = vm.kpis.find((r) => r.key === 'pnlUsd')!
    expect(pnl.cells[0]!.value).toBeCloseTo(Number(NET) / 1e18 * 2000, 6)
  })

  it('rolling is the selected book, not a TOTAL of mixed policies', () => {
    const { h, s } = filled()
    const vm = project(s, h, FULL)
    expect(vm.kpis.some((r) => r.label === 'TOTAL')).toBe(false)
    expect(vm.selectedBook).toBe('alpha')
    expect(vm.kpis.find((r) => r.key === 'n')!.cells[0]!.value).toBe(N)
  })

  it('return on turnover is pnl over spend from the buckets, not n times the current stake', () => {
    const { h, s } = filled()
    const rot = project(s, h, FULL).kpis.find((r) => r.key === 'rotPct')!
    // NET 0.0025 ETH / 0.1 ETH spend = 2.5%
    expect(rot.cells[0]!.value).toBeCloseTo(2.5)
    expect(rot.cells[0]!.missing).toBeNull()
  })

  it('the wallet card counts every close since zero, not the last forty', () => {
    const { h, s } = filled()
    expect(project(s, h, FULL).wallet.closed.value).toBe(N)
  })

  it('the machine report agrees with the ledger, and says how big the median sample was', () => {
    const { h, s } = filled()
    const r = buildReport(s, h, { value: 2000, source: 'test' })
    const day = r.windows.find((w) => w.label === '24h')!
    expect(day.n).toBe(N)
    expect(day.pnlEth).toBeCloseTo(Number(NET) / 1e18, 9)
    expect(day.winPct).toBeCloseTo(50)
    // The medians could only see the trades the history still holds. Saying so is the point.
    expect(day.medianN).toBe(LEVELS.exitsKept)
    expect(r.books.find((b) => b.id === 'alpha')!.n24h).toBe(N)
  })
})

describe('us against our own replay, on the page and in the report', () => {
  /**
   * THE WARNING IS THE POINT, not the halt. Both of v1's September losses were bugs rather than
   * markets, and both were found by a person reading numbers hours in. The halt stops the wallet;
   * this line is the one that arrives while the bug is still cheap, about twenty minutes into the
   * 09-06 log drop instead of five hours.
   */
  const withGap = (gapPp: number, at = 1_000) => {
    const s = st()
    return {
      ...s,
      sensors: {
        ...s.sensors,
        broken: { value: { gapPp, n: 20, realPp: -7.1, replayPp: 14.4 }, at, source: 'fold' as const, n: 20 },
      },
    }
  }

  const limit = () => st().config.risk.brokenGapPp

  it('says nothing before the reading exists', () => {
    expect(st().sensors.broken).toBeNull()
    expect(buildAlerts(st(), new History()).some((a) => a.id === 'broken')).toBe(false)
  })

  it('says nothing while the gap is inside the band', () => {
    const inside = -limit() * LEVELS.brokenWarnFraction + 0.1
    expect(buildAlerts(withGap(inside), new History()).some((a) => a.id === 'broken')).toBe(false)
  })

  it('warns at two thirds of the way to the halt, naming the limit', () => {
    const a = buildAlerts(withGap(-limit() * LEVELS.brokenWarnFraction), new History()).find((x) => x.id === 'broken')
    expect(a?.sev).toBe('warn')
    expect(a?.msg).toContain(String(limit()))
    expect(a?.msg).toContain('Check execution and replay assumptions')
  })

  it('crits at the limit, with both means so the sentence can be argued with', () => {
    const a = buildAlerts(withGap(-limit()), new History()).find((x) => x.id === 'broken')
    expect(a?.sev).toBe('crit')
    expect(a?.msg).toContain('Wallet safety stop')
    expect(a?.msg).toContain('-7.1%')
    expect(a?.msg).toContain('14.4%')
  })

  it('carries the reading, its window and its limit into the report the phone reads', () => {
    const r = buildReport(withGap(-18.3, 500), new History(), null)
    expect(r.broken).toMatchObject({ gapPp: -18.3, n: 20, realPp: -7.1, replayPp: 14.4, limitPp: limit() })
    expect(r.broken!.ageMs, 'the age, so a reading that stopped moving is visible').toBe(st().at - 500)
    expect(buildReport(st(), new History(), null).broken, 'null, not zero, before a full window').toBeNull()
  })
})

describe('one event, one alert', () => {
  /**
   * `alerts.ts` labelled each book with `haltedFor`, which answers "may this book trade" and so
   * matches wallet-wide halts too. One wallet halt therefore printed a crit line per declared
   * book AND the wallet line: three alerts that sound like three problems, for one event. That
   * is how a page teaches an operator to skim past crits.
   */
  const halted = (halt: { kind: string; book: string | null; reason: string }) => {
    const s = st()
    s.risk.halts.set(halt.book === null ? halt.kind : `${halt.kind}:${halt.book}`, { ...halt, at: 1 } as never)
    return s
  }

  it('reports a wallet-wide halt once, not once per book', () => {
    const alerts = buildAlerts(halted({ kind: 'stopped', book: null, reason: 'stopped from the dashboard' }), new History())
    const crits = alerts.filter((a) => a.msg.includes('halted'))
    expect(crits).toHaveLength(1)
    expect(crits[0]!.msg).toContain('wallet-wide')
  })

  it('still names the book when the halt is that book\'s own', () => {
    const alerts = buildAlerts(halted({ kind: 'venue', book: 'alpha', reason: 'shut' }), new History())
    const crits = alerts.filter((a) => a.msg.includes('halted'))
    expect(crits).toHaveLength(1)
    expect(crits[0]!.msg).toContain('alpha')
    // bravo is not halted and must not be told it is.
    expect(crits[0]!.msg).not.toContain('bravo')
  })
})

/**
 * A buy that never reached the chain, which is the one failure every other projection hides.
 *
 * On 2026-09-16 the fold raised eight buys, the signer signed them for chain 6343 and the
 * sequencer wanted 4663, so all eight were rejected before sequencing. Nothing opened, nothing
 * was booked, the nonce stayed ours, and the wallet, the P&L, the halts and the funnel all read
 * exactly as they do on a quiet night. The page said the bot was fine for twenty minutes.
 */
describe('a buy the chain never saw is a fault, not a quiet market', () => {
  const at = 1_000_000
  const token = '0x' + 'b'.repeat(40)

  const rejected = (n: number, bucket = 'send-rejected'): { s: ReturnType<typeof st>; h: History } => {
    const s = st()
    // The book attribution comes from the observation, because a refusal names a token.
    s.observations.set('0xcurve', { token, book: 'alpha', startedAt: at, launchBlock: 1 } as never)
    const h = new History()
    h.observe(
      { kind: 'chain-read', at, seq: 1, request: { kind: 'meta', args: [] } } as never,
      s,
      [],
      Array.from({ length: n }, () => ({ at, bucket, subject: token, reason: 'invalid chain id for signer' })) as never,
    )
    return { s, h }
  }

  it('raises a crit on the first rejected send, with no rate and no minimum', () => {
    const { s, h } = rejected(1)
    const a = buildAlerts(s, h).find((x) => x.id === 'send-alpha')
    expect(a?.sev).toBe('crit')
    expect(a?.msg).toContain('not one of them reached the chain')
  })

  it('names the book that could not send, and leaves the other one alone', () => {
    const { s, h } = rejected(8)
    const ids = buildAlerts(s, h).filter((x) => x.id.startsWith('send-')).map((x) => x.id)
    expect(ids).toEqual(['send-alpha'])
    expect(buildAlerts(s, h).find((x) => x.id === 'send-alpha')!.msg).toContain('8 buys')
  })

  it('counts a refusal by the send path itself, not only one the chain rejected', () => {
    const { s, h } = rejected(2, 'send-refused')
    expect(buildAlerts(s, h).some((x) => x.id === 'send-alpha')).toBe(true)
  })

  it('says nothing when nothing was rejected', () => {
    expect(buildAlerts(st(), new History()).some((x) => x.id.startsWith('send-'))).toBe(false)
  })

  it('forgets a failure that has aged out of the window, so a fixed send path goes quiet', () => {
    const { s, h } = rejected(3)
    const later = { ...s, at: at + LEVELS.sendFailureWindowMs + 60_000 }
    expect(buildAlerts(later, h).some((x) => x.id === 'send-alpha')).toBe(false)
  })
})

/**
 * What the chain reads are costing, which v1 was blind to twice.
 *
 * Reads that quietly start failing or slowing while the log stream keeps flowing make the book read
 * as a quiet market rather than a broken endpoint; 962 launches went that way in one day. It is a
 * METER AND NEVER A GATE: v1's gating version was removed on 2026-09-06 because its projection
 * would have moved reads onto a public RPC that was refusing 1,100 polls an hour, on a prediction.
 */
describe('the read meter counts what the reads cost', () => {
  const READ_AT = 1_000_000
  const read = (
    h: History, s: ReturnType<typeof st>,
    over: { kind?: string; result?: unknown; tries?: number; latencyMs?: number; viaKey?: boolean } = {},
  ): void => {
    h.observe({
      kind: 'chain-read', at: READ_AT, seq: 1, run: 't',
      request: { kind: over.kind ?? 'meta', args: ['0xc'] },
      result: 'result' in over ? over.result : { params: {} },
      viaKey: over.viaKey ?? true, tries: over.tries ?? 1, latencyMs: over.latencyMs ?? 100,
    } as never, s, [], [])
  }
  const rowsOf = (h: History, s: ReturnType<typeof st>) => project(s, h, FULL).readHealth

  it('reports nothing before any read, rather than a row of zeroes', () => {
    expect(rowsOf(new History(), st())).toEqual([])
  })

  it('counts reads per kind and keeps the busiest first', () => {
    const h = new History(); const s = st()
    read(h, s, { kind: 'meta' }); read(h, s, { kind: 'meta' }); read(h, s, { kind: 'balance' })
    const rows = rowsOf(h, s)
    expect(rows.map((r) => r.kind)).toEqual(['meta', 'balance'])
    expect(rows[0]!.reads).toBe(2)
  })

  /**
   * A METER THAT ONLY COUNTS SUCCESSES READS BEST EXACTLY WHEN THE PROVIDER IS WORST, which is the
   * failure this whole thing exists to make visible.
   */
  it('counts a failed read, because a failed read is a launch dropped', () => {
    const h = new History(); const s = st()
    read(h, s); read(h, s, { result: null })
    const row = rowsOf(h, s)[0]!
    expect(row.reads).toBe(2)
    expect(row.failed).toBe(1)
  })

  it('counts a read that needed more than one attempt', () => {
    const h = new History(); const s = st()
    read(h, s, { tries: 1 }); read(h, s, { tries: 3 })
    expect(rowsOf(h, s)[0]!.retried, 'only more-than-one counts; every read has a first try').toBe(1)
  })

  it('counts how many reads the keyed endpoint served, so a failing provider is visible', () => {
    const h = new History(); const s = st()
    read(h, s, { viaKey: true }); read(h, s, { viaKey: false }); read(h, s, { viaKey: false })
    const row = rowsOf(h, s)[0]!
    expect(row.viaKey).toBe(1)
    expect(row.reads - row.viaKey, 'two fell through to the public spare').toBe(2)
  })

  it('reports latency percentiles over the reads it timed', () => {
    const h = new History(); const s = st()
    for (const ms of [10, 20, 30, 40, 900]) read(h, s, { latencyMs: ms })
    const row = rowsOf(h, s)[0]!
    expect(row.p50Ms).toBe(30)
    expect(row.p95Ms).toBe(900)
    expect(row.maxMs).toBe(900)
  })

  /**
   * A ROW WITHOUT A LATENCY IS COUNTED BUT NOT TIMED. Same lesson as the receipt verdict: a tape
   * outlives the shape it was written in, and an `undefined` in the latency array poisons the sort
   * so every percentile drawn from it reads NaN. A wrong number is worse than an absent one.
   */
  it('counts a row written before latency was recorded, without poisoning the percentiles', () => {
    const h = new History(); const s = st()
    h.observe({
      kind: 'chain-read', at: READ_AT, seq: 1, run: 't',
      request: { kind: 'meta', args: ['0xc'] }, result: { params: {} },
    } as never, s, [], [])
    read(h, s, { latencyMs: 50 })
    const row = rowsOf(h, s)[0]!
    expect(row.reads, 'the read happened, so it is counted').toBe(2)
    expect(row.p50Ms, 'and the one row that carried a latency is the only one timed').toBe(50)
    expect(Number.isNaN(row.p50Ms)).toBe(false)
  })

  /**
   * DESCENDING ON PURPOSE, so the assertion can tell bounded from unbounded. Fed ascending, the
   * largest latency is also the newest, it survives either way, and the test passes whether the
   * cap works or not.
   */
  it('holds a bounded number of latencies, because this runs inside the trading process', () => {
    const h = new History(); const s = st()
    const extra = 250
    for (let i = 0; i < READ_LATENCIES_KEPT + extra; i++) read(h, s, { latencyMs: 10_000 - i })
    const row = rowsOf(h, s)[0]!
    expect(row.reads, 'every read still counts').toBe(READ_LATENCIES_KEPT + extra)
    expect(row.maxMs, 'the slowest reads were the oldest, and they have been dropped').toBe(10_000 - extra)
  })
})
