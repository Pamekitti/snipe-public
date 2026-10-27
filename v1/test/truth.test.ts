import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { TruthKeeper, rebuildRealized, rebuildDayRealized, type TruthRpc } from '../src/telemetry/truth.js'
import { RiskManager } from '../src/strategy/risk.js'
import { RISK } from '../src/config.js'
import { deferred } from './helpers/deferred.js'

const SCHEMA = `
CREATE TABLE positions (
  id INTEGER PRIMARY KEY, token TEXT, curve TEXT, live INTEGER, entry_block INTEGER,
  spend_wei TEXT, proceeds_wei TEXT, buy_hash TEXT, exit_hash TEXT, exit_reason TEXT,
  buy_ok INTEGER, pnl_wei TEXT, closed INTEGER DEFAULT 0,
  -- when the position closed. rebuildDayRealized windows the daily cap on this, so a
  -- fixture without it throws at prepare() and takes every test in this file with it.
  exit_at INTEGER,
  gas_wei TEXT, onchain_pnl_wei TEXT, fill_block INTEGER,
  -- raw gas units per leg. Added 2026-08-19: the summed gas_wei above could not show that
  -- six buys had burned an entire 150,000 limit, so the ceiling is now watched per leg.
  buy_gas_used INTEGER, sell_gas_used INTEGER,
  -- gas of the REVERTED sells on the way to the outcome; the backfill adds it (2026-09-06)
  burned_gas_wei TEXT, graduation_prep_gas_wei TEXT, t_detect INTEGER
);
CREATE TABLE chain_truth (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE balance (at INTEGER PRIMARY KEY, wei TEXT, open_n INTEGER, deployed_wei TEXT);
`

const H = (n: number) => ('0x' + String(n).repeat(2).padStart(64, 'a')).slice(0, 66)

function fakeRpc(overrides: Partial<TruthRpc> = {}): TruthRpc & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    getBalance: async () => { calls.push('getBalance'); return 79_600_000_000_000_000n },
    getTransactionReceipt: async ({ hash }) => {
      calls.push(`receipt:${hash.slice(0, 8)}`)
      return { gasUsed: 100_000n, effectiveGasPrice: 20_000_000n, blockNumber: 1017n, status: '0x1' }
    },
    request: async ({ method }) => {
      calls.push(method)
      if (method === 'eth_blockNumber') return '0x3e8'
      return []
    },
    ...overrides,
  }
}

function keeper(db: Database.Database, rpc: TruthRpc, open = 0, halts: string[] = [], deployed = 0n) {
  return new TruthKeeper(db, rpc, {
    wallet: () => '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
    openCount: () => open,
    deployedWei: () => deployed,
    onHalt: (r) => halts.push(r),
    health: () => {},
  })
}

