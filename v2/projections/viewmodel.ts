/**
 * State plus history, turned into finished values for a renderer that computes nothing.
 *
 * THE RENDERER RECEIVES NO RAW NUMBERS. Every drawable field below is a `Shown<T>` or a `Bar`,
 * carrying its text, its tone, its age and its source, or the sentence explaining why there is
 * no value. That is the rule that keeps the page from acquiring its own opinion: a renderer
 * with a bare number has to decide how to colour it, and the moment it does, the display's
 * idea of "good" and the bot's rules start drifting apart with nothing to notice.
 *
 * TWO QUESTIONS, TWO SHAPES. "Is my money OK?" is answered once, by the wallet card, which is
 * the chain's number and is never split per book or rebased. "What did finished trades do in
 * this window?" is answered by walking the same close list: Total is every book, Virtual is
 * the selected book. Both start at 0 on the left of the lookback. Paper, Market and Coins
 * share that clock and keep their own meaning.
 *
 * IT CANNOT REACH A DECISION. `rings.test.ts` fails if anything in this directory imports
 * `core/decide` or its siblings, so every value here is read off folded state or counted by
 * `history.ts`. Nothing is re-derived.
 */
import { bookIds } from '../core/book.js'
import { graduationProgress, markToExit } from '../core/curve.js'
import { haltedFor, stoppedKey, walletHalted } from '../core/state.js'
import { LEVELS } from './levels.js'
import {
  absent, ago, bar, count, dayHhmm, eth, ethValue, fromSensed, hhmm, hhmmss, isoUtc,
  keptTone, mult, pct, secs, shortToken, shown, signTone, spentTone, stakes, usd,
  type Bar, type Shown, type Tone,
} from './format.js'
import type { ClosedTrade, Bucket, BookBucket, HaltStamp, History, ChartClose, ReadHealthRow } from './history.js'
import type { RefusalBucket } from '../core/contracts.js'
import {
  bookBaseCeilingWei, effectiveBookSizeWei, effectiveWalletDrawdownWei, MIN_BOOK_TRADE_SIZE_WEI,
  type BookSpec, type FrozenConfig,
} from '../core/config.js'
import type { Inflight, Position, State } from '../core/state.js'
import { sizedEntryWei, sizingReading } from '../core/sizing.js'
import type { CuReading } from '../io/cu.js'
import type { RpcRoutingStatus } from '../io/routing.js'

// ---------------------------------------------------------------------------
// What the caller supplies
// ---------------------------------------------------------------------------

/**
 * What this run cannot produce, and the sentence to show instead.
 *
 * `money` is our own fills and everything summed from them. `account` is the wallet balance,
 * which only exists if a balance read is on the tape. `paper` is the ungated sim of
 * the selected book (0 start, 0.02 ETH per scored launch). `truePeak` is the independent
 * observer's peak over its own window, which is what makes the kept bar mean anything.
 */
export type Capability = 'money' | 'account' | 'paper' | 'truePeak'
export type Unavailable = Partial<Record<Capability, string>>

