/**
 * The regime gate, read from the side.
 *
 * scripts/gatewatch.py replays every launch we screened and passed and tracks how often
 * the cohort touches our take profit inside the hold. That number is the venue: it ran
 * 50-70% while the strategy made money and fell to 5% on 2026-08-18, and nothing visible
 * at buy time distinguishes the two states, so no filter can substitute for it.
 *
 * On that day the watcher existed only as a report and the bot kept buying all the way
 * down, which cost $25 in eight hours. So the bot now reads it and stops itself.
 *
 * TWO-WAY SINCE 2026-08-19, BUT ONLY FOR ITSELF. A shut gate turns entries off and a
 * sustained open one turns them back on, because the venue's quiet spells reverse on
 * their own and waiting for a human to notice at 3am threw away whole nights for nothing.
 *
 * The safety of that rests entirely on an asymmetry, so it is worth stating plainly: this
 * gate may only lift a halt that this gate placed. The drawdown kill switch and HALT=1
 * are untouchable by it (RiskManager.resume refuses any kind but its own, and refuses
 * 'drawdown' outright). "The venue recovered" is evidence about the venue; it is not
 * evidence that we stopped losing money. So the worst a bug in here can do is trade a
 * regime we should have sat out, bounded by the drawdown stop underneath it.
 *
 * REAL TIME SINCE 2026-08-19. The rate used to come only from gate.db, which gatewatch.py
 * rewrites on a five-minute timer, so a verdict reached this decision between 45s and
 * 5m51s after the launch it described. The 45s is the hold closing and is irreducible; the
 * rest was a timer. The bot now scores the cohort itself off the live feed (strategy/
 * cohort.ts) and applies the hysteresis here, so the same verdict arrives in milliseconds.
 * gatewatch.py is unchanged and still owns the durable record, the dashboard, and repair
 * of launches our feed dropped; its rows are the fallback whenever the live ring is thin.
 *
 * The thresholds and the rule are NOT changed by that: `open = was_shut ? rate >= openAt :
 * rate > shutAt` is character for character what gatewatch.py applies, and gatelive.test.ts
 * asserts they agree step for step. Only the latency moved.
 *
 * Shutting is immediate, and resuming is immediate too. The ten-minute resume timer
 * existed because a five-minute scoring tick made "ten minutes of open readings" only two
 * independent samples; with continuous scoring the band itself provides that separation,
 * since reopening still demands openAt rather than shutAt. The timer plumbing was deleted
 * on 2026-08-19 after sitting pinned at zero -- see gateAction below.
 *
 * That invariant has exactly one hole, and it is the reason for the staleness check
 * below: a gate that is merely FROZEN reads as open forever. If gatewatch.py dies during
 * a regime break, a stale 'open' is not a missed opportunity, it is the 2026-08-18 loss
 * happening again with a watcher that looks fine. So a watcher that has stopped
 * heartbeating is treated as shut. Costing upside is still the failure mode we choose.
 *
 * Its own database, opened read-only: the bot must never contend with the watcher for a
 * write lock, and a missing or corrupt gate.db has to be a no-op rather than an outage.
 * The live path does not change that -- it is in memory and writes nothing.
 */
import Database from 'better-sqlite3'
import type { Cohort } from './cohort.js'

export type GateReading = {
  state: 'open' | 'shut'
  rate: number
  n: number
  /** set when the verdict came from the heartbeat rather than the touch rate */
  stale?: string
  /**
   * Age of the newest launch this rate was computed from. NOT the same question as the
   * heartbeat, and the difference is the whole point: `ran_at` says the watcher is alive,
   * this says it has seen something. gatewatch only scores launches that passed the book,
   * so a dry spell starves it while it keeps heartbeating happily. On 2026-08-19 05:00 the
   * gate reported "open, 20.0%" on a window whose newest launch was 151 minutes old and
   * nothing anywhere said so.
   *
   * Reported only. Nothing in the halt/resume path reads it yet; time-bounding the window
   * is a trading-safety change and wants its own diff.
   *
   * Sourced from whichever side produced the rate: the live ring when it is full, the file
   * otherwise.
   */
  dataAgeMs: number | null
  /**
   * Which side actually produced this rate: our own live scoring, or gatewatch.py's file.
   *
   * Reported because the two can now disagree and the failure is silent: the ring is
   * SEEDED from the file, so a live path that quietly stopped filling looks identical on
   * the number alone while being exactly as stale as before the change. Anything showing
   * the gate to a human should show this next to it.
   */
  source: 'live' | 'file'
  /**
   * How many verdicts in the window our own scoring produced, against the window it needs.
   *
   * NOT the ring's size. The ring is seeded from gate.db, so a live scorer that died on
   * its first launch still shows a full window of 20 and a plausible rate forever. Only
   * this number falls, so this is the one to watch and the one to alarm on.
   *
   * Reported whether or not STRATEGY.gate.live is set, because the flag exists precisely
   * so the scorer can be observed before it decides anything.
   */
  liveN: number
}

