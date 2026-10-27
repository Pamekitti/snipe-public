import { describe,it,expect } from 'vitest'
import { predictExecution } from '../src/strategy/counterfactual.js'
import { calibrateTiming } from '../src/strategy/execution-model.js'
import { initialAccount,reduceAccount,monthlyAccount,type AccountEvent } from '../src/strategy/paper-account.js'
import { SimulationStore } from '../src/simulation/store.js'
import { executeBatch } from '../scripts/execution-worker.js'
import { request } from './fixtures/execution-request.js'
describe('versioned execution',()=>{
 it('charges costs and executes sells at the modeled time instead of the next polling tick',()=>{
  const r=predictExecution(request());expect(r.status).toBe('closed');expect(r.costsWei).toBe('60');expect(r.exitAt!-r.decisionAt!).toBe(75)
 })
 it('rejects minimum tokens at execution, before acquiring a holding',()=>{
  const q=request();q.minTokens=String(BigInt(q.entryQuoteTokens)+1n);q.entryQuoteTokens=String(BigInt(q.minTokens)*2n)
  const r=predictExecution(q);expect(r.status).toBe('buy_reverted');expect(r.pnlWei).toBe('-10');expect(r.tokens).toBe('0')
 })
 it('never uses actual fills as inputs and waits for fill adoption',()=>{
  const q=request();q.timing.confirmationMs=2500
  const r=predictExecution(q);expect(r.decisionAt).toBeGreaterThanOrEqual(q.entryAt+q.timing.sendMs+2500)
  expect(predictExecution({...q,actualPnlWei:'9999999999',tokens:'999'} as any)).toEqual(r)
 })
 it('charges approvals and every precommitted failed sell attempt',()=>{
  const q=request();q.costs.failedSellAttempts=2
  const r=predictExecution(q);expect(r.status).toBe('closed');expect(r.costsWei).toBe('140')
  q.costs.maxSellAttempts=2;expect(predictExecution(q).pnlWei).toBeNull()
 })
 it('does not turn missing evidence into zero profit',()=>{
  const q=request();q.coverage.gaps=['poll gap'];expect(predictExecution(q)).toMatchObject({status:'unavailable',pnlWei:null,reason:'source_gap'})
 })
 it('has identical batch and direct prediction output, including JSON bigint boundaries',()=>{
  const q=JSON.parse(JSON.stringify(request(),(_,v)=>typeof v==='bigint'?String(v):v))
  expect(executeBatch({op:'predict',requests:[q]})).toEqual([predictExecution(q)])
 })
 it('freezes calibration six hours before the evaluation end',()=>{
  const good={completedAt:1,availableAt:2,sendMs:10,confirmationMs:20,sellMs:30,observationMs:40}
  const scenarios=calibrateTiming([good,{...good,completedAt:90000000,availableAt:90000001,sellMs:9000}],100000000,100000000)
  expect(scenarios).toHaveLength(3);expect(scenarios.every(s=>s.n===1&&s.sellMs===30&&s.fitThrough===78400000)).toBe(true)
 })
})
const config={entry:{minCreatorTaxBps:50, maxCreatorTaxBps: 10000,minExemptionsToEnter:3,templateLossBlockMs:3600000,tradeSizeEth:0.01},bankrollWei:String(10n**17n),maxConcurrent:2,maxDrawdownWei:String(10n**17n),entryHours:[]}
const event=(at:number,id='a'):AccountEvent=>({kind:'opportunity',id,at,sequence:1,strategyVersion:'test',token:id,template:id,creatorTaxBps:'100',exemptions:3,sizeWei:String(10n**16n),result:{...predictExecution(request()),entryAt:at,exitAt:at+2000,pnlWei:'-100'},availableAt:at+2100,block:1,launched:at-2000,checked:true})
describe('shared account chronology',()=>{
 it('preserves an open position and cooldown across the UTC month boundary',()=>{
  const month=Date.UTC(2026,8,1),initial=initialAccount('continuous','test',month-10000,config,true)
  const a=event(month-1000),first=reduceAccount(initial,[a],month)
  expect(first.state.holdings).toHaveLength(1)
  const next=reduceAccount(first.state,[],month+5000)
  expect(next.state.losses.a).toBe(month+1000);expect(next.state.cashWei).toBe('-100')
  const full=reduceAccount(initial,[a],month+5000)
  expect(monthlyAccount(full,initial,month,month+5000).monthToDate).toBe(monthlyAccount(full,initial,month+3000,month+5000).monthToDate)
 })
 it('sorts backfill by chronology and deduplicates delivery',()=>{
  const initial=initialAccount('continuous','test',0,config,true),a=event(1000),b=event(4000,'b')
  expect(reduceAccount(initial,[b,a,a],8000)).toEqual(reduceAccount(initial,[a,b],8000))
  expect(()=>reduceAccount({...initial,at:2000},[a],8000)).toThrow('backfill')
 })
 it('Policy respects stops and Continuous measures opportunities through them',()=>{
  const control:AccountEvent={kind:'control',id:'stop',at:1,sequence:0,strategyVersion:'test',halted:true}
  const run=(kind:'policy'|'continuous')=>reduceAccount(initialAccount(kind,'test',0,config,true),[control,event(1000)],4000)
  expect(run('policy').decisions[0]?.allow).toBe(false);expect(run('continuous').decisions[0]?.allow).toBe(true)
 })
 it('Continuous ignores entry hours while policy still obeys them',()=>{
  const closed={...config,entryHours:[23]},at=1000
  const run=(kind:'policy'|'continuous')=>reduceAccount(initialAccount(kind,'test',0,closed,true),[event(at)],4000)
  expect(run('policy').decisions[0]?.reason).toBe('entry_hours')
  expect(run('continuous').decisions[0]?.allow).toBe(true)
 })
 it('unknown admitted execution blocks the account and invalidates monthly cash',()=>{
  const initial=initialAccount('continuous','test',0,config,true),a=event(1000) as Extract<AccountEvent,{kind:'opportunity'}>
  a.result={...a.result,status:'unavailable',pnlWei:null,exitAt:null}
  const run=reduceAccount(initial,[a,event(4000,'b')],8000)
  expect(run.decisions[1]?.reason).toBe('unresolved_account_state');expect(monthlyAccount(run,initial,0,8000).monthToDate).toBeNull()
 })
 it('rejects model changes without an explicit account rebuild',()=>{
  expect(()=>reduceAccount(initialAccount('continuous','different',0,config,true),[event(1000)],4000)).toThrow('version')
 })
})
describe('append-only capture',()=>{
 it('handles duplicate deliveries and refuses conflicts and overwrites',()=>{
  const s=new SimulationStore(':memory:'),e={session:'s',sequence:1,at:1,kind:'intent',key:'a',payload:{a:1},provenance:'prospective' as const}
  s.append([e,e]);expect(s.db.prepare('SELECT COUNT(*) n FROM captures').get()).toEqual({n:1})
  expect(()=>s.append([{...e,payload:{a:2}}])).toThrow('conflicting')
  expect(()=>s.db.exec("UPDATE captures SET at=2")).toThrow('immutable');s.close()
 })
})

