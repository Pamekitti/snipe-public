/**
 * The second fold: what happened over time, kept for the page and nowhere near a decision.
 *
 * WHY HISTORY IS NOT IN `core/State`. The state is what a decision needs. Chart buffers and a
 * closed-trade list are what a person needs, and putting them in the state would put display
 * requirements inside the kernel identity: adding a column to a table would change the hash
 * that says which code made a trade. So this is a separate fold over the same events, and it
 * lives in `projections/` where the ring test can keep it away from `core/decide`.
 *
 * IT RECORDS TRANSITIONS, IT DOES NOT RE-DERIVE THEM. Every number below is read off the state
 * the core produced, or counted from the intents and refusals the core emitted. There is no
 * rule here: no threshold, no exit reason recomputed, no entry screen in a second dialect.
 * That is the whole defect this replaces, where the old dashboard re-ran the regime gate on
 * every poll, re-ran the take-profit argmax, and coloured a position red at a supply the bot
 * does not act on.
 *
 * WHY IT SCANS RATHER THAN DIFFS. `decide` shallow-copies the state and mutates the Maps in
 * place, so `before.positions` and `after.positions` are the same object and a diff sees
 * nothing. Instead this keeps watermarks and scans only what can have changed, on only the
 * event kinds that can change it: positions close from a fill log, a receipt, a clock or
 * feed-block graduation step, or a leftover-bag wallet read; observations open in
 * `onCurveParams`, reached only from `chain-read`; outcomes settle in `observe`, reached
 * from `feed-block` and `clock`.
 *
 * FOUR DEFECTS ARE CARRIED FORWARD DELIBERATELY, each one found the hard way:
 *
 *   1. The scans run BEFORE refusals are stamped. A launch routes to a book and is refused by
 *      that book's filter inside the SAME event, so stamping first left `bookOf` empty for
 *      that token and the per-book funnel showed almost nothing while the wallet-wide one
 *      showed 134.
 *   2. Observations are keyed on `o.token`, not on the map key. `state.observations` is keyed
 *      by CURVE address because a chain log carries the curve; refusal subjects are TOKENS.
 *      Using the map key put every refusal in the unattributed pile.
 *   3. Wei ratios divide on the bigint before reaching float64. The old bot did this division
 *      in float at `bot.ts:941` and lost precision near 1e27.
 *   4. Bucket eviction walks a tracked minimum. `Map` preserves insertion order, not key
 *      order, and a late event can create a bucket behind the newest one, so `Math.min(...keys)`
 *      is both wrong and a stack overflow waiting for the day the ring is full.
 *
 * A DEAD BAG IS RESTATED, NOT LEFT WHERE THE FOLD FIRST PAINTED IT. The core only learns a
 * leftover bag is empty when a `position-wallet` read lands. Until 2026-09-18 those reads
 * happened at boot, so a bag that died overnight kept `tokensHeld > 0` for thirteen hours of
 * tape. Total added its spend on every minute of that stretch; Virtual booked the loss at
 * discovery. Both charts then drew a plateau and a cliff that were not a send. When this fold
 * sees the abandonment it walks back the minutes that had counted that spend and books the
 * loss at the last time tokens were confirmed (the fill, unless a later read said they were
 * still there). That is restating a number we already wrote, which is the one exception to
 * "it records transitions": the transition arrived late, and leaving the old minutes up is
 * how the page kept inventing 0.03 ETH.
 */
import { BoundedMap, BoundedSet } from '../core/contracts.js'
import { LEVELS } from './levels.js'
import type { Event } from '../core/events.js'
import type { Refusal, RefusalBucket } from '../core/contracts.js'
import type { Intent } from '../core/intents.js'
import type { State } from '../core/state.js'

/**
 * The bounds, declared in one place because every writer in this repo has to declare one.
 *
 * One minute is the finest granularity anything is drawn at, and 10,080 of them is seven
 * days, which is the longest window the page offers. Longer windows are aggregated up at
 * render time rather than stored a second time: two resolutions would be two things to keep
 * in agreement. At roughly 300 bytes a bucket with two books this is about 3 MB.
 */
export const BUCKET_MS = 60_000
export const BUCKETS_KEPT = 10_080

/**
 * How many tokens this remembers having seen, which bounds every per-token index below.
 *
 * 20,000 is months at a few hundred launches a day. It has to be bounded at all because this
 * process runs for weeks: the old bot shipped an unbounded map keyed by token and it leaked
 * slowly enough that nobody noticed until it mattered.
 */
export const TOKENS_REMEMBERED = 20_000

/**
 * How many entry samples each book keeps for its histograms.
 *
 * These are distributions over a window, not a time series, so they are kept as samples with
 * a timestamp and filtered at render rather than bucketed by minute. 2,000 per book is well
 * past the seven-day window at this venue's rate.
 */
export const SAMPLES_KEPT = 2_000

/** The template key is `tax:devBuyWei:exemptions`. Three, because it is a triple. */
const TEMPLATE_PARTS = 3

