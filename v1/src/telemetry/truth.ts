/**
 * Chain truth. Everything in here is either read from the chain or recomputed from
 * receipts; nothing is modeled. Three jobs:
 *
 *  1. Balance poll: one eth_getBalance per housekeeping tick, stored raw. The wallet
 *     card renders THIS series, not the simulated equity.
 *  2. Baseline + chain drawdown: the epoch baseline is recorded once while the book is
 *     flat, then every flat sample ratchets peak_flat_wei; the kill switch compares
 *     peak to current, in wei, against MAX_DRAWDOWN_ETH. Flat-only on purpose: deployed
 *     capital depresses the balance by up to the whole bankroll, which would false-trip
 *     the stop instantly.
 *  3. Receipt backfill: after a position closes, fetch the real receipts and write
 *     gas_wei / onchain_pnl_wei / fill_block back onto the row. The bot's own pnl_wei
 *     was charging modeled gas; rows 151-174 overstated cost 71x before this existed.
 *
 * Everything runs on the 30s housekeeping tick, throttled, error-tolerant: the public
 * RPC rate-limits (53 eth_getLogs 429s/hour from our own poller), so every call here
 * catches and retries next tick rather than ever throwing into the bot.
 */
import { ensureGraduationSchema } from '../graduation.js'
import { graduatedProceeds, type PoolKey } from '../tx/graduated.js'
import type Database from 'better-sqlite3'
import { EVENT_TOPICS, logWord } from '../abi.js'
import { truthGet, truthSet } from './db.js'
import { newEpoch, CHAIN_KEYS } from './epoch.js'
import type { Hex } from 'viem'
import { RISK } from '../config.js'
import { ensureApprovalSchema } from './approvals.js'

/** minimal structural slice of viem's PublicClient, so tests can fake it */
export type TruthRpc = {
  getBalance(args: { address: Hex }): Promise<bigint>
  getTransactionReceipt(args: { hash: Hex }): Promise<{ gasUsed: bigint; effectiveGasPrice: bigint; blockNumber: bigint; status: string; logs?: readonly { address: string; topics: readonly string[]; data: string }[] }>
  request(args: { method: string; params: unknown[] }): Promise<unknown>
}

/** ~2.5 min of 30s ticks: long enough for any RPC wobble, short enough not to wedge */
const MAX_BACKFILL_TRIES = 5

export type PositionRow = {
  id: number; token: string; curve: string; live: number; entry_block: number
  spend_wei: string; proceeds_wei: string | null; buy_hash: string | null
  exit_hash: string | null; exit_reason: string | null; buy_ok: number
  burned_gas_wei: string | null
  graduation_prep_gas_wei?: string | null
}

/**
 * Recompute realized P&L and its running peak for the current epoch from the DB.
 * Fixes the old behavior where both reset to zero on every restart and the $75
 * kill switch silently re-armed.
 */
export function rebuildRealized(db: Database.Database, epochBaseId: number): { realized: bigint; peak: bigint } {
  const rows = db.prepare(
    `SELECT COALESCE(onchain_pnl_wei, pnl_wei, '0') pnl FROM positions
     WHERE id > ? AND live = 1 AND closed = 1 ORDER BY exit_at, id`,
  ).all(epochBaseId) as Array<{ pnl: string }>
  let realized = 0n
  let peak = 0n
  for (const r of rows) {
    realized += BigInt(r.pnl)
    if (realized > peak) peak = realized
  }
  // Gas already burned by the reverted sells of positions still OPEN. risk.burned() charged
  // it live; rebuilding from closed rows alone forgave it at every backfill drain and every
  // restart, exactly for the parked, still-reverting position it exists to expose. It lowers
  // realized and never the peak, the same way the live charge does.
  realized -= openBurned(db, epochBaseId)
  return { realized, peak }
}

/** burned_gas_wei summed over the epoch's open live rows (optionally only those detected in [from, to)) */
function openBurned(db: Database.Database, epochBaseId: number, from?: number, to?: number): bigint {
  // Read-only tools can rebuild an older snapshot before its next schema migration.
  const columns = db.prepare('PRAGMA table_info(positions)').all() as Array<{ name: string }>
  const prep = columns.some(c => c.name === 'graduation_prep_gas_wei') ? 'graduation_prep_gas_wei' : 'NULL'
  const rows = (from === undefined
    ? db.prepare(`SELECT burned_gas_wei b,${prep} g FROM positions WHERE id > ? AND live = 1 AND closed = 0 AND (burned_gas_wei IS NOT NULL OR ${prep} IS NOT NULL)`).all(epochBaseId)
    : db.prepare(`SELECT burned_gas_wei b,${prep} g FROM positions WHERE id > ? AND live = 1 AND closed = 0 AND (burned_gas_wei IS NOT NULL OR ${prep} IS NOT NULL) AND t_detect >= ? AND t_detect < ?`).all(epochBaseId, from, to)
  ) as Array<{ b: string | null; g: string | null }>
  let sum = 0n
  for (const r of rows) sum += BigInt(r.b ?? 0) + BigInt(r.g ?? 0)
  return sum
}