describe('independently captured discrepancy regressions',()=>{
 it('keeps PACT and MID same-second entry ordering unavailable instead of adopting inflated token quantities',async()=>{
  const {readFileSync}=await import('node:fs'),{gunzipSync}=await import('node:zlib')
  const {fixtures}=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/alignment-discrepancies.json.gz',import.meta.url))).toString())
  for(const name of ['PACT','MID']){
   const f=fixtures.find((f:any)=>f.name===name)
   expect(f.request.minTokens).toBe(f.actual.min_tokens_out)
   expect(predictExecution(f.request)).toMatchObject({status:'unavailable',reason:'ambiguous_buy_order',tokens:null,pnlWei:null})
  }
 })
 it('models Anny and EVERYTHINGPAD limits as failed buys in the explicit after-order scenario',async()=>{
  const {readFileSync}=await import('node:fs'),{gunzipSync}=await import('node:zlib')
  const {fixtures}=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/alignment-discrepancies.json.gz',import.meta.url))).toString())
  for(const name of ['Anny','EVERYTHINGPAD']){
   const f=fixtures.find((f:any)=>f.name===name),q=structuredClone(f.request)
   q.timing.sameTimeOrder='after';q.timing.label+='-after'
   expect(predictExecution(q)).toMatchObject({status:'buy_reverted',pnlWei:String(-BigInt(q.costs.buyWei)),tokens:'0'})
  }
 })
 it('retains PORT, RQTE and FROGE differing exit paths as unresolved historical timing evidence',async()=>{
  const {readFileSync}=await import('node:fs'),{gunzipSync}=await import('node:zlib')
  const {fixtures}=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/alignment-discrepancies.json.gz',import.meta.url))).toString())
  for(const name of ['PORT','RQTE','FROGE']){
   const f=fixtures.find((f:any)=>f.name===name),r=predictExecution(f.request)
   expect(f.actual.onchain_pnl_wei).not.toBeNull()
   expect(r.scenario).toContain('upper-bound')
   expect(r.status==='unavailable'||r.pnlWei!==f.actual.onchain_pnl_wei).toBe(true)
  }
 })
})

