import { expect, it } from 'vitest'
import { EVENT_TOPICS } from '../src/abi.js'
import { freshCurve, simBuy, simSell } from '../src/state/curve.js'
import { params } from '../src/strategy/counterfactual.js'
import { compactBundle, expandBundle, replayScenarios } from '../src/strategy/execution-scenarios.js'
import { SimulationStore, compactRequest, encode, digest } from '../src/simulation/store.js'
import { request } from './fixtures/execution-request.js'

/**
 * One opportunity used to write its chain logs eight times: once to a `verified-logs`
 * checkpoint, once to `results.request`, and six times to `scenario_results.bundle`. On the box
 * on 2026-09-15 that was 436 MB a day of a 19 GB disk. These tests pin the two reductions and,
 * more importantly, pin that a row written before them still reads.
 */

const names = (store: SimulationStore) =>
  (store.db.prepare('SELECT name FROM checkpoints ORDER BY name').all() as Array<{ name: string }>).map(r => r.name)
const hex = (...words: bigint[]) => '0x' + words.map(w => w.toString(16).padStart(64, '0')).join('')
const bundled = () => {
  const q = request(), p = params(q.params), buy = simBuy(p, freshCurve(p), 10n ** 17n, 1001n)
  const sale = simSell(p, buy.next, buy.tokensOut)
  const base = { address: 'c', topics: [EVENT_TOPICS.CurveBuy], blockNumber: '0x2', transactionHash: '0xBUY', logIndex: '0x0',
    data: hex(buy.spent, buy.tokensOut, buy.next.quoteFeeBalance, buy.next.creatorTaxBalance), at: 1001000, observedAt: 1001001,
    observationSource: 'recorded' as const, order: { block: 2, transaction: 0, log: 0 }, timeResolutionMs: 1000 }
  q.logs = [base, { ...base, topics: [EVENT_TOPICS.CurveSell], transactionHash: '0xsell', blockNumber: '0x3',
    data: hex(buy.tokensOut, sale.quoteOut, 0n, 0n), at: 1004000, observedAt: 1004000, observationSource: 'modeled' as const,
    order: { block: 3, transaction: 0, log: 0 } }]
  const timings = [10, 50, 90].map(n => ({ ...q.timing, label: 'preceding-p' + n, sendMs: n, observationMs: n * 7 }))
  return { q, bundle: replayScenarios(q, timings) }
}

it('expands a stored bundle back to the six scenarios byte for byte', () => {
  const { bundle } = bundled()
  const stored = compactBundle(bundle)
  // The six scenarios differ in observedAt on the modeled log, so this is not a trivial copy.
  const observed = new Set(bundle.scenarios.map(s => s.request.logs[1]!.observedAt))
  expect(observed.size).toBe(3)
  expect(encode(expandBundle(stored))).toBe(encode(bundle))
  for (const s of stored.scenarios) expect(s.request.logs).toEqual([])
  // The property, independent of how many logs the fixture has: one copy, not six.
  const count = (json: string, needle: string) => json.split(needle).length - 1
  expect(count(encode(bundle), '0xBUY')).toBe(6)
  expect(count(encode(stored), '0xBUY')).toBe(1)
})

it('returns a bundle written before the change untouched', () => {
  const { bundle } = bundled()
  expect(encode(expandBundle(bundle))).toBe(encode(bundle))
})

it('stores one log array and still keys the row on the six full requests', () => {
  const { bundle } = bundled()
  const store = new SimulationStore(':memory:')
  try {
    store.saveScenarios('a', bundle, bundle.closedThrough!)
    const row = store.db.prepare('SELECT evidence,bundle FROM scenario_results').get() as { evidence: string; bundle: string }
    // Identity is unchanged: the digest still covers every log of every scenario.
    expect(row.evidence).toContain(digest(bundle.scenarios.map(s => s.request)))
    expect(encode(expandBundle(JSON.parse(row.bundle)))).toBe(encode(bundle))
    expect(row.bundle.split('0xBUY').length - 1).toBe(1)
    // A recomputation that disagrees must still be refused.
    const conflict = structuredClone(bundle); conflict.scenarios[0]!.result.pnlWei = '100'
    expect(() => store.saveScenarios('a', conflict, bundle.closedThrough!)).toThrow('conflicting')
  } finally { store.close() }
})

