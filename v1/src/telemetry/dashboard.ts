import { simulationReport } from '../simulation/reporting.js'
import { liveBooks, routeBook } from '../strategy/books.js'
import { scenarioOutcomeBuckets, scenarioComparison, displayCoins } from './dashboard-paper.js'
import {readForwardLedger} from '../simulation/forward-ledger.js'
import { gzipSync } from 'node:zlib'
import { effectiveMarketPolicy, executionScenarioHistory, dashboardMoney, bookedWindow, adaptiveHistory, outcomeBuckets, paperSeries, paperCalibration } from './dashboard-policy.js'
/**
 * A read-only status server for the running bot.
 *
 * Everything here is observation. It never touches a position, and the JSON snapshot is
 * built on demand from state that already exists, so a browser being open cannot change
 * what the bot does.
 *
 * The panels are ordered by what actually costs money when it goes wrong, not by what is
 * interesting to look at. Plumbing first, because a starved logs stream looks exactly
 * like a quiet market until you notice the bot has stopped trading.
 */
import http from 'node:http'
import { STALE_MS } from '../strategy/gate.js'
import type { HaltKind } from '../strategy/risk.js'
import { truthGet as truthGetDb, NON_TRADE_SQL } from './db.js'
import type { Bot } from '../bot.js'
import { STRATEGY, RISK, ENDPOINTS, GAS } from '../config.js'
import { config as liveConfig, configChangedAt, configErrors, envFilePath, pendingRestartChanges } from '../config/store.js'
import { dashboardHtml } from './dashboard-page.js'
import Database from 'better-sqlite3'
import { replayGate, thin, type GateObs } from './gatehistory.js'
import { rollingKpis, minutesSinceLastTrade, median, sampleSd, type TradeRow } from './kpi.js'
import * as LEVELS from './levels.js'
import { dashboardNotices, dashboardBanner } from './dashboard-notices.js'
import { resourceAlerts, type ResourceReading } from './resources.js'
import { binWidth, marketHistory, paperReconstructed, reconstructMarketHistory, scoreObservations, spliceReconstructed, thinSamples, type BarChooser, type MarketOutcomeRow } from './market-history.js'
import { adaptiveTakeProfit, barKey } from '../strategy/takeprofit.js'
import { FRESH_POLICY } from '../strategy/fresh-policy.js'

const num = (v: bigint) => Number(v) / 1e18

/**
 * Where to send someone who wants to SEE a trade rather than audit it.
 *
 * The explorer link answers "did this transfer happen"; it has no price chart, so it
 * cannot answer "what did this coin actually do", which is the question you have when
 * scanning a list of exits. Kept as one function so pointing it at the venue's own
 * terminal is a single edit.
 */
export const tradeUrl = (token: string): string => `${ENDPOINTS.terminal}/${token}`

/** the explorer links, in one place for the same reason: two call sites had drifted apart */
export const tokenUrl = (token: string): string => `${ENDPOINTS.explorer}/token/${token}`
export const curveUrl = (curve: string): string => `${ENDPOINTS.explorer}/address/${curve}`
export const txUrl = (hash: string): string => `${ENDPOINTS.explorer}/tx/${hash}`

/**
 * gate.db, opened read-only from this side as well.
 *
 * Deliberately a SECOND handle rather than sharing the bot's RegimeGate: that one decides
 * whether to halt trading, and coupling it to page rendering would let a dashboard bug
 * reach the halt path. Two readers under WAL is exactly what this file already supports
 * (a python writer plus the bot). Never latches on failure - the watcher's timer and the
 * bot's start order are independent, so a missing file is a normal transient.
 */
let gateDb: Database.Database | null = null
let gateNextTry = 0
/** env-overridable so tests can point at a fixture; production never sets it */
const GATE_DB = process.env.GATE_DB ?? 'data/gate.db'
function openGate(): Database.Database | null {
  if (gateDb) return gateDb
  if (Date.now() < gateNextTry) return null
  gateNextTry = Date.now() + 60_000
  try { gateDb = new Database(GATE_DB, { readonly: true, fileMustExist: true }) } catch { return null }
  return gateDb
}
function gateRows(): GateObs[] {
  const db = openGate()
  if (!db) return []
  try {
    return db.prepare(
      `SELECT block, launched_at, at, touch FROM obs WHERE error IS NULL ORDER BY block ASC`,
    ).all() as GateObs[]
  } catch { return [] }
}

/**
 * The rung a reconstructed launch is scored at: the same argmax over the trailing window the
 * bot runs live (bot.ts pickTakeProfit), so the backfill is priced the way the coin would
 * have been. Unknown falls through to the flat bar, never to the hottest rung.
 */
function adaptiveRung():BarChooser{
  const a=STRATEGY.takeProfit.adaptive
  if(!a.enabled)return barKey(STRATEGY.takeProfit.otherwise)
  return preceding=>barKey(adaptiveTakeProfit(preceding,a.window,a.bars,STRATEGY.takeProfit.otherwise).multiple)
}

/**
 * Trim a chart number to the digits a pane can show. Seventeen significant figures of a
 * float cost about 12 bytes each on a series of thousands of points, and nothing reads them.
 */
const round=(v:number|null|undefined,dp:number):number|null=>
  v===null||v===undefined||!Number.isFinite(v)?null:Math.round(v*10**dp)/10**dp

/**
 * Median round-trip gas of the real trades, ETH. The venue replay is gross of gas (the gate
 * scorer runs comp=0, haircut=0), so a rebuilt trade has to pay it to be comparable with a
 * recorded one. Median, not mean: one reverted-sell retry loop once burned $101 of gas on a
 * single position and a mean would carry it across eleven days of chart.
 */
function medianGasEth(db:Database.Database):number{
  try{
    const rows=db.prepare(`SELECT CAST(gas_wei AS REAL) g FROM positions
      WHERE live=1 AND closed=1 AND buy_ok=1 AND gas_wei IS NOT NULL ORDER BY id DESC LIMIT 200`)
      .all() as Array<{g:number}>
    if(rows.length<20)return 0
    const v=rows.map(r=>r.g).sort((a,b)=>a-b)
    return v[Math.floor(v.length/2)]!/1e18
  }catch{return 0}
}

/** Rows the live market guard would admit, bounded to the requested chart period. */
function marketOutcomeRows(book:Database.Database,from:number,to:number):MarketOutcomeRow[]{
  const gate=openGate()
  if(!gate)return []
  try{
    // the launch facts ride along: the paper rebuild reapplies the template-loss block, and
    // the template is tax:devBuy:exemptions. Same rows, same scan, three more columns.
    type Launch={token:string;creator_tax_bps:number|null;dev_buy_wei:string|null;exemptions:number|null}
    const eligible=new Map((book.prepare(
      `SELECT token,creator_tax_bps,dev_buy_wei,exemptions FROM launches
       WHERE launched_at>=? AND launched_at<=?
       AND creator_tax_bps>=? AND COALESCE(exemptions,0)>=?`,
    ).all(Math.floor(from/1000),Math.ceil(to/1000),STRATEGY.minCreatorTaxBps,STRATEGY.minExemptionsToEnter) as Launch[]).map(row=>[row.token,row]))
    if(!eligible.size)return []
    return (gate.prepare(
      `SELECT token,block,launched_at,bars FROM obs
       WHERE error IS NULL AND bars IS NOT NULL AND launched_at>=? AND launched_at<=?
       ORDER BY block`,
    ).all(Math.floor(from/1000),Math.ceil(to/1000)) as Array<{token:string;block:number;launched_at:number;bars:string}>)
      .filter(row=>eligible.has(row.token))
      .map(row=>{const l=eligible.get(row.token)!
        return {token:row.token,block:row.block,launchedAt:row.launched_at,bars:row.bars,
          creatorTaxBps:l.creator_tax_bps,devBuyWei:l.dev_buy_wei,exemptions:l.exemptions}})
  }catch{return []}
}

/**
 * The REAL peak each token reached inside the GATE's observation window, keyed by token.
 *
 * positions.peak_mult stops the moment we sell, so a take-profit truncates it by
 * construction: we exit at 1.20 and record a 1.22 peak while the coin carries on to 1.57
 * without us. That is the one number that says whether the exit rule is leaving money on
 * the table, and our own row can never contain it.
 *
 * gatewatch.py already measures it. It replays the curve from chain logs over
 * HOLD = gate.holdMs/100 blocks and stores max(multiple) over the whole window, holding
 * nothing and caring not at all when we sold.
 *
 * gate.holdMs, NOT maxHoldMs: this comment used to say maxHoldMs and was true only while
 * the two happened to be equal. They separated on 2026-08-27 when the exit clock went to
 * 90s and the gate's window stayed pinned at 45s, on purpose (a regime detector has to be
 * a fixed yardstick). So this column is "the best 45s any holder could have had", which is
 * NOT the span we now hold for, and reading it as a bound on our own exit is wrong.
 *
 * Caveat worth keeping in mind when reading the two side by side: gatewatch prices its
 * entry at launch block + 20, not at our actual fill, so this is "what our rule would have
 * seen" rather than a multiple on our exact basis. On time-exits, where we held the full
 * window and both numbers cover the same span, they agree to within about 0.008.
 *
 * Missing is normal and must stay cheap: gate.db is optional, and a launch scored after
 * this poll simply has no row yet.
 */
function truePeaks(tokens: string[]): Map<string, number> {
  const out = new Map<string, number>()
  if (!tokens.length) return out
  const db = openGate()
  if (!db) return out
  try {
    const rows = db.prepare(
      `SELECT token, peak FROM obs WHERE error IS NULL AND token IN (${tokens.map(() => '?').join(',')})`,
    ).all(...tokens) as Array<{ token: string; peak: number | null }>
    for (const r of rows) if (r.peak != null) out.set(r.token, r.peak)
  } catch { /* gate.db is the watcher's, and the page works without it */ }
  return out
}

/** the watcher's heartbeat, so a dead gatewatch is visible before it halts anything.
 * STALE_MS comes from the module that owns the halt decision, so the page and the bot
 * can never answer "is the watcher dead" differently. */

/**
 * What the page should say the gate is doing, given the replayed history and the
 * watcher's heartbeat.
 *
 * Its whole job is to not disagree with the bot. `obs` is what the watcher last wrote, so
 * a watcher that died leaves it frozen at whatever the venue was doing at the time; the
 * replay then renders GATE OPEN in green while the bot has halted itself for exactly that
 * staleness. Same rule as strategy/gate.ts: a watcher that stopped reads as shut.
 */
export function gateCardState(
  replayed: 'open' | 'shut' | null,
  heartbeatMs: number | null,
): { state: 'open' | 'shut' | null; stale: boolean } {
  const stale = heartbeatMs === null || heartbeatMs >= STALE_MS
  if (replayed === null) return { state: null, stale }
  return { state: stale ? 'shut' : replayed, stale }
}

function gateHeartbeatMs(): number | null {
  try {
    const r = gateDb?.prepare(`SELECT value FROM state WHERE key='ran_at'`).get() as { value: string } | undefined
    return r ? Date.now() - Number(r.value) : null
  } catch { return null }
}

/** one verdict of scripts/edgecheck.py: a rule the bot runs, and whether it still pays */
export type EdgeVerdict = { rule: string; ok: boolean; why: string }
export type EdgeState = {
  ranAt: number
  ageMs: number
  verdicts: EdgeVerdict[]
  mainNegStreak: number
  bar: number | null
  windows: Record<string, unknown>
}

/**
 * Parse what scripts/edgecheck.py wrote to gate.db state 'edgecheck'. Null on anything
 * that is not the expected shape: a missing row, invalid JSON, a number where an object
 * should be. The page shares the process with the trading loop, so this must never throw,
 * and it must never invent a verdict from a half-parsed one.
 */
export function parseEdge(raw: string | null | undefined, now = Date.now()): EdgeState | null {
  if (typeof raw !== 'string' || !raw) return null
  let o: any
  try { o = JSON.parse(raw) } catch { return null }
  if (!o || typeof o !== 'object' || typeof o.ran_at !== 'number') return null
  const verdicts = Array.isArray(o.verdicts)
    ? o.verdicts.filter((v: any) => v && typeof v.rule === 'string' && typeof v.ok === 'boolean')
        .map((v: any) => ({ rule: v.rule, ok: v.ok, why: typeof v.why === 'string' ? v.why : '' }))
    : []
  return {
    ranAt: o.ran_at, ageMs: Math.max(0, now - o.ran_at), verdicts,
    mainNegStreak: typeof o.main_neg_streak === 'number' ? o.main_neg_streak : 0,
    bar: typeof o.bar === 'number' ? o.bar : null,
    windows: o.windows && typeof o.windows === 'object' ? o.windows : {},
  }
}

function edgeState(): EdgeState | null {
  try {
    const db = openGate()
    if (!db) return null
    const r = db.prepare(`SELECT value FROM state WHERE key='edgecheck'`).get() as { value: string } | undefined
    return parseEdge(r?.value ?? null)
  } catch { return null }
}

/**
 * Every closed live trade in the last 24h, pulled once and bucketed in JS.
 *
 * One bounded pull beats four SQL aggregates here: `positions` is never pruned, so an
 * aggregate over it degrades forever while `exit_at >= ?` stays flat. `live = 1` is the
 * fix for a real bug - the old headline numbers omitted it and quietly averaged shadow
 * trades into the production figure, while the kill switch used a live-only sum, so the
 * two disagreed. The excluded exit reasons are bookkeeping closes, not trades.
 */
/**
 * Does this positions table have the book column yet.
 *
 * The live database gets it from the Telemetry migration at boot, but this module also reads
 * databases nothing migrated: scripts/dashboard-preview.ts opens a captured bot.db READ-ONLY,
 * and so does anything pointed at an archived snapshot. Referencing the column unconditionally
 * turned the whole page into a 500 there. Cached per handle, because it cannot change under a
 * live process without a restart, and a PRAGMA per snapshot at 1 Hz is not free.
 */
const bookColumn = new WeakMap<Database.Database, boolean>()
function hasBookColumn(db: Database.Database): boolean {
  const known = bookColumn.get(db)
  if (known !== undefined) return known
  let has = false
  try { has = (db.pragma('table_info(positions)') as Array<{ name: string }>).some((c) => c.name === 'book') } catch { has = false }
  bookColumn.set(db, has)
  return has
}

