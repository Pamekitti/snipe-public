/**
 * The chain's vocabulary: topics, selectors, and how a log moves a curve.
 *
 * PURE HEX, NO ABI LIBRARY. Every field this bot reads sits at a fixed 32-byte word offset,
 * so decoding is slicing, and slicing needs no dependency. That keeps core/ free of npm,
 * and it removes a whole class of surprise: an ABI decoder that changes how it coerces a
 * value between versions would silently change a decision.
 *
 * `word` exists so no site ever writes `BigInt('0x' + data.slice(2 + n*64, 66 + n*64))` by
 * hand. Every hand-rolled copy of that expression is one more chance to shift an offset by
 * a word, and this codebase has already shipped one units bug of exactly that shape.
 *
 * `tryWord` is what the fold must call. `word` throws on a short slice (`Cannot convert 0x
 * to a BigInt`), and a throw inside `decide` kills the process. That is the 42-crash loop
 * of 2026-09-17. Short data is not a crash, it is a log we cannot apply: return null.
 */
import type { CurveState } from './curve.js'

/**
 * The chain's fixed addresses. Constants, not config, deliberately.
 *
 * These are not policy: they identify the venue itself, and a bot pointed at a different
 * factory is a different bot, not the same bot configured differently. Putting them in the
 * spec would make "which venue are we trading" a hot key, which is a switch nobody should
 * be able to flip.
 */
export const ADDRESSES = {
  factory: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
  launcher: '0xe33e9e479df8802cb0866d5d05258bec4cf62948',
  /** the zero address IS the ETH pair here; a non-zero pair token is a different market */
  ethPair: '0x0000000000000000000000000000000000000000',
} as const

export const EVENT_TOPICS = {
  TokenLaunched: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',
  CurveBuy: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',
  CurveSell: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',
  BuybackLocked: '0x5feba9b0d52c92ada4b9c571c2bee52390c54f2947208ab250221e6ee32f12ff',
  FeesSwept: '0x9f4cd7c4ed99d08a797804560c9c5d71d2cf7e101f2e3b5e7d1ca8a24c370e4f',
  FeesRescued: '0x6460dc5c867a0678a8bcc5e64f629fae539901c53a4a8b42fe21d7a6c5e6437d',
  CurveCompleted: '0xf8d37a90738ae063b8b8058b66f5880cf3cf7ab0c5d4fa78219696591dfbfb67',
} as const

/** The three calls the feed overlay cares about. Routing selects on `buy` and `sell`. */
export const SELECTORS = { buy: '0x59a87bc1', sell: '0xd04c6983', launchAndBuy: '0xf85f8e41' } as const

/**
 * Word n of a LOG's data field, as a bigint. Logs only: a log has no selector.
 *
 * "Logs only" is now written down because the overlay used this on CALL data for the whole
 * life of v2. Calldata carries a 4-byte selector, so every word came out shifted by eight hex
 * characters and `quoteIn` read ~4e61 times too large; the last word ran off the end and threw
 * `Cannot convert 0x to a BigInt`, which killed the process 38 times on 2026-09-16. Use
 * `decodeCurveCall` for calldata. See `rebase` in decide.ts.
 */
export const word = (data: string, n: number): bigint => {
  const v = tryWord(data, n)
  if (v === null) throw new Error(`log data too short for word ${n}`)
  return v
}

/** Word n of a log, or null when the data is short or not hex. Never throws. */
export function tryWord(data: string, n: number): bigint | null {
  const hex = data.slice(2 + n * 64, 66 + n * 64)
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null
  return BigInt('0x' + hex)
}

/**
 * A curve call, decoded from the calldata a feed transaction carries.
 *
 * WHY THIS IS NOT `deltaFor`, WHICH IS WHAT IT REPLACED. A log records what HAPPENED
 * (`CurveBuy` is `quoteIn, tokensOut, fee, tax`); calldata records what was ASKED FOR (`buy`
 * is `quoteIn, minTokensOut, recipient`). `tokensOut`, `fee` and `tax` are not in the
 * calldata at any offset, because they are outputs of the curve math. One decoder cannot
 * serve both, and the attempt to make it is what broke: the request was applied as though it
 * were the outcome. The overlay has to SIMULATE, which is what `v1/src/state/engine.ts` has
 * always done and what this exists to let `rebase` do.
 *
 * TOTAL BY CONSTRUCTION: every short, unknown or malformed input is `null`, never a throw.
 * This runs inside the fold, so a throw here stops the bot.
 */
export type CurveCall =
  | { readonly kind: 'buy'; readonly quoteIn: bigint; readonly minTokensOut: bigint }
  | { readonly kind: 'sell'; readonly tokensIn: bigint; readonly minQuoteOut: bigint }

/** Word n of CALL data, past the 4-byte selector, or null when the call is too short. */
export function callWord(data: string, n: number): bigint | null {
  const start = 10 + n * 64
  if (data.length < start + 64) return null
  const hex = data.slice(start, start + 64)
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null
  return BigInt('0x' + hex)
}

