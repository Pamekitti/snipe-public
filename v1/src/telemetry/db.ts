/**
 * Telemetry. Every decision the bot makes is recorded whether or not it was broadcast,
 * because the shadow run is only worth as much as what we can reconstruct from it.
 *
 * Writes are queued and drained on setImmediate so the exit path never touches disk.
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { ensureGraduationSchema } from '../graduation.js'
import { ensureApprovalSchema } from './approvals.js'

/**
 * Closures that are bookkeeping, not round trips. They must stay out of every
 * return-on-turnover, win-rate and trade-count number, because none of them put capital at
 * risk on a curve.
 *
 * A LIST, not eight string literals. The `trades` view below already carries the scar of
 * two offline consumers re-deriving this predicate and drifting, and the list grew again on
 * 2026-08-19 ('buy-never-mined'): a new reason had to be added in five TypeScript queries
 * at once or it would have silently counted as a flat trade and diluted the win rate.
 *
 * scripts/recon.py and scripts/livewatch.cjs cannot import this. They carry their own copy
 * with a pointer back here; keep all three in step, or query the `trades` view instead,
 * which is what it exists for.
 */
export const NON_TRADE_REASONS = ['recovered-flat', 'buy-reverted', 'buy-never-mined'] as const

/** the same list as a SQL tuple, for interpolation into a NOT IN / IN clause */
export const NON_TRADE_SQL = NON_TRADE_REASONS.map((r) => `'${r}'`).join(',')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS launches (
  token TEXT PRIMARY KEY, curve TEXT, deployer TEXT, pair_token TEXT,
  block INTEGER, launched_at INTEGER, creator_tax_bps INTEGER, dev_buy_wei TEXT,
  detected_at INTEGER, detect_source TEXT, passed INTEGER, reject_reason TEXT
);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT, curve TEXT, live INTEGER,
  t_detect INTEGER, t_decide INTEGER, t_signed INTEGER, t_sent INTEGER, t_confirmed INTEGER,
  entry_block INTEGER, spend_wei TEXT, min_tokens_out TEXT, tokens_held TEXT,
  entry_mark_wei TEXT, buy_hash TEXT, buy_ok INTEGER, buy_error TEXT,
  exit_reason TEXT, exit_at INTEGER, exit_hash TEXT, proceeds_wei TEXT, expected_wei TEXT,
  pnl_wei TEXT, hold_ms INTEGER, peak_mult REAL, closed INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS latency (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, kind TEXT, ms REAL, ok INTEGER, note TEXT
);
CREATE TABLE IF NOT EXISTS mirror (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, wallet TEXT, curve TEXT, token TEXT,
  side TEXT, quote_wei TEXT, tokens TEXT, block INTEGER, elapsed_ms INTEGER, we_traded INTEGER
);
CREATE TABLE IF NOT EXISTS equity (
  at INTEGER PRIMARY KEY, realized_wei TEXT, unrealized_wei TEXT, open_n INTEGER, equity_wei TEXT
);
CREATE TABLE IF NOT EXISTS health (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, component TEXT, ok INTEGER, detail TEXT
);
CREATE TABLE IF NOT EXISTS chain_truth (
  key TEXT PRIMARY KEY, value TEXT
);
CREATE TABLE IF NOT EXISTS balance (
  at INTEGER PRIMARY KEY, wei TEXT, open_n INTEGER
);
CREATE TABLE IF NOT EXISTS trade_marks (
  position_id INTEGER NOT NULL, at INTEGER NOT NULL, mark_wei TEXT NOT NULL,
  multiple REAL NOT NULL, reason TEXT, PRIMARY KEY(position_id, at)
);
CREATE INDEX IF NOT EXISTS idx_trade_marks_at ON trade_marks(at);
CREATE TABLE IF NOT EXISTS guard_samples (
  at INTEGER PRIMARY KEY, live INTEGER NOT NULL,
  market REAL, market_fresh INTEGER NOT NULL, market_n INTEGER,
  market_off REAL, market_on REAL, execution REAL, execution_limit REAL,
  drawdown REAL, drawdown_limit REAL, halts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pos_token ON positions(token);
CREATE INDEX IF NOT EXISTS idx_pos_exit ON positions(exit_at);
CREATE INDEX IF NOT EXISTS idx_mirror_curve ON mirror(curve);
-- the chart buckets launches by detected_at on every 5s poll. the table is never pruned
-- and grows ~2.5k/day, so without this the aggregate is a full scan of an unbounded table.
-- DO NOT ADD RETENTION HERE. bot.ts seeds the deployer registry from this table on every
-- boot (SELECT deployer,block WHERE block>asOfBlock), and deployers.json is frozen at block
-- 39,528,127 with nothing to advance it, so these rows are the only record of every launch
-- since. Dropping one, passed or rejected, silently lowers priorLaunches for a serial
-- deployer and reopens the book the filter exists to close. There is no backfill path. At
-- 124.7 MB on 2026-09-15 it is the biggest table in this file and still only 0.7 MB/day.
CREATE INDEX IF NOT EXISTS idx_launches_detected ON launches(detected_at);
-- The venue reconstruction and every obs join filter on launched_at. Without this the
-- dashboard scanned all 407k rows on every chart rebuild.
CREATE INDEX IF NOT EXISTS idx_launches_launched ON launches(launched_at);
-- the dashboard counts exit failures and replays halt intervals from health on every
-- poll; without this both are full scans of a table that takes thousands of rows a day
CREATE INDEX IF NOT EXISTS idx_health_component ON health(component, at);
-- THE definition of "a real trade", owned here so consumers stop re-encoding it.
-- Every clause has a scar behind it: live=1 keeps shadow rows out of live averages,
-- the exit_reason clause keeps bookkeeping closures (orphans recovered at startup,
-- reverted buys) out of return-on-turnover, and pnl_true_wei prefers the
-- receipt-backfilled number over the model. Two offline consumers re-derived this
-- predicate by hand and both drifted; query the view instead.
-- Dropped and rebuilt every boot on purpose. A view is a stored string with no data behind
-- it, so IF NOT EXISTS meant an existing database kept whatever predicate it was created
-- with: adding 'buy-never-mined' to NON_TRADE_REASONS would have changed this file and
-- every fresh database while the box quietly went on using the old definition forever.
DROP VIEW IF EXISTS trades;
CREATE VIEW trades AS
  SELECT p.*, CAST(COALESCE(p.onchain_pnl_wei, p.pnl_wei) AS REAL) AS pnl_true_wei
  FROM positions p
  WHERE p.closed = 1 AND p.live = 1
    AND p.exit_reason NOT IN (${NON_TRADE_SQL});
`

/**
 * chain_truth key/value access for ANY handle. The bot's Telemetry, the dashboard's
 * read-only connection and the TruthKeeper each hold their own Database, and each used to
 * carry its own copy of these two lines; this is the one implementation.
 */
export function truthGet(db: Database.Database, key: string): string | null {
  const r = db.prepare('SELECT value FROM chain_truth WHERE key=?').get(key) as { value: string } | undefined
  return r?.value ?? null
}

export function truthSet(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO chain_truth (key,value) VALUES (?,?)').run(key, value)
}

/** a position whose curve graduated under us; the tokens sit in the wallet, unsellable here */
export type StrandedBag = {
  id: number; token: string; curve: string; tokens: string; spendWei: string; at: number; why: string
}

/** Historical inventory of holdings written off by the pre-swap exit policy.
 * New graduations stay open in positions and use graduation_exits instead. */
export function recordStrandedBag(db: Database.Database, bag: StrandedBag): void {
  let bags: StrandedBag[] = []
  try {
    const cur = JSON.parse(truthGet(db, 'stranded_bags') ?? '[]')
    if (Array.isArray(cur)) bags = cur
  } catch { /* a corrupt list is replaced, not fatal */ }
  if (bags.some((b) => b && b.id === bag.id)) return
  bags.push(bag)
  truthSet(db, 'stranded_bags', JSON.stringify(bags))
}

export class Telemetry {
  private db: Database.Database
  private queue: (() => void)[] = []
  private draining = false
  private markTimes = new Map<number, number>()
  private lastMarkPrune = 0
  private lastGuardPrune = 0
  private lastHealthPrune = 0

  /**
   * Prepared once here, not once per call. These run from the log-ingest path (mirror,
   * health), the exit pump (truthSet via the gate publisher) and every close, and the
   * old prepare-per-call pattern parsed the same SQL tens of thousands of times a day
   * synchronously on those callers.
   */
  private stmts!: {
    launch: Database.Statement; openPosition: Database.Statement; closePosition: Database.Statement
    entryReject: Database.Statement; burnedGas: Database.Statement
    latency: Database.Statement; mirror: Database.Statement; equity: Database.Statement
    equityPrune: Database.Statement; latencyPrune: Database.Statement
    truthGet: Database.Statement; truthSet: Database.Statement
    health: Database.Statement
  }

  constructor(file = 'data/bot.db') {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    // The shadow worker is a second process writing this same file. Without a busy timeout
    // the loser of a write race fails instantly rather than waiting, which is how the
    // observer went down on 2026-09-12. shadow-worker.ts sets the same 5s.
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(SCHEMA)
    this.migrate()
    const guardColumns = new Set((this.db.prepare('PRAGMA table_info(guard_samples)').all() as Array<{name:string}>).map(r=>r.name))
    for (const [name,type] of [['market_recent','REAL'],['market_policy','TEXT'],['market_publication','INTEGER']])
      if (!guardColumns.has(name!)) this.db.exec(`ALTER TABLE guard_samples ADD COLUMN ${name} ${type}`)
    this.stmts = {
      launch: this.db.prepare(`INSERT OR REPLACE INTO launches
      (token,curve,deployer,pair_token,block,launched_at,creator_tax_bps,dev_buy_wei,detected_at,detect_source,passed,reject_reason,
       exemptions,has_twitter,has_website,name,symbol,logo,live_book,prior_launches)
      VALUES (@token,@curve,@deployer,@pair_token,@block,@launched_at,@creator_tax_bps,@dev_buy_wei,@detected_at,@detect_source,@passed,@reject_reason,
       @exemptions,@has_twitter,@has_website,@name,@symbol,@logo,@live_book,@prior_launches)`),
      openPosition: this.db.prepare(`INSERT INTO positions
      (token,curve,live,t_detect,t_decide,t_signed,t_sent,entry_block,spend_wei,min_tokens_out,tokens_held,entry_mark_wei,buy_hash,buy_ok,buy_error,take_profit,dead_after_ms,dead_below,cohort,entry_mult,context_json,build_id)
      VALUES (@token,@curve,@live,@t_detect,@t_decide,@t_signed,@t_sent,@entry_block,@spend_wei,@min_tokens_out,@tokens_held,@entry_mark_wei,@buy_hash,@buy_ok,@buy_error,@take_profit,@dead_after_ms,@dead_below,@cohort,@entry_mult,@context_json,@build_id)`),
      // entry-stage decline for a launch that passed the book; see the migration note
      entryReject: this.db.prepare(`UPDATE launches SET entry_reject=@reason, entry_reject_at=@at WHERE token=@token`),
      // running total of gas the position's REVERTED sells burned (bot.ts reconcileSell);
      // the receipt backfill adds it to the two legs that landed. See the migration note.
      // ADDITIVE: the process restarts often and rebuilds each open position with the counter
      // at zero, so an absolute write would erase the pre-restart gas from the row
      burnedGas: this.db.prepare(`UPDATE positions SET burned_gas_wei =
        CAST(CAST(COALESCE(burned_gas_wei, '0') AS INTEGER) + CAST(@wei AS INTEGER) AS TEXT) WHERE id=@id`),
      // buy_error is COALESCEd so the three callers that have nothing to say about the buy
      // do not have to pass it and cannot blank a cause recorded at open time
      closePosition: this.db.prepare(`UPDATE positions SET exit_reason=@exit_reason, exit_at=@exit_at,
      exit_hash=@exit_hash, proceeds_wei=@proceeds_wei, expected_wei=@expected_wei, pnl_wei=@pnl_wei,
      hold_ms=@hold_ms, peak_mult=@peak_mult, tokens_held=@tokens_held,
      buy_error=COALESCE(@buy_error, buy_error), closed=1 WHERE id=@id`),
      latency: this.db.prepare('INSERT INTO latency (at,kind,ms,ok,note) VALUES (?,?,?,?,?)'),
      mirror: this.db.prepare(`INSERT INTO mirror (at,wallet,curve,token,side,quote_wei,tokens,block,elapsed_ms,we_traded)
      VALUES (@at,@wallet,@curve,@token,@side,@quote_wei,@tokens,@block,@elapsed_ms,@we_traded)`),
      equity: this.db.prepare('INSERT OR REPLACE INTO equity (at,realized_wei,unrealized_wei,open_n,equity_wei) VALUES (?,?,?,?,?)'),
      equityPrune: this.db.prepare('DELETE FROM equity WHERE at < ?'),
      latencyPrune: this.db.prepare('DELETE FROM latency WHERE at < ?'),
      truthGet: this.db.prepare('SELECT value FROM chain_truth WHERE key=?'),
      truthSet: this.db.prepare('INSERT OR REPLACE INTO chain_truth (key,value) VALUES (?,?)'),
      health: this.db.prepare('INSERT INTO health (at,component,ok,detail) VALUES (?,?,?,?)'),
    }
  }

  /** additive schema changes only: old databases keep working, new columns fill in as null */
  private migrate(): void {
    ensureApprovalSchema(this.db)
    ensureGraduationSchema(this.db)
    const have = new Set((this.db.prepare(`PRAGMA table_info(launches)`).all() as any[]).map((c) => c.name))
    const want: Array<[string, string]> = [
      ['exemptions', 'INTEGER'], ['has_twitter', 'INTEGER'], ['has_website', 'INTEGER'],
      ['name', 'TEXT'], ['symbol', 'TEXT'], ['logo', 'TEXT'], ['live_book', 'INTEGER'],
      ['prior_launches', 'INTEGER'],
      // Why a launch that PASSED the book was still not entered (2026-09-06). reject_reason
      // above is the book screen's verdict; the entry-stage declines (tax floor, exempt
      // floor, clock, risk gate, probe cap) lived only in an in-memory counter that died
      // with the process. 42 taxed book-passing launches were skipped in trading hours on
      // 09-05 with no recorded reason, and the leading suspect (the stream flagged
      // unhealthy by one 429) could not be measured. The first word is the funnel bucket.
      ['entry_reject', 'TEXT'], ['entry_reject_at', 'INTEGER'],
    ]
    for (const [col, type] of want) {
      if (!have.has(col)) this.db.exec(`ALTER TABLE launches ADD COLUMN ${col} ${type}`)
    }
    // cost basis of the open book at each balance sample. Without it the wallet series
    // dips by the deployed size on every buy and reads as a loss it is not: the ETH left
    // the wallet but it is sitting in tokens we are about to sell.
    const haveBal = new Set((this.db.prepare(`PRAGMA table_info(balance)`).all() as any[]).map((c) => c.name))
    if (!haveBal.has('deployed_wei')) this.db.exec(`ALTER TABLE balance ADD COLUMN deployed_wei TEXT`)

    // A COVERING index for the paper-wallet chart read, and it has to cover or it is
    // pointless. A shadow_jobs row averages 58 KB: `intent`, `request` and `result` are
    // whole replay payloads, and they sit BEFORE close_at/pnl/size in the record, so
    // reading a timestamp means paging through all three. One month of the chart query was
    // 15 ms against 486 rows and would have been ~290 ms against a full month, every 5 s,
    // in the process that trades. Listed here rather than in setupShadow on purpose:
    // SHADOW_KERNEL hashes the CONTENTS of shadow-account.ts, so adding a line there would
    // change every config id and shut the fresh-recovery guard until 20 new outcomes land.
    // Guarded on the table existing, because ShadowService creates it lazily and only when
    // VENUE_FRESH_RECOVERY is on; a later boot picks it up.
    const hasShadow = this.db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='shadow_jobs'`,
    ).get()
    if (hasShadow) {
      const cols = new Set((this.db.prepare(`PRAGMA table_info(shadow_jobs)`).all() as any[]).map((c) => c.name))
      const need = ['status', 'close_at', 'token', 'pnl', 'size', 'published_at', 'available']
      if (need.every((c) => cols.has(c))) {
        this.db.exec(`CREATE INDEX IF NOT EXISTS shadow_jobs_paper
          ON shadow_jobs(status,close_at,token,pnl,size,published_at,available)`)
      }
    }

    // receipt-backfilled truth, written after the fact by the backfill worker:
    // gas actually burned, P&L recomputed from receipts, and the real fill block
    // (entry_block above is the LAUNCH block, an old naming accident)
    const havePos = new Set((this.db.prepare(`PRAGMA table_info(positions)`).all() as any[]).map((c) => c.name))
    const wantPos: Array<[string, string]> = [
      ['context_json', 'TEXT'], ['build_id', 'TEXT'], ['updated_at', 'INTEGER'],
      ['gas_wei', 'TEXT'], ['onchain_pnl_wei', 'TEXT'], ['fill_block', 'INTEGER'],
      // the take-profit rung this position was opened on. Since 2026-08-19 the take profit
      // is a schedule over the venue's trailing touch rate, so the book holds several at
      // once and the config no longer tells you what any given row was exiting against.
      ['take_profit', 'REAL'],
      // RAW gas units per leg, not a cost. gas_wei above is gasUsed x effectiveGasPrice
      // SUMMED over buy+sell+approve, which cannot answer the one question that matters
      // when a limit is too tight: how close did this buy get to the ceiling. Six buys
      // burned the whole 150,000 limit on 2026-08-19 and the summed column could not show
      // it. GAS.limits.buy is set from these; see the note there.
      ['buy_gas_used', 'INTEGER'], ['sell_gas_used', 'INTEGER'],
      // the dead-coin bailout this position ran (STRATEGY.deadCoin), pinned at open for
      // the same reason as take_profit above: recon.py replays the rule the bot actually
      // ran, and a rule read from config goes stale the day the config moves. NULL on
      // rows opened before the bailout shipped, which recon treats as "no bailout".
      ['dead_after_ms', 'INTEGER'], ['dead_below', 'REAL'],
      // which book opened the row (strategy/entry.ts): 'main' or 'probe'. NULL on rows
      // older than 2026-09-06, which every reader treats as main. The probe book is real
      // money at tiny size under its own cap, and it must never be averaged into the main
      // book's numbers or the main book's into its own.
      ['cohort', 'TEXT'],
      // WHICH BOOK opened the row, and the digest of that book's FILTER at open. Deliberately
      // NOT `cohort` above, which is a different dimension and is load-bearing: three live
      // queries filter on the literal COALESCE(cohort,'main')='main' (shadow-account.ts
      // calibrate, bot.ts checkBroken, bot.ts seedTemplateLosses), so writing a book name into
      // it makes all three match nothing SILENTLY, which disarms the halt that catches the bot
      // losing money while the venue pays.
      //
      // The column lands here empty. Nothing writes it yet; the write is phase 4's, with the
      // rest of the live path. It exists now so every dashboard read can be unconditional, and
      // NULL is read as book 0 throughout, which is exactly right: every row in the table
      // predates books.
      ['book', 'TEXT'], ['book_digest', 'TEXT'],
      // the graduation guard's reading at decision (2026-09-06): the live curve's price for
      // our stake as a multiple of a fresh curve's. Every bag read 8.6-10.4x (one 5.24x);
      // normal trades p50 1.56 / p99 5.41. Stored so the band keeps being measured against
      // outcomes instead of re-derived from min_tokens_out with a guessed slippage bound.
      ['entry_mult', 'REAL'],
      // gas burned by this position's REVERTED sells, summed as each receipt is seen
      // (2026-09-06). Before the column, risk.burned() charged the live ledger and the
      // receipt backfill then rebuilt onchain_pnl_wei from the two landed legs only, so
      // every rebuild silently forgave it: 58 reverts in 24h at ~$0.10 each, and the
      // wallet ran $85 behind the books over three days with nothing else missing.
      ['burned_gas_wei', 'TEXT'],
    ]
    for (const [col, type] of wantPos) {
      if (!havePos.has(col)) this.db.exec(`ALTER TABLE positions ADD COLUMN ${col} ${type}`)
    }
    this.db.exec(`DROP TRIGGER IF EXISTS position_revision; CREATE TRIGGER position_revision AFTER UPDATE OF closed,onchain_pnl_wei,pnl_wei,gas_wei,approval_gas_wei,proceeds_wei,expected_wei,burned_gas_wei,buy_error,buy_ok,t_confirmed,exit_at ON positions BEGIN UPDATE positions SET updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=NEW.id; END`)
    // reverted buys used to record exit_hash '' rather than NULL. Empty string is not a
    // hash, and any tool that joins on it and asks the chain gets -32602 invalid argument
    // instead of skipping the row. Idempotent, so it stays here rather than in a one-off.
    this.db.exec(`UPDATE positions SET exit_hash = NULL WHERE exit_hash = ''`)
  }

  private push(fn: () => void): void {
    this.queue.push(fn)
    if (this.draining) return
    this.draining = true
    setImmediate(() => {
      const q = this.queue
      this.queue = []
      this.draining = false
      const run = this.db.transaction(() => { for (const f of q) f() })
      try { run() } catch (e) { console.error('telemetry write failed', e) }
    })
  }

  launch(row: Record<string, unknown>): void {
    const full = { exemptions: null, has_twitter: null, has_website: null, name: null, symbol: null, logo: null, live_book: null, prior_launches: null, ...row }
    this.push(() => this.stmts.launch.run(full))
  }

  openPosition(row: Record<string, unknown>): number {
    // synchronous: we need the id back to update the row when the position closes.
    // The bailout params default to NULL rather than being required: a caller that does
    // not run one (recovery's bookkeeping rows, old fixtures) records the truth, "no
    // bailout", and recon replays exactly that.
    return Number(this.stmts.openPosition.run({ dead_after_ms: null, dead_below: null, cohort: 'main', entry_mult: null, context_json: null, build_id: null, ...row }).lastInsertRowid)
  }

  /** One local quote per second while held; exit triggers bypass the sampling interval. */
  tradeMark(id: number, at: number, mark: bigint, entry: bigint, reason: string | null = null): void {
    if (!reason && at - (this.markTimes.get(id) ?? 0) < 1000) return
    this.markTimes.set(id, at)
    this.push(() => {
      this.db.prepare('INSERT OR REPLACE INTO trade_marks(position_id,at,mark_wei,multiple,reason) VALUES (?,?,?,?,?)')
        .run(id, at, mark.toString(), entry > 0n ? Number(mark) / Number(entry) : 0, reason)
      if (at - this.lastMarkPrune > 3600_000) {
        this.db.prepare('DELETE FROM trade_marks WHERE at<?').run(at - 7 * 86_400_000)
        this.lastMarkPrune = at
      }
    })
  }

  /** Retain cached owner readings and the thresholds that applied at sample time. */
  guardSample(at: number, guards: ReadonlyArray<{id:string;reading:number|null;status:string;n:number|null;stopAt:number;clearAt:number|null;recentReading?:number|null;policy?:unknown;publicationAt?:number|null}>, halts: readonly string[], live: boolean): void {
    const market = guards.find(g => g.id === 'venue'), execution = guards.find(g => g.id === 'broken'), drawdown = guards.find(g => g.id === 'drawdown')
    this.push(() => {
      this.db.prepare(`INSERT OR REPLACE INTO guard_samples
        (at,live,market,market_fresh,market_n,market_off,market_on,execution,execution_limit,drawdown,drawdown_limit,halts,market_recent,market_policy,market_publication)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(at, live ? 1 : 0, market?.reading ?? null,
          market && market.status !== 'unknown' ? 1 : 0, market?.n ?? null, market?.stopAt ?? null, market?.clearAt ?? null,
          execution?.reading ?? null, execution?.stopAt ?? null, drawdown?.reading ?? null, drawdown?.stopAt ?? null, JSON.stringify(halts), market?.recentReading ?? null, market?.policy ? JSON.stringify(market.policy) : null, market?.publicationAt ?? null)
      if (at - this.lastGuardPrune >= 3600_000) {
        this.db.prepare('DELETE FROM guard_samples WHERE at < ?').run(at - 7 * 86400_000)
        this.lastGuardPrune = at
      }
    })
  }

  /** the entry-stage decline of a launch that passed the book; first word is the bucket */
  entryReject(token: string, reason: string): void {
    this.push(() => this.stmts.entryReject.run({ token, reason, at: Date.now() }))
  }

  /** one more reverted sell's gas onto the row's running total, so a rebuild keeps it */
  burnedGas(id: number, wei: bigint): void {
    this.push(() => this.stmts.burnedGas.run({ id, wei: wei.toString() }))
  }

  closePosition(id: number, row: Record<string, unknown>): void {
    this.markTimes.delete(id)
    // better-sqlite3 rejects a named statement it cannot fill, so default the optional one
    this.push(() => this.stmts.closePosition.run({ buy_error: null, ...row, id }))
  }

  latency(kind: string, ms: number, ok: boolean, note = ''): void {
    this.push(() => this.stmts.latency.run(Date.now(), kind, ms, ok ? 1 : 0, note))
  }

  mirror(row: Record<string, unknown>): void {
    this.push(() => this.stmts.mirror.run(row))
  }

  /** One sample of portfolio value. Cheap enough to take often; pruned to a week. */
  equity(row: { at: number; realized: bigint; unrealized: bigint; openN: number; equity: bigint }): void {
    this.push(() => {
      this.stmts.equity.run(row.at, row.realized.toString(), row.unrealized.toString(), row.openN, row.equity.toString())
      this.stmts.equityPrune.run(row.at - 7 * 86_400_000)
      // latency rides the same 7d retention: the sequencer probe alone writes ~11.5k
      // rows/day, nothing in the running process reads them back, and the offline
      // scripts that do never look further than days
      this.stmts.latencyPrune.run(row.at - 7 * 86_400_000)
    })
  }

  // NOTE: no balanceSample() here on purpose. TruthKeeper writes the balance row itself,
  // with deployed_wei. A helper that omitted that column would INSERT OR REPLACE a NULL
  // into it, and the dashboard would silently fall back to estimating deployed capital
  // from open_n * tradeSizeEth - an estimate, in the one table that exists to be truth.

  /** chain_truth: tiny persistent key/value (baseline, peak flat balance, epoch base). */
  truthGet(key: string): string | null {
    const r = this.stmts.truthGet.get(key) as { value: string } | undefined
    return r?.value ?? null
  }

  truthSet(key: string, value: string): void {
    // synchronous on purpose: baseline/peak writes are rare and must survive a crash
    this.stmts.truthSet.run(key, value)
  }

  /**
   * Same write, but batched onto the drain queue. For keys rewritten every few seconds
   * (gate_live_json lands on every settled observation, from the exit pump's tick):
   * synchronous durability buys nothing for a value that is stale in 30s anyway, and the
   * sync write was a stall on the one path that decides sells.
   */
  truthSetQueued(key: string, value: string): void {
    this.push(() => this.stmts.truthSet.run(key, value))
  }

  /**
   * Health rows are transitions, mostly, and nothing reads one older than a day: the longest
   * live lookback is the 24 h `exit` failure count in dashboard.ts, and epoch.ts reads a single
   * calendar day. The table had no retention and held 180,652 rows back to 2026-08-17 when it
   * was measured on 2026-09-15. Eight days leaves a week of margin over the longest reader.
   */
  health(component: string, ok: boolean, detail = ''): void {
    this.push(() => {
      const at = Date.now()
      this.stmts.health.run(at, component, ok ? 1 : 0, detail)
      if (at - this.lastHealthPrune > 3600_000) {
        this.db.prepare('DELETE FROM health WHERE at<?').run(at - 8 * 86_400_000)
        this.lastHealthPrune = at
      }
    })
  }

  raw(): Database.Database {
    return this.db
  }

  close(): void {
    // Drain first. Writes are batched onto a setImmediate and index.ts calls
    // process.exit(0) right after this, so a queued close would either lose its callback
    // to the exit or run it against a shut handle. Either way the row stays closed=0 and
    // the next boot re-derives it as 'recovered-flat' with pnl 0 - a real trade's P&L
    // destroyed by a clean shutdown.
    const q = this.queue
    this.queue = []
    this.draining = false
    if (q.length) {
      try { this.db.transaction(() => { for (const f of q) f() })() }
      catch (e) { console.error('telemetry drain failed', e) }
    }
    this.db.close()
  }
}
