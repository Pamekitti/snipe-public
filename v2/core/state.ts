/**
 * Everything the bot knows, as a fold over the tape.
 *
 * THE RULE THAT DEFINES THIS FILE. If replaying the tape from seq 0 does not reproduce a
 * field exactly, that field does not belong here, it belongs on the tape as an event. And if
 * a field CAN be recomputed from the tape, it must not also be an event. The old bot broke
 * this in both directions: `TrackedCurve.working` was live-only state no replay could reach,
 * while `takeProfit` was recorded as an answer with no question beside it.
 *
 * THE CLOCK. `State.at` is the `at` of the last folded event and is the only "now" any pure
 * function may use. Nothing in core/ calls `Date.now()`.
 *
 * MUTABILITY. The fold mutates in place for the hot collections (curves, positions) because
 * cloning a Map of curves on every one of ~13 logs per second is the kind of cost that
 * starved the old bot's main loop. Everything scalar is readonly and replaced. The boundary
 * is explicit: a Map or a class instance is mutated, a primitive or a record is replaced.
 */
import { BoundedMap, BoundedSet, REFUSAL_BUCKETS, Ring } from './contracts.js'
import type { Aged, Refusal, RefusalBucket, Sensed } from './contracts.js'
import { BROKEN_PAIRS_KEPT } from './config.js'
import type { FrozenConfig, Switches } from './config.js'
import type { GapStream, SensorName } from './events.js'
import type { SimEvent } from './sim.js'
// Type-only, and therefore erased: `exit.ts` imports `Position` from here, so a runtime import
// would be a cycle. The reason's definition belongs in `exit.ts` beside the rules that produce
// it, and the row that records it belongs here, which is the one case this is worth.
import type { ExitReason } from './exit.js'

// ---------------------------------------------------------------------------
// The chain book
// ---------------------------------------------------------------------------

/**
 * The curve's mutable state and its immutable parameters, exactly as the contract holds
 * them. Both come from core/curve.ts, which is a verbatim port of the verified Solidity.
 *
 * This was a four-field simplification when state.ts was written in step 1, before the
 * curve was ported. It is the contract's own shape now, because `npm run validate` pins
 * these functions bit-exact against real chain history and a decision that folds a
 * paraphrased state into them is not the decision that was validated.
 */
export type { CurveParams, CurveState } from './curve.js'

/**
 * One curve, in three layers.
 *
 * `confirmed` is what chain logs proved. `pending` is the unconfirmed feed overlay.
 * `working` is confirmed with the overlay applied, and it is what every price and every
 * mark is computed from. Keeping all three is what lets a decision say which layer it
 * trusted, which the old bot could not: `working` existed only in the live process, so no
 * replay could reach the number a live decision actually read.
 */
export type TrackedCurve = {
  readonly curve: string
  readonly token: string
  /** immutable for the life of the curve; read from the launch and never re-read */
  readonly params: import('./curve.js').CurveParams
  /** proved by logs */
  confirmed: import('./curve.js').CurveState
  /** confirmed plus the accepted feed overlay. What decisions read. */
  working: import('./curve.js').CurveState
  /**
   * Feed transactions applied on top of `confirmed`, oldest first, by tx hash.
   *
   * `blockTs` is the SEQUENCED BLOCK's timestamp in seconds, carried here because the overlay
   * simulates each call and the snipe tax is a function of how long ago the curve launched.
   * Taking it from the block rather than from a clock is what keeps the overlay replayable:
   * `core/` has no clock, and a local one would put a different tax on a replay than the live
   * run computed.
   */
  pending: Map<string, { readonly at: number; readonly data: string; readonly blockTs: number }>
  /** the last block whose logs were folded into `confirmed` */
  confirmedThrough: number
  /**
   * true when the overlay was dropped or a reseed replaced confirmed state, so a decision
   * reading `working` knows it is reading something less than fully proved.
   */
  degraded: boolean
  /** when `working` last changed. Drives the overlay-age refusal. */
  workingAt: number
}

// ---------------------------------------------------------------------------
// Positions and observations
// ---------------------------------------------------------------------------

/**
 * Rules are PINNED at open and never re-read.
 *
 * An open position keeps the rules it opened under, so changing the spec mid-flight cannot
 * retroactively change what an open bag is allowed to do. The old bot had this right and it
 * is carried over deliberately.
 */
export type PinnedRules = {
  readonly maxHoldMs: number
  readonly hardStopMultiple: number
  readonly deadCoinAfterMs: number
  readonly deadCoinBelowMultiple: number
  readonly graduationExitAt: number
  readonly maxSellAttempts: number
  readonly takeProfitMultiple: number
  /**
   * The sell bound, pinned like everything else here.
   *
   * It is 1 wei by design and it is pure cost: with no mempool there is no sandwich to defend
   * against, so the bound can only ever refuse a sell we want to make. Pinned anyway, because
   * the position's book may have moved or been removed by the time the sell goes out, and a
   * bound re-read then is a bound this position never agreed to.
   */
  readonly sellFinalMinQuoteOutWei: string
}

/**
 * The V4 pool a graduated token trades in, as the factory describes it.
 *
 * Plain data, folded from a `grad-pool` read, because the swap calldata is built from it and
 * calldata built from a value the tape does not hold is calldata a replay cannot reproduce.
 * `hooks` is checked against the factory's own `memeHook` before it ever gets here: an
 * unverified hook is a different contract deciding what our sell is worth.
 */
export type PoolKey = {
  readonly currency0: string
  readonly currency1: string
  readonly fee: number
  readonly tickSpacing: number
  readonly hooks: string
}

/**
 * What the wallet and its approvals looked like at one block.
 *
 * One reading rather than three fields, so freshness is a property of the SET. The three
 * answers come back in one multicall and are only consistent with each other at the block
 * they were read at; storing them separately would let an allowance from block N be compared
 * against a balance from block N+2, which is how v1's graduation manager learned to pin its
 * reads to `confirmed_block`.
 */
