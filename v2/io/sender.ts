/**
 * PORTED from v1/src/tx/sender.ts, with only its config imports redirected.
 *
 * The September 24 repair preserves uncertainty across failover and bounds the public
 * fallback request. Tests cover ambiguous proxy errors and a hung fallback.
 *
 * Diff it against the original before trusting any change:
 *   diff v2/io/sender.ts v1/src/tx/sender.ts
 */
/**
 * Transaction submission.
 *
 * Measured on the sequencer: a cold request costs 358ms (TCP+TLS), a warm one 96ms,
 * which is exactly one round trip. So the entire job here is to never pay a handshake
 * on the hot path. Two clients stay warm; a 15s ping keeps them under the ALB idle
 * timeout and doubles as a continuous latency probe.
 *
 * The sequencer accepts only eth_sendRawTransaction. Everything else is 404-equivalent.
 */
import { Client } from 'undici'
import { ENDPOINTS } from './env.js'

const PING_INTERVAL_MS = 15_000
const SEND_TIMEOUT_MS = 250

export type SendResult =
  | { ok: true; hash: string; ms: number; via: string }
  | { ok: false; error: string; ms: number; via: string; nonceConsumed: boolean }

/**
 * A JSON-RPC error means the sequencer rejected the tx before sequencing it, so the
 * nonce was never consumed. A returned hash means it was sequenced and the nonce is
 * gone even if execution later reverts. That distinction is what keeps the local
 * nonce counter correct without ever querying the chain mid-flight.
 */
function nonceWasConsumed(errMessage: string): boolean {
  const m = errMessage.toLowerCase()
  if (m.includes('nonce too low')) return true // someone already used it
  return false
}

/**
 * Preserve whether submission might have happened. A rate limit rejects before execution;
 * a server/proxy failure may arrive after forwarding the bytes. Uncertainty must survive
 * failover so the driver keeps the nonce and position until execution evidence arrives.
 */
export function classifySend(statusCode: number, body: string):
  | { ok: true; hash: string }
  | { ok: false; error: string; nonceConsumed: boolean } {
  if (statusCode !== 200) {
    const ambiguous = statusCode >= 500
    return { ok: false, error: `${ambiguous ? 'transport: ' : ''}http ${statusCode}: ${body.slice(0, 80).replace(/\s+/g, ' ')}`, nonceConsumed: ambiguous }
  }
  let j: { result?: string; error?: { message?: string } }
  try {
    j = JSON.parse(body)
  } catch {
    // a 200 whose body is not JSON: the server answered, we cannot read it. ambiguous.
    return { ok: false, error: `unparseable 200: ${body.slice(0, 80)}`, nonceConsumed: true }
  }
  if (j.result) return { ok: true, hash: j.result }
  const msg = j.error?.message ?? 'unknown rpc error'
  return { ok: false, error: msg, nonceConsumed: nonceWasConsumed(msg) }
}

export class Sender {
  private clients: { name: string; client: Client }[] = []
  private pingTimer: NodeJS.Timeout | null = null
  rtt: number[] = []
  onProbe: ((ms: number, ok: boolean) => void) | null = null

  constructor() {
    this.clients = [
      { name: 'seq-primary', client: new Client(ENDPOINTS.sequencer, { allowH2: true, pipelining: 1 }) },
      { name: 'seq-spare', client: new Client(ENDPOINTS.sequencer, { allowH2: true, pipelining: 1 }) },
    ]
  }

  async start(): Promise<void> {
    await Promise.all(this.clients.map((c) => this.probe(c)))
    this.pingTimer = setInterval(() => {
      for (const c of this.clients) void this.probe(c)
    }, PING_INTERVAL_MS)
  }

