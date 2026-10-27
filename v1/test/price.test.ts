/**
 * THE ETH PRICE FEED (telemetry/price.ts).
 *
 * The reason this module is allowed to exist is that no stop reads its output. Until
 * 2026-09-07 the price scaled both drawdown stops, and fetching it would have handed an
 * external HTTP response the power to halt or un-halt a bot holding real money. The
 * drawdown stop moved to ETH and the daily cap was deleted first, in that order.
 *
 * So the tests here are not about accuracy. They are about a display number that must
 * never take the process down, never move on a bad answer, and never go stale silently.
 */
import { describe, it, expect } from 'vitest'
import { PriceFeed, acceptPrice, parseCoinbase, REFRESH_MS } from '../src/telemetry/price.js'
import { STRATEGY, RISK } from '../src/config.js'

const SEED = 2145
const T0 = Date.UTC(2026, 8, 7, 12, 0, 0)

/** a fetch that answers with whatever body, and records how often it was called */
const okFetch = (body: unknown) => {
  const calls = { n: 0 }
  const f = (async () => {
    calls.n++
    return { ok: true, json: async () => body } as unknown as Response
  }) as unknown as typeof fetch
  return { f, calls }
}
const spot = (amount: unknown) => ({ data: { amount, base: 'ETH', currency: 'USD' } })

describe('parseCoinbase reads the shape without trusting it', () => {
  it('takes the amount as a string, which is what the API actually sends', () => {
    expect(parseCoinbase(spot('2515.55'))).toBe(2515.55)
  })

  it('takes a number too, in case the shape ever changes under us', () => {
    expect(parseCoinbase(spot(2515))).toBe(2515)
  })

  it('returns null for every shape that is not a price', () => {
    for (const junk of [null, undefined, {}, { data: {} }, spot(null), spot('abc'), spot({}), [], 'nope']) {
      expect(parseCoinbase(junk)).toBeNull()
    }
  })
})

describe('acceptPrice is the guard between an API and the operator display', () => {
  it('takes an ordinary price', () => {
    expect(acceptPrice(2515, SEED, true)).toBe(true)
  })

  it('refuses anything that is not a finite number', () => {
    for (const junk of [NaN, Infinity, -Infinity, '2515', null, undefined, {}]) {
      expect(acceptPrice(junk, SEED, true)).toBe(false)
    }
  })

  it('refuses values outside the sanity bounds, which catch a units mix-up', () => {
    // the failure this is really for: an endpoint answering in a different unit, or a demo
    // endpoint answering 1, either of which would make every dollar on the page nonsense
    expect(acceptPrice(1, SEED, true)).toBe(false)
    expect(acceptPrice(0, SEED, true)).toBe(false)
    expect(acceptPrice(-2515, SEED, true)).toBe(false)
    expect(acceptPrice(2_000_000, SEED, true)).toBe(false)
  })

  it('refuses a jump no real hour produces, keeping the last good value', () => {
    expect(acceptPrice(SEED * 2, SEED, true)).toBe(false)
    expect(acceptPrice(SEED * 0.5, SEED, true)).toBe(false)
    // a big but plausible move is still taken
    expect(acceptPrice(SEED * 1.2, SEED, true)).toBe(true)
    expect(acceptPrice(SEED * 0.8, SEED, true)).toBe(true)
  })

  it('does NOT apply the jump test to the very first fetch', () => {
    // The case that made this a named argument rather than an implicit one: the seed had
    // been 2145 for weeks against a real 2515, and this module exists to correct exactly
    // that. A jump test against the seed would refuse the correction for being large and
    // pin the stale value forever, which is the bug rather than the guard.
    expect(acceptPrice(SEED * 3, SEED, false)).toBe(true)
    // the sanity bounds still apply, first fetch or not
    expect(acceptPrice(1, SEED, false)).toBe(false)
  })
})