export type ProjectOptions = {
  readonly unavailable: Unavailable
  /** ETH price for the dollar column, with its source. Null when nothing has supplied one. */
  readonly ethUsd: { readonly value: number; readonly source: string } | null
  /**
   * What the paid endpoint has cost this process, for the machine report. A METER, NEVER A GATE.
   *
   * It arrives as an option rather than being folded because no decision reads it: raising it as
   * an intent would put a new event in the stream and move the kernel id for a number that is
   * only ever displayed, which is the same reason the balance read is scheduled out of band.
   * `null` is a process that was given no meter, not a process that spent nothing.
   */
  readonly providerCu?: CuReading | null
  readonly rpcRouting?: RpcRoutingStatus | null
  /** when true the page offers Stop / Start / Reset. Only the live process sets this. */
  readonly canControl?: boolean
  /** which book's rolling table and per-book panes are drawn. Unknown or omitted falls back to a funded book. */
  readonly selectedBook?: string | null
  /** the lookback for Total wallet and History. Rolling always shows 1h / 4h / 12h beside each other. */
  readonly windowLabel?: string | null
  /** which book the exits table is filtered to, or null for all of them. */
  readonly exitsBook?: string | null
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * The windows the machine report offers. Unrelated to what the page draws: `/api/state` is a
 * pinned contract, and adding a column to the rolling table must not add a field the report
 * skill has never read.
 */
export const WINDOWS: readonly { readonly label: string; readonly ms: number }[] = [
  { label: '1h', ms: 3_600_000 },
  { label: '4h', ms: 14_400_000 },
  { label: '12h', ms: 43_200_000 },
  { label: '24h', ms: 86_400_000 },
  { label: '7d', ms: 604_800_000 },
]

/**
 * Paper wallet: what this book's policy would have made if it never sat out.
 *
 * Same scored launches as the market indicator, in ETH rather than a rolling twenty. Stakes
 * are already `mult - 1`, so `stakes * 0.02` is P&L of a 0.02 ETH trade. The path was walked
 * at `REPLAY_STAKE_ETH` (0.010) for impact; this scales the result and does not re-walk.
 */
export const PAPER_START_ETH = 0
export const PAPER_STAKE_ETH = 0.02

/**
 * Rolling performance: short beside long, which is the early warning.
 *
 * Copied from v1. 24h stays off this table because the calendar day already lives on the
 * wallet card; putting it here a second time is the same number twice.
 */
export const ROLLING_WINDOWS: readonly { readonly label: string; readonly ms: number }[] = [
  { label: '1h', ms: 3_600_000 },
  { label: '4h', ms: 14_400_000 },
  { label: '12h', ms: 43_200_000 },
]

/** History lookbacks, including the ones Rolling does not show. Default is 4h, as on v1. */
export const LOOKBACKS: readonly { readonly label: string; readonly ms: number; readonly bucketMs: number }[] = [
  { label: '1h', ms: 3_600_000, bucketMs: 120_000 },
  { label: '4h', ms: 14_400_000, bucketMs: 300_000 },
  { label: '12h', ms: 43_200_000, bucketMs: 900_000 },
  { label: '24h', ms: 86_400_000, bucketMs: 1_800_000 },
  { label: '3d', ms: 259_200_000, bucketMs: 7_200_000 },
  { label: '7d', ms: 604_800_000, bucketMs: 14_400_000 },
]

export const DEFAULT_LOOKBACK = LOOKBACKS[1]!

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

export type Point = { readonly at: number; readonly value: number | null }

/**
 * One History pane, already scaled in meaning: the browser only plots it.
 *
 * `stroke` is a tone the projection chose, not a colour the browser invents. `yDecimals` is
 * how many places the axis and the tooltip print, so the client never picks a precision.
 */
export type CoinBar = {
  readonly t: number
  readonly win: number
  readonly loss: number
  readonly pending: number
  readonly flat: number
  /** leftover of this book's launches after win/loss/pending/flat */
  readonly notSimulated: number
  /** launches this book did not take: `seen − launches`. v1's Filtered out. */
  readonly filtered: number
  readonly height: number
  readonly net: number | null
  readonly netText: string
  readonly stripTone: Tone
  readonly stripAlpha: number
}

export type ChartPane = {
  readonly id: 'wallet' | 'virtual' | 'paper' | 'market' | 'coins'
  readonly title: string
  readonly subtitle: string
  readonly missing: string | null
  readonly kind: 'line' | 'step' | 'bars' | 'stack'
  /** unix seconds, same length as `y`. uPlot's time scale. */
  readonly t: readonly number[]
  readonly y: readonly (number | null)[]
  readonly stroke: Tone
  readonly yDecimals: number
  readonly unit: string
  readonly rules: readonly { readonly label: string; readonly value: number; readonly stroke: Tone }[]
  /** coins pane only. Empty on the line panes. The drawer paints these; it does not classify. */
  readonly stack: readonly CoinBar[]
}

/** One closed trade, already sized and coloured for the money-pane dots. */
export type ChartTrade = {
  readonly t: number
  readonly tone: Tone
  readonly r: number
  readonly ring: boolean
  readonly token: string
  readonly book: string
  readonly pnlText: string
  readonly reason: string
}

/** A halt shade the drawer only paints. Stroke is a tone the projection already chose. */
export type ChartBand = {
  readonly from: number
  readonly to: number
  readonly stroke: Tone
}

export type ChartPayload = {
  readonly lookback: string
  readonly book: string | null
  /** unix seconds. The x range every pane is pinned to, even when a series is shorter. */
  readonly from: number
  readonly to: number
  /** unix seconds. Width of one coins bar, so the drawer never infers a bucket from the lookback. */
  readonly bucketSec: number
  /** written into the chart shell by the drawer; never baked into the shell HTML. */
  readonly bookHeader: string
  readonly trades: readonly ChartTrade[]
  readonly bands: readonly ChartBand[]
  readonly panes: readonly ChartPane[]
}

export type BookTab = {
  readonly id: string
  readonly funded: boolean
  readonly adjustable: boolean
  /** the effective stake: the lower of the book's declared size and the live switch. */
  readonly stakeEth: string
  readonly declaredEth: string
  readonly minimumEth: string
  readonly sizeSource: 'default' | 'book'
  readonly drawdownStakes: number
  readonly nextStakeEth: string
  readonly sizingMultiplier: string
  readonly sizingState: string
  readonly sizingWhy: string
  readonly sizingN: number
  readonly sizingRangeEth: string
  readonly state: Shown<string>
  readonly band: string
  readonly controlAction: 'start' | 'stop'
  readonly controlLabel: 'AUTO' | 'STOP'
}

export type KpiRow = {
  readonly key: string
  readonly label: string
  /** hidden until More metrics. The four default rows match v1. */
  readonly extra: boolean
  /** the P&L row: larger type, because that is the number the table exists to show. */
  readonly loud: boolean
  readonly cells: readonly Shown<number | string>[]
}

export type PositionView = {
  readonly id: string
  readonly openedText: string
  readonly book: string
  readonly token: string
  readonly curve: string
  readonly tokenText: string
  readonly tokenUrl: string
  readonly curveUrl: string
  readonly age: Shown<number>
  readonly hold: Bar
  readonly multiple: Shown<number>
  readonly takeProfit: Shown<number>
  readonly estimate: Shown<string>
  readonly pnl: Shown<string>
  readonly state: Shown<string>
  readonly stateDetail: string | null
  readonly canRetryExit?: boolean
  /** peak multiple, for the tooltip on current ×. Null when no entry mark exists. */
  readonly peakText: string | null
  /** fraction of sellable supply still on the curve. The v1 open card's "Supply left". */
  readonly supplyLeft: Shown<number>
}

export type ExitView = {
  readonly at: number
  readonly timeText: string
  readonly openedText: string
  readonly book: string
  readonly token: string
  readonly tokenText: string
  readonly pnlUsd: Shown<number>
  readonly pnlEth: Shown<string>
  readonly spendEth: Shown<string>
  readonly reason: string
  readonly reasonTone: Tone
  readonly hold: Shown<number>
  readonly takeProfit: Shown<number>
  readonly truePeak: Shown<number>
  readonly heldPeak: Shown<number>
  readonly exit: Shown<number>
  readonly kept: Bar
  readonly leftAfter: Shown<number>
  readonly proceedsEth: Shown<string>
  readonly detectToEntry: Shown<number>
  readonly devBuy: Shown<string>
  readonly exemptions: Shown<number>
  readonly taxBps: Shown<number>
  readonly tokenUrl: string
  readonly curveUrl: string
  readonly chartUrl: string
}

export type ViewModel = {
  readonly at: number
  readonly atText: string
  readonly seq: number
  readonly specVersion: number
  readonly kernelId: Shown<string>
  readonly mode: 'shadow' | 'live'
  readonly canControl: boolean
  readonly rpcRouting: RpcRoutingStatus | null

  /** when this tape starts, which is the zero every "since" on the page counts from */
  readonly zeroAt: number | null
  readonly zeroText: string

  readonly trading: {
    readonly state: Shown<string>
    readonly why: string
    /**
     * What the header button actually does. START lifts the dashboard stop; STOP ALL sets it.
     * This is the only operator off switch. There is no file halt.
     */
    readonly controlAction: 'start' | 'stop'
    readonly controlLabel: 'START' | 'STOP ALL'
    readonly open: Shown<number>
    readonly openLive: number
    readonly openStuck: number
    readonly openOpening: number
    readonly capacity: number
    /** header text: `1` when there is no slot ceiling, `1 / 14` when there is */
    readonly occupancy: string
    /** open-card text: `1` or `1 of 14` */
    readonly occupancyOf: string
    readonly size: Shown<string>
  }

  readonly streams: {
    readonly logs: Shown<string>
    readonly feed: Shown<string>
    readonly overlay: Shown<string>
    /** the sentence saying entries are refusing on plumbing, or null when they are not */
    readonly blocking: string | null
    readonly gaps: number
  }

  readonly booksDeclared: number
  readonly booksFunded: number

  /**
   * The chain's number, and the only one on the page that is not per book.
   *
   * Not rebased, not split, not summed from the books. The books' realized P&L and the
   * wallet's can legitimately differ by gas, and when they do the wallet is right.
   *
   * TWO NUMBERS, AND THEY ARE NOT THE SAME NUMBER. `eth`/`usd` are what the account holds on
   * chain, read from `eth_getBalance` and carrying the age of that read. `sinceZero*` are the
   * bot's cumulative booked P&L, which is what the drawdown stop reads. Until 2026-09-16 the
   * card showed P&L under the heading "TOTAL REAL WALLET / chain, not rebased" and there was
   * no balance read in the process at all, so the headline figure did not move when gas was
   * burnt, when ETH was deposited, or while a position was still held as tokens.
   */
  readonly wallet: {
    readonly eth: Shown<string>
    readonly usd: Shown<number>
    readonly sinceZeroEth: Shown<string>
    readonly sinceZeroUsd: Shown<number>
    readonly closed: Shown<number>
    readonly winPct: Shown<number>
    readonly drawdown: Bar
    readonly drawdownText: string
  }

  /** History lookback labels, for the 1h…7d buttons on Total wallet. */
  readonly lookbacks: readonly string[]
  readonly lookback: string
  readonly rollingWindows: readonly string[]
  readonly kpis: readonly KpiRow[]

  readonly bookTabs: readonly BookTab[]
  readonly selectedBook: string | null
  /** the one-line description of the selected book's policy, above its charts */
  readonly bookHeader: string
  /** booked closes of every book, above the book tabs. A book click must not change it. */
  readonly walletPayload: ChartPayload
  readonly chartPayload: ChartPayload

  readonly positions: readonly PositionView[]

  readonly exits: readonly ExitView[]
  readonly exitsBook: string | null
  readonly exitsMissing: string | null
  /** `Max 45s` when every visible book shares one hold clock; `Max` when they do not. */
  readonly exitsMaxHoldLabel: string
  /** false when this process was given no ETH price, so dollar cells must not render */
  readonly hasUsd: boolean

  /** each missing capability, once, so a dependent cell can draw a marker and not a paragraph */
  readonly notices: readonly { readonly id: Capability; readonly reason: string }[]
  /** bps that no declared band claims. Null when the bands tile the screened range. */
  readonly unrouted: string | null

  /**
   * What the chain reads are costing, per kind, busiest first. A METER AND NEVER A GATE.
   *
   * Here because the failure it watches for is one v1 was blind to twice: reads that quietly start
   * failing or slowing while the log stream keeps flowing, so the book reads as a quiet market
   * rather than a broken endpoint. 962 launches went that way in a single day. See `ReadHealthRow`
   * for the two windows and for what it deliberately cannot see.
   */
  readonly readHealth: readonly ReadHealthRow[]
}

// ---------------------------------------------------------------------------
// project
// ---------------------------------------------------------------------------

export function project(state: State, history: History, opts: ProjectOptions): ViewModel {
  const now = state.at
  const cfg = state.config
  const ids = bookIds(cfg)
  const cov = history.coverage
  const moneyGone = opts.unavailable.money ?? null
  const accountGone = opts.unavailable.account ?? null
  const paperGone = opts.unavailable.paper ?? null
  const peakGone = opts.unavailable.truePeak ?? null

  const lookback = LOOKBACKS.find((w) => w.label === opts.windowLabel) ?? DEFAULT_LOOKBACK
  // The x-axis is the lookback, always. Clamping it to tape coverage made a 7d view (4-hour
  // coins buckets) sit on a four-hour axis, so two bars filled the pane and overlapped.
  // Minute buckets are still fetched only for the tape we have: materialising 10,080 empty
  // minutes on every push is the cost that clamp was paying for.
  const chartFrom = now - lookback.ms
  const dataFrom = Math.max(cov.from ?? chartFrom, chartFrom)
  const buckets = history.window(dataFrom, now)
  // Paper walks kept minutes only. Evicted stakes live in `equityPrefix`, so a 1h paper
  // view does not rebase to a fresh account. Total and Virtual walk the close list for
  // this window and start at 0, so they do not read that prefix.
  const paperFrom = history.keptFrom ?? cov.from ?? chartFrom
  const paperBuckets = history.window(paperFrom, now)
  const exitsAll = history.recentExits()
  const closes = history.tradesIn(chartFrom, now)

  const open = [...state.positions.values()].filter((p) => !p.closed)
  const filledOpen = open.filter((p) => p.filled !== false)
  const heldTokens = new Set(open.map((p) => p.token))
  const opening = openingBuys(state).filter((f) => !heldTokens.has(f.token))
  const capacity = cfg.risk.maxConcurrent

  const funded = ids.filter((id) => isFunded(cfg.books.find((b) => b.id === id)!, state))
  const asked = opts.selectedBook && ids.includes(opts.selectedBook) ? opts.selectedBook : null
  const enterable = funded.find((id) => canEnter(cfg.books.find((b) => b.id === id)!, state))
  const selectedBook = asked ?? enterable ?? funded[0] ?? ids[0] ?? null
  const selectedSpec = selectedBook === null ? null : cfg.books.find((b) => b.id === selectedBook) ?? null
  const bookHeader = selectedSpec === null ? 'no books are declared' : headerOf(selectedSpec, state, buckets)

  // ---- the trading strip ----
  // WALLET-WIDE ONLY. A venue pause is scoped to one book; putting the first halt in the
  // map here painted the whole bot STOPPED whenever untaxed shut, and the header button
  // keyed off `value === 'halted'` (file HALT only), so it showed STOP ALL. Clicking it
  // then stopped taxed too, which was still open. 2026-09-17, 06:07 UTC.
  const halt = walletHalted(state.risk)
  const tradingState = halt
    ? shown({ value: halt.kind, text: halt.kind === 'stopped' ? 'STOPPED' : halt.kind === 'broken' ? 'WALLET SAFETY STOP' : `halted · ${halt.kind}`, tone: 'bad' })
    : shown({ value: 'normal', text: 'trading', tone: 'good' })
  const why = halt?.kind === 'broken' ? 'Actual returns fell below the replay benchmark. New buys are paused across all books.' : halt ? halt.reason : 'no halt in force'
  const dashboardStopped = state.risk.halts.has(stoppedKey(null))
  const controlAction: ViewModel['trading']['controlAction'] = dashboardStopped ? 'start' : 'stop'
  const controlLabel: ViewModel['trading']['controlLabel'] = dashboardStopped ? 'START' : 'STOP ALL'
  const stuckN = filledOpen.filter(bagStuck).length
  const liveN = filledOpen.length - stuckN
  const openingN = opening.length + (open.length - filledOpen.length)
  const occupied = filledOpen.length + openingN
  const openText = occupancyText(openingN, liveN, stuckN, filledOpen.length)

  return {
    at: now,
    atText: hhmmss(now),
    seq: state.seq,
    specVersion: cfg.specVersion,
    kernelId: state.kernelId
      ? shown({ value: state.kernelId, text: state.kernelId.slice(0, 12), source: 'fold' })
      : absent<string>('this tape has not been certified, so there is no kernel id to show', 'uncertified'),
    mode: state.switches.mode,
    canControl: Boolean(opts.canControl),
    rpcRouting: opts.rpcRouting ?? null,

    zeroAt: cov.from,
    zeroText: cov.from === null ? 'nothing folded yet' : dayHhmm(cov.from),

    trading: {
      state: tradingState,
      why,
      controlAction,
      controlLabel,
      open: shown({
        value: occupied,
        text: openText,
        tone: capacity > 0 && occupied / capacity >= LEVELS.capacityWarnFraction ? 'warn' : 'plain',
      }),
      openLive: liveN,
      openStuck: stuckN,
      openOpening: openingN,
      capacity,
      occupancy: capacity > 0 ? `${openText} / ${capacity}` : openText,
      occupancyOf: capacity > 0 ? `${openText} of ${capacity}` : openText,
      size: shown({ value: eth(state.switches.sizeWei, false), text: `${eth(state.switches.sizeWei, false)} ETH`, source: 'switch' }),
    },

    streams: streamsOf(state, selectedBook),
    booksDeclared: ids.length,
    booksFunded: funded.length,

    wallet: walletOf(state, history, opts, now, accountGone, moneyGone),

    lookbacks: LOOKBACKS.map((w) => w.label),
    lookback: lookback.label,
    rollingWindows: ROLLING_WINDOWS.map((w) => w.label),
    kpis: selectedBook === null ? [] : rollingOf(history, now, selectedBook, opts, moneyGone),

    bookTabs: ids.map((id) => tabOf(cfg.books.find((b) => b.id === id)!, state)),
    selectedBook,
    bookHeader,
    walletPayload: walletPayloadOf(closes, chartFrom, now, lookback, opts.ethUsd),
    chartPayload: chartPayloadOf(
      selectedSpec, buckets, paperBuckets, chartFrom, now, lookback, selectedBook,
      { paperGone }, bookHeader,
      closes, opts.ethUsd,
      selectedBook === null ? 0 : history.equityPrefix(selectedBook).stakes,
    ),

    positions: [
      ...opening
        .sort((a, b) => (b.signedAt || now) - (a.signedAt || now))
        .map((f) => openingOf(f, state, opts)),
      ...open
        .sort((a, b) => b.openedAt - a.openedAt)
        .map((p) => positionOf(p, state, opts)),
    ],

    exits: exitsAll
      .filter((t) => opts.exitsBook === null || opts.exitsBook === undefined || t.book === opts.exitsBook)
      .map((t) => exitOf(t, opts, peakGone)),
    exitsBook: opts.exitsBook ?? null,
    exitsMissing: moneyGone ?? (exitsAll.length === 0 ? 'nothing has closed on this tape yet' : null),
    exitsMaxHoldLabel: maxHoldLabel(cfg, opts.exitsBook ?? null),
    hasUsd: opts.ethUsd !== null,

    notices: (['money', 'account', 'paper', 'truePeak'] as const)
      .flatMap((id) => (opts.unavailable[id] ? [{ id, reason: opts.unavailable[id]! }] : [])),
    unrouted: unroutedBands(state),
    readHealth: history.readHealth(),
  }
}

// ---------------------------------------------------------------------------
// The strip
// ---------------------------------------------------------------------------

function streamsOf(state: State, selectedBook: string | null): ViewModel['streams'] {
  const now = state.at
  const cfg = state.config

  const logs = fromSensed<boolean, string>(
    now, state.sensors.logsHealthy,
    (v) => ({ value: v ? 'healthy' : 'unhealthy', text: v ? 'healthy' : 'UNHEALTHY', tone: v ? 'good' : 'bad' }),
    'the log stream has never reported. Entries refuse while its health is unknown.',
    'never reported',
  )
  const feed = fromSensed<boolean, string>(
    now, state.sensors.feedConnected,
    (v) => ({ value: v ? 'connected' : 'disconnected', text: v ? 'connected' : 'DISCONNECTED', tone: v ? 'good' : 'warn' }),
    'the sequencer feed has never reported.',
    'never reported',
  )
  const overlay = state.overlayAt === null
    ? absent<string>('there is no usable feed overlay. The entry price is confirmed logs plus overlay, so without it that is a different quantity and entries refuse.', 'none')
    : shown({
      value: 'live',
      text: ago(now - state.overlayAt),
      tone: now - state.overlayAt > cfg.risk.maxOverlayAgeMs ? 'warn' : 'good',
      at: state.overlayAt,
      ageMs: now - state.overlayAt,
      source: 'feed',
    })

  // Plumbing first, then why the selected book still cannot enter: the same folded flags
  // decide already wrote. Do not re-import risk.ts.
  const blocking =
    state.sensors.logsHealthy === null ? 'entries refuse: log health unknown'
      : !state.sensors.logsHealthy.value ? 'entries refuse: logs unhealthy'
        : now - state.sensors.logsHealthy.at > cfg.risk.maxLogsStalenessMs ? 'entries refuse: logs stale'
          : state.overlayAt === null ? 'entries refuse: no overlay'
            : now - state.overlayAt > cfg.risk.maxOverlayAgeMs ? 'entries refuse: overlay stale'
              : selectedCannotEnter(state, selectedBook)

  return { logs, feed, overlay, blocking, gaps: state.gaps.length }
}

function selectedCannotEnter(state: State, selectedBook: string | null): string | null {
  const wallet = walletHalted(state.risk)
  if (wallet) return wallet.kind === 'broken' ? 'new buys paused: wallet execution-gap check' : `entries refuse: ${wallet.kind}`
  if (selectedBook !== null) {
    const h = haltedFor(state.risk, selectedBook)
    if (h) return `entries refuse: ${selectedBook} ${h.kind}`
  }
  const cap = state.config.risk.maxConcurrent
  if (cap > 0 && state.risk.reserved >= cap) {
    return `entries refuse: ${state.risk.reserved} of ${cap} slots`
  }
  return null
}

// ---------------------------------------------------------------------------
// The wallet, which never splits
// ---------------------------------------------------------------------------

function walletOf(
  state: State, history: History,
  opts: ProjectOptions, now: number,
  accountGone: string | null, moneyGone: string | null,
): ViewModel['wallet'] {
  const realized = state.risk.walletRealizedWei
  const peak = state.risk.walletPeakWei
  const stop = effectiveWalletDrawdownWei(state.config, state.switches)
  const dd = peak - realized < 0n ? 0n : peak - realized
  const frac = stop > 0n ? Number((dd * 1000n) / stop) / 1000 : 0

  /**
   * Since zero means since zero, so these are the lifetime counters and not the trade list.
   *
   * The list is capped at 40 whole trades for the exits table. Counting it here meant the card
   * read "40 closed" from trade 41 onward, with a win rate over the last 40 under a label that
   * says "since zero".
   */
  const totals = history.totals
  const winPct = totals.closed > 0 ? (100 * totals.wins) / totals.closed : null

  /**
   * What the account holds, from the chain, or the sentence saying why nobody asked.
   *
   * `state.walletBalance` is null until the first chain read, so it has no
   * address, so there is nothing to ask about. That is the honest answer and it is why this
   * declares `account` unavailable rather than printing a zero or, as it did until
   * 2026-09-16, printing booked P&L under a heading that said "chain".
   */
  const bal = state.walletBalance
  const balanceGone = accountGone ?? (bal === null
    ? 'no balance has been read yet: this process has no key, so it has no address to ask about'
    : null)
  const equity = bal === null || balanceGone !== null
    ? absent<string>(balanceGone ?? 'no balance read', 'no balance read')
    : shown({
      value: eth(bal.value, false), text: `${eth(bal.value, false)} ETH`, tone: 'plain',
      at: bal.at, ageMs: now - bal.at, source: 'chain',
    })

  return {
    eth: equity,
    usd: bal === null || balanceGone !== null
      ? absent<number>(balanceGone ?? 'no balance read', 'no balance read')
      : opts.ethUsd === null
        ? absent<number>('no ETH price has been supplied to this process, so there is no dollar column')
        : shown({
          value: ethValue(bal.value) * opts.ethUsd.value,
          text: usd(ethValue(bal.value) * opts.ethUsd.value, false),
          at: bal.at, ageMs: now - bal.at, source: 'projection',
        }),
    sinceZeroEth: moneyGone
      ? absent<string>(moneyGone)
      : shown({ value: eth(realized), text: `${eth(realized)} ETH`, tone: signTone(realized), source: 'fold' }),
    sinceZeroUsd: opts.ethUsd === null
      ? absent<number>('no ETH price has been supplied to this process, so there is no dollar column')
      : shown({ value: ethValue(realized) * opts.ethUsd.value, text: usd(ethValue(realized) * opts.ethUsd.value), tone: signTone(realized), source: 'projection' }),
    closed: shown({ value: totals.closed, text: String(totals.closed), source: 'fold' }),
    winPct: winPct === null
      ? absent<number>('nothing has closed on this tape yet', 'no closes')
      : shown({ value: winPct, text: pct(winPct), tone: winPct >= LEVELS.winRateGoodPct ? 'good' : 'warn', n: totals.closed, source: 'fold' }),
    drawdown: stop > 0n
      ? bar(frac, `${eth(dd, false)} of ${eth(stop, false)}`, spentTone(frac, LEVELS.drawdownWarnFraction, LEVELS.drawdownCritFraction))
      : bar(null, 'no wallet stop declared', 'muted', 'the spec declares no wallet drawdown stop'),
    drawdownText: `${eth(dd, false)} / ${eth(stop, false)} ETH`,
  }
}

/**
 * One walk for Paper: same buckets, same clip, same first timestamp.
 *
 * Starts at 0 plus whatever already left the History ring. Adds each minute's step
 * before deciding whether the point is inside the lookback, so a 1h view does not rebase
 * to 0. RESET DD zeros the risk ledger and must not rewind this line. Total and Virtual
 * do not use this: they walk the close list for the window and start at 0.
 */
function equityPoints(
  buckets: readonly Bucket[],
  book: string,
  from: number,
  to: number,
  startEth: number,
  step: (x: BookBucket) => number,
): Point[] {
  let eq = startEth
  const out: Point[] = []
  for (const b of buckets) {
    const x = b.books.get(book)
    if (x) eq += step(x)
    if (b.at < from || b.at > to) continue
    out.push({ at: b.at, value: eq })
  }
  return out
}

function paperPoints(
  buckets: readonly Bucket[], book: string, from: number, to: number, prefixStakes: number,
): Point[] {
  return equityPoints(
    buckets, book, from, to,
    PAPER_START_ETH + prefixStakes * PAPER_STAKE_ETH,
    (x) => (x.scored > 0 ? x.stakes * PAPER_STAKE_ETH : 0),
  )
}

/**
 * Booked P&L of the closes in this window, from 0 at the left edge.
 *
 * `book` null is Total (every policy). One book is Virtual. The line is the dots, summed:
 * a close outside the window is not an invisible offset. RESET DD is not read.
 */
function closesPoints(
  closes: readonly ChartClose[],
  book: string | null,
  from: number,
  to: number,
): Point[] {
  const mine = closes
    .filter((c) => c.at >= from && c.at <= to && (book === null || c.book === book))
    .slice()
    .sort((a, b) => a.at - b.at || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0))
  const out: Point[] = [{ at: from, value: 0 }]
  let eq = 0
  for (const c of mine) {
    eq += ethValue(c.pnlWei)
    out.push({ at: c.at, value: eq })
  }
  if (out[out.length - 1]!.at < to) out.push({ at: to, value: eq })
  return out
}

