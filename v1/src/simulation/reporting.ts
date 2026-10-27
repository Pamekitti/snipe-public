import { modelValidation } from './validation.js'
import { EVENT_TOPICS, logWord } from '../abi.js'
import { MODEL_HASH } from './identity.js'
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { EXECUTION_VERSION } from '../strategy/execution-model.js'
import { initialAccount, reduceAccount, monthlyAccount, type AccountConfig, type AccountEvent, type PaperKind } from '../strategy/paper-account.js'
import { FreshRecovery } from '../strategy/fresh-recovery.js'
import type { buildScenarioObserver } from './scenario-observer.js'
const stats=(a:number[])=>{
  const sorted=[...a].sort((a,b)=>a-b),mean=a.length?a.reduce((s,x)=>s+x,0)/a.length:null
  return {n:a.length,mean,median:a.length?(sorted[Math.floor((a.length-1)/2)]!+sorted[Math.floor(a.length/2)]!)/2:null,
    sd:a.length>1?Math.sqrt(a.reduce((s,x)=>s+(x-mean!)**2,0)/(a.length-1)):null}
}
export function matchPredictions(actual:Array<{id:number;token:string;spend_wei:string;onchain_pnl_wei:string|null;pnl_wei:string|null;buy_ok:number;exit_reason?:string|null;actualTokens?:string|null}>,predictions:Array<{token:string;result:any}>){
  const byToken=new Map(predictions.map(p=>[p.token.toLowerCase(),p.result]))
  const matched=actual.flatMap(a=>{
    const p=byToken.get(a.token.toLowerCase()),cash=a.onchain_pnl_wei??a.pnl_wei
    if(!p||p.pnlWei===null||cash===null)return []
    const errorPp=100*Number(BigInt(p.pnlWei)-BigInt(cash))/Number(a.spend_wei)
    const actualFailure=a.exit_reason==='buy-reverted'?'reverted':a.exit_reason==='buy-never-mined'?'never-mined':a.buy_ok===0?'send-rejected':null
    const predictedFailure=p.status==='buy_reverted'?'reverted':p.reason==='buy-never-mined'?'never-mined':p.reason==='send_rejected'?'send-rejected':null
    return [{id:a.id,token:a.token,actualEth:Number(cash)/1e18,paperEth:Number(p.pnlWei)/1e18,errorPp,
      failedBuyAgreement:actualFailure===predictedFailure,actualFailed:actualFailure!==null,actualFailure,predictedFailure,
      entryErrorPct:a.actualTokens&&p.tokens&&BigInt(a.actualTokens)>0n?100*Number(BigInt(p.tokens)-BigInt(a.actualTokens))/Number(a.actualTokens):null}]
  })
  const failures=matched.filter(m=>m.actualFailed)
  return {matched:matched.length,actualAttempts:actual.length,unmatched:actual.length-matched.length,
    actualEth:matched.length?matched.reduce((n,m)=>n+m.actualEth,0):null,paperEth:matched.length?matched.reduce((n,m)=>n+m.paperEth,0):null,
    failedBuy:{n:failures.length,agreed:failures.filter(m=>m.failedBuyAgreement).length},
    signedErrorPp:stats(matched.map(m=>m.errorPp)),absoluteErrorPp:stats(matched.map(m=>Math.abs(m.errorPp))),
    entryErrorPct:stats(matched.flatMap(m=>m.entryErrorPct===null?[]:[m.entryErrorPct])),
    largestDiscrepancies:[...matched].sort((a,b)=>Math.abs(b.errorPp)-Math.abs(a.errorPp)).slice(0,10)}
}
export function buildSimulationReport(path:string|undefined,from:number,now:number){
  const d=new Date(now),monthStart=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1)
  const empty=(account:PaperKind)=>({account,dark:[],seams:[],modelVersion:EXECUTION_VERSION,points:[],monthStart,monthToDate:null,
    coverage:{complete:false,initialKnown:false,unresolved:['versioned capture unavailable']},pending:0,unavailable:1,lastProcessedAt:null,reconstruction:'unavailable',health:{stalled:true,fault:'versioned capture unavailable',pending:0,lastClose:null},n:0,wins:0})
  const validation=modelValidation(path)
  const fallback={comparison:matchPredictions([],[]),policy:empty('policy'),continuous:empty('continuous'),marketOff:empty('market-off'),candidate:empty('latest-eight'),scenarioObserver:null as ReturnType<typeof buildScenarioObserver>,candidateIndicator:{source:'conservative-paper',verified:false,reason:'capture_unavailable',n:0,sum:null,recentSum:null},validation}
  if(!path||!existsSync(path))return fallback
  const db=new Database(path,{readonly:true,fileMustExist:true});db.pragma('busy_timeout = 1')
  try{
    const rows=db.prepare("SELECT session,sequence,at,key,payload FROM captures WHERE kind='opportunity' AND at<=? ORDER BY at,session,sequence").all(now) as any[]
    if(!rows.length)return fallback
    const events:AccountEvent[]=[],first=JSON.parse(rows[0].payload)
    const cfg=(p:any):AccountConfig=>({entry:p.config.entry,bankrollWei:p.config.bankrollWei,maxConcurrent:p.config.maxConcurrent,maxDrawdownWei:String(BigInt(Math.round((p.strategy?.maxDrawdownEth??0.06)*1e18))),entryHours:p.entryHours??[]})
    const pendingRows=db.prepare('SELECT id,result,at,request FROM results WHERE model=? AND at<=? ORDER BY at').all(EXECUTION_VERSION+':'+MODEL_HASH,now) as any[]
    const results=new Map(pendingRows.map(r=>[r.id,r]))
    for(const row of rows){
      const p=JSON.parse(row.payload),id=row.session+':'+row.sequence,saved=results.get(id),result=saved?JSON.parse(saved.result):null
      events.push({kind:'control',id:id+':control',at:row.at,sequence:row.sequence*2,strategyVersion:EXECUTION_VERSION,config:cfg(p),
        halted:(p.haltKinds??[]).some((h:string)=>h!=='venue'),marketPaused:(p.haltKinds??[]).includes('venue')})
      if(!result)continue
      events.push({kind:'opportunity',id,at:row.at,sequence:row.sequence*2+1,strategyVersion:EXECUTION_VERSION,token:row.key,
        template:[p.params.creatorTaxBps,p.launch.devBuyWei??'0',p.launch.exemptions??''].join(':'),creatorTaxBps:String(p.params.creatorTaxBps),exemptions:p.launch.exemptions??null,
        sizeWei:p.sizeWei,result,availableAt:saved.at,block:p.launch.block,launched:Number(p.params.launchedAt)*1000,
        checked:JSON.parse(saved.request)?.coverage?.independentlyChecked===true&&result.scenario===null})
    }
    const controls=db.prepare("SELECT session,sequence,at,payload FROM captures WHERE kind='control' AND at>=? AND at<=? ORDER BY at,session,sequence").all(rows[0].at,now) as any[]
    for(const c of controls){const p=JSON.parse(c.payload);events.push({kind:'control',id:c.session+':'+c.sequence,at:c.at,sequence:c.sequence*2,strategyVersion:EXECUTION_VERSION,
      resetDrawdown:p.resetDrawdown,config:p.config?cfg(p):undefined,halted:p.haltKinds?p.haltKinds.some((h:string)=>h!=='venue'):undefined,marketPaused:p.haltKinds?p.haltKinds.includes('venue'):undefined})}
    const gaps=db.prepare('SELECT id,lo,reason FROM gaps WHERE lo<=? ORDER BY lo').all(now) as any[]
    for(const g of gaps)if(g.lo>=rows[0].at)events.push({kind:'gap',id:g.id,at:g.lo,sequence:0,strategyVersion:EXECUTION_VERSION,reason:g.reason})
    const writer=db.prepare("SELECT value FROM checkpoints WHERE name='writer'").get() as {value:string}|undefined
    const heartbeat=writer?JSON.parse(writer.value).at:0,stale=now-heartbeat>15000
    const processorRow=db.prepare("SELECT value FROM checkpoints WHERE name='processor'").get() as {value:string}|undefined
    const processorError=processorRow?JSON.parse(processorRow.value).error:null
    const pending=rows.filter(r=>!results.has(r.session+':'+r.sequence))
    // A pending admitted trade may still hold capital. Do not advance account decisions beyond it.
    const through=Math.max(rows[0].at,Math.min(now,pending[0]?.at?pending[0].at-1:now))
    const make=(kind:PaperKind)=>{
      const initial=initialAccount(kind,EXECUTION_VERSION,rows[0].at,cfg(first),true),run=reduceAccount(initial,events,through)
      const monthly=monthlyAccount(run,initial,from,now)
      const fullMonth=rows[0].at<=monthStart&&!stale&&!pending.length&&monthly.coverage.complete
      return {...monthly,dark:[],seams:[],monthToDate:fullMonth?monthly.monthToDate:null,coverage:{...monthly.coverage,complete:fullMonth},
        recordFrom:rows[0].at,n:run.cash.length,wins:run.cash.filter((p,i)=>BigInt(p.cashWei)>BigInt(run.cash[i-1]?.cashWei??initial.cashWei)).length,
        pending:pending.length+run.state.holdings.length,admittedUnavailable:run.state.unknown.length,unavailable:pendingRows.filter(r=>JSON.parse(r.result).status==='unavailable').length,health:{stalled:stale||!!processorError,fault:stale?'capture heartbeat stale':processorError??null,pending:pending.length,lastClose:run.cash.at(-1)?.t??null},
        reconstruction:fullMonth?'recorded':'partial-month; September coverage manifest required',_run:run}
    }
    const policy=make('policy'),continuous=make('continuous'),marketOff=make('market-off')
    for(const outcome of continuous._run.state.outcomes)events.push({kind:'publication',id:'publication:'+outcome.token,at:outcome.available,sequence:0,strategyVersion:EXECUTION_VERSION,
      outcomes:continuous._run.state.outcomes.filter(o=>o.available<=outcome.available)})
    const candidate=make('latest-eight')
    const guard=new FreshRecovery(rows[0].at),reading=guard.read(continuous._run.state.outcomes,now)
    for(const account of [policy,continuous,marketOff,candidate])delete (account as any)._run
    const actualRows=db.prepare("SELECT payload FROM captures WHERE kind='actual-reconciliation' AND at<=? ORDER BY at,sequence").all(now) as Array<{payload:string}>
    const actual=new Map<number,any>();for(const row of actualRows){const p=JSON.parse(row.payload);if(p.live&&p.closed)actual.set(p.id,p)}
    const predictions=rows.flatMap(row=>{const r=results.get(row.session+':'+row.sequence);return r?[{token:row.key,result:JSON.parse(r.result)}]:[]})
    const fills=new Map<string,string>()
    // Since 2026-09-15 `results.request` carries this map precomputed instead of the log bodies
    // it was the only reader of (store.ts, compactRequest). Rows written before that still carry
    // the bodies and cannot be rewritten, so both shapes are read.
    for(const row of pendingRows){
      const q=JSON.parse(row.request)
      if(q?.fills&&typeof q.fills==='object'){for(const [tx,tokens] of Object.entries(q.fills as Record<string,string>))fills.set(tx,String(tokens));continue}
      for(const l of q?.logs??[])if(l.topics[0]===EVENT_TOPICS.CurveBuy)fills.set(l.transactionHash.toLowerCase(),String(logWord(l.data,1)))
    }
    const comparison=matchPredictions([...actual.values()].map(p=>({...p,actualTokens:fills.get(p.buy_hash?.toLowerCase())??null})),predictions)
    const savedObserver=db.prepare("SELECT value FROM checkpoints WHERE name='scenario-observer'").get() as {value:string}|undefined
    const observer:ReturnType<typeof buildScenarioObserver>=savedObserver?JSON.parse(savedObserver.value):null
    const scenarioObserver=observer?.modelHash===MODEL_HASH&&observer.at<=now?observer:null
    const candidateIndicator=scenarioObserver?{...scenarioObserver.reading,source:'conservative-paper',verified:false,
      reason:scenarioObserver.failure??'model_validation_pending',n:Math.min(...scenarioObserver.reading.scenarios.map(s=>s.n)),
      sum:scenarioObserver.reading.sumRange?.[0]??null,recentSum:scenarioObserver.reading.recentSumRange?.[0]??null,
      pending:scenarioObserver.pending,recordFrom:scenarioObserver.recordFrom}:fallback.candidateIndicator
    return {comparison,policy,continuous,marketOff,candidate,scenarioObserver,candidateIndicator,validation}
  }catch(e){return {...fallback,error:String(e)}}finally{db.close()}
}

