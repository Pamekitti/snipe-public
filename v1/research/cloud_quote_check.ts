/** Verify that proven quote rejection never becomes a simulated fill or unknown account. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { executeJob } from './core/cloud_execution.js'
import { EVENT_TOPICS } from '../src/abi.js'
const requests=JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
const q=structuredClone(requests[0])
const block=q.seed.order.block+1
q.logs=[{address:q.curve,topics:[EVENT_TOPICS.CurveCompleted],data:'0x',transactionHash:'0x'+'1'.repeat(64),blockHash:'0x'+'2'.repeat(64),blockNumber:'0x'+block.toString(16),transactionIndex:'0x0',logIndex:'0x0',at:q.entryAt-1000,observedAt:q.entryAt-400,timeResolutionMs:1000,order:{block,transaction:0,log:0}}]
const known=executeJob({id:q.id,request:q,unavailable:[]})
assert(known.matrix)
let n=0
for(const scenario of known.matrix)for(const exit of scenario)for(const result of exit){assert.equal(result.status,'rejected');assert.equal(result.pnlWei,'0');assert.equal(result.costsWei,'0');assert.equal(result.tokens,'0');n++}
q.logs[0].topics=[EVENT_TOPICS.CurveBuy];q.logs[0].data='0xINVALID'
const malformed=executeJob({id:q.id,request:q,unavailable:[]})
assert.equal(malformed.matrix,null)
assert(malformed.unavailable.some((r:string)=>r.startsWith('causal_entry_quote:')))
console.log(JSON.stringify({knownPreEntryRejections:n,unknownInputPreserved:true}))
