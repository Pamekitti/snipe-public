/**
 * The trading filter: given a launch that a book admits, may we buy it?
 *
 * THE SCREEN STILL DOES NOT RUN THIS. Pair and meta decide what we wait to read. `admits`
 * then decides both the watch and the arm, so the guard scores the same coins the book may
 * buy (tax band, exempt floor, template-loss block). A launch refused here is still counted
 * in the funnel. It is not observed and not scored. Until 2026-09-17 the watch was wider;
 * that matched the 08-27 control-group rule and not the research indicator.
 *
 * ONE FILTER, ONE PLACE. In the old bot these three checks were three inline blocks inside
 * `bot.enter()`, each with its own reject string, plus a fourth copy in the replay and a
 * fifth encoded in SQL on the dashboard. The funnel bucketed on the first word of a free
 * string, so a reason that changed wording silently moved a bucket. Here the bucket is the
 * return type and the prose is only ever read by a human.
 *
 * ORDER IS THE FUNNEL. The first failing check wins and nothing after it runs, which is
 * what makes the funnel's denominators mean anything: `entry-exempt` counts launches that
 * passed the band, not launches that failed for any reason. The order is the order the
 * filters were adopted (tax 08-28, exempt 09-06, template loss 09-06), because changing it
 * would silently re-attribute months of history.
 */
import { no, ok, type Ok } from './contracts.js'
import type { BookSpec } from './config.js'

/** What a launch offers the filter. Everything here is proved or explicitly absent. */
export type LaunchFacts = {
  readonly token: string
  readonly creatorTaxBps: number
  readonly devBuyWei: bigint
  /**
   * null when the launch calldata never arrived.
   *
   * Null and 0 are NOT the same and must not collapse. Null means the feed never gave us
   * the call, 0 means the creator registered no exempt wallets. Both decline, but only one
   * of them is a fault on our side, and a projection that renders them alike hides a broken
   * feed as a quiet market.
   */
  readonly exemptions: number | null
  readonly deployer: string
}

/**
 * The identity a farm cannot change between launches without changing its script: creator
 * tax, the exact dev-buy amount, and how many exempt wallets it registered.
 *
 * The deployer is deliberately NOT in it. A farm uses a fresh wallet per launch (four
 * different deployers on the 09-06 burst), so keying on the deployer would block nothing.
 */
export function templateKey(creatorTaxBps: number, devBuyWei: bigint, exemptions: number | null): string {
  return `${creatorTaxBps}:${devBuyWei}:${exemptions ?? ''}`
}

/**
 * May this book buy this launch?
 *
 * `templateLossAt` is when this template's last REAL losing trade closed, or null if it has
 * none. Passed in rather than read, because the fold owns it and a pure function that
 * reached for it would need a clock to age it.
 */
export function admits(
  at: number,
  book: BookSpec,
  l: LaunchFacts,
  templateLossAt: number | null,
): Ok<{ readonly book: string; readonly templateKey: string }> {
  // Both tax bounds name the same bucket, because the operator question is "how many
  // launches did the band refuse", not which side of it they fell on.
  if (l.creatorTaxBps < book.minCreatorTaxBps || l.creatorTaxBps > book.maxCreatorTaxBps) {
    return no(at, 'entry-tax', l.token,
      `creator tax ${l.creatorTaxBps}bps outside ${book.id}'s band ${book.minCreatorTaxBps}-${book.maxCreatorTaxBps}`)
  }
  const ex = l.exemptions ?? 0
  if (ex < book.minExemptions) {
    const how = l.exemptions === null ? 'launch calldata never arrived, so exemptions are unknown and count as 0' : `${ex} exempt wallets`
    return no(at, 'entry-exempt', l.token, `${how}, below ${book.id}'s floor of ${book.minExemptions}`)
  }
  const key = templateKey(l.creatorTaxBps, l.devBuyWei, l.exemptions)
  if (templateLossAt !== null) {
    const ageMs = at - templateLossAt
    if (ageMs >= 0 && ageMs < book.templateLossBlockMs) {
      return no(at, 'entry-template-loss', l.token,
        `template ${key} lost ${Math.round(ageMs / 60_000)}m ago, blocked for ${Math.round(book.templateLossBlockMs / 60_000)}m`)
    }
  }
  return ok({ book: book.id, templateKey: key })
}
