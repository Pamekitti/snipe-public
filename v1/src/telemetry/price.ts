/**
 * The ETH price, fetched hourly. DISPLAY ONLY, and that is a load-bearing property.
 *
 * WHY THIS IS SAFE TO FETCH AT ALL. Until 2026-09-07 the price scaled both stops
 * (schema.ts said so: "It scales BOTH stops, so it is a money setting, not a display
 * one"), so a module like this one would have handed an external HTTP response the power
 * to move a kill switch. Two changes landed first, in this order, and neither is optional:
 * the drawdown stop is denominated in ETH, and the daily cap is gone. Nothing in the tree
 * now decides anything on this number. If a future change makes a stop read it again, this
 * module has to go back to being a config value.
 *
 * WHY IT NEEDED FETCHING. The configured value was 2145 while ETH was 2515, so every
 * dollar figure the operator read was 15% low, and while the stop was still in dollars the
 * same staleness made a "$240" limit really $282.
 *
 * WHERE THE NUMBER GOES. `chain_truth.eth_usd`, with its timestamp, which is the table the
 * out-of-process monitors already read for `epoch_base_id` and `strategy_json`. That keeps
 * the "one ETH price everywhere" rule that this repo has broken twice: once with three
 * different constants in three files, once with a stale one in all of them.
 */

/** Coinbase spot: no key, no rate limit worth worrying about at once an hour, flat shape. */
const SOURCE_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot'
const TIMEOUT_MS = 8_000
/** once an hour is plenty for a display number, and it is 24 calls a day */
export const REFRESH_MS = 3_600_000

/**
 * Sanity bounds. Not a forecast: a floor and ceiling wide enough that no real market move
 * trips them, narrow enough that a malformed body, a demo endpoint or a units mix-up does.
 */
const MIN_USD = 100
const MAX_USD = 100_000
/**
 * A single fetch may not move the displayed price more than this. ETH has never moved 35%
 * in an hour; a response that claims it did is a bad response, and the last good value is
 * a better answer than a wrong one. Only ever rejects, so the failure mode is a stale
 * price with a visible age, which the page shows and an alert raises.
 */
const MAX_JUMP = 0.35

export type PriceReading = {
  usd: number
  /** when the value was fetched, ms. 0 while still on the configured seed. */
  at: number
  source: 'config' | 'coinbase'
}

/** exported for the tests, and for anyone who wants to check a value without a network */
export function acceptPrice(next: unknown, last: number, hasFetched: boolean): boolean {
  if (typeof next !== 'number' || !Number.isFinite(next)) return false
  if (next < MIN_USD || next > MAX_USD) return false
  // The jump test only applies once a real fetch has landed. Against the SEED it would be
  // backwards: a seed left at 2145 for a month is exactly the case this module exists to
  // correct, and refusing the correction for being large would pin the stale value forever.
  if (!hasFetched) return true
  return Math.abs(next - last) / last <= MAX_JUMP
}

/** parse Coinbase's shape without trusting any of it */
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
  /** last failure, for the operator. A silent stale price is the thing to avoid here. */
  lastError: string | null = null

  /**
   * @param seed the configured ETHUSD, used until a fetch lands and whenever one cannot
   * @param now injected for the tests, like every other clock in this tree
   * @param fetchImpl injected so the suite never touches the network
   */
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

  /** ms since the last successful fetch, or null while still on the seed */
  ageMs(): number | null {
    return this.at === 0 ? null : this.now() - this.at
  }

  /** the seed moved under us (ETHUSD is hot): take it, but never over a real fetch */
  reseed(seed: number): void {
    if (this.source === 'config') this.usd = seed
  }

  /**
   * Fetch if the last success is older than REFRESH_MS. Never throws and never awaits
   * anything the caller has to handle: it is called from the housekeeping tick, which sits
   * above the trading loop, and a price refresh has no business being able to disturb it.
   *
   * Returns the reading if it CHANGED, so the caller can persist and log a transition
   * rather than writing the same row every tick.
   */
  async refresh(): Promise<PriceReading | null> {
    if (this.inFlight) return null
    if (this.at !== 0 && this.now() - this.at < REFRESH_MS) return null
    this.inFlight = true
    try {
      // status before body, for the reason logs/subscriber.ts records: a rate-limited or
      // erroring endpoint answers with an HTML page, and letting that reach JSON.parse
      // produces "Unexpected token '<'", which says nothing about the cause.
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
      // The last good value stands. There is no failure mode here that is improved by
      // moving the price, and the age is published so a stale one is visible rather than
      // quietly wrong.
      this.lastError = String(e instanceof Error ? e.message : e).slice(0, 80)
      return null
    } finally {
      this.inFlight = false
    }
  }
}
