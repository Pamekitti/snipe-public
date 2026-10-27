import { selectSharedTarget } from './simulation/selector.js'
import { scenarioRecovery } from './simulation/recovery.js'
import { SimulationService } from './simulation/service.js'
import { dirname } from 'node:path'
import { diskFree, memTotal, rssOf, resourceLevel, resourceDetail, type ResourceReading } from './telemetry/resources.js'
import { ScenarioController } from './simulation/scenario-controller.js'
import { digest as simulationDigest } from './simulation/store.js'
import { SELECTED_GUARD } from './strategy/scenario-guard.js'
import { FRESH_POLICY } from './strategy/fresh-policy.js'
/**
 * The bot. Wires the feed and logs streams into local curve state, schedules entries on
 * the snipe-tax clock, and runs exits off local state with no RPC in the decision path.
 *
 * Shadow and live are the same code. The only difference is whether the signed bytes
 * reach a socket, which is decided in the signer.
 */
import { createPublicClient, http, type Hex, type PublicClient } from 'viem'
import { EventEmitter } from 'node:events'
import { robinhoodChain, ADDRESSES, STRATEGY, RISK, GAS, ENDPOINTS, RPC_URLS, WINNERS, LIVE } from './config.js'
import { erc20Abi, EVENT_TOPICS, SELECTORS, logWord } from './abi.js'
import { FeedClient } from './feed/client.js'
import { LogsSubscriber, type RawLog } from './logs/subscriber.js'
import { StateEngine } from './state/engine.js'
import { type CurveParams, type CurveState, simBuy, entryPrice, midPrice, freshCurve, readyToGraduate } from './state/curve.js'
import { parseTokenLaunched, screenLaunch, screenCurve, parseLaunchCalldata, inBook, type LaunchInfo, type LaunchMeta, entryArmTs, inEntryWindow, entryWindowHours } from './strategy/launch.js'
import { deployers } from './strategy/deployers.js'
import { currentExitRules, evaluate, minQuoteOutFor, newPosition, shouldRetry, type Position, type ExitReason } from './strategy/exit.js'
import { config as liveConfig, type ReloadResult } from './config/store.js'
import { pickEntry, templateKey, liveEntryConfig } from './strategy/entry.js'
import { ShadowService } from './strategy/shadow-service.js'
import type { ShadowIntent } from './strategy/shadow-account.js'
import { RiskManager } from './strategy/risk.js'
import { RegimeGate, gateAction, venueAction, type GateReading, type VenueReading, type BookFloors } from './strategy/gate.js'
import { operatorState } from './telemetry/operator-state.js'
import { buildIdentity } from './telemetry/build.js'
import { PriceFeed } from './telemetry/price.js'
import { brokenGap } from './strategy/broken.js'
import { takeProfitFor, coldestTakeProfit, adaptiveTakeProfit, barKey, type BarOutcomes } from './strategy/takeprofit.js'
import { Cohort, touchedBar } from './strategy/cohort.js'
import { NonceManager } from './tx/nonce.js'
import { Signer } from './tx/signer.js'
import { Sender, sendUncertain, type SendResult } from './tx/sender.js'
import { buildBuy, buildApprove, buildSell, setBaseFee, gasSpentEth, classifyFailedTx } from './tx/builder.js'
import { Telemetry, NON_TRADE_SQL } from './telemetry/db.js'
import { TruthKeeper } from './telemetry/truth.js'
import { recordApproval, rejectApproval } from './telemetry/approvals.js'
import { ddResumeBudget } from './telemetry/epoch.js'
import { readHalts, writeHalts } from './telemetry/halts.js'
import { paperHealth } from './telemetry/paper-health.js'
import { TapeRecorder } from './tape.js'
import { readCurve, readCurveRetry } from './recovery.js'
import { GraduationExit, graduationClient } from './graduation.js'
import { graduatedTx } from './tx/graduated.js'
import { ReadBudget, CU, type CuMethod } from './rpc/budget.js'
import { readClient, READ_TIMEOUT_MS } from './rpc/read.js'

/**
 * How long a SOCKET launch waits for the public rpc to serve its block: 10 x 250ms = 2.5s,
 * against a measured 0.85s p50 / 1.3s p90 and no case over 6s (research/wsgap.ts,
 * 2026-09-06). The entry arms at launch + 2s, so most of these land before it.
 */
const WS_READ = { tries: 10, delayMs: 250, any: true } as const

/** how long to wait for proof a buy executed before asking the chain directly */
const LAUNCHER = ADDRESSES.launcher.toLowerCase()
/** when to ask the chain whether the book we are trading on is right (after a fill) */
const BOOK_CHECK_AT_MS = [5_000, 20_000] as const
const FILL_TIMEOUT_MS = 4_000
/** how long a zero balance may be argued with by the receipt before we believe it */
const RECONCILE_GRACE_MS = 60_000

/**
 * How long a launch is watched for the cohort verdict.
 *
 * STRATEGY.gate.holdMs, NOT maxHoldMs. Same argument as gate.touchMultiple: a regime
 * detector is a fixed yardstick or its own history stops being comparable. Shortening the
 * exit clock from 45s to 30s would otherwise shorten the window every historical touch
 * rate was measured over, re-gating the bot against openAt 25 / shutAt 10 with nobody
 * touching a gate setting. gatewatch.py derives its HOLD from the same published key.
 */
const OBSERVE_MS = STRATEGY.gate.holdMs
/** how long to wait for a sell's event before pulling its receipt */
const SELL_CONFIRM_MS = 3_000
/** a sell we cannot find at all: assume it never landed and try again */
const SELL_GIVEUP_MS = 15_000

/**
 * How often the cold-path diagnosis may ask the chain WHY a sell keeps reverting.
 *
 * The retry ladder answers a slippage revert and nothing else, so before 2026-08-26 two
 * positions retried a permanently impossible exit 33,804 times between them: 749 had a
 * zero allowance (its approve was lost to a transport blip and nothing re-checked it) and
 * 893's curve had graduated. Both are diagnosable in one multicall. Throttled because the
 * answer changes on the scale of minutes, and because an RPC call must never ride the
 * retry loop's own cadence.
 */
const SELL_DIAGNOSE_MS = 30_000

/** backoff between approve send retries, multiplied by the attempt number */
const APPROVE_RETRY_MS = 250

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * What the chain says about a sequenced buy.
 *
 * `pending` (no receipt yet) and `failed` are deliberately different: the first must not
 * close the row, because the tokens may still be ours. Within `failed`, `cause: null` means
 * no receipt arrived inside the grace window, which is not the same claim as a receipt that
 * says it reverted, and neither is the same as out-of-gas.
 */
type BuyVerdict =
  | { kind: 'landed' }
  | { kind: 'pending' }
  | { kind: 'failed'; cause: 'out-of-gas' | 'reverted' | null; gasUsed?: bigint }

export type BotOptions = {
  /** observe: watch and score, never sign. shadow: full path, no broadcast. live: real. */
  mode: 'observe' | 'shadow' | 'live'
  requireDevBuy?: boolean
  dbFile?: string
}

