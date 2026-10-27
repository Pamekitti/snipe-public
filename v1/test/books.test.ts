/**
 * The books: parsing, routing, identity, and the refusals.
 *
 * The single most important property here is that ONE configured book reproduces today
 * exactly. Every phase of the two-book work is a no-behaviour-change deploy while one book is
 * configured, and that is the entire safety argument for shipping it against a live wallet.
 *
 * The second is that overlapping bands are REFUSED. Nothing downstream has an arbiter, a
 * split fill or a shared position, and it does not need one only because a launch can belong
 * to at most one book. If that rule ever stops being enforced, the failure is the wallet
 * buying the same coin twice, not an exception.
 */
import { describe, it, expect } from 'vitest'
import { parseBooks, crossCheck, type Config } from '../src/config/schema.js'
import { bookDigest, routeBook, type LiveBook } from '../src/strategy/books.js'

const book = (id: string, minTaxBps: number, maxTaxBps: number): LiveBook => ({
  id, minTaxBps, maxTaxBps, digest: bookDigest({ minTaxBps, maxTaxBps, minExemptionsToEnter: 3, templateLossBlockMs: 3_600_000 }),
  entry: { minCreatorTaxBps: minTaxBps, maxCreatorTaxBps: maxTaxBps, minExemptionsToEnter: 3, templateLossBlockMs: 3_600_000, tradeSizeEth: 0.005 },
})

describe('parseBooks', () => {
  it('reads the target line, in the order written', () => {
    const r = parseBooks('untaxed:0-0,taxed:50-10000')
    expect(r).toEqual({ value: [
      { id: 'untaxed', minTaxBps: 0, maxTaxBps: 0 },
      { id: 'taxed', minTaxBps: 50, maxTaxBps: 10000 },
    ] })
  })

  it('tolerates the spacing an operator actually types', () => {
    expect(parseBooks(' untaxed:0-0 , taxed:50-10000 ')).toEqual(parseBooks('untaxed:0-0,taxed:50-10000'))
  })

  it('refuses a name that is not alphanumeric, because names become DOM ids', () => {
    // scripts/chart-smoke.mjs discovers elements with /\bid="([a-zA-Z0-9]+)"/g, so a dash in
    // a label would make the book's own chart invisible to the guard without failing it.
    expect(parseBooks('un-taxed:0-0')).toMatchObject({ error: expect.stringContaining('alphanumeric') })
    expect(parseBooks('un taxed:0-0')).toMatchObject({ error: expect.stringContaining('alphanumeric') })
  })

  it('refuses an inverted band, a band over the ceiling, an empty line and a fifth book', () => {
    expect(parseBooks('bad:100-50')).toMatchObject({ error: expect.stringContaining('inverted') })
    expect(parseBooks('bad:0-10001')).toMatchObject({ error: expect.stringContaining('10000') })
    expect(parseBooks('  ')).toMatchObject({ error: expect.stringContaining('no books') })
    expect(parseBooks('a:0-1,b:2-3,c:4-5,d:6-7,e:8-9')).toMatchObject({ error: expect.stringContaining('4 is the most') })
  })

  it('accepts an equal band, which is how "untaxed only" is written', () => {
    expect(parseBooks('untaxed:0-0')).toEqual({ value: [{ id: 'untaxed', minTaxBps: 0, maxTaxBps: 0 }] })
  })
})

describe('routeBook', () => {
  const books = [book('untaxed', 0, 0), book('taxed', 50, 10000)]

  it('sends a launch to exactly one book, both bounds inclusive', () => {
    expect(routeBook(0n, books)?.id).toBe('untaxed')
    expect(routeBook(50n, books)?.id).toBe('taxed')
    expect(routeBook(10000n, books)?.id).toBe('taxed')
    expect(routeBook(200n, books)?.id).toBe('taxed')
  })

  it('sends a launch in neither band to no book at all', () => {
    // 1-49 bps is a real hole in the target configuration, and a hole must read as "no book
    // may buy this", never as a silent fallback to the first one.
    expect(routeBook(1n, books)).toBeNull()
    expect(routeBook(49n, books)).toBeNull()
  })

  it('refuses a FAILED tax read, which arrives as -1 and is not the same as untaxed', () => {
    // This is the case that would quietly hand every unreadable launch to a 0-0 book.
    expect(routeBook(-1n, books)).toBeNull()
  })
})

