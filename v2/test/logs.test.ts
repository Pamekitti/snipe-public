/**
 * The polling path of the authoritative log stream, against a mocked RPC.
 * Ported from bot/test/subscriber.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
process.env.LOGS_WS_URL = ''
const { LogsSubscriber } = await import('../io/logs.js')
const { ENDPOINTS } = await import('../io/env.js')

type Res = { ok: boolean; status: number; json: () => Promise<any> }
const okJson = (result: any): Res => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) })
const html429: Res = { ok: false, status: 429, json: async () => { throw new SyntaxError("Unexpected token '<'") } }
const badBody: Res = { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input') } }
const rpcError = (message: string): Res => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { message } }) })

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

/**
 * WHICH ENDPOINT GOES FIRST, which is the difference between a stream that works and one
 * that flaps. The public RPC used to be the primary and the keyed provider the rescue. That
 * made every call pay a failed public request on a venue that answers 429, which flipped the
 * stream unhealthy 1,027 times in three hours and refused every launch while it was. The
 * order is now provider-first with the public RPC as the fallback, and `LOGS_PREFER_PUBLIC=1`
 * puts the old order back for the day credits matter more than launches.
 */
describe('which endpoint the poller asks first', () => {
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.LOGS_PREFER_PUBLIC })
  const provider = 'https://provider.invalid/v2/test'

  it('asks the keyed provider first and never touches the public RPC when it answers', async () => {
    const calls: string[] = [], counted: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return url === provider ? okJson('0x64') : html429
    }))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider, onProviderRequest: m => counted.push(m) })
    await expect((s as any).rpc('eth_blockNumber', [])).resolves.toBe('0x64')
    expect(calls).toEqual([provider])
    expect(counted).toEqual(['eth_blockNumber'])
    // Nothing fell back. The whole point is that the healthy path costs one request.
    expect(s.providerFallbacks).toBe(0)
  })

  it('falls back to the public RPC when the provider fails, so a spent quota is not an outage', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return url === provider ? html429 : okJson('0x64')
    }))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider })
    await expect((s as any).rpc('eth_blockNumber', [])).resolves.toBe('0x64')
    expect(calls).toEqual([provider, ENDPOINTS.rpcPublic])
    expect(s.providerFallbacks).toBe(1)
  })

  it('reports the provider error, not the fallback one, when both fail', async () => {
    // The health message is the only thing an operator reads at 3am. "http 429" from the
    // endpoint we actually rely on is a diagnosis; a second failure from the endpoint we were
    // never using is noise that hides it.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === provider ? html429 : badBody)))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider })
    await expect((s as any).rpc('eth_blockNumber', [])).rejects.toThrow('eth_blockNumber: http 429')
  })

  it('goes back to public-first when LOGS_PREFER_PUBLIC is set', async () => {
    process.env.LOGS_PREFER_PUBLIC = '1'
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return url === provider ? okJson('0x64') : html429
    }))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider })
    await expect((s as any).rpc('eth_blockNumber', [])).resolves.toBe('0x64')
    expect(calls).toEqual([ENDPOINTS.rpcPublic, provider])
    expect(s.providerFallbacks).toBe(1)
  })

  it('uses the public RPC alone when no provider is configured', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return okJson('0x64') }))
    const s = new LogsSubscriber(100, () => false, Date.now, {})
    await expect((s as any).rpc('eth_blockNumber', [])).resolves.toBe('0x64')
    expect(calls).toEqual([ENDPOINTS.rpcPublic])
  })

  it('rescues a public failure with one paid request at the original range', async () => {
    process.env.LOGS_PREFER_PUBLIC = '1'
    const slices: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      if (url !== provider) return html429
      const filter = JSON.parse(init.body).params[0]
      slices.push(filter)
      return okJson([{ address: '0xa', topics: ['0x1'], data: '0x', blockNumber: filter.fromBlock,
        logIndex: '0x1', blockHash: '0xb', transactionHash: '0xt' }])
    }))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider })
    const result = await (s as any).rpc('eth_getLogs', [{ fromBlock: '0x64', toBlock: '0x7a', topics: ['topic'] }])
    expect(slices).toEqual([{ fromBlock: '0x64', toBlock: '0x7a', topics: ['topic'] }])
    expect(result).toHaveLength(1)
    expect(s.providerCalls).toBe(1)
  })

  it('splits a paid range only when that provider explicitly rejects the range', async () => {
    process.env.LOGS_PREFER_PUBLIC = '1'
    const slices: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      if (url !== provider) return html429
      const filter = JSON.parse(init.body).params[0]
      slices.push(filter)
      if (filter.fromBlock === '0x64' && filter.toBlock === '0x7a') return rpcError('block range too wide')
      return okJson([])
    }))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider })
    await (s as any).rpc('eth_getLogs', [{ fromBlock: '0x64', toBlock: '0x7a', topics: ['topic'] }])
    expect(slices).toEqual([
      { fromBlock: '0x64', toBlock: '0x7a', topics: ['topic'] },
      { fromBlock: '0x64', toBlock: '0x6f', topics: ['topic'] },
      { fromBlock: '0x70', toBlock: '0x7a', topics: ['topic'] },
    ])
  })

  it('asks the provider for the whole range in one request, not ten blocks at a time', async () => {
    // The slicing exists because the PUBLIC endpoint caps a range. Carrying it onto the
    // primary path would turn one backfill into hundreds of requests and burn the quota the
    // old order was written to protect.
    const slices: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      if (url !== provider) return html429
      slices.push(JSON.parse(init.body).params[0])
      return okJson([])
    }))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider })
    await (s as any).rpc('eth_getLogs', [{ fromBlock: '0x64', toBlock: '0x7a', topics: ['topic'] }])
    expect(slices).toEqual([{ fromBlock: '0x64', toBlock: '0x7a', topics: ['topic'] }])
  })

  it('does not advance the cursor or freshness when a poll fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      if (body.method === 'eth_blockNumber') return okJson('0x7a')
      return badBody
    }))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider })
    s.lastProcessedBlock = 100
    await expect((s as any).backfill()).rejects.toThrow('bad body')
    expect(s.lastProcessedBlock).toBe(100)
    expect(s.lastHealthyAt).toBe(0)
  })

  it('rejects a missing result instead of treating it as an empty successful poll', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson(undefined)))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider })
    await expect((s as any).rpc('eth_getLogs', [{ fromBlock: '0x64', toBlock: '0x64' }])).rejects.toThrow('missing or invalid result')
  })
})

