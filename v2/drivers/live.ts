/**
 * The only code in the system that can touch the world.
 *
 * WHAT A DRIVER IS. It turns events into `decide` calls and intents into actions, and it
 * owns every impure thing there is: the clock, the sockets, the signer, the chain client and
 * the tape. `decide` owns every decision. The split is the whole architecture, and the test
 * of it is that this file contains no rule: there is no threshold here, no comparison
 * against a limit, and nothing that chooses whether to trade.
 *
 * THE ONE CLOCK. `stamp()` is the only `Date.now()` in the new bot's decision path. Every
 * event is stamped here, once, on receipt, and every time rule downstream reads `event.at`.
 * The old bot called `Date.now()` six times inside a single entry decision and again inside
 * the curve overlay, which is why two replays of one run could reach different answers.
 *
 * MODE IS ENFORCED HERE AND ONLY HERE. `shadow` signs and never sends. `live` sends. There
 * is no observe mode: a process that cannot send must not look like it is trading. A mode
 * check anywhere else would be a second implementation of the one rule that decides whether
 * real money moves.
 *
 * EVERY EFFECT IS RECORDED BEFORE IT IS ANSWERED. `tx-signed` goes on the tape before the
 * socket write, so a send that times out leaves evidence of what was signed rather than a
 * signed transaction nobody knows about.
 */
import { decide } from '../core/decide.js'
import type { Intent } from '../core/intents.js'
import type { Event } from '../core/events.js'
import type { State } from '../core/state.js'
import type { Refusal } from '../core/contracts.js'

/**
 * What one chain read cost, for the `chain-read` event to carry.
 *
 * `error` rather than a throw, because the tape wants the cost of a read that FAILED just as much
 * as one that worked — arguably more. Until 2026-09-17 the driver caught the throw and stamped
 * `tries: 1, latencyMs: 0`, so the one read worth measuring was the one recorded as free.
 *
 * It lives here, beside `World`, because it is part of the contract the driver asks for rather
 * than a detail of how `io/` satisfies it.
 */
export type ReadOutcome = {
  readonly result: unknown
  /** attempts actually made, which is more than one only where a read retries */
  readonly tries: number
  readonly latencyMs: number
  /** whether the keyed endpoint served it; see `spareServed` in `io/world.ts` */
  readonly viaKey: boolean
  readonly error: string | null
}

/** Everything impure, injected, so the driver itself is testable without any of it. */
export type World = {
  /** THE clock. Nothing else in the system may call one. */
  readonly now: () => number
  /** append the stamped event to the tape. Must never throw and never block. */
  readonly record: (event: Event) => void
  /** sign and send. Returns what came back, including the uncertain case. */
  readonly send: (i: Intent, nonce: number) => Promise<{ ok: boolean; hash: string; nonceConsumed: boolean; uncertain: boolean; error: string | null }>
  readonly sign: (i: Intent, nonce: number) => Promise<{ hash: string; raw: string }>
  /** re-broadcast already-signed bytes. Same hash, no new nonce. */
  readonly broadcast: (raw: string) => Promise<{ ok: boolean; hash: string; nonceConsumed: boolean; uncertain: boolean; error: string | null }>
  readonly reserveNonce: () => number
  /**
   * Give a nonce back, and say what the sequencer said if it was the sequencer that refused.
   *
   * THE ERROR IS NOT DECORATION. "nonce too high" is the chain telling us our counter has
   * walked ahead of it, and the only repair is to re-read the chain even with sends in
   * flight. Passing the reason through is what lets `io/world.ts` reach `NonceManager.rejected`
   * instead of the plain `release`; without it, v2 carried v1's repair as dead code and would
   * have reproduced v1's 2026-09-05 outage, where a counter twenty ahead rejected every
   * transaction for 37 minutes. Omit it where nothing refused: a sign failure and a shadow
   * non-send are our own doing and carry no verdict about the chain's count.
   */
  readonly releaseNonce: (n: number, error?: string) => void
  readonly settleNonce: () => void
  /**
   * Perform a chain read an intent asked for, and say what it cost.
   *
   * IT REPORTS A FAILURE RATHER THAN THROWING, so a read that failed is recorded with the tries
   * and the milliseconds it actually spent. The driver used to catch a throw and stamp
   * `tries: 1, latencyMs: 0`, which made the one read worth measuring the one recorded as free.
   * A throw is still handled below, because a fake or a bug can throw.
   */
  readonly read: (what: string, args: readonly string[]) => Promise<ReadOutcome>
  /** schedule a callback; the arm delay is the decision's, the timer is the driver's */
  readonly later: (ms: number, fn: () => void) => void
  readonly log: (line: string) => void
}

export type DriverOptions = {
  readonly world: World
  readonly initial: State
  /** shadow signs and does not send, live sends. */
  readonly mode: 'shadow' | 'live'
  /** the next seq this run will stamp. Taken from the tape so a restart does not reuse ids. */
  readonly startSeq?: number
  /** optional projection hook. Called after each fold, never on the send path. */
  readonly onDecision?: (event: Event, state: State, intents: readonly Intent[], refusals: readonly Refusal[]) => void
}

export class LiveDriver {
  private state: State
  private seq: number
  private busy = false
  private readonly queue: Event[] = []
  private idleWaiters: Array<() => void> = []

  constructor(private readonly opts: DriverOptions) {
    this.state = opts.initial
    this.seq = opts.startSeq ?? 1
  }

  current(): State { return this.state }
  idle(): boolean { return !this.busy && this.queue.length === 0 }
  whenIdle(): Promise<void> {
    if (this.idle()) return Promise.resolve()
    return new Promise((resolve) => { this.idleWaiters.push(resolve) })
  }

