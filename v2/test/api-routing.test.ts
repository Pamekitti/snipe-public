import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiModeController } from '../io/api-mode.js'
import { makeWorld } from '../io/world.js'
import { LogsSubscriber } from '../io/logs.js'
import { Sender } from '../io/sender.js'
import { keccak256, type Hex } from 'viem'

const paid = 'https://paid.invalid/v2/test'
const free = 'https://public.invalid/'
const token = '0x1111111111111111111111111111111111111111'
const hash = `0x${'ab'.repeat(32)}`
const subscribers: LogsSubscriber[] = []
beforeEach(() => {
  vi.stubEnv('RPC_KEY_URL', paid); vi.stubEnv('RPC_PUBLIC_URL', free)
  vi.stubEnv('PRIVATE_KEY', `0x${'11'.repeat(32)}`)
})
afterEach(() => { subscribers.splice(0).forEach(s => s.stop()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const controller = () => new ApiModeController('unused', new Map([['API_MODE', 'economy']]))
const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } })

describe('Economy uses the real read transport', () => {
  it('prepares a provider upgrade with open obligations without resetting the nonce ladder', async () => {
    const methods: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); methods.push(body.method); return reply('0x1')
    }))
    const made = makeWorld({ mode: 'shadow', record: () => {}, log: () => {}, apiMode: controller() })
    await made.prepareExecution(false)
    expect(methods).toEqual(['eth_gasPrice'])
  })
  it('resends exactly the same signed bytes for an existing obligation after sequencer failure', async () => {
    const raw: Hex = '0x1234', hash = keccak256(raw), urls: string[] = []
    vi.spyOn(Sender.prototype, 'send').mockResolvedValue({ ok: false, error: 'transport: http 503', nonceConsumed: true, ms: 1, via: 'seq' })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      urls.push(String(url)); const body = JSON.parse(String(init.body))
      expect(body.method).toBe('eth_sendRawTransaction'); expect(body.params).toEqual([raw])
      return String(url) === free ? new Response('unavailable', { status: 503 }) : reply(hash)
    }))
    const made = makeWorld({ mode: 'live', record: () => {}, log: () => {}, apiMode: controller(),
      recoveryOwner: (what, args) => what === 'receipt' && args[0] === hash ? 'old-signed-tx' : null })
    expect(await made.world.broadcast(raw)).toMatchObject({ ok: true, hash, nonceConsumed: true, uncertain: false })
    expect(urls).toEqual([free, paid])
  })
  it('does not rescue an unknown broadcast through paid RPC', async () => {
    vi.spyOn(Sender.prototype, 'send').mockResolvedValue({ ok: false, error: 'transport: http 503', nonceConsumed: true, ms: 1, via: 'seq' })
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const made = makeWorld({ mode: 'live', record: () => {}, log: () => {}, apiMode: controller(), recoveryOwner: () => null })
    expect(await made.world.broadcast('0x1234')).toMatchObject({ ok: false, nonceConsumed: true, uncertain: true })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('keeps boot, wallet reporting, gas and idle nonce maintenance public', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      urls.push(String(url)); const body = JSON.parse(String(init.body))
      return reply(body.method === 'eth_chainId' ? '0x1237' : '0x1')
    }))
    const made = makeWorld({ mode: 'shadow', record: () => {}, log: () => {}, apiMode: controller() })
    expect(await made.readChainId()).toBe(4663)
    await made.start(); await made.world.read('balance', [token]); await made.maintain(true)
    expect(urls.length).toBeGreaterThan(4)
    expect(new Set(urls)).toEqual(new Set([free]))
  })
  it('does not rescue failed monitoring or maintenance with paid requests', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(String(url)); return new Response('rate limited', { status: 429 }) }))
    const made = makeWorld({ mode: 'shadow', record: () => {}, log: () => {}, apiMode: controller() })
    expect((await made.world.read('balance', [token])).result).toBeNull()
    await made.maintain(true)
    expect(urls).not.toContain(paid)
  })
  it('records a scoped paid wallet rescue after a public failure', async () => {
    const urls: string[] = [], onRpc = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url)); return String(url) === free ? new Response('failure', { status: 503 }) : reply(`0x${'2'.padStart(64, '0')}`)
    }))
    const made = makeWorld({ mode: 'shadow', record: () => {}, log: () => {}, apiMode: controller(), onRpc,
      recoveryOwner: (what, args) => what === 'position-wallet' && args[0] === token ? 'position-1' : null })
    const result = await made.world.read('position-wallet', [token, 'position-1'])
    expect(result.result).toEqual({ balanceWei: '2' })
    expect(urls).toEqual([free, paid])
    expect(onRpc).toHaveBeenCalledWith('paid', 'eth_call', 'exit-rescue', 'request', 'position-1')
  })
  it('rechecks ownership before rescue and refuses an unrelated token', async () => {
    let owned = true; const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url)); owned = false; return new Response('failure', { status: 503 })
    }))
    const made = makeWorld({ mode: 'shadow', record: () => {}, log: () => {}, apiMode: controller(),
      recoveryOwner: () => owned ? 'position-1' : null })
    expect((await made.world.read('position-wallet', [token])).result).toBeNull()
    expect(urls).toEqual([free])
  })
  it('checks an owned receipt on paid when the public endpoint has not seen it', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url)); return String(url) === free ? reply(null) : reply({
        transactionHash: hash, transactionIndex: '0x0', blockHash: hash, blockNumber: '0x64',
        from: token, to: token, cumulativeGasUsed: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1',
        contractAddress: null, logs: [], logsBloom: '0x', status: '0x1', type: '0x0',
      })
    }))
    const made = makeWorld({ mode: 'shadow', record: () => {}, log: () => {}, apiMode: controller(),
      recoveryOwner: (what, args) => what === 'receipt' && args[0] === hash ? 'signed-buy' : null })
    expect((await made.world.read('receipt', [hash, '', '', 'buy'])).result).toMatchObject({ ok: true, gasWei: '1' })
    expect(urls).toEqual([free, paid])
  })
})

