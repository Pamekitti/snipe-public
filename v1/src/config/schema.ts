/**
 * Every setting an operator can change, declared exactly once.
 *
 * WHY THIS FILE EXISTS. Changing four numbers on 2026-09-06 took twenty minutes, three
 * restarts of a live process, and a silent failure in which the bot reported the old trade
 * size while claiming the restart had succeeded. Two causes, both structural:
 *
 *   Two sources of truth. `import 'dotenv/config'` never overrides a variable that is
 *   already in process.env, and pm2 replays its own saved copy of the environment on every
 *   `pm2 restart --update-env`. So pm2's stale TRADE_SIZE_ETH beat the edited .env file and
 *   nothing said so. Only `pm2 delete` + `pm2 start` cleared it.
 *
 *   Config frozen at import. STRATEGY and RISK were built from process.env when the module
 *   first loaded, so the only way to move a number was to restart, and restarting is the
 *   one routine act that can strand an open bag.
 *
 * Everything downstream derives from the table below, so a number cannot drift between the
 * code, the dashboard, the docs and the tests: parsing, range validation, the hot/restart
 * split, the .env.example completeness test, and the audit trail of what changed when.
 *
 * ADDING A SETTING: add a row here and mention the env var in .env.example. Nothing else.
 */

/** UTC hours, half-open [from, to). */
export type EntryWindow = { from: number; to: number }

export type FieldKind = 'number' | 'flag' | 'window' | 'string' | 'books'

/**
 * One book: a name the operator chose and the creator-tax band it is allowed to buy.
 *
 * The bands of the configured books must be DISJOINT, and `crossCheck` refuses the config
 * outright if they are not. That single rule is what keeps everything downstream simple: a
 * launch has one creator tax, so it routes to at most one book, so no launch is ever bought
 * twice, no position is shared, and nothing anywhere needs an arbiter. Overlapping books are
 * a non-goal that fails loudly at config load rather than quietly at the wallet.
 */
export type Book = { id: string; minTaxBps: number; maxTaxBps: number }

/**
 * `hot`     the running process re-reads it from the file; a change applies without a restart.
 * `restart` the value is captured once at construction (a client, a signer, a class field),
 *           so a file edit CANNOT take effect. The reload reports the change and refuses it
 *           rather than applying half of it.
 */
export type Scope = 'hot' | 'restart'

/**
 * `per-trade` pinned onto a position when it opens, so a change never moves the rules under
 *             a bag that is already held.
 * `account`   read live at the point of use; a change applies at once, to everything.
 */
export type Applies = 'per-trade' | 'account'

export type Field = {
  /** the environment variable, which is also the key in .env */
  env: string
  kind: FieldKind
  /** the value when the variable is unset or blank */
  def: number | boolean | string | null
  /** inclusive bounds for `number`. A value outside them is REFUSED, not clamped. */
  min?: number
  max?: number
  scope: Scope
  applies: Applies
  doc: string
}

/**
 * "12-21" -> { from: 12, to: 21 }, hours UTC, half-open [from, to). An empty or
 * unparseable string is null, which means the window is OFF: an operator who blanks the
 * variable gets no window, not a silently wrong one.
 */
export function parseEntryWindow(s: string | undefined): EntryWindow | null {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(s ?? '')
  if (!m) return null
  const from = Number(m[1]), to = Number(m[2])
  if (from < 0 || from > 23 || to < 0 || to > 24 || from === to) return null
  return { from, to }
}

/**
 * THE HOT SETTINGS: money and book shape. Each one is read fresh at its point of use, so
 * swapping the snapshot is enough to move it.
 *
 * The bounds are deliberately wide enough to be operationally useful and narrow enough to
 * refuse a typo. A refused value keeps the PREVIOUS one and raises a crit alert, because
 * the alternative (a bot that halts on every launch with 'above size ceiling', which is
 * what an out-of-range TRADE_SIZE_ETH used to do) looks like a dead bot rather than a bad
 * edit.
 */