describe('bookDigest', () => {
  it('moves when the band moves, so a band edit under an unchanged name is visible', () => {
    const base = { minTaxBps: 50, maxTaxBps: 10000, minExemptionsToEnter: 3, templateLossBlockMs: 3_600_000 }
    expect(bookDigest({ ...base, minTaxBps: 60 })).not.toBe(bookDigest(base))
    expect(bookDigest({ ...base, maxTaxBps: 9999 })).not.toBe(bookDigest(base))
    expect(bookDigest({ ...base, minExemptionsToEnter: 4 })).not.toBe(bookDigest(base))
    expect(bookDigest(base)).toHaveLength(8)
  })

  it('is stable across calls, because it is written onto every position row', () => {
    const base = { minTaxBps: 0, maxTaxBps: 0, minExemptionsToEnter: 3, templateLossBlockMs: 3_600_000 }
    expect(bookDigest(base)).toBe(bookDigest({ ...base }))
  })
})

/** A Config is 40+ fields; these tests only care about the handful each rule reads. */
const cfg = (over: Partial<Config>): Config => ({
  tradeSizeEth: 0.005, bankrollEth: 0.0796, maxDrawdownEth: 0.015, maxWalletDrawdownEth: 0.015,
  venuePauseOn: 1, venuePauseOff: -1.5, entryMinTaxBps: 0, entryMaxTaxBps: 0,
  venueExecutionScenarios: false, venueFreshRecovery: false,
  books: [{ id: 'untaxed', minTaxBps: 0, maxTaxBps: 0 }],
  ...over,
} as unknown as Config)

describe('crossCheck, the book rules', () => {
  const only = (out: string[], word: string) => out.filter((x) => x.includes(word))

  it('passes the target configuration', () => {
    const out = crossCheck(cfg({
      books: [{ id: 'untaxed', minTaxBps: 0, maxTaxBps: 0 }, { id: 'taxed', minTaxBps: 50, maxTaxBps: 10000 }],
      maxWalletDrawdownEth: 0.030,
    }), new Set(['BOOKS']))
    expect(out).toEqual([])
  })

  it('REFUSES overlapping bands, naming both, because the overlap would be bought twice', () => {
    const out = crossCheck(cfg({
      books: [{ id: 'low', minTaxBps: 0, maxTaxBps: 100 }, { id: 'high', minTaxBps: 50, maxTaxBps: 10000 }],
      maxWalletDrawdownEth: 0.030,
    }), new Set(['BOOKS']))
    expect(only(out, 'overlaps')).toHaveLength(1)
    expect(out[0]).toContain('low')
    expect(out[0]).toContain('high')
    expect(out[0]).toContain('bought twice')
  })

  it('treats a shared single bps as an overlap, since both bounds are inclusive', () => {
    const out = crossCheck(cfg({
      books: [{ id: 'a', minTaxBps: 0, maxTaxBps: 50 }, { id: 'b', minTaxBps: 50, maxTaxBps: 100 }],
      maxWalletDrawdownEth: 0.030,
    }), new Set(['BOOKS']))
    expect(only(out, 'overlaps')).toHaveLength(1)
  })

  it('refuses duplicate names, which are used as identifiers', () => {
    const out = crossCheck(cfg({
      books: [{ id: 'same', minTaxBps: 0, maxTaxBps: 0 }, { id: 'same', minTaxBps: 50, maxTaxBps: 100 }],
      maxWalletDrawdownEth: 0.030,
    }), new Set(['BOOKS']))
    expect(only(out, 'twice')).toHaveLength(1)
  })

  it('refuses the band being declared in two places at once', () => {
    const out = crossCheck(cfg({}), new Set(['BOOKS', 'ENTRY_MIN_TAX_BPS']))
    expect(only(out, 'declared twice')).toHaveLength(1)
    // ...and says nothing when only one of the two ways is used, which is both normal cases.
    expect(crossCheck(cfg({}), new Set(['BOOKS']))).toEqual([])
    expect(crossCheck(cfg({}), new Set(['ENTRY_MIN_TAX_BPS', 'ENTRY_MAX_TAX_BPS']))).toEqual([])
  })

  it('refuses a wallet stop below a book stop, which would make per-book limits unreachable', () => {
    const out = crossCheck(cfg({ maxDrawdownEth: 0.015, maxWalletDrawdownEth: 0.010 }), new Set())
    expect(only(out, 'MAX_WALLET_DRAWDOWN_ETH')).toHaveLength(1)
    expect(out[0]).toContain('before any book could reach its own limit')
    // equal is legal: that is one book, and it is exactly today
    expect(crossCheck(cfg({ maxDrawdownEth: 0.015, maxWalletDrawdownEth: 0.015 }), new Set())).toEqual([])
  })

  it('refuses a second book while the LIVE path still gates on one book', () => {
    // The measurement layer is per book since 2026-09-16, but bot.ts still builds one
    // ScenarioController and gates every entry on book 0's reading, so a second book would
    // trade against the wrong sensor. That is worse than not trading it. The box runs
    // VENUE_EXECUTION_SCENARIOS=1, so this rule is live.
    const two = { books: [{ id: 'untaxed', minTaxBps: 0, maxTaxBps: 0 }, { id: 'taxed', minTaxBps: 50, maxTaxBps: 10000 }], maxWalletDrawdownEth: 0.030 }
    expect(only(crossCheck(cfg({ ...two, venueExecutionScenarios: true }), new Set(['BOOKS'])), 'not wired yet')).toHaveLength(1)
    expect(only(crossCheck(cfg({ ...two, venueFreshRecovery: true }), new Set(['BOOKS'])), 'not wired yet')).toHaveLength(1)
    // ONE book with the guard on is the live configuration today and must stay legal.
    expect(crossCheck(cfg({ venueExecutionScenarios: true }), new Set())).toEqual([])
  })
})

