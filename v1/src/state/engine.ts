/**
 * Per-curve reserve state, maintained locally so exit decisions never wait on an RPC.
 *
 * Two layers. `confirmed` moves only on authoritative logs, which exist only for
 * transactions that actually succeeded, so a revert can never corrupt it. `pending`
 * holds feed transactions we have seen ordered but not yet confirmed; replaying them
 * over confirmed state gives the working view, which runs ~100-500ms ahead.
 *
 * Because we have exact curve math we can simulate each pending transaction before
 * applying it and drop the ones that will revert on their own slippage bound. That
 * removes the dominant revert class, which is rival bots racing each other at exactly
 * the moments we care about.
 *
 * Exit *triggers* read the working view (fast). Exit *minQuoteOut* reads confirmed
 * (conservative). So an optimistic mistake can only mistime a fire, never book a bad fill.
 */
import { decodeFunctionData } from 'viem'
import { curveAbi, EVENT_TOPICS, SELECTORS, logWord } from '../abi.js'
import { simBuy, simSell, markToExit, midPrice, sellableTokens, graduationProgress, CurveRevert, type CurveParams, type CurveState } from './curve.js'
import type { RawLog } from '../logs/subscriber.js'
import type { FeedTx } from '../feed/decoder.js'
import { RISK, STRATEGY } from '../config.js'

export type TrackedCurve = {
  curve: string
  token: string
  params: CurveParams
  confirmed: CurveState
  /** highest block a log has been folded FROM; prunes the overlay, guards nothing */
  confirmedBlock: number
  /**
   * The block the confirmed book was READ at (`track`). Logs at or below it are inside the
   * read and are skipped; that is the guard's only job. `confirmedBlock` is not a "fully
   * folded" marker: after a block's first log it says nothing about the rest of that block,
   * and guarding on it dropped 67 of 115 trades on one coin (position 1935, 2026-09-06),
   * every one sharing a block with an earlier log. Logs delivered twice are deduped
   * upstream (subscriber.ts keyOf); the engine never dedupes by block.
   */
  seedBlock: number
  pending: { block: number; tx: FeedTx; at: number }[]
  working: CurveState
  workingAt: number
  degraded: boolean
  /**
   * Counterfactual state for shadow mode: identical to confirmed except that our own
   * (unbroadcast) buy is folded in. Without this, paper marks ignore the price we
   * ourselves would have moved, which is most of why paper flatters live.
   */
  shadow: CurveState | null
  /**
   * A chain read taken while this position is open, waiting to be judged. The verdict can
   * only be read once the poller has folded every log up to and including `block`, which is
   * what `resolveCheck`'s two triggers establish.
   */
  pendingCheck: { state: CurveState; block: number } | null
}

/** One book-vs-chain verdict. `detail` is empty when the two agreed. */
export type BookCheckResult = { curve: string; block: number; ok: boolean; detail: string }

const BOOK_FIELDS = ['trackedQuote', 'trackedTokens', 'quoteFeeBalance', 'creatorTaxBalance', 'graduated'] as const

export class StateEngine {
  private curves = new Map<string, TrackedCurve>()
  overlayApplied = 0
  overlaySkippedRevert = 0
  /** logs at or below a curve's seed block, skipped because the read already held them */
  seedSkipped = 0
  /**
   * The confirmed book against the chain, judged while the money is on the table. The
   * same-block log drop of 2026-09-06 ran for six hours because nothing compared the two:
   * the exits simply fired at wrong prices and the dashboard called it a model error.
   */
  bookChecks = { ok: 0, drift: 0, skipped: 0 }
  private driftAt: number[] = []
  private checkResults: BookCheckResult[] = []
  /**
   * Ground truth for the simulate-before-apply gamble. Every feed tx we predicted would
   * revert is remembered; if its log later shows up, the prediction was wrong and our
   * optimistic state was silently drifting. A false-positive rate above a few percent
   * means the overlay is doing more harm than good and should be switched off.
   */
  verdicts = { skippedThenLanded: 0, skippedTotal: 0, appliedThenLanded: 0, appliedTotal: 0 }
  private pendingVerdict = new Map<string, 'skip' | 'apply'>()

  private noteVerdict(hash: string, v: 'skip' | 'apply'): void {
    this.pendingVerdict.set(hash.toLowerCase(), v)
    if (this.pendingVerdict.size > 5_000) {
      const drop = [...this.pendingVerdict.keys()].slice(0, 2_000)
      for (const k of drop) this.pendingVerdict.delete(k)
    }
  }