/**
 * What an UNSTAMPED row (book NULL, or no column at all) belongs to.
 *
 * With ONE book configured, it belongs to that book. There is only one book, so "which book
 * traded this" has one answer, and the per-book table then equals the wallet table, which is
 * what an operator running a single book should see.
 *
 * With TWO OR MORE, it belongs to NEITHER, and this returns null. Guessing from the band
 * would re-attribute history: it would claim a book traded rows opened before that book
 * existed, under a stake, a take-profit schedule and an exit rule that were not its own. The
 * plan rules that out for the charts and it is no more acceptable in a KPI table. Books start
 * their accounting at the cutover; the count of rows that predate it is reported, not hidden.
 */
export function unstampedBook(books: readonly { id: string }[]): string | null {
  return books.length === 1 ? books[0]!.id : null
}

function tradeRows(db: Database.Database, sinceMs: number, book0: string | null = 'main'): TradeRow[] {
  // A table without the column is a table written before books existed, so no row in it is
  // stamped. The bound value says what that means, rather than a COALESCE on a missing column.
  const bookExpr = hasBookColumn(db) ? 'COALESCE(book, ?)' : '?'
  return db.prepare(
    `SELECT exit_at, CAST(spend_wei AS REAL) spend,
            CAST(COALESCE(onchain_pnl_wei, pnl_wei) AS REAL) pnl,
            exit_reason, (onchain_pnl_wei IS NOT NULL) verified,
            ${bookExpr} book
     FROM positions
     WHERE live = 1 AND closed = 1 AND exit_at >= ?
       AND exit_reason NOT IN (${NON_TRADE_SQL})
     ORDER BY exit_at ASC`,
  ).all(book0, sinceMs) as TradeRow[]
}

/**
 * One book's closed trades, summarised with the spread rather than a bare mean.
 *
 * ROT is quoted twice because the two answer different questions and the house rule is that
 * neither travels alone. `rotPct` is portfolio level (sum pnl / sum spend), what the book
 * earned per dollar risked. `medianRotPct` with `sdRotPct` and `n` beside it is per trade:
 * a +4% portfolio return carried by one +45% winner among a crowd of -13% losers is a
 * different business from an even drizzle, and the book comparison is exactly where that
 * distinction decides something.
 */
export function bookSummary(rows: TradeRow[], ethUsd: number): {
  n: number; pnlEth: number; pnlUsd: number; spendEth: number
  rotPct: number | null; medianRotPct: number | null; sdRotPct: number | null; winRate: number | null
} {
  const pnl = rows.reduce((a, r) => a + r.pnl, 0)
  const spend = rows.reduce((a, r) => a + r.spend, 0)
  const rots = rows.filter((r) => r.spend > 0).map((r) => (r.pnl / r.spend) * 100)
  return {
    n: rows.length,
    pnlEth: pnl / 1e18,
    pnlUsd: (pnl / 1e18) * ethUsd,
    spendEth: spend / 1e18,
    rotPct: spend > 0 ? (pnl / spend) * 100 : null,
    medianRotPct: median(rots),
    sdRotPct: sampleSd(rots),
    winRate: rows.length ? (100 * rows.filter((r) => r.pnl > 0).length) / rows.length : null,
  }
}

/**
 * The POST-BAND reject funnel, per book, with its own denominator.
 *
 * Wallet-level `rejects` (the in-memory counters) cannot be split and must not be: most of
 * its buckets (`non-eth`, `no`, `dev`, `creator`, `repeat`) fire at the book SCREEN, before
 * any band is consulted, so those launches belong to no book at all. Only what happens after
 * the screen is a book's own business, and that is what this returns.
 *
 * Attribution is by band, not by a stored column, until phase 4 stamps `launches.book` at
 * detection. The consequence is stated rather than hidden: edit a band and this funnel
 * re-attributes its own history. That is tolerable for a "last 24h" funnel and is NOT
 * tolerable for the trade charts, which is why those wait for the column instead.
 */
export function bookRejectFunnel(
  db: Database.Database, books: readonly { id: string; minTaxBps: number; maxTaxBps: number }[],
  from: number, to: number,
): Map<string, { buckets: Record<string, number>; n: number; entered: number; basis: string }> {
  const out = new Map(books.map((b) => [b.id, { buckets: {} as Record<string, number>, n: 0, entered: 0, basis: 'band' }]))
  let rows: Array<{ tax: number | null; r: string | null; n: number }> = []
  try {
    rows = db.prepare(
      `SELECT creator_tax_bps tax, entry_reject r, COUNT(*) n FROM launches
       WHERE passed = 1 AND detected_at >= ? AND detected_at <= ? GROUP BY tax, r`,
    ).all(from, to) as any[]
  } catch { return out }
  for (const row of rows) {
    // A tax that could not be read arrives as null or -1 and belongs to NO book. A book with
    // a floor of 0 must not inherit every launch whose tax the RPC refused to answer for.
    if (row.tax == null) continue
    const b = routeBook(BigInt(row.tax), books)
    if (!b) continue
    const slot = out.get(b.id)!
    slot.n += row.n
    if (row.r == null) { slot.entered += row.n; continue }
    // First word only. bumpReject's first word IS the bucket and the rest is the detail;
    // splitting on anything else shatters ten buckets into hundreds.
    const bucket = String(row.r).split(' ')[0] || 'other'
    slot.buckets[bucket] = (slot.buckets[bucket] ?? 0) + row.n
  }
  return out
}

/**
 * Is the A-vs-B difference worth printing yet, and the difference itself.
 *
 * The gate lives HERE, on the server, and not in page JavaScript, for one reason: the report
 * skill reads this payload too. A gate in the page would let `report` print a delta the
 * dashboard is greying out, which is the worst of both, a confident number nobody vetted.
 *
 * 30 closed trades each side. At seven trades a side the difference between the books is
 * noise, and a number on a dashboard gets acted on whether or not it deserves to be.
 */
export const DELTA_MIN_N = 30
export function bookDelta(
  blocks: ReadonlyArray<{ id: string; trades: { n: number; rotPct: number | null; medianRotPct: number | null; winRate: number | null } }>,
): Record<string, unknown> {
  const minN = DELTA_MIN_N
  if (blocks.length < 2) return { ready: false, minN, a: blocks[0]?.id ?? null, b: null, why: 'one book configured' }
  const [a, b] = [blocks[0]!, blocks[1]!]
  const short = [a, b].filter((x) => x.trades.n < minN)
  const base = { minN, a: a.id, b: b.id, nA: a.trades.n, nB: b.trades.n }
  if (short.length) {
    return { ...base, ready: false, why: short.map((x) => `${x.id} has ${x.trades.n} of ${minN} closed trades`).join(', ') }
  }
  const sub = (x: number | null | undefined, y: number | null | undefined) => (x == null || y == null ? null : x - y)
  return {
    ...base, ready: true, why: null,
    rotPct: sub(a.trades.rotPct, b.trades.rotPct),
    medianRotPct: sub(a.trades.medianRotPct, b.trades.medianRotPct),
    winRate: sub(a.trades.winRate, b.trades.winRate),
  }
}

export type Alert = { id: string; sev: 'crit' | 'warn'; msg: string }

/**
 * What is wrong right now, in the order it costs money.
 *
 * The point of this list is the things the old page could not say at all. It showed 31
 * feed disconnects and 2,376 unhealthy log ticks in a day without ever mentioning them,
 * and it had no way to express "the bot has quietly stopped trading" - which looks
 * identical to a calm market on every other panel.
 */
