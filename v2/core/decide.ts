/**
 * THE FOLD. `decide(state, event) -> {state, intents, refusals}`.
 *
 * TWO ARGUMENTS, NOT THREE. Config is not a parameter, it is an event: a `config-applied`
 * on the tape moves `state.config`, so a replay is configured exactly as the run it
 * replays. The old bot passed six config fields into its replay while the live decision
 * read a dozen more off live getters, so the replay was configured differently from the run
 * and nothing said so. That is the single reason the paper account could disagree with the
 * book and no one could tell which was wrong.
 *
 * NO CLOCK. `state.at` is the `at` of the last folded event, and it is the only "now" any
 * rule may read. The old bot called `Date.now()` six times inside one entry decision and
 * again inside the curve overlay, so two replays of one run could reach different answers.
 *
 * NO I/O, NO RANDOMNESS, NO ORDER-DEPENDENCE. Every iteration over a Map iterates in
 * insertion order, which is specified. Every sort uses `compare`, never `localeCompare`.
 * Every intent id is minted from a counter in the state, so ids are stable across replays.
 *
 * INTENTS ARE REQUESTS, NOT ACTIONS. `decide` never signs, sends, reads a chain or touches
 * a socket. It says what it wants; a driver does it and feeds the result back as another
 * event. That is what lets the same core run live and in replay with no flag distinguishing
 * them.
 */
import {
  compare, no, ok, sensed,
  type Ok, type Refusal, type Sensed,
} from './contracts.js'
import type { Event, RawLog, ReceiptVerdict, RoutedTx } from './events.js'
import {
  bookLedger, forgetOldRows, freshGradState, haltedFor, ledgerNetWei, stoppedKey, walletNetWei,
  type Armed, type Inflight, type PoolKey, type Position, type State, type TrackedCurve,
} from './state.js'
import { ADDRESSES, EVENT_TOPICS, SELECTORS, addrFromTopic, decodeCurveCall, deltaFor, tryWord, wordAddress } from './chain.js'
import {
  CurveRevert, freshCurve, graduationProgress, markToExit, readyToGraduate, simBuy, simSell,
  type CurveParams, type CurveState,
} from './curve.js'
import { bookDigest, routeBook } from './book.js'
import { checkBookSize, effectiveBookSizeWei } from './config.js'
import { admits, templateKey, type LaunchFacts } from './entry.js'
import { rungNow } from './takeprofit.js'
import { sizedEntryWei, sizingReading } from './sizing.js'
import { clearBroken, filePair } from './broken.js'
import {
  evaluateExit, exhausted, nextGraduationStep,
  GRAD_BUDGET, GRAD_RECEIPT_GAP_MS, GRAD_RETRY_MS, GRAD_MAX_RETRY_MS, GRAD_PERMIT_TTL_S, GRAD_SWAP_TTL_S,
  SELL_SETTLE_GIVEUP_MS, type ExitReason,
} from './exit.js'
import type { Intent } from './intents.js'
import { canEnter, haltOnDrawdown, resetDrawdown, rollDay, type StreamHealth } from './risk.js'
import { pumpCheck, readSensor } from './guard.js'
import { longestSettleMs, observe, openObservation, recordCurveLog, refreshSensors } from './observe.js'
import { LIVE_PATH, blocksFromMs, type SimEvent } from './sim.js'

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

export type { Intent } from './intents.js'

export type Decision = {
  readonly state: State
  readonly intents: readonly Intent[]
  readonly refusals: readonly Refusal[]
}

// ---------------------------------------------------------------------------
// Small helpers, all pure
// ---------------------------------------------------------------------------

/** Give reserved capital back, never past zero. */
function releaseDeployed(s: State, amount: bigint): void {
  s.risk.deployedWei -= amount
  if (s.risk.deployedWei < 0n) s.risk.deployedWei = 0n
}

/**
 * Move `deployedWei` from the amount reserved at decide time to the amount the fill
 * actually spent. Close and abandon subtract `spendWei`. If those two numbers differ
 * and nobody adjusts here, leftover deployed capital looks like a full bankroll.
 */
function bookSpend(s: State, reserved: bigint, spent: bigint): void {
  if (spent === reserved) return
  releaseDeployed(s, reserved)
  s.risk.deployedWei += spent
}

/** Log hashes are `0x` + 64 hex. A sequencer answer without the prefix must still match. */
function normTxHash(h: string): string {
  if (!h) return ''
  const x = h.toLowerCase()
  return x.startsWith('0x') ? x : `0x${x}`
}

/**
 * Keep the first hash we trusted. `tx-signed` writes the bytes we will see in the log;
 * a later `tx-send-result` that carries a different string (no `0x`, a sequencer id)
 * must not replace it or the fill never matches.
 */
function firstHash(current: string | null | undefined, incoming: string): string {
  const have = current ? normTxHash(current) : ''
  if (have) return have
  return normTxHash(incoming)
}

/** Recompute `working` from `confirmed` plus the accepted overlay, oldest first. */
function rebase(c: TrackedCurve, at: number): void {
  let s: CurveState = c.confirmed
  for (const [, tx] of c.pending) {
    const next = applyPending(c, s, tx)
    if (next) s = next
  }
  c.working = s
  c.workingAt = at
}

/**
 * One unconfirmed feed transaction, applied by SIMULATING it through the curve math.
 *
 * WHY SIMULATE RATHER THAN READ THE NUMBERS OFF THE CALL. Because the numbers are not in the
 * call. `buy(quoteIn, minTokensOut, recipient)` says what the sender asked for; how far the
 * curve actually moves depends on its reserves, its fees, its creator tax and the snipe tax at
 * this timestamp. Only the curve math knows that, and it is the one part of this repo pinned
 * bit-exact against chain history by `npm run validate`.
 *
 * Until 2026-09-16 this mapped the selector onto the topic its execution WOULD emit and read
 * the calldata with a log's offsets. That is wrong twice over: a call has a 4-byte selector a
 * log does not (so every word was shifted), and `CurveBuy`'s `tokensOut`, `fee` and `tax` are
 * outputs that appear nowhere in the request. It produced reserves off by ~4e61 and killed the
 * process whenever the trailing word ran past the end of the data.
 *
 * SIMULATE-BEFORE-APPLY IS ALSO A FILTER, and the reason `v1/src/state/engine.ts` was built
 * this way: a call that would revert on its own slippage bound never touches the book. Rival
 * bots racing each other revert constantly at exactly the moments we care about, and folding
 * their attempts in would move a price that never moved.
 *
 * NOT EXEMPT, deliberately, matching v1: we cannot know whether the sender is snipe-tax exempt,
 * and assuming they are not understates how far the curve moved, which is the conservative
 * direction for an entry price.
 */
function applyPending(c: TrackedCurve, s: CurveState, tx: { readonly data: string; readonly blockTs: number }): CurveState | null {
  const call = decodeCurveCall(tx.data)
  if (!call) return null
  try {
    return call.kind === 'buy'
      ? simBuy(c.params, s, call.quoteIn, BigInt(tx.blockTs), { minTokensOut: call.minTokensOut }).next
      : simSell(c.params, s, call.tokensIn, { minQuoteOut: call.minQuoteOut }).next
  } catch (e) {
    // A revert is the expected answer and the whole point of simulating first. Anything else
    // is a surprise, so the curve is marked rather than quietly carrying a book nobody
    // checked. Neither may throw: this runs inside the fold, where a throw stops the bot.
    if (!(e instanceof CurveRevert)) c.degraded = true
    return null
  }
}

/** Deterministic intent ids: a counter in the state, so a replay mints identical ids. */
function mintId(state: State, prefix: string): { readonly id: string; readonly decisions: number } {
  const n = state.decisions + 1
  return { id: `${prefix}-${n}`, decisions: n }
}

const bump = (state: State, bucket: Refusal['bucket']): void => { state.counters[bucket]++ }

/** Every refusal goes through here so a bucket can never be raised without being counted. */
function refuse(state: State, out: Refusal[], r: Refusal): void {
  bump(state, r.bucket)
  out.push(r)
}

function take<T>(state: State, out: Refusal[], r: Ok<T>): T | null {
  if (r.ok) return r.value
  refuse(state, out, r.refusal)
  return null
}