/** One book's activity inside one minute. Counts only; every rate is computed at render. */
export type BookBucket = {
  /** launches this book passed `admits` on, i.e. the watch, not every tax-routed coin */
  launches: number
  /**
   * Buy intents this book raised, whether or not any of them was sent or filled.
   *
   * Separate from `entered` because they answer different questions and the gap between them
   * IS the send path's health. On a run with no sender they are `decided > 0, entered 0`,
   * which is the truth; collapsing them into one number would make a monitor that decides
   * correctly look identical to one that never decides at all.
   */
  decided: number
  entered: number
  closed: number
  wins: number
  pnlWei: bigint
  /**
   * Stake put on the closes in this minute. The rolling table's return on turnover is
   * `pnl / spend`, the same ratio v1 used, and it has to come from the buckets because the
   * trade list is capped at 40.
   */
  spendWei: bigint
  /** closes whose recorded sell reason was take-profit. Numerator of the pop-rate row. */
  tpClosed: number
  /**
   * Buys the send path refused or the chain rejected, counted here so the execution pane has
   * a numerator over the same minute as `decided`.
   */
  sendFailed: number
  /**
   * Settled replays and what they were worth, in stakes, at the indicator's bar.
   *
   * These two ARE the venue sensor's numerator and denominator: `stakes / scored` is the
   * average launch and `stakes` over a full window is the number that pauses the book. A row
   * whose replay dropped that bar counts in neither, because it is missing data and a zero
   * would pull the sum toward the middle.
   *
   * COUNTED AT SETTLE TIME. The market pane reconstructs a trailing window of scored launches
   * in the order they became evidence. That is a different clock from the coins stack.
   */
  scored: number
  stakes: number
  /**
   * The coins stack, counted at LAUNCH time. A coin's result sits in the minute it was
   * observed, not the minute the replay finished, so a 52-second settle cannot slide it one
   * bar to the right.
   *
   * `simWin` / `simLoss` / `simFlat` are the sign of `Outcome.stakes`. `simPending` is still
   * being watched. `simDropped` is a replay that produced no number (no path, or the
   * indicator bar missing). `simNet` / `simN` are the return strip: the sum and the count of
   * rows that had a number, so a bar with only pending does not draw as zero.
   */
  simWin: number
  simLoss: number
  simFlat: number
  simPending: number
  simDropped: number
  simNet: number
  simN: number
}

export type Bucket = {
  readonly at: number
  readonly books: Map<string, BookBucket>
  /**
   * Cumulative wallet realized at the end of this minute, so the line is a level not a delta.
   *
   * NULL MEANS NO EVENT LANDED IN THIS MINUTE, and it is not the same as zero. `window()` fills
   * the gaps between real buckets so the series is evenly spaced, and a filled gap carries null
   * here: the wallet did not become empty during a quiet minute, it simply was not restated. The
   * first version filled with `0n` and the live page drew the balance diving to zero and back
   * every time the bot went quiet for a minute.
   */
  walletRealizedWei: bigint | null
  /**
   * Chain wallet, only on a successful balance read. Null on any other minute.
   *
   * Open cost is a different clock: spend of positions that were already open at that last
   * read, restated on every event. A buy after the last read is excluded because its ETH is
   * still inside the last wallet figure; a close drops out immediately, so the line does not
   * keep adding vanished inventory until the next hourly read. Sampling the two together and
   * then carrying the SUM forward is how the live 12h pane read 0.28 ETH while the wallet
   * card read 0.26, with nothing open.
   */
  walletWei: bigint | null
  openCostWei: bigint | null
  /** cumulative per book, same reason. Keyed by book id. */
  readonly bookRealizedWei: Map<string, bigint>
  /**
   * Halts in force at the end of this minute, or null on a filled gap.
   *
   * NULL IS NOT EMPTY. `window()` inserts empty minutes so the series is evenly spaced, and a
   * filled gap must not look like "the halt lifted": the band walker carries the last real
   * stamps across it. A real minute with nothing in force is `[]`, which is what lifts the
   * shade. `halted` is `haltStamps.length > 0` on a real minute, false on a gap.
   */
  haltStamps: HaltStamp[] | null
  /** true when any halt was in force at the end of the minute */
  halted: boolean
  /**
   * Every launch this minute, every book and every screen reject. The coins pane's
   * "filtered out" is this minus the selected book's `launches`.
   */
  seen: number
}

/**
 * One finished trade, as the core closed it.
 *
 * `reason` is captured from the sell INTENT rather than recomputed at close, because by the
 * time the fill lands the inflight record carrying it has been deleted. Recomputing it would
 * mean running the exit rules a second time against a state that has already moved, which is
 * how a display starts disagreeing with the bot about why it sold.
 */
export type ClosedTrade = {
  readonly at: number
  readonly token: string
  readonly book: string
  readonly reason: string
  readonly holdMs: number
  readonly spendWei: bigint
  readonly proceedsWei: bigint
  readonly pnlWei: bigint
  readonly takeProfitMultiple: number
  /** proceeds over stake. Null when the stake was zero, which cannot happen but is not asserted. */
  readonly exitMultiple: number | null
  /** the best mark this position ever showed, over its entry mark */
  readonly peakMultiple: number | null
  /**
   * The independent observer's peak (`Outcome.peak`), the best mark any holder could have had
   * in the book's hold window. Null until the cohort scores, and stays null if the replay
   * dropped the path. Patched in place: a fast take-profit closes before settle (52s), and
   * the exits list would otherwise keep a dash forever.
   */
  observerPeak: number | null
  readonly curve: string
  /** launch log folded to position opened. Null when the launch predates this process. */
  readonly detectToEntryMs: number | null
  /** from the template key, which IS the (tax, dev buy, exemptions) tuple. Null if it will not parse. */
  readonly creatorTaxBps: number | null
  readonly devBuyWei: bigint | null
  readonly exemptions: number | null
}

/**
 * What one entry cost us to reach, sampled when the position opened.
 *
 * These feed the market and execution panes, which ask about the launches we TOOK: what tax
 * they carried, how many exempt wallets they had, and how long it took us to get from seeing
 * the launch to signing for it. Every field is measured off state the core already wrote; no
 * timing here is taken from a wall clock.
 */
export type EntrySample = {
  readonly at: number
  readonly book: string
  readonly creatorTaxBps: number | null
  readonly exemptions: number | null
  /** launch log folded to position opened. Null when the launch predates this process. */
  readonly detectToEntryMs: number | null
  /** launch log folded to the buy being signed. Null when no signature was ever recorded. */
  readonly detectToSendMs: number | null
}