export const HOT = {
  venueExecutionScenarios: {
    env: 'VENUE_EXECUTION_SCENARIOS', kind: 'flag', def: false, scope: 'hot', applies: 'account',
    doc: 'use the selected six-scenario guard. Requires a matching release, historical fidelity and prospective certification. Missing evidence blocks entries.',
  },
  venueFreshRecovery: {
    env: 'VENUE_FRESH_RECOVERY', kind: 'flag', def: false, scope: 'hot', applies: 'account',
    doc: 'use the verified adaptive shadow indicator and selected 20/-1, latest-8/+1 fresh recovery. Missing evidence pauses entries.',
  },
  tradeSizeEth: {
    env: 'TRADE_SIZE_ETH', kind: 'number', def: 0.01, min: 0.0005, max: 0.02,
    scope: 'hot', applies: 'per-trade',
    doc: 'stake per entry, ETH. The max is STRATEGY.maxTradeSizeEth: P&L peaks there and is negative by 0.05.',
  },
  bankrollEth: {
    env: 'BANKROLL_ETH', kind: 'number', def: 0.08, min: 0.001, max: 1,
    scope: 'hot', applies: 'account',
    doc: 'ceiling on capital deployed at once, ETH. Divided by the trade size, it is the concurrency the wallet affords.',
  },
  /**
   * THE CREATOR-TAX BAND THE BOOK TRADES, both bounds inclusive.
   *
   * Hot on purpose. A filter that costs a deploy and a restart to revert is a filter nobody
   * reverts at 3am, and this pair decides which launches get real money. The 2026-09-15
   * daily edge check had the floor failing (7d replay/trade: taxed -2.0% on n=4,918 against
   * untaxed +5.1% on n=7,602) while the live book was down $960 over 284 trades at a 25%
   * win rate, so the band had to become operable rather than compiled in.
   *
   * A BAND, not a floor. The floor alone could not express "untaxed only": ENTRY_MIN_TAX_BPS=0
   * admits every tax from 0 to 200. 0/0 admits untaxed launches and nothing else.
   *
   * NEITHER ONE TOUCHES THE BOOK SCREEN. STRATEGY.maxCreatorTaxBps still sets launches.passed
   * at 200 and is not an operator setting, because the screen defines the observation
   * universe every sensor and every edge check measures against. Narrowing it would delete
   * the control group rather than change the book (the 08-27 gate starvation).
   */
  /**
   * THE BOOKS, or blank for exactly one book from the two keys below.
   *
   *   BOOKS=untaxed:0-0,taxed:50-10000
   *
   * Why more than one: the whole book moved to untaxed-only on 2026-09-15 on evidence that
   * the taxed book was losing (7d replay/trade taxed -2.0% on n=4,918 against untaxed +5.1%
   * on n=7,602). That evidence is good and it is not proof. The study behind it also had
   * untaxed losing the earlier of its two weeks at nearly three times the drawdown, and its
   * edge is confounded with the venue guard, because the guard's outcome tape IS the set of
   * launches the book admits. Change the filter and you change the sensor. One band at a
   * time cannot separate those; two bands side by side on the same evidence can.
   *
   * Blank or unset is ONE book from ENTRY_MIN_TAX_BPS / ENTRY_MAX_TAX_BPS, which is exactly
   * the behaviour that shipped before this key existed. Setting BOOKS alongside either of
   * those is refused rather than merged: the band would be declared twice, and
   * liveEntryConfig(), bookFloors() and strategySpec() would publish a band nobody trades.
   */
  books: {
    env: 'BOOKS', kind: 'books', def: '',
    scope: 'hot', applies: 'account',
    doc: 'the books to trade, as name:minBps-maxBps, comma separated, up to 4. Blank = one book from ENTRY_MIN_TAX_BPS/ENTRY_MAX_TAX_BPS. Bands must not overlap.',
  },
  entryMinTaxBps: {
    env: 'ENTRY_MIN_TAX_BPS', kind: 'number', def: 50, min: 0, max: 10000,
    scope: 'hot', applies: 'account',
    doc: 'lowest creator tax the book will buy, bps, inclusive. 0 admits untaxed launches.',
  },
  entryMaxTaxBps: {
    env: 'ENTRY_MAX_TAX_BPS', kind: 'number', def: 10000, min: 0, max: 10000,
    scope: 'hot', applies: 'account',
    doc: 'highest creator tax the book will buy, bps, inclusive. Set equal to the floor to pin an exact band; the screen still refuses anything over STRATEGY.maxCreatorTaxBps.',
  },
  /**
   * THE KILL SWITCH, in ETH. Denominated in the same unit as TRADE_SIZE_ETH on purpose:
   * divided by the trade size it IS the stake multiple, which is the number every replay
   * fits (5.6 stakes = 0.112 ETH at 0.02). It was in dollars until 2026-09-07 and that
   * coupled it to ETHUSD, so a stale price silently moved the stop: at a configured $2145
   * against a real $2515 the "$240" limit was really $282, 17% wider than it read. The
   * ledger it is compared against has always been wei (risk.ts realizedPnlWei,
   * chain_truth.peak_flat_wei), so this unit also removes a conversion rather than adding one.
   */
  /**
   * THE WALLET-WIDE STOP, in ETH, measured against the real balance rather than the ledger.
   *
   * There are two drawdowns and they are not the same instrument. MAX_DRAWDOWN_ETH is an
   * accounting figure over closed `positions` rows, so it splits per book. The chain stop in
   * telemetry/truth.ts compares the WALLET against peak_flat_wei, so it cannot be attributed
   * to a book at all. Until this key existed both fired at the same number, which means two
   * books each allowed 0.015 sat behind a wallet stop that fired at 0.015 TOTAL: neither book
   * could ever reach its own limit and per-book drawdown would have appeared to work while
   * quietly doing nothing. That is the worst possible bug in a risk control, so the wallet
   * limit is now its own number and crossCheck refuses it below the per-book one.
   *
   * 0 means "derive": books x MAX_DRAWDOWN_ETH, resolved in store.ts build(). With one book
   * that is exactly MAX_DRAWDOWN_ETH, which is exactly today.
   */
  maxWalletDrawdownEth: {
    env: 'MAX_WALLET_DRAWDOWN_ETH', kind: 'number', def: 0, min: 0, max: 100,
    scope: 'hot', applies: 'account',
    doc: 'the wallet-wide kill switch, ETH from the peak flat balance, across every book. 0 = derive it as books x MAX_DRAWDOWN_ETH. Never below MAX_DRAWDOWN_ETH.',
  },
  maxDrawdownEth: {
    env: 'MAX_DRAWDOWN_ETH', kind: 'number', def: 0.06, min: 0.001, max: 100,
    scope: 'hot', applies: 'account',
    doc: 'the kill switch, ETH from the peak. Divided by TRADE_SIZE_ETH it is the stake multiple the replays fit. Lifts itself only when the venue pays again on launches scored since (twice a day at most); npm run newepoch resets it by hand.',
    // Finalized 2026-09-07 after research/guard_audit.py. The current-size sample did
    // not separate this stop from its neighbors. Keep 0.06; automatic resets mean
    // this is an episode limit, not a bound on total daily drawdown.
  },
  /**
   * Finalized market pause: 20 / -1 / +1, with a three-hour freshness limit.
   * The audit covered 101 actual 0.02 ETH trades and excluded its last six hours
   * from selection. Shorter windows beat the old 60-launch pause in the tested
   * scenarios, but 27 settings tied during fitting. This is a selected operating
   * policy, not a statistically established optimum. See docs/GUARD_AUDIT_2026-09-07.md.
   */
  venuePauseWindow: {
    env: 'VENUE_PAUSE_WINDOW', kind: 'number', def: 20, min: 10, max: 200,
    scope: 'hot', applies: 'account',
    doc: 'scored launches in the market window. Only launches meeting the book floors count.',
  },
  venuePauseOff: {
    env: 'VENUE_PAUSE_OFF', kind: 'number', def: -1, min: -20, max: 0,
    scope: 'hot', applies: 'account',
    doc: 'entries pause when simulated returns in the window sum strictly below this many stakes.',
  },
  venuePauseOn: {
    env: 'VENUE_PAUSE_ON', kind: 'number', def: 1, min: -20, max: 20,
    scope: 'hot', applies: 'account',
    doc: 'entries reopen strictly above this sum. Must exceed VENUE_PAUSE_OFF.',
  },
  venueFreshHours: {
    env: 'VENUE_FRESH_H', kind: 'number', def: 3, min: 0.5, max: 48,
    scope: 'hot', applies: 'account',
    doc: 'the whole window must fit inside this many hours. Older evidence has no opinion and can release a market pause.',
  },
  /**
   * THE DRAWDOWN STOP'S OWN RESUME (strategy/risk.ts liftOnSignal). Deliberately its own
   * window and its own line rather than reusing the pause's: this one only ever looks at
   * launches scored AFTER the stop fired, and it decides whether to put money back to work
   * rather than whether to keep it there.
   */
  ddResumeWindow: {
    env: 'DD_RESUME_WINDOW', kind: 'number', def: 20, min: 5, max: 200,
    scope: 'hot', applies: 'account',
    doc: 'launches scored since the drawdown stop that must have resolved before it may lift. At 13.1 book launches an hour, 20 is about 90 minutes.',
    // Retained by the current-size audit. The available recovery episodes did not
    // establish a better restart window; the old mixed-size sweep is superseded.
  },
  ddResumeOn: {
    env: 'DD_RESUME_ON', kind: 'number', def: 1, min: -20, max: 20,
    scope: 'hot', applies: 'account',
    doc: 'the drawdown stop lifts when that window sums strictly above this many stakes. Defaults to +1, matching market-pause recovery.',
  },
  /**
   * THE BOT-BROKEN HALT (strategy/broken.ts). How far our real returns may sit below what
   * the same coins replayed at before we call it a bug rather than a market. 15 points
   * fires 19 minutes into the 2026-09-06 same-block log drop and nowhere else in a week.
   */
  brokenGapPp: {
    env: 'BROKEN_GAP_PP', kind: 'number', def: 15, min: 1, max: 100,
    scope: 'hot', applies: 'account',
    doc: 'halt when our last trades came in this many points per trade below their own replay. Never lifts itself: a restart is the lift.',
  },
  /**
   * DISPLAY ONLY since 2026-09-07, and that is what makes fetching it safe. It used to
   * scale both stops, so an external price moving could move a kill switch; the drawdown
   * stop is ETH now and the daily cap is gone, so nothing decides on this number. The bot
   * refreshes it hourly (telemetry/price.ts) and publishes it to chain_truth.eth_usd for
   * every script to read. This value is the seed at boot and the fallback when the fetch
   * has never succeeded.
   */
  ethUsd: {
    env: 'ETHUSD', kind: 'number', def: 2515, min: 1, max: 1_000_000,
    scope: 'hot', applies: 'account',
    doc: 'seed and offline fallback for the ETH price. Display only: the live price is fetched hourly and no decision reads it.',
  },
  halt: {
    env: 'HALT', kind: 'flag', def: false,
    scope: 'hot', applies: 'account',
    doc: 'stop entering, keep exiting. HALT=1 applies live; HALT=0 does NOT (see store.ts: resuming is a money decision).',
  },
} as const satisfies Record<string, Field>

