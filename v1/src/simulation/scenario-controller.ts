import type Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { MODEL_HASH } from './identity.js'
import { digest } from './store.js'
import { ScenarioGuard, SELECTED_GUARD, type GuardPolicy, type ScenarioReading } from '../strategy/scenario-guard.js'
import type { buildScenarioObserver } from './scenario-observer.js'

export type ScenarioRelease = { modelHash: string; configId: string; policy: GuardPolicy; candidateId: string;
  candidateHash: string; datasetHash: string; lockedAt: number;
  fidelity: { path: string; sha256: string }; selection: { path: string; sha256: string }; certification: { path: string; sha256: string } }
const artifact = (root: string, ref: { path: string; sha256: string }) => {
  const bytes = readFileSync(resolve(root, ref.path))
  if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new Error('release_artifact_hash_mismatch')
  return JSON.parse(bytes.toString())
}
/** A release is prepared only after research and independent shadow verification pass. */
export function loadScenarioRelease(path: string): { release: ScenarioRelease | null; reason: string | null } {
  try {
    const release: ScenarioRelease = JSON.parse(readFileSync(path, 'utf8')), root = dirname(path)
    if (release.modelHash !== MODEL_HASH || !release.configId || !Number.isFinite(release.lockedAt)) throw new Error('release_model_or_config_mismatch')
    new ScenarioGuard(0, release.policy)
    const fidelity = artifact(root, release.fidelity), selection = artifact(root, release.selection), certification = artifact(root, release.certification)
    if (fidelity.modelHash !== MODEL_HASH || fidelity.datasetHash !== release.datasetHash || fidelity.verdict?.historical_fidelity_passed !== true) throw new Error('historical_fidelity_not_passed')
    if (selection.modelHash !== MODEL_HASH || selection.datasetHash !== release.datasetHash || selection.candidateHash !== release.candidateHash
      || selection.candidateId !== release.candidateId || digest(selection.policy) !== digest(release.policy) || selection.decision !== 'supported_replacement') throw new Error('selection_not_validated')
    if (certification.modelHash !== MODEL_HASH || certification.configId !== release.configId || certification.policyId !== release.policy.id
      || digest(certification.policy) !== digest(release.policy)
      || certification.independentReplayPassed !== true || certification.sourceCoverageComplete !== true || certification.publicationOrderingPassed !== true
      || certification.outcomes?.length < 20 || new Set(certification.outcomes?.map((o: any) => o.id)).size < 20
      || certification.outcomes.some((o: any) => o.entryAt < release.lockedAt || !o.evidenceHash || o.availableAt <= o.closedThrough)
      || certification.targetReplayPassed !== true || certification.selectorPinnedPassed !== true
      || certification.prospectiveAccuracyPassed !== true) throw new Error('prospective_certification_not_passed')
    return { release, reason: null }
  } catch (e) { return { release: null, reason: String(e).replace(/(?:https?|wss?):\/\/\S+/gi, '[source]').slice(0, 200) } }
}