export function buildAlerts(a: {
  halted: boolean; haltReason: string; haltKind: HaltKind | null
  /**
   * Does EVERY active halt lift itself, and when does the last one go? Derived once in
   * RiskManager.resumeOutlook rather than re-tested here: this used to be an inline
   * `haltKind === 'gate'`, which prints "needs you" for a daily cap that lifts on its own
   * at midnight, and there were three copies of the test.
   */
  autoResumes: boolean; resumesWhen: string | null
  feedConnected: boolean; feedAgeMs: number
  logsHealthy: boolean; logsAgeMs: number; logsStaleLimit: number
  /** ETH, because that is the unit the stop compares (risk.ts checkDrawdown) */
  drawdownEth: number; drawdownLimitEth: number
  /** display only, for the alert text; never the comparison */
  ethUsd: number
  gateState: 'open' | 'shut' | null; gateRate: number | null; gateHeartbeatMs: number | null
  gateDataAgeMs: number | null
  minsSinceTrade: number | null | undefined; upMs: number
  rot1h: number | null; n1h: number
  stuck: number; exitFailures: number
  /**
   * Bags the curve graduated under, CLOSED in the last 24h (bot.strand / recovery.ts), as
   * opposed to `stuck`, which is still retrying and may yet succeed. Split out on
   * 2026-08-26: one graduated bag generated 1,092 identical failures and, next to a
   * genuinely stuck position, read as the same alert. Since 2026-09-06 a stranded bag is
   * booked at minus the stake and forgotten rather than parked open, so this counts recent
   * closes: the line fires once, gets pushed, and ages out.
   */
  stranded: number
  /**
   * Positions parked in memory (wallet holds no tokens, or STRATEGY.maxSellAttempts
   * reverts in a row). Still holding, not retrying; a restart is the retry. Optional so an
   * older caller shape renders as zero rather than throwing.
   */
  parked?: number
  /** forced nonce resyncs in the trailing hour (tx/nonce.ts): the counter was wrong */
  nonceResyncs1h?: number
  /** failed log polls in the trailing hour; 183-612/h was the 2026-09-05 daytime baseline */
  pollFailures1h?: number
  /** launch -> detection lag over the trailing hour: median ms and how many launches */
  detectLagP50?: number | null; detectLagN?: number
  /**
   * The price model against the chain: real sale proceeds / the model's own estimate at
   * the moment the sell fired, median over the last hour of exits, and how many. 1.00 is a
   * correct model (p10 0.986 / p50 1.000 / p90 1.255 over 2026-09-03..05). On 2026-09-06
   * it read 1.28 for an afternoon while take profit fired on 2 of 46 trades: the block
   * attached to the curve read was the parent chain's, and the model double-counted the
   * coin's first blocks. A model this far off mis-fires every exit rule and no other
   * number on this page says so.
   */
  markErrP50?: number | null; markErrN?: number
  /** book-vs-chain disagreements in the trailing hour (state/engine.ts bookChecks) */
  bookDrift1h?: number
  /**
   * THE VENUE PAUSE (strategy/gate.ts readVenue): what the bot's exit rule would have made
   * on the trailing window of launches it was not holding, in stakes, and how many carried
   * the bar. `venueFresh` false means the window did not fit inside the freshness limit, so
   * there is no measurement -- reported, never alerted on, because a thin night is not a
   * bad venue.
   */
  venueSum?: number | null; venueN?: number; venueFresh?: boolean
  /**
   * THE BOT-BROKEN CHECK (strategy/broken.ts): our own return per trade minus what the
   * same coins replayed at, in points, over the last completed window. Negative means we
   * came in under the venue. It halts at BROKEN_GAP_PP; this warns on the way there,
   * because a drift that has not reached the halt is the cheapest moment to find the bug.
   */
  brokenGapPp?: number | null; brokenN?: number; brokenLimitPp?: number
  /** the provider key's projected monthly spend in compute units, socket plus reads; null before either has run */
  cuPerMonth?: number | null
  /** worst event-loop lag in the trailing minute, ms; the process choking, not the chain */
  loopLagMaxMs?: number
  resources?: ResourceReading | null
  /**
   * scripts/edgecheck.py's last run. `edgeAgeMs` null means it has NEVER run on this
   * box; undefined means the caller did not ask (tests, older snapshots), which is not
   * an alert. `edgeVerdicts` are the rules and whether each still pays.
   */
  edgeAgeMs?: number | null; edgeVerdicts?: EdgeVerdict[] | null; edgeMainStreak?: number
  /** buys that failed, and attempts, over the trailing window. Rate is the signal. */
  buyFails: number; buyAttempts: number
  /** how many of those failures burned the whole gas limit. Any is a config bug. */
  buyOutOfGas: number
  /** worst successful buy as a fraction of GAS.limits.buy, or null with no data */
  buyGasHeadroom: number | null
  /** why the config file was refused, if it was. Empty means the file and the process agree. */
  configErrors?: string[]
  /** settings edited in the file that this process cannot pick up without a restart */
  configPendingRestart?: string[]
}): Alert[] {
  const out: Alert[] = []
  // Overnight the only question that matters about a halt is whether it will lift itself.
  // A gate halt does, the moment the venue reads open again (GATE_RESUME_MS is 0 since
  // scoring moved in-process); the other two sit there until someone acts, so they are the
  // ones worth waking up for.
  if (a.halted) {
    const lifts = a.autoResumes
      ? `will resume by itself ${a.resumesWhen ?? ''}`.trimEnd()
      : 'needs you: this kind never auto-resumes'
    out.push({ id: 'halted', sev: 'crit', msg: `HALTED: ${a.haltReason} (${lifts})` })
  }
  if (!a.feedConnected) out.push({ id: 'feed', sev: 'crit', msg: 'sequencer feed disconnected' })
  else if (a.feedAgeMs > 30_000) out.push({ id: 'feed', sev: 'crit', msg: `feed silent ${(a.feedAgeMs / 1000).toFixed(0)}s` })
  if (!a.logsHealthy) out.push({ id: 'logs', sev: 'crit', msg: `authoritative logs unhealthy ${(a.logsAgeMs / 1000).toFixed(0)}s` })
  // healthy but stale is its own failure: canEnter rejects every launch with 'logs stale'
  // (strategy/risk.ts) while nothing on the page said so, and the bot just stopped buying
  else if (a.logsAgeMs > a.logsStaleLimit) {
    out.push({ id: 'logs', sev: 'crit', msg: `logs stale ${(a.logsAgeMs / 1000).toFixed(1)}s, entries are being rejected` })
  }

  // Measured in ETH against the ETH bound, so this cannot disagree with the stop the way
  // it did while both sides were converted through a stale price. The dollars are printed
  // for the reader and computed from the same number.
  // Finite guards for the same reason every other block here has them: this function is
  // also called with partial payloads by tests and by a box mid-deploy, and an alert that
  // throws takes the whole banner down, including the alerts that needed to be read.
  const ddEth = Number.isFinite(a.drawdownEth) ? a.drawdownEth : 0
  const ddLimitEth = Number.isFinite(a.drawdownLimitEth) ? a.drawdownLimitEth : 0
  const ddPct = ddLimitEth > 0 ? (100 * ddEth) / ddLimitEth : 0
  if (ddPct >= LEVELS.ddWarnPct) {
    const dollars = Number.isFinite(a.ethUsd) ? ` ($${(ddEth * a.ethUsd).toFixed(0)})` : ''
    const msg = `drawdown ${ddEth.toFixed(4)} ETH${dollars} is ${ddPct.toFixed(0)}% of the kill switch`
    out.push({ id: 'dd', sev: ddPct >= LEVELS.ddCritPct ? 'crit' : 'warn', msg })
  }

  if (a.gateState === 'shut') out.push({ id: 'gate', sev: 'crit', msg: `regime gate SHUT at ${a.gateRate?.toFixed(1) ?? '?'}%` })
  // the watcher halts the bot when it goes stale, so warn well before that fires
  if (a.gateHeartbeatMs === null) out.push({ id: 'gatewatch', sev: 'warn', msg: 'gatewatch has never heartbeated' })
  else if (a.gateHeartbeatMs > 15 * 60_000) {
    const mins = a.gateHeartbeatMs / 60_000
    out.push({ id: 'gatewatch', sev: mins > 30 ? 'crit' : 'warn', msg: `gatewatch last ran ${mins.toFixed(0)} min ago (halts at 30)` })
  }
  // A LIVE watcher with STALE DATA. Distinct from the heartbeat above and invisible until
  // now: gatewatch scores only launches that passed the book, so when nothing passes it
  // heartbeats happily while the rate it publishes ages without bound. The bot then holds
  // entries open on a verdict measured hours ago. Reported, not acted on: halting on a dry
  // spell would stop trading every night through the 03:00-06:00 trough, which is not what
  // "the venue is bad" means.
  if (a.gateDataAgeMs !== null && a.gateDataAgeMs > 60 * 60_000) {
    const h = a.gateDataAgeMs / 3600_000
    out.push({
      id: 'gatestale',
      sev: h > 3 ? 'crit' : 'warn',
      msg: `regime gate rate is ${h.toFixed(1)}h old (no launch has passed the book since)`,
    })
  }

  // A bot that has silently stopped entering looks like a quiet market everywhere else.
  // minsSinceTrade is null when the 24h pull came back empty, which is not "no data", it
  // is the worst case of this exact alert; it used to fall through the null guard and go
  // quiet after 24h. upMs separates it from a fresh boot that has not traded yet.
  //
  // The suppressors are the halts, and nothing else. Two used to sit here that no longer
  // exist: a closed entry window (deleted 2026-09-07, the bot trades 24 hours) and a shut
  // touch gate. `halted` covers every reason entries are legitimately off, including the
  // venue pause, so a paused bot is reported as paused by the `halted` alert rather than
  // twice, once correctly and once as "silent".
  if (!a.halted && a.upMs > LEVELS.bootGraceMs && a.minsSinceTrade !== undefined) {
    if (a.minsSinceTrade === null) {
      out.push({ id: 'idle', sev: 'crit', msg: 'no closed trade in over 24h, and entries are not halted' })
    } else if (a.minsSinceTrade > LEVELS.idleWarnMins) {
      out.push({ id: 'idle', sev: 'warn', msg: `no closed trade in ${a.minsSinceTrade.toFixed(0)} min, and entries are not halted` })
    }
  }
  // n>=10 so a couple of bad trades cannot trip it; below that the rate is noise
  if (a.n1h >= 10 && a.rot1h !== null && a.rot1h < -5) {
    out.push({ id: 'rot', sev: 'warn', msg: `1h return on turnover ${a.rot1h.toFixed(1)}% over ${a.n1h} trades` })
  }
  if (a.stuck > 0) out.push({ id: 'stuck', sev: 'crit', msg: `${a.stuck} position(s) stuck, still holding` })
  if (a.stranded > 0) {
    out.push({ id: 'stranded', sev: 'crit',
      msg: `${a.stranded} bag(s) STRANDED on graduation in the last 24h, booked at -stake; the DEX side is worth ~5% and is not chased` })
  }
  // The config file and the running process disagree. Crit, because until now the failure
  // was silent in both directions: a refused file left the old numbers running with nothing
  // saying so, and a restart-only edit looked applied to anyone reading the file.
  if (a.configErrors?.length) {
    out.push({ id: 'config', sev: 'crit',
      msg: `config file REFUSED, still running the previous values: ${a.configErrors.join('; ')}` })
  }
  if (a.configPendingRestart?.length) {
    out.push({ id: 'config-restart', sev: 'warn',
      msg: `${a.configPendingRestart.join(', ')} edited in the file but captured at startup; restart when flat to take it` })
  }
  if ((a.parked ?? 0) > 0) {
    out.push({ id: 'parked', sev: 'crit',
      msg: `${a.parked} position(s) parked (no tokens, or sell attempts exhausted), still holding; a restart is the retry` })
  }
  if (a.exitFailures > 0) out.push({ id: 'exit', sev: 'warn', msg: `${a.exitFailures} exit failure(s) in the last 24h` })

  // The plumbing that failed silently on 2026-09-05. Thirteen buys went to a dead nonce
  // over 25 minutes and nothing said so; the repair (a forced resync) is itself the
  // signal that the counter was wrong, so it gets a line even when it worked.
  const resyncs = a.nonceResyncs1h ?? 0
  if (resyncs >= 3) out.push({ id: 'nonce', sev: 'crit', msg: `${resyncs} forced nonce resyncs in the last hour: sends are being rejected` })
  else if (resyncs >= 1) out.push({ id: 'nonce', sev: 'warn', msg: `${resyncs} forced nonce resync in the last hour (the counter was wrong; repaired)` })
  // Rate limiting from the public RPC. 12,786 failed polls in the 24h to 2026-09-06 with
  // the evening peaking at 1,619/h; each one used to flip the stream unhealthy and reject
  // entries. Now three in a row do, but a rising count is still the RPC saying no.
  const pf = a.pollFailures1h ?? 0
  if (pf > 1000) out.push({ id: 'pollfail', sev: 'crit', msg: `${pf} failed log polls in the last hour: the RPC is rate-limiting us hard` })
  else if (pf > 600) out.push({ id: 'pollfail', sev: 'warn', msg: `${pf} failed log polls in the last hour (rate limiting)` })
  // Detection lag, the number that on 2026-08-27 turned a 65% gate into a $134 loss: the
  // move is over by 5s, so a launch seen at 7s is bought at the top. p50 ~1.5s is the
  // polling baseline; 3s means the poller is being starved.
  // The venue pause, reported as its own line: 'halted' already says the bot is off, but
  // not which sensor did it, and this one halts on a number nothing else on the page shows.
  if (
    a.venueSum != null && Number.isFinite(a.venueSum) && a.venueFresh
    && (a.venueN ?? 0) > 0 && a.venueSum < -1
  ) {
    out.push({
      id: 'venue',
      sev: 'warn',
      msg: `venue sensor ${a.venueSum.toFixed(2)} stakes over ${a.venueN} scored launches`,
    })
  }
  // Us against the venue. A halt is placed at the limit; this fires at two thirds of it,
  // which on 2026-09-06 would have been the first warning that the book was mispricing,
  // about twenty minutes into it.
  if (
    a.brokenGapPp != null && Number.isFinite(a.brokenGapPp)
    && (a.brokenN ?? 0) >= 20 && (a.brokenLimitPp ?? 0) > 0
  ) {
    const limit = a.brokenLimitPp!
    const gap = a.brokenGapPp
    if (gap <= -limit) {
      out.push({ id: 'broken', sev: 'crit', msg: `THE BOT, NOT THE VENUE: our last ${a.brokenN} trades came in ${(-gap).toFixed(1)} points a trade below what the same coins replayed at` })
    } else if (gap <= -(limit * 2) / 3) {
      out.push({ id: 'broken', sev: 'warn', msg: `our last ${a.brokenN} trades are ${(-gap).toFixed(1)} points a trade below their own replay (halts at ${limit.toFixed(0)})` })
    }
  }
  if (a.markErrP50 != null && (a.markErrN ?? 0) >= 10 && Number.isFinite(a.markErrP50)) {
    const off = Math.abs(a.markErrP50 - 1)
    if (off >= 0.20) out.push({ id: 'model', sev: 'crit', msg: `price model off: real sale / model estimate p50 ${a.markErrP50.toFixed(2)} over ${a.markErrN} exits (should be ~1.00); every exit rule is firing on a wrong price` })
    else if (off >= 0.08) out.push({ id: 'model', sev: 'warn', msg: `price model drifting: real sale / model estimate p50 ${a.markErrP50.toFixed(2)} over ${a.markErrN} exits (should be ~1.00)` })
  }
  // The book the exit rules read, checked against the chain while the position is open. Any
  // disagreement at all is critical: it means trades are missing from the local book, which
  // is what mistimed every exit for six hours on 2026-09-06.
  const bookDrift = a.bookDrift1h ?? 0
  if (Number.isFinite(bookDrift) && bookDrift > 0) {
    out.push({ id: 'bookdrift', sev: 'crit', msg: `confirmed book disagreed with the chain ${bookDrift} time(s) in the last hour and was re-seeded; the engine or log delivery is dropping trades` })
  }
  if (a.detectLagP50 != null && (a.detectLagN ?? 0) >= 20 && a.detectLagP50 > 3_000) {
    out.push({ id: 'detectlag', sev: 'warn', msg: `launch -> detection p50 ${(a.detectLagP50 / 1000).toFixed(1)}s over ${a.detectLagN} launches (baseline ~1.5s)` })
  }
  // The websocket key is a free tier: 30M compute units a month, billed per byte pushed.
  // The launch stream alone can reach that, so the bot projects its own burn and says so
  // before the provider cuts it off mid-window.
  if (typeof a.loopLagMaxMs === 'number' && Number.isFinite(a.loopLagMaxMs)) {
    if (a.loopLagMaxMs >= 2_000) out.push({ id: 'lag', sev: 'crit', msg: `event loop stalled ${(a.loopLagMaxMs / 1000).toFixed(1)}s in the last minute: the process is choking` })
    else if (a.loopLagMaxMs >= 500) out.push({ id: 'lag', sev: 'warn', msg: `event loop lagged ${a.loopLagMaxMs}ms in the last minute` })
  }
  // Disk and memory. The 2026-09-13 starvation showed up in both an hour before it showed
  // up in anything the bot measured about itself.
  out.push(...resourceAlerts(a.resources))
  if (typeof a.cuPerMonth === 'number' && Number.isFinite(a.cuPerMonth)) {
    const m = a.cuPerMonth / 1e6
    // The projection never moves the reads (bot.readVia); only a provider that actually
    // refuses does. So this line is a forecast of the bill, and says so. It once claimed
    // "reads have fallen back" at 29.8M pace with 1% of the month spent.
    const reads = 'reads stay on the key; the bot falls back only when the provider refuses'
    if (m > 30) out.push({ id: 'quota', sev: 'crit', msg: `provider key on pace for ${m.toFixed(0)}M compute units a month: over the 30M free tier; ${reads}` })
    else if (m > 27.5) out.push({ id: 'quota', sev: 'warn', msg: `provider key on pace for ${m.toFixed(0)}M compute units a month (30M free tier); ${reads}` })
  }
  // The edge check (scripts/edgecheck.py, daily 11:30 UTC). A rule that stopped paying is
  // the one thing nothing in this process could say before 2026-09-06: two rules had
  // already flipped once each and were found by hand, days later.
  if (a.edgeAgeMs === null) {
    out.push({ id: 'edgestale', sev: 'warn', msg: 'the daily edge check has never run on this box' })
  } else if (typeof a.edgeAgeMs === 'number' && a.edgeAgeMs > 36 * 3600_000) {
    out.push({ id: 'edgestale', sev: 'warn', msg: `the daily edge check last ran ${(a.edgeAgeMs / 3600_000).toFixed(0)}h ago` })
  }
  for (const v of a.edgeVerdicts ?? []) {
    if (v.ok) continue
    const crit = v.rule === 'main-book' && (a.edgeMainStreak ?? 0) >= 3
    out.push({ id: `edge-${v.rule}`, sev: crit ? 'crit' : 'warn', msg: `${v.rule} is not paying: ${v.why}${crit ? ` (${a.edgeMainStreak} daily runs in a row)` : ''}` })
  }

  // BUYS. There was no alert of any kind here until 2026-08-19, which is why a buy failure
  // rate of 2% -> 37.5% (p=5.6e-10) ran for four hours and was found by reading receipts by
  // hand. Every other panel looked calm, because a buy that never fills is invisible in
  // return-on-turnover: it is simply a trade that does not appear.
  //
  // Out of gas gets its own line ahead of the rate. A lost race is friction we priced; a
  // buy that burned the whole ceiling is a config bug that no amount of retrying fixes, and
  // averaging it into a percentage is how it stayed hidden.
  if (a.buyOutOfGas > 0) {
    out.push({
      id: 'buy-oog', sev: 'crit',
      msg: `${a.buyOutOfGas} buy(s) OUT OF GAS at the ${GAS.limits.buy} limit: raise GAS.limits.buy, retries cannot fix this`,
    })
  }
  // n>=10 for the same reason as rot1h: below that a single failure is 10pp of "rate"
  if (a.buyAttempts >= 10) {
    const pct = (100 * a.buyFails) / a.buyAttempts
    // 2% is the measured healthy baseline over 297 attempts, so 10% is already a signal
    if (pct > 25) {
      out.push({ id: 'buy', sev: 'crit', msg: `${pct.toFixed(0)}% of the last ${a.buyAttempts} buys failed (${a.buyFails})` })
    } else if (pct > 10) {
      out.push({ id: 'buy', sev: 'warn', msg: `${pct.toFixed(0)}% of the last ${a.buyAttempts} buys failed (${a.buyFails})` })
    }
  }
  // The early warning, and the one that would have paid: successful buys climbed 99k -> 118k
  // as the book widened to admit taxed launches, and nothing said so until they hit 150k and
  // started failing. A limit is only loose until the population moves.
  if (a.buyGasHeadroom !== null && a.buyGasHeadroom > 0.7) {
    out.push({
      id: 'buy-gas', sev: 'warn',
      msg: `a filled buy used ${(a.buyGasHeadroom * 100).toFixed(0)}% of the ${GAS.limits.buy} gas limit`,
    })
  }
  return out
}

