/** Durable, prompt transfer from a closed curve to Pons' native ETH swap route. */
import type Database from 'better-sqlite3'
import { encodeFunctionData, parseAbi, zeroAddress, type Hex, type PublicClient } from 'viem'
import factoryAbi from './factory.abi.json' with { type: 'json' }
import { ADDRESSES } from './config.js'
import { readClient, READ_TIMEOUT_MS } from './rpc/read.js'
import { erc20Abi } from './abi.js'
import { V4, permitAbi, swapData, graduatedProceeds, type PoolKey } from './tx/graduated.js'
import { recordApproval, rejectApproval } from './telemetry/approvals.js'
import type { SignedTx } from './tx/signer.js'
import type { SendResult } from './tx/sender.js'

export const GRADUATION_TIMING = { receiptMs: 150, retryMs: 250, maxRetryMs: 1000, resendMs: 1000, rpcTimeoutMs: READ_TIMEOUT_MS } as const
/** Provider failures must not copy credential-bearing URLs into the dashboard log. */
export function graduationError(error: unknown): string {
  const e = error as { shortMessage?: string; message?: string }
  return (e?.shortMessage ?? e?.message ?? String(error)).split('\n')[0]!
    .replace(/(?:https?|wss?):\/\/\S+/gi, '[RPC]').slice(0, 200)
}
const readyAbi = parseAbi(['function readyToGraduate() view returns (bool)'])
export function graduationClient(urls: string[], onProviderRequest?: (method: string) => void, onSharedReceipt?: () => void): PublicClient {
  return readClient(urls, { onProviderRequest, onSharedReceipt })
}

