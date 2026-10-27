import { digest } from '../simulation/store.js'
import Database from 'better-sqlite3'
import { MODEL_HASH } from '../simulation/identity.js'
import { paperSeries } from './dashboard-policy.js'
import { paperHealth } from './paper-health.js'
import type { BookFloors } from '../strategy/gate.js'
import type { buildScenarioObserver } from '../simulation/scenario-observer.js'

/** Display-only estimates from the running continuous collector, never live guard evidence. */
export function dashboardPaper(db: Database.Database, from: number, to: number, floors: BookFloors, balance: ReadonlyArray<{at:number}> = []) {
  const recorded = paperSeries(db, from, to, balance)
  const health = paperHealth(db, to, floors)
  return {
    ...recorded,
    account: 'continuous-estimate', source: 'shadow_jobs', estimated: true,
    // Partial recorded profit is useful, but cannot be labelled a complete monthly result.
    recordedPnlEth: recorded.monthToDate, monthToDate: null,
    coverage: {complete: false}, health,
  }
}

/** The display line names one scenario. The entry guard always uses all six. */
export function scenarioPaper(observer:ReturnType<typeof buildScenarioObserver>,from:number,to:number,heartbeatAt=observer?.at) {
  const scenario=observer?.continuous.find(s=>s.id==='p50-after')
  let cash=0n
  const complete=!!observer?.complete&&scenario?.complete===true&&to-(heartbeatAt??observer!.at)<=15000
  const gap=Math.max(observer?.recordFrom??to,Math.min(observer?.comparableThrough??to,observer?.firstPending??to))
  const closes=(scenario?.cash??[]).filter(p=>p.at<=(complete?to:gap-1))
  const all=scenario?[{t:observer!.recordFrom,eth:0 as number|null},...closes.map(p=>{cash+=BigInt(p.pnlWei);return {t:p.at,eth:Number(cash)/1e18 as number|null}})]:[]
  // Hold the last known cash only through supported account coverage.
  const end=complete?to:gap-1
  if(scenario&&end>=observer!.recordFrom)all.push({t:end,eth:Number(cash)/1e18})
  if(!complete){for(const p of all)if(p.t>=gap)p.eth=null;all.push({t:gap,eth:null})}
  all.sort((a,b)=>a.t-b.t)
  const prior=all.filter(p=>p.t<from).at(-1)
  return {cash:closes,account:'continuous-scenario',source:'conservative-paper',scenario:'p50-after',modelHash:observer?.modelHash,
    points:[...(prior?[{...prior,t:from}]:[]),...all.filter(p=>p.t>=from&&p.t<=to)],dark:[],seams:[],estimated:true,
    recordFrom:observer?.recordFrom??null,monthStart:Date.UTC(new Date(to).getUTCFullYear(),new Date(to).getUTCMonth(),1),monthToDate:null,
    recordedPnlEth:complete?Number(scenario!.netWei)/1e18:null,n:closes.length,
    wins:scenario?.wins??0,pending:observer?.pending??0,unavailable:scenario?.unavailable.length??1,
    coverage:{complete,from:observer?.recordFrom??null,through:complete?to:observer?.comparableThrough??observer?.firstPending??null},health:{stalled:!complete,fault:observer?.failure??(!complete?'scenario coverage unavailable':null),pending:observer?.pending??0,lastClose:scenario?.cash.at(-1)?.at??null},
    label:'24h baseline · p50-after · no market or drawdown stops'}
}


