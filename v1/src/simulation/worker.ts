import { SELECTED_GUARD } from '../strategy/scenario-guard.js'
import { selectorSnapshot } from './selector.js'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { modelValidation } from './validation.js'
import { PaperProcessor } from './processor.js'
import { buildScenarioObserver } from './scenario-observer.js'
import { liveBooks } from '../strategy/books.js'
import { loadScenarioRelease } from './scenario-controller.js'
/** The sole simulation writer. It never imports signing or sending code. */
import { SimulationStore, digest } from './store.js'
import { shouldRebuild } from './cadence.js'
import { forwardStart, publishForwardObserver } from './forward-ledger.js'
import { MODEL_HASH } from './identity.js'
import type { CaptureEvent } from './store.js'
const store=new SimulationStore(process.argv[2]!)
const processor=new PaperProcessor(store,process.argv[3]!)
const timer=setInterval(()=>void processor.tick(),1000)
/**
 * Two cadences, deliberately. The heartbeat says the worker is alive and ticks every 5 s;
 * the rebuild says the report is current and follows the data. Before 2026-09-14 they were
 * the same timer, so proving liveness cost a full replay of every capture ever taken.
 */
/**
 * `observer` is book 0, the book the trading process gates on, and stays exactly what it was
 * before books existed. `byBook` carries every configured book including book 0, for the
 * dashboard and for phase 4's per-book guard. With one book configured the two are the same
 * object and nothing downstream can tell the difference, which is the point.
 */
let cached:{observer:any;byBook:Array<{bookId:string;observer:any}>}|null=null
let report:any=null,reportBusy=false,reportError:string|null=null
const reporter=fork(fileURLToPath(new URL('./report-worker.ts',import.meta.url)),[process.argv[2]!],
  {execArgv:['--import','tsx'],env:{...process.env,PRIVATE_KEY:'',MODE:'observe',LIVE:'0'},stdio:['ignore','ignore','ignore','ipc']})
