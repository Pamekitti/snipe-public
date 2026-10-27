import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, it, expect } from 'vitest'
import { predictExecution } from '../src/strategy/counterfactual.js'
import { poolReplayHash } from '../src/strategy/pool-evidence.js'
import type { ExecutionRequest } from '../src/strategy/execution-model.js'
import { request as smallRequest } from './fixtures/execution-request.js'
import { EVENT_TOPICS } from '../src/abi.js'

const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/refunded-external-buy.json.gz',import.meta.url))).toString())
const request=()=>structuredClone(fixture.request) as ExecutionRequest

describe('submitted external buy budget',()=>{
  it('reaches the pool handoff with the traced budget but preserves unavailable cash',()=>{
    const q=request(), corrected=predictExecution(q)
    expect(corrected).toMatchObject({status:'unavailable',reason:'graduated_pool_evidence_required',pnlWei:null})
    // Independent contract fork, including removal of the earlier historical wallet buy.
    expect(corrected.tokens).toBe('3192300299556356197602460')
    expect(corrected.poolReplay?.curveState.graduated).toBe(true)
    for(const l of q.logs)delete l.externalBuy
    const original=predictExecution(q)
    expect(original).toMatchObject({status:'unavailable',reason:'graduated_pool_evidence_required',pnlWei:null})
    expect(corrected.poolReplay!.inputHash).not.toBe(original.poolReplay!.inputHash)
    expect(corrected.tokens).toBe(original.tokens)
    expect(corrected.decisionAt).toBe(original.decisionAt)
  })
  it('enforces external slippage and rejects invalid provenance',()=>{
    const q=request(), log=q.logs.find(l=>l.externalBuy)!
    log.externalBuy!.minTokensOut=String(10n**40n)
    expect(predictExecution(q).pnlWei).toBeNull()
    expect(predictExecution(q).replayFailure?.error).toContain('SlippageExceeded')
    log.externalBuy!.traceHash='unverified'
    expect(predictExecution(q).replayFailure?.error).toContain('invalid_external_buy_input')
  })
  it('binds pool evidence to the submitted budget',()=>{
    const q=request(), before=poolReplayHash(q)
    q.logs.find(l=>l.externalBuy)!.externalBuy!.quoteInWei='1600000000000000000'
    expect(poolReplayHash(q)).not.toBe(before)
  })
  it('replays a capped external fill against its full budget',()=>{
    const q=smallRequest()
    q.timing.sameTimeOrder='after'
    const log={address:q.curve,blockNumber:'0x2',logIndex:'0x0',transactionHash:'0x1234',
      topics:[EVENT_TOPICS.CurveBuy],data:'0x'+[10n**16n,0n,10n**14n,10n**14n].map(v=>v.toString(16).padStart(64,'0')).join(''),
      at:q.entryAt+200,observedAt:q.entryAt+200,order:{block:2,transaction:0,log:0}}
    q.logs=[log]
    expect(predictExecution(q).status).toBe('closed')
    q.logs[0]!.externalBuy={quoteInWei:String(10n**25n),minTokensOut:'1',traceHash:'a'.repeat(64)}
    expect(predictExecution(q)).toMatchObject({status:'unavailable',pnlWei:null,poolReplay:{tokens:expect.any(String)}})
  })
})
