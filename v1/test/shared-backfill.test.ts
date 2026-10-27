import {it,expect} from 'vitest'
import {reconstruct,type BackfillInput} from '../research/core/shared_backfill.js'
import {request} from './fixtures/execution-request.js'
import {MODEL_HASH} from '../src/simulation/identity.js'
const fixture=()=>{
 const q=request(),config={entry:{minCreatorTaxBps:50, maxCreatorTaxBps: 10000,minExemptionsToEnter:3,templateLossBlockMs:3600000,tradeSizeEth:0.01},bankrollWei:'100000000000000000',maxConcurrent:14,maxEntryMultiple:4.5,rules:q.rules,targetPolicy:{adaptive:{window:2,bars:[1.25,1.75]},otherwise:1.75}}
 const p={config,params:q.params,sizeWei:q.sizeWei,launch:{block:2,exemptions:3,token:q.token},haltKinds:[],strategy:{maxDrawdownEth:0.05}}
 const captures=[{session:'old',sequence:1,at:q.entryAt-1000,key:'control',kind:'control',payload:{haltKinds:[]}},{session:'old',sequence:2,at:q.entryAt,key:q.token,kind:'opportunity',payload:p}]
 const input:BackfillInput={at:q.endAt+1000,captures,results:[{id:'old:2',at:q.endAt,request:q}],scenarios:[{id:'old:2',publicationFloor:q.endAt,timings:[10,50,90].map(n=>({...q.timing,label:'preceding-p'+n,fitThrough:q.entryAt-6*3600000-1}))}],publications:[],attempts:[],gaps:[]}
 return input
}
it('replays frozen inputs and preceding controls without certifying history',()=>{
 const input=fixture(),before=structuredClone(input),r=reconstruct(input)
 expect(r.counts.replayed).toBe(0);expect(r.counts.selectorScores).toBe(1);expect(r.modelHash).toBe(MODEL_HASH)
 expect(r.activationEvidence).toBe(false);expect(r.diagnosticOnly).toBe(true)
 expect(r.ledger[0].tp).toBeNull();expect(r.ledger[0].selectorReady).toBe(false)
 expect(r.ledger[0].status).toBe('blocked');expect(r.observer.outcomes).toEqual([])
 expect(r.observer.accounts.every(a=>a.policy.cash.length===0)).toBe(true)
 expect(input).toEqual(before)
})
it('keeps missing target inputs in the denominator without inventing an admission during warmup',()=>{
 const input=fixture();input.results=[]
 const r=reconstruct(input)
 expect(r.counts).toMatchObject({opportunities:1,replayed:0,unavailable:1})
 expect(r.observer.comparableThrough).toBe(input.at)
 expect(r.observer.outcomes).toEqual([])
 expect(r.observer.continuous.every(a=>a.cash.length===0)).toBe(true)
})
it('refuses research pool assumptions and noncausal timing',()=>{
 const a=fixture();a.results[0]!.request.researchPoolQuote={kind:'historical-pool-quote-scenario'}
 expect(reconstruct(a).blockers).toEqual({research_only_pool_approximation:1})
 const b=fixture();b.scenarios[0]!.timings[0]!.fitThrough=b.at
 expect(reconstruct(b).blockers).toEqual({missing_preceding_calibration:1})
})
