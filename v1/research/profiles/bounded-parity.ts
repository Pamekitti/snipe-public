import assert from 'node:assert/strict'
import { replayScenarioAccounts as fast } from './bounded-account-fast.js'
import { replayScenarioAccounts, prepareScenarioAccounts, replayScenarioAccountGrid, compactScenarioAccountResult, type ScenarioAccountInput } from '../../src/strategy/scenario-account.js'
import { SCENARIO_IDS, SCENARIO_VERSION } from '../../src/strategy/execution-scenarios.js'
import { CONSERVATIVE_GUARD } from '../../src/strategy/scenario-guard.js'
import { EXECUTION_VERSION, EVIDENCE_VERSION } from '../../src/strategy/execution-model.js'
import { executeBatch } from '../../scripts/execution-worker.js'

function fixture(): ScenarioAccountInput {
  const config = { entry: { minCreatorTaxBps: 50, minExemptionsToEnter: 3, templateLossBlockMs: 30000, tradeSizeEth: .01 },
    bankrollWei: '100000000000000000', maxConcurrent: 1, maxDrawdownWei: '60000000000000000', entryHours: [] }
  return { start: 0, through: 40000, initialKnown: true, config, policy: CONSERVATIVE_GUARD, controls: [],
    opportunities: Array.from({ length: 13 }, (_, i) => ({ id: String(i), token: String(i), template: String(i), at: 1000 + i * 3000,
      sequence: i, configId: 'a', config, creatorTaxBps: '100', exemptions: 3, sizeWei: '10000000000000000',
      block: i + 1, launched: i * 3000, availableAt: 2001 + i * 3000,
      bundle: { version: SCENARIO_VERSION, complete: true, closedThrough: 2000 + i * 3000, unavailable: [],
        scenarios: SCENARIO_IDS.map(id => ({ id, request: { coverage: { complete: true, independentlyChecked: true, gaps: [] } } as any,
          result: { modelVersion: EXECUTION_VERSION, evidenceVersion: EVIDENCE_VERSION, status: 'closed', reason: 'time',
            entryAt: 1000 + i * 3000, exitAt: 2000 + i * 3000, decisionAt: 1900 + i * 3000,
            pnlWei: '3000000000000000', costsWei: '1', tokens: '1', spentWei: '10000000000000000', proceedsWei: '13000000000000001',
            scenario: id, trace: [], assumption: 'External traders retain historical order quantities' } })) } })) }
}

for (let seed=0;seed<80;seed++) {
 const input=fixture()
 input.policy={...input.policy,id:'parity-'+seed,n:2+seed%9,m:1,ageMs:12000+(seed%4)*12000}
 for(let i=0;i<input.opportunities.length;i++) {
  const o=input.opportunities[i]!
  if(seed%3===0)o.template=String(i%3)
  for(let j=0;j<o.bundle.scenarios.length;j++)if((seed+i+j)%7<2)o.bundle.scenarios[j]!.result.pnlWei='-4000000000000000'
 }
 if(seed%4===0)input.controls.push({kind:'control',id:'stop',at:22000,sequence:-3,strategyVersion:EXECUTION_VERSION,halted:true},{kind:'control',id:'resume',at:28000,sequence:99,strategyVersion:EXECUTION_VERSION,halted:false,resetDrawdown:true})
 if(seed%4===1)input.controls.push({kind:'control',id:'external-config',at:13000,sequence:99,strategyVersion:EXECUTION_VERSION,config:{...input.config,entry:{...input.config.entry,minCreatorTaxBps:150}}})
 if(seed%4===2)input.controls.push({kind:'gap',id:'gap',at:35000,sequence:0,strategyVersion:EXECUTION_VERSION,reason:'unavailable'})
 if(seed%4===3)input.controls.push({kind:'control',id:'4:config',at:13000,sequence:7,strategyVersion:EXECUTION_VERSION,halted:true})
 if(seed%5===0)input.opportunities[4]!.id='scenario-check:13000'
 if(seed%5===1)input.opportunities[5]!.id='4:config'
 if(seed%5===2)input.opportunities[5]!.config={...input.config,maxConcurrent:2}
 const expected=replayScenarioAccounts(input),actual=fast(input)
 assert.deepStrictEqual(actual,expected,'case '+seed)
}
console.log('80 full-output control, expiry, config, collision, capacity and gap parity cases passed')
