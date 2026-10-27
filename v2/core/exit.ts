/**
 * When to sell. Pure, total, and the only place an exit is decided.
 *
 * ORDER IS THE RULE. Graduation, then take profit, then the hold clock, then the hard stop,
 * then the dead-coin bail. The first match wins. This ordering is carried across from the
 * old bot expression for expression, because changing it silently re-attributes every
 * closed row: a position that hit both the take-profit bar and the hold clock in the same
 * tick is a `tp` in the book, and a reordering would quietly turn months of history into
 * `time`.
 *
 * WHY GRADUATION IS FIRST. It is not a soft event. The moment sellable supply hits zero the
 * contract refuses sells outright, so a position still open then cannot be exited on the
 * curve at any price. Waiting for graduation to HAPPEN is waiting until it is too late,
 * which cost a whole position (peaked at 3.65x) in the first shadow run.
 *
 * WHY THE DEAD-COIN CHECK IS LAST AND GUARDED. `deadCoinAfterMs === 0` means the rule is
 * OFF, and it must short-circuit before the elapsed comparison: `now - openedAt >= 0` is
 * true on the very first tick, so a plain zero would sell every position instantly instead
 * of disabling the rule. That guard is load-bearing, not defensive.
 *
 * INTEGER COMPARISONS ONLY. Every threshold is applied as a bigint cross-multiplication
 * against the mark, never as a float ratio. The old bot computed one such ratio through
 * float64 on operands near 1e27 (bot.ts:941); that bug is fixed here rather than carried,
 * and the gate treats it as a known divergence.
 */
import type { GradState, GradStep, Position } from './state.js'

/**
 * Why a position closed. Closed union, because this string is the funnel's key, lands in
 * the ledger, and is joined against in every analysis.
 *
 * The first five are decisions. `stranded` is not a decision, it is what a position becomes
 * when the curve refuses every sell; it is here so the ledger never has to represent it as
 * a normal exit.
 *
 * `graduated-swap` is not a decision either, and it is NOT `graduating`. `graduating` is the
 * bot leaving a curve it can still sell on, at `graduationExitAt`; `graduated-swap` is a bag
 * that did not get out in time being sold on the V4 pool instead. Two reasons, because they
 * have different costs and a book that cannot tell them apart cannot tell you how often the
 * 12% rule was late. v1 separates them for the same reason (`v1/src/strategy/exit.ts`).
 */
export type ExitReason = 'graduating' | 'tp' | 'time' | 'stop' | 'dead' | 'stranded' | 'graduated-swap'

/** The fields an exit decision reads. Nothing else on the position is visible to it. */
export type Exitable = Pick<Position, 'openedAt' | 'entryMarkWei' | 'peakMarkWei' | 'rules' | 'attempts' | 'inflightIntentId'>

/**
 * Should this position sell, given what it is worth right now?
 *
 * `mark` is `markToExit`: the real proceeds of selling the whole bag this instant, our own
 * impact and every fee included. Deliberately not a spot price, which overstates what a
 * sell returns and would fire the take profit early on a bag too large to exit at that
 * price.
 *
 * `graduating` is the curve's own signal, computed by the caller from
 * `graduationProgress <= rules.graduationExitAt`.
 *
 * Returns null when the position should be held. Null is correct here and is NOT a refusal:
 * "keep holding" is an answer, not a declined request, and inventing a refusal bucket for
 * the overwhelmingly common case would drown the funnel.
 */