describe('PriceFeed', () => {
  const feed = (body: unknown, now = () => T0) => {
    const { f, calls } = okFetch(body)
    return { p: new PriceFeed(SEED, now, f), calls }
  }

  it('starts on the configured seed and says so', () => {
    const { p } = feed(spot('2515'))
    expect(p.reading()).toEqual({ usd: SEED, at: 0, source: 'config' })
    // null age, not zero: "no fetch has landed" is a different claim from "fetched now"
    expect(p.ageMs()).toBeNull()
  })

  it('takes a good price, stamps it, and reports the change once', async () => {
    const { p, calls } = feed(spot('2515.55'))
    const moved = await p.refresh()
    expect(moved).toEqual({ usd: 2515.55, at: T0, source: 'coinbase' })
    expect(p.ageMs()).toBe(0)
    // the same price again is not a change: the caller writes a row and logs on a change,
    // and an hourly identical row is noise in a ledger people read
    expect(await p.refresh()).toBeNull()
    expect(calls.n).toBe(1)
  })

  it('fetches at most once an hour, whatever the tick rate', async () => {
    let now = T0
    const { p, calls } = feed(spot('2515'), () => now)
    await p.refresh()
    expect(calls.n).toBe(1)
    // the housekeeping tick runs every 30 seconds; 119 more of them must not add a call
    for (let i = 0; i < 119; i++) { now += 30_000; await p.refresh() }
    expect(calls.n).toBe(1)
    now = T0 + REFRESH_MS
    await p.refresh()
    expect(calls.n).toBe(2)
  })

  it('keeps the last good value when the endpoint fails, and never throws', async () => {
    const cases: Array<[string, typeof fetch]> = [
      ['http 500', (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch],
      ['html body', (async () => ({ ok: true, json: async () => { throw new SyntaxError('<') } })) as unknown as typeof fetch],
      ['no price', (async () => ({ ok: true, json: async () => ({ data: {} }) })) as unknown as typeof fetch],
      ['network', (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch],
    ]
    for (const [name, f] of cases) {
      const p = new PriceFeed(SEED, () => T0, f)
      await expect(p.refresh()).resolves.toBeNull()
      expect(p.reading().usd, name).toBe(SEED)
      expect(p.reading().source, name).toBe('config')
      expect(p.lastError, name).not.toBeNull()
    }
  })

  it('a refused price leaves the previous FETCHED value standing, not the seed', async () => {
    let now = T0
    let body: unknown = spot('2500')
    const f = (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch
    const p = new PriceFeed(SEED, () => now, f)
    await p.refresh()
    expect(p.reading().usd).toBe(2500)
    now += REFRESH_MS
    body = spot('9000')            // a 3.6x jump: refused
    expect(await p.refresh()).toBeNull()
    expect(p.reading().usd).toBe(2500)
    expect(p.lastError).toContain('refused')
    // and the age keeps growing, so the staleness is visible rather than hidden
    expect(p.ageMs()).toBe(REFRESH_MS)
  })

  it('retries after a failure rather than waiting out the hour', async () => {
    // a failed fetch does not stamp `at`, so the next tick tries again. Without this a
    // single 500 would blank the price for an hour.
    let fail = true
    const calls = { n: 0 }
    const f = (async () => {
      calls.n++
      if (fail) throw new Error('boom')
      return { ok: true, json: async () => spot('2515') } as unknown as Response
    }) as unknown as typeof fetch
    const p = new PriceFeed(SEED, () => T0, f)
    await p.refresh()
    expect(calls.n).toBe(1)
    fail = false
    await p.refresh()
    expect(calls.n).toBe(2)
    expect(p.reading().usd).toBe(2515)
  })

  it('takes a moved seed while on config, and never over a real fetch', async () => {
    // ETHUSD is hot, so an operator edit must show up before any fetch has landed. Once a
    // fetch HAS landed, the file is the fallback and must not overwrite live data.
    const { p } = feed(spot('2515'))
    p.reseed(3000)
    expect(p.reading().usd).toBe(3000)
    await p.refresh()
    expect(p.reading().usd).toBe(2515)
    p.reseed(9999)
    expect(p.reading().usd).toBe(2515)
  })

  it('does not stack overlapping fetches', async () => {
    // housekeeping is async and a slow tick can overlap the next one
    let release: (v: unknown) => void = () => {}
    const calls = { n: 0 }
    const f = (async () => {
      calls.n++
      await new Promise((r) => { release = r })
      return { ok: true, json: async () => spot('2515') } as unknown as Response
    }) as unknown as typeof fetch
    const p = new PriceFeed(SEED, () => T0, f)
    const first = p.refresh()
    expect(await p.refresh()).toBeNull()
    expect(calls.n).toBe(1)
    release(null)
    await first
    expect(calls.n).toBe(1)
  })
})

describe('the page shows the FETCHED price, not the seed', () => {
  it('every dollar in the payload is computed from the display price', async () => {
    // The bug this pins, found live on 2026-09-07 minutes after the fetch shipped: the
    // feed fetched 2507, stored it in chain_truth, and the page went on rendering the
    // configured 2515 while labelling it "coinbase". The payload read RISK.ethUsd, which
    // is the seed. A display layer has to read the display price.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/telemetry/dashboard.ts', import.meta.url), 'utf8')
    // exactly one place may read the seed: the fallback inside displayPrice
    const seedReads = src.split('\n').filter((l) => l.includes('RISK.ethUsd') && !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    expect(seedReads).toHaveLength(1)
    expect(seedReads[0]).toContain('Number.isFinite(p.usd)')   // displayPrice's fallback
    expect(src).toMatch(/function displayPrice/)
    // and both snapshot builders take the local
    expect(src).toMatch(/export function snapshot\(bot: Bot\)[^]*?const ethUsd = displayPrice\(bot\)/)
    expect(src).toMatch(/export function chartSnapshot\([^]*?const ethUsd = displayPrice\(bot\)/)
  })
})

describe('the price cannot reach a stop', () => {
  it('no stop in the tree reads the ETH price', async () => {
    // THE invariant that makes this module safe. If a future change compares dollars in a
    // kill switch again, this fails and the fetch has to go back to being a config value.
    const { readFileSync } = await import('node:fs')
    const risk = readFileSync(new URL('../src/strategy/risk.ts', import.meta.url), 'utf8')
    const truth = readFileSync(new URL('../src/telemetry/truth.ts', import.meta.url), 'utf8')
    // both stops compare wei against the ETH bound
    expect(risk).toMatch(/downWei >= limitWei\(\)/)
    expect(truth).toMatch(/downWei >= BigInt\(Math\.round\(RISK\.maxDrawdownEth \* 1e18\)\)/)
    // and every remaining use of the price in those two files is inside a display string.
    // There are no exceptions: the probe cap was the last USD-denominated limit in the tree
    // and it went with the probe book on 2026-09-07.
    for (const [name, src] of [['risk.ts', risk], ['truth.ts', truth]] as const) {
      for (const line of src.split('\n')) {
        if (!line.includes('RISK.ethUsd')) continue
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) continue
        expect(line, `${name}: ethUsd outside a display string`).toMatch(/toFixed|\$\{|dollars|usd =/)
      }
    }
  })

  it('no limit anywhere in the tree is denominated in dollars', () => {
    // The last one was the probe cap, deleted with the probe book on 2026-09-07. Before
    // that this test carried it as a named exception, because probeTripped had to read the
    // price and so a fetched price could move a real threshold.
    //
    // If a dollar-denominated limit is ever added back, convert it to ETH or move the
    // price fetch behind a config value again. Those are the only two safe shapes.
    const { readFileSync, readdirSync } = require('node:fs') as typeof import('node:fs')
    const dir = new URL('../src/config/', import.meta.url)
    const schema = readFileSync(new URL('schema.ts', dir), 'utf8')
    const usdKeys = [...schema.matchAll(/env: '([A-Z_]*USD[A-Z_]*)'/g)].map((m) => m[1])
    // ETHUSD is the price itself, not a limit
    expect(usdKeys.filter((k) => k !== 'ETHUSD')).toEqual([])
    void readdirSync
  })
})
