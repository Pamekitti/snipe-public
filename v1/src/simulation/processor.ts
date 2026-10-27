import { MODEL_HASH } from './identity.js'
import Database from 'better-sqlite3'
import { replayScenarios } from '../strategy/execution-scenarios.js'
import { predictExecution,params } from '../strategy/counterfactual.js'
import { freshCurve } from '../state/curve.js'
import { EXECUTION_VERSION,EVIDENCE_VERSION,calibrateTiming,type ExecutionRequest,type ExecutionResult } from '../strategy/execution-model.js'
import { replayTargets, compactTargets, capturedTarget } from './selector.js'
import { SimulationStore, digest, encode } from './store.js'
import { arrivalMap, ARRIVAL_PROMOTE_MS, ARRIVAL_GRACE_MS } from './arrivals.js'

/**
 * How long to wait for a gatewatch publication that has not appeared at all before calling
 * the opportunity unscoreable. Six hours, the same bound the cost fit already treats as
 * settled history, so nothing here decides a coin is dead while the rest of this file would
 * still consider its window open.
 */
const SOURCE_PUBLICATION_GIVE_UP_MS = 6 * 3600_000
import { readClient } from '../rpc/read.js'
import { EVENT_TOPICS } from '../abi.js'
import { requireStableSource,scanCandidates } from '../strategy/shadow-source.js'
import { pickEntry } from '../strategy/entry.js'
/** Independent history collection and prediction. Only this background process writes results. */
export class PaperProcessor {
  private source:Database.Database
  private client=readClient(undefined,{publicLogs:true,background:true})
  private busy=false
  constructor(private store:SimulationStore,sourcePath:string){this.source=new Database(sourcePath,{readonly:true,fileMustExist:true});this.source.pragma('busy_timeout = 1')}
  close(){this.source.close()}
  private async header(block:number){
    const key='verified-header:'+block
    const cached=this.store.read<{hash:string;timestamp:number}>(key)
    if(cached)return cached
    const existing=this.source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='shadow_headers'").get()
    const prior=existing?this.source.prepare('SELECT hash,timestamp FROM shadow_headers WHERE block=?').get(block) as {hash:string;timestamp:number}|undefined:undefined
    if(prior&&/^0x[0-9a-f]{64}$/i.test(prior.hash)&&Number.isSafeInteger(prior.timestamp)&&prior.timestamp>0){
      this.store.checkpoint(key,prior);return prior
    }
    const fetched=await this.client.getBlock({blockNumber:BigInt(block)})
    if(!fetched.hash||fetched.timestamp<=0n)throw new Error('missing settled header hash or timestamp')
    const value={hash:fetched.hash,timestamp:Number(fetched.timestamp)}
    this.store.checkpoint(key,value);return value
  }
  captureActual(){
    const cursor=this.store.read<{at:number;id:number}>('actual-cursor')??{at:Date.now()-3600_000,id:0}
    const rows=this.source.prepare('SELECT * FROM positions WHERE updated_at>? OR (updated_at=? AND id>?) ORDER BY updated_at,id LIMIT 100').all(cursor.at,cursor.at,cursor.id) as any[]
    const now=Date.now()
    for(const row of rows){
      this.store.append([{session:'actual-reconciliation',sequence:Number((this.store.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 n FROM captures WHERE session='actual-reconciliation'").get() as {n:number}).n),at:now,kind:'actual-reconciliation',key:row.token,payload:row,provenance:'reconstruction'}])
      this.store.checkpoint('actual-cursor',{at:row.updated_at,id:row.id})
    }
  }
  private unavailable(at:number,reason:string):ExecutionResult {
    return {modelVersion:EXECUTION_VERSION,evidenceVersion:EVIDENCE_VERSION,status:'unavailable',reason,entryAt:at,exitAt:null,decisionAt:null,tokens:null,spentWei:null,proceedsWei:null,pnlWei:null,costsWei:'0',scenario:null,trace:[],assumption:'External traders retain historical order quantities'}
  }
  async tick(){
    if(this.busy)return;this.busy=true
    let id:string|undefined
    try{
      this.captureActual()
      const job=this.store.nextJob(Date.now())
      if(!job)return
      id=job.session+':'+job.sequence
      const p=JSON.parse(job.payload),cutoff=job.at-6*3600_000
      const selected=capturedTarget(p,job.at),ready=selected.ready
      // The reason names the SOURCE of the replayed target, not just that one was found, so
      // the audit can separate "the bot traded the shared selector" from "the bot traded
      // another sensor's bar and we replayed that". Both are eligible; they are not the same.
      this.store.db.prepare('INSERT OR IGNORE INTO virtual_admissions (id,model,at,status,reason,target,evidence) VALUES (?,?,?,?,?,?,?)').run(id,MODEL_HASH,job.at,
        ready?'eligible':'blocked',ready?(selected.source==='live-take-profit'?'live_target_replayed':'adaptive_target_pinned'):selected.failure??'pinned_target_mismatch',ready?selected.multiple:null,encode(p.selector?.evidenceIds??[]))
      let sourcePublicationAt:number
      // Gatewatch remains an availability floor, never the return used by this indicator.
      const gate=new Database(process.env.GATE_DB??'data/gate.db',{readonly:true,fileMustExist:true})
      let unpublishable:string|null=null
      try{
        const row=gate.prepare('SELECT at,error,bars FROM obs WHERE token=?').get(job.key) as {at:number;error:string|null;bars:string|null}|undefined
        /**
         * A gatewatch row that carries an ERROR is terminal. The observer already tried and
         * recorded why it cannot score this coin ("no path (curve empty at entry)" is the
         * common one); nothing re-scores it, so waiting is waiting forever.
         *
         * It used to throw here and `retryJob` caps its backoff at 60s with no give-up, so
         * one such coin spun a processor tick every minute indefinitely. Measured on the box
         * 2026-09-16: job ...e1f1:504, captured 01:37:45, 343 attempts, still going.
         *
         * A MISSING row is different: gatewatch may simply not have got there yet, so that
         * one still waits. It stops waiting after the same 6 hours the cost fit already treats
         * as settled history, because a row that has not appeared by then is not coming.
         */
        if(row?.error)unpublishable='source_publication_failed:'+String(row.error).slice(0,60)
        else if(!row||row.bars==null){
          if(Date.now()>job.at+SOURCE_PUBLICATION_GIVE_UP_MS)unpublishable='source_publication_never_arrived'
          else throw new Error('waiting_for_source_publication')
        }
        sourcePublicationAt=row?.at??job.at
      }finally{gate.close()}
      if(unpublishable){
        // Recorded as unavailable and FINISHED, exactly like the other inputs this job can
        // never get. An unscoreable coin is a fact about the coin, not a fault to retry.
        this.store.saveResult(id,{opportunity:p,sourceUnavailable:unpublishable},this.unavailable(job.at,unpublishable),Date.now(),'prospective-input-unavailable')
        this.store.finishJob(id,Date.now())
        return
      }
      // The original opportunity is never updated. The fit excludes the final six hours.
      const rows=this.source.prepare(`SELECT p.id,p.buy_hash,p.exit_hash,p.approval_gas_wei,p.t_decide,p.t_sent,p.t_confirmed,p.exit_at,p.updated_at,p.gas_wei,p.context_json,
        (SELECT MIN(at) FROM trade_marks WHERE position_id=p.id AND reason IS NOT NULL) decision,
        (SELECT MIN(at) FROM trade_marks WHERE position_id=p.id) first_mark
        FROM positions p WHERE live=1 AND closed=1 AND buy_ok=1 AND exit_reason NOT IN ('buy-reverted','buy-never-mined') AND exit_at<? AND updated_at<? AND gas_wei IS NOT NULL
        ORDER BY exit_at DESC LIMIT 100`).all(cutoff,cutoff) as any[]
      const samples=rows.flatMap(r=>{
        const adoption=this.store.db.prepare("SELECT MIN(at) at FROM captures WHERE kind='fill-adoption' AND json_extract(payload,'$.id')=?").get(r.id) as {at:number|null}
        const confirmed=r.t_confirmed??adoption.at??r.first_mark
        if(confirmed===null||r.decision===null)return []
        return [{completedAt:r.exit_at,availableAt:r.updated_at,sendMs:r.t_sent-r.t_decide,confirmationMs:confirmed-r.t_sent,sellMs:r.exit_at-r.decision,observationMs:confirmed-r.t_sent}]
      })
      const timings=calibrateTiming(samples,job.at,job.at)
      const timing=timings.find(t=>t.label==='preceding-p50')
      if(timing)timing.label+='-adoption-upper-bound'
      if(!timing||samples.length<20||!p.minTokens||!p.entryQuoteTokens){
        const reason=!timing||samples.length<20?'missing_preceding_timing_calibration':'missing_submitted_entry_limit'
        this.store.saveResult(id,{opportunity:p,fitThrough:cutoff,sampleCount:samples.length},this.unavailable(job.at,reason),Date.now(),'prospective-input-unavailable')
        this.store.finishJob(id,Date.now())
        return
      }
      // The capture service promotes this curve's arrivals once, five seconds after the
      // window closes and five before this job becomes eligible. A missing row means the
      // process was not running then, so every arrival is modeled -- the same fallback the
      // per-log capture already took when no row matched.
      //
      // This wait sits ABOVE every RPC call on purpose. It used to sit below the two log
      // scans, so a job that arrived before its promotion re-burned a getBlockNumber, a
      // header walk, two eth_getLogs per 2000-block slice and a header per block on every
      // retry, then threw on a local SQLite read it could have done first. Same shape as
      // the 2026-08 gate check that sat behind retrying RPC calls.
      const promoted=this.store.db.prepare("SELECT payload FROM captures WHERE kind='curve-arrivals' AND key=? AND at>=? AND at<=? ORDER BY at LIMIT 1").get(p.launch.curve,job.at,job.at+3600_000) as {payload:string}|undefined
      if(!promoted&&Date.now()<job.at+ARRIVAL_PROMOTE_MS+ARRIVAL_GRACE_MS)throw new Error('waiting_for_arrival_promotion')
      const arrivals=arrivalMap(promoted?JSON.parse(promoted.payload):null)
      const endAt=job.at+180000,tip=Number(await this.client.getBlockNumber({cacheTime:0}))-100
      let hi=tip
      for(const b of scanCandidates(p.launch.block,Number(p.params.launchedAt)*1000,endAt,tip)){
        const h=await this.header(b)
        if(Number(h.timestamp)*1000>=endAt){hi=b;break}
      }
      const scan=async()=>{
        const logs:any[]=[]
        for(let lo=p.launch.block;lo<=hi;lo+=2000){
          const end=Math.min(lo+1999,hi),key='verified-logs:'+p.launch.curve+':'+lo+':'+end
          const cached=this.store.read<any[]>(key)
          if(cached){logs.push(...cached);continue}
          const filter={address:p.launch.curve,fromBlock:'0x'+lo.toString(16),toBlock:'0x'+end.toString(16),topics:[Object.values(EVENT_TOPICS)]}
          const first=await this.client.request({method:'eth_getLogs',params:[filter]} as any) as any[]
          await new Promise(r=>setTimeout(r,1000))
          const second=await this.client.request({method:'eth_getLogs',params:[filter]} as any) as any[]
          requireStableSource(first,second)
          // Save each verified slice, so one later failed slice cannot force a full rescan.
          this.store.checkpoint(key,second);logs.push(...second)
        }
        return logs
      }
      const endHeader=await this.header(hi)
      if(Number(endHeader.timestamp)*1000<endAt)throw new Error('source horizon has not settled')
      const second=await scan()
      const times=new Map<number,number>()
      for(const l of second){
        const block=Number(l.blockNumber)
        if(!times.has(block)){
          const h=await this.header(block)
          if(h.hash!==l.blockHash)throw new Error('source block hash mismatch')
          times.set(block,Number(h.timestamp)*1000)
        }
      }
      // Keep recorded arrivals distinct so timing stresses only change modeled arrivals.
      timing.sameTimeOrder='unavailable'
      const logs=second.map(l=>({...l,timeResolutionMs:1000,at:times.get(Number(l.blockNumber))!,observedAt:arrivals.get(l.transactionHash+':'+Number(l.logIndex))??times.get(Number(l.blockNumber))!+timing.observationMs,
        observationSource:arrivals.has(l.transactionHash+':'+Number(l.logIndex))?'recorded' as const:'modeled' as const,
        order:{block:Number(l.blockNumber),transaction:Number(l.transactionIndex),log:Number(l.logIndex)}}))
      const receiptCost=async(hash:string)=>{
        if(!hash)throw new Error('preceding receipt hash missing')
        const key='receipt:'+hash,cached=this.store.read<string>(key)
        if(cached!==null)return BigInt(cached)
        const receipt=await this.client.getTransactionReceipt({hash:hash as `0x${string}`})
        const cost=receipt.gasUsed*receipt.effectiveGasPrice
        this.store.checkpoint(key,String(cost));return cost
      }
      const costRows=rows.filter(r=>r.buy_hash&&r.exit_hash&&r.approval_gas_wei!==null)
      if(!costRows.length){this.store.saveResult(id,{opportunity:p,timing,logs},this.unavailable(job.at,'missing_preceding_receipt_cost_components'),Date.now(),'prospective-input-unavailable');this.store.finishJob(id,Date.now());return}
      const buys:bigint[]=[],sells:bigint[]=[],approvals:bigint[]=[]
      for(const row of costRows){buys.push(await receiptCost(row.buy_hash));sells.push(await receiptCost(row.exit_hash));approvals.push(BigInt(row.approval_gas_wei))}
      const median=(a:bigint[])=>{a.sort((a,b)=>a<b?-1:a>b?1:0);return (a[Math.floor((a.length-1)/2)]!+a[Math.floor(a.length/2)]!)/2n}
      const costs:ExecutionRequest['costs']={buyWei:String(median(buys)),sellWei:String(median(sells)),approvalWei:String(median(approvals)),
        failedSellWei:String(median(sells)),approvalDelayMs:timing.confirmationMs,retryMs:500,maxSellAttempts:20,failedSellAttempts:0}
      this.store.checkpoint('cost-model:'+cutoff,{...costs,sourceHashes:costRows.map(r=>[r.buy_hash,r.exit_hash]),n:costRows.length,fitThrough:cutoff})
      const gaps=(this.store.db.prepare('SELECT reason FROM gaps WHERE lo<=? AND hi>=?').all(endAt,Number(p.params.launchedAt)*1000) as Array<{reason:string}>).map(g=>g.reason)
      const q:ExecutionRequest={modelVersion:EXECUTION_VERSION,evidenceVersion:EVIDENCE_VERSION,strategyVersion:EXECUTION_VERSION,id,token:job.key,curve:p.launch.curve,wallet:p.wallet,params:p.params,sizeWei:p.sizeWei,entryQuoteTokens:p.entryQuoteTokens,minTokens:p.minTokens,maxEntryMultiple:p.config.maxEntryMultiple,takeProfit:p.takeProfit.multiple,rules:p.config.rules,entryAt:job.at,openedAt:job.at+timing.sendMs,endAt,pollMs:50,
        seed:{state:freshCurve(params(p.params)),order:{block:p.launch.block-1,transaction:0,log:0},at:Number(p.params.launchedAt)*1000,observedAt:job.at},logs,timing,costs,
        coverage:{complete:gaps.length===0,from:Number(p.params.launchedAt)*1000,through:endAt,independentlyChecked:true,gaps},provenance:{kind:job.session.endsWith(MODEL_HASH)?'prospective':'reconstruction',source:'settled-history-double-scan',capturedAt:job.at}}
      const targets=replayTargets(q,timings,p.config.targetPolicy.adaptive.bars)
      if(!targets.complete)throw new Error('unresolved_target_execution:'+Object.values(targets.bundles).flatMap(b=>b.unavailable.map(s=>s.reason)).join(','))
      const bundle=ready?replayScenarios({...q,takeProfit:selected.multiple!},timings):null
      if(bundle)bundle.publicationFloor=sourcePublicationAt
      const publishedAt=Date.now()
      this.store.db.transaction(()=>{
        this.store.saveResult(id!,q,ready?predictExecution(q):this.unavailable(job.at,'adaptive_entry_blocked'),publishedAt,q.provenance.kind)
        if(bundle)this.store.saveScenarios(id!,bundle,publishedAt)
        this.store.db.prepare('INSERT INTO selector_results VALUES (?,?,?,?,?)').run(id,MODEL_HASH,digest(p.config),encode(compactTargets(targets)),targets.complete?Math.max(publishedAt,targets.closedThrough!,sourcePublicationAt)+1:null)
      })()
      this.store.checkpoint('processor',{at:Date.now(),last:id,error:null})
      this.store.finishJob(id,publishedAt)
    }catch(e){
      const value=e as {shortMessage?:string;details?:string}
      const reason=[value.shortMessage??String(e),value.details].filter(Boolean).join(': ')
      if(id)this.store.retryJob(id,Date.now(),reason)
      else this.store.checkpoint('processor',{at:Date.now(),error:reason})
    }
    finally{this.busy=false}
  }
}
