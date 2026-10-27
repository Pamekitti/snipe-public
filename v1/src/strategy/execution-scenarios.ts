import { predictExecution } from './counterfactual.js'
import type { ExecutionRequest, ExecutionResult, TimingModel } from './execution-model.js'

export const SCENARIO_VERSION = 'conservative-six-v1'
export const SCENARIO_IDS = ['p10-before', 'p10-after', 'p50-before', 'p50-after', 'p90-before', 'p90-after'] as const
export type ScenarioId = typeof SCENARIO_IDS[number]
export type ScenarioExecution = { id: ScenarioId; request: ExecutionRequest; result: ExecutionResult }
export type ExecutionBundle = {
  version: typeof SCENARIO_VERSION
  scenarios: ScenarioExecution[]
  complete: boolean
  closedThrough: number | null
  unavailable: Array<{ id: ScenarioId; reason: string }>
  publicationFloor?: number
}

/** Six stresses through one execution engine. They are not confidence bounds. */
export function replayScenarios(base: ExecutionRequest, timings: readonly TimingModel[]): ExecutionBundle {
  const scenarios: ScenarioExecution[] = []
  for (const percentile of [10, 50, 90]) {
    const found = timings.filter(t => t.label.startsWith(`preceding-p${percentile}`))
    if (found.length !== 1) throw new Error(`missing or duplicate p${percentile} timing`)
    const timing = found[0]!
    if (timing.frozenAt > base.entryAt || timing.fitThrough > base.entryAt || timing.n < 1) throw new Error('noncausal scenario calibration')
    for (const order of ['before', 'after'] as const) {
      const id = `p${percentile}-${order}` as ScenarioId
      const request = structuredClone(base)
      request.timing = { ...timing, kind: 'scenario', sameTimeOrder: order, label: `${SCENARIO_VERSION}:${id}` }
      request.openedAt = request.entryAt + timing.sendMs
      request.costs.approvalDelayMs = timing.confirmationMs
      request.logs = request.logs.map(log => log.observationSource === 'modeled'
        ? { ...log, observedAt: log.at + timing.observationMs } : log)
      scenarios.push({ id, request, result: predictExecution(request) })
    }
  }
  const unavailable = scenarios.filter(s => s.result.status === 'unavailable' || s.result.pnlWei === null || s.result.exitAt === null)
    .map(s => ({ id: s.id, reason: s.result.reason }))
  return { version: SCENARIO_VERSION, scenarios, complete: unavailable.length === 0,
    closedThrough: unavailable.length ? null : Math.max(...scenarios.map(s => s.result.exitAt!)), unavailable }
}

/**
 * The six scenarios differ in `timing` and in nothing else that is large. `replayScenarios`
 * clones the base request per scenario, so the log array is written six times, and the only
 * difference between the six copies is `observedAt` on logs whose `observationSource` is
 * `modeled`. That is the single line above, and it reads `log.at` plus the scenario's own
 * `timing.observationMs`, both of which survive in the stored base.
 *
 * Measured on the box 2026-09-15: `scenario_results` took 88.0 MB in six hours, 417 kB a row,
 * of which the six log arrays were about 99%. Storing the array once takes the table from
 * 352 MB/day to about 59.
 *
 * `expandBundle` returns its input unchanged when there is no bundle-level `logs`, so the 615
 * fat rows already on disk keep replaying. Nothing rewrites them: `scenario_results` carries
 * RAISE(ABORT) triggers on UPDATE and DELETE.
 */
export type StoredBundle = ExecutionBundle & { logs?: ExecutionRequest['logs'] }

const scenarioLogs = (base: ExecutionRequest['logs'], timing: TimingModel) =>
  base.map(log => log.observationSource === 'modeled' ? { ...log, observedAt: log.at + timing.observationMs } : log)

/** Hoist the log array to the bundle. `logs: []` stays in place so key order survives. */
export function compactBundle(bundle: ExecutionBundle): StoredBundle {
  const base = bundle.scenarios[0]?.request.logs
  if (!base) return bundle
  return { ...bundle, scenarios: bundle.scenarios.map(s => ({ ...s, request: { ...s.request, logs: [] } })), logs: base }
}

/** Rebuild each scenario's logs. A bundle without `logs` is already whole and is returned as is. */
export function expandBundle(stored: StoredBundle): ExecutionBundle {
  if (!Array.isArray(stored.logs)) return stored
  const { logs, ...rest } = stored
  return { ...rest, scenarios: rest.scenarios.map(s => ({ ...s, request: { ...s.request, logs: scenarioLogs(logs, s.request.timing) } })) }
}