it('replaces request logs with the fills map that was their only reader', () => {
  const { q } = bundled()
  const out = compactRequest(q) as any
  expect(out.logs).toEqual([])
  expect(out.logCount).toBe(2)
  expect(out.logsDigest).toBe(digest(q.logs))
  // reporting.ts lowercases the hash and takes the second data word, the tokens bought.
  expect(Object.keys(out.fills)).toEqual(['0xbuy'])
  expect(out.fills['0xbuy']).toBe(String(BigInt('0x' + q.logs[0]!.data.slice(66, 130))))
  // The log bodies are gone. The digest still commits the row to them.
  expect(encode(out)).not.toContain(q.logs[0]!.data)
  expect(encode(out)).not.toContain('CurveSell')
})

it('passes a request with no logs through untouched', () => {
  const q = request()
  const unavailable = { opportunity: { a: 1 }, fitThrough: 5, sampleCount: 2 }
  expect(compactRequest(unavailable)).toBe(unavailable)
  expect(compactRequest(null)).toBe(null)
  // An empty array is still an array: it compacts, and the digest commits to emptiness.
  expect((compactRequest(q) as any).logCount).toBe(0)
})

it('keys a saved result on the full request while storing the compact one', () => {
  const { q } = bundled()
  const store = new SimulationStore(':memory:')
  try {
    store.saveResult('a', q, { status: 'closed' }, 5, 'prospective')
    const row = store.db.prepare('SELECT evidence,request FROM results').get() as { evidence: string; request: string }
    expect(row.evidence).toContain(digest(q))
    const saved = JSON.parse(row.request)
    expect(saved.logs).toEqual([])
    expect(saved.fills['0xbuy']).toBeDefined()
    // A reader written against the old shape iterates zero times rather than throwing.
    expect([...(saved.logs ?? [])]).toEqual([])
  } finally { store.close() }
})

/**
 * `checkpoints` is the only table in this database without immutability triggers, and until
 * 2026-09-15 it had no timestamp to prune on. Measured that day: `verified-logs:*` 20.4 MB in
 * 418 rows, `cost-model:*` 18.1 MB in 1,280 rows, neither ever deleted.
 */
it('prunes the two checkpoint families nothing reads back, and keeps the rest', () => {
  const store = new SimulationStore(':memory:')
  try {
    const now = Date.now()
    store.checkpoint('verified-logs:0xa:1:2000', [1])
    store.checkpoint('cost-model:12345', { n: 1 })
    store.checkpoint('verified-header:99', { hash: '0x1', timestamp: 2 })
    store.checkpoint('report', { at: 1 })
    // Rows written before the column existed carry a NULL `at` and are old by definition.
    store.db.prepare("INSERT INTO checkpoints(name,value,at) VALUES ('verified-logs:0xb:1:2000','[]',NULL)").run()
    store.db.prepare("INSERT INTO checkpoints(name,value,at) VALUES ('verified-header:98','{}',NULL)").run()

    store.pruneCheckpoints(now)
    // Nothing yet: every timestamped row is minutes old, but the NULL ones go.
    expect(names(store)).toEqual(['cost-model:12345', 'report', 'verified-header:98', 'verified-header:99', 'verified-logs:0xa:1:2000'])

    // An hour on, the log slices are past six hours and go; cost-model holds for a week.
    store.pruneCheckpoints(now + 7 * 3_600_000)
    expect(names(store)).toEqual(['cost-model:12345', 'report', 'verified-header:98', 'verified-header:99'])
    store.pruneCheckpoints(now + 8 * 86_400_000)
    expect(names(store)).toEqual(['report', 'verified-header:98', 'verified-header:99'])
  } finally { store.close() }
})

it('runs the checkpoint prune at most once an hour', () => {
  const store = new SimulationStore(':memory:')
  try {
    const now = Date.now()
    store.pruneCheckpoints(now)
    store.db.prepare("INSERT INTO checkpoints(name,value,at) VALUES ('cost-model:1','{}',NULL)").run()
    store.pruneCheckpoints(now + 60_000)
    expect(names(store)).toEqual(['cost-model:1'])
    store.pruneCheckpoints(now + 3_600_001)
    expect(names(store)).toEqual([])
  } finally { store.close() }
})
