/**
 * Sequencer feed client. PORTED from v1/src/feed/client.ts.
 *
 * Reconnect ALWAYS carries `Arbitrum-Requested-Sequence-Number`. Omitting it makes the
 * relay replay its whole backlog (~2 minutes of blocks), which would look like a flood
 * of stale launches. In-range resume replays from lastSeq, so expect one duplicate.
 *
 * A sequence gap means our optimistic view of the world has holes in it. We do not try
 * to patch it: we emit 'gap' and the fold drops its overlay and runs on confirmed state
 * until contiguity returns.
 *
 * THIS FILE DECIDES NOTHING. It turns frames into `feed-block` / `feed-gap` / `feed-status`
 * bodies. Routing (is this `to` a curve we track) is a fold predicate, applied by the
 * driver before the event is recorded, so an untracked transaction never reaches the tape.
 */
import WebSocket from 'ws'
import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { decodeFrame, type FeedBlock } from './decoder.js'
import { ENDPOINTS } from './env.js'

const PING_INTERVAL_MS = 10_000
const PONG_TIMEOUT_MS = 5_000
const BACKOFF_MS = [0, 250, 1_000, 2_500, 5_000]

/** Respect an upstream cooldown instead of turning rejection into a reconnect storm. */
function retryDelay(value: string | undefined, status: number | undefined): number | undefined {
  if (value) {
    const seconds = Number(value)
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
    if (Number.isFinite(delay) && delay > 0) return Math.min(2_147_483_647, Math.ceil(delay))
  }
  return status === 403 || status === 429 ? 60_000 : undefined
}

export interface FeedClient {
  on(e: 'block', fn: (b: FeedBlock) => void): this
  on(e: 'gap', fn: (info: { expected: number; got: number }) => void): this
  on(e: 'status', fn: (s: { connected: boolean; reason?: string }) => void): this
}

export class FeedClient extends EventEmitter {
  private ws: WebSocket | null = null
  private lastSeq = 0
  private attempt = 0
  private pingTimer: NodeJS.Timeout | null = null
  private pongTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private stopped = false
  connected = false
  lastBlockAt = 0

  /**
   * url is injectable for tests only; production always uses the configured endpoint.
   *
   * `cooldownFile` is where an upstream ban is remembered ACROSS RESTARTS, and it exists
   * because forgetting one is how you keep it. On 2026-09-16 the feed closed at 15:36:50,
   * the instant reconnect was refused with `retry in 3600s`, and the venue's own words were
   * "Blocked for 1 hour after sustained feed connection rejections". The cooldown was held
   * in memory only, so every restart connected immediately, was refused again, and renewed
   * the hour: attempts at 16:45, 17:36, 17:45, 18:13, 18:15, 18:18 and 18:45, none of which
   * could ever have succeeded, each one resetting the clock on the ban it was waiting out.
   * Meanwhile entries refuse, because the entry price is confirmed logs plus this overlay.
   */
  constructor(
    private readonly url: string = ENDPOINTS.feedWs,
    private readonly cooldownFile: string | null = null,
    private readonly now: () => number = Date.now,
  ) { super() }