/**
 * How many recent latencies to keep per read kind, for the percentiles.
 *
 * Bounded because this is a diagnostic that runs inside the trading process, and an unbounded
 * array of every read a week-old process ever made is a leak with a chart on it.
 */
export const READ_LATENCIES_KEPT = 500

/**
 * What the chain reads are costing, per kind of read.
 *
 * IT IS A METER AND NEVER A GATE, deliberately. v1 had one that gated: `ReadBudget` moved reads off
 * the keyed provider when its projected monthly pace passed a cap. That was removed on 2026-09-06
 * because the projection read 99% of pace with 1% of the month spent, and would have moved the
 * reads to a public RPC that was refusing 1,100 polls an hour, in the busiest hour of the week, on
 * a prediction. Being early is what pays; a provider that actually refuses is already handled by
 * the fallback and the retry. So this counts and says nothing about what to do.
 *
 * COUNTS ARE SINCE THIS PROCESS BOOTED; the percentiles are over the last `READ_LATENCIES_KEPT`
 * reads of that kind. Two different windows, because a total is only useful cumulative and a
 * latency is only useful recent.
 *
 * WHAT IT CANNOT SEE, stated so a zero is not misread: receipt reads. Those arrive as `receipt`
 * events, whose shape carries no `tries` or `latencyMs`, so they are absent here rather than
 * counted as free. Log traffic is likewise invisible: it comes over the subscriber, not as a read.
 * That is also why this is not v1's compute-unit projection — a true CU figure is not derivable
 * from the tape, and v1's own notes call that number unreliable.
 */
export type ReadHealthRow = {
  readonly kind: string
  readonly reads: number
  /** reads that came back with no result. Each one is a launch dropped or a question unanswered. */
  readonly failed: number
  /** reads that needed more than one attempt. Only the curve read retries at all. */
  readonly retried: number
  /** reads the keyed endpoint served. The rest fell through to the public spare. */
  readonly viaKey: number
  readonly p50Ms: number | null
  readonly p95Ms: number | null
  readonly maxMs: number | null
}

export type RefusalStamp = { readonly at: number; readonly bucket: RefusalBucket; readonly book: string | null }

/** One halt as it stood at the end of a minute, for the virtual-wallet shade. */
export type HaltStamp = { readonly kind: string; readonly book: string | null }

/** A close, kept for the virtual-wallet dots. Thinner than `ClosedTrade`, and not capped at 40. */
export type ChartClose = {
  readonly at: number
  readonly token: string
  readonly book: string
  readonly reason: string
  readonly pnlWei: bigint
}

export class History {
  private readonly buckets = new Map<number, Bucket>()
  private readonly closed: ClosedTrade[] = []
  private readonly samples: EntrySample[] = []
  private readonly recordedOpens = new BoundedSet<string>(TOKENS_REMEMBERED)
  private readonly recordedCloses = new BoundedSet<string>(TOKENS_REMEMBERED)
  private readonly recordedSends = new BoundedSet<string>(TOKENS_REMEMBERED)
  private readonly seenObservations = new BoundedSet<string>(TOKENS_REMEMBERED)
  /** screen rejects, so a launch that never routed still counts in `seen` once */
  private readonly seenRejected = new BoundedSet<string>(TOKENS_REMEMBERED)
  private readonly sellReason = new BoundedMap<string, string>(TOKENS_REMEMBERED)
  /** token to the book it routed to, so a refusal naming a token can be attributed to a book */
  private readonly bookOf = new BoundedMap<string, string>(TOKENS_REMEMBERED)
  /** token to when its launch log was folded, which is the zero for every entry timing below */
  private readonly detectedAt = new BoundedMap<string, number>(TOKENS_REMEMBERED)
  /**
   * Observations opened and not yet classified. A replay that cannot enter never writes a
   * cohort row, so without this a dropped launch would sit in `simPending` forever.
   */
  private readonly watching = new BoundedMap<string, { book: string; at: number }>(TOKENS_REMEMBERED)
  /** token to when its buy was signed, filled from `state.inflight` before the record is deleted */
  private readonly signedAt = new BoundedMap<string, number>(TOKENS_REMEMBERED)
  /**
   * Independent peak by token, copied off the cohort when it scores.
   *
   * A second copy, besides the field on `ClosedTrade`, because settle and close are different
   * events: the peak can arrive first, and the close has to find it. Looking it up on
   * `state.cohort` at render time is how a 40-row table would go blank when the ring rolled.
   */
  private readonly observerPeakByToken = new BoundedMap<string, number>(TOKENS_REMEMBERED)
  /**
   * Refusals, indexed by the minute they happened in.
   *
   * A FLAT ARRAY WAS THE WRONG SHAPE FOR THE ONE THING THAT READS IT. `refusalsIn` is called on
   * every SSE push, on every connection, inside the trading process, and it filtered seven days
   * of refusals to draw a one-hour funnel. The busiest bucket here fires once per launch per
   * book, so the array grows far faster than anything else in this file and the scan got slower
   * every day the process stayed up. Indexed by minute, a push costs the window and not the
   * week.
   */
  /** What each kind of chain read has cost. See `ReadHealthRow`: a meter, never a gate. */
  private readonly reads = new Map<string, { reads: number; failed: number; retried: number; viaKey: number; latencies: number[] }>()
  private readonly refusals = new Map<number, RefusalStamp[]>()
  private oldestRefusalMinute = Number.MAX_SAFE_INTEGER
  private scoredThrough = 0
  /** which settled replays have already been counted, so a timestamp tie counts each once */
  private readonly scoredTokens = new BoundedSet<string>(TOKENS_REMEMBERED)
  private oldestBucket = Number.MAX_SAFE_INTEGER
  /** the `at` of the first event ever folded. Everything before it is outside coverage. */
  private firstAt: number | null = null
  private lastAt = 0
  /**
   * When the last successful balance read landed. Open cost only counts positions that were
   * already open then: anything newer still has its ETH inside that reading.
   */
  private lastWalletAt: number | null = null
  /**
   * Every close since this process started, counted rather than stored.
   *
   * `closed` above is capped at `LEVELS.exitsKept` (40) because it holds whole trades for a
   * table. The wallet card's "since zero" counted that list, so on trade 41 the card stopped
   * moving and an operator reading it saw a bot that had closed 40 trades forever. Two ints
   * cost nothing and are the honest denominator.
   */
  private readonly lifetime = { closed: 0, wins: 0 }
  /** closes for the virtual-pane dots. The exits table stays capped at `LEVELS.exitsKept`. */
  private readonly chartCloses: ChartClose[] = []
  /**
   * Scored stakes and close P&L that left the ring. Paper and virtual start at 0 plus
   * these, so an evicted minute cannot rebase either line to a fresh account.
   */
  private readonly paperPrefix = new Map<string, number>()
  private readonly virtualPrefix = new Map<string, bigint>()
  /**
   * Last time a bag was confirmed to hold tokens, so an abandonment can be booked there
   * instead of at the later discovery read.
   */
  private readonly bagConfirmAt = new BoundedMap<string, number>(TOKENS_REMEMBERED)
  /**
   * Which bags were inside each minute's open-cost sum. Needed so a late abandonment can
   * subtract exactly the spend that minute had added, and not a minute that had already
   * dropped the bag (empty, unfilled, or opened after the last wallet read).
   */
  private readonly costMembers = new Map<number, Map<string, bigint>>()

