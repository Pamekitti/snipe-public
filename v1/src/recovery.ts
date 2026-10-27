/**
 * Crash recovery.
 *
 * A bot that restarts holding tokens it has forgotten about is a bag-holder, and
 * bag-holding is what most of the losing wallets in the study were doing. So on boot we
 * reconcile against the chain: anything the database thinks is open, plus anything we
 * hold a balance of, gets its curve state rebuilt and its exit manager resurrected.
 */
import { type Hex } from 'viem'
import { robinhoodChain, ADDRESSES, ENDPOINTS } from './config.js'
import { readClient } from './rpc/read.js'
import { curveAbi, erc20Abi, EVENT_TOPICS } from './abi.js'
import { type Telemetry } from './telemetry/db.js'

export type Recovered = {
  token: string
  curve: string
  tokens: bigint
  allowance: bigint
  positionId: number | null
  spendWei: bigint
  openedAt: number
  /** we could not read the balance; treat as possibly-held, never as flat */
  unknown?: boolean
  /** Resume through swap management, including a pending receipt. */
  graduated?: boolean
}

const client = readClient(undefined, { batchWait: 4, publicLogs: true })

/**
 * @param live  1 in live mode, 0 otherwise. Scoping to the running mode is not tidiness:
 *   a shadow restart against the same bot.db used to pick up REAL open rows, and shadow's
 *   exit path books a fill without writing the socket. The row closes on fabricated
 *   proceeds, the tokens stay in the wallet, and the next live start's `closed = 0` query
 *   can no longer see them. A shadow run must never be able to close a live position.
 */
export async function recoverOpenPositions(
  tel: Telemetry,
  wallet: Hex,
  live: 0 | 1,
  // injectable for the same reason readCurve's is: this decides whether a bag is adopted or
  // abandoned, and that deserves a test that does not need a chain
  via: { multicall: typeof client.multicall } = client,
): Promise<Recovered[]> {
  // buy_ok = 0 rows are in scope on purpose, provided they got as far as a hash.
  //
  // This used to filter `buy_ok = 1`. But buy_ok records what the SENDER thought: a
  // transport failure sets it 0 while the transaction may already have been sequenced, and
  // sender.ts says as much ("a transport failure tells us nothing about whether it landed").
  // So a buy that landed after a failed-looking send was invisible to recovery forever, and
  // nothing else looks at closed=0 rows. The tokens would sit in the wallet with no owner.
  //
  // Two such rows existed on 2026-08-19 (ids 277 and 357). Both turned out never to have
  // been mined with a zero balance, so nothing was lost, but only because we got lucky about
  // which way the ambiguity fell. The balance check below is what should decide, not buy_ok.
  const rows = tel.raw().prepare(
    `SELECT id, token, curve, spend_wei, t_sent, tokens_held, buy_ok FROM positions
     WHERE closed = 0 AND live = ? AND (buy_ok = 1 OR buy_hash IS NOT NULL)`,
  ).all(live) as { id: number; token: string; curve: string; spend_wei: string; t_sent: number; tokens_held: string; buy_ok: number }[]

  if (!rows.length) return []

  // trust the chain over our own records: balance is what we can actually sell, and
  // graduated() is whether the curve will ever let us. Three reads per row, one multicall.
  const res = await via.multicall({
    contracts: rows.flatMap((r) => [
      { address: r.token as Hex, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] } as const,
      { address: r.token as Hex, abi: erc20Abi, functionName: 'allowance', args: [wallet, r.curve as Hex] } as const,
      { address: r.curve as Hex, abi: curveAbi, functionName: 'graduated' } as const,
    ]),
    multicallAddress: ADDRESSES.multicall3 as Hex,
  })

  const out: Recovered[] = []
  rows.forEach((r, i) => {
    const bal = res[i * 3]?.result as bigint | undefined
    const allow = res[i * 3 + 1]?.result as bigint | undefined
    const graduated = res[i * 3 + 2]?.result as boolean | undefined
    const swap = tel.raw().prepare('SELECT 1 FROM graduation_exits WHERE position_id=?').get(r.id)
    if (bal === undefined && (swap || graduated === true)) {
      // The swap manager can retry its own balance read while the process stays up.
      out.push({ token: r.token, curve: r.curve, tokens: BigInt(r.tokens_held || '0'),
        allowance: allow ?? 0n, positionId: r.id, spendWei: BigInt(r.spend_wei),
        openedAt: r.t_sent, graduated: true })
      return
    }
    if (bal === undefined) {
      // an rpc glitch is not evidence of an empty wallet. leave the row open so the next
      // start tries again, rather than closing a position we may still be holding.
      out.push({ token: r.token, curve: r.curve, tokens: 0n, allowance: allow ?? 0n,
        positionId: r.id, spendWei: BigInt(r.spend_wei), openedAt: r.t_sent, unknown: true })
      return
    }
    if (bal === 0n && !swap) {
      // Nothing held. Which story that is depends on whether the buy ever landed: for a
      // buy_ok = 1 row the exit went through and we never recorded it, and truth.ts goes
      // looking for the sell on chain to price it. For a buy_ok = 0 row there was never a
      // position to exit, so claiming 'recovered-flat' would send the backfill hunting for
      // a CurveSell that cannot exist and log a scary "no sell found on chain".
      const neverBought = r.buy_ok === 0
      tel.closePosition(r.id, {
        exit_reason: neverBought ? 'buy-never-mined' : 'recovered-flat',
        exit_at: Date.now(), exit_hash: null,
        proceeds_wei: '0', expected_wei: '0', pnl_wei: '0', hold_ms: 0, tokens_held: '0', peak_mult: 0,
        ...(neverBought ? { buy_error: 'send failed and no tokens ever arrived' } : {}),
      })
      return
    }
    out.push({
      token: r.token, curve: r.curve, tokens: bal, allowance: allow ?? 0n,
      ...((graduated === true || swap) ? { graduated: true } : {}),
      positionId: r.id, spendWei: BigInt(r.spend_wei), openedAt: r.t_sent,
    })
  })
  return out
}

