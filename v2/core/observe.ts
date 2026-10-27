/**
 * THE MARKET INDICATOR. It is the simulator, not a counter.
 *
 * WHAT IT ANSWERS. For every launch `admits` would have allowed this book to buy, whether or
 * not it did: what would our own exit rule have made in it? That is tax band, exempt floor
 * and template-loss block — the same `pickEntry` set the Sep 1-14 research indicator used.
 * Halt, slots and drawdown do not gate the watch: sitting out is not a different coin set.
 * The answer is a replay of that launch's real chain logs through `core/sim.ts`, at each
 * candidate take-profit bar, and it comes out in stakes. Sum each row's own frozen-at-watch
 * column over the trailing window and you have the number that halts the wallet. Take the
 * argmax across columns and you have the take-profit rung. Take the best mark and you have
 * the peak the exits table reports. One replay, three readings.
 *
 * WHY THIS FILE WAS WRONG UNTIL 2026-09-16. It counted launches that reached 1.21x within
 * 45 seconds. That is `obs.touch`, the SECONDARY safety check, whose own live payload
 * describes itself as "this safety check is still active". The number that actually paused
 * the live wallet, `obs.bars`, is a replay result and always was. A counter and a replay
 * disagree in the worst possible way: they agree on quiet markets and diverge exactly when
 * the market is moving, which is the only time the guard matters.
 *
 * UNTIL 2026-09-17 THE WATCH WAS WIDER THAN THE BUY. An observation opened as soon as a
 * launch routed to a book, before `admits`. That was the 08-27 rule: keep the rejected
 * coins so a dead filter and a dead market stay distinguishable. It made the live guard
 * score coins live would refuse, which is not what the research indicator did. The funnel
 * still counts `entry-exempt` and `entry-template-loss`. The watch does not.
 *
 * WHY THE FOLD DOES THIS ITSELF. In the old bot the replay lived in a separate python process
 * writing a separate database (`gatewatch.py` -> `gate.db`) and the bot read the answer back
 * across that boundary. The reading could go stale without the bot noticing, which is the
 * 2026-09-16 "frozen tape drawn as live" defect. A replay of the tape could not reproduce it,
 * because the observer's rows were not on the tape. And the two processes disagreed about
 * what a launch was, because each had its own copy of the screen. Folding it here removes all
 * three: the reading is a function of the same events every other decision is a function of.
 */
import { sensed } from './contracts.js'
import { filePair } from './broken.js'
import { venueVerdict } from './guard.js'
import { releaseDrawdown } from './risk.js'
import { adaptiveBar, rungNow } from './takeprofit.js'
import {
  LIVE_EXIT_LAG_BLK, LIVE_PATH, LIVE_POLL_BLK, REPLAY_STAKE_ETH, SIM_WINDOW_MS,
  barKey, blocksFromMs, path, scoreLaunch, type SimEvent, type SimPolicy,
} from './sim.js'
import { simulationOf, type BookSpec } from './config.js'
import type { BarsReading, Observation, Outcome, State, VenueReading } from './state.js'

/**
 * Start watching a launch, from its launch block.
 *
 * Nothing is priced here and nothing is sampled here. The observation is a recorder: it
 * collects the launch's curve logs and the four launch facts the replay needs, and the whole
 * answer is computed once, at settle, from those inputs.
 */
export function openObservation(
  s: State,
  o: Omit<Observation, 'events' | 'startedAt' | 'pinnedBar'> & { readonly events?: readonly SimEvent[] },
): void {
  if (s.observations.has(o.curve)) return
  // THE COLUMN IS FROZEN HERE, at the same moment a real entry would have pinned its rung, and
  // THROUGH THE SAME FUNCTION. `rungNow` is what `decide` calls to pin a position's target, so
  // the venue sums the column the bot would really have traded — including "unknown means cold"
  // during warmup and after a stale reading, which is where the two used to part company.
  //
  // A book missing from the spec pins 0, which no bar keys, so the row arrives with `stakes`
  // null at settle and the window shrinks by one rather than counting a launch at a column
  // nothing chose. That is the same treatment a dropped bar already gets.
  const book = bookOf(s, o.book)
  const pinnedBar = book === null ? 0 : rungNow(s.at, s.sensors.bars.get(o.book) ?? null, book).multiple
  s.observations.set(o.curve, {
    token: o.token, curve: o.curve, book: o.book, startedAt: s.at, pinnedBar,
    launchBlock: o.launchBlock, deployer: o.deployer.toLowerCase(), launchTx: o.launchTx.toLowerCase(),
    creatorTaxBps: o.creatorTaxBps, events: [...(o.events ?? [])],
  })
}