export function evaluateExit(pos: Exitable, mark: bigint, now: number, graduating: boolean): ExitReason | null {
  // A sell already in flight must not be decided again; the settle closes it.
  if (pos.inflightIntentId !== null) return null

  if (graduating) return 'graduating'

  /**
   * BOTH PRICE RULES NEED A REAL ENTRY MARK, and the guard is not theoretical. Every
   * multiple here is relative to `entryMarkWei`, so at zero the take-profit bar is zero and
   * any price on earth clears it: the bot would dump a bag it had never managed to price,
   * at a 1 wei bound, the instant it saw one. The clock and the dead-coin bail below are
   * the rules that still mean something without a mark, and they are left reachable.
   */
  const priced = pos.entryMarkWei > 0n

  // Bank the win. The clock alone rode 5 of the pilot's trades from a +22%..+64% peak back
  // into a loss, because nothing ever sold into strength.
  if (priced && mark * 100n >= pos.entryMarkWei * BigInt(Math.round(pos.rules.takeProfitMultiple * 100))) return 'tp'

  if (now - pos.openedAt >= pos.rules.maxHoldMs) return 'time'

  if (priced && mark * 100n <= pos.entryMarkWei * BigInt(Math.round(pos.rules.hardStopMultiple * 100))) return 'stop'

  // Dead coin: never moved, never will. 100% of winners had printed the bar by 25s, so a
  // flat PEAK (not a flat mark) after `deadCoinAfterMs` is a curve already draining toward
  // the hold clock's loss. Peak, because a coin that spiked and came back is a different
  // animal and the hard stop is what handles it.
  if (
    pos.rules.deadCoinAfterMs > 0 &&
    now - pos.openedAt >= pos.rules.deadCoinAfterMs &&
    pos.peakMarkWei * 1000n < pos.entryMarkWei * BigInt(Math.round(pos.rules.deadCoinBelowMultiple * 1000))
  ) return 'dead'

  return null
}

/**
 * How long a sequenced sell may sit unsettled before the position is allowed to try again.
 *
 * THE HOLE THIS FILLS COST THREE POSITIONS ON 2026-09-16. `evaluateExit` returns null while
 * `inflightIntentId` is set, and only two things ever cleared it: a `CurveSell` log, or a
 * rejection by the sequencer BEFORE sequencing. A sell that the sequencer accepted and the
 * chain then REVERTED is neither. It emits no log, so nothing settles it; it was accepted, so
 * nothing rejects it. Three positions froze in exactly that state and would have stayed frozen
 * for as long as the process ran, showing as open and healthy on every projection.
 *
 * 15 seconds, which is `SELL_GIVEUP_MS` in v1 (`v1/src/bot.ts`), where the same case was
 * handled by pulling the receipt. The fold cannot pull a receipt — it has no network — so it
 * waits instead, and the wait has to be longer than a normal settle (a fill log arrives in
 * about a second) and short enough to leave room inside `maxHoldMs`.
 *
 * A MODULE CONSTANT RATHER THAN A CONFIG KEY, deliberately. `pos.rules` is snapshotted when
 * the position opens, so a new key would be `undefined` on every position already open — and
 * the positions already open are precisely the ones this exists to rescue.
 */
export { SELL_SETTLE_GIVEUP_MS } from './config.js'

/**
 * Has this position exhausted its attempts?
 *
 * Separate from `evaluateExit` because it answers a different question: not "should we
 * sell" but "have we stopped being able to". A refusal by the sequencer is NOT an attempt
 * (nothing was burned and no nonce was used), which is why `attempts` is incremented by the
 * driver only on a sequenced send.
 */
export function exhausted(pos: Exitable): boolean {
  return pos.attempts >= pos.rules.maxSellAttempts
}

// ---------------------------------------------------------------------------
// After graduation: the other venue
// ---------------------------------------------------------------------------

/**
 * The spend cap on an after-graduation sell, PORTED FROM v1's `checkBudget`.
 *
 * WHY THERE IS A CAP AT ALL. A graduated bag can fail in ways no retry ever fixes: the pool
 * has no liquidity, the hook refuses, the token taxes a transfer the router will not tolerate.
 * The failure to avoid is not "we did not get out", it is grinding gas against an exit that
 * cannot happen. So three ceilings, whichever comes first, and then a human.
 *
 * MODULE CONSTANTS, NOT CONFIG, for the reason written above `SELL_SETTLE_GIVEUP_MS`:
 * `pos.rules` is snapshotted at open, so a new key is `undefined` on every position already
 * open, and the positions already open are exactly the ones this exists to rescue.
 *
 * The gas ceiling is a FRACTION OF THE STAKE rather than an absolute, because that is the
 * only form of it that stays right when `TRADE_SIZE_ETH` moves. v1 writes it as
 * `spend_wei / 20n`.
 */