/** Only published continuous-account outcomes contribute to simulated return bars. */
export function scenarioOutcomeBuckets(db: Database.Database, observer: ReturnType<typeof buildScenarioObserver>, from: number, to: number, bucket: number, coins: readonly DisplayCoin[] = [], ledgerOnly = false) {
  const outcomes=new Map((observer?.outcomes??[]).filter(o=>o.available<=to).map(o=>[o.token.toLowerCase(),o]));
  for(const c of coins){outcomes.delete(c.token.toLowerCase());if(c.value!==null&&c.availableAt!==null&&c.availableAt<=to)outcomes.set(c.token.toLowerCase(),{token:c.token,value:c.value,available:c.availableAt,configId:c.configId} as any)}
  const bins=new Map<number,any>()
  if(ledgerOnly){
    for(const c of coins){
      const t=Math.floor(c.at/bucket)*bucket
      if(!bins.has(t))bins.set(t,{t,total:0,passed:0,win:0,loss:0,flat:0,pending:0,notSimulated:0,filtered:0,reconstructed:0,pos:0,neg:0,net:0,missing:0,n:0,configs:[]})
      const b=bins.get(t);b.total++;b.passed++
      if(c.admission.status!=='admitted'||c.value===null){b.notSimulated++;b.missing++;if(c.status==='unavailable')b.pending++;continue}
      b.n++;b.net+=c.value
      if(c.value>0){b.win++;b.pos+=c.value}else if(c.value<0){b.loss++;b.neg+=c.value}else b.flat++
      if(c.configId&&!b.configs.includes(c.configId))b.configs.push(c.configId)
    }
    return {source:'forward-ledger',modelHash:coins.at(-1)?.configId??null,scenario:'p50-after',publicationAt:coins.reduce((n,c)=>Math.max(n,c.availableAt??0),0)||null,
      coins,buckets:[...bins.values()].map(b=>({...b,net:b.n?b.net:null})),pending:coins.filter(c=>c.status==='unavailable').length,unavailable:coins.filter(c=>c.value===null).length}
  }
  const rows=db.prepare('SELECT token,detected_at,passed FROM launches WHERE detected_at>=? AND detected_at<=? ORDER BY detected_at').all(from,to) as any[]
  for(const row of rows){
    const t=Math.floor(row.detected_at/bucket)*bucket
    if(!bins.has(t))bins.set(t,{t,total:0,passed:0,win:0,loss:0,flat:0,pending:0,notSimulated:0,filtered:0,reconstructed:0,pos:0,neg:0,net:0,missing:0,n:0,configs:[]})
    const b=bins.get(t);b.total++
    if(!row.passed){b.filtered++;continue}b.passed++
    const outcome=outcomes.get(row.token.toLowerCase())
    if(!outcome){b.notSimulated++;b.missing++;continue}
    b.n++;b.net+=outcome.value
    if(outcome.value>0){b.win++;b.pos+=outcome.value}else if(outcome.value<0){b.loss++;b.neg+=outcome.value}else b.flat++
    if(!b.configs.includes(outcome.configId))b.configs.push(outcome.configId)
  }
  return {source:'shared-execution',modelHash:observer?.modelHash??null,scenario:'p50-after',publicationAt:observer?.publicationAt??null,
    coins, buckets:[...bins.values()].map(b=>({...b,net:b.n?b.net:null})),pending:observer?.pending??null,unavailable:observer?.complete?0:null}
}

/** Cumulative cash and money retention share one matching-exit reference and clock. */
export function scenarioComparison(observer: ReturnType<typeof buildScenarioObserver>, from:number,to:number) {
  const account=observer?.accounts.find(a=>a.id==='p50-after')
  if(!observer||!account)return {points:[],halts:[],policy:null,source:'shared-execution',complete:false}
  const selected=account.policy.cash, reference=account.marketOff.cash
  const times=[...new Set([observer.recordFrom,...selected.map(p=>p.at),...reference.map(p=>p.at),to])].sort((a,b)=>a-b)
  let si=0,ri=0,cash=0n,ref=0n,peak=0n,rpeak=0n,win=0n,loss=0n,rwin=0n,rloss=0n
  const points=times.map(t=>{
    while(si<selected.length&&selected[si]!.at<=t){const v=BigInt(selected[si++]!.pnlWei);cash+=v;if(v>0n)win+=v;else loss-=v;peak=peak>cash?peak:cash}
    while(ri<reference.length&&reference[ri]!.at<=t){const v=BigInt(reference[ri++]!.pnlWei);ref+=v;if(v>0n)rwin+=v;else rloss-=v;rpeak=rpeak>ref?rpeak:ref}
    const valid=t<=observer.comparableThrough&&!(t===to&&!observer.complete)
    return {t,cash:valid?Number(cash)/1e18:null,reference:valid?Number(ref)/1e18:null,drawdown:valid?Number(peak-cash)/1e18:null,referenceDrawdown:valid?Number(rpeak-ref)/1e18:null,
      winRetained:valid&&rwin>0n?100*Number(win)/Number(rwin):null,lossRetained:valid&&rloss>0n?100*Number(loss)/Number(rloss):null}
  })
  const prior=points.filter(p=>p.t<from).at(-1)
  const halts=[...account.drawdownHalts,...observer.decisions.flatMap((d,i)=>d.state==='shut'?[{from:d.at,to:observer.decisions[i+1]?.at??to,kind:'venue'}]:[])].filter(h=>h.to>=from&&h.from<=to)
  return {source:'shared-execution',modelHash:observer.modelHash,configId:observer.configId,policy:observer.policy,scenario:'p50-after',complete:observer.complete,
    points:[...(prior?[{...prior,t:from}]:[]),...points.filter(p=>p.t>=from&&p.t<=to)],halts}
}


