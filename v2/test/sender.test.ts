/**
 * The two pure functions that decide whether a nonce was spent and whether a bag might exist.
 *
 * `io/sender.ts` is ported from v1 verbatim and no defect has ever been found in it. These tests
 * are not an accusation; they exist because v2 had NONE, and the code they guard is where v1's two
 * worst days came from. A verbatim port is proven only until somebody edits it, and the whole point
 * of `classifySend` is that its answer is not obvious: the same HTTP response can mean "the nonce
 * is still ours" or "the nonce is gone" depending on the status code, and getting that backwards is
 * how twenty sends in thirty seconds walked the counter twenty ahead of the chain.
 *
 * TWO INCIDENTS, ONE FUNCTION EACH.
 *
 * 2026-09-05 21:05 — the public RPC was rate limiting. Each 429 fell through to JSON.parse on an
 * HTML body, threw, was classified "transport" and therefore consumed, and the counter advanced
 * with nothing sequenced. Every send for the next 37 minutes came back "nonce too high", thirteen
 * buys sat open as phantoms, and two real bags could not sell. That is `classifySend`.
 *
 * 2026-09-06 — a "nonce too low" was read as a clean rejection, so the row was closed as
 * never-mined and the curve released. But it can be OUR OWN transaction: the primary client times
 * out after the sequencer accepted it, the spare re-sends the identical bytes, and the sequencer
 * says the nonce is used. Closing that row leaves real tokens with nobody managing them. Found in
 * review before it cost anything. That is `sendUncertain`.
 *
 * `v2/test/nonce.test.ts` covers the `NonceManager` half, so nothing here repeats it.
 */
import { describe, expect, it, vi } from 'vitest'
import { Sender, classifySend, sendUncertain, type SendResult } from '../io/sender.js'

/** The JSON-RPC envelope the sequencer answers in. */
const rpc = (body: Record<string, unknown>): string => JSON.stringify({ jsonrpc: '2.0', id: 1, ...body })

describe('classifySend reads the status code before it reads the body', () => {
  /**
   * THE ORDER IS THE WHOLE FIX. A non-200 means the HTTP layer refused the request, so the
   * JSON-RPC method never ran and the sequencer never saw the bytes. Parsing first sends an HTML
   * error page into JSON.parse, and the throw was classified as a transport failure, which the
   * caller treats as consumed.
   */
  it('a 429 is the HTTP layer refusing, so the nonce is still ours', () => {
    const r = classifySend(429, '<html><body>Too Many Requests</body></html>')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.nonceConsumed, 'this single boolean is the 37-minute outage').toBe(false)
      expect(r.error).toContain('http 429')
    }
  })

  it('keeps a 502 or 503 ambiguous because a proxy may fail after forwarding the transaction', () => {
    for (const code of [502, 503]) {
      const r = classifySend(code, 'Bad Gateway')
      expect(r.ok, `${code} is not a sequencing`).toBe(false)
      if (!r.ok) expect(r.nonceConsumed).toBe(true)
    }
  })

  it('a 200 carrying a result is sequenced, and the hash is the answer', () => {
    expect(classifySend(200, rpc({ result: '0xabc' }))).toEqual({ ok: true, hash: '0xabc' })
  })

  it('a 200 saying "nonce too low" means someone already used it: consumed', () => {
    const r = classifySend(200, rpc({ error: { message: 'nonce too low: expected 5, got 4' } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.nonceConsumed).toBe(true)
  })

  /**
   * NOT CONSUMED, and the error text has to survive: `NonceManager.rejected` matches on it to
   * force a resync, and that is the only repair for a counter that has walked ahead of the chain.
   */
  it('a 200 saying "nonce too high" is a rejection that must reach the resync', () => {
    const r = classifySend(200, rpc({ error: { message: 'nonce too high: address 0x3a65, expected 41501, got 41521' } }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.nonceConsumed).toBe(false)
      expect(r.error, '`rejected` tests this string to decide whether to re-read the chain').toMatch(/nonce too high/)
    }
  })

  it('a 200 whose body is not JSON stays ambiguous, because the server did answer', () => {
    const r = classifySend(200, 'garbage')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.nonceConsumed, 'the safe direction: assume it landed').toBe(true)
  })

  it('a 200 with neither a result nor a readable error is still a refusal, not a send', () => {
    const r = classifySend(200, rpc({}))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('unknown rpc error')
  })
})

