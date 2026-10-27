/**
 * The tape's only schema. An event is something that HAPPENED TO US; everything else is
 * derived by folding these.
 *
 * THE TEST FOR WHETHER SOMETHING BELONGS HERE. If a replay of the tape could compute it,
 * it is not an event, it is state. Recording it anyway records an ANSWER, and then two
 * sources of truth exist for one fact and they drift. `TrackedCurve.working`, every mark,
 * every risk counter, the halt set, the screen verdict and the take-profit rung are all
 * folds, and none of them appear below.
 *
 * THE ONE CLOCK. `Envelope.at` is stamped once, by the driver, before the fold runs. Nothing
 * in core/ calls a clock. The old bot read `Date.now()` six times inside one entry decision
 * and again inside the curve overlay, which is why a replay could never reproduce a live run.
 *
 * Three classes, and the class says who caused it:
 *   Ingress  the world told us something
 *   Effect   we acted, and this is what came back
 *   Control  the rules moved (config, switches, the operator, a sensor, a gap)
 */
import type { RefusalBucket, Source } from './contracts.js'
import type { FrozenConfig, SwitchName, SwitchValue } from './config.js'

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export type Envelope = {
  /** monotonic and gapless, assigned by the appender. The fold's only ordering key. */
  readonly seq: number
  /** ms since epoch, stamped by the driver on receipt. THE ONLY CLOCK IN THE SYSTEM. */
  readonly at: number
  /**
   * which process run produced this. Forensics only: `decide()` must never read it, or two
   * replays of one tape could diverge on which machine wrote it.
   */
  readonly run: string
}

export type Event = Envelope & (Ingress | Effect | Control)

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** A chain log as the transport hands it over, before anything is decoded. */
export type RawLog = {
  readonly address: string
  readonly topics: readonly string[]
  readonly data: string
  readonly blockNumber: number
  readonly blockHash: string
  readonly transactionHash: string
  readonly transactionIndex: number
  readonly logIndex: number
}

/**
 * A sequencer-feed transaction that routing selected.
 *
 * Only the routed set is recorded, not every transaction in the block. Routing is a pure
 * predicate over fold state (is this `to` a curve we track), so a replay computes the same
 * set. `selected` carries what the live run chose so the fold can assert its own predicate
 * agrees; a mismatch is a `feed-routing-divergence` refusal rather than a silent difference.
 */
export type RoutedTx = {
  readonly hash: string
  readonly to: string
  readonly data: string
}

export type ChainReadKind =
  | 'curve' | 'meta' | 'balance' | 'allowance' | 'nonce' | 'gas-price' | 'block' | 'head'
  /** the wallet's current balance of one token, used only to reconcile an exhausted position */
  | 'position-wallet'
  /** the factory's view of a graduated token: phase, pool fee, tick spacing, verified hook */
  | 'grad-pool'
  /** the bag and both allowances the V4 router needs, in one multicall */
  | 'grad-wallet'

/**
 * Sensors whose reading arrives from OUTSIDE the fold.
 *
 * `venue`, `bars` and `broken` are deliberately not here. The fold computes all three from
 * evidence it holds itself, so an external event that could overwrite them would be a second
 * source of truth for one fact, and the two would drift exactly the way `gate.db` and the bot
 * did. `broken` left this union on 2026-09-17, when `core/broken.ts` started computing it; it
 * had sat here since the rewrite began with nothing on either side of the boundary.
 */
export type SensorName = 'template-block'

/**
 * A mined transaction, reduced to the four things a decision can act on.
 *
 * WEI AS DECIMAL STRINGS, because the tape is JSON: a bigint throws on serialise and a number
 * silently loses the low wei. Every other wei figure on the tape is a string for the same
 * reason.
 *
 * `proceedsWei` is only ever set for a swap whose receipt PROVED a complete ETH sale, and it
 * is proved from the pool's own events rather than from a wallet balance difference, which
 * could contain someone else's trade in the same block. `remainingWei` is what the token
 * balance was at the receipt's own block: a swap that succeeded and left tokens behind has
 * not closed the position, and treating it as closed would abandon the rest of the bag.
 */