  get coverage(): { readonly from: number | null; readonly to: number } {
    return { from: this.firstAt, to: this.lastAt }
  }

  /**
   * Oldest minute still on the ring. The equity walk starts here and adds `equityPrefix`;
   * everything before this is already in the prefix, so materialising empty days back to
   * `firstAt` would only spend memory to add zero.
   */
  get keptFrom(): number | null {
    if (this.oldestBucket === Number.MAX_SAFE_INTEGER) return this.firstAt
    let i = this.oldestBucket
    const last = Math.floor(this.lastAt / BUCKET_MS)
    while (i <= last && !this.buckets.has(i)) i++
    const b = this.buckets.get(i)
    return b !== undefined ? b.at : this.firstAt
  }

  /** Paper stakes and close P&L already folded off the ring for this book. */
  equityPrefix(book: string): { readonly stakes: number; readonly pnlWei: bigint } {
    return {
      stakes: this.paperPrefix.get(book) ?? 0,
      pnlWei: this.virtualPrefix.get(book) ?? 0n,
    }
  }

  /** Closes and wins since this process started, uncapped. Not a window: the whole tape. */
  get totals(): { readonly closed: number; readonly wins: number } {
    return { closed: this.lifetime.closed, wins: this.lifetime.wins }
  }

  /**
   * Fold one event's outcome.
   *
   * Takes the state AFTER the core folded it, plus what the core emitted. It never sees the
   * state before, because there is no before: see the header.
   */
  observe(event: Event, after: State, intents: readonly Intent[], refusals: readonly Refusal[]): void {
    if (this.firstAt === null) this.firstAt = event.at
    this.lastAt = event.at
    const b = this.bucket(event.at, after)

    // DEFECT 1: the scans run first, because the refusals below need what they learn.
    if (event.kind === 'chain-read') {
      this.fileRead(event)
      this.scanObservations(after)
      // Only a successful read, whose `at` is this event. A failed read leaves the last
      // balance in place; the card ages instead of blinking to unavailable.
      if (event.request?.kind === 'balance') this.fileWallet(after, event.at, b)
    }
    if (event.kind === 'feed-block' || event.kind === 'clock') {
      this.scanCohort(after)
      this.sweepUnscored(after)
    }
    this.scanSigned(after)
    // Logs close a curve sell from the fill; a receipt closes a curve sell whose log
    // never matched, and every graduated swap. Clock and feed-block run `markPositions`,
    // which is how a proven V4 swap actually flips the row to closed. A position-wallet
    // read is how a leftover bag is abandoned. Waiting for the next logs batch is how
    // a restart dropped those rows: the tape ended on the receipt, or the close landed
    // on a tick and `forgetOldRows` evicted it before the next scanned event.
    if (
      event.kind === 'logs'
      || event.kind === 'receipt'
      || event.kind === 'clock'
      || event.kind === 'feed-block'
      || (event.kind === 'chain-read' && event.request?.kind === 'position-wallet')
    ) this.scanPositions(after)
    if (event.kind === 'chain-read') this.noteBagConfirm(event, after)

    for (const i of intents) {
      if (i.kind === 'sell') this.sellReason.set(i.token, i.reason)
      // The buy intent carries its own book, so this needs no lookup and cannot be
      // misattributed by a token the observation scan has not reached yet.
      if (i.kind === 'buy') this.book(b, i.book).decided++
    }

    for (const r of refusals) {
      const book = this.bookOf.get(r.subject) ?? null
      const minute = Math.floor(r.at / BUCKET_MS)
      let row = this.refusals.get(minute)
      if (!row) { row = []; this.refusals.set(minute, row); this.oldestRefusalMinute = Math.min(this.oldestRefusalMinute, minute) }
      row.push({ at: r.at, bucket: r.bucket, book })
      if (book !== null && (r.bucket === 'send-rejected' || r.bucket === 'send-refused')) {
        this.book(b, book).sendFailed++
      }
      // Seen-but-not-watched: the screen, no-book, and the `admits` rejects that no longer
      // open an observation. Without this they vanish from the coins pane.
      if (NOT_PASSED.has(r.bucket) && !this.seenObservations.has(r.subject) && !this.seenRejected.has(r.subject)) {
        this.seenRejected.add(r.subject)
        this.bucket(r.at, after).seen++
      }
    }
    this.trimRefusals(event.at)

    b.walletRealizedWei = after.risk.walletRealizedWei
    for (const l of after.risk.books.values()) b.bookRealizedWei.set(l.book, l.realizedWei)
    const stamps = stampHalts(after)
    b.haltStamps = stamps
    b.halted = stamps.length > 0
    // After the scans, so a close on this event drops out of the sum this minute.
    // A late abandonment has already rewritten earlier minutes via `forgetBag`.
    if (this.lastWalletAt !== null) {
      const minute = Math.floor(event.at / BUCKET_MS)
      const { wei, members } = this.openCost(after)
      b.openCostWei = wei
      this.costMembers.set(minute, members)
    }
    this.trimChartCloses()
  }

