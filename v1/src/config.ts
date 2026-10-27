/**
 * Every tunable in one place. Values marked VERIFIED were measured on-chain
 * during the research pass (see ../docs/history/BUILD_BRIEF.md) or probed live while building.
 */
import { defineChain } from 'viem'
// config/store.ts loads the env file (ENV_FILE, default .env) as its first act, so importing
// it here is what used to be `import 'dotenv/config'`, pointed at the right file.
import { config as live } from './config/store.js'

/**
 * Settings an operator can change are declared in config/schema.ts and read through
 * config/store.ts, which re-reads the file when it changes. Those fields appear below as
 * GETTERS rather than values, so every existing `STRATEGY.tradeSizeEth` read site picks the
 * current one up with no change: the snapshot behind them is swapped wholesale, never
 * mutated, so a position that captured one keeps exactly what it captured.
 *
 * Everything else in this file is a constant with its evidence beside it, and moving one is
 * a code change on purpose.
 */
export { parseEntryWindow } from './config/schema.js'
import { parseEntryWindow as parseWindow } from './config/schema.js'
export type { Config } from './config/schema.js'

/**
 * The free public RPC. It rate-limits: 12,786 failed log polls in the 24h to 2026-09-06
 * 00:00 UTC, all "Too Many Requests". RPC_URL points the bot at a provider key instead
 * (Alchemy serves chain 4663 with a websocket); the public endpoint stays as the fallback
 * transport so a dead key degrades to today's behaviour rather than to nothing.
 */
const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com'
const RPC_URL = process.env.RPC_URL || PUBLIC_RPC

/** every distinct RPC to try, in order: the configured one first, the public one last */
export const RPC_URLS: readonly string[] = [...new Set([RPC_URL, PUBLIC_RPC])]

export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
})

