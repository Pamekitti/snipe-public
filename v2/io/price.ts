/**
 * The ETH price, fetched hourly. DISPLAY ONLY, and that is a load-bearing property.
 *
 * Ported from v1 `v1/src/telemetry/price.ts`. Nothing in the fold reads this number: the
 * drawdown stop is in ETH. If a future change makes a stop read it, this module has to go
 * back to being a config value, not a fetch.
 *
 * The seed is never shown. The page stays `unavailable` until Coinbase answers, rather than
 * publishing a made-up dollar figure. A bad body, a jump no real hour produces, or a units
 * mix-up keeps the last good value (or stays unavailable).
 */

const SOURCE_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot'
const TIMEOUT_MS = 8_000
export const REFRESH_MS = 3_600_000

const MIN_USD = 100
const MAX_USD = 100_000
const MAX_JUMP = 0.35

export type PriceReading = {
  usd: number
  at: number
  source: 'config' | 'coinbase'
}

export function acceptPrice(next: unknown, last: number, hasFetched: boolean): boolean {
  if (typeof next !== 'number' || !Number.isFinite(next)) return false
  if (next < MIN_USD || next > MAX_USD) return false
  if (!hasFetched) return true
  return Math.abs(next - last) / last <= MAX_JUMP
}

export function parseCoinbase(body: unknown): number | null {
  const amount = (body as { data?: { amount?: unknown } })?.data?.amount
  if (typeof amount !== 'string' && typeof amount !== 'number') return null
  const n = Number(amount)
  return Number.isFinite(n) ? n : null
}

export class PriceFeed {
  private usd: number
  private at = 0
  private source: 'config' | 'coinbase' = 'config'
  private inFlight = false
  lastError: string | null = null

  constructor(
    seed: number,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.usd = seed
  }

  reading(): PriceReading {
    return { usd: this.usd, at: this.at, source: this.source }
  }

  /** What the page may print. Null until a real fetch has landed. */
  display(): { readonly value: number; readonly source: string } | null {
    if (this.source !== 'coinbase') return null
    return { value: this.usd, source: 'coinbase' }
  }

  async refresh(): Promise<PriceReading | null> {
    if (this.inFlight) return null
    if (this.at !== 0 && this.now() - this.at < REFRESH_MS) return null
    this.inFlight = true
    try {
      const r = await this.fetchImpl(SOURCE_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!r.ok) throw new Error(`http ${r.status}`)
      let body: unknown
      try {
        body = await r.json()
      } catch {
        throw new Error('bad body')
      }
      const next = parseCoinbase(body)
      if (next === null) throw new Error('no price in body')
      if (!acceptPrice(next, this.usd, this.source === 'coinbase')) {
        throw new Error(`refused ${next} against ${this.usd}`)
      }
      const changed = next !== this.usd || this.source === 'config'
      this.usd = next
      this.at = this.now()
      this.source = 'coinbase'
      this.lastError = null
      return changed ? this.reading() : null
    } catch (e) {
      this.lastError = String(e instanceof Error ? e.message : e).slice(0, 80)
      return null
    } finally {
      this.inFlight = false
    }
  }
}
