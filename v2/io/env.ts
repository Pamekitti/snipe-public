/**
 * The plumbing the transports need: the key, the endpoints, the gas ceilings.
 *
 * NOT THE STRATEGY. Nothing here is a trading rule and nothing here is reviewed as one.
 * `config/strategy.toml` holds every value a decision reads, and it is versioned and goes on
 * the tape; this file holds the things that describe the MACHINE the bot runs on, which are
 * different in kind: a different RPC endpoint is not a different policy.
 *
 * That separation is why the strategy file can be shown to anyone: the secrets are here and
 * they come from the environment, never from a file in the repo and never from the tape.
 *
 * THE KEY IS READ ONCE AND NEVER LOGGED, never put on the tape, never in a refusal reason
 * and never in an error message. `requireKey()` throws a message that does not contain it.
 */

/** The chain's public HTTP RPC. No websocket, 10-block eth_getLogs on the free provider. */
const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com'

/**
 * EVERY FIELD IS A GETTER, SO EVERY READ IS A READ OF THE ENVIRONMENT AS IT IS NOW.
 *
 * These used to be plain properties, evaluated when this module was first imported. ES modules
 * are evaluated before the importing file's body, so a `main.ts` that loaded `.env` in its body
 * had already missed: `ENDPOINTS.rpc` was fixed at the public default before the file was read.
 * On 2026-09-16 that put every per-launch `meta` multicall on the free endpoint, which answered
 * `Too Many Requests` inside the entry window while the keyed provider sat unused.
 *
 * `io/dotenv.ts` now loads the files first and would be enough on its own for `main.ts`. These
 * stay getters anyway, because the next tool to read an endpoint will not remember the rule and
 * should not have to.
 */
