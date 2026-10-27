/**
 * The driver, with a fake world.
 *
 * WHAT THESE PIN. Mode is enforced in exactly one place; every effect is recorded before it
 * is answered; and folding is serialised, so two events can never interleave mutations of
 * the same state.
 *
 * The whole point of injecting the world is that none of this needs a socket, a signer, a
 * chain or a clock. If a test here needed one, the split between driver and core would have
 * leaked.
 */
import { describe, expect, it } from 'vitest'
import { LiveDriver, type ReadOutcome, type World } from '../drivers/live.js'
import { emptyState } from '../core/state.js'
import type { BookSpec, FrozenConfig, Switches } from '../core/config.js'

const CFG: FrozenConfig = {
  specVersion: 1,
  books: [{
    id: 'main', minCreatorTaxBps: 0, maxCreatorTaxBps: 0, minExemptions: 3, templateLossBlockMs: 3_600_000,
  sizeWei: '5000000000000000', maxDrawdownWei: '15000000000000000',
  entry: { entryDelayMs: 2_000, entryFallbackLateMs: 600, maxEntryPriceMultiple: 4.5, buySlippageBps: 5_000 },
  exit: { maxHoldMs: 45_000, hardStopMultiple: 0.5, deadCoinAfterMs: 20_000, deadCoinBelowMultiple: 1.03, graduationExitAt: 0.12, maxSellAttempts: 20, exitRetryDelayMs: 300, sellFinalMinQuoteOutWei: '1' },
  takeProfit: { otherwise: 1.75, adaptiveWindow: 20, adaptiveBars: [1.25, 1.75] },
  guard: { window: 20, recoveryWindow: 8, openAt: 1, shutAt: -1, settleMs: 52_000, freshMs: 10_800_000, pnlBar: 1.75, maxReadingAgeMs: 10_800_000 },
  } as BookSpec],
  risk: { maxConcurrent: 14, maxTradeSizeWei: '20000000000000000', bankrollWei: '80000000000000000', drawdownStakes: 3, maxWalletDrawdownWei: '15000000000000000', brokenWindow: 20, brokenFactor: 0.78, brokenGapPp: 15, maxLogsStalenessMs: 3000, maxOverlayAgeMs: 1500 },
  clock: { periodMs: 250 },
}
const SW: Switches = { sizeWei: 5_000_000_000_000_000n, mode: 'live', at: 0, by: 'test' }

function world(over: Partial<World> = {}) {
  const recorded: Array<{ kind: string; body: Record<string, unknown> }> = []
  const sent: string[] = []
  const signedOrder: string[] = []
  let t = 1_000_000
  const w: World = {
    now: () => t++,
    record: (e) => { recorded.push({ kind: e.kind, body: e as unknown as Record<string, unknown> }) },
    sign: async (i) => { signedOrder.push(i.kind); return { hash: `0xh${signedOrder.length}`, raw: '0xraw' } },
    send: async (i) => { sent.push(i.kind); return { ok: true, hash: '0xmined', nonceConsumed: true, uncertain: false, error: null } },
    broadcast: async () => ({ ok: true, hash: '0xmined', nonceConsumed: true, uncertain: false, error: null }),
    reserveNonce: () => 7,
    releaseNonce: () => {},
    settleNonce: () => {},
    read: async () => ({ result: null, tries: 1, latencyMs: 0, viaKey: true, error: null }),
    later: (_ms, fn) => { void fn },   // never fires unless a test drives it
    log: () => {},
    ...over,
  }
  return { w, recorded, sent, signedOrder }
}

const driver = (mode: 'shadow' | 'live', over: Partial<World> = {}) => {
  const h = world(over)
  return { ...h, d: new LiveDriver({ world: h.w, initial: emptyState(CFG, SW), mode }) }
}