export type PublishedCoin = { id?:string; token:string; at:number; availableAt:number|null; pnlWei:string|null; sizeWei?:string; configId?:string; reason:string; status:string; exitAt?:number|null; entryAt?:number; scenario?:string; indicatorEvidence?:boolean; admission?:{status:string;reason:string}; epoch?:string }
export type DisplayCoin = PublishedCoin & {value:number|null;indicatorEvidence:boolean;admission:{status:string;reason:string};actual:{status:string;reason:string|null}}
/** Read only published result fields. No execution or account replay runs in an HTTP request. */
export function publishedScenarioCoins(path:string|undefined,from:number,to:number):PublishedCoin[] {
  if(!path)return []
  let db:Database.Database|undefined
  try {
    db=new Database(path,{readonly:true,fileMustExist:true});db.pragma('busy_timeout = 1')
    const rows=db.prepare(`SELECT c.session||':'||c.sequence id,c.key token,c.at,
      json_extract(c.payload,'$.sizeWei') sizeWei,json_extract(c.payload,'$.config') config,s.available_at availableAt,
      json_extract(s.bundle,'$.complete') complete,json_extract(s.bundle,'$.unavailable[0].reason') unavailableReason,
      json_extract(e.value,'$.result') result,json_extract(e.value,'$.request.coverage') coverage,
      json_extract(r.result,'$.reason') failure
      FROM captures c LEFT JOIN scenario_results s ON s.id=c.session||':'||c.sequence AND s.model=substr(c.session,-64)
      LEFT JOIN json_each(s.bundle,'$.scenarios') e ON json_extract(e.value,'$.id')='p50-after'
      LEFT JOIN results r ON r.id=c.session||':'||c.sequence AND r.model='execution-account-v3:'||substr(c.session,-64)
      WHERE c.kind='opportunity' AND c.at>=? AND c.at<=? ORDER BY c.at`).all(from,to) as any[]
    const unique=new Map<string,any>(),duplicate=new Set<string>()
    for(const row of rows){if(unique.has(row.id))duplicate.add(row.id);else unique.set(row.id,row)}
    return [...unique.values()].map(r=>{
      const result=r.result?JSON.parse(r.result):null,coverage=r.coverage?JSON.parse(r.coverage):null
      const available=!duplicate.has(r.id)&&r.complete&&r.availableAt!==null&&r.availableAt<=to&&coverage?.complete&&coverage.independentlyChecked&&!coverage.gaps.length
      return {id:r.id,token:r.token,at:r.at,sizeWei:r.sizeWei,configId:r.config?digest(JSON.parse(r.config)):undefined,availableAt:available?r.availableAt:null,
        pnlWei:available?result.pnlWei:null,status:available?result.status:'unavailable',entryAt:result?.entryAt??r.at,exitAt:result?.exitAt??null,scenario:'p50-after',
        reason:duplicate.has(r.id)?'conflicting_execution_evidence':available?result.reason:r.failure??r.unavailableReason??'execution_pending'}
    })
  }catch{return []}finally{db?.close()}
}
export function displayCoins(db:Database.Database,rows:readonly PublishedCoin[],observer:ReturnType<typeof buildScenarioObserver>,from:number,to:number,ledgerOnly=false):DisplayCoin[] {
  const published=new Map(rows.map(r=>[r.token.toLowerCase(),r]))
  const evidence=new Set((observer?.outcomes??[]).filter(o=>o.available<=to).map(o=>o.token.toLowerCase()))
  const admitted=new Map(observer?.continuous.find(a=>a.id==='p50-after')?.cash.map(p=>[p.id,p])??[])
  const columns=new Set((db.prepare('PRAGMA table_info(launches)').all() as any[]).map(r=>r.name))
  const positionColumns=new Set((db.prepare('PRAGMA table_info(positions)').all() as any[]).map(r=>r.name))
  const actualKnown=positionColumns.has('t_decide')&&positionColumns.has('live')
  const actual=new Set(actualKnown?(db.prepare('SELECT token FROM positions WHERE live=1 AND t_decide>=? AND t_decide<=?').all(from,to) as any[]).map(r=>r.token.toLowerCase()):[])
  if(ledgerOnly)return rows.map(r=>{
    const admission=r.admission??{status:'unresolved',reason:r.reason}
    const available=r.availableAt!==null&&r.availableAt<=to&&r.pnlWei!==null&&!!r.sizeWei&&BigInt(r.sizeWei)>0n
    return {...r,value:available&&admission.status==='admitted'?Number(r.pnlWei)/Number(r.sizeWei):null,
      indicatorEvidence:r.indicatorEvidence??false,admission,
      actual:{status:actual.has(r.token.toLowerCase())?'attempted':actualKnown?'no_attempt_recorded':'unavailable',reason:null}}
  })
  const launches=db.prepare(`SELECT token,detected_at at,passed,${columns.has('entry_reject')?'entry_reject':'NULL entry_reject'}
    FROM launches WHERE detected_at>=? AND detected_at<=? ORDER BY detected_at`).all(from,to) as any[]
  const decisions=observer?.decisions??[]
  return launches.filter(l=>l.passed||published.has(l.token.toLowerCase())||actual.has(l.token.toLowerCase())).map(l=>{
    const r:PublishedCoin=published.get(l.token.toLowerCase())??{token:l.token,at:l.at,availableAt:null,pnlWei:null,status:'unavailable',reason:'no_compatible_execution'}
    const available=r.availableAt!==null&&r.availableAt<=to&&r.pnlWei!==null&&r.sizeWei&&BigInt(r.sizeWei)>0n
    let lo=0,hi=decisions.length-1,guardIndex=-1
    while(lo<=hi){const mid=(lo+hi)>>>1;if(decisions[mid]!.at<=r.at){guardIndex=mid;lo=mid+1}else hi=mid-1}
    const guard=decisions[guardIndex]
    const cashEntry=r.id?admitted.get(r.id):undefined
    const ledger=!!r.epoch
    const cashMatches=ledger?r.admission?.status==='admitted':!!cashEntry&&cashEntry.pnlWei===r.pnlWei
    const decision=ledger&&r.admission?r.admission:(cashMatches?{status:'admitted',reason:'continuous_account_outcome'}:
      r.status==='rejected'?{status:'skipped',reason:r.reason}:
      {status:'unresolved',reason:cashEntry&&!cashMatches?'cash_outcome_mismatch':r.reason==='conflicting_execution_evidence'?r.reason:'continuous_admission_not_recorded'})
    return {...r,at:r.epoch?r.at:l.at,value:available&&decision.status==='admitted'?Number(r.pnlWei)/Number(r.sizeWei):null,
      indicatorEvidence:r.indicatorEvidence??evidence.has(l.token.toLowerCase()),admission:decision,
      actual:{status:actual.has(l.token.toLowerCase())?'attempted':l.entry_reject?'skipped':actualKnown?'no_attempt_recorded':'unavailable',reason:l.entry_reject??null}}
  })
}
