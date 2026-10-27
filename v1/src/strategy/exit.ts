/**
 * Exit management.
 *
 * This is where the money is. In the friction ladder, exit lag cost about 9 points of
 * return on turnover while everything else combined cost under 5, so the rule here is
 * that a decision never waits on the network: marks come from local state, the approval
 * is already in place, and firing is a signature plus a socket write.
 *
 * The retry ladder matters as much as the trigger. 64 of the 101 wallets studied were
 * effectively bag-holders and they account for most of the money that cohort lost. So a
 * failed exit widens its slippage bound and tries again, down to one wei if it has to.
 * There is no mempool here, so nothing can sandwich a loose bound.
 */
import { STRATEGY } from '../config.js'

export type ExitReason = 'tp' | 'stop' | 'time' | 'graduating' | 'dead' | 'manual' | 'graduated-swap'

/**
 * The exit rules a position runs, PINNED WHEN IT OPENED, for the same reason
 * takeProfitMultiple is: a rule that moves under a bag already held is a rule nobody
 * agreed to. Config can now change while the bot runs (config/store.ts), so "the settings
 * at entry" has to be a thing the position carries rather than a thing we hope nobody
 * touched.
 *
 * It also makes the row honest. positions.dead_after_ms and dead_below have been written at
 * open since 2026-09-04 and described in db.ts as "the rule each row actually ran", but
 * evaluate() went on reading the globals, so the row recorded one rule and the bot applied
 * another. Both now read this.
 */
export type ExitRules = {
  maxHoldMs: number
  hardStopMultiple: number
  deadCoinAfterMs: number
  deadCoinBelowMult: number
}

/** the rules as they stand right now, to be pinned onto a position that is opening */
export function currentExitRules(): ExitRules {
  return {
    maxHoldMs: STRATEGY.maxHoldMs,
    hardStopMultiple: STRATEGY.hardStopMultiple,
    deadCoinAfterMs: STRATEGY.deadCoin.afterMs,
    deadCoinBelowMult: STRATEGY.deadCoin.belowMult,
  }
}

export type Position = {
  id: number
  token: string
  curve: string
  tokens: bigint
  spendWei: bigint
  entryMarkWei: bigint
  openedAt: number
  /**
   * The take profit this position is exiting on, PINNED WHEN IT OPENED.
   *
   * Not read from config at decision time any more: STRATEGY.takeProfit is a schedule over
   * the venue's trailing touch rate (see strategy/takeprofit.ts), and re-reading it per
   * tick would move the exit target under an open bag whenever the regime flipped
   * mid-hold. Chosen once, stored here, written to positions.take_profit so the live
   * distribution of rungs can be joined against the research that produced them.
   */
  takeProfitMultiple: number
  /** the clock, the hard stop and the dead-coin bail this position runs. See ExitRules. */
  rules: ExitRules
  peakMarkWei: bigint
  exiting: boolean
  attempts: number
  lastAttemptAt: number
  /** the buy is sequenced but we have not yet seen proof it executed */
  buyHash: string
  filled: boolean
  /** a sell is sequenced and we are waiting for its event or its receipt */
  sellInFlight: boolean
  sellHash: string
  sellSentAt: number
  /** exits have been failing for a long time; keep trying, but stop pretending */
  stuck: boolean
  /**
   * Which book opened this position; see strategy/entry.ts. 'main' carries the edge at
   * full size, 'probe' is the small-size calibration book with its own daily cap. Written
   * to positions.cohort so the two are never averaged into one number by accident.
   *
   * Always 'main' since 2026-09-07: the probe book is deleted. The FIELD stays because the
   * column stays, and the column stays because history has probe rows at a tenth the size
   * that must keep being excluded from the real-vs-replay comparison behind the bot-broken
   * halt (bot.ts checkBroken, edgecheck.py).
   */
  cohort: 'main'
  /**
   * This position has stopped sending sells. Two ways in, neither of them slippage:
   *
   *   no tokens   - the wallet holds none; there is nothing to sell.
   *   exhausted   - STRATEGY.maxSellAttempts reverts in a row. On 2026-09-04 position
   *                 1438 sent 945 sells that each reverted on insufficient balance, at
   *                 $0.107 of gas apiece, while the book reported +$52. Retries are not
   *                 free: a revert still pays for the gas it used.
   *
   * The row stays OPEN while parked. We still hold the tokens; closing would book a
   * loss we have not taken and hide the bag from recovery forever. A restart rebuilds
   * the position fresh (attempts 0, parked false), which is the intended second chance
   * once the diagnosis has corrected whatever was wrong.
   *
   * Graduated holdings remain open and move to the persistent swap manager.
   */
  parked: boolean
  /** Confirmed graduation hands exits to the persistent swap manager. */
  graduated?: boolean
  /** Confirmed gas for permissionless graduation preparation, charged while open. */
  preparationGasWei?: bigint
  /**
   * Gas paid by sells that REVERTED. A reverted transaction still executes up to the
   * revert and is charged for it, so every failed attempt is a real cost that neither
   * proceeds nor the buy/sell receipt backfill can see. Accumulated here from the
   * revert receipts, charged to the risk ledger as it accrues (so the drawdown stop and
   * the daily cap see a bleed WHILE it is happening, not when the row finally closes),
   * and subtracted from pnl_wei at settle.
   */
  burnedGasWei: bigint
  /** when the cold-path revert diagnosis last ran, so it stays off the hot path */
  lastDiagnosisAt: number
  /** why we are exiting, preserved across retries so telemetry stays truthful */
  exitReason: ExitReason | null
  /** an rpc reconciliation is already running for this position */
  reconciling: boolean
  /** strategy/entry.ts templateKey at open, so a losing close can block the template */
  templateKey: string
  /**
   * Sends the sequencer REFUSED before sequencing (http 429/503, "nonce too high"): no gas
   * burned, no nonce used, and since 2026-09-06 no sell attempt consumed either. The
   * attempt cap exists to stop a gas bleed from reverts; counting refusals against it
   * parked a position with its tokens in hand after a 30s refusal burst (the 09-05
   * shape: 20 in 30s), and a parked position skips the hard stop. Refusals back off on
   * their own clock instead: 500ms doubling to 10s, and the position keeps trying.
   */
  refusals: number
  retryNotBefore: number
  /**
   * Backoff for reconcileBuy while a buy is unconfirmed. The 50ms pump re-entered it as
   * fast as the round trips returned (5-8 passes a second for up to a minute, each a
   * balanceOf and a receipt on the public rpc, each writing a health row); thirteen such
   * buys during the 09-05 nonce runaway aimed ~130 calls a second at an rpc already
   * answering 429. Now 500ms doubling to 4s, and a health row only when the verdict changes.
   */
  lastReconcileAt: number
  reconcileBackoffMs: number
  lastReconcileNote: string
  /** what our model said the exit would fetch, captured when the sell was fired */
  expectedProceeds: bigint
}

