/**
 * PORTED from v1/src/tx/nonce.ts, with only its config imports redirected.
 *
 * Not rewritten, deliberately. This is money-path code that has been sending real
 * transactions for weeks with no defect found in it, and the rewrite's whole argument is
 * about STRUCTURE, not about these ~100 lines being wrong. Reimplementing them would take
 * proven code and make it unproven for no gain.
 *
 * Diff it against the original before trusting any change:
 *   diff v2/io/nonce.ts v1/src/tx/nonce.ts
 */
/**
 * Local nonce counter.
 *
 * There is no mempool here: eth_sendRawTransaction resolves against the sequencer
 * synchronously, so the answer tells us exactly what happened. A returned hash means
 * the transaction was sequenced and the nonce is spent even if execution later reverts.
 * A JSON-RPC rejection means it never entered the chain and the nonce is still ours.
 *
 * That is the whole reason we can hold a counter in memory and never pay an RPC round
 * trip to ask what our nonce is while trading.
 */
export class NonceManager {
  private next = 0
  private inFlight = 0
  private resyncing: Promise<void> | null = null

  constructor(private readonly fetchCount: () => Promise<number>) {}

  async init(): Promise<void> {
    this.next = await this.fetchCount()
    this.inFlight = 0
  }

  reserve(): number {
    this.inFlight++
    return this.next++
  }

  /** The transaction was sequenced. Nothing to undo. */
  settle(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
  }

  /**
   * Rejected before sequencing, so put the nonce back if nothing else has taken it.
   * If a later transaction already claimed a higher nonce we cannot roll back safely,
   * so we leave a hole and let the idle resync repair it.
   */
  release(nonce: number): boolean {
    this.inFlight = Math.max(0, this.inFlight - 1)
    if (nonce === this.next - 1) {
      this.next = nonce
      return true
    }
    return false
  }

  /**
   * A send the sequencer REJECTED, with its error. Releases the nonce like release(), and
   * if the rejection was "nonce too high" it also forces a resync, because that error is
   * the chain telling us our counter is ahead of it: nothing of ours can be pending above
   * the chain's count on a synchronous sequencer, so re-reading it is safe even in flight.
   *
   * 2026-09-05 21:05: the public RPC was 429ing, every 429 was classified "transport" and
   * therefore consumed, twenty sells in thirty seconds walked the counter twenty ahead,
   * and every transaction for the next 37 minutes was rejected. resyncIfIdle() could not
   * repair it because thirteen phantom buys kept inFlight above zero. This is the repair
   * that does not need idle.
   */
  rejected(nonce: number, error: string): boolean {
    const released = this.release(nonce)
    // The resync reads the chain, and the chain read can fail (the 09-05 runaway happened
    // UNDER a 429 storm, which is exactly when it would). A bare `void` on a rejecting
    // promise is an unhandled rejection, and that kills the process with every exit
    // manager in it. Swallow it: the next rejection retries, and the idle resync in
    // housekeeping repairs the counter as soon as the book is flat.
    if (/nonce too high/i.test(error)) this.forceResync().catch(() => {})
    return released
  }

  /**
   * When forced resyncs happened, so the dashboard can alert on them. The 09-05 runaway
   * ran 25 minutes with thirteen buys sent to a dead nonce and nothing in the process
   * said so; a forced resync is the chain telling us our counter was wrong, and that is
   * worth a line on a phone even when the repair worked.
   */
  private resyncTimes: number[] = []

  /** forced resyncs in the trailing hour */
  resyncs1h(now = Date.now()): number {
    this.resyncTimes = this.resyncTimes.filter((t) => now - t < 3600_000)
    return this.resyncTimes.length
  }

  /** Re-read the chain and take its answer, in flight or not. Only for a proven-wrong counter. */
  async forceResync(): Promise<void> {
    if (this.resyncing) { await this.resyncing; return }
    this.resyncTimes.push(Date.now())
    this.resyncing = (async () => {
      this.next = await this.fetchCount()
      this.inFlight = 0
    })()
    try { await this.resyncing } finally { this.resyncing = null }
  }

  get idle(): boolean {
    return this.inFlight === 0
  }
  async waitForResync(): Promise<void> { await this.resyncing }

  /** Only safe when flat: any in-flight transaction would make the answer a lie. */
  async resyncIfIdle(): Promise<boolean> {
    if (!this.idle || this.resyncing) return false
    this.resyncing = (async () => {
      const chain = await this.fetchCount()
      if (this.idle) this.next = chain
    })()
    try {
      await this.resyncing
      return true
    } finally {
      this.resyncing = null
    }
  }

  peek(): number {
    return this.next
  }
}