export type GradWallet = {
  readonly balanceWei: bigint
  /** the token's own allowance to Permit2 */
  readonly erc20AllowanceWei: bigint
  /** Permit2's allowance to the V4 router, and when it lapses (unix seconds) */
  readonly permitAmountWei: bigint
  readonly permitExpiry: number
  /** the `at` of the read this came from. A reading has to be able to go stale. */
  readonly at: number
}

/**
 * Everything the after-graduation sell remembers between steps.
 *
 * WHY IT LIVES ON THE POSITION AND NOT IN A TABLE. v1 kept this in `graduation_exits` and
 * `graduation_transactions`, two SQLite tables that had to be reconciled against the wallet
 * at every restart. Here the tape is the durable record and this is a fold over it, so a
 * restart replays to the same step it was on with nothing to reconcile.
 *
 * THE COUNTERS ARE A SPEND CAP, NOT A RETRY COUNT. A graduated bag can fail in ways no retry
 * fixes (no liquidity, a hook that refuses), and the failure mode to avoid is grinding gas
 * against it forever. v1's budget is 12 sends, 6 reverts, or reverted gas reaching 5% of the
 * stake, and it is carried here unchanged.
 */
export type GradState = {
  /** null until a `grad-pool` read proves it */
  pool: PoolKey | null
  /** the factory's `GraduationPhase`: 0 curve done, 1 pool uncreated, 2 tradeable */
  phase: number | null
  /**
   * The curve contract's `readyToGraduate`, from the same `grad-pool` read.
   *
   * Phase 0 is not enough: `graduate()` reverts until this is true. Five live bags
   * burned a send each on 2026-09-17 because the factory said phase 0 and we called
   * it anyway.
   */
  curveReady: boolean | null
  /** null until a `grad-wallet` read lands, and invalidated after every receipt */
  wallet: GradWallet | null
  /** transactions the sequencer accepted. A refused send is not one. */
  sends: number
  /** how many of those the chain then reverted */
  reverts: number
  /** gas those reverts burned, which is the thing the 5% cap is measured on */
  revertedGasWei: bigint
  /** nothing is raised before this. Backoff after a failure, receipt gap after a send. */
  retryAt: number
  /** the hash we are waiting on a receipt for, or null */
  awaitingReceipt: string | null
  /** Identifies a sale whose successful receipt still needs proceeds/balance proof. */
  pendingStep?: GradStep | null
  /** the signed bytes of that send, so a missing receipt can be resent without a new nonce */
  pendingRaw: string | null
  /** when those bytes were last broadcast. Drives the 1s resend. */
  pendingAt: number
  /** consecutive zero-balance wallet reads. A lagging RPC is not a missing bag. */
  emptyReads: number
  /** human detail from the last failure. Never matched on. */
  lastError: string | null
  /** set once a swap receipt proves an ETH sale. The close reads it and nothing else. */
  proven: { readonly proceedsWei: bigint; readonly hash: string } | null
  /** so the budget refusal is said once rather than on every tick */
  gaveUp: boolean
}

/**
 * The five transactions an after-graduation sell can need, in the order they can be needed.
 *
 * Closed union, because `io/` builds a different transaction for each and a sixth name would
 * be a transaction nobody can build. The two `prepare-` legs are the permissionless venue
 * transition: v1 calls the factory's `graduate` and `createGraduatedPool` and NEVER the
 * owner's sweep or rescue functions, which change who gets the reserves.
 */
export type GradStep = 'prepare-graduate' | 'prepare-pool' | 'approve-token' | 'approve-permit' | 'swap'

export function freshGradState(): GradState {
  return {
    pool: null, phase: null, curveReady: null, wallet: null, sends: 0, reverts: 0, revertedGasWei: 0n,
    retryAt: 0, awaitingReceipt: null, pendingRaw: null, pendingAt: 0, emptyReads: 0,
    lastError: null, proven: null, gaveUp: false,
  }
}

