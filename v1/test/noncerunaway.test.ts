/**
 * The nonce runaway of 2026-09-05 21:05 UTC.
 *
 * The public RPC was rate-limiting. Each 429 fell through to JSON.parse on an HTML body,
 * threw, was classified "transport" and therefore consumed, and the local counter advanced
 * with nothing sequenced. Twenty rejected sells on a resumed position in thirty seconds put
 * the counter twenty ahead of the chain; every send for the next 37 minutes came back
 * "nonce too high", thirteen buys sat open as phantoms, and two real bags could not sell.
 * resyncIfIdle() could not repair it because the phantoms kept inFlight above zero.
 *
 * Two defects, tested separately: the classification (an HTTP refusal is not a sequencing),
 * and the repair (a proven-wrong counter re-reads the chain without waiting to be idle).
 */
import { describe, it, expect } from 'vitest'
import { classifySend } from '../src/tx/sender.js'
import { NonceManager } from '../src/tx/nonce.js'

describe('classifySend: the status code decides before the body is parsed', () => {
  it('a 429 is the HTTP layer refusing: nothing was sequenced, the nonce is still ours', () => {
    const r = classifySend(429, '<html><body>Too Many Requests</body></html>')
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.nonceConsumed).toBe(false); expect(r.error).toContain('http 429') }
  })
  it('likewise a 502 or 503 from a proxy', () => {
    for (const code of [502, 503]) {
      const r = classifySend(code, 'Bad Gateway')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.nonceConsumed).toBe(false)
    }
  })
  it('a 200 with a result is sequenced', () => {
    const r = classifySend(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xabc' }))
    expect(r).toEqual({ ok: true, hash: '0xabc' })
  })
  it('a 200 with "nonce too low" means someone used it: consumed', () => {
    const r = classifySend(200, JSON.stringify({ error: { message: 'nonce too low: expected 5, got 4' } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.nonceConsumed).toBe(true)
  })
  it('a 200 with "nonce too high" is a rejection: NOT consumed, and the caller must resync', () => {
    const r = classifySend(200, JSON.stringify({ error: { message: 'nonce too high: address 0x3a65, expected 41501, got 41521' } }))
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.nonceConsumed).toBe(false); expect(r.error).toMatch(/nonce too high/) }
  })
  it('a 200 whose body is not JSON stays ambiguous, because the server did answer', () => {
    const r = classifySend(200, 'garbage')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.nonceConsumed).toBe(true)
  })
})

describe('NonceManager.rejected: a proven-wrong counter repairs itself in flight', () => {
  it('"nonce too high" forces a resync to the chain even with sends in flight', async () => {
    let chain = 100
    const n = new NonceManager(async () => chain)
    await n.init()
    // twenty sends "consumed" by transport errors: the counter walks ahead of the chain
    for (let i = 0; i < 20; i++) { n.reserve(); n.settle() }
    expect(n.peek()).toBe(120)
    // a phantom buy is still in flight, so resyncIfIdle would refuse
    const inflight = n.reserve()
    expect(n.idle).toBe(false)
    expect(await n.resyncIfIdle()).toBe(false)
    expect(n.peek()).toBe(121)
    // then the chain says so explicitly
    n.rejected(inflight, 'nonce too high: address 0x3a65, expected 100, got 120')
    await new Promise((r) => setTimeout(r, 0))   // forceResync is fire-and-forget
    expect(n.peek()).toBe(100)
    expect(n.idle).toBe(true)
  })
  it('any other rejection is a plain release and does NOT touch the chain', async () => {
    let reads = 0
    const n = new NonceManager(async () => { reads++; return 7 })
    await n.init()
    const nonce = n.reserve()
    expect(n.rejected(nonce, 'insufficient funds for gas')).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(n.peek()).toBe(7)
    expect(reads).toBe(1)   // init only
  })
  it('forceResync is idempotent under concurrent calls', async () => {
    let reads = 0
    const n = new NonceManager(async () => { reads++; await new Promise((r) => setTimeout(r, 5)); return 42 })
    await n.init()
    n.reserve(); n.reserve()
    await Promise.all([n.forceResync(), n.forceResync(), n.forceResync()])
    expect(n.peek()).toBe(42)
    expect(n.idle).toBe(true)
    expect(reads).toBe(2)   // init + one shared resync
  })
})

describe('2026-09-06 review: the two ways a bad send could have cost a position', () => {
  it('a failing chain read during the forced resync is swallowed, never an unhandled rejection', async () => {
    // the 09-05 runaway happened under a 429 storm, which is exactly when the resync's
    // getTransactionCount would throw; vitest fails the run on an unhandled rejection
    const n = new NonceManager(async () => { throw new Error('http 429') })
    expect(() => n.rejected(7, 'nonce too high')).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(n.resyncs1h()).toBe(1) // it was attempted, and the dashboard can see that
  })

  it('sendUncertain: transport failures and "nonce too low" keep the position; clean rejections do not', async () => {
    const { sendUncertain } = await import('../src/tx/sender.js')
    const fail = (error: string, nonceConsumed: boolean) => ({ ok: false as const, error, ms: 1, via: 'seq', nonceConsumed })
    expect(sendUncertain(fail('transport: fetch failed', true))).toBe(true)
    expect(sendUncertain(fail('nonce too low', true))).toBe(true)
    expect(sendUncertain(fail('Nonce too low: next nonce 41803', true))).toBe(true)
    expect(sendUncertain(fail('unparseable 200: <html>', true))).toBe(true) // the server answered, we could not read it
    expect(sendUncertain(fail('nonce too high', false))).toBe(false)
    expect(sendUncertain(fail('insufficient funds', false))).toBe(false)
    expect(sendUncertain({ ok: true, hash: '0x1', ms: 1, via: 'seq' })).toBe(false)
  })
})