/**
 * THE RESTART-ONLY SETTINGS. Each is captured once at construction, so editing the file
 * cannot move it and pretending otherwise would be worse than saying so.
 *
 *   MODE / LIVE          the broadcast gate. Switching to shadow with positions open signs
 *                        sells and never sends them, which strands the tokens. It also
 *                        decides at boot whether a signer, sender and nonce manager exist
 *                        at all, so there is no object to promote afterwards.
 *   PRIVATE_KEY          the signer is built once.
 *   LOGS_WS_URL, RPC_*   the viem clients and the socket are built once, and whether the
 *                        key client exists at all is decided then.
 *   GATE_LIVE            captured into RegimeGate.
 *   DB_FILE, GATE_DB     the handles are open.
 *   DASH, DASH_PORT      the listener is bound.
 *   REBASELINE           a one-boot flag, consumed by the truth keeper at startup.
 *   REQUIRE_DEV_BUY      captured into the bot's options.
 *   ENV_FILE             which file this store reads; it cannot re-point itself.
 *
 * They are tracked here anyway, as raw strings, so that a change to one is DETECTED and
 * reported ("edited in the file, needs a restart") instead of silently doing nothing,
 * which is exactly the failure this whole file exists to end.
 */
export const RESTART = {
  MODE: 'the broadcast gate: observe | shadow | live. live also needs LIVE=1.',
  LIVE: 'the second half of the broadcast gate. MODE=live AND LIVE=1 is real money.',
  PRIVATE_KEY: 'burner EOA private key. Never committed.',
  LOGS_WS_URL: 'Alchemy websocket for the launch subscription inside the entry window.',
  RPC_URL: 'provider http endpoint; unset leaves the poller on the public rpc.',
  RPC_KEY_URL: 'overrides the https form derived from LOGS_WS_URL for the per-launch reads.',
  PONS_TERMINAL_URL: "the venue's UI, linked from the dashboard's exit rows.",
  /**
   * Hours a day the Alchemy socket and the provider key are used (from-to, UTC, wrap
   * allowed). Blank means always, which is the live setting.
   *
   * This is the QUOTA lever, not a trading rule, and it is all that remains of
   * ENTRY_UTC_HOURS. That key was a trading filter (declined launches outside its hours)
   * that happened to double as the only throttle the 30M-a-month provider key has ever
   * had. The trading half was deleted on 2026-09-07 because the bot trades 24 hours; the
   * throttle half is kept, because a `quota` alert was firing at 36M a month at the time
   * and deleting the predicate would have removed the only way to act on it.
   */
  WS_HOURS: 'the hours the provider socket and key are used (from-to UTC). Blank = always. A quota lever, not a trading rule.',
  GATE_LIVE: 'the in-process cohort ring decides the regime halt, rather than gatewatch.py.',
  GATE_DB: "gatewatch's database.",
  DB_FILE: 'the bot database; a second instance needs its own.',
  DASH: 'DASH=0 disables the dashboard listener.',
  DASH_PORT: 'the dashboard port.',
  REBASELINE: 'one boot only, after a top-up or a withdrawal.',
  REQUIRE_DEV_BUY: 'reject launches whose creator buy cannot be read.',
  ENV_FILE: 'which file the config store reads. Defaults to .env beside the process.',
  /**
   * Where the event tape is recorded. THE PATH IS THE SWITCH: unset means no recorder, so
   * there is no second boolean that can disagree with it.
   *
   * Recording only. It observes and never decides, it never blocks the trading loop, and a
   * recording failure never halts trading. Its own budget (14 days OR 1 GB, whichever bites
   * first, above a 2 GB free-disk floor) is enforced in the forked writer, because the last
   * capture path on this box that grew unchecked wrote 2.2 GB a day and was found by the
   * disk rather than by an alert.
   *
   * It exists for the rewrite: the sequencer-feed overlay that every entry price and every
   * exit mark is computed from is recorded nowhere else, so without this no replay can
   * reproduce a live decision.
   */
  TAPE_DB: 'where the event tape is recorded. Unset = no recorder. Recording only: it never decides and never halts trading.',
} as const satisfies Record<string, string>

