/**
 * Authoritative event stream. PORTED from v1/src/logs/subscriber.ts.
 *
 * TWO TRANSPORTS, ONE OUTPUT, AND SINCE 2026-09-06 THEY RUN TOGETHER, NOT INSTEAD OF EACH
 * OTHER.
 *
 * The HTTP poller is the AUTHORITY: every reserve-mutating event (all seven topics), in
 * order, with `healthy` and `lastHealthyAt` as the liveness signal. The provider websocket
 * is an ACCELERATOR for TokenLaunched only.
 *
 * THIS FILE DECIDES NOTHING. It turns sockets into the `logs` / `logs-status` bodies
 * `decide()` already takes. A launch the socket delivered is emitted once; the poller
 * re-fetching the same block a moment later finds it already seen.
 */
import WebSocket from 'ws'
import { EventEmitter } from 'node:events'
import { ENDPOINTS } from './env.js'
import { EVENT_TOPICS } from './abi.js'
import { ADDRESSES } from '../core/chain.js'
import type { RawLog } from '../core/events.js'
import { RpcRouteLedger, type RpcRoutingStatus } from './routing.js'
import type { EconomyEligibility } from './economy.js'
import type { ApiMode } from './api-mode.js'
import { LogFilter, type FilterMode } from './log-filter.js'
import type { ComparisonBudget } from './comparison-budget.js'
import { CU } from './cu.js'

const ALL_TOPICS = Object.values(EVENT_TOPICS)
const keyOf = (l: RawLog): string => `${l.blockHash}:${l.logIndex}`
const POLL_MIN_MS = 150
/**
 * The poll interval while nothing is at risk, and the biggest line on the provider bill.
 *
 * MEASURED 2026-09-18 from the live tape and the provider's own usage page: the poller is 70 CU
 * a tick (`eth_blockNumber` 10 + `eth_getLogs` 60) at ~385k ticks a day, which is ~26M of the
 * 26.8M CU/day the account was burning — everything else together, the launch socket and every
 * entry read included, was ~0.9M. A position was open 1.17h of that day. So full speed around
 * the clock bought nothing for the 95% of the time there was no money on the table, and it put
 * the monthly cap a day and a half out, where an exhausted key 429s the launch socket and the
 * entry reads TOGETHER. That is the 2026-09-15 failure, bought with credits spent on nothing.
 *
 * WHY 1000 AND NOT 2000, MEASURED AND NOT REASONED. `foldLogs` re-stamps log freshness on every
 * delivered batch and `canEnter` refuses entry past `risk.maxLogsStalenessMs` (3s today). A batch
 * is only emitted when a poll finds a log it has not seen, so the gap between stamps is a MULTIPLE
 * of this interval, not this interval: two consecutive polls that turn up only already-seen logs
 * leave freshness untouched for both. Over 378 samples in the 12.9 minutes after the 2026-09-18
 * cutover, `logsAgeMs` ran p50 443ms, p95 949ms, worst 2015ms — so the observed worst case is
 * about 2x this constant, and zero samples reached the bound. At 2000 that same doubling lands
 * near 4s and starts refusing launches to save credits, which is the one trade this must not make.
 * The failure backoff below doubles and caps at POLL_MAX_MS, which keeps a degraded flat poller
 * inside the bound too.
 *
 * WHAT COUNTS AS AT RISK IS THE CALLER'S QUESTION, not this file's: see `busy` below.
 */
const POLL_FLAT_MS = 1_000
const POLL_MAX_MS = 1_500
const MAX_RANGE = 2_000
/** a poll request that has not answered in this long is a failed poll, not a slow one */
const RPC_TIMEOUT_MS = 750
/** Public normally trails by 4-9 blocks. Already-covered blocks need no paid rescue. */
const PUBLIC_HANDOVER_MS = 3_000
/**
 * How many polls must fail IN A ROW before the stream reads unhealthy.
 *
 * One used to be enough. On the public RPC that meant 12,786 "Too Many Requests" in the
 * 24h to 2026-09-06 00:00, each one flipping `healthy` false until the next success, and
 * entries refuse every launch while it is false. Data age is the real safety: `lastHealthyAt`
 * only advances on success. Three consecutive failures at the backoff ladder is already
 * past a second of no data; flipping earlier bought nothing but skipped launches.
 */
