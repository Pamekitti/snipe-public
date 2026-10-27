import { expect, it } from 'vitest'
import { matchPredictions, buildSimulationReport, simulationReport } from '../src/simulation/reporting.js'
import { SimulationStore,digest } from '../src/simulation/store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODEL_HASH } from '../src/simulation/identity.js'
import { buildScenarioObserver } from '../src/simulation/scenario-observer.js'

const fresh = () => ({ points: [], health: { stalled: false, fault: null }, monthToDate: 1, coverage: { complete: true } })

it('starts a new model account without erasing history and retains same-model restart evidence', () => {
  const store = new SimulationStore(':memory:')
  try {
    store.append([{ session: 'old-model', sequence: 1, at: 1, kind: 'opportunity', key: 'old', provenance: 'prospective', payload: {} }])
    expect(buildScenarioObserver(store.db, 2000)).toBeNull()
    const config={ entry: { tradeSizeEth: 1e-16, minCreatorTaxBps: 50, maxCreatorTaxBps: 10000, minExemptionsToEnter: 3, templateLossBlockMs: 0 }, bankrollWei: '1000', maxConcurrent: 3,
      targetPolicy:{adaptive:{window:1,bars:[1.75]},otherwise:1.75,maxRateAgeMs:300000} }
    const payload = { launch: { block: 1, exemptions: 3 }, params: { creatorTaxBps: '100', launchedAt: '0' }, sizeWei: '100',config,
      takeProfit:{multiple:1.75,ready:true},selectorHeartbeatAt:900,
      selector:{modelHash:MODEL_HASH,configId:digest(config),at:900,complete:true,rows:[{'1.75':1}],evidenceIds:['prior'],failure:null} }
    store.append(['first', 'restart'].map((session, index) => ({ session: session + ':' + MODEL_HASH, sequence: 1, at: 1000 + index * 100,
      kind: 'opportunity', key: session, payload, provenance: 'prospective' as const })))
    const reading = buildScenarioObserver(store.db, 2000)!
    expect(reading.recordFrom).toBe(1000)
    expect(reading.pending).toBe(2)
    expect(reading.complete).toBe(false)
    expect(store.db.prepare('SELECT count(*) n FROM captures').get()).toEqual({ n: 3 })
  } finally { store.close() }
})

it('recognizes a receipt-reverted buy despite successful submission', () => {
  const actual = [{ id: 1, token: 'a', spend_wei: '100', onchain_pnl_wei: '-2', pnl_wei: '-2', buy_ok: 1, exit_reason: 'buy-reverted' }]
  const result = matchPredictions(actual, [{ token: 'a', result: { status: 'buy_reverted', pnlWei: '-2', tokens: '0' } }])
  expect(result.failedBuy).toEqual({ n: 1, agreed: 1 })
  expect(matchPredictions([{ ...actual[0]!, exit_reason: 'buy-never-mined' }], [{ token: 'a', result: { status: 'buy_reverted', pnlWei: '-2' } }]).failedBuy.agreed).toBe(0)
})
it('does not consume a result published after the requested report cutoff', () => {
  const directory = mkdtempSync(join(tmpdir(), 'simulation-cutoff-')), path = join(directory, 'sim.db')
  const store = new SimulationStore(path)
  try {
    store.append([{ session: 's', sequence: 1, at: 1000, kind: 'opportunity', key: 'a', provenance: 'reconstruction', payload: {
      launch: { block: 1, exemptions: 3 }, params: { creatorTaxBps: '100', launchedAt: '0' }, sizeWei: '100',
      config: { entry: { tradeSizeEth: 1e-16, minCreatorTaxBps: 50, maxCreatorTaxBps: 10000, minExemptionsToEnter: 3, templateLossBlockMs: 0 }, bankrollWei: '1000', maxConcurrent: 3 }
    } }])
    store.saveResult('s:1', {}, { status: 'closed', exitAt: 1100, pnlWei: '-5' }, 2000, 'reconstruction')
    store.checkpoint('writer', { at: 1500 })
    const report = buildSimulationReport(path, 0, 1500)
    expect(report.policy.pending).toBe(1)
    expect(report.comparison.matched).toBe(0)
  } finally { store.close(); rmSync(directory, { recursive: true }) }
})

it('measures staleness by the worker heartbeat, not by when the report was last rebuilt', () => {
  const directory = mkdtempSync(join(tmpdir(), 'simulation-heartbeat-')), path = join(directory, 'sim.db')
  const store = new SimulationStore(path)
  try {
    const now = Date.now()
    // A report built five minutes ago is still current when nothing has been captured since.
    // Before 2026-09-14 the rebuild WAS the heartbeat, so this shape could not occur; now a
    // quiet hour is the normal case and must not read as a dead worker.
    store.checkpoint('report', { at: now - 300_000, report: { validation: { modelHash: MODEL_HASH },
      policy: fresh(), continuous: fresh(), marketOff: fresh(), candidate: fresh(),
      scenarioObserver: { at: now - 300_000 }, candidateIndicator: {} } })
    store.checkpoint('writer', { at: now - 1_000, clean: false, reportAt: now - 300_000 })
    const live = simulationReport(path, 0, now)
    expect(live.policy.health.stalled).toBe(false)
    expect(live.scenarioObserver).not.toBeNull()

    store.checkpoint('writer', { at: now - 20_000, clean: false, reportAt: now - 300_000 })
    const stale = simulationReport(path, 0, now)
    expect(stale.policy.health.stalled).toBe(true)
    expect(stale.policy.health.fault).toBe('paper worker heartbeat stale')
    expect(stale.scenarioObserver).toBeNull()
    expect(stale.candidateIndicator.reason).toBe('paper_worker_stale')
  } finally { store.close(); rmSync(directory, { recursive: true }) }
})