/**
 * Halt shade for the selected book. Drawdown red, venue amber, file/dashboard/broken grey.
 *
 * Gap minutes carry the last real stamps. A stamp scoped to another book does not paint.
 */
function virtualBands(buckets: readonly Bucket[], book: string, from: number, to: number): ChartBand[] {
  let last: HaltStamp[] = []
  let run: { stroke: Tone; from: number } | null = null
  const out: ChartBand[] = []
  const flush = (at: number): void => {
    if (run === null) return
    out.push({ from: run.from / 1000, to: at / 1000, stroke: run.stroke })
    run = null
  }
  for (const b of buckets) {
    if (b.haltStamps !== null) last = b.haltStamps
    if (b.at < from) continue
    if (b.at > to) break
    const stroke = paintOf(last, book)
    if (stroke === null) {
      flush(b.at)
      continue
    }
    if (run !== null && run.stroke === stroke) continue
    flush(b.at)
    run = { stroke, from: b.at }
  }
  flush(to)
  return out
}

/** Drawdown of this book (or wallet-wide) wins, else its venue, else any wallet-wide/file stamp. */
function paintOf(stamps: readonly HaltStamp[], book: string): Tone | null {
  const mine = stamps.filter((h) => h.book === null || h.book === book)
  if (mine.some((h) => h.kind === 'drawdown')) return 'bad'
  if (mine.some((h) => h.kind === 'venue')) return 'warn'
  if (mine.length > 0) return 'muted'
  return null
}

