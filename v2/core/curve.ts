/**
 * THE CURVE, ported VERBATIM from v1/src/state/curve.ts.
 *
 * Do not paraphrase this file. `npm run validate` replays ~350 real launches from chain
 * history and asserts these functions reproduce every fill bit-exactly, and that check is
 * the reason the bot can decide an exit without asking the chain anything. A rewrite that
 * "tidied" a division would pass every unit test here and be wrong by one wei on a real
 * fill, which is exactly the kind of error no test in this tree would catch.
 *
 * It imports nothing, so it was already ring-clean and moved across unchanged. The only
 * edit is this comment. Diff it against the old file before trusting any change to it:
 *
 *   diff <(tail -n +N v2/core/curve.ts) <(tail -n +M v1/src/state/curve.ts)
 *
 * Every division is floor because Solidity's is. The two exceptions are marked in place:
 * the `+1` in getAmountIn and the single ceil in the partial-fill gross-up.
 */

const BPS = 10_000n

export type CurveParams = {
  phantomQuote: bigint
  reservedTokens: bigint
  launchSupply: bigint
  feeBps: bigint
  creatorTaxBps: bigint
  snipeTaxStartBps: bigint
  snipeTaxSeconds: bigint
  launchedAt: bigint
}

export type CurveState = {
  trackedQuote: bigint
  trackedTokens: bigint
  quoteFeeBalance: bigint
  creatorTaxBalance: bigint
  graduated: boolean
}

/**
 * The curve the instant before anyone bought: the whole launch supply for sale against the
 * phantom reserve alone. The reference price for STRATEGY.maxEntryPriceMultiple: simBuy on
 * this state says what a fresh curve would give for our stake, and the ratio against what
 * the live curve gives is how far it has already been pumped when we are about to fire.
 */
export const freshCurve = (p: CurveParams): CurveState => ({
  trackedQuote: 0n, trackedTokens: p.launchSupply, quoteFeeBalance: 0n, creatorTaxBalance: 0n, graduated: false,
})

/**
 * A revert the chain would have produced, thrown so the sim unwinds the way the contract does.
 *
 * NO STACK, DELIBERATELY. This is control flow, not a fault: the replay throws one for every
 * rival buy that would have failed, and `decide` reads only `instanceof`. Capturing a stack on
 * each one cost 12 of the 45 seconds of a full tape replay. `degraded` still turns on for any
 * error that is NOT this class, so a real bug keeps its stack.
 */
export class CurveRevert extends Error {
  constructor(message?: string) {
    const limit = Error.stackTraceLimit
    Error.stackTraceLimit = 0
    super(message)
    Error.stackTraceLimit = limit
  }
}

/** quoteReserve = phantomQuote + trackedQuote - quoteFeeBalance - creatorTaxBalance */
export function reserves(p: CurveParams, s: CurveState): { q: bigint; t: bigint } {
  return { q: p.phantomQuote + s.trackedQuote - s.quoteFeeBalance - s.creatorTaxBalance, t: s.trackedTokens }
}

export function sellableTokens(p: CurveParams, s: CurveState): bigint {
  return s.trackedTokens > p.reservedTokens ? s.trackedTokens - p.reservedTokens : 0n
}

/** Sells revert while the curve merely *can* graduate, not just once it has. */
export function readyToGraduate(p: CurveParams, s: CurveState): boolean {
  return !s.graduated && sellableTokens(p, s) === 0n
}

/**
 * How much of the curve's sellable supply is left, 0 to 1.
 *
 * This matters more than it looks. Graduation is not a soft event: the moment sellable
 * hits zero the contract refuses sells outright, so a position still open at that point
 * cannot be exited on the curve at any price. Waiting for graduation to *happen* before
 * reacting is waiting until it is too late, which cost a full position (peaked at 3.65x)
 * in the first shadow run.
 */
export function graduationProgress(p: CurveParams, s: CurveState): number {
  const initial = p.launchSupply - p.reservedTokens
  if (initial <= 0n) return 0
  const left = sellableTokens(p, s)
  if (left <= 0n) return 0
  return Number((left * 10_000n) / initial) / 10_000
}

function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn === 0n) throw new CurveRevert('InsufficientInputAmount')
  if (reserveIn === 0n || reserveOut === 0n) throw new CurveRevert('InsufficientLiquidity')
  const out = (amountIn * reserveOut) / (reserveIn + amountIn)
  if (out === 0n) throw new CurveRevert('InsufficientOutputAmount')
  return out
}

function getAmountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountOut === 0n) throw new CurveRevert('InsufficientOutputAmount')
  if (reserveIn === 0n || reserveOut <= amountOut) throw new CurveRevert('InsufficientLiquidity')
  return (amountOut * reserveIn) / (reserveOut - amountOut) + 1n // the uniswap-style +1
}

/** startBps >> ((elapsed * 14) / window), then clamped so the buyer keeps at least 1%. */
export function snipeTaxBps(p: CurveParams, blockTimestamp: bigint, exempt = false): bigint {
  if (exempt || p.snipeTaxStartBps === 0n) return 0n
  const elapsed = blockTimestamp - p.launchedAt
  if (elapsed < 0n) return p.snipeTaxStartBps
  if (elapsed >= p.snipeTaxSeconds) return 0n
  const shift = (elapsed * 14n) / p.snipeTaxSeconds
  let bps = p.snipeTaxStartBps >> shift
  const max = BPS - p.feeBps - p.creatorTaxBps - 100n
  if (bps > max) bps = max
  return bps
}