describe('STOP ALL economy routing', () => {
  afterEach(() => vi.unstubAllGlobals())
  const provider = 'https://provider.invalid/v2/test'
  const eligible = { economyEnabled: () => true, economyEligibility: () => ({ eligible: true, reason: 'test' }) }

  it('uses public first only while explicitly enabled and eligible', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return okJson('0x64') }))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider, ...eligible })
    await (s as any).rpc('eth_blockNumber', [])
    expect(calls).toEqual([ENDPOINTS.rpcPublic])
    expect(s.routingStatus()).toMatchObject({ enabled: true, eligible: true, mode: 'public' })
  })

  it('treats a public head behind the cursor as failure and rescues it on paid', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return okJson(url === provider ? '0x64' : '0x63')
    }))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider, ...eligible })
    s.lastProcessedBlock = 100
    await expect((s as any).rpc('eth_blockNumber', [])).resolves.toBe('0x64')
    expect(calls).toEqual([ENDPOINTS.rpcPublic, provider])
    expect(s.routingStatus().public.failures).toBe(1)
    expect(s.routingStatus().paid.fallbacks).toBe(1)
  })

  it('probes public after five seconds following two public failures', async () => {
    let now = 1_000
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return url === provider ? okJson('0x64') : html429
    }))
    const s = new LogsSubscriber(100, () => false, () => now, { providerUrl: provider, ...eligible })
    await (s as any).rpc('eth_blockNumber', [])
    await (s as any).rpc('eth_blockNumber', [])
    calls.length = 0
    await (s as any).rpc('eth_blockNumber', [])
    expect(calls).toEqual([provider])
    expect(s.routingStatus().mode).toBe('cooldown')
    now += 5_001
    calls.length = 0
    await (s as any).rpc('eth_blockNumber', [])
    expect(calls[0]).toBe(ENDPOINTS.rpcPublic)
  })

  it('forces a keyed catch-up and waits for driver processing before resume', async () => {
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider, ...eligible })
    const order: string[] = []
    ;(s as any).backfill = async (forcePaid: boolean) => { order.push(`backfill:${forcePaid}`) }
    await s.preparePaidResume(async () => { order.push('processed') }, () => true)
    s.stop()
    expect(order).toEqual(['backfill:true', 'processed'])
  })

  it('waits for an active poll before starting the keyed catch-up', async () => {
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider, ...eligible })
    let release = (): void => {}
    ;(s as any).pollInFlight = new Promise<void>((resolve) => { release = resolve })
    const order: string[] = []
    ;(s as any).backfill = async () => { order.push('catch-up') }
    const preparing = s.preparePaidResume(async () => { order.push('processed') }, () => true)
    await Promise.resolve()
    expect(order).toEqual([])
    release()
    await preparing
    s.stop()
    expect(order).toEqual(['catch-up', 'processed'])
  })

  it('keeps STOP set when a newer STOP cancels preparation', async () => {
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider, ...eligible })
    ;(s as any).backfill = async () => {}
    await expect(s.preparePaidResume(async () => {}, () => false)).rejects.toThrow(/cancelled by a newer STOP/)
    s.stop()
  })
})