/**
 * TODAY's realized P&L (UTC), for the daily cap.
 *
 * Deliberately the same predicate as rebuildRealized above -- epoch-scoped, live only,
 * receipt truth preferred over the modelled number -- plus a UTC-day window on exit_at, so
 * the two ledgers can never disagree about what a realised loss is. Bookkeeping closes are
 * IN for the same reason they are in above: a reverted buy burns real gas, and a limit
 * denominated in money counts money rather than trades.
 *
 * Windowed on exit_at rather than on id: the cap asks what today COST, and a position
 * opened yesterday and closed today lost its money today.
 *
 * NOT filtered on positions.arm. The cap is account-level by design; see RISK for why a
 * per-arm cap would break the paired comparison it sits alongside.
 */
export function rebuildDayRealized(db: Database.Database, epochBaseId: number, nowMs: number): bigint {
  const from = Math.floor(nowMs / 86_400_000) * 86_400_000
  const rows = db.prepare(
    `SELECT COALESCE(onchain_pnl_wei, pnl_wei, '0') pnl FROM positions
     WHERE id > ? AND live = 1 AND closed = 1 AND exit_at >= ? AND exit_at < ?`,
  ).all(epochBaseId, from, from + 86_400_000) as Array<{ pnl: string }>
  let day = 0n
  for (const r of rows) day += BigInt(r.pnl)
  // plus the burned gas of today's still-open positions, for the reason given in rebuildRealized
  return day - openBurned(db, epochBaseId, from, from + 86_400_000)
}

export class TruthKeeper {
  private pending = new Set<number>()
  private backfillRunning = false
  /** consecutive failures per row, so an unresolvable receipt cannot block the queue */
  private tries = new Map<number, number>()
  private lastSampleAt = 0
  epochBaseId = 0

  constructor(
    private readonly db: Database.Database,
    private readonly rpc: TruthRpc,
    private readonly opts: {
      onReceipt?: (hash: string, receipt: unknown) => void
      wallet: () => string
      openCount: () => number
      /** cost basis of the open book, so the wallet series can be read as net worth */
      deployedWei: () => bigint
      onHalt: (reason: string) => void
      health: (component: string, ok: boolean, detail: string) => void
      /** called after a backfill batch so the in-memory ledger follows receipt truth */
      onRealized?: (realized: bigint, peak: bigint, day: bigint) => void
    },
  ) { ensureApprovalSchema(db); ensureGraduationSchema(db) }

  private get(key: string): string | null {
    return truthGet(this.db, key)
  }

  private set(key: string, value: string): void {
    truthSet(this.db, key, value)
  }

  /**
   * Boot: pin the epoch, honour REBASELINE, queue the backfill backlog.
   * A missing epoch base means a fresh database: the epoch starts at the current
   * max id so ancient rows can never leak into the new accounting.
   */
  /**
   * Record the strategy the bot is running, so out-of-process graders (recon.py) replay
   * the same rule instead of whatever they were written against. Overwritten every boot.
   */
  publishStrategy(spec: Record<string, string | number>): void {
    this.set('strategy_json', JSON.stringify(spec))
  }

  boot(now: number = Date.now()): { realized: bigint; peak: bigint; day: bigint } {
    if (process.env.REBASELINE === '1') {
      // the operator moved funds; the old baseline and peak are meaningless now
      for (const k of CHAIN_KEYS) {
        this.db.prepare('DELETE FROM chain_truth WHERE key=?').run(k)
      }
      console.log('REBASELINE=1: baseline and peak cleared, will re-record at the next flat sample')
    }
    const base = this.get('epoch_base_id')
    if (base !== null) {
      this.epochBaseId = Number(base)
    } else {
      const m = this.db.prepare('SELECT COALESCE(MAX(id),0) m FROM positions').get() as { m: number }
      this.epochBaseId = m.m
      this.set('epoch_base_id', String(this.epochBaseId))
    }
    const backlog = this.db.prepare(
      `SELECT id FROM positions WHERE id > ? AND live = 1 AND closed = 1 AND
       (onchain_pnl_wei IS NULL OR EXISTS (SELECT 1 FROM approval_transactions a
         WHERE a.position_id=positions.id AND a.rejected=0 AND a.gas_wei IS NULL))`,
    ).all(this.epochBaseId) as Array<{ id: number }>
    for (const r of backlog) this.pending.add(r.id)
    return { ...rebuildRealized(this.db, this.epochBaseId), day: rebuildDayRealized(this.db, this.epochBaseId, now) }
  }