export const GRAD_BUDGET = {
  /** transactions the sequencer accepted, across every leg */
  maxSends: 12,
  /** how many of those the chain reverted */
  maxReverts: 6,
  /** reverted gas, as a fraction of the stake: 1/20 is 5% */
  gasFractionOfStake: 20n,
} as const

/** How long to wait before asking for a receipt again. v1's `GRADUATION_TIMING.receiptMs`. */
export const GRAD_RECEIPT_GAP_MS = 150

/** How long a sequenced graduation tx may sit without a receipt before the same bytes go out again. v1's `resendMs`. */
export const GRAD_RESEND_MS = 1_000

/** Backoff after a failure: `retryMs * n`, capped. v1's `retryMs` and `maxRetryMs`. */
export const GRAD_RETRY_MS = 250
export const GRAD_MAX_RETRY_MS = 1_000

/**
 * How long a wallet reading may be leaned on before it is read again.
 *
 * A balance and two allowances are only true together at the block they were read at. This is
 * not a cache lifetime chosen for cost; it is how long the answers stay safe to build a swap
 * from. v1 dodged the question by re-reading before every leg and pinning to the last
 * confirmed block, which is the same rule with the number left implicit.
 */
export const GRAD_WALLET_MAX_AGE_MS = 5_000

/**
 * Permit2 allowances carry an expiry, and one about to lapse is one that will revert.
 *
 * 30 seconds of headroom, and a 600-second grant, both v1's numbers.
 */
export const GRAD_PERMIT_HEADROOM_S = 30
export const GRAD_PERMIT_TTL_S = 600
/** How long the router is given to execute. v1 grants 180 seconds. */
export const GRAD_SWAP_TTL_S = 180

/**
 * What the after-graduation sell should do next, or why it cannot.
 *
 * A VALUE RATHER THAN A SEQUENCE OF CALLS, because that is what makes the order testable: v1's
 * equivalent is an `await`-chain inside `GraduationExit.step()`, so the only way to check that
 * an approve precedes a swap is to run it against a fake chain. Here the order is a pure
 * function of what is known, and the test reads it directly.
 */
export type GradAction =
  /** something is in the air, or the backoff has not elapsed. Not a refusal. */
  | { readonly kind: 'wait' }
  | { readonly kind: 'read-pool' }
  | { readonly kind: 'read-wallet' }
  | { readonly kind: 'read-receipt'; readonly hash: string }
  /** the same signed bytes, same nonce. Idempotent; used when a receipt has not appeared. */
  | { readonly kind: 'resend'; readonly hash: string; readonly raw: string }
  | { readonly kind: 'send'; readonly step: GradStep; readonly amountWei: bigint }
  | { readonly kind: 'close'; readonly proceedsWei: bigint; readonly hash: string }
  /**
   * A wallet read said the bag is empty, which is usually RPC lag and not a missing bag.
   * Back off and look again. After `GRAD_BUDGET.maxSends` consecutive zeros, become `blocked`.
   */
  | { readonly kind: 'empty'; readonly why: string }
  /** the venue or the wallet contradicts what we believe. A person has to look. */
  | { readonly kind: 'blocked'; readonly why: string }
  /** a ceiling in `GRAD_BUDGET` was reached. Also a person. */
  | { readonly kind: 'budget'; readonly why: string }

/** Has this bag spent its budget? Separate, so the reason can be said precisely. */
export function gradBudgetSpent(g: GradState, stakeWei: bigint): string | null {
  if (g.sends >= GRAD_BUDGET.maxSends) return `${g.sends} transactions submitted`
  if (g.reverts >= GRAD_BUDGET.maxReverts) return `${g.reverts} reverts`
  const ceiling = stakeWei / GRAD_BUDGET.gasFractionOfStake
  if (stakeWei > 0n && g.revertedGasWei >= ceiling) {
    return `${g.revertedGasWei} wei of reverted gas against a ${ceiling} wei ceiling`
  }
  return null
}