/**
 * Rebuild a curve's params and current state from the chain in one multicall.
 *
 * The one place the 13-field list lives: bot.onLaunch reads through here too, so a field
 * added for CurveParams/CurveState changes every reader at once instead of desyncing the
 * boot path from the entry path. Callers can pass a tuned client; recovery uses
 * provider-first reads with bounded public fallback by default.
 */
/**
 * THIS chain's block number, batched with the curve reads so the state carries the block
 * it was read at. From the ArbSys precompile, NOT Multicall3.getBlockNumber(): on an
 * Arbitrum-family chain `block.number` inside the EVM is the PARENT chain's block
 * (25,918,913 against an L2 height of 56,050,470 on 2026-09-06). Read that way, every
 * tracked curve's confirmedBlock sat below every real log, the dedupe guard in
 * StateEngine.applyLog never skipped anything, the feed overlay filter never dropped
 * anything, and on the socket path the coin's first blocks were counted twice in the
 * price model: take profit fired on 2 of 46 trades that afternoon against 111 of 316 the
 * day before, and the dead-coin bail on 46% against 19%.
 */
export const ARBSYS = '0x0000000000000000000000000000000000000064' as const
const ARBSYS_BLOCK_ABI = [
  { type: 'function', name: 'arbBlockNumber', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256', name: '' }] },
] as const

export async function readCurve(curve: Hex, via: { multicall: typeof client.multicall } = client) {
  const fields = ['phantomQuote', 'reservedTokens', 'launchSupply', 'feeBps', 'creatorTaxBps', 'snipeTaxStartBps', 'snipeTaxSeconds', 'launchedAt', 'trackedQuote', 'trackedTokens', 'quoteFeeBalance', 'creatorTaxBalance', 'graduated'] as const
  const res = await via.multicall({
    contracts: [
      ...fields.map((f) => ({ address: curve, abi: curveAbi, functionName: f })),
      // the block this batch executed at, so the tracked book knows which logs it already
      // contains (state/engine.ts applyLog). Same round trip; a fake that returns only the
      // thirteen curve values reads as block 0, which disables the guard.
      { address: ARBSYS, abi: ARBSYS_BLOCK_ABI, functionName: 'arbBlockNumber' },
    ] as any,
    multicallAddress: ADDRESSES.multicall3 as Hex,
    allowFailure: false,
  })
  const [phantomQuote, reservedTokens, launchSupply, feeBps, creatorTaxBps, snipeTaxStartBps, snipeTaxSeconds, launchedAt, trackedQuote, trackedTokens, quoteFeeBalance, creatorTaxBalance, graduated] = res as any[]
  const block = Number((res as any[])[13] ?? 0)
  return {
    params: { phantomQuote, reservedTokens, launchSupply, feeBps, creatorTaxBps, snipeTaxStartBps, snipeTaxSeconds, launchedAt },
    state: { trackedQuote, trackedTokens, quoteFeeBalance, creatorTaxBalance, graduated },
    block,
  }
}

/**
 * Startup sanity check. The strategy numbers were fitted against a particular set of
 * factory parameters, so if Pons has retuned them we want to know before trading, not after.
 */
export async function checkVenueParams(): Promise<{ ok: boolean; notes: string[] }> {
  const notes: string[] = []
  try {
    const id = await client.getChainId()
    if (id !== robinhoodChain.id) return { ok: false, notes: [`chainId ${id}, expected ${robinhoodChain.id}`] }
    const head = await client.getBlock()
    const age = Date.now() / 1000 - Number(head.timestamp)
    if (age > 30) notes.push(`rpc head is ${age.toFixed(0)}s stale`)
  } catch (e) {
    return { ok: false, notes: [`rpc unreachable: ${String(e).slice(0, 80)}`] }
  }
  if (!ENDPOINTS.logsWs) {
    notes.push('no LOGS_WS_URL: falling back to http polling, which measured 100-1000ms slower')
  }
  return { ok: true, notes }
}


/**
 * readCurve with a short retry on the public endpoint's rate limit.
 *
 * The public RPC answers its rate limit as a JSON-RPC error {code: 429} inside an HTTP 200,
 * which viem surfaces as "An unknown RPC error occurred" and does not retry. 962 launches
 * were rejected 'param read failed' with that text on 2026-09-05..06, 469 of them between
 * 21:00 and 24:00 UTC inside the entry window, while the log stream kept flowing. Three
 * tries 250ms apart fit inside the ~2s between detection and entry; a launch that still
 * fails is rejected exactly as before.
 */
const RETRYABLE_READ = /429|too many requests|unknown rpc error|http request failed|timeout|timed out|fetch failed|ECONNRESET/i
export async function readCurveRetry(
  curve: Hex,
  via: { multicall: typeof client.multicall } = client,
  opts: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void>; any?: boolean; onTry?: () => void } = {},
): Promise<Awaited<ReturnType<typeof readCurve>>> {
  const tries = opts.tries ?? 3
  const delayMs = opts.delayMs ?? 250
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let last: unknown
  for (let i = 0; i < tries; i++) {
    opts.onTry?.()
    try {
      return await readCurve(curve, via)
    } catch (e) {
      last = e
      // `any`: the socket path, where the public rpc simply does not have the block yet and
      // the error can be anything from "no data" to a decode failure; every one means "wait"
      if (i === tries - 1 || !(opts.any || RETRYABLE_READ.test(String(e)))) break
      await sleep(delayMs)
    }
  }
  throw last
}
