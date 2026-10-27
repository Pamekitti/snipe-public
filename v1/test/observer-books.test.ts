/**
 * The observer under a book override.
 *
 * TWO PROPERTIES, and the first one is the whole safety argument for phase 2.
 *
 * 1. NO BEHAVIOUR CHANGE. Replaying with book 0, whose entry filter IS the live filter, must
 *    produce byte-identical output to replaying with no book at all. `digest` is
 *    JSON.stringify with no key sorting, so this turns on object key ORDER, which is exactly
 *    the kind of thing that cannot be settled by reading the code.
 *
 * 2. TWO BOOKS ARE ACTUALLY DIFFERENT. Their configIds must differ, because the forward
 *    ledger derives its epoch id from the configId and the scenario controller keys its
 *    checkpoint on it. Two books sharing one configId is the failure where both appear to
 *    work while sharing one tape.
 */
import { expect, it, describe } from 'vitest'
import { SimulationStore, digest } from '../src/simulation/store.js'
import { MODEL_HASH } from '../src/simulation/identity.js'
import { buildScenarioObserver } from '../src/simulation/scenario-observer.js'
import { liveBooks } from '../src/strategy/books.js'
import { liveEntryConfig } from '../src/strategy/entry.js'

/** One untaxed and one taxed opportunity, so the two bands genuinely select different rows. */
const seed = (store: SimulationStore) => {
  const config = { entry: liveEntryConfig(), bankrollWei: '1000', maxConcurrent: 3,
    targetPolicy: { adaptive: { window: 1, bars: [1.75] }, otherwise: 1.75, maxRateAgeMs: 300000 } }
  const row = (key: string, sequence: number, at: number, creatorTaxBps: string) => ({
    session: 'live:' + MODEL_HASH, sequence, at, kind: 'opportunity', key, provenance: 'prospective' as const,
    payload: { launch: { block: 1, exemptions: 3 }, params: { creatorTaxBps, launchedAt: '0' }, sizeWei: '100', config,
      takeProfit: { multiple: 1.75, ready: true }, selectorHeartbeatAt: 900,
      selector: { modelHash: MODEL_HASH, configId: digest(config), at: 900, complete: true, rows: [{ '1.75': 1 }], evidenceIds: ['prior'], failure: null } },
  })
  store.append([row('untaxedcoin', 1, 1000, '0'), row('taxedcoin', 2, 1100, '100')])
}

