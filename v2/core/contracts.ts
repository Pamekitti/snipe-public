/**
 * The primitives every other file in core/ is built from.
 *
 * Four of them, and each one exists because its absence cost money in the old bot:
 *
 *   Sensed<T>   a reading cannot reach a decision without its age and its source. On
 *               2026-09-16 the market pane drew a tape that had been frozen since 06:58 and
 *               it looked exactly like a live one, because a frozen array renders like a
 *               live array. Freshness has to be a value, not an assumption.
 *   Ok<T>       a refusal is a value with a reason, never `null` and never silence. The old
 *               processor declined every launch with `ready ? replay() : null` followed by
 *               `if (bundle) save(...)`, which stopped the entire measurement pipeline for
 *               20 minutes with no throw, no log and no counter.
 *   compare     byte order, not locale order. `localeCompare` is locale-dependent, so a
 *               decision that sorts with it is not reproducible on another machine.
 *   Bounded*    growth has a declared ceiling at the type level, so an unbounded cache
 *               cannot be written by accident.
 *
 * Nothing here imports anything. core/ is pure: no node: builtins, no npm, no clock.
 */

// ---------------------------------------------------------------------------
// Sensed values
// ---------------------------------------------------------------------------

/**
 * A measurement, with where it came from and when.
 *
 * `source` is deliberately a string union of PROVENANCE, not of subject: it answers "how do
 * we know this", which is what a reader needs in order to distrust it. The subject is
 * whatever field holds the value.
 */
export type Source = 'chain' | 'gate.db' | 'fold' | 'config' | 'operator' | 'feed' | 'logs'

export type Sensed<T> = {
  readonly value: T
  /** the `at` of the event this was read from. Never a clock call. */
  readonly at: number
  readonly source: Source
  /**
   * sample size, or null when the value is not a sample.
   *
   * Null and 0 are different answers and must not collapse: 0 means "we looked and found
   * nothing", null means "this is not the kind of thing that has an n". The old dashboard
   * rendered both as a dash and an operator could not tell them apart.
   */
  readonly n: number | null
}

/** A `Sensed<T>` that has been asked how old it is, relative to a specific fold position. */
export type Aged<T> = Sensed<T> & { readonly ageMs: number }

/**
 * Takes `now` rather than the whole State, so contracts.ts stays at the bottom of the import
 * graph and state.ts can depend on it rather than the other way round.
 *
 * `now` is always `state.at`, which is the `at` of the last folded event. There is no other
 * clock in core/.
 */
export function age<T>(now: number, s: Sensed<T>): Aged<T> {
  return { ...s, ageMs: now - s.at }
}

/** Convenience for the common case: a value read straight off the event being folded. */
export function sensed<T>(value: T, at: number, source: Source, n: number | null = null): Sensed<T> {
  return { value, at, source, n }
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Every way core/ can decline to act. Closed and exhaustive on purpose: adding a refusal
 * means adding a bucket here, which means the counter, the alert and the funnel all learn
 * about it at once. A free-text reason cannot be counted, so the bucket is the key and
 * `reason` is only ever read by a human.
 *
 * The prefix is the stage, and the funnel groups on it. Do NOT prefix anything else onto a
 * bucket (a book id, a token): the old reject funnel bucketed on the first word of a free
 * string, and prefixing shattered every bucket.
 */
export type RefusalBucket =
  // the observation screen, before a band is known
  | 'screen-pair' | 'screen-tax' | 'screen-devbuy' | 'screen-prior' | 'screen-meta'
  // the trading filter
  | 'entry-tax' | 'entry-exempt' | 'entry-template-loss' | 'entry-no-book'
  // wallet and machine limits
  | 'risk-halted' | 'risk-entered' | 'risk-capacity' | 'risk-size' | 'risk-bankroll'
  | 'risk-logs-unhealthy' | 'risk-logs-stale' | 'risk-degraded'
  // the last look before sending
  | 'guard-pumped' | 'guard-sim-failed'
  // an exit that was sequenced and then went quiet
  | 'exit-unsettled'
  // a sensor could not answer
  | 'sensor-unreadable' | 'sensor-stale' | 'sensor-no-rows'
  // the send path
  | 'send-rejected' | 'send-refused'
  // the exit path
  | 'exit-parked' | 'exit-stuck' | 'exit-abandoned'
  // the other venue: a bag the curve will no longer sell, being sold on the V4 pool
  | 'exit-grad-budget' | 'exit-grad-blocked'
  // the fold disagreed with the tape, or the operator's input was refused
  | 'feed-routing-divergence' | 'config-refused' | 'switch-refused'

export const REFUSAL_BUCKETS: readonly RefusalBucket[] = [
  'screen-pair', 'screen-tax', 'screen-devbuy', 'screen-prior', 'screen-meta',
  'entry-tax', 'entry-exempt', 'entry-template-loss', 'entry-no-book',
  'risk-halted', 'risk-entered', 'risk-capacity', 'risk-size', 'risk-bankroll',
  'risk-logs-unhealthy', 'risk-logs-stale', 'risk-degraded',
  'guard-pumped', 'guard-sim-failed',
  'exit-unsettled',
  'sensor-unreadable', 'sensor-stale', 'sensor-no-rows',
  'send-rejected', 'send-refused',
  'exit-parked', 'exit-stuck', 'exit-abandoned',
  'exit-grad-budget', 'exit-grad-blocked',
  'feed-routing-divergence', 'config-refused', 'switch-refused',
] as const

export type Refusal = {
  readonly at: number
  readonly bucket: RefusalBucket
  /** human detail. Never parsed, never matched on, never a control-flow input. */
  readonly reason: string
  /** what was refused: a token address, a curve, or an intent id. */
  readonly subject: string
}

/**
 * The return type of every predicate in core/.
 *
 * `null` is banned as a way of saying no, because `null` carries no reason and cannot be
 * counted. A function that genuinely has nothing to say returns `ok: true` with an empty
 * value; a function that DECLINED returns a refusal.
 */
export type Ok<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: Refusal }

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