export class ScenarioController {
  private guard: ScenarioGuard
  readonly release: ScenarioRelease | null
  readonly releaseFailure: string | null
  nextCheckAt = 0
  reading: (ScenarioReading & { verified: boolean; observerError: string | null; publicationAt: number | null }) | null = null
  constructor(private db: Database.Database, releasePath: string, now: number, load = loadScenarioRelease, readonly book: string = 'main') {
    const { release, reason } = load(releasePath); this.release = release; this.releaseFailure = reason
    this.guard = new ScenarioGuard(now, release?.policy ?? SELECTED_GUARD)
    db.exec('CREATE TABLE IF NOT EXISTS execution_guard_decisions(id INTEGER PRIMARY KEY AUTOINCREMENT,model TEXT,policy TEXT,at INTEGER,reading TEXT,checkpoint TEXT)')
    // THE BOOK, added 2026-09-16. The model hash and the policy id are both the same for every
    // book, so without it two books restore from each other's newest checkpoint and each trim
    // blanks the other's, which means neither ever recovers its own guard state across a
    // restart. Existing rows have no book and read as 'main', which is what one book has
    // always been.
    const columns = db.prepare('PRAGMA table_info(execution_guard_decisions)').all() as Array<{ name: string }>
    if (!columns.some((c) => c.name === 'book')) db.exec("ALTER TABLE execution_guard_decisions ADD COLUMN book TEXT")
    const saved = db.prepare("SELECT checkpoint FROM execution_guard_decisions WHERE model=? AND policy=? AND COALESCE(book,'main')=? AND checkpoint<>'' ORDER BY id DESC LIMIT 1").get(MODEL_HASH, this.guard.policy.id, this.book) as { checkpoint: string } | undefined
    if (saved) { try { this.guard.restore(JSON.parse(saved.checkpoint)) } catch { this.guard.pause(now) } }
  }
  pause(at: number) {
    this.guard.pause(at); this.nextCheckAt = 0
    this.record(at, 'null')
  }
  /**
   * One history row per decision, but only the newest row keeps the guard snapshot.
   *
   * `checkpoint` is read back in exactly one place, the constructor above, and only for the
   * newest row. The dashboard reads `at` and `reading` (dashboard-policy.ts). Every row
   * nonetheless stored a whole snapshot, and 74,473 of its 76,268 bytes were one field,
   * `fingerprint`, which is JSON.stringify(tapes) used as a change detector and grows with the
   * tape. Measured on the box 2026-09-15: 2,542 rows holding 42.8 MB of checkpoints in 7.96
   * hours, 140 MB a day, the second largest writer on the disk. Blanking the previous row
   * costs nothing, because no caller could read it.
   *
   * Retention at 8 days clears the dashboard's 7-day maximum lookback by a day.
   */
  private lastPrune = 0
  private record(at: number, reading: string) {
    const insert = this.db.prepare('INSERT INTO execution_guard_decisions(model,policy,at,reading,checkpoint,book) VALUES (?,?,?,?,?,?)')
    // AND book: the trim blanks every older checkpoint for this key, so unscoped it would
    // blank the OTHER book's newest row, the one thing the constructor reads back.
    const trim = this.db.prepare("UPDATE execution_guard_decisions SET checkpoint='' WHERE model=? AND policy=? AND COALESCE(book,'main')=? AND id<? AND checkpoint<>''")
    const prune = this.db.prepare('DELETE FROM execution_guard_decisions WHERE at<?')
    this.db.transaction(() => {
      const id = Number(insert.run(MODEL_HASH, this.guard.policy.id, at, reading, JSON.stringify(this.guard.snapshot()), this.book).lastInsertRowid)
      trim.run(MODEL_HASH, this.guard.policy.id, this.book, id)
      if (at - this.lastPrune > 3_600_000) { this.lastPrune = at; prune.run(at - 8 * 86_400_000) }
    })()
  }
  /**
   * `heartbeatAt` is when the worker last reported in, which is not when the observer was
   * built: the rebuild follows the data and a quiet hour produces no new one. Liveness is the
   * heartbeat; the observer's own `at` still has to be sane and not from the future.
   */
  check(observer: ReturnType<typeof buildScenarioObserver>, configId: string, now: number, heartbeatAt = observer?.at ?? 0) {
    let error = this.releaseFailure
    if (!observer || observer.modelHash !== MODEL_HASH || observer.at > now || now - heartbeatAt > 15000) error = 'paper_worker_missing_or_stale'
    else if (digest(observer.policy) !== digest(this.guard.policy)) error = 'observer_policy_mismatch'
    else if (!observer.complete || observer.configId !== configId) error = observer.failure ?? 'incompatible_or_incomplete_evidence'
    else if (!this.release || this.release.configId !== configId) error = this.releaseFailure ?? 'release_configuration_mismatch'
    const tapes = (observer?.tapes ?? []).map(t => ({ ...t, complete: t.complete && !error }))
    const reading = this.guard.read(tapes, now, configId)
    if(reading.reason==='invalid_or_incomplete_scenario_evidence')error??='invalid_scenario_evidence'
    const value = { ...reading, verified: !error, observerError: error, reason: error ?? reading.reason, publicationAt: observer?.publicationAt ?? null }
    try { this.record(now, JSON.stringify(value)) } catch (e) { this.guard.pause(now); throw e }
    const expiry = tapes.flatMap(t => t.outcomes.map(o => o.launched + this.guard.policy.ageMs + 1)).filter(at => at > now)
    this.nextCheckAt = Math.min(now + 15001, heartbeatAt + 15001 > now ? heartbeatAt + 15001 : now + 15001, ...expiry)
    return this.reading = value
  }
}
