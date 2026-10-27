import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { Telemetry } from '../src/telemetry/db.js'
import { ShadowAccount, shadowConfigId, type ShadowIntent, type ShadowJob } from '../src/strategy/shadow-account.js'
import { FreshRecovery } from '../src/strategy/fresh-recovery.js'

const fixtures = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/replay-before-extraction.json.gz', import.meta.url))).toString())
const sample = fixtures.cases.find((c: any) => c.expected.status === 'closed')
const handles: Telemetry[] = []
function setup() {
  const tel = new Telemetry(':memory:'); handles.push(tel)
  const account = new ShadowAccount(tel.raw())
  const r = structuredClone(sample.request)
  r.coverage = { complete: true }
  const intent: ShadowIntent = { token: r.token, curve: r.curve, block: Number(r.logs[0].blockNumber),
    launched: Number(r.params.launchedAt)*1000, entry: r.entryAt, wallet: r.wallet, params: r.params,
    exemptions: 3, devBuyWei: '100000000000000000', tp: r.takeProfit, targetReason: 'fixture', selector: [],
    config: { entry: { minCreatorTaxBps: 0, maxCreatorTaxBps: 10000, minExemptionsToEnter: 3, templateLossBlockMs: 3600000, tradeSizeEth: Number(r.sizeWei)/1e18 },
      rules: r.rules, bankrollWei: '80000000000000000', maxConcurrent: 14, maxEntryMultiple: 4.5, targetPolicy: 'adaptive' } }
  const enqueue = (i = intent) => { account.enqueue(i); return tel.raw().prepare('SELECT * FROM shadow_jobs WHERE token=?').get(i.token) as ShadowJob }
  return { tel, account, r, intent, enqueue }
}
afterEach(() => { for (const h of handles.splice(0)) h.close() })

describe('independent persistent shadow account', () => {
  it('deduplicates admission intents and leaves actual positions untouched', () => {
    const { tel, enqueue } = setup(); enqueue(); enqueue()
    expect((tel.raw().prepare('SELECT COUNT(*) n FROM shadow_jobs').get() as any).n).toBe(1)
    expect((tel.raw().prepare('SELECT COUNT(*) n FROM positions').get() as any).n).toBe(0)
  })
  it('pins the target and rejects attempts to change it at replay time', () => {
    const { account, enqueue, r } = setup()
    expect(() => account.complete(enqueue(), { ...r, takeProfit: 99 }, r.entryAt+200000)).toThrow('pinned intent')
  })
  it('refuses incomplete source coverage', () => {
    const { account, enqueue, r } = setup()
    expect(() => account.complete(enqueue(), { ...r, coverage: { complete: false } }, r.entryAt+200000)).toThrow('coverage')
  })
  it('applies the configured book floors before replay', () => {
    const { account, enqueue, intent } = setup(); intent.exemptions = 2
    expect(account.admission(enqueue())).toEqual({ allow: false, reason: 'exempt 2' })
  })
  it('preserves shadow capacity across rebuilding the account', () => {
    const { tel, account, enqueue, intent, r } = setup()
    const first = enqueue(); account.complete(first, r, r.entryAt+200000)
    tel.raw().prepare("UPDATE shadow_jobs SET status='modeled',close_at=?,size=? WHERE id=?").run(intent.entry+100000, intent.config.bankrollWei, first.id)
    const next = enqueue({ ...intent, token: '0xnext', entry: intent.entry+1 })
    expect(new ShadowAccount(tel.raw()).admission(next)).toEqual({ allow: false, reason: 'bankroll' })
  })
  it('uses shadow losses for template cooldown without consulting actual losses', () => {
    const { tel, account, enqueue, intent, r } = setup()
    const first = enqueue(); account.complete(first, r, r.entryAt+200000)
    tel.raw().prepare("UPDATE shadow_jobs SET pnl='-1',close_at=? WHERE id=?").run(intent.entry+1, first.id)
    const next = enqueue({ ...intent, token: '0xnext', entry: intent.entry+2 })
    expect(account.admission(next)).toEqual({ allow: false, reason: 'template-loss 0m ago' })
  })
  it('does not publish without gatewatch evidence and preserves publication through restart', () => {
    const { tel, account, enqueue, intent, r } = setup()
    const job = enqueue(); account.complete(job, r, r.entryAt+200000)
    const gate = new Database(':memory:')
    gate.exec('CREATE TABLE obs(token TEXT,at INTEGER,error TEXT,bars TEXT)')
    expect(account.publish(gate, r.entryAt+200000)).toBe(0)
    gate.prepare("INSERT INTO obs VALUES (?,?,NULL,'{}')").run(intent.token, r.entryAt+210000)
    account.publish(gate, r.entryAt+220000)
    const config = shadowConfigId(intent)
    expect(account.outcomes(config, r.entryAt+220000)).toHaveLength(0)
    const before = account.outcomes(config, r.entryAt+220001)
    expect(before).toHaveLength(1)
    const restarted = new ShadowAccount(tel.raw())
    expect(restarted.publish(gate, r.entryAt+300000)).toBe(0)
    expect(restarted.outcomes(config, r.entryAt+300000)).toEqual(before)
    gate.close()
  })
  it('keeps unavailable executions explicit and blocks subsequent admissions', () => {
    const { account, enqueue, intent, r } = setup()
    account.complete(enqueue(), { ...r, blocks: {} }, r.entryAt+200000)
    expect(account.admission(enqueue({ ...intent, token: '0xnext', entry: intent.entry+300000 })))
      .toEqual({ allow: false, reason: 'unresolved_prior_execution' })
  })
  it('isolates outcomes after a strategy configuration change', () => {
    const { intent } = setup()
    expect(shadowConfigId(intent)).not.toBe(shadowConfigId({ config: { ...intent.config, bankrollWei: '40000000000000000' } }))
  })
  it('cannot calibrate using future receipt reconciliation', () => {
    const { account, tel, intent } = setup()
    for (let i=0; i<20; i++) tel.raw().prepare(`INSERT INTO positions
      (live,closed,buy_ok,cohort,onchain_pnl_wei,gas_wei,buy_gas_used,sell_gas_used,t_decide,t_sent,exit_at,updated_at,context_json)
      VALUES (1,1,1,'main','1','100',100,100,1,2,3,?,?)`).run(intent.entry+1, JSON.stringify({ at: 2 }))
    expect(() => account.calibrate(intent.entry)).toThrow('0/20')
    expect(account.calibrate(intent.entry+2).n).toBe(20)
  })
  it('does not consume the same publication as new evidence after guard restart', () => {
    const g = new FreshRecovery(1000)
    const rows = Array.from({ length: 20 }, (_,i) => ({ token: String(i), block:i, launched:i+1, available:1000, value:1 }))
    g.read(rows, 1000); g.pause(1001)
    const restarted = new FreshRecovery(1002); restarted.restore(g.snapshot())
    expect(restarted.read(rows, 1003).state).toBe('shut')
  })
})
