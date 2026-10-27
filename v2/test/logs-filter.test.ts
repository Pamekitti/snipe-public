import { afterEach, describe, expect, it, vi } from 'vitest'
import { LogsSubscriber } from '../io/logs.js'
import { EVENT_TOPICS } from '../io/abi.js'

afterEach(() => vi.unstubAllGlobals())
describe('filter transport in the real subscriber', () => {
  function setup() {
    let now = 10_000, head = 100, eligible = true, filters: any[] = [], ranges: any[] = [], failFilter = false
    const calls: string[] = [], batches: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body); calls.push(request.method)
      if (failFilter && request.method === 'eth_getFilterChanges') return { ok: true, json: async () => ({ error: { message: 'filter not found' } }) }
      const result = request.method === 'eth_blockNumber' ? `0x${head.toString(16)}`
        : request.method === 'eth_newFilter' ? '0x1' : request.method === 'eth_getLogs' ? ranges : filters
      return { ok: true, json: async () => ({ result }) }
    }))
    const s = new LogsSubscriber(100, () => false, () => now, {
      providerUrl: 'https://provider.invalid/test', filterMode: () => 'live', filterEligible: () => eligible,
    }, () => !eligible)
    s.lastProcessedBlock = 100
    s.on('batch', batch => batches.push(batch))
    return { s, calls, batches, tick: () => (s as any).backfill(),
      set: (x: { time?: number; tip?: number; filter?: any[]; range?: any[]; eligible?: boolean; fail?: boolean }) => {
        now = x.time ?? now; head = x.tip ?? head; filters = x.filter ?? filters; ranges = x.range ?? ranges
        eligible = x.eligible ?? eligible; failFilter = x.fail ?? failFilter
      } }
  }
  const row = { address: '0xa', topics: [EVENT_TOPICS.CurveBuy], data: '0x', transactionHash: '0xt', blockHash: '0xb', blockNumber: '0x65', logIndex: '0x0' }
  it('does not publish tentative data or claim coverage before its two-second range audit', async () => {
    const f = setup(); await f.tick()
    f.set({ time: 11000, tip: 101, filter: [row] }); await f.tick()
    expect(f.s.lastProcessedBlock).toBe(100)
    expect(f.s.lastHealthyAt).toBe(10000)
    expect(f.batches).toHaveLength(0)
    f.set({ time: 12000, range: [row], filter: [] }); await f.tick()
    expect(f.s.lastProcessedBlock).toBe(101)
    expect(f.batches).toHaveLength(1)
    expect(f.s.routingStatus().filter?.disabledReason).toBeNull()
  })
  it('restores paid range scanning immediately on expired filters', async () => {
    const f = setup(); await f.tick()
    f.set({ time: 11000, tip: 101, fail: true, range: [row] }); await f.tick()
    expect(f.s.lastProcessedBlock).toBe(101)
    expect(f.s.routingStatus().filter?.repairs).toBe(1)
    expect(f.calls.slice(-2)).toEqual(['eth_blockNumber', 'eth_getLogs'])
  })
  it('does no optional filter reads while critical work exists', async () => {
    const f = setup(); await f.tick(); f.calls.length = 0
    f.set({ time: 11000, eligible: false, tip: 101, range: [row] }); await f.tick()
    expect(f.calls).toEqual(['eth_blockNumber', 'eth_getLogs'])
  })
})