export type HotKey = keyof typeof HOT
export type RestartKey = keyof typeof RESTART

type Val<K extends FieldKind> =
  K extends 'number' ? number
  : K extends 'flag' ? boolean
  : K extends 'window' ? EntryWindow | null
  : K extends 'books' ? readonly Book[]
  : string

/** The frozen snapshot every hot read goes through. */
export type Config = { readonly [K in HotKey]: Val<(typeof HOT)[K]['kind']> }

export const HOT_KEYS = Object.keys(HOT) as HotKey[]

/** every environment variable this program reads, for the .env.example completeness test */
export const ALL_ENV: string[] = [...HOT_KEYS.map((k) => HOT[k].env), ...Object.keys(RESTART)].sort()

/**
 * "untaxed:0-0,taxed:50-10000" -> two books, in the order the operator wrote them.
 *
 * Deliberately strict about the label: ids end up in `positions.book`, in halt reasons, in
 * log lines and as DOM ids on the dashboard, and `scripts/chart-smoke.mjs` discovers chart
 * elements with /\bid="([a-zA-Z0-9]+)"/g. A label with a dash in it would be invisible to
 * that sweep, so the page would lose its guard without failing.
 *
 * This checks ONE book at a time plus the shape of the list. Whether two bands overlap is a
 * question about a PAIR, so it lives in crossCheck with the other pair rules.
 */
