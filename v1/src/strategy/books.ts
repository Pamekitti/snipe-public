/**
 * The books, resolved from config and routed by creator tax.
 *
 * WHY THIS FILE IS SEPARATE FROM entry.ts. `src/strategy/entry.ts` is hashed into
 * SHADOW_KERNEL (see shadow-account.ts), so editing it marks every queued shadow job
 * `unavailable` and demands an explicit reconstruction. It does not need editing: `pickEntry`
 * already takes `cfg: EntryConfig = liveEntryConfig()`, so per-book entry is nothing more
 * than passing a different config at the call site. That is what this file produces.
 *
 * THE ONE INVARIANT EVERYTHING ELSE RESTS ON. Configured bands are disjoint, refused at
 * config load by crossCheck if they are not. A launch has one creator tax, so `routeBook`
 * returns at most one book. There is no contention for a launch, no shared position, no split
 * fill and no arbiter anywhere downstream, and none of that is a coincidence: it is that one
 * rule, enforced in one place.
 *
 * This file is in NEITHER MODEL_HASH nor SHADOW_KERNEL, which is safe because the digest it
 * computes is written onto every position row. The durable record is the values, not the
 * function that produced them.
 */
import { createHash } from 'node:crypto'
import { RISK, STRATEGY } from '../config.js'
import type { EntryConfig } from './entry.js'

export type LiveBook = {
  /** the operator's own name. This is what goes in positions.book, halt reasons and log lines. */
  id: string
  minTaxBps: number
  maxTaxBps: number
  /** the entry filter for this book, ready to hand to pickEntry */
  entry: EntryConfig
  /** 8 hex chars over the FILTER only; see bookDigest */
  digest: string
}

/**
 * The identity of a book's FILTER, and deliberately not of the book's economics.
 *
 * Over the band, the exempt floor and the template block, and NOT over tradeSizeEth,
 * bankrollEth, maxConcurrent or any exit rule. A stake change must not move it, or every open
 * row's digest would stop matching its own book the moment the operator resized, and the boot
 * check below would refuse to start for a change that altered no filter.
 *
 * What it IS for: catching a band that moved under a name that did not. `positions.book`
 * records `taxed`; if `taxed` silently becomes 60-10000 tomorrow, the name still matches and
 * only the digest says so.
 */
export function bookDigest(b: { minTaxBps: number; maxTaxBps: number; minExemptionsToEnter: number; templateLossBlockMs: number }): string {
  const canonical = JSON.stringify([b.minTaxBps, b.maxTaxBps, b.minExemptionsToEnter, b.templateLossBlockMs])
  return createHash('sha256').update(canonical).digest('hex').slice(0, 8)
}

/**
 * The configured books, with an entry config each. Read live, so a band edit applies without
 * a restart exactly like every other hot key.
 *
 * With one book this returns precisely what `liveEntryConfig()` returns today, which is the
 * no-behaviour-change property the whole phasing rests on.
 */
export function liveBooks(): LiveBook[] {
  const shared = {
    minExemptionsToEnter: STRATEGY.minExemptionsToEnter,
    templateLossBlockMs: STRATEGY.templateLossBlockMs,
    tradeSizeEth: STRATEGY.tradeSizeEth,
  }
  return STRATEGY.books.map((b) => ({
    id: b.id,
    minTaxBps: b.minTaxBps,
    maxTaxBps: b.maxTaxBps,
    entry: { minCreatorTaxBps: b.minTaxBps, maxCreatorTaxBps: b.maxTaxBps, ...shared },
    digest: bookDigest({ minTaxBps: b.minTaxBps, maxTaxBps: b.maxTaxBps, ...shared }),
  }))
}

/**
 * Which book may buy this launch, or null when none may.
 *
 * Returns ONE book or none, never a list, because the bands are disjoint. A failed tax read
 * arrives as -1 and belongs to no book: it is not the same thing as untaxed, and a book with
 * a floor of 0 must not inherit every launch whose tax could not be read.
 */
export function routeBook<T extends { minTaxBps: number; maxTaxBps: number } = LiveBook>(
  creatorTaxBps: bigint,
  // Generic over the band pair alone, so a caller holding only `{id, minTaxBps, maxTaxBps}`
  // (the dashboard's reject funnel does) routes through this ONE rule rather than writing a
  // second copy of the comparison somewhere the disjointness argument does not reach.
  books: readonly T[] = liveBooks() as unknown as readonly T[],
): T | null {
  if (creatorTaxBps < 0n) return null
  const tax = Number(creatorTaxBps)
  return books.find((b) => tax >= b.minTaxBps && tax <= b.maxTaxBps) ?? null
}

/** One line for the boot banner and the dashboard: what is configured and what it totals. */
export function booksBanner(books: readonly LiveBook[] = liveBooks()): string {
  const list = books.map((b) => `${b.id} ${b.minTaxBps}-${b.maxTaxBps}bps [${b.digest}]`).join(', ')
  // The arithmetic is spelled out because per-book drawdown makes the WALLET total the number
  // that actually bounds the loss, and it is not written anywhere else.
  const total = `${books.length} x ${RISK.maxDrawdownEth} = ${(books.length * RISK.maxDrawdownEth).toFixed(4)} ETH of per-book allowance, wallet stop ${RISK.maxWalletDrawdownEth} ETH, bankroll ${STRATEGY.bankrollEth} ETH`
  return `books  ${list}  |  ${total}`
}
