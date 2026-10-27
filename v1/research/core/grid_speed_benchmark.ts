/** Offline performance and parity benchmark. Load fixtures are not policy evidence. */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { isDeepStrictEqual } from 'node:util'
import { prepareScenarioAccounts, replayScenarioAccounts, compactScenarioAccountResult, type ScenarioAccountInput } from '../../src/strategy/scenario-account.js'
import { CONSERVATIVE_GUARD, type GuardPolicy } from '../../src/strategy/scenario-guard.js'
import { SCENARIO_IDS, SCENARIO_VERSION } from '../../src/strategy/execution-scenarios.js'
import { predictExecution } from '../../src/strategy/counterfactual.js'
import { EXECUTION_VERSION, type ExecutionRequest } from '../../src/strategy/execution-model.js'

const root = resolve(process.argv[2]!), action = process.argv[3] ?? 'prepare'
const base = resolve('data/research/20260913-both-periods-v1')
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const write = (name: string, value: unknown) => writeFileSync(resolve(root, name), JSON.stringify(value, null, 2))
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex')
export function candidates(): GuardPolicy[] {
  const result: GuardPolicy[] = []
  for (const n of [8, 10, 12, 15, 20, 30]) for (const m of [3, 5, 8]) {
    if (m >= n) continue
    for (const age of [30, 60, 120, 180]) for (const off of [-2.5, -2, -1.5, -1, -.5, 0]) {
      for (const freshOn of [.5, 1, 1.5, 2]) {
        result.push({ id: `fresh-${result.length}`, n, m, off, freshOn, fullOn: 2, ageMs: age * 60000, mode: 'fresh' })
        for (const fullOn of [1, 2, 3]) result.push({ id: `both-${result.length}`, n, m, off, freshOn, fullOn, ageMs: age * 60000, mode: 'both' })
      }
    }
  }
  for (const n of [8, 10, 12, 15, 20, 30]) for (const age of [30, 60, 120, 180])
    for (const off of [-2.5, -2, -1.5, -1, -.5, 0]) for (const fullOn of [1, 2, 3])
      result.push({ id: `full-${result.length}`, n, m: 3, off, freshOn: 1, fullOn, ageMs: age * 60000, mode: 'full' })
  return result
}
function workload(count: number): ScenarioAccountInput {
  const rows = read(resolve(base, 'rows.json')), requests: ExecutionRequest[] = read(resolve(base, 'requests.json'))
  const simulations = [600, 1200, 2000].flatMap(sell => ['before', 'after'].map(order =>
    read(resolve(base, `results/q5000-rank0.5-sell${sell}-${order}.json`)).results))
  const known = rows.map((_: unknown, i: number) => i).filter((i: number) => simulations.every(v => v[i].pnlWei !== null && v[i].exitAt !== null))
  const config = { entry: { minCreatorTaxBps: 50, maxCreatorTaxBps: 200, minExemptionsToEnter: 3, templateLossBlockMs: 60000, tradeSizeEth: .02 },
    bankrollWei: '200000000000000000', maxConcurrent: 3, maxDrawdownWei: '60000000000000000', entryHours: [] }
  const start = 1788220800000, through = 1789313400000, spacing = (through - start - 180000) / count
  const opportunities = Array.from({ length: count }, (_, i) => {
    const k = known[(i * 193) % known.length]!, q = requests[k]!, at = Math.floor(start + 1000 + i * spacing)
    const availableAt = at + 60001, size = 20000000000000000n
    return { id: String(i), token: `load-${i}`, template: `template-${i % 500}`, sequence: i,
      at, block: i + 1, launched: at - 1000, availableAt, configId: 'load', config,
      creatorTaxBps: '100', exemptions: 3, sizeWei: String(size), bundle: {
        version: SCENARIO_VERSION as typeof SCENARIO_VERSION, complete: true, closedThrough: at + 60000, unavailable: [],
        scenarios: SCENARIO_IDS.map((id, scenario) => {
          const r = simulations[scenario][k]
          return { id, request: { coverage: q.coverage } as ExecutionRequest,
            result: { ...r, trace: [], scenario: id, entryAt: at,
              decisionAt: at + Math.max(0, Math.min(57000, (r.decisionAt ?? q.entryAt) - q.entryAt)),
              exitAt: at + Math.max(1, Math.min(59000, r.exitAt - q.entryAt)),
              spentWei: String(size), pnlWei: String(BigInt(r.pnlWei) * size / BigInt(q.sizeWei)) } }
        }) } }
  })
  // Repeated account resets keep the load test from becoming a trivial permanent pause.
  const controls = Array.from({ length: 12 * 6 }, (_, i) => ({ kind: 'control' as const, id: `load-reset-${i}`,
    at: start + (i + 1) * 4 * 3600000, sequence: 0, strategyVersion: EXECUTION_VERSION, resetDrawdown: true }))
  return { start, through, initialKnown: true, config, opportunities, controls, policy: CONSERVATIVE_GUARD }
}

