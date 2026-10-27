/**
 * Which book a launch belongs to, if any.
 *
 * ONE LAUNCH, AT MOST ONE BOOK, AND THAT IS WHY THERE IS NO ARBITER ANYWHERE. A launch has
 * exactly one creator tax. Bands are disjoint, refused at load if they are not (see
 * core/config.ts CROSS_CHECKS). So routing is a total function from a tax to zero or one
 * book, and nothing downstream ever has to break a tie, split a fill, or decide which book
 * owns a shared position. None of that is luck: it is the disjointness rule paying out.
 *
 * WHY A BOOK EXISTS AT ALL. Two bands side by side on the same evidence can answer "is the
 * filter still right", which one band alone cannot: with a single book, changing the filter
 * changes the sensor, and every measurement afterwards is against a different universe. The
 * old repo learned this as the 08-27 gate starvation, where a trading filter applied at
 * screen time deleted the control group that measured it.
 *
 * THE DIGEST IS PINNED ON THE POSITION. A book's filter can change while a position is
 * open. `digest` is stored at open so a closed row says which policy actually admitted it,
 * rather than which policy happens to be loaded when someone reads the row back.
 */
import { compare, no, ok, type Ok } from './contracts.js'
import type { BookSpec, FrozenConfig } from './config.js'

/**
 * A stable fingerprint of the filter a book applied.
 *
 * Hand-rolled rather than a hash, because core/ may not import node:crypto: that exact
 * reach is how the old `books.ts` acquired a host dependency inside a pure decision path.
 * It is not a cryptographic digest and does not need to be. It needs to be stable, ordered,
 * and to change whenever any field a launch was judged against changes.
 *
 * The fields are listed explicitly rather than serialised from the object, so adding a
 * field to BookSpec without deciding whether it belongs in the digest is a compile error
 * below, not a silent change of meaning for every row already written.
 *
 * IT COVERS THE WHOLE POLICY SINCE 2026-09-16, not just the filter. A book now carries its own
 * entry, exit, take-profit ladder, guard, size and stop, and a closed row has to say which of
 * those admitted it. Digesting only the band would have let the exit stack move under a book
 * with every stored row still claiming the old digest, which is the exact failure the pinning
 * exists to prevent, one level up.
 */
export function bookDigest(b: BookSpec): string {
  const { id, minCreatorTaxBps, maxCreatorTaxBps, minExemptions, templateLossBlockMs, sizeWei, maxDrawdownWei } = b
  const { entryDelayMs, entryFallbackLateMs, maxEntryPriceMultiple, buySlippageBps } = b.entry
  const {
    maxHoldMs, hardStopMultiple, deadCoinAfterMs, deadCoinBelowMultiple,
    graduationExitAt, maxSellAttempts, exitRetryDelayMs, sellFinalMinQuoteOutWei,
  } = b.exit
  const { otherwise, adaptiveWindow, adaptiveBars } = b.takeProfit
  const { window, recoveryWindow, openAt, shutAt, settleMs, freshMs, pnlBar, maxReadingAgeMs } = b.guard
  return [
    `${id}|${minCreatorTaxBps}-${maxCreatorTaxBps}|x${minExemptions}|t${templateLossBlockMs}`,
    `s${sizeWei}|d${maxDrawdownWei}`,
    `e${entryDelayMs},${entryFallbackLateMs},${maxEntryPriceMultiple},${buySlippageBps}`,
    `X${maxHoldMs},${hardStopMultiple},${deadCoinAfterMs},${deadCoinBelowMultiple},${graduationExitAt},${maxSellAttempts},${exitRetryDelayMs},${sellFinalMinQuoteOutWei}`,
    `p${otherwise},${adaptiveWindow},[${adaptiveBars.join(' ')}]`,
    `g${window},${recoveryWindow},${openAt},${shutAt},${settleMs},${freshMs},${pnlBar},${maxReadingAgeMs}`,
  ].join('|')
}

/**
 * The book whose band holds this creator tax, or a refusal naming the bands that exist.
 *
 * Both bounds inclusive, which is how "untaxed only" is written: 0-0. A floor alone could
 * not express it, and that was a real limitation, not a theoretical one: the live book has
 * been 0-0 since 2026-09-15.
 *
 * Deterministic on ties by construction (bands are disjoint) and sorted by id anyway, so
 * that a config whose books are listed in a different order routes identically. A decision
 * that depends on array order is a decision that is not reproducible.
 */
export function routeBook(at: number, cfg: FrozenConfig, token: string, creatorTaxBps: number): Ok<BookSpec> {
  const sorted = [...cfg.books].sort((a, b) => compare(a.id, b.id))
  for (const b of sorted) {
    if (creatorTaxBps >= b.minCreatorTaxBps && creatorTaxBps <= b.maxCreatorTaxBps) return ok(b)
  }
  const bands = sorted.map((b) => `${b.id} ${b.minCreatorTaxBps}-${b.maxCreatorTaxBps}`).join(', ')
  return no(at, 'entry-no-book', token, `creator tax ${creatorTaxBps}bps is outside every book: ${bands || 'no books configured'}`)
}

/** Every book id, sorted, for the projections that report per book. */
export function bookIds(cfg: FrozenConfig): readonly string[] {
  return [...cfg.books].map((b) => b.id).sort(compare)
}