/** Cheap TTL memo so N open tabs polling every second cannot multiply the SQL. */
const memo = new Map<string, { at: number; v: unknown }>()
function cached<T>(key: string, ttlMs: number, make: () => T): T {
  const hit = memo.get(key)
  const now = Date.now()
  if (hit && now - hit.at < ttlMs) return hit.v as T
  const v = make()
  memo.set(key, { at: now, v })
  return v
}

/**
 * The SERIALIZED, compressed body, memoized beside the object.
 *
 * A warm hit used to still pay a full JSON.stringify of the whole payload on every request,
 * on the trading process's event loop, and then write it uncompressed: 677 KB at 7d over the
 * tailnet, measured at 3.0 s. The same bytes gzip to 93 KB. Serialize and compress once per
 * TTL, then a warm hit is a socket write.
 *
 * Both forms are kept because a client that did not ask for gzip still has to be served.
 */
type Body = { raw: Buffer; gz: Buffer | null }
const bodies = new Map<string, { at: number; body: Body; ttl: number }>()
/**
 * Entries are swept on write, not just overwritten.
 *
 * Without this the map only ever grows: every distinct key holds its raw AND its gzipped
 * buffer, up to ~93 KB gzipped each, resident in the trading process for the life of the
 * process. Six keys was survivable; keying by lookback AND book makes it eighteen, and the
 * same unbounded-growth class already bit us once through the unvalidated `h` parameter
 * below. A miss sweeps anything older than 10x its own TTL, which is far past useful.
 */
function cachedBody(key: string, ttlMs: number, make: () => unknown): Body {
  const hit = bodies.get(key)
  const now = Date.now()
  if (hit && now - hit.at < ttlMs) return hit.body
  for (const [k, e] of bodies) if (now - e.at > e.ttl * 10) bodies.delete(k)
  const raw = Buffer.from(JSON.stringify(make()) ?? 'null', 'utf8')
  // Level 6 is the default and the right trade here: level 9 costs about 3x the CPU on this
  // payload for under 2% more compression, and this runs next to the trading loop.
  let gz: Buffer | null = null
  try { gz = raw.length >= 1024 ? gzipSync(raw) : null } catch { gz = null }
  const body = { raw, gz }
  bodies.set(key, { at: now, body, ttl: ttlMs })
  return body
}

/**
 * Drop the /api/state caches. BOTH of them, which is the entire reason this is a named
 * function rather than two lines at the call site.
 *
 * `memo` holds the snapshot object and `bodies` holds the bytes written to the socket. A
 * control that clears only the first leaves the previous, pre-STOP body being served for up
 * to a full TTL, so the operator presses the button and the page tells them nothing
 * happened. That is precisely the failure the controls were built to rule out, and it is
 * invisible in every test that reads `snapshot()` directly instead of the HTTP body.
 */
export function invalidateState(): void {
  memo.delete('state')
  bodies.delete('state')
}

/** Test seam: the cache primitives, so eviction and invalidation are checkable without a Bot. */
export const __caches = { cachedBody, invalidateState, size: () => bodies.size, clear: () => bodies.clear() }

/**
 * The recent-exits block: one query, one mapping, one place.
 *
 * Exported because the local preview harness (.serve.mts) needs the identical shape and
 * had grown its own copy of both. The copy drifted the first time this changed, which is
 * exactly the failure a duplicated query invites.
 */
/**
 * The reading the BOT is actually gating on.
 *
 * Since 2026-08-19 the bot scores the cohort in process off the live feed and applies the
 * hysteresis there; gate.db is now its fallback and its startup seed, not its source of
 * truth. This page replayed gate.db independently, which was right up until that change
 * and is now a second opinion that can lag the real verdict by a poll or disagree with it
 * outright. A gate card that contradicts the thing halting trades is worse than no card.
 *
 * So the bot publishes what it decided and we render that. The replay stays as the
 * fallback for a key that is missing (older bot) or gone stale (a bot that stopped
 * evaluating), because those are exactly the cases where a confident number is a lie.
 */
type LiveGate = {
  state: 'open' | 'shut'
  rate: number
  n: number
  dataAgeMs: number | null
  source: 'live' | 'file'
  liveN: number
  at: number
  /**
   * The bot's reason string when it halted on a DEAD WATCHER rather than on the venue.
   *
   * Optional because a bot older than this key simply omits it. Dropping it (this branch
   * used to hardcode stale: null) rendered a stopped systemd job as an ordinary venue
   * shut, at whatever rate was frozen in obs when it died, and sent whoever was on call
   * after the venue instead of after the watcher.
   */
  stale?: string | null
}

/**
 * The part of the card that comes from the bot's own reading, as a pure function so the
 * stale contract can be tested without a database.
 *
 * `stale` stays the boolean the card renders; `staleReason` carries the bot's words. The
 * two are separate because they answer different questions: "is this reading trustworthy"
 * drives the colour, "why not" is what tells an operator where to go.
 */
export function gateSnapshotFrom(live: LiveGate): {
  state: 'open' | 'shut'
  stale: boolean
  staleReason: string | null
  rate: number
  n: number
  dataAgeMs: number | null
  source: 'live' | 'file'
  liveN: number
} {
  return {
    state: live.state,
    stale: live.stale != null,
    staleReason: live.stale ?? null,
    rate: live.rate,
    n: live.n,
    dataAgeMs: live.dataAgeMs,
    source: live.source,
    liveN: live.liveN,
  }
}

/** the bot re-publishes on every evaluation (~30s), so two minutes is six missed writes */
const LIVE_GATE_STALE_MS = 2 * 60_000

function liveGate(db: Database.Database, now: number): (LiveGate & { ageMs: number }) | null {
  try {
    const raw = truthGetDb(db, 'gate_live_json')
    if (!raw) return null
    const g = JSON.parse(raw) as LiveGate
    if (g.state !== 'open' && g.state !== 'shut') return null
    const ageMs = now - Number(g.at)
    if (!Number.isFinite(ageMs) || ageMs > LIVE_GATE_STALE_MS) return null
    return { ...g, ageMs }
  } catch {
    return null
  }
}

export function recentExits(db: Database.Database, epochBase = 0, book0: string | null = 'main'): Record<string, unknown>[] {
  const rows = db.prepare(
    `SELECT p.token, p.exit_reason, p.hold_ms, p.exit_at, ${hasBookColumn(db) ? 'COALESCE(p.book, ?)' : '?'} book,
            CAST(COALESCE(p.onchain_pnl_wei, p.pnl_wei) AS REAL) pnl,
            p.peak_mult, (p.onchain_pnl_wei IS NOT NULL) verified,
            CAST(p.spend_wei AS REAL) spend, CAST(p.proceeds_wei AS REAL) proceeds,
            CAST(p.expected_wei AS REAL) expected, CAST(p.entry_mark_wei AS REAL) entry_mark,
            CAST(p.tokens_held AS REAL) tokens, CAST(p.min_tokens_out AS REAL) min_tokens,
            CAST(p.gas_wei AS REAL) gas, CAST(p.pnl_wei AS REAL) modeled_pnl, p.take_profit,
            p.entry_block, p.fill_block, p.t_detect, p.t_decide, p.t_sent,
            p.buy_hash, p.exit_hash, p.curve,
            l.name, l.symbol, CAST(l.dev_buy_wei AS REAL) dev_buy, l.exemptions,
            l.creator_tax_bps, l.prior_launches, l.has_twitter, l.has_website
     FROM positions p LEFT JOIN launches l ON l.token = p.token
     WHERE p.closed = 1 AND p.live = 1 AND p.id > ${epochBase}
     ORDER BY p.id DESC LIMIT 24`,
  ).all(book0) as any[]
  const peaks = truePeaks(rows.map((r) => r.token as string))
  // Picked explicitly rather than spread. The query selects ~15 raw columns purely as
  // inputs to the derived fields below, and spreading shipped every one of them: 13 KB
  // of wei strings and block numbers per poll that nothing on the page ever reads,
  // re-serialised once a second inside the trading process.
  return rows.map((r: any) => ({
    token: r.token,
    symbol: r.symbol,
    name: r.name,
    // One field per row rather than a per-book copy of the whole array; see the note on the
    // open-positions map. NULL while more than one book is configured, which is the truth:
    // the row predates the split and belongs to neither book. See unstampedBook.
    book: r.book ?? null,
    exit_reason: r.exit_reason,
    // when the position closed, epoch ms; the page's Time column
    exitAt: r.exit_at ?? null,
    // the take-profit rung this position was opened on. Since 2026-08-19 the take profit
    // is a schedule over the venue's trailing gate rate, so the book holds several at once
    // and a 1.26x exit is a banked win on one rung and a missed clock exit on another.
    // Null for anything opened before the column existed.
    takeProfit: r.take_profit ?? null,
    hold_ms: r.hold_ms,
    peak_mult: r.peak_mult,
    // the peak the coin actually reached in the gate's observation window (gate.holdMs,
    // not maxHoldMs), whenever we happened to sell
    truePeak: peaks.get(r.token) ?? null,
    verified: r.verified,
    spend: r.spend,
    proceeds: r.proceeds,
    tokens: r.tokens,
    exemptions: r.exemptions,
    creator_tax_bps: r.creator_tax_bps,
    prior_launches: r.prior_launches,
    has_twitter: r.has_twitter,
    has_website: r.has_website,
    pnl: r.pnl == null ? null : r.pnl / 1e18,
    // what we sold at, as a multiple of what we paid. null when a position closed
    // without proceeds (a revert), where a multiple would be a fiction.
    exitMult: r.spend > 0 && r.proceeds > 0 ? r.proceeds / r.spend : null,
    devBuyEth: r.dev_buy != null ? r.dev_buy / 1e18 : null,
    // What our own size did to the curve on the way in. This IS the depth measurement:
    // the mark right after filling, against what we paid. A shallow curve gives a big
    // negative number because we moved the price buying into it.
    entryImpact: r.spend > 0 && r.entry_mark > 0 ? r.entry_mark / r.spend - 1 : null,
    // did the fill beat the slippage floor we signed for
    fillVsFloor: r.min_tokens > 0 && r.tokens > 0 ? r.tokens / r.min_tokens - 1 : null,
    // did the sell land where the local model quoted it
    exitVsQuote: r.expected > 0 && r.proceeds > 0 ? r.proceeds / r.expected - 1 : null,
    fillLagBlocks: r.fill_block != null && r.entry_block != null ? r.fill_block - r.entry_block : null,
    decideToSentMs: r.t_sent != null && r.t_decide != null ? r.t_sent - r.t_decide : null,
    detectToDecideMs: r.t_decide != null && r.t_detect != null ? r.t_decide - r.t_detect : null,
    gasEth: r.gas != null ? r.gas / 1e18 : null,
    modeledPnl: r.modeled_pnl != null ? r.modeled_pnl / 1e18 : null,
    tokenUrl: tokenUrl(r.token),
    curveUrl: curveUrl(r.curve),
    buyUrl: r.buy_hash ? txUrl(r.buy_hash) : null,
    sellUrl: r.exit_hash ? txUrl(r.exit_hash) : null,
    tradeUrl: tradeUrl(r.token),
  }))
}

/**
 * The chain-truth balance rows with NET WORTH derived per sample: wallet + what the open
 * book cost. Both are real ETH, so the series never shows the fake dip a buy causes when
 * only the wallet is drawn. Rows written before deployed_wei existed fall back to
 * open_n x trade size, exact while the size is fixed. The one place this rule lives;
 * snapshot() and chartSnapshot() both draw from here.
 */
/**
 * The price every dollar on the page is computed with: the FETCHED one, falling back to
 * the configured seed.
 *
 * Not ethUsd directly, which is the seed. When the fetch first shipped, the page went
 * on rendering the seed and labelling it "coinbase" because the payload read the config
 * value: the number was stored in chain_truth and displayed nowhere. A display layer has to
 * read the display price.
 */
function displayPrice(bot: Bot): number {
  const p = typeof bot.priceReading === 'function' ? bot.priceReading() : null
  return p && Number.isFinite(p.usd) ? p.usd : RISK.ethUsd
}

function balanceRows(db: Database.Database, from?: number): any[] {
  const rows = (from == null
    ? db.prepare(`SELECT at, CAST(wei AS REAL) w, open_n, CAST(deployed_wei AS REAL) d FROM balance ORDER BY at ASC`).all()
    : db.prepare(`SELECT at, CAST(wei AS REAL) w, open_n, CAST(deployed_wei AS REAL) d FROM balance WHERE at >= ? ORDER BY at ASC`).all(from)) as any[]
  const fallbackDeployed = STRATEGY.tradeSizeEth * 1e18
  for (const r of rows) r.net = r.w + (r.d ?? r.open_n * fallbackDeployed)
  return rows
}

