/** Offline verification of frozen publications. This command cannot activate trading. */
import Database from 'better-sqlite3'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { selectSharedTarget } from '../src/simulation/selector.js'
import { barKey } from '../src/strategy/takeprofit.js'
import { predictExecution } from '../src/strategy/counterfactual.js'
import { SCENARIO_IDS, expandBundle, type ExecutionBundle } from '../src/strategy/execution-scenarios.js'
import { MODEL_HASH } from '../src/simulation/identity.js'
import { digest, encode } from '../src/simulation/store.js'
import { buildScenarioObserver } from '../src/simulation/scenario-observer.js'
import type { GuardPolicy } from '../src/strategy/scenario-guard.js'

export function verifyScenarioPublications(db: Database.Database, lock: { at: number; configId: string; policy: GuardPolicy }, through: number) {
  const observer = buildScenarioObserver(db, through, lock.policy)
  const common = new Set(observer?.tapes[0]?.outcomes.map(o => o.token.toLowerCase()) ?? [])
  for (const tape of observer?.tapes ?? []) for (const token of common) if (!tape.outcomes.some(o => o.token.toLowerCase() === token)) common.delete(token)
  const rows = db.prepare(`SELECT s.id,s.evidence,s.bundle,s.at,s.available_at,c.payload FROM scenario_results s
    JOIN captures c ON s.id=c.session||':'||c.sequence WHERE s.model=? AND s.available_at<=? AND c.at>=? ORDER BY s.available_at,s.id`).all(MODEL_HASH, through, lock.at) as any[]
  const outcomes: Array<{ id: string; evidenceHash: string; entryAt: number; availableAt: number; closedThrough: number }> = []
  const failures: Array<{ id: string; reason: string }> = []
  for (const row of rows) {
    // Since 2026-09-15 the stored bundle keeps one log array instead of six clones. expandBundle
    // rebuilds each scenario's array from it, and returns a pre-2026-09-15 row untouched, so the
    // replay below sees exactly what it always saw.
    const bundle: ExecutionBundle = expandBundle(JSON.parse(row.bundle)), capture = JSON.parse(row.payload)
    if (digest(capture.config) !== lock.configId || !common.has(bundle.scenarios[0]?.request.token.toLowerCase() ?? '')) continue
    const fail = (reason: string) => failures.push({ id: row.id, reason })
    if (!bundle.complete || bundle.scenarios.length !== 6 || SCENARIO_IDS.some(id => bundle.scenarios.filter(s => s.id === id).length !== 1)) { fail('incomplete_bundle'); continue }
    if (row.available_at <= bundle.closedThrough! || row.available_at <= row.at || bundle.publicationFloor === undefined || row.at < bundle.publicationFloor) { fail('publication_order'); continue }
    const before = failures.length
    for (const s of bundle.scenarios) {
      if (s.request.provenance.kind !== 'prospective' || s.request.entryAt < lock.at) fail('not_new_prospective_inputs')
      if (!s.request.coverage.complete || !s.request.coverage.independentlyChecked || s.request.coverage.gaps.length) fail('incomplete_source_coverage')
      for (const log of s.request.logs) {
        const saved = db.prepare("SELECT value FROM checkpoints WHERE name=?").get('verified-header:' + log.order.block) as { value: string } | undefined
        const header = saved ? JSON.parse(saved.value) : null
        if (!header || header.hash !== (log as any).blockHash || header.timestamp * 1000 !== log.at) { fail('missing_or_mismatched_header'); break }
      }
      if (encode(predictExecution(s.request)) !== encode(s.result)) fail('calculation_mismatch:' + s.id)
    }
    const targetsRow = db.prepare('SELECT payload,available_at FROM selector_results WHERE id=? AND model=?').get(row.id,MODEL_HASH) as {payload:string;available_at:number|null}|undefined
    const targets = targetsRow ? JSON.parse(targetsRow.payload) : null
    const keys = capture.config.targetPolicy.adaptive.bars.map(barKey)
    if (!targets?.complete || targetsRow?.available_at === null || !targetsRow || targetsRow.available_at! <= targets.closedThrough) fail('target_publication_unavailable')
    else for (const key of keys) {
      const target = targets.results[key] as ExecutionBundle['scenarios']|undefined
      if (!target || target.length !== 6 || target.some(s=>s.result.status==='unavailable'||s.result.pnlWei===null||s.result.exitAt===null||targetsRow!.available_at!<=s.result.exitAt) || SCENARIO_IDS.some(id=>target.filter(s=>s.id===id).length!==1)) { fail('target_bundle_missing'); continue }
      for (const s of target) {
        const request={...bundle.scenarios.find(b=>b.id===s.id)!.request,takeProfit:Number(key)}
        if (encode(predictExecution(request)) !== encode(s.result)) fail('target_calculation_mismatch')
      }
      const score = Number(target.find(s=>s.id==='p50-after')!.result.pnlWei)/Number(capture.sizeWei)
      if (targets.scores[key] !== score) fail('target_score_mismatch')
    }
    const selected = selectSharedTarget(capture.selector,lock.configId,bundle.scenarios[0]!.request.entryAt,capture.selectorHeartbeatAt??0,capture.config.targetPolicy)
    if(!selected.ready)fail('selector_not_ready_at_entry')
    if (selected.ready) {
      const snapshot=capture.selector
      if (!Array.isArray(snapshot.evidenceIds) || snapshot.evidenceIds.length!==snapshot.rows.length) fail('selector_evidence_missing')
      else snapshot.evidenceIds.forEach((id:string,index:number)=>{
        const prior=db.prepare('SELECT config,payload,available_at FROM selector_results WHERE id=? AND model=?').get(id,MODEL_HASH) as any
        if (!prior || prior.config!==lock.configId || prior.available_at===null || prior.available_at>snapshot.at || encode(JSON.parse(prior.payload).scores)!==encode(snapshot.rows[index])) fail('selector_evidence_mismatch')
      })
    }
    if (bundle.scenarios.some(s=>s.request.takeProfit!==selected.multiple)) fail('selector_pin_mismatch')
    if (failures.length === before) outcomes.push({ id: row.id, evidenceHash: row.evidence, entryAt: bundle.scenarios[0]!.request.entryAt,
      availableAt: row.available_at, closedThrough: bundle.closedThrough! })
  }
  return { modelHash: MODEL_HASH, configId: lock.configId, policyId: lock.policy.id, policy:lock.policy, lockedAt: lock.at, through, outcomes, failures,
    independentReplayPassed: outcomes.length >= 20 && !failures.length,
    sourceCoverageComplete: observer?.complete === true && outcomes.length >= 20 && !failures.length,
    publicationOrderingPassed: outcomes.length >= 20 && !failures.some(f => f.reason === 'publication_order'),
    targetReplayPassed: outcomes.length >= 20 && !failures.some(f=>f.reason.startsWith('target_')),
    selectorPinnedPassed: outcomes.length >= 20 && !failures.some(f=>f.reason.startsWith('selector_')),
    prospectiveAccuracyPassed: false, status: 'shadow_calculation_check_only', liveChanges: false }
}
if (process.argv[1]?.endsWith('verify-execution-scenarios.ts')) {
  const [database, lockFile, output] = process.argv.slice(2)
  if (!database || !lockFile || !output) throw new Error('Usage: verify-execution-scenarios.ts DATABASE LOCK_JSON OUTPUT_JSON')
  const bytes = readFileSync(lockFile), lock = JSON.parse(bytes.toString())
  const db = new Database(database, { readonly: true, fileMustExist: true })
  try {
    const result = verifyScenarioPublications(db, lock, Date.now())
    if(lock.actualFidelity){
      const actualBytes=readFileSync(resolve(dirname(lockFile),lock.actualFidelity.path))
      if(createHash('sha256').update(actualBytes).digest('hex')!==lock.actualFidelity.sha256)throw new Error('actual fidelity hash mismatch')
      const actual=JSON.parse(actualBytes.toString())
      result.prospectiveAccuracyPassed=actual.modelHash===MODEL_HASH&&actual.fromMs>=lock.at&&actual.verdict?.historical_fidelity_passed===true
    }
    writeFileSync(output, JSON.stringify({ ...result, actualFidelity:lock.actualFidelity??null, lockSha256: createHash('sha256').update(bytes).digest('hex') }, null, 2), { flag: 'wx' })
    process.stdout.write(JSON.stringify({ outcomes: result.outcomes.length, failures: result.failures.length, status: result.status }) + '\n')
    process.exitCode = result.independentReplayPassed && result.sourceCoverageComplete && result.publicationOrderingPassed ? 0 : 2
  } finally { db.close() }
}
