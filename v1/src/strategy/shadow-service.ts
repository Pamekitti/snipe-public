import { FRESH_POLICY } from './fresh-policy.js'
import { fork, type ChildProcess } from 'node:child_process'
import { coalesceCoverage, openCoverageDb } from './shadow-coverage.js'
import { runRetention } from './bot-db-retention.js'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { FreshRecovery, type FreshReading, type ShadowOutcome } from './fresh-recovery.js'
import { ShadowAccount, shadowConfigId, encodeShadow, type ShadowIntent } from './shadow-account.js'

type Status = { at: number; config: string; error: string | null; pending: number; oldestPending: number | null; verified: boolean; outcomes: ShadowOutcome[] }
export type ShadowReading = FreshReading & { observerError: string | null; verified: boolean; pending: number; configId: string; publicationAt: number | null }

/** Main-process bridge. Network collection and replay run only in the child. */
export class ShadowService {
  private child: ChildProcess | null = null
  private coverageTimer: ReturnType<typeof setInterval> | null = null
  private coverageDelay: ReturnType<typeof setTimeout> | null = null
  private coalescing = false
  private account: ShadowAccount
  private guard: FreshRecovery
  private status: Status | null = null
  private config: string
  private fault: string | null = null
  private lastPublication = 0
  private nextExpiry = 0
  private lastReading: ShadowReading | null = null
  private stopping = false

  constructor(private db: Database.Database, private dbFile: string, private gateFile: string,
    cfg: ShadowIntent['config'], private onUpdate: () => void, private onRpc: (method: string) => void) {
    this.account = new ShadowAccount(db)
    // Deliberately NOT in shadow-account.ts: that file is hashed into SHADOW_KERNEL, so a line
    // there changes the replay identity and throws away the certificate. An index changes no
    // arithmetic. The table exists by now because the constructor above created it.
    // shadow_decisions' primary key leads with config, so the dashboard's WHERE at>=? scanned
    // all 38k rows on every chart rebuild.
    try { db.exec('CREATE INDEX IF NOT EXISTS shadow_decisions_at ON shadow_decisions(at)') } catch {}
    this.config = shadowConfigId({ config: cfg })
    this.guard = new FreshRecovery(Date.now())
    const checkpoint = db.prepare('SELECT value FROM shadow_meta WHERE key=?').get(`guard:${this.config}`) as { value: string } | undefined
    if (checkpoint) {
      try { this.guard.restore(JSON.parse(checkpoint.value)) } catch { this.fault = 'invalid guard checkpoint' }
    }
    this.guard.pause(Date.now())
  }

  /**
   * shadow_coverage grows by one row per pending job per feed poll, so it only grows while
   * this service runs. Merging it here keeps the fix on the same lifecycle as the growth, and
   * out of the two files SHADOW_KERNEL hashes. bot-db-retention rides the same hour and the
   * same handle for the same reason.
   */
  private coalesce(): void {
    if (this.coalescing) return
    this.coalescing = true
    let db: ReturnType<typeof openCoverageDb> | null = null
    try { db = openCoverageDb(this.dbFile) } catch { this.coalescing = false; return }
    // Its own handle, with shadow-coverage's 250 ms busy_timeout and not Telemetry's 5,000 ms:
    // a sweep on the shared handle would park the trading loop behind the shadow worker.
    void coalesceCoverage(db, { minRows: 8, budgetMs: 5_000 })
      .then(() => runRetention(db!, { now: Date.now(), liveConfig: this.config, budgetMs: 5_000 }))
      .catch(() => {})
      .finally(() => { try { db?.close() } catch {} ; this.coalescing = false })
  }

