/**
 * The real world, wired to the driver's `World` interface.
 *
 * EVERYTHING IMPURE IS HERE AND NOTHING ELSE IS. The clock, the tape, the signer, the
 * sender, the nonce ladder and the chain reads. There is no rule in this file: no threshold,
 * no comparison against a limit, nothing that chooses whether to trade. The driver asks and
 * this does.
 *
 * WHY IT IS AN OBJECT AND NOT A MODULE OF FUNCTIONS. So the driver's tests can pass a fake
 * one, which they do, and so nothing can reach a socket by importing a module.
 */
import { createPublicClient, decodeFunctionData, fallback, http, keccak256, zeroAddress, type Hex, type Transport } from 'viem'
import { Sender, sendUncertain, type SendResult } from './sender.js'
import { Signer } from './signer.js'
import { NonceManager } from './nonce.js'
import { buildBuy, buildSell, buildApprove, classifyFailedTx, setBaseFee } from './builder.js'
import {
  FACTORY, V4, buildGradTx, factoryGraduationAbi, graduatedProceeds, permitAbi, readyAbi,
} from './graduated.js'
import { ENDPOINTS, chainId, GAS, hasKey } from './env.js'
import { curveAbi, erc20Abi, launcherAbi, SELECTORS } from './abi.js'
import { EVENT_TOPICS, tryWord } from '../core/chain.js'
import type { ReceiptVerdict } from '../core/events.js'
import type { LaunchTransactionCache } from './launch-cache.js'
import { BackgroundReads } from './background-reads.js'
import type { ApiModeController, RecoveryContext } from './api-mode.js'

/**
 * ArbSys, and why the block number comes from it.
 *
 * `block.number` on this chain is the PARENT chain's, not this one's. Reading it instead of
 * `arbBlockNumber` gives a number that looks plausible, advances, and is wrong by a large
 * constant, which then silently disables the "have I already folded this log" guard.
 */
const ARBSYS = '0x0000000000000000000000000000000000000064' as const
const ARBSYS_BLOCK_ABI = [{ name: 'arbBlockNumber', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }] as const
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11' as const

/**
 * How long one chain read may take before it is a failed read. v1's `READ_TIMEOUT_MS`, verbatim.
 *
 * It is short because every caller of it is on a deadline: the `meta` multicall has about
 * three seconds of entry window, and everything else is queued behind it in the driver. A read
 * that has not answered in 750ms has already lost the thing it was for.
 */
const READ_TIMEOUT_MS = 750

/**
 * The curve read gets three attempts 250ms apart. v1's `readCurveRetry`, numbers and all.
 *
 * WHY A RETRY AT ALL, when the client already falls back to a second endpoint: because the
 * failure this is for is not an endpoint being down. The public RPC answers its rate limit as a
 * JSON-RPC error inside an HTTP 200, viem surfaces that as "An unknown RPC error occurred" and
 * does not retry it, and a fallback list moves on from it just as fast. v1 lost 962 launches to
 * it in 24 hours on 2026-09-05..06, 469 of them inside the entry window, while the log stream
 * kept flowing. v2 had no retry at all: `foldChainRead` drops the launch into `screen-meta` on
 * the first failure, so a rate limit lasting two seconds cost every launch inside it.
 *
 * ONLY THE CURVE READ. Every other read already has a caller that asks again on its own
 * schedule — `reclaimOrphanBuys` for a buy, the grad step machine for a receipt — and a retry
 * underneath one of those is two backoffs stacked with neither aware of the other.
 *
 * THREE TRIES IS A CEILING SET BY THE ENTRY WINDOW, not a guess. The worst case is 3 x 750ms of
 * timeout plus 2 x 250ms of wait, which stays inside the fold's own give-up for a launch whose
 * params never came (`sweepPendingLaunches`, `settleMs`), so a retry can never outlive the
 * launch it is for.
 */
const READ_TRIES = 3
const READ_RETRY_MS = 250

/**
 * Which read failures are worth another attempt. v1's `RETRYABLE_READ`, verbatim.
 *
 * Deliberately not "any error". A decode failure or a bad address fails identically three times,
 * and spending the entry window proving that is worse than refusing at once.
 */
const RETRYABLE_READ = /429|too many requests|unknown rpc error|http request failed|timeout|timed out|fetch failed|ECONNRESET/i

/** A chain read before the retry and the stopwatch are wrapped around it. */
type RawRead = (what: string, args: readonly string[]) => Promise<unknown>

/**
 * Perform a read, retrying the curve read as v1 does, and report what it actually cost.
 *
 * Separate from `world` and taking its dependencies as arguments so the retry rule can be tested
 * without a chain, a socket or a clock. The thing worth testing is which errors get a second
 * attempt and which do not, and that should not need an RPC to ask.
 */