  /**
   * Pick up closed rows the event scan has not seen yet.
   *
   * Boot folds the tape through `observe`, then calls this once so a receipt close at the
   * end of the tape — or any close that landed on an event this fold does not scan — still
   * fills the exits table. `recordedCloses` makes a second call a no-op.
   */
  catchUp(s: State): void {
    this.scanPositions(s)
    this.trimChartCloses()
  }

  // -------------------------------------------------------------------------
  // Scans
  // -------------------------------------------------------------------------

  /**
   * A launch that passed `admits` opened an observation. That is the moment it is watched.
   *
   * DEFECT 2: keyed on `o.token`, not on the map key. `state.observations` is keyed by CURVE
   * address, because a chain log carries the curve and not the token. `bookOf` is joined
   * against refusal subjects, which are tokens, so using the map key here would put every
   * refusal in the unattributed pile and leave the per-book funnel empty while the
   * wallet-wide one filled.
   */
  private scanObservations(s: State): void {
    for (const o of s.observations.values()) {
      if (this.seenObservations.has(o.token)) continue
      this.seenObservations.add(o.token)
      this.bookOf.set(o.token, o.book)
      this.detectedAt.set(o.token, o.startedAt)
      this.watching.set(o.token, { book: o.book, at: o.startedAt })
      const min = this.bucket(o.startedAt, s)
      min.seen++
      const launch = this.book(min, o.book)
      launch.launches++
      launch.simPending++
    }
  }

  /**
   * Settled observations, newest first, stopping at the watermark.
   *
   * Outcomes are pushed in `at` order, so walking backwards until the watermark is reached
   * touches only what is new. A forward scan of the whole ring would run on every feed block,
   * which is 88% of the tape.
   */
  private scanCohort(s: State): void {
    const all = s.cohort.all()
    for (let i = all.length - 1; i >= 0; i--) {
      const o = all[i]!
      /**
       * STRICTLY OLDER STOPS THE WALK, and a tie is settled by identity.
       *
       * `<=` here silently dropped every outcome that settled in the same millisecond as the
       * last one counted. Two launches settling together is not rare: `observe` settles them
       * all on one tick, so they share the tick's `at` exactly, and the second one onward
       * vanished from the venue sensor's numerator with nothing to show it had.
       */
      if (o.at < this.scoredThrough) break
      if (this.scoredTokens.has(o.token)) continue
      this.scoredTokens.add(o.token)
      this.watching.delete(o.token)
      this.rememberObserverPeak(o.token, o.peak)
      if (o.stakes !== null) {
        const settle = this.book(this.bucket(o.at, s), o.book)
        settle.scored++
        settle.stakes += o.stakes
      }
      this.fileSim(s, o.token, o.book, o.stakes, o.at)
    }
    if (all.length > 0) this.scoredThrough = Math.max(this.scoredThrough, all[all.length - 1]!.at)
  }

  /**
   * An observation that left the live set without a cohort row. The replay refused a path
   * rather than scoring a zero, and that is missing data: it belongs in `simDropped`, not in
   * pending and not in the return strip.
   */
  private sweepUnscored(s: State): void {
    const open = new Set<string>()
    for (const o of s.observations.values()) open.add(o.token)
    for (const [token, meta] of [...this.watching.entries()]) {
      if (open.has(token)) continue
      if (this.scoredTokens.has(token)) {
        this.watching.delete(token)
        continue
      }
      this.scoredTokens.add(token)
      this.watching.delete(token)
      this.fileSim(s, token, meta.book, null, meta.at)
    }
  }

  /**
   * Store the observer peak, and fill any closed row still waiting for it.
   *
   * Join is by token: one launch, one peak. A row that already has a number is left alone so
   * a second scoring of the same token cannot rewrite a trade the operator has already seen.
   */
  private rememberObserverPeak(token: string, peak: number): void {
    this.observerPeakByToken.set(token, peak)
    for (const t of this.closed) {
      if (t.token === token && t.observerPeak === null) t.observerPeak = peak
    }
  }

  /** Attribute one finished replay to the minute the launch was first seen. */
  private fileSim(s: State, token: string, book: string, stakes: number | null, fallbackAt: number): void {
    const launchedAt = this.detectedAt.get(token) ?? fallbackAt
    const row = this.book(this.bucket(launchedAt, s), book)
    if (row.simPending > 0) row.simPending--
    if (stakes === null) {
      row.simDropped++
      return
    }
    row.simNet += stakes
    row.simN++
    if (stakes > 0) row.simWin++
    else if (stakes < 0) row.simLoss++
    else row.simFlat++
  }

