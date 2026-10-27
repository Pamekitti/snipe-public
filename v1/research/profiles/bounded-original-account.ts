import { EXECUTION_VERSION } from '../../src/strategy/execution-model.js'
import { SCENARIO_IDS, type ExecutionBundle, type ScenarioId } from '../../src/strategy/execution-scenarios.js'
import { initialAccount, reduceAccount, type AccountConfig, type AccountEvent, type AccountRun } from '../../src/strategy/paper-account.js'
import { ScenarioGuard, ScenarioEvidenceIndex, type GuardPolicy, type ScenarioTape, type PreparedScenarioEvidence } from '../../src/strategy/scenario-guard.js'
import { pickEntry } from '../../src/strategy/entry.js'

export type ScenarioOpportunity = {
  id: string; at: number; sequence: number; configId: string; config: AccountConfig
  token: string; template: string; creatorTaxBps: string; exemptions: number | null
  sizeWei: string; block: number; launched: number; availableAt: number; bundle: ExecutionBundle
}
export type ScenarioControl = Extract<AccountEvent, { kind: 'control' | 'gap' }>
export type ScenarioAccountInput = {
  start: number; through: number; initialKnown: boolean; config: AccountConfig; policy: GuardPolicy
  opportunities: ScenarioOpportunity[]; controls: ScenarioControl[]; checks?: number[]
}

const metrics = (run: AccountRun) => {
  let previous = 0n, profit = 0n, loss = 0n, wins = 0, losses = 0
  const cash = run.cash.map(point => {
    const pnl = BigInt(point.cashWei) - previous; previous = BigInt(point.cashWei)
    if (pnl > 0n) { profit += pnl; wins++ }
    else if (pnl < 0n) { loss -= pnl; losses++ }
    return { id: point.id, at: point.t, pnlWei: String(pnl) }
  })
  return { cash, netWei: run.state.cashWei, drawdownWei: run.state.drawdownWei,
    wins, losses, profitWei: String(profit), lossWei: String(loss),
    complete: run.state.initialKnown && run.state.unknown.length === 0, unavailable: run.state.unknown }
}
export function retention(selected: ReturnType<typeof metrics>, reference: ReturnType<typeof metrics>) {
  if(!selected.complete||!reference.complete)return {winsRetained:null,lossesRetained:null,winningMoneyRetained:null,losingMoneyRetained:null,profitMissedWei:null,lossesAvoidedWei:null}
  const ratio = (a: number | string, b: number | string) => Number(b) === 0 ? null : Number(a) / Number(b)
  return { winsRetained: ratio(selected.wins, reference.wins), lossesRetained: ratio(selected.losses, reference.losses),
    winningMoneyRetained: ratio(selected.profitWei, reference.profitWei), losingMoneyRetained: ratio(selected.lossWei, reference.lossWei),
    profitMissedWei: String(BigInt(reference.profitWei) - BigInt(selected.profitWei)),
    lossesAvoidedWei: String(BigInt(reference.lossWei) - BigInt(selected.lossWei)) }
}

