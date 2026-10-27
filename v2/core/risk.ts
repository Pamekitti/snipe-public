/**
 * The wallet's limits, and the halts. Pure: it reads state and returns a verdict.
 *
 * TWO SCOPES, AND MIXING THEM IS THE CLASSIC ERROR.
 *
 *   Per book: one guard. Cash drawdown and the venue sum are two ways to shut it.
 *   The same 8-fresh +1 reopens it. Each book has its own ledger and its own guard tape.
 *
 *   Wallet-wide: optional capacity, optional bankroll, and the ever-entered set. A slot
 *   is a nonce and a slice of capital, and neither of those belongs to a book. Zero
 *   capacity or bankroll means that check is off: leftover reserved/deployed from an
 *   unbooked fill must not sit out a launch the book is otherwise allowed to buy.
 *
 * THE WALLET DRAWDOWN BAR IS NOT A HALT. It used to freeze every book and block START /
 * RESET DD, which is how an operator who owned the dashboard still could not lift it.
 * Per-book drawdown is the other shut trigger for that book's guard: the configured multiple of net
 * cash, same as 15 below -1.5. Reopen is the guard's 8-fresh +1, not a second rule.
 * The wallet scale is the sum of each book's live stop, not a halt.
 *
 * CAPACITY IS RESERVED BEFORE ANY AWAIT. `reserved` exists because two launches arriving in
 * one log batch can both pass a capacity check and both open, taking N+1 slots. The old bot
 * got this right by calling `risk.reserve()` before the first await in `enter()`, and the
 * rule is carried verbatim: the fold reserves, the driver acts, and a refused send releases.
 */
import { no, ok, type Ok } from './contracts.js'
import {
  effectiveBookDrawdownWei, effectiveWalletDrawdownWei, type FrozenConfig, type Switches,
} from './config.js'
import type { BookLedger, HaltKind, RiskState, State } from './state.js'
import { bookLedger, haltedFor, ledgerNetWei, walletNetWei } from './state.js'

const UTC_DAY_MS = 86_400_000

/** Unix time is UTC and has no leap seconds, so a UTC day is exactly 86.4e6 ms. */
export const utcDay = (ms: number): number => Math.floor(ms / UTC_DAY_MS)

/**
 * Stickiest first. THE one ordering: it decides what a refusal names and what the page shows.
 *
 * `satisfies readonly HaltKind[]` is load-bearing: a kind removed from the union but left
 * here would keep a dead halt ranked above a live one, which is how `gate` survived here
 * after the 1.21x gate itself was deleted.
 *
 * `broken` sits directly above `drawdown` deliberately. When the bot is mispricing, the
 * drawdown that follows is a SYMPTOM, and the page must not present the symptom as the cause.
 */
export const HALT_RANK = ['manual', 'broken', 'drawdown', 'stopped', 'venue'] as const satisfies readonly HaltKind[]

/** Health of the log stream, as the fold last saw it. Passed in; risk does not sense. */
export type StreamHealth = {
  readonly logsHealthy: boolean
  readonly logsAgeMs: number
  readonly overlayAgeMs: number | null
}

export type SizeRequest = {
  readonly token: string
  readonly book: string
  readonly sizeWei: bigint
}

/**
 * May we open this position, right now, in this book?
 *
 * Order is the funnel and the first refusal wins. Halts before capacity before money before
 * stream health, because a halted bot should say it is halted rather than that it is full,
 * and because the cheap in-memory checks must not sit behind anything that can be stale.
 */
