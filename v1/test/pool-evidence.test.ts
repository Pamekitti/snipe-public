import { describe, it, expect } from 'vitest'
import { predictExecution } from '../src/strategy/counterfactual.js'
import { poolReplayHash } from '../src/strategy/pool-evidence.js'
import { request } from './fixtures/execution-request.js'
import { EVENT_TOPICS } from '../src/abi.js'

function graduating() {
  const q = request()
  q.timing.sameTimeOrder = 'after'
  // An external buy consumes the remaining sellable supply before the pending exit.
  q.logs = [{ address: q.curve, blockNumber: '0x2', logIndex: '0x0', transactionHash: '0x1234',
    topics: [EVENT_TOPICS.CurveBuy], data: '0x' + [10n ** 25n, 0n, 10n ** 23n, 0n].map(v => v.toString(16).padStart(64, '0')).join(''),
    at: q.entryAt + 200, observedAt: q.entryAt + 200, order: { block: 2, transaction: 0, log: 0 } }]
  return q
}

describe('independent pool evidence', () => {
  it('exports the exact unresolved input and preserves unavailable cash', () => {
    const q = graduating(), result = predictExecution(q)
    expect(result.status).toBe('unavailable')
    expect(result.pnlWei).toBeNull()
    expect(result.poolReplay).toMatchObject({ inputHash: poolReplayHash(q), tokens: result.tokens,
      costsAlreadyChargedWei: '30', curveState: { graduated: false } })
    expect(BigInt(result.poolReplay!.curveState.trackedTokens as string)).toBe(BigInt(q.params.reservedTokens!))
  })

  it('binds evidence to the full input even when final curve states match', () => {
    const q = graduating(), handoff = predictExecution(q).poolReplay!
    q.graduation = { kind: 'independent-contract-replay', inputHash: handoff.inputHash,
      attemptedAt: handoff.attemptedAt, tokens: handoff.tokens, executionAt: handoff.attemptedAt + 1000,
      proceedsWei: '10000000000000000', gasWei: '123', curveState: handoff.curveState,
      evidenceHash: 'a'.repeat(64), source: 'test-only-independent-fork' }
    expect(predictExecution(q)).toMatchObject({ status: 'closed', reason: 'graduated-swap', costsWei: '153', pnlWei: '-153' })
    q.rules.maxHoldMs += 1
    expect(predictExecution(q)).toMatchObject({ status: 'unavailable', reason: 'graduated_pool_input_mismatch', pnlWei: null })
  })

  it('normalizes JSON bigint encoding and object key order', () => {
    const q = graduating(), json = JSON.parse(JSON.stringify(q, (_, v) => typeof v === 'bigint' ? String(v) : v))
    expect(poolReplayHash(json)).toBe(poolReplayHash(q))
    expect(poolReplayHash(Object.fromEntries(Object.entries(json).reverse()) as any)).toBe(poolReplayHash(q))
    json.logs[0].transactionHash = '0x5678'
    expect(poolReplayHash(json)).not.toBe(poolReplayHash(q))
  })

  it('does not use stale reserves after an external replay failure', () => {
    const q = graduating()
    q.logs[0]!.topics = [EVENT_TOPICS.CurveCompleted]
    q.logs[0]!.at = q.entryAt + 1060
    q.logs[0]!.observedAt = q.entryAt + 5000
    expect(predictExecution(q)).toMatchObject({ status: 'unavailable', reason: 'sell_state_replay_unresolved', pnlWei: null })
    expect(predictExecution(q).poolReplay).toBeUndefined()
  })
})


describe('bounded research pool quotes', () => {
  function scenario() {
    const q=graduating(), h=predictExecution(q).poolReplay!
    q.researchPoolQuote={kind:'historical-pool-quote-scenario',inputHash:h.inputHash,scenarioId:'delay0-haircut1000',
      attemptedAt:h.attemptedAt,executionAt:h.attemptedAt+1000,tokens:h.tokens,proceedsWei:'10000000000000000',gasWei:'123',
      block:12,blockAt:h.attemptedAt,nextBlockAt:h.attemptedAt+2000,evidenceHash:'b'.repeat(64),
      extraDelayMs:0,haircutBps:1000,preparationTransactions:1}
    return q
  }
  it('rejects research evidence on the ordinary production call',()=>{
    expect(predictExecution(scenario())).toMatchObject({status:'unavailable',reason:'research_pool_quote_not_allowed',pnlWei:null})
  })
  it('uses integer proceeds, extra costs and the declared closure time only with opt-in',()=>{
    const q=scenario(),r=predictExecution(q,{allowPoolQuote:true})
    expect(r).toMatchObject({status:'closed',reason:'graduated-quote-scenario',proceedsWei:'9000000000000000',costsWei:'153',pnlWei:'-1000000000000153',exitAt:q.researchPoolQuote!.executionAt})
    expect(r.approximation).toEqual(q.researchPoolQuote)
  })
  it.each(['tokens','inputHash','blockAt','nextBlockAt','executionAt','haircutBps','preparationTransactions'])(
    'rejects incompatible or noncausal %s',(field)=>{
      const q=scenario(),a=q.researchPoolQuote! as any
      a[field]=field==='tokens'?'1':field==='inputHash'?'c'.repeat(64):field==='blockAt'?a.executionAt+1:field==='nextBlockAt'?a.executionAt:field==='executionAt'?a.executionAt-1:-1
      expect(predictExecution(q,{allowPoolQuote:true})).toMatchObject({status:'unavailable',reason:'research_pool_quote_mismatch',pnlWei:null})
    })
  it('keeps a changed exit policy from reusing a quote proof',()=>{
    const q=scenario();q.rules.maxHoldMs++
    expect(predictExecution(q,{allowPoolQuote:true}).status).toBe('unavailable')
  })
})
