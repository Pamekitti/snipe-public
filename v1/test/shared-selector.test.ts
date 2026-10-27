import {it,expect} from 'vitest'
import {request} from './fixtures/execution-request.js'
import {replayTargets,selectSharedTarget,selectorSnapshot} from '../src/simulation/selector.js'
import {SimulationStore,digest,encode} from '../src/simulation/store.js'
import {MODEL_HASH} from '../src/simulation/identity.js'
import {SCENARIO_IDS} from '../src/strategy/execution-scenarios.js'
import {SELECTED_GUARD,ScenarioGuard} from '../src/strategy/scenario-guard.js'
import {scenarioRecovery} from '../src/simulation/recovery.js'

const policy={adaptive:{window:2,bars:[1.25,1.75]},otherwise:1.75,maxRateAgeMs:30000}
it('replays all TP targets without mutating pinned rules or substituting missing outcomes',()=>{
  const q=request(),original=encode(q),timings=[10,50,90].map(n=>({...q.timing,label:'preceding-p'+n}))
  const value=replayTargets(q,timings,[1.25,1.75])
  expect(encode(q)).toBe(original);expect(value.complete).toBe(true)
  expect(value.bundles['1.25']!.scenarios.every(s=>s.request.takeProfit===1.25)).toBe(true)
  q.coverage.complete=false
  const missing=replayTargets(q,timings,[1.25,1.75]);expect(missing.complete).toBe(false);expect(missing.scores).toEqual({})
})
it('uses only compatible published broader-population scores, and fails closed on missing targets',()=>{
  const store=new SimulationStore(':memory:')
  try{
    const config={targetPolicy:policy},session='test:'+MODEL_HASH
    for(let i=1;i<=2;i++){
      store.append([{session,sequence:i,at:i,kind:'opportunity',key:String(i),provenance:'prospective',payload:{config,launch:{block:i,token:String(i),exemptions:0}}}])
      store.db.prepare('INSERT INTO selector_results VALUES (?,?,?,?,?)').run(session+':'+i,MODEL_HASH,digest(config),encode({scores:{'1.25':1,'1.75':-1}}),10+i)
    }
    expect(selectorSnapshot(store.db,11)?.complete).toBe(false)
    const snapshot=selectorSnapshot(store.db,12)!
    expect(snapshot.complete).toBe(true)
    expect(selectSharedTarget(snapshot,digest(config),13,12,policy)).toMatchObject({multiple:1.25,ready:true})
    expect(selectSharedTarget(snapshot,'changed',13,12,policy).ready).toBe(false)
    expect(selectSharedTarget(snapshot,digest(config),30000,12,policy).ready).toBe(false)
    store.append([{session,sequence:3,at:13,kind:'opportunity',key:'3',provenance:'prospective',payload:{config,launch:{block:3,token:'3'}}}])
    expect(selectorSnapshot(store.db,200014)?.failure).toBe('selector_unresolved_execution')
  }finally{store.close()}
})
const tapes=(fresh:number,old:number,available=1000)=>SCENARIO_IDS.map(id=>({id,complete:true,outcomes:Array.from({length:15},(_,i)=>({token:String(i),block:i,launched:100+i,available,value:i<7?old/7:fresh/8}))}))
it('15/8 preserves strict fresh recovery below the brake and the next distinct pause',()=>{
  const guard=new ScenarioGuard(999,SELECTED_GUARD)
  expect(guard.read(tapes(1,-4),1000,'a').state).toBe('shut')
  const evidence=tapes(1.125,-4,1001)
  expect(guard.read(evidence,1001,'a').state).toBe('open')
  expect(guard.read(evidence,1001,'a').state).toBe('open')
  expect(guard.read(evidence,1002,'a').state).toBe('shut')
  expect(guard.read(evidence,1003,'a').state).toBe('shut')
  const restored=new ScenarioGuard(1004,SELECTED_GUARD);restored.restore(guard.snapshot())
  expect(restored.read(evidence,1004,'a').state).toBe('shut')
})
it('DD requires verified new evidence in every scenario and respects expiry',()=>{
  const observer:any={modelHash:MODEL_HASH,configId:'a',at:1000,complete:true,tapes:tapes(2,1)}
  expect(scenarioRecovery(observer,'a',999,1001,1000,15,10800000,true)).toMatchObject({n:15})
  expect(scenarioRecovery(observer,'a',1000,1001,1000,15,10800000,true)).toMatchObject({n:0})
  expect(scenarioRecovery(observer,'a',999,1001,1000,15,10800000,false)).toBeNull()
  observer.tapes[0].complete=false
  expect(scenarioRecovery(observer,'a',999,1001,1000,15,10800000,true)).toBeNull()
})