  /**
   * Stamp an event and fold it.
   *
   * SERIALISED THROUGH A QUEUE. Two events folding at once would interleave mutations of the
   * same Maps, and the resulting state would depend on which promise resolved first, which
   * no replay could reproduce. The old bot's equivalent hazard was two launches in one batch
   * both claiming the last slot, and it was defended in one place by hand; here the
   * serialisation is structural.
   */
  ingest(kind: string, body: Record<string, unknown>): void {
    const event = { seq: this.seq++, at: this.opts.world.now(), run: 'live', kind, ...body } as Event
    this.opts.world.record(event)
    this.queue.push(event)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      while (this.queue.length) {
        const event = this.queue.shift()!
        const out = decide(this.state, event)
        this.state = out.state
        this.opts.onDecision?.(event, this.state, out.intents, out.refusals)
        for (const r of out.refusals) {
          // Refusals are counted inside the fold; the driver only surfaces the loud ones.
          if (r.bucket === 'feed-routing-divergence') this.opts.world.log(`routing divergence: ${r.reason}`)
        }
        for (const intent of out.intents) await this.act(intent)
      }
    } finally {
      this.busy = false
      if (this.queue.length === 0) {
        const waiters = this.idleWaiters
        this.idleWaiters = []
        for (const resolve of waiters) resolve()
      }
    }
  }

  /**
   * Do what an intent asks, and feed the answer back as an event.
   *
   * Nothing here decides anything. Every branch is "the decision asked for X, so do X and
   * report what happened".
   */
  private async act(intent: Intent): Promise<void> {
    switch (intent.kind) {
      case 'arm':
        // The DELAY is the decision's; the timer is the driver's. A chain timestamp normally
        // releases it (see the fold's feed-block path); this is the fallback for a quiet feed.
        this.opts.world.later(Math.max(0, intent.releaseAt - this.opts.world.now()), () => this.ingest('clock', {}))
        return

      case 'read': {
        const r = await this.readOutcome(intent.what, intent.args)
        // A failed read is reported as a read with no result, so the fold can drop the launch
        // with a named bucket instead of leaving it pending forever.
        if (r.error !== null) {
          this.opts.world.log(`read ${intent.what} failed after ${r.tries} tr${r.tries === 1 ? 'y' : 'ies'} in ${r.latencyMs}ms: ${r.error}`)
        }
        if (intent.what === 'receipt') {
          this.ingest('receipt', { hash: intent.args[0] ?? '', result: r.result ?? null })
        } else {
          this.ingest('chain-read', {
            request: { kind: intent.what, args: intent.args },
            result: r.result ?? null, viaKey: r.viaKey, tries: r.tries, latencyMs: r.latencyMs,
          })
        }
        return
      }

      case 'buy':
      case 'sell':
      case 'approve':
      case 'grad':
        await this.submit(intent)
        return

      case 'broadcast': {
        if (this.opts.mode !== 'live') return
        const r = await this.opts.world.broadcast(intent.raw)
        this.opts.world.log(`resend ${intent.hash.slice(0, 12)} ${r.ok ? 'ok' : (r.error ?? 'failed')}`)
        return
      }
    }
  }

  /**
   * `world.read`, with a throwing world treated as a failed read.
   *
   * The contract says it reports failure rather than throwing, and `io/world.ts` honours that. This
   * is here for the ones that cannot: a test double, or a bug. An exception escaping `act` would
   * abandon the rest of `drain()`'s queue, so every event behind it would go unfolded.
   */
  private async readOutcome(what: string, args: readonly string[]): Promise<ReadOutcome> {
    try {
      return await this.opts.world.read(what, args)
    } catch (e) {
      return { result: null, tries: 1, latencyMs: 0, viaKey: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  private async submit(intent: Intent & { kind: 'buy' | 'sell' | 'approve' | 'grad' }): Promise<void> {
    const nonce = this.opts.world.reserveNonce()
    let signed: { hash: string; raw: string }
    try {
      signed = await this.opts.world.sign(intent, nonce)
    } catch (e) {
      this.opts.world.releaseNonce(nonce)
      this.ingest('tx-send-result', { intentId: intent.intentId, hash: '', ok: false, nonceConsumed: false, uncertain: false, statusCode: null, error: `sign failed: ${String(e)}`, tSigned: 0, tSent: 0 })
      return
    }

    // BEFORE THE SOCKET WRITE, for every kind. A send that times out must leave evidence of
    // what was signed; otherwise a signed transaction can be sequenced with nobody aware it
    // exists.
    const tSigned = this.opts.world.now()
    this.ingest('tx-signed', {
      intentId: intent.intentId,
      txKind: intent.kind === 'grad' ? 'graduate' : intent.kind,
      hash: signed.hash, nonce, raw: signed.raw,
    })

    if (this.opts.mode === 'shadow') {
      // Signed, deliberately not sent. The nonce goes back because nothing consumed it.
      this.opts.world.releaseNonce(nonce)
      this.ingest('tx-send-result', { intentId: intent.intentId, hash: signed.hash, ok: false, nonceConsumed: false, uncertain: false, statusCode: null, error: 'shadow mode does not broadcast', tSigned, tSent: tSigned })
      return
    }

    const r = await this.opts.world.send(intent, nonce)
    if (r.ok || r.nonceConsumed) this.opts.world.settleNonce()
    // WITH THE ERROR, because this is the one release the sequencer had an opinion about.
    else this.opts.world.releaseNonce(nonce, r.error ?? '')
    this.ingest('tx-send-result', {
      intentId: intent.intentId, hash: r.hash || signed.hash, ok: r.ok,
      nonceConsumed: r.nonceConsumed, uncertain: r.uncertain, statusCode: null,
      error: r.error, tSigned, tSent: this.opts.world.now(),
    })
  }
}