describe('uncertainty survives failover', () => {
  it('retains an earlier uncertain send when the spare rejects the same bytes', async () => {
    const sender=new Sender()
    const post=vi.spyOn(sender as any,'post')
      .mockResolvedValueOnce({ok:false,error:'transport: timeout',nonceConsumed:true,ms:2000,via:'primary'})
      .mockResolvedValueOnce({ok:false,error:'http 429: rate limited',nonceConsumed:false,ms:1,via:'spare'})
    try {
      const result=await sender.send('0x00')
      expect(sendUncertain(result)).toBe(true)
      expect(post).toHaveBeenCalledTimes(2)
    } finally {post.mockRestore();await sender.stop()}
  })

  it('bounds the public fallback and preserves uncertainty if it times out', async () => {
    const sender=new Sender()
    const post=vi.spyOn(sender as any,'post').mockResolvedValue({ok:false,error:'transport: timeout',nonceConsumed:true,ms:2000,via:'sequencer'})
    const controller=new AbortController()
    const timeout=vi.spyOn(AbortSignal,'timeout').mockReturnValue(controller.signal)
    let started!:()=>void
    const called=new Promise<void>(resolve=>{started=resolve})
    const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async (_url,options)=>{
      expect(options?.signal).toBe(controller.signal)
      started()
      return await new Promise<Response>((_resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('timeout')),{once:true}))
    })
    try {
      const pending=sender.send('0x00')
      await called
      expect(timeout).toHaveBeenCalledWith(2000)
      controller.abort()
      expect(sendUncertain(await pending)).toBe(true)
    } finally {post.mockRestore();fetch.mockRestore();timeout.mockRestore();await sender.stop()}
  })
})

describe('sendUncertain decides whether a failed send may still have landed', () => {
  const fail = (error: string, nonceConsumed: boolean): SendResult =>
    ({ ok: false, error, ms: 1, via: 'seq-primary', nonceConsumed })

  it('a transport failure may have landed: it says nothing either way', () => {
    expect(sendUncertain(fail('transport: fetch failed', true))).toBe(true)
  })

  it('"nonce too low" may be our own transaction, re-sent by the spare after a timeout', () => {
    expect(sendUncertain(fail('nonce too low', true))).toBe(true)
    expect(sendUncertain(fail('Nonce too low: next nonce 41803', true)), 'capitalised, as the sequencer sends it').toBe(true)
  })

  it('a 200 we could not read may have landed, because the server answered', () => {
    expect(sendUncertain(fail('unparseable 200: <html>', true))).toBe(true)
  })

  /**
   * A rejection that left the nonce with us is CERTAIN, and that matters as much as the other
   * direction: treating it as uncertain keeps a position that does not exist, holds its slot and
   * its capital, and blocks the token from ever being bought again.
   */
  it('a rejection that kept the nonce is certain: there is no position to keep', () => {
    expect(sendUncertain(fail('nonce too high', false))).toBe(false)
    expect(sendUncertain(fail('insufficient funds', false))).toBe(false)
    expect(sendUncertain(fail('http 429: Too Many Requests', false))).toBe(false)
  })

  it('a send that worked is not uncertain about anything', () => {
    expect(sendUncertain({ ok: true, hash: '0x1', ms: 1, via: 'seq-primary' })).toBe(false)
  })
})

describe('the two agree on every answer the sequencer can give', () => {
  /**
   * The end-to-end rule, stated once: an HTTP refusal must never cost a nonce AND must never
   * leave a phantom position behind. Both halves failed together on 09-05, because the same
   * misclassification feeds both functions.
   */
  it('an HTTP refusal costs neither a nonce nor a phantom position', () => {
    const c = classifySend(429, 'Too Many Requests')
    expect(c.ok).toBe(false)
    if (c.ok) return
    expect(c.nonceConsumed).toBe(false)
    expect(sendUncertain({ ok: false, error: c.error, ms: 1, via: 'seq-primary', nonceConsumed: c.nonceConsumed })).toBe(false)
  })

  it('an accepted "nonce too low" costs the nonce and keeps the position', () => {
    const c = classifySend(200, rpc({ error: { message: 'nonce too low' } }))
    expect(c.ok).toBe(false)
    if (c.ok) return
    expect(c.nonceConsumed).toBe(true)
    expect(sendUncertain({ ok: false, error: c.error, ms: 1, via: 'seq-primary', nonceConsumed: c.nonceConsumed })).toBe(true)
  })
})