// ---------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------

function isFunded(spec: BookSpec, state: State): boolean {
  return effectiveBookSizeWei(spec, state.switches) > 0n
}

function canEnter(spec: BookSpec, state: State): boolean {
  if (!isFunded(spec, state)) return false
  if (haltedFor(state.risk, spec.id) !== null) return false
  return true
}

function stakeWei(spec: BookSpec, state: State): bigint {
  return effectiveBookSizeWei(spec, state.switches)
}

function bandOf(spec: BookSpec): string {
  return `${spec.minCreatorTaxBps}–${spec.maxCreatorTaxBps} bps`
}

function tabOf(spec: BookSpec, state: State): BookTab {
  const h = haltedFor(state.risk, spec.id)
  const funded = isFunded(spec, state)
  const bookStopped = state.risk.halts.has(stoppedKey(spec.id))
  const override = state.switches.bookSizes?.get(spec.id)
  const base = stakeWei(spec, state)
  const sizing = sizingReading(state, spec)
  const next = sizedEntryWei(base, sizing, state.config.risk.maxTradeSizeWei)
  const weak = (base * BigInt(spec.sizing?.enabled ? spec.sizing.weakBps : 10_000)) / 10_000n
  const strong = (base * BigInt(spec.sizing?.enabled ? spec.sizing.strongBps : 10_000)) / 10_000n
  return {
    id: spec.id,
    funded,
    adjustable: BigInt(spec.sizeWei) > 0n,
    stakeEth: eth(stakeWei(spec, state), false),
    declaredEth: eth(bookBaseCeilingWei(spec), false),
    minimumEth: eth(MIN_BOOK_TRADE_SIZE_WEI, false),
    sizeSource: override ? 'book' : 'default',
    drawdownStakes: state.config.risk.drawdownStakes,
    nextStakeEth: eth(next, false),
    sizingMultiplier: `${(sizing.multiplierBps / 10_000).toFixed(2)}x`,
    sizingState: sizing.state,
    sizingWhy: sizing.why,
    sizingN: sizing.n,
    sizingRangeEth: `${eth(weak, false)}–${eth(strong, false)}`,
    state: h
      ? shown({ value: h.kind, text: h.kind === 'broken' ? 'WALLET SAFETY STOP' : h.kind.toUpperCase(), tone: 'bad' })
      : funded
        ? shown({ value: 'trading', text: 'trading', tone: 'good' })
        : shown({ value: 'unfunded', text: 'size 0', tone: 'muted' }),
    band: bandOf(spec),
    controlAction: bookStopped ? 'start' : 'stop',
    controlLabel: bookStopped ? 'AUTO' : 'STOP',
  }
}