  async stop(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer)
    await Promise.all(this.clients.map((c) => c.client.close().catch(() => {})))
  }

  /** Keeps the socket hot and measures the round trip. "0x00" is rejected in 1 RTT. */
  private async probe(c: { name: string; client: Client }): Promise<void> {
    const t = process.hrtime.bigint()
    try {
      const r = await c.client.request({
        path: '/',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'eth_sendRawTransaction', params: ['0x00'] }),
      })
      await r.body.text()
      const ms = Number(process.hrtime.bigint() - t) / 1e6
      this.rtt.push(ms)
      if (this.rtt.length > 200) this.rtt.shift()
      this.onProbe?.(ms, true)
    } catch {
      this.onProbe?.(Number(process.hrtime.bigint() - t) / 1e6, false)
    }
  }

  private async post(c: { name: string; client: Client }, raw: string): Promise<SendResult> {
    const t = process.hrtime.bigint()
    const ms = () => Number(process.hrtime.bigint() - t) / 1e6
    try {
      const r = await c.client.request({
        path: '/',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }),
        headersTimeout: SEND_TIMEOUT_MS * 8,
        bodyTimeout: SEND_TIMEOUT_MS * 8,
      })
      const out = classifySend(r.statusCode, await r.body.text())
      return out.ok
        ? { ok: true, hash: out.hash, ms: ms(), via: c.name }
        : { ok: false, error: out.error, ms: ms(), via: c.name, nonceConsumed: out.nonceConsumed }
    } catch (e) {
      // a transport failure tells us nothing about whether it landed, so treat the
      // nonce as consumed and let the idle resync fix it rather than double-spending it
      return { ok: false, error: `transport: ${String(e)}`, ms: ms(), via: c.name, nonceConsumed: true }
    }
  }

  /**
   * Resending the same signed tx is idempotent (same hash), so failing over costs
   * nothing worse than a "nonce too low" we can ignore.
   */
  async send(raw: string): Promise<SendResult> {
    let last: SendResult | null = null
    for (const c of this.clients) {
      const r = await this.post(c, raw)
      if (r.ok) return r
      // an rpc-level rejection is deterministic: the spare will reject it too
      if (!r.error.startsWith('transport:')) return retainUncertainty(last, r)
      last = r
    }
    const fallback = await this.postPublic(raw)
    return fallback ? retainUncertainty(last, fallback) : last!
  }

  /** Last resort: the public RPC forwards to the sequencer. Slower, but it is a path. */
  private async postPublic(raw: string): Promise<SendResult | null> {
    const t = process.hrtime.bigint()
    try {
      const r = await fetch(ENDPOINTS.rpc, {
        method: 'POST',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS * 8),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }),
      })
      // same classifier as the sequencer path: a 429 here is a refusal, not a sequencing
      const out = classifySend(r.status, await r.text())
      const ms = Number(process.hrtime.bigint() - t) / 1e6
      return out.ok
        ? { ok: true, hash: out.hash, ms, via: 'public-rpc' }
        : { ok: false, error: out.error, ms, via: 'public-rpc', nonceConsumed: out.nonceConsumed }
    } catch {
      return null
    }
  }

  stats(): { n: number; min: number; med: number; p95: number } | null {
    if (!this.rtt.length) return null
    const s = [...this.rtt].sort((a, b) => a - b)
    return { n: s.length, min: s[0]!, med: s[Math.floor(s.length / 2)]!, p95: s[Math.floor(s.length * 0.95)]! }
  }
}

function retainUncertainty(previous: SendResult | null, latest: SendResult): SendResult {
  if (latest.ok || !previous || previous.ok || !previous.nonceConsumed || latest.nonceConsumed) return latest
  return {...latest,nonceConsumed:true,error:`transport: an earlier submission remains unconfirmed; ${latest.error}`}
}

/**
 * Whether a FAILED send may still have landed, so the caller must keep the position and
 * let the wallet balance decide, instead of closing the row and releasing the curve.
 *
 * Three answers qualify. A transport failure (socket died, timeout with no response) says
 * nothing about whether the bytes were sequenced. And "nonce too low" can be our own
 * transaction: the primary client times out AFTER the sequencer accepted the tx, the
 * spare re-sends the identical signed bytes, and the sequencer answers that the nonce is
 * used. Before 2026-09-06 that second case was treated as a clean rejection, the row was
 * closed as never-mined and the curve released, which would have left real tokens with
 * nobody managing them (found in review before it happened live: 0 rows in 7 days). The
 * third is a 200 whose body could not be parsed: the server answered, we could not read it.
 */
export function sendUncertain(r: SendResult): boolean {
  // every failed send whose nonce was consumed: transport failure, "nonce too low", and a
  // 200 whose body could not be read. A rejection that left the nonce with us is certain.
  return !r.ok && r.nonceConsumed
}