export function snapshot(bot: Bot): Record<string, unknown> {
  const ethUsd = displayPrice(bot)
  const now = Date.now()
  const m = bot.meters
  const upMs = now - m.startedAt
  const logsAge = bot.logs.lastHealthyAt ? now - bot.logs.lastHealthyAt : -1
  const lastEventAge = bot.logs.lastEventAt ? now - bot.logs.lastEventAt : -1
  const feedAge = bot.feed.lastBlockAt ? now - bot.feed.lastBlockAt : -1
  const v = bot.state.verdicts
  const rtt = bot.senderStats()
  // Read ONCE per snapshot and threaded through, not called per block: liveBooks() reads hot
  // config, and two reads inside one build could disagree if the operator saves mid-snapshot.
  const books = liveBooks()
  // What a row with no book stamp counts as. NOT simply books[0]: see unstampedBook.
  const book0 = unstampedBook(books)

  const positions = bot.openPositions().map((p) => {
    const mark = bot.liveMark(p.curve, p.tokens)
    const entry = p.entryMarkWei > 0n ? p.entryMarkWei : p.spendWei
    return {
      token: p.token,
      curve: p.curve,
      tokenUrl: tokenUrl(p.token),
      curveUrl: curveUrl(p.curve),
      ageMs: now - p.openedAt,
      capMs: p.rules.maxHoldMs,
      takeProfit: p.takeProfitMultiple,
      estimatedReturnEth: num(mark - p.spendWei),
      multiple: Number(mark) / Number(entry),
      peak: Number(p.peakMarkWei) / Number(entry),
      markEth: num(mark),
      spendEth: num(p.spendWei),
      filled: p.filled,
      supplyLeft: bot.state.progress(p.curve),
      // parked outranks stuck: it is the terminal answer to the same symptom. A graduated
      // curve is no longer a parked state: bot.strand() closes it (see 'stranded' below).
      state: p.parked ? 'parked' : p.stuck ? 'stuck' : p.sellInFlight ? 'selling' : p.exiting ? 'exiting' : !p.filled ? 'unconfirmed' : 'holding',
      // TAGGED, not nested. positions and recent are the two biggest arrays in the payload
      // (recent alone is 29 KB), so a books[i].positions would duplicate them; one field per
      // row costs ~430 bytes total and keeps the flat key a strict superset, which is what
      // dashboard.browser.mjs and the report skill read. Book 0 until phase 4 writes the
      // field at open, which is true rather than a placeholder: every open row predates books.
      book: (p as { book?: string }).book ?? book0,
    }
  })

  // Counted once. Both the alert inputs and the `discipline` block want these, and each
  // used to run its own `positions.filter(...)` -- four passes over the list per snapshot
  // to produce two numbers, which then had two chances to disagree if a state name changed.
  const stateCounts = positions.reduce(
    (a, p) => {
      if (p.state === 'stuck') a.stuck++
      else if (p.state === 'parked') a.parked++
      return a
    },
    { stuck: 0, parked: 0 },
  )

  const db = bot.tel.raw()
  // Every query added on 2026-09-06 reads a column that may not exist on an older
  // database or a test fixture, so each one degrades to zero rather than taking the page
  // (and, since the page shares the process, the bot) down with it.
  // cached 30s: a full scan of positions on every 1s snapshot, in the trading process,
  // for a number that changes a few times a day (review, 2026-09-06)
  const stranded24h = cached('stranded24h', 30_000, () => {
    try {
      return Number((db.prepare(
        `SELECT COUNT(*) n FROM positions WHERE live = 1 AND exit_reason = 'stranded-graduated' AND exit_at >= ?`,
      ).get(now - 86_400_000) as any)?.n ?? 0)
    } catch { return 0 }
  })
  // launch -> detection lag over the trailing hour. obs.launched_at is the curve's own
  // timestamp in seconds; detected_at is when we first saw the log, in ms. A negative
  // value is a clock skew artifact and is dropped. Cached for 30s: it is a scan of an
  // hour of launches, and the number cannot change faster than launches arrive.
  const detectLag = cached('detectLag', 30_000, () => {
    try {
      const lags = (db.prepare(
        `SELECT detected_at - launched_at * 1000 lag FROM launches
         WHERE passed = 1 AND detected_at >= ? AND launched_at > 0`,
      ).all(now - 3600_000) as any[])
        .map((r) => Number(r.lag)).filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b)
      if (!lags.length) return { n: 0, p50: null as number | null, p90: null as number | null }
      const q = (f: number) => lags[Math.min(lags.length - 1, Math.floor(f * lags.length))]!
      return { n: lags.length, p50: q(0.5), p90: q(0.9) }
    } catch { return { n: 0, p50: null as number | null, p90: null as number | null } }
  })
  // the price model against the chain over the last hour of sells (see AlertInputs.markErrP50)
  const markErr = cached('markErr', 30_000, () => {
    try {
      const ratios = (db.prepare(
        `SELECT CAST(proceeds_wei AS REAL) / CAST(expected_wei AS REAL) r FROM positions
         WHERE live = 1 AND closed = 1 AND buy_ok = 1 AND exit_at >= ? AND exit_hash IS NOT NULL
           AND CAST(expected_wei AS REAL) > 0 AND CAST(proceeds_wei AS REAL) > 0`,
      ).all(now - 3600_000) as any[]).map((x) => Number(x.r)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
      if (!ratios.length) return { n: 0, p50: null as number | null }
      return { n: ratios.length, p50: ratios[Math.floor(ratios.length / 2)]! }
    } catch { return { n: 0, p50: null as number | null } }
  })
  // truth for the current epoch: receipt-backfilled pnl where available, the bot's
  // own booking as a fallback until the backfill worker catches up
  const epochBase = Number(bot.truth?.epochBaseId ?? 0)
  // `live = 1` added 2026-08-18: without it this averaged shadow trades into the number
  // an operator reads as production, while the kill switch summed live rows only. Two
  // numbers on one page that disagreed about what a trade is.
  const closed = db.prepare(
    `SELECT COALESCE(SUM(CAST(COALESCE(onchain_pnl_wei, pnl_wei) AS REAL)),0) pnl,
            COALESCE(SUM(CAST(spend_wei AS REAL)),0) spend,
            COUNT(*) n, COALESCE(SUM(CASE WHEN CAST(COALESCE(onchain_pnl_wei, pnl_wei) AS REAL) > 0 THEN 1 ELSE 0 END),0) wins,
            COALESCE(AVG(hold_ms),0) hold,
            COALESCE(SUM(CASE WHEN onchain_pnl_wei IS NOT NULL THEN 1 ELSE 0 END),0) verified
     FROM positions WHERE closed = 1 AND live = 1 AND id > ${epochBase}
       AND exit_reason NOT IN (${NON_TRADE_SQL})`,
  ).get() as any
  // the book live would actually trade: shadow deliberately runs the wider dev-buy
  // cohort so the bands below the floor keep being measured, so the headline number
  // for the go/no-go is this subset, not the whole shadow book. live_book is stamped on
  // the launch row at detection time, so it tracks whatever the book was then - the label
  // below is generated from config rather than typed, because it drifted once already.
  const liveBook = db.prepare(
    `SELECT COALESCE(SUM(CAST(COALESCE(p.onchain_pnl_wei, p.pnl_wei) AS REAL)),0) pnl,
            COALESCE(SUM(CAST(p.spend_wei AS REAL)),0) spend, COUNT(*) n
     FROM positions p JOIN launches l ON l.token = p.token
     WHERE p.closed = 1 AND p.id > ${epochBase}
       AND p.exit_reason NOT IN (${NON_TRADE_SQL}) AND l.live_book = 1`,
  ).get() as any
  // The exit multiple is the number that was missing: peak says how far it ran, this says
  // what we actually got out at, and the gap between them is the cost of the exit rule.
  // Named via the launch calldata, because "0xcd702f06..." is not something you can hold
  // in your head across twelve rows.
  const dup = db.prepare(
    `SELECT COALESCE(MAX(c),0) maxn FROM (SELECT COUNT(*) c FROM positions GROUP BY token)`,
  ).get() as any
  // buy_ok = 0 rows are bookkeeping, not exposure. Counting them made livewatch report
  // open=2 against a genuinely flat book for a day (ids 277 and 357, sends that failed and
  // never landed); recovery.ts decides real exposure from the chain balance, not this.
  const openRows = db.prepare(
    `SELECT COUNT(*) n FROM positions WHERE closed = 0 AND buy_ok = 1`,
  ).get() as any
  // Buys over the trailing window: a rate needs a denominator, and the denominator is
  // attempts, not trades. See the buy alerts in buildAlerts for why this exists at all.
  // closed = 1 only, so the numerator and denominator cover the same rows. An open position
  // is an attempt that has not resolved: counting it as an attempt but never as a failure
  // dilutes the rate downward, which is the wrong direction for an alarm to be wrong in.
  const buys = db.prepare(
    `SELECT COUNT(*) attempts,
            COALESCE(SUM(CASE WHEN exit_reason = 'buy-reverted' THEN 1 ELSE 0 END),0) fails,
            COALESCE(SUM(CASE WHEN buy_error LIKE 'out-of-gas%' THEN 1 ELSE 0 END),0) oog
     FROM (SELECT exit_reason, buy_error FROM positions
           WHERE live = 1 AND closed = 1 AND id > ${epochBase} ORDER BY id DESC LIMIT 20)`,
  ).get() as any
  // Worst RAW gas a filled buy used, so the ceiling is watched before it bites.
  //
  // Cached for a minute rather than riding the snapshot's 1s TTL. There is no index on
  // buy_gas_used, so this MAX is a scan of every position since the epoch began -- a range
  // that only grows across a trading day -- against the same SQLite file the trading loop
  // writes to on every fill. At 1s that is a full-range scan once a second for as long as
  // anyone leaves a dashboard tab open. The number itself can only change when a new buy
  // lands, and it is read to watch headroom against a fixed ceiling, so a minute of
  // staleness cannot change a decision.
  const buyGas = cached('buyGasMax', 60_000, () =>
    db.prepare(
      `SELECT MAX(buy_gas_used) g FROM positions
       WHERE live = 1 AND buy_gas_used IS NOT NULL AND id > ${epochBase}`,
    ).get() as any)
  // last 24h, not since the epoch baseline: the counter read "918 this epoch" for a week
  // after the incidents it counted were fixed, which is a warning nobody reads any more
  const exitFails = db.prepare(
    `SELECT COUNT(*) n FROM health WHERE component='exit' AND ok=0 AND at >= ?`,
  ).get(now - 86_400_000) as any

  // The modeled `equity` series used to be built here and shipped on every poll without
  // ever being rendered - the chart runs on `balance`, which is chain truth. Removed
  // 2026-08-18 along with the sim-vs-live recon card: reconciliation is still worth
  // running, it just is not an operations question.

  // ETH, the unit the stop compares. The dollars are derived where they are displayed.
  const drawdownEth = Number(bot.risk.peakPnlWei - bot.risk.realizedPnlWei) / 1e18

  // ---- chain truth: the wallet, not a model ----
  // NET WORTH per sample = wallet + what the open book cost. Both are real ETH, so the
  // series stays chain truth while losing the fake dip: a buy moves 0.005 ETH out of the
  // wallet and into tokens, and drawing only the wallet renders that as a 0.005 ETH loss
  // that reverses 39 seconds later. Rows written before deployed_wei existed fall back to
  // open_n x trade size, which is exact while the size is fixed.
  const balRows = balanceRows(db)
  // per-day change from the balance samples themselves, so the day rows are chain truth.
  // One pass over rows already in memory; the SQL version ran two correlated subqueries
  // per day over the whole table, every second, per open tab.
  const dayKey = (at: number) => new Date(at).toISOString().slice(0,10) // YYYY-MM-DD, local
  const dayMap = new Map<string, { d: string; open_w: number; close_w: number }>()
  for (const r of balRows) {
    const d = dayKey(r.at)
    const row = dayMap.get(d)
    if (!row) dayMap.set(d, { d, open_w: r.w, close_w: r.w })
    else row.close_w = r.w // rows arrive ordered by at ASC, so last write is the close
  }
  const balDays = [...dayMap.values()].reverse().slice(0, 8)
  const truthGet = (k: string): string | null => truthGetDb(db, k)
  // one dot per closed trade for the chart: where it landed on the curve, and how big
  const tradeDots = db.prepare(
    `SELECT exit_at t, CAST(COALESCE(onchain_pnl_wei, pnl_wei) AS REAL) pnl, exit_reason r
     FROM positions WHERE live = 1 AND closed = 1 AND id > ${epochBase} AND exit_at IS NOT NULL
     ORDER BY exit_at ASC`,
  ).all() as any[]
  const baselineWei = truthGet('baseline_wei')
  const baselineAt = truthGet('baseline_at')
  const peakFlatWei = truthGet('peak_flat_wei')
  const lastBal = balRows.length ? balRows[balRows.length - 1] : null
  const walletEth = lastBal ? lastBal.w / 1e18 : null
  const baselineEth = baselineWei !== null ? Number(baselineWei) / 1e18 : null
  // NET WORTH is the number that answers "what am I worth right now": the wallet plus
  // whatever the open positions would fetch. When a position is open the wallet alone
  // drops by the deployed size, which reads as a loss it is not.
  const openMarkEth = positions.reduce((a, p) => a + (p.filled ? p.markEth : p.spendEth), 0)
  const netWorthEth = walletEth !== null ? walletEth + openMarkEth : null
  // Independent cross-check: the wallet moved by X, the trade receipts say Y. They
  // should differ only by approve-tx gas (~1 microETH a trade, never captured on a
  // position row). A growing gap means a transfer, a missed trade, or an accounting bug.
  // Reconcile against EVERY live row in the epoch, including the ones the headline P&L
  // deliberately drops (buy-reverted burns gas, recovered-flat still moved coins). The
  // headline answers "did the strategy work"; this answers "where did the ETH go", and
  // they need different sets or the residual is permanently non-zero.
  const reconAll = db.prepare(
    `SELECT COALESCE(SUM(CAST(COALESCE(onchain_pnl_wei, pnl_wei) AS REAL)),0) pnl, COUNT(*) n
     FROM positions WHERE live = 1 AND closed = 1 AND id > ${epochBase}`,
  ).get() as any
  const receiptSumEth = (reconAll.pnl ?? 0) / 1e18
  const price = typeof bot.priceReading === 'function' ? bot.priceReading() : null
  const truth = {
    netWorthEth,
    netWorthUsd: netWorthEth !== null ? netWorthEth * ethUsd : null,
    openMarkEth,
    receiptSumEth,
    unreconciledEth: walletEth !== null && baselineEth !== null
      ? (netWorthEth! - baselineEth) - receiptSumEth : null,
    walletEth,
    walletUsd: walletEth !== null ? walletEth * ethUsd : null,
    lastBalanceAt: lastBal?.at ?? null,
    openAtSample: lastBal?.open_n ?? null,
    baselineEth,
    baselineAt: baselineAt !== null ? Number(baselineAt) : null,
    pnlSinceBaselineEth: netWorthEth !== null && baselineEth !== null ? netWorthEth - baselineEth : null,
    pnlSinceBaselineUsd: netWorthEth !== null && baselineEth !== null ? (netWorthEth - baselineEth) * ethUsd : null,
    drawdownFromPeakUsd: peakFlatWei !== null && lastBal !== null
      ? Math.max(0, (Number(peakFlatWei) - lastBal.w) / 1e18) * ethUsd : null,
    // The ETH price the numbers above were computed with, plus how old it is. Fetched
    // hourly since 2026-09-07 (telemetry/price.ts) and display only. The age matters to
    // the reader: a price that stopped refreshing makes every dollar on the page drift
    // quietly, which is the failure the fetch was added to fix in the first place.
    priceUsd: ethUsd,
    priceAgeMs: price?.ageMs ?? null,
    priceSource: price?.source ?? 'config',
    days: balDays.map((x) => ({
      day: x.d,
      changeEth: (x.close_w - x.open_w) / 1e18,
      changeUsd: ((x.close_w - x.open_w) / 1e18) * ethUsd,
    })),
    trades: tradeDots.map((x) => ({ t: x.t, eth: x.pnl / 1e18, usd: x.pnl == null ? null : (x.pnl / 1e18) * ethUsd, r: x.r })),
    filterChanges: (() => { try { return JSON.parse(truthGet('filter_changes') ?? '[]') } catch { return [] } })(),
    receiptsVerified: closed.verified ?? 0,
    receiptsTotal: closed.n ?? 0,
    // No `series` here. It was 42,280 bytes of a 94,413-byte payload, rebuilt every second
    // inside the trading process, and nothing read it: not the page, not the report skill,
    // not push.py, not either browser suite. The wallet series the CHART draws comes from
    // /api/chart (`wallet`, same balanceRows source) where it is bounded by lookback and
    // gzipped. If a state-side series is ever wanted again, add it there, not here.
  }

  // ---- rolling windows: the numbers that describe NOW ----
  const kpis = cached('kpi', 3_000, () => {
    const rows = tradeRows(db, now - 24 * 3600_000, book0)
    return { windows: rollingKpis(rows, now, ethUsd), minsSinceTrade: minutesSinceLastTrade(rows, now), rows }
  })
  const gate = cached('gate', 5_000, () => {
    const rows = gateRows()
    const pts = replayGate(rows, STRATEGY.gate)
    const last = pts.length ? pts[pts.length - 1]! : null
    const live = liveGate(db, Date.now())
    // The replay reads `obs`, which a dead watcher leaves frozen at whatever the venue
    // was doing when it died. So the page used to render GATE OPEN in green at 60% while
    // the bot had halted itself for exactly that staleness (strategy/gate.ts STALE_MS),
    // and the 'gate SHUT' alert never fired. Two sources of truth for the one question
    // this page exists to answer. The bot's rule wins: a watcher that stopped is shut.
    const { state, stale } = gateCardState(last?.state ?? null, gateHeartbeatMs())
    // How old the newest LAUNCH behind this rate is, which is a different question from
    // the heartbeat and the one nothing on this page could answer. gatewatch only scores
    // launches that passed the book, so a dry spell starves it while it keeps
    // heartbeating: on 2026-08-19 05:00 the card read "OPEN 20.0%" on a window whose
    // newest launch was 151 min old. obs.launched_at is in SECONDS.
    const newestObs = rows.reduce((a, r) => (r.launched_at > a ? r.launched_at : a), 0)
    const common = {
      openAt: STRATEGY.gate.openAt,
      shutAt: STRATEGY.gate.shutAt,
      window: STRATEGY.gate.window,
      heartbeatMs: gateHeartbeatMs(),
      scored: rows.length,
    }
    // `source` is on the card because the failure it catches is silent: the live ring is
    // SEEDED from gate.db, so a live path that quietly stopped filling reports the same
    // rate while being exactly as stale as before. dataAgeMs is what actually catches it,
    // and it comes from the bot's own reading here rather than from our replay.
    if (live) {
      return { ...common, ...gateSnapshotFrom(live), readingAgeMs: live.ageMs }
    }
    return {
      ...common,
      state,
      stale,
      staleReason: stale ? 'gatewatch heartbeat is stale' : null,
      rate: last?.rate ?? null,
      n: last?.n ?? null,
      dataAgeMs: newestObs > 0 ? Date.now() - newestObs * 1000 : null,
      source: 'replay' as const,
      liveN: null,
      readingAgeMs: null,
    }
  })
  const w1h = kpis.windows.find((x) => x.label === '1h')!
  // the daily edge check's last verdicts; cached because it is rewritten once a day
  const edge = cached('edge', 60_000, () => edgeState())
  const outlook = bot.risk.resumeOutlook()
  // typeof guards for the same reason the plumbing below uses them: the dashboard is also
  // pointed at older Bot shapes by tests and by a box mid-deploy
  const venue = typeof bot.venueReading === 'function' ? bot.venueReading() : null
  const broken = typeof bot.brokenReading === 'function' ? bot.brokenReading() : null
  const dayPnlUsd = num(bot.risk.dayRealizedPnlWei) * ethUsd
  const alerts = buildAlerts({
    halted: bot.risk.halted, haltReason: bot.risk.haltReason, haltKind: bot.risk.haltKind,
    autoResumes: outlook.autoResumes, resumesWhen: outlook.when,
    feedConnected: bot.feed.connected, feedAgeMs: feedAge,
    logsHealthy: bot.logs.healthy, logsAgeMs: logsAge, logsStaleLimit: RISK.maxLogsStalenessMs,
    drawdownEth, drawdownLimitEth: RISK.maxDrawdownEth, ethUsd: ethUsd,
    gateState: gate.state, gateRate: gate.rate, gateHeartbeatMs: gate.heartbeatMs,
    gateDataAgeMs: gate.dataAgeMs,
    minsSinceTrade: kpis.minsSinceTrade, upMs,
    rot1h: w1h.rotPct, n1h: w1h.n,
    stuck: stateCounts.stuck,
    parked: stateCounts.parked,
    stranded: stranded24h,
    exitFailures: exitFails.n ?? 0,
    nonceResyncs1h: typeof bot.nonceResyncs1h === 'function' ? bot.nonceResyncs1h() : 0,
    pollFailures1h: typeof bot.logs?.failures1h === 'function' ? bot.logs.failures1h() : 0,
    detectLagP50: detectLag.p50, detectLagN: detectLag.n,
    markErrP50: markErr.p50, markErrN: markErr.n,
    bookDrift1h: typeof bot.state?.bookDrift1h === 'function' ? bot.state.bookDrift1h() : 0,
    venueSum: venue?.sum ?? null, venueN: venue?.n ?? 0, venueFresh: venue?.fresh ?? false,
    brokenGapPp: broken?.gapPp ?? null, brokenN: broken?.n ?? 0, brokenLimitPp: RISK.brokenGapPp,
    cuPerMonth: bot.readBudget?.totalPerMonth?.() ?? null,
    loopLagMaxMs: typeof bot.loopLagMaxMs === 'function' ? bot.loopLagMaxMs() : undefined,
    resources: bot.resources ?? null,
    edgeAgeMs: edge ? edge.ageMs : null, edgeVerdicts: edge?.verdicts ?? null, edgeMainStreak: edge?.mainNegStreak ?? 0,
    buyFails: buys.fails ?? 0, buyAttempts: buys.attempts ?? 0, buyOutOfGas: buys.oog ?? 0,
    buyGasHeadroom: buyGas?.g ? buyGas.g / Number(GAS.limits.buy) : null,
    configErrors: configErrors(),
    configPendingRestart: pendingRestartChanges().map((c) => c.env),
  })

  // The per-book block. Everything here is MEASURED, none of it is staked: until phase 4
  // writes positions.book, every closed row reads as book 0, which is exactly true, and the
  // guard tape comes from phase 2's per-book replay over one shared evidence set.
  const bookTrades = cached('bookTrades', 10_000, () => {
    // 7 days rather than the kpi pull's 24h, because the delta gate wants 30 closed trades a
    // side and the book has run ~27 a day. Still bounded, so it does not degrade as positions
    // grows the way an unbounded aggregate over that table would.
    const rows = tradeRows(db, now - 7 * 86_400_000, book0)
    const byBook = new Map<string, TradeRow[]>()
    // Rows the partition drops on purpose: unstamped, and more than one book configured.
    // Counted rather than discarded, because a per-book table whose columns do not add up to
    // the wallet needs to say where the difference went.
    let unattributed = 0
    for (const r of rows) {
      const k = r.book ?? null
      if (k == null) { unattributed++; continue }
      const list = byBook.get(k); if (list) list.push(r); else byBook.set(k, [r])
    }
    return { byBook, unattributed }
  })
  const bookFunnel = cached('bookFunnel', 15_000, () => bookRejectFunnel(db, books, now - 24 * 3600_000, now))
  // Phase 2 publishes one observer per book off the same evidence. It arrives over IPC already
  // built, so this costs nothing: the alternative, re-reading the forward ledger per book at
  // 1 Hz inside the trading process, is the exact shape of the 2026-09-14 capture fuse.
  const bookObservers = new Map<string, any>(
    ((bot.simulation?.paperStatus as any)?.scenarioObservers ?? []).map((x: any) => [x.bookId, x.observer]),
  )
  const bookBlocks = books.map((b) => {
    const rows = bookTrades.byBook.get(b.id) ?? []
    const funnel = bookFunnel.get(b.id) ?? { buckets: {}, n: 0, entered: 0, basis: 'band' }
    const ob = bookObservers.get(b.id) ?? null
    return {
      id: b.id, minTaxBps: b.minTaxBps, maxTaxBps: b.maxTaxBps, digest: b.digest,
      band: `${b.minTaxBps}-${b.maxTaxBps} bps`,
      // the book's own rolling windows. The FLAT `kpis` below stays the wallet sum; these
      // never alias it, or `report` would print one book's n as the whole bot's.
      kpis: rollingKpis(rows, now, ethUsd),
      trades: { ...bookSummary(rows, ethUsd), windowMs: 7 * 86_400_000 },
      rejects: {
        ...funnel,
        // The denominator in words, because a funnel without one is a pile of numbers.
        note: `of ${funnel.n} launches in this band that passed the book screen, last 24h`,
      },
      // the guard tape, per book, from phase 2's replay. null until the worker has published.
      guard: ob ? {
        state: ob.reading?.state ?? null, reason: ob.reading?.reason ?? null,
        sum: ob.reading?.sumRange?.[0] ?? null, recentSum: ob.reading?.recentSumRange?.[0] ?? null,
        n: ob.reading?.scenarios?.length ? Math.min(...ob.reading.scenarios.map((x: any) => x.n)) : 0,
        configId: ob.configId ?? null, at: ob.at ?? null, pending: ob.pending ?? 0,
      } : null,
      // The per-book pause button ships rendered and DISABLED, with the reason in the tooltip.
      // controlAction places a single global 'stopped' halt; a per-book pause is phase 4's.
      // A button that looks live and then refuses is exactly what that function's comments
      // were written to prevent.
      controllable: false,
      controlWhy: 'per-book pause needs the per-book risk split (phase 4). STOP halts the wallet.',
    }
  })

  // The entry policy, from config: every number the book is actually running, so the page
  // never carries its own copy. The entry clock that used to head this block was deleted
  // on 2026-09-07 (the bot trades 24 hours); config.ts wsHours has the reasoning.
  const policy = {
    // The configured books. One entry while a single band is configured, which is the same
    // band the two scalars below report; the page takes its labels from here rather than
    // splicing them into the HTML, per the warning in dashboard-page.ts.
    books: books.map((b) => ({ id: b.id, minTaxBps: b.minTaxBps, maxTaxBps: b.maxTaxBps, digest: b.digest })),
    minCreatorTaxBps: STRATEGY.minCreatorTaxBps,
    maxCreatorTaxBps: STRATEGY.maxCreatorTaxBps,
    minExemptionsToEnter: STRATEGY.minExemptionsToEnter,
    maxEntryPriceMultiple: STRATEGY.maxEntryPriceMultiple,
    templateLossBlockMs: STRATEGY.templateLossBlockMs,
    takeProfitAdaptive: STRATEGY.takeProfit.adaptive.enabled,
    takeProfitAdaptiveWindow: STRATEGY.takeProfit.adaptive.window,
    takeProfitFallback: STRATEGY.takeProfit.otherwise,
    maxHoldMs: STRATEGY.maxHoldMs,
    deadCoinAfterMs: STRATEGY.deadCoin.afterMs,
    hardStopMultiple: STRATEGY.hardStopMultiple,
    // Shipped because the PAGE was colouring rows against its own copies of them: exempt
    // wallets green at >= 1 while the book required 3, and prior launches green only at 0
    // while the book allowed 3. A monitor quoting a bound the bot is not running is worse
    // than one that stays quiet, and these two had been wrong since the filters moved.
    maxPriorLaunches: STRATEGY.book.maxPriorLaunches,
    minExemptions: STRATEGY.book.minExemptions,
    /** gatewatch is considered stale past this; strategy/gate.ts owns the number */
    gateStaleMs: STALE_MS,
  }

  // What this process is actually running, and whether the file agrees with it. The 09-06
  // failure was invisible precisely because nothing published the effective config.
  const configState = {
    path: envFilePath(),
    changedAt: configChangedAt(),
    errors: configErrors(),
    pendingRestart: pendingRestartChanges(),
    values: liveConfig(),
  }

  const operator = typeof bot.operatorReading === 'function'
    ? bot.operatorReading((db.prepare('SELECT COUNT(*) n FROM positions WHERE live=1 AND closed=0').get() as {n:number}).n,
      (db.prepare('SELECT MAX(t_sent) at FROM positions WHERE live=1 AND buy_ok=1').get() as {at:number|null}).at)
    : null
  const notices = dashboardNotices({ alerts, operator, now, balanceAt: truth.lastBalanceAt,
    priceAgeMs: truth.priceAgeMs, priceSource: truth.priceSource })

  return {
    at: now, operator,
    activeGuard: { id: liveConfig().venueExecutionScenarios ? venue?.policyId ?? "unverified-scenario-release" : liveConfig().venueFreshRecovery ? "adaptive-shadow" : "legacy", reading: venue ? {...venue,sum:venue.source!=='conservative-paper'||venue.verified&&venue.fresh?venue.sum:null,recentSum:venue.source!=='conservative-paper'||venue.verified&&venue.fresh?venue.recentSum:null} : null },
    candidateIndicator: (bot.simulation?.paperStatus ?? simulationReport(undefined,now,now)).candidateIndicator,
    captureHealth: bot.simulation?.status ?? null,
    indicatorPipeline: bot.simulation?.paperStatus ? {modelHash:bot.simulation.paperStatus.scenarioObserver?.modelHash??null,
      selector:bot.simulation.paperStatus.selector,acquisition:bot.simulation.paperStatus.acquisition??null,
      lastPublicationAt:bot.simulation.paperStatus.scenarioObserver?.publicationAt??null,
      reportError:bot.simulation.paperStatus.reportError??null} : null,
    modelValidation: (bot.simulation?.paperStatus ?? simulationReport(undefined,now,now)).validation,
    money: dashboardMoney(db,now,ethUsd),
    marketPolicy: effectiveMarketPolicy(liveConfig().venueFreshRecovery,{window:STRATEGY.gate.pnlPauseWindow,off:STRATEGY.gate.pnlPauseOff,on:STRATEGY.gate.pnlPauseOn,freshMs:STRATEGY.gate.pnlFreshMs},bot.executionScenarioPolicy?.()),
    levels: LEVELS.LEVELS,
    notices,
    bannerAlerts: dashboardBanner({ alerts, notices, haltKinds: bot.risk.haltKinds,
      unresolvedExits: stateCounts.stuck + stateCounts.parked }),
    truth,
    edge,
    policy,
    config: configState,
    // the in-memory reject counters since boot, by bucket (tax / exempt / clock / probe / ...).
    // WALLET LEVEL and whole: most of these buckets fire at the book screen before any band
    // is consulted, so they belong to no book. books[i].rejects carries the post-band half.
    rejects: Object.fromEntries(bot.stats.rejects),
    books: bookBlocks,
    // Closed trades in the 7-day book window that carry no book stamp, so belong to no book.
    // Always 0 while one book is configured; it is the cutover cost of a second one.
    unattributedTrades: bookTrades.unattributed,
    // Is the A-vs-B difference worth printing yet. Server side deliberately, so the report
    // skill cannot print a delta the dashboard is greying out.
    delta: bookDelta(bookBlocks),
    kpis: kpis.windows.map(w=>{const cash=bookedWindow(db,now-w.ms,now,ethUsd);return {...w,n:cash.n,pnlUsd:cash.bookUsd,rotPct:cash.rotPct,winRate:cash.winPct,missing:cash.missing,attempts:cash.attempts}}),
    minsSinceTrade: kpis.minsSinceTrade,
    gate,
    alerts,
    resources: bot.resources ?? null,
    worstSev: alerts.some((a) => a.sev === 'crit') ? 'crit' : alerts.length ? 'warn' : 'ok',
    mode: bot.modeName,
    live: bot.modeName === 'live',
    upMs,
    // from config rather than typed into the page, which is how the old copy went stale
    entryDelayMs: STRATEGY.entryDelayMs,
    plumbing: {
      feedConnected: bot.feed.connected,
      feedBlocksPerSec: m.feedBlocks / Math.max(1, upMs / 1000),
      feedAgeMs: feedAge,
      feedGaps: m.feedGaps,
      feedTxs: m.feedTxs,
      logsMode: bot.logs.mode,
      logsHealthy: bot.logs.healthy,
      logsAgeMs: logsAge,
      lastEventAgeMs: lastEventAge,
      logsStaleLimit: RISK.maxLogsStalenessMs,
      rttMed: rtt?.med ?? null,
      rttP95: rtt?.p95 ?? null,
      // verdicts our own scorer has produced since boot. The gate card's liveN says how
      // many are in the CURRENT window; this says the scorer ever ran at all, which is
      // what separates "quiet venue" from "scoring is broken" when liveN sits at 0.
      cohortScored: m.cohortScored,
      // a rate over three samples is noise, not a signal. an alert metric that cries
      // wolf on tiny n gets ignored, which is worse than not showing it at all.
      overlayFalsePositivePct: v.skippedTotal >= 20 ? (v.skippedThenLanded / v.skippedTotal) * 100 : null,
      overlayMinSample: 20,
      bookChecks: bot.state?.bookChecks ?? { ok: 0, drift: 0, skipped: 0 },
      bookDrift1h: typeof bot.state?.bookDrift1h === 'function' ? bot.state.bookDrift1h() : 0,
    venueSum: venue?.sum ?? null, venueN: venue?.n ?? 0, venueFresh: venue?.fresh ?? false,
    brokenGapPp: broken?.gapPp ?? null, brokenN: broken?.n ?? 0, brokenLimitPp: RISK.brokenGapPp,
      overlayApplied: v.appliedTotal,
      overlaySkipped: v.skippedTotal,
      metaFromFeed: m.metaFromFeed,
      metaFromRpc: m.metaFromRpc,
      // the two numbers that were invisible until 2026-09-06: how hard the RPC is saying
      // no, and how late we see each launch (the 08-27 loss was entry lag, not strategy)
      pollFailures1h: typeof bot.logs?.failures1h === 'function' ? bot.logs.failures1h() : 0,
      providerLogFallbacks: bot.logs?.providerFallbacks ?? 0,
      providerLogCalls: bot.logs?.providerCalls ?? 0,
      logPolling: bot.logs?.diagnostics?.() ?? null,
      detectLag,
      markErr,
      // the launch accelerator (LOGS_WS_URL): up, how many launches it delivered, how many
      // of those it delivered BEFORE the poller, and what it is costing
      wsUp: Boolean(bot.logs?.wsUp),
      wsLaunches: bot.logs?.wsLaunches ?? 0,
      wsFirstSeen: bot.logs?.wsFirstSeen ?? 0,
      cuPerMonth: bot.readBudget?.totalPerMonth?.() ?? null,
      readCuPerMonth: bot.readBudget?.readsPerMonth?.() ?? null,
      providerMethodCalls: bot.readBudget?.calls ?? {},
      sharedReceiptReads: bot.sharedReceiptReads ?? 0,
      providerMeterStartedAt: bot.meters?.startedAt ?? null,
      keyReads: bot.meters?.keyReads ?? 0,
      keyReadFallbacks: bot.meters?.keyReadFallbacks ?? 0,
      loopLagMaxMs: typeof bot.loopLagMaxMs === 'function' ? bot.loopLagMaxMs() : 0,
      boundaryPrediction: typeof bot.boundaryPrediction === 'function' ? bot.boundaryPrediction() : null,
      wsCuPerMonth: typeof bot.logs?.wsCuPerMonth === 'function' ? bot.logs.wsCuPerMonth() : null,
    },
    risk: {
      open: positions.length,
      maxConcurrent: STRATEGY.maxConcurrent,
      deployedEth: num(bot.risk.deployedWei),
      deployedUsd: num(bot.risk.deployedWei) * ethUsd,
      bankrollEth: STRATEGY.bankrollEth,
      bankrollUsd: STRATEGY.bankrollEth * ethUsd,
      tradeSizeEth: STRATEGY.tradeSizeEth,
      tradeSizeUsd: STRATEGY.tradeSizeEth * ethUsd,
      realizedEth: num(bot.risk.realizedPnlWei),
      // ETH is the bound the stop actually compares (risk.ts checkDrawdown). The USD pair
      // is derived for display and for the two monitors that parse it (the report skill,
      // push.py); nothing decides on it.
      drawdownEth,
      drawdownLimitEth: RISK.maxDrawdownEth,
      drawdownUsd: drawdownEth * ethUsd,
      drawdownLimitUsd: RISK.maxDrawdownEth * ethUsd,
      halted: bot.risk.halted,
      haltReason: bot.risk.haltReason,
      haltKind: bot.risk.haltKind,
      // every active kind, stickiest first. Two can be true at once (an operator stop and
      // a shut venue), and the page must not report the second as if it were the only one.
      haltKinds: bot.risk.haltKinds,
      autoResumes: outlook.autoResumes,
      resumesWhen: outlook.when,
      dayPnlUsd,
      /** drawdown self-lifts spent today, against the two a day the stop is allowed */
      ddLiftsUsed: bot.risk.ddLiftsUsed,
      venue: venue
        ? { ...venue, sum:venue.source!=='conservative-paper'||venue.verified&&venue.fresh?venue.sum:null, recentSum:venue.source!=='conservative-paper'||venue.verified&&venue.fresh?venue.recentSum:null }
        : null,
      broken: broken ? { gapPp: broken.gapPp, n: broken.n, limitPp: RISK.brokenGapPp } : null,
    },
    discipline: {
      maxEntriesPerToken: dup.maxn ?? 0,
      openRows: openRows.n ?? 0,
      exitFailures: exitFails.n ?? 0,
      stuck: stateCounts.stuck,
      parked: stateCounts.parked,
      // graduated bags closed in the last 24h (was: parked-open positions, see bot.strand)
      stranded: stranded24h,
      // exposed as numbers, not just as alert strings, so the gas ceiling can be re-fitted
      // from the dashboard without opening the database
      buyAttempts: buys.attempts ?? 0,
      buyFails: buys.fails ?? 0,
      buyOutOfGas: buys.oog ?? 0,
      buyGasMax: buyGas?.g ?? null,
      buyGasLimit: Number(GAS.limits.buy),
    },
    results: {
      trades: closed.n ?? 0,
      rotPct: closed.spend > 0 ? (closed.pnl / closed.spend) * 100 : 0,
      pnlEth: (closed.pnl ?? 0) / 1e18,
      pnlUsd: ((closed.pnl ?? 0) / 1e18) * ethUsd,
      winPct: closed.n ? (closed.wins / closed.n) * 100 : 0,
      avgHoldS: (closed.hold ?? 0) / 1000,
      liveBookTrades: liveBook.n ?? 0,
      liveBookRotPct: liveBook.spend > 0 ? (liveBook.pnl / liveBook.spend) * 100 : 0,
      liveBookLabel: `of which the live book (dev\u2265${Number(STRATEGY.book.minDevBuyWei) / 1e18}, first launch)`,
      nonTrades: (db.prepare(
        `SELECT COUNT(*) n FROM positions WHERE closed = 1 AND id > ${epochBase} AND exit_reason IN (${NON_TRADE_SQL})`,
      ).get() as any).n ?? 0,
    },
    positions,
    recent: recentExits(db, epochBase, book0),
    explorer: ENDPOINTS.explorer,
    wallet: bot.walletAddress,
  }
}

