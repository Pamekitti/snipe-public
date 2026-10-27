/** Credential-isolated research routing and a shared paid-request allowance. */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

export const PUBLIC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com'

export function researchEndpoint(name = 'RESEARCH_RPC_URL') {
  return process.env[name] || PUBLIC_RPC_URL
}

export function isPublicEndpoint(url) {
  return url.replace(/\/+$/, '') === PUBLIC_RPC_URL.replace(/\/+$/, '')
}

export class ResearchPolicy {
  constructor(endpoints) {
    this.allowance = null
    if (endpoints.every(isPublicEndpoint)) return
    if (process.env.RESEARCH_ALLOW_PAID !== '1') {
      throw new Error('a non-public research endpoint requires RESEARCH_ALLOW_PAID=1')
    }
    const maximum = Number(process.env.RESEARCH_MAX_PAID_REQUESTS)
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new Error('RESEARCH_MAX_PAID_REQUESTS must be a positive integer for a paid research run')
    }
    const path = process.env.RESEARCH_PAID_BUDGET_PATH
    if (!path) {
      throw new Error('a paid research run requires RESEARCH_PAID_BUDGET_PATH so child processes share one allowance')
    }
    const db = new Database(path)
    db.pragma('busy_timeout = 30000')
    db.exec('create table if not exists paid_allowance(id integer primary key check(id=1), maximum integer not null, used integer not null)')
    const row = db.prepare('select maximum,used from paid_allowance where id=1').get()
    if (!row) db.prepare('insert into paid_allowance values(1,?,0)').run(maximum)
    else if (row.maximum !== maximum) throw new Error('RESEARCH_MAX_PAID_REQUESTS does not match the shared allowance file')
    this.allowance = { db, maximum }
  }

  beforeSend(endpoint, members) {
    if (isPublicEndpoint(endpoint)) return false
    const { db, maximum } = this.allowance
    const claim = db.transaction((count) => {
      const { used } = db.prepare('select used from paid_allowance where id=1').get()
      if (used + count > maximum) {
        throw new Error(`paid research allowance exhausted (${used}/${maximum}); refused ${count} request(s) before sending`)
      }
      db.prepare('update paid_allowance set used=used+? where id=1').run(count)
    })
    claim(members)
    return true
  }

  get paidUsed() {
    return this.allowance?.db.prepare('select used from paid_allowance where id=1').get().used ?? 0
  }

  close() { this.allowance?.db.close() }
}

export class ResearchRpc {
  constructor({ endpoint = researchEndpoint(), retries = 4 } = {}) {
    this.endpoint = endpoint
    this.retries = retries
    this.policy = new ResearchPolicy([endpoint])
    this.stats = { cacheHits: 0, networkAttempts: 0, missingResults: 0 }
  }

  async request(method, params, { bypassCache = false } = {}) {
    void bypassCache
    let last = 'missing result'
    for (let attempt = 0; attempt < this.retries; attempt++) {
      this.policy.beforeSend(this.endpoint, 1)
      this.stats.networkAttempts++
      try {
        const response = await fetch(this.endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(45_000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json()
        if (body.error) throw new Error(String(body.error.message || body.error.code || 'RPC error'))
        if (body.result !== null && body.result !== undefined) return body.result
        last = 'missing result'
      } catch (error) {
        last = String(error).replace(/(?:https?|wss?):\/\/\S+/gi, '[RPC]').slice(0, 180)
      }
      if (attempt + 1 < this.retries) await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)))
    }
    this.stats.missingResults++
    throw new Error(last)
  }

  summary() {
    return { ...this.stats, paidAllowanceUsed: this.policy.paidUsed }
  }

  close() { this.policy.close() }
}