  /**
   * File what one chain read cost. See `ReadHealthRow` for what this is and is not.
   *
   * A null result IS the failure, and it is counted rather than skipped: the whole reason to watch
   * reads is that a failed one costs a launch, and a meter that only counts successes reads best
   * exactly when the provider is worst.
   */
  private fileRead(e: Extract<Event, { kind: 'chain-read' }>): void {
    const kind = e.request?.kind ?? 'unknown'
    let r = this.reads.get(kind)
    if (!r) { r = { reads: 0, failed: 0, retried: 0, viaKey: 0, latencies: [] }; this.reads.set(kind, r) }
    r.reads++
    if (e.result === null || e.result === undefined) r.failed++
    if (e.tries > 1) r.retried++
    if (e.viaKey) r.viaKey++
    /**
     * A ROW WITHOUT A LATENCY IS COUNTED BUT NOT TIMED, rather than timed as `undefined`.
     *
     * Same lesson as the receipt verdict: a tape outlives the shape it was written in, and a field
     * added later is absent on every row before it. An `undefined` pushed in here poisons the sort
     * and every percentile drawn from it reads NaN, so the numbers would be wrong rather than
     * missing — and a wrong number is worse than an absent one on a page somebody trusts.
     */
    if (Number.isFinite(e.latencyMs)) {
      r.latencies.push(e.latencyMs)
      if (r.latencies.length > READ_LATENCIES_KEPT) r.latencies.splice(0, r.latencies.length - READ_LATENCIES_KEPT)
    }
  }

  /** What the reads are costing, busiest kind first. */
  readHealth(): readonly ReadHealthRow[] {
    const at = (sorted: readonly number[], q: number): number | null =>
      sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!
    return [...this.reads.entries()]
      .map(([kind, r]) => {
        const sorted = [...r.latencies].sort((a, b) => a - b)
        return {
          kind, reads: r.reads, failed: r.failed, retried: r.retried, viaKey: r.viaKey,
          p50Ms: at(sorted, 0.5), p95Ms: at(sorted, 0.95),
          maxMs: sorted.length ? sorted[sorted.length - 1]! : null,
        }
      })
      .sort((a, b) => b.reads - a.reads)
  }

  /** Chain wallet, only when this event is the successful balance read. */
  private fileWallet(s: State, eventAt: number, b: Bucket): void {
    const bal = s.walletBalance
    if (bal === null || bal.at !== eventAt) return
    this.lastWalletAt = eventAt
    b.walletWei = bal.value
  }

  /**
   * Spend still held, but only of bags the last wallet reading already deducted
   * and that still hold tokens.
   *
   * A fill that landed after that reading still has its ETH inside the last figure, so
   * adding it would jump the line by one stake until the next read. A close, an empty
   * row, or an abandonment is the opposite: the tokens are gone, and carrying the old
   * spend is what made Total sit at 0.18 while the chain was 0.15.
   *
   * `members` is the same sum, keyed, so a later abandonment can take this bag out of
   * minutes that had added it and leave minutes that had not (a newer buy, an already
   * empty row) alone.
   */
  private openCost(s: State): { wei: bigint; members: Map<string, bigint> } {
    const members = new Map<string, bigint>()
    if (this.lastWalletAt === null) return { wei: 0n, members }
    const asOf = this.lastWalletAt
    let open = 0n
    for (const p of s.positions.values()) {
      if (p.closed || p.filled === false || p.tokensHeld <= 0n) continue
      if (p.openedAt > asOf) continue
      open += p.spendWei
      members.set(p.id, p.spendWei)
    }
    return { wei: open, members }
  }

  /**
   * A chain read that still saw tokens. The fill is the first confirmation; a later
   * `position-wallet` or `grad-wallet` with a positive balance moves it forward. An
   * abandonment books the loss here, not at the discovery read.
   */
  private noteBagConfirm(e: Extract<Event, { kind: 'chain-read' }>, s: State): void {
    const kind = e.request?.kind
    if (kind !== 'position-wallet' && kind !== 'grad-wallet') return
    const id = e.request?.args[1] ?? ''
    const p = s.positions.get(id)
    if (p === undefined || p.closed || p.filled === false || p.tokensHeld <= 0n) return
    this.bagConfirmAt.set(p.id, e.at)
  }

  /**
   * Take a bag we later abandoned out of every minute that had counted it as inventory.
   *
   * If a later read confirmed tokens after the fill, minutes through that read stay:
   * the bag was real then. If the fill is the only confirmation, every minute loses
   * the spend — that is the leftover-bag case, where Total sat at chain + corpses
   * until boot.
   */
  private forgetBag(id: string, openedAt: number, lastConfirm: number): void {
    const keepThrough = lastConfirm > openedAt ? lastConfirm : Number.NEGATIVE_INFINITY
    for (const [minute, members] of this.costMembers) {
      const spend = members.get(id)
      if (spend === undefined) continue
      if (minute * BUCKET_MS <= keepThrough) continue
      members.delete(id)
      const b = this.buckets.get(minute)
      if (b !== undefined && b.openCostWei !== null) {
        b.openCostWei -= spend
        if (b.openCostWei < 0n) b.openCostWei = 0n
      }
    }
  }

  /**
   * When a buy was signed, captured while the inflight record still exists.
   *
   * It has to be taken here rather than at close, because `settleOwnFill` deletes the
   * inflight record the moment the fill lands: by the time the position exists, the only
   * timestamp left is `openedAt`, and the gap between deciding and signing is exactly what
   * the execution pane is asking about.
   */
  private scanSigned(s: State): void {
    for (const f of s.inflight.values()) {
      if (f.kind !== 'buy') continue
      if (this.recordedSends.has(f.intentId)) continue
      this.recordedSends.add(f.intentId)
      this.signedAt.set(f.token, f.signedAt)
    }
  }

