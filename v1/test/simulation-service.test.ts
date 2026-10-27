import {it,expect} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import Database from 'better-sqlite3'
import {SimulationService} from '../src/simulation/service.js'
import {Telemetry} from '../src/telemetry/db.js'
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms))
/**
 * Each of these tests forks a real worker, and `--import tsx` boots a TypeScript pipeline
 * before it can answer. On a loaded machine (the whole suite in parallel, or the 2-core box
 * that runs it during a deploy) that took longer than a fixed two-second wait, so the tests
 * failed on timing rather than on behaviour. Wait for the condition, cap it generously.
 */
const waitFor=async(what:string,cond:()=>boolean,ms=20_000)=>{
 const end=Date.now()+ms
 while(!cond()&&Date.now()<end)await delay(25)
 if(!cond())throw new Error('timed out waiting for '+what)
}
it('makes queue overflow durable without blocking capture or silently losing accepted events',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'simulation-overflow-')),path=join(dir,'bot.db'),tel=new Telemetry(path)
 const service=new SimulationService(join(dir,'simulation.db'),path,2)
 try{
  for(let i=0;i<5;i++)service.capture('fixture',String(i),{i})
  expect(service.status.dropped).toBe(3);service.start()
  await waitFor('the worker to acknowledge the accepted events',()=>service.status.acknowledged>=2)
  expect(service.status.acknowledged).toBe(2)
  await service.stop();await delay(100)
  const db=new Database(service.path,{readonly:true})
  expect((db.prepare("SELECT COUNT(*) n FROM captures WHERE kind='fixture'").get() as any).n).toBe(2)
  expect((db.prepare('SELECT reason FROM gaps').get() as any).reason).toContain('queue overflow: 3')
  db.close()
 }finally{await service.stop();tel.raw().close();await delay(200);rmSync(dir,{recursive:true,force:true})}
},30000)

it('promotes one arrivals row per opportunity instead of a row per log',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'simulation-arrivals-')),path=join(dir,'bot.db'),tel=new Telemetry(path)
 const service=new SimulationService(join(dir,'simulation.db'),path)
 const curve='0xCurve0000000000000000000000000000000001'
 try{
  service.start()
  await waitFor('the capture worker to open the database',()=>service.status.error===null)
  // A launch whose window has already closed: stop() must not leave its arrivals behind.
  const at=Date.now()-250_000
  service.capture('opportunity','0xtoken',{launch:{curve},params:{launchedAt:String(Math.floor((at-60_000)/1000))}},at)
  expect(service.status.pendingPromotions).toBe(1)
  service.arrival(curve,'0xtx',1,at-1000)
  service.arrival(curve.toLowerCase(),'0xtx',1,at-500)   // the same log, redelivered later
  service.arrival('0xsomeoneelse','0xtx',2,at-900)
  expect(service.status.ringSize).toBe(3)
  await service.stop();await delay(150)
  const db=new Database(service.path,{readonly:true})
  const rows=db.prepare("SELECT key,payload FROM captures WHERE kind='curve-arrivals'").all() as any[]
  expect(rows).toHaveLength(1)
  expect(rows[0].key).toBe(curve)
  const payload=JSON.parse(rows[0].payload)
  expect(payload.partial).toBe(true)
  expect(payload.arrivals).toEqual([['0xtx',1,at-1000]])
  expect(db.prepare("SELECT COUNT(*) n FROM captures WHERE kind='chain-log'").get()).toEqual({n:0})
  expect(service.status.pendingPromotions).toBe(0)
  db.close()
 }finally{await service.stop();tel.raw().close();await delay(200);rmSync(dir,{recursive:true,force:true})}
},30000)

it('keeps the heartbeat ticking without rebuilding the report',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'simulation-beat-')),path=join(dir,'bot.db'),tel=new Telemetry(path)
 const service=new SimulationService(join(dir,'simulation.db'),path)
 try{
  service.start()
  const seen:number[]=[]
  let reportKilled=false
  const watch=setInterval(()=>{
   const at=service.paperStatus?.at
   if(typeof at==='number'&&at!==seen.at(-1))seen.push(at)
   if(!reportKilled&&service.paperStatus?.reportPid){reportKilled=true;process.kill(service.paperStatus.reportPid,'SIGTERM')}
  },50)
  try{await waitFor('two worker heartbeats',()=>seen.length>=2)}finally{clearInterval(watch)}
  expect(seen.length).toBeGreaterThanOrEqual(2)
  expect(seen[1]!).toBeGreaterThan(seen[0]!)
  expect(service.paperStatus.reportError).toBe('dashboard_report_worker_exited')
  await service.stop();await delay(100)
  const db=new Database(service.path,{readonly:true})
  const beat=JSON.parse((db.prepare("SELECT value FROM checkpoints WHERE name='writer'").get() as any).value)
  // The heartbeat advanced; the report did not need to, because nothing was captured.
  expect(beat.at).toBeGreaterThanOrEqual(seen[1]!)
  db.close()
 }finally{await service.stop();tel.raw().close();await delay(200);rmSync(dir,{recursive:true,force:true})}
},30000)