describe('halted transport timing', () => {
  const provider = 'https://provider.invalid/v2/test'
  const eligible = { economyEnabled: () => true, economyEligibility: () => ({ eligible: true, reason: 'all halted' }) }
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('keeps a rescued paid head and its log scan on the same route', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      const method = JSON.parse(init.body).method
      calls.push(`${url === provider ? 'paid' : 'public'}:${method}`)
      if (url !== provider) return html429
      return okJson(method === 'eth_blockNumber' ? '0x70' : [])
    }))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider, ...eligible })
    await (s as any).backfill()
    expect(calls).toEqual(['public:eth_blockNumber', 'paid:eth_blockNumber', 'paid:eth_getLogs'])
    expect(s.routingStatus().consecutivePublicFailures).toBe(1)
    expect(s.lastProcessedBlock).toBe(112)
  })

  it('lets public reach already-covered blocks without repeatedly paying to move the cursor ahead', async () => {
    let now = 10_000, head = 96
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push(url)
      return okJson(JSON.parse(init.body).method === 'eth_blockNumber' ? `0x${head.toString(16)}` : [])
    }))
    const s = new LogsSubscriber(100, () => false, () => now, { providerUrl: provider, ...eligible })
    s.lastProcessedBlock = 100
    s.lastHealthyAt = now
    await (s as any).backfill()
    expect(s.lastProcessedBlock).toBe(100)
    expect(s.lastHealthyAt).toBe(10_000)
    now += 1000; head = 101
    await (s as any).backfill()
    expect(s.lastProcessedBlock).toBe(101)
    expect(s.lastHealthyAt).toBe(11_000)
    expect(calls.every(url => url === ENDPOINTS.rpcPublic)).toBe(true)
  })

  it('rescues a stalled public head and malformed logs without advancing failed coverage', async () => {
    let now = 10_000
    const s = new LogsSubscriber(100, () => false, () => now, { providerUrl: provider, ...eligible })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      if (JSON.parse(init.body).method === 'eth_blockNumber') return okJson(url === provider ? '0x70' : '0x64')
      return url === provider ? okJson([]) : okJson([{}])
    }))
    await (s as any).backfill()
    now += 4000
    await (s as any).backfill()
    expect(s.lastProcessedBlock).toBe(112)
    expect(s.routingStatus().public.failures).toBeGreaterThan(0)
    expect(s.routingStatus().paid.fallbacks).toBeGreaterThan(0)
    const covered = s.lastProcessedBlock, healthyAt = s.lastHealthyAt
    vi.stubGlobal('fetch', vi.fn(async () => html429))
    now += 4000
    await expect((s as any).backfill()).rejects.toThrow()
    expect(s.lastProcessedBlock).toBe(covered)
    expect(s.lastHealthyAt).toBe(healthyAt)
  })

  it('does not restart polling over a scan still unwinding after preparation times out', async () => {
    vi.useFakeTimers()
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider, ...eligible })
    let release!: () => void
    const scan = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    ;(s as any).backfill = scan
    const pending = s.preparePaidResume(async () => {}, () => true, 100)
    const rejected = expect(pending).rejects.toThrow(/exceeded/)
    await vi.advanceTimersByTimeAsync(101)
    await rejected
    await vi.advanceTimersByTimeAsync(2000)
    expect(scan).toHaveBeenCalledTimes(1)
    await expect(s.preparePaidResume(async () => {}, () => true)).rejects.toThrow(/already running/)
    s.stop()
    release()
    await Promise.resolve()
  })

  it('rejects paid preparation when its head is behind and never marks it healthy', async () => {
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: provider, ...eligible })
    s.lastProcessedBlock = 100
    s.healthy = false
    vi.stubGlobal('fetch', vi.fn(async () => okJson('0x63')))
    await expect(s.preparePaidResume(async () => {}, () => true)).rejects.toThrow(/behind/)
    s.stop()
    expect(s.healthy).toBe(false)
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
    await s.start()
    expect(s.healthy).toBe(true)

    await vi.advanceTimersByTimeAsync(1)
    expect(s.healthy).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(s.healthy).toBe(true)
    await vi.advanceTimersByTimeAsync(600)
    expect(s.healthy).toBe(false)
    expect(s.failures1h()).toBe(3)
    expect(status.filter((x) => !x.healthy)).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1200)
    expect(s.healthy).toBe(true)
    expect(status[status.length - 1]).toMatchObject({ healthy: true, reason: 'recovered' })

    await vi.advanceTimersByTimeAsync(150)
    expect(s.healthy).toBe(true)
    expect(s.failures1h()).toBe(4)
    s.stop()
  })
})