  /**
   * Positions that opened or closed since the last look.
   *
   * Scanned rather than pushed because the core has no hook to push from. Called on `logs`,
   * `receipt`, `clock`, `feed-block`, and `position-wallet` (an abandonment), and from
   * `catchUp` after boot.
   * Opens and closes are tracked with separate sets because a position can do both inside
   * one log batch, and one set would then record the close and lose the entry.
   */
  private scanPositions(s: State): void {
    for (const p of s.positions.values()) {
      if (!this.recordedOpens.has(p.id)) {
        // A send is not an entry. Counting it here would inflate the funnel by every
        // sequenced buy that later reverted or never held tokens.
        if (p.filled === false) continue
        this.recordedOpens.add(p.id)
        this.bagConfirmAt.set(p.id, p.openedAt)
        this.book(this.bucket(p.openedAt, s), p.book).entered++
        this.sample(p.openedAt, p.book, p.templateKey, p.token)
      }
      if (!p.closed || this.recordedCloses.has(p.id)) continue
      this.recordedCloses.add(p.id)
      // A dead bag is a loss: we spent and nothing came back. Skipping it here is how
      // virtual sat at 1.00 while Total invented the same spend as still-open cash.
      // Booking it at the discovery read is how both charts then drew a noon cliff:
      // the fold kept the spend as inventory until that read. Book at the last token
      // confirmation and take the spend out of the minutes that had added it.
      const abandoned = p.abandonedAt !== null
      const lastConfirm = this.bagConfirmAt.get(p.id) ?? p.openedAt
      if (abandoned) this.forgetBag(p.id, p.openedAt, lastConfirm)
      const at = abandoned ? lastConfirm : (p.closedAt ?? s.at)
      const proceeds = abandoned ? 0n : p.proceedsWei
      const pnl = abandoned ? -p.spendWei : p.proceedsWei - p.spendWei
      const tmpl = parseTemplate(p.templateKey)
      const detected = this.detectedAt.get(p.token)
      const trade: ClosedTrade = {
        at, token: p.token, book: p.book, curve: p.curve,
        reason: abandoned ? 'abandoned' : this.sellReason.get(p.token) ?? p.exitReason ?? 'not recorded',
        holdMs: at - p.openedAt,
        spendWei: p.spendWei, proceedsWei: proceeds, pnlWei: pnl,
        takeProfitMultiple: p.rules.takeProfitMultiple,
        exitMultiple: ratio(p.proceedsWei, p.spendWei),
        peakMultiple: ratio(p.peakMarkWei, p.entryMarkWei),
        observerPeak: this.observerPeakByToken.get(p.token) ?? null,
        detectToEntryMs: detected === undefined ? null : p.openedAt - detected,
        creatorTaxBps: tmpl.creatorTaxBps, devBuyWei: tmpl.devBuyWei, exemptions: tmpl.exemptions,
      }
      this.closed.push(trade)
      if (this.closed.length > LEVELS.exitsKept) this.closed.splice(0, this.closed.length - LEVELS.exitsKept)
      this.chartCloses.push({ at, token: p.token, book: p.book, reason: trade.reason, pnlWei: pnl })
      this.trimChartCloses()

      // Counted before the list is capped, because the list is capped. The wallet card's
      // "since zero" read the list's length and therefore stopped counting at 40.
      this.lifetime.closed++
      if (pnl > 0n) this.lifetime.wins++

      const bb = this.book(this.bucket(at, s), p.book)
      bb.closed++
      bb.pnlWei += pnl
      bb.spendWei += p.spendWei
      if (pnl > 0n) bb.wins++
      if (trade.reason === 'tp') bb.tpClosed++
      this.sellReason.delete(p.token)
    }
  }

  /** One entry, with the two timings that have a zero we actually recorded. */
  private sample(at: number, book: string, templateKey: string, token: string): void {
    const tmpl = parseTemplate(templateKey)
    const detected = this.detectedAt.get(token) ?? null
    const signed = this.signedAt.get(token) ?? null
    this.samples.push({
      at, book,
      creatorTaxBps: tmpl.creatorTaxBps,
      exemptions: tmpl.exemptions,
      detectToEntryMs: detected === null ? null : at - detected,
      detectToSendMs: detected === null || signed === null ? null : signed - detected,
    })
    if (this.samples.length > SAMPLES_KEPT) this.samples.splice(0, this.samples.length - SAMPLES_KEPT)
  }

  // -------------------------------------------------------------------------
  // Reading it back
  // -------------------------------------------------------------------------

  /** Newest first, which is the order the exits table reads in. */
  recentExits(): readonly ClosedTrade[] {
    return [...this.closed].reverse()
  }

  /** Closes inside the window, for the money-pane dots. Not the exits table. */
  tradesIn(from: number, to: number): readonly ChartClose[] {
    return this.chartCloses.filter((t) => t.at >= from && t.at <= to)
  }

  /** Drop closes older than the longest lookback so a 7d view cannot lose its left edge. */
  private trimChartCloses(): void {
    const cutoff = this.lastAt - LEVELS.chartTradesHorizonMs
    let w = 0
    for (let i = 0; i < this.chartCloses.length; i++) {
      const row = this.chartCloses[i]!
      if (row.at >= cutoff) this.chartCloses[w++] = row
    }
    this.chartCloses.length = w
  }

  /** Entry samples inside the window, for the distribution panes. */
  samplesIn(from: number, to: number): readonly EntrySample[] {
    return this.samples.filter((s) => s.at >= from && s.at <= to)
  }

  /**
   * The buckets covering `[from, to]`, oldest first, with gaps filled as empty minutes.
   *
   * Empty minutes are real information: a flat stretch where nothing launched looks the same
   * as a stretch the bot was down unless the series says which. Coverage, from `this.coverage`,
   * is what separates the two.
   */
  window(from: number, to: number): readonly Bucket[] {
    const out: Bucket[] = []
    const lo = Math.floor(from / BUCKET_MS)
    const hi = Math.floor(to / BUCKET_MS)
    for (let i = lo; i <= hi; i++) {
      out.push(this.buckets.get(i) ?? emptyMinute(i * BUCKET_MS, null, true))
    }
    return out
  }