/**
 * THE ACCEPTANCE TEST FOR THE WHOLE PHASING.
 *
 * Every phase up to 4 claims to be a no-behaviour-change deploy while one book is configured.
 * That claim is only worth anything if it is asserted, because the failure mode is a bot that
 * runs happily against a band nobody chose. If this test ever fails, the one-book path has
 * diverged from the path that shipped before books existed, and the deploy is not safe.
 */
describe('one configured book reproduces the pre-books behaviour exactly', () => {
  it('liveBooks() book 0 carries exactly what liveEntryConfig() carries', async () => {
    const { liveBooks } = await import('../src/strategy/books.js')
    const { liveEntryConfig } = await import('../src/strategy/entry.js')
    const books = liveBooks()
    expect(books).toHaveLength(1)
    expect(books[0]!.entry).toEqual(liveEntryConfig())
  })

  it('routes every launch the single book admits, and only those', async () => {
    const { liveBooks, routeBook } = await import('../src/strategy/books.js')
    const { pickEntry } = await import('../src/strategy/entry.js')
    const books = liveBooks()
    const b = books[0]!
    for (const tax of [0n, 1n, 49n, 50n, 100n, 200n, 10000n]) {
      const routed = routeBook(tax, books)
      const picked = pickEntry({ creatorTaxBps: tax, exemptions: 5 }, b.entry)
      // The router and the filter must agree on every single launch. If they disagree, one of
      // them is the real book and the other is a lie told to the dashboard.
      expect(routed !== null).toBe(!('reject' in picked))
    }
  })

  it('STRATEGY.books never resolves to an empty list, so no reader handles "unset"', async () => {
    const { STRATEGY } = await import('../src/config.js')
    expect(STRATEGY.books.length).toBeGreaterThan(0)
    expect(STRATEGY.books[0]!.minTaxBps).toBe(STRATEGY.minCreatorTaxBps)
    expect(STRATEGY.books[0]!.maxTaxBps).toBe(STRATEGY.maxEntryTaxBps)
  })

  it('the derived wallet stop equals the per-book stop while one book is configured', async () => {
    const { RISK } = await import('../src/config.js')
    expect(RISK.maxWalletDrawdownEth).toBe(RISK.maxDrawdownEth)
  })
})