export function no<T>(at: number, bucket: RefusalBucket, subject: string, reason: string): Ok<T> {
  return { ok: false, refusal: { at, bucket, reason, subject } }
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Byte order. Use this everywhere a decision sorts strings.
 *
 * `String.prototype.localeCompare` depends on the host's locale and ICU build, so two
 * machines can order the same array differently and a replay stops reproducing the live run.
 * It is never the right comparator inside a decision.
 */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Same rule for bigint, which has no built-in comparator that returns a number. */
export function compareBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// ---------------------------------------------------------------------------
// Bounded collections
// ---------------------------------------------------------------------------

/**
 * A Map with a declared ceiling, evicting oldest-first.
 *
 * The old bot had four tx-keyed caches with hand-rolled eviction at five separate sites, and
 * a fifth cache with no eviction at all. Making the ceiling part of the type means an
 * unbounded cache is something you have to go out of your way to write.
 *
 * Insertion order is Map's own, which is specified and therefore reproducible. That is the
 * one place relying on JS iteration order is safe, and it is why this is a Map and not an
 * object.
 */
export class BoundedMap<K, V> {
  private readonly m = new Map<K, V>()
  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('BoundedMap limit must be a positive integer')
  }
  get size(): number { return this.m.size }
  has(k: K): boolean { return this.m.has(k) }
  get(k: K): V | undefined { return this.m.get(k) }
  delete(k: K): boolean { return this.m.delete(k) }
  keys(): IterableIterator<K> { return this.m.keys() }
  entries(): IterableIterator<[K, V]> { return this.m.entries() }
  set(k: K, v: V): this {
    // Re-insert so a refreshed key becomes the newest, otherwise a hot key is evicted while
    // cold ones survive.
    if (this.m.has(k)) this.m.delete(k)
    this.m.set(k, v)
    while (this.m.size > this.limit) {
      const oldest = this.m.keys().next()
      if (oldest.done) break
      this.m.delete(oldest.value)
    }
    return this
  }
  clone(): BoundedMap<K, V> {
    const c = new BoundedMap<K, V>(this.limit)
    for (const [k, v] of this.m) c.m.set(k, v)
    return c
  }
}

/** The same ceiling for a set of keys with no value, used for negative caches. */
export class BoundedSet<K> {
  private readonly inner: BoundedMap<K, true>
  constructor(limit: number) { this.inner = new BoundedMap<K, true>(limit) }
  get size(): number { return this.inner.size }
  get limit(): number { return this.inner.limit }
  has(k: K): boolean { return this.inner.has(k) }
  add(k: K): this { this.inner.set(k, true); return this }
  delete(k: K): boolean { return this.inner.delete(k) }
  keys(): IterableIterator<K> { return this.inner.keys() }
  clone(): BoundedSet<K> {
    const c = new BoundedSet<K>(this.limit)
    for (const k of this.inner.keys()) c.add(k)
    return c
  }
}

/**
 * A fixed-length ring of samples, oldest dropped on push.
 *
 * Every trailing-window sensor in the old bot reimplemented this: the scored cohort, the three
 * venue guards, the adaptive take-profit window, the broken detector. One implementation, so
 * "the last N" means the same thing in all of them.
 */
export class Ring<T> {
  private items: T[] = []
  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Ring limit must be a positive integer')
  }
  get size(): number { return this.items.length }
  push(x: T): this {
    this.items.push(x)
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit)
    return this
  }
  /** oldest first */
  all(): readonly T[] { return this.items }
  /** the newest `n`, oldest first. Fewer than `n` if the ring holds fewer. */
  last(n: number): readonly T[] { return n >= this.items.length ? this.items : this.items.slice(this.items.length - n) }
  clone(): Ring<T> {
    const c = new Ring<T>(this.limit)
    c.items = [...this.items]
    return c
  }
}