export type ReceiptVerdict = {
  /** did it execute, as opposed to revert. A revert is still a receipt. */
  readonly ok: boolean
  /** gas actually paid, `gasUsed * effectiveGasPrice` */
  readonly gasWei: string
  readonly proceedsWei: string | null
  readonly remainingWei: string | null
  /** why the proof or the execution failed. Never matched on. */
  readonly error: string | null
  /**
   * For a FAILED receipt: did it burn its whole gas limit, or revert with gas to spare?
   *
   * TWO DIFFERENT EVENTS THAT MUST NEVER READ THE SAME. A revert with room left is the venue:
   * our slippage bound lost a first-come-first-served race, which is friction we chose and
   * priced. Burning the entire limit is US: the ceiling is too low, no retry fixes it, and
   * every one of them is a config bug. Reading the second as the first is what hid six
   * out-of-gas buys on 2026-08-19 while the buy failure rate went 2.0% to 37.5% with nothing
   * alerting, because nothing watched buys.
   *
   * COMPUTED IN `io/`, from v1's `classifyFailedTx`, because the gas limits live beside the
   * builder that bids them and `core/` may not import them. `null` is "not asked" or "did not
   * fail", and it is OPTIONAL so that every receipt already on the tape replays unchanged.
   */
  readonly outOfGas?: boolean | null
}

/** A confirmed operator recovery sale, verified against its transaction and receipt by io. */
export type RecoverySale = {
  readonly token: string
  readonly curve: string
  readonly oldHash: string
  readonly hash: string
  readonly oldNonce: number
  readonly nonce: number
  readonly confirmedNonce: number
  readonly tokensSoldWei: string
  readonly receipt: ReceiptVerdict
}

/**
 * Why reproducibility was lost over a range, and on which stream.
 *
 * The old `gaps` table had three producers and all three described a failure of the CAPTURE
 * pipeline, so `coverage.complete === true` only ever asserted "the writer did not fall
 * over". Every consumer read it as "we saw everything". These six causes are what it has to
 * cover for the claim to be true.
 */
export type GapStream = 'feed' | 'logs' | 'book' | 'appender' | 'writer' | 'recorder'

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

export type Ingress =
  /**
   * One event per BATCH, not per log. The batch boundary is load-bearing: dev-buy totals are
   * summed across the batch before any launch in it is dispatched, so splitting the batch
   * changes the screen verdict.
   */
  | { kind: 'logs'; logs: readonly RawLog[]; source: 'poll' | 'ws' | 'filter'; lo: number; hi: number }
  /**
   * The unconfirmed overlay. Without this on the tape, no entry price and no exit mark is
   * reproducible, because both are computed from confirmed logs PLUS this.
   */
  | { kind: 'feed-block'; block: number; timestamp: number; txs: readonly RoutedTx[] }
  | { kind: 'feed-gap'; expected: number; got: number; reason: string }
  | { kind: 'feed-status'; connected: boolean; reason: string }
  | { kind: 'logs-status'; healthy: boolean; mode: 'ws' | 'poll'; reason: string; entryReady?: boolean; quietEntryHold?: boolean }
  /**
   * Every chain read a decision consumes, recorded with its answer.
   *
   * This is what makes a decision that reads mid-flight reproducible. `viaKey`, `tries` and
   * `latencyMs` are recorded because the old bot's quota and latency alerts were computed
   * from in-memory counters that no replay could rebuild.
   */
  | { kind: 'chain-read'; request: { readonly kind: ChainReadKind; readonly args: readonly string[] }
      result: unknown; viaKey: boolean; tries: number; latencyMs: number }
  /**
   * A receipt is a chain read, kept as its own kind because it is the money evidence.
   *
   * IT ARRIVES DECODED, and that is deliberate. A V4 swap settles through the pool manager's
   * `Swap`, the hook's `HookFeeCollected` and an ERC20 `Transfer`, none of which the log
   * subscriber watches and none of which `core/` could read anyway: decoding them needs an ABI
   * library and `core/` imports no npm. So `io/` runs v1's `graduatedProceeds` proof, which
   * refuses anything that is not exactly one swap of ours, and puts the resulting NUMBER here.
   *
   * `result: null` is "we asked and could not get it", which is not the same as a revert and
   * must not be folded as one: the transaction may simply not be mined yet.
   */
  | { kind: 'receipt'; hash: string; result: ReceiptVerdict | null }
  /**
   * The only trigger for the pure time rules (max hold, dead-coin bail).
   *
   * Emitted by the driver ONLY while something is open, so an idle bot writes no clock
   * events and the tape does not fill with nothing happening.
   */
  | { kind: 'clock' }

