import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {replayScenarioAccounts as original} from './bounded-original-account.js'
import {replayScenarioAccounts as optimized} from '../../src/strategy/scenario-account.js'
const sample=JSON.parse(readFileSync('data/research/20260914-bounded-grid-v1/verification/account-pruning-reference.json','utf8'))[0].input
const input=structuredClone(sample)
const at=input.opportunities[2].at
const changed={...input.config,entry:{...input.config.entry,minCreatorTaxBps:150}}
input.controls.push({kind:'control',id:'duplicate',at:at-2,sequence:-3,strategyVersion:'execution-account-v3',config:input.config},
 {kind:'control',id:'duplicate',at:at-1,sequence:-3,strategyVersion:'execution-account-v3',config:changed})
input.opportunities[2].config=changed
assert.deepStrictEqual(JSON.parse(JSON.stringify(optimized(input))),JSON.parse(JSON.stringify(original(input))))
console.log('Duplicate config control parity passed')