export const ENDPOINTS = {
  // accepts ONLY eth_sendRawTransaction(+Conditional). HTTP/2, no websocket. VERIFIED
  sequencer: 'https://sequencer.mainnet.chain.robinhood.com',
  // HTTP only, no websocket exists on the public endpoint. VERIFIED. RPC_URL overrides.
  rpc: RPC_URL,
  rpcPublic: PUBLIC_RPC,
  // nitro sequencer broadcast feed, ~100ms/frame. VERIFIED
  feed: 'wss://feed.mainnet.chain.robinhood.com',
  // authoritative logs. no public WS, so a provider key is required
  logsWs: process.env.LOGS_WS_URL ?? '',
  // the same provider over HTTP, for the two per-launch reads inside the entry window
  // (bot.ts readVia; src/rpc/budget.ts for the quota). Derived from the socket url so
  // there is one secret. RPC_KEY_URL overrides. Empty means: every read on the public rpc.
  rpcKey: process.env.RPC_KEY_URL || (process.env.LOGS_WS_URL ?? '').replace(/^wss:\/\//, 'https://'),
  explorer: 'https://robinhoodchain.blockscout.com',
  // the venue's own trading UI, where a token has a price chart. The explorer does not,
  // which is why a link to it answers the wrong question when scanning recent exits.
  terminal: process.env.PONS_TERMINAL_URL ?? 'https://robinhoodchain.blockscout.com/token',
} as const

export const ADDRESSES = {
  factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  launcher: '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  weth: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  ethPair: '0x0000000000000000000000000000000000000000',
} as const

export const STRATEGY = {
  // Entry is a clock, not a race: the snipe tax decays to 0.19% at elapsed 2s.
  // Fired against observed block timestamps from the feed, never wall clock.
  entryDelayMs: 2_000,
  // Only used if the feed is unavailable. Aimed deliberately late: overshooting into
  // elapsed 3 costs 19bps of tax, undershooting into elapsed 1 costs 618bps.
  entryFallbackLateMs: 600,

  // 100 -> 200 on 2026-08-19. Held out on the current era, the 1% bound costs $23 against
  // a 2% bound ($107.43 vs $130.40) for 18 extra trades. Going from 2% to no bound at all
  // adds 2 launches in 60 hours, i.e. nothing, so the clause stays as a sanity bound: an
  // unbounded creator tax is a real way to lose and it simply did not show up in this tape.
  maxCreatorTaxBps: 200,

  // NEW 2026-08-28. A creator tax is the single strongest filter we have found, and it is
  // effectively binary rather than graded: replaying every closed live trade against
  // gatewatch's independent 45s peak (obs.peak, an observer that never sold anything), coins
  // with NO creator tax lose $494.55 over 874 trades at -$0.566 each, while every taxed band
  // is positive. The floor value barely matters (1-200bps nets $354, 50-200bps nets $371),
  // so 50 is a rounding of "non-zero" and not a fitted threshold.
  //
  // The ceiling above is deliberately NOT symmetric with this. It never binds on anything we
  // traded -- bands 50-200 and 50-10000 select the identical 267 trades -- because coins over
  // 200bps are rejected at the book screen, so we have no evidence about them either way.
  //
  // ENFORCED IN bot.ts enter(), NOT in screenCurve. screenCurve sets launches.passed, and
  // gatewatch scores WHERE passed = 1, so putting this in the screen would stop us observing
  // untaxed launches and destroy the control group the measurement above depends on. A
  // trading filter must never shrink the observation universe; see the 08-27 gate starvation.
  // WAS 50, a compiled-in constant, from 2026-08-28 until 2026-09-15. It is now the hot
  // ENTRY_MIN_TAX_BPS, paired with ENTRY_MAX_TAX_BPS below, so the band can be moved and
  // reverted from .env without a deploy. See config/schema.ts for why that mattered.
  get minCreatorTaxBps() { return live().entryMinTaxBps },

  /**
   * The upper entry bound, inclusive, and NOT the same thing as maxCreatorTaxBps above.
   * That one is the book screen at 200bps and sets launches.passed. This one is a trading
   * filter applied in strategy/entry.ts and never narrows what gets observed.
   *
   * Default 10000, i.e. no bound beyond the screen, so the pair reproduces the old
   * floor-only behaviour until an operator sets it.
   */
  get maxEntryTaxBps() { return live().entryMaxTaxBps },

  /**
   * THE BOOKS. One entry per band the bot is allowed to trade, from the hot `BOOKS` key.
   *
   * Never empty: an absent or blank BOOKS resolves in config/store.ts build() to a single
   * book named `main` carrying exactly the two getters above, so every downstream reader
   * sees a list and nobody has to handle "unset". With one configured book this reproduces
   * today byte for byte, which is what makes each phase of the two-book work a
   * no-behaviour-change deploy.
   *
   * The two getters above stay and read book 0, so every existing call site keeps working
   * untouched. They are the right answer while one book is configured and the wrong question
   * once two are; the call sites that must become per-book are converted deliberately, not
   * by deleting these.
   */
  get books() { return live().books },

  // NEW 2026-09-06. Exempt wallets (the creator's pre-approved bundle, LaunchMeta.exemptions)
  // sort coins better than the tax band does. Measured fresh on 2026-09-06 from bot.db and a
  // 7-day exit-aware replay of the cached taxed cohort (research/edge_fresh7d.py), current
  // era only (since 09-04 12:00 UTC), real trades at $2145/ETH:
  //   exempt   real n   real $    win   replay@1.75   terminal median
  //   1-2        61    -45.80    21%      -5.3%          0.919
  //   3-5        95    +36.31    53%      +8.3%          0.995
  //   6-10       75    +11.11    47%      +1.3%          0.876
  //   11-15      64    +82.17    69%     +18.3%          0.871
  //   16+        22    +19.00    55%     +16.3%          1.001
  // The 1-2 group is negative at every bar 1.25-2.50 in the replay, negative on both trading
  // days (win 6% and 38%), and has the lowest median observer peak of any bucket (1.03 over
  // 48h, 137 launches). ERA CAVEAT: all-time in the 2.50-bar era (08-25/26) the same coins
  // made +$112 over 182 trades, so this is right NOW and scripts/edgecheck.py re-checks it
  // every morning.
  //
  // ENFORCED IN strategy/entry.ts via bot.ts enter(), NOT in screenCurve and NOT by raising
  // book.minExemptions: that one sets launches.passed, gatewatch scores WHERE passed = 1, and
  // raising it would delete the very control group this table was measured on.
  minExemptionsToEnter: 3,

  /**
   * THE PROVIDER-QUOTA WINDOW (env WS_HOURS, restart-only), and all that is left of the
   * entry clock.
   *
   * WHAT WAS DELETED, 2026-09-07. ENTRY_UTC_HOURS refused launches outside 12-24 UTC. The
   * measurement behind it was real: over 08-17..08-27, 00-12 UTC was 10 of 18 day-blocks
   * negative while 12-24 was +0.20 with 0 of 13 negative, and no filter could see it
   * coming because the coins DO peak (gatewatch touch rates by hour are flat), they just
   * do not hold. But by 09-06 the clock was keeping only 73% of September's profit, six of
   * seven nights were positive, and the bot went to 24 hours behind the venue pause and
   * the self-lifting drawdown stop instead. A clock cannot lag; sensors can, which is why
   * it took three of them to replace it.
   *
   * WHAT WAS KEPT, AND WHY IT IS NOT A TRADING RULE. The same predicate was also the only
   * throttle the 30M-a-month provider key has ever had: the socket subscription and the
   * two per-launch key reads both ran only inside the window. With the window blank they
   * run all day, and on 2026-09-07 the `quota` alert was firing at 36M a month. Deleting
   * the predicate outright would have removed the only lever for that, so it survives as
   * its own switch, defaulting to always-on. It gates NOTHING about which launches are
   * traded: a launch outside these hours is entered exactly as one inside them, just read
   * through the public rpc.
   */
  get wsHours() { return parseWindow(process.env.WS_HOURS) },

  // NEW 2026-09-06. THE GRADUATION GUARD. Refuse a curve whose price, in our own model at
  // the moment we fire, is already this many times a FRESH curve's price for the same buy
  // (simBuy on freshCurve(params) against the live expected tokens, same landTs so the
  // snipe tax cancels). Every bag we ever held was bought that way: the bundle filled the
  // curve in the two seconds before our entry and graduation landed in the same block as
  // our buy, after which the curve refuses sells and the DEX side is worth ~5% in minutes.
  //
  // SHIPPED AT 3 AT 07:18 UTC AND WRONG. That number was measured against the median
  // NORMAL trade, not against a fresh curve; a normal trade already reads 1.56x fresh at
  // the median (the dev buy plus two seconds of buyers) and 3.39x at p90, so 3 would have
  // blocked 44% of the book when the window opened. Re-measured at 07:40 with the bot's
  // own simBuy on every era trade (research/guardcheck2.ts), fresh-curve scale:
  //
  //   normal trades, n=396: p50 1.56  p90 3.39  p95 3.79  p99 5.41  max 6.52
  //   bags at decision:     893 5.24 (then x1.60 in flight)  1300 8.73  1438 8.64
  //                         1629 9.17  1661 10.43  1722 8.89 (x1.33 in flight)
  //   graduation itself sits at ~12.5x on this scale (Q 1.68 -> 5.88 ETH, supply gone)
  //   normal trades at >= 4.5x: 11, $-8.45, win 27%   (>= 5x: 6, $-8.00;  >= 6x: 2, $-1.06)
  //   price move between decision and fill, n=396: p50 x1.02  p90 x1.24  p99 x1.79  max x1.95
  //
  // 4.5 catches all six bags with 0.74 of margin under 893, blocks 11 trades in 396 that
  // lost $8.45 between them, and keeps every slow-fill 'graduating' winner (3.5-3.8x). For
  // a coin under 4.5x to still be stranded, the price would have to move x2.8 between
  // decision and fill; the most ever seen is x1.95. The value is stored per row as
  // positions.entry_mult so the band keeps being measured. Reject bucket `pumped`.
  maxEntryPriceMultiple: 4.5,
  /**
   * TEMPLATE LOSS BLOCK (2026-09-06). A "template" is (creator tax, exact dev-buy wei,
   * exempt-wallet count). After one REAL losing trade on a template, that template is
   * refused for this long, measured from the loss's close.
   *
   * Why: farms launch the same template from a fresh wallet every few minutes, pump each
   * coin to ~2x in the first two seconds and dump into our buy. 14:53-14:58 UTC today: four
   * launches of tax 200 / dev 0.06 ETH / 6 exempt, four different deployers, entered at
   * 1.7-2.2x, sold at 0.31-0.46x, -$27 in seven minutes. The per-value template gate
   * (book.templateGate) did not fire: it scores the observer's touch-1.21 from the launch
   * price, which an insider pump touches by construction.
   *
   * Measured on 7 days / 397 real main-book trades: the next trade on the same template
   * within 30 min after a loss ran 27% wins, -$33.84 (n=52); after a win, 59%, +$18.45
   * (n=29). This rule would have skipped 63 trades worth -$47.29 (24% wins) and kept 334
   * worth +$212.69 (54%); by day, the skipped set lost money on 4 of the 5 trading days
   * (the exception is 08-27, the old era). Longer blocks and two-loss triggers were all
   * worse or equal. Reject bucket: `template-loss`.
   */
  templateLossBlockMs: 3_600_000,

  // Selection. REWRITTEN 2026-08-18 after the live pilot lost $35 in 90 minutes on the
  // old book. What went wrong: the old book keyed on "bundle" (creator registered
  // snipe-tax-exempt wallets) plus a big dev buy, and BOTH are free for the launcher to
  // fake. By Aug 17 they were being manufactured at scale: the exemption bands that scored
  // +19%/+47% on Aug 13-16 scored -2.8%/-10% on the days that followed. A signal that costs
  // the other side less to fake than it earns from us is bait, not an edge.
  //
  // The replacement, on a held-out split of the current era (search on the older 60% of
  // blocks, scored once on the newer 40%, then randomisation and per-day checks):
  //   dev >= 0.05 AND deployer's first launch ... +5.89% ROT, 90% CI [+2.6,+9.7],
  //                                               +4.76% after deleting the best trade,
  //                                               random books beat it 10/300 (p=0.010)
  //   dev >= 0.05 alone ......................... +3.49%   (the old cut, still positive)
  //   buy everything ............................ +1.07%   (CI crosses zero: dead)
  //   old book (bundle+twitter) ................. +0.42%   (CI crosses zero: farmed out)
  // Past 24h at the time of writing: +6.49% on 394 trades. See research/ fp_* and
  // strategy/deployers.ts for the era-by-era dose-response behind the deployer cut.
  //
  // The dev-buy floor stays in the book but is NOT trusted: it is still attacker-controlled
  // and is here because it survives measurement, not because it is honest. Re-test weekly.
  //
  // 2026-08-18 (second rewrite). The dev floor moves 0.05 -> 0.10 ETH. This was re-fitted
  // after discovering that every number above had been measured on a dataset that was
  // MISSING 70% of the trades in the recent window: ../research/pull_more.mjs grew its
  // getLogs chunk until the RPC silently truncated the response, and the loop walked
  // past the dropped tail without erroring. 9,117 trade rows were absent from blocks
  // 39.5M-39.6M, dev-buy therefore read 0.00 for all 36 live-traded tokens present in
  // the file, and only 1 of those 36 passed the research book at all. The sim was
  // scoring a population the bot never bought from. Pull fixed, data repaired, refitted.
  //
  // Dose-response on the repaired data, exit tp1.31 + 45s clock, scored ONLY on the newer
  // 40% of blocks that the search never saw:
  //   dev>=0.02 .. mean +5.5%  median -1.9%  win 43.0%   23.2 launches/h
  //   dev>=0.05 .. mean +7.1%  median +0.1%  win 50.2%   16.5/h   <- what the pilot ran
  //   dev>=0.08 .. mean +9.3%  median +4.5%  win 57.5%   11.6/h  <- here
  //   dev>=0.10 .. mean +9.0%  median +4.3%  win 58.2%    9.5/h
  //   dev>=0.15 .. mean +8.0%  median +4.3%  win 59.3%    7.1/h
  //   dev>=0.30 .. mean +9.1%  median +5.8%  win 65.7%    4.2/h
  // Mean peaks flat across 0.08-0.10 and the median/win-rate keep climbing after it, so
  // this is a knee, not a peak: raising the floor further keeps buying consistency with
  // trade count. 0.10 sits mid-plateau and halves the trade rate vs 0.05, which is the
  // real cost. The first-launch cut still earns its keep: dev>=0.05 on a REPEAT deployer
  // scores -8.2% held out, against +7.1% on a first-timer.
  //
  // 2026-08-18, second pass: 0.10 -> 0.08 ETH. The first comparison of these two floors
  // was done wrong and said "no difference": it scored the two COHORTS against each other,
  // but 399 of 0.08's 482 trades ARE 0.10's trades, and that shared bulk drowned the
  // signal inside the error bars. The right test is the marginal slice on its own.
  //
  // The 0.08-0.10 band alone, n=83: +$0.691/trade, 90% CI [+$0.421,+$0.961], positive in
  // 100% of 4,000 bootstrap resamples. Per-trade edge is indistinguishable from the coins
  // we already buy (+$0.691 vs +$0.722) - there are simply 2.0 more of them per hour.
  //   0.10: 9.6 trades/h -> $166/day        0.08: 11.6 trades/h -> $199/day   (+20%)
  //
  // The cost is real and worth naming: the band's own MEDIAN is -$0.061 against a mean of
  // +$0.691, so those extra coins are carried by their winners. Overall median per trade
  // drops from +$1.007 to +$0.833. Both still positive; this is a deliberate 17% haircut on
  // typical-trade quality bought for 20% more volume. The held-out quarter holds only 3
  // trades from this band, so the daily figure rests on the searched window alone.
  // WIDENED 2026-08-19. The book was starving: it passed 571 of 4,144 launches in the
  // current era and sat idle 41% of the held-out window, with a 2.7h gap this morning
  // while the gate was OPEN the whole time. Idle was never the gate's doing - it caused
  // only 54 of the 1,212 skipped launches across all 15 idle gaps.
  //
  // Idle is not automatically a loss, and that was worth measuring before touching
  // anything: buying every launch we sat out loses $213, and the 2.7h window this morning
  // loses $51 at a 12% win rate. Sitting those out was correct. But the clause-by-clause
  // decomposition says the dev floor is the one that was mis-set. Counting only launches
  // where a single clause was the ONLY thing blocking the trade (../research/idle2.py):
  //
  //     dev >= 0.08 .... 126 launches, +$35.00, median +16.80%, win 61%   <- winners
  //     ex  >= 1 ....... 195 launches, +$37.55, median  -2.02%, win 34%   <- pure tail
  //     ctax <= 1% ......  9 launches, +$10.60, median +19.76%, win 78%   <- n too small
  //     first launch ...  26 launches,  +$0.63, median  +5.48%, win 65%   <- neutral
  //
  // Held out on the newer 40% of blocks, against the book this replaces:
  //     $130.40 vs $87.91, max DD $10.27 vs $12.08, median +3.65% vs +2.77%,
  //     win 56% vs 54%, 15.6 trades/h vs 11.4, idle 17% vs 41%, worst gap 1.5h vs 2.7h.
  // Won 9 of 10 walk-forward 6h slices with no refitting (one-sided p = 0.011); block
  // bootstrap on the difference +$34.59, 95% CI [-4.66, +92.01]. The sign test is the
  // stronger half of that - the bootstrap interval clips zero.
  //
  // NO UPPER BOUND ON dev, deliberately, and this was asked for and measured. Capping at
  // 0.15 costs $71 held out, raises drawdown to $16.90, and loses 8 of 10 walk-forward
  // slices (-$254 total). Sliced by band, everything from 0.01 to 0.50 is strongly
  // positive and 0.15-0.25 has the BEST median in the whole book (+19.45%, win 67%).
  // Only dev >= 1.0 ETH looks weak (n=21, median -2.09%) and n=21 is noise. If a cap ever
  // ships it belongs at 1.0, not 0.15, and it needs its own evidence first.
  //
  // Standing caveat, and it is the big one: every dollar here rests on minExemptions,
  // whose edge is decaying at p = 0.0395 (see below). This widening buys volume on a
  // signal with a measured half-life, not a new edge.
  book: {
    minDevBuyWei: 10_000_000_000_000_000n, // 0.01 ETH, AND:
    /** reject a launch whose deployer has already launched this many coins or more */
    maxPriorLaunches: 3,
    // At least one wallet pre-approved for snipe-tax exemption in the launch calldata.
    //
    // The single strongest selection result measured on this venue, and the only change
    // all day that improves the DISTRIBUTION rather than just the average. Over 464 book
    // launches in a 40h window (../research/exempt_validate.py):
    //
    //            n    mean    median    win%   top5% share of gains
    //   ex>=1  319   +9.16   +18.60   70.2%          14.0%
    //   ex=0   145   +1.92    -1.98   35.2%          28.7%
    //
    // Checked five ways before shipping, because an hour earlier a filter built on 11
    // trades pointed the OPPOSITE way and was wrong:
    //   - the edge is in the median, and ex>=1 is the LESS concentrated of the two
    //     (14.0% vs 28.7% of gains in the top 5%), so it is not a lottery effect
    //   - better median in 9 of 9 four-hour windows, no exceptions
    //   - holds on the never-searched last 25%: +19.71 median / 78.4% win vs -1.81 / 46.2%
    //   - not a dev-buy proxy: holds inside every creator-buy band (0.08-0.15 +19.74 vs
    //     -2.25; 0.15-0.30 +19.39 vs +0.88; 0.30+ +15.02 vs -1.95)
    //   - not wired to our exit: gap is +11..+22pp at tp 1.10/1.21/1.35, hold 25/45/90s,
    //     and with the take profit switched off entirely
    //   - block bootstrap on the median gap: +20.60pp, 95% CI [+13.43, +21.77]
    //
    // Our own 51 live trades agree: the 9 on ex=0 lost $3.26 at an 11.1% win rate.
    // Costs roughly half the trade rate; dollars per hour hold flat while the win rate
    // goes 59% -> 70%. Mechanism: a creator who pre-approved nobody has no crowd lined
    // up, so nothing moves the price and we pay the fee for a flat ride.
    // DECAYING, measured 2026-08-19, and this is the number to watch above all others.
    // The gap between ex>=1 and ex=0 medians, in 6h buckets over the current era:
    //   08-16 17:48 +23.91pp | 08-17 05:48 +23.93 | 08-17 11:48 +22.97 | 08-17 17:48 +13.46
    //   08-18 05:48 +14.06   | 08-18 11:48  +4.41 | 08-18 17:48  +7.58 | 08-18 23:48 +3.71
    // The venue baseline is FLAT across all of them (-2.25% to -4.22% median, every
    // bucket), so this is the signal dying, not the market. Split the era in half and
    // bootstrap the decay: +22.43pp early, +7.40pp late, decay +14.59pp, 95% CI
    // [+0.59, +21.25], block permutation p = 0.0395.
    //
    // Mechanism: the exempt list is written by the creator into the launch calldata, so it
    // costs the other side nothing to fake. Same shape that killed bundle+twitter on the
    // 18th. Strip this clause and the book's median goes negative, so it is load-bearing
    // AND rotting. TODO: log the rolling gap next to the touch rate and alarm under +5pp,
    // so it dies in a chart rather than in P&L a day later.
    minExemptions: 1,
    /**
     * THE TEMPLATE GATE: a per-dev-buy-value regime gate. 2026-08-19.
     *
     * The farms that ate that day stamp out identical launches from fresh deployer
     * wallets, and the one legible signature is the EXACT dev-buy wei value repeated
     * across tokens: 0.0890 x40/day (33 deployers, we went 3/22 on it, -$20.53),
     * 0.4200 x21, 0.0100 x14. Value-shape rules do NOT work -- 87-90% of all launches
     * share an exact value with >=5 others because 0.1/0.05/0.02 are organic human
     * choices too, and blocking by frequency removed +$15.71 of 08-18 winners. What
     * separates 0.089 (win 14%) from 0.1 (fine) is OUTCOME, so this is the regime gate's
     * own mechanism applied per value: gatewatch already scores every passed launch's
     * 45s peak; a value whose trailing-24h scored observations are >= minObs with a
     * touch-1.21 rate under shutBelowPct is blocked until its own results lift it.
     *
     * Backtested on our own trades, decision-time information only (obs scored before
     * each entry): 08-18 +$3.25 -> +$8.92, 08-19 -$61.33 -> +$18.48 (with the floor at
     * 0.05; the gate's own cut was 0.089's 24 trades, -$22.88). Flat across minObs 3-5
     * and cut 10-20%, a plateau, not a fitted point. The adversary escapes by rotating
     * values, which bounds our bleed at ~minObs trades per new value, or by letting
     * their coins actually pump, which pays us.
     *
     * UNKNOWN MEANS ALLOWED, the opposite of the take-profit schedule's rule, and on
     * purpose: a value with no scored history is every organic launch ever; blocking on
     * no data is blocking the book. The dev-buy floor is what stands in front of fresh
     * values. gatewatch.py computes the list (it owns the scoring) and publishes it into
     * gate.db state under 'template_block'; the bot merges `seed` over whatever it reads.
     */
    templateGate: {
      windowMs: 86_400_000,
      minObs: 4,
      /** touch-1.21 rate (percent) below which a template with >= minObs scored obs is blocked */
      shutBelowPct: 15,
      /**
       * Blocked unconditionally, before any scoring: exact dev_buy_wei values as decimal
       * wei strings. 0.089 ETH is the farm that took -$22.88 from us on 2026-08-19 and
       * was still launching 36/12h at the time of writing. Seeding skips the ~minObs
       * learning bleed for a value we already know is poison.
       */
      seed: ['89000000000000000'],
    },
  },

  // 0.005 -> 0.010 on 2026-08-18. Capital was never the constraint: across three
  // independent views the book never held more than 3 positions at once, and we hold
  // NOTHING in 444 of 524 balance samples.
  //
  //   41h backtest, current book   8.4 trades/h   max 3 concurrent   1 open 90.9% of the time
  //   18h of live screening        ~7 trades/h    (median hour)
  //   our own 60 live entries                     max 3 (1x49, 2x11, 3x2)
  //
  // At 0.010 the wallet (0.0773 ETH) affords 7 concurrent against a max-ever of 3.
  // The binding limit is not the wallet but SIM HONESTY: our own buy pushes the quoted
  // price up and the sim scores our gain against that pushed-up price, so big sizes
  // flatter themselves. Median mark the instant we fill, by size:
  //     0.005 -> 0.9907 (the real fee cost)   0.010 -> 0.9933 (+0.26pp)
  //     0.020 -> 0.9985 (+0.8pp)              0.050 -> 1.0140 (+1.4pp of fiction)
  // 0.010 keeps the distortion to a quarter point. maxTradeSizeEth stays the hard stop.
  //
  // Cost: a rug loses ~17% of the stake, so $1.80 -> $3.60, and the $75 drawdown stop
  // goes from ~40 max-loss trades of headroom to ~21. Worst drawdown this epoch: ~$2.
  // Held at 0.010 rather than 0.015 only to avoid stacking two untested changes at once
  // (minExemptions shipped minutes earlier); revisit at n=100.
  get tradeSizeEth() { return live().tradeSizeEth },
  maxTradeSizeEth: 0.02, // hard ceiling: P&L peaks here, negative by 0.05
  get bankrollEth() { return live().bankrollEth },
  maxConcurrent: 14,


  // Exit rules, re-derived 2026-08-17 from the price-path anatomy (../research/fp_anatomy.py,
  // fp_sweep3.py, fp_exitfinal.py) and confirmed on a forward day the fit never saw.
  //
  // The exit is a clock, not a signal. After a +2s entry the median token sits flat for
  // ~60s and then bleeds (mark 0.94 at 120s, 0.90 at 300s); the mean is carried by a
  // fat right tail whose peaks come at 2-4 minutes. "Sell everything at 120s" scored
  // within noise of the best of 133 exit variants (trails, momentum gates, decaying
  // trails, partial exits, exit-on-creator-sell, exit-on-big-sell) on held-out data,
  // and beat most of them: every signal-based early exit sold into a dip that the clock
  // would have ridden out. Sell-triggered exits (creator sells, early-bot sells, large
  // sells) were all worse than the clock, by 2-14 points.
  //
  // So: hold cap 120s does the work. The trail is left in only as jackpot insurance
  // (armed at +20%, fires 50% off the peak: on the data it fires on <1% of trades and
  // costs nothing), and the hard stop at 0.5x is tail insurance that fired 22 times in
  // 1,548 trades for a 0.06pp cost. Neither is tuned; both are deliberately loose.
  //
  // 2026-08-18: the clock moved from 120s to 45s, and this was the single most expensive
  // thing we got wrong. The coin lifecycle COMPRESSED when the farms took over. Median
  // curve, as a share of its own peak ETH:
  //             t=30s   t=60s   t=90s   t=120s
  //   organic:   85%     83%     78%     74%     <- 120s was right here
  //   now:       64%     56%     21%      7%     <- 120s sells into an empty curve
  // Hold sweep on the current era, dev>=0.05: 20s +4.8%, 30s +5.3%, 45s +6.2%, 60s +4.6%,
  // 90s +1.0%, 120s +1.9%, 300s -4.9%. Same peak at 45s in the past 24h, the past 48h, the
  // 16th, the 17th daytime, last night, and a fit/test split of the era. Re-simulating the
  // pilot's own 22 trades: -$35.9 at 120s, -$8.8 at 45s, -$0.5 at 20s.
  // 45s sits in the middle of a broad 20-60s plateau on purpose. A spikier optimum would
  // mean a fitted number; being mid-plateau means small timing errors cost little.
  // WATCH THIS: if farms start dumping earlier the plateau slides left. Re-measure weekly.
  //
  // 2026-08-18: ADDED A TAKE PROFIT, and it is now the exit that does the work.
  //
  // The pilot's exit was a pure clock. Not by design - the trail fired ONCE in 656
  // simulated trades and the hard stop never fired at all, so "trail 50% off the peak,
  // armed at +20%" was decoration on a 45s timer. It showed: 5 of the 50 live trades
  // peaked at +22%..+64% and were sold at a loss anyway, because nothing in the rule set
  // ever sold into strength. Trade 154 peaked at 1.64x and closed -13.2%.
  //
  // Held out on the newer 40% of blocks (book dev>=0.10 + first launch, n=153):
  //             mean%   median%   win%   top-5%-of-trades' share of all P&L
  //   clock45   +8.34    +1.12    51.6%   53%      <- the pilot's rule
  //   tp1.21    +6.11    +4.78    58.8%   40%      <- here (see the walk-forward below)
  //   tp1.31    +9.03    +4.29    58.2%   29%
  //   tp1.40    +9.27    +2.95    55.6%   29%
  //   tp1.60    +9.70    +2.73    54.2%   39%
  // Paired block-bootstrap against the clock over the whole cohort: +0.34pp/trade,
  // 90% CI [-1.22,+1.84]. So the take profit does NOT reliably raise the mean and it is
  // not sold as doing so. What it reliably does is change the shape: the median trade
  // goes from losing to winning, the win rate crosses 50%, and the share of total P&L
  // riding on the best 5% of trades falls from 53% to 29%. Negative 4h sessions across
  // the 3-day window: 3/11 on the clock, 1/11 with the take profit.
  // Replayed on the exact 20 coins the pilot traded that also clear dev>=0.10: the clock
  // returns -2.20% (what we got), the take profit +9.19%.
  //
  // Insensitive to fill latency, which matters because a take profit fires on a spike:
  // mean moves +5.33 -> +6.04 as the trigger-to-fill lag goes 0.2s -> 3.0s (live measured
  // ~0.9s). The plateau spans 1.25-1.40; the exact value is not load-bearing.
  //
  // WHERE +20% COMES FROM. Two independent methods land on it, which is the only reason
  // it is here as a number rather than as a range.
  //
  // (1) Walk-forward, 5 consecutive folds of 76 trades. The best take-profit BY MEAN is
  // different in every fold: 1.20, 2.00, 1.35, 1.30, 1.75. There is no "best number" for
  // profit and anyone quoting one is fitting noise. But rank by CONSISTENCY and the order
  // is stable and monotone in all 5 folds without exception - lower banks more reliably:
  //           worst-fold median   worst-fold win%
  //   1.10          +2.90              52.6%
  //   1.15          +2.50              52.6%
  //   1.20          +1.88              52.6%   <- last level that is green in every fold
  //   1.25          -0.88              48.7%
  //   1.35          -1.32              46.1%
  //   clock45       -1.65              42.1%
  //
  // (2) Conditional path anatomy, which says WHY. Given a coin reaches +X%, does it keep
  // going, and does it give it back?
  //     reaches   % of coins   goes half-again higher   round-trips below 1.0
  //      +10%        55.4%             91.9%                    25.1%
  //      +15%        50.9%             83.0%                    24.2%
  //      +20%        47.5%             61.3%                    23.2%   <- continuation breaks
  //      +30%        29.1%             53.2%                    21.6%
  //      +50%        11.8%             35.6%                    24.4%
  // Below +20% a move is still building and selling into it is premature. At +20% the
  // continuation rate falls off a cliff (83% -> 61%) and never recovers. Meanwhile the
  // round-trip column is FLAT at ~21-26% across every level: going up more does not make
  // the position any safer. That is the whole story of the pilot's trade 154, which
  // peaked at 1.64x and closed -13.2%. Holding past +20% buys a shrinking chance of more
  // upside at an undiminished 1-in-4 risk of giving the entire move back.
  //
  // 1.21 not 1.20: the sim's mark ratio starts at 0.9907 (it measures the post-buy mid
  // against an average fill price that already carries the fee), while the bot's
  // mark/entryMark starts at exactly 1.0. 1.20 / 0.9907 = 1.211.
  //
  // Partial exits (bank 70% at 1.20, run 30% to 1.60) were tested and rejected: worst-fold
  // mean +4.10 vs +3.57, which does not pay for a second sell tx, a second failure mode,
  // and a partial-fill state the recovery path would have to learn.
  /**
   * THE TAKE PROFIT IS NOW A FUNCTION OF THE VENUE, NOT A CONSTANT. 2026-08-19.
   *
   * Measured on 498 replayed launches across two disjoint 24h windows. Two findings, and
   * the second one is why this is a schedule rather than a bigger number:
   *
   * 1. 1.25 was too low. Every threshold from 1.30 to 1.60 beat it in BOTH windows; 1.40
   *    and 1.50 beat it by more than the block-bootstrap band in one. Everything BELOW
   *    1.25 was significantly worse in both. We were sitting on the wrong side of a
   *    monotone slope, and the reason nobody noticed is a methodology error worth
   *    recording: the earlier sweep ranked thresholds by which ones were separable from
   *    the incumbent 1.21, and that test rewards the NEAREST neighbour (small difference,
   *    small variance) rather than the best setting. Re-basing on 1.25 showed the gradient
   *    kept climbing past it.
   *
   * 2. The edge is regime-conditional, and in cold regimes it inverts. Paired against
   *    1.25, launch by launch, pooled over all 498:
   *
   *      trailing-20 touch rate      n     gap of 1.40 over 1.25
   *      cold   < 25%              146          -$25.23
   *      warm   25-35%             137          +$15.66
   *      hot    >= 35%             195          +$66.56
   *
   *    Significant under the pre-committed 25/35 cuts AND under an independent median
   *    split, at 1.33 / 1.36 / 1.40. Same sign in both windows, significant on its own in
   *    the older one.
   *
   * WHY IT INVERTS, because the mechanism is the thing to hold on to. Raising the bar only
   * touches coins that already reached the lower one (~60 of 280). If such a coin keeps
   * running you gain the WIDTH OF THE RAISE and no more: +$1.88 median, 12% of position.
   * If it stalls in between, your sell never fires, the 45s clock runs out and you dump
   * into whatever is left -- median exit 0.873, -$5.98, 37% of position. 15 of 16 losers
   * exited on time, none of them "a bit lower". So it is +12% against -37%, and break-even
   * needs 73% of the coins that clear 1.25 to go on and clear 1.40. The recent window
   * converted 74% (+$5.41, a knife edge); the older one converted 83% (+$61.97). The gate
   * rate is a forecast of that conversion rate, which is why the same number flips sign.
   *
   * The rungs and cuts are READ OFF the bucket table, not searched. Searching cut points
   * and levels together on 498 launches finds a winner whatever the data says.
   *
   * Honest limit: over 48h this schedule earns $375.83 against fixed 1.50's $370.68 and
   * fixed 1.40's $353.20, and every one of those differences is inside its band. What it
   * demonstrably buys is the drawdown profile -- max DD $30.07/$42.75 against 1.50's
   * $31.48/$46.88, and no losing 6h bin in either window where fixed 1.36+ has one.
   */
  takeProfit: {
    /**
     * Rungs, COLDEST FIRST. A launch takes the first rung whose `below` exceeds the
     * trailing gate rate at the moment we open, and `otherwise` if none does.
     */
    // ONE cut at 30, read off a 602-launch bucket table on 2026-08-19. The old two cuts at
    // 25/35 straddled a boundary that is not there: bucketed at 10pp resolution, the best
    // bar is 1.25 through 20-30 and then jumps to "as high as possible" at 30-40. The
    // 20-30 and 25-35 populations are the same coins, so the middle rung was interpolating
    // across a step function.
    //
    //   gate %    n    best bar     $ at 1.25   $ at none
    //   20-30    167     1.25          +28.5      +22.8   <- low bar wins
    //   30-40    156     none          +27.7      +45.8   <- high bar wins
    //   40-50     93     none          +55.2     +142.5
    //
    // Worth +$31/48h over the 25/35 version and, unlike it, positive in all three disjoint
    // windows (+17.1 / +51.2 / +208.2 against -7.5 / +42.7 / +210.2).
    // EMPTIED 2026-08-27. Every launch now takes `otherwise`, i.e. a flat 2.00 bar.
    //
    // The cold rung existed because the venue's hot and cold bands wanted different bars.
    // Re-measured after the 08-27 bleed on 1,129 book launches over 7 days with a replay
    // that had first been validated against booked P&L (see `otherwise` below), the split
    // no longer earns its complexity: a flat 2.00 beats every rung combination tried, and
    // the cold 1.25 rung specifically is the worst flat bar in the sweep bar none
    // (+$0.64/trade against 2.00's +$1.07). Keeping an empty schedule rather than deleting
    // the mechanism, because the band-conditional idea is sound and may come back; what
    // died is this particular set of cuts.
    // The annotation is load-bearing: STRATEGY is `as const`, so a bare `[]` infers as
    // `readonly never[]` and every consumer that maps over a rung stops compiling
    // (bot.ts's publishStrategy did exactly that).
    //
    // RESTORED 2026-08-27, one cut at 30 with a 1.25 cold rung, alongside `otherwise` 2.50.
    //
    // The emptying above rested on a replay that has since been shown to mis-rank configs
    // (see scripts/engine.py and the `maxHoldMs` note); its "+$0.64 vs +$1.07" comparison
    // was computed with the same broken mark scale that sabotaged the dead-coin bar. The
    // live record for this exact schedule, every closed trade grouped by the settings it
    // ran under, is not ambiguous:
    //
    //   rung          n     net $      $/trade
    //   2.50 hot    564   +198.25      +0.351
    //   1.25 cold   231    -36.38      -0.157
    //   combined    795   +161.87      +0.204
    //
    // The cold rung losing money is NOT evidence that 1.25 is a bad bar. Rungs are assigned
    // BY the gate rate, so the cold rung fires only in cold regimes, and its P&L is
    // confounded with the conditions that select it.
    //
    // EMPTIED 2026-08-28. That confound is now resolved, and the schedule loses. Replaying
    // every closed live trade against gatewatch's independent 45s peak (obs.peak, an observer
    // that never sold anything) applies EVERY bar to the SAME 267 taxed trades, so the rung
    // assignment cannot select the conditions any more. On 10 days:
    //
    //   bar     net $    $/trade   win%   days+
    //   1.25   133.59     0.500   47.2%   6/10
    //   1.50   193.15     0.723   38.6%   6/10
    //   2.00   352.97     1.322   37.5%   7/10
    //   2.50   370.55     1.388   36.7%   7/10   <- peak, smooth and single-peaked
    //   3.00   316.71     1.186   36.3%   7/10
    //   4.00   229.74     0.861   35.6%   6/10
    //
    // Flat 2.50 earns 2.8x what 1.25 earns AND has one more positive day, so there was never
    // a consistency case for the low bar; the earlier one came from ranking on median, which
    // selects low variance rather than return. Day-block bootstrap on the difference:
    // +$236.96, 90% CI [+$42, +$467], P(2.50 better) 99.2%. Walk-forward, bar fitted only on
    // prior days, picks 2.00/2.75/2.50 and never once picks below 2.00.
    //
    // The honest weak point: dropping 08-25 and 08-26 (117 of 267 trades) shrinks the
    // difference to +$36.78. It never flips sign, but much of the edge is two days.
    //
    // With the schedule empty every launch takes `otherwise`, so the gate rate no longer
    // routes anything and maxRateAgeMs / coldestTakeProfit() are inert. takeprofit.ts is
    // left intact rather than deleted: an empty schedule already resolves to `otherwise`,
    // and the module is what the unknown-means-cold tests pin.
    schedule: [] as ReadonlyArray<{ readonly below: number; readonly multiple: number }>,
    // 1.50 -> 2.00 on 2026-08-19, the HOT rung only. The two cold rungs are untouched:
    // this is the band where the venue is paying, and it is the only band where a higher
    // bar was defensible.
    //
    // Replaying 587 launches over two disjoint 24h windows, total ETH is MONOTONE in the
    // take profit and highest with no bar at all: none 0.0692/0.1353, 3.00 0.0638/0.1293,
    // 2.50 0.0599/0.1317, 2.00 0.0503/0.1340, 1.50 0.0277/0.1254, 1.36 0.0117/0.1230.
    // Same ordering in both windows, so the direction is real, not a window artefact.
    //
    // We are NOT taking the full no-bar version, on purpose. The median coin's P&L is
    // identical at every rung (delta 0.0000) and win rate FALLS 1.7-3.7pp: the entire gain
    // is right-tail, 80% of it from 6 of 241 coins in one window and 1 of 346 in the other,
    // and window two's net flips negative if you remove its single best coin. Raising the
    // hot rung to 2.00 takes the part of that curve that is monotone in both windows
    // (+$83 and +$24) while keeping a bar, because a bar is what banked CULT at +$8.31
    // before it collapsed to the stop at -$8.99.
    //
    // The 45s clock and hardStopMultiple remain the things that handle losers. A take
    // profit never protected us from a dud -- duds lose identically at 1.8 and at 3.0
    // because they never reach any bar -- it only ever caps a winner.
    //
    // 2.00 -> 2.50 on 2026-08-19. BE CLEAR ABOUT WHAT THIS RUNG IS: only 8 of 608 launches
    // (1.3%) ever touch 2.50, and in the hot band it fires on 8 of 327 trades (2%) while
    // 96% ride the 45s clock out. So this is not "sell at 2.5x", it is "stop taking profit
    // once the gate is hot, and keep a fuse in case something runs". Literally removing the
    // bar scores higher again (+$293 vs +$274 over 48h) and is not taken: the fuse is what
    // banked CULT at +$8.31 before it fell to the stop at -$8.99.
    // 2.50 -> 2.00 on 2026-08-27, and now the ONLY bar (the schedule above is empty).
    //
    // Re-measured after the 08-27 bleed, on 1,129 book launches over the 7 days ending
    // that day, with a replay validated against booked P&L FIRST: sim +$159.94 vs booked
    // +$161.94 over 768 real trades, -1.2% total, median per-trade error $0.010, and
    // sim/live agreeing on the exit reason 91% of the time. That validation needed three
    // fixes the earlier campaign did not have -- entry latency (median live fill lands at
    // block 32, not the targeted 20), exit lag 6 blocks, and a POLL model (the bot reads
    // the mark over HTTP ~every 1.2s and cannot sell into a spike between two samples,
    // while the engine happily did). Before those, the sweep claimed buying everything
    // earned +$0.72/trade in a 24h window where the bot actually lost money.
    //
    // Per trade on identical coins, all with the 90s clock below:
    //   none (pure clock) +1.12   3.00 +1.09   2.00 +1.07   2.50 +1.04
    //   1.75 +0.93   1.50 +0.89   1.36 +0.80   1.25 +0.64   1.15 +0.39
    //
    // 2.00 -> 1.36 on 2026-08-27 18:00 UTC. The reasoning above still holds on totals and
    // is still why we do not run a pure clock; what changed is that 2.00 turned out to sit
    // above where these coins actually turn, and the gate had been saying so all along.
    //
    // The gate touch rate is the tell. It reports the share of launches that reach 1.21
    // within 45s, and it has been running at 60%. Live win rate under a 2.00 bar over the
    // same afternoon was 15%. Those two numbers describe one behaviour: most of what we buy
    // does go green, we decline to sell it at 1.21 because we are holding out for 2.00, and
    // the 90s clock then sells it red. We were not picking bad coins, we were refusing to
    // collect on good ones.
    //
    // Replayed by scripts/sim.py over every launch the filter admitted (14 variants, both
    // standard windows, acceptance gate passing at a median per-trade error under a cent):
    //
    //                  7d net   median   win%   ex-tail   top5%   maxDD   bins+
    //   TP 1.36       +1465.20   +2.22   57.9    +0.89     44%     195     7/7
    //   TP 2.00       +1816.66   +0.11   50.6    +0.80     59%     304     7/7
    //
    // 1.36 gives up 19% of the 7-day total and buys, for it: a median trade twenty times
    // larger, seven more points of win rate, a third less tail dependence, and a worst
    // drawdown of $195 against $304. Its 90% bootstrap interval on the median is
    // [+0.65, +3.95], clear of zero; 2.00's is [-0.42, +1.15] and is not.
    //
    // It is not a fit to one good hour, which is the trap this project has fallen into
    // before. 1.36 is positive in 7 of 7 daily bins and 7 of 8 three-hour bins, and in the
    // bin that prompted the change (08-27 14:00-17:00 UTC, 131 launches, the venue turning
    // over) it was the ONLY config on the board still positive at +$2.34, while 2.00 lost
    // $75.01 and 2.50 lost $208.47. The ordering across that bin is monotonic in the width
    // of the bar, which is what a market that stopped reaching 2.00 looks like.
    //
    // 1.25 scores a better median still (+3.70, 62% win) and is the right answer if this
    // regime deepens. It is not the choice today because it gives up $609 of the 7-day
    // total to 1.36's $351, and nothing yet says the tail is gone for good.
    // 1.36 -> 2.50 on 2026-08-27, restoring the hot rung the 795-trade era actually ran.
    // The sweep that chose 1.36 ranked bars on a replay whose dead-coin bar and clock were
    // both wrong (see `schedule` above); 1.36 itself has five live trades, all losing.
    // 2.50 -> 1.36 on 2026-09-04. The 2.50 bar was fitted on 08-18..08-27 and that era is
    // over. Replaying 1,212 taxed cohort launches from chain logs over the CURRENT era
    // (08-28 onward), per launch at half size:
    //
    //   bar    $/trade   total $   days+   worst day
    //   1.25    +0.521    631.06    8/8      +0.180
    //   1.36    +0.539    652.97    8/8      +0.206   <- best, and the top of the stable band
    //   1.50    +0.498    603.49    8/8      +0.026
    //   2.00    +0.451    546.75    7/8      -0.112
    //   2.50    +0.466    564.54    7/8      -0.060
    //   3.00    +0.482    584.03    7/8      -0.031
    //
    // The real split is narrow band (1.25-1.36, all 8/8 days, worst day positive) against
    // wide band (2.00-3.00, all 7/8, worst day negative). Narrow wins by 13-16% AND is
    // strictly more consistent, which is the stated objective.
    //
    // MECHANISM, not just a fit: terminal median in this era is 0.95-1.01 against 1.07-1.10
    // in the 08-25..08-27 era. Coins still peak the same (median peak 1.22-1.29 every day)
    // but they no longer HOLD it, so a wide bar rides winners back to flat. Confirmed live
    // on 09-04: three trades at 2.50 peaked 2.157, 1.379 and 1.000 and banked none of it.
    //
    // HONEST CAVEAT: a 2-day recency holdout (09-03..09-04) prefers 2.50 (+0.431 vs +0.388),
    // and the day-block bootstrap on 1.36-minus-2.50 is +$88 with a 90% CI of [-91, +272],
    // so this is NOT statistically separable. It is a consistency choice inside a band where
    // every bar from 1.10 to 3.00 earns $0.43-0.54 per trade. Revisit when the era turns.
    // 1.36 -> 1.75 on 2026-09-05 20:50 UTC, with 09-05 added to the era. Nine days,
    // 1,746 taxed cohort launches, $/trade at 0.005:
    //
    //   bar    total $   days+
    //   1.36   1703.71   9/9
    //   1.50   1700.67   9/9
    //   1.75   1748.45   9/9   <- best fixed bar, and best on the overnight block too
    //   2.00   1637.29   8/9
    //
    // Recency holdout agrees: fit on 08-28..09-04 picks 1.36; held-out 09-05 (179 real
    // trades) ranks 1.75 second only to 2.00 and +$52 over 1.36. The 82 coins we sold at
    // 1.36 today went on to a median TRUE peak of 2.04.
    //
    // This is a step, not the destination. An adaptive bar (argmax over the trailing ~15
    // scored launches) beats every fixed bar by 7-13% walk-forward and beats 97-100% of
    // 300 time-shuffles, i.e. the temporal structure is real. See research/wind*.py. It
    // needs gatewatch to store per-bar outcomes; until it ships, 1.75 is the best single
    // number, positive in every 3h block of the day.
    otherwise: 1.75,
    /**
     * Staleness bound on the rate used to pick a rung. The reading is refreshed on every
     * settled observation and every 30s housekeeping tick, so anything older than this is
     * a gate that stopped reporting, and an unknown rate must take the COLDEST rung.
     *
     * That direction is not a detail. The first version of the research script fell
     * through to the high default when the rate was unknown, which put every launch in
     * the first 20 after a gate restart on the hottest setting on no evidence at all.
     * Unknown means cold, everywhere, in this file and in dyntp.py (archive/purged-sims-20260827.tar.gz).
     */
    maxRateAgeMs: 5 * 60_000,
    /**
     * THE ADAPTIVE BAR. NEW 2026-09-05. At position open, take whichever bar earned the
     * most across the trailing `window` scored launches, and pin it. `otherwise` above is
     * the fallback for every way of not knowing (no gate.db, fewer than `window` rows
     * scored under this schema, a stale reading).
     *
     * Measured on 1,746 taxed cohort launches, 08-28..09-05, walk-forward with a 2-minute
     * resolution lag in the window, $/trade at 0.005:
     *
     *   flat 1.36                          1703.71   9/9 days
     *   flat 1.75 (best fixed)             1748.45   9/9
     *   argmax over trailing 20            1826.98   +4.5% over best fixed
     *   same rule, time order SHUFFLED     1622 median, p95 1806
     *
     * Real beats 98% of 300 shuffles and the shuffled score sits BELOW flat, so the whole
     * gain is temporal structure: the rule picks 1.25 on 19% of launches and 3.00 on 20%,
     * and no single number is right on both. N=5..20 all win; N>=25 does not (noise
     * dominates); "yesterday's best bar today" loses $87; threshold-fitted peak signals
     * overfit and lose on holdout. Only the direct empirical argmax survives.
     *
     * WHY THIS LIVES WHERE SIX TRAILING-WINDOW SENSORS DIED: every dead rule decided HALT
     * or TRADE, where a wrong halt skips the money entirely. The bar is continuous. A wrong
     * bar still trades and still usually wins, just less; the cost of error is the spread
     * between bars, not the whole trade. Adapt the cannon, never close the gate.
     *
     * Ties go to the LOWEST bar, matching the research (Python max() on an ascending list).
     * The bar set is published so gatewatch scores exactly these and nothing else.
     * See research/wind.py, wind2.py, wind3.py.
     */
    adaptive: {
      enabled: true,
      window: 20,
      bars: [1.25, 1.36, 1.50, 1.75, 2.00, 2.50, 3.00] as ReadonlyArray<number>,
    },
  },
  // trailPct/armAtMultiple deleted 2026-08-18. The trail armed at +20% and fired 50% off
  // the peak; with a take profit at +21% there is no longer a reachable band between the
  // two, and it had already fired exactly once in 656 simulated trades before that. A
  // safety net that cannot fire is worse than no safety net, because it reads like one.
  // The hard stop stays: it is reachable, and it is the only thing under the position if
  // a curve collapses before it ever gets near the take profit.
  hardStopMultiple: 0.5,
  // 45_000 -> 90_000 on 2026-08-27. This is the single largest effect in the whole refit.
  //
  // The coin lifecycle decompressed: peaks now land at 70-90s where they used to land near
  // 30s, and a 45s clock was selling into the middle of the move. Dose response on the same
  // 1,129 book launches, no take profit, no bailout, per trade:
  //   30s +0.32   45s +0.46   60s +0.79   75s +1.05   90s +1.12   105s +1.10   120s +0.94
  // Smooth, single-peaked, and it turns over after 105s, so 90 sits on a plateau rather
  // than on a spike. Positive in 7 of 7 days at 90s; the 45s clock manages 5 of 7.
  //
  // THE HONEST GAP, and it is the one claim in this file with no direct live confirmation:
  // we have never held a position for 90 seconds in live trading. The replay is validated
  // against 45s exits, where it matches booked P&L within $0.04/trade over 291 trades.
  // Ninety seconds is that same price path extended, not a measured result. It agrees with
  // the peak timing measured independently from gate.db, which is why it ships, but the
  // first day back IS the test. If p50 hold lands near 90s and the P&L does not follow,
  // this is the line to revert.
  //
  // 90_000 -> 45_000 on 2026-08-27. THE TEST ABOVE RAN AND THE CONDITION IT NAMED WAS MET.
  // p50 hold landed at 92.8s and the P&L did not follow: 30 live trades, -$86.46, -$2.88
  // per trade, and the worst day on record. So this reverts on its own terms.
  //
  // The dose response above is not withdrawn, it is downgraded. It came from a replay that
  // was later shown to mis-rank configs, and the fix list is in scripts/engine.py: the
  // sim's mark started at 0.9930 rather than 1.0000 because entry_px buried the fees in
  // the denominator, clock exits got a free 0.6s head start over bail exits, and the sim
  // priced graduation exits the live bot could not make. All three flatter a long clock.
  // Post-fix the sim reproduces the 45s eras to $0.083/trade; it has never been validated
  // against a 90s clock, because no validated era ever ran one.
  //
  // What IS live-measured, grouping every closed trade by the settings it ran under:
  //   45s clock + 20s bail   795 trades   +$161.87   +$0.204/trade   08-20..08-27
  //   90s clock + no bail      30 trades    -$86.46   -$2.88 /trade   08-27 16:38..18:06
  // Reverting to the row with 26x the sample. If the lifecycle really has decompressed,
  // it will show up in gate.db's peak-timing distribution first, and that is the signal to
  // try this again -- with the clock as the ONLY variable, not three at once.
  maxHoldMs: 45_000,
  /**
   * THE DEAD-COIN BAILOUT. 2026-08-19, from a full-path replay of all 291 epoch trades.
   *
   * A coin that never moves, never will: of 56 take-profit winners on the filtered book,
   * 98% had printed >=1.02x (sim scale) by 20s and 100% by 25s -- not one winner was
   * still flat at 25s -- while 76 of 119 losers never touch it at all. Meanwhile the farm
   * duds drain the curve to ~0.63 by the 45s clock, and the drain is mostly done by 30s,
   * so waiting for the clock is paying full price for a verdict that was in at 20s.
   * Bailing flat coins at 20s scored +$18.18 (filtered book) / +$32.96 (unfiltered) over
   * the two replay days; at 25s the drain is already done and the save shrinks to ~$1.
   *
   * The honest cost: win rate 49% -> 43% and median -1.3% -> -1.5% on the filtered book,
   * because flat coins that would have drifted to tiny clock wins become definite small
   * fee-losses. This buys disaster insurance with many small premiums. Its real job is
   * bounding the ~minObs-trade learning bleed while the template gate scores a new farm
   * value, so judge it with the book filters on, not alone.
   *
   * belowMult is BOT SCALE: mark/entryMark starts at exactly 1.0 here while the sim's
   * mark ratio starts at 0.9907 (same conversion as the take profit's 1.21 note above),
   * so the replayed 1.02 is 1.02 / 0.9907 = 1.0296 -> 1.03. NEVER raise it far: at a
   * replayed bar of 1.10 the same rule LOSES $25-50 because slow winners hover under +10%
   * for 20s+ before popping. Pinned onto the position row at open (positions.dead_after_ms
   * / dead_below) so recon.py replays the rule each row actually ran.
   */
  // DISABLED 2026-08-27 by setting afterMs to 0 (exit.ts short-circuits on that; a plain 0
  // without the guard would sell every position on its first tick).
  //
  // The measurement above was honest for the era it was taken in and is now inverted. On
  // the 1,129-launch replay, same 2.00 bar and 90s clock, per trade: no bailout +$0.89,
  // bail at 20s/1.03 +$0.43, bail at 15s/1.02 +$0.44, bail at 10s/1.02 +$0.39. It also
  // drags the win rate from 49% to 30%, because in a 70-90s-peak era a coin that is flat
  // at 20s is not dead, it is early. The live record agrees: over the 24h before the halt,
  // 63% of the coins this rule bailed on went on to print 1.03x.
  //
  // Kept as a switchable knob rather than deleted. If the lifecycle compresses back toward
  // 30s peaks -- watch the gate's peak-timing distribution, not the P&L -- this is the
  // first thing to turn back on.
  //
  // RE-ENABLED 2026-08-27 at 20s. The inversion above was measured with a broken bar.
  //
  // This rule is the one the engine's mark-scale defect hit hardest, and the arithmetic is
  // exact: the sim's mark ratio started at 0.9930 instead of 1.0000, so a 1.03 bar became
  // an effective 1.0373 and the replay declared dead every coin whose real peak landed
  // between 1.030 and 1.037. Against a 2.00 take profit that same 0.7pp offset is a 0.35%
  // distortion and changes nothing; against a 1.03 bar it is 23%. So "no bailout +$0.89 vs
  // bail at 20s +$0.43" compared a working rule against a sabotaged one, and the 30-point
  // win-rate drag it reported is the signature of exactly that over-bailing.
  //
  // The 63%-print-1.03x observation was real but is not evidence against the rule: it
  // counts coins that later touched the bar, not the money that touching it was worth. The
  // bailed coins that do come back come back small, which is what the original replay
  // priced and what the live record confirms.
  //
  // Live, and this is the whole argument: every trade booked under 20s/1.03 sits in the
  // 795-trade +$161.87 era, and every trade booked with the bailout off sits in the
  // 30-trade -$86.46 one. Pinned per position at open, so recon.py replays what each row
  // actually ran and this comment cannot silently go stale.
  deadCoin: {
    afterMs: 20_000,
    belowMult: 1.03,
  },
  // leave when this fraction of sellable supply is left. graduation slams the door:
  // at zero the curve refuses sells and the position cannot be exited at any price.
  graduationExitAt: 0.12,

  // slippage ladder for the buy; the sell ladder widens to 1 wei because
  // there is no mempool to be sandwiched by and a bad fill beats a bag
  //
  // 500 -> 1500 on 2026-08-19. THIS BOUND WAS A MOMENTUM FILTER POINTED THE WRONG WAY.
  //
  // minTokensOut is a pure bound (state/curve.ts checks it AFTER computing tokensOut and
  // never changes it), so widening cannot worsen a fill that already succeeds. It only
  // decides whether a buy reverts. And realised slip on fills is ~0: median 0.00%, p90
  // 0.56% over 345 live buys, because on a normal launch nothing happens in the ~1s
  // between our quote and our fill. The cap therefore protected us on nothing and fired
  // only on the coins where insiders were piling in during the wait.
  //
  // Which is exactly the wrong population to refuse. Replaying 586 launches over two
  // disjoint 24h windows: coins that breach 5% reach 1.4x at 47.4% against 15.5% for the
  // coins we do fill (P=0.001). Live, the cap cancelled STRATA (4.45x), MESH (2.71x),
  // ULON (2.23x) and SIGHT (1.91x) in six hours while our best actual fill did 2.00x.
  //
  // 1500 and not higher: above ~15% the median 45s exit is 0.869, i.e. the coin spikes and
  // hands it all back inside the hold, and that band's profit in the backtest was one coin
  // (SPURDO, 5.21x) -- drop it and the band is -$10. The 5-10% band survives the same
  // jackknife (+$19 without its best coin). 15% keeps the sweet spot and stays out of the
  // dump zone. Backtested delta vs 500: +$31/day and +$6/day, positive in BOTH windows.
  // 1500 -> 2000 on 2026-08-19. Measured against the new schedule over three disjoint
  // windows: 5% -> +225.9 (unstable), 15% -> +257.0, 20% -> +273.9, 30% -> +274.3, no cap
  // -> +274.3. 30% and no-cap are the SAME NUMBER because zero launches in 48h slipped
  // past 30%, so the cap stops binding around 20% and anything wider is decoration.
  //
  // 2000 -> 5000 on 2026-08-26. Every number above was inferred from a simulated
  // quote->fill gap; this one is MEASURED, and it moved the answer a long way. See
  // slipreal.py (the measurement) and capreal.py (the economics), both in archive/purged-sims-20260827.tar.gz.
  //
  // The measurement has no free parameters. minTokensOut is recorded per entry and the bot
  // built it as expected*(1-cap), so `expected` comes back exactly; the event-log replay
  // says what the curve would really have paid at the fill block. Validated first against
  // chain truth -- it reproduces 373 of 379 real fills to inside 1% (median error 0.00%).
  // Every one of the 25 reverts measures slip > 20% and none measures below it, which is
  // exactly what a 20% cap must produce and is the check that the method is sound.
  //
  // Realised slip is BIMODAL, which is why intermediate caps are so weak: fills slip a
  // median of 0.00% (p90 2.14%), reverts slip a median of 29.9% (p10 21.2%, max 71.8%).
  // There is nothing in between to tune. A cap either sits below the gap or above it.
  //
  // Totals over 403 attempted entries / 145h, priced at the REAL degraded entry (the coin
  // has already gapped 20-72% by the time we fill, so it is entered at the fill block and
  // the worse entry falls out of the curve state rather than being modelled on top):
  //   20% +$78.17   30% +$136.54   40% +$144.51   50% +$178.80   60% +$177.95   off +$175.54
  // 50% is the peak, and 30 -> 50 is +$42.26 with a 90% CI of [+15.52, +71.28], P(worse
  // than refusing) = 0.000 across 9 trades that win 89% of the time. It survives deleting
  // its single best trade (+$26.11 over the remaining 8) and it wins in three of four
  // disjoint windows; the fourth prefers 20% by $1.16 on n=52, i.e. noise.
  //
  // Win rate goes 30.5% -> 34.7% and top-5% concentration FALLS 346% -> 163%, so this is
  // not buying a fatter tail, it is buying the middle of the distribution. That matters
  // under the median/concentration ranking rule this project runs on.
  //
  // 5000 and not higher, and this is a real turning point rather than the edge of the
  // data: the three entries above 50% slip are all losers (-$3.26 together, P(worse than
  // refusing) = 1.000) and they peak at 0.98x, 1.29x and 1.72x FROM OUR ENTRY. A coin that
  // gapped more than half before we filled has already spent its move. Uncapped scores
  // $3.26 WORSE than 50%, so the fuse is free: if `expected` were ever computed wrong the
  // apparent slip would be enormous and this is the only thing that refuses the trade.
  buySlippageBps: 5000,
  // The sell ladder. EMPTY since 2026-09-06: every attempt goes out at the floor below.
  //
  // It was [300, 1000, 2500, 5000] bps, and the first rung was a pure cost. A sell's bound
  // only decides whether the sell reverts; the curve pays the curve's price at mining time
  // either way, and there is no mempool here to be sandwiched in. So the bound never
  // improved a fill. It only refused one, and every refusal cost SELL_CONFIRM_MS (3s) plus
  // a retry on a coin that was, by construction, moving fast. Last 24h on the box: 41
  // positions reverted at least once (58 reverts, ~$0.10 of gas each). The 29 hard stops
  // among them filled at a median 0.31 of their first quote (p10 0.21); the 2 that landed
  // first time filled at 1.00. Across every exit reason the clean fills sat at 1.000 and
  // the reverted ones at 0.31 (stop), 0.70 (tp), 0.90 (dead, time): not one class where
  // waiting bought a better price. Money left between first quote and fill on the 9
  // main-book stops of 09-05: $38.84 of $59.62 quoted. The note on buySlippageBps above
  // ("a bad fill beats a bag") already said this; it just started three rungs too late.
  sellSlippageLadderBps: [] as readonly number[],
  // 1 wei: the sell lands at whatever the curve pays. See the ladder note above.
  sellFinalMinQuoteOut: 1n,
  exitRetryDelayMs: 300,
  /**
   * How many sells a position may send before it parks. NEW 2026-09-04.
   *
   * The widening ladder answers a slippage revert and nothing else, and it had no ceiling.
   * Position 1438 recorded 166,454,718,398,244,681,223,641 tokens from its CurveBuy event
   * while the wallet actually held 166,022,388,824,117,598,926,233 (0.26% short), so every
   * sell reverted on insufficient balance, and the loop sent 945 of them at $0.107 each
   * in the 3.6 hours that the book was reporting +$52. The wallet finished $54 down.
   *
   * 20 is about $2 of gas at today's prices: enough for the 30s diagnosis to run three
   * times and correct a short balance or a lost approve, not enough to eat a session.
   */
  maxSellAttempts: 20,

  // THE REGIME GATE. Not a filter on coins, a switch on whether to trade at all.
  //
  // First principles, measured over 1,413 launches: a coin that pops to the take profit
  // inside the hold pays +$5.37; one that does not costs -$1.20 when the clock sells it.
  // A win is worth 4.5 losses, so we break even when 18.2% of coins pop. That is the
  // whole threshold, and everything below is just measuring it.
  //
  // `window` launches of rolling history is the estimate. It predicts honestly (gate
  // reading -> fraction of the NEXT coins that pop): 0-15% -> 21.8%, 25-35% -> 34.2%,
  // 45-55% -> 46.1%, 55%+ -> 50.7%.
  //
  // shutAt 20 sits just above the 18.2% break-even; openAt 25 adds margin so one coin
  // cannot flap it.
  //
  // `window` is a MOVING AVERAGE and therefore lags, which is the whole design tension:
  // 40 launches sounds like a smoothing choice but it spans a median 3.5h of venue (up to
  // 37h when launches are sparse), so the bot acts on a reading roughly 2h stale. It was
  // set to 40 first and that was simply too slow. Simulated properly - watcher polling on
  // its real 5-minute timer, a launch unscoreable until its 45s window closes, and the $75
  // stop ENDING the run rather than being traded through - over 150 rolling 48h runs at
  // 0.005 ETH on the 283h history:
  //
  //     window     median$   p10$   worst DD   P(hit $75)
  //     none        +76.3   +29.5      -80.1        14.0%   <- dies 1 run in 7
  //     W10         +61.8    +1.3      -40.0         0.0%
  //     W20         +55.2    +2.1      -35.8         0.0%
  //     W40         +37.7    +0.0      -35.8         0.0%
  //     W60         +27.6    +0.0      -43.5         0.0%
  //
  // Monotone in window length, which is what makes it a signal rather than a lucky cell:
  // every step of extra lag costs money. W10 edges W20 on the median but each launch moves
  // a 10-window by 10pp, so it can flip on a single coin; W20 is the shortest window whose
  // reading is not mostly noise.
  //
  // Not trading through the stop is the whole point. Never stopping has the better median
  // at every horizon (96h: +184 vs +156) and a 14.7% chance of being permanently halted
  // before it collects it. We are choosing the smaller, survivable number on purpose.
  //
  // scripts/gatewatch.py reads these from the published strategy, never its own copy.
  // shutAt 20 -> 15 on 2026-08-19, from the current-era band table (../research/era_dynamics.py).
  // Bucketing 718 traded launches by the gate reading at entry gives a monotone ladder:
  //   reading 0-15%  n= 58  mean -1.71%  win 38%   <- the only genuinely bad band
  //   reading 15-25% n= 48  mean +3.28%  win 46%   <- shutting here forfeits money
  //   reading 25-35% n=163  mean +4.32%  win 48%
  //   reading 35-45% n=172  mean +7.84%  win 63%
  //   reading 45%+   n=277  mean +7.11%  win 59%
  // corr(reading, next return) +0.085, permutation p=2.1% over 2000 shuffles. Shutting at
  // 20 halted on a band that still pays; 15 puts the threshold where the sign actually
  // flips. Also restores a real hysteresis band: at window 20 the rate moves in 5pp steps,
  // so 20/25 shut at <=4-of-20 and reopened at >=5-of-20, a zero-width gap that flapped.
  // 15/25 shuts at <=3 and reopens at >=5, leaving one step of dead zone.
  // Scored over the last 24h (356 launches): +$162.46 vs +$153.54 ungated, max drawdown
  // $13.72 vs $27.01, 3 halts. Best of nine configs on BOTH axes.
  // shutAt 15 -> 10 on 2026-08-19, together with the book widening above. The two are one
  // change: a gate earns its keep by cutting the worst launches, and 15 was tuned against
  // a book so tight there was little left to cut. On the widened book the loose gate is
  // worth +$19 held out ($130.40 vs $111.45 with no gate at all) and it halves drawdown
  // ($10.27 vs $20.67), while 20/15/25 on the same book gives back money for nothing.
  gate: {
    window: 20,
    openAt: 25,
    shutAt: 10,
    /**
     * The bar the gate measures the cohort against. DELIBERATELY NOT takeProfitMultiple.
     *
     * It used to be: both gatewatch.py and the in-process scorer read the bot's own take
     * profit, so "did our rule find a winner here" was the question. That reads well and
     * is a trap, because it makes the ruler move whenever the policy moves. Raising the
     * take profit 1.21 -> 1.25 would, with openAt/shutAt untouched, have taken the share
     * of windows sitting below shutAt from 6.9% to 14.8% and the share below openAt from
     * 30.3% to 43.6%, measured over all 485 scored observations. The gate would have
     * roughly doubled its halt rate and nobody would have changed a gate setting.
     *
     * A regime detector has to be a fixed yardstick or its own history is uncomparable:
     * you can no longer tell whether the venue moved or your ruler did. Pinned at 1.21,
     * which is where every existing calibration was measured (shutAt 10 sits at the 0th
     * percentile of this distribution, openAt 25 at the 2.3rd), so decoupling costs
     * nothing today and stops the next take-profit change from silently re-gating us.
     */
    touchMultiple: 1.21,
    /**
     * How long a launch is watched before its verdict is scored, in ms.
     *
     * The second half of the same argument as touchMultiple. `maxHoldMs` is an exit policy
     * and is allowed to move; the gate's observation window is a measurement and is not.
     * Shortening the exit clock to 30s while this stayed coupled would have silently
     * re-measured every touch rate over a shorter window and re-gated the bot against
     * openAt 25 / shutAt 10, which were calibrated at 45s. Pinned where they were.
     *
     * Published as gateHoldMs and read by gatewatch.py, so both halves observe the same
     * span. test/gatebar.test.ts locks the pair together.
     */
    holdMs: 45_000,
    /**
     * Whether the halt decision may use the bot's own in-process cohort scoring
     * (strategy/cohort.ts) instead of gatewatch.py's five-minute file.
     *
     * OFF BY DEPLOY, ON BY EVIDENCE. With this false the scorer still runs and still logs,
     * so its verdicts can be joined against gate.db.obs token by token to prove the two
     * agree before anything trades on it. Turning it on without that comparison is exactly
     * the sim-vs-live gap that has bitten this project twice.
     *
     * GATE_LIVE=1 to enable.
     */
    live: process.env.GATE_LIVE === '1',
    /**
     * The bar the P&L sensor values a scored launch at. FIXED, and for exactly the same
     * reason touchMultiple above is fixed: a regime detector has to be a yardstick, and
     * the adaptive take profit moves every twenty launches. Valuing the venue at whatever
     * bar the bot happens to be trading would make the sensor's own history uncomparable
     * and let a take-profit change re-gate the bot with nobody touching a gate setting.
     *
     * 1.75 is the fallback bar and the one the 2026-09-07 measurement was made at. It must
     * stay inside STRATEGY.takeProfit.adaptive.bars, because gatewatch replays only the
     * bars published there and a bar it does not score would leave the sensor blind;
     * test/venue.test.ts pins that.
     */
    pnlBar: 1.75,
    /** entries pause below this sum of stakes over the window, and resume above the next */
    get pnlPauseWindow() { return live().venuePauseWindow },
    get pnlPauseOff() { return live().venuePauseOff },
    get pnlPauseOn() { return live().venuePauseOn },
    /** the window must fit inside this many ms or the sensor has no opinion */
    get pnlFreshMs() { return live().venueFreshHours * 3600_000 },
    /** the drawdown stop's own resume evidence: launches scored since it fired */
    get ddResumeWindow() { return live().ddResumeWindow },
    get ddResumeOn() { return live().ddResumeOn },
  },
} as const

export const RISK = {
  /**
   * THE KILL SWITCH, in ETH from the peak. Same unit as TRADE_SIZE_ETH on purpose: divided
   * by the trade size this IS the stake multiple, and the stake multiple is what every
   * replay fits. 0.112 ETH at a 0.02 stake is 5.6 stakes, which is the number the 21-day
   * tape chose over 2.3, 3.7, 4.7, 7.0 and 9.0.
   *
   * It was denominated in dollars until 2026-09-07, which coupled it to ETHUSD and meant a
   * stale price silently moved it: with $2145 configured against a real $2515, the "$240"
   * limit was really $282, 17% wider than it read. The ledger it is compared against has
   * always been wei, so this unit removes a conversion rather than adding one.
   *
   * WHAT THE NUMBER BOUGHT, from the 150 simulated 48h runs that chose the original bound:
   * a stop at all was the smaller, survivable choice over never stopping, which had the
   * better median at every horizon and a 14.7% chance of being permanently halted first.
   * Since 2026-09-07 it also lifts itself on the venue's own scores, at most twice a UTC
   * day, so the survivability it spends is much smaller than it was when a trip meant a
   * night off waiting for a person.
   *
   * env-overridable and hot, so an operator can trip it without a code change. Setting it
   * below the current drawdown runs the tested flatten-then-idle path, which is the point:
   * killing the process is the one thing that strands open bags (see haltPhase). The
   * dashboard's stop button is the better lever for that now.
   */
  get maxDrawdownEth() { return live().maxDrawdownEth },
  /**
   * THE WALLET-WIDE STOP, the other drawdown. Read by telemetry/truth.ts, which compares the
   * real balance against peak_flat_wei and therefore cannot attribute a loss to a book.
   *
   * maxDrawdownEth above is an accounting figure over closed positions rows and splits per
   * book; this one measures the wallet and cannot. Before this existed both fired at the same
   * number, so per-book allowances were unreachable by construction. Resolved in
   * config/store.ts as books x maxDrawdownEth when MAX_WALLET_DRAWDOWN_ETH is unset, which
   * with one book is maxDrawdownEth, i.e. exactly today.
   */
  get maxWalletDrawdownEth() { return live().maxWalletDrawdownEth },
  /**
   * THE BOT-BROKEN HALT (strategy/broken.ts, 2026-09-07). Losing money is a market; losing
   * money the same coins did not lose is a bug in us, and the two need different answers.
   *
   * Every real loss this bot has taken in September was the second kind: the $101 burned
   * gas retry loop on 09-04, and the same-block log drop on 09-06 that mispriced every busy
   * coin for five hours while the venue paid +14% a launch. Both were found by a person
   * looking. This is the check that finds them: our own return per trade against what
   * gatewatch's replay says the same tokens were worth, over the last 20 closed trades.
   *
   * `brokenFactor` is what real money has historically made per unit of replay: 0.78 over
   * 463 paired trades in September and 0.80 over 145 in August. It is not a fudge, it is
   * the honest gap between a replay that pays no gas, no slippage and enters at a fixed
   * block offset, and a bot that pays all three. Re-measure it when the trade size moves:
   * it was fitted at 0.003-0.01 ETH and the book now trades 0.02.
   */
  brokenWindow: 20,
  brokenFactor: 0.78,
  get brokenGapPp() { return live().brokenGapPp },
  /**
   * ONE ETH price for the whole tree, and since 2026-09-07 a DISPLAY number only.
   *
   * The history is why the distinction is written down. The comment here once said "only
   * used for reporting thresholds" while the value was in fact driving the kill switch,
   * and three different prices (1885 here, 2145 in the monitors) meant one trade showed
   * different dollars in different places. Then it went stale in the other direction: a
   * configured 2145 against a real 2515 made the drawdown stop 17% wider than its label.
   *
   * Both problems are gone for the same reason: no stop reads this any more. The drawdown
   * limit is ETH and the daily cap is deleted, so this scales nothing that decides
   * anything. That is what makes it safe for telemetry/price.ts to refresh it hourly from
   * an external API, which would otherwise have handed an HTTP response the power to move
   * a kill switch. This value is the boot seed and the fallback when no fetch has landed;
   * the live number is published to chain_truth.eth_usd for every script to read.
   */
  get ethUsd() { return live().ethUsd },
  // no entries while the authoritative stream is this stale
  maxLogsStalenessMs: 3_000,
  // curve whose optimistic overlay outruns confirmed state by this much is degraded
  maxOverlayAgeMs: 1_500,
} as const

/** FCFS: priority fees are ignored and refunded on Orbit. Never bid. VERIFIED */
export const GAS = {
  maxPriorityFeePerGas: 0n,
  baseFeeMultiplier: 4n,
  minMaxFeePerGas: 500_000_000n, // 0.5 gwei floor
  // hardcoded because eth_estimateGas is inflated on arbitrum lineage and costs an RTT.
  //
  // THESE ARE A BID SIZED FOR THE TAIL, NOT THE MEDIAN. Unused gas is refunded, nothing
  // in the tree budgets against a limit (gasCostEth is exported and called nowhere), and
  // burning a full 400k at the 0.5 gwei floor is $0.43 worst case against a $16 trade. So
  // the only thing a tight limit buys is lost entries.
  //
  // buy 150_000 -> 400_000 on 2026-08-19. It was calibrated when the book only passed
  // creator-tax-0 coins costing ~99.6k (p50 99,618 / max 102,638 over 17 receipts). Then
  // the book widened to admit ctax 100/200bps launches, which went 0% -> 18% of everything
  // that passes, successful buys climbed to 118,040, and SIX buys in the next four hours
  // burned the entire limit and reverted: 149,856 / 149,858 / 149,898 / 149,899 / 149,902
  // / 150,000 exactly, status 0 and zero logs, which is what out-of-gas looks like on a
  // receipt. Buy failures went 6/297 (2.0%) -> 9/24 (37.5%), p=5.6e-10 on an exact
  // binomial. Nothing alerted, because nothing watched buys.
  //
  // 400k is deliberately past what the evidence pins down: the node is pruned, eth_call at
  // a historical block answers "metadata is not found", so the failures cannot be traced
  // and their true ceiling is unknown beyond ">150k". The jump from 118k to >150k says
  // they take a different path, and a buy that tips a curve into graduation runs the
  // migration, which is plausibly 300k on its own. positions.buy_gas_used now records raw
  // units per leg, so replace this with the measured p99 once a day of trades has landed.
  //
  // sell 260_000 -> 400_000 in the same pass. Sells are healthy today (p50 78,146 / p95
  // 94,541 / max 94,541 over 17 receipts, 2.75x clear) and none has ever run out of gas. It
  // moves anyway for two reasons. A failed sell is strictly worse than a failed buy: it
  // leaves a bleeding position that reconcileSell retries twelve times while widening a
  // slippage bound that was never the problem. And graduationExitAt exists because a curve
  // CAN slam the door mid-hold, which is precisely the expensive path a tight ceiling would
  // fail on. Refunds mean there is nothing to trade off.
  limits: { buy: 400_000n, approve: 80_000n, sell: 400_000n },
  // What we actually burn, measured from 40 receipts on 2026-08-18: buy p50 100,161,
  // sell p50 77,276 / p95 113,472, at an effectiveGasPrice of 0.0200 gwei. Confirmed
  // 2026-08-19 on 34 more receipts: buy p50 ~100k either side of the book widening, sell
  // p50 78,146 / p95 94,541. Charging P&L at limit x maxFee overstated cost by 71x and fed
  // a phantom drawdown into the kill switch, so these stay the accounting numbers and
  // truth.ts backfills real receipt gas over the top of them.
  used: { buy: 105_000n, approve: 50_000n, sell: 100_000n },
} as const

/** The two persistently profitable wallets. Mirrored in shadow to learn their selection. */
export const WINNERS = [
  '0x03c724b1c53da1edf4a81e95e99e05e75311c182', // +11.3% ROT, 268 trades
  '0xe224ef47ac009fc7d0eee7f7ccb23131a26670bc', // +5.9% ROT, 1007 trades
] as const

export const LIVE = process.env.LIVE === '1'
export const PRIVATE_KEY = process.env.PRIVATE_KEY ?? ''