  private settleVerdict(hash: string): void {
    const v = this.pendingVerdict.get(hash.toLowerCase())
    if (!v) return
    this.pendingVerdict.delete(hash.toLowerCase())
    if (v === 'skip') this.verdicts.skippedThenLanded++
    else this.verdicts.appliedThenLanded++
  }

  track(curve: string, token: string, params: CurveParams, state: CurveState, block: number): TrackedCurve {
    const c: TrackedCurve = {
      curve: curve.toLowerCase(), token: token.toLowerCase(), params,
      confirmed: state, confirmedBlock: block, seedBlock: block, pending: [],
      working: state, workingAt: Date.now(), degraded: false, shadow: null, pendingCheck: null,
    }
    this.curves.set(c.curve, c)
    return c
  }

  get(curve: string): TrackedCurve | undefined {
    return this.curves.get(curve.toLowerCase())
  }

  untrack(curve: string): void {
    const k = curve.toLowerCase()
    if (this.curves.get(k)?.pendingCheck) this.bookChecks.skipped++
    this.curves.delete(k)
  }

  /**
   * Hold a chain read for comparison against the confirmed book.
   *
   * False means there is nothing to judge: the curve is gone, or the fold is already past
   * the read's block, so `confirmed` holds trades the read does not and a mismatch would
   * say nothing. A second arm displaces the first, which only happens when the poller has
   * stalled longer than the gap between checks; the newer read is the useful one.
   */
  armCheck(curve: string, read: { state: CurveState; block: number }): boolean {
    const c = this.curves.get(curve.toLowerCase())
    if (!c) return false
    if (c.confirmedBlock > read.block) { this.bookChecks.skipped++; return false }
    if (c.pendingCheck) this.bookChecks.skipped++
    c.pendingCheck = { state: read.state, block: read.block }
    return true
  }

  /**
   * The poller has folded every block up to `tip`. Judges every check that covers, and
   * returns the verdicts since the last call. This is the trigger for a quiet curve: one
   * that never trades again above the read's block would otherwise never be judged.
   */
  settleChecks(tip: number): BookCheckResult[] {
    for (const c of this.curves.values()) if (c.pendingCheck && tip >= c.pendingCheck.block) this.resolveCheck(c)
    return this.checkResults.splice(0)
  }

  private resolveCheck(c: TrackedCurve): void {
    const chk = c.pendingCheck!
    c.pendingCheck = null
    const diffs = BOOK_FIELDS.filter((f) => c.confirmed[f] !== chk.state[f])
    if (!diffs.length) {
      this.bookChecks.ok++
      this.checkResults.push({ curve: c.curve, block: chk.block, ok: true, detail: '' })
      return
    }
    this.bookChecks.drift++
    this.driftAt.push(Date.now())
    const detail = `book drift at block ${chk.block}: ` + diffs.map((f) => `${f} ${c.confirmed[f]} vs chain ${chk.state[f]}`).join(', ')
    this.reseed(c.curve, chk.state, chk.block)
    this.checkResults.push({ curve: c.curve, block: chk.block, ok: false, detail })
  }

  /**
   * Replace the confirmed book with a chain read taken at `block`. Pending feed txs at or
   * below it are dropped by `rebase` (the read already holds them) and later ones replay on
   * top, so the working view stays as fast as it was.
   */
  reseed(curve: string, state: CurveState, block: number): void {
    const c = this.curves.get(curve.toLowerCase())
    if (!c) return
    // the shadow book is confirmed plus our own buy: it missed exactly what confirmed missed
    if (c.shadow) c.shadow = {
      trackedQuote: c.shadow.trackedQuote + (state.trackedQuote - c.confirmed.trackedQuote),
      trackedTokens: c.shadow.trackedTokens + (state.trackedTokens - c.confirmed.trackedTokens),
      quoteFeeBalance: c.shadow.quoteFeeBalance + (state.quoteFeeBalance - c.confirmed.quoteFeeBalance),
      creatorTaxBalance: c.shadow.creatorTaxBalance + (state.creatorTaxBalance - c.confirmed.creatorTaxBalance),
      graduated: state.graduated,
    }
    c.confirmed = state
    c.seedBlock = block
    c.confirmedBlock = block
    this.rebase(c)
  }

  /** Book-vs-chain disagreements in the trailing hour. */
  bookDrift1h(now = Date.now()): number {
    this.driftAt = this.driftAt.filter((t) => now - t < 3_600_000)
    return this.driftAt.length
  }

  list(): TrackedCurve[] {
    return [...this.curves.values()]
  }

