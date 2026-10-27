/**
 * The websocket ACCELERATOR, against a fake socket.
 *
 * Since 2026-09-06 the socket is not a second transport for the whole stream: the free
 * tier bills per byte and the full stream would cost 48x the monthly quota. It subscribes
 * to launches only, runs only while the entry window is open, and never touches the
 * poller, which stays the authority for every event and for `healthy`. What this pins:
 * the one subscription it sends, that polling keeps going, that a launch is emitted once
 * whichever transport wins, that a socket log never moves the poller's cursor, the
 * ping/pong liveness, the reconnect, and the window gate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ sockets: [] as any[] }))

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWebSocket extends EventEmitter {
    sent: string[] = []
    pings = 0
    terminated = false
    constructor(public url: string) { super(); h.sockets.push(this) }
    send(m: string) { this.sent.push(m) }
    ping() { this.pings++ }
    terminate() { this.terminated = true }
    close() { this.terminated = true }
  }
  return { default: FakeWebSocket }
})

// a usable-looking provider url, set before config.ts is first imported by this file
process.env.LOGS_WS_URL = 'wss://robinhood-mainnet.example.test/v2/abcdef'

const okJson = (result: any) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) })
/** a chain whose tip is fixed and whose only logs are the ones the test hands it */
function chain(polled: any[] = []) {
  return vi.fn(async (_u: string, init: any) => {
    const body = JSON.parse(init.body)
    return body.method === 'eth_getLogs' ? okJson(polled) : okJson('0x64')
  })
}
const LAUNCH_TOPIC = '0x' + '11'.repeat(32)
const rawLog = (blockNumber = '0x66', logIndex = '0x2') => ({
  address: '0xABCDEF0000000000000000000000000000000001', topics: [LAUNCH_TOPIC], data: '0x',
  blockNumber, logIndex, transactionHash: '0x' + 'aa'.repeat(32), blockHash: '0x' + 'bb'.repeat(32),
})
const frame = (result: any) => Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: '0x1', result } }))

async function up(wanted: () => boolean = () => true, polled: any[] = []) {
  const { LogsSubscriber } = await import('../src/logs/subscriber.js')
  const s = new LogsSubscriber(100, wanted)
  const wsEvents: any[] = []
  s.on('ws', (x) => wsEvents.push(x))
  await s.start()
  return { s, wsEvents, ws: () => h.sockets[h.sockets.length - 1], fetchMock: globalThis.fetch as any }
}