export const ENDPOINTS = {
  get sequencer(): string { return process.env.SEQUENCER_URL ?? 'https://sequencer.mainnet.chain.robinhood.com' },
  get rpc(): string { return process.env.RPC_URL ?? PUBLIC_RPC },
  /** always the public endpoint: the poller is the authority and must not sit on a quota. */
  get rpcPublic(): string { return process.env.RPC_PUBLIC_URL ?? PUBLIC_RPC },
  /**
   * The same provider over HTTP as `logsWs`, for the per-launch reads inside the entry window.
   * Derived from the socket url so there is one secret. Empty means every read on public.
   */
  get rpcKey(): string { return process.env.RPC_KEY_URL || (process.env.LOGS_WS_URL ?? '').replace(/^wss:\/\//, 'https://') },
  /** the provider socket. Carries an API key, so it is never echoed anywhere. */
  get logsWs(): string { return process.env.LOGS_WS_URL ?? '' },
  /** nitro sequencer broadcast feed. A missing env is not a missing feed: the default is the venue. */
  get feedWs(): string { return process.env.FEED_WS_URL || 'wss://feed.mainnet.chain.robinhood.com' },
}

/**
 * What the paid endpoint charges and what we told it to stop at. For the meter in `io/cu.ts`.
 *
 * BILLING FACTS, NOT TRADING RULES, which is why they are here and not in `strategy.toml`: no
 * decision reads either of them and `cu.ts` cannot refuse a trade. They are in the environment
 * rather than inline because they are the VENDOR's numbers and the vendor changes them — this
 * account has seen $0.45 and $0.525 per million in one month — and a billing figure hardcoded in
 * a repo is a comment that starts lying the day it is written.
 *
 * `PROVIDER_CU_CAP_PER_MONTH` is the usage limit set in the provider's dashboard, in compute
 * units. Null means nobody has told this process, and the meter then reports a pace with no
 * fraction rather than inventing a denominator. Setting it is what lets the report FLAG that the
 * key will stop answering before the month is out, which on 2026-09-18 it was a day and a half
 * from doing with nothing watching.
 */
export const PROVIDER = {
  get txCache(): boolean { return process.env.RPC_TX_CACHE === '1' },
  get quietEconomy(): boolean { return process.env.RPC_QUIET_ECONOMY === '1' },
  get haltedReadEconomy(): boolean { return process.env.RPC_HALTED_READ_ECONOMY === '1' },
  get filterMode(): 'off' | 'compare' | 'live' {
    const mode = process.env.RPC_FILTER_MODE
    return mode === 'compare' || mode === 'live' ? mode : 'off'
  },
  get haltedEconomy(): boolean { return (process.env.RPC_HALTED_ECONOMY ?? process.env.RPC_STOPPED_ECONOMY) === '1' },
  get stoppedEconomy(): boolean { return process.env.RPC_STOPPED_ECONOMY === '1' },
  get cuCapPerMonth(): number | null {
    const raw = process.env.PROVIDER_CU_CAP_PER_MONTH
    if (raw === undefined || raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  },
  get usdPerMillionCu(): number | null {
    const raw = process.env.PROVIDER_USD_PER_MILLION_CU
    if (raw === undefined || raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  },
}

/**
 * The chain a transaction is signed for. A function, for the same reason as the getters above.
 *
 * 4663 IS THE CHAIN. It is `robinhoodChain.id` in `v1/src/config.ts`, the number that signed
 * every transaction v1 ever landed, and `eth_chainId` on the public RPC answers `0x1237`.
 *
 * It read 6343 from the day v2 was written until 2026-09-16, and nothing on the box sets
 * `CHAIN_ID`, so the wrong default WAS the value. The fold decided correctly, the signer signed
 * correctly, and the sequencer answered `invalid chain id for signer: have 6343 want 4663` to
 * all eight buys between 21:33 and 21:55 on the first live evening. Nothing alerted, because a
 * rejected send left the nonce with us and looked, from every projection, like a quiet market.
 * `assertChain()` below is what stops a wrong number from being silent a second time.
 */
export const chainId = (): number => Number(process.env.CHAIN_ID ?? 4663)

/**
 * Ask the chain who it is, and refuse to sign for a different one.
 *
 * THE CHECK COSTS ONE CALL AT BOOT and buys the class of failure above: the signer and the
 * sequencer disagreeing about the network, which is invisible in every projection because it
 * fails after the decision and before the money. A mismatch is fatal rather than a warning:
 * there is no useful work a signing process can do when every transaction it produces will be
 * rejected, and staying up makes an empty book look like a slow one.
 */
export async function assertChain(read: () => Promise<number>): Promise<void> {
  const want = chainId()
  const got = await read()
  if (got !== want) {
    throw new Error(
      `the chain says it is ${got} and this process signs for ${want}. Every transaction would be rejected, `
      + `so it will not start. Set CHAIN_ID=${got} if ${got} is the chain you mean to trade.`,
    )
  }
}

/** Past this, the read endpoint is behind the chain by more than any decision can tolerate. v1's number. */
const STALE_HEAD_S = 30

/**
 * What is wrong with the venue that is worth saying but not worth refusing to start over.
 *
 * v1's `checkVenueParams` printed these at boot and v2 printed nothing, so the two conditions
 * below were invisible until somebody went looking for them in a bad hour.
 *
 * A WARNING AND NOT A REFUSAL, which is the same line v1 draws. A wrong chain id is fatal because
 * every transaction the process produces would be rejected and there is no useful work left. These
 * two are degradations: the bot still trades, just worse, and a process that refuses to start
 * cannot tell anyone why.
 *
 * Pure, and given its inputs rather than reading them, so both branches are testable without a
 * chain or a clock.
 */
export function venueNotes(v: { readonly headTimestampS: number | null; readonly nowMs: number; readonly logsWs: string }): string[] {
  const notes: string[] = []
  if (v.headTimestampS === null) {
    notes.push('could not read the chain head, so its freshness is unknown')
  } else {
    const ageS = v.nowMs / 1000 - v.headTimestampS
    /**
     * A READ ENDPOINT BEHIND THE CHAIN IS THE WORST KIND OF WRONG, because every answer it gives is
     * a true answer about a past that has moved. A curve read from 30s ago prices a launch against
     * reserves that are already gone, and nothing downstream can tell that from a quiet market.
     */
    if (ageS > STALE_HEAD_S) notes.push(`the read endpoint's head is ${ageS.toFixed(0)}s stale, so every read is about a chain that has moved`)
  }
  /**
   * NO SOCKET MEANS HTTP POLLING, which v1 measured at 100-1000ms slower. The entry window is about
   * three seconds wide, so that is a large fraction of it spent not knowing a launch happened.
   */
  if (!v.logsWs) notes.push('no LOGS_WS_URL: launches arrive by http polling, which v1 measured 100-1000ms slower on a ~3s entry window')
  return notes
}

/**
 * The gas bid and the accounting figures, PORTED VERBATIM from v1/src/config.ts.
 *
 * Every comment below is kept because every number below was paid for. In particular the
 * 400k buy limit: it was 150k, calibrated when the book only passed untaxed coins costing
 * ~100k, and when the book widened to admit taxed launches six buys in four hours burned
 * the whole limit and reverted. Nothing alerted, because nothing watched buys. That is the
 * "limits tuned against a filter" scar, and the comment is the only thing standing between
 * this file and someone tidying the number back down.
 */
export const GAS = {
  maxPriorityFeePerGas: 0n,
  baseFeeMultiplier: 4n,
  minMaxFeePerGas: 500_000_000n, // 0.5 gwei floor
  // hardcoded because eth_estimateGas is inflated on arbitrum lineage and costs an RTT.
  //
  // THESE ARE A BID SIZED FOR THE TAIL, NOT THE MEDIAN. Unused gas is refunded, nothing
  // in the tree budgets against a limit (gasCostEth is exported and called nowhere), and
  // burning a full 400k at the 0.5 gwei floor is $0.43 worst case against a $16 trade. So
  // the only thing a tight limit buys is lost entries.
  //
  // buy 150_000 -> 400_000 on 2026-08-19. It was calibrated when the book only passed
  // creator-tax-0 coins costing ~99.6k (p50 99,618 / max 102,638 over 17 receipts). Then
  // the book widened to admit ctax 100/200bps launches, which went 0% -> 18% of everything
  // that passes, successful buys climbed to 118,040, and SIX buys in the next four hours
  // burned the entire limit and reverted: 149,856 / 149,858 / 149,898 / 149,899 / 149,902
  // / 150,000 exactly, status 0 and zero logs, which is what out-of-gas looks like on a
  // receipt. Buy failures went 6/297 (2.0%) -> 9/24 (37.5%), p=5.6e-10 on an exact
  // binomial. Nothing alerted, because nothing watched buys.
  //
  // 400k is deliberately past what the evidence pins down: the node is pruned, eth_call at
  // a historical block answers "metadata is not found", so the failures cannot be traced
  // and their true ceiling is unknown beyond ">150k". The jump from 118k to >150k says
  // they take a different path, and a buy that tips a curve into graduation runs the
  // migration, which is plausibly 300k on its own. positions.buy_gas_used now records raw
  // units per leg, so replace this with the measured p99 once a day of trades has landed.
  //
  // sell 260_000 -> 400_000 in the same pass. Sells are healthy today (p50 78,146 / p95
  // 94,541 / max 94,541 over 17 receipts, 2.75x clear) and none has ever run out of gas. It
  // moves anyway for two reasons. A failed sell is strictly worse than a failed buy: it
  // leaves a bleeding position that reconcileSell retries twelve times while widening a
  // slippage bound that was never the problem. And graduationExitAt exists because a curve
  // CAN slam the door mid-hold, which is precisely the expensive path a tight ceiling would
  // fail on. Refunds mean there is nothing to trade off.
  // On 2026-09-23, 80k approvals were refused with "intrinsic gas too low" while
  // the same period's reverted sells used 176k-181k. Allow for the chain's data fee
  // component as well as contract execution. Unused gas is not charged.
  limits: { buy: 400_000n, approve: 400_000n, sell: 400_000n },
  // What we actually burn, measured from 40 receipts on 2026-08-18: buy p50 100,161,
  // sell p50 77,276 / p95 113,472, at an effectiveGasPrice of 0.0200 gwei. Confirmed
  // 2026-08-19 on 34 more receipts: buy p50 ~100k either side of the book widening, sell
  // p50 78,146 / p95 94,541. Charging P&L at limit x maxFee overstated cost by 71x and fed
  // a phantom drawdown into the kill switch, so these stay the accounting numbers and
  // truth.ts backfills real receipt gas over the top of them.
  used: { buy: 105_000n, approve: 50_000n, sell: 100_000n },
} as const

/**
 * The signing key, or a refusal that does not contain it.
 *
 * Deliberately a function rather than a module constant: `observe` mode must be able to run
 * with no key at all, and a constant would make importing this module fatal on a machine
 * that has none. The tape writer is started with `PRIVATE_KEY: ''` for the same reason.
 */
export function requireKey(): string {
  const pk = process.env.PRIVATE_KEY ?? ''
  if (!pk.startsWith('0x') || pk.length !== 66) {
    throw new Error('PRIVATE_KEY must be a 0x-prefixed 32-byte hex key. It is read from the environment and never logged.')
  }
  return pk
}

export const hasKey = (): boolean => (process.env.PRIVATE_KEY ?? '').length === 66