/**
 * gatewatch.py runs every 5 minutes and stamps `ran_at` at the end of every pass, so six
 * consecutive misses is a watcher that is genuinely down rather than one slow RPC round.
 */
export const STALE_MS = 30 * 60_000

/**
 * What the P&L sensor sees. `state` is what the caller acts on; `fresh` says whether the
 * window was dense enough to mean anything, and an unfresh window always reads 'open'.
 */
export type VenueReading = {
  source?: 'adaptive-shadow' | 'conservative-paper'
  window?: number
  recoveryWindow?: number
  fullRecoveryOn?: number
  recoveryOn?: number
  recoveryMode?: 'fresh' | 'full' | 'both'
  pauseBelow?: number
  sumRange?: [number, number] | null
  recentSumRange?: [number, number] | null
  policyId?: string
  recentSum?: number
  reason?: string
  observerError?: string | null
  verified?: boolean
  pending?: number
  configId?: string
  publicationAt?: number | null
  state: 'open' | 'shut'
  sum: number
  n: number
  fresh: boolean
  oldestAgeMs: number
  bar: string
  /** the individual launches this sum was built from, newest first. See OutcomeValue. */
  outcomes?: OutcomeValue[]
  /** the recovery window's own slice, when the sensor keeps one separate from `outcomes` */
  recentOutcomes?: OutcomeValue[]
  /**
   * Set when the adaptive sensor had no opinion and gatewatch answered instead, carrying
   * WHY. Null/absent means the sensor named in `source` is the one that decided.
   */
  fallback?: string | null
}

/**
 * The hysteresis step itself, exported so the dashboard's historical replay
 * (telemetry/gatehistory.ts) applies character-for-character the rule that halts real
 * money. gatelive.test.ts pins this against gatewatch.py; the replay riding the same
 * function means a page can no longer disagree with the halt path by one comparison
 * operator. (gatewatch.py keeps its own Python copy by design; the test is the bridge.)
 */
export const stepGate = (
  state: 'open' | 'shut', rate: number, openAt: number, shutAt: number,
): 'open' | 'shut' => ((state === 'shut' ? rate >= openAt : rate > shutAt) ? 'open' : 'shut')
/**
 * THE P&L SENSOR, as a pure function over rows gatewatch already wrote.
 *
 * The touch rate above asks "did the cohort reach a price". This asks the question the
 * money actually turns on: what would the bot's own exit rule have MADE on the launches it
 * was not holding? gatewatch replays every book-passing launch at every bar the bot trades
 * (scripts/gatewatch.py score()), with our own fills stripped, so the sum below is the
 * venue measured in stakes, on coins we never had to hold.
 *
 * The 2026-09-07 current-size audit selected a 20-launch window with -1/+1
 * thresholds. The older wide-tape claims were not independently validated.
 * See research/GUARD_AUDIT_PROTOCOL.md for the remaining execution-data limits.
 *
 * `fresh` is the whole safety of it. In August this venue produced 10 launches a day and a
 * 40-launch window reached back four days; today it produces 300-500 and the same window
 * is about an hour. A sensor whose window silently stretches to days is measuring a dead
 * era, so a window that does not fit inside freshMs returns fresh:false and the caller
 * treats it as no opinion rather than as evidence.
 *
 * Rows arrive newest first and carry launched_at in SECONDS. A row missing this bar's key
 * is skipped rather than counted as zero (gatewatch drops a bar that failed to replay, and
 * a skipped bar is missing data, not a flat outcome), so the caller over-fetches and this
 * takes the first `window` rows that actually carry it.
 */
export type OutcomeRow = { bars: string; launched_at: number; at: number; token?: string; peak?: number }
/**
 * The trading book's entry bounds (strategy/entry.ts), so the sensor counts only coins it
 * would buy. `maxTaxBps` joined the pair on 2026-09-15 with ENTRY_MAX_TAX_BPS: a sensor that
 * kept summing taxed launches after the book stopped buying them would be explaining a
 * different book from the one holding the money (memory: venue-sensor-measures-the-book).
 */