const UNHEALTHY_AFTER = 3
const WS_PING_MS = 2_000
const WS_PONG_TIMEOUT_MS = 6_000
const WS_WINDOW_CHECK_MS = 30_000
const CU_PER_BYTE = 0.04

function hexToNum(h: string): number {
  return parseInt(h, 16)
}

export type LogBatch = {
  readonly logs: readonly RawLog[]
  readonly source: 'poll' | 'ws' | 'filter'
  readonly lo: number
  readonly hi: number
}

export interface LogsSubscriber {
  on(e: 'coverage', fn: (batch: { lo: number; hi: number; rows: RawLog[] }) => void): this
  on(e: 'logs', fn: (logs: RawLog[]) => void): this
  on(e: 'batch', fn: (batch: LogBatch) => void): this
  on(e: 'head', fn: (block: number) => void): this
  on(e: 'status', fn: (s: { mode: string; healthy: boolean; reason?: string }) => void): this
  on(e: 'ws', fn: (s: { up: boolean; reason?: string }) => void): this
}

export class LogsSubscriber extends EventEmitter {
  private stopped = false
  private ws: WebSocket | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private pongTimer: NodeJS.Timeout | null = null
  private windowTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private pollDelay = POLL_MIN_MS
  private wsRetries = 0
  private seen = new Set<string>()
  private rpcId = 1
  private failStreak = 0
  private failTimes: number[] = []
  lastProcessedBlock = 0
  lastEventAt = 0
  /**
   * Last time we successfully reached the source, event or no event. This is the
   * liveness signal. Using lastEventAt instead would read a quiet market as a dead
   * stream and silently stop the bot entering trades.
   */
  lastHealthyAt = 0
  mode: 'ws' | 'poll' = 'poll'
  healthy = false
  wsUp = false
  wsLaunches = 0
  wsFirstSeen = 0
  wsBytes = 0
  private wsBytesSince = 0
  /** times the preferred endpoint failed and the other one answered instead, either direction */
  providerFallbacks = 0
  providerCalls = 0
  private requestStartedAt = 0
  private requestMethod: string | null = null
  private lastTip = 0
  private publicHead = 0
  private publicHeadAdvancedAt = 0
  private headRoute: 'public' | 'paid' = 'paid'

  diagnostics() {
    return { cursor: this.lastProcessedBlock, tip: this.lastTip,
      request: this.requestMethod,
      requestAgeMs: this.requestStartedAt ? this.now() - this.requestStartedAt : 0 }
  }

  constructor(
    private readonly fromBlock?: number,
    /**
     * When the socket may be connected. Defaults to always; the live process passes the
     * entry window so the free tier's monthly quota is spent only on launches we could enter.
     */
    private readonly wsWanted: () => boolean = () => true,
    private readonly now: () => number = Date.now,
    private readonly rpcOptions: {
      providerUrl?: string
      apiMode?: () => ApiMode
      onProviderRequest?: (method: string) => void
      /** socket payload delivered on the keyed endpoint, which is billed by the byte */
      onProviderBytes?: (bytes: number) => void
      routeLedger?: RpcRouteLedger
      economyEnabled?: () => boolean
      economyEligibility?: () => EconomyEligibility
      filterMode?: () => FilterMode
      filterEligible?: () => boolean
      filterStatePath?: string
      comparisonBudget?: ComparisonBudget
      phase?: () => string
    } = {},
    /**
     * Whether anything is at risk right now, which is what buys full-speed polling.
     *
     * DEFAULTS TO ALWAYS BUSY, deliberately: every existing caller and test keeps the old
     * cadence, and a new call site that forgets this argument gets the SAFE side of the trade
     * (fast and expensive) rather than the cheap one.
     *
     * The live process answers it from the fold — a bag open, a buy in flight, a launch armed,
     * or either stream down. See `atRisk` in `main.ts`. This file may not ask any of those
     * questions itself: they are facts about the book, and the book lives in the fold.
     */
    private readonly atRisk: () => boolean = () => true,
  ) {
    super()
    this.routeLedger = rpcOptions.routeLedger ?? new RpcRouteLedger(null, now)
    this.filter = new LogFilter({
      topics: ALL_TOPICS, normalize: l => this.normalize(l), now,
      ...(rpcOptions.filterStatePath ? { path: rpcOptions.filterStatePath } : {}),
      request: async (method, params, comparison) => {
        const provider = this.rpcOptions.providerUrl ?? ENDPOINTS.rpcKey
        if (!provider || provider === ENDPOINTS.rpcPublic) throw new Error('filter needs a paid endpoint')
        if (comparison) {
          if (!this.rpcOptions.comparisonBudget) throw new Error('comparison needs a shared allowance')
          this.rpcOptions.comparisonBudget.claim([method])
        }
        return this.requestRpc(provider, method, params, 'paid')
      },
    })
  }