describe('buildScenarioObserver with a book', () => {
  it('book 0 reproduces the no-book replay EXACTLY, configId included', () => {
    const store = new SimulationStore(':memory:')
    try {
      seed(store)
      const plain = buildScenarioObserver(store.db, 2000)!
      const books = liveBooks()
      expect(books).toHaveLength(1)
      const withBook = buildScenarioObserver(store.db, 2000, undefined, 0, { id: books[0]!.id, entry: books[0]!.entry })!

      // The configId is the one that matters: it keys the forward-ledger epoch and the guard
      // checkpoint, and it is a digest of an object whose KEY ORDER is not normalised.
      expect(withBook.configId).toBe(plain.configId)
      expect(withBook.recordFrom).toBe(plain.recordFrom)
      expect(withBook.complete).toBe(plain.complete)
      expect(withBook.failure).toBe(plain.failure)
      expect(withBook.reading.configId).toBe(plain.reading.configId)
      // and the whole payload, minus the one field that is new by design
      const strip = (o: any) => { const { bookId, ...rest } = o; return digest(rest) }
      expect(strip(withBook)).toBe(strip(plain))
      expect(withBook.bookId).toBe(books[0]!.id)
    } finally { store.close() }
  })

  it('two books over ONE evidence set get different configIds and different admitted sets', () => {
    const store = new SimulationStore(':memory:')
    try {
      seed(store)
      const shared = { minExemptionsToEnter: 3, templateLossBlockMs: 3_600_000, tradeSizeEth: 0.005 }
      const untaxed = buildScenarioObserver(store.db, 2000, undefined, 0,
        { id: 'untaxed', entry: { minCreatorTaxBps: 0, maxCreatorTaxBps: 0, ...shared } })!
      const taxed = buildScenarioObserver(store.db, 2000, undefined, 0,
        { id: 'taxed', entry: { minCreatorTaxBps: 50, maxCreatorTaxBps: 10000, ...shared } })!

      // Different identity, or they share a forward-ledger epoch and a guard checkpoint.
      expect(untaxed.configId).not.toBe(taxed.configId)
      expect(untaxed.bookId).toBe('untaxed')
      expect(taxed.bookId).toBe('taxed')

      // DIFFERENT ADMITTED SETS, which is the entire reason for running two books.
      // `firstPending` is the timestamp of the first row this book would have taken and is
      // still waiting on execution for. A row the band rejects never reaches it, so this says
      // exactly which launch each book selected out of the same two.
      //   untaxed admits the 0 bps coin at 1000, and refuses the 100 bps one.
      //   taxed   admits the 100 bps coin at 1100, and refuses the 0 bps one.
      expect(untaxed.firstPending).toBe(1000)
      expect(taxed.firstPending).toBe(1100)
      expect(untaxed.pending).toBe(1)
      expect(taxed.pending).toBe(1)

      // THE EVIDENCE IS SHARED AND NEITHER BOOK MAY WRITE TO IT. This is the efficiency claim
      // and the correctness claim at once: one set of chain reads, N replays. If a book could
      // write here, the second book would be scoring a tape the first one moved.
      const counts = () => ['captures', 'scenario_results', 'selector_results'].map((t) =>
        (store.db.prepare('SELECT count(*) n FROM ' + t).get() as any).n)
      const before = counts()
      expect(before[0]).toBe(2)
      buildScenarioObserver(store.db, 2000, undefined, 0, { id: 'untaxed', entry: { minCreatorTaxBps: 0, maxCreatorTaxBps: 0, ...shared } })
      buildScenarioObserver(store.db, 2000, undefined, 0, { id: 'taxed', entry: { minCreatorTaxBps: 50, maxCreatorTaxBps: 10000, ...shared } })
      expect(counts()).toEqual(before)
    } finally { store.close() }
  })

  it('an unbounded historical config is still replayable under a book, rather than throwing', () => {
    // Captures written before 2026-09-15 carry no maxCreatorTaxBps. The book supplies its own
    // entry filter, so the stored one is never read for the band, but the SHAPE still has to
    // survive the round trip.
    const store = new SimulationStore(':memory:')
    try {
      const config = { entry: { tradeSizeEth: 1e-16, minCreatorTaxBps: 50, minExemptionsToEnter: 3, templateLossBlockMs: 0 }, bankrollWei: '1000', maxConcurrent: 3 }
      store.append([{ session: 'live:' + MODEL_HASH, sequence: 1, at: 1000, kind: 'opportunity', key: 'old', provenance: 'prospective',
        payload: { launch: { block: 1, exemptions: 3 }, params: { creatorTaxBps: '100', launchedAt: '0' }, sizeWei: '100', config } }])
      const shared = { minExemptionsToEnter: 3, templateLossBlockMs: 3_600_000, tradeSizeEth: 0.005 }
      expect(() => buildScenarioObserver(store.db, 2000, undefined, 0,
        { id: 'taxed', entry: { minCreatorTaxBps: 50, maxCreatorTaxBps: 10000, ...shared } })).not.toThrow()
    } finally { store.close() }
  })
})

/**
 * The per-book observer CHECKPOINTS, which are 518 KB each on the box.
 *
 * This database has already had one disk fuse (see the 2026-09-14 capture incident), so a
 * half-megabyte written twice per rebuild, or stranded forever by a rename, is not a rounding
 * error. Book 0 keeps the unsuffixed name that reporting.ts reads; only the extra books get a
 * suffix; books that are no longer configured get theirs deleted.
 */
describe('observer checkpoint storage', () => {
  it('drops per-book snapshots for books that are no longer configured, and keeps the rest', async () => {
    const { SimulationStore: Store } = await import('../src/simulation/store.js')
    const store = new Store(':memory:')
    try {
      store.checkpoint('scenario-observer', { book: 0 })
      store.checkpoint('scenario-observer:taxed', { book: 'taxed' })
      store.checkpoint('scenario-observer:retired', { book: 'retired' })
      store.checkpoint('selector', { keep: true })

      store.dropObserverCheckpointsExcept(['taxed'])

      const names = (store.db.prepare("SELECT name FROM checkpoints ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name)
      // book 0's unsuffixed row is never touched here, and unrelated checkpoints survive
      expect(names).toEqual(['scenario-observer', 'scenario-observer:taxed', 'selector'])
    } finally { store.close() }
  })

  it('with ONE book configured there is no suffixed row at all, so nothing is stored twice', async () => {
    const { SimulationStore: Store } = await import('../src/simulation/store.js')
    const store = new Store(':memory:')
    try {
      store.checkpoint('scenario-observer', { book: 0 })
      store.checkpoint('scenario-observer:stale', { book: 'stale' })
      // one book means books.slice(1) is empty: every suffixed row goes
      store.dropObserverCheckpointsExcept([])
      const names = (store.db.prepare("SELECT name FROM checkpoints ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name)
      expect(names).toEqual(['scenario-observer'])
    } finally { store.close() }
  })
})