export type BookFloors = { minTaxBps: number; maxTaxBps: number; minExempt: number }
/**
 * One launch as the sensor counted it: the outcome in multiples of stake at the bar in use.
 * Kept so the dashboard can show the operator the SAME rows the sum was built from. `obs`
 * is roughly 80% coins the book would never buy, so a reader that re-queries without the
 * book-floor join disagrees with the guard it is meant to explain (memory:
 * venue-sensor-measures-the-book). These come straight off the sum's own loop instead.
 */
export type OutcomeValue = { value: number; launchedAt: number; token: string | null; peak?: number | null }
export type Trailing = { sum: number; n: number; oldestAgeMs: number; fresh: boolean; values: OutcomeValue[] }

export function trailingOutcome(
  rows: readonly OutcomeRow[],
  opts: { window: number; freshMs: number; key: string; now: number },
): Trailing | null {
  if (!rows.length) return null
  let sum = 0
  let n = 0
  let oldestSec = 0
  const values: OutcomeValue[] = []
  for (const r of rows) {
    if (n >= opts.window) break
    let v: unknown
    try {
      v = (JSON.parse(r.bars) as Record<string, unknown>)[opts.key]
    } catch {
      continue // one unparseable row must not cost the sensor
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    sum += v
    n++
    values.push({ value: v, launchedAt: r.launched_at, token: r.token ?? null, peak: r.peak ?? null })
    oldestSec = r.launched_at // rows are newest first, so the last one kept is the oldest
  }
  if (!n) return null
  const oldestAgeMs = opts.now - oldestSec * 1000
  return { sum, n, oldestAgeMs, fresh: n >= opts.window && oldestAgeMs <= opts.freshMs, values }
}

/**
 * The venue sensor's hysteresis, the same shape as stepGate and separate on purpose: the
 * two sensors measure different things on different scales and must not share thresholds.
 * Shut strictly below `off`, open strictly above `on`, and inside the band nothing moves.
 */
export const stepVenue = (
  state: 'open' | 'shut', sum: number, off: number, on: number,
): 'open' | 'shut' => (state === 'open' ? (sum < off ? 'shut' : 'open') : (sum > on ? 'open' : 'shut'))

/** a failed open is retried, but not on every 30s housekeeping tick */
const REOPEN_MS = 60_000

export class RegimeGate {
  private db: Database.Database | null = null
  private nextTry = 0

  /**
   * Prepared once per open, not once per read. read() is now called from the settle path
   * of the 50ms exit pump, so the three statements below sit on the same synchronous tick
   * that decides when to sell. It only fires when a hold closes rather than every tick,
   * but this project has already lost 3.5 minutes of gate visibility to blocking I/O in a
   * hot path once, so the cheap fix goes in.
   */
  private stmts: {
    obs: Database.Statement
    /** null when gate.db predates the per-bar schema; the gate itself does not depend on it */
    bars: Database.Statement | null
    /** the same rows with their clocks, for the P&L sensor. Null for the same reason. */
    barsAt: Database.Statement | null
    /** one launch's outcomes by token, for the real-vs-replay check. Built per call. */
    barsFor: ((tokens: string[]) => Database.Statement) | null
    ranAt: Database.Statement
    gate: Database.Statement
    templateBlock: Database.Statement
  } | null = null

  /**
   * Hysteresis state, owned here rather than read from gate.db's `state.gate` row. It
   * starts as 'shut' and is seeded from the file on the first read, so a restart inherits
   * the watcher's view instead of assuming the venue is good.
   */
  private state: 'open' | 'shut' = 'shut'
  private seeded = false

  /**
   * The P&L sensor's own hysteresis state, separate from the touch gate's above.
   *
   * Starts OPEN, unlike the touch gate, and is seeded from the first FRESH reading. The
   * touch gate seeds shut because its band (10-25) has a wide disagreement region where
   * the permissive answer keeps buying on a rate that was never good enough. This band is
   * a P&L sum whose neutral point is zero and whose resume threshold is +0.5 stakes: seeding
   * shut would park a restarted bot until the venue had actively made money, which is not
   * the same claim and would cost a whole window of trading after every deploy.
   */
  private venueState: 'open' | 'shut' = 'open'
  private venueSeeded = false

  constructor(
    private readonly file = 'data/gate.db',
    private readonly now: () => number = Date.now,
    private cohort: Cohort | null = null,
    /** see STRATEGY.gate.live: the live path records and reports before it decides */
    private readonly useLive = true,
    /**
     * bot.db, attached read-only so the P&L sensor can join obs to launches and keep only
     * the coins the BOOK would buy. Null (the touch-gate-only callers) leaves the sensor
     * with no opinion; it never falls back to the whole scored set, see open().
     */
    private readonly bookFile: string | null = null,
  ) {}
  private bookWarned = false

  setCohort(c: Cohort | null): void {
    this.cohort = c
  }

  private open(): Database.Database | null {
    if (this.db) return this.db
    // Never latch. The watcher's timer and the bot's start order are independent, so
    // "gate.db does not exist yet" is a normal state on a fresh box and it resolves
    // itself within five minutes. Latching it turned the gate off for the whole
    // lifetime of the process, which is the one failure this module may not have.
    if (this.now() < this.nextTry) return null
    this.nextTry = this.now() + REOPEN_MS
    try {
      this.db = new Database(this.file, { readonly: true, fileMustExist: true })
      // THE SENSOR MEASURES THE BOOK, NOT THE SCORED SET. gatewatch scores every launch
      // the screen passes, on purpose: the untaxed and thin-exempt coins the bot declines
      // are the control group that proves each filter still works. That set is 80% coins
      // the bot never buys (1,809 of 2,242 scored on 2026-09-06), and it moves on its own:
      // at 23:46 that day the 40 newest scored coins summed -3.63 and paused the bot while
      // the 6 buyable ones among them summed +0.40 and the 40 newest BUYABLE coins +13.20.
      // The pause was caused entirely by coins the bot would never have held. The tapes
      // every threshold was fitted on carried the book, so the join below is what makes
      // the live number the fitted one. bot.db is attached read-only for the join; an
      // attach that fails leaves the sensor with no opinion (barsAt null) and says so once,
      // rather than quietly reading the wrong set again.
      let book = false
      if (this.bookFile) {
        try {
          this.db.prepare('ATTACH DATABASE ? AS book').run(this.bookFile)
          book = true
        } catch (e) {
          if (!this.bookWarned) {
            this.bookWarned = true
            console.error(`gate: cannot attach ${this.bookFile} (${String(e).slice(0, 80)}); the venue sensor has no opinion`)
          }
        }
      }
      this.stmts = {
        // one query serves read() and hydrate(); read() just ignores the token column
        obs: this.db.prepare(
          `SELECT token, launched_at, touch FROM obs WHERE error IS NULL ORDER BY block DESC LIMIT ?`,
        ),
        // the adaptive take profit's window: only rows scored under the per-bar schema.
        // `bars` is NULL on every row older than 2026-09-05, and the column may not exist
        // at all on a gate.db the watcher has not migrated yet. Prepared on its own, so a
        // missing column costs the adaptive bar (readBars -> null, the fallback rung) and
        // NOT the gate: before 2026-09-06 this throw fell into the catch below and nulled
        // every statement, which silently switched the regime gate off.
        bars: ((): Database.Statement | null => {
          try {
            return this.db!.prepare(`SELECT bars FROM obs WHERE error IS NULL AND bars IS NOT NULL ORDER BY block DESC LIMIT ?`)
          } catch {
            return null
          }
        })(),
        // The P&L sensor's rows: the newest scored launches THE BOOK WOULD BUY, with the
        // two clocks the sensor needs. Parameters: tax floor (bps), exempt floor, limit;
        // the floors are the caller's (strategy/entry.ts's numbers), so a book change moves
        // the sensor with it and gate.ts never carries a copy of a trading rule.
        //
        // `launched_at > 0` is not decoration. It is the block timestamp in SECONDS and it
        // is nullable (bot.ts writes `?? null` on one path and 0 on another, and gatewatch
        // copies whatever launches holds), so a single zero row in the window reads as a
        // launch from 1970 and freezes the freshness test forever. Dropped at the source.
        // `creator_tax_bps` is NULL on a pre-screen reject and -1 on a read failure; both
        // fail the floor. `exemptions` is NULL when the launch carried no metadata, and
        // the bot declines those too (entry.ts reads it as 0), hence the COALESCE.
        barsAt: ((): Database.Statement | null => {
          if (!book) return null
          try {
            return this.db!.prepare(
              `SELECT o.bars, o.launched_at, o.at, o.token, o.peak FROM obs o
               JOIN book.launches l ON l.token = o.token
               WHERE o.error IS NULL AND o.bars IS NOT NULL AND o.launched_at > 0
                 AND l.creator_tax_bps >= ? AND l.creator_tax_bps <= ? AND COALESCE(l.exemptions, 0) >= ?
               ORDER BY o.block DESC LIMIT ?`,
            )
          } catch {
            return null
          }
        })(),
        // Per-token, so a closed trade can be compared with what the same coin replayed
        // at. The IN list is variable, so this is prepared per call rather than once;
        // it runs on the 30s housekeeping tick only, never from the exit pump.
        barsFor: ((): ((tokens: string[]) => Database.Statement) | null => {
          try {
            // prove the column exists once, here, rather than on every call
            this.db!.prepare(`SELECT token, bars FROM obs WHERE token = ?`)
            return (tokens: string[]) => this.db!.prepare(
              `SELECT token, bars FROM obs WHERE error IS NULL AND bars IS NOT NULL
               AND token IN (${tokens.map(() => '?').join(',')})`,
            )
          } catch {
            return null
          }
        })(),
        ranAt: this.db.prepare(`SELECT value FROM state WHERE key='ran_at'`),
        gate: this.db.prepare(`SELECT value FROM state WHERE key='gate'`),
        templateBlock: this.db.prepare(`SELECT value FROM state WHERE key='template_block'`),
      }
    } catch {
      this.db = null // the watcher has not run yet; stay silent rather than fail loudly
      this.stmts = null
    }
    return this.db
  }

  /**
   * Null means "no opinion": no database, no rows, or a read that threw. Callers must
   * treat that as "keep trading", because a watcher that is merely absent is not
   * evidence that the venue is bad.
   *
   * A watcher that used to be here and went quiet is different, and returns 'shut'.
   */
  read(window: number, openAt: number, shutAt: number): GateReading | null {
    // open() sets db and stmts together, so this pair can only disagree if something has
    // gone very wrong. Check rather than assert: null here means "no opinion", which is
    // the same answer a missing database already gives.
    const db = this.open()
    const st = this.stmts
    if (!db || !st) return null
    try {
      const rows = st.obs.all(window) as Array<{ touch: number; launched_at: number | null }>
      // no observations at all: the watcher is installed but has never scored anything,
      // which is a fresh deployment, not a bad venue
      if (!rows.length) return null
      // The file is the fallback and the seed; the live ring is preferred whenever it can
      // fill the whole window. A partial ring is NOT blended in: a rate over 3 launches and
      // a rate over 20 are different questions, and mixing them silently changes what the
      // thresholds mean.
      let rate = (100 * rows.reduce((a, r) => a + r.touch, 0)) / rows.length
      // obs.launched_at is the block timestamp, in SECONDS (obs.at is the ms one)
      const newest = rows.reduce((a, r) => (r.launched_at && r.launched_at > a ? r.launched_at : a), 0)
      let dataAgeMs = newest > 0 ? this.now() - newest * 1000 : null
      let n = rows.length
      let source: 'live' | 'file' = 'file'
      let liveN = 0
      try {
        // read the ring whatever the flag says: with GATE_LIVE off the scorer still runs
        // and still has to be observable, which is the entire point of shipping it dark
        const live = this.cohort?.reading(window, this.now()) ?? null
        liveN = live?.liveN ?? 0
        if (this.useLive && live && live.n >= window) {
          rate = live.rate
          n = live.n
          dataAgeMs = live.dataAgeMs
          source = 'live'
        }
      } catch {
        // a broken live path must degrade to the file, never to 'open'
      }

      // it HAS scored launches before, so a missing or old heartbeat means it stopped
      const ran = st.ranAt.get() as { value: string } | undefined
      const age = ran ? this.now() - Number(ran.value) : Infinity
      if (!(age < STALE_MS)) {
        const how = ran ? `${Math.round(age / 60_000)} min since last run` : 'never heartbeated'
        // Deliberately still fatal even when the live ring is healthy. A dead watcher is
        // not evidence the venue is good, and it also means nothing is repairing the
        // launches our feed dropped. Costing upside stays the failure mode we choose.
        this.state = 'shut'
        return { state: 'shut', rate, n, dataAgeMs, source, liveN, stale: `gatewatch is not running (${how})` }
      }

      // Seed the band ONCE from the watcher's last verdict so a restart resumes on the
      // same side it left on. A missing verdict means a watcher older than this contract,
      // and we cannot know which side it was on, so assume the shut side: inside the
      // 10-25 band the two answers disagree and the permissive one keeps us buying on a
      // rate that was never good enough to open the gate.
      if (!this.seeded) {
        const stored = st.gate.get() as { value: string } | undefined
        this.state = stored ? (stored.value === 'shut' ? 'shut' : 'open') : 'shut'
        this.seeded = true
      }
      // The same rule gatewatch.py applies, applied here so it lands in milliseconds
      // rather than on the next five-minute tick.
      this.state = stepGate(this.state, rate, openAt, shutAt)
      return { state: this.state, rate, n, dataAgeMs, source, liveN }
    } catch {
      return null
    }
  }

  /**
   * The trailing per-bar outcomes for the adaptive take profit, newest first. Null means
   * no opinion (no database, no migrated rows, a read that threw); a short list is
   * returned as-is and the caller decides whether it is enough. Rows that fail to parse
   * are dropped rather than failing the read: one bad row must not cost the bar.
   */
  readBars(window: number): Array<Readonly<Record<string, number>>> | null {
    const db = this.open()
    const st = this.stmts
    if (!db || !st || !st.bars) return null
    try {
      const rows = st.bars.all(window) as Array<{ bars: string }>
      const out: Array<Readonly<Record<string, number>>> = []
      for (const r of rows) {
        try {
          const o = JSON.parse(r.bars) as Record<string, unknown>
          const clean: Record<string, number> = {}
          for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && Number.isFinite(v)) clean[k] = v
          out.push(clean)
        } catch {}
      }
      return out
    } catch {
      return null
    }
  }

  /**
   * THE VENUE PAUSE. What the bot's exit rule would have made on the launches it was not
   * holding, over the trailing window, with hysteresis. See trailingOutcome above for the
   * measurement and why the freshness rule carries its safety.
   *
   * Null means no opinion (no database, no migrated rows, nothing parseable), exactly as
   * read() does. An UNFRESH window also means no opinion, but it is reported as a reading
   * with state 'open' and fresh:false rather than as null, because the caller needs the
   * numbers for the page either way -- and, importantly, the internal state is left
   * untouched, so a pause survives a dry spell and resumes deciding when the data returns.
   *
   * Deliberately does NOT re-test the heartbeat. A dead watcher already reads shut through
   * the touch gate, which halts on its own kind; repeating the test here would place a
   * second halt for one cause and make the page name whichever kind sorted first.
   */
  readVenue(opts: { window: number; off: number; on: number; freshMs: number; bar: string; book: BookFloors; requireRecovery?: boolean }): VenueReading | null {
    // An operator resume must earn the recovery threshold at the time it can clear.
    // A previous open reading, including one blocked by another halt, cannot grant it.
    if (opts.requireRecovery) {
      this.venueState = 'shut'
      this.venueSeeded = true
    }
    const db = this.open()
    const st = this.stmts
    if (!db || !st || !st.barsAt) return null
    try {
      // Over-fetch: a row whose replay dropped this bar is skipped, and without the
      // slack the window would silently shrink and read as unfresh instead.
      const rows = st.barsAt.all(opts.book.minTaxBps, opts.book.maxTaxBps, opts.book.minExempt, opts.window * 2) as OutcomeRow[]
      const t = trailingOutcome(rows, { window: opts.window, freshMs: opts.freshMs, key: opts.bar, now: this.now() })
      if (!t) return null
      if (!t.fresh) {
        return { state: 'open', sum: t.sum, n: t.n, fresh: false, oldestAgeMs: t.oldestAgeMs, bar: opts.bar, outcomes: t.values }
      }
      if (!this.venueSeeded) {
        // seed from the first fresh window: below the floor is a pause, anything else trades
        this.venueState = t.sum < opts.off ? 'shut' : 'open'
        this.venueSeeded = true
      }
      this.venueState = stepVenue(this.venueState, t.sum, opts.off, opts.on)
      return { state: this.venueState, sum: t.sum, n: t.n, fresh: true, oldestAgeMs: t.oldestAgeMs, bar: opts.bar, outcomes: t.values }
    } catch {
      return null
    }
  }

  /**
   * The drawdown stop's resume evidence: the newest `window` launches SCORED AFTER a given
   * moment, summed at `bar`. Null until that many exist.
   *
   * Two differences from readVenue, both deliberate. It filters on `obs.at` (when gatewatch
   * scored the row, ms) rather than launched_at, because the question is "what has the
   * venue done since the stop fired" and a launch scored after the halt is evidence that
   * arrived after it. And it has no freshness rule: waiting for a full post-halt window IS
   * the wait, and adding a second clock would let a thin night lift the stop on 20 launches
   * spread over six hours -- which is fine, that is still 20 independent outcomes.
   */
  readResume(window: number, bar: string, scoredAfterMs: number, book: BookFloors): { sum: number; n: number } | null {
    const reading = this.readResumeProgress(window, bar, scoredAfterMs, book)
    return reading && reading.n > 0 && reading.n >= window ? reading : null
  }

  /** Same evidence as readResume, including an incomplete window for the operator. */
  readResumeProgress(window: number, bar: string, scoredAfterMs: number, book: BookFloors): { sum: number; n: number; values: OutcomeValue[] } | null {
    const db = this.open()
    const st = this.stmts
    if (!db || !st || !st.barsAt) return null
    try {
      const rows = (st.barsAt.all(book.minTaxBps, book.maxTaxBps, book.minExempt, window * 4) as OutcomeRow[]).filter((r) => r.at > scoredAfterMs)
      const t = trailingOutcome(rows, { window, freshMs: Infinity, key: bar, now: this.now() })
      if (!t) return { sum: 0, n: 0, values: [] }
      return { sum: t.sum, n: t.n, values: t.values }
    } catch {
      return null
    }
  }

  /**
   * Per-token replay outcomes, for comparing what a trade MADE with what the same coin was
   * worth. Tokens are lower-cased on both sides: bot.db writes them as they came off the
   * log and gate.db copies that, so a case mismatch would silently return an empty map and
   * read as "no evidence" rather than as a bug.
   */
  barsFor(tokens: string[]): Map<string, Record<string, number>> | null {
    const db = this.open()
    const st = this.stmts
    const out = new Map<string, Record<string, number>>()
    if (!db || !st || !st.barsFor || !tokens.length) return null
    try {
      const rows = st.barsFor(tokens).all(...tokens.map((t) => t.toLowerCase())) as Array<{ token: string; bars: string }>
      for (const r of rows) {
        try {
          const o = JSON.parse(r.bars) as Record<string, unknown>
          const clean: Record<string, number> = {}
          for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && Number.isFinite(v)) clean[k] = v
          out.set(r.token.toLowerCase(), clean)
        } catch {}
      }
      return out
    } catch {
      return null
    }
  }

  /**
   * The template gate's blocklist, as gatewatch last published it: exact dev-buy wei
   * values (decimal strings) whose recent scored launches did not pay. See
   * STRATEGY.book.templateGate for the rule and the measurement.
   *
   * Null means "no opinion" for the same reasons as read(): no database, no row yet, or
   * an unparseable one. The caller falls back to the seed alone -- a watcher that has not
   * published a blocklist is not evidence that any value is safe, but it is also not
   * evidence any is poison, and the seed carries the ones we already know. Deliberately
   * NOT invalidated by a stale heartbeat: the list is trailing-24h outcome data, still
   * true when five minutes old, and the stale-watcher case already shuts the main gate.
   */
  templateBlock(): { values: string[]; at: number } | null {
    const db = this.open()
    const st = this.stmts
    if (!db || !st) return null
    try {
      const row = st.templateBlock.get() as { value: string } | undefined
      if (!row) return null
      const parsed = JSON.parse(row.value) as { values?: unknown; at?: unknown }
      if (!Array.isArray(parsed.values)) return null
      return {
        values: parsed.values.filter((v): v is string => typeof v === 'string'),
        at: typeof parsed.at === 'number' ? parsed.at : 0,
      }
    } catch {
      return null
    }
  }

  /**
   * Seed the live ring from the watcher's record so a restart is not blind for its first
   * `window` launches. Without this a bot that restarts inside a bad patch would fall back
   * to the file anyway -- correct, but slow again exactly when speed matters.
   */
  hydrate(cohort: Cohort, window: number): number {
    const db = this.open()
    const st = this.stmts
    if (!db || !st) return 0
    try {
      const rows = st.obs.all(window) as Array<{
        token: string; launched_at: number | null; touch: number
      }>
      // what the cohort took, not what the file offered: rows with a null launched_at and
      // tokens we already hold are skipped, and reporting rows.length would overstate the
      // ring on exactly the startups where it matters
      return cohort.hydrate(rows)
    } catch {
      return 0
    }
  }

  close(): void {
    try { this.db?.close() } catch {}
    this.stmts = null
    this.db = null
    this.nextTry = 0
  }
}

