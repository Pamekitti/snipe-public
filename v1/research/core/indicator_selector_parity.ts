/** Historical adapter parity only. Never publishes evidence or opens a live account. */
import {readFileSync,writeFileSync} from 'node:fs'
import {gunzipSync} from 'node:zlib'
import {MODEL_HASH} from '../../src/simulation/identity.js'
import {SimulationStore,digest,encode} from '../../src/simulation/store.js'
import {selectorSnapshot,selectorEvidence} from '../../src/simulation/selector.js'
import {barKey} from '../../src/strategy/takeprofit.js'
const [capturePath,referencePath,output]=process.argv.slice(2)
if(!capturePath||!referencePath||!output)throw new Error('Usage: indicator_selector_parity.ts CAPTURE_GZ TARGET_REFERENCE_JSON OUTPUT_JSON')
const input=JSON.parse(gunzipSync(readFileSync(capturePath)).toString())
const reference=JSON.parse(readFileSync(referencePath,'utf8'))
const scores=new Map<string,any>(reference.ledger.filter((r:any)=>r.targetsComplete&&r.availableAt!==null).map((r:any)=>[r.id,r]))
const captures=input.captures.filter((c:any)=>c.kind==='opportunity').sort((a:any,b:any)=>a.at-b.at||a.sequence-b.sequence||(a.session+':'+a.sequence).localeCompare(b.session+':'+b.sequence))
const store=new SimulationStore(':memory:'),candidates:any[]=[],failures:any[]=[]
let ready=0
try{
  for(const c of captures){
    const oldId=c.session+':'+c.sequence,session=c.session+':'+MODEL_HASH,id=session+':'+c.sequence,config=c.payload.config
    store.append([{...c,session,provenance:'reconstruction'}])
    const score=scores.get(oldId)
    if(score)store.db.prepare('INSERT INTO selector_results VALUES (?,?,?,?,?)').run(id,MODEL_HASH,digest(config),encode({scores:score.targetScores}),score.availableAt)
    candidates.push({id,at:c.at,block:c.payload.launch.block,token:c.key,configId:digest(config),availableAt:score?.availableAt??null,scores:score?.targetScores??null})
    const offline=selectorEvidence(candidates,digest(config),c.at,config.targetPolicy.adaptive.window,config.targetPolicy.adaptive.bars.map(barKey))
    const live=selectorSnapshot(store.db,c.at)!
    const fields=['rows','evidenceIds','blockingIds','complete','publicationAt','failure'] as const
    for(const key of fields)if(encode(offline[key])!==encode(live[key]))failures.push({id:oldId,at:c.at,field:key})
    if(live.complete)ready++
  }
  const result={modelHash:MODEL_HASH,checks:captures.length,ready,failures,from:captures[0]?.at,through:input.at,
    purpose:'SQL live selector versus offline selector on frozen historical target publications',prospective:false}
  writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(failures.length)process.exitCode=1
}finally{store.close()}