export function canEnter(
  state: State,
  req: SizeRequest,
  health: StreamHealth,
): Ok<{ readonly sizeWei: bigint }> {
  const { at, config, risk } = state

  const halt = haltedFor(risk, req.book)
  if (halt) {
    const scope = halt.book === null ? 'wallet-wide' : `on ${halt.book}`
    return no(at, 'risk-halted', req.token, `${halt.kind} halt ${scope}: ${halt.reason}`)
  }

  // Wallet-wide, never per book: the same token bought twice is the same token, whichever
  // policy admitted it the second time.
  if (risk.everEntered.has(req.token)) {
    return no(at, 'risk-entered', req.token, 'already entered once; a token is bought at most once, ever')
  }

  // ZERO MEANS NO CAP. Same convention as bankroll: 0 is not "zero slots, refuse
  // everything". Ghost `reserved` from an unbooked fill used to fill 14 and sit out
  // later launches. A positive ceiling still refuses, so a replay of an older spec
  // keeps the refusals it recorded.
  const cap = config.risk.maxConcurrent
  if (cap > 0 && risk.reserved >= cap) {
    return no(at, 'risk-capacity', req.token, `${risk.reserved} of ${cap} slots in use`)
  }

  const maxSize = BigInt(config.risk.maxTradeSizeWei)
  if (req.sizeWei > maxSize) {
    return no(at, 'risk-size', req.token, `${req.sizeWei} exceeds the ${maxSize} ceiling`)
  }
  if (req.sizeWei <= 0n) {
    return no(at, 'risk-size', req.token, 'size is zero or negative')
  }

  // ZERO MEANS NO CAP. Same convention as a zero drawdown stop: 0 is not "halt on
  // contact". A leftover `deployedWei` from an unbooked fill used to sit out every
  // later launch against a finite bankroll (102 open-and-on misses on the 09-18 tape).
  // Slots still bind. A positive bankroll still refuses, so a replay of an older
  // spec keeps the refusals it recorded.
  const bankroll = BigInt(config.risk.bankrollWei)
  if (bankroll > 0n && risk.deployedWei + req.sizeWei > bankroll) {
    return no(at, 'risk-bankroll', req.token,
      `${risk.deployedWei} deployed plus ${req.sizeWei} would pass the ${bankroll} bankroll`)
  }

  // Stream health last, because these are the checks most likely to be transiently false
  // and a launch refused here should have already been refused by everything cheaper.
  if (state.sensors.entryReady === false) {
    return no(at, 'risk-logs-unhealthy', req.token, 'entry waits for paid log catch-up after halted observation')
  }
  if (!health.logsHealthy) {
    return no(at, 'risk-logs-unhealthy', req.token, 'the log stream is not healthy')
  }
  if (health.logsAgeMs > config.risk.maxLogsStalenessMs) {
    return no(at, 'risk-logs-stale', req.token,
      `logs ${health.logsAgeMs}ms old, over ${config.risk.maxLogsStalenessMs}ms`)
  }
  // A null overlay age means the feed has never delivered. That is degraded, not fresh: the
  // entry price is computed from confirmed logs PLUS the overlay, so no overlay means the
  // price we would fire on is not the price the decision was designed around.
  if (health.overlayAgeMs === null || health.overlayAgeMs > config.risk.maxOverlayAgeMs) {
    const age = health.overlayAgeMs === null ? 'no feed overlay at all' : `overlay ${health.overlayAgeMs}ms old`
    return no(at, 'risk-degraded', req.token, `${age}, over ${config.risk.maxOverlayAgeMs}ms`)
  }

  return ok({ sizeWei: req.sizeWei })
}

/**
 * Has this book's session drawdown breached its stop?
 *
 * Wei against wei. The limit has been denominated in ETH since 2026-09-07 and the ledger
 * always was, so there is no price in this path at all: a stale ETHUSD used to move the
 * stop silently, reading "$240" while enforcing $282.
 */
