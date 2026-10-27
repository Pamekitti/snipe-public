/**
 * The polling path of the authoritative log stream, against a mocked RPC.
 *
 * 2026-09-06: 12,786 "Too Many Requests" in one day, and each ONE flipped the stream
 * unhealthy until the next success, which made RiskManager.canEnter refuse every launch
 * landing in that gap. The data-age guard (3s) is the real safety; the flag now needs
 * three consecutive failures. And 1,776 of those failures reached JSON.parse as an HTML
 * page, so the request checks the status first and names the failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
// this file tests the POLLER. On a box whose .env carries a real LOGS_WS_URL, dotenv would
// hand it to config.ts and start() would open a real socket to the provider from inside a
// unit test. dotenv never overrides a variable that is already set, so blank it first.
process.env.LOGS_WS_URL = ''
const { LogsSubscriber } = await import('../src/logs/subscriber.js')

type Res = { ok: boolean; status: number; json: () => Promise<any> }
const okJson = (result: any): Res => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) })
const html429: Res = { ok: false, status: 429, json: async () => { throw new SyntaxError("Unexpected token '<'") } }
const badBody: Res = { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input') } }

/** answers eth_blockNumber from a queue and eth_getLogs with nothing, like a quiet chain */
function rpcMock(heads: Res[]) {
  return vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body)
    if (body.method === 'eth_getLogs') return okJson([])
    return heads.shift() ?? okJson('0x64')
  })
}

describe('LogsSubscriber.rpc', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reports an HTTP failure by status, before touching the body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => html429))
    const s = new LogsSubscriber(100)
    await expect((s as any).rpc('eth_blockNumber', [])).rejects.toThrow('eth_blockNumber: http 429')
  })

  it('names an unparseable body as such rather than leaking a SyntaxError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => badBody))
    const s = new LogsSubscriber(100)
    await expect((s as any).rpc('eth_blockNumber', [])).rejects.toThrow('eth_blockNumber: bad body')
  })

  it('sends a timeout signal with every request', async () => {
    const f = vi.fn(async (_u: string, init: any) => {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return okJson('0x64')
    })
    vi.stubGlobal('fetch', f)
    const s = new LogsSubscriber(100)
    await expect((s as any).rpc('eth_blockNumber', [])).resolves.toBe('0x64')
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('provider log fallback', () => {
  afterEach(() => vi.unstubAllGlobals())
  const provider = 'https://provider.invalid/v2/test'

  it('rescues a refused head read without changing the public primary', async () => {
    const calls: string[] = [], counted: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return url === provider ? okJson('0x64') : html429
    }))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider, onProviderRequest: m => counted.push(m) })
    await expect((s as any).rpc('eth_blockNumber', [])).resolves.toBe('0x64')
    expect(calls).toHaveLength(2)
    expect(calls[1]).toBe(provider)
    expect(counted).toEqual(['eth_blockNumber'])
    expect(s.providerFallbacks).toBe(1)
  })

  it('splits provider log reads into consecutive ten-block slices', async () => {
    const slices: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      if (url !== provider) return html429
      const filter = JSON.parse(init.body).params[0]
      slices.push(filter)
      return okJson([{ block: filter.fromBlock }])
    }))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider })
    const result = await (s as any).rpc('eth_getLogs', [{ fromBlock: '0x64', toBlock: '0x7a', topics: ['topic'] }])
    expect(slices).toEqual([
      { fromBlock: '0x64', toBlock: '0x6d', topics: ['topic'] },
      { fromBlock: '0x6e', toBlock: '0x77', topics: ['topic'] },
      { fromBlock: '0x78', toBlock: '0x7a', topics: ['topic'] },
    ])
    expect(result).toHaveLength(3)
    expect(s.providerCalls).toBe(3)
  })

  it('does not advance the cursor or freshness when a later provider slice fails', async () => {
    let slices = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body)
      if (body.method === 'eth_blockNumber') return okJson('0x7a')
      if (url !== provider) return html429
      return ++slices === 1 ? okJson([]) : badBody
    }))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider })
    s.lastProcessedBlock = 100
    await expect((s as any).backfill()).rejects.toThrow('bad body')
    expect(s.lastProcessedBlock).toBe(100)
    expect(s.lastHealthyAt).toBe(0)
    expect(slices).toBe(2)
  })

  it('rejects a missing result instead of treating it as an empty successful poll', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson(undefined)))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider })
    await expect((s as any).rpc('eth_getLogs', [{ fromBlock: '0x64', toBlock: '0x64' }])).rejects.toThrow('missing or invalid result')
    expect(s.providerFallbacks).toBe(0)
  })

  it('falls back even when a response body ignores its abort signal', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === provider ? okJson('0x64') :
      { ok: true, status: 200, json: () => new Promise(() => {}) }))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider })
    await expect((s as any).rpc('eth_blockNumber', [])).resolves.toBe('0x64')
    expect(s.providerFallbacks).toBe(1)
    expect(s.diagnostics().request).toBeNull()
  })
})

describe('poll health', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('one failed poll keeps the stream healthy; three in a row flip it; a success resets the streak', async () => {
    vi.stubGlobal('fetch', rpcMock([html429, html429, html429, okJson('0x64'), html429]))
    const s = new LogsSubscriber(100)
    const status: Array<{ healthy: boolean; reason?: string }> = []
    s.on('status', (x) => status.push(x))
    await s.start()                       // polling, since LOGS_WS_URL is unset in tests
    expect(s.healthy).toBe(true)

    await vi.advanceTimersByTimeAsync(1)     // tick 1: 429
    expect(s.healthy).toBe(true)
    await vi.advanceTimersByTimeAsync(300)   // tick 2: 429 (backoff doubled)
    expect(s.healthy).toBe(true)
    await vi.advanceTimersByTimeAsync(600)   // tick 3: 429 -> unhealthy
    expect(s.healthy).toBe(false)
    expect(s.failures1h()).toBe(3)
    // exactly one transition was reported, not one row per failure
    expect(status.filter((x) => !x.healthy)).toHaveLength(1)
    expect(status.filter((x) => !x.healthy)[0]!.reason).toContain('3 consecutive failures')

    await vi.advanceTimersByTimeAsync(1200)  // tick 4: success
    expect(s.healthy).toBe(true)
    expect(status[status.length - 1]).toMatchObject({ healthy: true, reason: 'recovered' })

    await vi.advanceTimersByTimeAsync(150)   // tick 5: one more 429 after the reset
    expect(s.healthy).toBe(true)             // streak restarted at 1
    expect(s.failures1h()).toBe(4)
    s.stop()
  })

  it('lastHealthyAt advances only on success, so the 3s staleness guard still bites', async () => {
    vi.stubGlobal('fetch', rpcMock([html429, html429]))
    const s = new LogsSubscriber(100)
    await s.start()
    const t0 = s.lastHealthyAt
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(300)
    expect(s.healthy).toBe(true)             // two failures: flag still up
    expect(s.lastHealthyAt).toBe(t0)         // but the data is exactly as old as it really is
    s.stop()
  })

  it('failures1h forgets failures older than an hour', async () => {
    vi.stubGlobal('fetch', rpcMock([html429]))
    const s = new LogsSubscriber(100)
    await s.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(s.failures1h()).toBe(1)
    expect(s.failures1h(Date.now() + 3600_001)).toBe(0)
    s.stop()
  })
})
