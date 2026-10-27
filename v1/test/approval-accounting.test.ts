import { describe, it, expect, afterEach } from 'vitest'
import { Telemetry } from '../src/telemetry/db.js'
import { recordApproval, rejectApproval } from '../src/telemetry/approvals.js'
import { TruthKeeper, rebuildRealized, type TruthRpc } from '../src/telemetry/truth.js'
import { ddResumeBudget, newEpoch } from '../src/telemetry/epoch.js'
import { RiskManager } from '../src/strategy/risk.js'

const hash = (x: string) => `0x${x.repeat(64)}`
const instances: Telemetry[] = []
const make = () => { const t = new Telemetry(':memory:'); instances.push(t); return t.raw() }
afterEach(() => { for (const t of instances.splice(0)) t.close() })

function setup(reason = 'time') {
  const db = make()
  db.prepare(`INSERT INTO positions(id,token,curve,live,closed,entry_block,spend_wei,proceeds_wei,
    buy_hash,exit_hash,buy_ok,exit_reason,exit_at,pnl_wei) VALUES(1,'token','curve',1,1,100,'10000','12000',?,?,1,?,1000,'1600')`)
    .run(hash('b'), hash('c'), reason)
  db.prepare("INSERT INTO chain_truth VALUES('epoch_base_id','0')").run()
  const rpc: TruthRpc = {
    getBalance: async () => 1_000_000n,
    getTransactionReceipt: async ({ hash: h }) => ({ gasUsed: h === hash('a') ? 50n : 100n,
      effectiveGasPrice: 2n, blockNumber: 110n, status: 'success' }),
    request: async () => '0x64',
  }
  const keeper = new TruthKeeper(db, rpc, { wallet: () => hash('d').slice(0, 42), openCount: () => 0,
    deployedWei: () => 0n, onHalt: () => {}, health: () => {} })
  return { db, rpc, keeper }
}

describe('approval receipt accounting', () => {
  it('includes the approval leg and never double-charges a replayed backfill', async () => {
    const { db, keeper } = setup()
    recordApproval(db, 1, hash('a'), 2)
    keeper.boot(); await keeper.tick()
    const read = () => db.prepare('SELECT gas_wei,onchain_pnl_wei,approval_gas_wei FROM positions').get()
    expect(read()).toEqual({ gas_wei: '500', onchain_pnl_wei: '1500', approval_gas_wei: '100' })
    keeper.enqueue(1); await keeper.tick()
    expect(read()).toEqual({ gas_wei: '500', onchain_pnl_wei: '1500', approval_gas_wei: '100' })
  })

  it('charges reverted approvals, but not cleanly rejected sends', async () => {
    const { db, keeper, rpc } = setup()
    recordApproval(db, 1, hash('a'), 2)
    recordApproval(db, 1, hash('e'), 3)
    rejectApproval(db, hash('e'))
    const original = rpc.getTransactionReceipt
    rpc.getTransactionReceipt = async (args) => ({ ...await original(args), status: 'reverted' })
    keeper.boot(); await keeper.tick()
    expect(db.prepare('SELECT gas_wei FROM positions').get()).toEqual({ gas_wei: '500' })
  })

  it('keeps an approval cost even when its buy never mined', async () => {
    const { db, keeper } = setup('buy-never-mined')
    recordApproval(db, 1, hash('a'), 2)
    keeper.boot(); await keeper.tick()
    expect(db.prepare('SELECT onchain_pnl_wei FROM positions').get()).toEqual({ onchain_pnl_wei: '-100' })
  })

  it('reopens receipt accounting when a late approval is recorded after close', async () => {
    const { db, keeper } = setup()
    keeper.boot(); await keeper.tick()
    expect(db.prepare('SELECT onchain_pnl_wei FROM positions').get()).toEqual({ onchain_pnl_wei: '1600' })
    recordApproval(db, 1, hash('a'), 2)
    expect(db.prepare('SELECT onchain_pnl_wei FROM positions').get()).toEqual({ onchain_pnl_wei: null })
    keeper.boot(); await keeper.tick()
    expect(db.prepare('SELECT onchain_pnl_wei FROM positions').get()).toEqual({ onchain_pnl_wei: '1500' })
  })

  it('does not certify an unavailable approval receipt as a zero cost', async () => {
    const { db, keeper, rpc } = setup()
    recordApproval(db, 1, hash('a'), 2)
    const original = rpc.getTransactionReceipt
    rpc.getTransactionReceipt = async (args) => {
      if (args.hash === hash('a')) throw new Error('receipt unavailable')
      return original(args)
    }
    keeper.boot(); await keeper.tick()
    expect(db.prepare('SELECT onchain_pnl_wei FROM positions').get()).toEqual({ onchain_pnl_wei: null })
    expect(keeper.backlogSize()).toBe(1)
  })

  it('rebuilds the peak by exit time when concurrent positions close out of entry order', () => {
    const { db } = setup()
    db.prepare("UPDATE positions SET pnl_wei='-30',exit_at=2000 WHERE id=1").run()
    db.prepare("INSERT INTO positions(id,live,closed,pnl_wei,exit_at) VALUES(2,1,1,'50',1000)").run()
    expect(rebuildRealized(db, 0)).toEqual({ realized: 20n, peak: 50n })
  })
})

describe('durable drawdown restart budget', () => {
  const now = Date.UTC(2026, 8, 7, 12)
  it('migrates both recorded restarts and restores an exhausted risk budget', () => {
    const db = make()
    for (const at of [now - 1000, now - 500]) {
      db.prepare("INSERT INTO health(at,component,ok,detail) VALUES(?,'drawdown',1,'auto-resumed: evidence')").run(at)
    }
    expect(ddResumeBudget(db, now)).toBe(2)
    const risk = new RiskManager(1n, () => now)
    risk.restoreDdLifts(ddResumeBudget(db, now))
    risk.halt('test', 'drawdown')
    expect(risk.liftOnSignal('drawdown', 'test')).toBe(false)
  })

  it('records the spent restart atomically with the epoch and refuses a third reset', () => {
    const db = make()
    newEpoch(db, 'drawdown auto-resume: first', now, true)
    newEpoch(db, 'drawdown auto-resume: second', now + 1, true)
    const before = db.prepare('SELECT * FROM chain_truth ORDER BY key').all()
    expect(() => newEpoch(db, 'drawdown auto-resume: third', now + 2, true)).toThrow('budget exhausted')
    expect(db.prepare('SELECT * FROM chain_truth ORDER BY key').all()).toEqual(before)
    expect(ddResumeBudget(db, now + 86_400_000)).toBe(0)
  })

  it('does not clear the spent budget on a manual epoch reset', () => {
    const db = make()
    newEpoch(db, 'drawdown auto-resume: first', now, true)
    newEpoch(db, 'operator accounting reset', now + 1)
    expect(ddResumeBudget(db, now + 2)).toBe(1)
  })

  it('refuses malformed persisted budgets', () => {
    const db = make()
    db.prepare("INSERT INTO chain_truth VALUES('dd_resume_budget',?)")
      .run(JSON.stringify({ day: Math.floor(now / 86_400_000), used: -1 }))
    expect(() => ddResumeBudget(db, now)).toThrow('invalid persisted')
  })
})
