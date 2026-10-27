import { expect, it } from 'vitest'
import { EVENT_TOPICS } from '../src/abi.js'
import { freshCurve, simBuy, simSell } from '../src/state/curve.js'
import { params, predictExecution } from '../src/strategy/counterfactual.js'
import { replayScenarios } from '../src/strategy/execution-scenarios.js'
import { SimulationStore } from '../src/simulation/store.js'
import { request } from './fixtures/execution-request.js'

const hex = (...words: bigint[]) => '0x' + words.map(w => w.toString(16).padStart(64, '0')).join('')
it('orders an unobserved same-second external sale separately at our sell execution', () => {
  const q = request(), p = params(q.params), buy = simBuy(p, freshCurve(p), 10n ** 17n, 1001n)
  const sale = simSell(p, buy.next, buy.tokensOut)
  q.entryQuoteTokens = String(simBuy(p, buy.next, BigInt(q.sizeWei), 1003n).tokensOut)
  q.minTokens = String(BigInt(q.entryQuoteTokens) / 2n)
  q.timing.sellMs = 750
  const base = { address: 'c', topics: [EVENT_TOPICS.CurveBuy], blockNumber: '0x2', transactionHash: 'buy', logIndex: '0x0',
    data: hex(buy.spent, buy.tokensOut, buy.next.quoteFeeBalance, buy.next.creatorTaxBalance), at: 1001000, observedAt: 1001001,
    order: { block: 2, transaction: 0, log: 0 }, timeResolutionMs: 1000 }
  q.logs = [base, { ...base, topics: [EVENT_TOPICS.CurveSell], transactionHash: 'sell', blockNumber: '0x3',
    data: hex(buy.tokensOut, sale.quoteOut, 0n, 0n), at: 1004000, observedAt: 1004900, order: { block: 3, transaction: 0, log: 0 } }]
  const before = predictExecution({ ...q, timing: { ...q.timing, sameTimeOrder: 'before' } })
  const after = predictExecution({ ...q, timing: { ...q.timing, sameTimeOrder: 'after' } })
  expect(before.status).toBe('closed'); expect(after.status).toBe('closed')
  expect(before.decisionAt).toBe(after.decisionAt); expect(before.exitAt).toBe(after.exitAt)
  expect(BigInt(before.proceedsWei!)).toBeGreaterThan(BigInt(after.proceedsWei!))
  expect(predictExecution(q).reason).toBe('ambiguous_sell_order')
})
it('pins the TP and rules and only varies preceding timing and unresolved ordering', () => {
  const q = request(), timings = [10, 50, 90].map(n => ({ ...q.timing, label: 'preceding-p' + n, sendMs: n, sellMs: n * 10 }))
  const bundle = replayScenarios(q, timings)
  expect(bundle.scenarios).toHaveLength(6)
  for (const s of bundle.scenarios) {
    expect(s.request.takeProfit).toBe(q.takeProfit); expect(s.request.rules).toEqual(q.rules)
    expect(s.request.openedAt).toBe(q.entryAt + s.request.timing.sendMs)
  }
  expect(q.timing.label).toBe('test')
  expect(() => replayScenarios(q, timings.map(t => ({ ...t, fitThrough: q.entryAt + 1 })))).toThrow('noncausal')
})
it('publishes six results atomically after their last closure and rejects conflicting recomputation', () => {
  const q = request(), bundle = replayScenarios(q, [10, 50, 90].map(n => ({ ...q.timing, label: 'preceding-p' + n })))
  const store = new SimulationStore(':memory:')
  try {
    expect(() => store.saveScenarios('a', bundle, bundle.closedThrough! - 1)).toThrow('closure')
    store.saveScenarios('a', bundle, bundle.closedThrough!)
    store.saveScenarios('a', bundle, bundle.closedThrough! + 10)
    const row = store.db.prepare('SELECT COUNT(*) n, available_at available FROM scenario_results').get() as any
    expect(row).toEqual({ n: 1, available: bundle.closedThrough! + 1 })
    const conflict = structuredClone(bundle); conflict.scenarios[0]!.result.pnlWei = '100'
    expect(() => store.saveScenarios('a', conflict, bundle.closedThrough!)).toThrow('conflicting')
  } finally { store.close() }
})