describe('the driver records everything it ingests', () => {
  it('reports idle only after queued work and resulting reads finish', async () => {
    let release = (): void => {}
    const h = driver('live', {
      read: async () => {
        await new Promise<void>((resolve) => { release = resolve })
        return { result: null, tries: 1, latencyMs: 0, viaKey: true, error: null }
      },
    })
    h.d.current().inflight.set('buy-1', {
      kind: 'buy', intentId: 'buy-1', token: '0xt', curve: '0xc', book: 'main',
      bookDigest: 'd', templateKey: 't', sizeWei: 1n, rules: {} as never,
      hash: '0xhash', nonce: 1, signedAt: 1, walletReadAt: 0, walletReads: 0,
    })
    h.d.ingest('recovery-start', { reason: 'test' })
    expect(h.d.idle()).toBe(false)
    release()
    await h.d.whenIdle()
    expect(h.d.idle()).toBe(true)
  })

  it('records an event before folding it, so the tape leads the state', async () => {
    const { d, recorded } = driver('live')
    d.ingest('logs-status', { healthy: true, mode: 'poll', reason: 'up' })
    await new Promise((r) => setImmediate(r))
    expect(recorded[0]!.kind).toBe('logs-status')
    expect(d.current().sensors.logsHealthy?.value).toBe(true)
  })

  it('stamps every event from the one clock', async () => {
    const { d } = driver('live')
    d.ingest('logs-status', { healthy: true, mode: 'poll', reason: 'a' })
    await new Promise((r) => setImmediate(r))
    const first = d.current().at
    d.ingest('logs-status', { healthy: false, mode: 'poll', reason: 'b' })
    await new Promise((r) => setImmediate(r))
    expect(d.current().at).toBeGreaterThan(first)
  })

  it('gives every event a gapless seq, so the fold has a total order', async () => {
    const { d } = driver('live')
    d.ingest('logs-status', { healthy: true, mode: 'poll', reason: 'a' })
    d.ingest('logs-status', { healthy: true, mode: 'poll', reason: 'b' })
    d.ingest('logs-status', { healthy: true, mode: 'poll', reason: 'c' })
    await new Promise((r) => setImmediate(r))
    expect(d.current().seq).toBe(3)
  })
})