export type Position = {
  readonly id: string
  readonly token: string
  readonly curve: string
  /** which book admitted it, and the digest of that book's filter at the time */
  readonly book: string
  readonly bookDigest: string
  /**
   * The (tax, dev-buy, exempts) shape this launch had, pinned at open.
   *
   * Carried on the position rather than recomputed at close, because at close the launch
   * facts are long gone: the only thing still in hand is the log, and a log does not carry
   * how many exempt wallets the creator registered. A key rebuilt from what is available at
   * close would be a DIFFERENT key, so the loss would block a template that never traded.
   */
  readonly templateKey: string
  readonly openedAt: number
  /**
   * What the fill paid, or the reserved size until the fill is proved.
   *
   * Mutable because the row is created on a successful send and the log's `quoteIn` can
   * differ from the reserved size. Close subtracts this, so it has to become the real
   * spend or leftover `deployedWei` looks like a full bankroll.
   */
  spendWei: bigint
  /**
   * What we could get back at the fill, or 0 until the fill is proved.
   *
   * Mutable because the row is created on a successful send (v1's shape) and the mark is
   * only known when the CurveBuy or the wallet read lands. A send is not a fill.
   */
  entryMarkWei: bigint
  readonly rules: PinnedRules
  tokensHeld: bigint
  /**
   * The send was accepted. The fill is not proved until a CurveBuy, a receipt, or a
   * wallet read says we hold tokens. Unfilled rows take a slot and show as opening; they
   * do not exit and they do not book P&L.
   */
  filled: boolean
  peakMarkWei: bigint
  /**
   * Quote received so far, summed across partial fills.
   *
   * On the row rather than derived from a ledger delta, because more than one position can
   * close inside a single log batch and a delta cannot be split back into the trades that
   * made it. Booked P&L for this trade is `proceedsWei - spendWei` and nothing else; a
   * balance difference is not this trade, because the wallet moves for other reasons.
   */
  proceedsWei: bigint
  /** set once, when the last token leaves. Null while the position is open. */
  closedAt: number | null
  /**
   * Set only when a fresh chain read proves the wallet holds zero tokens but no sale receipt
   * exists. This releases capacity without pretending there was a close or booking false P&L.
   */
  abandonedAt: number | null
  /** The operator-visible evidence for an abandonment. Null for normal open and closed rows. */
  abandonReason: string | null
  /**
   * Why it closed, set at the close and null while open.
   *
   * IT IS ON THE ROW BECAUSE IT IS THE ONLY WAY TO JUDGE THE 12% RULE. `graduating` means the
   * bot left a curve it could still sell on; `graduated-swap` means it did not get out in time
   * and the bag had to be sold on the V4 pool instead. Those are the same money and a very
   * different verdict on `graduationExitAt`, and without the reason on the row the two are
   * indistinguishable once the position is closed.
   */
  exitReason: ExitReason | null
  /** sell attempts made so far; a refusal does not count as an attempt */
  attempts: number
  /** Curve sells wait for an allowance proved on chain. Absent on older snapshots. */
  approval?: {
    ready: boolean
    intentId: string | null
    hash: string | null
    awaitingAllowance: boolean
    retryAt: number
    failures: number
    reverts: number
    gasWei: bigint
    lastError: string | null
    gaveUp: boolean
  }
  /** Timed-out sells remain identifiable until their receipts arrive. */
  sellReceipts?: Map<string, { reason: ExitReason; readAt: number }>
  /** Receipt delivery and log delivery may repeat; each effect is booked once. */
  chargedReceiptHashes?: Set<string>
  settledSellHashes?: Set<string>
  /** An explicit operator retry waits for a fresh balance before renewing its budget. */
  exitRecovery?: { requestedAt: number; readAt: number }
  priorSellAttempts?: number
  /** set once the driver reports a send; cleared on a settled result */
  inflightIntentId: string | null
  /**
   * Hash of the last signed buy. Kept after the inflight record is freed, so a late
   * CurveBuy can still book the spend the log paid after a receipt already opened the row.
   */
  lastBuyHash: string | null
  /**
   * Hash of the last signed sell. Kept after the inflight record is freed, so a late
   * CurveSell can still close the row and give the slot back.
   */
  lastSellHash: string | null
  /**
   * A sell we gave up waiting for, whose receipt is still outstanding. Matched on
   * the receipt path after `freeStuckSell` deleted the inflight record.
   */
  awaitingSellReceipt: string | null
  closed: boolean
  /**
   * Which venue this bag can still be sold on.
   *
   * IT IS NOT A STATUS, IT IS AN ADDRESS OF THE EXIT. The curve refuses every sell the moment
   * sellable supply hits zero, so a position that reaches that point has not "failed to exit",
   * it has moved market: the tokens are real, tradeable, and reachable only through the V4
   * pool. v2 parked them instead and three of them would have sat open forever.
   *
   * The flip is one way. A graduated curve never comes back, so nothing sets this to 'curve'.
   */
  venue: 'curve' | 'graduated'
  /** null while `venue` is 'curve'; created by the flip and folded from there on */
  grad: GradState | null
}

export type Observation = {
  readonly token: string
  readonly curve: string
  /**
   * The book whose universe this launch belongs to, stamped when it routed.
   *
   * On the observation rather than looked up later, for the same reason `templateKey` is on
   * the position: at settle time the launch facts are gone, and a band that moved in between
   * would re-attribute history. It is also the join key the projection uses to split the
   * funnel by book without the refusal itself having to carry one.
   */
  readonly book: string
  /** when the launch log was folded. The settle clock runs from here. */
  readonly startedAt: number
  /** the launch block. `sim.path` counts every offset from here, so it is not optional. */
  readonly launchBlock: number
  /** the creator, lower case, so the replay can tell their buys from a stranger's. */
  readonly deployer: string
  /** the launch transaction, so the dev buy is not also counted as an early wallet. */
  readonly launchTx: string
  /** creator tax, bps. Fixed for the life of the curve and priced into every fill. */
  readonly creatorTaxBps: number
  /**
   * The take-profit column this launch will contribute to the venue sum, frozen at watch.
   *
   * WHATEVER A REAL ENTRY WOULD HAVE PINNED AT THIS MOMENT, through `rungNow`: the selector's
   * argmax when it has a window, the coldest bar when it does not or when its reading is stale.
   * Frozen HERE rather than looked up at settle so that a regime that flips while the launch is
   * being watched cannot re-pick the column: the ruler would then move with the thing it
   * measures, which is the one coupling `takeprofit.ts` forbids.
   *
   * Optional because a `seed` row arrives already scored, with no watch to freeze anything at.
   */
  readonly pinnedBar?: number
  /**
   * Every curve log on this launch, in chain order, as the simulator consumes them.
   *
   * THIS IS THE WHOLE MEASUREMENT. The old observer kept two prices and a peak; this keeps
   * the launch's actual history, and the answer is computed from it at settle. Keeping the
   * inputs rather than a running summary is what lets one launch be scored at seven bars at
   * once, and it is why the indicator and the take-profit selector cannot drift apart: they
   * read two columns of one vector rather than two summaries of one stream.
   *
   * OUR OWN FILLS ARE NOT IN HERE. The replay measures the venue, not our own size, so a log
   * whose transaction is ours is dropped at the door. That is `chainio.decode_seq`'s rule and
   * every stored row in `gate.db` was produced under it.
   */
  readonly events: SimEvent[]
}