/** The selected book's policy, in one line, so the charts below it are never ambiguous. */
function headerOf(spec: BookSpec, state: State, buckets: readonly Bucket[]): string {
  const v = state.sensors.venue.get(spec.id)
  const b = state.sensors.bars.get(spec.id)
  const agg = sumBook(buckets, spec.id)
  const venueText = v
    ? `venue ${stakes(v.value.sumStakes)} ${v.value.fresh ? (v.value.open ? 'OPEN' : 'SHUT') : 'STALE'}`
    : 'venue never read'
  const tpText = b && b.value.ready ? `TP ${mult(b.value.multiple)}` : 'TP not ready'
  return `${spec.id} · ${bandOf(spec)} · exempt ≥${spec.minExemptions} · ${venueText} · ${tpText} · ${agg.closed} closed`
}

type Agg = {
  launches: number; decided: number; entered: number; closed: number; wins: number
  pnlWei: bigint; spendWei: bigint; tpClosed: number; sendFailed: number; scored: number; stakes: number
}

const emptyAgg = (): Agg => ({
  launches: 0, decided: 0, entered: 0, closed: 0, wins: 0,
  pnlWei: 0n, spendWei: 0n, tpClosed: 0, sendFailed: 0, scored: 0, stakes: 0,
})

function sumBook(buckets: readonly Bucket[], id: string): Agg {
  const a: Agg = emptyAgg()
  for (const b of buckets) {
    const x = b.books.get(id)
    if (!x) continue
    a.launches += x.launches; a.decided += x.decided; a.entered += x.entered
    a.closed += x.closed; a.wins += x.wins; a.pnlWei += x.pnlWei; a.spendWei += x.spendWei
    a.tpClosed += x.tpClosed; a.sendFailed += x.sendFailed; a.scored += x.scored; a.stakes += x.stakes
  }
  return a
}

// ---------------------------------------------------------------------------
// Rolling: metric rows, 1h / 4h / 12h columns, one selected book
// ---------------------------------------------------------------------------

/**
 * Counted from the minute buckets, never from the capped trade list.
 *
 * `history.recentExits()` is 40 whole trades for the exits table. Using it here is how a
 * busy hour reported "40" under a heading that said 12h. The buckets have counted every
 * close for seven days the whole time.
 */
function rollingOf(
  history: History, now: number, book: string, opts: ProjectOptions, moneyGone: string | null,
): KpiRow[] {
  const per = ROLLING_WINDOWS.map((w) => sumBook(history.window(now - w.ms, now), book))

  const cell = (
    w: Agg,
    draw: (w: Agg) => Shown<number | string>,
  ): Shown<number | string> => draw(w)

  const closedCell = (w: Agg, draw: (w: Agg) => Shown<number | string>): Shown<number | string> => {
    if (moneyGone) return absent(moneyGone, '–')
    if (w.closed === 0) return absent('nothing closed in this window', '–')
    return draw(w)
  }

  const row = (
    key: string, label: string, extra: boolean, loud: boolean,
    each: (w: Agg) => Shown<number | string>,
  ): KpiRow => ({ key, label, extra, loud, cells: per.map(each) })

  return [
    row('n', 'closed', false, false, (w) => cell(w, (x) => shown({ value: x.closed, text: count(x.closed), source: 'fold' }))),
    row('pnlUsd', 'P&L', false, true, (w) => closedCell(w, (x) => {
      if (opts.ethUsd === null) {
        return shown({ value: eth(x.pnlWei), text: eth(x.pnlWei), tone: signTone(x.pnlWei) })
      }
      const dollars = ethValue(x.pnlWei) * opts.ethUsd.value
      return shown({ value: dollars, text: usd(dollars), tone: signTone(x.pnlWei), n: x.closed })
    })),
    row('rotPct', 'return on turnover', false, true, (w) => closedCell(w, (x) => {
      const r = rotationPct(x.pnlWei, x.spendWei)
      if (r === null) return absent('no stake was put on in this window', '–')
      return shown({ value: r, text: pct(r, true), tone: signTone(r), n: x.closed })
    })),
    row('winRate', 'win rate', false, false, (w) => closedCell(w, (x) => {
      const p = (100 * x.wins) / x.closed
      return shown({ value: p, text: pct(p), tone: p >= LEVELS.winRateGoodPct ? 'good' : 'warn', n: x.closed })
    })),
    row('launches', 'launches seen', true, false, (w) => cell(w, (x) => shown({ value: x.launches, text: count(x.launches), source: 'fold' }))),
    row('replay', 'replay, stakes/launch', true, false, (w) => {
      if (w.scored === 0) return absent('no launch has been replayed in this window', '–')
      const avg = w.stakes / w.scored
      return shown({ value: avg, text: avg.toFixed(3), n: w.scored, source: 'fold', tone: signTone(avg) })
    }),
    row('entered', 'entered', false, false, (w) => cell(w, (x) => shown({ value: x.entered, text: count(x.entered), source: 'fold' }))),
    row('popRate', 'pop rate (took profit)', true, false, (w) => closedCell(w, (x) => {
      const p = (100 * x.tpClosed) / x.closed
      return shown({ value: p, text: pct(p), n: x.closed })
    })),
  ]
}

/**
 * Portfolio return: sum pnl / sum spend, as a percent.
 *
 * Scaled on the bigint first so a window of many closes cannot lose the ratio in float64
 * before it is a percentage. Null when nothing was staked, which is not the same as 0%.
 */
function rotationPct(pnl: bigint, spend: bigint): number | null {
  if (spend <= 0n) return null
  return Number((pnl * 10_000n) / spend) / 100
}

// ---------------------------------------------------------------------------
// Positions and exits
// ---------------------------------------------------------------------------

function bagStuck(p: Position): boolean {
  if (p.filled === false) return false
  if (p.inflightIntentId !== null) return false
  if ((p.sellReceipts?.size ?? 0) > 0) return false
  return p.approval?.gaveUp === true || p.grad?.gaveUp === true || p.attempts >= p.rules.maxSellAttempts || p.tokensHeld === 0n
}

function openingBuys(state: State): Extract<Inflight, { kind: 'buy' }>[] {
  const out: Extract<Inflight, { kind: 'buy' }>[] = []
  for (const f of state.inflight.values()) {
    if (f.kind === 'buy') out.push(f)
  }
  return out
}

function occupancyText(openingN: number, liveN: number, stuckN: number, openN: number): string {
  const bits: string[] = []
  if (openingN > 0) bits.push(`${openingN} opening`)
  if (stuckN > 0) {
    bits.push(`${liveN} live`)
    bits.push(`${stuckN} stuck`)
  } else if (openN > 0) {
    bits.push(String(openN))
  }
  return bits.length > 0 ? bits.join(' · ') : '0'
}

function holdBarOf(ageMs: number, maxHoldMs: number): Bar {
  if (maxHoldMs <= 0) return bar(null, '–', 'muted', 'this position has no hold clock')
  const fraction = ageMs / maxHoldMs
  return bar(
    fraction,
    `${secs(ageMs)} of ${secs(maxHoldMs)}`,
    spentTone(fraction, LEVELS.holdWarnFraction, LEVELS.holdCritFraction),
  )
}

function positionStateOf(p: Position): Shown<string> {
  if (p.filled === false) return shown({ value: 'opening', text: 'opening', tone: 'warn' })
  if (p.exitRecovery) return shown({value:'recovery',text:'checking wallet',tone:'warn'})
  if (p.approval && !p.approval.ready && p.venue === 'curve') {
    return shown({ value: 'approval', text: p.approval.gaveUp ? 'approval failed' : 'approval pending', tone: p.approval.lastError ? 'bad' : 'warn' })
  }
  if (p.inflightIntentId) return shown({ value: 'selling', text: 'selling', tone: 'warn' })
  if ((p.sellReceipts?.size ?? 0) > 0) return shown({ value: 'settling', text: 'checking sale', tone: 'warn' })
  if (p.grad?.gaveUp === true || p.attempts >= p.rules.maxSellAttempts) {
    return shown({ value: 'stuck', text: 'stuck', tone: 'bad' })
  }
  if (p.venue === 'graduated') return shown({ value: 'graduating', text: 'graduating', tone: 'warn' })
  if (p.tokensHeld === 0n) return shown({ value: 'empty', text: 'empty', tone: 'bad' })
  return shown({ value: 'held', text: 'held', tone: 'plain' })
}