export async function readWithStats(
  read: RawRead,
  what: string,
  args: readonly string[],
  env: {
    /** requests the spare endpoint has served so far; see `spareServed` in `make` */
    readonly spareServed: () => number
    /** whether a keyed endpoint is configured at all. With none, no read is `viaKey`. */
    readonly keyed: boolean
    readonly now?: () => number
    readonly sleep?: (ms: number) => Promise<void>
  },
): Promise<ReadOutcome> {
  const now = env.now ?? (() => Date.now())
  const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms) }))
  const startedAt = now()
  const spareBefore = env.spareServed()
  // Only the curve read retries. `curve` and `meta` are the same multicall behind one name.
  const mayRetry = what === 'meta' || what === 'curve'
  let tries = 0
  let error = ''
  for (;;) {
    tries++
    try {
      const result = await read(what, args)
      return {
        result, tries, latencyMs: now() - startedAt, error: null,
        viaKey: env.keyed && env.spareServed() === spareBefore,
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      if (!mayRetry || tries >= READ_TRIES || !RETRYABLE_READ.test(error)) break
      await sleep(READ_RETRY_MS)
    }
  }
  return {
    result: null, tries, latencyMs: now() - startedAt, error,
    viaKey: env.keyed && env.spareServed() === spareBefore,
  }
}

/**
 * How many wallets the creator pre-registered as exempt from the snipe tax, or null.
 *
 * WHY THE TRANSACTION AND NOT A GETTER. There isn't one. The count is an argument to
 * `launchAndBuy` (`snipeTaxExemptions`, an address array); the launcher keeps the addresses,
 * not the number, and `TokenLaunched` does not carry it. The calldata of the launch itself is
 * the only place it has ever existed, which is why v1 decoded it too.
 *
 * NULL IS NOT ZERO AND MUST NOT BECOME ZERO. `admits` reads a null as "unknown, count it as
 * zero and refuse", which is the safe direction: a launch we cannot judge is one we do not
 * buy. A thrown error here would be the unsafe direction, because it fails the whole meta read
 * and drops the launch into `screen-meta`, where it stops being observed as well as traded.
 * So every failure path returns null.
 */
export async function exemptCount(client: { getTransaction: (a: { hash: Hex }) => Promise<{ input?: Hex; to?: string | null }> }, tx: Hex): Promise<number | null> {
  if (!tx) return null
  try {
    const t = await client.getTransaction({ hash: tx })
    const data = t?.input ?? '0x'
    if (data.slice(0, 10).toLowerCase() !== SELECTORS.launchAndBuy) return null
    const d = decodeFunctionData({ abi: launcherAbi, data })
    // Positional, because that is what the ABI guarantees: the exemptions are the seventh
    // argument. Named access would depend on viem's decoding shape rather than the contract's.
    const exemptions = (d.args as readonly unknown[])[6]
    return Array.isArray(exemptions) ? exemptions.length : null
  } catch {
    return null
  }
}
import type { ReadOutcome, World } from '../drivers/live.js'
import type { Event } from '../core/events.js'
import type { Intent } from '../core/intents.js'

export type WorldOptions = {
  readonly apiMode?: ApiModeController
  readonly recoveryOwner?: (what: string, args: readonly string[]) => string | null
  readonly launchCache?: LaunchTransactionCache
  readonly backgroundEligible?: () => boolean
  readonly launchBlock?: (curve: string) => number | undefined
  readonly onRpc?: (route: 'public' | 'paid', method: string, purpose: string, event: 'request' | 'failure' | 'fallback', recoveryId?: string) => void
  readonly mode: 'shadow' | 'live'
  readonly record: (event: Event) => void
  readonly log: (line: string) => void
  /**
   * One request went out on the KEYED endpoint, so the meter in `io/cu.ts` can price it.
   *
   * Per request and not per read: one `meta` read is a multicall plus a `getTransaction`, and this
   * fires for each. It carries no method name on purpose — finding one means reading the request
   * body, which consumes the stream on a live trading path for a display number.
   */
  readonly onKeyedRequest?: () => void
}

