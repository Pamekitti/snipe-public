import { describe, it, expect } from 'vitest'
import { PriceFeed, acceptPrice, parseCoinbase } from '../io/price.js'

const SEED = 2145
const spot = (amount: unknown) => ({ data: { amount, base: 'ETH', currency: 'USD' } })

const okFetch = (body: unknown) => {
  const calls = { n: 0 }
  const f = (async () => {
    calls.n++
    return { ok: true, json: async () => body } as unknown as Response
  }) as unknown as typeof fetch
  return { f, calls }
}

describe('parseCoinbase reads the shape without trusting it', () => {
  it('takes the amount as a string, which is what the API actually sends', () => {
    expect(parseCoinbase(spot('2515.55'))).toBe(2515.55)
  })

  it('returns null for every shape that is not a price', () => {
    for (const junk of [null, undefined, {}, { data: {} }, spot(null), spot('abc')]) {
      expect(parseCoinbase(junk)).toBeNull()
    }
  })
})

describe('acceptPrice is the guard between an API and the operator display', () => {
  it('refuses values outside the sanity bounds, which catch a units mix-up', () => {
    expect(acceptPrice(1, SEED, true)).toBe(false)
    expect(acceptPrice(2_000_000, SEED, true)).toBe(false)
  })

  it('refuses a jump no real hour produces, keeping the last good value', () => {
    expect(acceptPrice(SEED * 2, SEED, true)).toBe(false)
    expect(acceptPrice(SEED * 1.2, SEED, true)).toBe(true)
  })

  it('does NOT apply the jump test to the very first fetch', () => {
    expect(acceptPrice(SEED * 3, SEED, false)).toBe(true)
    expect(acceptPrice(1, SEED, false)).toBe(false)
  })
})

describe('PriceFeed never throws and never shows the seed', () => {
  it('stays undisplayed until Coinbase answers', async () => {
    const { f } = okFetch(spot('2515'))
    const feed = new PriceFeed(SEED, () => 0, f)
    expect(feed.display()).toBeNull()
    await feed.refresh()
    expect(feed.display()).toEqual({ value: 2515, source: 'coinbase' })
  })

  it('keeps the last good value on a bad body', async () => {
    let n = 0
    let now = 0
    const f = (async () => {
      n++
      if (n === 1) return { ok: true, json: async () => spot('2515') } as unknown as Response
      return { ok: true, json: async () => { throw new Error('bad json') } } as unknown as Response
    }) as unknown as typeof fetch
    const feed = new PriceFeed(SEED, () => now, f)
    await feed.refresh()
    now = 4_000_000
    await feed.refresh()
    expect(feed.display()?.value).toBe(2515)
    expect(feed.lastError).toBeTruthy()
  })
})
