/**
 * The curve read's retry, which v2 did not have and v1 paid 962 launches to learn it needed.
 *
 * On 2026-09-05..06 the public RPC answered its rate limit as a JSON-RPC error inside an HTTP 200.
 * viem surfaces that as "An unknown RPC error occurred" and does not retry it, and a fallback list
 * moves past it just as fast, so having a second endpoint is no defence against it at all. 962
 * launches were refused `param read failed` in 24 hours, 469 of them inside the entry window,
 * while the log stream kept flowing the whole time. v1's answer was `readCurveRetry`: three tries
 * 250ms apart. v2 dropped the launch into `screen-meta` on the first failure.
 *
 * What is pinned here is the RULE, not the plumbing: which failures earn another attempt, which do
 * not, and that the cost of every read reaches the tape whether it worked or not. `readWithStats`
 * takes its clock and its sleep as arguments so none of this needs a chain or real time.
 */
import { describe, expect, it } from 'vitest'
import { readWithStats } from '../io/world.js'

/** A clock that only moves when a read or a sleep says it did, so latency is exact. */
function harness(opts: { keyed?: boolean; spare?: () => number } = {}) {
  let clock = 0
  const slept: number[] = []
  return {
    env: {
      spareServed: opts.spare ?? (() => 0),
      keyed: opts.keyed ?? true,
      now: () => clock,
      sleep: async (ms: number) => { slept.push(ms); clock += ms },
    },
    slept,
    tick: (ms: number) => { clock += ms },
    get clock() { return clock },
  }
}

/** A read that fails `failures` times with `error`, then answers. Counts its own attempts. */
function flaky(failures: number, error: string, cost = 0, h?: { tick: (ms: number) => void }) {
  const calls: string[] = []
  return {
    calls,
    read: async (what: string) => {
      calls.push(what)
      h?.tick(cost)
      if (calls.length <= failures) throw new Error(error)
      return { params: { launchedAt: '1' } }
    },
  }
}

describe('a rate-limited curve read is asked again, not thrown away', () => {
  it('retries a 429 and returns the answer the second attempt got', async () => {
    const h = harness()
    const f = flaky(1, 'HTTP request failed: 429 Too Many Requests', 0, h)
    const out = await readWithStats(f.read, 'meta', ['0xc'], h.env)
    expect(out.error, 'the read succeeded, so nothing failed').toBe(null)
    expect(out.result).toEqual({ params: { launchedAt: '1' } })
    expect(out.tries, 'and the tape says it took two attempts').toBe(2)
    expect(h.slept, 'v1 waits 250ms between them').toEqual([250])
  })

  it('retries the error viem gives a JSON-RPC 429 hidden inside an HTTP 200', async () => {
    // The exact wording that cost v1 962 launches, and the reason a fallback list is no defence:
    // both endpoints answer it the same way, immediately.
    const h = harness()
    const f = flaky(2, 'An unknown RPC error occurred', 0, h)
    const out = await readWithStats(f.read, 'meta', ['0xc'], h.env)
    expect(out.error).toBe(null)
    expect(out.tries).toBe(3)
  })

  it('gives up after three attempts rather than spending the whole entry window', async () => {
    const h = harness()
    const f = flaky(99, 'timed out', 0, h)
    const out = await readWithStats(f.read, 'meta', ['0xc'], h.env)
    expect(f.calls.length, 'v1 tries three times, and so does this').toBe(3)
    expect(out.tries).toBe(3)
    expect(out.error).toMatch(/timed out/)
    expect(out.result, 'a read that never answered has no result to report').toBe(null)
  })

  it('never waits longer than the fold gives a launch whose params never came', async () => {
    // Three 750ms timeouts plus two 250ms waits. The ceiling has to stay under the fold's own
    // give-up or a retry outlives the launch it is for.
    const h = harness()
    const f = flaky(99, 'timed out', 750, h)
    await readWithStats(f.read, 'meta', ['0xc'], h.env)
    expect(h.clock).toBe(3 * 750 + 2 * 250)
    expect(h.clock).toBeLessThan(52_000)
  })
})

describe('what does NOT earn a second attempt', () => {
  it('a deterministic failure is refused at once, because three tries would fail the same way', async () => {
    const h = harness()
    const f = flaky(99, 'invalid address', 0, h)
    const out = await readWithStats(f.read, 'meta', ['0xc'], h.env)
    expect(f.calls.length, 'spending the entry window proving this is worse than refusing now').toBe(1)
    expect(out.tries).toBe(1)
    expect(h.slept).toEqual([])
  })

  /**
   * EVERY OTHER READ ALREADY HAS A CALLER THAT ASKS AGAIN. `reclaimOrphanBuys` re-reads a buy's
   * wallet on its own schedule and the grad step machine re-asks for a receipt; a retry
   * underneath either is two backoffs stacked with neither aware of the other.
   */
  it('a receipt read does not retry, because the fold asks again on its own schedule', async () => {
    const h = harness()
    const f = flaky(99, '429 too many requests', 0, h)
    const out = await readWithStats(f.read, 'receipt', ['0xh'], h.env)
    expect(f.calls.length).toBe(1)
    expect(out.tries).toBe(1)
  })

  it('nor does a wallet read', async () => {
    const h = harness()
    const f = flaky(99, '429 too many requests', 0, h)
    await readWithStats(f.read, 'position-wallet', ['0xt', 'buy-1'], h.env)
    expect(f.calls.length).toBe(1)
  })
})

describe('the cost of a read reaches the tape either way', () => {
  it('reports the milliseconds a successful read spent', async () => {
    const h = harness()
    const f = flaky(0, '', 120, h)
    const out = await readWithStats(f.read, 'meta', ['0xc'], h.env)
    expect(out.latencyMs).toBe(120)
    expect(out.tries).toBe(1)
  })

  it('reports them for a failed read too, which is the one worth measuring', async () => {
    const h = harness()
    const f = flaky(99, 'timed out', 750, h)
    const out = await readWithStats(f.read, 'meta', ['0xc'], h.env)
    expect(out.latencyMs, 'stamping 0 here made the slowest read look free').toBe(3 * 750 + 2 * 250)
    expect(out.error).toMatch(/timed out/)
  })
})

describe('viaKey says whether the keyed endpoint actually served the read', () => {
  it('is true when the spare served nothing while the read ran', async () => {
    const h = harness({ keyed: true, spare: () => 4 })   // steady: no new spare request
    const f = flaky(0, '', 0, h)
    const out = await readWithStats(f.read, 'meta', ['0xc'], h.env)
    expect(out.viaKey).toBe(true)
  })

  it('is false when the read fell through to the spare', async () => {
    let served = 4
    const h = harness({ keyed: true, spare: () => served })
    const out = await readWithStats(async () => { served++; return {} }, 'meta', ['0xc'], h.env)
    expect(out.viaKey, 'a read the spare answered did not go via the key').toBe(false)
  })

  it('is false with no key configured, rather than true by default', async () => {
    const h = harness({ keyed: false })
    const f = flaky(0, '', 0, h)
    const out = await readWithStats(f.read, 'meta', ['0xc'], h.env)
    expect(out.viaKey).toBe(false)
  })

  it('is reported on a failed read as well', async () => {
    const h = harness({ keyed: true })
    const f = flaky(99, 'invalid address', 0, h)
    const out = await readWithStats(f.read, 'meta', ['0xc'], h.env)
    expect(out.error).not.toBe(null)
    expect(out.viaKey).toBe(true)
  })
})