  /**
   * Move the epoch in-process and hand back the ledger it leaves behind (zero, by
   * construction). The drawdown stop's self-lift calls this; see strategy/risk.ts
   * liftOnSignal for why the lift and the reset are one action.
   *
   * SYNCHRONOUS on purpose, and epochBaseId moves before it returns. housekeeping() is
   * async and a slow getGasPrice can overlap two ticks, so a backfill drain finishing
   * between the reset and the seed would otherwise call onRealized with the OLD base and
   * re-seed the very loss we just closed the books on -- which would re-place the halt
   * one tick after lifting it.
   *
   * Throws when the database still holds an open row, which is a normal transient right
   * after a close (telemetry/db.ts queues closePosition onto setImmediate) and a permanent
   * state after a boot recovery leaves a row it could not resolve. The caller retries and,
   * if it persists, says so where a person will see it.
   */
  openEpoch(why: string, now: number = Date.now()): { realized: bigint; peak: bigint; day: bigint } {
    const r = newEpoch(this.db, why, now, true)
    this.epochBaseId = r.now
    return { ...rebuildRealized(this.db, this.epochBaseId), day: rebuildDayRealized(this.db, this.epochBaseId, now) }
  }

  enqueue(id: number): void {
    this.pending.add(id)
  }

  backlogSize(): number {
    return this.pending.size
  }

  /** One housekeeping tick: a balance sample, then up to five receipt backfills. */
  async tick(): Promise<void> {
    await this.sampleBalance().catch(() => {})
    await this.pumpBackfill().catch(() => {})
  }

  private async sampleBalance(): Promise<void> {
    const wallet = this.opts.wallet()
    if (!wallet) return
    const now = Date.now()
    if (now - this.lastSampleAt < 25_000) return
    this.lastSampleAt = now
    const wei = await this.rpc.getBalance({ address: wallet as Hex })
    const openN = this.opts.openCount()
    // record what the open book cost alongside the raw balance. Both are real ETH
    // amounts - the wallet, and what we actually paid - so wei+deployed stays chain
    // truth. A curve quote would be a model and this table promises not to be one.
    const deployed = this.opts.deployedWei()
    this.db.prepare('INSERT OR REPLACE INTO balance (at,wei,open_n,deployed_wei) VALUES (?,?,?,?)')
      .run(now, wei.toString(), openN, deployed.toString())
    this.db.prepare('DELETE FROM balance WHERE at < ?').run(now - 7 * 86_400_000)
    if (openN !== 0) return // deployed capital depresses the balance; not a flat sample

    if (this.get('baseline_wei') === null) {
      const block = await this.rpc.request({ method: 'eth_blockNumber', params: [] }) as string
      this.set('baseline_wei', wei.toString())
      this.set('baseline_block', String(parseInt(block, 16)))
      this.set('baseline_at', String(now))
      console.log(`chain baseline recorded: ${Number(wei) / 1e18} ETH`)
    }
    const peak = BigInt(this.get('peak_flat_wei') ?? '0')
    if (wei > peak) this.set('peak_flat_wei', wei.toString())
    const ref = wei > peak ? wei : peak
    // Wei against wei since 2026-09-07, the same bound and the same unit as the session
    // stop in risk.ts checkDrawdown. Both used to convert this wei ledger up to dollars to
    // meet a dollar limit, which put a stale ETHUSD in front of two kill switches.
    const downWei = ref - wei
    if (downWei >= BigInt(Math.round(RISK.maxDrawdownEth * 1e18))) {
      const eth = (Number(downWei) / 1e18).toFixed(4)
      const dollars = ((Number(downWei) / 1e18) * RISK.ethUsd).toFixed(0)
      this.opts.onHalt(`chain drawdown ${eth} ETH from peak flat balance ($${dollars})`)
    }
  }

