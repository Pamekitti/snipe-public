import { drawdownHistory } from './drawdown-history.js'
import type Database from 'better-sqlite3'
import { digest } from './store.js'
import { MODEL_HASH } from './identity.js'
import { EXECUTION_VERSION } from '../strategy/execution-model.js'
import { replayScenarioAccounts, type ScenarioOpportunity, type ScenarioControl } from '../strategy/scenario-account.js'
import { SELECTED_GUARD, type GuardPolicy } from '../strategy/scenario-guard.js'
import { pickEntry } from '../strategy/entry.js'
import { capturedTarget } from './selector.js'
import type { AccountConfig } from '../strategy/paper-account.js'
import type { EntryConfig } from '../strategy/entry.js'

/**
 * Replay this evidence under a DIFFERENT entry filter than the one that was captured.
 *
 * This is how two books are measured on one set of chain reads: the captures, the execution
 * bundles and the selector are shared and untouched, and each book replays them through its
 * own filter. `id` names the book; `entry` replaces the stored filter everywhere a config is
 * read, which is more places than it looks.
 */
export type ObserverBook = { id: string; entry: EntryConfig }

export const captureConfig = (p: any): AccountConfig => ({ entry: p.config.entry, bankrollWei: p.config.bankrollWei,
  maxConcurrent: p.config.maxConcurrent, maxDrawdownWei: String(BigInt(Math.round((p.strategy?.maxDrawdownEth ?? 0.06) * 1e18))), entryHours: p.entryHours ?? [] })

/**
 * Worker-only replay. HTTP readers receive its saved snapshot and cannot advance a guard.
 *
 * WITH A BOOK OVERRIDE, THREE THINGS MUST MOVE TOGETHER OR THE TAPE IS SILENTLY WRONG.
 *
 *  1. The config handed to `pickEntry`, which is the filter itself.
 *  2. EVERY control that carries a config, not only the opportunities. One config control is
 *     emitted per opportunity row INCLUDING rows this book rejects, and more come from the
 *     stored `control` captures below. The account reducer reads `s.config.entry`
 *     (strategy/paper-account.ts), so a single un-overridden control reverts the book's
 *     filter mid-stream and the rest of the tape is scored under the captured band.
 *  3. The configId, consistently, in the cohort walk, in the returned value and in the
 *     `compatible` check. It also has to DIFFER between books: the forward ledger derives its
 *     epoch id from it, so two books sharing one configId would share one epoch.
 *
 * `bookConfig` and `bookConfigId` below are the only two places that know about the
 * override, so there is one way to get it right rather than nine.
 */
