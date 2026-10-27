import { describe, expect, it } from 'vitest'
import { FeedClient } from '../src/feed/client.js'
import { createServer } from 'node:http'
import { once } from 'node:events'

/**
 * The feed is what releases armed entries on observed block timestamps. When it dies the
 * bot does not stop, it silently falls back to a wall clock aimed 600ms late and every
 * entry gets worse. So "did it keep trying to reconnect" is a money question.
 */
describe('FeedClient reconnect', () => {
  it('honours Retry-After, retries when it expires, and cancels the wait when stopped', async () => {
    const hits: number[] = []
    const server = createServer((_req, res) => {
      hits.push(Date.now())
      res.writeHead(403, {'Retry-After':'1', Connection:'close'}); res.end('temporarily blocked')
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const c = new FeedClient(`ws://127.0.0.1:${(server.address() as any).port}`)
    let gaps = 0; c.on('gap', () => gaps++)
    try {
      const first = once(c, 'status'); c.start()
      expect((await first)[0]).toMatchObject({connected:false,reason:'HTTP 403; retry in 1s'})
      const second = once(c, 'status')
      await new Promise(r => setTimeout(r, 300))
      expect(hits).toHaveLength(1)
      await second
      expect(hits).toHaveLength(2)
      expect(hits[1]! - hits[0]!).toBeGreaterThanOrEqual(990)
      expect(gaps).toBe(2)
      c.stop()
      await new Promise(r => setTimeout(r, 1100))
      expect(hits).toHaveLength(2)
    } finally { c.stop(); server.close(); server.closeAllConnections() }
  }, 8000)

  it.each([403,429])('backs off an HTTP %s rejection without a usable Retry-After', async status => {
    let hits = 0
    const server = createServer((_req, res) => {
      hits++; res.writeHead(status, {'Retry-After':'invalid', Connection:'close'}); res.end()
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const c = new FeedClient(`ws://127.0.0.1:${(server.address() as any).port}`)
    try {
      const rejected = once(c, 'status'); c.start()
      expect((await rejected)[0].reason).toBe(`HTTP ${status}; retry in 60s`)
      await new Promise(r => setTimeout(r, 300))
      expect(hits).toBe(1)
    } finally { c.stop(); server.close(); server.closeAllConnections() }
  })

  it('accepts an HTTP-date cooldown without leaving a timer after stop', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(429, {'Retry-After':new Date(Date.now()+60_000).toUTCString(), Connection:'close'}); res.end()
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const c = new FeedClient(`ws://127.0.0.1:${(server.address() as any).port}`)
    try {
      const rejected = once(c, 'status'); c.start()
      expect((await rejected)[0].reason).toMatch(/HTTP 429; retry in (59|60)s/)
      c.stop()
      expect((c as any).reconnectTimer).toBeNull()
    } finally { c.stop(); server.close(); server.closeAllConnections() }
  })

  it('keeps reconnecting after repeated failures', async () => {
    // port 1 refuses instantly, so every attempt fails the same way a dead relay would
    const c = new FeedClient('ws://127.0.0.1:1')
    let downs = 0
    c.on('status', (s) => { if (!s.connected) downs++ })
    c.start()
    await new Promise((r) => setTimeout(r, 1_800))
    c.stop()
    // The old dedupe was `!connected && attempt > 0`, which also matched every failure of
    // a socket that never opened: the first retry returned early, nothing was scheduled,
    // and the feed stayed dead for the life of the process. That produced exactly 1.
    expect(downs).toBeGreaterThan(2)
  })

  it('emits exactly one gap per disconnect, so error+close do not double-reconnect', async () => {
    // Dedupe is now on socket identity, so the pair of events one dying socket emits
    // collapses to a single down(). Counting both sides keeps that honest without racing
    // the backoff jitter: whatever the attempt count, the two must stay in lockstep.
    const c = new FeedClient('ws://127.0.0.1:1')
    let downs = 0, gaps = 0
    c.on('status', (s) => { if (!s.connected) downs++ })
    c.on('gap', () => gaps++)
    c.start()
    await new Promise((r) => setTimeout(r, 1_000))
    c.stop()
    expect(downs).toBeGreaterThan(0)
    expect(gaps).toBe(downs)
  })
})

describe('FeedClient liveness (2026-09-06)', () => {
  it('a frame from the server clears the pong deadline: streaming frames are proof of life', async () => {
    // ~100 drops in three days, 37 in one busy hour, all 'pong timeout' while blocks kept
    // arriving; each one put every entry in the gap on the wall clock aimed 600ms late
    const { vi } = await import('vitest')
    vi.useFakeTimers()
    try {
      const c = new FeedClient('ws://127.0.0.1:1') // never started: no socket, no reconnects
      const downs: string[] = []
      c.on('status', (s) => { if (!s.connected) downs.push(s.reason ?? '') })
      ;(c as any).pongTimer = setTimeout(() => (c as any).down('pong timeout'), 5_000)
      await vi.advanceTimersByTimeAsync(4_000)
      ;(c as any).onMessage('{}') // any bytes at all
      await vi.advanceTimersByTimeAsync(6_000)
      expect(downs).toEqual([])
      expect((c as any).pongTimer).toBeNull()
      // and silence still drops it (stopped: the drop must not schedule a reconnect here)
      ;(c as any).stopped = true
      ;(c as any).pongTimer = setTimeout(() => (c as any).down('pong timeout'), 5_000)
      await vi.advanceTimersByTimeAsync(6_000)
      expect(downs).toEqual(['pong timeout'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('non-transaction feed messages consume their sequence number (2026-09-06)', () => {
  // header kinds 13/9/12 (batch posting reports and the like) arrived ~40 times an hour and
  // every one read as a lost block, dropping the optimistic overlay for the coins being
  // exited. A standalone probe over 6 minutes: 4 gaps, all 4 right after an ignored message.
  const block = (seq: number) => JSON.stringify({ version: 1, messages: [{ sequenceNumber: seq, message: { message: { header: { kind: 3, timestamp: 1_700_000_000 + seq }, l2Msg: Buffer.from([3]).toString('base64') } }, blockHash: null }] })
  const report = (seq: number, kind = 13) => JSON.stringify({ version: 1, messages: [{ sequenceNumber: seq, message: { message: { header: { kind, timestamp: 1 } } } }] })

  it('a batch posting report between two blocks is not a gap', () => {
    const c = new FeedClient('ws://127.0.0.1:1')
    const gaps: any[] = [], blocks: number[] = []
    c.on('gap', (g) => gaps.push(g))
    c.on('block', (b) => blocks.push(b.block))
    ;(c as any).onMessage(block(100))
    ;(c as any).onMessage(report(101))
    ;(c as any).onMessage(block(102))
    ;(c as any).onMessage(report(103, 9))
    ;(c as any).onMessage(report(104, 12))
    ;(c as any).onMessage(block(105))
    expect(blocks).toEqual([100, 102, 105])
    expect(gaps).toEqual([])
    // a real hole is still a gap, whichever kind lands after it
    ;(c as any).onMessage(report(107))
    expect(gaps).toEqual([{ expected: 106, got: 107 }])
    ;(c as any).onMessage(block(108))
    expect(gaps).toHaveLength(1)
    // and a resume duplicate of an ignored message is ignored, not a gap
    ;(c as any).onMessage(report(104))
    expect(gaps).toHaveLength(1)
  })

  it('an unparseable frame still cannot be trusted: no sequence number, no advance', () => {
    const c = new FeedClient('ws://127.0.0.1:1')
    const gaps: any[] = []
    c.on('gap', (g) => gaps.push(g))
    ;(c as any).onMessage(block(100))
    ;(c as any).onMessage('not json')
    ;(c as any).onMessage(block(101))
    expect(gaps).toEqual([]) // nothing was skipped; 101 follows 100
    ;(c as any).onMessage(block(103))
    expect(gaps).toEqual([{ expected: 102, got: 103 }])
  })
})