  /** Fold an authoritative log into confirmed state, then rebase the overlay. */
  applyLog(log: RawLog): void {
    const c = this.curves.get(log.address)
    if (!c) return
    const topic = log.topics[0]
    const w = (n: number) => logWord(log.data, n)
    // the same delta is applied to both books; only the starting point differs
    // did this tx match what our overlay predicted for it?
    if (topic === EVENT_TOPICS.CurveBuy || topic === EVENT_TOPICS.CurveSell) this.settleVerdict(log.transactionHash)
    // A log above the read's block means every log at or below it has folded (they arrive
    // ordered by block then index), so the book is exactly "through" the read: judge before
    // this log moves it.
    if (c.pendingCheck && log.blockNumber > c.pendingCheck.block) this.resolveCheck(c)
    // The confirmed book was seeded from a chain read at `seedBlock` (readCurve), which
    // already contains every log up to and including that block; folding one of those in
    // again double-counts it (the socket path tracks the curve before the creator's own buy
    // lands as a log). Everything above the seed folds, including every later log of a block
    // whose first log already moved confirmedBlock. See TrackedCurve.seedBlock.
    if (log.blockNumber <= c.seedBlock) { this.seedSkipped++; return }
    const delta = this.deltaFor(topic, w)
    if (!delta) return
    c.confirmed = delta(c.confirmed)
    if (c.shadow) c.shadow = delta(c.shadow)
    c.confirmedBlock = Math.max(c.confirmedBlock, log.blockNumber)
    this.rebase(c)
  }

  /** Turn a log into a pure state transition, so it can be replayed onto any book. */
  private deltaFor(topic: string | undefined, w: (n: number) => bigint): ((s: CurveState) => CurveState) | null {
    switch (topic) {
      case EVENT_TOPICS.CurveBuy: {
        // quoteIn is what was actually spent; fee already includes any snipe tax
        const [quoteIn, tokensOut, fee, tax] = [w(0), w(1), w(2), w(3)]
        return (s) => ({ ...s, trackedQuote: s.trackedQuote + quoteIn, trackedTokens: s.trackedTokens - tokensOut,
          quoteFeeBalance: s.quoteFeeBalance + fee, creatorTaxBalance: s.creatorTaxBalance + tax })
      }
      case EVENT_TOPICS.CurveSell: {
        const [tokensIn, quoteOut, fee, tax] = [w(0), w(1), w(2), w(3)]
        return (s) => ({ ...s, trackedQuote: s.trackedQuote - quoteOut, trackedTokens: s.trackedTokens + tokensIn,
          quoteFeeBalance: s.quoteFeeBalance + fee, creatorTaxBalance: s.creatorTaxBalance + tax })
      }
      case EVENT_TOPICS.BuybackLocked: {
        const locked = w(1)
        return (s) => ({ ...s, trackedTokens: s.trackedTokens - locked })
      }
      case EVENT_TOPICS.FeesSwept: {
        // protocol + creator leave the curve; the buyback slice stays as tradeable reserve
        const [protocolAmt, creatorAmt] = [w(0), w(2)]
        return (s) => ({ ...s, trackedQuote: s.trackedQuote - protocolAmt - creatorAmt, quoteFeeBalance: 0n, creatorTaxBalance: 0n })
      }
      case EVENT_TOPICS.FeesRescued: {
        const [protocolAmt, creatorAmt] = [w(0), w(1)]
        return (s) => ({ ...s, trackedQuote: s.trackedQuote - protocolAmt - creatorAmt, quoteFeeBalance: 0n, creatorTaxBalance: 0n })
      }
      case EVENT_TOPICS.CurveCompleted:
        return (s) => ({ ...s, trackedQuote: 0n, trackedTokens: 0n, graduated: true })
      default:
        return null
    }
  }

  /** Fold our own simulated buy into a private book that tracks the curve from here on. */
  openShadow(curve: string, state: CurveState): void {
    const c = this.curves.get(curve.toLowerCase())
    if (c) c.shadow = state
  }

  /** Exit proceeds in the counterfactual world where our buy did happen. */
  markShadow(curve: string, tokens: bigint): bigint {
    const c = this.curves.get(curve.toLowerCase())
    if (!c) return 0n
    return markToExit(c.params, c.shadow ?? c.working, tokens)
  }

  /** Queue an ordered-but-unconfirmed transaction seen on the feed. */
  applyFeedTx(curve: string, block: number, tx: FeedTx): void {
    const c = this.curves.get(curve)
    if (!c || block <= c.confirmedBlock) return
    c.pending.push({ block, tx, at: Date.now() })
    this.rebase(c)
  }

