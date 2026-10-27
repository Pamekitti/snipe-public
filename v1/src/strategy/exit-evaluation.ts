import type { Position, ExitReason } from './exit.js'

export type EvaluatedPosition = Pick<Position, 'exiting' | 'peakMarkWei' | 'entryMarkWei' | 'takeProfitMultiple' | 'openedAt' | 'rules'>

export function evaluate(pos: EvaluatedPosition, mark: bigint, now: number, graduating: boolean): ExitReason | null {
  if (pos.exiting) return null
  // peak feeds the dead-coin check below and, after the fact, tells us how much of a
  // move we gave back
  if (mark > pos.peakMarkWei) pos.peakMarkWei = mark

  // graduation ends the curve's life as a tradeable venue, so leave while we still can
  if (graduating) return 'graduating'
  // Bank the win. See STRATEGY.takeProfit: the clock alone rode 5 of the pilot's
  // trades from a +22%..+64% peak back to a loss, because nothing here ever sold into
  // strength - the trail fired once in 656 simulated trades and is not an exit rule.
  if (mark * 100n >= pos.entryMarkWei * BigInt(Math.round(pos.takeProfitMultiple * 100))) return 'tp'
  if (now - pos.openedAt >= pos.rules.maxHoldMs) return 'time'
  if (mark * 100n <= pos.entryMarkWei * BigInt(Math.round(pos.rules.hardStopMultiple * 100))) return 'stop'
  // Dead coin: never moved, never will. See STRATEGY.deadCoin for the measurement; the
  // short version is that 100% of winners had printed the bar by 25s, so a flat peak
  // after `afterMs` is a coin whose curve is already draining toward the -37% clock exit.
  // afterMs = 0 means the bailout is OFF, and it must short-circuit before the elapsed
  // comparison: `now - openedAt >= 0` is true on the very first tick, so a plain 0 would
  // sell every position instantly instead of disabling the rule.
  if (
    pos.rules.deadCoinAfterMs > 0 &&
    now - pos.openedAt >= pos.rules.deadCoinAfterMs &&
    pos.peakMarkWei * 1000n < pos.entryMarkWei * BigInt(Math.round(pos.rules.deadCoinBelowMult * 1000))
  ) return 'dead'
  return null
}