reporter.on('message',(m:any)=>{
  reportBusy=false
  if(m.type==='report'){
    report=m.value;reportError=null
    store.checkpoint('report',{at:m.at,report})
  }else reportError=m.error??'dashboard_report_failed'
})
reporter.on('error',()=>{reportBusy=false;reportError='dashboard_report_worker_failed'})
reporter.on('exit',()=>{reportBusy=false;reportError='dashboard_report_worker_exited'})
const reportTimerSlow=setInterval(()=>{
  if(!reportBusy&&reporter.connected){reportBusy=true;reporter.send({type:'build',at:Date.now()})}
},60000)
let builtAt=0
let nextDeadline=Infinity
const reportTimer=setInterval(()=>{
  const now=Date.now()
  try{
    if(shouldRebuild({dirty:store.dirty,now,builtAt,nextDeadline})){
      // Cleared BEFORE the build: the build is synchronous, and a write that lands while it
      // runs must leave the flag set rather than be swallowed by the clear that follows.
      store.dirty=false
      const selectedRelease=loadScenarioRelease(process.argv[2]+'.release.json').release
      const policy=selectedRelease?.policy ?? SELECTED_GUARD
      // ONE set of chain reads, N replays. The evidence half (processor.tick, scenario_results,
      // selector_results) is shared and untouched above; only the replay repeats per book, over
      // the same captures and the same execution bundles. That is the whole efficiency claim:
      // adding a book costs CPU, not RPC.
      const books=liveBooks()
      const byBook=books.map((b,index)=>{
        // Each book gets its OWN forward-ledger start. Sharing one would make either book's
        // config change restart the other book's account.
        const from=forwardStart(store.db,MODEL_HASH,policy,now,b.id)
        const observer=buildScenarioObserver(store.db,now,policy,from,{id:b.id,entry:b.entry})
        if(observer)publishForwardObserver(store.db,observer,b.id)
        // Book 0 is stored under the UNSUFFIXED name and the extra books under a suffix.
        // Not both: a checkpoint measured 518 KB on the box, and writing book 0 twice would
        // add half a megabyte of pure duplication to every rebuild of a database this repo
        // has already had one disk fuse over. reporting.ts reads the unsuffixed name and is
        // the only reader, so with one book this writes exactly the one row it always did.
        if(index>0)store.checkpoint('scenario-observer:'+b.id,observer)
        return {bookId:b.id,observer}
      })
      const observer=byBook[0]?.observer??null
      store.checkpoint('scenario-observer',observer)
      // A renamed or removed book would otherwise leave its 518 KB snapshot behind for the
      // life of the database, with nothing that ever reads or overwrites it again.
      store.dropObserverCheckpointsExcept(books.slice(1).map(b=>b.id))
      store.checkpoint('selector',selectorSnapshot(store.db,now))
      cached={observer,byBook};builtAt=now
      const monthEnd=Date.UTC(new Date(now).getUTCFullYear(),new Date(now).getUTCMonth()+1,1)
      const overdue=observer?.firstPending?observer.firstPending+190000+1:Infinity
      nextDeadline=Math.min(monthEnd,overdue)
    }
    store.checkpoint('writer',{at:now,clean:false,reportAt:builtAt})
    // Self-throttled to hourly. Deliberately after the heartbeat: a slow delete must never be
    // the reason the guard reads the worker as stale.
    store.pruneCheckpoints(now)
    if(cached)process.send?.({type:'paper-status',value:{at:now,candidateIndicator:cached.observer?{
      ...cached.observer.reading,source:'conservative-paper',verified:false,reason:cached.observer.failure??'model_validation_pending'
    }:null,scenarioObserver:cached.observer,
      // Every book's tape, book 0 included. Nothing gates on this yet; the live per-book guard
      // is phase 4. Sending it now is what lets the dashboard show both books before either
      // one has money on it.
      scenarioObservers:cached.byBook,selector:store.read('selector'),validation:report?.validation??modelValidation(process.argv[2]),
      acquisition:store.jobHealth(now),reportError,reportPid:reporter.pid}})
  }catch(e){
    // No heartbeat on a failed rebuild. A worker that cannot produce a report must go stale
    // within 15 s and shut the guard, not keep announcing that it is alive.
    store.dirty=true
    process.send?.({type:'fault',error:String(e)})
  }
},5000)
const prior=store.read<{at:number;clean:boolean}>('writer')
if(prior)store.gap('restart:'+prior.at,prior.at,Date.now(),prior.clean?'writer restart interval; prospective capture unavailable':'unclean writer restart; final capture delivery unknown')
store.checkpoint('writer',{at:Date.now(),clean:false})
let queue:Promise<void>=Promise.resolve()
process.on('message',(m:any)=>{
  queue=queue.then(async()=>{
    if(m.type==='batch'){
      // A transient failure retries the identical batch. ACK only follows a durable transaction.
      for(let attempt=0;;attempt++){
        try{
          if(m.gap)store.gap(digest([m.session,m.gap]),m.gap.lo,m.gap.hi,m.gap.reason+': '+m.gap.count)
          store.append(m.events as CaptureEvent[])
          store.checkpoint('writer',{at:Date.now(),clean:false})
          process.send?.({type:'ack'});break
        }catch(e){
          process.send?.({type:'fault',error:String(e)})
          if(attempt===0){try{store.gap('write:'+Date.now(),m.events[0]?.at??Date.now(),Date.now(),'writer failure: '+String(e))}catch{}}
          await new Promise(r=>setTimeout(r,Math.min(5000,100*2**Math.min(attempt,6))))
        }
      }
    }
    if(m.type==='stop'){clearInterval(timer);clearInterval(reportTimer);clearInterval(reportTimerSlow);reporter.kill();processor.close();store.checkpoint('writer',{at:Date.now(),clean:true});store.close();process.exit(0)}
  }).catch(e=>{process.send?.({type:'fault',error:String(e)});process.exit(1)})
})
process.send?.({type:'ready'})

// A dead parent must not leave an orphan writer beside the replacement process.
process.on('disconnect',()=>process.exit(0))