export class Bot extends EventEmitter {
  readonly feed = new FeedClient()
  readonly logs: LogsSubscriber
  readonly state = new StateEngine()
  readonly tel: Telemetry
  readonly risk: RiskManager
  // Provider first for receipts and recovery, with bounded public fallback.
  // Wide accounting log searches keep their public route.
  private client = readClient(undefined, { batchWait: 4, publicLogs: true,
    onProviderRequest: method => this.countProviderRequest(method),
    onSharedReceipt: () => { this.sharedReceiptReads++ } })
  sharedReceiptReads = 0
  /**
   * The provider key over HTTP, for the two per-launch reads inside the entry window only
   * (readVia). It already has the block a socket launch came from, and it does not refuse
   * under the load that makes the public rpc answer 429. Launch-level retries and
   * fallback remain in readCurveVia and fetchLaunchMeta. Null without a key.
   */
  private keyClient = ENDPOINTS.rpcKey
    ? createPublicClient({ chain: robinhoodChain, transport: http(ENDPOINTS.rpcKey, { timeout: READ_TIMEOUT_MS, retryCount: 0, batch: { wait: 4 } }) })
    : null
  /**
   * How predictable the sequencer's second boundary is, measured from the feed. We send
   * the buy after OBSERVING the first frame stamped launchedAt+2, which lands the fill
   * ~2.3s after launch; a send timed to the predicted boundary would land ~0.2s earlier at
   * the same tax, but only if the prediction is tighter than the 618bps bracket below it.
   * `boundaryErrs` holds (first frame of second N+1) - (first frame of second N + 1000ms)
   * for the trailing hour; the dashboard reports its p50/p90. No policy reads it yet.
   */
  private lastFeedSecond = 0
  private lastFeedSecondAt = 0
  private boundaryErrs: number[] = []
  /** a (re)connect replays up to ~2 minutes of backlog in a burst; those are not boundaries */
  private feedWarmUntil = 0
  private noteSecondBoundary(sec: number, now: number): void {
    if (sec <= this.lastFeedSecond) return
    if (now < this.feedWarmUntil) { this.lastFeedSecond = 0; return } // re-anchor after the burst
    if (this.lastFeedSecond > 0 && sec === this.lastFeedSecond + 1) {
      this.boundaryErrs.push(now - (this.lastFeedSecondAt + 1000))
      if (this.boundaryErrs.length > 3600) this.boundaryErrs.shift()
    }
    this.lastFeedSecond = sec
    this.lastFeedSecondAt = now
  }
  /** the boundary prediction error over the trailing hour, ms */
  boundaryPrediction(): { n: number; p50: number | null; p90: number | null; absP90: number | null } {
    const a = this.boundaryErrs
    if (!a.length) return { n: 0, p50: null, p90: null, absP90: null }
    const s = [...a].sort((x, y) => x - y)
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))]!
    const abs = a.map(Math.abs).sort((x, y) => x - y)
    return { n: a.length, p50: q(0.5), p90: q(0.9), absP90: abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.9))]! }
  }
  private loopTimer: NodeJS.Timeout | null = null
  private loopExpected = 0
  private loopLags: Array<{ at: number; lag: number }> = []
  /** worst event-loop lag in the trailing minute, ms */
  /** Disk and memory as of the last housekeeping tick. Read by the dashboard, never by the trading path. */
  resources: ResourceReading | null = null
  private lastResourceLevel: string | null = null
  loopLagMaxMs(): number {
    let m = 0
    for (const l of this.loopLags) if (l.lag > m) m = l.lag
    return m
  }
  // The tier's own ceiling. The projection extrapolates the CURRENT rate over a month at
  // the window fraction, and on a busy Sunday evening (09-06 14:50 UTC) that read 28.8M:
  // socket ~23M, reads ~6M. A lower cap only moved the reads back to the public rpc, which
  // refused 8% of them, at exactly the busy hour the key exists for. Past 30M the provider
  // refuses the key and everything degrades to the poller and the public rpc, which is the
  // pre-09-06 bot: slower, not blind. The dashboard warns at 27.5M.
  readonly readBudget = new ReadBudget(
    30_000_000,
    () => (typeof this.logs?.wsCuPerMonth === 'function' ? this.logs.wsCuPerMonth() : null),
    Date.now,
    // the socket's own hours (config.ts wsHours), not a trading window. See ReadBudget.
    () => entryWindowHours(STRATEGY.wsHours) / 24,
  )
  private signer: Signer | null = null
  private sender: Sender | null = null
  private nonce: NonceManager | null = null
  private positions = new Map<string, Position>()
  simulation: SimulationService | null = null
  private scenarioController: ScenarioController | null = null
  private shadow: ShadowService | null = null
  private launchByCurve = new Map<string, LaunchInfo>()
  /** launch calldata seen in the feed, keyed by tx hash; the logs stream is ~0.5s behind it */
  private launchMetaByTx = new Map<string, LaunchMeta>()
  /**
   * The launch tx's block timestamp (== launchedAt) and the launch txs the feed saw but
   * could not parse, both keyed by hash. They let a launch be screened and recorded
   * before any paid read: the calldata is in hand ~0.5s before the log, and a tx to the
   * launcher that is not launchAndBuy is a launch through another entry point, which
   * has never been enterable and used to pay for two reads to say so.
   */
  private launchTsByTx = new Map<string, number>()
  private launchTxUnparseable = new Set<string>()
  /**
   * Entries waiting for their tax window, keyed by curve. One record per scheduled entry:
   * the feed's observed-timestamp release and the wall-clock fallback timer used to live
   * in two maps under two different keys (curve here, token there), and every release
   * path had to do the cross-key dance to clear both.
   */
  private armed = new Map<string, { launch: LaunchInfo; params: CurveParams; armAtTs: bigint; fallback: NodeJS.Timeout }>()
  /**
   * Our own live view of the cohort, so a touch verdict reaches the gate the instant the
   * hold closes instead of on gatewatch.py's next five-minute tick. gate.db stays the
   * durable record and the fallback; this never writes to it.
   */
  private readonly cohort = new Cohort()
  // GATE_DB matches telemetry/dashboard.ts, which already honours it. Without that the
  // page and the halt decision can be pointed at different files by the same harness and
  // then quietly disagree, which is the one thing a gate view may never do.
  // Built in the constructor, not here: it needs opts.dbFile, the bot.db the P&L sensor
  // joins against so it counts only the coins the book would buy (gate.ts open()).
  private readonly gate: RegimeGate
  /**
   * The ETH price, refreshed hourly off the housekeeping tick. Display only: see
   * telemetry/price.ts for why that is a property this module must not break.
   */
  readonly price = new PriceFeed(RISK.ethUsd)
  /**
   * Book launches being watched for the cohort, whether or not we bought them. Keyed by
   * curve. We watch the ones we skip too -- that is the whole point: while halted the bot
   * used to untrack everything and so had no way to learn the venue had recovered.
   */
  private observations = new Map<string, {
    // NO token quantity here on purpose. The gate measures a PRICE ratio, so nothing in
    // this record is denominated in wei, and there is no `tokens` field to tempt anyone
    // back into markWorking(curve, o.tokens) -- which is the units bug that shipped on
    // 2026-08-19 and scored every launch as a touch. See test/observation.test.ts.
    token: string
    entryMark: bigint; peak: bigint; launchedAtMs: number; until: number
  }>()
  private awaitingExit = new Map<string, { id: number; spendWei: bigint; tokens: bigint; reason: ExitReason; holdMs: number; estimatedPnl: bigint; peakMult: number }>()
  private winnerSet = new Set(WINNERS.map((w) => w.toLowerCase()))
  private exitTimer: NodeJS.Timeout | null = null
  private sweepTimer: NodeJS.Timeout | null = null
  private houseTimer: NodeJS.Timeout | null = null
  private equityTimer: NodeJS.Timeout | null = null
  truth: TruthKeeper | null = null
  stats = { launches: 0, screened: 0, entered: 0, exited: 0, rejects: new Map<string, number>() }
  /** liveness counters, read by the dashboard */
  meters = { feedBlocks: 0, feedTxs: 0, feedGaps: 0, startedAt: Date.now(), lastFeedBlock: 0, metaFromFeed: 0, metaFromRpc: 0, preScreened: 0, cohortScored: 0, keyReads: 0, keyReadFallbacks: 0 }

  constructor(private readonly opts: BotOptions) {
    super()
    this.tel = new Telemetry(opts.dbFile ?? 'data/bot.db')
    this.gate = new RegimeGate(
      process.env.GATE_DB ?? 'data/gate.db', Date.now, this.cohort, STRATEGY.gate.live, opts.dbFile ?? 'data/bot.db',
    )
    this.risk = new RiskManager(() => BigInt(Math.round(STRATEGY.bankrollEth * 1e18)))
    this.risk.restoreDdLifts(ddResumeBudget(this.tel.raw()))
    // ONE persistence site for eighteen halt and lift sites. A truthSet beside each of
    // those is how "one rule implemented many times" gets written; the object that owns
    // the halt map announces, and this is the only thing listening.
    //
    // Swallowed deliberately: a database that will not take the row must not stop the bot
    // halting. The halt is still in force in memory, and the row is a restart's problem.
    this.risk.watchHalts((halts) => {
      try { writeHalts(this.tel.raw(), halts) } catch (e) { this.tel.health('halt', false, `halt state not persisted: ${String(e)}`) }
    })
    // The websocket accelerator runs only inside WS_HOURS, which is blank (always on) in
    // the live book. It is a QUOTA control and never a trading rule: a launch arriving
    // outside these hours is entered exactly the same way, just discovered by the poller
    // instead of the socket. See config.ts wsHours for why this outlived the entry clock.
    this.logs = new LogsSubscriber(undefined, () => inEntryWindow(Math.floor(Date.now() / 1000), STRATEGY.wsHours),
      Date.now, { onProviderRequest: method => this.countProviderRequest(method) })
  }

  /**
   * The event tape, or null when TAPE_DB is unset.
   *
   * THE PATH IS THE SWITCH. No boolean: a recorder with a boolean and a path has two ways
   * to be off and they can disagree, which is the shape of every switch fault in this repo.
   * Unset means the field stays null and every `this.tape?.push(...)` below is a no-op.
   *
   * It observes and never decides. Nothing in a trading path reads it, nothing awaits it,
   * and `push` cannot throw. See tape.ts for the three rules and the scar behind each.
   */
  private tape: TapeRecorder | null = null

  /**
   * Send, with both halves on the tape. The ONE send path, so there is one place to read.
   *
   * `tx-signed` is written BEFORE the socket write, for every kind. Approvals and
   * graduations already had that contract; buys and sells did not, which is why a send that
   * timed out could leave a signed transaction nobody knew about. Universal is strictly
   * safer and it costs one push.
   *
   * `uncertain` is the buy path's own rule, not a new one: a transport failure or a "nonce
   * too low" may describe our own transaction landing, and only the balance decides.
   */
  private async tapedSend(
    txKind: 'buy' | 'sell' | 'approve' | 'graduate', intentId: string,
    signed: { hash: string; raw: string }, nonce: number,
  ): Promise<SendResult> {
    const tSigned = Date.now()
    this.tape?.push('tx-signed', { intentId, txKind, hash: signed.hash, nonce, raw: signed.raw })
    const r = await this.sender!.send(signed.raw)
    const tSent = Date.now()
    this.tape?.push('tx-send-result', {
      intentId, hash: r.ok ? r.hash : signed.hash, ok: r.ok,
      nonceConsumed: r.ok ? true : r.nonceConsumed,
      uncertain: r.ok ? false : (r.nonceConsumed && sendUncertain(r)),
      statusCode: null, error: r.ok ? null : r.error, tSigned, tSent,
    })
    return r
  }

  private countProviderRequest(method: string): void {
    if (Object.hasOwn(CU, method)) this.readBudget.spent(method as CuMethod)
  }

  private shadowConfig(): ShadowIntent['config'] {
    return { entry: liveEntryConfig(), rules: currentExitRules(), bankrollWei: String(BigInt(Math.round(STRATEGY.bankrollEth*1e18))),
      maxConcurrent: STRATEGY.maxConcurrent, maxEntryMultiple: STRATEGY.maxEntryPriceMultiple,
      targetPolicy: STRATEGY.takeProfit }
  }

  private ensureShadow(): void {
    // Paper collection must continue when another sensor controls live entries.
    if (this.opts.mode === 'observe') return
    if (!this.simulation) {
      const source = this.opts.dbFile ?? 'data/bot.db'
      this.simulation = new SimulationService(source.replace(/\.db$/, '') + '.simulation.db', source)
      this.simulation.onPublication = () => {
        if (liveConfig().venueExecutionScenarios) this.checkVenue()
      }
      this.simulation.start()
      this.simulation.capture('session-start', 'bot', { strategy: this.strategySpec(), open: this.positions.size })
    }
    if (liveConfig().venueExecutionScenarios) {
      this.shadow?.stop(); this.shadow = null
      this.scenarioController ??= new ScenarioController(this.tel.raw(), this.simulation.path + '.release.json', Date.now())
      return
    }
    if (this.shadow) { this.shadow.configure(this.shadowConfig(), Date.now()); return }
    this.shadow = new ShadowService(this.tel.raw(), this.opts.dbFile ?? 'data/bot.db', process.env.GATE_DB ?? 'data/gate.db',
      this.shadowConfig(), () => {
        if (liveConfig().venueFreshRecovery) {
          try { this.checkVenue() } catch (e) { this.risk.halt(`shadow guard failed: ${String(e)}`, 'venue') }
        }
      }, method => this.countProviderRequest(method))
    this.shadow.start()
  }

  /**
   * Bring a position we were holding when we last stopped back under management.
   * Without this a restart is indistinguishable from abandoning the bag, which is what
   * most of the losing wallets in the study were effectively doing.
   */
  async resume(r: { token: string; curve: string; tokens: bigint; allowance: bigint; positionId: number | null; spendWei: bigint; openedAt: number; graduated?: boolean }): Promise<void> {
    const swapRecovery = this.opts.mode === 'live' && (r.graduated || this.graduationManager().has(r.positionId ?? 0))
    let confirmedGraduation = !!swapRecovery
    let mark = 0n
    if (!swapRecovery) {
      const { params, state, block } = await readCurve(r.curve as Hex)
      this.state.track(r.curve, r.token, params, state, block)
      mark = this.state.markConfirmed(r.curve, r.tokens)
      confirmedGraduation = state.graduated || readyToGraduate(params, state)
    }
    const pos = newPosition({
      id: r.positionId ?? 0, token: r.token, curve: r.curve, tokens: r.tokens,
      spendWei: r.spendWei, entryMarkWei: mark || r.spendWei, openedAt: r.openedAt || Date.now(),
      buyHash: '', filled: true,
      // already past its hold, so it exits on the clock and the rung never fires. Take
      // the coldest one rather than invent a rate for a launch we did not observe.
      takeProfitMultiple: coldestTakeProfit(),
    })
    // the gas its reverted sells burned before the restart lives on the row (additive);
    // without this the strand loss and pnl_wei would forget it, and the live ledger's
    // rebuild, which reads the row, would disagree with the position in memory
    if (r.positionId) {
      const row = this.tel.raw().prepare('SELECT burned_gas_wei b,graduation_prep_gas_wei g FROM positions WHERE id=?').get(r.positionId) as { b: string | null; g: string | null } | undefined
      pos.burnedGasWei = BigInt(row?.b ?? '0')
      pos.preparationGasWei = BigInt(row?.g ?? '0')
    }
    // it is already past its hold window, so the only correct action is to leave
    pos.exiting = true
    pos.exitReason = 'time'
    this.positions.set(r.curve, pos)
    this.risk.reserve(r.token, r.spendWei)
    if (this.opts.mode === 'live' && confirmedGraduation) this.graduate(pos)
    if (this.opts.mode === 'live' && !pos.graduated && r.allowance === 0n) {
      // sell() pulls via safeTransferFrom, so without this the exit cannot even be tried
      await this.approve(r.token as Hex, r.curve as Hex)
    }
    this.tel.health('recovery', true, `resumed ${r.token.slice(0, 12)} holding ${r.tokens}`)
  }

  async start(): Promise<void> {
    // deployer track record. Refuse to trade blind: an unloaded registry makes every
    // deployer look brand new, which silently turns the filter off and puts us straight
    // back into the book that lost money on 2026-08-17.
    deployers.load()
    if (!deployers.loaded) {
      const msg = 'data/deployers.json missing or unreadable: the deployer filter would silently pass everything'
      if (this.opts.mode === 'live') throw new Error(msg)
      console.warn(`WARNING ${msg}`)
    } else {
      const seen = this.tel.raw().prepare(
        'SELECT deployer, block FROM launches WHERE block > ?',
      ).all(deployers.asOfBlock) as Array<{ deployer: string; block: number }>
      const added = deployers.seed(seen)
      console.log(`deployers ${deployers.size} known (history to block ${deployers.asOfBlock}, +${added} from earlier runs)`)
    }

    if (this.opts.mode !== 'observe') {
      this.signer = new Signer()
      this.sender = new Sender()
      this.sender.onProbe = (ms, ok) => this.tel.latency('sequencer-rtt', ms, ok)
      await this.sender.start()
      // The key first: it runs ~6 blocks ahead of the public rpc, and a resync that reads a
      // count from behind the sequencer (an approve sequenced 200ms ago not yet in it) lands
      // the counter one too low and costs the next buy. Public rpc when the key is absent
      // or fails. One read per resync, so the quota does not notice.
      this.nonce = new NonceManager(async () => {
        const args = { address: this.signer!.address, blockTag: 'pending' as const }
        if (this.keyClient) {
          try {
            this.countProviderRequest('eth_getTransactionCount')
            return Number(await this.keyClient.getTransactionCount(args))
          } catch { /* fall through */ }
        }
        return Number(await this.client.getTransactionCount(args))
      })
      await this.nonce.init()
      console.log(`wallet ${this.signer.address} nonce ${this.nonce.peek()} mode=${this.opts.mode} live=${LIVE}`)
      if (this.opts.mode === 'live' && !LIVE) throw new Error('mode=live requires LIVE=1 in the environment')

      // chain truth: balance poll, epoch baseline, chain drawdown, receipt backfill
      // viem's request() is typed against its own rpc schema; TruthKeeper only needs
      // the structural slice, so the cast is safe and keeps the module fake-able in tests
      this.truth = new TruthKeeper(this.tel.raw(), this.client as unknown as import('./telemetry/truth.js').TruthRpc, {
        onReceipt: (hash,receipt) => this.simulation?.capture('receipt',hash,{hash,receipt}),
        wallet: () => this.signer?.address ?? '',
        openCount: () => this.positions.size,
        deployedWei: () => [...this.positions.values()].reduce((a, p) => a + p.spendWei, 0n),
        onHalt: (reason) => this.risk.halt(reason, 'drawdown'),
        health: (c, ok, d) => this.tel.health(c, ok, d),
        onRealized: (realized, peak, day) => this.risk.seedLedger({ realized, peak, day }),
      })
      // Every row that exists before this process opened one belongs to a previous run.
      // checkBroken counts only rows above it: a restart is the operator's lift for that
      // halt, and recovery's own closes are not trades this bot chose to make.
      try {
        this.bootMaxId = (this.tel.raw().prepare('SELECT COALESCE(MAX(id),0) m FROM positions').get() as { m: number }).m
      } catch {}
      const seeded = this.truth.boot()
      // Publish the exit rule we are actually running, so the recon replay can never drift
      // from it. It already did once: recon.py replayed a bare 45s clock against trades the
      // bot had exited on a take profit, and reported +5 to +25pp of fake "sim beats live"
      // gap on every one of them. Anything that grades the bot must read the rule from here.
      this.truth.publishStrategy(this.strategySpec())
      if (this.opts.mode === 'live') {
        // Both ledgers from one rebuild. The epoch ledger is what the kill switch compares;
        // the day ledger is read by the page and by rollDay, which restores the stop's
        // self-lift budget. A restart is not a new day for either.
        this.risk.seedLedger(seeded)
    this.simulation?.capture('control','epoch',{resetDrawdown:true})
        this.seedTemplateLosses()
        const eth = Number(seeded.realized) / 1e18
        const dayEth = Number(seeded.day) / 1e18
        console.log(`epoch realized restored from db: ${eth.toFixed(4)} ETH ($${(eth * RISK.ethUsd).toFixed(2)})`
          + ` (today ${dayEth.toFixed(4)} ETH, stop at ${RISK.maxDrawdownEth} ETH from peak,`
          + ` ${this.truth.backlogSize()} rows awaiting receipt backfill)`)
      }
    }

    this.feed.on('block', (b) => this.onFeedBlock(b))
    this.feed.on('gap', (g: any) => {
      if (g.got > 0) this.meters.feedGaps++
      this.tape?.push('feed-gap', { expected: Number(g.expected ?? 0), got: Number(g.got ?? 0), reason: String(g.reason ?? 'sequence gap') })
      this.state.dropOverlay()
    })
    this.feed.on('status', (s) => {
      if (s.connected) this.feedWarmUntil = Date.now() + 30_000 // the replay burst is not data
      this.tape?.push('feed-status', { connected: !!s.connected, reason: String(s.reason ?? '') })
      this.tel.health('feed', s.connected, s.reason ?? '')
    })
    this.logs.on('logs', (ls) => this.onLogs(ls))
    this.logs.on('head', (tip) => this.onHead(tip))
    this.logs.on('coverage', b => this.shadow?.coverage(b.lo, b.hi, b.rows))
    this.logs.on('status', (s) => {
      this.tape?.push('logs-status', { healthy: !!s.healthy, mode: String(s.mode), reason: String(s.reason ?? '') })
      this.tel.health('logs', s.healthy, `${s.mode} ${s.reason ?? ''}`)
    })
    // the accelerator's own line: its ups and downs are not the authority's health
    this.logs.on('ws', (s) => this.tel.health('ws', s.up, s.reason ?? ''))

    // Ask the gate BEFORE the streams start, not merely before the first housekeeping
    // tick. Both are local sqlite reads that cannot block. Otherwise every restart trades
    // blind for the first launch after the streams come up no matter what the venue is
    // doing, which is worst exactly when it matters: you restart into a shut gate
    // precisely when the venue has turned. (Moved above logs.start() 2026-09-06; the 2s
    // entry delay made the window moot in practice, and now it is moot by construction.)
    this.ensureShadow()
    this.checkRegimeGate()
    if (liveConfig().venueFreshRecovery || liveConfig().venueExecutionScenarios) this.checkVenue()
    // same argument as the gate call above: without this the first launches of every
    // restart screen against the bare seed list, ignoring whatever the watcher published
    this.refreshTemplateBlocklist()

    // Before the streams, so the very first feed block and log batch are recorded rather
    // than arriving into a recorder that is not up yet.
    if (process.env.TAPE_DB) {
      this.tape = new TapeRecorder(process.env.TAPE_DB, `${Date.now().toString(36)}-${process.pid}`)
      this.tape.start()
      console.log(`tape: recording to ${process.env.TAPE_DB}`)
    }

    await this.logs.start()
    this.feed.start()
    this.exitTimer = setInterval(() => this.pumpExits(), 50)
    this.sweepTimer = setInterval(() => this.sweepIdleCurves(), 60_000)
    this.houseTimer = setInterval(() => void this.housekeeping(), 30_000)
    this.equityTimer = setInterval(() => this.sampleEquity(), 15_000)
    // event-loop lag: how late a 500ms timer fires. The feed used to drop ~100 times in
    // three days, almost all in the busy hours; if this reads high there, the process
    // itself is choking and no transport fix will help. Kept for a minute, max reported.
    this.loopExpected = Date.now() + 500
    this.loopTimer = setInterval(() => {
      const now = Date.now()
      const lag = Math.max(0, now - this.loopExpected)
      this.loopExpected = now + 500
      this.loopLags.push({ at: now, lag })
      while (this.loopLags.length && now - this.loopLags[0]!.at > 60_000) this.loopLags.shift()
    }, 500)
    this.sampleEquity()
    this.recordHaltState()
    const seeded = this.gate.hydrate(this.cohort, STRATEGY.gate.window)
    console.log(`streams up. logs=${this.logs.mode} feed=connecting`)
    // `seeded` is what the cohort ACCEPTED, not what gate.db offered, so this cannot
    // report a full ring while the ring is short (see RegimeGate.hydrate)
    console.log(`  gate: seeded ${seeded}/${STRATEGY.gate.window} from gate.db`
      + ` (hydrated, not live-scored), live scoring ${STRATEGY.gate.live ? 'DECIDING' : 'shadow (recording only)'}`)
  }

  async stop(): Promise<void> {
    if (this.loopTimer) clearInterval(this.loopTimer)
    if (this.exitTimer) clearInterval(this.exitTimer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.houseTimer) clearInterval(this.houseTimer)
    if (this.equityTimer) clearInterval(this.equityTimer)
    for (const a of this.armed.values()) clearTimeout(a.fallback)
    this.armed.clear()
    this.feed.stop()
    this.logs.stop()
    this.shadow?.stop()
    await this.simulation?.stop()
    await this.sender?.stop()
    this.gate.close()
    this.tel.close()
  }

  // ---------- ingest ----------

  private onFeedBlock(b: { block: number; timestamp: number; txs: any[] }): void {
    this.meters.feedBlocks++
    this.noteSecondBoundary(b.timestamp, Date.now())
    this.meters.feedTxs += b.txs.length
    this.meters.lastFeedBlock = b.block
    // the chain has told us what time it is; release anything whose window has opened
    if (this.armed.size) {
      const ts = BigInt(b.timestamp)
      for (const [curve, a] of this.armed) {
        if (ts < a.armAtTs) continue
        this.armed.delete(curve)
        clearTimeout(a.fallback)
        void this.enter(a.launch, a.params)
      }
    }
    // THE ROUTED SET, recorded as the loop selects it.
    //
    // Only what routing picked, never the whole block. Routing is a pure predicate over
    // fold state (is this `to` the launcher, or a curve we track), so a replay recomputes
    // the same set and can assert its own predicate agrees. Recording every transaction
    // would multiply the tape by roughly the block's width for no reproducibility gained.
    //
    // This overlay is the reason the tape exists. Every entry price and every exit mark is
    // confirmed logs PLUS these unconfirmed transactions, and until now they were recorded
    // nowhere, so no replay could reproduce a live decision. That is the real reason the
    // paper account matched none of 49 real trades.
    const routed: Array<{ hash: string; to: string; data: string }> = []
    for (const tx of b.txs) {
      if (!tx.to) continue
      const to = tx.to.toLowerCase()
      if (to === LAUNCHER) {
        routed.push({ hash: String(tx.hash).toLowerCase(), to, data: String(tx.data) })
        // the creator's whole pitch (name, socials, bundle wallets) rides in this call,
        // and it is here ~0.5s before the launch log arrives by polling
        const meta = parseLaunchCalldata(tx.data)
        const hash = tx.hash.toLowerCase()
        this.launchTsByTx.set(hash, b.timestamp)
        if (meta) this.launchMetaByTx.set(hash, meta)
        else this.launchTxUnparseable.add(hash)
        for (const c of [this.launchMetaByTx, this.launchTsByTx, this.launchTxUnparseable] as const) {
          if (c.size > 2_000) { const oldest = c.keys().next().value; if (oldest) c.delete(oldest) }
        }
        continue
      }
      const c = this.state.get(to)
      if (c) {
        const sel = tx.data.slice(0, 10)
        if (sel === SELECTORS.buy || sel === SELECTORS.sell) {
          routed.push({ hash: String(tx.hash).toLowerCase(), to, data: String(tx.data) })
          this.state.applyFeedTx(to, b.block, tx)
        }
      }
    }
    // After the loop and after applyFeedTx: recording is never allowed to sit between the
    // chain telling us something and the state folding it.
    this.tape?.push('feed-block', { block: b.block, timestamp: b.timestamp, txs: routed })
  }

  private onLogs(logs: RawLog[]): void {
    // One stamp for the batch: the poller delivered them together, and the replay only
    // ever asks which of these the bot had seen by a given moment.
    const seenAt = Date.now()
    // ONE EVENT PER BATCH, not per log. The batch boundary is load-bearing: dev-buy totals
    // are summed across the whole batch before any launch in it is dispatched, so a tape
    // that split the batch would change the screen verdict on replay.
    if (this.tape && logs.length) {
      let lo = logs[0]!.blockNumber, hi = lo
      for (const l of logs) { if (l.blockNumber < lo) lo = l.blockNumber; if (l.blockNumber > hi) hi = l.blockNumber }
      this.tape.push('logs', { logs, source: logs.some((l) => l.viaWs) ? 'ws' : 'poll', lo, hi })
    }
    for (const log of logs) this.simulation?.arrival(log.address, log.transactionHash, log.logIndex, seenAt)
    // The creator's bundled buy rides in the same transaction as the launch, so index the
    // batch by tx hash first. Reading trackedQuote instead would count every rival who got
    // in before our RPC round trip returned, which inflates the dev buy and waves through
    // launches the filter is meant to reject.
    const devBuyByTx = new Map<string, bigint>()
    for (const log of logs) {
      if (log.topics[0] !== EVENT_TOPICS.CurveBuy) continue
      const k = log.transactionHash.toLowerCase()
      if (!devBuyByTx.has(k)) devBuyByTx.set(k, logWord(log.data, 0))
    }

    for (const log of logs) {
      if (log.topics[0] === EVENT_TOPICS.TokenLaunched) {
        // A socket launch travels alone (the subscription is launches only; a receipt costs
        // 8x the monthly quota), so its dev buy is read from the launch calldata in
        // onLaunch. null says "not in this batch", which is not the same as zero.
        const dev = devBuyByTx.get(log.transactionHash.toLowerCase())
        void this.onLaunch(log, dev ?? (log.viaWs ? null : 0n))
        continue
      }
      // the subscriber marks a log seen and advances its cursor BEFORE emitting, so a throw
      // here loses every log after it in the batch for good; one bad log must not cost the rest
      try {
        this.state.applyLog(log)
        this.recordMirror(log)
        if (log.topics[0] === EVENT_TOPICS.CurveBuy) this.noteOurFill(log)
        if (log.topics[0] === EVENT_TOPICS.CurveSell) this.noteOurExit(log)
      } catch (e) {
        this.tel.health('book', false, `${log.address.slice(0, 12)} log ${log.transactionHash.slice(0, 10)} threw: ${String(e).slice(0, 80)}`)
      }
    }
  }

  /** Log every trade the two persistently profitable wallets make, for later analysis. */
  private recordMirror(log: RawLog): void {
    const t0 = log.topics[0]
    if (t0 !== EVENT_TOPICS.CurveBuy && t0 !== EVENT_TOPICS.CurveSell) return
    const actor = ('0x' + (log.topics[1] ?? '').slice(26)).toLowerCase()
    if (!this.winnerSet.has(actor)) return
    const l = this.launchByCurve.get(log.address)
    const w = (n: number) => logWord(log.data, n)
    this.tel.mirror({
      at: Date.now(), wallet: actor, curve: log.address, token: l?.token ?? '',
      side: t0 === EVENT_TOPICS.CurveBuy ? 'B' : 'S',
      quote_wei: (t0 === EVENT_TOPICS.CurveBuy ? w(0) : w(1)).toString(),
      tokens: (t0 === EVENT_TOPICS.CurveBuy ? w(1) : w(0)).toString(),
      block: log.blockNumber,
      elapsed_ms: l ? (log.blockNumber - l.block) * 100 : -1,
      we_traded: this.risk.hasEntered(l?.token ?? '') ? 1 : 0,
    })
  }

  // ---------- entry ----------

  private async onLaunch(log: RawLog, devBuyFromBatch: bigint | null): Promise<void> {
    // null: the launch came over the socket without its transaction's CurveBuy. The
    // calldata carries the same number (research/devbuycheck.ts: 6 of 6), and the public
    // rpc is ~0.85s behind the socket (research/wsgap.ts), so both chain reads below wait.
    const viaWs = devBuyFromBatch === null
    const l = parseTokenLaunched(log)
    if (!l) return
    this.stats.launches++
    this.launchByCurve.set(l.curve, l)
    // a long run sees tens of thousands of launches; keep only recent ones for the mirror
    if (this.launchByCurve.size > 5_000) {
      const oldest = this.launchByCurve.keys().next().value
      if (oldest) this.launchByCurve.delete(oldest)
    }

    // Deployer track record, read BEFORE recording this launch so it counts only priors.
    // Both happen here, above every early return: the boot seed replays `launches` rows
    // unfiltered, so a launch we reject still counts after a restart. Skipping the bump on
    // the reject paths made priorLaunches smaller during a run than after one, and with
    // maxPriorLaunches: 0 that is the difference between accepting a deployer and
    // rejecting it. The book must not change because the process restarted.
    const priorLaunches = deployers.priorLaunches(l.deployer)
    deployers.bump(l.deployer)

    const screen = screenLaunch(l)
    if (!screen.pass) {
      this.reject(l, screen.reason!)
      return
    }

    // The launch calldata normally arrived via the feed already; when it did not, the
    // getTransaction fallback fires ALONGSIDE the curve read below rather than after it --
    // the two are independent, and paying their round trips in sequence spent 100-300ms
    // of the 2s entry window exactly on the degraded path (feed down) that can least
    // afford it.
    const txHash = log.transactionHash.toLowerCase()
    let meta: LaunchMeta | null = this.launchMetaByTx.get(txHash) ?? null

    // Screen on the free calldata BEFORE paying for the curve read. Everything in the book
    // screen except the creator tax comes from the calldata or the deployer registry, and
    // the feed delivers the calldata ~0.5s before the log. In the four hours before this
    // shipped (2026-09-06), 35% of socket launches were rejected on those checks after
    // paying for a curve read, and 22% more were launches through another contract that
    // paid for two reads to learn it. A launch the feed did not see falls through to the
    // reads exactly as before. Decisions are unchanged; a coin failing both the tax and a
    // calldata check now records the calldata reason, and its row carries no tax.
    const preDevBuy = devBuyFromBatch ?? meta?.quoteInWei ?? 0n
    const pre = meta
      ? screenCurve({ creatorTaxBps: null, devBuyWei: preDevBuy, meta, priorLaunches,
          requireDevBuy: this.opts.requireDevBuy ?? true, blockedDev: this.templateBlocked })
      : this.launchTxUnparseable.has(txHash) ? { pass: false, reason: viaWs ? 'no launch metadata (ws)' : 'no launch metadata' } : null
    if (pre && !pre.pass) {
      this.meters.preScreened++
      this.tel.launch({
        token: l.token, curve: l.curve, deployer: l.deployer, pair_token: l.pairToken,
        block: l.block, launched_at: this.launchTsByTx.get(txHash) ?? null, creator_tax_bps: null,
        dev_buy_wei: preDevBuy.toString(), detected_at: l.detectedAt, detect_source: viaWs ? 'ws' : l.source,
        passed: 0, reject_reason: pre.reason ?? null,
        exemptions: meta?.exemptions ?? null, has_twitter: meta ? (meta.hasTwitter ? 1 : 0) : null,
        has_website: meta ? (meta.hasWebsite ? 1 : 0) : null, name: meta?.name ?? null, symbol: meta?.symbol ?? null,
        logo: meta?.logo?.slice(0, 16) ?? null, live_book: inBook(preDevBuy, priorLaunches, meta?.exemptions ?? null) ? 1 : 0,
        prior_launches: priorLaunches,
      })
      this.bumpReject(pre.reason!)
      this.launchMetaByTx.delete(txHash); this.launchTsByTx.delete(txHash); this.launchTxUnparseable.delete(txHash)
      return
    }

    const via = this.readVia()
    const metaFallback = meta ? null : this.fetchLaunchMeta(log.transactionHash as Hex, viaWs, via)

    // one multicall reads params and genesis state. we have ~2s of clock before entry,
    // and a round trip here is far cheaper than assuming a config that may have drifted
    let params: CurveParams, state: CurveState, block: number
    try {
      ;({ params, state, block } = await this.readCurveVia(l.curve as Hex, viaWs, via))
    } catch (e) {
      this.reject(l, `param read failed: ${String(e).slice(0, 60)}`)
      return
    }

    this.state.track(l.curve, l.token, params, state, block)

    if (metaFallback) {
      const r = await metaFallback
      meta = r.meta // screened without it: a missing pitch is a reject in the live book
      if (r.got) this.meters.metaFromRpc++
    } else {
      this.meters.metaFromFeed++
    }
    this.launchMetaByTx.delete(txHash); this.launchTsByTx.delete(txHash)
    // rides the LaunchInfo into enter(), where strategy/entry.ts applies the exempt floor
    l.exemptions = meta?.exemptions ?? null

    // THE READ IS RECORDED WITH ITS ANSWER, which is what makes a decision that reads
    // mid-flight reproducible at all. Without this the replay reaches the launch, has no
    // creator tax and no supply, and can only refuse: the curve parameters live on the
    // contract and are in no log. Recorded AFTER the answer is in hand, never before, so a
    // failed read is absent from the tape rather than present with a lie in it.
    this.tape?.push('chain-read', {
      request: { kind: 'meta', args: [l.curve.toLowerCase(), l.token.toLowerCase()] },
      result: {
        params: {
          phantomQuote: String(params.phantomQuote), reservedTokens: String(params.reservedTokens),
          launchSupply: String(params.launchSupply), feeBps: String(params.feeBps),
          creatorTaxBps: String(params.creatorTaxBps), snipeTaxStartBps: String(params.snipeTaxStartBps),
          snipeTaxSeconds: String(params.snipeTaxSeconds), launchedAt: String(params.launchedAt),
        },
        state: {
          trackedQuote: String(state.trackedQuote), trackedTokens: String(state.trackedTokens),
          quoteFeeBalance: String(state.quoteFeeBalance), creatorTaxBalance: String(state.creatorTaxBalance),
          graduated: state.graduated, block,
        },
        exemptions: l.exemptions,
      },
      viaKey: via.key, tries: 1, latencyMs: 0,
    })

    const devBuyWei = devBuyFromBatch ?? meta?.quoteInWei ?? 0n
    l.devBuyWei = devBuyWei // rides into enter() for the template key
    // a socket launch with no calldata has nothing to screen on, and its poller copy is
    // already deduped: name the real reason rather than "dev buy 0"
    const verdict = viaWs && !meta
      ? { pass: false, reason: 'no launch metadata (ws)' }
      : screenCurve({
        creatorTaxBps: params.creatorTaxBps, devBuyWei, meta, priorLaunches,
        requireDevBuy: this.opts.requireDevBuy ?? true,
        blockedDev: this.templateBlocked,
      })

    this.tel.launch({
      token: l.token, curve: l.curve, deployer: l.deployer, pair_token: l.pairToken,
      block: l.block, launched_at: Number(params.launchedAt), creator_tax_bps: Number(params.creatorTaxBps),
      dev_buy_wei: devBuyWei.toString(), detected_at: l.detectedAt, detect_source: viaWs ? 'ws' : l.source,
      passed: verdict.pass ? 1 : 0, reject_reason: verdict.reason ?? null,
      exemptions: meta?.exemptions ?? null, has_twitter: meta ? (meta.hasTwitter ? 1 : 0) : null,
      has_website: meta ? (meta.hasWebsite ? 1 : 0) : null, name: meta?.name ?? null, symbol: meta?.symbol ?? null,
      logo: meta?.logo?.slice(0, 16) ?? null, live_book: inBook(devBuyWei, priorLaunches, meta?.exemptions ?? null) ? 1 : 0,
      prior_launches: priorLaunches,
    })

    if (!verdict.pass) {
      this.bumpReject(verdict.reason!)
      this.state.untrack(l.curve)
      return
    }
    this.stats.screened++

    // Entry is a clock, and the clock is the chain's, not ours. The snipe tax reads
    // block.timestamp - launchedAt in WHOLE SECONDS, so landing 150ms early is not a
    // 150ms mistake, it is a whole tax bracket: 618bps at elapsed 1 against 19bps at
    // elapsed 2. Wall-clock arithmetic cannot see that boundary because the launch block
    // could have been produced anywhere inside its own second. The feed can: every frame
    // carries the real block timestamp. So we wait to *observe* the boundary, then fire.
    const armAt = entryArmTs(params.launchedAt)
    // if the feed is down we still need to trade, so fall back to wall clock, but aimed
    // deliberately late: overshooting into elapsed 3 costs 19bps, undershooting costs 618
    const fallbackAt = Number(armAt) * 1000 + STRATEGY.entryFallbackLateMs
    const fallback = setTimeout(() => {
      if (this.armed.delete(l.curve)) void this.enter(l, params)
    }, Math.max(0, fallbackAt - Date.now()))
    this.armed.set(l.curve, { launch: l, params, armAtTs: armAt, fallback })
  }

  /**
   * Which client serves the two per-launch reads right now: the provider key inside the
   * entry window, the public rpc outside it. Outside the window the reads only feed the
   * observation universe, and the public rpc's 429s there cost a sample, not a trade.
   *
   * The quota projection (readBudget) does NOT gate this. It did until 2026-09-06 evening,
   * when it read 99% of pace with 1% of the month spent and would have moved the reads to
   * a public rpc that was refusing 1,100 polls an hour, in the busiest hour of the week,
   * on a prediction. Being early is what pays here; a provider that actually refuses is
   * handled below by the fallback, and that is the only thing that should move the reads.
   */
  private readVia(): { key: boolean } {
    const key = !!this.keyClient && inEntryWindow(Math.floor(Date.now() / 1000), STRATEGY.wsHours)
    return { key }
  }

  /**
   * readCurve for a launch. On the key: up to three quick tries (it already has the block,
   * even for a socket launch); if the key fails the public rpc takes over exactly as
   * before, so a dead key is a slower bot, never a blind one. On the public rpc: the
   * 429 retry, and on the socket path anything, until the block is there.
   */
  private async readCurveVia(curve: Hex, viaWs: boolean, via: { key: boolean }): Promise<Awaited<ReturnType<typeof readCurve>>> {
    if (via.key && this.keyClient) {
      try {
        return await readCurveRetry(curve, this.keyClient, {
          tries: 3, delayMs: 150, any: true,
          onTry: () => { this.meters.keyReads++; this.readBudget.spent('eth_call') },
        })
      } catch {
        this.meters.keyReadFallbacks++
      }
    }
    return readCurveRetry(curve, this.client, viaWs ? WS_READ : {})
  }

  /**
   * The launch calldata from the chain when the feed did not carry it. Same routing as
   * readCurveVia. On the public rpc a socket launch is ahead by ~0.85s p50 / 1.3s p90
   * (measured 2026-09-06), so that path retries until the block is there, inside the entry
   * budget; a poller launch keeps the single try, its block is by definition served.
   */
  private async fetchLaunchMeta(hash: Hex, viaWs: boolean, via: { key: boolean }): Promise<{ got: boolean; meta: LaunchMeta | null }> {
    if (via.key && this.keyClient) {
      for (let i = 0; i < 3; i++) {
        this.meters.keyReads++
        this.readBudget.spent('eth_getTransactionByHash')
        try {
          const tx = await this.keyClient.getTransaction({ hash })
          return { got: true, meta: parseLaunchCalldata(tx.input) }
        } catch {
          if (i < 2) await new Promise((r) => setTimeout(r, 150))
        }
      }
      this.meters.keyReadFallbacks++
    }
    const tries = viaWs ? WS_READ.tries : 1
    for (let i = 0; i < tries; i++) {
      try {
        const tx = await this.client.getTransaction({ hash })
        return { got: true, meta: parseLaunchCalldata(tx.input) }
      } catch {
        if (i < tries - 1) await new Promise((r) => setTimeout(r, WS_READ.delayMs))
      }
    }
    return { got: false, meta: null }
  }

  /**
   * First word of the reason is the counter key, so every 'dev buy ...' reject lands in
   * the one bucket the funnel expects.
   *
   * With a token, the reason is ALSO written to launches.entry_reject: that is an
   * entry-stage decline of a launch that passed the book, and until 2026-09-06 those lived
   * only in this in-memory map. 42 taxed book-passing launches were skipped in one
   * trading day with no recorded reason, and the leading suspect could not be measured.
   */
  private bumpReject(reason: string, token?: string): void {
    const key = reason.split(' ')[0]!
    this.stats.rejects.set(key, (this.stats.rejects.get(key) ?? 0) + 1)
    if (token) this.tel.entryReject(token, reason)
  }

  private reject(l: LaunchInfo, reason: string): void {
    this.bumpReject(reason)
    this.tel.launch({
      token: l.token, curve: l.curve, deployer: l.deployer, pair_token: l.pairToken, block: l.block,
      launched_at: 0, creator_tax_bps: -1, dev_buy_wei: '0', detected_at: l.detectedAt,
      detect_source: l.source, passed: 0, reject_reason: reason,
    })
  }

  private async enter(l: LaunchInfo, params: CurveParams): Promise<void> {
    // Start watching BEFORE any filter, so a launch we decline still teaches us what the
    // venue did. Notional throughout, never our real fill, so the series stays the same
    // question gatewatch.py answers and is not bent by our own price impact. Priced at the
    // MAIN size whatever book the launch ends up in: the observation is a venue
    // measurement and gatewatch prices its notional at the same size.
    this.startObservation(l, params, BigInt(Math.round(STRATEGY.tradeSizeEth * 1e18)))
    try {
      this.ensureShadow()
      const now = Date.now(), tracked = this.state.get(l.curve), size = BigInt(Math.round(STRATEGY.tradeSizeEth*1e18))
      const expected = tracked ? simBuy(params, tracked.working, size, entryArmTs(params.launchedAt)).tokensOut : null
      this.simulation?.capture('opportunity', l.token, { launch:l, params, config:this.shadowConfig(),
        strategy:this.strategySpec(), takeProfit:this.pickTakeProfit(now), selector:this.simulation?.paperStatus?.selector ?? null, selectorHeartbeatAt:this.simulation?.paperStatus?.at ?? 0, wallet:this.signer?.address ?? '',
        sizeWei:String(size), entryQuoteTokens:expected===null?null:String(expected),
        minTokens:expected===null?null:String(expected*BigInt(10_000-STRATEGY.buySlippageBps)/10_000n),
        seed:tracked?{state:{...tracked.confirmed},working:{...tracked.working},seedBlock:tracked.seedBlock,confirmedBlock:tracked.confirmedBlock,pending:[...tracked.pending]}:null,
        haltKinds:[...this.risk.haltKinds], entryHours:[] }, now)
    } catch(e) { this.simulation?.capture('source-fault',l.token,{reason:String(e)}) }
    if (liveConfig().venueExecutionScenarios) this.checkVenue()
    if (!liveConfig().venueExecutionScenarios && this.opts.mode !== 'observe' && !('reject' in pickEntry({ creatorTaxBps: params.creatorTaxBps, exemptions: l.exemptions ?? null }))) {
      try {
        this.ensureShadow()
        const now = Date.now(), tp = this.pickTakeProfit(now)
        this.shadow!.enqueue({ token: l.token, curve: l.curve, block: l.block, launched: Number(params.launchedAt)*1000,
          entry: now, wallet: this.signer?.address ?? '', params: Object.fromEntries(Object.entries(params).map(([k,v]) => [k,String(v)])),
          exemptions: l.exemptions ?? null, devBuyWei: String(l.devBuyWei ?? 0n), tp: tp.multiple, targetReason: tp.why,
          selector: this.lastBars, config: this.shadowConfig() })
        if (liveConfig().venueFreshRecovery) this.checkVenue()
      } catch (e) {
        try { this.shadow?.fail(`shadow intent capture failed: ${String(e)}`) } catch {}
        if (liveConfig().venueFreshRecovery) this.risk.halt(`shadow evidence failed: ${String(e)}`, 'venue')
        this.tel.health('shadow', false, String(e))
      }
    }
    // Every trading filter (creator-tax floor, exempt-wallet floor, entry window, the probe
    // book) lives in strategy/entry.ts and is applied HERE, deliberately not in
    // screenCurve. screenCurve sets launches.passed and gatewatch scores WHERE passed = 1,
    // so a filter there would stop us observing the launches we decline -- and the
    // declined arm is the control group that measures whether each filter still works. It
    // is checked after startObservation for the same reason: decline the trade, keep the
    // evidence. The reason goes to launches.entry_reject via bumpReject's token argument.
    const tkey = templateKey(params.creatorTaxBps, l.devBuyWei ?? 0n, l.exemptions ?? null)
    const lossAt = this.templateLossAt.get(tkey)
    const entryStrategy = this.strategySpec()
    const pick = pickEntry({
      creatorTaxBps: params.creatorTaxBps, exemptions: l.exemptions ?? null,
      templateLossAgeMs: lossAt === undefined ? null : Date.now() - lossAt,
    })
    if ('reject' in pick) {
      this.bumpReject(pick.reject, l.token)
      // release, never drop the curve's tracking outright: an observation may be open on
      // it, and killing the tracking stops applyLog feeding that observation, which is
      // exactly how a halted bot went blind before.
      this.releaseCurve(l.curve)
      return
    }
    const { sizeWei } = pick
    const gate = this.risk.canEnter({
      token: l.token, sizeWei,
      logsHealthy: this.logs.healthy,
      // stream liveness, not event activity: a quiet market is not a broken stream
      logsAgeMs: this.logs.lastHealthyAt ? Date.now() - this.logs.lastHealthyAt : 0,
      curveDegraded: this.state.get(l.curve)?.degraded ?? false,
    })
    // claim the slot before any await, or a burst of launches in the same second all
    // pass the gate against a stale count and we blow through the concurrency cap
    if (gate.allow) this.risk.reserve(l.token, sizeWei)
    if (!gate.allow) {
      this.bumpReject(gate.reason!, l.token)
      this.releaseCurve(l.curve)
      return
    }

    const tracked = this.state.get(l.curve)
    if (!tracked) { this.risk.unreserve(sizeWei); return }
    const tDecide = Date.now()

    // price the buy at the timestamp we expect to land in. we fire on the block that
    // opened the window, so that block's second is the one we land in.
    const landTs = entryArmTs(params.launchedAt)
    let expected: bigint
    try {
      expected = simBuy(params, tracked.working, sizeWei, landTs).tokensOut
    } catch {
      this.releaseCurve(l.curve)
      this.risk.unreserve(sizeWei)
      return
    }
    // THE GRADUATION GUARD (2026-09-06). How far has this curve already been pumped, in
    // our own model, right now? `expected` is what the live curve gives for our stake; a
    // fresh curve would give more. Every bag we ever held read 3.4x-6.8x here and we fired
    // anyway; no normal trade this era read 5x and the 3-5x band lost. Same landTs on both
    // sides so the snipe tax cancels. A failure of the reference sim is a model problem,
    // not evidence, so it never blocks a trade by itself. See STRATEGY.maxEntryPriceMultiple.
    let pumped = 0
    try {
      const fresh = simBuy(params, freshCurve(params), sizeWei, landTs).tokensOut
      pumped = expected > 0n ? Number(fresh) / Number(expected) : Infinity
    } catch (e) {
      this.tel.health('entry', false, `${l.token.slice(0, 12)} fresh-curve reference failed: ${String(e).slice(0, 60)}`)
    }
    if (pumped >= STRATEGY.maxEntryPriceMultiple) {
      this.bumpReject(`pumped ${pumped.toFixed(1)}x`, l.token)
      this.releaseCurve(l.curve)
      this.risk.unreserve(sizeWei)
      return
    }
    const minTokensOut = (expected * BigInt(10_000 - STRATEGY.buySlippageBps)) / 10_000n

    if (this.opts.mode === 'observe') {
      this.stats.entered++
      this.risk.unreserve(sizeWei)
      this.emit('would-enter', { launch: l, expected, minTokensOut, sizeWei })
      return
    }

    this.simulation?.capture('entry-decision', l.token, { expected, minTokensOut, sizeWei, tDecide, rules:currentExitRules(), strategy:entryStrategy })
    const nonce = this.nonce!.reserve()
    const tx = buildBuy({ curve: l.curve as Hex, quoteIn: sizeWei, minTokensOut, recipient: this.signer!.address, nonce, chainId: robinhoodChain.id })
    const signed = await this.signer!.sign(tx)
    const tSigned = Date.now()

    let ok = false, hash = signed.hash as string, error: string | null = null
    // a transport failure tells us nothing: the bytes may have been sequenced and filled.
    // discarding the position there would leave real tokens with nobody managing them.
    let uncertain = false
    if (this.opts.mode === 'live') {
      const r = await this.tapedSend('buy', l.token, signed, nonce)
      this.tel.latency('buy-send', r.ms, r.ok)
      if (r.ok) { ok = true; hash = r.hash; this.nonce!.settle() }
      else {
        error = r.error
        // see sendUncertain: a transport failure OR "nonce too low" may describe our own
        // buy landing, and the balance decides; a clean rejection closes the row below
        if (r.nonceConsumed) { this.nonce!.settle(); uncertain = sendUncertain(r) }
        else this.nonce!.rejected(nonce, r.error)
      }
    } else {
      // shadow: everything above actually happened, we simply do not write the socket
      ok = true
      this.nonce!.release(nonce)
    }
    const tSent = Date.now()
    this.simulation?.capture('buy-send', l.token, { hash, ok, uncertain, error, tDecide, tSigned, tSent })

    // in shadow we assume the modelled fill; live replaces it from the actual event
    const tokens = expected
    if ((ok || uncertain) && this.opts.mode === 'shadow') {
      // fold our own buy into a private book so every later mark carries our impact.
      // without this, paper marks price a curve we never moved and read too high.
      try {
        this.state.openShadow(l.curve, simBuy(params, tracked.confirmed, sizeWei, landTs).next)
      } catch {}
    }
    const entryMark = ok || uncertain ? this.mark(l.curve, tokens) || sizeWei : 0n

    // The rung, chosen ONCE here and carried on the position. One `openedAt` for the row,
    // the position and the rate age, so the three can never describe different instants.
    const openedAt = Date.now()
    const tp = this.pickTakeProfit(openedAt)
    // The exit rules this position will run, read ONCE here. The row below and the position
    // itself are both written from this object, so they cannot describe different rules,
    // and a config change mid-hold cannot move the clock under a bag already open.
    const rules = currentExitRules()

    const id = this.tel.openPosition({
      token: l.token, curve: l.curve, live: this.opts.mode === 'live' ? 1 : 0,
      t_detect: l.detectedAt, t_decide: tDecide, t_signed: tSigned, t_sent: tSent,
      entry_block: l.block, spend_wei: sizeWei.toString(), min_tokens_out: minTokensOut.toString(),
      tokens_held: expected.toString(), entry_mark_wei: entryMark.toString(), buy_hash: hash,
      buy_ok: ok ? 1 : 0, buy_error: error,
      // recorded per position, not per config: the schedule means the live book now holds
      // several rungs at once, and joining outcomes back to the rung that produced them is
      // the only way to check the research against what actually happened
      take_profit: tp.multiple,
      // the bailout this position runs, pinned for the same reason (recon replays the
      // row's own rule; NULL rows predate the bailout and replay without one)
      dead_after_ms: rules.deadCoinAfterMs, dead_below: rules.deadCoinBelowMult,
      // Always 'main' now: the probe book was deleted 2026-09-07. Still written, because
      // the column still has to separate this era's rows from the probe rows behind them.
      cohort: 'main',
      // the graduation guard's reading at decision, kept so the band stays measurable
      entry_mult: Number.isFinite(pumped) ? Number(pumped.toFixed(3)) : null,
      build_id: buildIdentity.id,
      context_json: JSON.stringify({ at: openedAt, build: buildIdentity, strategyAtOpen: this.strategySpec(), entryStrategy, rules: { ...rules, takeProfitMultiple: tp.multiple },
        targetReason: tp.why, market: this.lastVenue?.reading ?? null, touch: this.lastGate?.reading ?? null }),
    })

    if (!ok && !uncertain) {
      // The sequencer rejected it with a reason: nothing was sequenced, no gas was paid,
      // no tokens are coming. The row was already written above (buy_ok 0), so close it
      // now rather than leave it open for recovery to find on the next restart. On
      // 2026-09-05 thirteen of these sat open for 35 minutes during a nonce runaway, the
      // dashboard counted them as positions, and the bot's own book said two.
      this.tel.closePosition(id, {
        exit_reason: 'buy-never-mined', exit_at: Date.now(), exit_hash: null,
        proceeds_wei: '0', expected_wei: '0', pnl_wei: '0', hold_ms: 0,
        tokens_held: '0', peak_mult: 0, buy_error: error,
      })
      this.releaseCurve(l.curve); this.risk.unreserve(sizeWei); return
    }
    if (uncertain) {
      // keep the slot and the curve; reconcileBuy will read the balance and either adopt
      // the position or release the capacity once the chain tells us which happened
      this.tel.health('buy', false, `${l.token.slice(0, 12)} send uncertain, will reconcile from balance`)
    }
    const pos = newPosition({
      id, token: l.token, curve: l.curve, tokens, spendWei: sizeWei, entryMarkWei: entryMark,
      openedAt, buyHash: hash, takeProfitMultiple: tp.multiple, rules, templateKey: tkey,
      // live buys are not filled until the chain says so. a buy that reverts on its own
      // slippage bound is the most common live failure, and treating it as filled means
      // selling tokens we never owned and booking a loss for money we never spent.
      filled: this.opts.mode !== 'live' && !uncertain,
    })
    this.positions.set(l.curve, pos)
    this.stats.entered++
    console.log(`  tp ${tp.multiple.toFixed(2)} (${tp.why})`)

    // approve now, not at exit time: sell() pulls via safeTransferFrom, and paying for
    // that round trip during an exit is exactly the 9 points the research says to protect
    if (this.opts.mode === 'live') void this.approve(l.token as Hex, l.curve as Hex)
  }

  /**
   * Begin a notional watch on a book launch. Priced at the arm moment so the entry matches
   * gatewatch.py's (block lb+20, i.e. +2s), which is what makes the two series comparable.
   *
   * Never throws: a failure here must cost a cohort sample, never a trade.
   */
  private startObservation(l: LaunchInfo, params: CurveParams, sizeWei: bigint): void {
    try {
      if (this.observations.has(l.curve)) return
      const tracked = this.state.get(l.curve)
      if (!tracked) return
      const landTs = entryArmTs(params.launchedAt)
      const sim = simBuy(params, tracked.working, sizeWei, landTs)
      if (sim.tokensOut <= 0n) return
      // gatewatch.py's ratio, term for term: entry_px = X/got (gross in over tokens out,
      // so every friction is inside it) and the series is the raw mid q/t against it.
      // A markToExit/markToExit ratio would cancel those frictions and start at 1.000,
      // making 1.21 a 0.70% looser bar than the one openAt/shutAt were calibrated on.
      // See test/venuemark.test.ts.
      const entryMark = entryPrice(sizeWei, sim.tokensOut)
      if (entryMark <= 0n) return
      // sim.next, not tracked.working: gatewatch measures AFTER its own notional buy has
      // moved the curve, so the first point of the series has to include that impact too.
      //
      // Known residual, deliberately not chased: every LATER point is the real curve,
      // while gatewatch keeps replaying on its mutated one, so our series runs a touch
      // below theirs by our notional's impact plus the size difference (it uses a fixed
      // 0.010, we trade 0.0075). Measured at dP -0.10% on the first joined verdict and a
      // median -0.14% over 4286 launches offline. It is small and it is CONSERVATIVE (we
      // read fewer touches, so the gate shuts sooner, not later), and closing it would
      // mean a simBuy per observation per 50ms tick in the exit loop. Not worth it.
      const peak = midPrice(params, sim.next)
      if (peak <= 0n) return
      this.observations.set(l.curve, {
        token: l.token, entryMark, peak,
        launchedAtMs: Number(params.launchedAt) * 1000, until: Date.now() + OBSERVE_MS,
      })
    } catch { /* a cohort sample is not worth risking the entry path for */ }
  }

  /**
   * Advance every open observation and settle the ones whose hold has closed. Runs inside
   * pumpExits (50ms), which is why the verdict is available in milliseconds.
   *
   * Every step is contained to ONE observation. The settle path deletes from the map
   * before it records, so an uncaught throw halfway through would lose that verdict AND
   * skip every remaining observation due on the same tick. A scoring outage must cost at
   * most one sample, and must degrade to gate.db (i.e. to today's behaviour), never to
   * 'open'.
   */
  private pumpObservations(now: number): void {
    if (!this.observations.size) return
    let settled = false
    for (const [curve, o] of this.observations) {
      try {
        try {
          // midWorking, NOT markWorking: entryMark and peak are PRICES here (scaled by
          // PRICE_SCALE), and markWorking returns exit proceeds in wei. The two differ by
          // ~6 orders of magnitude, so a wei mark always wins the `>` and pins the peak to
          // a nonsense value -- observed live as peak=2354341.8290 and touch=1 on a launch
          // that did nothing. Units, not rounding.
          const mark = this.state.midWorking(curve)
          if (mark > o.peak) o.peak = mark
        } catch { /* a curve we cannot mark this tick is not a verdict yet */ }
        if (now < o.until) continue
        this.observations.delete(curve)
        // same question gatewatch asks: did the venue mark reach the bar inside the hold.
        // gate.touchMultiple, NOT takeProfitMultiple: this is the venue measurement, and
        // it has to stay put when the exit policy moves or the rate is not comparable
        // with its own history or with the openAt/shutAt thresholds calibrated on it
        const touch = touchedBar(o.entryMark, o.peak, STRATEGY.gate.touchMultiple)
        this.cohort.record(o.token, o.launchedAtMs, touch)
        this.meters.cohortScored++
        // set the moment the verdict is IN the ring: everything below is reporting, and a
        // throw in reporting must still let the gate re-evaluate on what it just learned
        settled = true
        // Logged on every verdict so it can be joined against gate.db.obs token by token.
        // parity.py did that join (archive/purged-sims-20260827.tar.gz); keep this line while the two halves are
        // being compared on real curves.
        const mult = o.entryMark > 0n ? Number((o.peak * 10000n) / o.entryMark) / 10000 : 0
        console.log(`[cohort] token=${o.token} touch=${touch ? 1 : 0} peak=${mult.toFixed(4)}`
          + ` lag=${((now - o.launchedAtMs) / 1000).toFixed(1)}s live=${STRATEGY.gate.live ? 1 : 0}`)
        this.releaseCurve(curve)
      } catch { /* never let one bad sample break the exit loop or the rest of the batch */ }
    }
    // Evaluate on the verdict itself, not on the next 30s housekeeping tick. This is the
    // other half of "real time": scoring fast is pointless if the decision still waits.
    if (settled) { try { this.checkRegimeGate() } catch {} }
  }

  /** Untrack only once nothing still needs the curve: a position, or an open observation. */
  private releaseCurve(curve: string): void {
    if (this.positions.has(curve) || this.observations.has(curve)) return
    this.state.untrack(curve)
  }

  /**
   * Triggers read the fast book; in shadow that book also carries our own buy, so paper
   * results are not flattered by an impact we would really have had.
   */
  private mark(curve: string, tokens: bigint): bigint {
    return this.opts.mode === 'shadow'
      ? this.state.markShadow(curve, tokens)
      : this.state.markWorking(curve, tokens)
  }

  /**
   * Approve the curve to pull our tokens, retrying a failed send.
   *
   * This used to be fire-and-forget, and a single failed send was unrecoverable: sell()
   * pulls via safeTransferFrom, so a position whose approve never landed cannot exit at
   * all, and nothing re-checked the allowance until the next process restart. That is
   * exactly what stranded position 749 for 29 hours on 2026-08-24 after a 4ms transport
   * failure. Measured failure rate is 3 in 531 sends (0.6%), which is rare enough to
   * ignore right up until it costs a whole position.
   *
   * Returns whether the approve is believed sequenced. Callers on the entry path ignore
   * it (the sell path re-checks the allowance for real); the diagnosis path uses it.
   */
  private async approve(token: Hex, curve: Hex, tries = 3): Promise<boolean> {
    const positionId = this.positions.get(curve)?.id
    for (let attempt = 1; attempt <= tries; attempt++) {
      const nonce = this.nonce!.reserve()
      const tx = buildApprove({ token, spender: curve, nonce, chainId: robinhoodChain.id })
      const signed = await this.signer!.sign(tx)
      if (positionId) {
        recordApproval(this.tel.raw(), positionId, signed.hash, nonce)
        const row = this.tel.raw().prepare('SELECT closed FROM positions WHERE id=?').get(positionId) as { closed: number } | undefined
        if (row?.closed) this.truth?.enqueue(positionId)
      }
      const r = await this.tapedSend('approve', token, signed, nonce)
      this.simulation?.capture('approval-send',token,{hash:signed.hash,attempt,positionId,ok:r.ok})
      this.tel.latency('approve-send', r.ms, r.ok)
      if (r.ok || r.nonceConsumed) {
        this.nonce!.settle()
        // nonceConsumed without ok means the send is ambiguous, not successful. Treat it
        // as sequenced (retrying would double-spend the nonce) and let the sell path
        // discover the truth from the allowance itself.
        if (attempt > 1) this.tel.health('approve', true, `${token.slice(0, 12)} approved on attempt ${attempt}`)
        return true
      }
      if (positionId) rejectApproval(this.tel.raw(), signed.hash)
      this.nonce!.rejected(nonce, r.error)
      if (attempt < tries) await sleep(APPROVE_RETRY_MS * attempt)
    }
    this.tel.health('approve', false,
      `${token.slice(0, 12)} approve failed ${tries}x: this position cannot sell until it is re-approved`)
    return false
  }

  /**
   * Confirm our fill from the chain. Matched on our own transaction hash, not on the
   * recipient field: buy() lets anyone name any recipient, so a rival could send us a
   * one-wei buy, overwrite our position size with dust, and leave the real tokens stranded.
   */
  private noteOurFill(log: RawLog): void {
    const pos = this.positions.get(log.address)
    if (!pos || !pos.buyHash) return
    if (log.transactionHash.toLowerCase() !== pos.buyHash.toLowerCase()) return
    const tokensOut = logWord(log.data, 1)
    this.adoptFill(pos, tokensOut)
  }

  /**
   * The one place a position becomes real. Both confirmation paths (the CurveBuy event
   * and the balance reconcile) land here, so the mark fallback and the peak seed cannot
   * drift between them.
   */
  private adoptFill(pos: Position, tokens: bigint): void {
    const first = !pos.filled
    pos.tokens = tokens
    pos.filled = true
    pos.entryMarkWei = this.mark(pos.curve, tokens) || pos.entryMarkWei
    pos.peakMarkWei = pos.entryMarkWei
    this.simulation?.capture('fill-adoption',pos.token,{id:pos.id,hash:pos.buyHash,tokens,first,entryMarkWei:pos.entryMarkWei,openedAt:pos.openedAt})
    // both fill paths land here; arm the book checks once, on whichever got there first
    if (first) for (const ms of BOOK_CHECK_AT_MS) setTimeout(() => void this.bookCheck(pos), ms).unref()
  }

  /**
   * Ask the chain what this curve's book is, while we are holding it, and hand the answer
   * to the engine to compare against the book the exit rules are reading. Two reads a trade
   * on the key (~26 CU each): the price of never again running six hours on a wrong book.
   */
  private async bookCheck(pos: Position): Promise<void> {
    if (this.positions.get(pos.curve) !== pos || !this.keyClient || !this.state.get(pos.curve)) return
    this.meters.keyReads++
    this.readBudget.spent('eth_call')
    try {
      const { state, block } = await readCurve(pos.curve as Hex, this.keyClient)
      this.state.armCheck(pos.curve, { state, block })
    } catch {
      // a key that refuses is already reported by the launch reads; a missing check is not news
    }
  }

  /** The poller has folded everything up to `tip`: any book check it covers can be judged. */
  private onHead(tip: number): void {
    for (const r of this.state.settleChecks(tip)) {
      if (!r.ok) this.tel.health('book', false, `${r.curve.slice(0, 12)} ${r.detail}`)
    }
  }

  /**
   * A live exit is only really known once its event lands. Until then the recorded
   * proceeds are our own estimate, and reporting an estimate as a result is how a bot
   * convinces you it is profitable when it is not.
   */
  private noteOurExit(log: RawLog): void {
    const pos = this.positions.get(log.address)
    if (!pos || !pos.sellInFlight) return
    if (log.transactionHash.toLowerCase() !== pos.sellHash.toLowerCase()) return
    const quoteOut = logWord(log.data, 1)
    this.settleExit(pos, quoteOut, log.transactionHash)
  }

  /**
   * Gas actually burned, for P&L and therefore for the kill switch.
   *
   * `sold: false` is the reverted-buy case: the approve went out and the buy burned its
   * gas, but no sell was ever built, so charging one books a cost that never happened
   * straight into the drawdown stop.
   *
   * `burnedLimit` is the out-of-gas case, where the buy consumed the whole ceiling rather
   * than the GAS.used.buy median. Fractions of a cent at current base fees, but the number
   * should not claim to be measured when we know it is wrong. truth.ts overwrites all of
   * this from receipts anyway; this is only what the kill switch sees in the meantime.
   */
  private gasBudgetWei({ sold = true, burnedLimit = false }: { sold?: boolean; burnedLimit?: boolean } = {}): bigint {
    let legs = gasSpentEth(burnedLimit ? GAS.limits.buy : GAS.used.buy)
    if (sold) legs += gasSpentEth(GAS.used.sell)
    if (this.opts.mode === 'live') legs += gasSpentEth(GAS.used.approve)
    return BigInt(Math.round(legs * 1e18))
  }

  /**
   * A zero token balance is not proof the buy reverted: the buy goes to the sequencer and
   * the balance read goes to the public RPC, which can be a block or two behind it. Ask
   * the receipt, which is definitive, and keep the position if the two disagree.
   *
   * Bounded on purpose. A tx that was dropped rather than mined has no receipt and never
   * will, so after the grace window we accept the balance and let the row close; holding
   * a slot open forever is its own leak.
   *
   * Returns WHY as well as whether, because the two failure modes need different humans:
   * `reverted` is venue friction, `out-of-gas` is our own ceiling set too low.
   */
  private async inspectBuy(pos: Position, urgent = false): Promise<BuyVerdict> {
    if (this.opts.mode !== 'live' || !pos.buyHash) return { kind: 'failed', cause: null }
    if (Date.now() - pos.openedAt > RECONCILE_GRACE_MS) return { kind: 'failed', cause: null }
    try {
      const rc = await (urgent ? this.graduationReadClient() : this.client).getTransactionReceipt({ hash: pos.buyHash as Hex })
      this.simulation?.capture('buy-receipt',pos.token,{hash:pos.buyHash,receipt:rc})
      if (rc.status === 'success') return { kind: 'landed' }
      const cause = classifyFailedTx(rc.gasUsed, GAS.limits.buy)
      return { kind: 'failed', cause, gasUsed: rc.gasUsed }
    } catch {
      return { kind: 'pending' } // not mined yet as far as this node knows; not reverted
    }
  }

  // ---------- exit ----------

  private graduation: GraduationExit | null = null
  private graduationRpc: PublicClient | null = null
  private graduationReadClient(): PublicClient {
    return this.graduationRpc ??= graduationClient([ENDPOINTS.rpcKey ?? '', ...RPC_URLS],
      method => this.countProviderRequest(method), () => { this.sharedReceiptReads++ })
  }

  private graduate(pos: Position): void {
    if (pos.graduated) return
    pos.graduated = true
    pos.parked = false
    pos.exiting = true
    pos.exitReason = 'graduated-swap'
    pos.expectedProceeds = 0n // a curve quote is not an estimate for the new pool
    pos.retryNotBefore = 0
    this.tel.health('exit', false, `${pos.token.slice(0, 12)} graduated; handing held tokens to swap exit`)
    this.graduationManager().enroll(pos.id)
  }

  private graduationManager(): GraduationExit {
    return this.graduation ??= new GraduationExit({
      capture: (kind,key,payload) => this.simulation?.capture(kind,key,payload),
      db: this.tel.raw(), client: this.graduationReadClient(), wallet: this.signer!.address,
      sign: async (to, data, gas) => {
        const nonce = this.nonce!.reserve()
        try { return await this.signer!.sign(graduatedTx(to, data, nonce, gas)) }
        catch (e) { this.nonce!.release(nonce); throw e }
      },
      send: async (signed, nonce, replay) => {
        this.simulation?.capture('graduation-send',signed.hash,{hash:signed.hash,nonce,replay})
        const r = await this.tapedSend('graduate', signed.hash, signed, nonce)
        this.simulation?.capture('graduation-send-result',signed.hash,{hash:signed.hash,result:r})
        if (!replay) {
          if (r.ok || r.nonceConsumed) this.nonce!.settle()
          else this.nonce!.rejected(nonce, r.error)
        }
        return r
      },
      release: nonce => { this.nonce!.release(nonce) },
      burned: (id, gas) => {
        const p = [...this.positions.values()].find(p => p.id === id)
        if (p) p.burnedGasWei += gas
        this.risk.burned(gas)
        // Synchronous with the durable receipt status, so a crash cannot charge twice.
        const row = this.tel.raw().prepare('SELECT burned_gas_wei b FROM positions WHERE id=?').get(id) as { b: string | null }
        this.tel.raw().prepare('UPDATE positions SET burned_gas_wei=? WHERE id=?').run(String(BigInt(row.b ?? '0') + gas), id)
      },
      prepared: (id, gas) => {
        const p = [...this.positions.values()].find(p => p.id === id)
        if (p) p.preparationGasWei = (p.preparationGasWei ?? 0n) + gas
        this.risk.burned(gas)
        const row = this.tel.raw().prepare('SELECT graduation_prep_gas_wei g FROM positions WHERE id=?').get(id) as { g: string | null }
        this.tel.raw().prepare('UPDATE positions SET graduation_prep_gas_wei=? WHERE id=?').run(String(BigInt(row.g ?? '0') + gas), id)
      },
      health: (ok, note) => this.tel.health('exit', ok, note),
    })
  }

  private async pumpGraduated(pos: Position): Promise<void> {
    if (Date.now() < pos.retryNotBefore) return
    if (this.opts.mode !== 'live') { pos.stuck = true; return }
    try {
      const result = await this.graduationManager().step(pos.id, pos.token as Hex, pos.curve as Hex)
      if (result) this.settleExit(pos, result.proceeds, result.hash)
      else pos.stuck = Date.now() - pos.openedAt > 30000
    } catch (e) {
      pos.stuck = true
      pos.retryNotBefore = Date.now() + 30000
      this.tel.health('exit', false, `${pos.token.slice(0, 12)} swap manager unavailable: ${String(e).slice(0, 120)}; holding remains open`)
    }
  }

  private pumpExits(): void {
    const now = Date.now()
    if (liveConfig().venueExecutionScenarios && now >= (this.scenarioController?.nextCheckAt ?? 0)) this.checkVenue()
    if (liveConfig().venueFreshRecovery && this.shadow?.needsExpiryCheck(now)) {
      try { this.checkVenue() } catch (e) { this.risk.halt(`shadow guard failed: ${String(e)}`, 'venue') }
    }
    this.pumpObservations(now)
    for (const pos of this.positions.values()) {
      const tracked = this.state.get(pos.curve)
      const closedCurve = this.opts.mode === 'live' && !!tracked && (tracked.confirmed.graduated || readyToGraduate(tracked.params, tracked.confirmed))
      // Graduation must not sit behind the ordinary buy/sell confirmation timers.
      if (!pos.filled) {
        if (closedCurve || now - pos.openedAt > FILL_TIMEOUT_MS) void this.reconcileBuy(pos, closedCurve)
        continue
      }
      if (pos.sellInFlight) {
        if (closedCurve || now - pos.sellSentAt > SELL_CONFIRM_MS) void this.reconcileSell(pos, closedCurve)
        continue
      }
      if (closedCurve) this.graduate(pos)
      if (pos.graduated) { void this.pumpGraduated(pos); continue }
      const graduating = this.state.isGraduating(pos.curve)
      const mark = this.mark(pos.curve, pos.tokens)
      if (!pos.exiting) {
        const reason = evaluate(pos, mark, now, graduating)
        this.simulation?.evaluator(pos.token,{mark:String(mark),entryMark:String(pos.entryMarkWei),peak:String(pos.peakMarkWei),openedAt:pos.openedAt,rules:pos.rules,takeProfit:pos.takeProfitMultiple,graduating,reason},now)
        try { this.tel.tradeMark?.(pos.id, now, mark, pos.entryMarkWei, reason) } catch { /* telemetry cannot stop an exit */ }
        if (reason) void this.fireExit(pos, reason)
      } else if (shouldRetry(pos, now)) {
        void this.fireExit(pos, pos.exitReason ?? 'manual')
      }
    }
  }

  /**
   * The buy was sequenced but no CurveBuy event arrived. It reverted, or we missed the log.
   * Ask the chain, because guessing either way costs money: assuming filled means selling
   * tokens we never owned, assuming reverted means abandoning tokens we do own.
   *
   * When it did revert, the receipt says which kind and the row records it. This used to
   * assert "the common case when an FCFS race is lost" in a comment and write nothing, so
   * six out-of-gas buys on 2026-08-19 were indistinguishable from lost races for four
   * hours. buy_error carries the cause now; exit_reason stays 'buy-reverted' so existing
   * queries keep working.
   */
  private async reconcileBuy(pos: Position, urgent = false): Promise<void> {
    const now = Date.now()
    if (pos.reconciling || (!urgent && now - pos.lastReconcileAt < pos.reconcileBackoffMs)) return
    pos.reconciling = true
    pos.lastReconcileAt = now
    // a verdict that keeps us waiting backs the next pass off; a health row only when the
    // verdict changes. See Position.reconcileBackoffMs.
    const waiting = (note: string) => {
      pos.reconcileBackoffMs = Math.min(4_000, Math.max(500, pos.reconcileBackoffMs * 2))
      if (pos.lastReconcileNote !== note) { pos.lastReconcileNote = note; this.tel.health('buy', false, `${pos.token.slice(0, 12)} ${note}`) }
    }
    try {
      const bal = await (urgent ? this.graduationReadClient() : this.client).readContract({
        address: pos.token as Hex, abi: erc20Abi, functionName: 'balanceOf', args: [this.signer!.address],
      })
      if (bal > 0n) {
        this.adoptFill(pos, bal)
        this.tel.health('buy', true, `${pos.token.slice(0, 12)} filled, confirmed by balance`)
        return
      }
      const verdict = await this.inspectBuy(pos, urgent)
      if (verdict.kind === 'landed') {
        // the receipt says the buy succeeded, so the zero came from an RPC replica behind
        // the fill. Closing here would abandon tokens we own: the row goes closed=1 and
        // recovery only ever looks at closed=0, so no later restart would find them.
        waiting('balance 0 but receipt ok; rpc lagging, retrying')
        return
      }
      if (verdict.kind === 'pending') {
        waiting('balance 0, no receipt yet; retrying')
        return
      }
      // nothing held: the buy failed and the eth came back. no loss beyond gas.
      const oog = verdict.cause === 'out-of-gas'
      const gas = this.gasBudgetWei({ sold: false, burnedLimit: oog })
      const why = verdict.cause === null
        ? 'unknown: no receipt within the grace window'
        : `${verdict.cause} gasUsed=${verdict.gasUsed}/${GAS.limits.buy}`
      this.tel.closePosition(pos.id, {
        exit_reason: 'buy-reverted', exit_at: Date.now(), exit_hash: null,
        proceeds_wei: '0', expected_wei: '0', pnl_wei: (-gas).toString(), hold_ms: Date.now() - pos.openedAt,
        tokens_held: '0', peak_mult: 0, buy_error: why,
      })
      this.positions.delete(pos.curve)
      this.releaseCurve(pos.curve)
      this.risk.closed(pos.spendWei, -gas)
      this.truth?.enqueue(pos.id)
      // an out-of-gas buy is a config bug, not friction. Say so, loudly and differently.
      this.tel.health('buy', false, oog
        ? `${pos.token.slice(0, 12)} OUT OF GAS at ${GAS.limits.buy}, raise GAS.limits.buy; capacity released`
        : `${pos.token.slice(0, 12)} ${why}, capacity released`)
    } catch (e) {
      waiting(`reconcile failed: ${String(e).slice(0, 60)}`)
    } finally {
      pos.reconciling = false
    }
  }

  /**
   * A sequenced sell is not an executed sell. If its event never arrives we check the
   * receipt: reverted means retry wider, succeeded means close from the real numbers.
   * Closing on send-acknowledgement instead would strand the tokens while booking a win.
   *
   * Retrying wider only answers a slippage revert. An out-of-gas sell will fail identically
   * on all 12 attempts while the bag bleeds, so it is called out separately. Sell has 2.75x
   * headroom today (p95 94,541 against a 260,000 limit) so this is prophylactic, but the
   * buy path made the case for not letting one failure mode wear another's clothes.
   */
  private async reconcileSell(pos: Position, urgent = false): Promise<void> {
    if (pos.reconciling) return
    pos.reconciling = true
    try {
      const rec = await (urgent ? this.graduationReadClient() : this.client).getTransactionReceipt({ hash: pos.sellHash as Hex }).catch(() => null)
      if(rec)this.simulation?.capture('sell-receipt',pos.token,{hash:pos.sellHash,receipt:rec})
      if (!rec) {
        // not mined yet, or we cannot see it. give it another window before retrying.
        if (Date.now() - pos.sellSentAt > SELL_GIVEUP_MS) {
          pos.sellInFlight = false
          this.tel.health('exit', false, `${pos.token.slice(0, 12)} sell ${pos.sellHash.slice(0, 10)} unknown, retrying`)
        }
        return
      }
      if (rec.status === 'success') {
        const log = rec.logs.find((l) => l.topics[0] === EVENT_TOPICS.CurveSell)
        const proceeds = log ? logWord(log.data, 1) : 0n
        this.settleExit(pos, proceeds, pos.sellHash)
      } else {
        // reverted: we still hold the tokens, so widen the bound and go again.
        // But a revert is not free. The chain executed up to the revert and charged for
        // it, and nothing else in the pipeline can see that cost: proceeds are zero, and
        // the receipt backfill only walks buy_hash and exit_hash. Book it here, into the
        // position AND the live ledger, so a bleeding retry loop shows up in the drawdown
        // and daily-cap arithmetic while it is bleeding rather than after.
        const burned = rec.gasUsed * rec.effectiveGasPrice
        pos.burnedGasWei += burned
        this.risk.burned(burned)
        this.tel.burnedGas(pos.id, burned) // added onto the row, or the backfill forgets it
        pos.sellInFlight = false
        pos.stuck = pos.attempts > 6
        const cause = classifyFailedTx(rec.gasUsed, GAS.limits.sell)
        this.tel.health('exit', false, cause === 'out-of-gas'
          ? `${pos.token.slice(0, 12)} sell OUT OF GAS at ${GAS.limits.sell} on attempt ${pos.attempts}; `
            + 'widening slippage cannot fix this, raise GAS.limits.sell'
          : `${pos.token.slice(0, 12)} sell reverted, attempt ${pos.attempts}`)
        // widening the bound only answers a slippage revert. ask the chain what else it
        // could be before spending another few thousand attempts finding out the hard way.
        if (cause !== 'out-of-gas') void this.diagnoseStuckSell(pos)
      }
    } finally {
      pos.reconciling = false
    }
  }

  /**
   * Why does this sell keep reverting? Two causes are not slippage and never heal on
   * their own, so the retry ladder cannot touch them:
   *
   *   allowance 0  - the approve never landed. sell() pulls via safeTransferFrom, so
   *                  every attempt reverts ERC20InsufficientAllowance (0xfb8f41b2).
   *                  Fixable: send the approve again.
   *   graduated    - the curve has left the venue and reverts CurveGraduated()
   *                  (0x025ac17e) by construction. Not fixable here at any price; the
   *                  tokens are on the DEX side now. Hand them to swap management.
   *
   * On 2026-08-25 these two accounted for 33,804 retries and buried every other alert.
   *
   * Never throws and never blocks an exit: this is diagnosis, and a failed diagnosis just
   * means the normal widening ladder carries on.
   */
  private async diagnoseStuckSell(pos: Position): Promise<void> {
    const now = Date.now()
    if (this.opts.mode !== 'live' || pos.parked) return
    if (now - pos.lastDiagnosisAt < SELL_DIAGNOSE_MS) return
    pos.lastDiagnosisAt = now
    try {
      const [allowance, balance, curve] = await Promise.all([
        this.client.readContract({
          address: pos.token as Hex, abi: erc20Abi, functionName: 'allowance',
          args: [this.signer!.address, pos.curve as Hex],
        }) as Promise<bigint>,
        this.client.readContract({
          address: pos.token as Hex, abi: erc20Abi, functionName: 'balanceOf',
          args: [this.signer!.address],
        }) as Promise<bigint>,
        readCurve(pos.curve as Hex, this.client),
      ])
      // graduated first: a graduated curve cannot sell no matter what the allowance says
      if (curve.state.graduated || readyToGraduate(curve.params, curve.state)) {
        this.graduate(pos)
        return
      }
      // Then the balance, because the sell is built from pos.tokens and pos.tokens is what
      // the CurveBuy EVENT said, not what the wallet received. Those can differ (a token
      // that taxes the transfer in, a rounding in the curve's accounting), and when the
      // record is even one wei over, safeTransferFrom reverts on insufficient balance and
      // no slippage bound can help. Position 1438 was 0.26% over and sent 945 sells.
      if (balance === 0n) {
        pos.parked = true
        pos.stuck = true
        this.tel.health('exit', false,
          `${pos.token.slice(0, 12)} NO-TOKENS: record says ${pos.tokens}, wallet holds 0. `
          + 'nothing to sell. parked; check whether an earlier sell landed unseen')
        return
      }
      if (balance < pos.tokens) {
        this.tel.health('exit', false,
          `${pos.token.slice(0, 12)} record ${pos.tokens} but wallet holds ${balance}; `
          + 'selling what we hold')
        pos.tokens = balance
        // not a return: the allowance may ALSO be wrong, and the next attempt needs both
      }
      if (allowance === 0n) {
        this.tel.health('exit', false,
          `${pos.token.slice(0, 12)} sell reverting because allowance is 0, re-approving`)
        await this.approve(pos.token as Hex, pos.curve as Hex)
      }
    } catch (e) {
      this.tel.health('exit', false, `${pos.token.slice(0, 12)} diagnosis failed: ${String(e).slice(0, 60)}`)
    }
  }

  private async fireExit(pos: Position, reason: ExitReason): Promise<void> {
    if (pos.graduated) { await this.pumpGraduated(pos); return }
    // The ceiling. Checked before the increment so exactly maxSellAttempts go out. Parking
    // is what stops shouldRetry, so this is a single alert and then silence, not a loop
    // that logs 'stuck' on every tick. The row stays open; see Position.parked.
    if (pos.attempts >= STRATEGY.maxSellAttempts) {
      if (!pos.parked) {
        pos.parked = true
        pos.stuck = true
        this.tel.health('exit', false,
          `${pos.token.slice(0, 12)} EXHAUSTED after ${pos.attempts} sells, `
          + `$${((Number(pos.burnedGasWei) / 1e18) * RISK.ethUsd).toFixed(2)} of gas burned; `
          + 'parked, still holding. restart to retry after the diagnosis has corrected it')
      }
      return
    }
    pos.exiting = true
    pos.exitReason = reason
    pos.lastAttemptAt = Date.now()
    const attempt = pos.attempts++
    // bound comes from confirmed state so an optimistic error cannot book a bad fill
    const markConfirmed = this.opts.mode === 'shadow'
      ? this.state.markShadow(pos.curve, pos.tokens)
      : this.state.markConfirmed(pos.curve, pos.tokens)
    const minQuoteOut = minQuoteOutFor(markConfirmed, attempt)
    // keep the first estimate: comparing it to what the chain actually paid is how the
    // pilot measures the friction that shadow mode structurally cannot see
    if (pos.expectedProceeds === 0n) pos.expectedProceeds = markConfirmed

    if (this.opts.mode === 'observe') { this.settleExit(pos, markConfirmed, ''); return }

    const nonce = this.nonce!.reserve()
    const tx = buildSell({ curve: pos.curve as Hex, tokensIn: pos.tokens, minQuoteOut, recipient: this.signer!.address, nonce, chainId: robinhoodChain.id })
    const signed = await this.signer!.sign(tx)

    if (this.opts.mode === 'shadow') {
      this.nonce!.release(nonce)
      this.tel.latency('exit-decide', Date.now() - pos.lastAttemptAt, true, reason)
      this.settleExit(pos, markConfirmed, signed.hash)
      return
    }

    pos.sellInFlight = true
    pos.sellHash = signed.hash
    pos.sellSentAt = Date.now()
    this.simulation?.capture('sell-send',pos.token,{hash:pos.sellHash,attempt,reason,minQuoteOut,tokens:pos.tokens,decidedAt:pos.lastAttemptAt})
    const r = await this.tapedSend('sell', pos.token, signed, nonce)
    this.tel.latency('sell-send', r.ms, r.ok, reason)
    if (r.ok) {
      this.nonce!.settle()
      pos.sellHash = r.hash
      // deliberately do NOT close here: sequenced is not executed. the CurveSell event
      // (or the receipt, if the event is missed) is what closes a position.
    } else {
      pos.sellInFlight = false
      if (r.nonceConsumed) this.nonce!.settle()
      else {
        this.nonce!.rejected(nonce, r.error)
        // refused before sequencing: nothing burned, nothing used, so not an attempt
        // against the gas-bleed cap. Its own backoff, and a line on the first and every
        // tenth, so a refusing sequencer is visible without flooding. See Position.refusals.
        pos.attempts--
        pos.refusals++
        pos.retryNotBefore = Date.now() + Math.min(10_000, 500 * 2 ** Math.min(pos.refusals - 1, 5))
        if (pos.refusals === 1 || pos.refusals % 10 === 0) {
          this.tel.health('exit', false, `${pos.token.slice(0, 12)} sell refused by the sequencer (${pos.refusals}x): ${r.error.slice(0, 50)}; backing off, still holding`)
        }
        return
      }
      if (pos.attempts > 12 && !pos.stuck) {
        pos.stuck = true
        // never mark the row closed while we still hold tokens: recovery only looks at
        // open rows, so closing here would make the position invisible forever
        this.tel.health('exit', false, `${pos.token.slice(0, 12)} stuck after ${pos.attempts} attempts, still holding, still retrying`)
      }
    }
  }

  /** The one place a position is removed from the book. */
  private settleExit(pos: Position, proceeds: bigint, hash: string): void {
    if (!this.positions.has(pos.curve)) return // already settled; do not double-count
    // Zero proceeds while still holding tokens is not an exit, it is a position we could
    // not price. Booking it as a completed trade records a 100% loss that may not be real
    // and, worse, marks the row closed so recovery stops looking at it.
    if (proceeds === 0n && pos.tokens > 0n && this.opts.mode !== 'observe') {
      if (!pos.stuck) {
        pos.stuck = true
        this.tel.health('exit', false, `${pos.token.slice(0, 12)} unpriceable (curve graduated?), holding, still retrying`)
      }
      pos.sellInFlight = false
      // same question as a reverted sell, reached from the other direction: our own model
      // says the bag is worth nothing. ask the chain whether that is graduation.
      void this.diagnoseStuckSell(pos)
      return
    }
    const gas = this.gasBudgetWei()
    // burnedGasWei is what the reverted attempts cost on the way to this fill. It is
    // already in the live risk ledger (charged as each revert was seen), so it must NOT
    // go through risk.closed again below, but it does belong in the row's pnl_wei.
    const sunk = pos.burnedGasWei + (pos.preparationGasWei ?? 0n)
    const pnl = proceeds - pos.spendWei - gas - sunk
    this.tel.closePosition(pos.id, {
      // '' is not a hash: observe/shadow settle without one, and an empty string makes any
      // tool that joins on exit_hash ask the chain for it and get -32602 back
      exit_reason: pos.exitReason ?? 'manual', exit_at: Date.now(), exit_hash: hash || null,
      proceeds_wei: proceeds.toString(), expected_wei: pos.expectedProceeds.toString(),
      pnl_wei: pnl.toString(),
      hold_ms: Date.now() - pos.openedAt, tokens_held: pos.tokens.toString(),
      peak_mult: pos.entryMarkWei > 0n ? Number(pos.peakMarkWei) / Number(pos.entryMarkWei) : 0,
    })
    this.positions.delete(pos.curve)
    this.noteTemplateOutcome(pos, pnl + sunk)
    // A take profit fires well inside the hold, so untracking on exit would drop the
    // observation for exactly the launches that touched and bias the cohort toward misses.
    this.releaseCurve(pos.curve)
    this.risk.closed(pos.spendWei, pnl + sunk)   // burned gas was charged live
    this.truth?.enqueue(pos.id)
    this.stats.exited++
  }

  /**
   * Portfolio value: the book we started with, plus what we have realised, plus what the
   * open positions would fetch if we sold them right now. Marked to exit proceeds rather
   * than to a spot price, so it already carries our own impact on the way out.
   */
  private sampleEquity(): void {
    let unrealized = 0n
    for (const p of this.positions.values()) {
      if (!p.filled) continue
      unrealized += this.mark(p.curve, p.tokens) - p.spendWei
    }
    const start = BigInt(Math.round(STRATEGY.bankrollEth * 1e18))
    this.tel.equity({
      at: Date.now(), realized: this.risk.realizedPnlWei, unrealized,
      openN: this.positions.size, equity: start + this.risk.realizedPnlWei + unrealized,
    })
    // Store the same guard readings the operator sees, without extra RPC calls.
    try {
      const view = this.operatorReading(this.positions.size, null)
      this.tel.guardSample(Date.now(), view.guards, this.risk.haltKinds, this.opts.mode === 'live')
    } catch { /* telemetry must never interrupt position management */ }
  }

  /**
   * The strategy the bot is running, as the out-of-process graders read it.
   *
   * Published at boot AND on every applied config change. It used to be a boot-only
   * snapshot, which was fine while a number could only move by restarting; now that
   * config/store.ts can move one under a running bot, a stale strategy_json would have
   * gatewatch.py, recon.py, edgecheck.py and livewatch.cjs all quoting a book that is no
   * longer being traded, which is the exact failure the comment below warns about.
   */
  private strategySpec(): Record<string, string | number> {
    const scenario = this.executionScenarioPolicy()
    return {
      // the schedule, not a scalar. Published whole so a replay can reproduce which rung
      // any given launch got from gate.db's rate alone, without guessing the cuts.
      takeProfitSchedule: STRATEGY.takeProfit.schedule
        .map((r) => `<${r.below}:${r.multiple}`).join(' '),
      takeProfitOtherwise: STRATEGY.takeProfit.otherwise,
      takeProfitMaxRateAgeMs: STRATEGY.takeProfit.maxRateAgeMs,
      // the adaptive bar, published whole: gatewatch scores exactly these bars and no
      // others, so the bar set is owned here and read there, never duplicated
      takeProfitAdaptive: STRATEGY.takeProfit.adaptive.enabled ? 1 : 0,
      takeProfitAdaptiveWindow: STRATEGY.takeProfit.adaptive.window,
      takeProfitAdaptiveBars: STRATEGY.takeProfit.adaptive.bars.join(' '),
      maxHoldMs: STRATEGY.maxHoldMs,
      hardStopMultiple: STRATEGY.hardStopMultiple,
      // the dead-coin bailout, so recon can see the rule even though each row also pins
      // its own copy (positions.dead_after_ms / dead_below)
      deadCoinAfterMs: STRATEGY.deadCoin.afterMs,
      deadCoinBelowMult: STRATEGY.deadCoin.belowMult,
      minDevBuyWei: STRATEGY.book.minDevBuyWei.toString(),
      // the creator-tax band. The floor is the filter that carries the current edge, so
      // any replay that does not know it is scoring a different book than the one running.
      minCreatorTaxBps: STRATEGY.minCreatorTaxBps,
      maxCreatorTaxBps: STRATEGY.maxCreatorTaxBps,
      // The ENTRY ceiling, new 2026-09-15, and a different number from the screen bound
      // directly above it. A reader that knows only the floor cannot tell a 0-and-up book
      // from an untaxed-only one, and those are opposite policies.
      maxEntryTaxBps: STRATEGY.maxEntryTaxBps,
      // the 2026-09-06 entry filters (strategy/entry.ts). A replay that scores the whole
      // taxed cohort is scoring a book the bot is not trading.
      minExemptionsToEnter: STRATEGY.minExemptionsToEnter,
      maxEntryPriceMultiple: STRATEGY.maxEntryPriceMultiple,
      templateLossBlockMs: STRATEGY.templateLossBlockMs,
      // the template gate's thresholds, read by gatewatch.py the same way it reads the
      // regime gate's: from here, never from its own copy
      templateWindowMs: STRATEGY.book.templateGate.windowMs,
      templateMinObs: STRATEGY.book.templateGate.minObs,
      templateShutBelowPct: STRATEGY.book.templateGate.shutBelowPct,
      maxPriorLaunches: STRATEGY.book.maxPriorLaunches,
      minExemptions: STRATEGY.book.minExemptions,
      tradeSizeEth: STRATEGY.tradeSizeEth,
      gateWindow: STRATEGY.gate.window,
      gateOpenAt: STRATEGY.gate.openAt,
      gateShutAt: STRATEGY.gate.shutAt,
      // the gate's own bar, published separately from takeProfitMultiple on purpose so
      // gatewatch.py stops inheriting the exit policy as its measuring stick
      gateTouchMultiple: STRATEGY.gate.touchMultiple,
      // likewise the observation window: gatewatch used to derive its HOLD from
      // maxHoldMs, which let an exit-clock change resize the gate's ruler
      gateHoldMs: STRATEGY.gate.holdMs,
      // the kill switch, so out-of-process monitors stop carrying their own copy of it.
      // livewatch.cjs alarmed at a hardcoded -$45 and printed "against the -$75 stop"
      // while the real limit had been $100 since 2026-08-19: a monitor quoting a bound
      // the bot is not running is worse than one that stays quiet. In ETH since
      // 2026-09-07, so a monitor cannot re-introduce the stale-price coupling either.
      maxDrawdownEth: RISK.maxDrawdownEth,
      // and the ETH price, for the same reason: it is fetched hourly now, so a monitor
      // holding its own copy would report a different dollar figure for the same trade.
      // chain_truth.eth_usd carries it with a timestamp; this is the current value.
      ethUsd: RISK.ethUsd,
      // the P&L sensor, published for the same reason as the gate's own numbers above:
      // gatewatch prints the sum the bot is deciding on, and must not keep its own copy
      // of the window or the bar it is summed at
      venuePauseWindow: scenario?.n ?? STRATEGY.gate.pnlPauseWindow,
      venuePauseOff: scenario?.off ?? STRATEGY.gate.pnlPauseOff,
      venuePauseOn: scenario?.fullOn ?? STRATEGY.gate.pnlPauseOn,
      venueFreshMs: scenario?.ageMs ?? STRATEGY.gate.pnlFreshMs,
      venueBar: STRATEGY.gate.pnlBar,
      venueIndicator: liveConfig().venueExecutionScenarios ? 'conservative-paper' : liveConfig().venueFreshRecovery ? 'adaptive-shadow' : 'fixed-bar',
      venueRecoveryPolicy: liveConfig().venueExecutionScenarios ? this.scenarioController?.release?.policy.id ?? 'unverified-scenario-release' : liveConfig().venueFreshRecovery ? FRESH_POLICY.id : 'legacy',
      venueRecoveryWindow: scenario?.m ?? (liveConfig().venueFreshRecovery ? FRESH_POLICY.recoveryWindow : STRATEGY.gate.pnlPauseWindow),
      venueRecoveryOn: scenario?.freshOn ?? (liveConfig().venueFreshRecovery ? FRESH_POLICY.recoverAbove : STRATEGY.gate.pnlPauseOn),
      ddResumeWindow: STRATEGY.gate.ddResumeWindow,
      ddResumeOn: STRATEGY.gate.ddResumeOn,
      brokenGapPp: RISK.brokenGapPp,
    }
  }

  /**
   * A config file change has been read and validated. Move everything that follows from it.
   *
   * The store has already swapped the snapshot, so the new values are live by the time this
   * runs; what is left is the consequences. Deliberately NOT among them: clearing a halt.
   * Raising MAX_DRAWDOWN_USD while the drawdown stop is holding moves the number and leaves
   * the halt exactly where it is, because the stop not lifting itself is the whole reason
   * the regime gate is allowed to resume on its own, and a file edit is not a decision to
   * put money back to work.
   */
  onConfigReload(r: ReloadResult): void {
    if (r.errors.length) {
      for (const e of r.errors) console.error(`config REFUSED: ${e}`)
      console.error(`config: nothing applied, still running the previous values`)
      this.tel.health('config', false, r.errors.join('; '))
      return
    }
    if (!r.applied.length && !r.pending.length) return
    this.simulation?.capture('control','settings',{haltKinds:[...this.risk.haltKinds],config:this.shadowConfig(),strategy:this.strategySpec(),entryHours:[]})
    if (r.applied.some(c => ['VENUE_EXECUTION_SCENARIOS', 'VENUE_FRESH_RECOVERY', 'TRADE_SIZE_ETH', 'BANKROLL_ETH'].includes(c.env))) {
      if (r.applied.some(c => c.env === 'VENUE_EXECUTION_SCENARIOS')) this.scenarioController = null
      this.ensureShadow()
      if (liveConfig().venueExecutionScenarios) { this.scenarioController?.pause(Date.now()); this.checkVenue() }
      if (liveConfig().venueFreshRecovery) { this.shadow?.pause(Date.now()); this.checkVenue() }
    }

    const open = this.positions.size
    for (const c of r.applied) {
      const scope = c.applies === 'per-trade'
        ? `new entries only${open ? `, ${open} open position(s) keep theirs` : ''}`
        : 'applies now'
      console.log(`config: ${c.env} ${c.from} -> ${c.to} (${scope})`)
    }
    for (const c of r.pending) {
      console.warn(`config: ${c.env} ${c.from} -> ${c.to} in the file, but it is captured at startup. NOT applied; restart to take it.`)
    }

    if (r.applied.length) {
      // The out-of-process graders read the strategy from chain_truth, so republish it in
      // the same breath: a monitor quoting a bound the bot is not running is worse than one
      // that stays quiet.
      try { this.truth?.publishStrategy(this.strategySpec()) } catch {}
      this.recordConfigChange(r)
      this.tel.health('config', true, r.applied.map((c) => `${c.env} ${c.from}->${c.to}`).join(', '))
    }

    // HALT=1 applies live; HALT=0 does not. Stopping is always safe and the operator may
    // need it in a hurry. Resuming is a money decision, asked for on its own, so a file
    // edit only reports that it wants one. 'manual' is not caller-liftable anyway.
    if (r.applied.some((c) => c.env === 'HALT')) {
      if (liveConfig().halt) this.risk.halt('halted by operator (HALT=1)', 'manual')
      else if (this.risk.isHalted('manual')) {
        console.warn('config: HALT=0 in the file. Resuming is a money decision and needs a restart; entries stay off.')
      }
    }
  }

  /**
   * Append to chain_truth.filter_changes, the audit channel gatehistory.ts documents and
   * the dashboard already reads. It has been written by hand until now, which is why the
   * chart could show a seam only when somebody remembered to record one.
   */
  private recordConfigChange(r: ReloadResult): void {
    try {
      const prev = JSON.parse(this.tel.truthGet('filter_changes') ?? '[]') as unknown[]
      const row = this.tel.raw().prepare('SELECT MAX(id) m FROM positions').get() as { m: number | null }
      prev.push({
        afterPositionId: row?.m ?? 0,
        at: r.at,
        change: r.applied.map((c) => `${c.env} ${c.from} -> ${c.to}`).join('; '),
      })
      // keep the tail: this is a seam marker for the chart, not a ledger
      this.tel.truthSet('filter_changes', JSON.stringify(prev.slice(-200)))
    } catch (e) {
      console.error(`config: could not record the change: ${(e as Error).message}`)
    }
  }

  /**
   * Periodic maintenance on the cold path: refresh the fee cap from the chain, and repair
   * the nonce counter while nothing is in flight. Without the resync, a transport failure
   * that we conservatively treated as "sequenced" would leave the counter one ahead
   * forever, and every subsequent send would be rejected.
   */
  /**
   * One sample of what the machine has left. Written to `health` only when the verdict
   * CHANGES: that table has no retention, and a row every thirty seconds saying the same
   * thing is how a disk-space check becomes a disk-space problem.
   */
  private sampleResources(): void {
    try {
      const path = dirname(this.opts.dbFile ?? 'data/bot.db')
      this.resources = { at: Date.now(), path, disk: diskFree(path), memTotalBytes: memTotal(),
        rss: { main: rssOf(process.pid), simulation: rssOf(this.simulation?.pid() ?? null), shadow: rssOf(this.shadow?.pid() ?? null) } }
      const level = resourceLevel(this.resources)
      if (level !== this.lastResourceLevel) {
        this.lastResourceLevel = level
        this.tel.health('resources', level === 'ok', resourceDetail(this.resources))
      }
    } catch { /* a watchdog must not be able to stop the thing it watches */ }
  }

  private async housekeeping(): Promise<void> {
    // The gate first, and before anything that touches the network. It is a local sqlite
    // read that cannot block, while getGasPrice and resyncIfIdle are RPC calls on a
    // 30s timeout that viem retries three times. On 2026-08-18 23:00 the RPC was serving
    // 429s, both calls sat there, and the bot traded for 3m32s with the gate already shut
    // for thirteen minutes. A safety check that goes offline exactly when the venue is
    // degraded is not a safety check, so it runs before the things that can hang.
    //
    // The UTC rollover goes FIRST, above even the gate. It restores the drawdown stop's
    // self-lift budget, and a halted, flat bot closes nothing, so a rollover reached only
    // through closed() would never run while it mattered. Polling it here is what stops
    // the budget from being spent once and never returning -- and it sits above the RPC
    // calls for the same reason the gate does.
    if (this.risk.rollDay(Date.now())) {
      console.error('\nUTC day rolled over: the drawdown stop may lift itself twice again today.')
    }
    this.checkRegimeGate()
    // Both of these are local sqlite reads and, for the resume, one local write. They sit
    // here for the same reason the gate does: above everything that can hang. The order
    // between them matters -- checkBroken can place the halt that outranks the drawdown,
    // so it runs BEFORE the drawdown is allowed to lift itself, never after.
    this.checkBroken()
    this.refreshRecoveryReading()
    this.checkDrawdownResume()
    this.refreshTemplateBlocklist()
    this.checkPaperCollection()
    this.recordHaltState()
    // Local file reads, microseconds, and they belong above the RPC calls for the reason the
    // gate does: the box running out of disk or memory is exactly when the network calls
    // below start hanging, and a check that goes quiet then is not a check.
    this.sampleResources()
    // Display prices must not delay fee, nonce or accounting checks. PriceFeed owns
    // its hourly schedule and overlap guard; contain unexpected publication failures too.
    void this.refreshPrice().catch(() => {})
    try {
      const fee = await this.client.getGasPrice()
      setBaseFee(fee)
    } catch {}
    if (this.nonce && this.positions.size === 0) {
      await this.nonce.resyncIfIdle().catch(() => false)
    }
    await this.truth?.tick()
  }

  /**
   * Write halt transitions to the health table so the dashboard can shade when the bot
   * was actually stopped.
   *
   * Polled here rather than hooked into RiskManager.halt() on purpose: this path already
   * runs every 30s, and reading a boolean cannot affect the halt decision, whereas a
   * callback inside the risk manager puts telemetry on the trading path. Every halt source
   * (regime gate, daily cap, drawdown stop, operator HALT=1) lands in the same set, so
   * watching the set catches all of them. The first tick records the boot state, which is
   * how an operator halt applied before start() gets captured.
   *
   * Edge-triggered on the whole active SET, not on the boolean it used to watch. Two kinds
   * can be live at once now -- a daily cap and a shut venue -- and a boolean misses the
   * transition where the second lands on top of the first. That matters because this row's
   * detail is the label the chart shades the halted span with (gatehistory.haltIntervals),
   * so a boolean would caption the span with a reason that had already been superseded.
   */
  private lastHaltSeen: string | null = null
  private recordHaltState(): void {
    const key = this.risk.haltKinds.join('+')
    if (key === this.lastHaltSeen) return
    this.lastHaltSeen = key
    this.simulation?.capture('control','halts',{haltKinds:[...this.risk.haltKinds],config:this.shadowConfig(),strategy:this.strategySpec(),entryHours:[]})
    const halted = this.risk.halted
    this.tel.health('halt', !halted, halted ? `[${key}] ${this.risk.haltReason}` : 'armed')
  }

  /**
   * Follow the venue in both directions: stop buying when it stops paying, start again
   * when it comes back. See strategy/gate.ts for why this is now two-way.
   *
   * Halt and resume run on the same rule and the same clock: a reading that says open
   * resumes on the spot, exactly as a reading that says shut halts on the spot. What stops
   * a single lucky scoring round from restarting us is not a timer but the hysteresis
   * band, which demands openAt (25) to reopen while staying open needs only shutAt (10).
   *
   * It can only ever lift a halt the gate itself placed. A drawdown stop or HALT=1 stays
   * exactly where it is no matter what the venue does.
   */
  /**
   * The last gate reading and when it was taken, so choosing a take-profit rung at entry
   * costs nothing. checkRegimeGate() already runs on every settled observation and every
   * 30s housekeeping tick, which is far inside STRATEGY.takeProfit.maxRateAgeMs; doing the
   * read on the entry path instead would put three prepared statements on the hot path
   * that decides a buy, and this project has already lost 3.5 minutes of gate visibility
   * to blocking I/O in a hot path once.
   *
   * Stays null until the first read lands, which is the correct answer at boot: unknown
   * regime takes the coldest rung.
   */
  private lastGate: { reading: GateReading; at: number } | null = null
  /** the adaptive take profit's window, refreshed on the same tick as lastGate; see pickTakeProfit */
  private lastBars: { rows: ReadonlyArray<BarOutcomes>; at: number } | null = null

  /** Read the same cached inputs as the next entry; never refresh a sensor from the page. */
  takeProfitReading(now = Date.now()) {
    const decision = this.pickTakeProfit(now)
    const a = STRATEGY.takeProfit.adaptive
    if (liveConfig().venueExecutionScenarios) {
      const snapshot = this.simulation?.paperStatus?.selector
      const selected = selectSharedTarget(snapshot, simulationDigest(this.shadowConfig()), now, this.simulation?.paperStatus?.at ?? 0, STRATEGY.takeProfit)
      return { ...selected, adaptive: a.enabled, n: snapshot?.rows.length ?? 0, window:a.window,
        at:snapshot?.publicationAt ?? null, fresh:selected.ready, modelHash:snapshot?.modelHash,
        scores:a.bars.map(bar=>({bar,sum:selected.ready?snapshot.rows.reduce((sum:number,row:BarOutcomes)=>sum+row[barKey(bar)]!,0):null})) }
    }
    const cached = this.lastBars
    const fresh = !!cached && now >= cached.at && now - cached.at <= STRATEGY.takeProfit.maxRateAgeMs
    const rows = fresh ? cached!.rows.slice(0, a.window) : []
    return { ...decision, adaptive: a.enabled, n: rows.length, window: a.window,
      at: cached?.at ?? null, fresh,
      scores: a.enabled ? a.bars.map(bar => ({ bar, sum: rows.length ? rows.reduce((sum, row) => {
        const value = row[barKey(bar)]
        return sum + (Number.isFinite(value) ? value! : 0)
      }, 0) : null })) : [] }
  }

  /**
   * The rung this launch gets, and why, for the log. Every not-knowing (no reading, a
   * stale one, a short window, an old cache) resolves to the coldest rung inside
   * takeProfitFor; see strategy/takeprofit.ts for why that direction is not negotiable.
   */
  private pickTakeProfit(now: number): { multiple: number; why: string } {
    // The adaptive bar first. It reads a cache refreshed off the hot path, exactly as the
    // gate rate does, so this stays a pure function of memory. Every way of not knowing
    // (no rows, a short window, a reading older than maxRateAgeMs) falls through to the
    // FIXED bar via `otherwise`, never to the hottest rung: unknown means the flat bar.
    const a = STRATEGY.takeProfit.adaptive
    if (a.enabled) {
      if (liveConfig().venueExecutionScenarios) return selectSharedTarget(this.simulation?.paperStatus?.selector,
        simulationDigest(this.shadowConfig()), now, this.simulation?.paperStatus?.at ?? 0, STRATEGY.takeProfit)
      const b = this.lastBars
      const fresh = b && now - b.at >= 0 && now - b.at <= STRATEGY.takeProfit.maxRateAgeMs
      return adaptiveTakeProfit(fresh ? b.rows : null, a.window, a.bars, STRATEGY.takeProfit.otherwise)
    }
    const g = this.lastGate
    return takeProfitFor(
      g ? { rate: g.reading.rate, n: g.reading.n, ageMs: now - g.at, stale: !!g.reading.stale } : null,
      STRATEGY.gate.window,
    )
  }

  /**
   * The template gate's merged blocklist: STRATEGY seed plus whatever gatewatch last
   * published into gate.db. Cached for 30s because screening runs per launch and the
   * published list only changes on the watcher's five-minute pass. A read with no
   * opinion (fresh box, watcher not yet run) keeps the LAST merged list rather than
   * clearing it: an absent watcher unblocks nothing, and the seed is always in.
   */
  private templateBlocked: ReadonlySet<string> = new Set(STRATEGY.book.templateGate.seed)
  /** template key -> when its last real losing trade closed (STRATEGY.templateLossBlockMs) */
  private templateLossAt = new Map<string, number>()
  private noteTemplateOutcome(pos: Position, pnlWei: bigint): void {
    if (!pos.templateKey || pnlWei >= 0n) return
    this.templateLossAt.set(pos.templateKey, Date.now())
    if (this.templateLossAt.size > 2_000) {
      const cut = Date.now() - STRATEGY.templateLossBlockMs
      for (const [k, t] of this.templateLossAt) if (t < cut) this.templateLossAt.delete(k)
    }
  }
  /** the blocks a restart must not forget: real losing closes inside the window, from the db */
  private seedTemplateLosses(): void {
    try {
      const rows = this.tel.raw().prepare(
        `SELECT p.exit_at at, l.creator_tax_bps tax, l.dev_buy_wei dev, l.exemptions ex FROM positions p
         JOIN launches l ON l.token = p.token
         WHERE p.live = 1 AND p.closed = 1 AND p.buy_ok = 1 AND p.exit_at >= ?
           AND COALESCE(p.cohort, 'main') = 'main' AND p.exit_reason NOT IN (${NON_TRADE_SQL})
           AND CAST(COALESCE(p.onchain_pnl_wei, p.pnl_wei, '0') AS REAL) < 0`,
      ).all(Date.now() - STRATEGY.templateLossBlockMs) as Array<{ at: number; tax: number; dev: string; ex: number | null }>
      for (const r of rows) {
        const k = templateKey(BigInt(r.tax), BigInt(r.dev ?? '0'), r.ex)
        if ((this.templateLossAt.get(k) ?? 0) < r.at) this.templateLossAt.set(k, r.at)
      }
    } catch { /* an unreadable table blocks nothing, which is the pre-rule behaviour */ }
  }

  /**
   * Pull the published blocklist into memory. Called from housekeeping, NEVER from
   * screening.
   *
   * This used to be a lazily-refreshed getter called inline by screenCurve, so once every
   * 30s a launch paid for a synchronous better-sqlite3 read of gate.db in the middle of the
   * entry decision. gate.db is written by a separate process under WAL, and the entry
   * budget is about two seconds that the surrounding code already works to shave 100-300ms
   * off. A once-per-30s cost is small on average and lands entirely on one unlucky launch,
   * which is the worst possible distribution for it.
   *
   * Housekeeping already runs on a 30s timer and already does exactly this kind of local
   * sqlite read (checkRegimeGate) off the hot path, so the refresh belongs there and
   * screening gets an already-populated Set.
   *
   * A read with no opinion (fresh box, watcher not yet run) keeps the LAST merged list
   * rather than clearing it: an absent watcher unblocks nothing, and the seed is always in.
   */
  private refreshTemplateBlocklist(): void {
    try {
      const pub = this.gate.templateBlock()
      if (pub) this.templateBlocked = new Set([...STRATEGY.book.templateGate.seed, ...pub.values])
    } catch {
      // an unreadable list must not take screening down; the last list stands
    }
  }

  private checkRegimeGate(): void {
    const reading = this.gate.read(STRATEGY.gate.window, STRATEGY.gate.openAt, STRATEGY.gate.shutAt)
    // cache before anything can throw: a halt path that fails must not also freeze the
    // rate the take profit reads, and a null reading must CLEAR it rather than leave a
    // stale rate looking fresh
    this.lastGate = reading ? { reading, at: Date.now() } : null
    // the adaptive bar's window rides the same tick: one sqlite read, cached, off the
    // hot path. A null read clears the cache so a stale window cannot look fresh.
    try {
      const rows = !liveConfig().venueExecutionScenarios && STRATEGY.takeProfit.adaptive.enabled ? this.gate.readBars(STRATEGY.takeProfit.adaptive.window) : null
      this.lastBars = rows ? { rows, at: Date.now() } : null
    } catch { this.lastBars = null }
    // Publish what the BOT actually decided on. The dashboard replays gate.db itself, and
    // since 2026-08-19 that file is no longer what halts us -- the in-process ring is. A
    // page showing a different gate than the one stopping trades is worse than no page.
    try {
      const common = {
        at: Date.now(), halted: this.risk.halted, haltKind: this.risk.haltKind, haltKinds: this.risk.haltKinds,
        // the P&L sensor rides the same row: one place to read what the bot decided on
        venue: this.lastVenue?.reading ?? null,
      }
      this.tel.truthSetQueued('gate_live_json', JSON.stringify(
        reading ? { ...reading, ...common } : { ...common, reading: null }))
    } catch {}
    // its OWN halt, not the bot's: a shut venue must be recorded even while a daily cap or
    // a drawdown stop is holding us, or nothing remembers the venue shut when that lifts
    const action = gateAction({ reading, gateHalted: this.risk.isHalted('gate') })
    if (action.do === 'halt') {
      this.risk.halt(action.why, 'gate')
      this.tel.health('gate', false, action.why)
      console.error(`\n${action.why}. entries off; open positions will still be sold.`)
    } else if (action.do === 'resume' && this.risk.resume('gate')) {
      this.tel.health('gate', true, action.why)
      console.error(`\n${action.why}. entries back on.`)
    }
    if (!liveConfig().venueFreshRecovery && !liveConfig().venueExecutionScenarios) this.checkVenue()
  }

  /**
   * THE VENUE PAUSE. The same two-way decision as the touch gate above, on the sensor that
   * measures the venue in money instead of touches (strategy/gate.ts readVenue).
   *
   * Its own halt kind on purpose. The two sensors disagree by design -- a venue can be
   * touching 1.21x on half its launches while the exit rule loses money on them, which is
   * the 2026-08-28 pattern that no touch-based sensor could see -- and a shared kind would
   * let whichever recovered first lift the other's pause.
   */
  /**
   * Refresh the ETH price at most hourly and publish it where the monitors read.
   *
   * `chain_truth.eth_usd` rather than the .env file, deliberately. Writing the file would
   * have been fewer moving parts, but config/store.ts watches it and would treat every
   * hourly price as an operator config change: a `filter_changes` seam in the ledger, a
   * bumped `changedAt` on the page, and a line in `report` every hour saying somebody
   * edited the config. A published row is what the other monitors already read for the
   * epoch base and the strategy, so it is also the shape they expect.
   */
  private async refreshPrice(): Promise<void> {
    // ETHUSD is hot, so an operator edit to the seed should show up while no fetch has
    // landed yet. It never overrides a real fetch; see PriceFeed.reseed.
    this.price.reseed(RISK.ethUsd)
    const moved = await this.price.refresh()
    if (!moved) return
    try {
      this.tel.truthSet('eth_usd', String(moved.usd))
      this.tel.truthSet('eth_usd_at', String(moved.at))
    } catch { /* a busy database costs one hour of freshness, never the tick */ }
    console.log(`ETH price ${moved.usd} (${moved.source})`)
  }

  /**
   * Re-place every halt that was in force when the process last went down. Called from
   * index.ts before start(), so they are in place before the first launch is screened.
   *
   * Never the reverse: nothing here LIFTS a halt. At this point nothing is halted anyway,
   * and clearing halts at boot is how a bot un-halts itself by accident. Each kind is
   * re-derived from its own source within a tick of start() (the gate and the venue on the
   * housekeeping tick, 'manual' from the file); this covers the gap between the first
   * launch and that tick, which is the gap 'drawdown' and 'broken' fall into because
   * neither re-fires until the next close.
   *
   * It ASSERTS rather than trusts. A restore that silently placed fewer halts than the row
   * held is the exact failure this method exists to prevent, so the two sets are compared
   * and a mismatch is a loud health row, not a log line nobody reads.
   */
  restoreHaltState(): void {
    const stored = this.tel.truthGet('operator_stop')
    if (this.tel.truthGet('operator_recovery') === '1') {
      this.operatorRecoveryPending = true
      this.risk.halt('waiting for market recovery after operator resume', 'venue')
    }
    if (stored === '1') {
      this.risk.halt('halted by operator: stopped from the dashboard before this restart', 'stopped')
      console.error('\noperator STOP restored from the last session. start from the dashboard when ready.')
    }

    const want = readHalts(this.tel.raw())
    const placed = this.risk.restoreHalts(want)
    const missing = want.filter((h) => !this.risk.isHalted(h.kind)).map((h) => h.kind)
    if (missing.length) {
      // Unreachable by construction: restoreHalts places every durable record it is given.
      // It is checked anyway because the cost of being wrong here is a known-broken bot
      // trading at full size, and the cost of the check is one array comparison per boot.
      this.tel.health('halt', false, `halt restore incomplete: ${missing.join('+')} was stored and is not in force`)
    }
    if (placed.length) {
      console.error(`\nhalts restored from the last session: ${placed.join('+')}.`
        + ` ${want.filter((h) => placed.includes(h.kind)).map((h) => `${h.kind}: ${h.reason}`).join('; ')}`)
    }
  }

  /**
   * THE OPERATOR'S STOP, from the dashboard. Placed under its own kind so the file's
   * HALT=1 stays one-way; see strategy/risk.ts HaltKind for why the two are separate.
   *
   * PERSISTED, and that is the part worth arguing about. A stop the operator has to
   * remember to re-apply after every pm2 restart and every box reboot is not a stop: the
   * bot would come back trading, quietly, at whatever hour the process happened to
   * restart. The row is the record; boot reads it before the first entry (see start()).
   */
  operatorStop(why: string): void {
    this.risk.halt(`halted by operator: ${why}`, 'stopped')
    try { this.tel.truthSet('operator_stop', '1') } catch {}
    this.tel.health('operator', false, why)
    this.recordHaltState()
    console.error(`\noperator STOP: ${why}. entries off; open positions will still be sold.`)
  }

  /**
   * THE DRAWDOWN RESET, from the dashboard. Same transaction the hand tool runs
   * (scripts/newepoch.ts -> telemetry/epoch.ts), and same one the self-lift runs, but
   * in-process so it needs NO restart: openEpoch moves epochBaseId in memory before it
   * returns, which is the only reason the command-line version has to bounce pm2.
   *
   * It exists because the automatic lift refuses exactly when a person is most likely to
   * be standing there wanting it -- a third stop in a UTC day, or a stop that was sitting
   * under the operator's own stop -- and the only remedy was an ssh session. That is the
   * same argument that put STOP on the page in the first place.
   *
   * Two things it does not do. It does not resume trading: the reset clears what the stop
   * MEASURES, and every other guard still gets its say afterwards (which is why the reply
   * quotes the halt kind that is left, if any). And it cannot punch through 'broken' or
   * 'manual', because risk.liftByOperator's rank check refuses those.
   */
  operatorReset(why: string): string {
    if (!this.truth) return 'no accounting store: nothing to reset'
    // Flat in memory first. newEpoch re-checks the database, which is the authority (a row
    // can be open there while the map is empty), but this catches a buy in flight that has
    // reserved capacity and has no row yet.
    if (this.positions.size > 0 || this.risk.openCount > 0) {
      return `${this.positions.size || this.risk.openCount} open position(s): reset while flat`
    }
    const held = this.risk.haltKind
    if (held && held !== 'drawdown') return `${held} is holding: reset the drawdown once that clears`
    let seeded: { realized: bigint; peak: bigint; day: bigint }
    try {
      seeded = this.truth.openEpoch(`operator reset: ${why}`)
    } catch (e) {
      const msg = String((e as Error).message ?? e)
      this.tel.health('drawdown', false, `operator reset blocked: ${msg}`)
      return `reset refused: ${msg}`
    }
    this.risk.seedLedger(seeded)
    this.simulation?.capture('control','epoch',{resetDrawdown:true})
    const lifted = this.risk.liftByOperator('drawdown', why)
    this.tel.health('drawdown', true, `operator reset: ${why}`)
    this.recordHaltState()
    console.error(
      `\noperator RESET: ${why}. new epoch, both stops from zero;`
      + ` the chain baseline re-records at the next flat sample.`
      + (lifted ? ' drawdown stop lifted.' : ' no drawdown stop was holding.'),
    )
    return this.risk.halted
      ? `Drawdown reset to zero; entries still paused: ${this.risk.haltReason}`
      : 'Drawdown reset to zero; entries back on'
  }

  /** Return control to the automatic guards, with a new market recovery check. */
  operatorStart(why: string): string {
    if (!this.risk.isHalted('stopped')) return 'automatic operation already requested'
    if (this.risk.haltKind !== 'stopped') return `${this.risk.haltKind} is still holding`
    // Persist both sides together. A crash must restore either the manual stop or the
    // recovery wait. A failed write leaves the manual stop in place.
    this.tel.raw().transaction(() => {
      this.tel.truthSet('operator_recovery', '1')
      this.tel.truthSet('operator_stop', '0')
    })()
    this.operatorRecoveryPending = true
    this.risk.halt('waiting for market recovery after operator resume', 'venue')
    this.risk.resume('stopped')
    this.shadow?.pause(Date.now())
    this.scenarioController?.pause(Date.now())
    // Synchronous: no launch can enter between clearing the manual stop and checking
    // both market guards. Missing readings leave the recovery wait in place.
    this.checkRegimeGate()
    if (liveConfig().venueFreshRecovery || liveConfig().venueExecutionScenarios) this.checkVenue()
    const result = this.risk.halted
      ? `Automatic operation requested; entries paused: ${this.risk.haltReason}`
      : 'Automatic operation enabled; recovery checks passed'
    this.tel.health('operator', true, `${why}. ${result}`)
    this.recordHaltState()
    console.error(`\noperator RESUME AUTO: ${result}.`)
    return result
  }

  /** what the price feed last said, for the dashboard */
  priceReading(): { usd: number; ageMs: number | null; source: string; error: string | null } {
    return {
      usd: this.price.reading().usd,
      ageMs: this.price.ageMs(),
      source: this.price.reading().source,
      error: this.price.lastError,
    }
  }

  private lastVenue: { reading: VenueReading; at: number } | null = null
  private operatorRecoveryPending = false
  /**
   * The entry bounds strategy/entry.ts applies (the tax band, exempt wallets), handed to the
   * sensors so they count only launches the bot would have bought. The same numbers
   * strategySpec() publishes, so gatewatch's status line and the bot agree on the set.
   */
  private bookFloors(): BookFloors {
    return { minTaxBps: STRATEGY.minCreatorTaxBps, maxTaxBps: STRATEGY.maxEntryTaxBps, minExempt: STRATEGY.minExemptionsToEnter }
  }

  /**
   * Say out loud whether the paper collector is still collecting.
   *
   * It was already measured and the answer went nowhere: `paperHealth` was reachable only
   * through `dashboardPaper`, which nothing has called, so the 20-minute measurement freeze
   * on 2026-09-16 happened under a health check that could not report it. A sensor whose
   * reading no channel carries is not a sensor.
   *
   * Reported under the existing 'shadow' component rather than a new one, because a new
   * alert id needs adding to both banner allowlists and this is the same subject the
   * component already covers. Three local sqlite reads on the 30s housekeeping tick, which
   * is where every other local read of this shape already lives, never on the entry path.
   *
   * It NEVER halts. Collection is measurement, and wiring a measurement failure to a money
   * halt is the defect that stopped this bot for 23.8 hours.
   */
  private checkPaperCollection(): void {
    try {
      const h = paperHealth(this.tel.raw(), Date.now(), this.bookFloors())
      if (!h.stalled) { this.tel.health('shadow', true, `collecting; ${h.pending} pending`); return }
      const why = h.fault ? `collector fault: ${h.fault}`
        : h.missing > 0 ? `${h.missing} launch(es) in the book were never enqueued`
        : `${h.pending} job(s) stuck over 180s`
      this.tel.health('shadow', false, why)
    } catch (e) {
      this.tel.health('shadow', false, `paper collection unreadable: ${String(e)}`)
    }
  }
  private checkVenue(): void {
    let reading: VenueReading | null = null
    try {
      if (liveConfig().venueExecutionScenarios) {
        this.ensureShadow()
        const selector = selectSharedTarget(this.simulation?.paperStatus?.selector, simulationDigest(this.shadowConfig()), Date.now(), this.simulation?.paperStatus?.at ?? 0, STRATEGY.takeProfit)
        const observer = this.simulation?.paperStatus?.scenarioObserver
        const evidence = observer && !selector.ready ? {...observer,complete:false,failure:selector.failure} : observer
        const value = this.scenarioController!.check(evidence ?? null, simulationDigest(this.shadowConfig()), Date.now(), this.simulation?.paperStatus?.at ?? 0)
        const scores = value.scenarios
        reading = { source: 'conservative-paper', state: value.state, reason: value.reason,
          sum: value.sumRange?.[0] ?? 0, recentSum: value.recentSumRange?.[0] ?? 0,
          sumRange: value.sumRange, recentSumRange: value.recentSumRange,
          n: scores.length ? Math.min(...scores.map(s => s.n)) : 0,
          fresh: value.verified && scores.every(s => s.fresh), oldestAgeMs: scores.length ? Math.max(...scores.map(s => s.oldestAgeMs)) : 0,
          verified: value.verified, observerError: value.observerError, configId: value.configId, publicationAt: value.publicationAt,
          outcomes: (observer?.tapes.find((t:any)=>t.id==='p50-after')?.outcomes??[]).filter((o:any)=>o.available<=Date.now()).sort((a:any,b:any)=>b.block-a.block||b.token.localeCompare(a.token)).slice(0,value.policy.n).map((o:any)=>({token:o.token,value:o.value,launchedAt:o.launched/1000})),
          recentOutcomes: (observer?.tapes.find((t:any)=>t.id==='p50-after')?.outcomes??[]).filter((o:any)=>o.available<=Date.now()&&Date.now()-o.launched<=value.policy.ageMs).sort((a:any,b:any)=>b.launched-a.launched||b.token.localeCompare(a.token)).slice(0,value.policy.m).map((o:any)=>({token:o.token,value:o.value,launchedAt:o.launched/1000})),
          bar: 'adaptive', policyId: value.policy.id, window: value.policy.n, recoveryWindow: value.policy.m,
          pauseBelow: value.policy.off, recoveryOn: value.policy.freshOn, recoveryMode: value.policy.mode, fullRecoveryOn: value.policy.mode === 'fresh' ? undefined : value.policy.fullOn }
      } else if (liveConfig().venueFreshRecovery) {
        reading = this.shadow?.read(Date.now()) ?? null
        if (reading && (!reading.fresh || reading.verified === false || reading.observerError)) reading = { ...reading, state: 'shut' }
        if (!reading) this.risk.halt('adaptive shadow observer unavailable', 'venue')
      } else {
        reading = this.gate.readVenue({ window: STRATEGY.gate.pnlPauseWindow, off: STRATEGY.gate.pnlPauseOff,
          on: STRATEGY.gate.pnlPauseOn, freshMs: STRATEGY.gate.pnlFreshMs, bar: barKey(STRATEGY.gate.pnlBar),
          book: this.bookFloors(), requireRecovery: this.operatorRecoveryPending })
      }
    } catch (e) {
      if (liveConfig().venueFreshRecovery || liveConfig().venueExecutionScenarios) this.risk.halt(`shadow guard unavailable: ${String(e)}`, 'venue')
      reading = null
    }
    this.lastVenue = reading ? { reading, at: Date.now() } : null
    const action = venueAction({ venue: reading, venueHalted: this.risk.isHalted('venue') })
    if (action.do === 'halt') {
      this.risk.halt(action.why, 'venue')
      this.tel.health('venue', false, action.why)
      console.error(`\n${action.why}. entries off; open positions will still be sold.`)
    } else if (action.do === 'resume' && this.risk.haltKind === 'venue') {
      // Clear the durable wait only when every higher-priority stop has cleared.
      // If persistence fails, entries remain halted and the next check can retry.
      if (this.operatorRecoveryPending) this.tel.truthSet('operator_recovery', '0')
      if (!this.risk.resume('venue')) return
      this.operatorRecoveryPending = false
      this.tel.health('venue', true, action.why)
      console.error(`\n${action.why}. entries back on.`)
    }
  }

  /** what the venue sensor last said, for the dashboard */
  venueReading(): (VenueReading & { ageMs: number }) | null {
    const v = this.lastVenue
    return v ? { ...v.reading, ageMs: Date.now() - v.at } : null
  }

  executionScenarioPolicy() {
    return liveConfig().venueExecutionScenarios ? this.scenarioController?.release?.policy ?? SELECTED_GUARD : null
  }

  /**
   * THE DRAWDOWN STOP'S SELF-LIFT. Until 2026-09-07 this stop waited for a person, which
   * meant an overnight stop cost a whole day of trading and, on 2026-09-01, five days.
   *
   * Every precondition below is load-bearing and none is a preference:
   *
   *   FLAT, in memory and in the database. `positions.size` alone is not flat: a buy in
   *   flight has reserved capacity and has no row yet (risk.openCount catches that), and a
   *   row can be open in the db while the map is empty (telemetry/db.ts queues
   *   closePosition onto setImmediate, and boot recovery leaves rows it could not resolve).
   *   newEpoch's own COUNT is the authority and it throws rather than guessing.
   *
   *   POST-HALT EVIDENCE. readResume only counts launches gatewatch scored AFTER the stop
   *   fired. The newest scored launches at the moment a stop fires are usually the very
   *   coins it fired for, so the obvious version of this check lifts a bot-fault stop
   *   straight back into the fault. This is the difference between the two failures of
   *   2026-09-06 costing $240 and costing $240 an hour, all night.
   *
   *   THE EPOCH MOVES FIRST. The lift and the accounting reset are one action: lifting a
   *   stop whose peak still stands would re-fire it on the next trade, and doing it the
   *   other way round would leave the books zeroed on a bot that never resumed.
   *
   *   NOTHING STICKIER. Enforced in liftOnSignal, which refuses under 'manual' and
   *   'broken'. A venue paying well is not evidence that WE are pricing it correctly.
   *
   * Synchronous end to end, with no await between the epoch move and the seed: housekeeping
   * is async, a slow getGasPrice overlaps ticks, and a backfill drain landing in between
   * would re-seed the ledger from the old base and re-place the halt one tick after lifting.
   */
  private lastEpochBlocked: string | null = null
  private lastRecovery: { n: number; sum: number; at: number } | null = null
  private refreshRecoveryReading(): void {
    if (!this.risk.isHalted('drawdown')) { this.lastRecovery = null; return }
    const at = this.risk.haltAt('drawdown')
    if (at === null || typeof this.gate.readResumeProgress !== 'function') return
    try {
      const reading = liveConfig().venueExecutionScenarios ? this.sharedRecovery(at) : this.gate.readResumeProgress(STRATEGY.gate.ddResumeWindow, barKey(STRATEGY.gate.pnlBar), at, this.bookFloors())
      this.lastRecovery = reading ? { ...reading, at: Date.now() } : null
    } catch { this.lastRecovery = null }
  }

  /** Only cached owner readings and live risk values cross into this presentation. */
  operatorReading(databaseOpen: number, lastEntryAt: number | null) {
    const now = Date.now()
    const scenarioPolicy = this.executionScenarioPolicy()
    return operatorState({ now, mode: this.opts.mode, kinds: this.risk.haltKinds,
      reasons: this.risk.haltKinds.map(kind => ({ kind, reason: this.risk.haltReasonFor(kind), since: this.risk.haltAt(kind) })),
      drawdownEth: Number(this.risk.peakPnlWei - this.risk.realizedPnlWei) / 1e18, limitEth: RISK.maxDrawdownEth,
      open: this.risk.openCount, databaseOpen, capacity: STRATEGY.maxConcurrent,
      deployedEth: Number(this.risk.deployedWei) / 1e18, bankrollEth: Number(this.risk.bankrollWei) / 1e18, tradeSizeEth: STRATEGY.tradeSizeEth,
      logsHealthy: this.logs.healthy, logsAgeMs: this.logs.lastHealthyAt ? now - this.logs.lastHealthyAt : Infinity,
      logsLimitMs: RISK.maxLogsStalenessMs, lastEntryAt,
      market: this.venueReading(), marketBar: STRATEGY.gate.pnlBar, marketWindow: scenarioPolicy?.n ?? (liveConfig().venueFreshRecovery ? FRESH_POLICY.window : STRATEGY.gate.pnlPauseWindow), marketOff: scenarioPolicy?.off ?? (liveConfig().venueFreshRecovery ? FRESH_POLICY.pauseBelow : STRATEGY.gate.pnlPauseOff),
      marketOn: scenarioPolicy?.freshOn ?? (liveConfig().venueFreshRecovery ? FRESH_POLICY.recoverAbove : STRATEGY.gate.pnlPauseOn), marketFreshMs: scenarioPolicy?.ageMs ?? (liveConfig().venueFreshRecovery ? FRESH_POLICY.freshMs : STRATEGY.gate.pnlFreshMs),
      touch: this.lastGate ? { ...this.lastGate.reading, ageMs: now - this.lastGate.at } : null,
      touchBar: STRATEGY.gate.touchMultiple, touchHoldMs: STRATEGY.gate.holdMs, touchWindow: STRATEGY.gate.window, touchOff: STRATEGY.gate.shutAt, touchOn: STRATEGY.gate.openAt,
      execution: this.lastBroken, executionFactor: RISK.brokenFactor, executionWindow: RISK.brokenWindow, executionLimit: RISK.brokenGapPp,
      recovery: this.lastRecovery, recoveryError: this.lastEpochBlocked, recoveryWindow: STRATEGY.gate.ddResumeWindow, recoveryOn: STRATEGY.gate.ddResumeOn,
      liftsUsed: this.risk.ddLiftsUsed, liftsLimit: this.risk.ddLiftsLimit,
      operatorRecoveryPending: this.operatorRecoveryPending })
  }
  private sharedRecovery(haltAt: number) {
    return scenarioRecovery(this.simulation?.paperStatus?.scenarioObserver ?? null, simulationDigest(this.shadowConfig()),
      haltAt, Date.now(), this.simulation?.paperStatus?.at ?? 0, STRATEGY.gate.ddResumeWindow,
      this.executionScenarioPolicy()?.ageMs ?? SELECTED_GUARD.ageMs, this.scenarioController?.reading?.verified === true)
  }
  private checkDrawdownResume(): void {
    if (this.risk.haltKind !== 'drawdown') { this.lastEpochBlocked = null; return }
    if (this.opts.mode !== 'live' || !this.truth) return
    if (this.positions.size > 0 || this.risk.openCount > 0) return
    if (this.risk.ddLiftsExhausted) return
    const haltAt = this.risk.haltAt('drawdown')
    if (haltAt === null) return
    const ev = liveConfig().venueExecutionScenarios ? this.sharedRecovery(haltAt) : this.gate.readResume(STRATEGY.gate.ddResumeWindow, barKey(STRATEGY.gate.pnlBar), haltAt, this.bookFloors())
    if (!ev || ev.n < STRATEGY.gate.ddResumeWindow || ev.sum <= STRATEGY.gate.ddResumeOn) return

    const why = `venue paid +${ev.sum.toFixed(2)} stakes over ${ev.n} launches scored since the stop`
    let seeded: { realized: bigint; peak: bigint; day: bigint }
    try {
      seeded = this.truth.openEpoch(`drawdown auto-resume: ${why}`)
    } catch (e) {
      // Normal for one tick right after a close, permanent when a recovered row stays
      // open. Reported once per distinct reason so a stuck epoch is visible rather than
      // silently costing every resume from here on.
      const msg = String((e as Error).message ?? e)
      if (msg !== this.lastEpochBlocked) {
        this.lastEpochBlocked = msg
        this.tel.health('drawdown', false, `auto-resume blocked: ${msg}`)
      }
      return
    }
    this.lastEpochBlocked = null
    this.risk.seedLedger(seeded)
    this.simulation?.capture('control','epoch',{resetDrawdown:true})
    if (!this.risk.liftOnSignal('drawdown', why)) return
    this.tel.health('drawdown', true, `auto-resumed: ${why}`)
    console.error(
      `\ndrawdown stop lifted itself: ${why}.`
      + ` new epoch, both stops from zero; the chain baseline re-records at the next flat sample.`
      + ` entries back on (${this.risk.ddLiftsUsed} of 2 self-lifts used today).`,
    )
  }

  /**
   * THE BOT-BROKEN HALT. Are we losing money the venue did not lose? See strategy/broken.ts
   * for why that question needs a different answer from every other halt in the tree.
   *
   * Only rows THIS PROCESS opened count (`id > bootMaxId`). A restart is the operator's
   * lift for this kind, so a window that survived one would re-halt the bot the moment it
   * booted, and boot recovery's own closes (a stranded bag at minus the stake) would count
   * as trades this bot chose to make.
   *
   * Rows whose coin gatewatch has not scored are skipped rather than counted as zero, and
   * do not fill the window: no replay is missing evidence, not evidence of nothing.
   */
  private bootMaxId = 0
  private lastBrokenId = 0
  private lastBroken: { gapPp: number; n: number; at: number; realPp: number; replayPp: number } | null = null
  private checkBroken(): void {
    if (this.opts.mode !== 'live') return
    if (this.risk.isHalted('broken')) return
    try {
      const rows = this.tel.raw().prepare(
        `SELECT token, take_profit, spend_wei, pnl_true_wei, id FROM trades
         WHERE COALESCE(cohort,'main') = 'main' AND id > ?
         ORDER BY id DESC LIMIT ?`,
      ).all(this.bootMaxId, RISK.brokenWindow) as Array<{
        token: string; take_profit: number | null; spend_wei: string; pnl_true_wei: number; id: number
      }>
      if (rows.length < RISK.brokenWindow) return
      if (rows[0]!.id === this.lastBrokenId) return // nothing has closed since the last look
      this.lastBrokenId = rows[0]!.id
      const bars = this.gate.barsFor(rows.map((r) => r.token))
      if (!bars) return
      const pairs: Array<{ real: number; replay: number }> = []
      for (const r of rows) {
        const spend = Number(r.spend_wei)
        if (!Number.isFinite(spend) || spend <= 0) continue
        if (typeof r.take_profit !== 'number' || !Number.isFinite(r.take_profit)) continue
        const replay = bars.get(r.token.toLowerCase())?.[barKey(r.take_profit)]
        if (typeof replay !== 'number') continue
        pairs.push({ real: r.pnl_true_wei / spend, replay })
      }
      if (pairs.length < RISK.brokenWindow) return
      const b = brokenGap(pairs, RISK.brokenFactor)
      this.lastBroken = b ? { ...b, at: Date.now() } : null
      if (!b || b.gapPp > -RISK.brokenGapPp) return
      const why = `we made ${b.realPp.toFixed(1)}% a trade where the same ${b.n} coins replayed at`
        + ` ${b.replayPp.toFixed(1)}%: ${b.gapPp.toFixed(1)} points short of what the venue paid`
      this.risk.halt(why, 'broken')
      this.tel.health('broken', false, why)
      console.error(`\nHALTED, and this one is us, not the venue: ${why}.`
        + ` entries off; open positions will still be sold. Find the bug before restarting.`)
    } catch {
      // an unreadable window must not take the bot down; the next tick tries again
    }
  }

  /** the real-vs-replay gap, for the dashboard. Null until a full window exists. */
  brokenReading(): { gapPp: number; n: number } | null { return this.lastBroken }

  /** Stop mirroring curve state for anything we hold no position in. */
  private sweepIdleCurves(): void {
    const cutoff = Date.now() - 10 * 60_000
    for (const c of this.state.list()) {
      if (this.positions.has(c.curve) || this.observations.has(c.curve)) continue
      if (c.workingAt < cutoff) this.state.untrack(c.curve)
    }
  }

  openPositions(): Position[] {
    return [...this.positions.values()]
  }

  /** Live mark for an open position, using whichever book this mode trades on. */
  liveMark(curve: string, tokens: bigint): bigint {
    return this.mark(curve, tokens)
  }

  senderStats(): { n: number; min: number; med: number; p95: number } | null {
    return this.sender?.stats() ?? null
  }

  /** forced nonce resyncs in the trailing hour, for the dashboard's alert */
  nonceResyncs1h(): number {
    return this.nonce?.resyncs1h() ?? 0
  }

  get modeName(): string {
    return this.opts.mode
  }

  get walletAddress(): string {
    return this.signer?.address ?? ''
  }
}