describe('the websocket launch accelerator', () => {
  beforeEach(() => { h.sockets.length = 0; vi.useFakeTimers(); vi.stubGlobal('fetch', chain()) })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('subscribes to the factory launch event only: no newHeads, no full stream', async () => {
    const { s, ws, wsEvents } = await up()
    ws().emit('open')
    const frames = ws().sent.map((m: string) => JSON.parse(m))
    expect(frames).toHaveLength(1)
    expect(frames[0].method).toBe('eth_subscribe')
    expect(frames[0].params[0]).toBe('logs')
    expect(frames[0].params[1].address).toMatch(/^0x/)         // the factory
    expect(frames[0].params[1].topics).toHaveLength(1)          // one topic, one filter
    expect(s.wsUp).toBe(true)
    expect(wsEvents[0]).toMatchObject({ up: true })
    s.stop()
  })

  it('polling keeps running while the socket is up, and the socket never changes mode or health', async () => {
    const { s, ws, fetchMock } = await up()
    ws().emit('open')
    const before = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before)   // the poller is still asking
    expect(s.mode).toBe('poll')
    expect(s.healthy).toBe(true)
    s.stop()
  })

  it('emits a socket launch at once, marked viaWs, once only, and never moves the poller cursor', async () => {
    // The socket carries the launch ALONE (the subscription is launches only; a receipt for
    // the rest of the transaction costs 8x the monthly quota). `viaWs` tells bot.ts to read
    // the creator's buy from the launch calldata instead of the batch; see wslaunch.test.ts
    // for that end to end. The 2026-09-06 review caught the bare log screening as "dev buy 0".
    const { s, ws } = await up(() => true, [rawLog('0x66', '0x2')])
    ws().emit('open')
    const got: any[] = []
    s.on('logs', (ls) => got.push(...ls))
    const cursor = s.lastProcessedBlock
    ws().emit('message', frame(rawLog('0x6a', '0x2')))          // block 106, ahead of the public tip (100)
    expect(got).toHaveLength(1)                                 // no round trip in between
    expect(got[0]).toMatchObject({ blockNumber: 106, address: '0xabcdef0000000000000000000000000000000001', viaWs: true })
    expect(ws().sent).toHaveLength(1)                           // the subscription; no receipt request
    expect(s.wsFirstSeen).toBe(1)
    expect(s.lastProcessedBlock).toBe(cursor)                   // the poller still owns blocks 101..105
    // the same launch delivered again (socket or poller): seen, not emitted twice
    await vi.advanceTimersByTimeAsync(200)
    ws().emit('message', frame(rawLog('0x6a', '0x2')))
    expect(got).toHaveLength(1)
    s.stop()
  })

  it('a socket that stops answering pings is dropped and reconnected with backoff; polling and health untouched', async () => {
    const { s, ws, wsEvents } = await up()
    const first = ws()
    first.emit('open')
    await vi.advanceTimersByTimeAsync(2_100)
    expect(first.pings).toBeGreaterThan(0)
    first.emit('pong')                                          // one answer, then silence
    await vi.advanceTimersByTimeAsync(6_100)
    expect(first.terminated).toBe(true)
    expect(wsEvents.find((x) => !x.up)?.reason).toBe('no pong')
    expect(s.wsUp).toBe(false)
    expect(s.healthy).toBe(true)
    expect(s.mode).toBe('poll')
    await vi.advanceTimersByTimeAsync(3_000)                    // first backoff step
    expect(h.sockets).toHaveLength(2)
    s.stop()
  })

  it('a socket error takes the same road, and a reconnect re-subscribes', async () => {
    const { s, ws } = await up()
    ws().emit('open')
    ws().emit('error', new Error('ECONNRESET'))
    expect(s.wsUp).toBe(false)
    await vi.advanceTimersByTimeAsync(3_000)
    const second = h.sockets[1]
    second.emit('open')
    expect(second.sent).toHaveLength(1)
    s.stop()
  })

  it('outside the entry window there is no socket; when the window opens it connects; when it closes it hangs up', async () => {
    let open = false
    const { s } = await up(() => open)
    expect(h.sockets).toHaveLength(0)
    open = true
    await vi.advanceTimersByTimeAsync(30_000)                   // the window check
    expect(h.sockets).toHaveLength(1)
    h.sockets[0].emit('open')
    expect(s.wsUp).toBe(true)
    open = false
    await vi.advanceTimersByTimeAsync(30_000)
    expect(s.wsUp).toBe(false)
    expect(h.sockets[0].terminated).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)                   // and it does not creep back
    expect(h.sockets).toHaveLength(1)
    s.stop()
  })

  it('projects its own compute-unit spend from the bytes it received', async () => {
    const { s, ws } = await up()
    ws().emit('open')
    const f = frame(rawLog())
    for (let i = 0; i < 10; i++) ws().emit('message', f)
    expect(s.wsBytes).toBe(f.length * 10)
    await vi.advanceTimersByTimeAsync(60_000)
    const cu = s.wsCuPerMonth()!
    // 10 events of f.length bytes in a minute, x 0.04 CU/byte, x 30 days
    expect(cu).toBeCloseTo((f.length * 10 / 60_000) * 30 * 86_400_000 * 0.04, -3)
    s.stop()
  })

  it('hanging up on a socket that has not finished connecting does not throw', async () => {
    // the real `ws` emits an 'error' on terminate() before 'open'; with no listener that is
    // an uncaught exception, and the window closing during a reconnect would trigger it
    let open = true
    const { s, ws } = await up(() => open)
    const sock = ws()
    sock.terminate = function () { this.terminated = true; this.emit('error', new Error('WebSocket was closed before the connection was established')) }
    open = false
    expect(() => { (s as any).checkWindow() }).not.toThrow()
    expect(sock.terminated).toBe(true)
    s.stop()
  })

  it('polls the PUBLIC endpoint, never the key: the free tier caps getLogs at 10 blocks', async () => {
    const { s, fetchMock } = await up()
    await vi.advanceTimersByTimeAsync(10)
    const urls = new Set(fetchMock.mock.calls.map((c: any[]) => c[0]))
    for (const u of urls) expect(String(u)).not.toContain('alchemy')
    s.stop()
  })
})