export function parseBooks(raw: string): { value: readonly Book[] } | { error: string } {
  const parts = raw.split(',').map((x) => x.trim()).filter((x) => x !== '')
  if (!parts.length) return { error: 'names no books' }
  if (parts.length > 4) return { error: `names ${parts.length} books; 4 is the most` }
  const books: Book[] = []
  for (const part of parts) {
    const m = /^([A-Za-z0-9]+):(\d+)-(\d+)$/.exec(part)
    if (!m) return { error: `has "${part}", which is not name:min-max with an alphanumeric name` }
    const id = m[1]!, minTaxBps = Number(m[2]), maxTaxBps = Number(m[3])
    if (minTaxBps > 10000 || maxTaxBps > 10000) return { error: `has "${part}", above the 10000 bps ceiling` }
    if (maxTaxBps < minTaxBps) return { error: `has "${part}", whose band is inverted: no launch could ever be admitted` }
    books.push({ id, minTaxBps, maxTaxBps })
  }
  return { value: books }
}

/**
 * Parse one raw string against its field. Returns the value, or an error STRING explaining
 * what was wrong in the operator's own terms. It never throws and never clamps: a bad value
 * must be visible, not quietly rounded into range.
 */
export function parseField(f: Field, raw: string | undefined): { value: unknown } | { error: string } {
  const s = raw?.trim()
  // Unset: the documented default.
  if (s === undefined) {
    // `books` unset resolves to ONE book built from ENTRY_MIN_TAX_BPS / ENTRY_MAX_TAX_BPS,
    // but parseField sees one field in isolation and cannot read those. It returns the empty
    // list and `build()` fills it in before the freeze, so `Config.books` is never empty
    // downstream and "absent" means exactly today.
    if (f.kind === 'books') return { value: [] as readonly Book[] }
    return { value: f.kind === 'window' ? parseEntryWindow(f.def as string) : f.def }
  }
  // Present but blank. For a window this is MEANINGFUL and means the filter is off, which
  // is why .env.example says to blank it rather than delete it. For everything else blank
  // is the same as unset: `Number('')` is 0, and a TRADE_SIZE_ETH= line that silently means
  // zero is the kind of thing this file exists to stop.
  if (s === '') {
    if (f.kind === 'window') return { value: null }
    if (f.kind === 'string') return { value: '' }
    if (f.kind === 'books') return { value: [] as readonly Book[] }
    return { value: f.def }
  }
  switch (f.kind) {
    case 'flag':
      if (s === '1' || s === '0') return { value: s === '1' }
      return { error: `${f.env}="${s}" is not 1 or 0` }
    case 'window': {
      const w = parseEntryWindow(s)
      if (w === null) return { error: `${f.env}="${s}" is not an hour range like 12-24` }
      return { value: w }
    }
    case 'books': {
      const books = parseBooks(s)
      if ('error' in books) return { error: `${f.env}="${s}" ${books.error}` }
      return { value: books.value }
    }
    case 'number': {
      const n = Number(s)
      if (!Number.isFinite(n)) return { error: `${f.env}="${s}" is not a number` }
      if (f.min !== undefined && n < f.min) return { error: `${f.env}=${n} is below the floor of ${f.min}` }
      if (f.max !== undefined && n > f.max) return { error: `${f.env}=${n} is above the ceiling of ${f.max}` }
      return { value: n }
    }
    default:
      return { value: s }
  }
}

