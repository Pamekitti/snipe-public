import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoricalTransactionCache, PUBLIC_RESEARCH_RPC } from '../tools/research-rpc.js'

const dirs: string[] = []
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true })
  for (const key of ['RESEARCH_RPC_URL', 'RESEARCH_ALLOW_PAID', 'RESEARCH_MAX_PAID_REQUESTS', 'RESEARCH_PAID_BUDGET_PATH']) delete process.env[key]
})

function dir(): string { const path = mkdtempSync(join(tmpdir(), 'research-rpc-')); dirs.push(path); return path }
function response(body: unknown): Response { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) }

describe('historical research acquisition', () => {
  it('ignores inherited trading endpoints and uses public by default', async () => {
    process.env.RPC_URL = 'https://paid.invalid/key'
    process.env.RPC_KEY_URL = 'https://paid.invalid/key'
    let seen = ''
    const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen = String(url)
      const body = JSON.parse(String(init?.body)) as Array<{ id: number; params: string[] }>
      return response(body.map((q) => ({ id: q.id, result: { hash: q.params[0], blockNumber: '0x1', input: '0x' } })))
    }
    const root = dir(), cache = new HistoricalTransactionCache(join(root, 'cache.sqlite'), undefined, fetcher)
    await cache.transactions(4663, ['0xabc'])
    expect(seen).toBe(PUBLIC_RESEARCH_RPC)
    cache.close()
  })

  it('refuses an unknown endpoint without explicit paid authority', () => {
    const root = dir()
    expect(() => new HistoricalTransactionCache(join(root, 'cache.sqlite'), 'https://paid.invalid/key'))
      .toThrow(/RESEARCH_ALLOW_PAID/)
  })

  it('counts batch members and retries before sending, then stops at the allowance', async () => {
    const root = dir()
    process.env.RESEARCH_ALLOW_PAID = '1'
    process.env.RESEARCH_MAX_PAID_REQUESTS = '3'
    process.env.RESEARCH_PAID_BUDGET_PATH = join(root, 'allowance.sqlite')
    let sends = 0
    const fetcher = async (): Promise<Response> => { sends++; throw new Error('rate limited') }
    const cache = new HistoricalTransactionCache(join(root, 'cache.sqlite'), 'https://paid.invalid/key', fetcher)
    const found = await cache.transactions(4663, ['0xa', '0xb'])
    expect([...found.values()]).toEqual([null, null])
    expect(sends).toBe(1)
    expect(cache.summary()).toEqual({ cacheHits: 0, networkAttempts: 2, paidAllowanceUsed: 2, missingResults: 2 })
    cache.close()
  })

  it('reuses only mined matching transactions and bypasses cache for verification', async () => {
    const root = dir()
    let calls = 0
    const fetcher = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls++
      const body = JSON.parse(String(init?.body)) as Array<{ id: number; params: string[] }>
      return response(body.map((q) => ({ id: q.id, result: { hash: q.params[0], blockNumber: '0x1', input: `0x${calls}` } })))
    }
    const cache = new HistoricalTransactionCache(join(root, 'cache.sqlite'), PUBLIC_RESEARCH_RPC, fetcher)
    expect((await cache.transactions(4663, ['0xabc'])).get('0xabc')?.input).toBe('0x1')
    expect((await cache.transactions(4663, ['0xabc'])).get('0xabc')?.input).toBe('0x1')
    expect((await cache.transactions(4663, ['0xabc'], true)).get('0xabc')?.input).toBe('0x2')
    expect((await cache.transactions(4663, ['0xabc'])).get('0xabc')?.input).toBe('0x1')
    expect(calls).toBe(2)
    cache.close()
  })
})