/**
 * Record one curve log against the launch that is watching it.
 *
 * Appended in arrival order, which is chain order: the fold walks a log batch in the order
 * the node returned it and a batch is one block range. `sim.path` relies on that ordering and
 * does not re-sort, exactly as `chainio.decode_seq` sorted once and handed over a list.
 *
 * A log past the replay's horizon is dropped at the door rather than stored and ignored. The
 * walk stops there anyway, and a curve that stays busy for an hour would otherwise hold
 * thousands of events nothing will ever read.
 */
export function recordCurveLog(s: State, curve: string, e: SimEvent): void {
  const o = s.observations.get(curve)
  if (!o) return
  if (e.b - o.launchBlock > LIVE_PATH.entryBlk + LIVE_PATH.horizon) return
  o.events.push(e)
}

/**
 * The exit stack the replay walks, in blocks, from the same spec the live exits read.
 *
 * ONE SOURCE FOR BOTH. The simulator scores what `core/exit.ts` would have done, so it takes
 * the hard stop, the dead-coin bail and the clock from `config.exit` rather than from numbers
 * of its own. The poll interval and the exit lag come from `sim.ts` instead, because those
 * measure what the bot's loop can do rather than what the operator chose.
 */
export function simPolicy(book: BookSpec): Omit<SimPolicy, 'takeProfit'> {
  return {
    hardStop: book.exit.hardStopMultiple,
    deadAfterBlk: blocksFromMs(book.exit.deadCoinAfterMs),
    deadBelowMultiple: book.exit.deadCoinBelowMultiple,
    holdBlk: blocksFromMs(book.exit.maxHoldMs),
    pollBlk: LIVE_POLL_BLK,
    exitLagBlk: LIVE_EXIT_LAG_BLK,
  }
}

/** This book's policy, by id. Null when a band moved out from under an open observation. */
function bookOf(s: State, id: string): BookSpec | null {
  for (const b of s.config.books) if (b.id === id) return b
  return null
}

/**
 * The longest settle window any book asks for.
 *
 * Read by the pending-launch sweep, which runs BEFORE the metadata read tells us the creator
 * tax, so it does not yet know which book the launch belongs to. Taking the maximum means no
 * book's launch is ever dropped early; taking the minimum would silently starve whichever book
 * watches longest.
 */
export function longestSettleMs(s: State): number {
  let ms = SIM_WINDOW_MS
  for (const b of s.config.books) if (b.guard.settleMs > ms) ms = b.guard.settleMs
  return ms
}

/**
 * Settle every observation whose window has closed, scoring it at every bar.
 *
 * SETTLE IS ON THE CLOCK, NOT ON THE LAST LOG. A dead coin emits nothing after its dev buy,
 * so waiting for a log past the horizon would leave exactly the launches that define a bad
 * market unscored forever, and the indicator would read the market as better than it is.
 *
 * A LAUNCH THE REPLAY CANNOT ENTER IS DROPPED, NOT ZEROED. `path` returns null when the curve
 * has no sellable supply left by our entry block, which is missing data. Recording it as a
 * flat outcome would pull every sum toward the middle by exactly the number of graduations.
 */
