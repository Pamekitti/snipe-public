import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {replayScenarioAccounts} from './bounded-account-fast.js'
import {initialAccount,reduceAccount} from '../../src/strategy/paper-account.js'
import {reduceAccount as fastReduce} from './bounded-paper-fast.js'
import {EXECUTION_VERSION} from '../../src/strategy/execution-model.js'
const cases=JSON.parse(readFileSync('data/research/20260914-bounded-grid-v1/verification/account-pruning-reference.json','utf8'))
for(const [i,c] of cases.entries()) {
 assert.deepStrictEqual(JSON.parse(JSON.stringify(replayScenarioAccounts(c.input))),c.expected,'full case '+i)
 const events:any[]=[...c.input.controls,...c.input.opportunities.flatMap((o:any)=>[
  {kind:'control',id:o.id+':config',at:o.at,sequence:o.sequence*2,strategyVersion:EXECUTION_VERSION,config:o.config},
  {kind:'opportunity',id:o.id,at:o.at,sequence:o.sequence*2+1,strategyVersion:EXECUTION_VERSION,token:o.token,template:o.template,creatorTaxBps:o.creatorTaxBps,exemptions:o.exemptions,sizeWei:o.sizeWei,result:o.bundle.scenarios[3].result,availableAt:o.availableAt,block:o.block,launched:o.launched,checked:true}
 ])]
 const initial=initialAccount('policy',EXECUTION_VERSION,c.input.start,c.input.config,c.input.initialKnown)
 const prefix=reduceAccount(initial,events,16500)
 assert.deepStrictEqual(fastReduce(prefix.state,events,c.input.through),reduceAccount(prefix.state,events,c.input.through),'resumed case '+i)
}
console.log('80 full scenario outputs and 80 resumed account outputs match the original')
