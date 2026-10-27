/**
 * What the paid endpoint is costing, in the provider's own unit.
 *
 * A METER AND NEVER A GATE. v1 shipped the gating version (`v1/src/rpc/budget.ts`,
 * `ReadBudget.allow`) and it was removed on 2026-09-06 because the projection read 99% of pace
 * with 1% of the month spent, and it would have moved the reads onto a public RPC that was
 * refusing 1,100 polls an hour, in the busiest hour of the week, on a prediction. Being early is
 * what pays. A provider that actually refuses is already handled by the fallback and the retry.
 * So this counts, and says nothing about what to do. Nothing here is imported by `core/`, nothing
 * here can refuse a trade, and `allow()` deliberately does not exist.
 *
 * WHY IT EXISTS AT ALL. On 2026-09-18 the account had burnt 56.6M of a 95.2M cap and nothing in
 * v2 could say so: `projections/history.ts` counts reads but explicitly cannot price them, and the
 * one number that mattered — CU a day against the cap — lived only on the provider's website. An
 * exhausted key 429s the launch socket and the entry reads together, so "how long until the paid
 * endpoint stops answering" is an operational question the bot should be able to answer itself.
 *
 * WHAT IT CANNOT SEE, stated so a small number is not misread as a safe one:
 *   - It counts from THIS PROCESS START. It is not the account's billing period, and the box has
 *     restarted 95 times in 50 hours. The provider's usage page is the invoice; this is the pace.
 *   - It sees only this process. Another app, a laptop `validate` run or a research script on the
 *     same key are invisible to it.
 *   - Keyed requests that do not name their method are charged a nominal per-request figure. See
 *     `CU_PER_UNTYPED_REQUEST`.
 *   - A 429 or a 403 may be billed at zero by the provider and is counted here anyway, so the
 *     meter errs high on a failing key.
 */

/**
 * The provider's published cost per JSON-RPC method, ported from `v1/src/rpc/budget.ts`.
 *
 * Verified against the provider's compute-unit table on 2026-09-18. `eth_getLogs` at 60 and
 * `eth_blockNumber` at 10 are the two that matter: together they are the 70 CU the log poller
 * spends per tick, which was ~97% of this account's burn.
 *
 * A method absent from this table is charged `CU_PER_UNTYPED_REQUEST` rather than zero: an
 * unpriced call is an unknown cost, and rounding unknown down to free is how a meter starts
 * lying.
 */
export const CU: Readonly<Record<string, number>> = {
  eth_chainId: 0,
  eth_blockNumber: 10,
  eth_subscribe: 10,
  eth_unsubscribe: 10,
  eth_maxPriorityFeePerGas: 10,
  eth_feeHistory: 10,
  eth_estimateGas: 20,
  eth_gasPrice: 20,
  eth_getBalance: 20,
  eth_getBlockByHash: 20,
  eth_getBlockByNumber: 20,
  eth_getCode: 20,
  eth_getStorageAt: 20,
  eth_getTransactionByHash: 20,
  eth_getTransactionCount: 20,
  eth_getTransactionReceipt: 20,
  eth_getFilterChanges: 20,
  eth_newFilter: 20,
  eth_call: 26,
  eth_sendRawTransaction: 40,
  eth_getLogs: 60,
}

/** Subscription and webhook traffic is billed by the byte, not by the event. */
export const CU_PER_BYTE = 0.04

/**
 * What one keyed request costs when this meter never learned its method.
 *
 * Every read in `io/world.ts` goes out through viem, which reports that a request happened but
 * not what was in it, and reading the body to find out would consume the stream on a live trading
 * path. So those are counted per REQUEST at this nominal rate. 26 is `eth_call`, because almost
 * every one of them is a multicall; the provider's own rule of thumb for mixed traffic is 27.
 *
 * It is a floor-ish estimate on ~3% of the bill. The poller, which is the other 97%, names its
 * methods exactly.
 */
export const CU_PER_UNTYPED_REQUEST = 26

/**
 * How long this must run before it will extrapolate a pace.
 *
 * v1's number and v1's reason: a restart during a busy minute projected the socket at 57M/month
 * against a measured 16M, because the first seconds after a boot are a burst. The TOTAL is a fact
 * and is reported immediately; only `perDay`, `perMonth` and the dollars wait for this.
 */
export const MIN_OBS_MS = 10 * 60_000

/** The meter's answer. `perDay` and below are null until `MIN_OBS_MS` has passed. */
export type CuReading = {
  /** compute units this process has spent on the keyed endpoint since it booted */
  readonly cu: number
  readonly sinceMs: number
  /** extrapolated from the rate above, never a measurement of a month */
  readonly perDay: number | null
  readonly perMonth: number | null
  readonly usdPerMonth: number | null
  /** projected month against the configured cap, or null when either is unknown */
  readonly capFraction: number | null
  readonly capPerMonth: number | null
  /** busiest methods first, so the bill has a cause and not just a size */
  readonly byMethod: readonly { readonly method: string; readonly calls: number; readonly cu: number }[]
}

export class ProviderMeter {
  private cu = 0
  private readonly startedAt: number
  private readonly calls = new Map<string, { calls: number; cu: number }>()

  constructor(
    private readonly now: () => number = Date.now,
    /** the account's monthly usage limit in CU, or null when nobody has told us */
    private readonly capPerMonth: number | null = null,
    private readonly usdPerMillion: number | null = null,
  ) {
    this.startedAt = this.now()
  }

  /** One JSON-RPC call whose method we know. */
  method(method: string): void {
    this.charge(method, CU[method] ?? CU_PER_UNTYPED_REQUEST)
  }

  /** One keyed request whose method we do not know. See `CU_PER_UNTYPED_REQUEST`. */
  request(label = 'untyped request'): void {
    this.charge(label, CU_PER_UNTYPED_REQUEST)
  }

  /** Subscription payload delivered over the socket, billed by the byte. */
  bytes(n: number, label = 'subscription bytes'): void {
    if (!Number.isFinite(n) || n <= 0) return
    this.charge(label, n * CU_PER_BYTE)
  }

  private charge(label: string, cu: number): void {
    this.cu += cu
    const row = this.calls.get(label)
    if (row) { row.calls++; row.cu += cu } else this.calls.set(label, { calls: 1, cu })
  }

  reading(now = this.now()): CuReading {
    const sinceMs = Math.max(0, now - this.startedAt)
    const settled = sinceMs >= MIN_OBS_MS
    // Guarded against a zero elapsed even when settled: a fake clock can sit still.
    const perDay = settled && sinceMs > 0 ? (this.cu / sinceMs) * 86_400_000 : null
    const perMonth = perDay === null ? null : perDay * 30
    const byMethod = [...this.calls.entries()]
      .map(([method, r]) => ({ method, calls: r.calls, cu: r.cu }))
      .sort((a, b) => b.cu - a.cu)
    return {
      cu: this.cu,
      sinceMs,
      perDay,
      perMonth,
      usdPerMonth: perMonth === null || this.usdPerMillion === null ? null : (perMonth / 1_000_000) * this.usdPerMillion,
      capFraction: perMonth === null || this.capPerMonth === null || this.capPerMonth <= 0 ? null : perMonth / this.capPerMonth,
      capPerMonth: this.capPerMonth,
      byMethod,
    }
  }
}
