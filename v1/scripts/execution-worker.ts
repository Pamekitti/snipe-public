/** Batched, offline interface used by Python research and paper diagnostics. No signer imports. */
import { createInterface } from 'node:readline'
import { predictExecution, reconstructExecution } from '../src/strategy/counterfactual.js'
import { reduceAccount, monthlyAccount } from '../src/strategy/paper-account.js'
import { calibrateTiming } from '../src/strategy/execution-model.js'
import { replayScenarios } from '../src/strategy/execution-scenarios.js'
import { ScenarioGuard } from '../src/strategy/scenario-guard.js'
import { replayScenarioAccounts, replayScenarioAccountGrid } from '../src/strategy/scenario-account.js'
import { MODEL_HASH } from '../src/simulation/identity.js'
export function executeBatch(batch:any):unknown {
  if(batch.op==='identity')return {modelHash:MODEL_HASH}
  if(batch.op==='predict')return batch.requests.map((r: any) => predictExecution(r))
  if(batch.op==='scenarios')return batch.requests.map((r:any)=>replayScenarios(r.request,r.timings))
  if(batch.op==='scenario-accounts')return replayScenarioAccounts(batch.input)
  if(batch.op==='scenario-account-grid')return replayScenarioAccountGrid(batch.input,batch.policies)
  if(batch.op==='scenario-guard'){
    const guard=new ScenarioGuard(batch.start,batch.policy)
    if(batch.checkpoint)guard.restore(batch.checkpoint)
    return {readings:batch.checks.map((c:any)=>guard.read(c.tapes,c.at,c.configId)),checkpoint:guard.snapshot()}
  }
  if(batch.op==='scenario-guards')return batch.policies.map((policy:any)=>{
    const guard=new ScenarioGuard(batch.start,policy)
    return batch.checks.map((at:number)=>{
      const r=guard.read(batch.tapes,at,batch.configId)
      return [r.state==='open',r.sumRange?.[0]??null,r.recentSumRange?.[0]??null,r.scenarios.every(s=>s.fresh)]
    })
  })
  if(batch.op==='reconstruct')return batch.requests.map(reconstructExecution)
  if(batch.op==='account'){const run=reduceAccount(batch.initial,batch.events,batch.through);return {...run,monthly:monthlyAccount(run,batch.initial,batch.from,batch.through)}}
  if(batch.op==='calibrate')return calibrateTiming(batch.samples,batch.frozenAt,batch.evaluationEnd)
  if(batch.op==='calibrate-many')return batch.requests.map((r:any)=>calibrateTiming(r.samples,r.frozenAt,r.evaluationEnd))
  throw new Error('unknown operation')
}
if(process.argv[1]?.endsWith('execution-worker.ts'))for await(const line of createInterface({input:process.stdin})){
  try{process.stdout.write(JSON.stringify({ok:true,result:executeBatch(JSON.parse(line))},(_,v)=>typeof v==='bigint'?String(v):v)+'\n')}
  catch(e){process.stdout.write(JSON.stringify({ok:false,error:String(e)})+'\n')}
}
