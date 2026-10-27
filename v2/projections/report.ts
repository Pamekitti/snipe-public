/**
 * The machine contract: one flat block of numbers, for scripts, pinned by a test.
 *
 * WHY THIS EXISTS AS ITS OWN THING. `/api/state` used to be the view model with a handful of
 * script-shaped fields bolted onto the end, so every rename in the display was a potential
 * break in the phone report, and the two could not be reasoned about separately. They have
 * genuinely different requirements: the display wants strings, tones and a sentence when a
 * value is missing, and a script wants a number or a null. Serving both from one shape meant
 * neither was right, and after the v2 cutover it meant `report` printed `unavailable` for the
 * wallet, for today, and for booked P&L, because the names it reads had never existed here.
 *
 * WHAT GOES IN. Only things v2 genuinely folds. The old bot's `/api/state` also carried
 * `edge`, `plumbing.detectLag`, and a livewatch reconciliation block; those came from
 * processes that do not exist beside v2, and inventing empty versions of them would make a
 * missing instrument look like a healthy one reading zero.
 *
 * NUMBERS, NOT STRINGS. A consumer that has to parse "+0.0091" back into a float is a
 * consumer that will one day parse "unavailable" into 0. Every field here is a number, a
 * boolean, a string that is genuinely categorical, or null. `null` always means "not
 * measured" and never "zero".
 *
 * WEI IS A STRING. JSON numbers are float64 and wei is not, so any wei quantity is carried as
 * a decimal string beside its ETH float. The float is for reading; the string is for adding up.
 */
import { bookIds } from '../core/book.js'
import { bookLedger, haltedFor, ledgerNetWei, walletHalted, walletNetWei } from '../core/state.js'
import { buildAlerts, type Alert } from './alerts.js'
import { WINDOWS } from './viewmodel.js'
import type { Bucket, ClosedTrade, History } from './history.js'
import type { BookSpec } from '../core/config.js'
import {
  effectiveBookDrawdownWei, effectiveBookSizeWei, effectiveWalletDrawdownWei, simulationOf,
} from '../core/config.js'
import { sizedEntryWei, sizingReading } from '../core/sizing.js'
import type { State } from '../core/state.js'
import type { CuReading } from '../io/cu.js'
import type { RpcRoutingStatus } from '../io/routing.js'

const WEI_PER_ETH = 1e18

export type WindowReport = {
  readonly label: string
  readonly n: number
  readonly pnlEth: number
  readonly pnlUsd: number | null
  readonly winPct: number | null
  readonly medianMultiple: number | null
  readonly medianHoldMs: number | null
  /**
   * How many trades the two medians were computed over.
   *
   * `n` counts every close in the window, from the minute buckets. The medians need whole
   * trades and `history` keeps only the last 40 of those, so `medianN <= n` and the gap is
   * the part of the window the medians could not see. They were the same number, silently,
   * until 2026-09-16.
   */
  readonly medianN: number
}

export type BookReport = {
  readonly id: string
  readonly funded: boolean
  readonly bandBps: readonly [number, number]
  /** the effective stake: the lower of the book's declared size and the live switch */
  readonly stakeEth: number
  readonly declaredEth: number
  readonly nextStakeEth: number
  readonly sizingMultiplier: number
  readonly sizingState: string
  readonly sizingWhy: string
  readonly sizingN: number
  readonly sizeSource: 'default' | 'book'
  readonly sizeAt: number
  readonly sizeBy: string
  readonly halted: boolean
  readonly haltKind: string | null
  readonly haltReason: string | null
  readonly drawdownEth: number
  readonly drawdownLimitEth: number
  /** the number that pauses this book, or null when it has never produced a reading */
  readonly venueStakes: number | null
  readonly venueState: 'open' | 'shut' | 'stale' | null
  readonly venueWindow: number
  readonly venueAgeMs: number | null
  readonly takeProfit: number | null
  readonly n24h: number
  readonly pnl24hEth: number
}