  start(): void {
    if (this.child) return
    if (!this.coverageTimer) {
      // Not at t=0: the boot minute is the busiest one on the box.
      this.coverageDelay = setTimeout(() => this.coalesce(), 30_000); this.coverageDelay.unref?.()
      this.coverageTimer = setInterval(() => this.coalesce(), 3_600_000); this.coverageTimer.unref?.()
    }
    this.child = fork(fileURLToPath(new URL('./shadow-worker.ts', import.meta.url)),
      [resolve(this.dbFile), resolve(this.gateFile), this.config], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    this.child.on('message', (m: any) => {
      if (m.type === 'rpc') this.onRpc(m.method)
      if (m.type !== 'status' || m.config !== this.config) return
      this.status = m
      const latest = Math.max(0, ...m.outcomes.map((r: ShadowOutcome) => r.available))
      if (latest > this.lastPublication || !!m.error !== !!this.lastReading?.observerError || m.verified !== this.lastReading?.verified) {
        this.lastPublication = latest
        this.onUpdate()
      }
    })
    this.child.stderr?.on('data', chunk => { console.error(`shadow worker: ${String(chunk).slice(0, 400)}`) })
    this.child.on('error', e => { this.fault = String(e); this.onUpdate() })
    this.child.on('exit', code => {
      this.child = null
      if (!this.stopping) { this.fault = `shadow worker exited (${code})`; this.onUpdate() }
    })
  }

  enqueue(intent: ShadowIntent): void {
    // Freeze local, already reconciled samples before any worker/network delay.
    this.account.enqueue({ ...intent, calibration: this.account.calibrate(intent.entry) })
    this.configure(intent.config, intent.entry)
  }

  configure(cfg: ShadowIntent['config'], now: number): void {
    const config = shadowConfigId({ config: cfg })
    if (config !== this.config) {
      this.config = config; this.guard = new FreshRecovery(now); this.status = null
      this.lastPublication = 0; this.lastReading = null
      this.child?.send({ type: 'config', config })
      this.onUpdate()
    }
  }

  coverage(lo: number, hi: number, rows: unknown[]): void {
    if (!this.child?.connected) return
    // Backpressure loses only this cache opportunity. The durable jobs trigger RPC backfill.
    if ((this.child as any).channel?.bufferSize > 1_000_000) return
    this.child.send({ type: 'coverage', lo, hi, rows }, error => {
      if (error && !this.stopping) { this.fault = String(error); this.onUpdate() }
    })
  }

  pause(now: number): void { this.guard.pause(now); this.save() }
  fail(reason: string): void {
    this.fault = reason
    this.guard.pause(Date.now())
    this.db.prepare('INSERT OR REPLACE INTO shadow_meta VALUES (?,?)').run('source_fault', reason)
  }
  private save(): void {
    this.db.prepare('INSERT OR REPLACE INTO shadow_meta VALUES (?,?)').run(`guard:${this.config}`, encodeShadow(this.guard.snapshot()))
  }

  /** Called only by the decision scheduler, never by presentation reads. */
  read(now: number): ShadowReading {
    const s = this.status
    const error = this.fault ?? (!s ? 'shadow observer starting' : now-s.at > 15_000 ? 'shadow worker heartbeat stale'
      : s.error ?? (s.oldestPending !== null && now-s.oldestPending > 180_000 ? 'shadow collection backlog' : null))
    const verified = s?.verified ?? false
    let reading = this.guard.read(s?.outcomes ?? [], now)
    if (error || !verified) {
      this.guard.pause(now)
      reading = { ...reading, state: 'shut', reason: error ? 'observer_unavailable' : 'verification_pending' }
    }
    this.nextExpiry = s?.outcomes.length ? Math.min(...s.outcomes.filter(r => now-r.launched <= FRESH_POLICY.freshMs).map(r => r.launched+FRESH_POLICY.freshMs+1)) : Infinity
    this.lastReading = { ...reading, observerError: error ?? (!verified ? 'prospective verification pending' : null),
      verified, pending: s?.pending ?? 0, configId: this.config, publicationAt: this.lastPublication || null }
    this.db.transaction(() => {
      this.save()
      this.db.prepare('INSERT OR REPLACE INTO shadow_decisions VALUES (?,?,?,?)')
        .run(this.config, now, encodeShadow(this.lastReading), encodeShadow(this.guard.snapshot()))
    })()
    return this.lastReading
  }

  needsExpiryCheck(now: number): boolean {
    return now >= this.nextExpiry || !!this.status && now-this.status.at > 15_000 && this.lastReading?.state === 'open'
  }
  /** The forked worker's pid, for the resource watchdog. Null when it is not running. */
  pid(): number | null { return this.child?.pid ?? null }
  stop(): void {
    this.stopping = true
    if (this.coverageDelay) { clearTimeout(this.coverageDelay); this.coverageDelay = null }
    if (this.coverageTimer) { clearInterval(this.coverageTimer); this.coverageTimer = null }
    this.child?.send({ type: 'stop' }); this.child?.disconnect()
  }
}