/**
 * One settled observation: what a trade in that launch would have returned, at every bar.
 *
 * `perBar` is the vector. THREE SENSORS READ THREE THINGS OUT OF IT and there is no fourth
 * source: the venue indicator sums each row's own frozen-at-watch column, the take-profit
 * selector takes the argmax across columns, and `peak` is the best mark the launch ever
 * showed. One replay, three readings, so they cannot disagree about what happened.
 */
export type Outcome = {
  readonly token: string
  readonly book: string
  readonly at: number
  /** model that produced `perBar`; absent on historical raw-v1 rows */
  readonly simulationModel?: string
  /** bar key to calibrated outcome in stakes, consumed by paper, adaptive TP and the guard. */
  readonly perBar: Readonly<Record<string, number>>
  /** raw curve replay retained for the bot-broken detector; absent on historical rows */
  readonly rawPerBar?: Readonly<Record<string, number>>
  /**
   * This launch's contribution to the venue sum: its own pinned column, lifted out at settle.
   *
   * Stored rather than looked up later because nothing downstream can reconstruct which
   * column this row pinned: a chart that re-picked today's argmax would be free to draw a
   * different sum from the one that halted the wallet. Null when the replay dropped that
   * bar, which is missing data and never a zero.
   */
  readonly stakes: number | null
  /** Selected-policy return at the sizing policy's fixed reference stake. */
  readonly sizingStakes?: number | null
  /** the best mark inside the window, paying no poll, no lag and no exit rule */
  readonly peak: number
}

/**
 * One closed trade beside the replay of the same coin. The bot-broken detector's input.
 *
 * Both sides are a return on stake and both are GROSS OF GAS, which is what makes them
 * comparable: `scoreLaunch` stores `mult - 1`, and booked P&L here is proceeds minus stake.
 * Gas belongs to the drawdown stop, which measures it separately and in wei.
 */
