/**
 * The strategy spec: one versioned document, and the two switches that are not in it.
 *
 * WHY A DOCUMENT AND NOT AN ENV FILE. A flat key=value file cannot express a policy, so the
 * old bot crammed a mini-language into a string (`BOOKS=untaxed:0-0,taxed:50-10000`) and
 * needed sixty lines and six cross-checks to parse it. A nested document diffs, reviews,
 * hashes, and holds a comment beside every number saying why it is that number.
 *
 * WHY CONFIG IS AN EVENT. `decide(state, event)` takes two arguments, not three. The applied
 * config arrives as a `config-applied` event and lives in `state.config`. A third parameter
 * would be a second source of truth for one fact, and a replay configured differently from
 * the run it replays would look identical to one configured the same. On the tape, a
 * disagreement is a visible row.
 *
 * WHY READERS ARE DECLARED. On 2026-09-16 one flag documented with a single clause turned
 * out to be read at 19 sites and to change 11 behaviours, including which take-profit source
 * the bot used. Flipping it stopped the measurement pipeline for 20 minutes. Here every key
 * names the modules allowed to read it, and a test fails when an undeclared module does.
 * The declaration is the contract; the prose is not.
 */
import { no, ok, type Ok } from './contracts.js'
import type { Source } from './contracts.js'
import { SIM_WINDOW_MS, type SimCalibration } from './sim.js'

// ---------------------------------------------------------------------------
// The two switches
// ---------------------------------------------------------------------------

/**
 * The ONLY things an operator changes at runtime. Everything else is a spec version.
 *
 * The test for membership: would you change it at 3am, alone, without review, to stop losing
 * money? Size reduces exposure. Broadcast decides whether anything is actually sent. New
 * buys are stopped from the dashboard (STOP ALL), not from a file line that the page could
 * not lift and the fold did not even check.
 *
 * `halt` stays on SwitchName because old tapes still carry those rows. The fold ignores them.
 */
export type SwitchName = 'halt' | 'size' | 'book-size' | 'broadcast'

export type Mode = 'shadow' | 'live'

export type SwitchValue =
  | { readonly kind: 'halt'; readonly on: boolean }
  /** wei, as a decimal string. Bounded by spec.risk.maxTradeSizeWei at apply time. */
  | { readonly kind: 'size'; readonly wei: string }
  /** null clears the override and returns this book to the global default. */
  | { readonly kind: 'book-size'; readonly book: string; readonly wei: string | null }
  /** `observe` is dead. It remains here so old tape rows still decode. The fold ignores it. */
  | { readonly kind: 'broadcast'; readonly mode: 'observe' | Mode }

export type Switches = {
  /** Default for every book without its own override. */
  readonly sizeWei: bigint
  /** Optional for historical fixtures and snapshots written before per-book controls existed. */
  readonly bookSizes?: ReadonlyMap<string, BookSizeOverride>
  readonly mode: Mode
  /** provenance of the last change to size or mode. */
  readonly at: number
  readonly by: string
}

export type BookSizeOverride = {
  readonly sizeWei: bigint
  readonly at: number
  readonly by: string
}

/** Smallest operator-selected live stake. Below this, fixed costs dominate the sample. */
export const MIN_BOOK_TRADE_SIZE_WEI = 500_000_000_000_000n

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

/** The most books a spec may declare. See the refusal in `validate` for why 16, and why bounded at all. */
export const MAX_BOOKS = 16

/**
 * One book: a creator-tax band and the filter that goes with it.
 *
 * Bands must be disjoint, refused at load if they are not. That single rule is why nothing
 * downstream needs an arbiter: a launch has one creator tax, so it routes to at most one
 * book. There is no contention, no shared position and no split fill anywhere, and none of
 * that is a coincidence.
 */
export type BookSpec = {
  /** the operator's own name. Goes in the ledger, in halt reasons and on the dashboard. */
  readonly id: string
  readonly minCreatorTaxBps: number
  readonly maxCreatorTaxBps: number
  readonly minExemptions: number
  readonly templateLossBlockMs: number
  /**
   * What this book stakes on one launch, wei. ZERO MEANS DECLARED AND NOT FUNDED.
   *
   * Funding a book is a money decision and it belongs in the reviewed, versioned document
   * rather than in a switch, because "should this policy trade at all" is not a question
   * anyone should answer at 3am alone. The global default and a per-book override apply
   * instantly, but neither can exceed this declaration or fund a size-0 book.
   */
  readonly sizeWei: string
  /**
   * This book's declared session-stop ceiling, wei: `sizeWei * risk.drawdownStakes`.
   *
   * The live stop uses the effective book size multiplied by `risk.drawdownStakes`. Zero when
   * the book is unfunded. Per book because the loss is per book.
   */
  readonly maxDrawdownWei: string
  /**
   * THE POLICY. Each book carries a complete one, resolved from `[defaults]` at load so
   * every read site sees a fully materialised value and never a default it has to remember
   * to apply. A book is not a filter with shared rules behind it; it is a filter, an entry,
   * an exit, a take-profit ladder and a market guard that answer only for its own launches.
   */
  readonly entry: EntrySpec
  readonly exit: ExitSpec
  readonly takeProfit: TakeProfitSpec
  readonly guard: GuardSpec
  /** Absent on historical specs. Missing means fixed 1x sizing. */
  readonly sizing?: SizingSpec
}

export type SizingSpec = {
  readonly enabled: boolean
  /** Fixed simulator stake used only for the sizing signal. */
  readonly referenceSizeWei: string
  readonly window: number
  readonly recentWindow: number
  readonly confirmations: number
  readonly clipStakes: number
  readonly strongThreshold: number
  /** Integer basis points keep stake arithmetic exact. Normal is always 10,000. */
  readonly weakBps: number
  readonly strongBps: number
  /** Pilot ceiling on the dashboard-selected 1x base. */
  readonly maxBaseSizeWei: string
  readonly freshMs: number
}

export type EntrySpec = {
  readonly entryDelayMs: number
  readonly entryFallbackLateMs: number
  readonly maxEntryPriceMultiple: number
  readonly buySlippageBps: number
}

export type ExitSpec = {
  readonly maxHoldMs: number
  readonly hardStopMultiple: number
  readonly deadCoinAfterMs: number
  readonly deadCoinBelowMultiple: number
  readonly graduationExitAt: number
  readonly maxSellAttempts: number
  readonly exitRetryDelayMs: number
  readonly sellFinalMinQuoteOutWei: string
}

export type TakeProfitSpec = {
  /** used when the adaptive window cannot answer. Never silently, always with a reason. */
  readonly otherwise: number
  readonly adaptiveWindow: number
  /** exponential half-life in launches; zero keeps every row equally weighted */
  readonly adaptiveHalfLife?: number
  /** magnitude of the most negative score one launch may contribute; zero is uncapped */
  readonly adaptiveLossCap?: number
  /** magnitude of the most positive score one launch may contribute; zero is uncapped */
  readonly adaptiveProfitCap?: number
  readonly adaptiveBars: readonly number[]
}

