import { expect, it } from 'vitest'
import { replayScenarioAccounts, prepareScenarioAccounts, replayScenarioAccountGrid, compactScenarioAccountResult, type ScenarioAccountInput } from '../src/strategy/scenario-account.js'
import { SCENARIO_IDS, SCENARIO_VERSION } from '../src/strategy/execution-scenarios.js'
import { CONSERVATIVE_GUARD } from '../src/strategy/scenario-guard.js'
import { EXECUTION_VERSION, EVIDENCE_VERSION } from '../src/strategy/execution-model.js'
import { executeBatch } from '../scripts/execution-worker.js'

function fixture(): ScenarioAccountInput {
  const config = { entry: { minCreatorTaxBps: 50, maxCreatorTaxBps: 10000, minExemptionsToEnter: 3, templateLossBlockMs: 30000, tradeSizeEth: .01 },
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
it('has exact research batch parity and retains wins relative to matching-exit market-off accounts', () => {
  const input = fixture(), run = replayScenarioAccounts(input)
  expect(executeBatch({ op: 'scenario-accounts', input })).toEqual(run)
  expect(run.accounts[0]!.selected.wins).toBe(3)
  expect(run.accounts[0]!.reference.wins).toBe(13)
  expect(run.accounts[0]!.retention.winsRetained).toBe(3 / 13)
  expect(run.accounts[0]!.retention.losingMoneyRetained).toBeNull()
})
it('keeps each scenario capacity and template history independent', () => {
  const input = fixture(), first = input.opportunities[0]!, second = input.opportunities[1]!
  first.bundle.scenarios[0]!.result.exitAt = 4500; first.bundle.closedThrough = 4500; first.availableAt = 4501
  second.template = first.template
  first.bundle.scenarios[1]!.result.pnlWei = '-100'
  const run = replayScenarioAccounts(input)
  expect(run.continuous[0]!.run.decisions[1]!.reason).toBe('capacity')
  expect(run.continuous[1]!.run.decisions[1]!.reason).toContain('template')
  expect(run.continuous[2]!.run.decisions[1]!.allow).toBe(true)
})
it('keeps account stops and cumulative loss across drawdown resets', () => {
  const input = fixture()
  input.controls.push({ kind: 'control', id: 'manual', at: 31000, sequence: 0, strategyVersion: EXECUTION_VERSION, halted: true })
  const stopped = replayScenarioAccounts(input)
  expect(stopped.accounts[0]!.selected.wins).toBe(0)
  expect(stopped.accounts[0]!.reference.wins).toBe(10)
  expect(stopped.continuous[0]!.metrics.wins).toBe(13)
  for (const o of input.opportunities) for (const s of o.bundle.scenarios) s.result.pnlWei = '-100'
  input.controls = [{ kind: 'control', id: 'reset', at: 31000, sequence: 0, strategyVersion: EXECUTION_VERSION, resetDrawdown: true }]
  const losses = replayScenarioAccounts(input)
  expect(losses.accounts[0]!.reference.netWei).toBe('-1300')
  expect(losses.accounts[0]!.reference.drawdownWei).toBe('1300')
})
it('does not let future missing evidence change earlier decisions', () => {
  const input = fixture(), prefix = replayScenarioAccounts({ ...input, through: 33000 })
  const last = input.opportunities.at(-1)!
  last.bundle.scenarios[0]!.request.coverage.independentlyChecked = false
  const after = replayScenarioAccounts(input)
  expect(after.readings.filter(r => r.at <= 33000 && r.at !== 33000)).toEqual(prefix.readings.filter(r => r.at !== 33000))
  expect(after.reading.state).toBe('shut')
})
it('requires a fresh compatible window on configuration change', () => {
  const input = fixture(); input.opportunities[10]!.configId = 'b'; input.opportunities[11]!.configId = 'b'; input.opportunities[12]!.configId = 'b'
  const run = replayScenarioAccounts(input)
  expect(run.accounts[0]!.selected.wins).toBe(0)
  expect(run.reading.scenarios.every(s => s.n === 3)).toBe(true)
})
it('does not report retained profit from an incomplete account comparison', () => {
  const input=fixture()
  input.controls.push({kind:'gap',id:'missing-source',at:34000,sequence:0,strategyVersion:EXECUTION_VERSION,reason:'missing history'})
  const run=replayScenarioAccounts(input)
  expect(Object.values(run.accounts[0]!.retention).every(v=>v===null)).toBe(true)
})
it('continues known cash after a source gap and rewarms the indicator from post-gap outcomes',()=>{
  const input=fixture()
  input.policy={...CONSERVATIVE_GUARD,n:3,m:2,mode:'fresh'}
  input.controls.push({kind:'gap',id:'restart-gap',at:30000,sequence:0,strategyVersion:EXECUTION_VERSION,reason:'writer restart'})
  const warming=replayScenarioAccounts({...input,through:35000})
  expect(warming.continuous[0]!.run.decisions.filter(d=>d.at>30000).every(d=>d.reason!=='unresolved_account_state')).toBe(true)
  expect(warming.tapes.every(t=>!t.complete)).toBe(true)
  const rewarmed=replayScenarioAccounts(input)
  expect(rewarmed.tapes.every(t=>t.complete)).toBe(true)
  expect(rewarmed.reading.reason).not.toBe('invalid_or_incomplete_scenario_evidence')
  expect(Object.values(rewarmed.accounts[0]!.retention).every(v=>v===null)).toBe(true)
})
it('batch preparation preserves scalar results across interleaved window groups and thresholds', () => {
  const input = fixture()
  const policies = [CONSERVATIVE_GUARD, { ...CONSERVATIVE_GUARD, id: 'fresh', mode: 'fresh' as const, n: 8, m: 3 },
    { ...CONSERVATIVE_GUARD, id: 'high', fullOn: 4 }, { ...CONSERVATIVE_GUARD, id: 'short', ageMs: 12000 },
    { ...CONSERVATIVE_GUARD, id: 'same-behavior', fullOn: 2 }]
  const grid = replayScenarioAccountGrid(input, policies)
  expect(grid.results).toEqual(policies.map(policy => compactScenarioAccountResult(replayScenarioAccounts({ ...input, policy }))))
  expect(grid.stats.preparations).toBe(1)
  expect(grid.stats.evidencePlans).toBe(3)
  expect(grid.stats.selectedCacheHits).toBeGreaterThan(0)
})
it('prepared replay owns its inputs and preserves configuration switches, stops and gaps', () => {
  const input = fixture()
  input.opportunities[5]!.configId = 'b'; input.opportunities[6]!.configId = 'b'
  input.controls.push({ kind: 'control', id: 'stop', at: 22000, sequence: 0, strategyVersion: EXECUTION_VERSION, halted: true },
    { kind: 'control', id: 'resume', at: 28000, sequence: 0, strategyVersion: EXECUTION_VERSION, halted: false, resetDrawdown: true },
    { kind: 'gap', id: 'missing', at: 35000, sequence: 0, strategyVersion: EXECUTION_VERSION, reason: 'missing source' })
  const expected = replayScenarioAccounts(input), prepared = prepareScenarioAccounts(input)
  input.opportunities[0]!.bundle.scenarios[0]!.result.pnlWei = '999999'
  expect(prepared.replay(CONSERVATIVE_GUARD)).toEqual(expected)
  expect(prepared.replay({ ...CONSERVATIVE_GUARD, id: 'equivalent' }).accounts).toEqual(expected.accounts)
})
it('ignores duplicate config controls without dropping the next required configuration', () => {
  const input = fixture(), at = input.opportunities[2]!.at
  const changed = { ...input.config, entry: { ...input.config.entry, minCreatorTaxBps: 150 , maxCreatorTaxBps: 10000,} }
  input.controls.push(
    { kind: 'control', id: 'duplicate', at: at - 2, sequence: -3, strategyVersion: EXECUTION_VERSION, config: input.config },
    { kind: 'control', id: 'duplicate', at: at - 1, sequence: -3, strategyVersion: EXECUTION_VERSION, config: changed },
  )
  input.opportunities[2]!.config = changed
  const run = replayScenarioAccounts(input)
  expect(run.continuous[0]!.run.decisions[2]!.reason).toBe('tax 100bps')
  expect(run.accounts[0]!.marketOff.decisions[2]!.reason).toBe('tax 100bps')
  expect(run.continuous[0]!.run.decisions[3]!.allow).toBe(true)
})
it('applies the next market check when an earlier event consumed the recovery check identity', () => {
  const input = fixture()
  input.policy = { ...input.policy, n: 2, m: 1, freshOn: .1, fullOn: .1 }
  input.controls.push({ kind: 'control', id: 'scenario-check:5001', at: 0, sequence: -3, strategyVersion: EXECUTION_VERSION })
  const run = replayScenarioAccounts(input)
  expect(run.readings.find(r => r.at === 5001)!.state).toBe('open')
  expect(run.accounts[0]!.policy.decisions[2]!.allow).toBe(true)
})
