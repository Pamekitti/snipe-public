/**
 * Every threshold the operator display decides on, in one place.
 *
 * WHY THIS FILE EXISTS. The alert ladder and the page had grown ~45 numeric literals
 * between them, and they had drifted apart: on 2026-09-07 the page turned the feed card
 * amber at 3,000 ms while the alert that pages a human fired at 30,000 ms, the position
 * colour used 0.7 against a hard stop that sells at 0.5, and the supply-left warning used
 * 0.2 against a graduation exit that happens at 0.12. Every one of those is a number a
 * reader would reasonably assume came from the config. None of them did.
 *
 * THE RULE. A threshold lives here, or it comes from the config, or it comes from the state
 * payload. It does not live in the page and it does not live inline in buildAlerts. The
 * React page receives owner-computed guard states and the level table through the API.
 * Thresholds are tested beside the backend decisions, so the browser does not invent
 * another set of trading limits.
 *
 * EVERY ENTRY CARRIES ITS SOURCE. One of three things: a config value it must track, a
 * measured baseline with the measurement named, or a deliberate choice with the reasoning.
 * A number with no source is a number nobody can safely change.
 */

/**
 * Percentages of the kill switch at which the drawdown alert warns and crits.
 *
 * DELIBERATE CHOICE. Two thirds and four fifths of the way to a stop that halts the bot.
 * The pair exists so the overnight push has a rung before the one that matters; they are
 * not fitted and there is nothing to fit them on, since the stop's own value is the risk
 * decision and this only decides when to mention it.
 */
export const ddWarnPct = 60
export const ddCritPct = 80

/**
 * How long after boot the idle alert is allowed to fire.
 *
 * MEASURED-ish: a fresh process has closed nothing by definition, and the book takes about
 * ten minutes to open, hold and close its first trade at 16 launches an hour. Twenty gives
 * that room without hiding a real stall for long.
 */
export const bootGraceMs = 20 * 60_000

/**
 * Minutes without a closed trade before the idle alert warns.
 *
 * MEASURED: the book closes 16 to 18 trades an hour, so three minutes is the ordinary gap
 * and twenty is roughly six times that. It is the one number on this list that a quiet
 * hour can trip honestly, which is why it warns rather than crits.
 */
export const idleWarnMins = 20

// Display policy only. Two distinct flat samples must breach both bounds.
export const reconciliationFloorEth = 0.002
export const reconciliationFraction = 0.1
// Four missed balance ticks and two missed hourly price updates.
export const balanceStaleMs = 120_000
export const priceStaleMs = 2 * 3600_000
export const stateStaleMs = 10_000
// Replay verdicts need three days of coverage; monitor freshness is independent.
export const edgeCoverageHours = 72

// Existing alert policy, collected here without changing its cuts. The source comments
// beside buildAlerts document the measured baselines and deliberate warning margins.
export const ALERT_LEVELS = {
  feedStaleMs: 30_000,
  gateDataWarnMs: 3600_000, gateDataCritMs: 3 * 3600_000,
  rateMinN: 10, rotWarnPct: -5,
  nonceCritCount: 3,
  pollWarnCount: 600, pollCritCount: 1000,
  venueWarnStakes: -1,
  brokenMinN: 20, brokenWarnFraction: 2 / 3,
  modelMinN: 10, modelWarnDifference: 0.08, modelCritDifference: 0.2,
  detectMinN: 20, detectWarnMs: 3000,
  loopWarnMs: 500, loopCritMs: 2000,
  quotaWarnMillions: 27.5, quotaCritMillions: 30,
  edgeStaleMs: 36 * 3600_000, edgeCritStreak: 3,
  buyWarnPct: 10, buyCritPct: 25, gasWarnFraction: 0.7,
} as const

/**
 * The whole object, for the page splice. Named exports above are for buildAlerts, which
 * imports what it uses; this is what crosses into the browser.
 */
export const LEVELS = {
  ddWarnPct,
  ddCritPct,
  bootGraceMs,
  idleWarnMins,
  reconciliationFloorEth, reconciliationFraction, balanceStaleMs, priceStaleMs, stateStaleMs, edgeCoverageHours,
} as const

export type Levels = typeof LEVELS

/**
 * Free disk, as a percentage of the volume, at which the operator display warns and crits.
 *
 * MEASURED. The box is a 20 GiB gp3 volume. On 2026-09-13 it sat at 78% used while the
 * simulation capture grew 2.21 GB a day (92.1 MB/h over a clean five-minute window), so 15%
 * free was about a day and a half of warning and 8% about half a day. The crit matters
 * because everything the bot knows is a sqlite write: the book, the positions, the halt
 * state. A full disk does not slow it down, it stops it recording what it did.
 */
export const diskWarnFreePct = 15
export const diskCritFreePct = 8

/**
 * Resident memory at which the display warns, per process and for the tracked set together.
 *
 * MEASURED. t4g.small: 1.8 GB and NO swap. The three node processes held 760 MB on
 * 2026-09-13 (bot 331 MB, capture 289 MB, shadow 141 MB) and the page cache had to fit the
 * rest, which is what made a 43 s scan starve the trading loop. 400 MB is above every
 * measured process and below anything that could be called healthy on this box.
 *
 * The fraction rungs are about the OOM killer rather than about performance: it picks by
 * size, so the process it takes is usually the bot itself, not the worker that grew.
 */
export const memoryWarnProcessBytes = 400 * 1024 * 1024
export const memoryWarnFraction = 0.75
export const memoryCritFraction = 0.90