if (action === 'prepare') {
  const policies = candidates()
  if (policies.length !== 6960) throw new Error('candidate count mismatch')
  write('policies.json', policies)
  for (const count of [1000, 5000, 25272]) write(`load-${count}.json`, workload(count))
  write('benchmark-protocol.json', { kind: 'performance-only', representativeCounts: [1000, 5000, 25272],
    source: base, generatedFrom: 'recorded simulation outputs, rescheduled and resized for load; not historical account reconstruction',
    candidateCount: policies.length, inputHashes: Object.fromEntries([1000, 5000, 25272].map(n => [n, hash(read(resolve(root, `load-${n}.json`)))])),
    policyHash: hash(policies), rankings: false, liveChanges: false })
  console.log(JSON.stringify({ prepared: true, policies: policies.length }))
} else if (action === 'parity') {
  const old = await import(pathToFileURL(resolve(root, 'before/src/strategy/scenario-account.ts')).href)
  const input = read(resolve(root, 'load-1000.json')) as ScenarioAccountInput
  const policies = candidates(), sample = [CONSERVATIVE_GUARD, ...Array.from({ length: 12 }, (_, i) => policies[Math.floor(i * policies.length / 12)]!)]
  const baselineTimes: number[] = [], optimizedTimes: number[] = [], prepared = prepareScenarioAccounts(input)
  let checks = 0
  for (const policy of sample) {
    let t = performance.now(); const expected = old.replayScenarioAccounts({ ...input, policy }); baselineTimes.push(performance.now() - t)
    t = performance.now(); const actual = prepared.replay(policy); optimizedTimes.push(performance.now() - t)
    if (!isDeepStrictEqual(actual, expected)) {
      write('parity-mismatch.json', { policy, actual, expected }); throw new Error('exact account parity failed')
    }
    checks++; write('parity-progress.json', { checks, total: sample.length, at: Date.now() })
  }
  const result = { fullAccountComparisons: checks, mismatch: 0, baselineTimes, optimizedTimes, stats: prepared.stats }
  write('parity.json', result); console.log(JSON.stringify(result))
} else if (action === 'pilot') {
  const count = Number(process.argv[4] ?? 25272), budgetMs = Number(process.argv[5] ?? 900000)
  const input = read(resolve(root, `load-${count}.json`)) as ScenarioAccountInput, policies = candidates()
  const groups = new Map<string, GuardPolicy[]>()
  for (const p of policies) { const k = `${p.n}-${p.m}-${p.ageMs}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(p) }
  // Interleave different windows and threshold settings; do not choose profitable outcomes.
  const ordered = [...groups.values()].sort((a, b) => (a[0]!.n * 31 + a[0]!.m * 17 + a[0]!.ageMs / 60000) % 97 - (b[0]!.n * 31 + b[0]!.m * 17 + b[0]!.ageMs / 60000) % 97)
  const started = performance.now(), prepared = prepareScenarioAccounts(input), preparationMs = performance.now() - started
  const observations: Array<{ policy: string; n: number; m: number; ageMs: number; ms: number; coldGroup: boolean }> = []
  let digest = createHash('sha256')
  let groupCount = 0
  outer: for (const group of ordered) {
    groupCount++
    for (let i = 0; i < group.length; i++) {
      const p = group[i]!, t = performance.now(), result = prepared.replay(p)
      observations.push({ policy: p.id, n: p.n, m: p.m, ageMs: p.ageMs, ms: performance.now() - t, coldGroup: i === 0 })
      digest.update(JSON.stringify(compactScenarioAccountResult(result)))
      if (observations.length % 10 === 0 || performance.now() - started >= budgetMs)
        write(`pilot-${count}-progress.json`, { policies: observations.length, total: policies.length, groups: groupCount,
          elapsedMs: performance.now() - started, heartbeat: Date.now(), stats: prepared.stats })
      if (performance.now() - started >= budgetMs) break outer
    }
  }
  const result = { count, preparationMs, elapsedMs: performance.now() - started, measuredPolicies: observations.length,
    totalPolicies: policies.length, groupsMeasured: groupCount, totalGroups: groups.size, stats: prepared.stats,
    observations, digest: digest.digest('hex'), peakRssBytes: process.resourceUsage().maxRSS * 1024, diagnosticLoadOnly: true }
  write(`pilot-${count}.json`, result); console.log(JSON.stringify({ ...result, observations: undefined }))
} else if (action === 'execution') {
  const requests: ExecutionRequest[] = read(resolve(base, 'requests.json')), observations: unknown[] = []
  let digest = createHash('sha256')
  for (let batch = 0; batch < 12; batch++) {
    const selected = Array.from({ length: 100 }, (_, i) => requests[(batch * 100 + i) % requests.length]!)
    const t = performance.now(); let attempts = 0
    for (const q of selected) for (const hold of [20, 35, 45, 60]) for (const target of [1.25, 1.75, 3]) {
      const v = predictExecution({ ...q, takeProfit: target, rules: { ...q.rules, maxHoldMs: hold * 1000 } })
      digest.update(JSON.stringify(v)); attempts++
    }
    observations.push({ attempts, elapsedMs: performance.now() - t })
    write('execution-progress.json', { batches: batch + 1, total: 12, heartbeat: Date.now() })
  }
  write('execution-benchmark.json', { observations, digest: digest.digest('hex'), actualFrozenInputs: true, policyEvidence: false })
  console.log(JSON.stringify({ batches: 12, attempts: 14400 }))
} else throw new Error('unknown benchmark action')