/**
 * Rules that no single field can check, because each one is about a PAIR of them. Every one
 * of these has a failure mode that looks like a dead bot rather than a bad number:
 * a trade size above the bankroll makes canEnter refuse every launch for 'bankroll fully
 * deployed'; a drawdown stop below one stake halts on the first ordinary loss.
 */
export function crossCheck(c: Config, present: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = []
  if (c.tradeSizeEth > c.bankrollEth) {
    out.push(`TRADE_SIZE_ETH ${c.tradeSizeEth} is above BANKROLL_ETH ${c.bankrollEth}: no entry could ever be admitted`)
  }
  // A stop under one stake cannot survive a single ordinary loss, so it is a stopped bot
  // dressed as a risk setting. The hard stop sells at 0.5x, so one trade can lose half a
  // stake; anything below one whole stake fires on noise.
  if (c.maxDrawdownEth < c.tradeSizeEth) {
    out.push(`MAX_DRAWDOWN_ETH ${c.maxDrawdownEth} is below one TRADE_SIZE_ETH ${c.tradeSizeEth}: a single ordinary loss would halt the bot`)
  }
  // the hysteresis band. Equal thresholds are not a narrow band, they are a sensor that
  // flaps on every launch, and inverted ones would resume below the level that paused.
  if (c.venuePauseOn <= c.venuePauseOff) {
    out.push(`VENUE_PAUSE_ON ${c.venuePauseOn} is not above VENUE_PAUSE_OFF ${c.venuePauseOff}: the gap between them is the hysteresis, and without it the sensor flaps`)
  }
  // Both bounds are inclusive, so equal is a legal one-value band and is how "untaxed only"
  // is written. Inverted is not a narrow band, it is a book that can never admit anything.
  if (c.entryMaxTaxBps < c.entryMinTaxBps) {
    out.push(`ENTRY_MAX_TAX_BPS ${c.entryMaxTaxBps} is below ENTRY_MIN_TAX_BPS ${c.entryMinTaxBps}: no launch could ever be admitted`)
  }

  // ---- the books ----
  // `present` is the set of env names the operator actually wrote, which `Config` cannot
  // show: a resolved single book is indistinguishable from an explicit one-book BOOKS line.
  // The difference matters for exactly one rule, the double declaration below.
  const books = c.books

  // THE RULE THE REST OF THE DESIGN RESTS ON. Disjoint bands are why no launch is ever
  // admitted by two books, which is why there is no arbiter, no split fill and no shared
  // position anywhere downstream. Overlap must fail here, loudly, or it fails at the wallet
  // by buying the same coin twice.
  for (let i = 0; i < books.length; i++) {
    for (let j = i + 1; j < books.length; j++) {
      const a = books[i]!, b = books[j]!
      if (a.minTaxBps <= b.maxTaxBps && b.minTaxBps <= a.maxTaxBps) {
        out.push(`BOOKS "${a.id}" ${a.minTaxBps}-${a.maxTaxBps} overlaps "${b.id}" ${b.minTaxBps}-${b.maxTaxBps}: a launch in the overlap would be admitted by both books and bought twice`)
      }
    }
  }
  const seen = new Set<string>()
  for (const b of books) {
    if (seen.has(b.id)) out.push(`BOOKS names "${b.id}" twice: book names are used as identifiers and must be unique`)
    seen.add(b.id)
  }
  // Declaring the band twice. liveEntryConfig(), bookFloors() and strategySpec() would each
  // have to pick a winner, and whichever lost would be published as the band while a
  // different one was traded. That silent disagreement is what configdrift.test.ts exists
  // to police, so refuse the combination instead of resolving it.
  if (present.has('BOOKS') && (present.has('ENTRY_MIN_TAX_BPS') || present.has('ENTRY_MAX_TAX_BPS'))) {
    out.push('BOOKS is set together with ENTRY_MIN_TAX_BPS or ENTRY_MAX_TAX_BPS: the band would be declared twice. Put every band in BOOKS, or delete BOOKS and use the two keys.')
  }
  // The wallet-wide stop must not sit below a single book's stop, or the per-book allowance
  // is unreachable and per-book drawdown only LOOKS like it works.
  if (c.maxWalletDrawdownEth < c.maxDrawdownEth) {
    out.push(`MAX_WALLET_DRAWDOWN_ETH ${c.maxWalletDrawdownEth} is below MAX_DRAWDOWN_ETH ${c.maxDrawdownEth}: the wallet stop would fire before any book could reach its own limit`)
  }
  // The MEASUREMENT layer is per book since 2026-09-16: the observer replays each band over
  // the shared evidence, each book owns its forward-ledger epoch, and each keeps its own guard
  // checkpoint. The LIVE path is not. `bot.ts` still builds one ScenarioController and gates
  // every entry on book 0's reading, so a second book would trade against the first book's
  // sensor. That is phase 4's work, and until it lands refusing is the honest answer. The box
  // runs VENUE_EXECUTION_SCENARIOS=1 today, so this rule bites the moment BOOKS names a
  // second book.
  if (books.length > 1 && (c.venueExecutionScenarios || c.venueFreshRecovery)) {
    out.push(`BOOKS names ${books.length} books while VENUE_EXECUTION_SCENARIOS or VENUE_FRESH_RECOVERY is on: the guard is measured per book but the trading path still gates every entry on the first book's reading, so the second book would trade against the wrong sensor. The live per-book guard is not wired yet.`)
  }
  return out
}