export type GuardSpec = {
  /** the main window. Pause reads this many scored launches. */
  readonly window: number
  /** the fresh window. Reopen reads this many, and never more than `window`. */
  readonly recoveryWindow: number
  /** stakes the FRESH window must sum ABOVE to reopen a paused book */
  readonly openAt: number
  /** stakes the MAIN window must sum BELOW to pause a trading book */
  readonly shutAt: number
  /** how long a launch is watched before it is scored. Must cover the replay's own horizon. */
  readonly settleMs: number
  /** the window must fit inside this, or the evidence is stale and the guard fails closed */
  readonly freshMs: number
  /** the column a launch pins while the adaptive selector still has no window of its own. */
  readonly pnlBar: number
  /** a reading older than this is stale and the guard has no opinion. */
  readonly maxReadingAgeMs: number
}

export type RiskSpec = {
  /**
   * Wallet-wide open-position ceiling. Zero means no ceiling: leftover `reserved`
   * from an unbooked fill must not sit out a launch. A positive value still refuses.
   */
  readonly maxConcurrent: number
  /** the ceiling any book may declare or select from the dashboard. */
  readonly maxTradeSizeWei: string
  /**
   * Ceiling on capital marked deployed at once, wallet-wide. Zero means no ceiling.
   * A leftover deployedWei from an unbooked fill must not sit out open coins.
   */
  readonly bankrollWei: string
  /**
   * Session stop as a multiple of each book's live effective size. The per-book wei stop and
   * the wallet bar are derived from this, including after a hot size-switch edit.
   */
  readonly drawdownStakes: number
  /**
   * Scale of the wallet drawdown bar and its alerts. Not a halt.
   *
   * Stored as the sum of every declared book stop. At runtime the bar uses the sum of the live
   * effective stops, so a live size change moves the bar without another config edit.
   */
  readonly maxWalletDrawdownWei: string
  readonly brokenWindow: number
  readonly brokenFactor: number
  /**
   * How far under its own replay the book may come in, in POINTS a trade, before this is called
   * a bug rather than a market. Positive here; the comparison is against the negative.
   */
  readonly brokenGapPp: number
  readonly maxLogsStalenessMs: number
  readonly maxOverlayAgeMs: number
}

export type ClockSpec = {
  /** how often the driver emits a `clock` event while anything is open. */
  readonly periodMs: number
}

export type SimulationSpec = SimCalibration & {
  /** versioned name shown to operators and carried by newly settled outcomes */
  readonly model: string
}

export const RAW_SIMULATION: SimulationSpec = {
  model: 'raw-v1',
  positiveFactor: 1,
  negativeFactor: 1,
}

/** Old config-applied rows predate calibration and therefore reproduce the raw model. */
export function simulationOf(config: FrozenConfig): SimulationSpec {
  return config.simulation ?? RAW_SIMULATION
}

/**
 * The whole spec. FOUR FIELDS, because only two things are genuinely wallet-wide.
 *
 * `risk` and `clock` are the wallet and the machine: one key, one nonce, one bankroll, one
 * timer. Everything a policy decides now lives on the book that decides it, so there is no
 * top-level `entry` or `guard` for a second book to quietly inherit and no read site that has
 * to remember which scope it is in.
 */
export type FrozenConfig = {
  readonly specVersion: number
  readonly books: readonly BookSpec[]
  /** Optional only so historical config-applied events replay as the raw model. */
  readonly simulation?: SimulationSpec
  readonly risk: RiskSpec
  readonly clock: ClockSpec
}

// ---------------------------------------------------------------------------
// Reader declarations
// ---------------------------------------------------------------------------

/** The modules in core/ that are allowed to read config at all. */
/**
 * The modules in core/ that are allowed to read config at all, plus 'driver' for the two
 * keys a transport needs in order to shape a transaction or time a tick.
 *
 * Exported as a value, not only a type, so a test can check the declarations at runtime as
 * well as at compile time.
 */
/**
 * How many paired trades the fold keeps for the bot-broken detector, and therefore the ceiling
 * `risk.broken_window` may ask for.
 *
 * The bound exists here rather than as a silent floor in the ring, because a window larger than
 * the ring is a detector that can never fill its window and so can never fire — and the repo
 * already has one story about a sensor that looked healthy while being structurally unable to
 * speak. Refused at load, in the style of every other limit in this file.
 *
 * 200 is ten windows at the shipped 20, which is enough history for the report to draw where the
 * gap has been without keeping trades from a different era of the code.
 */
export const BROKEN_PAIRS_KEPT = 200

export const READERS = ['entry', 'exit', 'takeprofit', 'risk', 'guard', 'book', 'broken', 'observe', 'decide', 'driver'] as const
export type Reader = (typeof READERS)[number]

/**
 * Every spec key, the modules that may read it, and why it exists.
 *
 * `doc` is prose and may be wrong. `readers` is the contract and cannot be, because a test
 * walks the import graph and fails when a module reads a key that has not named it here.
 * That is the mechanical form of "one switch, one job, every reader declared": the rule the
 * old repo wrote down in a markdown file and then broke in the same week.
 *
 * Keys are dotted paths into FrozenConfig. A key missing from this table is a build failure,
 * so adding a field forces adding its readers.
 */
export type KeySpec = {
  readonly readers: readonly Reader[]
  readonly doc: string
}

