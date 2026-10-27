/**
 * Is the BOT broken, or is the market bad?
 *
 * Those need opposite answers and until 2026-09-07 the bot could not tell them apart. Both
 * look identical on every panel: money going out. But a bad market reverses on its own and
 * a bug does not, so one halt should lift itself and the other must never.
 *
 * Every real loss this bot took in September was the second kind. On 09-04 a retry loop
 * burned $101 of gas while the book read +$52. On 09-06 the confirmed book dropped every
 * trade after the first in a block, so for five hours the bot sold winners at made-up
 * prices while the same coins were replaying at +14% a launch. Both were found by a person
 * reading numbers, hours in.
 *
 * The measurement is the one thing on this box that can see the difference: gatewatch
 * replays every book-passing launch under the bot's own exit rule, with our own fills
 * stripped, so for any coin we traded there is an independent answer to "what was this
 * worth". If our fills come in far under the replay, the venue paid and we did not.
 *
 * `factor` is what real money historically makes per unit of replay (RISK.brokenFactor,
 * 0.78 measured over 463 paired trades). The replay pays no gas, no slippage, and enters
 * at a fixed block offset, so it is expected to read high; the alarm is about the residual
 * after that expectation, not about the gap itself.
 */

/** one closed trade beside what the same coin replayed at, both as return on stake */
export type Pair = { real: number; replay: number }

export type BrokenReading = {
  /** mean(real) - factor * mean(replay), in POINTS, so -18 is eighteen points short */
  gapPp: number
  n: number
  realPp: number
  replayPp: number
}

/**
 * Compared on the MEANS rather than pair by pair, deliberately.
 *
 * A per-pair gap divided by one trade's stake has tails fat enough to be meaningless: one
 * 2.36x runner moved recon's per-trade mean by 215 points of a single trade's spend
 * (scripts/reconstat.cjs records that day). What this asks is whether the BOOK came in
 * under the book the venue offered, which is a question about the sums.
 */
export function brokenGap(pairs: readonly Pair[], factor: number): BrokenReading | null {
  const usable = pairs.filter((p) => Number.isFinite(p.real) && Number.isFinite(p.replay))
  if (!usable.length) return null
  const mean = (xs: number[]): number => xs.reduce((a, x) => a + x, 0) / xs.length
  const real = mean(usable.map((p) => p.real))
  const replay = mean(usable.map((p) => p.replay))
  return {
    gapPp: 100 * (real - factor * replay),
    n: usable.length,
    realPp: 100 * real,
    replayPp: 100 * replay,
  }
}
