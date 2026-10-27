/**
 * Approximate provider compute-unit pace since process startup.
 *
 * The socket is estimated from bytes. HTTP reads are estimated by method, including
 * normal receipt reads, graduated exits and provider log fallback. This is not the
 * provider's billing ledger: it resets on restart and excludes other processes.
 * No trading route reads allow(); only actual provider failures trigger fallback.
 *
 * Why the reads moved: the public rpc refuses reads under load ('param read failed', 962
 * launches in 24h, 469 inside the window), and it runs ~0.85s behind the socket, so a
 * socket launch waited for it. The provider already has the block: one try, no wait.
 */
export const CU = {
  eth_call: 26, eth_getTransactionByHash: 20, eth_getTransactionReceipt: 20,
  eth_getTransactionCount: 20, eth_getBalance: 20, eth_getBlockByNumber: 20,
  eth_getBlockByHash: 20, eth_getCode: 20, eth_blockNumber: 10, eth_getLogs: 60,
  eth_chainId: 0,
  eth_gasPrice: 20, eth_estimateGas: 20,
} as const
export type CuMethod = keyof typeof CU
/**
 * No verdict before this much observation. The process restarts often and the first
 * minutes after a restart at a busy hour are a burst: 69 launches in the first 80s on
 * 2026-09-06 13:26 UTC projected the socket at 57M/month against a measured 16M over the
 * previous 86 minutes, and the reads were switched off for nothing.
 */
export const MIN_OBS_MS = 10 * 60_000

export class ReadBudget {
  private cu = 0
  private since: number | null = null
  private counts: Partial<Record<CuMethod, number>> = {}

  private readonly startedAt: number

  constructor(
    /** Reference allowance for the estimate, never an execution limit. */
    readonly capPerMonth = 24_000_000,
    /** the socket's own projection, added to the total */
    private readonly extraPerMonth: () => number | null = () => null,
    private readonly now: () => number = Date.now,
    /**
     * Fraction of the day the key is in use. Both the socket and the reads run only inside
     * the entry window, and a rate measured inside it projected over 24h reads 2x high:
     * on 2026-09-06 the first window's 16M/month socket projected as 32M, tripped the cap,
     * and the reads fell back to the public rpc, which then refused 79 of them.
     */
    private readonly windowFraction: () => number = () => 1,
  ) {
    this.startedAt = this.now()
  }

  /** enough observation to call the projection a pace */
  settled(now = this.now()): boolean {
    return now - this.startedAt >= MIN_OBS_MS
  }

  spent(method: CuMethod): void {
    if (this.since === null) this.since = this.now()
    this.cu += CU[method]
    this.counts[method] = (this.counts[method] ?? 0) + 1
  }

  /** the reads alone, projected to 30 days at the rate since the first one; null before any */
  readsPerMonth(now = this.now()): number | null {
    if (this.since === null) return null
    const elapsed = Math.max(60_000, now - this.since) // the first minute is not a rate
    return (this.cu / elapsed) * 30 * 86_400_000 * this.windowFraction()
  }

  /** reads plus the socket; null until either has something to say, and until settled */
  totalPerMonth(now = this.now()): number | null {
    if (!this.settled(now)) return null
    const r = this.readsPerMonth(now)
    const x = this.extraPerMonth()
    if (r === null && x === null) return null
    return (r ?? 0) + (x ?? 0) * this.windowFraction()
  }

  /** false once the projection is past the cap */
  allow(now = this.now()): boolean {
    const t = this.totalPerMonth(now)
    return t === null || t < this.capPerMonth
  }

  get calls(): Readonly<Partial<Record<CuMethod, number>>> {
    return this.counts
  }
}