/** Presentation reads a worker-prepared snapshot. Replay never runs in the live HTTP loop. */
export function simulationReport(path:string|undefined,from:number,now:number):ReturnType<typeof buildSimulationReport> {
  if(!path||!existsSync(path))return buildSimulationReport(undefined,from,now)
  let db:Database.Database|undefined
  try{
    db=new Database(path,{readonly:true,fileMustExist:true});db.pragma('busy_timeout = 1')
    const row=db.prepare("SELECT value FROM checkpoints WHERE name='report'").get() as {value:string}|undefined
    if(!row)return buildSimulationReport(undefined,from,now)
    const saved=JSON.parse(row.value),report=saved.report
    if(report.validation.modelHash!==MODEL_HASH)return buildSimulationReport(undefined,from,now)
    // Staleness is the WORKER's heartbeat, not the report's build time. Since 2026-09-14 the
    // report is rebuilt only when a capture, result or scenario lands, so a quiet hour leaves
    // a report an hour old that is nonetheless exactly current. Asking `saved.at` would have
    // shut the guard on every quiet stretch.
    const beat=db.prepare("SELECT value FROM checkpoints WHERE name='writer'").get() as {value:string}|undefined
    const heartbeatAt=beat?Number(JSON.parse(beat.value).at)||0:saved.at
    const stale=now-heartbeatAt>15000
    report.heartbeatAt=heartbeatAt
    report.reportAt=saved.at
    for(const kind of ['policy','continuous','marketOff','candidate']){
      const account=report[kind],points=account.points,before=points.filter((p:any)=>p.t<from).at(-1)
      account.points=[...(before?[{...before,t:from}]:[]),...points.filter((p:any)=>p.t>=from&&p.t<=now)]
      if(stale){account.health.stalled=true;account.health.fault='paper worker heartbeat stale';account.monthToDate=null;account.coverage.complete=false}
    }
    if(stale){report.scenarioObserver=null;report.candidateIndicator={...report.candidateIndicator,verified:false,state:'shut',reason:'paper_worker_stale'}}
    return report
  }catch{return buildSimulationReport(undefined,from,now)}finally{db?.close()}
}