  private async pumpBackfill(): Promise<void> {
    // A slow historical lookup can outlive the next tick. Balance sampling must
    // continue, but a second batch must not repeat its reads or spend its retries.
    if (this.backfillRunning) return
    this.backfillRunning = true
    try {
      await this.drainBackfill()
    } finally {
      this.backfillRunning = false
    }
  }

  private async drainBackfill(): Promise<void> {
    const batch = [...this.pending].slice(0, 5)
    // Whether any row actually got written, not how the set changed size. settleExit can
    // enqueue() during the awaited receipt calls below, so a pass that drained two rows
    // and gained two would compare equal and silently skip the re-seed - leaving the
    // drawdown kill switch on modeled-gas numbers exactly when it just got real ones.
    let drained = false
    for (const id of batch) {
      const row = this.db.prepare(
        'SELECT id,token,curve,live,entry_block,spend_wei,proceeds_wei,buy_hash,exit_hash,exit_reason,buy_ok,burned_gas_wei,graduation_prep_gas_wei FROM positions WHERE id=?',
      ).get(id) as PositionRow | undefined
      if (!row || row.live !== 1) { this.pending.delete(id); this.tries.delete(id); continue } // shadow hashes were never broadcast
      try {
        const done = await this.backfillOne(row)
        if (done) { this.pending.delete(id); this.tries.delete(id); drained = true }
      } catch (e) {
        // A row whose buy_hash was never actually mined (a transport failure that still
        // consumed the nonce) throws here forever. The batch is the FIRST five of an
        // insertion-ordered set, so a poison prefix would wedge receipt truth for every
        // trade behind it - and receipt truth is what re-seeds the drawdown kill switch.
        // Give up after a few rounds and say so, rather than blocking silently.
        const n = (this.tries.get(id) ?? 0) + 1
        this.tries.set(id, n)
        if (n >= MAX_BACKFILL_TRIES) {
          this.pending.delete(id)
          this.tries.delete(id)
          drained = true
          this.opts.health('backfill', false, `position ${id} gave up after ${n} tries: ${String(e).slice(0, 60)}`)
        }
      }
    }
    // The row's booked pnl_wei just changed under the risk manager's feet: at boot it
    // was seeded from pnl_wei (which for pre-fix rows carried modeled gas), so without
    // this the kill switch keeps running on stale numbers. Recomputing from the DB is
    // idempotent and cannot drift the way applying deltas would.
    if (drained && this.opts.onRealized) {
      const r = rebuildRealized(this.db, this.epochBaseId)
      this.opts.onRealized(r.realized, r.peak, rebuildDayRealized(this.db, this.epochBaseId, Date.now()))
    }
  }