/**
 * THE IDENTITY GUARD.
 *
 * `SHADOW_KERNEL` hashes eight files into the replay identity. If it moves, every queued
 * shadow job is marked `unavailable` with "execution version changed; original intent
 * preserved; explicit reconstruction required" (strategy/shadow-worker.ts), and that is not
 * recoverable by re-running anything. `MODEL_HASH` hashes ~30 files into the simulation
 * identity; moving it starts a new virtual account from zero evidence and invalidates the
 * release until it is re-certified.
 *
 * Both are hashes of FILE CONTENTS, so a comment costs exactly as much as a statement. Books
 * were deliberately built to touch neither: `books.ts` is in no list, `entry.ts` needs no edit
 * because `pickEntry` already takes a config argument, and `strategySpec()` waits for phase 4.
 *
 * These are the values the 2026-09-15 band swap left. Changing them is sometimes correct, but
 * it must be a decision someone made on purpose, not a side effect of a book change.
 */
describe('the replay identities', () => {
  it('SHADOW_KERNEL has not moved', async () => {
    const { SHADOW_KERNEL } = await import('../src/strategy/shadow-account.js')
    expect(SHADOW_KERNEL.slice(0, 16),
      'SHADOW_KERNEL moved. Something edited one of the eight kernel files, most likely '
      + 'strategy/entry.ts or strategy/shadow-account.ts. Every queued shadow job is about to '
      + 'be marked unavailable and cannot be recovered by re-running. Revert the edit; do not '
      + 'update this number unless an execution-model change was the actual intent.',
    ).toBe('43649c4af965fb3e')
  })

  // MOVED 2026-09-16 by phase 2, deliberately: the per-book observer edits
  // scenario-observer.ts, worker.ts, scenario-controller.ts and store.ts, all four of which
  // are hashed. Was 1406b0ef741a0d63 from the 2026-09-15 band swap. The virtual account
  // restarts from zero evidence at the next restart. There is nothing to re-certify right
  // now: the box has no data/bot.simulation.db.release.json at all, which is why the venue
  // guard is already shut with an ENOENT as its reason. Creating a release is a separate
  // decision, because it is what lets the bot trade again.
  it('MODEL_HASH has not moved', async () => {
    const { MODEL_HASH } = await import('../src/simulation/identity.js')
    expect(MODEL_HASH.slice(0, 16),
      'MODEL_HASH moved. One of the ~30 files in simulation/identity.ts changed, contents '
      + 'only, so a COMMENT counts. The virtual account restarts from zero evidence and the '
      + 'release needs re-certifying (scripts/verify-execution-scenarios.ts, then refresh '
      + 'simulation/validation.json). Phases 2 and 4 move this deliberately: when they do, '
      + 'update this number in the same commit as the change that earned it, and re-certify. '
      + 'If you did not mean to touch a hashed file, revert instead.',
      // Moved 2026-09-16 by the pre-cutover controls, deliberately. Four changes, two
      // hashed files (risk.ts, bot.ts), ONE identity move because they ship together:
      // halts now persist through a single sink so a restart stops silently un-halting the
      // bot; rotPct divides one population by itself; paper collection health is reported
      // on the housekeeping tick instead of being measured into a dead function; and the
      // event tape records the sequencer-feed overlay, which was recorded nowhere and is
      // the reason no replay has ever reproduced a live decision.
      //
      // Moved again the same day, by recording the curve parameter read with its answer.
      // Without it a replay reaches a launch with no creator tax and no supply and can only
      // refuse: those values live on the contract and appear in no log.
      //
      // Nothing to re-certify: VENUE_EXECUTION_SCENARIOS=0 on the box, so the scenario
      // guard is not reading a certificate and cannot halt on a stale one. The virtual
      // account restarts from zero evidence at the next restart, which is the recurring
      // cost of hashing bot.ts into the model identity at all. The rewrite removes it.
    ).toBe('245cd22506bd93b1')
  })
})