export type Report = {
  /** bumped when a field is removed or changes meaning. Added fields do not bump it. */
  readonly schema: number
  readonly at: number
  readonly seq: number
  readonly specVersion: number
  readonly simulationModel: string
  readonly simulationPositiveFactor: number
  readonly simulationNegativeFactor: number
  readonly kernelId: string | null
  /** the first event on this tape: the zero every "since" counts from */
  readonly zeroAt: number | null

  readonly mode: 'shadow' | 'live'
  /** true only when mode is live. `shadow` never sends. */
  readonly sending: boolean
  readonly stopped: boolean
  readonly halted: boolean
  readonly haltKind: string | null
  readonly haltReason: string | null

  readonly sizeEth: number
  /** when size or mode last changed, and what moved them. A `.env` size edit shows up here. */
  readonly switchesAt: number
  readonly switchesBy: string
  readonly openN: number
  readonly capacity: number

  /**
   * What the account holds on chain, and when it was last asked.
   *
   * SCHEMA 2 CHANGED WHAT THIS MEANS. Under schema 1, `walletEth` was cumulative booked P&L
   * wearing the wallet's name: it did not move when gas was burnt, when ETH was deposited, or
   * while a position was open. Booked P&L is now `bookedPnlEth` and this is `eth_getBalance`.
   * Null means nobody has asked yet.
   */
  readonly walletEth: number | null
  readonly walletWei: string | null
  readonly walletUsd: number | null
  readonly walletAt: number | null
  /** cumulative realized P&L since the tape's zero. The number the drawdown stop reads. */
  readonly bookedPnlEth: number
  readonly bookedPnlWei: string
  readonly bookedPnlUsd: number | null
  readonly priceUsd: number | null
  readonly priceSource: string | null

  readonly drawdownEth: number
  readonly drawdownLimitEth: number

  /**
   * Us against our own replay: whether the bot is mispricing or the market is bad.
   *
   * Wallet-wide, and null until a full `risk.broken_window` of trades have been paired with the
   * replay of the same coin. `gapPp` is points a trade, so -18 means eighteen points short of what
   * the venue paid; `limitPp` is where the halt sits, positive, compared against the negative.
   */
  readonly broken: {
    readonly gapPp: number
    readonly n: number
    readonly realPp: number
    readonly replayPp: number
    readonly limitPp: number
    readonly ageMs: number
  } | null

  readonly windows: readonly WindowReport[]
  readonly books: readonly BookReport[]

  readonly streams: {
    readonly logsHealthy: boolean | null
    readonly logsAgeMs: number | null
    readonly feedConnected: boolean | null
    readonly overlayAgeMs: number | null
    readonly curvesTracked: number
    readonly gaps: number
  }

  /**
   * What the PAID endpoint has cost this process. A METER AND NEVER A GATE; see `io/cu.ts`.
   *
   * It is here because on 2026-09-18 the account had spent 56.6M of a 95.2M cap, was a day and a
   * half from the key refusing to answer, and nothing the bot could print knew it. An exhausted
   * key 429s the launch socket and the entry reads together, so this is the same class of fact as
   * `streams`: whether the plumbing will still be there in an hour.
   *
   * `cu` is measured and always present. EVERYTHING BELOW IT IS AN EXTRAPOLATION from the rate
   * since this process booted and is null until there is enough of a window to be worth printing
   * (`MIN_OBS_MS`). It is not the account's billing period, it cannot see another app on the same
   * key, and the box restarts often — so a small `cu` here means a young process, not a cheap one.
   * The provider's usage page is the invoice. This is the pace.
   */
  readonly provider: {
    readonly cu: number
    readonly sinceMs: number
    readonly cuPerDay: number | null
    readonly cuPerMonth: number | null
    readonly usdPerMonth: number | null
    readonly capPerMonth: number | null
    /** projected month over the configured cap. Past 1 the key stops answering before month end. */
    readonly capFraction: number | null
    /** the single biggest line, so the bill has a cause and not just a size */
    readonly topMethod: string | null
    readonly topMethodCu: number | null
  } | null

  readonly rpcRouting: RpcRoutingStatus | null

  readonly alerts: readonly Alert[]
}

/**
 * Bumped only on a removal or a change of meaning. `pull.sh` refuses a schema it does not know.
 *
 * 2 (2026-09-16): `walletEth`/`walletWei`/`walletUsd` are the chain balance and can be null.
 * They were cumulative booked P&L, which now has its own name, `bookedPnlEth`. A consumer that
 * kept reading `walletEth` under schema 1 was reading a different quantity, so the delta file
 * `pull.sh` writes is discarded across the bump rather than differenced against.
 */
export const REPORT_SCHEMA = 2