function currentMultipleOf(p: Position, state: State, opts: ProjectOptions): {
  multiple: Shown<number>
  peakText: string | null
  pnl: Shown<string>
} {
  const noPnl = (why: string): Shown<string> => (
    opts.unavailable.money ? absent<string>(opts.unavailable.money) : absent<string>(why, '–')
  )
  if (p.entryMarkWei <= 0n) {
    return {
      multiple: absent<number>('this position has no entry mark on the tape, so a multiple cannot be formed', '–'),
      peakText: null,
      pnl: noPnl('this position has no entry mark on the tape, so a return cannot be formed'),
    }
  }
  const peak = Number((p.peakMarkWei * 10_000n) / p.entryMarkWei) / 10_000
  const peakText = `peak ${mult(peak)}`
  if (p.tokensHeld === 0n) {
    return {
      multiple: absent<number>(`this position holds no tokens, so a current mark cannot be formed (${peakText})`, '–'),
      peakText,
      pnl: noPnl(`this position holds no tokens, so a current mark cannot be formed (${peakText})`),
    }
  }
  const curve = state.curves.get(p.curve)
  if (!curve) {
    return {
      multiple: absent<number>(`no curve is on the tape for this position, so a current mark cannot be formed (${peakText})`, '–'),
      peakText,
      pnl: noPnl(`no curve is on the tape for this position, so a current mark cannot be formed (${peakText})`),
    }
  }
  const mark = markToExit(curve.params, curve.working, p.tokensHeld)
  const multiple = Number((mark * 10_000n) / p.entryMarkWei) / 10_000
  const pnlWei = mark - p.spendWei
  return {
    multiple: shown({ value: multiple, text: mult(multiple), tone: multiple >= 1 ? 'good' : 'bad', source: 'fold' }),
    peakText,
    pnl: opts.unavailable.money
      ? absent<string>(opts.unavailable.money)
      : shown({ value: eth(pnlWei), text: `${eth(pnlWei)} ETH`, tone: signTone(pnlWei), source: 'fold' }),
  }
}

function positionLinks(token: string, curve: string): Pick<PositionView, 'tokenText' | 'tokenUrl' | 'curveUrl'> {
  return {
    tokenText: shortToken(token),
    tokenUrl: `${EXPLORER}/token/${token}`,
    curveUrl: `${EXPLORER}/address/${curve}`,
  }
}

function openingOf(f: Extract<Inflight, { kind: 'buy' }>, state: State, opts: ProjectOptions): PositionView {
  const now = state.at
  const signed = f.signedAt > 0
  const ageMs = signed ? now - f.signedAt : 0
  const why = 'this buy has not filled, so there is no mark yet'
  return {
    id: f.intentId,
    openedText: hhmmss(signed ? f.signedAt : now),
    book: f.book,
    token: f.token,
    curve: f.curve,
    ...positionLinks(f.token, f.curve),
    age: shown({ value: ageMs, text: secs(ageMs), tone: 'warn' }),
    hold: holdBarOf(ageMs, f.rules.maxHoldMs),
    multiple: absent<number>(why, '–'),
    takeProfit: pinnedTpOf(absent<number>(why, '–'), f.rules.takeProfitMultiple),
    estimate: opts.unavailable.money
      ? absent<string>(opts.unavailable.money)
      : shown({ value: eth(f.sizeWei, false), text: `${eth(f.sizeWei, false)} ETH`, source: 'fold' }),
    pnl: opts.unavailable.money ? absent<string>(opts.unavailable.money) : absent<string>(why, '–'),
    state: shown({ value: signed ? 'opening' : 'signing', text: signed ? 'opening' : 'signing', tone: 'warn' }),
    stateDetail: null,
    peakText: null,
    supplyLeft: supplyLeftOf(f.curve, state),
  }
}

function positionOf(p: Position, state: State, opts: ProjectOptions): PositionView {
  const now = state.at
  const ageMs = now - p.openedAt
  const { multiple, peakText, pnl } = currentMultipleOf(p, state, opts)

  return {
    id: p.id,
    openedText: hhmmss(p.openedAt),
    book: p.book,
    token: p.token,
    curve: p.curve,
    ...positionLinks(p.token, p.curve),
    age: shown({ value: ageMs, text: secs(ageMs), tone: ageMs > p.rules.maxHoldMs ? 'warn' : 'plain' }),
    hold: holdBarOf(ageMs, p.rules.maxHoldMs),
    multiple,
    takeProfit: pinnedTpOf(multiple, p.rules.takeProfitMultiple),
    estimate: opts.unavailable.money
      ? absent<string>(opts.unavailable.money)
      : shown({ value: eth(p.spendWei, false), text: `${eth(p.spendWei, false)} ETH`, source: 'fold' }),
    pnl,
    state: positionStateOf(p),
    canRetryExit: p.venue === 'curve' && p.filled && p.inflightIntentId === null
      && !p.exitRecovery && (p.sellReceipts?.size ?? 0) === 0
      && (p.attempts >= p.rules.maxSellAttempts || p.approval?.gaveUp === true)
      && (state.risk.halts.has(stoppedKey(null)) || state.risk.halts.has('broken')),
    stateDetail: p.approval && !p.approval.ready && p.venue === 'curve'
      ? p.approval.lastError ?? 'Waiting for an allowance confirmed on chain.'
      : p.attempts >= p.rules.maxSellAttempts
        ? `${p.attempts} sell attempts exhausted. Tokens remain held; recovery required.`
        : p.grad?.gaveUp ? p.grad.lastError : null,
    peakText,
    supplyLeft: supplyLeftOf(p.curve, state),
  }
}

function pinnedTpOf(multiple: Shown<number>, tp: number): Shown<number> {
  const reached = multiple.missing === null && multiple.value !== null && multiple.value >= tp
  return shown({
    value: tp,
    text: reached ? `${mult(tp)} · reached` : mult(tp),
    tone: reached ? 'good' : 'muted',
    source: 'config',
  })
}

function supplyLeftOf(curveId: string, state: State): Shown<number> {
  const curve = state.curves.get(curveId)
  if (!curve) {
    return absent('no curve is on the tape for this position, so remaining supply cannot be formed', '–')
  }
  const frac = graduationProgress(curve.params, curve.working)
  const tone: Tone = frac < LEVELS.supplyLeftCritFraction
    ? 'bad'
    : frac < LEVELS.supplyLeftWarnFraction ? 'warn' : 'muted'
  return shown({ value: frac, text: pct(100 * frac), tone, source: 'fold' })
}

function exitOf(t: ClosedTrade, opts: ProjectOptions, peakGone: string | null): ExitView {
  const usdOf = (wei: bigint) => opts.ethUsd === null ? null : ethValue(wei) * opts.ethUsd.value
  const pnlUsd = usdOf(t.pnlWei)

  return {
    at: t.at,
    timeText: hhmm(t.at),
    openedText: hhmmss(t.at - t.holdMs),
    book: t.book,
    token: t.token,
    tokenText: shortToken(t.token),
    pnlUsd: pnlUsd === null
      ? absent<number>('no ETH price has been supplied to this process, so there is no dollar column', '–')
      : shown({ value: pnlUsd, text: usd(pnlUsd), tone: signTone(t.pnlWei) }),
    pnlEth: shown({ value: eth(t.pnlWei), text: eth(t.pnlWei), tone: signTone(t.pnlWei) }),
    spendEth: shown({ value: eth(t.spendWei, false), text: `${eth(t.spendWei, false)} ETH` }),
    proceedsEth: shown({ value: eth(t.proceedsWei, false), text: `${eth(t.proceedsWei, false)} ETH` }),
    reason: t.reason,
    reasonTone: t.reason === 'tp' ? 'good' : t.reason === 'stop' ? 'bad' : 'muted',
    hold: shown({ value: t.holdMs, text: secs(t.holdMs) }),
    takeProfit: shown({ value: t.takeProfitMultiple, text: mult(t.takeProfitMultiple), source: 'config' }),
    truePeak: observerPeakOf(t, peakGone),
    heldPeak: t.peakMultiple === null
      ? absent<number>('this position never carried an entry mark, so its peak cannot be formed', '–')
      : shown({ value: t.peakMultiple, text: mult(t.peakMultiple) }),
    exit: t.exitMultiple === null
      ? absent<number>('this position recorded a zero stake, so an exit multiple cannot be formed', '–')
      : shown({ value: t.exitMultiple, text: mult(t.exitMultiple), tone: signTone(t.pnlWei) }),
    kept: keptBar(t, peakGone),
    leftAfter: leftAfterOf(t, peakGone),
    detectToEntry: t.detectToEntryMs === null
      ? absent<number>('this launch was not seen by this process, so detect-to-entry cannot be formed', '–')
      : shown({ value: t.detectToEntryMs, text: `${t.detectToEntryMs} ms` }),
    devBuy: t.devBuyWei === null
      ? absent<string>('this position\'s template key would not parse, so the dev buy is unknown', '–')
      : shown({ value: eth(t.devBuyWei, false), text: eth(t.devBuyWei, false) }),
    exemptions: t.exemptions === null
      ? absent<number>('this position\'s template key would not parse, so the exemption count is unknown', '–')
      : shown({ value: t.exemptions, text: String(t.exemptions) }),
    taxBps: t.creatorTaxBps === null
      ? absent<number>('this position\'s template key would not parse, so the creator tax is unknown', '–')
      : shown({ value: t.creatorTaxBps, text: String(t.creatorTaxBps) }),
    tokenUrl: `${EXPLORER}/token/${t.token}`,
    curveUrl: `${EXPLORER}/address/${t.curve}`,
    chartUrl: `${TERMINAL}/${t.token}`,
  }
}