/** the lookbacks the page offers; 7d is the ceiling because `balance` is pruned to 7d */
export const LOOKBACKS: Record<string, number> = {
  '1h': 3600_000, '4h': 4 * 3600_000, '12h': 12 * 3600_000,
  '24h': 24 * 3600_000, '3d': 3 * 86_400_000, '7d': 7 * 86_400_000,
}

/**
 * Bucket width per lookback, sized so every view lands near 50 bars: wide enough to read
 * at 80px tall, narrow enough that a two-hour dry spell is still visible as its own dip.
 */
export const BUCKET_MS: Record<string, number> = {
  '1h': 2 * 60_000, '4h': 5 * 60_000, '12h': 15 * 60_000,
  '24h': 30 * 60_000, '3d': 2 * 3600_000, '7d': 4 * 3600_000,
}

/**
 * How long a rebuilt chart payload stands, per lookback. The page polls on the same table.
 *
 * One flat 5s TTL meant a 7-day tab made this process rebuild seven days of history every
 * five seconds, ~1s of blocked event loop in every 5 inside a live trading bot. A 7-day view
 * whose newest 4-hour bucket is up to a minute old costs nothing; /api/state still polls at
 * 1s, so every live number on the page stays live.
 */
export const CHART_TTL_MS: Record<string, number> = {
  '1h': 5_000, '4h': 5_000, '12h': 10_000,
  '24h': 15_000, '3d': 30_000, '7d': 60_000,
}

