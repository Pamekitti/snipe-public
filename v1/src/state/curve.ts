/**
 * Exact bigint port of PonsV2BondingCurve + PonsV2BondingCurveMath.
 *
 * Ported from the factory's verified source (solc 0.8.35). Every division here is
 * floor because Solidity's is; the only exceptions are the `+1` in getAmountIn and
 * the single ceil in the partial-fill gross-up, both marked below. Getting this
 * bit-exact is what lets the bot decide exits without asking the chain anything.
 *
 * Note the library is always called with its own feeBps=0, so the 10000 factors in
 * numerator and denominator cancel and getAmountOut reduces to floor(n*T/(Q+n)).
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

export class CurveRevert extends Error {}

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
 * Fixed-point scale for the two price helpers below. Reserves are wei-scale bigints
 * (q ~1e18, t ~1e27), so 1e18 leaves ~9 significant digits on the quotient with no
 * float anywhere in the path.
 */
export const PRICE_SCALE = 10n ** 18n

/**
 * The curve's raw mid price, quote per token, scaled by PRICE_SCALE.
 *
 * This is gatewatch.py's `Curve.price()` (`s.q / s.t`) and it exists ONLY for the regime
 * gate. Do not reach for it to price an exit: it is a spot price with no fees and no
 * impact, so it overstates what a sell would actually return. markToExit is the mark the
 * exit rules run on; this is the mark the venue measurement runs on.
 */
export function midPrice(p: CurveParams, s: CurveState): bigint {
  const { q, t } = reserves(p, s)
  if (t <= 0n || q <= 0n) return 0n
  return (q * PRICE_SCALE) / t
}

/**
 * What a buy actually costs per token, every friction included, scaled by PRICE_SCALE.
 *
 * gatewatch.py's `entry_px = X / got`: gross ETH in over tokens out, so the curve fee, the
 * creator tax, the snipe tax and our own slippage all sit in this number. Pairing it with
 * midPrice is what makes the gate's ratio start BELOW 1.0 (median 0.9930 measured over
 * 4286 launches) rather than at exactly 1.0.
 *
 * That asymmetry is the point and it is easy to "fix" by mistake. A ratio of two
 * markToExit calls cancels every friction and starts at 1.000, which sounds cleaner and
 * silently makes the bar 0.70% looser than the one openAt/shutAt were calibrated against.
 * See test/venuemark.test.ts.
 */
export function entryPrice(spentWei: bigint, tokens: bigint): bigint {
  if (tokens <= 0n || spentWei <= 0n) return 0n
  return (spentWei * PRICE_SCALE) / tokens
}