  private readonly routeLedger: RpcRouteLedger
  private readonly filter: LogFilter
  private compareBusy = false
  private compareLo: number | null = null
  private compareHi = 0
  private compareRows = new Map<string, RawLog>()
  private resumePreparing = false
  private pollInFlight: Promise<void> | null = null

  routingStatus(): RpcRoutingStatus {
    const eligibility = this.economyEligibility()
    return { ...this.routeLedger.status(this.economyEnabled(), eligibility.eligible, this.resumePreparing, eligibility.reason),
      verifiedCursor: this.lastProcessedBlock, filter: this.filter.status(),
      activeTransport: this.liveFilter() ? 'filter' : 'range',
    }
  }

  private liveFilter(): boolean {
    return this.rpcOptions.apiMode?.() !== 'economy' && !this.resumePreparing && this.rpcOptions.filterMode?.() === 'live' && !this.filter.disabledReason
      && this.rpcOptions.filterEligible?.() === true && !this.economyEligible()
  }

  private economyEnabled(): boolean {
    try { return this.rpcOptions.economyEnabled?.() === true } catch { return false }
  }

  private economyEligibility(): EconomyEligibility {
    if (this.resumePreparing) return { eligible: false, reason: 'START preparation is using paid routing' }
    try { return this.rpcOptions.economyEligibility?.() ?? { eligible: false, reason: 'no eligibility source' } }
    catch { return { eligible: false, reason: 'eligibility check failed' } }
  }

  private economyEligible(): boolean {
    return this.economyEligibility().eligible
  }

  async start(): Promise<void> {
    this.stopped = false
    if (this.fromBlock) this.lastProcessedBlock = this.fromBlock
    if (!this.lastProcessedBlock) this.lastProcessedBlock = await this.tip()
    this.lastHealthyAt = this.now()
    this.startPolling(this.wsUsable() ? 'poller is the authority; ws accelerates launches' : ENDPOINTS.logsWs ? 'provider websocket url looks unconfigured' : 'no provider websocket configured')
    if (this.wsUsable()) {
      this.checkWindow()
      this.windowTimer = setInterval(() => this.checkWindow(), WS_WINDOW_CHECK_MS)
    }
  }