export function buildReport(
  state: State,
  history: History,
  ethUsd: { readonly value: number; readonly source: string } | null,
  /** optional so the monitor, the tools and every test keep calling this with three arguments */
  providerCu: CuReading | null = null,
  rpcRouting: RpcRoutingStatus | null = null,
): Report {
  const now = state.at
  const cfg = state.config
  const simulation = simulationOf(cfg)
  const ids = bookIds(cfg)
  const exits = history.recentExits()

  const halt = walletHalted(state.risk)
  const walletStop = effectiveWalletDrawdownWei(cfg, state.switches)
  // The SAME net figure `walletDrawdownBreach` measures, for the reason `bookReport` says below.
  // The per-book number was moved to net and this one was left on booked P&L, so `report` would
  // have shown the wallet further from its stop than the stop itself thought it was.
  const ddRaw = state.risk.walletPeakWei - walletNetWei(state.risk)
  const dd = ddRaw < 0n ? 0n : ddRaw

  const logs = state.sensors.logsHealthy
  const feed = state.sensors.feedConnected
  const bal = state.walletBalance
  const broken = state.sensors.broken

  return {
    schema: REPORT_SCHEMA,
    at: now,
    seq: state.seq,
    specVersion: cfg.specVersion,
    simulationModel: simulation.model,
    simulationPositiveFactor: simulation.positiveFactor,
    simulationNegativeFactor: simulation.negativeFactor,
    kernelId: state.kernelId || null,
    zeroAt: history.coverage.from,

    mode: state.switches.mode,
    sending: state.switches.mode === 'live',
    stopped: state.risk.halts.has('stopped'),
    halted: halt !== null,
    haltKind: halt?.kind ?? null,
    haltReason: halt?.reason ?? null,

    sizeEth: toEth(state.switches.sizeWei),
    switchesAt: state.switches.at,
    switchesBy: state.switches.by,
    openN: [...state.positions.values()].filter((p) => !p.closed).length,
    capacity: cfg.risk.maxConcurrent,

    walletEth: bal === null ? null : toEth(bal.value),
    walletWei: bal === null ? null : bal.value.toString(),
    walletUsd: bal === null || ethUsd === null ? null : toEth(bal.value) * ethUsd.value,
    walletAt: bal?.at ?? null,
    bookedPnlEth: toEth(state.risk.walletRealizedWei),
    bookedPnlWei: state.risk.walletRealizedWei.toString(),
    bookedPnlUsd: ethUsd === null ? null : toEth(state.risk.walletRealizedWei) * ethUsd.value,
    priceUsd: ethUsd?.value ?? null,
    priceSource: ethUsd?.source ?? null,

    drawdownEth: toEth(dd),
    drawdownLimitEth: toEth(walletStop),

    broken: broken === null ? null : {
      gapPp: broken.value.gapPp,
      n: broken.value.n,
      realPp: broken.value.realPp,
      replayPp: broken.value.replayPp,
      limitPp: cfg.risk.brokenGapPp,
      ageMs: now - broken.at,
    },

    windows: WINDOWS.map((w) => windowReport(
      w.label,
      history.window(now - w.ms, now),
      ids,
      exits.filter((t) => t.at >= now - w.ms),
      ethUsd,
    )),
    books: ids.map((id) => bookReport(cfg.books.find((b) => b.id === id)!, state, history, exits, now)),

    streams: {
      logsHealthy: logs?.value ?? null,
      logsAgeMs: logs === null ? null : now - logs.at,
      feedConnected: feed?.value ?? null,
      overlayAgeMs: state.overlayAt === null ? null : now - state.overlayAt,
      curvesTracked: state.curves.size,
      gaps: state.gaps.length,
    },

    provider: providerCu === null ? null : {
      cu: providerCu.cu,
      sinceMs: providerCu.sinceMs,
      cuPerDay: providerCu.perDay,
      cuPerMonth: providerCu.perMonth,
      usdPerMonth: providerCu.usdPerMonth,
      capPerMonth: providerCu.capPerMonth,
      capFraction: providerCu.capFraction,
      topMethod: providerCu.byMethod[0]?.method ?? null,
      topMethodCu: providerCu.byMethod[0]?.cu ?? null,
    },
    rpcRouting,

    alerts: buildAlerts(state, history),
  }
}

/**
 * One window's numbers. COUNTED FROM THE MINUTE BUCKETS, SAMPLED FOR THE MEDIANS.
 *
 * `history.recentExits()` holds whole trades and is capped at `LEVELS.exitsKept` (40), because
 * the exits table needs every column of a trade. It used to be the only input here, so a 24h
 * window on a busy day reported `n=40` and a P&L that was the last 40 trades', which the phone
 * report then printed as the day's total. The buckets count every close for seven days.
 *
 * `medianN` says how many trades the medians were actually computed over, so a reader can see
 * when the sample is smaller than the window rather than assuming they match.
 */
