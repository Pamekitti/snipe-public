import { describe, expect, it, vi } from 'vitest'
import { Bot } from '../src/bot.js'
import { PriceFeed } from '../src/telemetry/price.js'
import { deferred } from './helpers/deferred.js'

function maintenance(refreshPrice: () => Promise<unknown>) {
  return {
    risk: { rollDay: vi.fn(() => false) },
    checkRegimeGate: vi.fn(), checkBroken: vi.fn(), refreshRecoveryReading: vi.fn(),
    checkDrawdownResume: vi.fn(), refreshTemplateBlocklist: vi.fn(), recordHaltState: vi.fn(),
    checkPaperCollection: vi.fn(),
    sampleResources: vi.fn(),
    refreshPrice, client: { getGasPrice: vi.fn(async () => 20_000_000n) },
    nonce: { resyncIfIdle: vi.fn(async () => true) }, positions: new Map(),
    truth: { tick: vi.fn(async () => {}) },
  }
}

const tick = (subject: ReturnType<typeof maintenance>) =>
  (Bot.prototype as any).housekeeping.call(subject) as Promise<void>

describe('essential maintenance does not wait for display prices', () => {
  it('runs risk, fee, nonce and accounting checks while one display fetch stays pending', async () => {
    const response = deferred<Response>()
    const fetchPrice = vi.fn(() => response.promise)
    const price = new PriceFeed(2500, Date.now, fetchPrice as typeof fetch)
    const subject = maintenance(() => price.refresh())
    const first = tick(subject)
    const second = tick(subject)
    try {
      // Observe completion before resolving the price request. A regressed await
      // would keep both ticks pending, without relying on a wall-clock timeout.
      await vi.waitFor(() => expect(subject.truth.tick).toHaveBeenCalledTimes(2))
      expect(subject.checkRegimeGate).toHaveBeenCalledTimes(2)
      expect(subject.checkBroken).toHaveBeenCalledTimes(2)
      expect(subject.sampleResources).toHaveBeenCalledTimes(2)
      // paper collection health is measured on this tick and nowhere else; before
      // 2026-09-16 it was measured nowhere at all (bot.ts checkPaperCollection)
      expect(subject.checkPaperCollection).toHaveBeenCalledTimes(2)
      expect(subject.client.getGasPrice).toHaveBeenCalledTimes(2)
      expect(subject.nonce.resyncIfIdle).toHaveBeenCalledTimes(2)
      expect(fetchPrice).toHaveBeenCalledTimes(1)
      await Promise.all([first, second])
    } finally {
      response.resolve(new Response(JSON.stringify({ data: { amount: '2501' } })))
      await Promise.all([first, second])
    }
  })

  it('contains an unexpected display publication rejection', async () => {
    const subject = maintenance(async () => { throw new Error('display publication failed') })
    await expect(tick(subject)).resolves.toBeUndefined()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(subject.truth.tick).toHaveBeenCalledTimes(1)
    expect(subject.nonce.resyncIfIdle).toHaveBeenCalledTimes(1)
  })
})
