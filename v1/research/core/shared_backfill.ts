/** Offline reconstruction through the production engine. Never supplies activation evidence. */
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs'
import {gunzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import {MODEL_HASH} from '../../src/simulation/identity.js'
import {digest} from '../../src/simulation/store.js'
import {replayTargets,selectorEvidence} from '../../src/simulation/selector.js'
import {calibrateTiming,type ExecutionRequest,type TimingModel} from '../../src/strategy/execution-model.js'
import {replayScenarios} from '../../src/strategy/execution-scenarios.js'
import {adaptiveTakeProfit,barKey,type BarOutcomes} from '../../src/strategy/takeprofit.js'
import {captureConfig} from '../../src/simulation/scenario-observer.js'
import {replayScenarioAccounts,type ScenarioOpportunity,type ScenarioControl} from '../../src/strategy/scenario-account.js'
import {SELECTED_GUARD} from '../../src/strategy/scenario-guard.js'
import {drawdownHistory} from '../../src/simulation/drawdown-history.js'
import {pickEntry} from '../../src/strategy/entry.js'

type Capture={session:string;sequence:number;at:number;key:string;kind:string;payload:any}
export type BackfillInput={at:number;captures:Capture[];results:Array<{id:string;at:number;request:any}>;scenarios:Array<{id:string;timings:TimingModel[];publicationFloor?:number}>;publications:Array<{id:string;at:number|null}>;attempts:any[];gaps:Array<{id:string;lo:number;hi:number;reason:string}>}
const identity=(c:Capture)=>c.session+':'+c.sequence
export function reconstruct(input:BackfillInput,checkpoint?:(value:unknown)=>void){
 const captures=input.captures.filter(c=>c.kind==='opportunity').sort((a,b)=>a.at-b.at||a.sequence-b.sequence||identity(a).localeCompare(identity(b)))
 if(!captures.length)throw new Error('No opportunity captures')
 const requests=new Map(input.results.filter(r=>r.request.logs&&r.request.timing).map(r=>[r.id,r]))
 const scenarios=new Map(input.scenarios.map(r=>[r.id,r])),pubs=new Map(input.publications.map(r=>[r.id,r.at]))
 const scored:Array<{id:string;block:number;token:string;configId:string;at:number;available:number;scores:BarOutcomes}>=[]
 const opportunities:ScenarioOpportunity[]=[],controls:ScenarioControl[]=[],ledger:any[]=[]
 const blockers:Record<string,number>={};let firstUnresolved:number|null=null
 const entryReady=new Map<string,boolean>()
 const reject=(c:Capture,reason:string)=>{
  blockers[reason]=(blockers[reason]??0)+1
  const p=c.payload,admittedByFilters=!('reject' in pickEntry({creatorTaxBps:BigInt(p.params.creatorTaxBps),exemptions:p.launch.exemptions??null},p.config.entry))
  ledger.push({id:identity(c),token:c.key,at:c.at,configId:digest(p.config),status:'unavailable',reason,admittedByFilters,selectorReady:entryReady.get(identity(c))??false,pnlWei:null,sizeWei:p.sizeWei,availableAt:null})
  if(admittedByFilters&&entryReady.get(identity(c))){firstUnresolved??=c.at;controls.push({kind:'gap',id:identity(c)+':unresolved',at:c.at,sequence:-2,strategyVersion:'execution-account-v3',reason})}
 }
 for(let i=0;i<captures.length;i++){
  const c=captures[i]!,p=c.payload,id=identity(c),configId=digest(p.config),saved=requests.get(id),config=captureConfig(p)
  const targetPolicy=p.config.targetPolicy,byId=new Map(scored.map(s=>[s.id,s]))
  const evidence=selectorEvidence(captures.slice(0,i).map(prior=>{
    const s=byId.get(identity(prior))
    return {id:identity(prior),at:prior.at,block:prior.payload.launch.block,token:prior.key,configId:digest(prior.payload.config),availableAt:s?.available??null,scores:s?.scores??null}
  }),configId,c.at,targetPolicy.adaptive.window,targetPolicy.adaptive.bars.map(barKey))
  const selectorReady=evidence.complete,selectorFault=evidence.blockingIds.length>0
  entryReady.set(id,selectorReady)
  const selection=adaptiveTakeProfit(selectorReady?evidence.rows:null,targetPolicy.adaptive.window,targetPolicy.adaptive.bars,targetPolicy.otherwise)
  controls.push({kind:'control',id:id+':stops',at:c.at,sequence:c.sequence*2,strategyVersion:'execution-account-v3',config,halted:(p.haltKinds??[]).some((h:string)=>h!=='venue')})
  if(!saved){reject(c,'missing_frozen_execution_input');continue}
  const base=saved.request as ExecutionRequest
  if(base.researchPoolQuote){reject(c,'research_only_pool_approximation');continue}
  if(!base.coverage?.complete||!base.coverage.independentlyChecked||base.coverage.gaps.length){reject(c,'incomplete_source_coverage');continue}
  if(!base.minTokens||BigInt(base.minTokens)<=1n||!base.entryQuoteTokens||BigInt(base.entryQuoteTokens)<=1n||base.sizeWei!==p.sizeWei){reject(c,'missing_or_incompatible_entry_limit');continue}
  let timings=scenarios.get(id)?.timings
  if(!timings){
   const cutoff=c.at-6*3600_000
   const rows=input.attempts.filter(r=>r.exit_at<cutoff&&r.updated_at<cutoff).sort((a,b)=>b.exit_at-a.exit_at).slice(0,100)
   timings=calibrateTiming(rows.flatMap(r=>{const confirmed=r.t_confirmed??r.first_mark;return confirmed===null||r.decision===null?[]:[{completedAt:r.exit_at,availableAt:r.updated_at,sendMs:r.t_sent-r.t_decide,confirmationMs:confirmed-r.t_sent,sellMs:r.exit_at-r.decision,observationMs:confirmed-r.t_sent}]}),c.at,c.at)
  }
  if(timings.length!==3||timings.some(t=>t.n<20||t.fitThrough>c.at-6*3600_000||t.frozenAt>c.at)){reject(c,'missing_preceding_calibration');continue}
  const sourcePublication=scenarios.get(id)?.publicationFloor??pubs.get(id)
  if(sourcePublication===null||sourcePublication===undefined){reject(c,'missing_source_publication');continue}
  // Target observations warm up independently; a blocked virtual entry never uses fallback TP.
  const control=controls.at(-1)!
  if(control.kind==='control')control.halted=control.halted||!selectorReady
  const q:ExecutionRequest={...base,takeProfit:selection.multiple,provenance:{kind:'reconstruction',source:'frozen-capture-shared-backfill',capturedAt:c.at}}
  try{
   const targets=replayTargets(q,timings,targetPolicy.adaptive.bars),bundle=selectorReady?replayScenarios(q,timings):null
   // Historical availability is modeled using the original capture completion floor. This publication is not prospective.
   const availableAt=Math.max(saved.at,sourcePublication,bundle?.closedThrough??base.entryAt,targets.closedThrough??base.endAt)+1
   if(targets.complete)scored.push({id,block:p.launch.block,token:c.key,configId,at:c.at,available:availableAt,scores:targets.scores})
   if(!bundle){
    ledger.push({id,token:c.key,at:c.at,configId,status:'blocked',reason:evidence.failure,admittedByFilters:false,pnlWei:null,sizeWei:p.sizeWei,availableAt:null,tp:null,
      selectorEvidence:evidence.evidenceIds,selectorReady:false,selectorFault,targetScores:targets.scores,targetsComplete:targets.complete})
    continue
   }
   if(!bundle.complete){reject(c,'unresolved_execution:'+bundle.unavailable.map(s=>s.reason).filter((v,i,a)=>a.indexOf(v)===i).join(','));continue}
   bundle.publicationFloor=sourcePublication
   opportunities.push({id,at:c.at,sequence:c.sequence,configId,config,token:c.key,template:[p.params.creatorTaxBps,p.launch.devBuyWei??'0',p.launch.exemptions??''].join(':'),creatorTaxBps:String(p.params.creatorTaxBps),exemptions:p.launch.exemptions??null,sizeWei:p.sizeWei,block:p.launch.block,launched:Number(p.params.launchedAt)*1000,availableAt,bundle})
   const central=bundle.scenarios.find(s=>s.id==='p50-after')!.result
   ledger.push({id,token:c.key,at:c.at,configId,status:central.status,reason:central.reason,pnlWei:central.pnlWei,sizeWei:p.sizeWei,availableAt,tp:selection.multiple,selectorEvidence:evidence.evidenceIds,selectorReady,selectorFault,selectorWarmup:evidence.rows.length<targetPolicy.adaptive.window,targetScores:targets.scores,targetsComplete:targets.complete,entryAt:q.entryAt,exitAt:central.exitAt,sourceHash:digest(base),timings})
  }catch(e){reject(c,'replay_error:'+String(e).slice(0,100))}
  if(i%50===0)checkpoint?.({at:Date.now(),stage:'replay',completed:i+1,total:captures.length,available:opportunities.length,unavailable:ledger.filter(l=>l.status==='unavailable').length})
 }
 for(const c of input.captures.filter(c=>c.kind==='control')){const p=c.payload;controls.push({kind:'control',id:identity(c),at:c.at,sequence:c.sequence*2,strategyVersion:'execution-account-v3',resetDrawdown:p.resetDrawdown,halted:p.haltKinds?p.haltKinds.some((h:string)=>h!=='venue'):undefined,config:p.config?captureConfig(p):undefined})}
 const start=Math.min(captures[0]!.at,...controls.map(c=>c.at))
 for(const g of input.gaps.filter(g=>g.hi>=start&&g.lo<=input.at))controls.push({kind:'gap',id:g.id,at:Math.max(start,g.lo),sequence:-3,strategyVersion:'execution-account-v3',reason:g.reason})
 const replay=replayScenarioAccounts({start,through:input.at,initialKnown:true,config:captureConfig(captures[0]!.payload),policy:SELECTED_GUARD,opportunities,controls})
 const firstGap=Math.min(...controls.filter(c=>c.kind==='gap').map(c=>c.at)),through=Math.min(input.at,firstUnresolved??input.at,firstGap)
 const decisions=new Map(replay.accounts.find(a=>a.id==='p50-after')!.policy.decisions.map(d=>[d.id,d]))
 const coins=ledger.map(row=>{
  const decision=decisions.get(row.id)
  return {...row,admission:decision?{status:decision.reason==='unresolved_account_state'?'unresolved':decision.allow?'admitted':'skipped',reason:decision.reason}:{status:'unresolved',reason:row.reason??'account_decision_unavailable'}}
 })
 const metadata=new Map(opportunities.map(o=>[o.token.toLowerCase(),o]))
 const observer={at:input.at,modelHash:MODEL_HASH,configId:digest(captures.at(-1)!.payload.config),policy:SELECTED_GUARD,tapes:replay.tapes,reading:replay.reading,publicationAt:Math.max(0,...replay.tapes.flatMap(t=>t.outcomes.map(o=>o.available))),pending:0,firstPending:Number.isFinite(firstGap)?firstGap:firstUnresolved,complete:through===input.at&&replay.tapes.every(t=>t.complete),failure:through<input.at?'historical_unresolved_prefix':null,comparableThrough:through,recordFrom:start,accountScope:'reconstructed-independent-account-from-known-flat-start',continuous:replay.continuous.map(a=>({id:a.id,...a.metrics})),outcomes:replay.continuous.find(a=>a.id==='p50-after')!.run.state.outcomes.map(o=>({...o,configId:metadata.get(o.token.toLowerCase())?.configId})),decisions:replay.readings.map(d=>d.at>=through?{...d,sumRange:null,recentSumRange:null}:d),accounts:replay.accounts.map(a=>({id:a.id,policy:a.selected,marketOff:a.reference,retention:a.retention,drawdownHalts:drawdownHistory(a.policy,captureConfig(captures[0]!.payload),controls,input.at),losingRecoveries:a.losingRecoveries,recoveryLossWei:a.recoveryLossWei})),verified:false,reason:'historical_reconstruction_not_certification'}
 return {version:1,modelHash:MODEL_HASH,policy:SELECTED_GUARD,from:start,through:input.at,generatedAt:Date.now(),diagnosticOnly:true,activationEvidence:false,publication:'Modeled from closure and original source/capture completion floors',counts:{opportunities:captures.length,replayed:opportunities.length,unavailable:ledger.filter(l=>l.status==='unavailable').length,selectorScores:scored.length},blockers,ledger,coins,observer,limitations:['No historical outcomes authorize live entries.','Recorded stake and configuration eras are preserved.','No comparison is continued past an admitted unresolved execution or capture gap.','Earlier September research inputs without preceding timing or submitted limits are not imported.','Historical cash fidelity has not passed.']}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [source,out]=process.argv.slice(2);if(!source||!out)throw new Error('Usage: shared_backfill.ts INPUT_JSON_GZ NEW_OUTPUT_DIRECTORY')
 const bytes=readFileSync(source),input:BackfillInput=JSON.parse(gunzipSync(bytes).toString()),inputHash=createHash('sha256').update(bytes).digest('hex')
 mkdirSync(out,{recursive:true});const manifest={inputHash,modelHash:MODEL_HASH,policy:SELECTED_GUARD,from:input.captures.find(c=>c.kind==='opportunity')?.at,through:input.at}
 if(existsSync(out+'/manifest.json')&&digest(JSON.parse(readFileSync(out+'/manifest.json','utf8')))!==digest(manifest))throw new Error('Backfill manifest changed')
 writeFileSync(out+'/manifest.json',JSON.stringify(manifest,null,2))
 const report=reconstruct(input,p=>writeFileSync(out+'/progress.json',JSON.stringify(p)))
 writeFileSync(out+'/history.json',JSON.stringify({...report,inputHash}))
 writeFileSync(out+'/progress.json',JSON.stringify({at:Date.now(),stage:'completed',...report.counts}))
 console.log(JSON.stringify({counts:report.counts,blockers:report.blockers,comparableThrough:report.observer.comparableThrough,from:report.from,through:report.through}))
}