/**
 * The chart payload, on its own endpoint and its own (slower) poll.
 *
 * Split from /api/state because it is the expensive half and the cheap half is what wants
 * a 1s refresh. Everything here is bounded by the requested lookback.
 */
export function chartSnapshot(bot: Bot, key: string, now = Date.now(), historical = false, book?: string): Record<string, unknown> {
  const ethUsd = displayPrice(bot)
  const span = LOOKBACKS[key] ?? LOOKBACKS['4h']!
  const bucket = BUCKET_MS[key] ?? BUCKET_MS['4h']!
  const from = now - span
  const db = bot.tel.raw()
  const books = liveBooks()
  // An unknown book falls back to book 0 rather than returning empty panes. The ROUTE is what
  // refuses an unknown name (see the note there about memo keys); this is the second line.
  const bookId = books.find((b) => b.id === book)?.id ?? books[0]!.id
  // Which series the page will draw. It used to take this from /api/state, so on first paint,
  // before state arrived, the venue pane could pick the series that is empty in this mode.
  const marketSource = effectiveMarketPolicy(liveConfig().venueFreshRecovery,
    {window:STRATEGY.gate.pnlPauseWindow,off:STRATEGY.gate.pnlPauseOff,on:STRATEGY.gate.pnlPauseOn,freshMs:STRATEGY.gate.pnlFreshMs},bot.executionScenarioPolicy?.()).source
  const adaptive = marketSource==='conservative-paper' ? {samples:[] as any[],events:[] as any[]} : adaptiveHistory(db,from,now)
  const accounts = simulationReport(bot.simulation?.path, from, now)
  const status=bot.simulation?.paperStatus
  // The live observer FOR THIS BOOK. Phase 2 publishes one per book off one evidence set, so
  // reading the unsuffixed one for every tab would label book B's pane with book A's tape.
  const perBook=((status as any)?.scenarioObservers as Array<{bookId:string;observer:any}>|undefined)?.find(x=>x.bookId===bookId)?.observer
  const liveObserver:typeof accounts.scenarioObserver=status&&now-status.at<=15000?(perBook??status.scenarioObserver):accounts.scenarioObserver
  const observer=liveObserver
  const forward=readForwardLedger(bot.simulation?.path,from,now,now,bookId)
  const paper=forward?.paper??{cash:[],points:[],dark:[],seams:[],estimated:true,monthToDate:null,n:0,wins:0,recordFrom:null,recordedPnlEth:null,pending:0,unavailable:1,coverage:{complete:false,from:null,through:null},health:{stalled:true,fault:'forward ledger warming',pending:0,lastClose:null},account:'continuous-scenario',scenario:'p50-after',source:'forward-ledger',modelHash:null,label:'24h baseline'}
  const coins=displayCoins(db,forward?.coins??[],null,from,now,true)
  const outcomes=scenarioOutcomeBuckets(db,null,from,now,bucket,coins,true)
  const recordedMarket = marketHistory(db, from, now)
  const market=forward?.market??[]
  const contributorTokens=[...new Set(market.flatMap((p:any)=>p.scenarios?.flatMap((s:any)=>[...(s.mainTokens??[]),...(s.freshTokens??[])])??[]))]
  const tokenIndex=new Map(contributorTokens.map((t,i)=>[t,i]))
  for(const p of market)for(const s of p.scenarios??[]){s.mainIds=s.mainTokens?.map((t:string)=>tokenIndex.get(t));s.freshIds=s.freshTokens?.map((t:string)=>tokenIndex.get(t));delete s.mainTokens;delete s.freshTokens}
  const spliced = { points: 0, spans: [] as Array<{from:number;to:number}> }

  const balRows = balanceRows(db, from)
  const wallet = thin(balRows.filter(x=>x.at<=now), 400).map((x: any) => ({
    t: x.at, eth: round(x.net / 1e18, 6), usd: round((x.net / 1e18) * ethUsd, 2), open: x.open_n,
  }))

  const simulationComparison = scenarioComparison(observer,from,Math.min(now,observer?.at??now))

  const trades = db.prepare(
    `SELECT exit_at t, CAST(COALESCE(onchain_pnl_wei, pnl_wei) AS REAL) pnl, exit_reason r,
            token, hold_ms
     FROM positions WHERE live = 1 AND closed = 1 AND exit_at >= ? AND exit_at <= ? ORDER BY exit_at ASC`,
  ).all(from, now) as any[]

  // A vs B. Built ONLY when the comparison tab asked for it, because it is a second full
  // ledger read per other book. Two real lines, not one line and a copy: each book has its own
  // guard tape from phase 2, which is the whole reason the comparison is worth drawing.
  //
  // The book lines are BOOKED P&L in stakes and the wallet line above is chain truth, so
  // A + B does not equal the wallet and the page must not claim it does. The residual is open
  // positions, gas on reverted sells and unbooked receipts, which truth.unreconciledEth names.
  const compare = book !== 'vs' ? null : books.map((b) => {
    const f = b.id === bookId ? forward : readForwardLedger(bot.simulation?.path, from, now, now, b.id)
    return {
      bookId: b.id, band: `${b.minTaxBps}-${b.maxTaxBps} bps`,
      paper: (f?.paper.points ?? []).map((x: any) => ({ t: x.t, eth: x.eth })),
      market: (f?.market ?? []).map((x: any) => ({ t: x.t, sum: x.sum ?? null, recentSum: x.recentSum ?? null, fresh: x.fresh ?? false })),
      n: f?.paper.n ?? 0, wins: f?.paper.wins ?? 0,
    }
  })

  // WHICH GUARD IS ACTUALLY GATING ENTRIES, and how old the drawn tape is.
  //
  // The market pane draws the forward ledger's SCENARIO tape and prints the SCENARIO
  // thresholds whatever guard is live. On 2026-09-16 the bot was gated on the legacy
  // gatewatch sensor while this pane showed the scenario tape, frozen since 06:58, under
  // "pause below -1.00 / recover above +2.00" -- numbers the running guard does not use. A
  // stale tape drawn as live reads as an opinion, which is worse than no tape at all.
  const activeGuardId = liveConfig().venueExecutionScenarios ? 'conservative-paper'
    : liveConfig().venueFreshRecovery ? 'adaptive-shadow' : 'legacy'
  const lastMarketAt = market.reduce((a:number,p:any)=>p.sum==null?a:Math.max(a,p.t??0),0)
  const marketTape = {
    // the guard this pane's series belongs to, and the one entries are really gated on
    drawnGuard: 'conservative-paper', activeGuard: activeGuardId,
    /** true when the pane is drawing a guard that is NOT the one refusing entries */
    representsLiveGuard: activeGuardId === 'conservative-paper',
    lastSampleAt: lastMarketAt || null,
    ageMs: lastMarketAt ? Math.max(0, now - lastMarketAt) : null,
    /** a tape with no new sample for this long is stale whoever is reading it */
    staleAfterMs: STALE_MS,
    stale: lastMarketAt ? now - lastMarketAt > STALE_MS : true,
  }

  return {
    lookback: key, from, to: now, marketSource, simulationComparison, historyError:null,
    book: bookId, books: books.map((b)=>({id:b.id,band:`${b.minTaxBps}-${b.maxTaxBps} bps`})), compare,
    marketTape,
    marketPolicy:effectiveMarketPolicy(false,{window:15,off:-1.5,on:1,freshMs:10800000},observer?.policy??bot.executionScenarioPolicy?.()),
    simulationIdentity:{modelHash:forward?.latest.model??observer?.modelHash??null,configId:forward?.latest.config??observer?.configId??null,publicationAt:observer?.publicationAt??null,verified:false,validation:accounts.validation,coverageThrough:paper.coverage.through},
    historyDisplay:null, historicalBackfill:null,
    market, contributorTokens, marketEvents: forward?.events??adaptive.events, outcomes,
    // Where the recorder's own line starts, and how much of the drawn line was rebuilt.
    marketRecordedFrom:null,
    marketRebuilt: {points: spliced.points, spans: spliced.spans},
    marketCoverage: recordedMarket.coverage,
    recordedHalts: recordedMarket.halts, recordedStates: recordedMarket.states,
    wallet, paper:{...paper,segments:forward?.epochs??[]}, policy: accounts.policy, continuous: accounts.continuous,
    paperAccounts: accounts, paperComparison: accounts.comparison, selectedPaperAccount: 'continuous-scenario:p50-after',
    bucketMs: bucket,
    trades: trades.map((x) => ({
      t: x.t, usd: x.pnl == null ? null : round((x.pnl / 1e18) * ethUsd, 2), r: x.r,
      token: x.token as string, holdMs: x.hold_ms as number,
    })),
  }
}

