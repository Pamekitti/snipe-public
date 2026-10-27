/**
 * Every display threshold, in one table, and nothing else in this directory holds one.
 *
 * TWO KINDS OF NUMBER, AND ONLY ONE OF THEM BELONGS HERE. A threshold the BOT acts on lives
 * in `strategy.toml` and reaches the projection through `state.config`. A threshold that only
 * decides how something is drawn, or when to say something out loud, lives here.
 *
 * The old `alerts.ts` blurred the two: it hand-copied `logsStaleWarnMs: 3_000`,
 * `overlayStaleWarnMs: 1_500` and `sensorStaleWarnMs: 10_800_000` out of the spec, so tuning
 * the spec moved the moment entries start refusing without moving the moment the operator is
 * told. Those three are deliberately absent; the alert builder reads
 * `config.risk.maxLogsStalenessMs`, `config.risk.maxOverlayAgeMs` and
 * `config.guard.maxReadingAgeMs` instead, so the alert fires at exactly the number the bot
 * refuses at.
 *
 * `rings.test.ts` fails if a numeric literal appears in a comparison anywhere else under
 * projections/, which is the mechanical version of the paragraph above.
 */

export const LEVELS = {
  // -------------------------------------------------------------------------
  // Colour: when a number stops reading as fine
  // -------------------------------------------------------------------------

  /** a book or the wallet past this share of its own stop is worth colouring, and then saying */
  drawdownWarnFraction: 0.6,
  drawdownCritFraction: 0.85,

  /** this share of the wallet's slots in use */
  capacityWarnFraction: 0.8,

  /**
   * How far through a position's pinned hold clock before the age bar changes colour.
   *
   * Copied from watching the v1 bar: amber near the clock, red once the clock has passed.
   * The bot already exits on `maxHoldMs`; this only paints the bar the operator is staring at.
   */
  holdWarnFraction: 0.8,
  holdCritFraction: 1,

  /**
   * Remaining sellable supply on an open row. Copied from v1's open card: amber under 40%,
   * red under 20%. The bot already exits on `graduationExitAt`; this only paints the cell.
   */
  supplyLeftWarnFraction: 0.4,
  supplyLeftCritFraction: 0.2,

  /**
   * How far toward the bot-broken halt the gap may drift before the page says so.
   *
   * The halt is placed at `risk.broken_gap_pp`; this fires at two thirds of it, because a drift
   * that has not reached the halt is the cheapest moment to find the bug. On 2026-09-06 this would
   * have been the first warning that v1's book was mispricing, about twenty minutes in, against
   * the five hours it actually took a person to notice.
   */
  brokenWarnFraction: 2 / 3,

  /**
   * The funnel: one bucket taking this share of all refusals means a stage is stuck.
   *
   * 1.0 and not 0.9: below 100% the remaining refusals prove the other stages are still
   * reached, and a stage that is merely dominant is normal. Every launch stopping at one
   * bucket is not.
   */
  bucketDominanceFraction: 1.0,
  /** below this many refusals the dominance check has no power and must not fire */
  bucketDominanceMinimum: 20,

  /**
   * How far back the send-failure alert looks.
   *
   * An hour, because that is roughly how long the 2026-09-16 chain-id failure ran before anyone
   * asked why the wallet had not moved, and because a shorter window lets a broken send path go
   * quiet between launches on a slow night while still being broken.
   */
  sendFailureWindowMs: 3_600_000,

  /**
   * How the kept bar is coloured: what share of the run available to us we actually took.
   *
   * Replaces the literals at the old `dashboard-page.ts:665`. Same cuts, one place, and
   * reachable by a test.
   */
  keptGoodFraction: 0.7,
  keptWarnFraction: 0.3,

  /**
   * How much of the independent run we left on the table before the Peak cell goes amber.
   *
   * Copied from the old `dashboard-page.ts` scan: `truePeak - exitMult > 0.10`. A tenth of a
   * multiple is the smallest miss the eye picks up on a 2-decimal column; smaller than that
   * is noise against the round-trip.
   */
  leftOnTableWarnMultiple: 0.10,

  /** a win rate at or above this reads as working. Below, it reads as needing a look. */
  winRateGoodPct: 50,

  // -------------------------------------------------------------------------
  // Size: how much of anything is drawn
  // -------------------------------------------------------------------------

  /** how many closed trades the exits table keeps. Bounds the history fold's own list. */
  exitsKept: 40,
  /** closes older than this leave the chart list. Matches the longest lookback (7d). */
  chartTradesHorizonMs: 604_800_000,
  /** the most points a chart draws. Minutes are grouped up to this; see downsample(). */
  seriesPoints: 120,
  /** rows in the outcome histogram, which is a fixed vocabulary of exit reasons */
  outcomeRowsMax: 8,

  // -------------------------------------------------------------------------
  // Chart geometry, matching the live v1 uPlot panes
  // -------------------------------------------------------------------------

  paneWalletPx: 185,
  panePaperPx: 185,
  paneVenuePx: 175,
  paneVolumePx: 235,
  /** y-range padding as a fraction of (max - min), so a flat hour is not a 1px wiggle */
  chartRangePad: 0.15,
  /** below this span the y-axis is treated as a constant series and padded in the unit */
  chartMinRange: 0.000000001,
  chartConstantPad: 0.0005,
  /** axis decimals: account ETH, market stakes, coins count */
  paneWalletDecimals: 5,
  paneMarketDecimals: 2,
  paneCoinsDecimals: 0,
  /** seconds of slack before a drag is treated as a zoom, so float noise does not show the chip */
  chartZoomSlopSec: 1,

  /**
   * Coins stack: bar width as a fraction of the slot, then clamped in CSS pixels.
   *
   * Copied from v1. A pure fraction draws slivers at 1h and slabs at 7d; clamping lets the
   * gaps carry the spacing and keeps a drag-zoom from turning bars into a wall.
   */
  chartBarSlotFraction: 0.55,
  chartBarMinPx: 1.5,
  chartBarMaxPx: 11,
  /** a one-pixel gap between stack segments, but only when the segment is taller than this */
  chartSegGapMinPx: 3,
  /** room between the plot and the time labels for the return strip */
  chartStripOffsetPx: 5,
  chartStripHeightPx: 8,
  chartStripLabelGapPx: 3,
  chartXAxisSizePx: 82,
  chartXAxisGapPx: 36,
  /** below this |net| the strip stays grey rather than reading as a verdict */
  chartNetQuiet: 0.05,
  /** |net| at which the strip colour is full. Copied from v1's 1.6 stakes. */
  chartNetFull: 1.6,
  chartStripAlphaFloor: 0.35,
  chartStripAlphaGain: 0.65,
  /** skip a strip number when the slot is narrower than this, so labels do not collide */
  chartNetLabelMinSlotPx: 28,
  /** decimals on the strip numbers. Axes stay on paneCoinsDecimals. */
  chartStripDecimals: 1,
  /** trade-dot radius in CSS pixels: min + gain * sqrt(|pnl| / window max). Copied from v1. */
  chartDotMinPx: 2,
  chartDotGainPx: 4,
  /** halt-band fill opacity on the virtual pane. Copied from v1's account shade. */
  chartBandAlpha: 0.18,

  /**
   * How many decimals an axis tick gets, chosen by the size of the range rather than the value.
   *
   * A wallet chart spanning 0.003 ETH labelled to two decimals prints "0.08, 0.08, 0.08", and a
   * millisecond axis labelled to four prints noise. Driving the precision off the magnitude is
   * the only way one formatter serves an ETH axis, a latency axis and a count axis, and it is a
   * table rather than a chain of literals so `rings.test.ts` can still see every number.
   */
  tickPrecision: [
    { atLeast: 1000, decimals: 0 },
    { atLeast: 10, decimals: 1 },
    { atLeast: 1, decimals: 2 },
    { atLeast: 0.01, decimals: 3 },
    { atLeast: 0, decimals: 4 },
  ],

  /**
   * The hold-time histogram's buckets, in seconds, with the label each one prints.
   *
   * Cut where this strategy's exits actually cluster: the take-profit and the hard stop fire in
   * the first seconds, the dead-coin rule at tens of seconds, and the clock last. Even buckets
   * would put almost every trade in the first one.
   */
  holdBuckets: [
    { underSec: 10, label: '0–10s' },
    { underSec: 30, label: '10–30s' },
    { underSec: 60, label: '30–60s' },
    { underSec: 300, label: '1–5m' },
  ],
  holdOverflowLabel: '5m+',

  // -------------------------------------------------------------------------
  // The live connection
  // -------------------------------------------------------------------------

  /**
   * The floor between two pushes on one SSE connection.
   *
   * The old page reloaded itself whole every 2,000ms, which is why a selected tab, a scroll
   * position and an expanded row could not survive. This is the replacement, and it is lower
   * because a push is a few hundred bytes of changed regions rather than a whole document.
   */
  streamMinIntervalMs: 1_000,
  /** a connection with nothing to say still sends a comment this often, so proxies hold it open */
  streamKeepAliveMs: 15_000,
  /** what the browser waits before reconnecting a dropped stream */
  streamRetryMs: 2_000,

  /** POST /api/control bodies larger than this are a client bug, not a command. */
  controlBodyMaxBytes: 4096,
} as const

export type Levels = typeof LEVELS