  /** A feed gap means our pending list has holes, so it is worthless. Drop it. */
  dropOverlay(): void {
    for (const c of this.curves.values()) {
      c.pending = []
      this.rebase(c)
    }
  }

  private rebase(c: TrackedCurve): void {
    // prunes through the highest folded block; inside a batch the rest of that block folds
    // synchronously, so nothing can read the book between its first and last log
    c.pending = c.pending.filter((p) => p.block > c.confirmedBlock)
    let s = c.confirmed
    for (const p of c.pending) {
      const applied = this.applyPendingTx(c, s, p.tx, p.block)
      if (applied) s = applied
    }
    c.working = s
    c.workingAt = Date.now()
    const oldest = c.pending[0]?.at
    c.degraded = oldest !== undefined && Date.now() - oldest > RISK.maxOverlayAgeMs
  }

  /**
   * Simulate before applying. If the transaction would revert on its own slippage
   * bound it never touches state, which is how we stay right through rival races.
   */
  private applyPendingTx(c: TrackedCurve, s: CurveState, tx: FeedTx, _block: number): CurveState | null {
    if (!tx.data || tx.data.length < 10) return null
    const selector = tx.data.slice(0, 10)
    if (selector !== SELECTORS.buy && selector !== SELECTORS.sell) return null
    try {
      const { functionName, args } = decodeFunctionData({ abi: curveAbi, data: tx.data })
      if (functionName === 'buy') {
        const [quoteIn, minTokensOut] = args as [bigint, bigint, string]
        // we cannot know if the sender is snipe-tax exempt, and assuming they are not
        // is the conservative choice: it understates how much the curve moved
        const r = simBuy(c.params, s, quoteIn, BigInt(Math.floor(Date.now() / 1000)), { minTokensOut })
        this.overlayApplied++
        this.verdicts.appliedTotal++
        this.noteVerdict(tx.hash, 'apply')
        return r.next
      }
      if (functionName === 'sell') {
        const [tokensIn, minQuoteOut] = args as [bigint, bigint, string]
        const r = simSell(c.params, s, tokensIn, { minQuoteOut })
        this.overlayApplied++
        this.verdicts.appliedTotal++
        this.noteVerdict(tx.hash, 'apply')
        return r.next
      }
    } catch (e) {
      if (e instanceof CurveRevert) {
        this.overlaySkippedRevert++
        this.verdicts.skippedTotal++
        this.noteVerdict(tx.hash, 'skip')
      }
      return null
    }
    return null
  }

  /** Proceeds if we sold `tokens` right now. Working view: fast, for triggers. */
  markWorking(curve: string, tokens: bigint): bigint {
    const c = this.curves.get(curve.toLowerCase())
    return c ? markToExit(c.params, c.working, tokens) : 0n
  }

  /**
   * The curve's raw mid price right now, working view. For the REGIME GATE only.
   *
   * Deliberately a sibling of markWorking rather than a flag on it, because the two return
   * different units and mixing them is not a rounding error: markWorking is proceeds in
   * wei (~7.5e15 on our size), this is a price scaled by PRICE_SCALE (~1e9). Feeding one
   * into a peak initialised from the other reported a multiple of 2,354,341x and scored
   * every launch as a touch. See test/observation.test.ts.
   */
  midWorking(curve: string): bigint {
    const c = this.curves.get(curve.toLowerCase())
    return c ? midPrice(c.params, c.working) : 0n
  }

  /** Proceeds on confirmed state only. Conservative, for setting minQuoteOut. */
  markConfirmed(curve: string, tokens: bigint): bigint {
    const c = this.curves.get(curve.toLowerCase())
    return c ? markToExit(c.params, c.confirmed, tokens) : 0n
  }

  /**
   * True while there is still time to act. Fires on approach, not on arrival, because
   * once sellable reaches zero the curve stops accepting sells entirely.
   */
  isGraduating(curve: string): boolean {
    const c = this.curves.get(curve.toLowerCase())
    if (!c) return false
    if (c.working.graduated || sellableTokens(c.params, c.working) === 0n) return true
    return graduationProgress(c.params, c.working) < STRATEGY.graduationExitAt
  }

  /** Fraction of sellable supply remaining, for telemetry. */
  progress(curve: string): number {
    const c = this.curves.get(curve.toLowerCase())
    return c ? graduationProgress(c.params, c.working) : 1
  }

}
