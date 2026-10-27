import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {replayScenarioAccounts} from '../../src/strategy/scenario-account.js'
const root='data/research/20260914-bounded-grid-v1/verification'
const cases=JSON.parse(readFileSync(root+'/account-pruning-reference.json','utf8'))
for(const [i,c] of cases.entries())assert.deepStrictEqual(JSON.parse(JSON.stringify(replayScenarioAccounts(c.input))),c.expected,'frozen case '+i)
const result={passed:true,fullOutputCases:cases.length};writeFileSync(root+'/account-pruning-parity.json',JSON.stringify(result));console.log(result)