export function observe(s: State): State {
  if (s.observations.size === 0) return s
  const due: Observation[] = []
  for (const [curve, o] of s.observations) {
    // EACH BOOK'S OWN WINDOW. A book that watches longer is a book whose launches settle
    // later, and reading one shared number here would score somebody else's policy.
    const b = bookOf(s, o.book)
    const settleMs = Math.max(b?.guard.settleMs ?? SIM_WINDOW_MS, SIM_WINDOW_MS)
    if (s.at - o.startedAt < settleMs) continue
    due.push(o)
    s.observations.delete(curve)
  }
  if (due.length === 0) return s

  for (const o of due) {
    // A book that has gone from the spec takes its unsettled launches with it. Scoring them
    // under some other book's rules would file a launch nobody traded against a policy that
    // never saw it, which is worse than losing the row.
    const book = bookOf(s, o.book)
    if (book === null) continue

    const P = path(
      { token: o.token, block: o.launchBlock, deployer: o.deployer, tx: o.launchTx },
      REPLAY_STAKE_ETH, o.events, o.creatorTaxBps, LIVE_PATH,
    )
    if (P === null) continue

    const simulation = simulationOf(s.config)
    const scored = scoreLaunch(
      P,
      book.takeProfit.adaptiveBars,
      simPolicy(book),
      blocksFromMs(book.exit.maxHoldMs),
      simulation,
    )
    // The column this launch pinned when the watch opened, never today's argmax. The fallback
    // is for a row that never had a watch to freeze anything at, which is what `pnlBar` is for.
    const stakes = scored.perBar[barKey(o.pinnedBar ?? book.guard.pnlBar)]
    let sizingStakes: number | null | undefined
    if (book.sizing?.enabled) {
      const sizingPath = path(
        { token: o.token, block: o.launchBlock, deployer: o.deployer, tx: o.launchTx },
        Number(BigInt(book.sizing.referenceSizeWei)) / 1e18, o.events, o.creatorTaxBps, LIVE_PATH,
      )
      if (sizingPath === null) sizingStakes = null
      else {
        const sizing = scoreLaunch(
          sizingPath, book.takeProfit.adaptiveBars, simPolicy(book),
          blocksFromMs(book.exit.maxHoldMs), simulation,
        )
        sizingStakes = sizing.perBar[barKey(o.pinnedBar ?? book.guard.pnlBar)] ?? null
      }
    }
    const outcome: Outcome = {
      token: o.token, book: o.book, at: s.at,
      simulationModel: simulation.model,
      perBar: scored.perBar, rawPerBar: scored.rawPerBar,
      stakes: stakes === undefined ? null : stakes,
      ...(sizingStakes === undefined ? {} : { sizingStakes }),
      peak: scored.peak,
    }
    s.cohort.push(outcome)
  }

  // A COIN WE TRADED IS NOW MEASURABLE. Filed after every row is in the cohort rather than inside
  // the loop, so the pair reads the row this pass just wrote. Where the trade closed first this
  // is the second half and the pair completes; where it has not closed yet, its close completes
  // it. `filePair` returns state because raising the reading replaces the sensors record.
  for (const o of due) s = filePair(s, o.token)

  return refreshSensors(s)
}

/**
 * The venue reading: two windows over the same rows, with hysteresis across them.
 *
 * THE WINDOW IS THE BOOK'S OWN. `s.cohort` holds every book's launches, and summing across
 * books would give two policies one blended verdict, which is the hole `bot/` has and the
 * reason it refuses to start with two books configured. Filtering here is what makes a book a
 * policy rather than a label.
 *
 * A complete but old window holds the previous verdict. An incomplete window still shuts.
 * Freshness describes whether the score can move the verdict, not whether the market lost.
 *
 * ONLY ON NEW EVIDENCE, and that is structural rather than a flag: `refreshSensors` is called
 * from exactly two places, after `observe` settles rows and after a `seed` folds them, so a
 * verdict is only ever recomputed when a publication landed. No clock re-reads this.
 */
export function venueReading(s: State, book: string): VenueReading | null {
  const b = bookOf(s, book)
  if (b === null) return null
  const spec = b.guard
  const rows: Outcome[] = []
  const all = s.cohort.all()
  let oldestAt = s.at
  for (let i = all.length - 1; i >= 0 && rows.length < spec.window; i--) {
    const o = all[i]!
    if (o.book !== book) continue
    // A row whose replay dropped its pinned bar is skipped rather than counted as zero. It is
    // one launch of missing data, and the window shrinks by one instead of being pulled flat.
    if (o.stakes === null) continue
    rows.push(o)
    oldestAt = o.at
  }
  if (rows.length === 0) return null

  // `rows` is newest first, so the freshest slice is its head. Both sums are drawn from the
  // same array on purpose: the reopen must never read a population the pause did not see.
  //
  // A config-applied row recorded BEFORE this field existed has no `recoveryWindow`, and the
  // fold replaces `state.config` from that row wholesale without revalidating it, so the type
  // says `number` while the tape can still hand over `undefined`. Falling back to the main
  // window reproduces exactly what those hours ran: one window for both directions.
  const recoveryWindow = spec.recoveryWindow ?? spec.window
  const fresh = rows.slice(0, recoveryWindow)
  const sums = {
    mainSum: rows.reduce((a, o) => a + (o.stakes ?? 0), 0),
    mainN: rows.length,
    freshSum: fresh.reduce((a, o) => a + (o.stakes ?? 0), 0),
    freshN: fresh.length,
    reachMs: s.at - oldestAt,
  }

  // Cash drawdown is the other shut trigger for THIS same verdict. A book already down
  // 3 stakes must use the reopen path (8 above +1), not the "stay open while 15 is fine"
  // path, or a crash that the replay has not yet scored would never pause.
  const previous = s.sensors.venue.get(book)?.value
  // No prior verdict cannot be held open on stale seed data. A first complete fresh
  // window retains the existing open-side threshold rather than requiring recovery.
  const wasOpen = !s.risk.halts.has(`drawdown:${book}`)
    && (previous?.open ?? (sums.reachMs <= spec.freshMs))
  const v = venueVerdict(spec, sums, wasOpen)
  return {
    open: v.open, fresh: v.fresh, why: v.why,
    sumStakes: sums.mainSum, window: sums.mainN,
    recentSum: sums.freshSum, recoveryWindow: sums.freshN,
    bar: 'adaptive',
  }
}

