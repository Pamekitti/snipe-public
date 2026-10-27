/** Persistent historical transaction acquisition for v2 research tools. */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const PUBLIC_RESEARCH_RPC = 'https://rpc.mainnet.chain.robinhood.com'

type Tx = { readonly hash?: string; readonly blockNumber?: string | null; readonly input?: string }
type Stats = { cacheHits: number; networkAttempts: number; paidAllowanceUsed: number; missingResults: number }

export class HistoricalTransactionCache {
  private readonly cache: Database.Database
  private readonly allowance: Database.Database | null
  private readonly paid: boolean
  private readonly maximum: number
  private stats: Stats = { cacheHits: 0, networkAttempts: 0, paidAllowanceUsed: 0, missingResults: 0 }

  constructor(
    cachePath = process.env.RESEARCH_CACHE_PATH ?? '../v1/data/research/cache.sqlite',
    private readonly endpoint = process.env.RESEARCH_RPC_URL ?? PUBLIC_RESEARCH_RPC,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    mkdirSync(dirname(cachePath), { recursive: true })
    this.cache = new Database(cachePath)
    this.cache.pragma('busy_timeout = 30000')
    this.cache.exec('create table if not exists historical_transactions(chain integer not null, hash text not null, value text not null, at integer not null, primary key(chain,hash))')
    this.paid = endpoint.replace(/\/+$/, '') !== PUBLIC_RESEARCH_RPC.replace(/\/+$/, '')
    if (!this.paid) { this.allowance = null; this.maximum = 0; return }
    if (process.env.RESEARCH_ALLOW_PAID !== '1') throw new Error('a non-public research endpoint requires RESEARCH_ALLOW_PAID=1')
    this.maximum = Number(process.env.RESEARCH_MAX_PAID_REQUESTS)
    if (!Number.isSafeInteger(this.maximum) || this.maximum <= 0) throw new Error('RESEARCH_MAX_PAID_REQUESTS must be a positive integer for a paid research run')
    const path = process.env.RESEARCH_PAID_BUDGET_PATH
    if (!path) throw new Error('a paid research run requires RESEARCH_PAID_BUDGET_PATH so child processes share one allowance')
    mkdirSync(dirname(path), { recursive: true })
    this.allowance = new Database(path)
    this.allowance.pragma('busy_timeout = 30000')
    this.allowance.exec('create table if not exists paid_allowance(id integer primary key check(id=1), maximum integer not null, used integer not null)')
    const row = this.allowance.prepare('select maximum from paid_allowance where id=1').get() as { maximum: number } | undefined
    if (!row) this.allowance.prepare('insert into paid_allowance values(1,?,0)').run(this.maximum)
    else if (row.maximum !== this.maximum) throw new Error('RESEARCH_MAX_PAID_REQUESTS does not match the shared allowance file')
  }

  async transactions(chain: number, hashes: readonly string[], bypassCache = false): Promise<ReadonlyMap<string, Tx | null>> {
    const result = new Map<string, Tx | null>()
    const missing: string[] = []
    const read = this.cache.prepare('select value from historical_transactions where chain=? and hash=?')
    for (const raw of hashes) {
      const hash = raw.toLowerCase()
      const row = bypassCache ? undefined : read.get(chain, hash) as { value: string } | undefined
      if (row) { result.set(hash, JSON.parse(row.value) as Tx); this.stats.cacheHits++ }
      else missing.push(hash)
    }
    for (let offset = 0; offset < missing.length; offset += 25) {
      let pending = missing.slice(offset, offset + 25)
      for (let attempt = 0; pending.length && attempt < 5; attempt++) {
        try {
          this.claim(pending.length)
        } catch {
          for (const hash of pending) { result.set(hash, null); this.stats.missingResults++ }
          pending = []
          break
        }
        this.stats.networkAttempts += pending.length
        const body = pending.map((hash, id) => ({ jsonrpc: '2.0', id, method: 'eth_getTransactionByHash', params: [hash] }))
        let json: Array<{ id: number; result?: Tx | null; error?: unknown }> = []
        try {
          const response = await this.fetcher(this.endpoint, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
            signal: AbortSignal.timeout(45_000),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const decoded = await response.json()
          if (!Array.isArray(decoded)) throw new Error('batch response is not an array')
          json = decoded as typeof json
        } catch {
          if (attempt < 4) await new Promise<void>((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)))
          continue
        }
        const byId = new Map(json.map((row) => [row.id, row]))
        const retry: string[] = []
        for (let id = 0; id < pending.length; id++) {
          const hash = pending[id]!, row = byId.get(id), tx = row?.result
          if (!row?.error && tx && tx.blockNumber && tx.hash?.toLowerCase() === hash) {
            result.set(hash, tx)
            if (!bypassCache) this.cache.prepare('insert or replace into historical_transactions values(?,?,?,?)')
              .run(chain, hash, JSON.stringify(tx), Date.now())
          } else retry.push(hash)
        }
        pending = retry
      }
      for (const hash of pending) { result.set(hash, null); this.stats.missingResults++ }
    }
    return result
  }

  async request(method: string, params: readonly unknown[]): Promise<unknown> {
    let last = 'missing result'
    for (let attempt = 0; attempt < 5; attempt++) {
      try { this.claim(1) } catch (error) { this.stats.missingResults++; throw error }
      this.stats.networkAttempts++
      try {
        const response = await this.fetcher(this.endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(45_000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json() as { result?: unknown; error?: { message?: string } }
        if (body.error) throw new Error(body.error.message ?? 'RPC error')
        if (body.result !== null && body.result !== undefined) return body.result
        last = 'missing result'
      } catch (error) {
        last = String(error).replace(/(?:https?|wss?):\/\/\S+/gi, '[RPC]').slice(0, 180)
      }
      if (attempt < 4) await new Promise<void>((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)))
    }
    this.stats.missingResults++
    throw new Error(last)
  }

  private claim(count: number): void {
    if (!this.paid) return
    const db = this.allowance!
    db.transaction(() => {
      const row = db.prepare('select used from paid_allowance where id=1').get() as { used: number }
      if (row.used + count > this.maximum) throw new Error('paid research allowance exhausted')
      db.prepare('update paid_allowance set used=used+? where id=1').run(count)
    })()
    this.stats.paidAllowanceUsed = (db.prepare('select used from paid_allowance where id=1').get() as { used: number }).used
  }

  summary(): Stats {
    if (this.allowance) this.stats.paidAllowanceUsed = (this.allowance.prepare('select used from paid_allowance where id=1').get() as { used: number }).used
    return { ...this.stats }
  }

  close(): void { this.cache.close(); this.allowance?.close() }
}