  start(): void {
    this.stopped = false
    const until = this.cooldownUntil()
    if (until === null) { this.connect(); return }
    // Say it out loud on the tape and in the banner. A feed that is deliberately not
    // connecting looks exactly like a feed that is broken, right up until someone restarts
    // the process to "fix" it and pushes the ban out another hour.
    const seconds = Math.ceil((until - this.now()) / 1000)
    this.emit('status', { connected: false, reason: `upstream cooldown from a previous run; not connecting for ${seconds}s` })
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect() }, until - this.now())
  }

  /** When the venue told us to come back, if that moment is still in the future. */
  private cooldownUntil(): number | null {
    if (!this.cooldownFile) return null
    try {
      const { until } = JSON.parse(readFileSync(this.cooldownFile, 'utf8')) as { until?: number }
      if (typeof until !== 'number' || !Number.isFinite(until)) return null
      return until > this.now() ? until : null
    } catch {
      // No file, unreadable file, or junk in it. A cooldown we cannot read is not a reason
      // to refuse to start: connect, and find out from the venue.
      return null
    }
  }

  private rememberCooldown(untilMs: number, reason: string): void {
    if (!this.cooldownFile) return
    try { writeFileSync(this.cooldownFile, JSON.stringify({ until: untilMs, reason, at: this.now() })) }
    catch { /* the feed must not die because a scratch file will not write */ }
  }

  private forgetCooldown(): void {
    if (!this.cooldownFile) return
    try { rmSync(this.cooldownFile, { force: true }) } catch { /* nothing to forget */ }
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.ws?.close()
    this.ws = null
  }

  private connect(): void {
    if (this.stopped) return
    const headers: Record<string, string> = {}
    if (this.lastSeq > 0) headers['Arbitrum-Requested-Sequence-Number'] = String(this.lastSeq)

    // The venue now refuses the upgrade without a deflate offer (`Compression is required:
    // offer permessage-deflate`). `false` here is what turned a dropped socket into a 400
    // storm on 2026-09-17: the old connection had been up since boot, the reconnect was
    // rejected, and every entry fell back to confirmed logs alone.
    const ws = new WebSocket(this.url, { perMessageDeflate: true, headers })
    this.ws = ws

    ws.on('open', () => {
      this.attempt = 0
      this.connected = true
      this.forgetCooldown()
      this.emit('status', { connected: true })
      this.startPing()
    })
    ws.on('message', (data: WebSocket.RawData) => this.onMessage(data.toString()))
    ws.on('pong', () => {
      if (this.pongTimer) clearTimeout(this.pongTimer)
      this.pongTimer = null
    })
    ws.on('error', (err: Error) => this.down(err.message, ws))
    ws.on('close', () => this.down('closed', ws))
    ws.on('unexpected-response', (_request, response) => {
      const delay = retryDelay(response.headers['retry-after'], response.statusCode)
      response.resume()
      const reason = `HTTP ${response.statusCode}${delay === undefined ? '' : `; retry in ${Math.ceil(delay / 1000)}s`}`
      // Written before the reconnect is scheduled, so a crash between the two still
      // remembers. The file is the only thing that survives the process.
      if (delay !== undefined) this.rememberCooldown(this.now() + delay, reason)
      this.down(reason, ws, delay)
    })
  }

  private onMessage(raw: string): void {
    // Bytes from the server ARE liveness. The relay streams a frame every ~100-250ms, and
    // under load (ours or theirs) a pong can arrive late while frames keep flowing; the old
    // check tore down a healthy feed on that pong alone, ~100 times in three days and 37 of
    // them in one busy hour (2026-09-06), and every entry in the gap fell back to the wall
    // clock aimed 600ms late. A pong timeout now means silence, not a slow pong.
    if (this.pongTimer) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
    for (const r of decodeFrame(raw)) {
      // a non-transaction message with a sequence number is a block with nothing in it
      // for us: consume the number, no gap. See DecodeResult 'ignored'.
      if (r.kind === 'ignored' && r.sequenceNumber !== undefined) {
        const n = r.sequenceNumber
        if (n <= this.lastSeq) continue
        if (this.lastSeq > 0 && n !== this.lastSeq + 1) this.emit('gap', { expected: this.lastSeq + 1, got: n })
        this.lastSeq = n
        continue
      }
      if (r.kind !== 'block') continue
      const b = r.block
      if (b.block <= this.lastSeq) continue // resume duplicate
      if (this.lastSeq > 0 && b.block !== this.lastSeq + 1) {
        this.emit('gap', { expected: this.lastSeq + 1, got: b.block })
      }
      this.lastSeq = b.block
      this.lastBlockAt = Date.now()
      this.emit('block', b)
    }
  }

  private startPing(): void {
    this.clearTimers()
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      this.ws.ping()
      if (this.pongTimer) return
      this.pongTimer = setTimeout(() => this.down('pong timeout'), PONG_TIMEOUT_MS)
    }, PING_INTERVAL_MS)
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.pingTimer = this.pongTimer = null
  }

  private down(reason: string, ws?: WebSocket, retryAfterMs?: number): void {
    // One dying socket emits both 'error' and 'close', and we want one reconnect, not
    // two. Dedupe on the SOCKET, not on the attempt counter: `attempt > 0 && !connected`
    // also matches every failure of a socket that never opened, so the first failed
    // reconnect used to return here and no further reconnect was ever scheduled. The feed
    // stayed dead for the life of the process, silently, and every entry fell back to the
    // wall clock aimed 600ms late.
    if (ws && ws !== this.ws) return
    this.connected = false
    this.clearTimers()
    this.emit('status', { connected: false, reason })
    // any disconnect leaves an unknown hole, so consumers must drop optimistic state
    this.emit('gap', { expected: this.lastSeq + 1, got: -1 })
    try {
      this.ws?.removeAllListeners()
      // Terminating an unfinished upgrade emits an asynchronous error after cleanup.
      this.ws?.on('error', () => {})
      this.ws?.terminate()
    } catch { /* a dying socket is already dead */ }
    this.ws = null
    if (this.stopped) return
    const delay = Math.max(retryAfterMs ?? 0, BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)]! + Math.random() * 200)
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect() }, delay)
  }
}
