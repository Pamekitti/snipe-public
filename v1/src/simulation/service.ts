import { MODEL_HASH } from './identity.js'
import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type { CaptureEvent } from './store.js'
import { ArrivalRing, promoteArrivals, ARRIVAL_PROMOTE_MS } from './arrivals.js'
/** Bounded main-process queue. Only the child opens the simulation database for writing. */
export class SimulationService {
  private child:ChildProcess|null=null
  private queue:CaptureEvent[]=[]
  private flight:CaptureEvent[]=[]
  private sequence=0
  private session=randomUUID()+':'+MODEL_HASH
  private timer:ReturnType<typeof setInterval>|null=null
  private stopped=false
  private lastInputs=new Map<string,string>()
  private gap:{lo:number;hi:number;count:number;reason:string}|null=null
  private gapFlight:typeof this.gap=null
  private ring=new ArrivalRing()
  private promotions=new Map<string,{timer:ReturnType<typeof setTimeout>;curve:string;from:number}>()
  onPublication:(()=>void)|null=null
  paperStatus:any=null
  status:{at:number;error:string|null;queued:number;dropped:number;acknowledged:number;ringSize:number;pendingPromotions:number}={at:0,error:'capture starting',queued:0,dropped:0,acknowledged:0,ringSize:0,pendingPromotions:0}
  constructor(readonly path:string,private sourceDb:string,readonly capacity=2048){}
  start(){
    if(this.child||this.stopped)return
    const child=fork(fileURLToPath(new URL('./worker.ts',import.meta.url)),[resolve(this.path),resolve(this.sourceDb)],{execArgv:['--import','tsx'],serialization:'advanced',env:{...process.env,ENV_FILE:'/dev/null',MODE:'observe',LIVE:'0',DOTENV_CONFIG_QUIET:'true'},stdio:['ignore','ignore','pipe','ipc']})
    this.child=child
    child.on('message',(m:any)=>{
      if(m.type==='paper-status'){
        const prior=this.paperStatus?.scenarioObserver
        this.paperStatus=m.value
        const next=m.value?.scenarioObserver
        if(next?.publicationAt!==prior?.publicationAt||next?.complete!==prior?.complete||next?.configId!==prior?.configId)this.onPublication?.()
      }
      if(m.type==='ready'){this.status.error=null;this.flush()}
      if(m.type==='ack'){
        this.status.acknowledged+=this.flight.length;this.flight=[];this.gapFlight=null;this.status.queued=this.queue.length;this.status.at=Date.now();this.status.error=null;this.flush()
      }
      if(m.type==='fault'){this.status.error=String(m.error).replace(/(?:https?|wss?):\/\/\S+/gi,'[RPC]').slice(0,300)}
    })
    child.stderr?.on('data',c=>{this.status.error=String(c).slice(0,200)})
    child.on('error',e=>{this.status.error=String(e)})
    child.on('exit',()=>{
      this.child=null;this.status.error='capture worker exited'
      this.queue=[...this.flight,...this.queue];this.flight=[]
      if(this.gapFlight){this.noteGap(this.gapFlight.lo,this.gapFlight.hi,this.gapFlight.reason);this.gapFlight=null}
      if(!this.stopped)setTimeout(()=>this.start(),1000).unref()
    })
    if(!this.timer)this.timer=setInterval(()=>this.flush(),25).unref()
  }
  /** The forked writer's pid, for the resource watchdog. Null when it is not running. */
  pid():number|null{return this.child?.pid??null}
  private noteGap(lo:number,hi:number,reason:string){
    this.gap=this.gap?{lo:Math.min(lo,this.gap.lo),hi:Math.max(hi,this.gap.hi),count:this.gap.count+1,reason}:{lo,hi,count:1,reason}
    this.status.error=reason;this.status.dropped++
  }
  capture(kind:string,key:string,payload:unknown,at=Date.now()){
    if(this.stopped)return
    if(this.queue.length+this.flight.length>=this.capacity){this.noteGap(at,at,'capture queue overflow');return}
    this.queue.push({session:this.session,sequence:++this.sequence,at,kind,key,payload,provenance:'prospective'})
    this.status.queued=this.queue.length+this.flight.length
    if(kind==='opportunity')this.schedulePromotion(key,payload,at)
  }
  /**
   * One log arrival. Thirteen of these land per second; none of them is a capture, and the
   * ring is the reason the simulation database no longer grows 2.2 GB a day.
   */
  arrival(address:string,tx:string,logIndex:number,at=Date.now()){
    if(this.stopped)return
    this.ring.push(address,tx,logIndex,at)
    this.status.ringSize=this.ring.size
  }
  /**
   * The replay wants arrivals for the curve's own window, so the slice is cut when that
   * window closes rather than held until shutdown. A launch with no curve or no launch time
   * schedules nothing: the replay then models every arrival, which is what it already does
   * for a window the process was not running for.
   */
  private schedulePromotion(key:string,payload:any,at:number){
    const curve=payload?.launch?.curve,from=Number(payload?.params?.launchedAt)*1000
    if(typeof curve!=='string'||!curve||!Number.isFinite(from))return
    const id=key+':'+at
    if(this.promotions.has(id))return
    const timer=setTimeout(()=>this.promote(id,false),Math.max(0,at+ARRIVAL_PROMOTE_MS-Date.now()))
    timer.unref?.()
    this.promotions.set(id,{timer,curve,from})
    this.status.pendingPromotions=this.promotions.size
  }
  private promote(id:string,partial:boolean){
    const pending=this.promotions.get(id)
    if(!pending)return
    clearTimeout(pending.timer);this.promotions.delete(id)
    this.status.pendingPromotions=this.promotions.size
    const through=Date.now()
    this.capture('curve-arrivals',pending.curve,promoteArrivals(this.ring,pending.curve,pending.from,through,partial),through)
  }
  /** Capture changed inputs and every timer boundary/trigger without repeated quiet ticks. */
  evaluator(key:string,input:{mark:string;entryMark:string;peak:string;openedAt:number;rules:{maxHoldMs:number;deadCoinAfterMs:number};reason:string|null;[k:string]:unknown},at:number){
    const age=at-input.openedAt
    const signature=JSON.stringify({...input,timer:age>=input.rules.maxHoldMs?'time':age>=input.rules.deadCoinAfterMs?'dead':'before'})
    if(this.lastInputs.get(key)===signature&&!input.reason)return
    this.lastInputs.set(key,signature)
    if(this.lastInputs.size>256)this.lastInputs.delete(this.lastInputs.keys().next().value!)
    this.capture('exit-evaluation',key,input,at)
  }
  private flush(){
    if(!this.child?.connected||this.flight.length||this.gapFlight||(!this.queue.length&&!this.gap))return
    this.flight=this.queue.splice(0,64);this.gapFlight=this.gap;this.gap=null
    try{this.child.send({type:'batch',events:this.flight,gap:this.gapFlight,session:this.session},error=>{
      if(error){this.status.error=String(error);this.child?.kill()}
    })}catch(e){this.status.error=String(e);this.child.kill()}
  }
  async stop(){
    // Before `stopped`, so the events enter the queue and the drain below delivers them. A
    // window cut short says so, and the replay treats a short slice the same as a missing one.
    for(const id of [...this.promotions.keys()])this.promote(id,true)
    const end=Date.now()+2000
    while((this.queue.length||this.flight.length||this.gap||this.gapFlight)&&Date.now()<end){this.flush();await new Promise(r=>setTimeout(r,25))}
    this.stopped=true;if(this.timer)clearInterval(this.timer)
    const child=this.child
    if(child?.connected)await new Promise<void>(resolve=>{
      const timer=setTimeout(()=>{child.kill();resolve()},500)
      child.once('exit',()=>{clearTimeout(timer);resolve()})
      child.send({type:'stop'},error=>{if(error){clearTimeout(timer);child.kill();resolve()}})
    })
  }
}
