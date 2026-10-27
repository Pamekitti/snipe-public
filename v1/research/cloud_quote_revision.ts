/** Revise only proven pre-entry quote rejections; retain every other replay calculation. */
import { readFileSync,writeFileSync,mkdirSync,renameSync,existsSync,readdirSync,linkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { executeJob } from './core/cloud_execution.js'
const root='/work/results', old=root+'/pre-quote-rejection'
const read=(p:string):any=>JSON.parse(readFileSync(p,'utf8'))
const sha=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex')
// Python writes the canonical freeze and checkpoint JSON used by the controller.
const save=(p:string,v:any)=>{writeFileSync(p+'.tmp',JSON.stringify(v));renameSync(p+'.tmp',p)}
const frozen=read(root+'/run-freeze.json'), inputs=read(root+'/input-manifest.json')
if(sha(old+'/cloud_execution.ts')!==frozen.sources['research/core/cloud_execution.ts'])throw new Error('Original worker source proof failed')
const source:any={}
for(const [path,hash] of Object.entries(frozen.sources)){
 source[path]=sha(path)
 if(path!=='research/core/cloud_execution.ts'&&source[path]!==hash)throw new Error('Unexpected source change '+path)
}
if(sha(root+'/input-manifest.json')!==frozen.inputManifestHash)throw new Error('Input manifest changed')
if(sha('research/core/cloud-exits.json')!==frozen.exitDescriptorsHash)throw new Error('Exit definitions changed')
const identity=JSON.parse(execFileSync('node',['--import','tsx','scripts/execution-worker.ts'],{input:'{"op":"identity"}\n',encoding:'utf8'})).result
if(identity.modelHash!==frozen.modelHash)throw new Error('Execution kernel changed')
for(const name of ['matrices','accounts','account-manifest.json','candidate-freeze.json','scores','build-accounts.log','parallelism-pilot.json'])if(existsSync(root+'/'+name))renameSync(root+'/'+name,old+'/'+name)
renameSync(root+'/run-freeze.json',old+'/run-freeze.json')
writeFileSync(old+'/input-manifest.json',readFileSync(root+'/input-manifest.json'))
mkdirSync(root+'/matrices',{recursive:true})
const revised={...frozen,sources:source}
execFileSync('/work/venv/bin/python',['-c','import sys,json;from research.core.data import write_json;write_json(sys.argv[1],json.load(sys.stdin))',root+'/run-freeze.json'],{input:JSON.stringify(revised)})
const oldFreezeHash=sha(old+'/run-freeze.json'),newFreezeHash=sha(root+'/run-freeze.json')
let changed=0,files=0;const audit:any[]=[]
for(const chunk of inputs.chunks){
 const name=chunk.path.split('/').pop(),prior=old+'/matrices/'+name,target=root+'/matrices/'+name,checkpoint=prior+'.checkpoint.json'
 if(!existsSync(prior)||!existsSync(checkpoint))continue
 if(sha(chunk.path)!==chunk.sha256)throw new Error('Frozen job changed '+name)
 const args=['node','--import','tsx','research/core/cloud_execution.ts',chunk.path,target]
 const jobHash=(freeze:string)=>execFileSync('/work/venv/bin/python',['-c','import sys,json,hashlib;print(hashlib.sha256(json.dumps(json.load(sys.stdin)).encode()).hexdigest())'],{input:JSON.stringify({args,inputKey:chunk.sha256,freeze}),encoding:'utf8'}).trim()
 const proof=read(checkpoint),buffer=readFileSync(prior)
 if(createHash('sha256').update(buffer).digest('hex')!==proof.outputHash||jobHash(oldFreezeHash)!==proof.jobHash)throw new Error('Prior replay cache proof failed '+name)
 let replacements=0
 if(buffer.includes(Buffer.from('causal_entry_quote:Error: CurveGraduated'))){
  const rows=JSON.parse(buffer.toString()),jobs=read(chunk.path)
  if(rows.length!==jobs.length)throw new Error('Row count mismatch')
  for(let i=0;i<rows.length;i++){
   const row=rows[i],job=jobs[i]
   if(row.id!==job.id)throw new Error('Row identity mismatch')
   if(row.matrix===null&&row.unavailable?.includes('causal_entry_quote:Error: CurveGraduated')){
    const next=executeJob(job)
    if(!next.matrix||next.matrix.some((s:any)=>s.some((h:any)=>h.some((r:any)=>r.status!=='rejected'||r.pnlWei!=='0'||r.costsWei!=='0'))))throw new Error('Pre-entry rejection did not reproduce')
    rows[i]=next;replacements++
   }
  }
  save(target,rows)
 }else linkSync(prior,target)
 const resultHash=sha(target)
 save(target+'.checkpoint.json',{jobHash:jobHash(newFreezeHash),outputHash:resultHash})
 audit.push({chunk:name,oldOutputHash:proof.outputHash,newOutputHash:resultHash,knownQuoteRejections:replacements,otherResultsUnchanged:true})
 changed+=replacements;files++
 save(root+'/quote-revision-progress.json',{completed:files,total:inputs.chunks.length,changedRows:changed,heartbeat:Date.now()})
}
save(root+'/quote-revision.json',{at:Date.now(),changedRows:changed,files,oldFreezeHash,newFreezeHash,modelHash:identity.modelHash,kernelUnchanged:true,scope:'Known pre-entry CurveGraduated quote failures now match bot.enter: no transaction, no gas, no outcome. Other unresolved results are unchanged.',audit})
console.log(JSON.stringify({changedRows:changed,files,kernelUnchanged:true}))