export type TradePair = {
  readonly token: string
  /** when the pair completed, which is whichever of the close and the settle came second */
  readonly at: number
  /** `(proceeds - stake) / stake` for the real trade */
  readonly real: number
  /** the replay's return in stakes, at the rung THIS position pinned */
  readonly replay: number
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

/**
 * Halt scope. Venue and cash drawdown are two shut triggers for the same per-book guard,
 * because each book has its own guard tape and its own closed rows. Everything else is the
 * wallet or the machine, where the book is not a meaningful dimension.
 */
export type HaltKind = 'venue' | 'drawdown' | 'broken' | 'stopped' | 'manual'

export type Halt = {
  readonly kind: HaltKind
  /** null for a wallet-wide or machine-wide halt */
  readonly book: string | null
  readonly reason: string
  readonly at: number
}

export type BookLedger = {
  readonly book: string
  /**
   * BOOKED P&L: proceeds minus stake, over closed rows, and NOTHING ELSE IN IT.
   *
   * Gas is deliberately not here. Runbook rule 3 is that the wallet and the book are different
   * instruments and the gas is the difference between them, so mixing gas into this number would
   * make the one figure a person reads stop meaning what it says.
   */
  realizedWei: bigint
  /**
   * Gas this book has PROVED it burned, from receipts only. Never an estimate.
   *
   * It exists because booked P&L cannot see a bug. A sell that reverts moves no proceeds and
   * closes no row, so it lands nowhere in `realizedWei` — while the chain charges for every one
   * of them. v1 learned this on 2026-09-04, when a single stuck position burned $101 across 945
   * reverts with both of its caps reading the book at +$52 and seeing nothing.
   *
   * ONLY MEASURED GAS. Every wei here came from a receipt's `gasUsed * effectiveGasPrice`. The
   * ordinary legs of a healthy trade never have their receipt read, so their gas is absent
   * rather than guessed, and that is the safe direction: v1 charged an estimate at
   * `limit * maxFee` once and overstated the cost 71x, which fed a phantom drawdown straight
   * into the kill switch.
   */
  gasWei: bigint
  /** The high-water mark of NET, not of `realizedWei`, because net is what the stop measures. */
  peakWei: bigint
  dayRealizedWei: bigint
}

/**
 * What this book has actually taken out of the wallet: booked P&L less the gas it proved it
 * burned. THE NUMBER THE DRAWDOWN STOP MEASURES.
 *
 * Separate from `realizedWei` so the figure a person reads keeps the definition rule 3 gives it,
 * while the figure that halts the wallet sees the whole bleed. One function, so the stop, the
 * alert and the report cannot drift into three opinions about it.
 */
export const ledgerNetWei = (l: BookLedger): bigint => l.realizedWei - l.gasWei

/** The same, wallet-wide. */
export const walletNetWei = (r: { walletRealizedWei: bigint; walletGasWei: bigint }): bigint =>
  r.walletRealizedWei - r.walletGasWei

export type RiskState = {
  /** keyed `kind` for wallet-wide halts and `kind:book` for scoped ones */
  halts: Map<string, Halt>
  /** per book, so a per-book stop is reachable */
  books: Map<string, BookLedger>
  /** wallet-wide booked P&L: proceeds minus stake, no gas. See `BookLedger.realizedWei`. */
  walletRealizedWei: bigint
  /** wallet-wide proved gas. See `BookLedger.gasWei`. */
  walletGasWei: bigint
  /** the high-water mark of `walletNetWei`, which is what the wallet stop measures */
  walletPeakWei: bigint
  /** tokens ever entered. Wallet-wide: never buy the same token twice, whatever the book. */
  everEntered: BoundedSet<string>
  /** reserved before any await, so two launches in one batch cannot both claim the last slot */
  reserved: number
  deployedWei: bigint
  /** the UTC day `dayRealizedWei` was last rolled for */
  dayStamp: number
}

// ---------------------------------------------------------------------------
// Sensors
// ---------------------------------------------------------------------------

/**
 * Every reading a decision consumes, each one carrying its age and source in its type.
 *
 * A field here may never be a bare value. That is checked structurally by a test, and it is
 * the type-level form of "a chart that draws a sensor carries that sensor's age and which
 * sensor is in force". The old market pane drew a tape frozen 40 minutes earlier and nothing
 * in the code could have noticed.
 */
/**
 * THE MARKET INDICATOR. What the bot's own exit rule would have made on the launches it did
 * not hold, summed in stakes over two windows drawn from the same rows.
 *
 * It is a REPLAY RESULT, not a counter. `sumStakes` is the main `window`, which is what
 * pauses a trading book below `shutAt`. `recentSum` is the freshest `recoveryWindow` of those
 * same rows, which is what reopens a paused one above `openAt`. -2.5 means those launches
 * would have cost two and a half stakes between them.
 *
 * `fresh` is separate from `open` because they answer different questions, but it no longer
 * softens anything: a reading that is not fresh is ALSO not open. Incomplete or stale
 * evidence fails closed, which is the September 14 rule and the opposite of the August one
 * it replaces.
 */
export type VenueReading = {
  readonly open: boolean
  readonly sumStakes: number
  readonly window: number
  /** the freshest `recoveryWindow` rows of the same window, in stakes. The reopen reads this. */
  readonly recentSum: number
  readonly recoveryWindow: number
  /**
   * Which column was summed. `'adaptive'` because there is no longer one: every row carries
   * the bar it pinned at watch, and naming a single ruler here would be a lie the chart
   * would repeat.
   */
  readonly bar: string
  readonly fresh: boolean
  readonly why: string
}
export type BarsReading = { readonly multiple: number; readonly ready: boolean; readonly why: string }
/**
 * Us against the venue, over the trailing paired window. See `core/broken.ts`.
 *
 * `gapPp` is `mean(real) - factor * mean(replay)` in POINTS, so -18 means eighteen points a
 * trade short of what the same coins replayed at. The two component means travel with it
 * because a single residual cannot be argued with: "we made -7 where the venue paid +14" is a
 * sentence an operator can act on, and "-18" alone is not.
 */
export type BrokenReading = {
  readonly gapPp: number
  readonly n: number
  readonly realPp: number
  readonly replayPp: number
}

export type Sensors = {
  /**
   * The two stream readings are `Sensed` like every other, deliberately.
   *
   * "The logs are healthy" is a MEASUREMENT with an age, not a fact: the old bot held it as
   * a bare boolean, so a health flag that stopped being updated read as healthy forever.
   * Carrying the age is what lets `risk-logs-stale` fire on a stream that went quiet rather
   * than only on one that reported a problem.
   */
  readonly logsHealthy: Sensed<boolean> | null
  /** False while public observation must be checked before an entry. Absent on old tapes. */
  readonly entryReady?: boolean
  readonly quietEntryHold?: boolean
  readonly feedConnected: Sensed<boolean> | null
  /**
   * The two readings the replay produces, and the ONLY two. Both are columns of one vector.
   *
   * `venue` halts and resumes the book; `bars` picks its take-profit rung. They were four
   * sensors across two processes in the old bot (the 1.21x touch gate, the venue sum, the
   * scenario selector and the fresh-recovery reading), three of which are now deleted rather
   * than ported: a second opinion about the same launches is not redundancy, it is a pair of
   * numbers that can disagree with nobody to arbitrate.
   *
   * KEYED BY BOOK, AND THAT IS THE POINT OF THE WHOLE STEP. A book is a complete policy: its
   * own band, its own filter, its own launches, so its own market reading and its own halt.
   * The old bot summed the whole cohort into one verdict with no book filter, which is why it
   * refuses to start with two books configured (`config/schema.ts:508`). Two policies trading
   * different coins off one blended opinion is not a simplification, it is a wrong answer for
   * both of them.
   *
   * A MISSING KEY IS "NEVER READ", not "shut". `readSensor` turns that into `sensor-unreadable`
   * with the book named, which is a different operator action from a book that is paused.
   */
  readonly venue: ReadonlyMap<string, Sensed<VenueReading>>
  readonly bars: ReadonlyMap<string, Sensed<BarsReading>>
  readonly broken: Sensed<BrokenReading> | null
  /** template keys currently blocked, published by the blocklist reader */
  readonly templateBlocked: Sensed<readonly string[]> | null
}

export const NO_SENSORS: Sensors = {
  logsHealthy: null, feedConnected: null,
  venue: new Map(), bars: new Map(), broken: null, templateBlocked: null,
}

/** Which sensors a decision actually consulted, so a refusal can name the one that was silent. */
export type SensorUse = { readonly sensor: SensorName; readonly reading: Aged<unknown> | null }

// ---------------------------------------------------------------------------
// Launch plumbing
// ---------------------------------------------------------------------------

/**
 * What the launch call told us, parsed from the creator's own calldata.
 *
 * It carries the curve's full `CurveParams` rather than a handful of extracted numbers,
 * because every simulation needs all of them and a decision that rebuilt params from parts
 * would be simulating a curve slightly different from the one on chain.
 *
 * `exemptions` is nullable and that is load-bearing: null means the calldata never reached
 * us, 0 means the creator registered none. Both decline the launch, but only one of them is
 * a fault on our side.
 */
export type LaunchMeta = {
  readonly token: string
  readonly curve: string
  readonly params: import('./curve.js').CurveParams
  readonly exemptions: number | null
  readonly deployer: string
  readonly launchedAt: number
  readonly block: number
}

/**
 * A launch we have seen and cannot yet judge, because the curve's parameters are a CHAIN
 * READ and have not come back.
 *
 * This is a real state, not a gap to paper over. `TokenLaunched` carries the token, the
 * curve and the deployer, and nothing else: the creator tax, the supply and the snipe-tax
 * schedule all live on the curve contract. Every filter needs the tax, so the launch waits
 * here until the read lands.
 *
 * It costs nothing in entry timing. The arm delay is 2,000ms by spec and a curve read is
 * tens of milliseconds, so the read is long back before the entry window opens. Modelling
 * it as a wait rather than hiding it behind a synchronous read is what keeps the fold free
 * of I/O.
 */
export type PendingLaunch = {
  readonly token: string
  readonly curve: string
  readonly deployer: string
  readonly block: number
  /** the launch transaction, so the dev buy is not later counted as an early wallet */
  readonly tx: string
  readonly seenAt: number
  /** summed across the whole log batch before any launch in it is judged */
  readonly devBuyWei: bigint
  /**
   * Curve logs seen before the metadata read came back, held for the observation.
   *
   * The creator's own buy lands in the SAME transaction as the launch, so it arrives before
   * anything knows the curve's parameters. Dropping it would mean every replay started from
   * an empty curve the market had already moved, which is the one event that moves it most.
   */
  readonly events: SimEvent[]
}

/** A launch waiting for its entry clock to release. */
export type Armed = {
  readonly token: string
  /** pinned when the book admitted it, so the entry and the eventual loss agree on the key */
  readonly templateKey: string
  readonly devBuyWei: bigint
  readonly meta: LaunchMeta
  readonly armAt: number
  /** the block that released it, or null when the wall-clock fallback did */
  releasedByBlock: number | null
}

/**
 * A transaction we have decided on and not yet seen settle.
 *
 * IT IS CREATED WHEN THE INTENT IS, not when the driver signs. An intent that exists only
 * in the driver is state the fold cannot see, and the old bot's crash recovery had to
 * rebuild exactly that from a database row plus a chain read, with `index.ts` carrying a
 * second copy of the same lifecycle knowledge.
 *
 * A DISCRIMINATED UNION, because a buy in flight IS a pending position and carries the
 * pinned rules it will open under, while a sell in flight carries the position it closes.
 * One flat shape with optional fields would let a sell be constructed with a book and a
 * size that mean nothing.
 */
export type Inflight =
  | { readonly kind: 'buy'; readonly intentId: string; readonly token: string; readonly curve: string
      readonly book: string; readonly bookDigest: string; readonly templateKey: string
      readonly sizeWei: bigint; readonly rules: PinnedRules
      hash: string; nonce: number; signedAt: number
      /** A receipt can be retried while its balance read is unavailable. */
      receiptGasCharged?: boolean
      /**
       * Last time the fold asked the chain whether this buy's tokens are in the wallet.
       * 0 until that read is raised. Stops a clock from spamming the same read every tick
       * while a fill log is missing, which is how a skipped CurveBuy used to sit forever.
       */
      walletReadAt: number
      /** how many of those reads have been raised. Bounds the retry rate; see `ORPHAN_READ_TRIES`. */
      walletReads: number }
  | { readonly kind: 'sell'; readonly intentId: string; readonly token: string; readonly curve: string
      readonly reason: string
      /**
       * When the fold decided this exit, which is NOT when it was signed.
       *
       * The unsettled-sell release needs a clock even for a sell the driver never picked up,
       * and `signedAt` is 0 in that case. Falling back to `openedAt` instead made every such
       * sell instantly overdue, so a replay freed and re-raised the same exit on every single
       * tick: 10,764 refusals across three stuck positions in 95 minutes of tape.
       */
      readonly raisedAt: number
      hash: string; nonce: number; signedAt: number }
  | { readonly kind: 'approve'; readonly intentId: string; readonly token: string; readonly curve: string
      /** When the fill raised it. The only thing that can ever retire it; see `forgetOldRows`. */
      readonly raisedAt: number
      hash: string; nonce: number; signedAt: number }
  /**
   * A leg of the after-graduation sell.
   *
   * It carries its `step`, because the five legs are answered by one `tx-send-result` shape
   * and the fold has to know which one came back in order to decide what is next: a reverted
   * approve and a reverted swap are the same event with different consequences.
   */
  | { readonly kind: 'graduate'; readonly intentId: string; readonly token: string; readonly curve: string
      readonly step: GradStep; readonly positionId: string
      hash: string; nonce: number; signedAt: number; raw: string }

export type Gap = {
  readonly stream: GapStream
  readonly lo: number
  readonly hi: number
  readonly reason: string
}

// ---------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------

export type State = {
  /** the seq of the last folded event */
  readonly seq: number
  /** the `at` of the last folded event. The only clock in core/. */
  readonly at: number
  readonly config: FrozenConfig
  readonly switches: Switches
  /** hash of the decision stream over the certification tape. Identity is behaviour. */
  readonly kernelId: string

  readonly curves: Map<string, TrackedCurve>
  readonly positions: Map<string, Position>
  /** keyed by CURVE address, because that is what a log carries. One curve, one launch. */
  readonly observations: Map<string, Observation>
  /** settled replays, bounded. Every book's, filtered by book at the read. */
  readonly cohort: Ring<Outcome>
  /**
   * Closed trades beside what the same coin replayed at, newest last. `core/broken.ts`.
   *
   * WALLET-WIDE AND NOT PER BOOK, unlike `cohort`. Each entry is already normalised against its
   * own replay, so a pair says "we came in this far under what this coin was worth" whichever
   * policy bought it, and the fault it detects is in the code rather than in a band.
   */
  readonly pairs: Ring<TradePair>

  readonly risk: RiskState
  /** deployer address to prior launch count. Part of the observation screen. */
  readonly registry: Map<string, number>
  /** template key to the time its last real loss closed. An entry filter with an hour of memory. */
  readonly templateLossAt: Map<string, number>
  readonly sensors: Sensors

  /** launches whose curve parameters have been asked for and not yet come back */
  readonly pendingLaunches: Map<string, PendingLaunch>
  readonly armed: Map<string, Armed>
  readonly launchMetaByTx: BoundedMap<string, LaunchMeta>
  readonly launchTsByTx: BoundedMap<string, number>
  readonly launchTxUnparseable: BoundedSet<string>

  /**
   * When the feed overlay last moved, or null when there is no usable overlay.
   *
   * Null is set by a feed gap and by a disconnect, and it is what makes `risk-degraded`
   * refuse rather than let a decision fire on a price computed from confirmed logs alone.
   * The entry price is confirmed PLUS overlay by design, so no overlay is not "slightly
   * stale", it is a different quantity.
   */
  readonly overlayAt: number | null

  /**
   * What the signing wallet actually holds on chain, or null when nothing has read it.
   *
   * THIS IS NOT P&L AND IT IS NOT A DECISION INPUT. `risk.walletRealizedWei` is cumulative
   * booked profit and is what the drawdown rule reads; this is the chain's answer to "how much
   * ETH is in the account", including gas burnt, anything sent in or out, and any position
   * still held as tokens. The dashboard called P&L "TOTAL REAL WALLET / chain, not rebased"
   * for a week, which was a label describing a number it was not attached to.
   *
   * Null is honest and is rendered as unavailable: nobody has asked the chain yet.
   */
  readonly walletBalance: Sensed<bigint> | null

  readonly nonce: { next: number; inFlight: number; resyncAt: number[] }
  readonly inflight: Map<string, Inflight>

  /** every refusal ever counted, by bucket. A bucket at 100% of a window is an alert. */
  readonly counters: Record<RefusalBucket, number>
  /** trailing, drives whether a decision in this window is reproducible */
  readonly gaps: Gap[]
  /** monotonic counter that mints decision ids, so ids are stable across replays */
  readonly decisions: number
  /** the last refusals produced, for the driver to log and project. Not history. */
  readonly lastRefusals: readonly Refusal[]
}

/**
 * True when every stream was intact over the window a decision depended on.
 *
 * An appender overflow costs reproducibility, not correctness, because the live process
 * holds its state in memory either way. So a gap marks decisions inside it as unreproducible
 * and does NOT halt trading. Turning a measurement failure into a money halt is exactly the
 * defect that made a shadow-capture error stop the live bot.
 */
export function reproducible(state: State, fromAt: number): boolean {
  return !state.gaps.some((g) => g.hi >= fromAt && g.lo <= state.at)
}

/**
 * How many closed positions and untracked curves the state keeps before it starts forgetting.
 *
 * THIS PROCESS IS MEANT TO RUN FOR WEEKS. `positions` and `curves` were the two maps nothing
 * ever removed from: every launch this bot has ever watched stayed in `curves`, and every trade
 * it has ever made stayed in `positions`, where `markPositions` walks the whole map on every
 * clock tick and every feed block. The migration plan named `positions` under "still not
 * fixed"; `curves` was the same defect one line down.
 *
 * The numbers are sized so that forgetting is always old news: at this venue's rate 4,000
 * curves is more than a day of launches and 2,000 closed positions is weeks of trading, and
 * both are read back from `history`, not from here, which is why the page loses nothing.
 */
export const POSITIONS_KEPT = 2_000
export const CURVES_TRACKED = 4_000

/**
 * How long an approve record is kept before it is treated as dead.
 *
 * `foldSendResult` deletes an approve the moment its send answers, which is the live path and
 * takes seconds. A REPLAY cannot rely on that: the fold mints its own intent ids, so an id on
 * the tape need not be one this fold ever minted, the send result then finds no record, and
 * the approve sits there for the rest of the run. That is how a boot rebuilt 3,415 dead ones.
 * Five minutes is far past any send the driver will still answer, and nothing reads an approve
 * after its send: no fill matches it (an approve emits `Approval`) and no receipt path looks
 * for it.
 */
export const APPROVE_KEPT_MS = 300_000

/**
 * The size above which the in-flight sweep runs at all.
 *
 * `forgetOldRows` is called on EVERY event, so an unconditional walk of this map would be the
 * cost of the map times the length of the tape. In ordinary running the map holds a handful of
 * records, well under this, and the walk never happens.
 */
const INFLIGHT_SWEEP_AT = 32

/**
 * How far below the ceiling a sweep goes, so that sweeping is rare instead of constant.
 *
 * Without it, every single event past the ceiling would evict exactly one row and rebuild the
 * protected set to do it. With it, that happens once per 64 rows.
 */
const SWEEP_SLACK = 64

/**
 * Forget the oldest rows nothing needs any more. NOTHING LIVE IS EVER EVICTED.
 *
 * The floor is the whole point of writing this by hand instead of reaching for `BoundedMap`,
 * which evicts by age alone: an open position whose curve was dropped would mark against a
 * curve that is not there, `markPositions` would skip it, and the bot would hold a bag it had
 * stopped pricing. So a curve survives while it has an open position, a pending launch, an
 * armed entry or a running observation, however old it is, and a position survives until it is
 * closed. If everything is live, nothing is evicted and the map is allowed over its ceiling:
 * that is a bounded overshoot (`risk.maxConcurrent`) and the honest answer.
 */
export function forgetOldRows(s: State): void {
  if (s.positions.size > POSITIONS_KEPT) {
    const target = Math.max(1, POSITIONS_KEPT - SWEEP_SLACK)
    for (const [id, p] of s.positions) {
      if (s.positions.size <= target) break
      if (!p.closed) continue
      s.positions.delete(id)
    }
  }

  if (s.inflight.size > INFLIGHT_SWEEP_AT) {
    for (const [id, f] of s.inflight) {
      if (f.kind !== 'approve') continue
      if (s.at - f.raisedAt <= APPROVE_KEPT_MS) continue
      s.inflight.delete(id)
    }
  }

  if (s.curves.size > CURVES_TRACKED) {
    const needed = new Set<string>()
    for (const p of s.positions.values()) if (!p.closed) needed.add(p.curve)
    for (const a of s.armed.values()) needed.add(a.meta.curve)
    const target = Math.max(1, CURVES_TRACKED - SWEEP_SLACK)
    for (const addr of s.curves.keys()) {
      if (s.curves.size <= target) break
      if (needed.has(addr) || s.pendingLaunches.has(addr) || s.observations.has(addr)) continue
      s.curves.delete(addr)
    }
  }
}

/** The ledger for a book, created on first use so a new book needs no migration. */
export function bookLedger(risk: RiskState, book: string): BookLedger {
  let l = risk.books.get(book)
  if (!l) {
    l = { book, realizedWei: 0n, gasWei: 0n, peakWei: 0n, dayRealizedWei: 0n }
    risk.books.set(book, l)
  }
  return l
}

/** Map key for an operator stop. No book is STOP ALL; a book is that policy only. */
export function stoppedKey(book: string | null | undefined): string {
  return book ? `stopped:${book}` : 'stopped'
}

/** Halt lookup honours scope: a wallet-wide halt stops every book. */
export function haltedFor(risk: RiskState, book: string): Halt | null {
  for (const h of risk.halts.values()) {
    if (h.book === null || h.book === book) return h
  }
  return null
}

/**
 * A halt that stops EVERY book, or null.
 *
 * Venue and per-book drawdown are scoped. Treating the first halt in the map as the wallet
 * made one book's pause paint the whole bot STOPPED, and turned the START button into STOP ALL.
 */
export function walletHalted(risk: RiskState): Halt | null {
  for (const h of risk.halts.values()) {
    if (h.book === null) return h
  }
  return null
}

/**
 * This book's OWN halt, ignoring wallet-wide ones. The display's question, not the gate's.
 *
 * `haltedFor` answers "may this book trade", which is what a decision needs and which a
 * wallet-wide halt also answers no to. A page that used it to label each book printed one
 * wallet halt once per declared book, plus the wallet line, which is three alerts for one
 * event. Keyed by scanning rather than by lookup because the halt map is keyed by cause
 * (`drawdown:main`, `venue:main`, `wallet`, `stopped`), not by book.
 */
export function haltedBy(risk: RiskState, book: string): Halt | null {
  for (const h of risk.halts.values()) {
    if (h.book === book) return h
  }
  return null
}

/**
 * A state that has folded nothing.
 *
 * Every replay starts here and reaches the live state by folding the tape, which is the
 * property the whole design rests on: if this function and the tape do not determine the
 * state, something is reading a clock or a database behind the fold's back.
 *
 * The bounds are declared here rather than at each use, so the ceiling on every cache in
 * the system is visible in one place. They are sized from the old bot's measured traffic:
 * ~13 logs a second and a few hundred launches a day, so 2,048 tx keys is well over an
 * hour of history and 20,000 entered tokens is months.
 */
/** The largest guard window any book asks for, so the shared cohort ring can satisfy all of them. */
function widestWindow(config: FrozenConfig): number {
  let n = 1
  for (const b of config.books) if (b.guard.window > n) n = b.guard.window
  return n
}

export function emptyState(config: FrozenConfig, switches: Switches, kernelId = ''): State {
  const counters = Object.fromEntries(REFUSAL_BUCKETS.map((b) => [b, 0])) as Record<RefusalBucket, number>
  return {
    seq: 0, at: 0, config, switches, kernelId,
    curves: new Map(), positions: new Map(), observations: new Map(),
    /**
     * ONE RING FOR EVERY BOOK, SIZED SO THE RAREST BOOK STILL FILLS ITS WINDOW.
     *
     * A fixed 200 was safe with one book and quietly wrong with two. The taxed band sees a
     * small share of launches, so a shared 200-row ring could evict its rows before it ever
     * had 20, and its guard would read `only 8 of 20 scored` forever while looking healthy.
     * A sensor that can never reach its own window is a sensor that never fires.
     *
     * 40x the window per book is ~13 hours of the live venue's traffic at the untaxed book's
     * share, which comfortably covers the 3-hour freshness bound that makes a window usable.
     */
    cohort: new Ring(Math.max(200, config.books.length * widestWindow(config) * 40)),
    /**
     * PAIRED TRADES, wallet-wide. The detector reads the newest `risk.brokenWindow` of them; the
     * rest is history, so the report can show where the gap has been and not just where it is.
     *
     * A CONSTANT RATHER THAN A MULTIPLE OF THE WINDOW, because `config` is replaced wholesale by
     * a `config-applied` row while this ring is built once. Sizing from the window would let a
     * spec change leave a ring too small to ever fill it; instead the spec is refused at load for
     * asking for more than this, which is the same bound under a name.
     */
    pairs: new Ring(BROKEN_PAIRS_KEPT),
    risk: {
      halts: new Map(), books: new Map(),
      walletRealizedWei: 0n, walletGasWei: 0n, walletPeakWei: 0n,
      everEntered: new BoundedSet(20_000),
      reserved: 0, deployedWei: 0n, dayStamp: 0,
    },
    registry: new Map(), templateLossAt: new Map(), sensors: NO_SENSORS,
    pendingLaunches: new Map(), armed: new Map(),
    launchMetaByTx: new BoundedMap(2_048),
    launchTsByTx: new BoundedMap(2_048),
    launchTxUnparseable: new BoundedSet(2_048),
    overlayAt: null,
    walletBalance: null,
    nonce: { next: 0, inFlight: 0, resyncAt: [] },
    inflight: new Map(),
    counters, gaps: [], decisions: 0, lastRefusals: [],
  }
}