  /** Refusals inside the window, so the funnel has a denominator that is not "since boot". */
  /** Proportional to the window asked for, never to how long this process has been up. */
  refusalsIn(from: number, to: number): readonly RefusalStamp[] {
    const out: RefusalStamp[] = []
    const lo = Math.floor(from / BUCKET_MS)
    const hi = Math.floor(to / BUCKET_MS)
    for (let i = lo; i <= hi; i++) {
      const row = this.refusals.get(i)
      if (!row) continue
      // Only the two edge minutes can contain rows outside the window, but checking every row
      // costs nothing next to the map lookup and keeps the bound exact.
      for (const r of row) if (r.at >= from && r.at <= to) out.push(r)
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private bucket(at: number, s: State): Bucket {
    const i = Math.floor(at / BUCKET_MS)
    let b = this.buckets.get(i)
    if (!b) {
      b = emptyMinute(i * BUCKET_MS, s.risk.walletRealizedWei)
      this.buckets.set(i, b)
      if (i < this.oldestBucket) this.oldestBucket = i
      // DEFECT 4: eviction walks the tracked minimum rather than spreading ten thousand keys
      // into an argument list, which is also a stack overflow waiting to be discovered on the
      // day the ring is full.
      while (this.buckets.size > BUCKETS_KEPT) {
        while (!this.buckets.has(this.oldestBucket)) this.oldestBucket++
        const gone = this.buckets.get(this.oldestBucket)
        if (gone) this.foldPrefix(gone)
        this.costMembers.delete(this.oldestBucket)
        this.buckets.delete(this.oldestBucket)
        this.oldestBucket++
      }
    }
    return b
  }

  /** Move one evicted minute's paper stakes and close P&L into the prefix. */
  private foldPrefix(gone: Bucket): void {
    for (const [id, bb] of gone.books) {
      if (bb.pnlWei !== 0n) this.virtualPrefix.set(id, (this.virtualPrefix.get(id) ?? 0n) + bb.pnlWei)
      if (bb.scored > 0 && bb.stakes !== 0) {
        this.paperPrefix.set(id, (this.paperPrefix.get(id) ?? 0) + bb.stakes)
      }
    }
  }

  private book(b: Bucket, id: string): BookBucket {
    let x = b.books.get(id)
    if (!x) {
      x = emptyBook()
      b.books.set(id, x)
    }
    return x
  }

  /** Refusals are kept for the longest window the page offers, and no longer. */
  /**
   * Drop whole minutes that have fallen out of the longest window the page can ask for.
   *
   * Walks a tracked minimum rather than the whole key set, for DEFECT 4's reason: `Map` keeps
   * insertion order, not key order, so a late event can create a minute behind the newest one
   * and `Math.min(...keys)` is both wrong and a stack overflow waiting for a full ring.
   */
  private trimRefusals(now: number): void {
    const cutoff = Math.floor((now - BUCKET_MS * BUCKETS_KEPT) / BUCKET_MS)
    if (this.oldestRefusalMinute > cutoff) return
    for (let i = this.oldestRefusalMinute; i < cutoff; i++) this.refusals.delete(i)
    this.oldestRefusalMinute = cutoff
  }
}

function emptyBook(): BookBucket {
  return {
    launches: 0, decided: 0, entered: 0, closed: 0, wins: 0,
    pnlWei: 0n, spendWei: 0n, tpClosed: 0, sendFailed: 0,
    scored: 0, stakes: 0,
    simWin: 0, simLoss: 0, simFlat: 0, simPending: 0, simDropped: 0,
    simNet: 0, simN: 0,
  }
}

function emptyMinute(at: number, realized: bigint | null, gap = false): Bucket {
  return {
    at, books: new Map(), walletRealizedWei: realized,
    walletWei: null, openCostWei: null,
    bookRealizedWei: new Map(),
    haltStamps: gap ? null : [],
    halted: false, seen: 0,
  }
}

/** Every halt the fold is holding, keyed as they stand. */
function stampHalts(state: State): HaltStamp[] {
  return [...state.risk.halts.values()].map((h) => ({ kind: h.kind, book: h.book }))
}

/**
 * Seen but not watched. Screen rejects, no book, and the `admits` rejects that used to open
 * an observation (until 2026-09-17) and now must be counted here or they vanish from `seen`.
 */
const NOT_PASSED: ReadonlySet<RefusalBucket> = new Set([
  'screen-pair', 'screen-tax', 'screen-devbuy', 'screen-prior', 'screen-meta', 'entry-no-book',
  'entry-exempt', 'entry-template-loss',
])

/**
 * A ratio of two wei quantities, as a float, or null when the denominator is zero.
 *
 * DEFECT 3: scaled on the bigint first so operands near 1e27 cannot lose precision in float64.
 * The old bot did exactly this division in float64 at `bot.ts:941`.
 */
function ratio(a: bigint, b: bigint): number | null {
  if (b <= 0n) return null
  return Number((a * 10_000n) / b) / 10_000
}

/**
 * Pull the tax, the dev buy and the exemption count back out of the template key.
 *
 * The key IS the tuple: `${creatorTaxBps}:${devBuyWei}:${exemptions}` (core/entry.ts:49). It
 * is parsed rather than carried a second time on the position, because two copies of the same
 * tuple is two things that can disagree. Anything that will not parse returns nulls and the
 * columns render as absent, which is the honest answer rather than a zero.
 */
function parseTemplate(key: string): {
  creatorTaxBps: number | null
  devBuyWei: bigint | null
  exemptions: number | null
} {
  const parts = key.split(':')
  if (parts.length !== TEMPLATE_PARTS) return { creatorTaxBps: null, devBuyWei: null, exemptions: null }
  let devBuyWei: bigint | null = null
  try { devBuyWei = BigInt(parts[1]!) } catch { devBuyWei = null }
  return {
    creatorTaxBps: intOrNull(parts[0]),
    devBuyWei,
    exemptions: intOrNull(parts[2]),
  }
}

function intOrNull(s: string | undefined): number | null {
  if (s === undefined || s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}