/**
 * WHAT A POLL COSTS WHILE NOTHING IS AT RISK.
 *
 * Measured 2026-09-18: the poller was 70 CU a tick (`eth_blockNumber` 10 + `eth_getLogs` 60) at
 * ~385k ticks a day, ~26M of the account's 26.8M CU/day, while a position was open 1.17h of that
 * day. The interval is not free to choose, though: `foldLogs` re-stamps log freshness on every
 * delivered batch and `canEnter` refuses entry past `risk.maxLogsStalenessMs`, so the flat
 * interval plus the failure backoff on top of it has to stay inside that bound. These tests pin
 * both halves — the saving and the bound — because getting the second one wrong buys credits
 * with skipped launches.
 *
 * The predicate itself is composed in `main.ts` (`atRisk`) out of fold facts and `wsUp`. What is
 * this file's contract, and what is pinned here, is that it is consulted on EVERY successful poll
 * and that it can never make a poll look like a failure.
 */
describe('the poll interval while nothing is at risk', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  /** Counts eth_getLogs, one per poll, answering with a fresh log so a batch is really emitted. */
  function pollCounter(): () => number {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      if (JSON.parse(init.body).method !== 'eth_getLogs') return okJson('0x64')
      n++
      return okJson([{
        address: '0xa', topics: ['0x1'], data: '0x', blockNumber: 100,
        blockHash: '0xbh', transactionHash: '0xth', transactionIndex: 0, logIndex: n,
      }])
    }))
    return () => n
  }

  it('pays full speed while something is at risk', async () => {
    const polls = pollCounter()
    const s = new LogsSubscriber(100, () => false, Date.now, {}, () => true)
    await s.start()
    await vi.advanceTimersByTimeAsync(3_000)
    s.stop()
    // 150ms apart is about twenty polls in three seconds. Asserted loosely because each tick
    // also awaits two mocked round trips; the point is the order of magnitude against the flat
    // case below, not the exact count.
    expect(polls()).toBeGreaterThan(12)
  })

  it('backs off to a second while nothing is, which is the whole saving', async () => {
    const polls = pollCounter()
    const s = new LogsSubscriber(100, () => false, Date.now, {}, () => false)
    await s.start()
    await vi.advanceTimersByTimeAsync(3_000)
    s.stop()
    expect(polls()).toBeGreaterThan(1)
    expect(polls()).toBeLessThan(6)
  })

  it('still delivers well inside the entry-freshness bound while flat', async () => {
    const polls = pollCounter()
    const at: number[] = []
    const s = new LogsSubscriber(100, () => false, Date.now, {}, () => false)
    s.on('batch', () => at.push(Date.now()))
    await s.start()
    await vi.advanceTimersByTimeAsync(10_000)
    s.stop()
    expect(polls()).toBeGreaterThan(5)
    let worst = 0
    for (let i = 1; i < at.length; i++) worst = Math.max(worst, at[i]! - at[i - 1]!)
    // 3_000 is `risk.max_logs_staleness_ms` in the shipped spec. A flat interval that can reach
    // it refuses launches to save credits, which is the one trade this change must not make.
    //
    // Live, a batch is only emitted when a poll finds an unseen log, so the real gap is a multiple
    // of the interval: 2,015ms worst over 378 samples after the 2026-09-18 cutover. This mock
    // answers with a fresh log every time, so it pins the interval and not that multiple — the
    // headroom for it is why POLL_FLAT_MS is a third of the bound rather than two thirds.
    expect(worst).toBeLessThan(3_000)
  })

  it('is asked again on every poll, so a stream going down restores full speed', async () => {
    // This is the mechanism behind `atRisk`'s socket and feed clauses in `main.ts`: the answer is
    // read per tick and never cached at construction, so losing the accelerator mid-run does not
    // leave the only remaining detection path on the cheap interval.
    //
    // THE HANDOVER COSTS ONE INTERVAL, and that is pinned rather than hidden: the poll already
    // scheduled when the answer changes still fires at the flat delay, so full speed resumes on
    // the poll AFTER the flip. The lag is bounded by POLL_FLAT_MS, which is why that constant has
    // to stay well inside `risk.maxLogsStalenessMs` and not merely under it.
    const polls = pollCounter()
    let risk = false
    const s = new LogsSubscriber(100, () => false, Date.now, {}, () => risk)
    await s.start()
    await vi.advanceTimersByTimeAsync(2_000)
    const whileFlat = polls()
    risk = true
    await vi.advanceTimersByTimeAsync(1_000)
    const handover = polls() - whileFlat
    await vi.advanceTimersByTimeAsync(3_000)
    const settled = polls() - whileFlat - handover
    s.stop()
    // One flat-scheduled poll in the first second after the flip, then full speed.
    expect(handover).toBe(1)
    expect(settled).toBeGreaterThan(whileFlat * 3)
  })

  it('treats a throwing predicate as at-risk rather than as a failed poll', async () => {
    // It is evaluated inside the tick's try. A throw reaching that catch would count against
    // failStreak and eventually flip the stream unhealthy, which refuses every entry: a
    // display-grade bug turning itself into a trading outage.
    const polls = pollCounter()
    const s = new LogsSubscriber(100, () => false, Date.now, {}, () => { throw new Error('fold unavailable') })
    const status: Array<{ healthy: boolean }> = []
    s.on('status', (x) => status.push(x))
    await s.start()
    await vi.advanceTimersByTimeAsync(3_000)
    s.stop()
    expect(polls()).toBeGreaterThan(12)
    expect(s.healthy).toBe(true)
    expect(s.failures1h()).toBe(0)
    expect(status.filter((x) => !x.healthy)).toHaveLength(0)
  })

  it('keeps the old cadence for a caller that passes no predicate', async () => {
    // Every existing call site and test. The default is the expensive side on purpose.
    const polls = pollCounter()
    const s = new LogsSubscriber(100, () => false)
    await s.start()
    await vi.advanceTimersByTimeAsync(3_000)
    s.stop()
    expect(polls()).toBeGreaterThan(12)
  })
})

describe('one path for both log transports', () => {
  it('a log the socket already delivered is not emitted again by the poller', () => {
    const s = new LogsSubscriber(100)
    const batches: Array<{ source: string; logs: unknown[] }> = []
    s.on('batch', (b) => batches.push({ source: b.source, logs: [...b.logs] }))
    const log = {
      address: '0xa', topics: ['0x1'], data: '0x', blockNumber: 5, blockHash: '0xbh',
      transactionHash: '0xth', transactionIndex: 0, logIndex: 1,
    }
    ;(s as unknown as { ingest: (logs: unknown[], source: string, lo?: number, hi?: number) => void }).ingest([log], 'ws')
    ;(s as unknown as { ingest: (logs: unknown[], source: string, lo?: number, hi?: number) => void }).ingest([log], 'poll', 5, 5)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.source).toBe('ws')
    ;(s as unknown as { ingest: (logs: unknown[], source: string, lo?: number, hi?: number) => void }).ingest([{ ...log, logIndex: 2 }], 'poll', 5, 5)
    expect(batches).toHaveLength(2)
    expect(batches[1]!.source).toBe('poll')
    expect(s.lastProcessedBlock).toBe(5)
  })
})