describe('mode is enforced in exactly one place', () => {
  const buyIntent = async (mode: 'shadow' | 'live') => {
    const h = driver(mode)
    // drive the driver's own submit path through a synthetic intent, the way the fold would
    await (h.d as unknown as { submit: (i: unknown) => Promise<void> }).submit({ kind: 'buy', intentId: 'buy-1', token: '0xt', curve: '0xc', book: 'main', sizeWei: 1n, minTokensOut: 1n, decidedAt: 0 })
    return h
  }

  it('shadow signs and never sends', async () => {
    // Shadow is the mode that strands tokens if it is entered with positions open: it signs
    // the sell and never broadcasts it.
    const h = await buyIntent('shadow')
    expect(h.signedOrder).toEqual(['buy'])
    expect(h.sent).toEqual([])
    expect(h.recorded.some((r) => r.kind === 'tx-signed')).toBe(true)
  })

  it('live signs and sends', async () => {
    const h = await buyIntent('live')
    expect(h.signedOrder).toEqual(['buy'])
    expect(h.sent).toEqual(['buy'])
  })

  it('records tx-signed BEFORE the send in every mode that signs', async () => {
    // A send that times out must leave evidence of what was signed, or a signed transaction
    // can be sequenced with nobody aware it exists.
    const order: string[] = []
    const h = driver('live', {
      send: async () => { order.push('send'); return { ok: true, hash: '0xm', nonceConsumed: true, uncertain: false, error: null } },
      record: (e) => { if (e.kind === 'tx-signed') order.push('recorded-signed') },
    })
    await (h.d as unknown as { submit: (i: unknown) => Promise<void> }).submit({ kind: 'buy', intentId: 'buy-1', token: '0xt', curve: '0xc', book: 'main', sizeWei: 1n, minTokensOut: 1n, decidedAt: 0 })
    expect(order).toEqual(['recorded-signed', 'send'])
  })

  it('returns the nonce when signing fails, so a failure cannot burn a slot in the ladder', async () => {
    let released: number | null = null
    const h = driver('live', {
      sign: async () => { throw new Error('signer unavailable') },
      releaseNonce: (n) => { released = n },
    })
    await (h.d as unknown as { submit: (i: unknown) => Promise<void> }).submit({ kind: 'buy', intentId: 'buy-1', token: '0xt', curve: '0xc', book: 'main', sizeWei: 1n, minTokensOut: 1n, decidedAt: 0 })
    expect(released).toBe(7)
  })

  const submitBuy = (h: { d: unknown }) =>
    (h.d as unknown as { submit: (i: unknown) => Promise<void> }).submit({ kind: 'buy', intentId: 'buy-1', token: '0xt', curve: '0xc', book: 'main', sizeWei: 1n, minTokensOut: 1n, decidedAt: 0 })

  /**
   * THE SEQUENCER'S REASON MUST REACH THE LADDER, and for a while it did not.
   *
   * `io/world.ts` routes a release WITH a reason to `NonceManager.rejected`, which force-resyncs
   * on "nonce too high" — the chain telling us our counter has walked ahead of it, and the only
   * repair for that state. Dropping the reason here makes that repair unreachable, which is how
   * v1 spent 37 minutes on 2026-09-05 rejecting every transaction it signed.
   */
  it('passes the sequencer`s reason with the nonce it is giving back', async () => {
    const seen: Array<{ n: number; error?: string }> = []
    const h = driver('live', {
      send: async () => ({ ok: false, hash: '', nonceConsumed: false, uncertain: false, error: 'nonce too high' }),
      releaseNonce: (n, error) => { seen.push({ n, ...(error === undefined ? {} : { error }) }) },
    })
    await submitBuy(h)
    expect(seen).toEqual([{ n: 7, error: 'nonce too high' }])
  })

  it('gives the nonce back with NO reason when nobody refused it', async () => {
    // Shadow signs and deliberately does not send, so the chain has said nothing about the
    // count. A reason here would be this process inventing a verdict on its own behalf.
    const seen: Array<string | undefined> = []
    const h = driver('shadow', { releaseNonce: (_n, error) => { seen.push(error) } })
    await submitBuy(h)
    expect(seen).toEqual([undefined])
  })
})