export function drawdownBreach(
  cfg: FrozenConfig,
  risk: RiskState,
  book: string,
  switches: Switches | bigint,
): { readonly downWei: bigint; readonly limitWei: bigint } | null {
  // The BOOK's own stop since 2026-09-16. A shared figure meant two policies with different
  // sizes and different win rates were allowed to lose exactly the same amount, which is a
  // limit on the spec rather than on the risk.
  const spec = cfg.books.find((b) => b.id === book)
  if (!spec) return null
  const l = bookLedger(risk, book)
  // NET, NOT BOOKED P&L, since 2026-09-17. Booked P&L is proceeds minus stake over CLOSED rows,
  // and a bug closes no rows: a reverting sell books nothing while the chain charges for every
  // attempt. Measured against booked P&L this stop could not see that bleed at all, which is how
  // v1 burned $101 across 945 reverts while reading +$52.
  const downWei = l.peakWei - ledgerNetWei(l)
  const limitWei = effectiveBookDrawdownWei(cfg, spec, switches)
  // A zero stop is an unfunded book, not a halt-on-contact: 0 >= 0 would fire on a flat ledger.
  if (limitWei === 0n) return null
  return downWei >= limitWei ? { downWei, limitWei } : null
}

/**
 * Place this book's cash halt if the session stop has been breached.
 *
 * Checked on every close and every proved gas charge, not on a timer: a stop that fires a
 * tick late has already let another position open.
 */
export function haltOnDrawdown(s: State, book: string): State {
  const b = drawdownBreach(s.config, s.risk, book, s.switches)
  if (b && !s.risk.halts.has(`drawdown:${book}`)) {
    s.risk.halts.set(`drawdown:${book}`, {
      kind: 'drawdown', book,
      reason: `${book} is ${b.downWei} wei down from its peak, at or past the ${b.limitWei} stop`,
      at: s.at,
    })
  }
  return s
}

function zeroBookSession(l: BookLedger): void {
  l.realizedWei = 0n
  l.gasWei = 0n
  l.peakWei = 0n
}

/**
 * Forget the cash session. One book, or the wallet. The gas goes with it: it is part of
 * what the stop measures, so leaving it behind would hand the reset a book already down.
 */
export function resetDrawdown(s: State, book?: string | null): void {
  if (book) {
    s.risk.halts.delete(`drawdown:${book}`)
    zeroBookSession(bookLedger(s.risk, book))
    return
  }
  for (const key of [...s.risk.halts.keys()]) if (key.startsWith('drawdown')) s.risk.halts.delete(key)
  for (const l of s.risk.books.values()) zeroBookSession(l)
  s.risk.walletRealizedWei = 0n
  s.risk.walletGasWei = 0n
  s.risk.walletPeakWei = 0n
}

/**
 * The guard reopened. Forget this book's cash halt and the peak that would re-fire it.
 * Any other halt that applies to this book still holds.
 */
export function releaseDrawdown(s: State, book: string): void {
  if (!s.risk.halts.has(`drawdown:${book}`)) return
  for (const [key, h] of s.risk.halts) {
    if (key === `drawdown:${book}` || key === `venue:${book}`) continue
    if (h.book === null || h.book === book) return
  }
  resetDrawdown(s, book)
}

/** How far the wallet bar is past its scale. A measurement, not a halt. */
export function walletDrawdownBreach(
  cfg: FrozenConfig,
  risk: RiskState,
  switches: Switches | bigint,
): { readonly downWei: bigint; readonly limitWei: bigint } | null {
  const downWei = risk.walletPeakWei - walletNetWei(risk)
  const limitWei = effectiveWalletDrawdownWei(cfg, switches)
  if (limitWei === 0n) return null
  return downWei >= limitWei ? { downWei, limitWei } : null
}

/**
 * Roll every ledger's daily figures when the UTC day turns.
 *
 * Mutates, because RiskState's maps are the fold's hot state. Returns whether it rolled, so
 * the caller logs a transition rather than a no-op on every tick.
 */
export function rollDay(risk: RiskState, at: number): boolean {
  const day = utcDay(at)
  if (day === risk.dayStamp) return false
  risk.dayStamp = day
  for (const l of risk.books.values()) l.dayRealizedWei = 0n
  return true
}
