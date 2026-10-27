/**
 * The regime gate's fast half: recent touch verdicts, in memory, keyed by token.
 *
 * WHY THIS EXISTS. scripts/gatewatch.py is the authority on what the cohort did, but it is
 * a systemd job on a 5-minute timer, so its verdict reaches the halt decision somewhere
 * between 45s and 5m51s after the launch it describes. The 45s is the hold closing and is
 * irreducible; the rest is a timer we chose. The bot already marks curves off the live feed
 * every 50ms for its own exits, so it can know the same thing the instant the hold closes.
 * This holds those verdicts.
 *
 * It is deliberately not a cache of gate.db and does not write to it: gate.db stays
 * read-only to the bot (see gate.ts) so the watcher never contends for a write lock.
 *
 * DEDUPED BY TOKEN, because the same launch arrives twice by design -- once from our live
 * scoring and once from a gate.db hydrate after a restart. Counting it twice moves the rate
 * on no new information, and the rate is what halts real money.
 */
export type CohortReading = {
  rate: number
  n: number
  dataAgeMs: number | null
  /**
   * How many of those `n` we scored OURSELVES, as opposed to inheriting from a gate.db
   * hydrate. The ring is seeded from the file, so `n` alone cannot tell a working live
   * scorer from one that died right after startup: both show a full window of 20. This
   * is the number that distinguishes them, and it is the one to alarm on.
   */
  liveN: number
}

/**
 * The cohort verdict, in exactly the terms gatewatch.py uses: did the venue mark reach the
 * gate's bar at any point inside the hold.
 *
 * NOT named for the take profit any more, and that is deliberate. It used to be handed
 * STRATEGY.takeProfitMultiple, which made the gate's ruler move whenever the exit policy
 * did; it is now handed STRATEGY.gate.touchMultiple. A name that still said "take profit"
 * was the last thing pointing the wrong way.
 *
 * `entry` and `peak` are PRICES scaled by PRICE_SCALE (state/curve.ts), not wei: the ratio
 * is the raw mid over the fee-inclusive entry price, matching gatewatch's
 * `c.price() / entry_px`. Integer maths throughout, because a float round-trip at the
 * boundary is the difference between a touch and a miss on a launch that hit 1.2100
 * exactly. Scaled by 1000 so a 1.21x bar is 1210 and nothing is lost to truncation above it.
 */
export function touchedBar(entry: bigint, peak: bigint, bar: number): boolean {
  if (entry <= 0n) return false
  return (peak * 1000n) / entry >= BigInt(Math.round(bar * 1000))
}

/** `live` records where the verdict came from, which is what makes liveN honest */
type Verdict = { at: number; touch: boolean; live: boolean }

/** enough for any plausible window, bounded so a long-running process cannot creep */
const DEFAULT_CAP = 200

export class Cohort {
  private v = new Map<string, Verdict>()

  constructor(private readonly cap = DEFAULT_CAP) {}

  get size(): number {
    return this.v.size
  }

  /**
   * A launch we scored ourselves. `launchedAtMs` is milliseconds; gate.db's column is
   * seconds and hydrate() converts, which is the one unit trap in here.
   *
   * A repeat for the same token REPLACES rather than adds, so gatewatch correcting our
   * live verdict lands as a correction instead of a second vote.
   */
  record(token: string, launchedAtMs: number, touch: boolean): void {
    this.v.set(token.toLowerCase(), { at: launchedAtMs, touch, live: true })
    this.evict()
  }

  /** Seed from gate.db on startup so a restart is not blind for the first 20 launches. */
  hydrate(rows: Array<{ token: string; launched_at: number | null; touch: number }>): number {
    let accepted = 0
    for (const r of rows) {
      const k = (r.token ?? '').toLowerCase()
      if (!k || r.launched_at == null) continue
      // never clobber a verdict we scored live: it is at least as fresh as the file's
      if (this.v.has(k)) continue
      this.v.set(k, { at: r.launched_at * 1000, touch: r.touch === 1, live: false })
      accepted++
    }
    this.evict()
    // the count the CALLER may report. rows.length overstates it whenever a row was
    // skipped for a null launched_at or a token we already held, and "seeded 20/20" when
    // the ring holds 15 is exactly the kind of lie that gets believed at 3am.
    return accepted
  }

  /**
   * The newest `window` verdicts by LAUNCH time, not by arrival time. A verdict can arrive
   * late (a hydrate, or a slow feed) and must not displace something newer than itself.
   *
   * Null means "nothing recorded", which callers must read as no opinion rather than as a
   * bad venue -- the same contract RegimeGate.read() already has.
   */
  reading(window: number, now: number): CohortReading | null {
    if (!this.v.size) return null
    const w = [...this.v.values()].sort((a, b) => b.at - a.at).slice(0, window)
    const touches = w.reduce((a, r) => a + (r.touch ? 1 : 0), 0)
    const liveN = w.reduce((a, r) => a + (r.live ? 1 : 0), 0)
    return { rate: (100 * touches) / w.length, n: w.length, dataAgeMs: now - w[0]!.at, liveN }
  }

  private evict(): void {
    if (this.v.size <= this.cap) return
    const byAge = [...this.v.entries()].sort((a, b) => a[1].at - b[1].at)
    for (const [k] of byAge.slice(0, this.v.size - this.cap)) this.v.delete(k)
  }
}