export function buildScenarioObserver(db: Database.Database, now: number, policy: GuardPolicy = SELECTED_GUARD, notBefore = 0, book?: ObserverBook) {
  /** the captured account config with THIS book's entry filter swapped in */
  const bookConfig = (p: any): AccountConfig => {
    const c = captureConfig(p)
    return book ? { ...c, entry: book.entry } : c
  }
  /**
   * The identity of the config as this book replays it, not as it was captured.
   *
   * Digesting the stored `p.config` would give both books the same id, and the id is what
   * separates their forward-ledger epochs, their guard checkpoints and their warmup. Two
   * books on one id is the failure where both appear to work and share one tape.
   */
  const bookConfigId = (p: any): string => digest(book ? { ...p.config, entry: book.entry } : p.config)
  // A model begins a new independent virtual account. Older inputs remain archived for research.
  // Restarts retain the same model suffix and therefore retain its complete account history.
  const allRows = db.prepare("SELECT session,sequence,at,key,payload FROM captures WHERE kind='opportunity' AND substr(session,-64)=? AND at>=? AND at<=? ORDER BY at,session,sequence").all(MODEL_HASH, notBefore, now) as any[]
  if (!allRows.length) return null
  const latestConfigId=bookConfigId(JSON.parse(allRows.at(-1)!.payload))
  let cohort=allRows.length-1
  while(cohort>0&&bookConfigId(JSON.parse(allRows[cohort-1]!.payload))===latestConfigId)cohort--
  const rows=allRows.slice(cohort)
  const stored = db.prepare('SELECT id,bundle,available_at FROM scenario_results WHERE model=? AND at<=? ORDER BY at').all(MODEL_HASH, now) as any[]
  const bundles = new Map(stored.map(row => [row.id, row]))
  const opportunities: ScenarioOpportunity[] = [], controls: ScenarioControl[] = []
  let pending = 0, blocked = 0, firstPending: number | null = null, prefixComplete = true
  for (const row of rows) {
    const p = JSON.parse(row.payload), id = row.session + ':' + row.sequence, config = bookConfig(p), saved = bundles.get(id)
    controls.push({ kind: 'control', id: id + ':account-stops', at: row.at, sequence: row.sequence * 2, strategyVersion: EXECUTION_VERSION,
      halted: (p.haltKinds ?? []).some((h: string) => h !== 'venue'), config })
    if ('reject' in pickEntry({ creatorTaxBps: BigInt(p.params.creatorTaxBps), exemptions: p.launch.exemptions ?? null }, config.entry)) continue
    if(!capturedTarget(p,row.at).ready){blocked++;continue}
    if (!saved || saved.available_at === null || saved.available_at > now) {
      pending++; firstPending ??= row.at; prefixComplete = false; continue
    }
    if (!prefixComplete) continue
    opportunities.push({ id, at: row.at, sequence: row.sequence, configId: bookConfigId(p), config, token: row.key,
      template: [p.params.creatorTaxBps, p.launch.devBuyWei ?? '0', p.launch.exemptions ?? ''].join(':'),
      creatorTaxBps: String(p.params.creatorTaxBps), exemptions: p.launch.exemptions ?? null, sizeWei: p.sizeWei,
      block: p.launch.block, launched: Number(p.params.launchedAt) * 1000, availableAt: saved.available_at, bundle: JSON.parse(saved.bundle) })
  }
  for (const row of db.prepare("SELECT session,sequence,at,payload FROM captures WHERE kind='control' AND substr(session,-64)=? AND at>=? AND at<=?").all(MODEL_HASH, rows[0].at, now) as any[]) {
    const p = JSON.parse(row.payload)
    controls.push({ kind: 'control', id: row.session + ':' + row.sequence, at: row.at, sequence: row.sequence * 2, strategyVersion: EXECUTION_VERSION,
      resetDrawdown: p.resetDrawdown, halted: p.haltKinds ? p.haltKinds.some((h: string) => h !== 'venue') : undefined,
      // bookConfig, not captureConfig: a stored control carrying the CAPTURED entry would
      // reset this book's filter partway through the replay, with no error anywhere.
      config: p.config ? bookConfig(p) : undefined })
  }
  const gaps = db.prepare('SELECT id,lo,reason FROM gaps WHERE lo>=? AND lo<=?').all(rows[0].at, now) as any[]
  for (const g of gaps) controls.push({ kind: 'gap', id: g.id, at: g.lo, sequence: 0, strategyVersion: EXECUTION_VERSION, reason: g.reason })
  // This defines a new independent virtual account starting flat. It is not historical account reconstruction.
  const replay = replayScenarioAccounts({ start: rows[0].at, through: now, initialKnown: true, config: bookConfig(JSON.parse(rows[0].payload)), policy, opportunities, controls })
  const overdue = firstPending !== null && now - firstPending > 190000
  if (overdue) for (const tape of replay.tapes) tape.complete = false
  const latest = JSON.parse(rows.at(-1).payload), configId = bookConfigId(latest)
  const compatible = replay.reading.configId === configId
  const processorRow=db.prepare("SELECT value FROM checkpoints WHERE name='processor'").get() as {value:string}|undefined
  const processorError=processorRow?JSON.parse(processorRow.value).error:null
  // Job errors are scoped by the admission prefix above. A rejected launch's failed
  // target replay cannot invalidate an unrelated, already published account outcome.
  if (!compatible) for (const tape of replay.tapes) { tape.complete = false; tape.outcomes = [] }
  const metadata = new Map(opportunities.map(o=>[o.token.toLowerCase(),o]))
  const publications=replay.continuous.flatMap(account=>{
    const decisions=new Map(account.run.decisions.map(d=>[d.id,d]))
    const cash=new Map(account.metrics.cash.map(p=>[p.id,p]))
    return opportunities.map(o=>{
      const execution=o.bundle.scenarios.find(s=>s.id===account.id)!,decision=decisions.get(o.id),settled=cash.get(o.id)
      const coverage=execution.request.coverage
      return {executionId:o.id,scenario:account.id,token:o.token,detectedAt:o.at,launchAt:o.launched,
        closeAt:execution.result.exitAt,publicationAt:o.availableAt,stakeWei:o.sizeWei,pnlWei:settled?.pnlWei??null,
        executionStatus:execution.result.status,executionReason:execution.result.reason,configId:o.configId,
        admissionStatus:settled?'admitted':decision?.allow?'execution_failed':'skipped',admissionReason:decision?.reason??'unavailable',
        indicatorEvidence:!!settled&&coverage.complete&&coverage.independentlyChecked&&!coverage.gaps.length}
    })
  })
  const gapBlocksCurrentWindow=gaps.length>0&&replay.tapes.some(t=>!t.complete)
  return { at: now, bookId: book?.id ?? 'main', modelHash: MODEL_HASH, configId, policy, tapes: replay.tapes, reading: replay.reading,
    publicationAt: Math.max(0, ...replay.tapes.flatMap(t => t.outcomes.map(o => o.available))), pending, firstPending,
    complete: compatible && !overdue && replay.tapes.every(t => t.complete),
    failure: overdue ? 'unresolved_execution_prefix' : !compatible ? 'configuration_warmup' : gapBlocksCurrentWindow ? 'source_gap' : null,
    acquisitionError:processorError,blocked,
    comparableThrough: Math.min(now,firstPending??now,...gaps.map(g=>g.lo)),
    recordFrom: rows[0].at, accountScope: 'independent-virtual-account-since-capture',
    continuous: replay.continuous.map(a=>({id:a.id,...a.metrics})),publications,
    outcomes: replay.continuous.find(a=>a.id==='p50-after')!.run.state.outcomes.map(o=>({...o,configId:metadata.get(o.token.toLowerCase())?.configId})),
    decisions: replay.readings,
    accounts: replay.accounts.map(a => ({ id: a.id, policy: a.selected, marketOff: a.reference, retention: a.retention, drawdownHalts:drawdownHistory(a.policy,bookConfig(JSON.parse(rows[0].payload)),controls,now),
      losingRecoveries: a.losingRecoveries, recoveryLossWei: a.recoveryLossWei })),
    verified: false, reason: 'model_validation_pending' }
}
