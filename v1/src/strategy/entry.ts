/**
 * Which book a launch enters, if any: the ONE decision point for every trading filter.
 *
 * Three filters used to be three inline blocks in bot.enter(), each with its own reject
 * bucket and its own copy of the "after startObservation, releaseCurve not untrack" rule.
 * They live here as a pure function so the whole decision is testable without a chain and
 * so the observation-universe rule (see below) has exactly one place to be right.
 *
 * THE RULE THAT MUST NOT MOVE: none of this runs in screenCurve. screenCurve sets
 * launches.passed, and gatewatch scores WHERE passed = 1, so a trading filter there would
 * delete the control group that measures whether the filter still works. Every filter here
 * is applied AFTER bot.startObservation, so a declined launch still teaches us what the
 * venue did. That is the 08-27 gate-starvation scar generalized.
 *
 * ONE BOOK, since 2026-09-07. There were two: `main`, and a `probe` cohort that traded
 * candidate filters at a tenth the size under its own daily cap so replay results got
 * calibrated by real fills first. It is deleted, not disabled. It had been off since
 * 2026-09-06, its last standing verdict was "not paying" (55 real trades, -$6.81, against
 * a replay that said +7.0% on 376 untaxed coins with 16+ exempt wallets), and a switched-off
 * book still costs a config key, a cohort type threaded through four modules, a cap that
 * had to be converted whenever the money unit changed, and a card on the page reading OFF.
 *
 * What survives it: `positions.cohort` and every `COALESCE(cohort,'main')` filter. History
 * has probe rows in it, they were a tenth the size, and letting them into the real-vs-replay
 * comparison would poison the bot-broken halt.
 *
 * The first word of a reject reason is its funnel bucket (bot.bumpReject), so the words
 * are chosen: `tax`, `exempt`, `template-loss`.
 */
import { STRATEGY } from '../config.js'

export type EntryPick = { sizeWei: bigint } | { reject: string }

/** the slice of STRATEGY this decision reads, injectable so tests can vary it without env */
export type EntryConfig = {
  minCreatorTaxBps: number
  /**
   * Upper entry bound on creator tax, inclusive. NOT the same number as
   * STRATEGY.maxCreatorTaxBps, which is the BOOK SCREEN's sanity bound and sets
   * launches.passed. This one is a trading filter and never touches the screen, for the
   * same reason the floor does not: shrinking the observation universe deletes the control
   * group that measures whether the filter still works (the 08-27 gate starvation).
   *
   * Exists so the book can be pinned to an exact band rather than only a floor. A floor of
   * 0 admits every tax from 0 to 200; a floor of 0 with a ceiling of 0 admits only untaxed
   * launches, which is a different policy and was not previously expressible.
   */
  maxCreatorTaxBps: number
  minExemptionsToEnter: number
  /** refuse a template for this long after a real loss on it; see STRATEGY.templateLossBlockMs */
  templateLossBlockMs: number
  tradeSizeEth: number
}

export const liveEntryConfig = (): EntryConfig => ({
  minCreatorTaxBps: STRATEGY.minCreatorTaxBps,
  maxCreatorTaxBps: STRATEGY.maxEntryTaxBps,
  minExemptionsToEnter: STRATEGY.minExemptionsToEnter,
  templateLossBlockMs: STRATEGY.templateLossBlockMs,
  tradeSizeEth: STRATEGY.tradeSizeEth,
})

const wei = (eth: number): bigint => BigInt(Math.round(eth * 1e18))

export function pickEntry(
  a: {
    creatorTaxBps: bigint
    /** null when the launch calldata never arrived: treated as zero, i.e. declined */
    exemptions: number | null
    /** ms since this template's last real losing trade closed; null when it has none */
    templateLossAgeMs?: number | null
  },
  cfg: EntryConfig = liveEntryConfig(),
): EntryPick {
  const ex = a.exemptions ?? 0
  // in the order the filters were adopted: tax (08-28), exempt (09-06), template loss
  // (09-06). The first failing one names the reject.
  //
  // There was a fourth, `clock`, refusing launches outside 12-24 UTC. Deleted 2026-09-07:
  // the bot trades 24 hours behind the venue pause and the self-lifting drawdown stop, and
  // the clock was keeping only 73% of September's profit. See config.ts wsHours for the
  // measurement and for the quota lever that is all that remains of it.
  // Every stored ShadowIntent.config.entry and capture payload written before 2026-09-15
  // carries no ceiling, and those rows are replayed by shadow-account.admission() and
  // scenario-observer on every rebuild. An absent ceiling is unbounded, which is exactly the
  // policy those rows ran under, so each one keeps replaying to the identical verdict.
  // BigInt(undefined) would throw instead, which is why this is not a plain read.
  const ceiling = (cfg as { maxCreatorTaxBps?: number }).maxCreatorTaxBps ?? Number.MAX_SAFE_INTEGER
  // Both tax bounds name the same funnel bucket (`tax`), because the operator question is
  // "how many launches did the tax band refuse", not which side of it they fell on.
  const reject =
    a.creatorTaxBps < BigInt(cfg.minCreatorTaxBps) ? `tax ${a.creatorTaxBps}bps`
    : a.creatorTaxBps > BigInt(ceiling) ? `tax ${a.creatorTaxBps}bps above ${ceiling}`
    : ex < cfg.minExemptionsToEnter ? `exempt ${ex}`
    : a.templateLossAgeMs != null && a.templateLossAgeMs < cfg.templateLossBlockMs ? `template-loss ${Math.round(a.templateLossAgeMs / 60_000)}m ago`
    : null
  return reject === null ? { sizeWei: wei(cfg.tradeSizeEth) } : { reject }
}

/**
 * The identity a farm cannot change between launches without changing its script: creator
 * tax, the exact dev-buy amount, and how many exempt wallets it registered. The deployer
 * is NOT in it (a farm uses a fresh wallet per launch: four different deployers on the
 * 09-06 burst). See STRATEGY.templateLossBlockMs.
 */
export function templateKey(creatorTaxBps: bigint, devBuyWei: bigint, exemptions: number | null): string {
  return `${creatorTaxBps}:${devBuyWei}:${exemptions ?? ''}`
}