describe('a failed read is reported, never swallowed', () => {
  const failed = (error: string, over: Partial<ReadOutcome> = {}): ReadOutcome =>
    ({ result: null, tries: 1, latencyMs: 0, viaKey: true, error, ...over })

  it('feeds back a chain-read with no result so the fold can drop the launch', async () => {
    // Left pending forever is how the old bot leaked entries into caches nobody swept.
    const h = driver('live', { read: async () => failed('rpc down') })
    await (h.d as unknown as { act: (i: unknown) => Promise<void> }).act({ kind: 'read', what: 'meta', args: ['0xc', '0xt'] })
    const rec = h.recorded.find((r) => r.kind === 'chain-read')
    expect(rec).toBeDefined()
    expect(rec!.body.result).toBe(null)
  })

  /**
   * A world that THROWS must not escape `act`. Everything queued behind this event in `drain()`
   * would go unfolded, which on a live box is fills and exits for positions already open.
   */
  it('treats a throwing world as a failed read rather than letting it escape the queue', async () => {
    const h = driver('live', { read: async () => { throw new Error('rpc down') } })
    await expect((h.d as unknown as { act: (i: unknown) => Promise<void> })
      .act({ kind: 'read', what: 'meta', args: ['0xc', '0xt'] })).resolves.toBeUndefined()
    const rec = h.recorded.find((r) => r.kind === 'chain-read')
    expect(rec!.body.result).toBe(null)
  })

  /**
   * THE COST OF A FAILED READ IS RECORDED, and it used to be stamped `tries: 1, latencyMs: 0`
   * whatever actually happened, so the read worth measuring was the one the tape called free.
   */
  it('records the tries and the milliseconds the read really spent', async () => {
    const h = driver('live', { read: async () => failed('429 too many requests', { tries: 3, latencyMs: 812, viaKey: false }) })
    await (h.d as unknown as { act: (i: unknown) => Promise<void> }).act({ kind: 'read', what: 'meta', args: ['0xc', '0xt'] })
    const rec = h.recorded.find((r) => r.kind === 'chain-read')!
    expect(rec.body.tries).toBe(3)
    expect(rec.body.latencyMs).toBe(812)
    expect(rec.body.viaKey, 'a read that fell through to the spare did not go via the key').toBe(false)
  })

  it('records them for a read that SUCCEEDED too, so latency has a baseline', async () => {
    const h = driver('live', { read: async () => ({ result: { params: {} }, tries: 2, latencyMs: 301, viaKey: true, error: null }) })
    await (h.d as unknown as { act: (i: unknown) => Promise<void> }).act({ kind: 'read', what: 'meta', args: ['0xc', '0xt'] })
    const rec = h.recorded.find((r) => r.kind === 'chain-read')!
    expect(rec.body.tries).toBe(2)
    expect(rec.body.latencyMs).toBe(301)
    expect(rec.body.viaKey).toBe(true)
  })

  it('feeds a receipt read back as a receipt, not a chain-read', async () => {
    const verdict = { ok: true, gasWei: '1', proceedsWei: null, remainingWei: '0', error: null }
    const h = driver('live', { read: async () => ({ result: verdict, tries: 1, latencyMs: 5, viaKey: true, error: null }) })
    await (h.d as unknown as { act: (i: unknown) => Promise<void> }).act({ kind: 'read', what: 'receipt', args: ['0xh', '0xt'] })
    expect(h.recorded.some((r) => r.kind === 'receipt')).toBe(true)
    expect(h.recorded.some((r) => r.kind === 'chain-read')).toBe(false)
    expect(h.recorded.find((r) => r.kind === 'receipt')!.body.result).toEqual(verdict)
  })
})

describe('a graduated send is a first-class transaction', () => {
  it('records it as txKind graduate and still sends the bytes', async () => {
    const h = driver('live')
    await (h.d as unknown as { submit: (i: unknown) => Promise<void> }).submit({
      kind: 'grad', intentId: 'g-1', token: '0xt', curve: '0xc',
      step: 'prepare-graduate', pool: null, amountWei: 0n, deadline: 1,
    })
    const signed = h.recorded.find((r) => r.kind === 'tx-signed')
    expect(signed?.body.txKind).toBe('graduate')
    expect(h.sent).toEqual(['grad'])
  })
})

describe('a resend does not take a new nonce', () => {
  it('broadcasts the same bytes in live and records nothing as signed', async () => {
    let reserved = 0
    let broadcasted = ''
    const h = driver('live', {
      reserveNonce: () => { reserved++; return 7 },
      broadcast: async (raw) => { broadcasted = raw; return { ok: true, hash: '0xmined', nonceConsumed: true, uncertain: false, error: null } },
    })
    await (h.d as unknown as { act: (i: unknown) => Promise<void> }).act({ kind: 'broadcast', hash: '0xh', raw: '0xsame' })
    expect(reserved).toBe(0)
    expect(broadcasted).toBe('0xsame')
    expect(h.signedOrder).toEqual([])
    expect(h.recorded.some((r) => r.kind === 'tx-signed')).toBe(false)
  })

  it('does not broadcast in shadow', async () => {
    let called = false
    const h = driver('shadow', {
      broadcast: async () => { called = true; return { ok: true, hash: '0xh', nonceConsumed: true, uncertain: false, error: null } },
    })
    await (h.d as unknown as { act: (i: unknown) => Promise<void> }).act({ kind: 'broadcast', hash: '0xh', raw: '0xsame' })
    expect(called).toBe(false)
  })
})