export function decodeCurveCall(data: string): CurveCall | null {
  const sel = data.slice(0, 10)
  if (sel !== SELECTORS.buy && sel !== SELECTORS.sell) return null
  // Both take (uint256, uint256, address): three static words, no dynamic offsets, so the
  // decode is two reads and needs no ABI walker. The third word is the recipient, which the
  // curve math does not use.
  const a = callWord(data, 0)
  const b = callWord(data, 1)
  if (a === null || b === null) return null
  return sel === SELECTORS.buy
    ? { kind: 'buy', quoteIn: a, minTokensOut: b }
    : { kind: 'sell', tokensIn: a, minQuoteOut: b }
}

/** The last 20 bytes of a 32-byte word, as a lowercase address. */
export const wordAddress = (data: string, n: number): string => '0x' + data.slice(2 + n * 64 + 24, 66 + n * 64).toLowerCase()

/**
 * Turn a log into a pure state transition, so it can be replayed onto any book.
 *
 * Returns null for a topic that does not move reserves, which is not an error: the
 * subscription asks for every curve event and several of them are informational.
 *
 * These seven are ALL the reserve-mutating events. Missing `FeesSwept` in particular makes
 * local reserves drift high, which sets `minQuoteOut` above what the curve will actually
 * pay and turns every sell into a slippage revert.
 */
export function deltaFor(topic: string | undefined, data: string): ((s: CurveState) => CurveState) | null {
  const w = (n: number) => tryWord(data, n)
  switch (topic) {
    case EVENT_TOPICS.CurveBuy: {
      // quoteIn is what was actually spent; `fee` already includes any snipe tax
      const quoteIn = w(0), tokensOut = w(1), fee = w(2), tax = w(3)
      if (quoteIn === null || tokensOut === null || fee === null || tax === null) return null
      return (s) => ({ ...s, trackedQuote: s.trackedQuote + quoteIn, trackedTokens: s.trackedTokens - tokensOut,
        quoteFeeBalance: s.quoteFeeBalance + fee, creatorTaxBalance: s.creatorTaxBalance + tax })
    }
    case EVENT_TOPICS.CurveSell: {
      const tokensIn = w(0), quoteOut = w(1), fee = w(2), tax = w(3)
      if (tokensIn === null || quoteOut === null || fee === null || tax === null) return null
      return (s) => ({ ...s, trackedQuote: s.trackedQuote - quoteOut, trackedTokens: s.trackedTokens + tokensIn,
        quoteFeeBalance: s.quoteFeeBalance + fee, creatorTaxBalance: s.creatorTaxBalance + tax })
    }
    case EVENT_TOPICS.BuybackLocked: {
      const locked = w(1)
      if (locked === null) return null
      return (s) => ({ ...s, trackedTokens: s.trackedTokens - locked })
    }
    case EVENT_TOPICS.FeesSwept: {
      // protocol and creator leave the curve; the buyback slice stays as tradeable reserve
      const protocolAmt = w(0), creatorAmt = w(2)
      if (protocolAmt === null || creatorAmt === null) return null
      return (s) => ({ ...s, trackedQuote: s.trackedQuote - protocolAmt - creatorAmt, quoteFeeBalance: 0n, creatorTaxBalance: 0n })
    }
    case EVENT_TOPICS.FeesRescued: {
      const protocolAmt = w(0), creatorAmt = w(1)
      if (protocolAmt === null || creatorAmt === null) return null
      return (s) => ({ ...s, trackedQuote: s.trackedQuote - protocolAmt - creatorAmt, quoteFeeBalance: 0n, creatorTaxBalance: 0n })
    }
    case EVENT_TOPICS.CurveCompleted:
      return (s) => ({ ...s, trackedQuote: 0n, trackedTokens: 0n, graduated: true })
    default:
      return null
  }
}

/**
 * Does this feed transaction belong to us? THE ROUTING PREDICATE, and the only copy of it.
 *
 * `main.ts` filters the sequencer feed with this, and `foldFeedBlock` accepts exactly what it
 * accepts, so a `feed-routing-divergence` refusal now means something really is wrong instead
 * of being a difference between two rules written in two places.
 *
 * IT USED TO SAY MORE THAN THE FOLD DOES, and both halves of that cost something. It admitted
 * anything sent to the launcher, which the fold has no arm for, so those would be tape with no
 * reader; and `main.ts` never called it, filtering on the tracked curve alone, so every fee
 * sweep the venue sent to a curve we hold was recorded and then refused as a divergence. That
 * was 25,857 refusals in the funnel and 58,000 lines of warning about `0x3729bb9a`, which is
 * the sweep, whose `FeesSwept` log the fold applies anyway.
 */
export function routes(to: string, isTrackedCurve: (addr: string) => boolean, data: string): boolean {
  if (!isTrackedCurve(to.toLowerCase())) return false
  const sel = data.slice(0, 10)
  return sel === SELECTORS.buy || sel === SELECTORS.sell
}

/** An address out of an indexed topic: the low 20 bytes of a 32-byte word. */
export const addrFromTopic = (t: string | undefined): string => (t ? '0x' + t.slice(26).toLowerCase() : '')