export const SPEC: Readonly<Record<string, KeySpec>> = {
  // ---- the book: a complete policy, one entry per leaf ----
  //
  // Paths are written `books.<field>` with the array index collapsed, because a reader that may
  // see book 0's entry delay may see book 1's. The declaration is about which MODULE reads the
  // key, not which book it came from.
  'books.id': { readers: ['book', 'risk', 'decide'], doc: 'the operator\'s name for the policy. The ledger key, the halt scope and the dashboard column.' },
  'books.minCreatorTaxBps': { readers: ['book', 'entry'], doc: 'low end of the creator-tax band, inclusive. Bands must be disjoint.' },
  'books.maxCreatorTaxBps': { readers: ['book', 'entry'], doc: 'high end of the creator-tax band, inclusive.' },
  'books.minExemptions': { readers: ['entry'], doc: 'exempt-wallet floor. 1-2 lose in the current era, 3+ wins.' },
  'books.templateLossBlockMs': { readers: ['entry'], doc: 'how long one real loss blocks that (tax, dev buy, exempts) template.' },
  'books.sizeWei': {
    readers: ['decide', 'risk'],
    doc: 'reviewed ceiling for this book. Zero means declared and not funded. Defaults and overrides cannot exceed it.',
  },
  'books.maxDrawdownWei': { readers: ['risk'], doc: 'this book\'s declared stop ceiling. The live stop is effective size × risk.drawdownStakes over its own closed rows since the epoch base.' },

  'books.entry.entryDelayMs': {
    readers: ['entry', 'decide'],
    doc: 'how long after launch this book arms. The tax bracket clock; a buy sent after 3 s loses.',
  },
  'books.entry.entryFallbackLateMs': {
    readers: ['entry'],
    doc: 'wall-clock fallback when no feed block released the arm in time.',
  },
  'books.entry.maxEntryPriceMultiple': {
    readers: ['entry', 'decide'],
    doc: 'refuse a launch already pumped this far above its fresh price. The graduation guard.',
  },
  'books.entry.buySlippageBps': {
    readers: ['entry', 'decide', 'driver'],
    doc: 'sets minTokensOut on the buy. Read by the driver because it shapes the transaction, not the decision.',
  },

  'books.exit.maxHoldMs': { readers: ['exit', 'decide', 'guard'], doc: 'the clock. Read by guard because the replay walks the same one.' },
  'books.exit.hardStopMultiple': { readers: ['exit', 'decide', 'guard'], doc: 'the floor under a losing position, as a multiple of entry.' },
  'books.exit.deadCoinAfterMs': { readers: ['exit', 'decide', 'guard'], doc: 'when the dead-coin bail arms. Moves with max_hold_ms or not at all.' },
  'books.exit.deadCoinBelowMultiple': { readers: ['exit', 'decide', 'guard'], doc: 'the peak a coin must have reached by then to survive the bail.' },
  'books.exit.graduationExitAt': { readers: ['exit', 'decide'], doc: 'leave with this fraction of sellable supply left. Graduation slams the door.' },
  'books.exit.maxSellAttempts': { readers: ['exit', 'decide'], doc: 'the ONE ceiling on sell attempts.' },
  'books.exit.exitRetryDelayMs': { readers: ['exit', 'driver'], doc: 'delay between sell attempts.' },
  'books.exit.sellFinalMinQuoteOutWei': { readers: ['exit', 'decide'], doc: 'floor of the slippage ladder, pinned on the position. A sell bound only ever refuses.' },

  'books.takeProfit.otherwise': {
    readers: ['takeprofit'],
    doc: 'used when this book\'s adaptive window cannot answer. Returned with ready:false and a reason, never silently.',
  },
  'books.takeProfit.adaptiveWindow': { readers: ['takeprofit', 'guard'], doc: 'how many of this book\'s trailing launches the argmax runs over.' },
  'books.takeProfit.adaptiveHalfLife': { readers: ['takeprofit'], doc: 'exponential launch half-life inside the adaptive window. Zero means equal weights.' },
  'books.takeProfit.adaptiveLossCap': { readers: ['takeprofit'], doc: 'magnitude of the most negative per-launch bar score. Zero means uncapped.' },
  'books.takeProfit.adaptiveProfitCap': { readers: ['takeprofit'], doc: 'magnitude of the most positive per-launch bar score. Zero means uncapped.' },
  'books.takeProfit.adaptiveBars': { readers: ['takeprofit', 'guard'], doc: 'the candidate rungs the argmax chooses between, and the columns the replay scores.' },

  'books.sizing.enabled': { readers: ['observe', 'decide'], doc: 'whether this book scales its dashboard-selected base from the sizing outcome tape.' },
  'books.sizing.referenceSizeWei': { readers: ['observe'], doc: 'fixed simulator stake for sizing outcomes. It never follows the wallet size.' },
  'books.sizing.window': { readers: ['decide'], doc: 'number of clipped selected-policy outcomes in the sizing mean.' },
  'books.sizing.recentWindow': { readers: ['decide'], doc: 'freshest outcomes that must remain positive before strong size is allowed.' },
  'books.sizing.confirmations': { readers: ['decide'], doc: 'consecutive qualifying publications required before strong size is allowed.' },
  'books.sizing.clipStakes': { readers: ['decide'], doc: 'symmetric per-outcome cap in stakes before sizing means are computed.' },
  'books.sizing.strongThreshold': { readers: ['decide'], doc: 'clipped mean required for the strong multiplier.' },
  'books.sizing.weakBps': { readers: ['decide'], doc: 'weak multiplier in basis points of the dashboard base.' },
  'books.sizing.strongBps': { readers: ['decide'], doc: 'strong multiplier in basis points of the dashboard base.' },
  'books.sizing.maxBaseSizeWei': { readers: ['risk', 'decide'], doc: 'pilot ceiling on the dashboard-selected base while sizing is enabled.' },
  'books.sizing.freshMs': { readers: ['decide'], doc: 'maximum reach of a complete sizing window. Stale evidence selects weak size.' },

  'books.guard.window': { readers: ['guard'], doc: 'this book\'s trailing scored launches. The pause sums this many.' },
  'books.guard.recoveryWindow': { readers: ['guard'], doc: 'the freshest slice of that window. The reopen sums this many, and it may not exceed window.' },
  'books.guard.openAt': { readers: ['guard'], doc: 'the fresh window must sum strictly above this many stakes to reopen this book.' },
  'books.guard.shutAt': { readers: ['guard'], doc: 'the main window must sum strictly below this many stakes to pause it. Hysteresis: openAt > shutAt.' },
  'books.guard.settleMs': { readers: ['guard', 'decide'], doc: 'how long this book watches a launch before replaying it. Refused below the replay horizon.' },
  'books.guard.freshMs': { readers: ['guard'], doc: 'the window must fit inside this. Older evidence fails closed: it neither pauses nor reopens.' },
  'books.guard.pnlBar': { readers: ['observe'], doc: 'the column a row with no watch behind it is scored at, which is a seeded row. Must be a scored bar.' },
  'books.guard.maxReadingAgeMs': { readers: ['guard', 'decide'], doc: 'beyond this a reading is stale and this book\'s guard has no opinion.' },

  'simulation.model': { readers: ['observe'], doc: 'versioned residual calibration applied to newly settled simulated outcomes.' },
  'simulation.positiveFactor': { readers: ['observe'], doc: 'multiplier on positive gross simulated returns before paper, adaptive TP and venue guard consume them.' },
  'simulation.negativeFactor': { readers: ['observe'], doc: 'multiplier on negative gross simulated returns before paper, adaptive TP and venue guard consume them.' },

  // ---- the wallet and the machine, which are genuinely one of each ----
  'risk.maxConcurrent': { readers: ['risk'], doc: 'wallet-wide open position ceiling. Zero means no ceiling. Global, never per book: a slot is a nonce.' },
  'risk.maxTradeSizeWei': { readers: ['risk'], doc: 'ceiling on what any book may declare or select from a live size control.' },
  'risk.bankrollWei': { readers: ['risk'], doc: 'ceiling on capital marked deployed at once. Zero means no ceiling. Wallet-wide.' },
  'risk.drawdownStakes': {
    readers: ['risk'],
    doc: 'session stop as a multiple of each book\'s live effective size. The other shut trigger for that book\'s guard; the same recovery rule reopens it. The per-book stop and wallet bar follow a hot size edit automatically.',
  },
  'risk.maxWalletDrawdownWei': {
    readers: ['risk'],
    doc: 'declared ceiling for the wallet drawdown bar. Runtime scale is the sum of every book\'s effective size × drawdown_stakes.',
  },
  'risk.brokenWindow': { readers: ['broken'], doc: 'trades compared against their own replay by the bot-broken halt.' },
  'risk.brokenFactor': { readers: ['broken'], doc: 'what real money makes per unit of replay. The residual after this expectation is the alarm.' },
  'risk.brokenGapPp': { readers: ['broken'], doc: 'halt when our trades come in this many points each below their own replay. Never lifts itself.' },
  'risk.maxLogsStalenessMs': { readers: ['risk', 'decide'], doc: 'refuse entry when the log stream is older than this.' },
  'risk.maxOverlayAgeMs': { readers: ['risk', 'decide'], doc: 'refuse entry when the feed overlay is older than this.' },
  'clock.periodMs': { readers: ['driver'], doc: 'how often the driver emits a clock event WHILE something is open. Bounds the time rules\' resolution.' },
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * REFUSE, NEVER CLAMP.
 *
 * A clamped value is a value the operator did not choose, running with real money, with
 * nothing on screen saying so. Every check below returns a refusal naming the key and what
 * was wrong with it, and a refused spec leaves the previous one in force. That is the same
 * whole-or-nothing discipline the old config reload had, and it is the one part of the old
 * config layer worth carrying over unchanged.
 *
 * Pure: takes already-parsed data. Parsing TOML needs a library, so it happens in io/ and
 * hands the result here. That split is also what lets the whole rule set be tested without
 * a filesystem.
 */

type Raw = Record<string, unknown>

const isObj = (x: unknown): x is Raw => typeof x === 'object' && x !== null && !Array.isArray(x)

function num(at: number, src: Raw, key: string, path: string, lo: number, hi: number): Ok<number> {
  const v = src[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) return no(at, 'config-refused', path, `expected a finite number, got ${JSON.stringify(v)}`)
  if (v < lo || v > hi) return no(at, 'config-refused', path, `${v} is outside [${lo}, ${hi}]`)
  return ok(v)
}

function int(at: number, src: Raw, key: string, path: string, lo: number, hi: number): Ok<number> {
  const r = num(at, src, key, path, lo, hi)
  if (!r.ok) return r
  if (!Number.isInteger(r.value)) return no(at, 'config-refused', path, `${r.value} must be a whole number`)
  return r
}

/**
 * Wei is a decimal STRING in the spec, never a TOML number.
 *
 * A TOML integer is a double once parsed, and 0.08 ETH is 8e16 wei, well past the 2^53 where
 * doubles stop being exact. Writing it as a number would silently round the bankroll.
 */
function wei(at: number, src: Raw, key: string, path: string): Ok<string> {
  const v = src[key]
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return no(at, 'config-refused', path, `expected a decimal wei string, got ${JSON.stringify(v)}`)
  return ok(v)
}

function text(at: number, src: Raw, key: string, path: string): Ok<string> {
  const v = src[key]
  if (typeof v !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(v)) {
    return no(at, 'config-refused', path, `expected 1-64 letters, digits, dot, underscore or hyphen, got ${JSON.stringify(v)}`)
  }
  return ok(v)
}

function table(at: number, src: Raw, key: string): Ok<Raw> {
  const v = src[key]
  if (!isObj(v)) return no(at, 'config-refused', key, `missing the [${key}] table`)
  return ok(v)
}

/** Every unknown key is refused, so a typo cannot be silently ignored into a default. */
function noStrays(at: number, src: Raw, known: readonly string[], path: string): Ok<null> {
  const stray = Object.keys(src).filter((k) => !known.includes(k))
  if (stray.length) return no(at, 'config-refused', path, `unknown key(s): ${stray.join(', ')}`)
  return ok(null)
}

/**
 * THE FOUR POLICY TABLES, each validated by one function so a book and the defaults cannot
 * drift apart.
 *
 * Each takes the already-merged table and the path to report against, so a refusal names
 * `books[1].guard.shut_at` rather than `guard.shut_at` and the operator knows which book they
 * broke. Writing them once is the point: a second copy for the per-book case is exactly how a
 * default and an override end up enforcing different bounds.
 */
function entrySpec(at: number, v: Raw, path: string): Ok<EntrySpec> {
  const stray = noStrays(at, v, ['entry_delay_ms', 'entry_fallback_late_ms', 'max_entry_price_multiple', 'buy_slippage_bps'], path); if (!stray.ok) return stray
  const entryDelayMs = int(at, v, 'entry_delay_ms', `${path}.entry_delay_ms`, 0, 60_000); if (!entryDelayMs.ok) return entryDelayMs
  const entryFallbackLateMs = int(at, v, 'entry_fallback_late_ms', `${path}.entry_fallback_late_ms`, 0, 60_000); if (!entryFallbackLateMs.ok) return entryFallbackLateMs
  const maxEntryPriceMultiple = num(at, v, 'max_entry_price_multiple', `${path}.max_entry_price_multiple`, 1, 1_000); if (!maxEntryPriceMultiple.ok) return maxEntryPriceMultiple
  const buySlippageBps = int(at, v, 'buy_slippage_bps', `${path}.buy_slippage_bps`, 0, 10_000); if (!buySlippageBps.ok) return buySlippageBps
  return ok({
    entryDelayMs: entryDelayMs.value, entryFallbackLateMs: entryFallbackLateMs.value,
    maxEntryPriceMultiple: maxEntryPriceMultiple.value, buySlippageBps: buySlippageBps.value,
  })
}

function exitSpec(at: number, v: Raw, path: string): Ok<ExitSpec> {
  const stray = noStrays(at, v, ['max_hold_ms', 'hard_stop_multiple', 'dead_coin_after_ms', 'dead_coin_below_multiple', 'graduation_exit_at', 'max_sell_attempts', 'exit_retry_delay_ms', 'sell_final_min_quote_out_wei'], path); if (!stray.ok) return stray
  const maxHoldMs = int(at, v, 'max_hold_ms', `${path}.max_hold_ms`, 1_000, 3_600_000); if (!maxHoldMs.ok) return maxHoldMs
  const hardStopMultiple = num(at, v, 'hard_stop_multiple', `${path}.hard_stop_multiple`, 0, 1); if (!hardStopMultiple.ok) return hardStopMultiple
  const deadCoinAfterMs = int(at, v, 'dead_coin_after_ms', `${path}.dead_coin_after_ms`, 0, 3_600_000); if (!deadCoinAfterMs.ok) return deadCoinAfterMs
  const deadCoinBelowMultiple = num(at, v, 'dead_coin_below_multiple', `${path}.dead_coin_below_multiple`, 1, 10); if (!deadCoinBelowMultiple.ok) return deadCoinBelowMultiple
  const graduationExitAt = num(at, v, 'graduation_exit_at', `${path}.graduation_exit_at`, 0, 1); if (!graduationExitAt.ok) return graduationExitAt
  const maxSellAttempts = int(at, v, 'max_sell_attempts', `${path}.max_sell_attempts`, 1, 100); if (!maxSellAttempts.ok) return maxSellAttempts
  const exitRetryDelayMs = int(at, v, 'exit_retry_delay_ms', `${path}.exit_retry_delay_ms`, 0, 60_000); if (!exitRetryDelayMs.ok) return exitRetryDelayMs
  const sellFinalMinQuoteOutWei = wei(at, v, 'sell_final_min_quote_out_wei', `${path}.sell_final_min_quote_out_wei`); if (!sellFinalMinQuoteOutWei.ok) return sellFinalMinQuoteOutWei
  // dead-bail-inside-the-clock. A bail that arms after the clock has already sold can never
  // fire, so the pair would read as configured and do nothing.
  if (deadCoinAfterMs.value >= maxHoldMs.value) {
    return no(at, 'config-refused', `${path}.dead_coin_after_ms`,
      `${deadCoinAfterMs.value}ms is at or past max_hold_ms ${maxHoldMs.value}ms, so the dead-coin bail could never fire`)
  }
  return ok({
    maxHoldMs: maxHoldMs.value, hardStopMultiple: hardStopMultiple.value,
    deadCoinAfterMs: deadCoinAfterMs.value, deadCoinBelowMultiple: deadCoinBelowMultiple.value,
    graduationExitAt: graduationExitAt.value, maxSellAttempts: maxSellAttempts.value,
    exitRetryDelayMs: exitRetryDelayMs.value, sellFinalMinQuoteOutWei: sellFinalMinQuoteOutWei.value,
  })
}

function takeProfitSpec(at: number, v: Raw, path: string): Ok<TakeProfitSpec> {
  const stray = noStrays(at, v, [
    'otherwise', 'adaptive_window', 'adaptive_half_life', 'adaptive_loss_cap',
    'adaptive_profit_cap', 'adaptive_bars',
  ], path); if (!stray.ok) return stray
  const otherwise = num(at, v, 'otherwise', `${path}.otherwise`, 1, 100); if (!otherwise.ok) return otherwise
  const adaptiveWindow = int(at, v, 'adaptive_window', `${path}.adaptive_window`, 1, 1_000); if (!adaptiveWindow.ok) return adaptiveWindow
  const adaptiveHalfLife = num(at, v, 'adaptive_half_life', `${path}.adaptive_half_life`, 0, 1_000); if (!adaptiveHalfLife.ok) return adaptiveHalfLife
  const adaptiveLossCap = num(at, v, 'adaptive_loss_cap', `${path}.adaptive_loss_cap`, 0, 100); if (!adaptiveLossCap.ok) return adaptiveLossCap
  const adaptiveProfitCap = num(at, v, 'adaptive_profit_cap', `${path}.adaptive_profit_cap`, 0, 100); if (!adaptiveProfitCap.ok) return adaptiveProfitCap
  const barsRaw = v['adaptive_bars']
  if (!Array.isArray(barsRaw) || barsRaw.length < 1) return no(at, 'config-refused', `${path}.adaptive_bars`, 'expected a non-empty array')
  const bars: number[] = []
  for (const b of barsRaw) {
    if (typeof b !== 'number' || !Number.isFinite(b) || b <= 1) return no(at, 'config-refused', `${path}.adaptive_bars`, `every bar must be a number above 1, got ${JSON.stringify(b)}`)
    bars.push(b)
  }
  // take-profit-bars-sorted: the argmax reports the FIRST best bar, so ties break on order.
  // An unsorted list would make the pinned rung depend on how the operator typed it.
  for (let i = 1; i < bars.length; i++) {
    if (bars[i]! <= bars[i - 1]!) return no(at, 'config-refused', `${path}.adaptive_bars`, `must be strictly ascending: ${bars[i - 1]} then ${bars[i]}`)
  }
  return ok({
    otherwise: otherwise.value,
    adaptiveWindow: adaptiveWindow.value,
    adaptiveHalfLife: adaptiveHalfLife.value,
    adaptiveLossCap: adaptiveLossCap.value,
    adaptiveProfitCap: adaptiveProfitCap.value,
    adaptiveBars: bars,
  })
}

function guardSpec(at: number, v: Raw, path: string, bars: readonly number[]): Ok<GuardSpec> {
  const stray = noStrays(at, v, ['window', 'recovery_window', 'open_at', 'shut_at', 'settle_ms', 'fresh_ms', 'pnl_bar', 'max_reading_age_ms'], path); if (!stray.ok) return stray
  const window = int(at, v, 'window', `${path}.window`, 1, 10_000); if (!window.ok) return window
  const recoveryWindow = int(at, v, 'recovery_window', `${path}.recovery_window`, 1, 10_000); if (!recoveryWindow.ok) return recoveryWindow
  // recovery-fits-main. The fresh slice is drawn FROM the main window, so a longer one would
  // reopen on rows the pause never saw and the two thresholds would be reading different
  // populations. Equal is allowed: that is the single-window guard, spelled out.
  if (recoveryWindow.value > window.value) {
    return no(at, 'config-refused', `${path}.recovery_window`,
      `${recoveryWindow.value} exceeds window ${window.value}: the fresh slice is drawn from the main window and cannot be longer than it`)
  }
  const openAt = num(at, v, 'open_at', `${path}.open_at`, -20, 20); if (!openAt.ok) return openAt
  const shutAt = num(at, v, 'shut_at', `${path}.shut_at`, -20, 20); if (!shutAt.ok) return shutAt
  // guard-hysteresis
  if (openAt.value <= shutAt.value) return no(at, 'config-refused', path, `open_at ${openAt.value} must exceed shut_at ${shutAt.value}, or the gate oscillates on one sample`)
  const settleMs = int(at, v, 'settle_ms', `${path}.settle_ms`, 1_000, 3_600_000); if (!settleMs.ok) return settleMs
  // settle-covers-replay. The walk buys at entry_blk and runs horizon blocks past it, so a
  // launch settled sooner is scored on a path whose tail never arrived. The error is not
  // noise, it is one-directional: the missing tail is where the winners are.
  if (settleMs.value < SIM_WINDOW_MS) {
    return no(at, 'config-refused', `${path}.settle_ms`,
      `${settleMs.value}ms is below the ${SIM_WINDOW_MS}ms the replay walks. Every launch would be scored on a truncated path.`)
  }
  const freshMs = int(at, v, 'fresh_ms', `${path}.fresh_ms`, 60_000, 7 * 24 * 3_600_000); if (!freshMs.ok) return freshMs
  const pnlBar = num(at, v, 'pnl_bar', `${path}.pnl_bar`, 1, 100); if (!pnlBar.ok) return pnlBar
  // indicator-bar-is-scored. The replay only produces the bars in this book's adaptive_bars,
  // so an indicator pointed at any other bar reads a column that is never written and the
  // venue sensor silently has no rows at all. Checked against THIS book's bars, which is why
  // the bar set is a parameter rather than read from a top-level table that no longer exists.
  if (!bars.some((b) => b === pnlBar.value)) {
    return no(at, 'config-refused', `${path}.pnl_bar`,
      `${pnlBar.value} is not in this book's take_profit.adaptive_bars [${bars.join(', ')}], so the replay never scores that column`)
  }
  const maxReadingAgeMs = int(at, v, 'max_reading_age_ms', `${path}.max_reading_age_ms`, 1_000, 7 * 24 * 3_600_000); if (!maxReadingAgeMs.ok) return maxReadingAgeMs
  return ok({
    window: window.value, recoveryWindow: recoveryWindow.value,
    openAt: openAt.value, shutAt: shutAt.value,
    settleMs: settleMs.value, freshMs: freshMs.value, pnlBar: pnlBar.value,
    maxReadingAgeMs: maxReadingAgeMs.value,
  })
}

function simulationSpec(at: number, v: Raw): Ok<SimulationSpec> {
  const stray = noStrays(at, v, ['model', 'positive_factor', 'negative_factor'], 'simulation'); if (!stray.ok) return stray
  const model = text(at, v, 'model', 'simulation.model'); if (!model.ok) return model
  const positiveFactor = num(at, v, 'positive_factor', 'simulation.positive_factor', 0, 2); if (!positiveFactor.ok) return positiveFactor
  const negativeFactor = num(at, v, 'negative_factor', 'simulation.negative_factor', 0, 2); if (!negativeFactor.ok) return negativeFactor
  if (positiveFactor.value === 0) return no(at, 'config-refused', 'simulation.positive_factor', 'must be above zero so a win cannot become flat')
  if (negativeFactor.value === 0) return no(at, 'config-refused', 'simulation.negative_factor', 'must be above zero so a loss cannot become flat')
  return ok({ model: model.value, positiveFactor: positiveFactor.value, negativeFactor: negativeFactor.value })
}

const BOOK_KEYS = [
  'id', 'min_creator_tax_bps', 'max_creator_tax_bps', 'min_exemptions', 'template_loss_block_ms',
  'size_wei', 'entry', 'exit', 'take_profit', 'guard', 'sizing',
] as const

function sizingSpec(at: number, v: Raw, path: string): Ok<SizingSpec> {
  const stray = noStrays(at, v, [
    'enabled', 'reference_size_wei', 'window', 'recent_window', 'confirmations',
    'clip_stakes', 'strong_threshold', 'weak_bps', 'strong_bps', 'max_base_size_wei', 'fresh_ms',
  ], path); if (!stray.ok) return stray
  if (typeof v['enabled'] !== 'boolean') return no(at, 'config-refused', `${path}.enabled`, 'expected a boolean')
  const referenceSizeWei = wei(at, v, 'reference_size_wei', `${path}.reference_size_wei`); if (!referenceSizeWei.ok) return referenceSizeWei
  const window = int(at, v, 'window', `${path}.window`, 1, 1_000); if (!window.ok) return window
  const recentWindow = int(at, v, 'recent_window', `${path}.recent_window`, 1, 1_000); if (!recentWindow.ok) return recentWindow
  if (recentWindow.value > window.value) return no(at, 'config-refused', `${path}.recent_window`, `${recentWindow.value} exceeds window ${window.value}`)
  const confirmations = int(at, v, 'confirmations', `${path}.confirmations`, 1, 20); if (!confirmations.ok) return confirmations
  const clipStakes = num(at, v, 'clip_stakes', `${path}.clip_stakes`, 0.000_001, 100); if (!clipStakes.ok) return clipStakes
  const strongThreshold = num(at, v, 'strong_threshold', `${path}.strong_threshold`, 0, 100); if (!strongThreshold.ok) return strongThreshold
  const weakBps = int(at, v, 'weak_bps', `${path}.weak_bps`, 1, 10_000); if (!weakBps.ok) return weakBps
  const strongBps = int(at, v, 'strong_bps', `${path}.strong_bps`, 10_000, 100_000); if (!strongBps.ok) return strongBps
  const maxBaseSizeWei = wei(at, v, 'max_base_size_wei', `${path}.max_base_size_wei`); if (!maxBaseSizeWei.ok) return maxBaseSizeWei
  const freshMs = int(at, v, 'fresh_ms', `${path}.fresh_ms`, 60_000, 7 * 24 * 3_600_000); if (!freshMs.ok) return freshMs
  return ok({
    enabled: v['enabled'], referenceSizeWei: referenceSizeWei.value,
    window: window.value, recentWindow: recentWindow.value, confirmations: confirmations.value,
    clipStakes: clipStakes.value, strongThreshold: strongThreshold.value,
    weakBps: weakBps.value, strongBps: strongBps.value,
    maxBaseSizeWei: maxBaseSizeWei.value, freshMs: freshMs.value,
  })
}

/**
 * A book's own table laid over the defaults, KEY BY KEY, one level deep.
 *
 * One level is deliberate. Overriding `[books.guard]` replaces only the guard keys the book
 * names and keeps the rest of the default guard, which is what an operator means by "this book
 * pauses at -3 instead". A whole-table replace would silently drop every key they did not
 * retype, and the missing ones would then fail validation somewhere far from the edit.
 */
function merged(defaults: Raw, own: unknown, table: string): Raw {
  const base = isObj(defaults[table]) ? (defaults[table] as Raw) : {}
  const over = isObj(own) ? own : {}
  return { ...base, ...over }
}

/** Session stop in wei: size × the pinned stake multiple. Exact integer, no float. */
export function sessionStopWei(sizeWei: string, drawdownStakes: number): string {
  return (BigInt(sizeWei) * BigInt(drawdownStakes)).toString()
}

/** The requested stake for this book before the reviewed spec ceiling is applied. */
export function requestedBookSizeWei(book: BookSpec, switches: Switches | bigint): bigint {
  if (typeof switches === 'bigint') return switches
  return switches.bookSizes?.get(book.id)?.sizeWei ?? switches.sizeWei
}

/** Maximum operator-selected 1x base while the book's sizing policy is active. */
export function bookBaseCeilingWei(book: BookSpec): bigint {
  const declared = BigInt(book.sizeWei)
  const pilot = book.sizing?.enabled ? BigInt(book.sizing.maxBaseSizeWei) : declared
  return pilot < declared ? pilot : declared
}

/** The stake a book can actually place under its override, default and reviewed ceiling. */
export function effectiveBookSizeWei(book: BookSpec, switches: Switches | bigint): bigint {
  const declared = bookBaseCeilingWei(book)
  const requested = requestedBookSizeWei(book, switches)
  return declared < requested ? declared : requested
}

/** A book's live stop always follows its effective stake. */
export function effectiveBookDrawdownWei(
  cfg: FrozenConfig,
  book: BookSpec,
  switches: Switches | bigint,
): bigint {
  // Historical config-applied rows predate drawdownStakes. Their recorded wei stop is the only
  // rule they carried, so replay must keep using it rather than inventing today's multiplier.
  if (!Number.isInteger(cfg.risk.drawdownStakes)) return BigInt(book.maxDrawdownWei)
  return effectiveBookSizeWei(book, switches) * BigInt(cfg.risk.drawdownStakes)
}

/** The wallet bar is the sum of the live stops for every funded book. */
export function effectiveWalletDrawdownWei(cfg: FrozenConfig, switches: Switches | bigint): bigint {
  if (!Number.isInteger(cfg.risk.drawdownStakes)) return BigInt(cfg.risk.maxWalletDrawdownWei)
  let total = 0n
  for (const book of cfg.books) total += effectiveBookDrawdownWei(cfg, book, switches)
  return total
}

function book(at: number, src: Raw, i: number, defaults: Raw, maxTradeSizeWei: string, drawdownStakes: number): Ok<BookSpec> {
  const path = `books[${i}]`
  const strays = noStrays(at, src, BOOK_KEYS, path); if (!strays.ok) return strays
  const id = src['id']
  if (typeof id !== 'string' || !/^[a-zA-Z0-9]{1,24}$/.test(id)) {
    // Ids become SQL identifiers and DOM ids downstream, so the character set is load-bearing.
    return no(at, 'config-refused', `${path}.id`, `expected 1-24 alphanumeric characters, got ${JSON.stringify(id)}`)
  }
  const lo = int(at, src, 'min_creator_tax_bps', `${path}.min_creator_tax_bps`, 0, 10_000); if (!lo.ok) return lo
  const hi = int(at, src, 'max_creator_tax_bps', `${path}.max_creator_tax_bps`, 0, 10_000); if (!hi.ok) return hi
  if (lo.value > hi.value) return no(at, 'config-refused', path, `inverted band ${lo.value}-${hi.value}`)
  const ex = int(at, src, 'min_exemptions', `${path}.min_exemptions`, 0, 100); if (!ex.ok) return ex
  const tl = int(at, src, 'template_loss_block_ms', `${path}.template_loss_block_ms`, 0, 24 * 3_600_000); if (!tl.ok) return tl
  const sizeWei = wei(at, src, 'size_wei', `${path}.size_wei`); if (!sizeWei.ok) return sizeWei
  // book-size-under-ceiling. `risk.max_trade_size_wei` is the hard ceiling on what any book may
  // declare, checked here rather than only against the switch, so a spec cannot commit more per
  // launch than the wallet has ever agreed to.
  if (BigInt(sizeWei.value) > BigInt(maxTradeSizeWei)) {
    return no(at, 'config-refused', `${path}.size_wei`, `${sizeWei.value} exceeds risk.max_trade_size_wei ${maxTradeSizeWei}`)
  }

  const entry = entrySpec(at, merged(defaults, src['entry'], 'entry'), `${path}.entry`); if (!entry.ok) return entry
  const exit = exitSpec(at, merged(defaults, src['exit'], 'exit'), `${path}.exit`); if (!exit.ok) return exit
  const takeProfit = takeProfitSpec(at, merged(defaults, src['take_profit'], 'take_profit'), `${path}.take_profit`); if (!takeProfit.ok) return takeProfit
  const guard = guardSpec(at, merged(defaults, src['guard'], 'guard'), `${path}.guard`, takeProfit.value.adaptiveBars); if (!guard.ok) return guard
  const sizingRaw = merged(defaults, src['sizing'], 'sizing')
  const sizing = Object.keys(sizingRaw).length ? sizingSpec(at, sizingRaw, `${path}.sizing`) : null
  if (sizing !== null && !sizing.ok) return sizing
  if (sizing?.value.enabled) {
    const declared = BigInt(sizeWei.value)
    const maxBase = BigInt(sizing.value.maxBaseSizeWei)
    if (declared > 0n && maxBase > declared) return no(at, 'config-refused', `${path}.sizing.max_base_size_wei`, `${maxBase} exceeds base ceiling ${declared}`)
    const maxAdaptive = (maxBase * BigInt(sizing.value.strongBps)) / 10_000n
    if (maxAdaptive > BigInt(maxTradeSizeWei)) {
      return no(at, 'config-refused', `${path}.sizing.strong_bps`, `${maxAdaptive} wei adaptive maximum exceeds risk.max_trade_size_wei ${maxTradeSizeWei}`)
    }
  }

  return ok({
    id, minCreatorTaxBps: lo.value, maxCreatorTaxBps: hi.value,
    minExemptions: ex.value, templateLossBlockMs: tl.value,
    sizeWei: sizeWei.value, maxDrawdownWei: sessionStopWei(sizeWei.value, drawdownStakes),
    entry: entry.value, exit: exit.value, takeProfit: takeProfit.value, guard: guard.value,
    ...(sizing === null ? {} : { sizing: sizing.value }),
  })
}

/**
 * Turn parsed TOML into a FrozenConfig, or say exactly why not.
 *
 * `at` is the `at` of the event carrying the change, so a refusal is timestamped by the tape
 * rather than by a clock.
 *
 * RISK IS READ FIRST, because `risk.max_trade_size_wei` bounds every book's declared size and
 * a book cannot be judged without it.
 */
export function validate(at: number, raw: unknown): Ok<FrozenConfig> {
  if (!isObj(raw)) return no(at, 'config-refused', 'spec', 'the spec is not a table')
  const strays = noStrays(at, raw, ['spec_version', 'defaults', 'books', 'simulation', 'risk', 'clock'], 'spec')
  if (!strays.ok) return strays

  const specVersion = int(at, raw, 'spec_version', 'spec_version', 1, 1_000_000); if (!specVersion.ok) return specVersion

  let simulation: SimulationSpec | undefined
  if (raw['simulation'] === undefined) {
    // Spec v1 predates residual calibration. Keeping the field absent preserves both its raw
    // behaviour and its historical config digest during replay.
    if (specVersion.value >= 2) return no(at, 'config-refused', 'simulation', 'spec_version 2 requires the [simulation] table')
  } else {
    const simulationTable = table(at, raw, 'simulation'); if (!simulationTable.ok) return simulationTable
    const parsed = simulationSpec(at, simulationTable.value); if (!parsed.ok) return parsed
    simulation = parsed.value
  }

  const r = table(at, raw, 'risk'); if (!r.ok) return r
  const rStray = noStrays(at, r.value, ['max_concurrent', 'max_trade_size_wei', 'bankroll_wei', 'drawdown_stakes', 'broken_window', 'broken_factor', 'broken_gap_pp', 'max_logs_staleness_ms', 'max_overlay_age_ms'], 'risk'); if (!rStray.ok) return rStray
  const maxConcurrent = int(at, r.value, 'max_concurrent', 'risk.max_concurrent', 0, 1_000); if (!maxConcurrent.ok) return maxConcurrent
  const maxTradeSizeWei = wei(at, r.value, 'max_trade_size_wei', 'risk.max_trade_size_wei'); if (!maxTradeSizeWei.ok) return maxTradeSizeWei
  const bankrollWei = wei(at, r.value, 'bankroll_wei', 'risk.bankroll_wei'); if (!bankrollWei.ok) return bankrollWei
  // 1 is the v1 floor (a stop under one stake fires on a single ordinary loss). 20 is
  // enough room for a typo to be refused rather than silently becoming a 20-trade leash.
  const drawdownStakes = int(at, r.value, 'drawdown_stakes', 'risk.drawdown_stakes', 1, 20); if (!drawdownStakes.ok) return drawdownStakes
  const brokenWindow = int(at, r.value, 'broken_window', 'risk.broken_window', 1, BROKEN_PAIRS_KEPT); if (!brokenWindow.ok) return brokenWindow
  const brokenFactor = num(at, r.value, 'broken_factor', 'risk.broken_factor', 0, 10); if (!brokenFactor.ok) return brokenFactor
  const brokenGapPp = num(at, r.value, 'broken_gap_pp', 'risk.broken_gap_pp', 1, 100); if (!brokenGapPp.ok) return brokenGapPp
  const maxLogsStalenessMs = int(at, r.value, 'max_logs_staleness_ms', 'risk.max_logs_staleness_ms', 100, 3_600_000); if (!maxLogsStalenessMs.ok) return maxLogsStalenessMs
  const maxOverlayAgeMs = int(at, r.value, 'max_overlay_age_ms', 'risk.max_overlay_age_ms', 100, 3_600_000); if (!maxOverlayAgeMs.ok) return maxOverlayAgeMs

  const defaults = isObj(raw['defaults']) ? (raw['defaults'] as Raw) : {}
  const dStray = noStrays(at, defaults, ['entry', 'exit', 'take_profit', 'guard', 'sizing'], 'defaults'); if (!dStray.ok) return dStray

  const rawBooks = raw['books']
  /**
   * The ceiling on how many books may exist, and why there is one at all.
   *
   * The bound stays rather than going away because an unbounded list is a way to make the
   * page unreadable and the funnel meaningless, and because a spec with 400 books is a
   * typo, not a strategy. It is not a trading cap.
   *
   * WAS 4 until 2026-09-16. Nothing measured chose 4; it was the number of books that existed
   * when the validator was written, which is the worst reason for a limit.
   */
  if (!Array.isArray(rawBooks) || rawBooks.length < 1 || rawBooks.length > MAX_BOOKS) {
    return no(at, 'config-refused', 'books', `expected 1 to ${MAX_BOOKS} [[books]] entries, got ${Array.isArray(rawBooks) ? rawBooks.length : typeof rawBooks}`)
  }
  const books: BookSpec[] = []
  for (let i = 0; i < rawBooks.length; i++) {
    const entry = rawBooks[i]
    if (!isObj(entry)) return no(at, 'config-refused', `books[${i}]`, 'not a table')
    const b = book(at, entry, i, defaults, maxTradeSizeWei.value, drawdownStakes.value); if (!b.ok) return b
    books.push(b.value)
  }
  if (specVersion.value >= 3 && books.some((b) => b.sizing === undefined)) {
    return no(at, 'config-refused', 'books.sizing', 'spec_version 3 requires a resolved sizing policy for every book')
  }

  // books-unique-ids
  const ids = books.map((b) => b.id)
  const dupe = ids.find((id, i) => ids.indexOf(id) !== i)
  if (dupe !== undefined) return no(at, 'config-refused', 'books', `duplicate book id ${dupe}: the id is the ledger key, so two books would merge silently`)

  // books-disjoint. The invariant everything downstream rests on, so it is checked here and
  // nowhere else has to cope with the alternative.
  for (let i = 0; i < books.length; i++) {
    for (let j = i + 1; j < books.length; j++) {
      const a = books[i]!, b = books[j]!
      if (a.minCreatorTaxBps <= b.maxCreatorTaxBps && b.minCreatorTaxBps <= a.maxCreatorTaxBps) {
        return no(at, 'config-refused', 'books', `bands overlap: ${a.id} ${a.minCreatorTaxBps}-${a.maxCreatorTaxBps} and ${b.id} ${b.minCreatorTaxBps}-${b.maxCreatorTaxBps}. A launch would route to two books.`)
      }
    }
  }

  // Wallet bar = the sum of the derived book stops. A size-0 book contributes 0, so an
  // unfunded control arm does not inflate the scale the funded book is read against.
  let need = 0n
  for (const b of books) need += BigInt(b.maxDrawdownWei)

  const c = table(at, raw, 'clock'); if (!c.ok) return c
  const cStray = noStrays(at, c.value, ['period_ms'], 'clock'); if (!cStray.ok) return cStray
  const periodMs = int(at, c.value, 'period_ms', 'clock.period_ms', 10, 60_000); if (!periodMs.ok) return periodMs

  return ok({
    specVersion: specVersion.value,
    books,
    ...(simulation === undefined ? {} : { simulation }),
    risk: {
      maxConcurrent: maxConcurrent.value, maxTradeSizeWei: maxTradeSizeWei.value,
      bankrollWei: bankrollWei.value,
      drawdownStakes: drawdownStakes.value,
      maxWalletDrawdownWei: need.toString(),
      brokenWindow: brokenWindow.value, brokenFactor: brokenFactor.value, brokenGapPp: brokenGapPp.value,
      maxLogsStalenessMs: maxLogsStalenessMs.value, maxOverlayAgeMs: maxOverlayAgeMs.value,
    },
    clock: { periodMs: periodMs.value },
  })
}

/**
 * Clamp a size switch to the spec ceiling, or refuse it.
 *
 * Refuses rather than clamping, for the same reason as everything else here: an operator who
 * typed 0.05 and got 0.02 has a wrong belief about what the bot is doing.
 */
export function checkSize(at: number, wanted: bigint, cfg: FrozenConfig): Ok<bigint> {
  if (wanted <= 0n) return no(at, 'switch-refused', 'size', `size must be positive, got ${wanted}`)
  const ceiling = BigInt(cfg.risk.maxTradeSizeWei)
  if (wanted > ceiling) return no(at, 'switch-refused', 'size', `${wanted} exceeds risk.max_trade_size_wei ${ceiling}`)
  return ok(wanted)
}

/** Validate one dashboard-selected book size without clamping or changing halt state. */
export function checkBookSize(at: number, wanted: bigint, cfg: FrozenConfig, bookId: string): Ok<bigint> {
  const book = cfg.books.find((candidate) => candidate.id === bookId)
  if (!book) return no(at, 'switch-refused', bookId, `no book named ${bookId}`)
  const declared = BigInt(book.sizeWei)
  if (declared === 0n) return no(at, 'switch-refused', bookId, `${bookId} is declared but unfunded`)
  if (wanted < MIN_BOOK_TRADE_SIZE_WEI) {
    return no(at, 'switch-refused', bookId, `${wanted} is below the ${MIN_BOOK_TRADE_SIZE_WEI} wei minimum`)
  }
  const riskCeiling = BigInt(cfg.risk.maxTradeSizeWei)
  const declaredCeiling = bookBaseCeilingWei(book)
  const ceiling = declaredCeiling < riskCeiling ? declaredCeiling : riskCeiling
  if (wanted > ceiling) return no(at, 'switch-refused', bookId, `${wanted} exceeds ${bookId}'s ${ceiling} wei ceiling`)
  return ok(wanted)
}
/** Time before an unresolved curve sell needs receipt recovery and an operator alert. */
export const SELL_SETTLE_GIVEUP_MS = 15_000