export type GateAction =
  | { do: 'halt'; why: string }
  | { do: 'resume'; why: string }
  | { do: 'nothing' }

/**
 * The whole two-way decision, as a pure function, because it runs unattended overnight
 * against real money and the interesting cases (a flapping venue, a resume arriving on
 * top of a drawdown stop) are the ones you cannot reproduce by hand on a live box.
 *
 * Resume is immediate on the first open reading. There used to be a ten-minute timer
 * here (openSince/resumeAfterMs, threaded through the caller), pinned to 0 on 2026-08-19
 * when cohort scoring moved in-process and then deleted: at a five-minute scoring tick the
 * wait was the only way to make "ten minutes of open readings" mean two INDEPENDENT
 * samples, and with continuous scoring the hysteresis band supplies that separation by
 * itself -- reopening demands openAt (25) while merely staying open needs only shutAt (10).
 */
export function gateAction(args: {
  reading: GateReading | null
  /**
   * Whether the GATE's own halt is placed. Deliberately not "is the bot halted".
   *
   * This used to be the global boolean plus the kind, and the shut branch below returned
   * 'nothing' whenever ANY halt was up. With a daily cap in the tree that is a hole: the
   * cap halts at 14:00, the venue shuts at 18:00 and nothing anywhere records it, and at
   * 00:00 UTC the cap lifts into a venue that has been shut for six hours.
   *
   * The gate now reasons only about its own halt, so a shut reading is always recorded.
   * Whether lifting it actually resumes the bot is RiskManager.resume's business, and that
   * is the one place that can see every halt at once. The safety argument below is
   * unchanged, it just lives on the other side of the call.
   */
  gateHalted: boolean
}): GateAction {
  const { reading: g, gateHalted } = args
  // No watcher, no opinion, so the halt state is left alone: a gate that is merely
  // absent is not evidence of anything.
  if (!g) return { do: 'nothing' }

  if (g.state === 'shut') {
    if (gateHalted) return { do: 'nothing' }
    const why = g.stale
      ? `regime gate unreadable: ${g.stale}`
      : `regime gate shut (cohort touch ${g.rate.toFixed(1)}% over ${g.n} launches)`
    return { do: 'halt', why }
  }

  // open. Only a halt this gate placed may be lifted by it; a drawdown stop, a daily cap
  // or HALT=1 stays exactly where it is no matter what the venue does -- RiskManager.resume
  // refuses when anything stickier is holding. A stale reading can never reach here because
  // staleness always reads as shut.
  if (!gateHalted) return { do: 'nothing' }
  return {
    do: 'resume',
    why: `regime gate reopened (cohort touch ${g.rate.toFixed(1)}% over ${g.n} launches)`,
  }
}