// ---------------------------------------------------------------------------
// Effect
// ---------------------------------------------------------------------------

/**
 * Written after the driver acts. These exist so the fold can reconstruct in-flight state
 * across a crash without reading a database or the chain: the old bot's `resume()` rebuilt a
 * position from a DB row plus a chain read, and `index.ts` duplicated that lifecycle
 * knowledge a second time.
 */
export type Effect =
  /** Replaces NonceManager's in-memory next / inFlight / resyncTimes. */
  | { kind: 'nonce'; op: 'reserve' | 'settle' | 'release' | 'resync'; nonce: number; reason: string }
  /**
   * Written BEFORE the socket write, for every transaction kind.
   *
   * Approvals and graduation already had this contract in the old bot; buys and sells did
   * not, which is why a send that timed out could leave a signed transaction nobody knew
   * about. Universal is strictly safer.
   */
  | { kind: 'tx-signed'; intentId: string; txKind: 'buy' | 'sell' | 'approve' | 'graduate'
      hash: string; nonce: number; raw: string }
  /** The verdict from the send path, including the uncertain case where we do not know. */
  | { kind: 'tx-send-result'; intentId: string; hash: string; ok: boolean
      nonceConsumed: boolean; uncertain: boolean; statusCode: number | null
      error: string | null; tSigned: number; tSent: number }

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

export type Control =
  /**
   * The WHOLE frozen config, every key `decide()` can read, not a subset.
   *
   * The old bot passed six fields into the replay while the decision read a dozen more off
   * live getters, so the replay was configured differently from the run it was replaying and
   * nothing said so. Config is an event precisely so that a disagreement shows up on the tape
   * as a different `config-applied` rather than as an invisible parameter.
   */
  | { kind: 'config-applied'; specVersion: number; digest: string; values: FrozenConfig
      changed: readonly string[]; source: 'boot' | 'file' }
  /** The three runtime switches. Everything else is a spec change, reviewed and versioned. */
  | { kind: 'switch-set'; name: SwitchName; value: SwitchValue; by: string }
  /**
   * `clear-broken` is the ONLY way the bot-broken halt ever comes off, and it is here rather than
   * inside `start` on purpose. That halt means "this bot is losing money in a way nobody has
   * explained", so lifting it is a statement that someone looked and found the bug — which is a
   * different act from turning entries back on, and belongs on the tape as its own row with its
   * own reason.
   */
  | { kind: 'operator'; action: 'stop' | 'start' | 'reset' | 'reconcile-empty' | 'clear-broken' | 'retry-exit' | 'reconcile-sale'; why: string; book?: string; positionId?: string; recoverySale?: RecoverySale }
  | { kind: 'epoch-reset'; baseId: number; note: string }
  /**
   * Written around a process boot that re-read the chain. The fold does not act on them:
   * they are a record that a restart happened, not an input to a decision. Ignoring them
   * on replay is the whole point of putting them on the tape as their own kind rather than
   * inventing a chain-read the live run never made.
   */
  | { kind: 'recovery-start'; reason: string }
  | { kind: 'recovery-complete'; authoritativeBlock: number }
  /**
   * One kind for every external-database reading a decision consumes, discriminated by
   * `sensor`. One kind rather than seven because they share one contract: a reading, its
   * sample size, its source, and a reason when there is no reading. The old bot had three
   * separate guard implementations with three different vocabularies for "stale".
   */
  | { kind: 'sensor'; sensor: SensorName; reading: unknown; rows: number
      source: Source; reason: string | null }
  | { kind: 'gap'; stream: GapStream; lo: number; hi: number; reason: string }
  /**
   * Written once at the head of a tape, and again after an epoch move.
   *
   * Carries the state the old bot rebuilt at boot by scanning databases: deployer priors,
   * template losses, the already-entered set, the ledger base, and the scored launches
   * gate.db already holds so a restart is not blind for the first 20. With these on the tape
   * the fold owns them, so a replay from seq 0 reaches the same state the live process did
   * instead of starting blind.
   */
  | { kind: 'seed'; what: 'deployers' | 'template-losses' | 'entered' | 'ledger' | 'outcomes'; rows: unknown }

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