/** Blockscout, the same explorer v1 linked from a closed row. Display only. */
const EXPLORER = 'https://robinhoodchain.blockscout.com'
/** The venue chart. v1's terminal default: a token page, not the address page. */
const TERMINAL = 'https://robinhoodchain.blockscout.com/token'

function observerPeakOf(t: ClosedTrade, peakGone: string | null): Shown<number> {
  if (peakGone) return absent(peakGone, '–')
  if (t.observerPeak === null) {
    return absent('the independent peak has not settled yet, so there is no run to measure against', '–')
  }
  const left = t.exitMultiple === null ? null : t.observerPeak - t.exitMultiple
  const tone: Tone = left !== null && left > LEVELS.leftOnTableWarnMultiple ? 'warn' : 'plain'
  return shown({ value: t.observerPeak, text: mult(t.observerPeak), tone })
}

function leftAfterOf(t: ClosedTrade, peakGone: string | null): Shown<number> {
  if (peakGone) return absent(peakGone, '–')
  if (t.observerPeak === null || t.exitMultiple === null) {
    return absent('the independent peak has not settled yet, so what we left cannot be formed', '–')
  }
  const left = t.observerPeak - t.exitMultiple
  const sign = left > 0 ? '+' : ''
  return shown({
    value: left,
    text: `${sign}${left.toFixed(2)}x`,
    tone: left > LEVELS.leftOnTableWarnMultiple ? 'warn' : 'good',
  })
}

/**
 * `Max 45s` when every book on this table shares one hold clock. `Max` when they do not,
 * because labelling the column with one book's window would lie about the other.
 */
function maxHoldLabel(cfg: FrozenConfig, exitsBook: string | null): string {
  const books = exitsBook === null ? cfg.books : cfg.books.filter((b) => b.id === exitsBook)
  if (books.length === 0) return 'Max'
  const first = books[0]!.exit.maxHoldMs
  for (const b of books) {
    if (b.exit.maxHoldMs !== first) return 'Max'
  }
  return `Max ${Math.round(first / 1_000)}s`
}

/**
 * How much of the run available to us we actually took.
 *
 * `(exit - 1) / (observerPeak - 1)`, so a trade that sold at the very top of the independent
 * run reads 100% and one that round-tripped to break-even reads 0%. It needs the observer's
 * number. An unset peak is a dash: an empty bar and a 0% bar look identical, and "not settled
 * yet" is the opposite of "never rose". A peak at 1.00× is a measured zero run, so the grey
 * track is drawn at 0% rather than looking like a missing cell.
 */
function keptBar(t: ClosedTrade, peakGone: string | null): Bar {
  if (peakGone) return bar(null, 'no peak', 'muted', peakGone)
  if (t.observerPeak === null || t.exitMultiple === null) {
    return bar(null, 'no peak', 'muted', 'the independent peak has not settled yet, so there is no run to measure against')
  }
  const head = t.observerPeak - 1
  if (head <= 0) {
    return bar(0, 'this launch never traded above entry, so there was no run to keep any of', 'muted')
  }
  const f = (t.exitMultiple - 1) / head
  const clamped = Math.max(0, Math.min(1, f))
  return bar(clamped, pct(100 * clamped), keptTone(clamped, LEVELS.keptGoodFraction, LEVELS.keptWarnFraction))
}

// ---------------------------------------------------------------------------
// History panes: finished series the browser only plots
// ---------------------------------------------------------------------------

function walletPayloadOf(
  closes: readonly ChartClose[],
  from: number, now: number, lookback: (typeof LOOKBACKS)[number],
  ethUsd: ProjectOptions['ethUsd'],
): ChartPayload {
  const pts = closesPoints(closes, null, from, now)
  const y = pts.map((p) => p.value)
  const none: ChartPane['stack'] = []
  return {
    lookback: lookback.label,
    book: null,
    from: from / 1000,
    to: now / 1000,
    bucketSec: lookback.bucketMs / 1000,
    bookHeader: '',
    trades: tradesOf(closes, null, ethUsd),
    bands: [],
    panes: [
      {
        id: 'wallet',
        title: 'Total wallet',
        subtitle: 'booked closes in this window from 0 · ETH',
        missing: null,
        kind: 'step',
        t: pts.map((p) => p.at / 1000),
        y,
        stroke: seriesTone(y),
        yDecimals: LEVELS.paneWalletDecimals,
        unit: 'ETH',
        rules: [],
        stack: none,
      },
    ],
  }
}

function chartPayloadOf(
  spec: BookSpec | null, buckets: readonly Bucket[], paperBuckets: readonly Bucket[],
  from: number, now: number, lookback: (typeof LOOKBACKS)[number], book: string | null,
  gone: { paperGone: string | null },
  bookHeader: string,
  closes: readonly ChartClose[],
  ethUsd: ProjectOptions['ethUsd'],
  prefixStakes: number,
): ChartPayload {
  const virtualPts = spec === null ? [] : closesPoints(closes, spec.id, from, now)
  const virtualY = virtualPts.map((p) => p.value)
  const virtualStroke = seriesTone(virtualY)

  const paperPts = spec === null || gone.paperGone
    ? []
    : downsample(paperPoints(paperBuckets, spec.id, from, now, prefixStakes))
  const paperY = paperPts.map((p) => p.value)
  const paperStroke = seriesTone(paperY)

  const marketPts = spec === null
    ? []
    : downsample(stakePoints(buckets, spec.id, spec.guard.window, from, now))
  const marketY = marketPts.map((p) => p.value)

  const coins = spec === null || book === null
    ? []
    : coinStackOf(buckets, book, from, now, lookback.bucketMs)
  const coinT = coins.map((b) => b.t)
  const coinY = coins.map((b) => b.height)
  const seen = coins.reduce((n, b) => n + b.win + b.loss + b.pending + b.flat + b.notSimulated, 0)
  const scored = coins.reduce((n, b) => n + b.win + b.loss + b.flat, 0)
  const rate = seen === 0 ? '' : ` · ${scored} scored of ${seen} seen`

  const tOf = (pts: readonly Point[]) => pts.map((p) => p.at / 1000)
  const none: ChartPane['stack'] = []
  const bands = spec === null ? [] : virtualBands(paperBuckets, spec.id, from, now)

  return {
    lookback: lookback.label,
    book,
    from: from / 1000,
    to: now / 1000,
    bucketSec: lookback.bucketMs / 1000,
    bookHeader,
    trades: tradesOf(closes, book, ethUsd),
    bands,
    panes: [
      {
        id: 'virtual',
        title: 'Virtual wallet',
        subtitle: spec === null
          ? 'select a book — booked P&L is per policy'
          : `this book's booked closes in this window from 0 · sitting out is flat`,
        missing: spec === null ? 'no book is selected, so there is no virtual wallet to draw' : null,
        kind: 'step',
        t: tOf(virtualPts),
        y: virtualY,
        stroke: virtualStroke,
        yDecimals: LEVELS.paneWalletDecimals,
        unit: 'ETH',
        rules: [],
        stack: none,
      },
      {
        id: 'paper',
        title: 'Paper wallet',
        subtitle: spec === null
          ? 'select a book — paper is per policy'
          : `counterfactual · ungated · ${PAPER_STAKE_ETH} ETH/trade from 0 · no venue, no DD`,
        missing: gone.paperGone ?? (spec === null ? 'no book is selected, so there is no paper wallet to draw' : null),
        kind: 'step',
        t: tOf(paperPts),
        y: paperY,
        stroke: paperStroke,
        yDecimals: LEVELS.paneWalletDecimals,
        unit: 'ETH',
        rules: [],
        stack: none,
      },
      {
        id: 'market',
        title: 'Market indicator',
        subtitle: spec === null
          ? 'no book in the spec'
          : `trailing ${spec.guard.window} scored, adaptive-pinned · pause below ${spec.guard.shutAt}`
            + ` · reopen on the freshest ${spec.guard.recoveryWindow} above ${spec.guard.openAt}`,
        missing: spec === null ? 'no book is selected, so there is no indicator to draw' : null,
        kind: 'step',
        t: tOf(marketPts),
        y: marketY,
        stroke: 'plain',
        yDecimals: LEVELS.paneMarketDecimals,
        unit: 'stakes',
        rules: spec === null ? [] : [
          { label: `pause below ${spec.guard.shutAt}`, value: spec.guard.shutAt, stroke: 'bad' },
          { label: `reopen last ${spec.guard.recoveryWindow} above ${spec.guard.openAt}`, value: spec.guard.openAt, stroke: 'good' },
        ],
        stack: none,
      },
      {
        id: 'coins',
        title: 'Coins',
        subtitle: spec === null
          ? 'replay at the indicator bar'
          : `replay at the indicator bar · ${bandOf(spec)}${rate}`,
        missing: book === null ? 'no book is selected' : null,
        kind: 'stack',
        t: coinT,
        y: coinY,
        stroke: 'plain',
        yDecimals: LEVELS.paneCoinsDecimals,
        unit: 'launches',
        rules: [],
        stack: coins,
      },
    ],
  }
}