/** One account reducer and one decision schedule for offline research and the observer. */
export function prepareScenarioAccounts(input: Omit<ScenarioAccountInput, 'policy'>) {
  input = structuredClone(input)
  const configs = new Map<string, AccountConfig>()
  const canonicalConfig = (config: AccountConfig) => {
    const key = JSON.stringify(config)
    if (!configs.has(key)) configs.set(key, config)
    return configs.get(key)!
  }
  input.config = canonicalConfig(input.config)
  for (const o of input.opportunities) o.config = canonicalConfig(o.config)
  for (const c of input.controls) if (c.kind === 'control' && c.config) c.config = canonicalConfig(c.config)
  const opportunities = [...input.opportunities].sort((a, b) => a.at - b.at || a.sequence - b.sequence || a.id.localeCompare(b.id))
  if (new Set(opportunities.map(o => o.id)).size !== opportunities.length) throw new Error('duplicate scenario opportunity')
  if (opportunities.some(o => o.at < input.start || !Number.isFinite(o.availableAt) || o.availableAt <= o.at || o.availableAt < (o.bundle.closedThrough ?? o.at))) throw new Error('invalid scenario account chronology')
  const metadata = new Map(opportunities.map(o => [o.token.toLowerCase(), o]))
  const makeEvents = (id: ScenarioId): AccountEvent[] => [
    ...input.controls.map(c => c.kind === 'control' ? { ...c, marketPaused: undefined } : c),
    ...opportunities.flatMap(o => {
      const execution = o.bundle.scenarios.find(s => s.id === id)
      if (!execution) throw new Error('missing account scenario')
      return [
        { kind: 'control' as const, id: o.id + ':config', at: o.at, sequence: o.sequence * 2, strategyVersion: EXECUTION_VERSION, config: o.config },
        { kind: 'opportunity' as const, id: o.id, at: o.at, sequence: o.sequence * 2 + 1, strategyVersion: EXECUTION_VERSION,
          token: o.token, template: o.template, creatorTaxBps: o.creatorTaxBps, exemptions: o.exemptions,
          sizeWei: o.sizeWei, result: execution.result, availableAt: o.availableAt, block: o.block, launched: o.launched,
          checked: execution.request.coverage.complete && execution.request.coverage.independentlyChecked && !execution.request.coverage.gaps.length },
      ]
    }),
  ]
  const eventCache = new Map(SCENARIO_IDS.map(id => [id, makeEvents(id)]))
  const eventsFor = (id: ScenarioId) => eventCache.get(id)!
  const continuous = SCENARIO_IDS.map(id => {
    const run = reduceAccount(initialAccount('continuous', EXECUTION_VERSION, input.start, input.config, input.initialKnown), eventsFor(id), input.through)
    return { id, run, metrics: metrics(run) }
  })
  const incompleteAt = new Map(continuous.map(s => {
    const admitted = new Set(s.run.decisions.filter(d => d.allow).map(d => d.id))
    const faults = opportunities.filter(o => {
      const e = o.bundle.scenarios.find(e => e.id === s.id)!
      return admitted.has(o.id) && (e.result.status === 'unavailable' || e.result.pnlWei === null || !e.request.coverage.independentlyChecked || !e.request.coverage.complete || e.request.coverage.gaps.length > 0)
    }).map(o => o.availableAt)
    return [s.id, Math.min(...faults, ...input.controls.filter(c => c.kind === 'gap').map(c => c.at))]
  }))
  const tapesAt = (at: number, configId: string): ScenarioTape[] => continuous.map(s => ({ id: s.id,
    complete: s.run.state.initialKnown && at < incompleteAt.get(s.id)!,
    outcomes: s.run.state.outcomes.filter(o => o.available <= at && metadata.get(o.token.toLowerCase())?.configId === configId),
  }))
  const references = new Map(SCENARIO_IDS.map(id => {
    const run = reduceAccount(initialAccount('market-off', EXECUTION_VERSION, input.start, input.config, input.initialKnown), eventsFor(id), input.through)
    // These opportunities have no account capacity, cooldown or stop.
    const unrestricted: Array<{ id: string; at: number; pnlWei: string }> = [], unrestrictedUnavailable: string[] = []
    for (const o of opportunities) {
      if ('reject' in pickEntry({ creatorTaxBps: BigInt(o.creatorTaxBps), exemptions: o.exemptions }, o.config.entry)) continue
      const result = o.bundle.scenarios.find(s => s.id === id)!.result
      if (result.pnlWei !== null && result.exitAt !== null && result.exitAt <= input.through)
        unrestricted.push({ id: o.id, at: result.exitAt, pnlWei: result.pnlWei })
      else unrestrictedUnavailable.push(o.id)
    }
    return [id, { run, metrics: metrics(run), unrestricted, unrestrictedUnavailable }]
  }))
  const stats = { preparations: 1, evidencePlans: 0, selectedAccountReplays: 0, selectedCacheHits: 0 }
  let planKey = ''
  let plan: Array<{ evidence: PreparedScenarioEvidence; configId: string }> = []
  const accountCache = new Map<string, ReturnType<typeof replayAccounts>>()
  const replay = (policy: GuardPolicy) => {
    const key = JSON.stringify([policy.n, policy.m, policy.ageMs, policy.halfLifeMs, policy.positiveCap])
    if (key !== planKey) {
      planKey = key; plan = []; accountCache.clear(); stats.evidencePlans++
      const times = new Set<number>([...opportunities.map(o => o.at), ...input.controls.map(c => c.at), ...(input.checks ?? []), input.through])
      for (const s of continuous) for (const o of s.run.state.outcomes) {
        times.add(o.available); times.add(o.launched + policy.ageMs + 1)
      }
      const indexes = new Map<string, ScenarioEvidenceIndex>()
      let configId = opportunities[0]?.configId ?? '', index = 0
      for (const at of [...times].filter(at => at >= input.start && at <= input.through).sort((a, b) => a - b)) {
        while (index < opportunities.length && opportunities[index]!.at <= at) configId = opportunities[index++]!.configId
        const frozenConfig = configId
        if (!indexes.has(configId)) indexes.set(configId, new ScenarioEvidenceIndex(continuous.map(s => ({ id: s.id,
          complete: s.run.state.initialKnown, outcomes: s.run.state.outcomes.filter(o => metadata.get(o.token.toLowerCase())?.configId === configId) })), policy))
        plan.push({ configId, evidence: indexes.get(configId)!.prepare(at, id => at < incompleteAt.get(id)!,
          () => JSON.stringify(tapesAt(at, frozenConfig))) })
      }
    }
    const guard = new ScenarioGuard(input.start, policy)
    const readings = plan.map(p => guard.readPrepared(p.evidence, p.configId))
    const permissionKey = readings.map(r => r.state === 'open' ? '1' : '0').join('')
    let accounts = accountCache.get(permissionKey)
    if (accounts) stats.selectedCacheHits++
    else {
      const marketControls: AccountEvent[] = readings.map(r => ({ kind: 'control', id: 'scenario-check:' + r.at, at: r.at,
        sequence: -1, strategyVersion: EXECUTION_VERSION, marketPaused: r.state !== 'open' }))
      accounts = replayAccounts(readings, marketControls)
      if (accountCache.size >= 8) accountCache.delete(accountCache.keys().next().value!)
      accountCache.set(permissionKey, accounts)
    }
    const configId = plan.at(-1)?.configId ?? opportunities[0]?.configId ?? ''
    return { continuous, accounts, get tapes() { return tapesAt(input.through, configId) },
      reading: readings.at(-1)!, readings, get checkpoint() { return guard.snapshot() } }
  }
  function replayAccounts(readings: ReturnType<ScenarioGuard['read']>[], marketControls: AccountEvent[]) {
  const accounts = SCENARIO_IDS.map(id => {
    const events = eventsFor(id)
    const policy = reduceAccount(initialAccount('policy', EXECUTION_VERSION, input.start, input.config, input.initialKnown), [...events, ...marketControls], input.through)
    stats.selectedAccountReplays++
    const saved = references.get(id)!
    const marketOff = saved.run
    const selected = metrics(policy), reference = saved.metrics
    const { unrestricted, unrestrictedUnavailable } = saved
    let episode = 0, previous = 'shut', point = 0
    const recoveries = new Map<number, { at: number; netWei: bigint; lossesWei: bigint; trades: number }>()
    const admittedEpisode = new Map<string, number>()
    for (const d of policy.decisions) {
      while (point < readings.length && readings[point]!.at <= d.at) {
        const reading = readings[point++]!
        if (reading.state === 'open' && previous === 'shut') recoveries.set(++episode, { at: reading.at, netWei: 0n, lossesWei: 0n, trades: 0 })
        previous = reading.state
      }
      if (d.allow) admittedEpisode.set(d.id, episode)
    }
    for (const c of selected.cash) {
      const recovery = recoveries.get(admittedEpisode.get(c.id) ?? -1)
      if (recovery) { const pnl = BigInt(c.pnlWei); recovery.netWei += pnl; recovery.lossesWei += pnl < 0n ? -pnl : 0n; recovery.trades++ }
    }
    return { id, policy, marketOff, selected, reference, retention: retention(selected, reference), unrestricted, unrestrictedUnavailable,
      losingRecoveries: [...recoveries.values()].filter(r => r.netWei < 0n).length,
      recoveryLossWei: String([...recoveries.values()].reduce((sum, r) => sum + (r.netWei < 0n ? -r.netWei : 0n), 0n)),
      recoveries: [...recoveries.values()].map(r => ({ ...r, netWei: String(r.netWei), lossesWei: String(r.lossesWei) })) }
  })
    return accounts
  }
  return { replay, stats }
}