export function ensureGraduationSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS graduation_exits (
    position_id INTEGER PRIMARY KEY, pool_key TEXT, detected_at INTEGER NOT NULL,
    retry_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    proceeds_wei TEXT, exit_hash TEXT, pool_ready INTEGER NOT NULL DEFAULT 0, confirmed_block INTEGER
  ); CREATE TABLE IF NOT EXISTS graduation_transactions (
    hash TEXT PRIMARY KEY, position_id INTEGER NOT NULL, kind TEXT NOT NULL,
    raw TEXT NOT NULL, nonce INTEGER NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL,
    gas_wei TEXT, receipt_json TEXT
  ); CREATE INDEX IF NOT EXISTS idx_graduation_tx ON graduation_transactions(position_id);`)
  const cols = new Set((db.prepare('PRAGMA table_info(graduation_exits)').all() as Array<{name:string}>).map(r => r.name))
  if (!cols.has('pool_ready')) db.exec('ALTER TABLE graduation_exits ADD COLUMN pool_ready INTEGER NOT NULL DEFAULT 0')
  if (!cols.has('confirmed_block')) db.exec('ALTER TABLE graduation_exits ADD COLUMN confirmed_block INTEGER')
  const positionCols = db.prepare('PRAGMA table_info(positions)').all() as Array<{name:string}>
  if (!positionCols.some(r => r.name === 'graduation_prep_gas_wei')) db.exec('ALTER TABLE positions ADD COLUMN graduation_prep_gas_wei TEXT')
}
type Tx = { hash: Hex; raw: Hex; nonce: number; kind: string; at: number }
type Row = { pool_key: string | null; pool_ready: number; confirmed_block: number | null; retry_at: number; failures: number; proceeds_wei: string | null; exit_hash: string | null; last_error: string | null }
export type GraduationResult = { proceeds: bigint; hash: string }
type Dependencies = {
  capture?: (kind:string,key:string,payload:unknown) => void;
  db: Database.Database; client: PublicClient; wallet: Hex;
  sign: (to: Hex, data: Hex, gas?: bigint) => Promise<SignedTx>;
  send: (signed: Pick<SignedTx, 'raw' | 'hash'>, nonce: number, replay: boolean) => Promise<SendResult>;
  health: (ok: boolean, note: string) => void;
  burned: (id: number, gas: bigint) => void;
  prepared?: (id: number, gas: bigint) => void;
  release?: (nonce: number) => void;
  now?: () => number;
}
const isApproval = (kind: string) => kind === 'token-approval' || kind === 'permit-approval'

export class GraduationExit {
  private busy = new Set<number>()
  constructor(private d: Dependencies) { ensureGraduationSchema(d.db) }
  private now() { return (this.d.now ?? Date.now)() }
  enroll(id: number): void {
    this.d.db.prepare('INSERT OR IGNORE INTO graduation_exits(position_id,detected_at) VALUES(?,?)').run(id, this.now())
  }
  has(id: number): boolean { return !!this.d.db.prepare('SELECT 1 FROM graduation_exits WHERE position_id=?').get(id) }

  async step(id: number, token: Hex, curve: Hex): Promise<GraduationResult | null> {
    if (this.busy.has(id)) return null
    this.enroll(id)
    let row = this.d.db.prepare('SELECT * FROM graduation_exits WHERE position_id=?').get(id) as Row
    if (row.proceeds_wei && row.exit_hash) return { proceeds: BigInt(row.proceeds_wei), hash: row.exit_hash }
    if (row.retry_at > this.now()) return null
    this.busy.add(id)
    try {
      const pending = this.d.db.prepare("SELECT * FROM graduation_transactions WHERE position_id=? AND status='pending' ORDER BY at LIMIT 1").get(id) as Tx | undefined
      if (pending && !(await this.receipt(id, pending, row))) return null
      row = this.d.db.prepare('SELECT * FROM graduation_exits WHERE position_id=?').get(id) as Row
      if (row.proceeds_wei && row.exit_hash) return { proceeds: BigInt(row.proceeds_wei), hash: row.exit_hash }
      this.checkBudget(id)

      let key: PoolKey | null = row.pool_key ? JSON.parse(row.pool_key) : null
      if (!row.pool_ready) {
        const [info, hook] = await this.d.client.multicall({
          contracts: [
            { address: ADDRESSES.factory as Hex, abi: factoryAbi, functionName: 'getLaunchedToken', args: [token] },
            { address: ADDRESSES.factory as Hex, abi: factoryAbi, functionName: 'memeHook' },
          ], allowFailure: false, multicallAddress: ADDRESSES.multicall3 as Hex,
        }) as [any, Hex]
        if (!info.exists || info.token.toLowerCase() !== token.toLowerCase() || info.curve.toLowerCase() !== curve.toLowerCase() || info.pairToken !== zeroAddress) throw new Error('factory does not confirm this native ETH holding')
        if (hook.toLowerCase() !== V4.hook.toLowerCase()) throw new Error('unverified graduation hook')
        key = { currency0: zeroAddress, currency1: token, fee: info.poolFee, tickSpacing: info.tickSpacing, hooks: hook }
        this.d.db.prepare('UPDATE graduation_exits SET pool_key=?,pool_ready=? WHERE position_id=?').run(JSON.stringify(key), Number(info.phase === 2), id)
        if (info.phase === 0 || info.phase === 1) {
          if (info.phase === 0 && !(await this.d.client.readContract({ address: curve, abi: readyAbi, functionName: 'readyToGraduate' }))) throw new Error('curve is not ready to graduate')
          // Both are permissionless, zero-value venue transitions. Never use the
          // owner's forced sweep or rescue functions, which change who gets reserves.
          const fn = info.phase === 0 ? 'graduate' : 'createGraduatedPool'
          await this.submit(id, info.phase === 0 ? 'graduate' : 'create-pool', ADDRESSES.factory as Hex,
            encodeFunctionData({ abi: factoryAbi, functionName: fn, args: [token] }), V4.preparationGas)
          return null
        }
        if (info.phase !== 2) throw new Error(`unsupported graduation phase ${info.phase}`)
      }
      if (!key) throw new Error('missing verified pool key')

      // One state read, rather than a quote and separate allowance reads for each leg.
      // After a receipt, use its block to avoid re-approving against a lagging replica.
      const [balance, allowance, permission] = await this.d.client.multicall({
        contracts: [
          { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [this.d.wallet] },
          { address: token, abi: erc20Abi, functionName: 'allowance', args: [this.d.wallet, V4.permit2] },
          { address: V4.permit2, abi: permitAbi, functionName: 'allowance', args: [this.d.wallet, token, V4.router] },
        ], allowFailure: false, multicallAddress: ADDRESSES.multicall3 as Hex,
        ...(row.confirmed_block ? { blockNumber: BigInt(row.confirmed_block) } : {}),
      }) as [bigint, bigint, readonly [bigint, number, number]]
      if (balance === 0n) throw new Error('zero balance without a confirmed swap receipt; reconciliation required')
      if (allowance < balance) {
        await this.submit(id, 'token-approval', token, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [V4.permit2, balance] }))
      } else if (permission[0] < balance || permission[1] <= Math.floor(this.now() / 1000) + 30) {
        await this.submit(id, 'permit-approval', V4.permit2, encodeFunctionData({ abi: permitAbi, functionName: 'approve', args: [token, V4.router, balance, Math.floor(this.now() / 1000) + 600] }))
      } else {
        // Match the existing emergency curve exit: a declining quote must not refuse
        // the sale. Simulation still verifies a positive executable return before send.
        await this.submit(id, 'swap', V4.router, swapData(key, balance, 1n, BigInt(Math.floor(this.now() / 1000) + 180)))
      }
      return null
    } catch (e) {
      const note = graduationError(e), n = row.failures + 1
      this.d.db.prepare('UPDATE graduation_exits SET failures=?,retry_at=?,last_error=?,confirmed_block=NULL WHERE position_id=?')
        .run(n, this.now() + Math.min(GRADUATION_TIMING.maxRetryMs, GRADUATION_TIMING.retryMs * n), note, id)
      if (row.last_error !== note || n % 10 === 0) this.d.health(false, `position ${id} graduated exit: ${note}; holding remains open`)
      return null
    } finally { this.busy.delete(id) }
  }

  private checkBudget(id: number): void {
    const submitted = this.d.db.prepare("SELECT COUNT(*) n FROM graduation_transactions WHERE position_id=? AND status!='rejected'").get(id) as { n: number }
    const losses = this.d.db.prepare("SELECT gas_wei FROM graduation_transactions WHERE position_id=? AND status='reverted'").all(id) as Array<{gas_wei:string}>
    const stake = this.d.db.prepare('SELECT spend_wei FROM positions WHERE id=?').get(id) as {spend_wei:string}
    if (submitted.n >= 12 || losses.length >= 6 || losses.reduce((sum, r) => sum + BigInt(r.gas_wei), 0n) >= BigInt(stake.spend_wei) / 20n) {
      throw new Error('swap transaction/gas budget exhausted; operator recovery required')
    }
  }

  private async submit(id: number, kind: string, to: Hex, data: Hex, gas: bigint = V4.gas): Promise<void> {
    await this.d.client.call({ account: this.d.wallet, to, data, gas })
    const signed = await this.d.sign(to, data, gas), at = this.now()
    try {
      this.d.db.transaction(() => {
        this.d.db.prepare("INSERT INTO graduation_transactions(hash,position_id,kind,raw,nonce,at,status) VALUES(?,?,?,?,?,?,'pending')")
          .run(signed.hash, id, kind, signed.raw, signed.tx.nonce, at)
        if (isApproval(kind)) recordApproval(this.d.db, id, signed.hash, signed.tx.nonce, at)
      })()
    } catch (e) { this.d.release?.(signed.tx.nonce); throw e }
    const r = await this.d.send(signed, signed.tx.nonce, false)
    if (!r.ok && !r.nonceConsumed) {
      this.d.db.prepare("UPDATE graduation_transactions SET status='rejected' WHERE hash=?").run(signed.hash)
      if (isApproval(kind)) rejectApproval(this.d.db, signed.hash)
      throw new Error(r.error)
    }
    this.d.health(true, `position ${id} graduated ${kind} submitted ${signed.hash}`)
    this.d.db.prepare('UPDATE graduation_exits SET retry_at=?,failures=0,last_error=NULL WHERE position_id=?')
      .run(at + GRADUATION_TIMING.receiptMs, id)
  }

  private async receipt(id: number, tx: Tx, row: Row): Promise<boolean> {
    let rc
    try { rc = await this.d.client.getTransactionReceipt({ hash: tx.hash }) } catch {
      if (this.now() - tx.at >= GRADUATION_TIMING.resendMs) {
        await this.d.send({ hash: tx.hash, raw: tx.raw }, tx.nonce, true)
        this.d.db.prepare('UPDATE graduation_transactions SET at=? WHERE hash=?').run(this.now(), tx.hash)
      }
      this.d.db.prepare('UPDATE graduation_exits SET retry_at=? WHERE position_id=?').run(this.now() + GRADUATION_TIMING.receiptMs, id)
      return false
    }
    try { this.d.capture?.('graduation-receipt',tx.hash,{hash:tx.hash,kind:tx.kind,receipt:rc}) } catch { /* capture cannot delay settlement */ }
    const gas = rc.gasUsed * rc.effectiveGasPrice
    if (rc.status === 'reverted') {
      this.d.db.transaction(() => {
        this.d.db.prepare("UPDATE graduation_transactions SET status='reverted',gas_wei=? WHERE hash=?").run(String(gas), tx.hash)
        if (isApproval(tx.kind)) this.d.db.prepare('UPDATE approval_transactions SET gas_wei=? WHERE hash=?').run(String(gas), tx.hash)
        else this.d.burned(id, gas)
      })()
      throw new Error(`${tx.kind} reverted; ${gas} wei gas`)
    }
    if (tx.kind === 'swap') {
      if (!row.pool_key) throw new Error('swap receipt missing its recorded pool')
      const key: PoolKey = JSON.parse(row.pool_key)
      const proceeds = graduatedProceeds(rc.logs, key, this.d.wallet)
      const remaining = await this.d.client.readContract({ address: key.currency1, abi: erc20Abi, functionName: 'balanceOf', args: [this.d.wallet], blockNumber: rc.blockNumber })
      if (remaining !== 0n) throw new Error('swap succeeded but tokens remain; reconciliation required')
      this.d.db.prepare('UPDATE graduation_exits SET proceeds_wei=?,exit_hash=? WHERE position_id=?').run(String(proceeds), tx.hash, id)
    }
    this.d.db.transaction(() => {
      this.d.db.prepare("UPDATE graduation_transactions SET status='success',gas_wei=?,receipt_json=? WHERE hash=?")
        .run(String(gas), JSON.stringify(rc, (_, v) => typeof v === 'bigint' ? String(v) : v), tx.hash)
      this.d.db.prepare('UPDATE graduation_exits SET confirmed_block=? WHERE position_id=?').run(Number(rc.blockNumber), id)
      if (isApproval(tx.kind)) this.d.db.prepare('UPDATE approval_transactions SET gas_wei=? WHERE hash=?').run(String(gas), tx.hash)
      if (tx.kind === 'graduate' || tx.kind === 'create-pool') {
        if (!this.d.prepared) throw new Error('missing preparation cost accounting')
        this.d.prepared(id, gas)
      }
    })()
    return true
  }
}