describe('chain truth', () => {
  let db: Database.Database
  beforeEach(() => { db = new Database(':memory:'); db.exec(SCHEMA) })
  afterEach(() => { vi.restoreAllMocks() })

  it('keeps sampling balances while one backfill batch spans several ticks', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const insert = db.prepare(`INSERT INTO positions
      (id,token,curve,live,entry_block,spend_wei,proceeds_wei,buy_hash,exit_hash,exit_reason,buy_ok,closed)
      VALUES (?, '0xt','0xc',1,1000,'5000000000000000','4800000000000000',?,?,'time',1,1)`)
    insert.run(151, H(1), H(2))
    db.prepare("INSERT INTO chain_truth VALUES ('epoch_base_id','150')").run()
    const blocked = deferred()
    const started = deferred()
    const base = fakeRpc()
    const receipt = vi.fn(async (args: { hash: `0x${string}` }) => {
      if (args.hash === H(1)) { started.resolve(); await blocked.promise }
      return base.getTransactionReceipt(args)
    })
    const balance = vi.fn(base.getBalance)
    const realized = vi.fn()
    const k = new TruthKeeper(db, fakeRpc({ getBalance: balance, getTransactionReceipt: receipt }), {
      wallet: () => H(9).slice(0, 42), openCount: () => 0, deployedWei: () => 0n,
      onHalt: vi.fn(), health: vi.fn(), onRealized: realized,
    })
    k.boot()
    const first = k.tick()
    await started.promise
    try {
      insert.run(152, H(3), H(4))
      k.enqueue(152)
      for (let i = 0; i < 3; i++) { now += 30_000; await k.tick() }
      expect(receipt).toHaveBeenCalledTimes(1)
      expect(balance).toHaveBeenCalledTimes(4)
      expect(db.prepare('SELECT COUNT(*) n FROM balance').get()).toEqual({ n: 4 })
      expect(k.backlogSize()).toBe(2)
    } finally { blocked.resolve(); await first }
    expect(k.backlogSize()).toBe(1)
    expect(realized).toHaveBeenCalledTimes(1)
    const pnl = 4_800_000_000_000_000n - 5_000_000_000_000_000n - 4_000_000_000_000n
    expect(realized.mock.calls[0]![0]).toBe(pnl)
    now += 30_000
    await k.tick()
    expect(receipt).toHaveBeenCalledTimes(4)
    expect(k.backlogSize()).toBe(0)
    expect(realized).toHaveBeenCalledTimes(2)
    expect(realized.mock.calls[1]![0]).toBe(2n * pnl)
  })

  it('does not spend retry attempts on overlapping ticks and retries a failed batch', async () => {
    db.prepare(`INSERT INTO positions
      (id,token,curve,live,entry_block,spend_wei,buy_hash,exit_reason,buy_ok,closed)
      VALUES (151,'0xt','0xc',1,1000,'5000',?,'buy-reverted',0,1)`).run(H(1))
    db.prepare("INSERT INTO chain_truth VALUES ('epoch_base_id','150')").run()
    const blocked = deferred()
    const started = deferred()
    const base = fakeRpc()
    const receipt = vi.fn(base.getTransactionReceipt).mockImplementationOnce(async () => {
      started.resolve()
      await blocked.promise
      throw new Error('provider unavailable')
    })
    const k = keeper(db, fakeRpc({ getTransactionReceipt: receipt }))
    k.boot()
    const first = k.tick()
    await started.promise
    try {
      for (let i = 0; i < 6; i++) await k.tick()
      expect(receipt).toHaveBeenCalledTimes(1)
    } finally { blocked.resolve(); await first }
    expect(k.backlogSize()).toBe(1)
    await k.tick()
    expect(receipt).toHaveBeenCalledTimes(2)
    expect(k.backlogSize()).toBe(0)
    expect(db.prepare('SELECT onchain_pnl_wei p FROM positions WHERE id=151').get())
      .toEqual({ p: '-2000000000000' })
  })

  it('releases the batch guard when ledger publication throws', async () => {
    db.prepare("INSERT INTO chain_truth VALUES ('epoch_base_id','150')").run()
    const insert = db.prepare(`INSERT INTO positions
      (id,token,curve,live,entry_block,spend_wei,buy_hash,exit_reason,buy_ok,closed)
      VALUES (?,'0xt','0xc',1,1000,'5000',?,'buy-reverted',0,1)`)
    insert.run(151, H(1))
    const realized = vi.fn().mockImplementationOnce(() => { throw new Error('publication failed') })
    const k = new TruthKeeper(db, fakeRpc(), {
      wallet: () => '', openCount: () => 0, deployedWei: () => 0n,
      onHalt: vi.fn(), health: vi.fn(), onRealized: realized,
    })
    k.boot()
    await k.tick()
    insert.run(152, H(2))
    k.enqueue(152)
    await k.tick()
    expect(k.backlogSize()).toBe(0)
    expect(realized).toHaveBeenCalledTimes(2)
    expect(realized.mock.calls[1]![0]).toBe(-4_000_000_000_000n)
  })

  it('retains graduation preparation costs while open without charging them twice after close', () => {
    db.prepare(`INSERT INTO positions(id,live,closed,t_detect,burned_gas_wei,graduation_prep_gas_wei)
      VALUES(201,1,0,1000,'11','17')`).run()
    expect(rebuildRealized(db, 200).realized).toBe(-28n)
    expect(rebuildDayRealized(db, 200, 2000)).toBe(-28n)
    db.prepare("UPDATE positions SET closed=1,exit_at=1500,onchain_pnl_wei='-40' WHERE id=201").run()
    expect(rebuildRealized(db, 200).realized).toBe(-40n)
    expect(rebuildDayRealized(db, 200, 2000)).toBe(-40n)
  })

  it('epoch base pins to max id on a fresh db and never moves after', () => {
    db.prepare(`INSERT INTO positions (id,live,closed,pnl_wei) VALUES (150,1,1,'-999')`).run()
    const k = keeper(db, fakeRpc())
    k.boot()
    expect(k.epochBaseId).toBe(150) // the old pilot's losses stay outside the epoch
    db.prepare(`INSERT INTO positions (id,live,closed,pnl_wei) VALUES (200,1,1,'5')`).run()
    const k2 = keeper(db, fakeRpc())
    k2.boot()
    expect(k2.epochBaseId).toBe(150) // persisted, not recomputed
  })

  it('rebuildRealized prefers receipt truth and tracks the running peak', () => {
    // +30, then -50 (receipt says -40), then +5: realized -5, peak +30
    db.prepare(`INSERT INTO positions (id,live,closed,pnl_wei,onchain_pnl_wei) VALUES
      (151,1,1,'30',NULL), (152,1,1,'-50','-40'), (153,1,1,'5',NULL), (99,1,1,'-1000',NULL), (154,0,1,'77',NULL)`).run()
    const { realized, peak } = rebuildRealized(db, 150)
    expect(realized).toBe(-5n) // 30 - 40 + 5; id 99 (old epoch) and 154 (shadow) excluded
    expect(peak).toBe(30n)
  })

  it('both ledgers count the burned gas of positions still open, so a backfill drain cannot forgive it', () => {
    // review 2026-09-06: risk.burned() charged the live ledger per revert, then the next
    // receipt landing re-seeded both ledgers from CLOSED rows only and the charge vanished,
    // for exactly the parked, still-reverting position the charge exists to expose
    const NOW = Date.UTC(2026, 8, 6, 14, 0, 0)
    const DAY = Math.floor(NOW / 86_400_000) * 86_400_000
    // 151 closed today +30; 152 open, detected today, 7 burned; 153 open, detected yesterday,
    // 5 burned; 154 shadow (out); 99 old epoch (out)
    db.prepare(`INSERT INTO positions (id,live,closed,pnl_wei,exit_at,burned_gas_wei,t_detect) VALUES
      (151,1,1,'30',?,NULL,?), (152,1,0,NULL,NULL,'7',?), (153,1,0,NULL,NULL,'5',?),
      (154,0,0,NULL,NULL,'999',?), (99,1,0,NULL,NULL,'999',?)`)
      .run(DAY + 1000, DAY + 500, DAY + 600, DAY - 1000, DAY + 700, DAY + 800)
    const r = rebuildRealized(db, 150)
    expect(r.realized).toBe(30n - 7n - 5n)
    expect(r.peak).toBe(30n) // burned gas lowers realized, never the peak, like the live charge
    expect(rebuildDayRealized(db, 150, NOW)).toBe(30n - 7n) // yesterday's open row burned yesterday
  })

  it('rebuildDayRealized counts today only, and does not care which arm traded', () => {
    const NOW = Date.UTC(2026, 7, 27, 14, 0, 0)
    const DAY = Math.floor(NOW / 86_400_000) * 86_400_000
    db.prepare(`INSERT INTO positions (id,live,closed,pnl_wei,onchain_pnl_wei,exit_at) VALUES
      (151,1,1,'30',NULL,?), (152,1,1,'-50','-40',?), (153,1,1,'7',NULL,?),
      (154,1,1,'999',NULL,?), (155,1,1,'888',NULL,?), (99,1,1,'-1000',NULL,?), (156,0,1,'77',NULL,?)`)
      .run(DAY, DAY + 3_600_000, DAY + 86_399_999, DAY - 1, DAY + 86_400_000, DAY, DAY)
    // 30 - 40 + 7. Yesterday (154), tomorrow (155), the old epoch (99) and the shadow row
    // (156) are all out, and receipt truth wins over the modelled number exactly as the
    // epoch rebuild does -- the two ledgers must never disagree about what a loss is.
    expect(rebuildDayRealized(db, 150, NOW)).toBe(-3n)
  })

  it('boot seeds BOTH ledgers, so a restart cannot re-arm the kill switch', () => {
    // The 2026-08-18 bug: seeding neither meant every restart handed the bot a fresh stop
    // to spend. The daily cap that used to be tested here was deleted on 2026-09-07; the
    // day ledger survives because the dashboard reads it, and the epoch ledger is what the
    // stop compares, so the restart-safety property is asserted on the stop itself.
    const NOW = Date.UTC(2026, 7, 27, 14, 0, 0)
    const DAY = Math.floor(NOW / 86_400_000) * 86_400_000
    const over = -BigInt(Math.round(RISK.maxDrawdownEth * 1.1 * 1e18))
    // pin the epoch first: on a FRESH db boot() sets the base to MAX(id) so ancient rows
    // cannot leak into new accounting, and that would put this row on the wrong side of it
    db.prepare(`INSERT INTO chain_truth (key,value) VALUES ('epoch_base_id','150')`).run()
    db.prepare(`INSERT INTO positions (id,live,closed,pnl_wei,exit_at) VALUES (151,1,1,?,?)`)
      .run(over.toString(), DAY + 3_600_000)
    const seeded = keeper(db, fakeRpc()).boot(NOW)
    const r = new RiskManager(BigInt(1e17), () => NOW)
    r.seedLedger(seeded, NOW)
    expect(r.halted).toBe(true)
    expect(r.haltKind).toBe('drawdown')
    // and today's number is restored too, for the page rather than for a stop
    expect(r.dayRealizedPnlWei).toBe(over)
  })

  it('records the baseline exactly once, and only while flat', async () => {
    const rpc = fakeRpc()
    const halts: string[] = []
    const kOpen = keeper(db, rpc, 3, halts)
    kOpen.boot()
    await kOpen.tick()
    expect(db.prepare(`SELECT value FROM chain_truth WHERE key='baseline_wei'`).get()).toBeUndefined()
    const kFlat = keeper(db, rpc, 0, halts)
    await kFlat.tick()
    const base = db.prepare(`SELECT value FROM chain_truth WHERE key='baseline_wei'`).get() as { value: string }
    expect(base.value).toBe('79600000000000000')
    // a second flat sample must not overwrite it
    db.prepare(`UPDATE chain_truth SET value='1' WHERE key='baseline_wei'`).run()
    const kAgain = keeper(db, rpc, 0, halts)
    await kAgain.tick()
    expect((db.prepare(`SELECT value FROM chain_truth WHERE key='baseline_wei'`).get() as { value: string }).value).toBe('1')
    expect(halts).toEqual([])
  })

  it('records what the open book cost, so the series is net worth not the bare wallet', async () => {
    // the wallet dips by the deployed size the moment a buy lands; the dip is only
    // real if the tokens are worth nothing, and they are not
    const k = keeper(db, fakeRpc(), 2, [], 10_000_000_000_000_000n)
    await k.tick()
    const row = db.prepare('SELECT wei, open_n, deployed_wei FROM balance').get() as any
    expect(row.open_n).toBe(2)
    expect(row.deployed_wei).toBe('10000000000000000')
    expect(BigInt(row.wei) + BigInt(row.deployed_wei)).toBe(89_600_000_000_000_000n)
  })

  it('chain drawdown halts from peak flat balance, never while positions are open', async () => {
    // peak chosen so the gap to the fake wallet balance (0.0796 ETH) is 115% of whatever
    // the stop currently is, rather than a literal that dies when the limit moves
    const peakWei = 79_600_000_000_000_000n
      + BigInt(Math.round(RISK.maxDrawdownEth * 1.15 * 1e18))
    db.prepare(`INSERT INTO chain_truth VALUES ('peak_flat_wei',?)`).run(peakWei.toString())
    const halts: string[] = []
    const kOpen = keeper(db, fakeRpc(), 2, halts)
    await kOpen.tick()
    expect(halts).toEqual([]) // deployed capital is not a drawdown
    const kFlat = keeper(db, fakeRpc(), 0, halts)
    await kFlat.tick()
    expect(halts.length).toBe(1)
    expect(halts[0]).toContain('chain drawdown')
  })

  it('backfills a normal close from both receipts', async () => {
    db.prepare(`INSERT INTO positions (id,token,curve,live,entry_block,spend_wei,proceeds_wei,buy_hash,exit_hash,exit_reason,buy_ok,closed)
      VALUES (151,'0xt','0xc',1,1000,'5000000000000000','4800000000000000',?,?,'time',1,1)`).run(H(1), H(2))
    db.prepare(`INSERT INTO chain_truth VALUES ('epoch_base_id','150')`).run()
    const k = keeper(db, fakeRpc())
    k.boot()
    await k.tick()
    const r = db.prepare(
      'SELECT gas_wei, onchain_pnl_wei, fill_block, buy_gas_used, sell_gas_used FROM positions WHERE id=151',
    ).get() as any
    // 2 legs x 100k gas x 0.02 gwei = 4e12 wei
    expect(r.gas_wei).toBe('4000000000000')
    expect(r.onchain_pnl_wei).toBe(String(4_800_000_000_000_000n - 5_000_000_000_000_000n - 4_000_000_000_000n))
    expect(r.fill_block).toBe(1017)
    // RAW units per leg, which is the only form that can be compared to a gas LIMIT
    expect(r.buy_gas_used).toBe(100_000)
    expect(r.sell_gas_used).toBe(100_000)
  })

  it('keeps the gas of the reverted sells on the way to a close', async () => {
    // reconcileSell writes the running total onto the row as each revert is seen. The
    // backfill only fetches the two landed legs, so without this the rebuild forgave about
    // $6 a day of real gas and the wallet ran $85 behind the books (2026-09-06).
    db.prepare(`INSERT INTO positions (id,token,curve,live,entry_block,spend_wei,proceeds_wei,buy_hash,exit_hash,exit_reason,buy_ok,closed,burned_gas_wei)
      VALUES (151,'0xt','0xc',1,1000,'5000000000000000','4800000000000000',?,?,'stop',1,1,'7000000000000'),
             (152,'0xu','0xd',1,1000,'5000000000000000','0',?,NULL,'stranded-graduated',1,1,'3000000000000')`).run(H(1), H(2), H(3))
    db.prepare(`INSERT INTO chain_truth VALUES ('epoch_base_id','150')`).run()
    const k = keeper(db, fakeRpc())
    k.boot()
    await k.tick()
    const r = db.prepare('SELECT gas_wei, onchain_pnl_wei FROM positions WHERE id=151').get() as any
    expect(r.gas_wei).toBe('11000000000000') // 4e12 from the two receipts + 7e12 burned
    const pnl151 = 4_800_000_000_000_000n - 5_000_000_000_000_000n - 11_000_000_000_000n
    expect(r.onchain_pnl_wei).toBe(String(pnl151))
    // a stranded bag: one landed leg (the buy), no sell, and its reverted attempts still count
    const s = db.prepare('SELECT gas_wei, onchain_pnl_wei FROM positions WHERE id=152').get() as any
    expect(s.gas_wei).toBe('5000000000000')
    const pnl152 = -5_000_000_000_000_000n - 5_000_000_000_000n
    expect(s.onchain_pnl_wei).toBe(String(pnl152))
    // and the epoch ledger the drawdown stop is rebuilt from sees both
    expect(rebuildRealized(db, 150).realized).toBe(pnl151 + pnl152)
  })

  it('a reverted buy costs only its real gas, and shadow rows are skipped', async () => {
    db.prepare(`INSERT INTO positions (id,token,curve,live,entry_block,spend_wei,buy_hash,exit_hash,exit_reason,buy_ok,closed)
      VALUES (151,'0xt','0xc',1,1000,'5000000000000000',?, '', 'buy-reverted',0,1),
             (152,'0xs','0xd',0,1000,'5000000000000000',?, '', 'time',1,1)`).run(H(3), H(4))
    db.prepare(`INSERT INTO chain_truth VALUES ('epoch_base_id','150')`).run()
    const rpc = fakeRpc()
    const k = keeper(db, rpc)
    k.boot()
    await k.tick()
    const r = db.prepare('SELECT onchain_pnl_wei, buy_gas_used, sell_gas_used FROM positions WHERE id=151').get() as any
    expect(r.onchain_pnl_wei).toBe('-2000000000000') // one leg of real gas, no capital
    expect(r.buy_gas_used).toBe(100_000)
    expect(r.sell_gas_used).toBeNull() // there was no sell leg to measure
    const shadow = db.prepare('SELECT onchain_pnl_wei FROM positions WHERE id=152').get() as any
    expect(shadow.onchain_pnl_wei).toBeNull()
    expect(rpc.calls.filter((c) => c.startsWith('receipt')).length).toBe(1) // never fetched the shadow hash
  })

  it('repairs a recovered-flat row from the on-chain sell log', async () => {
    db.prepare(`INSERT INTO positions (id,token,curve,live,entry_block,spend_wei,proceeds_wei,buy_hash,exit_hash,exit_reason,buy_ok,closed,pnl_wei)
      VALUES (151,'0xt','0xc',1,1000,'5000000000000000','0',?, '', 'recovered-flat',1,1,'0')`).run(H(5))
    db.prepare(`INSERT INTO chain_truth VALUES ('epoch_base_id','150')`).run()
    const quoteOut = 4_600_000_000_000_000n
    const rpc = fakeRpc({
      request: async ({ method }) => {
        if (method === 'eth_blockNumber') return '0x3e8'
        // CurveSell data: (tokensIn, quoteOut, fee, tax)
        return [{ data: '0x' + '1'.padStart(64, '0') + quoteOut.toString(16).padStart(64, '0') + ''.padStart(128, '0'), transactionHash: H(6) }]
      },
    })
    const k = keeper(db, rpc)
    k.boot()
    await k.tick()
    const r = db.prepare('SELECT onchain_pnl_wei, sell_gas_used FROM positions WHERE id=151').get() as any
    // proceeds 0.0046 - spend 0.005 - 2 legs of gas
    expect(r.onchain_pnl_wei).toBe(String(quoteOut - 5_000_000_000_000_000n - 4_000_000_000_000n))
    // the sell was found by log rather than by hash, and still gets measured
    expect(r.sell_gas_used).toBe(100_000)
  })

  /**
   * recovery.ts closes a row this way when the send failed AND no tokens ever arrived. It
   * has a buy_hash that was never mined, so there is no receipt to fetch and no sell to
   * hunt for. Falling through would compute 0 - spend - gas and book the whole trade size
   * as a realised loss straight into the drawdown kill switch.
   */
  it('a never-mined buy books zero, not the trade size', async () => {
    db.prepare(`INSERT INTO positions (id,token,curve,live,entry_block,spend_wei,buy_hash,exit_reason,buy_ok,closed,pnl_wei)
      VALUES (151,'0xt','0xc',1,1000,'5000000000000000',?,'buy-never-mined',0,1,'0')`).run(H(7))
    db.prepare(`INSERT INTO chain_truth VALUES ('epoch_base_id','150')`).run()
    const rpc = fakeRpc({
      // a tx that never landed has no receipt, and asking for one throws forever
      getTransactionReceipt: async () => { throw new Error('not found') },
    })
    const k = keeper(db, rpc)
    k.boot()
    await k.tick()
    const r = db.prepare('SELECT onchain_pnl_wei, gas_wei FROM positions WHERE id=151').get() as any
    expect(r.onchain_pnl_wei).toBe('0')
    expect(r.gas_wei).toBe('0')
    // and it must not have gone looking, or a poison row wedges the backfill queue
    expect(rpc.calls.filter((c) => c.startsWith('receipt')).length).toBe(0)
  })
})

describe('RiskManager.book (2026-09-06)', () => {
  it('books a loss into both ledgers without releasing capacity that was never reserved', () => {
    const r = new RiskManager(BigInt(4e16), () => Date.UTC(2026, 8, 6, 14))
    r.reserve('0xa', BigInt(1e16))                    // position A resumed at boot
    r.book(-BigInt(1e16))                             // position B stranded at boot
    expect(r.openCount).toBe(1)                       // A is still open
    expect(r.deployedWei).toBe(BigInt(1e16))          // and still deployed
    expect(r.realizedPnlWei).toBe(-BigInt(1e16))
    expect(r.dayRealizedPnlWei).toBe(-BigInt(1e16))
  })
})
