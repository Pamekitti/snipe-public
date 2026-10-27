import {expect,it} from 'vitest'
import {recordedScenarioDisplay} from '../src/telemetry/dashboard-policy.js'
import {SCENARIO_IDS} from '../src/strategy/execution-scenarios.js'
import {SELECTED_GUARD} from '../src/strategy/scenario-guard.js'
const reading=()=>({policy:SELECTED_GUARD,verified:false,
 observerError:"Error: ENOENT: no such file or directory, open 'data/bot.simulation.db.release.json'",
 scenarios:SCENARIO_IDS.map((id,i)=>({id,n:15,recentN:8,sum:i-2,recentSum:i-1,fresh:true}))})
it('displays available calculated scores without granting entry verification',()=>{
 const r=reading(),before=JSON.stringify(r)
 expect(recordedScenarioDisplay(r)).toEqual({sum:-2,recentSum:-1,diagnostic:true,valid:true})
 expect(JSON.stringify(r)).toBe(before)
})
it('keeps source errors, missing windows and duplicate scenarios unavailable',()=>{
 for(const error of ['selector_unresolved_execution','source_gap','paper_worker_missing_or_stale','release_model_or_config_mismatch']) {
  expect(recordedScenarioDisplay({...reading(),observerError:error}).valid).toBe(false)
 }
 for(const edit of [(r:any)=>r.scenarios[0].fresh=false,(r:any)=>r.scenarios[0].n=14,
  (r:any)=>r.scenarios[0].recentN=7,(r:any)=>r.scenarios[0].sum=null,
  (r:any)=>r.scenarios[0].id=r.scenarios[1].id]) {
  const r=reading();edit(r);expect(recordedScenarioDisplay(r).sum).toBeNull()
 }
})
it('keeps known published scores visible during selector processing without changing the guard',()=>{
 const r={...reading(),at:20000,publicationAt:10000,observerError:'selector_unresolved_execution'},before=JSON.stringify(r)
 expect(recordedScenarioDisplay(r)).toEqual({sum:-2,recentSum:-1,diagnostic:true,valid:true})
 expect(JSON.stringify(r)).toBe(before)
 for(const p of [null,0,NaN,21000])expect(recordedScenarioDisplay({...r,publicationAt:p}).valid).toBe(false)
 for(const error of ['source_gap','paper_worker_missing_or_stale','release_model_or_config_mismatch'])
  expect(recordedScenarioDisplay({...r,observerError:error}).valid).toBe(false)
 r.scenarios[0]!.fresh=false
 expect(recordedScenarioDisplay(r).valid).toBe(false)
})