export type EventKind = Event['kind']

/**
 * Every event kind as a runtime value, so a diagram, a projection or a migration can be
 * checked against the union instead of drifting from it.
 *
 * The two assertions below make this list impossible to get wrong: adding a kind to the
 * union without adding it here fails to compile, and naming a kind here that the union does
 * not have fails to compile too. That is what stops the architecture diagram becoming the
 * same kind of dead documentation as a comment.
 */
export const EVENT_KINDS = [
  'logs', 'feed-block', 'feed-gap', 'feed-status', 'logs-status', 'chain-read', 'receipt', 'clock',
  'nonce', 'tx-signed', 'tx-send-result',
  'config-applied', 'switch-set', 'operator', 'epoch-reset', 'recovery-start', 'recovery-complete',
  'sensor', 'gap', 'seed',
] as const

type MissingFromList = Exclude<EventKind, (typeof EVENT_KINDS)[number]>
type NotAnEventKind = Exclude<(typeof EVENT_KINDS)[number], EventKind>
/** Both must be `never`. If either errors, EVENT_KINDS and the Event union have diverged. */
const _everyKindListed: MissingFromList extends never ? true : MissingFromList = true
const _everyEntryReal: NotAnEventKind extends never ? true : NotAnEventKind = true
void _everyKindListed
void _everyEntryReal

/** Which class an event belongs to. The class says who caused it. */
export const EVENT_CLASS: Readonly<Record<EventKind, 'ingress' | 'effect' | 'control'>> = {
  logs: 'ingress', 'feed-block': 'ingress', 'feed-gap': 'ingress', 'feed-status': 'ingress',
  'logs-status': 'ingress', 'chain-read': 'ingress', receipt: 'ingress', clock: 'ingress',
  nonce: 'effect', 'tx-signed': 'effect', 'tx-send-result': 'effect',
  'config-applied': 'control', 'switch-set': 'control', operator: 'control',
  'epoch-reset': 'control', 'recovery-start': 'control', 'recovery-complete': 'control',
  sensor: 'control', gap: 'control', seed: 'control',
} as const

/** Exhaustiveness guard: a new event kind with no fold arm fails to compile. */
export function unreachable(x: never, context: string): never {
  throw new Error(`unhandled ${context}: ${JSON.stringify(x)}`)
}

/**
 * Buckets an event can be refused into before it reaches the fold. Kept beside the event
 * union so adding a kind forces a decision about how it can fail.
 */
export const INGRESS_REFUSALS: Readonly<Partial<Record<EventKind, RefusalBucket>>> = {
  'feed-block': 'feed-routing-divergence',
  'config-applied': 'config-refused',
  'switch-set': 'switch-refused',
} as const
