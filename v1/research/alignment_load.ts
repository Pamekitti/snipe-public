/** Controlled laptop comparison of exit evaluation with capture and background replay. */
import { performance } from 'node:perf_hooks'
import { mkdtempSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import Database from 'better-sqlite3'
import { Telemetry } from '../src/telemetry/db.js'
import { SimulationService } from '../src/simulation/service.js'
import { evaluate } from '../src/strategy/exit-evaluation.js'
const root=mkdtempSync(join(tmpdir(),'snipe-capture-load-'))
const source=join(root,'source.db');const tel=new Telemetry(source)
const service=new SimulationService(join(root,'simulation.db'),source)
const q=(a:number[],p:number)=>[...a].sort((a,b)=>a-b)[Math.floor((a.length-1)*p)]!
async function measure(capture:boolean){
 const times:number[]=[],lag:number[]=[],start=performance.now();let previous=start,n=0
 await new Promise<void>(resolve=>{
  const timer=setInterval(()=>{
   const t=performance.now();lag.push(Math.max(0,t-previous-5));previous=t
   const at=Date.now(),pos={exiting:false,peakMarkWei:100n,entryMarkWei:100n,takeProfitMultiple:2,openedAt:at,rules:{maxHoldMs:45000,hardStopMultiple:0.5,deadCoinAfterMs:20000,deadCoinBelowMult:1.03}}
   for(let i=0;i<14;i++){
    const mark=100n+BigInt(n%10),reason=evaluate(pos,mark,at,false)
    if(capture)service.evaluator(String(i),{mark:String(mark),entryMark:'100',peak:String(pos.peakMarkWei),openedAt:at,rules:pos.rules,reason},at)
   }
   times.push(performance.now()-t);n++
   if(performance.now()-start>=8000){clearInterval(timer);resolve()}
  },5)
 })
 return {n,events:n*14,p99EvaluationMs:q(times,.99),p99SchedulingDelayMs:q(lag,.99)}
}
const baseline=await measure(false)
service.start();await new Promise(r=>setTimeout(r,1000))
const replay=spawn(process.execPath,['--import','tsx','scripts/execution-worker.ts'],{stdio:['pipe','ignore','inherit'],env:{...process.env,ENV_FILE:'/dev/null',MODE:'observe',LIVE:'0'}})
const input=process.argv[2]
let replayTimer:ReturnType<typeof setInterval>|undefined
if(input){const {readFileSync}=await import('node:fs');const requests=JSON.parse(readFileSync(input,'utf8'));replayTimer=setInterval(()=>{replay.stdin.write(JSON.stringify({op:'predict',requests})+'\n')},100)}
const captured=await measure(true)
if(replayTimer)clearInterval(replayTimer);replay.stdin.end()
await service.stop()
await new Promise(r=>setTimeout(r,750))
const db=new Database(service.path,{readonly:true}),stored=(db.prepare("SELECT COUNT(*) n FROM captures WHERE kind='exit-evaluation'").get() as {n:number}).n
const gaps=db.prepare('SELECT * FROM gaps').all()
const result={baseline,captured,addedP99EvaluationMs:captured.p99EvaluationMs-baseline.p99EvaluationMs,addedP99SchedulingDelayMs:captured.p99SchedulingDelayMs-baseline.p99SchedulingDelayMs,
 stored,expected:captured.events,reportedDrops:service.status.dropped,unreportedLoss:captured.events-stored-service.status.dropped,gaps,scope:'controlled laptop comparison; 14 positions at 200 cycles/s; background capture and replay',root}
writeFileSync(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
db.close();tel.raw().close()
if(result.unreportedLoss!==0||result.addedP99EvaluationMs>5||result.addedP99SchedulingDelayMs>5)process.exitCode=1