describe('account controls and publication parity',()=>{
 it('does not let a historical control clear a simulated drawdown stop',()=>{
  const initial=initialAccount('policy','test',0,{...config,maxDrawdownWei:'50'},true)
  const clear:AccountEvent={kind:'control',id:'control',at:3500,sequence:0,strategyVersion:'test',halted:false}
  const run=reduceAccount(initial,[event(1000),clear,event(4000,'b')],8000)
  expect(run.decisions[1]?.reason).toBe('account_pause');expect(run.state.drawdownHalted).toBe(true)
 })
 it('recovers the latest-eight account only from Continuous Paper publications, with exact batch parity',()=>{
  const initial=initialAccount('continuous','test',0,config,true)
  const opportunities=Array.from({length:20},(_,i)=>{
   const e=event(1000+i*3000,String(i)) as Extract<AccountEvent,{kind:'opportunity'}>
   e.result.pnlWei=String(2n*10n**15n);return e
  })
  const continuous=reduceAccount(initial,opportunities,65000)
  const publications:AccountEvent[]=continuous.state.outcomes.map(o=>({kind:'publication',id:'pub:'+o.token,at:o.available,sequence:0,strategyVersion:'test',outcomes:continuous.state.outcomes.filter(x=>x.available<=o.available)}))
  const candidate=initialAccount('latest-eight','test',0,config,true),events=[...opportunities,...publications,event(66000,'next')]
  const run=reduceAccount(candidate,events,70000)
  expect(run.decisions.slice(0,20).every(d=>!d.allow)).toBe(true)
  expect(run.decisions.at(-1)?.allow).toBe(true)
  expect((executeBatch({op:'account',initial:candidate,events,through:70000,from:0}) as any).state).toEqual(run.state)
 })
})
it('progress holding closes at its first deadline when the executable mark does not improve',()=>{
 const q=request();q.takeProfit=100;q.rules.deadCoinAfterMs=0;q.rules.hardStopMultiple=.001
 q.progressHold={initialMs:3000,stepMs:1000,lookbackMs:1000,maximumMs:6000};q.endAt=q.entryAt+10000;q.coverage.through=q.endAt
 const r=predictExecution(q)
 expect(r.status).toBe('closed');expect(r.reason).toBe('time');expect(r.decisionAt!-(q.openedAt??q.entryAt)).toBeGreaterThanOrEqual(3000)
 expect(r.decisionAt!-(q.openedAt??q.entryAt)).toBeLessThan(3000+q.pollMs)
})
