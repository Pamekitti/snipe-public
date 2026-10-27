/**
 * What the core wants done. A data type, not a decision.
 *
 * IT LIVES IN ITS OWN FILE SO THE TRANSPORTS CAN NAME IT WITHOUT REACHING THE DECISION.
 * `io/` may not import `core/decide`, and the ring test enforces that: a transport that can
 * reach `decide` is a transport that can decide, which is how the old dashboard ended up
 * re-deriving eleven verdicts the bot had already made. A driver needs to know the SHAPE of
 * an intent in order to act on one; it must never be able to produce one.
 */
import type { ExitReason } from './exit.js'
import type { GradStep, PoolKey } from './state.js'

export type Intent =
  /** sign and send a buy. `minTokensOut` is a PRICE bound, computed here, never by a driver. */
  | { readonly kind: 'buy'; readonly intentId: string; readonly token: string; readonly curve: string
      readonly book: string; readonly sizeWei: bigint; readonly minTokensOut: bigint; readonly decidedAt: number }
  | { readonly kind: 'sell'; readonly intentId: string; readonly token: string; readonly curve: string
      readonly tokensIn: bigint; readonly minQuoteOut: bigint; readonly reason: ExitReason; readonly attempt: number }
  | { readonly kind: 'approve'; readonly intentId: string; readonly token: string; readonly curve: string }
  /**
   * One leg of the after-graduation sell: sign and send it.
   *
   * IT CARRIES EVERYTHING THE BYTES NEED, and that is the point rather than a convenience.
   * `pool` came off a `grad-pool` read and `deadline` off `state.at`, so both are on the tape;
   * a driver that reached for the factory itself, or for a clock, would be building calldata a
   * replay could not reproduce. The driver's whole job here is to encode and send.
   *
   * `deadline` is unix SECONDS, because that is what Permit2 and the router take.
   */
  | { readonly kind: 'grad'; readonly intentId: string; readonly token: string; readonly curve: string
      readonly step: GradStep; readonly pool: PoolKey | null
      readonly amountWei: bigint; readonly deadline: number }
  /**
   * Re-broadcast already-signed bytes. Same hash, same nonce. The sequencer treats a second
   * copy as a no-op if the first landed, which is why a missing receipt is safe to retry
   * this way and is NOT safe to resign.
   */
  | { readonly kind: 'broadcast'; readonly hash: string; readonly raw: string }
  /**
   * Hold this launch until `releaseAt`, then tell us. The delay is a measured entry rule
   * (the curve is still being bought into for ~2s after a launch), so it belongs to the
   * decision, and the driver owns only the timer.
   */
  | { readonly kind: 'arm'; readonly token: string; readonly releaseAt: number }
  /**
   * read something from the chain and feed it back as a `chain-read` event
   *
   * `grad-pool` and `grad-wallet` are each ONE multicall, not a list of reads, because their
   * answers are only true together: a phase read at block N beside an allowance from block
   * N+2 describes a venue that never existed.
   */
  | { readonly kind: 'read'
      readonly what: 'curve' | 'meta' | 'balance' | 'allowance' | 'position-wallet' | 'grad-pool' | 'grad-wallet' | 'receipt'
      readonly args: readonly string[] }