/**
 * The one place the after-graduation order is decided. Pure and total.
 *
 * THE ORDER IS v1's ORDER, leg for leg (`v1/src/graduation.ts`), and it is an order rather
 * than a set because each step invalidates the last one's answer:
 *
 *   1. a proven swap closes the position and nothing else runs
 *   2. a receipt we are waiting on is fetched before anything new is signed, because what it
 *      says changes which leg is next
 *   3. the pool is proved before a swap is built, since the calldata IS the pool key
 *   4. phase 0 and phase 1 are permissionless venue transitions: the curve is done but the
 *      pool does not exist yet, and until one of them lands there is nothing to sell into
 *   5. the wallet and both allowances are read together, because `sell` here is a router
 *      pulling tokens through Permit2 and any of the three being stale reverts it
 *   6. token approve, then permit, then swap
 *
 * A zero balance with no proven swap is `empty` first, not a close and not a give-up. One
 * lagging RPC is the usual case; booking it as a completed trade would write a 100% loss
 * that may not be real, and treating the first zero as `blocked` stranded bags v1 recovered
 * on the next read. After `GRAD_BUDGET.maxSends` consecutive zeros it becomes `blocked`.
 */
export function nextGraduationStep(pos: Position, now: number): GradAction {
  const g = pos.grad
  if (g === null) return { kind: 'wait' }

  if (g.proven !== null) return { kind: 'close', proceedsWei: g.proven.proceedsWei, hash: g.proven.hash }

  // A send is out and the fold has not seen its result yet. Nothing may be signed on top of
  // it: two legs in flight on one bag is two nonces racing to approve the same allowance.
  if (pos.inflightIntentId !== null) return { kind: 'wait' }

  // A RECEIPT IN THE AIR BEATS THE BUDGET. v1 processes a pending receipt before checkBudget.
  // Send 12 can be the swap that worked; giving up here would never fold the proof that closes it.
  if (g.awaitingReceipt !== null) {
    if (now < g.retryAt) return { kind: 'wait' }
    if (g.pendingRaw !== null && now - g.pendingAt >= GRAD_RESEND_MS) {
      return { kind: 'resend', hash: g.awaitingReceipt, raw: g.pendingRaw }
    }
    return { kind: 'read-receipt', hash: g.awaitingReceipt }
  }

  // Already said, already a person's problem. Saying it again every tick is what turned one
  // stuck v1 position into 33,804 log lines.
  if (g.gaveUp) return { kind: 'wait' }

  const spent = gradBudgetSpent(g, pos.spendWei)
  if (spent !== null) return { kind: 'budget', why: spent }

  if (now < g.retryAt) return { kind: 'wait' }

  if (g.pool === null) return { kind: 'read-pool' }
  if (g.phase === 0) {
    // v1 will not build this call until the curve itself says it is ready. Calling
    // it early reverts and spends the budget on a venue transition that cannot happen.
    if (g.curveReady === false) return { kind: 'wait' }
    return { kind: 'send', step: 'prepare-graduate', amountWei: 0n }
  }
  if (g.phase === 1) return { kind: 'send', step: 'prepare-pool', amountWei: 0n }
  if (g.phase !== 2) return { kind: 'blocked', why: `unsupported graduation phase ${g.phase}` }

  if (g.wallet === null || now - g.wallet.at >= GRAD_WALLET_MAX_AGE_MS) return { kind: 'read-wallet' }

  const w = g.wallet
  if (w.balanceWei === 0n) {
    return { kind: 'empty', why: 'zero token balance with no proven swap; an earlier sale may have landed unseen, or the RPC is lagging' }
  }
  if (w.erc20AllowanceWei < w.balanceWei) {
    return { kind: 'send', step: 'approve-token', amountWei: w.balanceWei }
  }
  if (w.permitAmountWei < w.balanceWei || w.permitExpiry <= Math.floor(now / 1000) + GRAD_PERMIT_HEADROOM_S) {
    return { kind: 'send', step: 'approve-permit', amountWei: w.balanceWei }
  }
  return { kind: 'send', step: 'swap', amountWei: w.balanceWei }
}
