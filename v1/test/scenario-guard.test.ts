import { expect, it } from 'vitest'
import { SCENARIO_IDS } from '../src/strategy/execution-scenarios.js'
import { ScenarioGuard, ScenarioEvidenceIndex, prepareScenarioEvidence, CONSERVATIVE_GUARD, BASELINE_GUARD, type ScenarioTape } from '../src/strategy/scenario-guard.js'
import fixtures from './fixtures/fresh-recovery-parity.json'

const tapes = (values: number[], available = 1001): ScenarioTape[] => SCENARIO_IDS.map(id => ({ id, complete: true,
  outcomes: values.map((value, i) => ({ token: `token-${i}`, value, available, block: i + 1, launched: 100 + i })) }))
it('preserves all 8056 historical baseline checks when scenarios have identical evidence', () => {
  let checks=0
  for(const fixture of fixtures){
    const guard=new ScenarioGuard(fixture.start,BASELINE_GUARD)
    const rows=SCENARIO_IDS.map(id=>({id,complete:true,outcomes:fixture.records}))
    for(const [at,allowed,score,recent,fresh] of fixture.expected){
      const reading=guard.read(rows,at as number,'baseline')
      expect(reading.state==='open').toBe(allowed)
      expect(reading.scenarios.every(s=>s.fresh)).toBe(fresh)
      expect(reading.recentSumRange?.[0]).toBeCloseTo(recent as number,10)
      checks++
    }
  }
  expect(checks).toBe(8056)
},Number(process.env.RESEARCH_PARITY_TIMEOUT_MS ?? 120000))
// 8056 guard reads over a 1.15MB tape: ~29s on the laptop and slower on the 2-core box,
// where deploy.sh aborts the rollback snapshot after two consecutive suite failures. The
// old 30000 default sat inside the measurement's own noise.
it('requires both strict recovery thresholds in every scenario', () => {
  const guard = new ScenarioGuard(1000, CONSERVATIVE_GUARD)
  expect(guard.read(tapes(Array(10).fill(.2)), 1001, 'a').state).toBe('shut')
  const partial = tapes(Array(10).fill(.3), 1002)
  partial[0]!.outcomes = tapes(Array(10).fill(.1))[0]!.outcomes
  expect(guard.read(partial, 1002, 'a').state).toBe('shut')
  expect(guard.read(tapes(Array(10).fill(.3), 1003), 1003, 'a').state).toBe('open')
})
it('one loss scenario pauses everyone, with strict brake equality', () => {
  const guard = new ScenarioGuard(1000, CONSERVATIVE_GUARD)
  guard.read(tapes(Array(10).fill(.3)), 1001, 'a')
  const rows = tapes(Array(10).fill(.3), 1002)
  rows[0]!.outcomes = tapes([-2, ...Array(9).fill(0)], 1002)[0]!.outcomes
  expect(guard.read(rows, 1002, 'a').state).toBe('open')
  rows[0]!.outcomes[0]!.value = -2.01
  expect(guard.read(rows, 1003, 'a').reason).toBe('scenario_loss_brake')
  expect(guard.read(tapes(Array(10).fill(.3)), 1004, 'a').state).toBe('shut')
})
it('preserves consumed evidence through restart and invalidates config changes', () => {
  const guard = new ScenarioGuard(1000, CONSERVATIVE_GUARD)
  guard.read(tapes(Array(10).fill(.3)), 1001, 'a'); guard.pause(1002)
  const next = new ScenarioGuard(1002, CONSERVATIVE_GUARD); next.restore(guard.snapshot())
  expect(next.read(tapes(Array(10).fill(.3)), 1003, 'a').state).toBe('shut')
  expect(next.read(tapes(Array(10).fill(.3), 1004), 1004, 'a').state).toBe('open')
  expect(next.read(tapes(Array(10).fill(.3), 1005), 1005, 'b').state).toBe('shut')
  expect(() => new ScenarioGuard(1000, BASELINE_GUARD).restore(guard.snapshot())).toThrow('incompatible')
})
it('missing scenarios, duplicate outcomes and expiry fail closed', () => {
  const guard = new ScenarioGuard(1000, CONSERVATIVE_GUARD)
  expect(guard.read(tapes(Array(10).fill(.3)).slice(1), 1001, 'a').state).toBe('shut')
  const duplicate = tapes(Array(10).fill(.3), 1002)
  duplicate[0]!.outcomes.push(duplicate[0]!.outcomes[0]!)
  expect(guard.read(duplicate, 1002, 'a').reason).toContain('invalid')
  expect(guard.read(tapes(Array(10).fill(.3), 1003), 1003, 'a').state).toBe('open')
  expect(guard.read(tapes(Array(10).fill(.3), 1003), 10801004, 'a').state).toBe('shut')
})
it('retains baseline recovery below the brake until the next distinct check', () => {
  const guard = new ScenarioGuard(1000, BASELINE_GUARD)
  const rows = tapes([...Array(12).fill(-1), ...Array(8).fill(.2)])
  expect(guard.read(rows, 1001, 'a').state).toBe('open')
  expect(guard.read(rows, 1001, 'a').state).toBe('open')
  expect(guard.read(rows, 1002, 'a').state).toBe('shut')
})
it('refuses changed data at the same decision time and never rewinds its cursor', () => {
  const guard = new ScenarioGuard(1000, CONSERVATIVE_GUARD)
  expect(guard.read(tapes(Array(10).fill(.3)), 1001, 'a').state).toBe('open')
  expect(guard.read(tapes(Array(10).fill(-.3)), 1001, 'a').state).toBe('shut')
  guard.read(tapes(Array(10).fill(.3)), 999, 'a')
  expect(guard.snapshot().cursor).toBe(1001)
  expect(guard.read(tapes(Array(10).fill(.3)), 1002, 'a').state).toBe('shut')
})
it('indexed windows match scalar evidence with delayed, simultaneous and invalid publications', () => {
  const rows = tapes(Array.from({ length: 40 }, (_, i) => (i % 7 - 3) / 7))
  for (const tape of rows) tape.outcomes.forEach((r, i) => {
    r.available = 1001 + Math.floor(i / 3) * 100 + (i % 5 === 0 ? 700 : 0)
    r.launched = i % 4 === 0 ? 200 + i : 100 + i
    r.block = i % 4
  })
  rows[0]!.outcomes[35]!.token = rows[0]!.outcomes[1]!.token
  const policy = { ...CONSERVATIVE_GUARD, ageMs: 1500 }, indexed = new ScenarioEvidenceIndex(rows, policy)
  const scalarGuard = new ScenarioGuard(0, policy), indexedGuard = new ScenarioGuard(0, policy)
  for (const at of [0, 1001, 1101, 1701, 2201, 2901, 5000]) {
    const visible = rows.map(t => ({ ...t, complete: at < 4000, outcomes: t.outcomes.filter(r => r.available <= at) }))
    const fingerprint = () => JSON.stringify(visible)
    const a = prepareScenarioEvidence(visible, at, policy), b = indexed.prepare(at, () => at < 4000, fingerprint)
    expect({ ...b, fingerprint: b.fingerprint() }).toEqual({ ...a, fingerprint: a.fingerprint() })
    expect(indexedGuard.readPrepared(b, 'a')).toEqual(scalarGuard.read(visible, at, 'a'))
    expect(indexedGuard.snapshot()).toEqual(scalarGuard.snapshot())
  }
})
it('prepared evidence cannot be reused for a different window', () => {
  const evidence = prepareScenarioEvidence(tapes(Array(10).fill(.3)), 1001, CONSERVATIVE_GUARD)
  expect(() => new ScenarioGuard(0, BASELINE_GUARD).readPrepared(evidence, 'a')).toThrow('incompatible prepared')
})
it('counts new outcomes separately from six scenario deliveries and preserves the pause count', () => {
  const policy={...CONSERVATIVE_GUARD,id:'new-four',minNewOutcomes:4,off:0}
  const g=new ScenarioGuard(1000,policy)
  g.read(tapes(Array(10).fill(.3)),1001,'a')
  let rows=tapes(Array(10).fill(-.3),1002)
  expect(g.read(rows,1002,'a').state).toBe('shut')
  const restored=new ScenarioGuard(1000,policy);restored.restore(g.snapshot())
  for(let i=0;i<4;i++) {
    rows=rows.map(t=>({...t,outcomes:[...t.outcomes,{token:'new-'+i,block:11+i,launched:1003+i,available:1100+i,value:2}]}))
    expect(restored.read(rows,1100+i,'a').state).toBe(i===3?'open':'shut')
  }
})
it('requires new evidence after the cooldown and applies participation to uncapped wins',()=>{
  const p={...CONSERVATIVE_GUARD,id:'cool-part',cooldownMs:100,participation:.5}
  const g=new ScenarioGuard(1000,p);g.read(tapes(Array(10).fill(.3)),1001,'a')
  expect(g.read(tapes(Array(10).fill(-1),1002),1002,'a').state).toBe('shut')
  expect(g.read(tapes(Array(10).fill(1),1050),1050,'a').state).toBe('shut')
  expect(g.read(tapes(Array(10).fill(1),1050),1102,'a').state).toBe('shut')
  expect(g.read(tapes(Array(10).fill(1),1103),1103,'a').state).toBe('open')
})
it('matches indexed and scalar weighted/capped scores without changing native window scale',()=>{
  const p={...CONSERVATIVE_GUARD,id:'weighted-cap',halfLifeMs:1000,positiveCap:1}
  const rows=tapes(Array(10).fill(2)),index=new ScenarioEvidenceIndex(rows,p)
  const scalar=prepareScenarioEvidence(rows,1001,p),fast=index.prepare(1001,()=>true,()=>JSON.stringify(rows))
  expect(fast.scores).toEqual(scalar.scores)
  expect(scalar.scores[0]!.sum).toBeCloseTo(10)
  expect(scalar.scores[0]!.recentSum).toBeCloseTo(5)
  expect(()=>new ScenarioGuard(0,CONSERVATIVE_GUARD).readPrepared(scalar,'a')).toThrow('incompatible')
})
it('applies the fresh deterioration brake even while the main window stays positive',()=>{
  const p={...CONSERVATIVE_GUARD,id:'fresh-brake',freshBrake:-.5}
  const g=new ScenarioGuard(1000,p);g.read(tapes(Array(10).fill(1)),1001,'a')
  expect(g.read(tapes([...Array(5).fill(1),...Array(5).fill(-.2)],1002),1002,'a').reason).toBe('scenario_loss_brake')
})