  stop(): void {
    this.stopped = true
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (this.windowTimer) clearInterval(this.windowTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.closeWs()
  }

  failures1h(now = this.now()): number {
    this.failTimes = this.failTimes.filter((t) => now - t < 3600_000)
    return this.failTimes.length
  }

  wsCuPerMonth(now = this.now()): number | null {
    if (!this.wsBytesSince) return null
    const elapsed = Math.max(60_000, now - this.wsBytesSince)
    return (this.wsBytes / elapsed) * 30 * 86_400_000 * CU_PER_BYTE
  }

  /** A placeholder from .env.example is worse than nothing: it 401s in a tight loop. */
  private wsUsable(): boolean {
    const u = ENDPOINTS.logsWs
    return Boolean(u) && u.startsWith('ws') && !/YOUR_KEY|<.*>|\/v2\/?$/i.test(u)
  }

  /**
   * The keyed provider first when there is one, and the free public RPC as the fallback.
   *
   * IT USED TO BE THE OTHER WAY ROUND, to spend as few provider credits as possible. On a
   * quiet venue that is thrift; on this one it is a stream that does not work. Every single
   * call paid a failed public request before it could start, and the public endpoint answers
   * `http 429` or nothing: 1,027 health flips in the three hours after the 2026-09-16
   * cutover, flapping between unhealthy and recovered every few seconds. `canEnter` refuses
   * every launch while the stream is unhealthy, so the saving was denominated in credits and
   * the cost was denominated in trades.
   *
   * THE CHEAP PATH IS STILL THERE, as the fallback, so a provider outage or an exhausted
   * quota degrades to the public RPC instead of stopping the bot. And `LOGS_PREFER_PUBLIC=1`
   * puts the old order back without a deploy, for the day the credits matter more than the
   * launches.
   */
  private async rpc(method: string, params: unknown[], forcePaid = false): Promise<any> {
    if (this.rpcOptions.apiMode?.() === 'economy') {
      if (forcePaid) throw new Error('Economy forbids paid monitoring')
      return this.requestRpc(ENDPOINTS.rpcPublic, method, params, 'public')
    }
    const provider = this.rpcOptions.providerUrl ?? ENDPOINTS.rpcKey
    const usable = Boolean(provider) && provider !== ENDPOINTS.rpcPublic && !/YOUR_KEY|<.*>|\/v2\/?$/i.test(provider)
    if (forcePaid) {
      if (!usable) throw new Error(`${method}: no paid endpoint is configured for resume preparation`)
      return this.paidWithRangeSplit(provider, method, params)
    }
    if (this.economyEnabled() && this.economyEligible()) {
      if (this.routeLedger.cooldownUntil > this.now()) {
        if (!usable) throw new Error(`${method}: public route is cooling down and no paid endpoint is configured`)
        return this.paidWithRangeSplit(provider, method, params)
      }
      return this.publicFirst(method, params, usable ? provider : null, true)
    }
    if (!usable || process.env.LOGS_PREFER_PUBLIC === '1') return this.publicFirst(method, params, usable ? provider : null)

    try {
      return await this.requestRpc(provider, method, params, 'paid')
    } catch (providerError) {
      // The public RPC cannot serve a 2,000-block range, so a wide backfill the provider
      // refused is not something the fallback can rescue. Raising the provider's error keeps
      // the reason in the health message rather than replacing it with a second, vaguer one.
      try {
        const rescued = await this.requestRpc(ENDPOINTS.rpcPublic, method, params, 'public')
        this.providerFallbacks++
        this.routeLedger.fallback('public')
        return rescued
      } catch { throw providerError }
    }
  }

  /** Public first, then one paid request at the original range. Split only on a range refusal. */
  private async publicFirst(method: string, params: unknown[], provider: string | null, economy = false): Promise<any> {
    try {
      const result = await this.requestRpc(ENDPOINTS.rpcPublic, method, params, 'public')
      return result
    }
    catch (publicError) {
      if (economy) this.routeLedger.publicFailure()
      if (!provider) throw publicError
      const result = await this.paidWithRangeSplit(provider, method, params)
      this.providerFallbacks++
      this.routeLedger.fallback('paid')
      return result
    }
  }

  private async paidWithRangeSplit(provider: string, method: string, params: unknown[]): Promise<any> {
    try { return await this.requestRpc(provider, method, params, 'paid') }
    catch (error) {
      if (method !== 'eth_getLogs' || !/range|too many blocks|block limit|max(?:imum)?.*blocks/i.test(String(error))) throw error
      const filter = params[0] as { fromBlock?: string; toBlock?: string }
      const from = Number.parseInt(filter.fromBlock ?? '', 16), to = Number.parseInt(filter.toBlock ?? '', 16)
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) throw error
      const middle = Math.floor((from + to) / 2)
      const left = await this.paidWithRangeSplit(provider, method, [{ ...filter, toBlock: `0x${middle.toString(16)}` }])
      const right = await this.paidWithRangeSplit(provider, method, [{ ...filter, fromBlock: `0x${(middle + 1).toString(16)}` }])
      return [...left, ...right]
    }
  }

