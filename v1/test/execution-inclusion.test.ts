import { describe,expect,it } from 'vitest'
import { predictExecution,params } from '../src/strategy/counterfactual.js'
import { freshCurve,simBuy,simSell } from '../src/state/curve.js'
import { EVENT_TOPICS } from '../src/abi.js'
import { request } from './fixtures/execution-request.js'

describe('separate send and inclusion clocks',()=>{
  it('preserves omitted and zero inclusion behavior exactly',()=>{
    const q=request()
    expect(predictExecution({...q,timing:{...q.timing,buyInclusionMs:0}})).toEqual(predictExecution(q))
  })
  it('does not add inclusion time to the existing send-to-adoption delay',()=>{
    const q=request();q.rules.maxHoldMs=0;q.timing.confirmationMs=1000;q.timing.buyInclusionMs=600
    const r=predictExecution(q)
    expect(r.decisionAt).toBe(q.entryAt+q.timing.sendMs+1000)
  })
  it('cannot observe its fill before modeled inclusion',()=>{
    const q=request();q.rules.maxHoldMs=0;q.timing.buyInclusionMs=600
    expect(predictExecution(q).decisionAt).toBe(q.entryAt+q.timing.sendMs+600)
  })
  it('includes external buying between submission and inclusion in the executable fill',()=>{
    const q=request(),p=params(q.params),other=simBuy(p,freshCurve(p),10n**17n,1003n)
    const words=[other.spent,other.tokensOut,other.fee,other.tax]
    q.logs=[{address:'c',transactionHash:'0x01',blockNumber:'0x2',logIndex:'0x0',topics:[EVENT_TOPICS.CurveBuy],
      data:'0x'+words.map(n=>n.toString(16).padStart(64,'0')).join(''),at:q.entryAt+200,observedAt:q.entryAt+200,
      timeResolutionMs:1,order:{block:2,transaction:0,log:0}}]
    const immediate=predictExecution(q)
    q.timing.buyInclusionMs=500
    const delayed=predictExecution(q)
    expect(BigInt(delayed.tokens!)).toBeLessThan(BigInt(immediate.tokens!))
    q.minTokens=immediate.tokens!
    expect(predictExecution(q).status).toBe('buy_reverted')
  })
  it('keeps invalid and uncovered inclusion unavailable',()=>{
    for(const value of [-1,Infinity,NaN]){
      const q=request();q.timing.buyInclusionMs=value
      expect(predictExecution(q)).toMatchObject({status:'unavailable',reason:'invalid_timing_or_costs',pnlWei:null})
    }
    const q=request();q.timing.buyInclusionMs=100000
    expect(predictExecution(q)).toMatchObject({status:'unavailable',reason:'buy_inclusion_outside_coverage'})
  })
  it('can model a worse interior fill than either end of a buy-then-sell second',()=>{
    const q=request(),p=params(q.params),b=simBuy(p,freshCurve(p),10n**17n,1003n),s=simSell(p,b.next,b.tokensOut)
    const event=(index:number,topic:string,words:bigint[])=>({address:'c',transactionHash:'0x0'+index,blockNumber:'0x'+(index+1).toString(16),logIndex:'0x0',topics:[topic],
      data:'0x'+words.map(n=>n.toString(16).padStart(64,'0')).join(''),at:q.entryAt,observedAt:q.entryAt+1000,
      timeResolutionMs:1000,order:{block:index+1,transaction:0,log:0}})
    q.logs=[event(1,EVENT_TOPICS.CurveBuy,[b.spent,b.tokensOut,b.fee,b.tax]),event(2,EVENT_TOPICS.CurveSell,[b.tokensOut,s.quoteOut,s.fee,s.tax])]
    q.timing.kind='scenario';q.timing.sameTimeOrder='after'
    const fill=(fraction:number)=>BigInt(predictExecution({...q,timing:{...q.timing,buyOrderFraction:fraction}}).tokens!)
    expect(fill(.5)).toBeLessThan(fill(0));expect(fill(.5)).toBeLessThan(fill(1))
    q.logs[0]!.observedAt=q.entryAt
    expect(fill(0)).toBe(fill(.5))
    // A pair of events inside one external transaction cannot contain our buy.
    q.logs[0]!.observedAt=q.entryAt+1000
    q.logs[1]={...q.logs[1]!,transactionHash:q.logs[0]!.transactionHash,blockNumber:q.logs[0]!.blockNumber,
      logIndex:'0x1',order:{...q.logs[0]!.order,log:1}}
    expect(fill(.5)).toBe(fill(1))
    q.logs[0]!.observedAt=q.entryAt
    expect(fill(0)).toBe(fill(1))
  })
  it('rejects invalid ranks and cannot label a modeled rank as observed timing',()=>{
    for(const fraction of [-.1,1.1,NaN]){
      const q=request();q.timing.kind='scenario';q.timing.buyOrderFraction=fraction
      expect(predictExecution(q).reason).toBe('invalid_modeled_buy_order')
    }
    const q=request();q.timing.buyOrderFraction=.5
    expect(predictExecution(q).reason).toBe('invalid_modeled_buy_order')
  })
})