/**
 * The adaptive bar: whichever column earned the most across the book's trailing window.
 *
 * Reads the SAME rows the venue sum reads, one column over instead of one column deep. The
 * argmax itself lives in `takeprofit.ts` beside the rule for what "not ready" means, because
 * a fallback multiple presented as a measurement is a guess wearing a lab coat.
 */
export function barsReading(s: State, book: string): BarsReading {
  const b = bookOf(s, book)
  if (b === null) return { multiple: 0, ready: false, why: `no book ${book} in the spec` }
  const window = b.takeProfit.adaptiveWindow
  const rows: Array<Readonly<Record<string, number>>> = []
  const all = s.cohort.all()
  for (let i = all.length - 1; i >= 0 && rows.length < window; i--) {
    const o = all[i]!
    if (o.book !== book) continue
    rows.push(o.perBar)
  }
  return adaptiveBar(rows, b.takeProfit)
}

/**
 * Recompute both readings for EVERY book, store them, and move that book's halt.
 *
 * Stamped `source: 'fold'` so a projection can tell a reading this process derived from one
 * that arrived as a recorded `sensor` event, and `n` carries the window so `readSensor` can
 * refuse a reading taken over zero rows. A sum with no denominator is the thing this repo has
 * a rule against.
 *
 * THE HALT IS RAISED HERE, beside the verdict that justifies it, and it is scoped to the book.
 * Until 2026-09-16 `HaltKind` declared `venue` and nothing in v2 ever raised it, so the guard
 * was a number on a page rather than a control. A sensor that cannot stop the wallet is not a
 * guard.
 *
 * An incomplete window shuts the book. A complete but old window holds the last verdict,
 * so a quiet period alone does not move the halt in either direction.
 */
export function refreshSensors(s: State): State {
  const venue = new Map(s.sensors.venue)
  const bars = new Map(s.sensors.bars)
  for (const book of s.config.books) {
    const v = venueReading(s, book.id)
    if (v !== null) {
      venue.set(book.id, sensed(v, s.at, 'fold', v.window))
      stepHalt(s, book.id, v)
    }
    bars.set(book.id, sensed(barsReading(s, book.id), s.at, 'fold', book.takeProfit.adaptiveWindow))
  }
  return { ...s, sensors: { ...s.sensors, venue, bars } }
}

/**
 * Migrate a saved fold from the previous fail-closed freshness rule.
 *
 * `stepHalt` never replaces an existing venue halt's reason. A stale-window reason therefore
 * proves this book was venue-open immediately before freshness alone raised its halt. The
 * migration restores that verdict and asks the new rule to recompute it from the saved rows.
 * It refuses a cash halt, an incomplete window, or any other reason to be shut.
 */
export function holdPreviouslyOpenStaleVenue(s: State, book: string): State | null {
  const halt = s.risk.halts.get(`venue:${book}`)
  const reading = s.sensors.venue.get(book)
  const spec = bookOf(s, book)
  if (halt?.kind !== 'venue' || !halt.reason.startsWith('the window reaches back ')
    || s.risk.halts.has(`drawdown:${book}`) || reading === undefined || spec === null
    || reading.value.open || reading.value.fresh || reading.value.window < spec.guard.window) return null

  const venue = new Map(s.sensors.venue)
  venue.set(book, { ...reading, value: { ...reading.value, open: true } })
  const migrated = refreshSensors({ ...s, sensors: { ...s.sensors, venue } })
  return migrated.sensors.venue.get(book)?.value.open === true
    && !migrated.risk.halts.has(`venue:${book}`) ? migrated : null
}

/**
 * Raise or clear this book's venue halt, and nothing else's.
 *
 * Keyed `venue:<book>` because `haltedFor` treats a null book as wallet-wide: a venue pause on
 * one policy must not stop the other, which is the entire argument for running two books at
 * all. When the guard reopens, cash drawdown reopens with it: one shut, one reopen.
 */
function stepHalt(s: State, book: string, v: VenueReading): void {
  const key = `venue:${book}`
  if (!v.open) {
    if (!s.risk.halts.has(key)) {
      s.risk.halts.set(key, { kind: 'venue', book, reason: v.why, at: s.at })
    }
  } else {
    s.risk.halts.delete(key)
    releaseDrawdown(s, book)
  }
}
