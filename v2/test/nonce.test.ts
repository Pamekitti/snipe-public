/**
 * The nonce ladder's two repairs, which v2 carried as dead code until 2026-09-17.
 *
 * `io/nonce.ts` is ported verbatim from v1 and has never had a defect found in it. These tests
 * are not about the class being wrong. They exist because NOTHING IN V2 CALLED EITHER REPAIR:
 * `drivers/live.ts` released every rejected nonce through the plain `release`, and no timer ever
 * ran `resyncIfIdle`. Both were reachable and neither was reached, which is the worst shape a
 * safety mechanism can be in, because every reader assumes it is on.
 *
 * So what is pinned here is the BEHAVIOUR each repair exists for. Between these and the
 * driver's "passes the sequencer's reason with the nonce it is giving back", deleting either
 * caller fails a test instead of quietly restoring the 2026-09-05 outage.
 */
import { describe, expect, it } from 'vitest'
import { NonceManager } from '../io/nonce.js'

/** A chain whose count is whatever the test says it is, and that counts how often it was asked. */
function chain(count: number) {
  const state = { count, reads: 0, fail: false }
  const m = new NonceManager(async () => {
    state.reads++
    if (state.fail) throw new Error('rpc down')
    return state.count
  })
  return { m, state }
}

describe('a counter that has walked ahead of the chain repairs itself', () => {
  it('re-reads the chain on "nonce too high", even with sends in flight', async () => {
    const { m } = chain(100)
    await m.init()

    // Four reserved and none settled: the ladder is at 104 and believes four are in flight.
    for (let i = 0; i < 4; i++) m.reserve()
    expect(m.peek()).toBe(104)
    expect(m.idle).toBe(false)

    // The chain never moved. It is still at 100, and it says so.
    m.rejected(103, 'nonce too high')
    await new Promise((r) => setImmediate(r))

    expect(m.peek(), 'the chain`s answer wins; anything else keeps rejecting every send').toBe(100)
    expect(m.idle, 'a forced resync clears the phantom in-flight count that blocked the idle repair').toBe(true)
  })

  it('does not re-read on an ordinary rejection, because the counter is not in question', async () => {
    const { m, state } = chain(100)
    await m.init()
    const before = state.reads
    m.reserve()
    m.rejected(100, 'execution reverted: insufficient funds')
    await new Promise((r) => setImmediate(r))
    expect(state.reads).toBe(before)
    expect(m.peek(), 'the top of the ladder came back the ordinary way').toBe(100)
  })

  it('survives a chain read that fails, because the storm is when this fires', async () => {
    // v1's note: the 09-05 runaway happened UNDER a 429 storm, and an unhandled rejection here
    // would take the process down with every exit manager in it.
    const { m, state } = chain(100)
    await m.init()
    state.fail = true
    m.reserve()
    expect(() => m.rejected(100, 'nonce too high')).not.toThrow()
    await new Promise((r) => setImmediate(r))
  })

  it('counts forced resyncs, so a repair that worked is still visible', async () => {
    const { m } = chain(100)
    await m.init()
    expect(m.resyncs1h()).toBe(0)
    await m.forceResync()
    expect(m.resyncs1h()).toBe(1)
  })
})

describe('a hole in the ladder is closed when the book is flat', () => {
  it('cannot roll back a nonce another send has claimed above it, and leaves a gap', async () => {
    const { m } = chain(100)
    await m.init()
    const first = m.reserve()   // 100
    m.reserve()                 // 101
    expect(m.release(first), 'rolling back under a live claim would double-spend 101').toBe(false)
    expect(m.peek()).toBe(102)
  })

  it('takes the chain`s count once nothing is in flight', async () => {
    const { m, state } = chain(100)
    await m.init()
    const first = m.reserve()
    const second = m.reserve()
    m.release(first)            // refused, leaves the gap
    m.release(second)           // top of the ladder, comes back
    expect(m.peek()).toBe(101)
    expect(m.idle).toBe(true)

    expect(await m.resyncIfIdle(), 'with no resync the ladder stays one ahead of the chain forever').toBe(true)
    expect(m.peek()).toBe(state.count)
  })

  it('refuses to resync with anything in flight, because the chain`s count would be a lie', async () => {
    const { m } = chain(100)
    await m.init()
    m.reserve()
    expect(await m.resyncIfIdle()).toBe(false)
    expect(m.peek()).toBe(101)
  })
})