/** Stream health as the fold last saw it, assembled once so risk never senses for itself. */
function health(state: State): StreamHealth {
  const logs = state.sensors.logsHealthy
  const overlayAt = state.overlayAt
  return {
    logsHealthy: logs?.value ?? false,
    logsAgeMs: logs === null ? Number.MAX_SAFE_INTEGER : state.at - logs.at,
    overlayAgeMs: overlayAt === null ? null : state.at - overlayAt,
  }
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

export function decide(state: State, event: Event): Decision {
  const intents: Intent[] = []
  const refusals: Refusal[] = []
  // `at` advances FIRST. Every rule below reads state.at, so a rule that ran before this
  // assignment would be reasoning about the previous event's clock.
  let s: State = { ...state, seq: event.seq, at: event.at }

  // A UTC rollover is checked on every event rather than on a timer, because the fold has
  // no timer. It is idempotent and costs a floor division.
  rollDay(s.risk, s.at)

  // Two size comparisons on every event, and an eviction pass only when a map is over its
  // ceiling. Here rather than in the arms that grow, because there are five of those and one
  // of them will eventually be added without this. Nothing live is ever evicted; see the
  // function's own header for the floor.
  forgetOldRows(s)

  switch (event.kind) {
    case 'logs': return foldLogs(s, event, intents, refusals)
    case 'feed-block': return foldFeedBlock(s, event, intents, refusals)
    case 'clock': return foldClock(s, intents, refusals)
    case 'chain-read': return foldChainRead(s, event, intents, refusals)
    case 'tx-send-result': return foldSendResult(s, event, intents, refusals)
    case 'sensor': return foldSensor(s, event, intents, refusals)

    case 'feed-gap': {
      // The overlay is no longer trustworthy, so drop it rather than carry a prediction we
      // know is missing transactions. Dropping marks every curve degraded, which is what
      // makes `risk-degraded` fire instead of a silently wrong entry price.
      for (const c of s.curves.values()) {
        if (c.pending.size) { c.pending.clear(); c.degraded = true; rebase(c, s.at) }
      }
      s = { ...s, overlayAt: null, gaps: [...s.gaps, { stream: 'feed', lo: event.expected, hi: event.got, reason: event.reason }] }
      return { state: s, intents, refusals }
    }
    case 'feed-status': {
      if (!event.connected) s = { ...s, overlayAt: null }
      return { state: { ...s, sensors: { ...s.sensors, feedConnected: sensed(event.connected, s.at, 'feed') } }, intents, refusals }
    }
    case 'logs-status':
      if (event.entryReady !== undefined) {
        const wasQuiet = s.sensors.quietEntryHold === true
        s = { ...s, sensors: { ...s.sensors, entryReady: event.entryReady,
          ...(event.quietEntryHold !== undefined ? { quietEntryHold: event.quietEntryHold } : {}) } }
        if (wasQuiet && event.entryReady) s = releaseArmed(s, intents, refusals)
        return { state: s, intents, refusals }
      }
      return { state: { ...s, sensors: { ...s.sensors, logsHealthy: sensed(event.healthy, s.at, 'logs') } }, intents, refusals }

    case 'gap':
      return { state: { ...s, gaps: [...s.gaps, { stream: event.stream, lo: event.lo, hi: event.hi, reason: event.reason }] }, intents, refusals }

    case 'config-applied': {
      // The spec is replaced WHOLE. A partial update is how a config ends up half-applied
      // with no event describing the half.
      const bookSizes = new Map(s.switches.bookSizes ?? [])
      for (const [bookId, override] of bookSizes) {
        const book = event.values.books.find((candidate) => candidate.id === bookId)
        if (!book || BigInt(book.sizeWei) === 0n) {
          bookSizes.delete(bookId)
          continue
        }
        const riskCeiling = BigInt(event.values.risk.maxTradeSizeWei)
        const ceiling = effectiveBookSizeWei(book, riskCeiling)
        if (override.sizeWei <= ceiling) continue
        bookSizes.set(bookId, { sizeWei: ceiling, at: s.at, by: 'config' })
        refuse(s, refusals, {
          at: s.at, bucket: 'switch-refused', subject: bookId,
          reason: `${bookId}'s ${override.sizeWei} wei override was lowered to its new ${ceiling} wei config ceiling`,
        })
      }
      return { state: { ...s, config: event.values, switches: { ...s.switches, bookSizes } }, intents, refusals }
    }

    case 'switch-set': {
      const v = event.value
      let sw = s.switches
      if (v.kind === 'halt') {
        // File halt is gone. Historical tape rows stay valid and change nothing.
        return { state: s, intents, refusals }
      }
      if (v.kind === 'broadcast') {
        if (v.mode !== 'live' && v.mode !== 'shadow') return { state: s, intents, refusals }
        sw = { ...sw, mode: v.mode }
      } else if (v.kind === 'book-size') {
        const bookSizes = new Map(sw.bookSizes ?? [])
        if (v.wei === null) {
          bookSizes.delete(v.book)
        } else {
          const checked = checkBookSize(s.at, BigInt(v.wei), s.config, v.book)
          if (!checked.ok) {
            refuse(s, refusals, checked.refusal)
            return { state: s, intents, refusals }
          }
          bookSizes.set(v.book, { sizeWei: checked.value, at: s.at, by: event.by })
        }
        return { state: { ...s, switches: { ...sw, bookSizes } }, intents, refusals }
      } else {
        /**
         * THE CEILING IS APPLIED HERE, not only at boot.
         *
         * `SwitchValue` has always documented the size as "bounded by spec.risk.maxTradeSizeWei
         * at apply time", and this case did not apply it: the bound lived in `main.ts`, so it
         * held for the value the process started with and for nothing after. Now that the file
         * is watched and a stake can change without a restart, that gap is a typo away from a
         * trade the spec never agreed to. A refusal rather than a silent clamp, because an
         * operator who typed 0.05 for 0.005 needs to be told which number is in force.
         */
        const max = BigInt(s.config.risk.maxTradeSizeWei)
        const asked = BigInt(v.wei)
        const size = asked < 0n ? 0n : asked > max ? max : asked
        if (size !== asked) {
          refuse(s, refusals, {
            at: s.at, bucket: 'switch-refused', subject: 'size',
            reason: `a stake of ${asked} wei was asked for; the spec allows ${max}, so ${size} is in force`,
          })
        }
        sw = { ...sw, sizeWei: size }
      }
      return { state: { ...s, switches: { ...sw, at: s.at, by: event.by } }, intents, refusals }
    }

    case 'operator': {
      const book = event.book
      if (event.action === 'reconcile-sale') return reconcileRecoverySale(s, event, intents, refusals)
      if (event.action === 'retry-exit') {
        const p = s.positions.get(event.positionId ?? '')
        const blocked = s.risk.halts.has(stoppedKey(null)) || s.risk.halts.has('broken')
        if (!blocked || !p || p.closed || !p.filled || p.venue !== 'curve'
          || p.inflightIntentId !== null || (p.sellReceipts?.size ?? 0) > 0
          || p.exitRecovery || (!exhausted(p) && !p.approval?.gaveUp)) {
          refuse(s, refusals, { at:s.at, bucket:'exit-stuck', subject:event.positionId ?? 'operator',
            reason:'exit retry requires stopped new entries and one exhausted curve position with no pending sale' })
          return { state:s, intents, refusals }
        }
        p.exitRecovery = { requestedAt:s.at, readAt:s.at }
        intents.push({kind:'read',what:'position-wallet',args:[p.token,p.id]})
        return {state:s,intents,refusals}
      }
      if (event.action === 'stop') {
        s.risk.halts.set(stoppedKey(book), { kind: 'stopped', book: book ?? null, reason: event.why, at: s.at })
      }
      if (event.action === 'start') {
        s.risk.halts.delete(stoppedKey(book))
      }
      if (event.action === 'reset') {
        // The reset IS the lift: clearing what the stop measures without clearing the stop
        // leaves it re-firing on the same peak within one trade.
        resetDrawdown(s, book)
      }
      if (event.action === 'clear-broken') {
        // ONLY WHILE FLAT, checked here as well as in the control layer, because the tape is the
        // authority and can be replayed without that layer. Lifting with money on the table puts a
        // bot nobody has diagnosed straight back onto open positions. What the lift forgets, and
        // why it has to forget it, is in `core/broken.ts`.
        const open = [...s.positions.values()].filter((p) => !p.closed).length
        if (open > 0) {
          refuse(s, refusals, {
            at: s.at, bucket: 'risk-halted', subject: 'operator',
            reason: `the broken halt was not lifted: ${open} position(s) still open, and this one is lifted flat`,
          })
          return { state: s, intents, refusals }
        }
        return { state: clearBroken(s), intents, refusals }
      }
      if (event.action === 'reconcile-empty') {
        // The control layer admits this only while operator-stopped. The fold repeats the
        // guard because the tape is the authority and may be replayed without that layer.
        if (!s.risk.halts.has(stoppedKey(null))) {
          refuse(s, refusals, {
            at: s.at, bucket: 'exit-stuck', subject: 'operator',
            reason: 'empty-position reconciliation was refused because the bot is not operator-stopped',
          })
          return { state: s, intents, refusals }
        }
        for (const pos of s.positions.values()) {
          if (pos.closed) continue
          const spent = exhausted(pos) || pos.grad?.gaveUp === true
          if (!spent || pos.inflightIntentId !== null) continue
          intents.push({ kind: 'read', what: 'position-wallet', args: [pos.token, pos.id] })
        }
      }
      return { state: s, intents, refusals }
    }

    case 'epoch-reset': {
      resetDrawdown(s)
      return { state: s, intents, refusals }
    }

    case 'recovery-start':
      /**
       * Boot asks the chain about every bag the fold still thinks it holds, and about any
       * sent buy that never became a position. The answers are chain-reads on the tape.
       *
       * IT ASKS, IT DOES NOT CONCLUDE. A zero balance on a row with a sequenced sell is
       * ambiguous, and the `position-wallet` arm pulls that sell's receipt rather than
       * closing the row. Reading zero as an abandonment books no proceeds for a sale that
       * happened.
       *
       * UNSIGNED LEFTOVERS ARE NOT BAGS. A buy reserved at decide time and never signed is
       * rebuilt by replay with no driver left to sign it, and `reclaimOrphanBuys` skips a
       * record with no hash, so the slot sat forever. Those go back here, before the
       * hashed path asks the wallet. A live clock must not do the same: the driver may
       * still be signing that intent.
       */
      releaseUnsignedBuys(s, refusals)
      reclaimOrphanBuys(s, intents, refusals)
      for (const pos of s.positions.values()) {
        if (pos.closed) continue
        intents.push({ kind: 'read', what: 'position-wallet', args: [pos.token, pos.id] })
      }
      return { state: s, intents, refusals }

    case 'recovery-complete':
      return { state: s, intents, refusals }

    case 'seed': return foldSeed(s, event, intents, refusals)

    case 'nonce':
      return { state: { ...s, nonce: { ...s.nonce, next: event.nonce, inFlight: event.op === 'reserve' ? s.nonce.inFlight + 1 : Math.max(0, s.nonce.inFlight - 1) } }, intents, refusals }

    case 'tx-signed': {
      // The fold already created this record when it decided the intent. Signing only adds
      // the hash and the nonce, which is how the fold later recognises its OWN fill in a
      // batch of logs that is mostly other people's.
      const f = s.inflight.get(event.intentId)
      if (f) {
        f.hash = firstHash(f.hash, event.hash)
        f.nonce = event.nonce
        f.signedAt = s.at
        if (f.kind === 'graduate') f.raw = event.raw
        if (f.kind === 'sell') {
          const pos = [...s.positions.values()].find((p) => p.inflightIntentId === f.intentId)
          if (pos) rememberSell(pos, f, s.at)
        }
        if (f.kind === 'approve') {
          const pos = [...s.positions.values()].find((p) => p.approval?.intentId === f.intentId)
          if (pos?.approval) pos.approval.hash = f.hash
        }
        if (f.kind === 'buy') {
          const pos = s.positions.get(f.intentId)
          if (pos) pos.lastBuyHash = firstHash(pos.lastBuyHash, f.hash)
        }
      }
      return { state: s, intents, refusals }
    }

    case 'receipt':
      return foldReceipt(s, event, intents, refusals)
  }
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

function foldLogs(s: State, e: Extract<Event, { kind: 'logs' }>, intents: Intent[], refusals: Refusal[]): Decision {
  /**
   * A DELIVERED BATCH IS THE EVIDENCE THE STREAM IS ALIVE, so it is what stamps the reading.
   *
   * `logsAgeMs` is what `risk-logs-stale` refuses on, and until 2026-09-16 this timestamp
   * only moved when a `logs-status` event CHANGED. A healthy subscriber emits one of those at
   * connect and then never again, so three seconds into any run every entry was refused for a
   * stream that was in fact delivering thirteen batches a second. On the live tape that is
   * `risk-logs-stale` at 26 with a perfect stream, and on the dashboard it read as
   * "the log stream last reported 2105s ago".
   *
   * The VALUE still comes from the status event: delivery says the pipe is open, and only the
   * subscriber can say it has fallen back to polling or lost its socket. An explicit
   * `healthy: false` therefore survives a batch, and `risk-logs-unhealthy` refuses on the
   * value regardless of how fresh the timestamp is.
   */
  s = { ...s, sensors: { ...s.sensors, logsHealthy: sensed(s.sensors.logsHealthy?.value ?? true, s.at, 'logs') } }

  // THE BATCH IS THE UNIT. Dev-buy totals are summed across the whole batch before any
  // launch in it is dispatched: reading the curve instead would count every rival who got
  // in before our round trip returned, inflating the dev buy and waving through launches
  // the filter exists to reject.
  const devBuyByTx = new Map<string, bigint>()
  for (const log of e.logs) {
    if (log.topics[0] !== EVENT_TOPICS.CurveBuy) continue
    const quoteIn = tryWord(log.data, 0)
    if (quoteIn === null) continue
    devBuyByTx.set(log.transactionHash, (devBuyByTx.get(log.transactionHash) ?? 0n) + quoteIn)
  }

  /**
   * Snapshot the seed watermark at the START of the batch.
   *
   * The skip below is "already inside the chain-read snapshot, do not count twice."
   * Updating `confirmedThrough` as each log is applied made a second log in the SAME
   * block look already-seeded. A rival buy processed first then skipped our own fill:
   * 2026-09-17 buy-3684, 0.02 ETH held until a person sold it. Several buyers in one
   * block is the hot-launch case, not an edge.
   *
   * ONLY THE ADDRESSES THIS BATCH CARRIES, and this pass must stay above the loop: a curve
   * born in the batch is deliberately absent, so its own logs fall through to the live
   * watermark the way they always have. Snapshotting every tracked curve instead read the
   * whole book thirteen times a second and got slower with every launch the run had ever
   * seen — 46 of the 88 seconds of a full replay, and the reason a restart went dark for
   * twenty-three minutes on 2026-09-18.
   */
  const throughAtStart = new Map<string, number>()
  for (const log of e.logs) {
    const addr = log.address.toLowerCase()
    if (throughAtStart.has(addr)) continue
    const c = s.curves.get(addr)
    if (c !== undefined) throughAtStart.set(addr, c.confirmedThrough)
  }

  for (const log of e.logs) {
    if (log.topics[0] === EVENT_TOPICS.TokenLaunched) {
      s = onLaunch(s, log, devBuyByTx.get(log.transactionHash) ?? 0n, intents, refusals)
      continue
    }
    const addr = log.address.toLowerCase()
    // THE REPLAY'S INPUT, recorded before anything else touches the log. It is recorded even
    // while the metadata read is still out, because the creator's own buy rides in the launch
    // transaction and is the single largest move any curve ever sees.
    recordSimEvent(s, addr, log)
    const c = s.curves.get(addr)
    if (!c) continue
    // A log at or below the block the confirmed book was SEEDED from is already inside that
    // seed (a chain read returns state including every log up to its block), so folding it
    // again double-counts it. Compare against the snapshot, not the watermark we just moved.
    const through = throughAtStart.get(addr) ?? c.confirmedThrough
    const alreadySeeded = log.blockNumber <= through
    const d = alreadySeeded ? null : deltaFor(log.topics[0], log.data)
    if (d) {
      c.confirmed = d(c.confirmed)
      c.confirmedThrough = Math.max(c.confirmedThrough, log.blockNumber)
    }
    // The log is confirmed either way: drop it from the overlay so a seeded fill is not
    // applied twice, once in the snapshot and once as pending.
    c.pending.delete(log.transactionHash)
    rebase(c, s.at)

    // IS THIS OUR OWN FILL? Matched on our transaction hash, never on "a buy on a curve we
    // hold": several buyers land in the same block and matching on the curve would credit
    // us with a stranger's fill. The old bot learned this one the expensive way.
    //
    // Settled EVEN WHEN THE RESERVE DELTA IS SKIPPED. The watermark is "do not count this
    // log into reserves twice". It is not "this fill is not ours". Skipping settle here is
    // how a buy that landed in its seed block, or a short CurveBuy, spent ETH and never
    // opened a position. Short data still settles if the first two words are present.
    s = settleOwnFill(s, log, c, intents, refusals)
  }

  return markPositions(s, intents, refusals)
}

/**
 * Let the curve pull this position's tokens, which is the difference between a position that
 * can be exited and one that cannot.
 *
 * `sell` moves our tokens with `safeTransferFrom`, so the curve needs an ERC20 allowance
 * before any sell can succeed. THIS INTENT WAS NEVER RAISED BY ANYTHING until 2026-09-16: the
 * kind existed in `intents.ts`, the transaction existed in `io/builder.ts`, the signer handled
 * it in `io/world.ts`, and no decision anywhere emitted one. The first three live buys proved
 * it — all three landed, and all three sells reverted on chain having burned 49,028 gas each,
 * which is the shape of `ERC20InsufficientAllowance`.
 *
 * ON THE FILL, not at exit time, and that ordering is the whole point: v1 approves here for
 * the same reason (`v1/src/bot.ts`), because paying for a round trip to the chain during an
 * exit spends exactly the seconds the exit exists to save.
 *
 * Called again whenever a sequenced sell fails to settle. An approve is idempotent and costs
 * about 50k gas, so re-sending one is cheap; a lost approve that nothing re-sends is a
 * position that can never leave, which is what stranded v1's position 749 for 29 hours.
 */
function approve(s: State, pos: Position, intents: Intent[]): State {
  const a = pos.approval ??= {
    ready: false, intentId: null, hash: null, awaitingAllowance: false, retryAt: 0,
    failures: 0, reverts: 0, gasWei: 0n, lastError: null, gaveUp: false,
  }
  if (a.intentId !== null || a.hash !== null || a.gaveUp) return s
  const { id, decisions } = mintId(s, 'approve')
  s = { ...s, decisions }
  a.ready = false
  a.awaitingAllowance = false
  a.intentId = id
  a.retryAt = s.at + SELL_SETTLE_GIVEUP_MS
  s.inflight.set(id, { kind: 'approve', intentId: id, token: pos.token, curve: pos.curve, raisedAt: s.at, hash: '', nonce: -1, signedAt: 0 })
  intents.push({ kind: 'approve', intentId: id, token: pos.token, curve: pos.curve })
  return s
}

const APPROVAL_READ_MS = 1_000

function approvalBackoff(pos: Position, at: number, reason: string): void {
  const a = pos.approval!
  a.ready = false
  a.intentId = null
  a.hash = null
  a.awaitingAllowance = false
  a.failures++
  a.retryAt = at + Math.min(30_000, APPROVAL_READ_MS * 2 ** Math.min(a.failures - 1, 5))
  a.lastError = reason
  a.gaveUp = a.reverts >= pos.rules.maxSellAttempts || a.gasWei * GRAD_BUDGET.gasFractionOfStake >= pos.spendWei
}

/** A rejected approval consumes no sell attempts. A pending transaction is only read. */
function checkApproval(s: State, pos: Position, intents: Intent[]): State {
  const a = pos.approval
  if (!a || a.ready || a.gaveUp || s.at < a.retryAt) return s
  a.retryAt = s.at + APPROVAL_READ_MS
  if (a.hash !== null) {
    intents.push({ kind: 'read', what: 'receipt', args: [a.hash, pos.token, pos.curve, 'approve'] })
  } else if (a.awaitingAllowance) {
    intents.push({ kind: 'read', what: 'allowance', args: [pos.token, pos.curve, pos.id] })
  } else {
    if (a.intentId !== null) s.inflight.delete(a.intentId)
    a.intentId = null
    s = approve(s, pos, intents)
  }
  return s
}

/**
 * Fold OUR OWN buy or sell, matched on our transaction hash.
 *
 * A successful send already wrote an unconfirmed row. This is where that row is FILLED or
 * a late bag is booked, and where a sell dies. A sequenced transaction is not an executed
 * one: exits and booked P&L wait for the log (or the wallet, or the receipt) to prove tokens.
 */
function settleOwnFill(s: State, log: RawLog, c: TrackedCurve, intents: Intent[], refusals: Refusal[]): State {
  const hash = normTxHash(log.transactionHash)
  let mine: Inflight | undefined
  for (const f of s.inflight.values()) if (normTxHash(f.hash) === hash) { mine = f; break }

  if (log.topics[0] === EVENT_TOPICS.CurveBuy) {
    const spent = tryWord(log.data, 0)
    const tokens = tryWord(log.data, 1)
    if (spent === null || tokens === null) return s
    if (mine?.kind === 'buy') return openHeldBuy(s, mine, tokens, spent, c, intents, refusals)
    const pos = [...s.positions.values()].find((p) => !p.closed && p.lastBuyHash === hash)
    if (!pos) return s
    return applyBuySpend(s, pos, tokens, spent, c, intents, refusals)
  }

  if (log.topics[0] === EVENT_TOPICS.CurveSell) {
    const tokensIn = tryWord(log.data, 0)
    const quoteOut = tryWord(log.data, 1)
    if (tokensIn === null || quoteOut === null) return s
    const pos = mine?.kind === 'sell'
      ? [...s.positions.values()].find((p) => !p.closed && (
        p.inflightIntentId === mine!.intentId
        || p.sellReceipts?.has(hash)
        || firstHash(p.lastSellHash, '') === hash
        || firstHash(p.awaitingSellReceipt, '') === hash
      ))
      : [...s.positions.values()].find((p) => !p.closed && (
        p.sellReceipts?.has(hash) || firstHash(p.lastSellHash, '') === hash || firstHash(p.awaitingSellReceipt, '') === hash
      ))
    if (!pos || pos.settledSellHashes?.has(hash)) return s
    ;(pos.settledSellHashes ??= new Set()).add(hash)
    pos.sellReceipts?.delete(hash)
    if (mine) s.inflight.delete(mine.intentId)
    if (pos.inflightIntentId !== null) {
      s.inflight.delete(pos.inflightIntentId)
      pos.inflightIntentId = null
    }
    pos.awaitingSellReceipt = null
    if (!pos.chargedReceiptHashes?.has(hash)) pos.attempts++
    pos.tokensHeld -= tokensIn
    if (pos.tokensHeld < 0n) pos.tokensHeld = 0n
    pos.proceedsWei += quoteOut
    if (pos.tokensHeld > 0n) return s

    pos.exitReason = (mine?.kind === 'sell' ? mine.reason : pos.exitReason) as ExitReason
    return closePosition(s, pos)
  }

  return s
}

/**
 * Track a curve again for a bag we still hold, from a `meta` read with no launch behind it.
 *
 * WHY IT IS NEEDED. `forgetOldRows` protects a curve while a position on it is open, but a
 * recovered bag's position does not exist yet at the moment the wallet read comes back, and
 * a buy whose fill never settled never had a curve tracked in the first place after a
 * restart. Without this the recovery had nothing to price the bag against, opened it at an
 * entry mark of zero, and `markPositions` then skipped it forever: a held bag, on the page,
 * that no exit rule ever looked at.
 *
 * It routes no book, opens no observation and arms nothing. This is not a launch; it is a
 * price for something already bought.
 */
function reseedForHeldBag(
  s: State, curve: string, params: CurveParams, seed: CurveState | null, seedBlock: number,
): State {
  if (s.curves.has(curve)) return s
  let token = ''
  for (const f of s.inflight.values()) if (f.kind === 'buy' && f.curve === curve) { token = f.token; break }
  if (!token) {
    for (const p of s.positions.values()) if (!p.closed && p.curve === curve) { token = p.token; break }
  }
  // Nothing holds this curve, so nothing needs it priced. A read with no reader is dropped
  // rather than growing the map a restart would have to walk.
  if (!token) return s

  s.curves.set(curve, {
    curve, token, params,
    confirmed: seed ?? freshCurve(params), working: seed ?? freshCurve(params),
    pending: new Map(), confirmedThrough: seedBlock, degraded: false, workingAt: s.at,
  })
  return s
}

/**
 * Book a position from tokens we already hold. Used by the fill log and by the chain
 * balance the fold asks for when that log never settled.
 *
 * A CURVE IS REQUIRED, because a position with no price is a position no exit rule can act
 * on: `markPositions` skips a row whose curve is missing, and an entry mark of zero makes
 * the take-profit bar zero, which every price clears. The caller re-seeds the curve first.
 *
 * An already-filled row only restates spend. A receipt opens at the reserved size; the
 * CurveBuy log carries `quoteIn`. Overwriting tokens or the entry mark a second time would
 * move the take-profit bar after the position was already being managed.
 */
function applyBuySpend(
  s: State, pos: Position, tokens: bigint, spent: bigint,
  c: TrackedCurve, intents: Intent[], refusals: Refusal[],
): State {
  if (tokens <= 0n) {
    if (!pos.filled) {
      s.positions.delete(pos.id)
      s.risk.reserved = Math.max(0, s.risk.reserved - 1)
      releaseDeployed(s, pos.spendWei)
      refuse(s, refusals, { at: s.at, bucket: 'send-rejected', reason: 'the buy executed and returned zero tokens', subject: pos.token })
    }
    return s
  }
  bookSpend(s, pos.spendWei, spent)
  pos.spendWei = spent
  if (pos.filled) return s
  const entryMark = markToExit(c.params, c.working, tokens)
  pos.tokensHeld = tokens
  pos.entryMarkWei = entryMark
  pos.peakMarkWei = entryMark
  pos.filled = true
  return approve(s, pos, intents)
}

function openHeldBuy(
  s: State, mine: Extract<Inflight, { kind: 'buy' }>, tokens: bigint, spent: bigint,
  c: TrackedCurve, intents: Intent[], refusals: Refusal[],
): State {
  const existing = s.positions.get(mine.intentId)
  s.inflight.delete(mine.intentId)
  if (tokens <= 0n) {
    if (existing && !existing.closed) s.positions.delete(mine.intentId)
    s.risk.reserved = Math.max(0, s.risk.reserved - 1)
    releaseDeployed(s, mine.sizeWei)
    refuse(s, refusals, { at: s.at, bucket: 'send-rejected', reason: 'the buy executed and returned zero tokens', subject: mine.token })
    return s
  }
  // The entry mark is what we could get BACK this instant, not what we paid. Marking at
  // cost would make every position look flat at open and would move the take-profit bar
  // by the round-trip cost of the trade.
  const entryMark = markToExit(c.params, c.working, tokens)
  if (existing && !existing.closed) {
    existing.lastBuyHash = firstHash(existing.lastBuyHash, mine.hash)
    return applyBuySpend(s, existing, tokens, spent, c, intents, refusals)
  }
  bookSpend(s, mine.sizeWei, spent)
  const pos: Position = {
    id: mine.intentId, token: mine.token, curve: mine.curve, book: mine.book, bookDigest: mine.bookDigest,
    templateKey: mine.templateKey,
    openedAt: s.at, spendWei: spent, entryMarkWei: entryMark, rules: mine.rules,
    tokensHeld: tokens, peakMarkWei: entryMark, proceedsWei: 0n, closedAt: null,
    abandonedAt: null, abandonReason: null,
    exitReason: null, attempts: 0, inflightIntentId: null,
    lastBuyHash: firstHash(null, mine.hash) || null,
    lastSellHash: null, awaitingSellReceipt: null, closed: false,
    venue: 'curve', grad: null, filled: true,
  }
  s.positions.set(pos.id, pos)
  return approve(s, pos, intents)
}

/**
 * A successful send is a row, the way v1 wrote it. The fill is still unproved.
 *
 * THE SLOT IS ALREADY TAKEN, at decide time. This does not reserve again. It makes the
 * send visible and keeps the curve from being forgotten while we wait for the log. Exits
 * do not run until `filled` is set. A send is not a fill: we do not sell, and we do not
 * book P&L, until a CurveBuy, a receipt, or a wallet read says we hold tokens.
 */
function openUnconfirmedBuy(s: State, f: Extract<Inflight, { kind: 'buy' }>): void {
  if (s.positions.has(f.intentId)) return
  s.positions.set(f.intentId, {
    id: f.intentId, token: f.token, curve: f.curve, book: f.book, bookDigest: f.bookDigest,
    templateKey: f.templateKey,
    openedAt: f.signedAt > 0 ? f.signedAt : s.at,
    spendWei: f.sizeWei, entryMarkWei: 0n, rules: f.rules,
    tokensHeld: 0n, peakMarkWei: 0n, proceedsWei: 0n,
    closedAt: null, abandonedAt: null, abandonReason: null,
    exitReason: null, attempts: 0, inflightIntentId: null,
    lastBuyHash: f.hash ? firstHash(null, f.hash) : null,
    lastSellHash: null, awaitingSellReceipt: null, closed: false,
    venue: 'curve', grad: null, filled: false,
  })
}

/**
 * The one place a position is booked closed. Both venues end here.
 *
 * IT IS SHARED BECAUSE THE TWO PATHS MUST NOT DRIFT. A curve sell closes from a `CurveSell`
 * log and an after-graduation sell closes from a proven swap receipt, and those are genuinely
 * different evidence — but what they do to the book is identical, and a second copy of this
 * arithmetic is a second definition of booked P&L. v1 has `settleExit` for exactly this
 * reason and routes its graduated exits through it too.
 *
 * The caller owns `proceedsWei` and `tokensHeld`; this reads them and does not set them, so a
 * partial fill is the caller's business to detect before it gets here.
 */
function closePosition(s: State, pos: Position): State {
  pos.closed = true
  pos.closedAt = s.at
  pos.lastBuyHash = null
  pos.lastSellHash = null
  pos.awaitingSellReceipt = null
  // BOOKED P&L IS PROCEEDS MINUS STAKE, in wei, on the row. Not a running balance
  // difference: the wallet moves for reasons that are not this trade.
  const pnl = pos.proceedsWei - pos.spendWei
  releaseDeployed(s, pos.spendWei)
  s.risk.reserved = Math.max(0, s.risk.reserved - 1)

  const l = bookLedger(s.risk, pos.book)
  l.realizedWei += pnl
  l.dayRealizedWei += pnl
  s.risk.walletRealizedWei += pnl
  // BOTH PEAKS TRACK NET, not booked P&L, because net is what the stop measures. A peak taken on
  // the gross figure with a drawdown taken on the net one would read every trade's gas as a fresh
  // drawdown from a high-water mark that never existed.
  if (ledgerNetWei(l) > l.peakWei) l.peakWei = ledgerNetWei(l)
  if (walletNetWei(s.risk) > s.risk.walletPeakWei) s.risk.walletPeakWei = walletNetWei(s.risk)

  // A LOSS BLOCKS ITS TEMPLATE. Farms pump first, so the touch gate cannot see them
  // coming; one real loss on a (tax, dev-buy, exempts) template is the only warning there
  // is, and it is worth an hour of refusing that shape.
  if (pnl < 0n) s.templateLossAt.set(pos.templateKey, s.at)

  // US AGAINST THE VENUE, on the way past. If this coin's watch has already settled, the pair
  // completes here; if it has not, the settle completes it instead. Either way it is filed once,
  // and it is what separates "the market took it" from "we did", which are opposite actions.
  return filePair(haltOnDrawdown(s, pos.book), pos.token)
}

/**
 * Charge gas the chain PROVED we paid, and let the stops look at the result.
 *
 * CHARGED WHEN THE RECEIPT SAYS SO, not when the position eventually closes, because a bleeding
 * position may never close. That is v1's rule, written after a stuck row burned $101 across 945
 * reverts while both of its caps read the book at +$52 and saw nothing.
 *
 * IT MOVES NO SLOT AND NO CAPACITY. Gas is money gone; it says nothing about whether the tokens
 * are still held, so `reserved` and `deployedWei` are not this function's business.
 *
 * It only ever subtracts, so it can never raise a peak, and it checks the stops on every call,
 * because the whole point is a bleed that closes no row and would otherwise reach no check.
 */
function chargeGas(s: State, book: string, gasWei: bigint): State {
  if (gasWei <= 0n) return s
  bookLedger(s.risk, book).gasWei += gasWei
  s.risk.walletGasWei += gasWei
  return haltOnDrawdown(s, book)
}

function chargeReceiptGas(s: State, pos: Position, hash: string, gasWei: bigint): State {
  const seen = pos.chargedReceiptHashes ??= new Set()
  if (seen.has(hash)) return s
  seen.add(hash)
  return chargeGas(s, pos.book, gasWei)
}

/**
 * Drop launches whose metadata read never came back.
 *
 * `pendingLaunches` was only ever cleared by the read landing, so a read that is dropped, times
 * out, or is answered by a process that is not listening leaves the entry there forever. On the
 * live tape a read-only fold answers no reads and 571 of them had accumulated over four hours.
 * Each one now also holds that curve's logs, which turns a slow leak into a fast one.
 *
 * THE DEADLINE IS THE SETTLE WINDOW, not an arbitrary timeout. A launch whose read lands after
 * the replay window has already passed cannot be scored anyway: its observation would open with
 * a partial log history and settle immediately on a truncated path, which is worse than not
 * scoring it. Refused into `screen-meta`, the same bucket a failed read uses, because it is the
 * same failure seen from the other side.
 */
function sweepPendingLaunches(s: State, refusals: Refusal[]): void {
  if (s.pendingLaunches.size === 0) return
  // THE LONGEST WINDOW ANY BOOK ASKS FOR, because this runs before the read tells us the
  // creator tax and therefore before we know which book the launch belongs to. The maximum is
  // the only safe choice: the minimum would drop a launch the slowest book was still watching.
  const settleMs = longestSettleMs(s)
  const deadline = s.at - settleMs
  for (const [curve, p] of s.pendingLaunches) {
    if (p.seenAt > deadline) continue
    s.pendingLaunches.delete(curve)
    refuse(s, refusals, { at: s.at, bucket: 'screen-meta', reason: `the curve parameters never came back within ${Math.round(settleMs / 1000)}s, so this launch can no longer be scored`, subject: p.token })
  }
}

/**
 * Turn a curve log into the simulator's event shape and hand it to whoever is watching.
 *
 * THREE TOPICS, WHICH IS ALL THE REPLAY HAS EVER SEEN. Buy, Sell and BuybackLocked are the
 * topics `chainio.decode_seq` fetched, so they are the topics every stored row in `gate.db`
 * was produced from. Fee sweeps move the real curve and the replay does not model them; that
 * is a known limit of the engine, not something to quietly fix here, because fixing it would
 * make this port stop reproducing the rows it is checked against.
 *
 * OUR OWN FILLS ARE DROPPED. The replay measures the venue, not our own size. Matched on the
 * transaction hash against what is in flight, which is the same test `settleOwnFill` uses,
 * rather than on "a log on a curve we hold": several buyers land in the same block.
 */
function recordSimEvent(s: State, addr: string, log: RawLog): void {
  // Nobody watching costs nothing. Most logs in a batch are on curves no book routed, and
  // decoding four words for each of them is work the fold does thirteen times a second.
  const pending = s.pendingLaunches.get(addr)
  if (!pending && !s.observations.has(addr)) return
  // A pending launch is bounded by the SAME horizon an open observation is. Without this a
  // launch whose metadata read never lands collects that curve's logs forever: found on the
  // live tape, where a read-only fold answers no reads and 571 pending launches were holding
  // 17,604 events between them and still growing.
  if (pending && log.blockNumber - pending.block > LIVE_PATH.entryBlk + LIVE_PATH.horizon) return

  const topic = log.topics[0]
  if (topic !== EVENT_TOPICS.BuybackLocked && topic !== EVENT_TOPICS.CurveBuy && topic !== EVENT_TOPICS.CurveSell) return

  const hash = log.transactionHash.toLowerCase()
  for (const f of s.inflight.values()) if (f.hash === hash) return

  const w = (n: number) => '0x' + log.data.slice(2 + n * 64, 66 + n * 64)
  const e: SimEvent = topic === EVENT_TOPICS.BuybackLocked
    ? { b: log.blockNumber, s: 'BB', q: w(0), t: w(1) }
    : {
        b: log.blockNumber, s: topic === EVENT_TOPICS.CurveBuy ? 'B' : 'S',
        r: addrFromTopic(log.topics[2]), q: w(0), t: w(1), f: w(2), x: w(3), tx: hash,
      }

  if (pending) { pending.events.push(e); return }
  recordCurveLog(s, addr, e)
}

/**
 * A launch. Screen the pair, then ASK FOR THE CURVE, because nothing else can be decided yet.
 *
 * `TokenLaunched` carries the token, the curve, the deployer and the pair token. It does not
 * carry the creator tax, the supply or the snipe-tax schedule: those live on the curve
 * contract and have to be read. Every trading filter needs the tax, so the launch waits in
 * `pendingLaunches` until the read lands and is judged in `onCurveParams` below.
 *
 * THE SCREEN RUNS HERE AND THE TRADING FILTERS DO NOT. Pair and meta decide whether we
 * even wait for a curve read. Observation and the buy arm both wait for `admits` in
 * `onCurveParams`, so the guard scores the same coins the book is allowed to buy.
 */
function onLaunch(s: State, log: RawLog, devBuyWei: bigint, intents: Intent[], refusals: Refusal[]): State {
  if (log.address.toLowerCase() !== ADDRESSES.factory) return s
  const token = addrFromTopic(log.topics[1])
  const curve = addrFromTopic(log.topics[2])
  const deployer = addrFromTopic(log.topics[3])
  const pairToken = wordAddress(log.data, 0)

  if (pairToken !== ADDRESSES.ethPair) {
    refuse(s, refusals, { at: s.at, bucket: 'screen-pair', reason: `pair token ${pairToken.slice(0, 10)} is not ETH`, subject: token })
    return s
  }
  if (!curve || s.curves.has(curve) || s.pendingLaunches.has(curve)) return s

  s.registry.set(deployer, (s.registry.get(deployer) ?? 0) + 1)
  s.pendingLaunches.set(curve, {
    token, curve, deployer, block: log.blockNumber, tx: log.transactionHash.toLowerCase(),
    seenAt: s.at, devBuyWei, events: [],
  })
  /**
   * The read is an INTENT, not a call. A fold that reached for a chain would stop being
   * replayable, and the answer comes back as a `chain-read` event that the replay sees too.
   *
   * THE LAUNCH TRANSACTION IS THE THIRD ARGUMENT, and it is the whole reason this bot can
   * trade. The exempt-wallet count exists nowhere else: `TokenLaunched` carries the token, the
   * curve, the deployer and the pair token and nothing more, and no getter on the curve
   * returns it. It is an argument to `launchAndBuy`, so the only place to read it is the
   * calldata of the transaction that launched this token. Without it `admits` counts zero
   * exempt wallets, every book with a floor refuses every launch, and the bot is a very
   * thorough observer: 927 `entry-exempt` refusals and no trades in the first three hours
   * after the cutover, against v1's 101 buys a day.
   */
  intents.push({ kind: 'read', what: 'meta', args: [curve, token, log.transactionHash.toLowerCase()] })
  return s
}

/**
 * The curve's parameters came back. Now the launch can be judged.
 *
 * Routing, `admits`, the watch and the arm happen here, one step later than the launch
 * itself. The step costs nothing: the arm delay is 2,000ms by spec and the read is tens of
 * milliseconds. The watch opens only after `admits` passes, so the guard and the book see
 * the same coins.
 */
function onCurveParams(
  s: State, curve: string, params: CurveParams, exemptions: number | null,
  seed: CurveState | null, seedBlock: number,
  intents: Intent[], refusals: Refusal[],
): State {
  const pending = s.pendingLaunches.get(curve)
  if (!pending) return reseedForHeldBag(s, curve, params, seed, seedBlock)
  s.pendingLaunches.delete(curve)

  const start = seed ?? freshCurve(params)
  const tracked: TrackedCurve = {
    curve, token: pending.token, params,
    confirmed: start, working: start,
    // The read already contains every log up to `seedBlock`, so folding one of those again
    // double-counts it. This watermark is the whole defence against that.
    pending: new Map(), confirmedThrough: Math.max(pending.block, seedBlock), degraded: false, workingAt: s.at,
  }
  s.curves.set(curve, tracked)

  const facts: LaunchFacts = {
    token: pending.token, creatorTaxBps: Number(params.creatorTaxBps),
    devBuyWei: pending.devBuyWei, exemptions, deployer: pending.deployer,
  }

  const book = take(s, refusals, routeBook(s.at, s.config, facts.token, facts.creatorTaxBps))
  if (!book) return s

  // WATCH ONLY WHAT THE BOOK MAY BUY. Same `admits` as the arm: tax band, exempt floor,
  // template-loss block. The Sep 1-14 research indicator used that set; watching the wider
  // routed set made the live guard score coins live would refuse. Halt, slots and drawdown
  // stay sit-outs and do not gate the watch.
  const lossAt = s.templateLossAt.get(templateKey(facts.creatorTaxBps, facts.devBuyWei, facts.exemptions)) ?? null
  const verdict = take(s, refusals, admits(s.at, book, facts, lossAt))
  if (!verdict) return s

  openObservation(s, {
    token: facts.token, curve, book: book.id,
    launchBlock: pending.block, deployer: pending.deployer, launchTx: pending.tx,
    creatorTaxBps: facts.creatorTaxBps, events: pending.events,
  })

  // ARM, DO NOT BUY. The curve is still being bought into for the first seconds of its life,
  // so the entry delay is a measured rule and it belongs to the decision, not to a timer
  // somewhere in a transport.
  const armed: Armed = {
    token: facts.token, templateKey: verdict.templateKey, devBuyWei: facts.devBuyWei,
    meta: { token: facts.token, curve, params, exemptions, deployer: facts.deployer, launchedAt: Number(params.launchedAt) * 1000, block: pending.block },
    armAt: pending.seenAt + book.entry.entryDelayMs, releasedByBlock: null,
  }
  s.armed.set(facts.token, armed)
  intents.push({ kind: 'arm', token: facts.token, releaseAt: armed.armAt + book.entry.entryFallbackLateMs })
  return s
}

// ---------------------------------------------------------------------------
// feed-block
// ---------------------------------------------------------------------------

function foldFeedBlock(s: State, e: Extract<Event, { kind: 'feed-block' }>, intents: Intent[], refusals: Refusal[]): Decision {
  for (const tx of e.txs) {
    const to = tx.to.toLowerCase()
    const c = s.curves.get(to)
    if (!c) continue
    const sel = tx.data.slice(0, 10)
    if (sel !== SELECTORS.buy && sel !== SELECTORS.sell) {
      // The live run routed this and the fold would not have. Recorded as a refusal rather
      // than ignored, because a routing disagreement means the replay is not reproducing
      // the run and that has to be visible, not inferred later from a mismatch.
      refuse(s, refusals, { at: s.at, bucket: 'feed-routing-divergence', reason: `live routed selector ${sel} on a tracked curve; the fold would not have`, subject: tx.hash })
      continue
    }
    c.pending.set(tx.hash, { at: s.at, data: tx.data, blockTs: e.timestamp })
    rebase(c, s.at)
  }
  s = { ...s, overlayAt: s.at }

  // Feed timestamps have whole-second precision. Block offsets preserve the same entry
  // clock used by the simulator without rounding a 2s delay into the next second.
  s = releaseArmed(s, intents, refusals, e.block)
  return markPositions(s, intents, refusals)
}

function releaseArmed(s: State, intents: Intent[], refusals: Refusal[], block?: number): State {
  for (const [token, a] of [...s.armed]) {
    const routed = routeBook(s.at, s.config, token, Number(a.meta.params.creatorTaxBps))
    if (!routed.ok) continue
    const entry = routed.value.entry
    const chainReady = block !== undefined && block >= a.meta.block + blocksFromMs(entry.entryDelayMs)
    const fallbackReady = s.at >= a.armAt + entry.entryFallbackLateMs
    const heldChainReady = a.releasedByBlock !== null
    if (!chainReady && !heldChainReady && !fallbackReady) continue
    if (s.sensors.quietEntryHold && s.sensors.entryReady === false && !fallbackReady) {
      if (chainReady) s.armed.set(token, { ...a, releasedByBlock: block! })
      continue
    }
    s.armed.delete(token)
    // A saved chain release must not permit entry after its original fallback deadline.
    if (heldChainReady && fallbackReady && s.sensors.entryReady !== false) {
      refuse(s, refusals, { at: s.at, bucket: 'risk-logs-unhealthy', reason: 'quiet preparation missed the entry deadline', subject: token })
      continue
    }
    s = tryEnter(s, { ...a, releasedByBlock: chainReady ? block! : a.releasedByBlock }, intents, refusals)
  }
  return s
}

// ---------------------------------------------------------------------------
// The entry decision
// ---------------------------------------------------------------------------

function tryEnter(s: State, a: Armed, intents: Intent[], refusals: Refusal[]): State {
  const token = a.token
  const c = s.curves.get(a.meta.curve)
  if (!c) return s

  const book = take(s, refusals, routeBook(s.at, s.config, token, Number(a.meta.params.creatorTaxBps)))
  if (!book) return s

  /**
   * WHAT THIS BOOK STAKES, WHICH IS THE LOWER OF TWO NUMBERS WITH TWO DIFFERENT JOBS.
   *
   * `book.sizeWei` is the reviewed ceiling. A per-book override wins over the global default,
   * and the declared ceiling still wins over both. A size control can never fund a size-0 book
   * or raise a book past what its spec agreed to.
   */
  const baseSizeWei = effectiveBookSizeWei(book, s.switches)
  if (baseSizeWei <= 0n) {
    refuse(s, refusals, { at: s.at, bucket: 'risk-size', reason: `${book.id} is declared with size 0: it routes, observes and scores, but it is not funded`, subject: token })
    return s
  }
  const sizeWei = sizedEntryWei(baseSizeWei, sizingReading(s, book), s.config.risk.maxTradeSizeWei)
  const verdict = take(s, refusals, canEnter(s, { token, book: book.id, sizeWei }, health(s)))
  if (!verdict) return s

  // The pump check is LAST because it costs two curve simulations, and there is no point
  // paying for them on a launch eight cheaper checks would have refused.
  const blockTs = BigInt(Math.floor(s.at / 1000))
  const pumped = take(s, refusals, pumpCheck(s.at, token, c.params, c.working, sizeWei, blockTs, book.entry.maxEntryPriceMultiple))
  if (!pumped) return s

  // THE SLIPPAGE BOUND IS A PRICE BOUND, computed here from the simulation the decision just
  // ran. A driver that recomputed it would be a second implementation of the same rule.
  const minTokensOut = (pumped.liveTokens * BigInt(10_000 - book.entry.buySlippageBps)) / 10_000n

  // THE RULES ARE PINNED HERE AND NEVER RE-READ. An open position keeps the policy it
  // opened under, so editing the spec mid-flight cannot retroactively change what an open
  // bag is allowed to do. The take-profit rung is part of that: re-reading it per tick would
  // let a regime that flips mid-hold move the exit target under a position already open.
  // THIS BOOK'S OWN BAR, never the wallet's. Two books trading different bands see different
  // launches, so a rung picked from the other book's window is a target nothing measured.
  const rules = {
    maxHoldMs: book.exit.maxHoldMs,
    hardStopMultiple: book.exit.hardStopMultiple,
    deadCoinAfterMs: book.exit.deadCoinAfterMs,
    deadCoinBelowMultiple: book.exit.deadCoinBelowMultiple,
    graduationExitAt: book.exit.graduationExitAt,
    maxSellAttempts: book.exit.maxSellAttempts,
    // Pinned on the position because the sell path needs it long after the book's spec may
    // have moved, and a bound re-read at sell time is a bound the position never agreed to.
    sellFinalMinQuoteOutWei: book.exit.sellFinalMinQuoteOutWei,
    // Through `rungNow`, which is also what a watch freezes as its venue column, so the
    // indicator cannot end up measuring a rung no entry would have taken.
    takeProfitMultiple: rungNow(s.at, s.sensors.bars.get(book.id) ?? null, book).multiple,
  }

  // RESERVE BEFORE ANYTHING ELSE CAN RUN. Two launches in one batch can both pass capacity
  // and both open, taking N+1 slots, unless the slot is claimed here, synchronously, before
  // the intent leaves.
  s.risk.reserved++
  s.risk.deployedWei += sizeWei
  s.risk.everEntered.add(token)

  const { id, decisions } = mintId(s, 'buy')
  // Recorded as in flight the moment it is decided, not when a driver signs it: an intent
  // that lives only in the driver is state the fold cannot see, and rebuilding it later
  // from a database row plus a chain read is what the old crash recovery had to do.
  s.inflight.set(id, {
    kind: 'buy', intentId: id, token, curve: c.curve, book: book.id, bookDigest: bookDigest(book),
    templateKey: a.templateKey, sizeWei, rules, hash: '', nonce: -1, signedAt: 0,
    walletReadAt: 0, walletReads: 0,
  })
  intents.push({ kind: 'buy', intentId: id, token, curve: c.curve, book: book.id, sizeWei, minTokensOut, decidedAt: s.at })
  return { ...s, decisions }
}

// ---------------------------------------------------------------------------
// Exits
// ---------------------------------------------------------------------------

function rememberSell(pos: Position, rec: Extract<Inflight, { kind: 'sell' }>, at: number): void {
  const hash = normTxHash(rec.hash)
  if (!hash) return
  pos.lastSellHash = hash
  const pending = pos.sellReceipts ??= new Map()
  if (!pending.has(hash)) pending.set(hash, { reason: rec.reason as ExitReason, readAt: at })
}

function keepSellEvidence(pos: Position, rec: Inflight | undefined, intents: Intent[], at: number): void {
  if (!rec || rec.kind !== 'sell' || !rec.hash) return
  const hash = normTxHash(rec.hash)
  const alreadyRead = pos.sellReceipts?.get(hash)?.readAt === at
  rememberSell(pos, rec, at)
  if (pos.awaitingSellReceipt === hash) return
  pos.awaitingSellReceipt = hash
  pos.sellReceipts!.get(hash)!.readAt = at
  if (!alreadyRead) intents.push({ kind: 'read', what: 'receipt', args: [hash, pos.token, pos.curve] })
}

/**
 * A quiet sell needs a receipt. Retain its hash and stop overlapping attempts until
 * the receipt or fill log resolves it. A timeout alone proves no gas expenditure.
 */
function freeStuckSell(s: State, pos: Position, intents: Intent[], refusals: Refusal[]): State {
  if (pos.inflightIntentId === null) return s
  // A position only ever points at its own sell. Narrowed rather than asserted so a record of
  // some other kind cannot quietly take the `openedAt` path and be freed on the first tick.
  const rec = s.inflight.get(pos.inflightIntentId)
  const f = rec && rec.kind === 'sell' ? rec : undefined
  // `signedAt` is 0 until the driver signs, so an exit the driver never picked up is measured
  // from when the fold decided it. A record that has gone missing entirely falls back to the
  // position, which can only make it overdue, never early.
  const since = f === undefined ? pos.openedAt : f.signedAt > 0 ? f.signedAt : f.raisedAt
  if (s.at - since < SELL_SETTLE_GIVEUP_MS) return s

  keepSellEvidence(pos, f, intents, s.at)

  s.inflight.delete(pos.inflightIntentId)
  pos.inflightIntentId = null
  refuse(s, refusals, {
    at: s.at, bucket: 'exit-unsettled', subject: pos.token,
    reason: `a sell was sequenced ${Math.round((s.at - since) / 1000)}s ago and never settled; waiting for its receipt before retrying`,
  })
  // Wait for the receipt before deciding that this sell needs another approval.
  return s
}

// ---------------------------------------------------------------------------
// After graduation: selling on the other venue
// ---------------------------------------------------------------------------

/**
 * Do the one thing the after-graduation sell needs next.
 *
 * THE DECISION IS NOT HERE. `nextGraduationStep` decides; this turns its answer into an intent
 * and moves the bookkeeping. Keeping the order in a pure function means the sequence can be
 * tested by reading it, instead of by running the whole fold against a fake chain, which is
 * what v1 has to do.
 *
 * EVERY BRANCH SETS `retryAt`, and that is load-bearing rather than tidy. `clock` fires every
 * 250ms while anything is open, so a branch that raised a read without arming a gap would
 * raise the same read four times a second until the answer landed. The old bot shipped exactly
 * that shape of loop and it sent 33,804 sells against two positions that could never exit.
 */
function stepGraduation(s: State, pos: Position, intents: Intent[], refusals: Refusal[]): State {
  const g = pos.grad
  if (g === null) return s

  const action = nextGraduationStep(pos, s.at)
  switch (action.kind) {
    case 'wait':
      return s

    case 'read-pool':
      g.retryAt = s.at + GRAD_RETRY_MS
      intents.push({ kind: 'read', what: 'grad-pool', args: [pos.token, pos.curve] })
      return s

    case 'read-wallet':
      g.retryAt = s.at + GRAD_RETRY_MS
      intents.push({ kind: 'read', what: 'grad-wallet', args: [pos.token] })
      return s

    case 'read-receipt':
      g.retryAt = s.at + GRAD_RECEIPT_GAP_MS
      intents.push({ kind: 'read', what: 'receipt', args: [action.hash, pos.token] })
      return s

    case 'send': {
      const { id, decisions } = mintId(s, 'grad')
      s = { ...s, decisions }
      // The deadline is computed from the FOLD'S clock, so the bytes a replay builds are the
      // bytes the live run built. A driver reading its own clock here would sign a different
      // transaction on every replay and the proof would be worthless.
      const ttl = action.step === 'approve-permit' ? GRAD_PERMIT_TTL_S : GRAD_SWAP_TTL_S
      const deadline = Math.floor(s.at / 1000) + ttl
      pos.inflightIntentId = id
      g.retryAt = s.at + GRAD_RETRY_MS
      s.inflight.set(id, {
        kind: 'graduate', intentId: id, token: pos.token, curve: pos.curve,
        step: action.step, positionId: pos.id, hash: '', nonce: -1, signedAt: 0, raw: '',
      })
      intents.push({
        kind: 'grad', intentId: id, token: pos.token, curve: pos.curve,
        step: action.step, pool: g.pool, amountWei: action.amountWei, deadline,
      })
      return s
    }

    case 'resend':
      // Same bytes, same nonce. Bump pendingAt so the next tick does not rebroadcast every 250ms.
      g.pendingAt = s.at
      g.retryAt = s.at + GRAD_RECEIPT_GAP_MS
      intents.push({ kind: 'broadcast', hash: action.hash, raw: action.raw })
      return s

    case 'empty':
      g.emptyReads++
      g.wallet = null
      if (g.emptyReads >= GRAD_BUDGET.maxSends) {
        g.gaveUp = true
        refuse(s, refusals, {
          at: s.at, bucket: 'exit-grad-blocked', subject: pos.token,
          reason: `${action.why} (${g.emptyReads} consecutive empty reads); still holding, and it needs a person`,
        })
        return s
      }
      gradSetback(g, s.at, action.why)
      return s

    case 'close':
      // The receipt proved an ETH sale and a zero remaining balance, so the bag is gone and
      // the proceeds are the pool's own numbers rather than a curve quote, which would be an
      // estimate for a market this token has left.
      pos.proceedsWei += action.proceedsWei
      pos.tokensHeld = 0n
      pos.exitReason = 'graduated-swap'
      return closePosition(s, pos)

    case 'budget':
      g.gaveUp = true
      refuse(s, refusals, {
        at: s.at, bucket: 'exit-grad-budget', subject: pos.token,
        reason: `the graduated sell spent its budget (${action.why}); still holding, and it needs a person`,
      })
      return s

    case 'blocked':
      g.gaveUp = true
      refuse(s, refusals, {
        at: s.at, bucket: 'exit-grad-blocked', subject: pos.token,
        reason: `${action.why}; still holding, and it needs a person`,
      })
      return s
  }
}

/** Re-mark every open position against the curve as it now stands, and decide exits. */
function markPositions(s: State, intents: Intent[], refusals: Refusal[]): Decision {
  reclaimOrphanBuys(s, intents, refusals)
  sweepPendingLaunches(s, refusals)
  // The observer runs on the same tick as the marks, so a watched launch and a held position
  // on the same curve never see two different working states in one second.
  s = observe(s)

  for (const pos of s.positions.values()) {
    if (pos.closed) continue
    if (pos.exitRecovery) {
      if (s.at - pos.exitRecovery.readAt >= APPROVAL_READ_MS) {
        pos.exitRecovery.readAt = s.at
        intents.push({kind:'read',what:'position-wallet',args:[pos.token,pos.id]})
      }
      continue
    }
    for (const [hash, pending] of pos.sellReceipts ?? []) {
      if (s.at - pending.readAt < SELL_SETTLE_GIVEUP_MS) continue
      pending.readAt = s.at
      intents.push({ kind: 'read', what: 'receipt', args: [hash, pos.token, pos.curve] })
    }
    // A send is not a fill. Selling, graduating, or parking a row that has not proved tokens
    // would invent a bag and then invent an exit. The orphan path asks the wallet instead.
    if (pos.filled === false) continue
    const c = s.curves.get(pos.curve)
    if (!c) continue

    /**
     * HAS THE CURVE STOPPED BEING A VENUE? Checked before anything else, because every rule
     * below is about a market this bag may no longer be in.
     *
     * CONFIRMED STATE, NOT `working`, and the difference matters: the flip is one way, so it
     * must be made on proof rather than on the feed overlay's prediction. An overlay that
     * predicts graduation still parks the sell below (`exit-parked`), and the flip happens when
     * a log confirms it. v1 reads `confirmed` here for the same reason.
     */
    if (pos.venue === 'curve' && (c.confirmed.graduated || readyToGraduate(c.params, c.confirmed))) {
      const rec = pos.inflightIntentId === null ? undefined : s.inflight.get(pos.inflightIntentId)
      // A sequenced curve sell may still settle. Dropping it here is how a real CurveSell
      // arrives with nobody to match, the V4 path then reads a zero balance, and a sold bag
      // is booked as blocked. v1 pulls that receipt before handing off.
      if (rec?.kind === 'sell' && rec.signedAt > 0) {
        if (s.at - rec.signedAt < SELL_SETTLE_GIVEUP_MS) continue
        // The curve is gone. A curve re-approve would burn gas for a venue we are leaving;
        // the V4 path has its own allowances. Count the attempt: the chain already did.
        // Keep the hash: a late CurveSell still has to close this row and give the slot back.
        keepSellEvidence(pos, rec, intents, s.at)
        s.inflight.delete(rec.intentId)
        pos.inflightIntentId = null
        refuse(s, refusals, {
          at: s.at, bucket: 'exit-unsettled', subject: pos.token,
          reason: `a sell was sequenced ${Math.round((s.at - rec.signedAt) / 1000)}s ago and never settled; the curve has graduated, so the bag moves to the V4 venue`,
        })
      } else if (pos.inflightIntentId !== null) {
        keepSellEvidence(pos, rec, intents, s.at)
        s.inflight.delete(pos.inflightIntentId)
        pos.inflightIntentId = null
      }
      pos.venue = 'graduated'
      pos.grad = freshGradState()
    }

    if (pos.venue === 'graduated') {
      const g = pos.grad
      // Phase 0 and the curve itself says it is not ready: do not call graduate().
      // Re-read the factory so we notice when it becomes ready, and do not spend the budget.
      if (g && g.phase === 0 && g.curveReady === false && !g.gaveUp
        && pos.inflightIntentId === null && g.awaitingReceipt === null && s.at >= g.retryAt) {
        g.retryAt = s.at + 10_000
        intents.push({ kind: 'read', what: 'grad-pool', args: [pos.token, pos.curve] })
        continue
      }
      s = stepGraduation(s, pos, intents, refusals)
      continue
    }

    s = freeStuckSell(s, pos, intents, refusals)

    const mark = markToExit(c.params, c.working, pos.tokensHeld)
    if (mark > pos.peakMarkWei) pos.peakMarkWei = mark
    s = checkApproval(s, pos, intents)
    if (pos.approval && !pos.approval.ready) continue
    if (pos.inflightIntentId === null && (pos.sellReceipts?.size ?? 0) > 0) continue

    if (exhausted(pos)) {
      if (pos.inflightIntentId !== null) {
        keepSellEvidence(pos, s.inflight.get(pos.inflightIntentId), intents, s.at)
        s.inflight.delete(pos.inflightIntentId)
        pos.inflightIntentId = null
      }
      const canGraduate = c.confirmed.graduated
        || readyToGraduate(c.params, c.confirmed)
        || readyToGraduate(c.params, c.working)
      if (canGraduate) {
        refuse(s, refusals, { at: s.at, bucket: 'exit-stuck', reason: `${pos.attempts} sell attempts spent on the curve; trying the graduated venue`, subject: pos.token })
        pos.venue = 'graduated'
        pos.grad = freshGradState()
        s = stepGraduation(s, pos, intents, refusals)
        continue
      }
      refuse(s, refusals, { at: s.at, bucket: 'exit-stuck', reason: `${pos.attempts} sell attempts spent; the curve is still the venue and it needs a person`, subject: pos.token })
      continue
    }

    const graduating = graduationProgress(c.params, c.working) <= pos.rules.graduationExitAt
    const reason = evaluateExit(pos, mark, s.at, graduating)
    if (reason === null) continue

    // Will the curve even take this sell? Simulated first, so a position that cannot be
    // exited is reported as parked rather than burned as a revert. The simulation's OUTPUT
    // is deliberately discarded: it answers "would this revert", not "what should we ask
    // for".
    try {
      simSell(c.params, c.working, pos.tokensHeld)
    } catch {
      if (readyToGraduate(c.params, c.confirmed) || readyToGraduate(c.params, c.working) || c.confirmed.graduated) {
        if (pos.inflightIntentId !== null) {
          keepSellEvidence(pos, s.inflight.get(pos.inflightIntentId), intents, s.at)
          s.inflight.delete(pos.inflightIntentId)
          pos.inflightIntentId = null
        }
        refuse(s, refusals, { at: s.at, bucket: 'exit-parked', reason: 'the curve will not accept a sell; the bag has moved to the graduated venue', subject: pos.token })
        pos.venue = 'graduated'
        pos.grad = freshGradState()
        s = stepGraduation(s, pos, intents, refusals)
        continue
      }
      refuse(s, refusals, { at: s.at, bucket: 'exit-parked', reason: 'the curve will not accept a sell of this size right now', subject: pos.token })
      continue
    }

    // THE SELL BOUND IS 1 WEI BY DESIGN, and it is pure cost. With no mempool there is no
    // sandwich to defend against, so the bound can only ever REFUSE a sell we want to make,
    // and a refused sell on a draining curve costs the whole position rather than a few bps.
    // It is a revert guard, not a price improvement.
    const minQuoteOut = BigInt(pos.rules.sellFinalMinQuoteOutWei)

    const { id, decisions } = mintId(s, 'sell')
    s = { ...s, decisions }
    pos.inflightIntentId = id
    s.inflight.set(id, { kind: 'sell', intentId: id, token: pos.token, curve: pos.curve, reason, raisedAt: s.at, hash: '', nonce: -1, signedAt: 0 })
    intents.push({ kind: 'sell', intentId: id, token: pos.token, curve: pos.curve, tokensIn: pos.tokensHeld, minQuoteOut, reason, attempt: pos.attempts + 1 })
  }
  return { state: s, intents, refusals }
}

// ---------------------------------------------------------------------------
// Effects coming back
// ---------------------------------------------------------------------------

function foldSendResult(s: State, e: Extract<Event, { kind: 'tx-send-result' }>, intents: Intent[], refusals: Refusal[]): Decision {
  const f = s.inflight.get(e.intentId)
  // The hash is how a later CurveBuy/CurveSell finds this record. `tx-signed` usually
  // wrote it already; a send result that carries one and an inflight that does not is
  // the case where the sign event never made the tape.
  if (f && e.hash) {
    f.hash = firstHash(f.hash, e.hash)
    if (f.kind === 'sell') {
      const pos = [...s.positions.values()].find((p) => p.inflightIntentId === f.intentId)
      if (pos) rememberSell(pos, f, s.at)
    }
    if (f.kind === 'buy') {
      const pos = s.positions.get(f.intentId)
      if (pos) pos.lastBuyHash = firstHash(pos.lastBuyHash, f.hash)
    }
  }

  /**
   * A SUCCESSFUL SEND KEEPS ITS INFLIGHT RECORD. It is not finished; it is in the air.
   *
   * `settleOwnFill` matches an arriving CurveBuy or CurveSell log to `state.inflight` BY
   * TRANSACTION HASH. Deleting the record here, as this did until 2026-09-16, means a send
   * that worked has nothing left for its own fill to match against: the position is never
   * opened, `risk.reserved` is never released, and after `maxConcurrent` buys every launch is
   * refused for capacity forever. That is what the monitor was showing as `risk-capacity` 10
   * with zero positions open, which is an impossible pair and is how the bug was found.
   *
   * An UNCERTAIN failure keeps it for the same reason: the bytes may still have been
   * sequenced, and a record deleted on a maybe is a fill that arrives with no owner.
   *
   * Only a CLEAN rejection is terminal, because nothing was sequenced and nothing can arrive.
   */
  if (!e.ok && !e.uncertain) s.inflight.delete(e.intentId)

  // The submission record ends here; the position retains the approval hash until
  // its receipt and a fresh allowance read confirm that selling is possible.
  if (f?.kind === 'approve') {
    s.inflight.delete(e.intentId)
    const pos = [...s.positions.values()].find((p) => !p.closed && p.approval?.intentId === f.intentId)
    if (pos?.approval) {
      const a = pos.approval
      a.intentId = null
      if (e.ok || e.uncertain) {
        a.hash = firstHash(f.hash, e.hash) || null
        a.retryAt = s.at + APPROVAL_READ_MS
        if (a.hash) intents.push({ kind: 'read', what: 'receipt', args: [a.hash, pos.token, pos.curve, 'approve'] })
      } else {
        approvalBackoff(pos, s.at, e.error ?? 'approval rejected before sequencing')
        refuse(s, refusals, { at: s.at, bucket: 'exit-unsettled', subject: pos.token,
          reason: `approval failed: ${a.lastError}; sells wait for a confirmed allowance` })
      }
    }
  }

  if (!e.ok && !e.uncertain) {
    // A CLEAN rejection: nothing was sequenced, so the slot and the capital go back. An
    // UNCERTAIN failure does not release, because the bytes may still have been sequenced
    // and releasing would let a second buy take the same slot as a fill we cannot see.
    if (f?.kind === 'buy') {
      s.risk.reserved = Math.max(0, s.risk.reserved - 1)
      // THE CAPITAL GOES BACK WITH THE SLOT. `tryEnter` takes both together at reserve time
      // (`decide.ts:555`), and until 2026-09-16 only the slot came back here. A rejected send
      // therefore consumed bankroll permanently: sixteen sequencer rejections and every later
      // launch is refused for `risk-bankroll` with nothing actually deployed. Found on the
      // monitor, whose sends are all rejected by construction, so it hit the wall in an hour.
      releaseDeployed(s, f.sizeWei)
      refuse(s, refusals, { at: s.at, bucket: 'send-rejected', reason: e.error ?? 'rejected with no reason given', subject: e.intentId })
    }
    if (f?.kind === 'sell') {
      const pos = [...s.positions.values()].find((p) => p.inflightIntentId === e.intentId)
      if (pos) {
        pos.inflightIntentId = null
        pos.sellReceipts?.delete(normTxHash(f.hash))
        if (pos.awaitingSellReceipt === normTxHash(f.hash)) pos.awaitingSellReceipt = null
        // A refusal before sequencing burned nothing and used no nonce, so it is NOT an
        // attempt against the cap. Counting it would strand positions on a flaky sequencer.
        refuse(s, refusals, { at: s.at, bucket: 'send-refused', reason: e.error ?? 'sell refused by the sequencer', subject: pos.token })
      }
    }
  }

  if ((e.ok || e.uncertain) && f?.kind === 'buy') openUnconfirmedBuy(s, f)

  if (f?.kind === 'graduate') {
    const pos = s.positions.get(f.positionId)
    if (pos && pos.grad !== null) {
      const g = pos.grad
      // The leg is no longer in the air either way, so the machine is free to think again.
      pos.inflightIntentId = null
      /**
       * A GRADUATE RECORD IS DONE AT THE SEND RESULT, unlike a buy or a sell.
       *
       * The comment at the top of this function keeps successful buys and sells in `inflight`
       * because `settleOwnFill` matches their fills back by transaction hash. Nothing matches a
       * graduation leg that way: there is no `CurveBuy` or `CurveSell` to arrive, and the
       * receipt is matched against `grad.awaitingReceipt` on the position instead. So the
       * record has no remaining job, and `inflight` is an unbounded Map.
       */
      s.inflight.delete(e.intentId)

      if (e.ok || e.uncertain) {
        /**
         * ONLY A SEQUENCED SEND COSTS BUDGET, and it is the same rule the sell path already
         * states above: a refusal burned no gas and used no nonce. It is also what keeps
         * shadow mode honest. Shadow signs and never broadcasts, so every one of its sends
         * comes back a clean rejection; if those counted, a shadow run would spend all twelve
         * on a bag it never touched and hand the next live process a position that had
         * already given up.
         *
         * An UNCERTAIN send counts, because the bytes may well have been sequenced and the
         * receipt is the only thing that can say. Undercounting a maybe is how a budget
         * stops being a ceiling.
         */
        g.sends++
        g.awaitingReceipt = firstHash(e.hash, f.hash)
        g.pendingStep = f.step
        g.pendingRaw = f.raw || null
        g.pendingAt = s.at
        g.retryAt = s.at + GRAD_RECEIPT_GAP_MS
        g.lastError = null
      } else {
        gradSetback(g, s.at, e.error ?? 'refused by the sequencer before sequencing')
        refuse(s, refusals, {
          at: s.at, bucket: 'send-refused', subject: pos.token,
          reason: `graduated ${f.step} refused by the sequencer: ${e.error ?? 'no reason given'}; backing off, still holding`,
        })
      }
    }
  }
  return { state: s, intents, refusals }
}

function foldChainRead(s: State, e: Extract<Event, { kind: 'chain-read' }>, intents: Intent[], refusals: Refusal[]): Decision {
  if (e.request.kind === 'allowance') {
    const pos = s.positions.get(e.request.args[2] ?? '')
    const a = pos?.approval
    const raw = (e.result as { allowanceWei?: unknown } | null)?.allowanceWei
    if (!pos || pos.closed || !a || !a.awaitingAllowance
      || pos.token !== e.request.args[0]?.toLowerCase() || pos.curve !== e.request.args[1]?.toLowerCase()) {
      return { state: s, intents, refusals }
    }
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return { state: s, intents, refusals }
    if (BigInt(raw) >= pos.tokensHeld) {
      a.ready = true
      a.awaitingAllowance = false
      a.lastError = null
    } else {
      approvalBackoff(pos, s.at, 'the confirmed allowance is below the token balance')
    }
    return { state: s, intents, refusals }
  }
  if (e.request.kind === 'meta') {
    const curve = (e.request.args[0] ?? '').toLowerCase()
    const r = e.result as { params?: Record<string, string>; exemptions?: number | null } | null
    if (!r || !r.params) {
      // The read failed or returned nothing. The launch is dropped with a named bucket
      // rather than left in `pendingLaunches` forever, which is how the old bot leaked
      // entries into caches nobody ever swept.
      const p = s.pendingLaunches.get(curve)
      s.pendingLaunches.delete(curve)
      if (p) refuse(s, refusals, { at: s.at, bucket: 'screen-meta', reason: 'the curve parameters could not be read, so no filter can judge this launch', subject: p.token })
      return { state: s, intents, refusals }
    }
    const p = r.params
    const params: CurveParams = {
      phantomQuote: BigInt(p.phantomQuote ?? '0'), reservedTokens: BigInt(p.reservedTokens ?? '0'),
      launchSupply: BigInt(p.launchSupply ?? '0'), feeBps: BigInt(p.feeBps ?? '0'),
      creatorTaxBps: BigInt(p.creatorTaxBps ?? '0'), snipeTaxStartBps: BigInt(p.snipeTaxStartBps ?? '0'),
      snipeTaxSeconds: BigInt(p.snipeTaxSeconds ?? '1'), launchedAt: BigInt(p.launchedAt ?? '0'),
    }
    // The read returns the curve AS IT STANDS, not as it launched: by the time it lands the
    // creator's own buy is usually already in it. Seeding from `freshCurve` instead would
    // under-price every mark by exactly the dev buy, so the read's state is the seed and its
    // block is the watermark below which logs must not be folded again.
    const rs = (e.result as { state?: Record<string, string | boolean | number> }).state
    const seed = rs ? {
      trackedQuote: BigInt(rs.trackedQuote as string), trackedTokens: BigInt(rs.trackedTokens as string),
      quoteFeeBalance: BigInt(rs.quoteFeeBalance as string), creatorTaxBalance: BigInt(rs.creatorTaxBalance as string),
      graduated: !!rs.graduated,
    } : null
    s = onCurveParams(s, curve, params, r.exemptions ?? null, seed, Number(rs?.block ?? 0), intents, refusals)
    return { state: s, intents, refusals }
  }
  if (e.request.kind === 'balance') {
    /**
     * The wallet's own balance. Stored, and NOTHING ELSE HAPPENS.
     *
     * No intent, no halt, no gate: the drawdown rule reads booked P&L and keeps reading it, so
     * this arm cannot change a decision and the kernel id is unaffected. That is deliberate. A
     * balance is a beautiful thing to accidentally trade on and a terrible thing to actually
     * trade on: it moves when gas is burnt, when a position is held as tokens, and when money
     * is sent in or out, none of which is the bot's edge.
     *
     * A failed read leaves the previous reading in place with its old timestamp, so the card
     * ages visibly instead of blinking to unavailable on one bad RPC answer.
     */
    const raw = e.result
    const wei = typeof raw === 'string' && /^\d+$/.test(raw) ? BigInt(raw)
      : typeof raw === 'bigint' ? raw
        : null
    if (wei === null) return { state: s, intents, refusals }
    // n is null, not 1: a balance is one chain answer, not a sample of anything.
    return { state: { ...s, walletBalance: { value: wei, at: s.at, source: 'chain', n: null } }, intents, refusals }
  }
  if (e.request.kind === 'position-wallet') {
    const token = (e.request.args[0] ?? '').toLowerCase()
    const id = e.request.args[1] ?? ''
    const pos = s.positions.get(id)
    const r = e.result as { balanceWei?: string } | null
    const balance = r && typeof r.balanceWei === 'string' ? BigInt(r.balanceWei) : null

    if (pos && !pos.closed && pos.token.toLowerCase() === token) {
      if (balance === null) return { state: s, intents, refusals }

      /**
       * UNFILLED ROW: the send wrote it. The wallet is being asked whether the fill exists.
       *
       * A zero here is not proof the buy failed (the read can be a block behind the sequencer).
       * A positive balance is not a mark until the curve can price it. Confirm in place, or
       * ask; do not sell, and do not abandon on a stale zero.
       */
      if (pos.filled === false) {
        const f = s.inflight.get(id)
        const buy = f?.kind === 'buy' ? f : undefined
        if (balance === 0n) {
          const hash = firstHash(buy?.hash, pos.lastBuyHash ?? '')
          if (hash) {
            intents.push({ kind: 'read', what: 'receipt', args: [hash, pos.token, '', 'buy'] })
            return { state: s, intents, refusals }
          }
          // No hash and no tokens: nothing was sequenced that a later log could match.
          // releaseUnsignedBuys skipped this row because the send wrote it.
          s.positions.delete(pos.id)
          if (buy) s.inflight.delete(buy.intentId)
          s.risk.reserved = Math.max(0, s.risk.reserved - 1)
          releaseDeployed(s, pos.spendWei)
          refuse(s, refusals, {
            at: s.at, bucket: 'send-rejected', subject: pos.token,
            reason: 'unconfirmed buy with no hash and a zero wallet; nothing was sequenced',
          })
          return { state: s, intents, refusals }
        }
        if (buy) {
          const c = s.curves.get(buy.curve)
          if (!c) {
            intents.push({ kind: 'read', what: 'meta', args: [buy.curve, buy.token] })
            return { state: s, intents, refusals }
          }
          s = openHeldBuy(s, buy, balance, buy.sizeWei, c, intents, refusals)
          return { state: s, intents, refusals }
        }
        const c = s.curves.get(pos.curve)
        if (!c) {
          intents.push({ kind: 'read', what: 'meta', args: [pos.curve, pos.token] })
          return { state: s, intents, refusals }
        }
        pos.tokensHeld = balance
        pos.entryMarkWei = markToExit(c.params, c.working, balance)
        pos.peakMarkWei = pos.entryMarkWei
        pos.filled = true
        return { state: approve(s, pos, intents), intents, refusals }
      }

      if (balance !== 0n) {
        // The chain is the authority for what can be sold. Keep the row open and correct the
        // amount so a person can choose a separate recovery for a real remaining bag.
        pos.tokensHeld = balance
        if (pos.exitRecovery) {
          delete pos.exitRecovery
          pos.priorSellAttempts = (pos.priorSellAttempts ?? 0) + pos.attempts
          pos.attempts = 0
          pos.approval = {
            ready:false,intentId:null,hash:null,awaitingAllowance:true,retryAt:s.at+APPROVAL_READ_MS,
            failures:0,reverts:0,gasWei:0n,lastError:null,gaveUp:false,
          }
          intents.push({kind:'read',what:'allowance',args:[pos.token,pos.curve,pos.id]})
        }
        return { state: s, intents, refusals }
      }

      /**
       * ZERO TOKENS IS NOT AUTOMATICALLY AN ABANDONMENT, and reading it as one loses money.
       *
       * A sell that was sequenced and whose `CurveSell` never reached the tape leaves exactly
       * this state: the wallet holds no tokens and the ETH for them is already banked.
       * Closing the row here books NO proceeds and deletes the only record the arriving log
       * could have matched, so the wallet is right and the book is short by a whole sale --
       * the divergence rule 3 exists to prevent. Pull the receipt instead: it carries the
       * proceeds from the curve's own event and says whether the sell reverted.
       */
      const rec = pos.inflightIntentId === null ? undefined : s.inflight.get(pos.inflightIntentId)
      if ((pos.sellReceipts?.size ?? 0) > 0) {
        for (const [hash, pending] of pos.sellReceipts!) {
          pending.readAt = s.at
          intents.push({ kind: 'read', what: 'receipt', args: [hash, pos.token, pos.curve] })
        }
        return { state: s, intents, refusals }
      }
      const sellHash = rec?.kind === 'sell' && rec.hash
        ? firstHash(rec.hash, '')
        : firstHash(pos.awaitingSellReceipt, pos.lastSellHash ?? '')
      if (sellHash) {
        pos.awaitingSellReceipt = sellHash
        intents.push({ kind: 'read', what: 'receipt', args: [sellHash, pos.token, pos.curve] })
        return { state: s, intents, refusals }
      }

      if (pos.inflightIntentId !== null) {
        s.inflight.delete(pos.inflightIntentId)
        pos.inflightIntentId = null
      }
      pos.tokensHeld = 0n
      pos.closed = true
      pos.closedAt = s.at
      pos.abandonedAt = s.at
      pos.abandonReason = 'fresh chain balance was exactly zero; no sale receipt exists, so booked P&L is unchanged'
      releaseDeployed(s, pos.spendWei)
      s.risk.reserved = Math.max(0, s.risk.reserved - 1)
      refuse(s, refusals, {
        at: s.at, bucket: 'exit-abandoned', subject: pos.token,
        reason: pos.abandonReason,
      })
      return { state: s, intents, refusals }
    }

    const f = s.inflight.get(id)
    if (f?.kind === 'buy' && f.token.toLowerCase() === token) {
      if (balance === null) return { state: s, intents, refusals }

      /**
       * A ZERO BALANCE IS NOT PROOF THE BUY FAILED, and reading it as proof strands a bag.
       *
       * The buy went to the SEQUENCER and this balance came from a READ endpoint, and the two
       * are not the same clock: the read can be a block or two behind the transaction it is
       * being asked about. v1 says so where it does the same check, and reads the receipt
       * instead. Concluding here is worse than a wrong number, because `openHeldBuy` with zero
       * tokens deletes the in-flight record, and the arriving `CurveBuy` log matches on exactly
       * that record — so a real bag would become permanently invisible to the fold with real
       * tokens in the wallet and nobody managing them.
       *
       * The receipt is definitive on both counts. Its `remainingWei` is the token balance at
       * the receipt's OWN block, and its status says whether there was ever anything to hold.
       */
      if (balance === 0n && f.hash) {
        intents.push({ kind: 'read', what: 'receipt', args: [f.hash, f.token, '', 'buy'] })
        return { state: s, intents, refusals }
      }

      const c = s.curves.get(f.curve)
      if (!c) {
        // No price, no position. Opening here would book a bag at an entry mark of zero, and
        // `markPositions` would then skip it for as long as the process ran. Ask for the
        // curve and let the next wallet read open it against a real mark.
        intents.push({ kind: 'read', what: 'meta', args: [f.curve, f.token] })
        return { state: s, intents, refusals }
      }
      s = openHeldBuy(s, f, balance, f.sizeWei, c, intents, refusals)
      return { state: s, intents, refusals }
    }

    return { state: s, intents, refusals }
  }
  if (e.request.kind === 'grad-pool' || e.request.kind === 'grad-wallet') {
    return foldGradRead(s, e, intents, refusals)
  }
  if (e.request.kind === 'curve') {
    const addr = (e.request.args[0] ?? '').toLowerCase()
    const c = s.curves.get(addr)
    const r = e.result as Partial<CurveState> & { readonly block?: number }
    if (c && r && typeof r.trackedQuote !== 'undefined') {
      // A read REPLACES confirmed state and invalidates the overlay built on the old one.
      // Marking degraded is what stops a decision reading a working book that is half a
      // reseed and half a prediction.
      c.confirmed = {
        trackedQuote: BigInt(r.trackedQuote as unknown as string), trackedTokens: BigInt(r.trackedTokens as unknown as string),
        quoteFeeBalance: BigInt(r.quoteFeeBalance as unknown as string), creatorTaxBalance: BigInt(r.creatorTaxBalance as unknown as string),
        graduated: !!r.graduated,
      }
      c.confirmedThrough = Math.max(c.confirmedThrough, r.block ?? 0)
      c.pending.clear()
      c.degraded = true
      rebase(c, s.at)
    }
  }
  return { state: s, intents, refusals }
}

/** The open, graduated position holding this token, or undefined. One bag per token. */
function gradPositionFor(s: State, token: string): Position | undefined {
  const t = token.toLowerCase()
  for (const p of s.positions.values()) {
    if (!p.closed && p.venue === 'graduated' && p.grad !== null && p.token.toLowerCase() === t) return p
  }
  return undefined
}

/**
 * Note a failure against the bag and back off, without ending the attempt.
 *
 * The backoff is v1's: `retryMs * failures`, capped at `maxRetryMs`. It is driven off the
 * revert count rather than a separate counter, so the two cannot disagree about how badly
 * this exit is going.
 */
function gradSetback(g: NonNullable<Position['grad']>, at: number, why: string): void {
  g.lastError = why
  g.wallet = null   // whatever we believed about the bag, this answer came after it
  g.retryAt = at + Math.min(GRAD_MAX_RETRY_MS, GRAD_RETRY_MS * Math.max(1, g.reverts))
}

/**
 * Fold the two reads the after-graduation sell depends on.
 *
 * BOTH ARE REFUSED BY BEING IGNORED, not by a bucket, and that is deliberate: a read that did
 * not come back is not a decision about the trade, it is a missing input, and the step machine
 * simply asks again after its backoff. The buckets are reserved for the two states a person
 * has to resolve. A read that comes back CONTRADICTING the venue is different, and that one
 * does get a bucket: it means we are not holding what we think we are holding.
 */
function foldGradRead(s: State, e: Extract<Event, { kind: 'chain-read' }>, intents: Intent[], refusals: Refusal[]): Decision {
  const pos = gradPositionFor(s, e.request.args[0] ?? '')
  if (!pos || pos.grad === null) return { state: s, intents, refusals }
  const g = pos.grad

  if (e.request.kind === 'grad-pool') {
    const r = e.result as {
      ok?: boolean; reason?: string; phase?: number; ready?: boolean
      pool?: PoolKey
    } | null
    if (!r) {
      gradSetback(g, s.at, 'the factory could not be read')
      return { state: s, intents, refusals }
    }
    if (r.ok !== true) {
      // The factory does not agree this is our native-ETH holding, or the hook is not the one
      // the venue publishes. Either way the swap would be built against something we have not
      // verified, and v1 refuses to build it for the same reason.
      g.gaveUp = true
      refuse(s, refusals, {
        at: s.at, bucket: 'exit-grad-blocked', subject: pos.token,
        reason: `${r.reason ?? 'the factory does not confirm this holding'}; still holding, and it needs a person`,
      })
      return { state: s, intents, refusals }
    }
    g.phase = typeof r.phase === 'number' ? r.phase : null
    g.pool = r.pool ?? null
    g.curveReady = typeof r.ready === 'boolean' ? r.ready : null
    g.lastError = r.ready === false ? 'the curve is not ready to graduate' : null
    g.retryAt = r.ready === false ? s.at + 10_000 : s.at
    return { state: s, intents, refusals }
  }

  const r = e.result as {
    balanceWei?: string; erc20AllowanceWei?: string
    permitAmountWei?: string; permitExpiry?: number
  } | null
  if (!r || typeof r.balanceWei !== 'string') {
    gradSetback(g, s.at, 'the wallet and its allowances could not be read')
    return { state: s, intents, refusals }
  }
  g.wallet = {
    balanceWei: BigInt(r.balanceWei),
    erc20AllowanceWei: BigInt(r.erc20AllowanceWei ?? '0'),
    permitAmountWei: BigInt(r.permitAmountWei ?? '0'),
    permitExpiry: r.permitExpiry ?? 0,
    at: s.at,
  }
  if (g.wallet.balanceWei > 0n) g.emptyReads = 0
  // The bag on chain is the bag, not what the fill log said. v1 learned this on position 1438,
  // which was 0.26% over and sent 945 sells that could not have succeeded: `safeTransferFrom`
  // reverts on one wei too many and no slippage bound can help.
  pos.tokensHeld = g.wallet.balanceWei
  g.lastError = null
  g.retryAt = s.at
  return { state: s, intents, refusals }
}

/**
 * The verdict carried by a receipt event, or null when there is not one.
 *
 * MISSING AND NULL ARE THE SAME ANSWER, and telling them apart with `=== null` alone was a crash.
 * 15 of the 52 receipt events on the box's tape carry no `result` key at all: they are an OLDER
 * SHAPE, `{hash, receipt}`, written before the verdict was decoded in `io/`. `undefined === null`
 * is false, so a handler guarding only null walked straight into reading a field off `undefined` —
 * and a throw inside the fold is a refuse-to-boot in `main.ts`, so the bot would not start at all.
 * Found by `tools/replay-proof.ts` against the box's own tape on 2026-09-17, by no test.
 *
 * AN OLD-SHAPE EVENT IS READ AS NO VERDICT, deliberately, rather than decoded. Its payload is a
 * raw receipt and not a `ReceiptVerdict`, and writing a decoder for a dead shape to recover
 * evidence the fold will simply ask for again is more risk than the evidence is worth. "We asked
 * and could not get it" is already the meaning every caller below handles.
 */
const verdictOf = (e: Extract<Event, { kind: 'receipt' }>): ReceiptVerdict | null => e.result ?? null

/**
 * Fold a receipt, which on this path is the money evidence and the only thing that closes.
 *
 * A SEQUENCED TRANSACTION IS NOT AN EXECUTED ONE, and on the V4 venue there is no log the
 * subscriber watches to tell the difference, so the receipt is the whole settle. It arrives
 * already proven by `io/` (see `ReceiptVerdict`): one swap of ours, one hook fee, a matching
 * transfer, and the remaining balance at the receipt's own block.
 *
 * No verdict means the receipt could not be fetched, which is NOT a revert: the
 * transaction may not be mined yet. It backs off and asks again, exactly as v1 does.
 */
function foldReceipt(s: State, e: Extract<Event, { kind: 'receipt' }>, intents: Intent[], refusals: Refusal[]): Decision {
  const hash = normTxHash(e.hash)

  for (const p of s.positions.values()) {
    const a = p.approval
    if (p.closed || !a || a.hash !== hash) continue
    const v = verdictOf(e)
    if (v === null) return { state: s, intents, refusals }
    a.hash = null
    if (a.intentId !== null) s.inflight.delete(a.intentId)
    a.intentId = null
    a.gasWei += BigInt(v.gasWei)
    s = chargeReceiptGas(s, p, hash, BigInt(v.gasWei))
    if (!v.ok) {
      a.reverts++
      approvalBackoff(p, s.at, v.error ?? 'approval reverted on chain')
      refuse(s, refusals, { at: s.at, bucket: 'exit-unsettled', subject: p.token,
        reason: `approval reverted: ${a.lastError}; sells wait for a confirmed allowance` })
    } else {
      a.awaitingAllowance = true
      a.retryAt = s.at + APPROVAL_READ_MS
      intents.push({ kind: 'read', what: 'allowance', args: [p.token, p.curve, p.id] })
    }
    return { state: s, intents, refusals }
  }

  // A CURVE SELL'S RECEIPT, matched on the position's OWN in-flight sell rather than on the
  // curve, so a stranger selling the same coin in the same block cannot close our row.
  for (const p of s.positions.values()) {
    if (p.closed) continue
    const rec = p.inflightIntentId === null ? undefined : s.inflight.get(p.inflightIntentId)
    if (rec?.kind === 'sell' && firstHash(rec.hash, '') === hash) {
      return foldCurveSellReceipt(s, p, rec, e, intents, refusals)
    }
    if (p.sellReceipts?.has(hash) || firstHash(p.awaitingSellReceipt, '') === hash || firstHash(p.lastSellHash, '') === hash) {
      // A newer sell may already be in flight. Do not hand that record to the old receipt:
      // foldCurveSellReceipt would delete it, and a reverted first attempt would strand the
      // second.
      const leftover = rec?.kind === 'sell' && firstHash(rec.hash, '') === hash ? rec : {
        kind: 'sell' as const, intentId: `late-sell:${hash}`,
        token: p.token, curve: p.curve, reason: p.sellReceipts?.get(hash)?.reason ?? p.exitReason ?? 'time',
        raisedAt: p.openedAt, hash, nonce: -1, signedAt: 0,
      }
      return foldCurveSellReceipt(s, p, leftover, e, intents, refusals)
    }
  }

  // A SENT BUY'S RECEIPT, matched on the in-flight buy's own hash for the same reason: the
  // hash is ours, so nothing a stranger did can be mistaken for it.
  for (const f of s.inflight.values()) {
    if (f.kind !== 'buy' || firstHash(f.hash, '') !== hash) continue
    return foldBuyReceipt(s, f, e, intents, refusals)
  }

  let pos: Position | undefined
  for (const p of s.positions.values()) {
    if (!p.closed && p.grad !== null && p.grad.awaitingReceipt === hash) { pos = p; break }
  }
  if (!pos || pos.grad === null) return { state: s, intents, refusals }
  const g = pos.grad

  const v = verdictOf(e)
  if (v === null) {
    g.retryAt = s.at + GRAD_RECEIPT_GAP_MS
    return { state: s, intents, refusals }
  }
  const expectsSale = g.pendingStep === 'swap' || v.proceedsWei !== null

  /**
   * EVERY LEG OF THIS EXIT COSTS GAS, and the stop must see all of them.
   *
   * This path sends an approve, a permit, the venue transition and the swap, and it retries. The
   * reverts are the loud ones, but a successful leg is money out of the wallet too, and v1 charged
   * both: its graduation manager called `risk.burned` from `burned` AND from `prepared`. Charged
   * here, once, above every branch below, so no branch can be the one that forgets.
   */
  s = chargeReceiptGas(s, pos, hash, BigInt(v.gasWei))

  if (v.ok && expectsSale && (v.proceedsWei === null || v.remainingWei === null)) {
    // Execution is confirmed, so rebroadcasting cannot add evidence. Keep the receipt
    // until its proceeds and remaining balance are readable.
    g.pendingRaw = null
    g.lastError = 'the swap executed but its proceeds or remaining balance are not yet proved'
    g.retryAt = s.at + GRAD_RECEIPT_GAP_MS
    return { state:s, intents, refusals }
  }
  g.awaitingReceipt = null
  g.pendingStep = null
  g.pendingRaw = null
  g.pendingAt = 0

  if (!v.ok) {
    // The chain executed up to the revert and charged for it. Booking the gas here is what
    // makes the 5% ceiling mean anything, and it is the cost v1 had to add by hand after a
    // retry loop bled without showing up in the drawdown while it was bleeding.
    g.reverts++
    g.revertedGasWei += BigInt(v.gasWei)
    gradSetback(g, s.at, v.error ?? 'the transaction reverted')
    return { state: s, intents, refusals }
  }

  if (v.proceedsWei === null) {
    // A successful leg that is not the sale: an approve, a permit, or the venue transition.
    // Nothing to book, and the wallet reading is stale now by definition.
    g.wallet = null
    g.lastError = null
    g.retryAt = s.at
    return { state: s, intents, refusals }
  }

  // A swap that succeeded and left tokens behind has NOT closed the position. Treating it as
  // closed would abandon the rest of the bag, and a closed row is a row no recovery looks at.
  const remaining = v.remainingWei === null ? null : BigInt(v.remainingWei)
  if (remaining === null || remaining > 0n) {
    if (remaining !== null) {
      pos.proceedsWei += BigInt(v.proceedsWei)
      pos.tokensHeld = remaining
    }
    g.wallet = null
    g.lastError = `the swap landed but ${remaining === null ? 'the remaining balance is unknown' : `${remaining} tokens remain`}`
    g.retryAt = s.at + GRAD_RECEIPT_GAP_MS
    return { state: s, intents, refusals }
  }

  g.proven = { proceedsWei: BigInt(v.proceedsWei), hash }
  g.retryAt = s.at
  // The close itself runs through the step machine on the next tick, so there is exactly one
  // path to a closed row and it is the one the order is tested against.
  return { state: stepGraduation(s, pos, intents, refusals), intents, refusals }
}

/**
 * Settle a sent buy from its receipt. The only definitive answer to "are we holding a bag".
 *
 * WHY A RECEIPT AND NOT THE WALLET. The wallet read that got us here came from a read endpoint
 * and the buy went to the sequencer, so a zero balance can be a real bag that the read has not
 * caught up with. This carries `remainingWei`, which `io/` read AT THE RECEIPT'S OWN BLOCK, so
 * it cannot be behind the transaction it describes.
 *
 * AND IT NAMES THE FAILURE. v1 read this receipt for one other reason: a revert with gas to
 * spare is the venue losing us a race, and burning the whole limit is our own ceiling set too
 * low. The two need different humans, and until this existed v2 reported both as "the buy
 * executed and returned zero tokens", which is the wording that hid six out-of-gas buys in v1
 * behind a comment calling them ordinary race losses.
 */
function foldBuyReceipt(
  s: State, f: Extract<Inflight, { kind: 'buy' }>, e: Extract<Event, { kind: 'receipt' }>,
  intents: Intent[], refusals: Refusal[],
): Decision {
  // Not mined as far as this node knows, which is NOT a revert. `reclaimOrphanBuys` asks the
  // wallet again on its own schedule, and that read raises this one again.
  const v = verdictOf(e)
  if (v === null) return { state: s, intents, refusals }
  const held = v.remainingWei === null ? null : BigInt(v.remainingWei)

  // A buy that reverted still paid, and an out-of-gas one paid the WHOLE ceiling. Charged against
  // the book that sent it, above every branch, for the same reason as the sell path below.
  if (!f.receiptGasCharged) {
    s = chargeGas(s, f.book, BigInt(v.gasWei))
    f.receiptGasCharged = true
  }

  if (!v.ok) {
    /**
     * Sequenced, executed, failed. There is no bag, so the slot AND the capital go back
     * together, the way `tryEnter` took them.
     *
     * The bucket stays `send-rejected` on purpose, even for out-of-gas. It is what the funnel
     * counts and what raises the crit on the first failed buy, and a new bucket would take an
     * out-of-gas buy — the most alert-worthy thing here — out of both. The CAUSE goes in the
     * reason, which is the thing that was missing.
     */
    s.inflight.delete(f.intentId)
    const unconfirmed = s.positions.get(f.intentId)
    if (unconfirmed && unconfirmed.filled === false && !unconfirmed.closed) s.positions.delete(f.intentId)
    s.risk.reserved = Math.max(0, s.risk.reserved - 1)
    releaseDeployed(s, f.sizeWei)
    refuse(s, refusals, {
      at: s.at, bucket: 'send-rejected', subject: f.token,
      reason: v.outOfGas === true
        ? `the buy burned its entire gas limit and reverted. That is OUR ceiling set too low, not the venue, and every one of them is a config bug: ${v.error ?? 'out of gas'}`
        : `the buy was sequenced as ${f.hash.slice(0, 12)} and reverted with gas to spare, which is the venue: ${v.error ?? 'no reason given'}`,
    })
    return { state: s, intents, refusals }
  }

  // It executed. An executed buy that left nothing is the zero-token case, and now it is
  // PROVEN rather than inferred from a balance that could have been reading an older block.
  if (held === null) {
    // Executed, and the balance at that block could not be read, so nothing is settled. Hold
    // the slot and the record: the wallet read will come round again.
    return { state: s, intents, refusals }
  }

  const c = s.curves.get(f.curve)
  if (!c) {
    // Same rule as the wallet path: no price, no position. Opening at an entry mark of zero
    // would leave a bag that `markPositions` skips for as long as the process runs.
    intents.push({ kind: 'read', what: 'meta', args: [f.curve, f.token] })
    return { state: s, intents, refusals }
  }
  return { state: openHeldBuy(s, f, held, f.sizeWei, c, intents, refusals), intents, refusals }
}

/** Settle a verified operator sale through the existing receipt accounting. */
function reconcileRecoverySale(
  s: State, event: Extract<Event, { kind: 'operator' }>, intents: Intent[], refusals: Refusal[],
): Decision {
  const p = s.positions.get(event.positionId ?? '')
  const proof = event.recoverySale
  if (p?.closed && proof && p.settledSellHashes?.has(normTxHash(proof.hash))) return { state: s, intents, refusals }
  const decimal = (v: unknown): v is string => typeof v === 'string' && /^\d{1,78}$/.test(v)
  const hash = proof ? normTxHash(proof.hash) : ''
  const old = proof ? normTxHash(proof.oldHash) : ''
  const tracked = p?.inflightIntentId ? s.inflight.get(p.inflightIntentId) : undefined
  const ownsOld = p && (p.sellReceipts?.has(old) || normTxHash(p.awaitingSellReceipt ?? '') === old
    || normTxHash(p.lastSellHash ?? '') === old || (tracked?.kind === 'sell' && normTxHash(tracked.hash) === old))
  const otherWork = [...s.inflight.values()].some(f => ['buy', 'sell', 'graduate'].includes(f.kind)
    && !(f.kind === 'sell' && p && f.token === p.token && f.curve === p.curve && normTxHash(f.hash) === old))
  const v = proof?.receipt
  if (!s.risk.halts.has(stoppedKey(null)) || !p || p.closed || !p.filled || p.venue !== 'curve'
    || !proof || !ownsOld || otherWork || p.proceedsWei !== 0n
    || (p.sellReceipts?.size ?? 0) > 1
    || proof.token.toLowerCase() !== p.token.toLowerCase() || proof.curve.toLowerCase() !== p.curve.toLowerCase()
    || !/^0x[0-9a-f]{64}$/.test(hash) || !/^0x[0-9a-f]{64}$/.test(old) || hash === old
    || !Number.isSafeInteger(proof.oldNonce) || !Number.isSafeInteger(proof.nonce)
    || !Number.isSafeInteger(proof.confirmedNonce) || proof.oldNonce < 0
    || proof.nonce <= proof.oldNonce || proof.confirmedNonce <= proof.nonce
    || !decimal(proof.tokensSoldWei) || BigInt(proof.tokensSoldWei) !== p.tokensHeld
    || v?.ok !== true || v.remainingWei !== '0' || !decimal(v.proceedsWei) || !decimal(v.gasWei)
    || v.error !== null) {
    refuse(s, refusals, { at: s.at, bucket: 'exit-stuck', subject: event.positionId ?? 'operator',
      reason: 'recovery settlement requires stopped entries, one owned obsolete sale, and a proved complete replacement sale' })
    return { state: s, intents, refusals }
  }
  const reason = p.sellReceipts?.get(old)?.reason ?? p.exitReason ?? 'time'
  for (const [id, f] of s.inflight) {
    if (f.kind === 'sell' && f.token === p.token && f.curve === p.curve && normTxHash(f.hash) === old) {
      s.inflight.delete(id)
      if (p.inflightIntentId === id) p.inflightIntentId = null
    }
  }
  p.sellReceipts?.delete(old)
  p.awaitingSellReceipt = hash
  p.lastSellHash = hash
  ;(p.sellReceipts ??= new Map()).set(hash, { reason, readAt: s.at })
  return foldCurveSellReceipt(s, p, {
    kind: 'sell', intentId: `operator-recovery:${hash}`, token: p.token, curve: p.curve,
    reason, raisedAt: s.at, hash, nonce: proof.nonce, signedAt: s.at,
  }, { kind: 'receipt', seq: event.seq, at: event.at, run: event.run, hash, result: v }, intents, refusals)
}

/**
 * Settle a curve sell from its receipt. The boot reconcile's only honest evidence.
 *
 * The live path closes a position from a `CurveSell` log. This closes it from the same
 * numbers pulled out of the receipt, for the case where the process died between the send
 * and the log: `io/` reads `quoteOut` off the curve's own event inside our own transaction,
 * so the proceeds are proved rather than inferred from a wallet difference that could
 * contain somebody else's trade.
 *
 * A definitive receipt consumes one attempt. Repeated reads do not charge gas or
 * book proceeds again; missing balance or proceeds keep the receipt pending.
 */
function foldCurveSellReceipt(
  s: State, pos: Position, rec: Extract<Inflight, { kind: 'sell' }>,
  e: Extract<Event, { kind: 'receipt' }>, intents: Intent[], refusals: Refusal[],
): Decision {
  // "We asked and could not get it" is not a verdict: the transaction may not be mined yet,
  // and nothing about the position has been learned. Leave it exactly as it was.
  const v = verdictOf(e)
  if (v === null) return { state: s, intents, refusals }

  const hash = normTxHash(e.hash)
  const charged = pos.chargedReceiptHashes?.has(hash) ?? false
  const alreadyFilled = pos.settledSellHashes?.has(hash) ?? false
  if (charged && (!v.ok || alreadyFilled)) return { state: s, intents, refusals }
  const tracked = s.inflight.get(rec.intentId)
  const ours = tracked?.kind === 'sell' && firstHash(tracked.hash, '') === hash
  if (ours) {
    s.inflight.delete(rec.intentId)
    if (pos.inflightIntentId === rec.intentId) pos.inflightIntentId = null
  }
  if (!charged && !alreadyFilled) pos.attempts++

  /**
   * THE GAS IS SPENT WHETHER OR NOT THE SALE WAS, so it is charged above every branch.
   *
   * The reverting branch is the one this exists for: it books no proceeds and closes no row, so
   * before 2026-09-17 a sell that reverted twenty times cost twenty transactions' worth of gas and
   * moved the drawdown stop by exactly nothing. v1's `risk.burned` was written for this failure.
   */
  s = chargeReceiptGas(s, pos, hash, BigInt(v.gasWei))
  if (alreadyFilled) return { state: s, intents, refusals }

  if (!v.ok) {
    pos.sellReceipts?.delete(hash)
    if (pos.awaitingSellReceipt === hash) pos.awaitingSellReceipt = null
    // Sequenced, executed, reverted. A zero allowance is the likeliest cause, so the
    // re-approve rides along exactly as it does on the unsettled path.
    refuse(s, refusals, {
      at: s.at, bucket: 'exit-unsettled', subject: pos.token,
      reason: `the sell reverted on chain (${v.error ?? 'no reason given'}); re-approving and waiting for its receipt before retrying`,
    })
    return { state: exhausted(pos) || pos.venue !== 'curve' ? s : approve(s, pos, intents), intents, refusals }
  }

  if (v.proceedsWei === null || v.remainingWei === null) {
    // It executed and we cannot prove what it paid. Booking a guess here would put a made-up
    // number in the ledger, so the row stays open and says so: a person decides.
    refuse(s, refusals, {
      at: s.at, bucket: 'exit-stuck', subject: pos.token,
      reason: `the sell executed but its proceeds or remaining balance are unproved (${v.error ?? 'incomplete receipt evidence'}); keeping the row open and retrying the read`,
    })
    const pending = pos.sellReceipts ??= new Map()
    pending.set(hash, { reason: rec.reason as ExitReason, readAt: s.at })
    pos.awaitingSellReceipt = hash
    return { state: s, intents, refusals }
  }

  pos.sellReceipts?.delete(hash)
  if (pos.awaitingSellReceipt === hash) pos.awaitingSellReceipt = null
  ;(pos.settledSellHashes ??= new Set()).add(hash)
  pos.proceedsWei += BigInt(v.proceedsWei)
  // A confirmed remaining balance keeps partial sales open.
  pos.tokensHeld = BigInt(v.remainingWei)
  if (pos.tokensHeld > 0n) return { state: s, intents, refusals }

  // A late successful sale of this bag makes any newer inflight sell moot.
  if (pos.inflightIntentId !== null) {
    s.inflight.delete(pos.inflightIntentId)
    pos.inflightIntentId = null
  }
  pos.exitReason = rec.reason as ExitReason
  return { state: closePosition(s, pos), intents, refusals }
}

function foldSensor(s: State, e: Extract<Event, { kind: 'sensor' }>, intents: Intent[], refusals: Refusal[]): Decision {
  const at = s.at
  const put = <T>(v: T): Sensed<T> => ({ value: v, at, source: 'gate.db', n: e.rows })
  switch (e.sensor) {
    case 'template-block': return { state: { ...s, sensors: { ...s.sensors, templateBlocked: put(e.reading as never) } }, intents, refusals }
  }
}

function foldSeed(s: State, e: Extract<Event, { kind: 'seed' }>, intents: Intent[], refusals: Refusal[]): Decision {
  // HISTORY ARRIVES AS FOLDED STATE, NOT AS REPLAYED EVENTS. The feed overlay, the arming
  // blocks and the reseeds were never recorded before the tape existed, so inventing events
  // for them would put fiction in an append-only ledger. One honest seed beats a plausible
  // reconstruction.
  switch (e.what) {
    case 'entered':
      for (const t of e.rows as readonly string[]) s.risk.everEntered.add(t.toLowerCase())
      return { state: s, intents, refusals }
    case 'template-losses':
      for (const [k, at] of e.rows as ReadonlyArray<readonly [string, number]>) s.templateLossAt.set(k, at)
      return { state: s, intents, refusals }
    case 'deployers':
      for (const [d, n] of e.rows as ReadonlyArray<readonly [string, number]>) s.registry.set(d.toLowerCase(), n)
      return { state: s, intents, refusals }
    case 'ledger': {
      for (const r of e.rows as ReadonlyArray<{ book: string; realizedWei: string; peakWei: string }>) {
        const l = bookLedger(s.risk, r.book)
        l.realizedWei = BigInt(r.realizedWei)
        l.peakWei = BigInt(r.peakWei)
      }
      // The wallet figures are the sum of the books: genesis has no separate wallet peak,
      // and inventing one from a high-water we did not record would understate drawdown.
      let realized = 0n
      let peak = 0n
      for (const l of s.risk.books.values()) {
        realized += l.realizedWei
        if (l.peakWei > peak) peak = l.peakWei
      }
      s.risk.walletRealizedWei = realized
      s.risk.walletPeakWei = peak > realized ? peak : realized
      return { state: s, intents, refusals }
    }
    case 'outcomes': {
      // HISTORY ARRIVES AS FOLDED STATE. These are the scored launches gate.db already
      // holds, so a restart is not blind for the first 20. Inventing the logs that
      // produced them would put fiction on the tape; the outcomes themselves are facts.
      for (const r of e.rows as ReadonlyArray<{
        token: string; book: string; at: number
        perBar: Readonly<Record<string, number>>; stakes: number | null; peak: number
      }>) {
        s.cohort.push({
          token: r.token.toLowerCase(), book: r.book, at: r.at,
          perBar: r.perBar, stakes: r.stakes, peak: r.peak,
        })
      }
      return { state: refreshSensors(s), intents, refusals }
    }
  }
}

function foldClock(s: State, intents: Intent[], refusals: Refusal[]): Decision {
  return markPositions(releaseArmed(s, intents, refusals), intents, refusals)
}

/**
 * How many times a missing fill is chased at the fast interval before the operator is told.
 *
 * Three, matching v1's approve retry count. A read that has failed three times across 45
 * seconds is not a blip, and the operator should hear about it rather than have the bot keep
 * asking quietly forever.
 */
export const ORPHAN_READ_TRIES = 3
/** The interval after the operator has been told. Five minutes: still trying, no longer noisy. */
export const ORPHAN_READ_SLOW_MS = 300_000

/**
 * A buy the driver never signed is not in the air. Give the slot back.
 *
 * `tryEnter` reserves before the intent leaves, and replay rebuilds that record with an
 * empty hash. Boot does not re-queue the original buy, and `reclaimOrphanBuys` will not
 * look at a record with no hash, so without this the leftover occupies a slot forever.
 * Same release as a clean send reject: nothing was sequenced, so nothing can arrive.
 *
 * `everEntered` stays. The coin already had its one shot; buying it late on a leftover
 * is a different trade than the one that was decided.
 */
function releaseUnsignedBuys(s: State, refusals: Refusal[]): void {
  for (const f of [...s.inflight.values()]) {
    if (f.kind !== 'buy') continue
    if (f.hash || f.signedAt > 0) continue
    // A send already wrote the unconfirmed row. Releasing here would free the slot
    // while tokens may still be in the air.
    if (s.positions.has(f.intentId)) continue
    s.inflight.delete(f.intentId)
    s.risk.reserved = Math.max(0, s.risk.reserved - 1)
    releaseDeployed(s, f.sizeWei)
    refuse(s, refusals, {
      at: s.at, bucket: 'send-rejected', subject: f.token,
      reason: 'decided and never signed; nothing was sequenced',
    })
  }
}

/**
 * A sent buy with no position is tokens the fold has forgotten. Ask the chain.
 *
 * The fill log is the happy path. This is the net under it: a skipped CurveBuy, a short
 * data field, a boot that threw away the fill's intents. Fifteen seconds matches the
 * unsettled-sell give-up, so a log that is merely late still wins. The read is throttled on
 * the in-flight record so a clock cannot spam it.
 *
 * IT NEVER GIVES UP AND NEVER RELEASES, and both halves are deliberate. The ETH for this
 * buy is already spent, so releasing the slot and the capital would let the wallet commit it
 * a second time; deleting the record would forget a bag that may well exist, which is the
 * exact failure this whole path was built to end. So after `ORPHAN_READ_TRIES` it says so
 * once, slows down, and keeps asking.
 */
function reclaimOrphanBuys(s: State, intents: Intent[], refusals: Refusal[]): void {
  for (const f of s.inflight.values()) {
    if (f.kind !== 'buy') continue
    if (!f.hash) continue
    const pos = s.positions.get(f.intentId)
    if (pos && !pos.closed && pos.filled !== false) continue
    if (f.signedAt <= 0 || s.at - f.signedAt < SELL_SETTLE_GIVEUP_MS) continue
    const every = f.walletReads >= ORPHAN_READ_TRIES ? ORPHAN_READ_SLOW_MS : SELL_SETTLE_GIVEUP_MS
    if (f.walletReadAt > 0 && s.at - f.walletReadAt < every) continue
    f.walletReadAt = s.at
    f.walletReads++
    // Exactly on the read that crosses the cap, so the operator is told once rather than
    // every five minutes for as long as the process runs.
    if (f.walletReads === ORPHAN_READ_TRIES) {
      refuse(s, refusals, {
        at: s.at, bucket: 'exit-stuck', subject: f.token,
        reason: `a buy was sequenced as ${f.hash.slice(0, 12)} and ${ORPHAN_READ_TRIES} wallet reads have not said whether it holds tokens; the slot stays reserved because the ETH is already spent`,
      })
    }
    intents.push({ kind: 'read', what: 'position-wallet', args: [f.token, f.intentId] })
  }
}