  private async requestRpc(url: string, method: string, params: unknown[], route: 'public' | 'paid'): Promise<any> {
    if (route === 'paid' && this.rpcOptions.apiMode?.() === 'economy') throw new Error('Economy forbids paid monitoring')
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    this.requestStartedAt = this.now()
    this.requestMethod = method
    const phase = this.rpcOptions.phase?.() ?? 'critical'
    const purpose = method.includes('Filter') ? 'filter' : 'logs'
    this.routeLedger.request(route, method, purpose, phase)
    if (route === 'paid' && this.liveFilter()) this.filter.charge(CU[method] ?? 60)
    try {
      const result = await Promise.race([
        this.fetchRpc(url, method, params, route === 'paid', abort.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            abort.abort()
            reject(new Error(`${method}: request deadline exceeded`))
          }, RPC_TIMEOUT_MS)
        }),
      ])
      if (route === 'public' && method === 'eth_blockNumber') {
        const head = hexToNum(result)
        if (head > this.publicHead) { this.publicHead = head; this.publicHeadAdvancedAt = this.now() }
        if ((this.rpcOptions.apiMode?.() === 'economy' || (this.economyEnabled() && this.economyEligible()))
          && this.now() - this.publicHeadAdvancedAt > PUBLIC_HANDOVER_MS) throw new Error(`${method}: public head stopped advancing`)
        if (head < this.lastProcessedBlock && !(this.economyEnabled() && this.economyEligible()
          && this.now() - this.lastHealthyAt < PUBLIC_HANDOVER_MS)) {
          throw new Error(`${method}: public head is behind the processed cursor`)
        }
      }
      if (method === 'eth_blockNumber') this.headRoute = route
      return result
    } catch (error) {
      this.routeLedger.failure(route, method, purpose, phase)
      throw error
    } finally {
      clearTimeout(timer)
      this.requestStartedAt = 0
      this.requestMethod = null
    }
  }

  private async fetchRpc(url: string, method: string, params: unknown[], provider: boolean, signal: AbortSignal): Promise<any> {
    if (provider) {
      this.providerCalls++
      try { this.rpcOptions.onProviderRequest?.(method) } catch { /* accounting cannot block reads */ }
    }
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.rpcId++, method, params }),
      signal,
    })
    if (!r.ok) {
      void r.body?.cancel().catch(() => {})
      throw new Error(`${method}: http ${r.status}`)
    }
    let j: { error?: { message: string }; result?: any }
    try {
      j = (await r.json()) as typeof j
    } catch {
      throw new Error(`${method}: bad body`)
    }
    if (j.error) throw new Error(`${method}: ${String(j.error.message).replace(/(?:https?|wss?):\/\/\S+/gi, '[RPC]').slice(0, 160)}`)
    if (method === 'eth_blockNumber' && (typeof j.result !== 'string' || !/^0x[0-9a-f]+$/i.test(j.result))) throw new Error(`${method}: missing or invalid result`)
    if ((method === 'eth_getLogs' || method === 'eth_getFilterChanges') && !Array.isArray(j.result)) throw new Error(`${method}: missing or invalid result`)
    if ((method === 'eth_getLogs' || method === 'eth_getFilterChanges') && j.result.some((l: any) => !l || !Array.isArray(l.topics)
      || typeof l.address !== 'string' || typeof l.data !== 'string'
      || typeof l.blockHash !== 'string' || typeof l.transactionHash !== 'string'
      || !Number.isFinite(hexToNum(l.blockNumber)) || !Number.isFinite(hexToNum(l.logIndex)))) {
      throw new Error(`${method}: malformed log row`)
    }
    return j.result
  }

  private async tip(forcePaid = false): Promise<number> {
    this.lastTip = hexToNum(await this.rpc('eth_blockNumber', [], forcePaid))
    return this.lastTip
  }

  private checkWindow(): void {
    if (this.stopped) return
    const wanted = this.wsUsable() && this.wsWanted() && this.rpcOptions.apiMode?.() !== 'economy'
    if (wanted && !this.ws && !this.reconnectTimer) this.connectWs()
    else if (!wanted && this.ws) this.wsDown('entry window closed', false)
  }

  refreshRouting(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.checkWindow()
  }

  private connectWs(): void {
    if (this.stopped || this.ws || !this.wsWanted() || this.rpcOptions.apiMode?.() === 'economy') return
    const ws = new WebSocket(ENDPOINTS.logsWs)
    this.ws = ws
    ws.on('open', () => {
      if (this.ws !== ws || !this.wsWanted() || this.rpcOptions.apiMode?.() === 'economy') { ws.close(); return }
      this.wsRetries = 0
      this.wsUp = true
      if (!this.wsBytesSince) this.wsBytesSince = this.now()
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_subscribe',
        params: ['logs', { address: ADDRESSES.factory, topics: [EVENT_TOPICS.TokenLaunched] }],
      }))
      this.armPing()
      this.emit('ws', { up: true, reason: 'subscribed to launches' })
    })
    ws.on('message', (d: WebSocket.RawData) => {
      const s = d.toString()
      this.wsBytes += s.length
      try { this.rpcOptions.onProviderBytes?.(s.length) } catch { /* accounting cannot block a log */ }
      if (this.ws !== ws || this.rpcOptions.apiMode?.() === 'economy') return
      let m: any
      try {
        m = JSON.parse(s)
      } catch {
        return
      }
      const r = m?.params?.result
      if (!r || !r.topics) return
      this.wsLaunches++
      this.ingest([{ ...this.normalize(r) }], 'ws')
    })
    ws.on('pong', () => this.armPong())
    ws.on('error', (e: Error) => this.wsDown(e.message))
    ws.on('close', () => this.wsDown('closed'))
  }

  private armPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => { try { this.ws?.ping() } catch { /* a dead socket is already down */ } }, WS_PING_MS)
    this.armPong()
  }

  private armPong(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.pongTimer = setTimeout(() => this.wsDown('no pong'), WS_PONG_TIMEOUT_MS)
  }

  private closeWs(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null }
    const ws = this.ws
    this.ws = null
    this.wsUp = false
    if (!ws) return
    ws.removeAllListeners()
    // terminate() on a socket that is still CONNECTING makes `ws` emit an 'error'
    // ("WebSocket was closed before the connection was established") on the next tick,
    // and an error event with no listener is an uncaught exception that takes the whole
    // process down. Found by the box's test run on 2026-09-06.
    ws.on('error', () => {})
    try { ws.terminate() } catch { /* already gone */ }
  }

  private wsDown(reason: string, reconnect = true): void {
    if (!this.ws && !this.wsUp) return
    this.closeWs()
    this.emit('ws', { up: false, reason })
    if (!reconnect || this.stopped) return
    this.wsRetries++
    const backoff = Math.min(3_000 * this.wsRetries, 60_000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped && this.wsWanted()) this.connectWs()
    }, backoff)
  }

  /**
   * The interval after a SUCCESSFUL poll: full speed while something is at risk, `POLL_FLAT_MS`
   * otherwise. See `POLL_FLAT_MS` for what that is worth and what bounds it.
   *
   * A THROW IN THE CALLER'S PREDICATE MUST NOT READ AS A FAILED POLL. It is evaluated inside the
   * tick's `try`, so an exception would land in the catch below, count against `failStreak` and
   * eventually flip the stream unhealthy, which refuses every entry — a display-grade bug
   * turning into a trading outage. It falls back to the fast, expensive, safe side.
   */
  private nextDelay(): number {
    try { return this.atRisk() ? POLL_MIN_MS : POLL_FLAT_MS } catch { return POLL_MIN_MS }
  }

  private startPolling(reason: string, resetHealth = true): void {
    if (this.pollTimer || this.stopped) return
    this.mode = 'poll'
    if (resetHealth) {
      this.healthy = true
      this.failStreak = 0
      this.emit('status', { mode: 'poll', healthy: true, reason })
    }
    const tick = async () => {
      this.pollTimer = null
      if (this.stopped) return
      const work = this.backfill()
      this.pollInFlight = work
      try {
        await work
        const wasHealthy = this.healthy
        this.healthy = true
        this.failStreak = 0
        this.pollDelay = this.nextDelay()
        if (!wasHealthy) this.emit('status', { mode: 'poll', healthy: true, reason: 'recovered' })
      } catch (e) {
        this.failStreak++
        this.failTimes.push(this.now())
        if (this.failTimes.length > 20_000) this.failTimes = this.failTimes.slice(-10_000)
        this.pollDelay = Math.min(this.pollDelay * 2, POLL_MAX_MS)
        if (this.healthy && this.failStreak >= UNHEALTHY_AFTER) {
          this.healthy = false
          this.emit('status', { mode: 'poll', healthy: false, reason: `${this.failStreak} consecutive failures, last: ${String(e)}` })
        }
      }
      if (this.pollInFlight === work) this.pollInFlight = null
      if (!this.stopped && !this.resumePreparing && !this.pollTimer) this.pollTimer = setTimeout(tick, this.pollDelay)
    }
    this.pollTimer = setTimeout(tick, 0)
  }

  private async backfill(forcePaid = false, signal?: AbortSignal): Promise<void> {
    if (!forcePaid && this.liveFilter()) this.filter.cycle()
    let filterAudit = !forcePaid && this.liveFilter()
    if (filterAudit && !this.filter.auditDue()) {
      try {
        const rows = await this.filter.poll(this.lastProcessedBlock, false)
        // Keep tentative events out of the fold. A later repair cannot undo a reserve or
        // guard observation already applied out of order. Launches force an immediate scan.
        if (this.liveFilter() && !rows.some(row => row.topics[0] === EVENT_TOPICS.TokenLaunched)) return
      } catch (e) {
        if (/unsupported|not supported|method not found|removed/i.test(String(e))) this.filter.disable('filter transport is unsupported or invalid')
        else this.filter.repair()
        forcePaid = true
      }
      filterAudit = !forcePaid && this.liveFilter()
    }
    const economyCycle = !forcePaid && this.economyEnabled() && this.economyEligible()
      && this.routeLedger.cooldownUntil <= this.now()
    const publicFailuresBefore = this.routeLedger.consecutivePublicFailures
    const tip = await this.tip(forcePaid)
    if (filterAudit) {
      try { await this.filter.poll(this.lastProcessedBlock, false) }
      catch (e) {
        if (/unsupported|not supported|method not found|removed/i.test(String(e))) this.filter.disable('filter transport is unsupported or invalid')
        else this.filter.repair()
        filterAudit = false; forcePaid = true
      }
    }
    const paidScan = forcePaid || (economyCycle && this.headRoute === 'paid')
    signal?.throwIfAborted()
    if (tip < this.lastProcessedBlock) {
      if (economyCycle) return // Covered already. Neither cursor nor freshness moves.
      throw new Error('RPC head is behind the processed cursor')
    }
    let from = this.lastProcessedBlock
    while (from <= tip) {
      signal?.throwIfAborted()
      const to = Math.min(tip, from + MAX_RANGE - 1)
      const raw: any[] = await this.rpc('eth_getLogs', [
        { fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [ALL_TOPICS] },
      ], paidScan)
      signal?.throwIfAborted()
      const rows = raw.map((l) => this.normalize(l))
      if (filterAudit) this.filter.verify(from, to, rows)
      this.ingest(rows, 'poll', from, to)
      this.emit('coverage', { lo: from, hi: to, rows })
      this.compareFilter(from, to, rows)
      this.lastProcessedBlock = to
      from = to + 1
    }
    this.lastHealthyAt = this.now()
    if (economyCycle && this.routeLedger.consecutivePublicFailures === publicFailuresBefore) this.routeLedger.publicSuccess()
    this.emit('head', tip)
  }

  /** Optional comparison never delays the authoritative poller or consumes its retry budget. */
  private compareFilter(lo: number, hi: number, rows: RawLog[]): void {
    if (this.rpcOptions.apiMode?.() === 'economy') return
    if (this.rpcOptions.filterMode?.() !== 'compare' || this.filter.disabledReason) return
    this.compareLo ??= lo
    this.compareHi = hi
    for (const row of rows) this.compareRows.set(keyOf(row), row)
    if (this.compareRows.size > 50_000) { this.filter.disable('comparison backlog exceeded'); this.compareRows.clear(); return }
    if (this.compareBusy) return
    this.compareBusy = true
    const from = this.compareLo, through = this.compareHi
    void this.filter.poll(from, true).then(() => {
      this.filter.verify(from, through, [...this.compareRows.values()])
      for (const [key, row] of this.compareRows) if (row.blockNumber <= through) this.compareRows.delete(key)
      this.compareLo = through + 1
    }).catch(e => {
      this.filter.disable(String((e as Error).message ?? e))
      this.compareRows.clear()
    }).finally(() => { this.compareBusy = false })
  }

  /** Restore paid routing, cover through a keyed head, then wait for the driver to process it. */
  async preparePaidResume(afterBatch: (signal: AbortSignal) => Promise<void>, stillCurrent: () => boolean, timeoutMs = 10_000): Promise<void> {
    return this.prepareResume('paid', afterBatch, stillCurrent, timeoutMs)
  }

  async prepareResume(route: 'public' | 'paid', afterBatch: (signal: AbortSignal) => Promise<void>, stillCurrent: () => boolean, timeoutMs = 10_000): Promise<void> {
    if (this.resumePreparing) throw new Error('paid catch-up is already running')
    this.resumePreparing = true
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
    let forcedWork: Promise<void> | null = null
    const abort = new AbortController()
    const deadline = this.now() + timeoutMs
    const bounded = async (work: Promise<void>): Promise<void> => {
      const left = deadline - this.now()
      if (left <= 0) throw new Error(`resume preparation exceeded ${timeoutMs}ms`)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([work, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { abort.abort(); reject(new Error(`resume preparation exceeded ${timeoutMs}ms`)) }, left)
        })])
      } finally { clearTimeout(timer) }
    }
    try {
      if (this.pollInFlight) await bounded(this.pollInFlight.catch(() => {}))
      if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
      if (!stillCurrent()) throw new Error('resume preparation was cancelled by a newer STOP')
      for (;;) {
        if (!stillCurrent()) throw new Error('resume preparation was cancelled by a newer STOP')
        forcedWork = this.backfill(route === 'paid', abort.signal)
        this.pollInFlight = forcedWork
        try { await bounded(forcedWork); break }
        catch (error) {
          if (route === 'paid' || abort.signal.aborted || !/head.*behind|head stopped advancing/i.test(String(error))) throw error
          await bounded(new Promise<void>(resolve => setTimeout(resolve, 50)))
        }
      }
      await bounded(afterBatch(abort.signal))
      if (!stillCurrent()) throw new Error('resume preparation was cancelled by a newer STOP')
      this.healthy = true
      this.failStreak = 0
      this.emit('status', { mode: 'poll', healthy: true, reason: `${route} catch-up processed` })
    } finally {
      abort.abort()
      // A timeout cancels the scan, but its last fetch may still be unwinding. Do not overlap it.
      const work = this.pollInFlight
      const restart = () => {
        if (this.pollInFlight === work) this.pollInFlight = null
        this.resumePreparing = false
        if (!this.stopped && !this.pollTimer) this.startPolling('resume preparation finished', false)
      }
      if (work) void work.catch(() => {}).finally(restart)
      else restart()
    }
  }

  private normalize(l: any): RawLog {
    return {
      address: String(l.address).toLowerCase(),
      topics: l.topics,
      data: l.data,
      blockNumber: hexToNum(l.blockNumber),
      logIndex: hexToNum(l.logIndex),
      transactionIndex: l.transactionIndex == null ? 0 : hexToNum(l.transactionIndex),
      transactionHash: l.transactionHash,
      blockHash: l.blockHash,
    }
  }

  /**
   * One path for both transports. The seen-set is what makes the accelerator safe.
   *
   * Only the POLLER advances lastProcessedBlock. The provider runs ~6 blocks ahead of the
   * public RPC, so a socket log from block N+6 must not move the cursor past N+1..N+5.
   */
  private ingest(logs: RawLog[], source: 'poll' | 'ws' | 'filter', lo?: number, hi?: number): void {
    const fresh: RawLog[] = []
    for (const l of logs) {
      const key = keyOf(l)
      if (this.seen.has(key)) continue
      this.seen.add(key)
      fresh.push(l)
      if (source === 'poll' && l.blockNumber > this.lastProcessedBlock) this.lastProcessedBlock = l.blockNumber
    }
    if (this.seen.size > 50_000) {
      this.seen = new Set([...this.seen].slice(-10_000))
    }
    if (!fresh.length) return
    if (source === 'ws') this.wsFirstSeen += fresh.length
    fresh.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    this.lastEventAt = this.now()
    const from = lo ?? fresh[0]!.blockNumber
    const to = hi ?? fresh[fresh.length - 1]!.blockNumber
    this.emit('logs', fresh)
    this.emit('batch', { logs: fresh, source, lo: from, hi: to } satisfies LogBatch)
  }
}
