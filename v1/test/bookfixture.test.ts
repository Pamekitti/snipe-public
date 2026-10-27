import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { StateEngine } from '../src/state/engine.js'
import { freshCurve, type CurveParams, type CurveState } from '../src/state/curve.js'
import type { RawLog } from '../src/logs/subscriber.js'

/**
 * Position 1935, 2026-09-06 18:42 UTC: a coin whose dump was routed through other contracts,
 * so the only way the bot could see it was the poller's logs. The shipped engine folded 48
 * of its 115 trade logs and priced the exit at 2.73x while the chain was at 0.36x. Every log
 * of the coin, from launch to its last trade, replayed from a fresh curve must reproduce the
 * chain's state exactly: the same standard `npm run validate` holds the curve math to.
 */
const fx = JSON.parse(readFileSync(new URL('./fixtures/curve-1935.json', import.meta.url), 'utf8'))

describe('the confirmed book against the chain (position 1935)', () => {
  it('replays every log of a real coin from launch and lands on the chain state bit-exactly', () => {
    const params = Object.fromEntries(Object.entries(fx.params).map(([k, v]) => [k, BigInt(v as string)])) as CurveParams
    const final: CurveState = {
      trackedQuote: BigInt(fx.final.trackedQuote), trackedTokens: BigInt(fx.final.trackedTokens),
      quoteFeeBalance: BigInt(fx.final.quoteFeeBalance), creatorTaxBalance: BigInt(fx.final.creatorTaxBalance),
      graduated: fx.final.graduated,
    }
    // normalised and ordered exactly as logs/subscriber.ts delivers them
    const logs: RawLog[] = fx.logs
      .map((l: any) => ({
        address: String(l.address).toLowerCase(), topics: l.topics, data: l.data,
        blockNumber: parseInt(l.blockNumber, 16), logIndex: parseInt(l.logIndex, 16),
        transactionHash: l.transactionHash, blockHash: l.blockHash,
      }))
      .sort((a: RawLog, b: RawLog) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    // a fixture with one log per block would prove nothing about the guard
    expect(new Set(logs.map((l) => l.blockNumber)).size).toBeLessThan(logs.length)

    const e = new StateEngine()
    e.track(fx.curve, '0xtok', params, freshCurve(params), fx.launchBlock - 1)
    for (const l of logs) e.applyLog(l)
    expect(e.get(fx.curve)!.confirmed).toEqual(final)
    expect(e.seedSkipped).toBe(0)
  })
})