/** Colour the line by where it ended relative to where it started, not by a threshold. */
function seriesTone(y: readonly (number | null)[]): Tone {
  const real = y.filter((v): v is number => v !== null)
  if (real.length === 0) return 'plain'
  return signTone(real[real.length - 1]! - real[0]!)
}

function tradesOf(
  closes: readonly ChartClose[], book: string | null, ethUsd: ProjectOptions['ethUsd'],
): ChartTrade[] {
  const mine = book === null ? [...closes] : closes.filter((c) => c.book === book)
  if (mine.length === 0) return []
  let big = 0
  const rows = mine.map((c) => {
    const e = ethValue(c.pnlWei)
    const a = e < 0 ? -e : e
    if (a > big) big = a
    return { c, e }
  })
  if (big <= 0) big = 1
  return rows.map(({ c, e }) => {
    const frac = (e < 0 ? -e : e) / big
    const capped = frac > 1 ? 1 : frac
    const dollars = ethUsd === null ? null : e * ethUsd.value
    return {
      t: c.at / 1000,
      tone: signTone(c.pnlWei),
      r: LEVELS.chartDotMinPx + LEVELS.chartDotGainPx * Math.sqrt(capped),
      ring: c.reason === 'tp',
      token: shortToken(c.token),
      book: c.book,
      pnlText: dollars === null ? eth(c.pnlWei) : usd(dollars),
      reason: c.reason,
    }
  })
}

function coinStackOf(
  buckets: readonly Bucket[], id: string, from: number, to: number, bucketMs: number,
): CoinBar[] {
  const bins = new Map<number, {
    t: number; win: number; loss: number; pending: number; flat: number
    launches: number; seen: number; net: number; n: number
  }>()
  const floor = (at: number) => Math.floor(at / bucketMs) * bucketMs
  for (const b of buckets) {
    if (b.at > to) continue
    const t = floor(b.at)
    let row = bins.get(t)
    if (!row) {
      row = { t, win: 0, loss: 0, pending: 0, flat: 0, launches: 0, seen: 0, net: 0, n: 0 }
      bins.set(t, row)
    }
    row.seen += b.seen
    const x = b.books.get(id)
    if (!x) continue
    row.win += x.simWin
    row.loss += x.simLoss
    row.pending += x.simPending
    row.flat += x.simFlat
    row.launches += x.launches
    row.net += x.simNet
    row.n += x.simN
  }
  const out: CoinBar[] = []
  const lo = floor(from)
  const hi = floor(to)
  for (let t = lo; t <= hi; t += bucketMs) {
    const row = bins.get(t) ?? { t, win: 0, loss: 0, pending: 0, flat: 0, launches: 0, seen: 0, net: 0, n: 0 }
    const rest = row.launches - row.win - row.loss - row.pending - row.flat
    const notSimulated = rest > 0 ? rest : 0
    const extra = row.seen - row.launches
    const filtered = extra > 0 ? extra : 0
    const height = row.win + row.loss + row.pending + row.flat + notSimulated + filtered
    const net = row.n === 0 ? null : row.net
    const strip = stripOf(net, row.pending, row.win + row.loss + row.flat)
    out.push({
      t: t / 1000,
      win: row.win, loss: row.loss, pending: row.pending, flat: row.flat,
      notSimulated, filtered, height, net,
      netText: net === null ? '' : stripLabel(net),
      stripTone: strip.tone, stripAlpha: strip.alpha,
    })
  }
  return out
}

/** Colour and depth of one return-strip cell. Quiet nets stay grey; pending-only is hatched. */
function stripOf(net: number | null, pending: number, settled: number): { tone: Tone; alpha: number } {
  if (net === null && pending > 0 && settled === 0) return { tone: 'warn', alpha: 1 }
  if (net === null) return { tone: 'muted', alpha: 1 }
  const mag = Math.abs(net)
  if (mag < LEVELS.chartNetQuiet) return { tone: 'muted', alpha: 1 }
  const unit = mag / LEVELS.chartNetFull
  const capped = unit > 1 ? 1 : unit
  return {
    tone: net > 0 ? 'good' : 'bad',
    alpha: LEVELS.chartStripAlphaFloor + LEVELS.chartStripAlphaGain * capped,
  }
}

function stripLabel(net: number): string {
  const n = net.toFixed(LEVELS.chartStripDecimals)
  return net > 0 ? `+${n}` : n
}

/**
 * The venue indicator reconstructed over time: the trailing sum of stakes across the last
 * `window` SCORED launches, which is the quantity the guard actually reads.
 *
 * It is a trailing sum over scored rows, not a sum over minutes, because the guard's window is
 * counted in launches and a quiet hour must not dilute it. A minute where the book has not yet
 * accumulated a full window draws null rather than a partial sum: a partial window is exactly
 * the state the guard calls "no opinion", and drawing it as a number would suggest a verdict
 * that does not exist.
 */
function stakePoints(buckets: readonly Bucket[], id: string, window: number, from: number, to: number): Point[] {
  const out: Point[] = []
  const recent: number[] = []
  for (const b of buckets) {
    if (b.at < from || b.at > to) continue
    const x = b.books.get(id)
    if (x && x.scored > 0) {
      // The bucket carries a sum and a count, not the individual rows, so each scored launch in
      // the minute is entered at the minute's mean. Over a 60-second bucket at this venue's rate
      // that is almost always one row, and never more than a handful.
      const each = x.stakes / x.scored
      for (let i = 0; i < x.scored; i++) recent.push(each)
      while (recent.length > window) recent.shift()
    }
    out.push({ at: b.at, value: recent.length >= window ? recent.reduce((s, v) => s + v, 0) : null })
  }
  return out
}

/**
 * Group a series down to at most `LEVELS.seriesPoints`.
 *
 * Averaging rather than sampling, so a spike inside a group moves the line instead of being
 * invisible half the time depending on where the group boundaries land. A group with no
 * non-null members stays null, because "we averaged nothing" is not zero.
 *
 * `last` holds the ending level of the group, which is what a wallet line is: averaging
 * 0.26 with 0.28 invented a climb the account never took.
 */
function downsample(points: readonly Point[], hold: 'mean' | 'last' = 'mean'): Point[] {
  if (points.length <= LEVELS.seriesPoints) return [...points]
  const size = Math.ceil(points.length / LEVELS.seriesPoints)
  const out: Point[] = []
  for (let i = 0; i < points.length; i += size) {
    const group = points.slice(i, i + size)
    const real = group.map((p) => p.value).filter((v): v is number => v !== null)
    const value = real.length === 0
      ? null
      : hold === 'last'
        ? real[real.length - 1]!
        : real.reduce((s, v) => s + v, 0) / real.length
    out.push({ at: group[0]!.at, value })
  }
  return out
}

// ---------------------------------------------------------------------------
// Coverage of the band space
// ---------------------------------------------------------------------------

/**
 * Creator-tax values inside the screened range that no declared book claims.
 *
 * A launch there is observed and then refused `entry-no-book`, which looks identical on the
 * funnel to a launch the filter rejected on merit. Saying it out loud is the difference
 * between "the market is bad" and "we are not looking at part of it".
 */
function unroutedBands(state: State): string | null {
  const books = [...state.config.books].sort((a, b) => a.minCreatorTaxBps - b.minCreatorTaxBps)
  if (books.length === 0) return 'no books are declared, so every launch refuses entry-no-book'
  const holes: string[] = []
  let cursor = books[0]!.minCreatorTaxBps
  for (const b of books) {
    if (b.minCreatorTaxBps > cursor) holes.push(`${cursor}–${b.minCreatorTaxBps - 1}`)
    if (b.maxCreatorTaxBps >= cursor) cursor = b.maxCreatorTaxBps + 1
  }
  return holes.length === 0 ? null : `${holes.join(', ')} bps route to no book`
}

export { isoUtc, count }