export type BuyResult = {
  tokensOut: bigint
  spent: bigint
  fee: bigint
  tax: bigint
  snipeTax: bigint
  next: CurveState
}

/**
 * `received` is what actually reached the curve. The contract may spend less than that
 * when the fill is clamped at the reserved-token floor, refunding the difference.
 */
export function simBuy(
  p: CurveParams,
  s: CurveState,
  received: bigint,
  blockTimestamp: bigint,
  opts: { exempt?: boolean; minTokensOut?: bigint } = {},
): BuyResult {
  if (s.graduated) throw new CurveRevert('CurveGraduated')
  if (received === 0n) throw new CurveRevert('ZeroAmount')

  const { q: Q, t: T } = reserves(p, s)
  const stBps = snipeTaxBps(p, blockTimestamp, opts.exempt)

  let spent = received
  let fee = (spent * p.feeBps) / BPS
  let tax = (spent * p.creatorTaxBps) / BPS
  let snipeTax = (spent * stBps) / BPS
  let tokensOut = getAmountOut(spent - fee - tax - snipeTax, Q, T)

  const sellable = sellableTokens(p, s)
  if (sellable === 0n) throw new CurveRevert('CurveGraduated')

  if (tokensOut > sellable) {
    tokensOut = sellable
    const net = getAmountIn(sellable, Q, T)
    const denom = BPS - p.feeBps - p.creatorTaxBps - stBps
    const grossedUp = (net * BPS + denom - 1n) / denom // Math.mulDiv(..., Rounding.Ceil)
    spent = grossedUp < received ? grossedUp : received
    fee = (spent * p.feeBps) / BPS
    tax = (spent * p.creatorTaxBps) / BPS
    snipeTax = (spent * stBps) / BPS
  }

  // slippage is a price-ratio bound, not a quantity bound
  if (opts.minTokensOut !== undefined && spent * opts.minTokensOut > received * tokensOut) {
    throw new CurveRevert('SlippageExceeded')
  }

  const next: CurveState = {
    trackedQuote: s.trackedQuote + spent,
    trackedTokens: s.trackedTokens - tokensOut,
    quoteFeeBalance: s.quoteFeeBalance + fee + snipeTax, // snipe tax joins the fee bucket
    creatorTaxBalance: s.creatorTaxBalance + tax,
    graduated: s.graduated,
  }
  return { tokensOut, spent, fee, tax, snipeTax, next }
}

export type SellResult = { quoteOut: bigint; gross: bigint; fee: bigint; tax: bigint; next: CurveState }

/** Fees on a sell come off the *output*, unlike a buy where they come off the input. */
export function simSell(
  p: CurveParams,
  s: CurveState,
  tokensIn: bigint,
  opts: { minQuoteOut?: bigint } = {},
): SellResult {
  if (s.graduated || readyToGraduate(p, s)) throw new CurveRevert('CurveGraduated')
  if (tokensIn === 0n) throw new CurveRevert('ZeroAmount')

  const { q: Q, t: T } = reserves(p, s)
  const gross = getAmountOut(tokensIn, T, Q)
  const fee = (gross * p.feeBps) / BPS
  const tax = (gross * p.creatorTaxBps) / BPS
  const quoteOut = gross - fee - tax
  if (opts.minQuoteOut !== undefined && quoteOut < opts.minQuoteOut) throw new CurveRevert('SlippageExceeded')

  return {
    quoteOut,
    gross,
    fee,
    tax,
    next: {
      trackedQuote: s.trackedQuote - quoteOut,
      trackedTokens: s.trackedTokens + tokensIn,
      quoteFeeBalance: s.quoteFeeBalance + fee,
      creatorTaxBalance: s.creatorTaxBalance + tax,
      graduated: s.graduated,
    },
  }
}

/**
 * What our position is worth right now, net of everything, if we sold it this instant.
 * This is the mark the exit rules run on: not a spot price, but the actual exit proceeds
 * including our own impact. Returns 0n when the curve will not accept a sell.
 */
export function markToExit(p: CurveParams, s: CurveState, tokens: bigint): bigint {
  if (tokens <= 0n) return 0n
  try {
    return simSell(p, s, tokens).quoteOut
  } catch {
    return 0n
  }
}

/**
 * THE TWO PRICE HELPERS ARE GONE, and this note is here so nobody reinvents them.
 *
 * `midPrice` (raw spot, `q / t`) and `entryPrice` (gross in over tokens out) existed only to
 * be divided by each other, which is how the old observer measured a launch. That ratio starts
 * at a median of 0.9930 rather than 1.0000, because every friction sits in the denominator and
 * none in the numerator. The fix is not a tidier version of this pair: it is `sim.proceeds` on
 * BOTH ends, which is what `core/sim.ts` does and what every stored `gate.db` row was produced
 * with. `markToExit` above is the only mark in the system that a decision reads.
 */
