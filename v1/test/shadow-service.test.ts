import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Telemetry } from '../src/telemetry/db.js'
import { ShadowService } from '../src/strategy/shadow-service.js'
import { shadowConfigId, type ShadowIntent } from '../src/strategy/shadow-account.js'

const cfg: ShadowIntent['config'] = { entry: { minCreatorTaxBps: 50, maxCreatorTaxBps: 10000, minExemptionsToEnter: 3, templateLossBlockMs: 3600000, tradeSizeEth: 0.02 },
  rules: { maxHoldMs: 45000, hardStopMultiple: 0.5, deadCoinAfterMs: 20000, deadCoinBelowMult: 1.03 },
  bankrollWei: '80000000000000000', maxConcurrent: 14, maxEntryMultiple: 4.5, targetPolicy: 'adaptive' }
const cleanup: Array<() => void> = []
afterEach(() => { for (const f of cleanup.splice(0)) f() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-service-'))
  const tel = new Telemetry(join(dir, 'bot.db'))
  const gate = new Database(join(dir, 'gate.db'))
  gate.exec('CREATE TABLE obs(token TEXT,at INTEGER,error TEXT,bars TEXT)'); gate.close()
  const service = new ShadowService(tel.raw(), join(dir,'bot.db'), join(dir,'gate.db'), cfg, () => {}, () => {})
  cleanup.push(() => { tel.close(); rmSync(dir, { recursive: true, force: true }) })
  return { service, tel }
}
const status = (now: number) => ({ at: now, config: shadowConfigId({ config: cfg }), pending: 0, oldestPending: null, verified: true, error: null,
  outcomes: Array.from({ length: 20 }, (_,i) => ({ token: String(i), block:i, launched:now-2000+i, available:now, value:1 })) })

describe('shadow worker integration and release gate', () => {
  it('runs the actual worker without signing or network work when the queue is empty', async () => {
    const { service } = fixture()
    service.start()
    const child = (service as any).child
    try {
      service.coverage(100, 110, [])
      const deadline = Date.now()+4000
      while ((!(service as any).status || (service as any).status.error) && Date.now()<deadline) await new Promise(r => setTimeout(r,50))
      expect((service as any).status?.error).toBeNull()
      expect(service.read(Date.now()).state).toBe('shut')
      expect(service.read(Date.now()).verified).toBe(false)
    } finally {
      const exited = new Promise<void>(r => child.once('exit', () => r()))
      service.stop(); await exited
    }
  }, 8000)
  it('shows collected outcomes but cannot trade before prospective verification', () => {
    const { service, tel } = fixture(); const now=Date.now()+10
    ;(service as any).status={ ...status(now), verified:false }
    const r=service.read(now)
    expect(r.n).toBe(20); expect(r.state).toBe('shut')
    expect(r.observerError).toBe('prospective verification pending')
    const saved=tel.raw().prepare('SELECT reading,checkpoint FROM shadow_decisions WHERE at=?').get(now) as any
    expect(JSON.parse(saved.reading)).toEqual(r)
    expect(JSON.parse(saved.checkpoint).allowed).toBe(false)
  })
  it('halts on worker failure or backlog even with profitable fresh evidence', () => {
    for (const extra of [{ at: Date.now()-16000 }, { error:'source missing' }, { oldestPending:Date.now()-181000 }]) {
      const { service }=fixture(); const now=Date.now()+10
      ;(service as any).status={ ...status(now), ...extra }
      expect(service.read(now).state).toBe('shut')
    }
  })
  it('keeps persistent capture faults from being cleared by a later good publication', () => {
    const { service, tel }=fixture(); const now=Date.now()+10
    service.fail('intent write failed')
    ;(service as any).status=status(now)
    expect(service.read(now).state).toBe('shut')
    expect((tel.raw().prepare("SELECT value FROM shadow_meta WHERE key='source_fault'").get() as any).value).toBe('intent write failed')
  })
  it('freezes cost samples before a worker can observe later reconciliations', () => {
    const { service, tel } = fixture(), at = Date.now()
    for (let i=0; i<20; i++) tel.raw().prepare(`INSERT INTO positions
      (live,closed,buy_ok,cohort,onchain_pnl_wei,gas_wei,buy_hash,buy_gas_used,sell_gas_used,t_decide,t_sent,exit_at,updated_at,context_json)
      VALUES (1,1,1,'main','1','100',?,100,100,1,2,3,4,?)`).run(String(i), JSON.stringify({ at: 2 }))
    service.enqueue({ token:'test', curve:'curve', block:1, launched:at-10, entry:at, wallet:'wallet',
      params:{}, exemptions:3, devBuyWei:'1', tp:1.75, targetReason:'test', selector:[], config:cfg })
    tel.raw().prepare("UPDATE positions SET gas_wei='999',updated_at=?").run(at+1)
    const intent=JSON.parse((tel.raw().prepare('SELECT intent FROM shadow_jobs').get() as any).intent)
    expect(intent.calibration).toMatchObject({ gasWei:'100', n:20, latest:4 })
  })
})