describe('Economy log collection and preparation', () => {
  it('rejects a public head that stops advancing without spending on paid monitoring', async () => {
    let now = 1_000; const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(String(url)); return reply('0x64') }))
    const s = new LogsSubscriber(100, () => false, () => now, { providerUrl: paid, apiMode: () => 'economy' }); subscribers.push(s)
    await (s as any).rpc('eth_blockNumber', [])
    now += 3_001
    await expect((s as any).rpc('eth_blockNumber', [])).rejects.toThrow('stopped advancing')
    expect(urls).toEqual([free, free])
  })
  it('refuses paid monitoring, even when an old path requests forced paid catch-up', async () => {
    const fetcher = vi.fn(async () => reply('0x64')); vi.stubGlobal('fetch', fetcher)
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: paid, apiMode: () => 'economy' }); subscribers.push(s)
    await expect((s as any).rpc('eth_blockNumber', [], true)).rejects.toThrow('forbids paid monitoring')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('never falls back to paid logs after a public failure', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(String(url)); return new Response('failure', { status: 429 }) }))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: paid, apiMode: () => 'economy' }); subscribers.push(s)
    await expect((s as any).rpc('eth_blockNumber', [])).rejects.toThrow()
    expect(urls).toEqual([free])
  })
  it('waits for the public head to cover the previous cursor before completing preparation', async () => {
    const urls: string[] = []; let heads = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      urls.push(String(url)); const body = JSON.parse(String(init.body))
      return reply(body.method === 'eth_blockNumber' ? (++heads === 1 ? '0x63' : '0x64') : [])
    }))
    const s = new LogsSubscriber(100, () => false, Date.now, { providerUrl: paid, apiMode: () => 'economy' }); subscribers.push(s)
    const processed = vi.fn(async () => {})
    await s.start()
    await s.prepareResume('public', processed, () => true)
    expect(heads).toBe(2); expect(processed).toHaveBeenCalledOnce()
    expect(s.healthy).toBe(true); expect(new Set(urls)).toEqual(new Set([free]))
  })
})