export type MadeWorld = {
  readonly preemptBackground: () => void
  readonly prepareExecution: (flat?: boolean) => Promise<void>
  readonly world: World
  readonly start: () => Promise<void>
  /**
   * The signing wallet, or null when this process has no key.
   *
   * Exposed so `main.ts` can ask the chain what that wallet holds. No key means no address
   * and the process must not boot: there is no silent observe fallback.
   */
  readonly address: string | null
  /**
   * The chain id the read endpoint reports, for `assertChain` at boot.
   *
   * It asks the SAME client the signer's nonce comes from, which is the point: a check against
   * some other endpoint would pass while the one that matters disagrees.
   */
  readonly readChainId: () => Promise<number>
  /**
   * The timestamp of the read endpoint's head block, in seconds, or null if it could not be read.
   *
   * For `venueNotes` at boot. Null rather than a throw because an unreadable head is itself one of
   * the things worth printing, not a reason to stop.
   */
  readonly readHeadTimestamp: () => Promise<number | null>
  /**
   * Keep the gas bid and the nonce ladder true to the chain. v1's `housekeeping`, the two parts
   * of it that are about sending transactions.
   *
   * NEITHER OF THESE HAD A CALLER IN V2, and both were load-bearing in v1.
   *
   * The BASE FEE is a cached number that only `setBaseFee` moves, and nothing moved it, so
   * `currentMaxFee()` sat at the 0.5 gwei floor from boot to shutdown. Today that is 25x the
   * observed 0.02 gwei and nothing is wrong; the day the chain's base fee passes 0.125 gwei
   * the bid stops clearing it and every transaction this process signs becomes unsendable,
   * silently, with the book reading as a quiet market. v1 re-read `eth_gasPrice` every 30s.
   *
   * The NONCE RESYNC repairs a hole. `release` refuses to roll back a nonce that a later
   * transaction has already claimed above it (`io/nonce.ts`), and leaves the gap for the idle
   * resync to close; with no resync the gap never closes, and the ladder stays permanently one
   * ahead of the chain. It runs only when FLAT, because the chain's count is a lie about a
   * ladder with anything in flight.
   *
   * `flat` is the caller's, not ours: it is a fact about the book, and the book lives in the
   * fold. Nothing in this file may read a position.
   */
  readonly maintain: (flat: boolean) => Promise<void>
}