export function newPosition(
  p: Omit<Position, 'peakMarkWei' | 'exiting' | 'attempts' | 'lastAttemptAt' | 'filled' | 'sellInFlight' | 'sellHash' | 'sellSentAt' | 'stuck' | 'parked' | 'lastDiagnosisAt' | 'exitReason' | 'reconciling' | 'templateKey' | 'refusals' | 'retryNotBefore' | 'lastReconcileAt' | 'reconcileBackoffMs' | 'lastReconcileNote' | 'expectedProceeds' | 'burnedGasWei' | 'cohort' | 'rules'> & { buyHash: string; filled?: boolean; templateKey?: string; rules?: ExitRules },
): Position {
  return {
    ...p, cohort: 'main', rules: p.rules ?? currentExitRules(), peakMarkWei: p.entryMarkWei, exiting: false, attempts: 0, lastAttemptAt: 0,
    filled: p.filled ?? false, sellInFlight: false, sellHash: '', sellSentAt: 0, stuck: false,
    parked: false, lastDiagnosisAt: 0,
    exitReason: null, reconciling: false, templateKey: p.templateKey ?? '', refusals: 0, retryNotBefore: 0, lastReconcileAt: 0, reconcileBackoffMs: 0, lastReconcileNote: '', expectedProceeds: 0n, burnedGasWei: 0n,
  }
}

/**
 * `mark` is the proceeds we would actually receive selling the whole position right now,
 * net of fees and our own impact. Not a spot price: the spot price flatters small
 * positions and lies about big ones.
 */
export { evaluate } from './exit-evaluation.js'

/**
 * Slippage bound for attempt n. The first attempt protects the fill; each retry gives up
 * more, because by then the alternative is not a better price, it is no exit at all.
 */
export function minQuoteOutFor(markConfirmed: bigint, attempt: number): bigint {
  const ladder = STRATEGY.sellSlippageLadderBps
  if (attempt >= ladder.length) return STRATEGY.sellFinalMinQuoteOut
  const bps = BigInt(ladder[attempt]!)
  const out = (markConfirmed * (10_000n - bps)) / 10_000n
  return out > 0n ? out : STRATEGY.sellFinalMinQuoteOut
}

/**
 * Never fire a second sell while one is still in flight: two sequenced sells for one
 * position means the second reverts, and worse, both look like successful exits.
 */
export function shouldRetry(pos: Position, now: number): boolean {
  if (!pos.exiting || pos.sellInFlight) return false
  // a parked position is one the chain has told us can never sell here. see Position.parked
  if (pos.parked) return false
  if (now < pos.retryNotBefore) return false // a refused send's own backoff
  const backoff = pos.stuck ? STRATEGY.exitRetryDelayMs * 10 : STRATEGY.exitRetryDelayMs
  return now - pos.lastAttemptAt >= backoff
}
