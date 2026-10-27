import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { replay } from './counterfactual.js'
import { pickEntry, templateKey, type EntryConfig } from './entry.js'
import type { ExitRules } from './exit.js'
import type { ShadowOutcome } from './fresh-recovery.js'

export const SHADOW_VERSION = 'adaptive-fresh-v2'
export const SHADOW_KERNEL = createHash('sha256').update([
  './counterfactual.ts', './pool-evidence.ts', './exit-evaluation.ts', '../state/curve.ts', '../abi.ts', './entry.ts', './shadow-account.ts', './shadow-worker.ts', './shadow-source.ts',
].map(p => readFileSync(new URL(p, import.meta.url), 'utf8')).join('\n')).digest('hex')
export const encodeShadow = (x: unknown): string => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v)
export type ShadowIntent = {
  token: string; curve: string; block: number; launched: number; entry: number; wallet: string
  params: Record<string, string>; exemptions: number | null; devBuyWei: string; kernel?: string
  tp: number; targetReason: string; selector: unknown
  calibration?: ReturnType<ShadowAccount['calibrate']>
  config: { entry: EntryConfig; rules: ExitRules; bankrollWei: string; maxConcurrent: number; maxEntryMultiple: number; targetPolicy: unknown }
}
export const shadowConfigId = (i: Pick<ShadowIntent, 'config'>) => createHash('sha256').update(encodeShadow([SHADOW_VERSION, SHADOW_KERNEL, i.config])).digest('hex')

