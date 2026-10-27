import {it,expect} from 'vitest'
import {SimulationStore} from '../src/simulation/store.js'
import {MODEL_HASH} from '../src/simulation/identity.js'
import {selectorEvidence,capturedTarget} from '../src/simulation/selector.js'
import {PaperProcessor} from '../src/simulation/processor.js'
import Database from 'better-sqlite3'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

it('persists actual processor admissions and retries missing sources without blocking the next job',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'indicator-processor-')),prior=process.env.GATE_DB
  const sourcePath=join(dir,'source.db'),gatePath=join(dir,'gate.db')
  const source=new Database(sourcePath),gate=new Database(gatePath)
  source.exec('CREATE TABLE positions(id INTEGER,updated_at INTEGER)');source.close()
  gate.exec('CREATE TABLE obs(token TEXT,at INTEGER,error TEXT,bars TEXT)');gate.close()
  process.env.GATE_DB=gatePath
  const store=new SimulationStore(':memory:'),processor=new PaperProcessor(store,sourcePath)
  try{
    const session='processor:'+MODEL_HASH,now=Date.now()
    store.append([1,2].map(sequence=>({session,sequence,at:now-210000+sequence,kind:'opportunity',key:String(sequence),
      payload:{config:{targetPolicy:{adaptive:{window:2,bars:[1.25,1.75]},otherwise:1.75,maxRateAgeMs:300000}},
        takeProfit:{multiple:1.75,ready:false},selector:null},provenance:'prospective' as const})))
    await processor.tick();await processor.tick()
    expect(store.db.prepare('SELECT status,reason,target FROM virtual_admissions ORDER BY id').all()).toEqual([
      {status:'blocked',reason:'selector_unavailable',target:null},{status:'blocked',reason:'selector_unavailable',target:null}])
    const jobs=store.db.prepare('SELECT status,attempts,error FROM processing_jobs ORDER BY id').all()
    expect(jobs).toEqual([1,2].map(()=>({status:'retry',attempts:1,error:'Error: waiting_for_source_publication'})))
    expect(store.db.prepare('SELECT COUNT(*) n FROM results').get()).toEqual({n:0})
  }finally{
    processor.close();store.close()
    if(prior===undefined)delete process.env.GATE_DB;else process.env.GATE_DB=prior
    rmSync(dir,{recursive:true,force:true})
  }
})

it('processes another ready job while an older job backs off, retaining attempts across claims',()=>{
  const store=new SimulationStore(':memory:'),session='test:'+MODEL_HASH,now=1000000
  try{
    store.append([1,2].map(sequence=>({session,sequence,at:sequence,kind:'opportunity',key:String(sequence),payload:{},provenance:'prospective' as const})))
    const first=store.nextJob(now);expect(first.sequence).toBe(1)
    store.retryJob(session+':1',now,'HTTP 429 https://secret.example/key')
    const next=store.nextJob(now+1);expect(next.sequence).toBe(2)
    store.finishJob(session+':2',now+2)
    expect(store.nextJob(now+999)).toBeUndefined()
    expect(store.nextJob(now+1001)).toMatchObject({sequence:1,attempts:1})
    expect(JSON.stringify(store.jobHealth(now))).not.toContain('secret.example')
  }finally{store.close()}
})

it('blocks a missing required observation without poisoning all later complete windows',()=>{
  const rows=[1,2,3].map(i=>({id:String(i),at:i,block:i,token:String(i),configId:'a',availableAt:i===2?null:10,scores:i===2?null:{'1.75':i}}))
  const blocked=selectorEvidence(rows,'a',200000,2,['1.75'])
  expect(blocked.evidenceIds).toEqual(['3','2']);expect(blocked.blockingIds).toEqual(['2']);expect(blocked.complete).toBe(false)
  rows.push({id:'4',at:4,block:4,token:'4',configId:'a',availableAt:11,scores:{'1.75':4}})
  const recovered=selectorEvidence(rows,'a',200000,2,['1.75'])
  expect(recovered.evidenceIds).toEqual(['4','3']);expect(recovered.complete).toBe(true)
  expect(selectorEvidence(rows,'new-config',200000,2,['1.75']).complete).toBe(false)
})

it('never admits a fallback target or a target whose publication is not ready',()=>{
  const capture={config:{targetPolicy:{adaptive:{window:2,bars:[1.25,1.75]},otherwise:1.75,maxRateAgeMs:300000}},
    takeProfit:{multiple:1.75,ready:false},selector:null,selectorHeartbeatAt:1000}
  expect(capturedTarget(capture,1001)).toMatchObject({ready:false,failure:'selector_unavailable'})
})