  /** returns true when the row is final (either written, or permanently unknowable) */
  private async backfillOne(row: PositionRow): Promise<boolean> {
    const approvals = this.db.prepare('SELECT hash,gas_wei,rejected FROM approval_transactions WHERE position_id=?')
      .all(row.id) as Array<{ hash: string; gas_wei: string | null; rejected: number }>
    let approvalGas = 0n
    for (const a of approvals) {
      if (a.rejected) continue
      if (a.gas_wei === null) {
        const rc = await this.rpc.getTransactionReceipt({ hash: a.hash as Hex })
        try { this.opts.onReceipt?.(a.hash, rc) } catch { /* capture cannot interrupt accounting */ }
        a.gas_wei = (rc.gasUsed * rc.effectiveGasPrice).toString()
        this.db.prepare('UPDATE approval_transactions SET gas_wei=? WHERE hash=?').run(a.gas_wei, a.hash)
      }
      // Reverted approvals burn gas too. The receipt status does not change the cost.
      approvalGas += BigInt(a.gas_wei)
    }
    if (approvals.length) {
      this.db.prepare('UPDATE positions SET approval_gas_wei=? WHERE id=?').run(approvalGas.toString(), row.id)
    }
    // The send failed and no tokens ever arrived (recovery.ts). There is no receipt to
    // fetch, no sell to hunt for, and above all no capital was deployed: falling through
    // would compute 0 - spend - gas and book the whole trade size as a realised loss into
    // the drawdown kill switch. Zero it and stop.
    if (row.exit_reason === 'buy-never-mined') {
      this.db.prepare('UPDATE positions SET gas_wei=?, onchain_pnl_wei=? WHERE id=?')
        .run(approvalGas.toString(), (-approvalGas).toString(), row.id)
      return true
    }
    let gas = approvalGas
    let fillBlock: number | null = null
    // raw units, kept separate from `gas` (a cost, summed over every leg) because a limit
    // that is too tight is only visible per leg. See GAS.limits in config.
    let buyGasUsed: number | null = null
    let sellGasUsed: number | null = null
    if (row.buy_hash) {
      const rc = await this.rpc.getTransactionReceipt({ hash: row.buy_hash as Hex })
        try { this.opts.onReceipt?.(row.buy_hash, rc) } catch { /* capture cannot interrupt accounting */ }
      gas += rc.gasUsed * rc.effectiveGasPrice
      fillBlock = Number(rc.blockNumber)
      buyGasUsed = Number(rc.gasUsed)
    }
    let proceeds = BigInt(row.proceeds_wei ?? '0')
    let spend = BigInt(row.spend_wei)
    if (row.exit_reason === 'buy-reverted') {
      proceeds = 0n; spend = 0n // the buy reverted: no capital deployed, only gas burned
    } else if (row.exit_hash && row.exit_hash.length === 66) {
      const rc = await this.rpc.getTransactionReceipt({ hash: row.exit_hash as Hex })
        try { this.opts.onReceipt?.(row.exit_hash, rc) } catch { /* capture cannot interrupt accounting */ }
      gas += rc.gasUsed * rc.effectiveGasPrice
      sellGasUsed = Number(rc.gasUsed)
      if (row.exit_reason === 'graduated-swap') {
        if (rc.status !== 'success') throw new Error('graduated sale is not confirmed')
        const route = this.db.prepare('SELECT pool_key FROM graduation_exits WHERE position_id=?').get(row.id) as { pool_key: string } | undefined
        if (!route) throw new Error('graduated sale is missing its pool evidence')
        proceeds = graduatedProceeds(rc.logs ?? [], JSON.parse(route.pool_key) as PoolKey, this.opts.wallet())
        this.db.prepare('UPDATE positions SET proceeds_wei=? WHERE id=?').run(proceeds.toString(), row.id)
      }
    } else if (row.exit_reason === 'recovered-flat') {
      // the exit event was missed while the bot was down and the row was booked at
      // pnl 0. the sell is still on chain: find our CurveSell on this curve.
      const found = await this.findRecoveredSell(row)
      if (found === null) {
        this.opts.health('backfill', false, `${row.token.slice(0, 12)} recovered-flat: no sell found on chain`)
        return true // permanently unknowable; stop retrying
      }
      proceeds = found.proceeds
      gas += found.gas
      sellGasUsed = found.gasUsed
    }
    // What the reverted sells on the way to this outcome cost (bot.ts reconcileSell keeps
    // the running total on the row). Not a receipt this worker fetches, and leaving it out
    // is how the wallet ran $85 behind the books by 2026-09-06: risk.burned() charged the
    // live ledger, then every rebuild from onchain_pnl_wei forgave it.
    gas += BigInt(row.burned_gas_wei ?? '0') + BigInt(row.graduation_prep_gas_wei ?? '0')
    const pnl = proceeds - spend - gas
    this.db.prepare(
      'UPDATE positions SET gas_wei=?, onchain_pnl_wei=?, fill_block=?, buy_gas_used=?, sell_gas_used=? WHERE id=?',
    ).run(gas.toString(), pnl.toString(), fillBlock, buyGasUsed, sellGasUsed, row.id)
    return true
  }

  private async findRecoveredSell(
    row: PositionRow,
  ): Promise<{ proceeds: bigint; gas: bigint; gasUsed: number } | null> {
    const wallet = this.opts.wallet().toLowerCase()
    const from = row.entry_block
    const logs = await this.rpc.request({
      method: 'eth_getLogs',
      params: [{
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + (from + 20_000).toString(16), // ~33 min; a later manual sell is out of scope
        address: row.curve,
        topics: [EVENT_TOPICS.CurveSell, '0x' + wallet.slice(2).padStart(64, '0')],
      }],
    }) as Array<{ data: string; transactionHash: string }>
    const log = logs?.[0]
    if (!log) return null
    const proceeds = logWord(log.data, 1) // sell data = (tokensIn, quoteOut, fee, tax)
    const rc = await this.rpc.getTransactionReceipt({ hash: log.transactionHash as Hex })
        try { this.opts.onReceipt?.(log.transactionHash, rc) } catch { /* capture cannot interrupt accounting */ }
    return { proceeds, gas: rc.gasUsed * rc.effectiveGasPrice, gasUsed: Number(rc.gasUsed) }
  }
}