export function setupShadow(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS shadow_jobs (
    id INTEGER PRIMARY KEY, token TEXT NOT NULL, config TEXT NOT NULL, entry INTEGER NOT NULL,
    intent TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', request TEXT, result TEXT,
    template TEXT, close_at INTEGER, pnl TEXT, size TEXT, available INTEGER,
    error TEXT, attempts INTEGER NOT NULL DEFAULT 0, UNIQUE(token,config));
    CREATE INDEX IF NOT EXISTS shadow_jobs_queue ON shadow_jobs(status,entry);
    CREATE TABLE IF NOT EXISTS shadow_headers (block INTEGER PRIMARY KEY, hash TEXT NOT NULL, timestamp INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS shadow_source_logs (curve TEXT NOT NULL,block INTEGER NOT NULL,idx INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(curve,block,idx));
    CREATE TABLE IF NOT EXISTS shadow_coverage (curve TEXT NOT NULL,lo INTEGER NOT NULL,hi INTEGER NOT NULL,PRIMARY KEY(curve,lo,hi));
    CREATE TABLE IF NOT EXISTS shadow_decisions (config TEXT NOT NULL,at INTEGER NOT NULL,reading TEXT NOT NULL,checkpoint TEXT NOT NULL,PRIMARY KEY(config,at));
    CREATE TABLE IF NOT EXISTS shadow_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);`)
  const columns = new Set((db.prepare('PRAGMA table_info(shadow_jobs)').all() as Array<{ name: string }>).map(r => r.name))
  for (const name of ['gate_at', 'published_at']) if (!columns.has(name)) db.exec(`ALTER TABLE shadow_jobs ADD COLUMN ${name} INTEGER`)
  db.prepare('INSERT OR IGNORE INTO shadow_meta VALUES (?,?)').run('capture_started_at', String(Date.now()))
}

export type ShadowJob = { id: number; config: string; intent: string; entry: number; status: string; request: string | null; result: string | null; attempts: number }
export class ShadowAccount {
  constructor(readonly db: Database.Database) { setupShadow(db) }

  enqueue(intent: ShadowIntent): string {
    const config = shadowConfigId(intent)
    this.db.prepare('INSERT OR IGNORE INTO shadow_jobs(token,config,entry,intent) VALUES (?,?,?,?)')
      .run(intent.token, config, intent.entry, encodeShadow({ ...intent, kernel: SHADOW_KERNEL }))
    return config
  }

  /** The shadow account settles modeled closes before considering the next modeled entry. */
  admission(job: ShadowJob): { allow: true; size: bigint; template: string } | { allow: false; reason: string } {
    const i: ShadowIntent = JSON.parse(job.intent)
    const template = templateKey(BigInt(i.params.creatorTaxBps!), BigInt(i.devBuyWei), i.exemptions)
    const blocked = this.db.prepare("SELECT 1 FROM shadow_jobs WHERE config=? AND entry<? AND status='unavailable' LIMIT 1").get(job.config, i.entry)
    if (blocked) return { allow: false, reason: 'unresolved_prior_execution' }
    const loss = this.db.prepare("SELECT MAX(close_at) at FROM shadow_jobs WHERE config=? AND template=? AND close_at<=? AND CAST(pnl AS REAL)<0")
      .get(job.config, template, i.entry) as { at: number | null }
    const pick = pickEntry({ creatorTaxBps: BigInt(i.params.creatorTaxBps!), exemptions: i.exemptions,
      templateLossAgeMs: loss.at === null ? null : i.entry - loss.at }, i.config.entry)
    if ('reject' in pick) return { allow: false, reason: pick.reject }
    const open = this.db.prepare("SELECT size FROM shadow_jobs WHERE config=? AND entry<=? AND close_at>? AND status IN ('modeled','published')")
      .all(job.config, i.entry, i.entry) as Array<{ size: string }>
    if (open.length >= i.config.maxConcurrent) return { allow: false, reason: 'capacity' }
    if (open.reduce((n, r) => n + BigInt(r.size), 0n) + pick.sizeWei > BigInt(i.config.bankrollWei)) return { allow: false, reason: 'bankroll' }
    return { allow: true, size: pick.sizeWei, template }
  }

  calibrate(at: number) {
    const rows = this.db.prepare(`SELECT gas_wei gas,buy_hash hash,buy_gas_used buy,sell_gas_used sell,t_sent-t_decide send,
      context_json context,t_decide decided,updated_at FROM positions
      WHERE live=1 AND closed=1 AND buy_ok=1 AND COALESCE(cohort,'main')='main'
      AND onchain_pnl_wei IS NOT NULL AND gas_wei IS NOT NULL AND buy_gas_used>0 AND sell_gas_used>0
      AND t_sent>=t_decide AND exit_at<? AND updated_at<? ORDER BY exit_at DESC LIMIT 100`).all(at, at) as
      Array<{ gas: string; hash: string; buy: number; sell: number; send: number; context: string | null; decided: number; updated_at: number }>
    const valid = rows.flatMap(r => {
      try {
        const opened = JSON.parse(r.context ?? '{}').at - r.decided
        return Number.isFinite(opened) && opened >= 0 ? [{ ...r, opened }] : []
      } catch { return [] }
    })
    if (valid.length < 20) throw new Error(`cost warmup: ${valid.length}/20 preceding reconciled trades`)
    const median = (a: number[]) => { a.sort((x, y) => x-y); return Math.round((a[Math.floor((a.length-1)/2)]! + a[Math.floor(a.length/2)]!) / 2) }
    return { gasWei: String(median(valid.map(r => Number(r.gas)))),
      // Buy-only failures require a receipt-derived buy cost, supplied separately by the collector.
      sendMs: median(valid.map(r => r.send)), openMs: median(valid.map(r => r.opened)), n: valid.length,
      latest: Math.max(...valid.map(r => r.updated_at)), buyHashes: valid.map(r => r.hash) }
  }

  complete(job: ShadowJob, request: any, now: number): void {
    const intent: ShadowIntent = JSON.parse(job.intent)
    const a = this.admission(job)
    if (!a.allow) {
      if (a.reason === 'unresolved_prior_execution') throw new Error(a.reason)
      this.db.prepare("UPDATE shadow_jobs SET status='rejected',error=? WHERE id=?").run(a.reason, job.id)
      return
    }
    if (request.entryAt !== intent.entry || request.takeProfit !== intent.tp || request.sizeWei !== a.size.toString()
      || request.wallet !== intent.wallet || !request.coverage?.complete) throw new Error('replay request does not match pinned intent or complete coverage')
    const result = replay(request)
    const status = result.status === 'entry_price_rejected' ? 'rejected'
      : result.status === 'closed' || result.status === 'buy_reverted' ? 'modeled' : 'unavailable'
    this.db.prepare(`UPDATE shadow_jobs SET status=?,request=?,result=?,template=?,close_at=?,pnl=?,size=?,error=? WHERE id=?`)
      .run(status, encodeShadow(request), encodeShadow(result), a.template,
        'exitAt' in result ? result.exitAt : null, 'pnlWei' in result ? String(result.pnlWei) : null,
        a.size.toString(), status === 'unavailable' ? result.status : null, job.id)
  }

  publish(gate: Database.Database, now: number): number {
    const rows = this.db.prepare("SELECT id,token,close_at FROM shadow_jobs WHERE status='modeled' ORDER BY id").all() as
      Array<{ id: number; token: string; close_at: number }>
    let n = 0
    this.db.transaction(() => {
      for (const r of rows) {
        const obs = gate.prepare('SELECT at FROM obs WHERE token=? AND error IS NULL AND bars IS NOT NULL').get(r.token) as { at: number } | undefined
        if (!obs) continue
        this.db.prepare("UPDATE shadow_jobs SET status='published',available=?,gate_at=?,published_at=? WHERE id=?")
          .run(Math.max(now, r.close_at, obs.at) + 1, obs.at, now, r.id)
        n++
      }
    })()
    return n
  }

  outcomes(config: string, now: number): ShadowOutcome[] {
    const rows = this.db.prepare("SELECT token,intent,available,pnl,size FROM shadow_jobs WHERE config=? AND status='published' AND available<=? ORDER BY available DESC,entry DESC,id DESC LIMIT 1000")
      .all(config, now) as Array<{ token: string; intent: string; available: number; pnl: string; size: string }>
    return rows.map(r => { const i: ShadowIntent = JSON.parse(r.intent); return {
      token: r.token, block: i.block, launched: i.launched, available: r.available, value: Number(r.pnl) / Number(r.size),
    } })
  }
}
