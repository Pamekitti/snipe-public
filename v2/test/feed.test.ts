import { describe, expect, it } from 'vitest'
import { FeedClient } from '../io/feed.js'
import { decodeFrame } from '../io/decoder.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

describe('feed decoder', () => {
  it('survives garbage input', () => {
    expect(decodeFrame('not json')[0]!.kind).toBe('ignored')
    expect(decodeFrame('{"version":1}')[0]!.kind).toBe('ignored')
  })

  it('a confirmed-sequence frame is not a block', () => {
    const r = decodeFrame(JSON.stringify({ confirmedSequenceNumberMessage: { sequenceNumber: 9 } }))
    expect(r).toEqual([{ kind: 'confirmed', sequenceNumber: 9 }])
  })

  it('a non-L2 header consumes its sequence number as ignored', () => {
    const r = decodeFrame(JSON.stringify({
      version: 1,
      messages: [{ sequenceNumber: 40, message: { message: { header: { kind: 13, timestamp: 1 } } } }],
    }))
    expect(r[0]).toMatchObject({ kind: 'ignored', sequenceNumber: 40 })
  })

  it('drops a block whose sequence number will not parse, rather than emitting NaN', () => {
    /**
     * The `ignored` branches above have always checked `Number.isFinite`; the block branch did
     * not, so `block: Number(undefined)` was `NaN`. Every comparison against NaN is false, so
     * the gap detector stops seeing holes, and on the tape JSON turns it into `null`, which
     * means a replay reads a different number than the live run did. One lost block is cheap;
     * a sequence tracker that has quietly stopped working is not.
     */
    const frame = (sequenceNumber: unknown) => JSON.stringify({
      version: 1,
      messages: [{ sequenceNumber, message: { message: { header: { kind: 3, timestamp: 1 }, l2Msg: '' } } }],
    })
    for (const bad of [undefined, null, 'not-a-number', {}]) {
      const r = decodeFrame(frame(bad))
      expect(r.every((x) => x.kind !== 'block')).toBe(true)
    }
    // ...and a good one still decodes, so this is a guard and not a blanket refusal.
    const ok = decodeFrame(frame(41))
    expect(ok.some((x) => x.kind === 'block')).toBe(true)
  })
})

describe('FeedClient reconnect', () => {
  it('honours Retry-After, retries when it expires, and cancels the wait when stopped', async () => {
    const hits: number[] = []
    const server = createServer((_req, res) => {
      hits.push(Date.now())
      res.writeHead(403, { 'Retry-After': '1', Connection: 'close' }); res.end('temporarily blocked')
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const c = new FeedClient(`ws://127.0.0.1:${(server.address() as any).port}`)
    let gaps = 0; c.on('gap', () => gaps++)
    try {
      const first = once(c, 'status'); c.start()
      expect((await first)[0]).toMatchObject({ connected: false, reason: 'HTTP 403; retry in 1s' })
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

  it('keeps reconnecting after repeated failures', async () => {
    const c = new FeedClient('ws://127.0.0.1:1')
    let downs = 0
    c.on('status', (s) => { if (!s.connected) downs++ })
    c.start()
    await new Promise((r) => setTimeout(r, 1_800))
    c.stop()
    expect(downs).toBeGreaterThan(2)
  })

  it('emits exactly one gap per disconnect, so error+close do not double-reconnect', async () => {
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

/**
 * THE BAN THAT KEPT RENEWING ITSELF. The feed closed at 15:36:50 on 2026-09-16, the instant
 * reconnect was refused with `retry in 3600s`, and the venue said why: "Blocked for 1 hour
 * after sustained feed connection rejections". The cooldown lived in memory, so every restart
 * connected immediately, was refused, and pushed the hour out again. Seven such attempts were
 * recorded on the tape, none of which could have succeeded. Entries refuse without the
 * overlay, so the cost of forgetting was every trade in that window.
 */
describe('FeedClient remembers an upstream cooldown across restarts', () => {
  const file = () => `${tmpdir()}/feed-cooldown-${Math.random().toString(36).slice(2)}.json`

  it('does not connect at all while a remembered cooldown is still running', async () => {
    const path = file()
    writeFileSync(path, JSON.stringify({ until: Date.now() + 60_000, reason: 'HTTP 403' }))
    let hits = 0
    const server = createServer((_req, res) => { hits++; res.writeHead(403); res.end() })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const c = new FeedClient(`ws://127.0.0.1:${(server.address() as any).port}`, path)
    try {
      const status = once(c, 'status')
      c.start()
      expect((await status)[0].reason).toMatch(/upstream cooldown from a previous run/)
      await new Promise((r) => setTimeout(r, 300))
      // The whole point: the socket was never opened, so the ban was never renewed.
      expect(hits).toBe(0)
    } finally { c.stop(); server.close(); server.closeAllConnections(); rmSync(path, { force: true }) }
  }, 8000)

  it('connects normally when the remembered cooldown has already expired', async () => {
    const path = file()
    writeFileSync(path, JSON.stringify({ until: Date.now() - 1, reason: 'HTTP 403' }))
    let hits = 0
    const server = createServer((_req, res) => { hits++; res.writeHead(403); res.end() })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const c = new FeedClient(`ws://127.0.0.1:${(server.address() as any).port}`, path)
    try {
      c.start()
      await new Promise((r) => setTimeout(r, 300))
      expect(hits).toBe(1)
    } finally { c.stop(); server.close(); server.closeAllConnections(); rmSync(path, { force: true }) }
  }, 8000)

  it('writes the cooldown down when the venue refuses, so the next process knows', async () => {
    const path = file()
    const server = createServer((_req, res) => { res.writeHead(403, { 'Retry-After': '900', Connection: 'close' }); res.end() })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const c = new FeedClient(`ws://127.0.0.1:${(server.address() as any).port}`, path)
    try {
      const status = once(c, 'status')
      c.start()
      await status
      const saved = JSON.parse(readFileSync(path, 'utf8')) as { until: number; reason: string }
      expect(saved.reason).toBe('HTTP 403; retry in 900s')
      expect(saved.until - Date.now()).toBeGreaterThan(890_000)
    } finally { c.stop(); server.close(); server.closeAllConnections(); rmSync(path, { force: true }) }
  }, 8000)

  it('treats an unreadable cooldown as no cooldown rather than refusing to start', async () => {
    const path = file()
    writeFileSync(path, 'not json at all')
    let hits = 0
    const server = createServer((_req, res) => { hits++; res.writeHead(403); res.end() })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const c = new FeedClient(`ws://127.0.0.1:${(server.address() as any).port}`, path)
    try {
      c.start()
      await new Promise((r) => setTimeout(r, 300))
      expect(hits).toBe(1)
    } finally { c.stop(); server.close(); server.closeAllConnections(); rmSync(path, { force: true }) }
  }, 8000)
})

describe('non-transaction feed messages consume their sequence number', () => {
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
    expect(blocks).toEqual([100, 102])
    expect(gaps).toEqual([])
    ;(c as any).onMessage(report(107))
    expect(gaps).toEqual([{ expected: 103, got: 107 }])
  })
})