function windowReport(
  label: string, buckets: readonly Bucket[], ids: readonly string[],
  sample: readonly ClosedTrade[],
  ethUsd: { readonly value: number } | null,
): WindowReport {
  let n = 0
  let wins = 0
  let pnlWei = 0n
  for (const b of buckets) {
    for (const id of ids) {
      const x = b.books.get(id)
      if (!x) continue
      n += x.closed; wins += x.wins; pnlWei += x.pnlWei
    }
  }
  const eth = toEth(pnlWei)
  const multiples = sample.map((t) => t.exitMultiple).filter((x): x is number => x !== null)
  return {
    label,
    n,
    pnlEth: eth,
    pnlUsd: ethUsd === null ? null : eth * ethUsd.value,
    winPct: n > 0 ? (100 * wins) / n : null,
    medianMultiple: median(multiples),
    medianHoldMs: median(sample.map((t) => t.holdMs)),
    medianN: multiples.length,
  }
}

function bookReport(spec: BookSpec, state: State, history: History, exits: readonly ClosedTrade[], now: number): BookReport {
  const l = bookLedger(state.risk, spec.id)
  const h = haltedFor(state.risk, spec.id)
  const stop = effectiveBookDrawdownWei(state.config, spec, state.switches)
  // The SAME net figure `drawdownBreach` measures, so the number a person reads and the number
  // that halts the book cannot disagree about how close the stop is.
  const ddRaw = l.peakWei - ledgerNetWei(l)
  const dd = ddRaw < 0n ? 0n : ddRaw

  const declared = BigInt(spec.sizeWei)
  const stake = effectiveBookSizeWei(spec, state.switches)
  const sizing = sizingReading(state, spec)
  const nextStake = sizedEntryWei(stake, sizing, state.config.risk.maxTradeSizeWei)
  const override = state.switches.bookSizes?.get(spec.id)

  const v = state.sensors.venue.get(spec.id)
  const b = state.sensors.bars.get(spec.id)

  // Same correction as `windowReport`: counted from the buckets, which see the whole day.
  const day = WINDOWS.find((w) => w.label === '24h')!.ms
  let n24 = 0
  let pnl24 = 0n
  for (const b of history.window(now - day, now)) {
    const x = b.books.get(spec.id)
    if (!x) continue
    n24 += x.closed; pnl24 += x.pnlWei
  }

  return {
    id: spec.id,
    funded: stake > 0n,
    bandBps: [spec.minCreatorTaxBps, spec.maxCreatorTaxBps],
    stakeEth: toEth(stake),
    declaredEth: toEth(declared),
    nextStakeEth: toEth(nextStake),
    sizingMultiplier: sizing.multiplierBps / 10_000,
    sizingState: sizing.state,
    sizingWhy: sizing.why,
    sizingN: sizing.n,
    sizeSource: override ? 'book' : 'default',
    sizeAt: override?.at ?? state.switches.at,
    sizeBy: override?.by ?? state.switches.by,
    halted: h !== null,
    haltKind: h?.kind ?? null,
    haltReason: h?.reason ?? null,
    drawdownEth: toEth(dd),
    drawdownLimitEth: toEth(stop),
    venueStakes: v?.value.sumStakes ?? null,
    venueState: v === undefined ? null : !v.value.fresh ? 'stale' : v.value.open ? 'open' : 'shut',
    venueWindow: spec.guard.window,
    venueAgeMs: v === undefined ? null : now - v.at,
    takeProfit: b !== undefined && b.value.ready ? b.value.multiple : null,
    n24h: n24,
    pnl24hEth: toEth(pnl24),
  }
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  const isEven = s.length % 2
  return isEven === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!
}

/**
 * Wei to an ETH float, dividing on the bigint first.
 *
 * `Number(BigInt)` is lossy above 2^53 wei, which is 0.009 ETH. This is the same division
 * `format.ts` does, deliberately duplicated rather than imported: `format.ts` is the display's
 * and may grow display concerns, and the machine contract must not move when it does.
 */
function toEth(wei: bigint): number {
  const neg = wei < 0n
  const abs = neg ? -wei : wei
  const n = Number(abs / 10n ** 18n) + Number(abs % 10n ** 18n) / WEI_PER_ETH
  return neg ? -n : n
}