/** the operator's stop, start and drawdown reset, decided in one pure function so it can be tested alone */
export function controlAction(
  action: unknown,
  state: { stopped: boolean; haltKind: HaltKind | null; open?: number; drawdownEth?: number },
): { do: 'stop' | 'start' | 'reset' | 'nothing'; code: number; why: string } {
  if (action !== 'stop' && action !== 'start' && action !== 'reset') {
    return { do: 'nothing', code: 400, why: 'action must be "stop", "start" or "reset"' }
  }
  if (action === 'stop') {
    if (state.stopped) return { do: 'nothing', code: 200, why: 'already stopped' }
    return { do: 'stop', code: 200, why: 'stopped from the dashboard' }
  }
  // THE DRAWDOWN RESET. Its refusals are not the start button's, so it gets its own branch
  // rather than a flag on that one: it is offered while the drawdown stop is the thing
  // holding, which is exactly when start is refused.
  if (action === 'reset') {
    // Flat is the epoch boundary's own precondition (telemetry/epoch.ts newEpoch), repeated
    // here so the page shows a sentence instead of a 500 from the transaction.
    if ((state.open ?? 0) > 0) {
      return { do: 'nothing', code: 409, why: `${state.open} open position(s): reset while flat` }
    }
    // 'drawdown' outranks 'stopped' in HALT_RANK, so a stop the operator placed themselves
    // does not block this; 'manual' and 'broken' do, and those are not theirs to wave away.
    if (state.haltKind && state.haltKind !== 'drawdown' && state.haltKind !== 'stopped') {
      return { do: 'nothing', code: 409, why: `${state.haltKind} is holding: reset the drawdown once that clears` }
    }
    if (!state.drawdownEth) return { do: 'nothing', code: 200, why: 'drawdown is already zero' }
    return { do: 'reset', code: 200, why: 'drawdown reset from the dashboard' }
  }
  if (!state.stopped) return { do: 'nothing', code: 200, why: 'not stopped' }
  // Anything stickier than the operator's own stop refuses the start, and says which. This
  // is the same rank rule RiskManager.resume enforces; it is repeated here only to give the
  // page a sentence to show instead of a silent no-op.
  if (state.haltKind !== 'stopped') {
    return { do: 'nothing', code: 409, why: `${state.haltKind} is holding: that one is not yours to lift` }
  }
  return { do: 'start', code: 200, why: 'automatic operation requested from the dashboard' }
}

/**
 * POST /api/control {"action":"stop"|"start"}.
 *
 * The reason this exists: HALT=1 in the file is the only stop the bot had, and reaching it
 * meant an ssh session. An operator who wants to stop NOW should not be waiting on a
 * round trip, and the alternative people actually reach for is `pm2 stop`, which kills the
 * exit managers and strands every open bag (see risk.ts haltPhase).
 *
 * It places its own halt kind, 'stopped', rather than 'manual'. That keeps the file's
 * HALT=1 as the one-way switch it has always been while giving the page a two-way control,
 * and it means the rank check refuses a start while a drawdown stop or a broken halt holds.
 */
function control(bot: Bot, req: http.IncomingMessage, res: http.ServerResponse): void {
  const reply = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    try { res.end(JSON.stringify(body)) } catch {}
  }
  const chunks: Buffer[] = []
  let size = 0
  req.on('data', (c: Buffer) => {
    size += c.length
    // a control body is a few dozen bytes; anything larger is not a control body
    if (size > 4096) { req.destroy(); return }
    chunks.push(c)
  })
  req.on('error', () => reply(400, { error: 'read failed' }))
  req.on('end', () => {
    try {
      let action: unknown = null
      try { action = (JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { action?: unknown }).action }
      catch { return reply(400, { error: 'body must be JSON' }) }
      const a = controlAction(action, {
        stopped: bot.risk.isHalted('stopped'), haltKind: bot.risk.haltKind,
        open: bot.risk.openCount,
        drawdownEth: Number(bot.risk.peakPnlWei - bot.risk.realizedPnlWei) / 1e18,
      })
      if (a.do === 'stop') bot.operatorStop(a.why)
      else if (a.do === 'start') a.why = bot.operatorStart(a.why)
      else if (a.do === 'reset') a.why = bot.operatorReset(a.why)
      invalidateState()
      reply(a.code, { ok: a.code === 200, halted: bot.risk.halted, haltKind: bot.risk.haltKind, why: a.why })
    } catch (e) {
      reply(500, { error: String(e) })
    }
  })
}

export function startDashboard(bot: Bot, port = Number(process.env.DASH_PORT ?? 8787)): http.Server {
  const server = http.createServer((req, res) => {
    // This server shares a process with the trading loop and there is no
    // uncaughtException handler, so EVERY branch here is wrapped. A bug in a page nobody
    // is looking at must never be able to take the bot down with it.
    // Serve an already-serialized body, gzipped when the client accepts it. The chart payload
    // is highly repetitive JSON and compresses about 7x, which is the single largest win
    // available on a tailnet link.
    const send = (body: Body) => {
      const wants = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
      const out = wants && body.gz ? body.gz : body.raw
      const head: Record<string, string> = {
        'content-type': 'application/json', 'cache-control': 'no-store',
        'content-length': String(out.length), vary: 'accept-encoding',
      }
      if (out === body.gz) head['content-encoding'] = 'gzip'
      res.writeHead(200, head)
      res.end(out)
    }
    const fail = (code: number, msg: string) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      try { res.end(JSON.stringify({ error: msg })) } catch {}
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = req.method ?? 'GET'
      // Methods are checked from 2026-09-07, when the first mutating route landed. Until
      // then nothing here looked at the verb at all, so a POST to /api/state returned the
      // JSON and a GET could have reached a control route by accident.
      if (url.pathname === '/api/control') {
        if (method !== 'POST') return fail(405, 'POST only')
        return control(bot, req, res)
      }
      if (method !== 'GET') return fail(405, 'GET only')
      // 1s memo: the payload only changes on that cadence anyway, and N open tabs used
      // to cost N full rebuilds per second inside the trading process
      // Serialized and gzipped once per TTL, like /api/chart. This route used to
      // re-stringify the whole payload per request, so N open tabs cost N stringifies a
      // second on the trading loop; a warm hit is now a socket write. 4.0x on the wire.
      if (url.pathname === '/api/state') return send(cachedBody('state', 1_000, () => snapshot(bot)))
      if (url.pathname === '/api/chart') {
        // Validate against the table rather than falling back silently. An unknown `h` used
        // to mint a permanent memo entry under its own key, so any URL anyone typed leaked a
        // full chart payload's worth of memory for the life of the process.
        const asked = url.searchParams.get('h') ?? '4h'
        const k = asked in LOOKBACKS ? asked : '4h'
        const historical=false
        // Same rule for the book, and for the same reason: `book` is part of the memo key, so
        // an unvalidated one lets any URL anyone types mint a permanent chart payload. Six
        // lookbacks x (books + 1 comparison) is the bound, and cachedBody now evicts on age.
        const askedBook = url.searchParams.get('book')
        const names = new Set(liveBooks().map((b) => b.id))
        const bookKey = askedBook === 'vs' ? 'vs' : askedBook && names.has(askedBook) ? askedBook : ''
        return send(cachedBody(`chart:${k}:${historical}:${bookKey}`, CHART_TTL_MS[k]!,
          () => chartSnapshot(bot, k, Date.now(), historical, bookKey || undefined)))
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(dashboardHtml())
    } catch (e) {
      try { res.writeHead(500); res.end(String(e)) } catch {}
    }
  })
  // Bound to loopback. The operator reaches it over the tailnet because `tailscale serve`
  // proxies https://<host>.ts.net/ to this port, so the tailnet IS the authentication
  // boundary for /api/control, and it is the only one. There is no token: the page would
  // hand any token it carried to whoever loaded the page.
  server.listen(port, '127.0.0.1', () => {
    console.log(`dashboard  http://localhost:${port}`)
  })
  server.on('error', (e) => console.error(`dashboard failed to start: ${e.message}`))
  return server
}