/** Single-policy callers retain the historical interface and full result. */
export function replayScenarioAccounts(input: ScenarioAccountInput) {
  return prepareScenarioAccounts(input).replay(input.policy)
}

/** Group equal evidence windows without changing caller order. Results keep only
 * scorecards; full account lines are replayed on demand for selected candidates. */
export function replayScenarioAccountGrid(input: Omit<ScenarioAccountInput, 'policy'>, policies: GuardPolicy[]) {
  const prepared = prepareScenarioAccounts(input)
  const groups = new Map<string, Array<{ policy: GuardPolicy; index: number }>>()
  policies.forEach((policy, index) => {
    const key = JSON.stringify([policy.n, policy.m, policy.ageMs, policy.halfLifeMs, policy.positiveCap])
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push({ policy, index })
  })
  const results: Array<ReturnType<typeof compactScenarioAccountResult>> = []
  for (const group of groups.values()) for (const { policy, index } of group)
    results[index] = compactScenarioAccountResult(prepared.replay(policy))
  return { results, stats: prepared.stats }
}

export function compactScenarioAccountResult(run: ReturnType<typeof replayScenarioAccounts>) {
  return { policy: run.reading?.policy, scenarios: run.accounts.map(a => {
    const { cash: selectedCash, ...selected } = a.selected
    const { cash: referenceCash, ...reference } = a.reference
    return { id: a.id, selected, reference, retention: a.retention, losingRecoveries: a.losingRecoveries, recoveryLossWei: a.recoveryLossWei }
  }) }
}