export function makeWorld(opts: WorldOptions): MadeWorld {
  /**
   * The keyed provider when there is one, the public endpoint when there is not.
   *
   * Every read this client makes is INSIDE THE ENTRY WINDOW: the `meta` multicall that prices a
   * launch, and the nonce. The public endpoint is rate limited and answered `Too Many Requests`
   * to exactly those multicalls on 2026-09-16, which is a refused entry every time. The poller
   * deliberately stays on public (`logs.ts` treats it as the authority and must not sit on a
   * quota); this one is the opposite case and belongs on the key.
   *
   * THE TIMEOUT AND THE RETRY COUNT ARE THE WHOLE POINT OF THIS CLIENT, and until now it had
   * neither. `http(url)` with no options is viem's defaults: a 10 SECOND timeout and THREE
   * retries with exponential backoff, so a single unreachable endpoint holds a read for the
   * better part of a minute. The driver awaits each intent in turn inside one `drain()` loop
   * (`drivers/live.ts`), and every event that arrives meanwhile sits in the queue behind it.
   * So a slow RPC did not merely lose the launch it was reading: it stalled the fills, the
   * exits and the clock ticks for every position already open. v1 never had that exposure
   * because `rpc/read.ts` pinned every read at 750ms with `retryCount: 0` and let the caller
   * own the retry, which is also what this fold does (`reclaimOrphanBuys` asks again,
   * `sweepPendingLaunches` drops a launch whose read never came).
   *
   * TWO ENDPOINTS, NOT ONE, for the same reason v1 had a `fallback` list: a keyed provider
   * that is down took every read with it, including the boot reconcile that decides whether
   * a bag exists. The key stays FIRST so the entry window keeps its quota-free path, and the
   * public endpoint is only ever reached when the key did not answer in 750ms.
   */
  const readUrl = ENDPOINTS.rpcKey || ENDPOINTS.rpc
  const spare = readUrl === ENDPOINTS.rpcPublic ? [] : [ENDPOINTS.rpcPublic]
  /**
   * How many requests the SPARE endpoint has served, so `viaKey` on the tape is measured.
   *
   * A `fallback` transport does not report which endpoint answered, and the driver hardcoded the
   * field to `false`, so every read on the tape looked as though it came off the public RPC. The
   * spare is only ever reached when the key did not answer within 750ms, so "did the spare serve
   * a request while this read ran" is the same question as "did this read fall through" — and
   * that is the direction worth knowing, because a run where `viaKey` starts reading false is a
   * run whose keyed provider is failing.
   *
   * ITS ONE AMBIGUITY, stated rather than hidden: driver reads are serialised through `drain()`,
   * but `maintain`'s gas read is not, so a fall-through belonging to that read can be attributed
   * to a driver read overlapping it. That needs the key to be failing already, and this is a
   * diagnostic field no decision reads.
   */
  let spareServed = 0
  /**
   * Metered only when a key is actually configured. With none, `readUrl` IS the public endpoint
   * and every request on it is free, so counting them would invent a bill out of nothing.
   */
  const meterKeyed = readUrl !== ENDPOINTS.rpcPublic ? opts.onKeyedRequest : undefined
  const transport = (url: string, purpose: string, signal?: AbortSignal, spareRead = false, recovery?: RecoveryContext): Transport => config => {
    const route = url === ENDPOINTS.rpcPublic ? 'public' : 'paid'
    const base = http(url, { timeout: READ_TIMEOUT_MS, retryCount: 0,
      ...(signal ? { fetchOptions: { signal } } : {}) })(config)
    return { ...base, request: async args => {
      if (route === 'paid' && opts.apiMode?.mode() === 'economy' && !recovery?.valid()) {
        throw new Error('Economy forbids paid reads without an existing obligation')
      }
      const actualPurpose = route === 'paid' && opts.apiMode?.mode() === 'economy' ? 'exit-rescue' : purpose
      try {
        opts.onRpc?.(route, args.method, actualPurpose, 'request', recovery?.id)
        if (actualPurpose === 'exit-rescue') opts.onRpc?.(route, args.method, actualPurpose, 'fallback', recovery?.id)
        if (!opts.onRpc && route === 'paid') meterKeyed?.()
      } catch { /* metering never blocks acquisition */ }
      try {
        const result = await base.request(args)
        if (recovery && result === null && ['eth_getTransactionReceipt', 'eth_getTransactionByHash'].includes(args.method)) {
          throw new Error('the recovery transaction is not visible on this endpoint')
        }
        if (spareRead) {
          spareServed++
          try { opts.onRpc?.(route, args.method, purpose, 'fallback') } catch {}
        }
        return result as never
      }
      catch (error) { try { opts.onRpc?.(route, args.method, actualPurpose, 'failure', recovery?.id) } catch {} throw error }
    } }
  }
  const createClient = (purpose: string) => createPublicClient({
    transport: fallback(
      [
        transport(readUrl, purpose),
        ...spare.map(url => transport(url, purpose, undefined, true)),
      ],
      { retryCount: 0 },
    ),
  })
  const client = createClient('execution')
  const metadataClient = createClient('metadata')
  const maintenanceClient = createClient('maintenance')
  const requestClient = (purpose: string, what: string, args: readonly string[]) => {
    if (!opts.apiMode) return purpose === 'metadata' ? metadataClient : purpose === 'maintenance' ? maintenanceClient : client
    const id = opts.recoveryOwner?.(what, args)
    const recovery = id ? { id, valid: () => opts.recoveryOwner?.(what, args) === id } : undefined
    return createPublicClient({ transport: config => {
      const free = transport(ENDPOINTS.rpcPublic, purpose, undefined, true, recovery)(config)
      const paid = readUrl === ENDPOINTS.rpcPublic ? null : transport(readUrl, purpose, undefined, false, recovery)(config)
      return { ...free, request: request => opts.apiMode!.request(
        () => free.request(request), paid ? () => paid.request(request) : null, recovery,
      ) as never }
    } })
  }
  const background = new BackgroundReads(() => !preparing && opts.backgroundEligible?.() === true)
  const publicClient = (signal: AbortSignal, purpose: string) => createPublicClient({ transport: transport(ENDPOINTS.rpcPublic, purpose, signal) })
  let preparing = false
  let maintenance = false
  let maintenanceDone: Promise<void> = Promise.resolve()
  const signer = hasKey() ? new Signer() : null
  const sender = opts.mode === 'live' ? new Sender() : null
  /**
   * The nonce ladder, seeded from the chain.
   *
   * It takes a fetcher rather than a number because a nonce read at construction is a nonce
   * that is already stale by the time anything signs. `init()` is awaited by the caller
   * before the first intent, and `resyncIfIdle` re-reads when the ladder has been quiet.
   */
  const nonce = new NonceManager(async () => {
    if (!signer) return 0
    const paid = () => requestClient('maintenance', 'nonce', []).getTransactionCount({ address: signer.address, blockTag: 'pending' })
    if (opts.apiMode?.mode() === 'economy') return paid()
    return maintenance && !preparing
      ? background.read(signal => publicClient(signal, 'maintenance').getTransactionCount({ address: signer.address, blockTag: 'pending' }), paid,
        () => opts.onRpc?.('paid', 'eth_getTransactionCount', 'maintenance', 'fallback'))
      : paid()
  })
  /**
   * The raw bytes of the last signature per intent, so `send` has something to write.
   *
   * Bounded and cleared on send: an unbounded map keyed by intent id is a slow leak, and
   * this repo has shipped one of those before. It holds at most the in-flight set, which is
   * capped by `risk.maxConcurrent`.
   */
  const lastSigned = new Map<string, string>()

  const sendSigned = async (raw: Hex, what: string, args: readonly string[]): Promise<SendResult> => {
    const result = await sender!.send(raw)
    if (result.ok || opts.apiMode?.mode() !== 'economy' || !opts.recoveryOwner?.(what, args)) return result
    if (!/transport|timeout|timed out|fetch|http (?:429|5\d\d)|unparseable/i.test(result.error)) return result
    try {
      const hash = await requestClient('execution', what, args).sendRawTransaction({ serializedTransaction: raw })
      if (hash.toLowerCase() !== keccak256(raw).toLowerCase()) throw new Error('broadcast returned a different transaction hash')
      return { ok: true, hash, ms: result.ms, via: 'recovery-rpc' }
    } catch (error) {
      const message = String((error as Error).message ?? error)
      return { ...result, nonceConsumed: result.nonceConsumed || /nonce too low/i.test(message),
        error: `${result.error}; recovery: ${message.replace(/(?:https?|wss?):\/\/\S+/gi, '[RPC]').slice(0, 160)}` }
    }
  }

  /** So `maintain` can say a forced resync happened on the edge, not once a minute forever. */
  let lastForcedResyncs = 0

  const gasFor = (kind: Intent['kind']): bigint =>
    kind === 'buy' ? GAS.limits.buy : kind === 'sell' ? GAS.limits.sell : GAS.limits.approve

  /**
   * Everything the driver needs except the read's stopwatch, which `world` wraps around it below.
   *
   * Typed as `World` minus `read` so every other member keeps its contextual types; an untyped
   * object literal here would silently give `releaseNonce` and friends implicit `any` parameters.
   */
  const io: Omit<World, 'read'> & { read: RawRead } = {
    now: () => Date.now(),
    record: opts.record,
    log: opts.log,
    later: (ms, fn) => { const t = setTimeout(fn, ms); t.unref?.() },

    reserveNonce: () => nonce.reserve(),
    /**
     * `rejected` when the sequencer refused, plain `release` when nobody did.
     *
     * The difference is the force-resync inside `rejected`: "nonce too high" means the chain's
     * count is BELOW ours, so re-reading it is safe even with sends in flight, and it is the
     * only repair for a counter that has walked ahead. v1 called `rejected` on all four of its
     * refusal paths and v2 called it on none, which made `NonceManager.rejected` dead code and
     * left the 2026-09-05 runaway unguarded here.
     */
    releaseNonce: (n, error) => { if (error === undefined) nonce.release(n); else nonce.rejected(n, error) },
    settleNonce: () => nonce.settle(),

    /**
     * One multicall per curve read, the same shape the old bot used.
     *
     * The params and the state come back together deliberately: two round trips would let
     * the curve move between them, and a decision built from a params read at block N and a
     * state read at block N+1 is a decision about a curve that never existed.
     */
    /**
     * The curve, in ONE multicall. Ported from v1/src/recovery.ts readCurve.
     *
     * One round trip deliberately: two would let the curve move between them, and a
     * decision built from params at block N and state at block N+1 is a decision about a
     * curve that never existed.
     *
     * `arbBlockNumber` rides the SAME batch. It is what tells the fold which logs the read
     * already contains, and a read that came back without it reads as block 0, which
     * disables the double-count guard entirely. That is why it is in the contract list
     * rather than a second call.
     */
    read: async (what, args) => {
      const client = requestClient('execution', what, args)
      const metadataClient = requestClient('metadata', what, args)
      if (what === 'position-wallet') {
        const token = (args[0] ?? '') as Hex
        if (!token || !signer) return null
        const balance = await client.readContract({
          address: token, abi: erc20Abi, functionName: 'balanceOf', args: [signer.address],
        })
        return { balanceWei: String(balance) }
      }
      if (what === 'grad-pool') {
        const token = (args[0] ?? '') as Hex
        const curve = (args[1] ?? '') as Hex
        if (!token) return { ok: false, reason: 'no token' }
        const contracts = [
          { address: FACTORY, abi: factoryGraduationAbi, functionName: 'getLaunchedToken', args: [token] },
          { address: FACTORY, abi: factoryGraduationAbi, functionName: 'memeHook' },
          ...(curve ? [{ address: curve, abi: readyAbi, functionName: 'readyToGraduate' }] : []),
        ]
        const batch = await client.multicall({
          contracts: contracts as never,
          allowFailure: false,
          multicallAddress: MULTICALL3,
        }) as unknown as [
          {
            token: Hex; curve: Hex; pairToken: Hex; poolFee: number; tickSpacing: number
            phase: number; exists: boolean
          },
          Hex,
          boolean?,
        ]
        const [info, hook, ready] = batch
        if (!info.exists || info.token.toLowerCase() !== token.toLowerCase()
          || (curve && info.curve.toLowerCase() !== curve.toLowerCase())
          || info.pairToken.toLowerCase() !== zeroAddress) {
          return { ok: false, reason: 'the factory does not confirm this native ETH holding' }
        }
        if (hook.toLowerCase() !== V4.hook.toLowerCase()) {
          return { ok: false, reason: 'unverified graduation hook' }
        }
        return {
          ok: true,
          phase: Number(info.phase),
          ready: typeof ready === 'boolean' ? ready : null,
          pool: {
            currency0: zeroAddress,
            currency1: info.token.toLowerCase(),
            fee: Number(info.poolFee),
            tickSpacing: Number(info.tickSpacing),
            hooks: hook.toLowerCase(),
          },
        }
      }
      if (what === 'grad-wallet') {
        const token = (args[0] ?? '') as Hex
        if (!token || !signer) return null
        const [balance, allowance, permission] = await client.multicall({
          contracts: [
            { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [signer.address] },
            { address: token, abi: erc20Abi, functionName: 'allowance', args: [signer.address, V4.permit2] },
            { address: V4.permit2, abi: permitAbi, functionName: 'allowance', args: [signer.address, token, V4.router] },
          ] as never,
          allowFailure: false,
          multicallAddress: MULTICALL3,
        }) as unknown as [bigint, bigint, readonly [bigint, number, number]]
        return {
          balanceWei: String(balance),
          erc20AllowanceWei: String(allowance),
          permitAmountWei: String(permission[0]),
          permitExpiry: Number(permission[1]),
        }
      }
      if (what === 'allowance') {
        if (!signer) return null
        const allowance = await client.readContract({
          address: args[0] as Hex, abi: erc20Abi, functionName: 'allowance',
          args: [signer.address, args[1] as Hex],
        })
        return { allowanceWei: String(allowance) }
      }
      if (what === 'receipt') {
        const hash = (args[0] ?? '') as Hex
        const token = (args[1] ?? '') as Hex
        /**
         * Which leg this receipt belongs to, so a failure can be blamed correctly.
         *
         * It exists only to pick the gas limit `classifyFailedTx` measures against, and to let
         * a BUY skip the sale proof below. Empty is every caller that came before it and keeps
         * their exact behaviour.
         */
        const leg = args[3] ?? ''
        if (!hash) return null
        let raw
        try { raw = await client.getTransactionReceipt({ hash }) } catch { return null }
        const gasWei = String(BigInt(raw.gasUsed) * BigInt(raw.effectiveGasPrice ?? 0n))
        const ok = raw.status === 'success'
        let remainingWei: string | null = null
        if (signer && token && leg !== 'approve') {
          try {
            remainingWei = String(await client.readContract({
              address: token, abi: erc20Abi, functionName: 'balanceOf', args: [signer.address],
              blockNumber: raw.blockNumber,
            }))
          } catch { remainingWei = null }
        }
        if (!ok) {
          const limit = leg === 'buy' ? GAS.limits.buy : leg === 'approve' ? GAS.limits.approve : GAS.limits.sell
          const outOfGas = classifyFailedTx(BigInt(raw.gasUsed), limit) === 'out-of-gas'
          return {
            ok: false, gasWei, proceedsWei: null, remainingWei, outOfGas,
            error: outOfGas
              ? `the transaction burned its whole ${limit} gas limit, which is our ceiling set too low and not the venue`
              : 'the transaction reverted',
          } satisfies ReceiptVerdict
        }
        /**
         * A BUY IS ASKED FOR NOTHING BUT THE FACTS, and must not fall into either proof below.
         *
         * `graduatedProceeds` hunts a pool swap of ours and a buy has none, so it would answer
         * with an error about a sale that was never attempted. What the fold actually wants from
         * a landed buy is `remainingWei`: the token balance at the RECEIPT'S OWN BLOCK, which is
         * the only definitive answer to "did this buy leave us holding anything".
         */
        if (leg === 'buy' || leg === 'approve') {
          return { ok: true, gasWei, proceedsWei: null, remainingWei, outOfGas: false, error: null } satisfies ReceiptVerdict
        }
        /**
         * A CURVE SELL PROVES ITSELF FROM `CurveSell`, never from the V4 proof below.
         *
         * `graduatedProceeds` hunts for a pool swap of ours and there is none in a curve
         * sale, so it answers null or throws, and the boot reconcile would then have no
         * evidence for a sale that plainly happened. The curve emits `quoteOut` itself, and
         * every log inside OUR transaction at OUR curve is ours, so no recipient matching is
         * needed: the transaction hash already did it.
         */
        const curve = (args[2] ?? '').toLowerCase()
        if (curve) {
          for (const log of raw.logs) {
            if ((log.address ?? '').toLowerCase() !== curve) continue
            if ((log.topics?.[0] ?? '').toLowerCase() !== EVENT_TOPICS.CurveSell) continue
            const quoteOut = tryWord(log.data, 1)
            if (quoteOut === null) continue
            return { ok: true, gasWei, proceedsWei: String(quoteOut), remainingWei, error: null } satisfies ReceiptVerdict
          }
          return {
            ok: true, gasWei, proceedsWei: null, remainingWei,
            error: 'the transaction executed and emitted no CurveSell at this curve',
          } satisfies ReceiptVerdict
        }
        let proceedsWei: string | null = null
        let error: string | null = null
        if (signer && token) {
          try {
            const [info, hook] = await client.multicall({
              contracts: [
                { address: FACTORY, abi: factoryGraduationAbi, functionName: 'getLaunchedToken', args: [token] },
                { address: FACTORY, abi: factoryGraduationAbi, functionName: 'memeHook' },
              ] as never,
              allowFailure: false,
              multicallAddress: MULTICALL3,
            }) as unknown as [{ token: Hex; poolFee: number; tickSpacing: number }, Hex]
            proceedsWei = String(graduatedProceeds(raw.logs, {
              currency0: zeroAddress, currency1: info.token.toLowerCase(),
              fee: Number(info.poolFee), tickSpacing: Number(info.tickSpacing), hooks: hook.toLowerCase(),
            }, signer.address))
          } catch (e) {
            error = e instanceof Error ? e.message : String(e)
          }
        }
        return { ok: true, gasWei, proceedsWei, remainingWei, error } satisfies ReceiptVerdict
      }
      if (what === 'balance') {
        /**
         * What the wallet holds, as a decimal string.
         *
         * A string, not a bigint, because the result goes on the tape and the tape is JSON: a
         * bigint would throw on serialise, and a number would silently lose the low wei of any
         * balance past 0.009 ETH. Every other wei figure on the tape is a decimal string for
         * the same reason.
         */
        const addr = (args[0] ?? '') as Hex
        if (!addr) return null
        return String(await client.getBalance({ address: addr }))
      }
      if (what !== 'meta' && what !== 'curve') return null
      const curve = args[0] as Hex
      const launchTx = (args[2] ?? '') as Hex
      const readMeta = async (readClient: Pick<typeof client, 'multicall' | 'getTransaction'>, publicRoute = false) => {
      const fields = ['phantomQuote', 'reservedTokens', 'launchSupply', 'feeBps', 'creatorTaxBps', 'snipeTaxStartBps', 'snipeTaxSeconds', 'launchedAt', 'trackedQuote', 'trackedTokens', 'quoteFeeBalance', 'creatorTaxBalance', 'graduated'] as const
      // Both halves in flight together: the exempt count must not add a round trip to the
      // entry window, and the two answers are about different things (the curve now, the
      // launch as it was) so they cannot disagree with each other by arriving apart.
      const [res, exemptions] = await Promise.all([
        readClient.multicall({
          contracts: [
            ...fields.map((f) => ({ address: curve, abi: curveAbi, functionName: f })),
            { address: ARBSYS, abi: ARBSYS_BLOCK_ABI, functionName: 'arbBlockNumber' },
          ] as never,
          multicallAddress: MULTICALL3,
          allowFailure: false,
        }) as Promise<unknown[]>,
        launchTx && opts.launchCache
          ? opts.launchCache.exemptions(launchTx, () => readClient.getTransaction({ hash: launchTx }), publicRoute ? 'public' : 'paid')
          : exemptCount(readClient, launchTx),
      ])
      if (publicRoute && launchTx && exemptions === null) throw new Error('public launch calldata unavailable')
      const minimum = opts.launchBlock?.(curve)
      if (minimum !== undefined && (!Number.isSafeInteger(Number(res[13])) || Number(res[13]) < minimum)) throw new Error('metadata seed predates the launch block')
      const v = (i: number) => String(res[i])
      return {
        params: {
          phantomQuote: v(0), reservedTokens: v(1), launchSupply: v(2), feeBps: v(3),
          creatorTaxBps: v(4), snipeTaxStartBps: v(5), snipeTaxSeconds: v(6), launchedAt: v(7),
        },
        state: {
          trackedQuote: v(8), trackedTokens: v(9), quoteFeeBalance: v(10),
          creatorTaxBalance: v(11), graduated: !!res[12], block: Number(res[13] ?? 0),
        },
        exemptions,
      }
      }
      if (opts.apiMode?.mode() === 'economy') return readMeta(what === 'meta' ? metadataClient : client, true)
      return what === 'meta'
        ? background.read(signal => readMeta(publicClient(signal, 'observation'), true), () => readMeta(metadataClient),
          () => opts.onRpc?.('paid', 'eth_call', 'observation', 'fallback'))
        : readMeta(client)
    },

    sign: async (intent, n) => {
      if (!signer) throw new Error(`no signer: mode is ${opts.mode}${hasKey() ? '' : ' and no key is configured'}`)
      if (intent.kind !== 'buy' && intent.kind !== 'sell' && intent.kind !== 'approve' && intent.kind !== 'grad') {
        throw new Error(`${intent.kind} is not signable`)
      }
      const tx = intent.kind === 'grad'
        ? buildGradTx({
            step: intent.step, token: intent.token as Hex, pool: intent.pool,
            amountWei: intent.amountWei, deadline: intent.deadline, nonce: n,
          })
        : intent.kind === 'buy' ? buildBuy({ curve: intent.curve as Hex, quoteIn: intent.sizeWei, minTokensOut: intent.minTokensOut, recipient: signer.address, nonce: n, chainId: chainId() })
        : intent.kind === 'sell' ? buildSell({ curve: intent.curve as Hex, tokensIn: intent.tokensIn, minQuoteOut: intent.minQuoteOut, recipient: signer.address, nonce: n, chainId: chainId() })
        : buildApprove({ token: intent.token as Hex, spender: intent.curve as Hex, nonce: n, chainId: chainId() })
      if (intent.kind === 'grad') {
        // v1's pre-send eth_call: a doomed swap must not burn a nonce. A throw here is a
        // sign failure, which the driver releases without counting against the budget.
        await requestClient('execution', 'exit-sign', [intent.token]).call({ account: signer.address, to: tx.to, data: tx.data, gas: tx.gas })
      }
      if (intent.kind !== 'grad') void gasFor(intent.kind)
      const s = await signer.sign(tx)
      lastSigned.set(intent.intentId, s.raw)
      if (lastSigned.size > 64) { const oldest = lastSigned.keys().next(); if (!oldest.done) lastSigned.delete(oldest.value) }
      return { hash: s.hash, raw: s.raw }
    },

    /**
     * Send the signed bytes. The driver hands the raw transaction it just signed.
     *
     * `uncertain` is the rule that matters: a transport failure or a "nonce too low" may
     * describe our OWN transaction landing, and only the balance can decide. Treating those
     * as clean failures would discard a position that really exists, leaving real tokens
     * with nobody managing them.
     */
    send: async (intent, _n) => {
      if (!sender) throw new Error(`no sender: mode is ${opts.mode}`)
      // Narrowed, not asserted: only the four signable kinds ever reach here, and a cast
      // would be the one place this path stopped being checked by the compiler.
      if (intent.kind !== 'buy' && intent.kind !== 'sell' && intent.kind !== 'approve' && intent.kind !== 'grad') {
        return { ok: false, hash: '', nonceConsumed: false, uncertain: false, error: `${intent.kind} is not a sendable intent` }
      }
      const raw = lastSigned.get(intent.intentId)
      if (!raw) return { ok: false, hash: '', nonceConsumed: false, uncertain: false, error: 'nothing signed for this intent' }
      const r = await sendSigned(raw as Hex, intent.kind === 'buy' ? 'entry-send' : 'exit-sign', [intent.token])
      return r.ok
        ? { ok: true, hash: r.hash, nonceConsumed: true, uncertain: false, error: null }
        : { ok: false, hash: '', nonceConsumed: r.nonceConsumed, uncertain: r.nonceConsumed && sendUncertain(r), error: r.error }
    },

    broadcast: async (raw) => {
      if (!sender) throw new Error(`no sender: mode is ${opts.mode}`)
      const r = await sendSigned(raw as Hex, 'receipt', [keccak256(raw as Hex)])
      return r.ok
        ? { ok: true, hash: r.hash, nonceConsumed: true, uncertain: false, error: null }
        : { ok: false, hash: '', nonceConsumed: r.nonceConsumed, uncertain: r.nonceConsumed && sendUncertain(r), error: r.error }
    },
  }

  /**
   * The driver's world: `io` with the curve read's retry and the stopwatch wrapped around `read`.
   *
   * Wrapped here rather than inside each branch of `io.read` so there is exactly one place that
   * decides what a read costs and whether it is worth a second attempt.
   */
  const world: World = {
    ...io,
    read: (what, args) => readWithStats(io.read, what, args, {
      spareServed: () => spareServed,
      keyed: !!ENDPOINTS.rpcKey,
    }),
  }

  return {
    preemptBackground: () => background.preempt(),
    prepareExecution: async (flat = true) => {
      background.preempt(); preparing = true
      try {
        await maintenanceDone
        const gas = await requestClient('maintenance', 'prepare', []).getGasPrice()
        if (signer && flat) { await nonce.waitForResync(); await nonce.forceResync() }
        setBaseFee(gas)
      } finally { preparing = false }
    },
    world,
    start: async () => {
      await nonce.init()
      if (sender) await sender.start()
    },
    address: signer ? signer.address : null,
    readChainId: () => requestClient('execution', 'startup', []).getChainId(),
    readHeadTimestamp: async () => {
      // Null rather than a throw: this is a boot warning, and a failed read is itself the note.
      try { return Number((await requestClient('execution', 'startup', []).getBlock()).timestamp) } catch { return null }
    },
    maintain: async (flat) => {
      // Each half is caught on its own: a failing gas read must not skip the nonce repair, and
      // the 2026-09-05 runaway happened UNDER an RPC storm, which is exactly when it would.
      if (preparing || maintenance) return
      maintenance = true
      let finished!: () => void
      maintenanceDone = new Promise<void>(resolve => { finished = resolve })
      try {
        try { setBaseFee(opts.apiMode?.mode() === 'economy'
          ? await requestClient('maintenance', 'exit-gas', []).getGasPrice()
          : await background.read(signal => publicClient(signal, 'maintenance').getGasPrice(), () => maintenanceClient.getGasPrice(),
            () => opts.onRpc?.('paid', 'eth_gasPrice', 'maintenance', 'fallback'))) } catch { /* cached bid stands */ }
        if (signer && flat) await nonce.resyncIfIdle().catch(() => false)
      } finally { maintenance = false; finished() }
      // A forced resync is the chain telling us the counter was wrong, and v1's note on it says
      // that is worth saying out loud even when the repair worked. Edge-triggered, so a quiet
      // ladder says nothing.
      const forced = nonce.resyncs1h()
      if (forced !== lastForcedResyncs) {
        lastForcedResyncs = forced
        if (forced > 0) opts.log(`nonce: ${forced} forced resync(s) in the last hour; the counter had walked ahead of the chain`)
      }
    },
  }
}

/** Exposed so a caller that needs the raw types has them from one place. */
export { Sender, Signer, NonceManager, sendUncertain }