/**
 * The same two-way decision for the P&L sensor, and a separate function rather than a
 * parameter on gateAction: the two sensors halt under different kinds, and one function
 * returning an action for "whichever gate you meant" is how a resume ends up lifting the
 * halt the other one placed.
 *
 * A reading that is not fresh carries state 'open', so a dry spell lifts a pause. That is
 * the rule the backtest ran and it is the honest one: with fewer than 40 launches inside
 * six hours there is no measurement, and refusing to trade on the absence of evidence
 * would have stopped the bot every night of August.
 */
export function venueAction(args: {
  venue: VenueReading | null
  /** whether the VENUE's own halt is placed; see gateAction's note on why not the global */
  venueHalted: boolean
}): GateAction {
  const { venue: v, venueHalted } = args
  if (!v) return { do: 'nothing' }
  const how = v.source === 'conservative-paper'
    ? `${v.n}/${v.window} complete scenario outcomes; main ${v.sumRange?.map(x=>x.toFixed(2)).join(' to ')??'unavailable'}, fresh ${v.recentSumRange?.map(x=>x.toFixed(2)).join(' to ')??'unavailable'}; ${v.observerError??v.reason}`
    : v.source === 'adaptive-shadow'
    ? `${v.sum.toFixed(2)} stakes over ${v.n}/20 adaptive shadow outcomes; latest 8 ${v.recentSum?.toFixed(2)}${v.observerError ? `; ${v.observerError}` : ''}`
    : `${v.sum >= 0 ? '+' : ''}${v.sum.toFixed(2)} stakes over ${v.n} scored launches at ${v.bar}x`
  if (v.state === 'shut') {
    if (venueHalted) return { do: 'nothing' }
    return { do: 'halt', why: `venue not paying (${how})` }
  }
  if (!venueHalted) return { do: 'nothing' }
  return {
    do: 'resume',
    why: v.fresh
      ? `venue paying again (${how})`
      : `venue sensor has no window (${v.n} of the launches it needs inside the freshness limit)`,
  }
}
