/**
 * PORTED from v1/src/tx/builder.ts, with only its config imports redirected.
 *
 * Not rewritten, deliberately. This is money-path code that has been sending real
 * transactions for weeks with no defect found in it, and the rewrite's whole argument is
 * about STRUCTURE, not about these ~100 lines being wrong. Reimplementing them would take
 * proven code and make it unproven for no gain.
 *
 * Diff it against the original before trusting any change:
 *   diff v2/io/builder.ts v1/src/tx/builder.ts
 */
/**
 * Transaction construction.
 *
 * Two things worth knowing. Priority fees do nothing on an Orbit chain: ordering is
 * first-come-first-served at the sequencer and any tip is refunded to the sender, so we
 * always bid zero and just keep maxFeePerGas comfortably clear of baseFee.
 *
 * And we never call eth_estimateGas. It is inflated on arbitrum-lineage chains and it
 * costs a round trip in the one place we cannot afford one. Limits are hardcoded from
 * measurements; unused gas is refunded anyway.
 */
import { encodeFunctionData } from 'viem'
import type { Hex } from 'viem'
import { curveAbi, erc20Abi } from './abi.js'
import { GAS } from './env.js'

export type UnsignedTx = {
  to: Hex
  data: Hex
  value: bigint
  gas: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  nonce: number
  chainId: number
}

let cachedBaseFee = 20_000_000n // 0.02 gwei, the observed level

export function setBaseFee(fee: bigint): void {
  if (fee > 0n) cachedBaseFee = fee
}

export function currentMaxFee(): bigint {
  const scaled = cachedBaseFee * GAS.baseFeeMultiplier
  return scaled > GAS.minMaxFeePerGas ? scaled : GAS.minMaxFeePerGas
}

function base(nonce: number, chainId: number, gas: bigint) {
  return { gas, maxFeePerGas: currentMaxFee(), maxPriorityFeePerGas: GAS.maxPriorityFeePerGas, nonce, chainId }
}

export function buildBuy(args: {
  curve: Hex; quoteIn: bigint; minTokensOut: bigint; recipient: Hex; nonce: number; chainId: number
}): UnsignedTx {
  return {
    to: args.curve,
    data: encodeFunctionData({ abi: curveAbi, functionName: 'buy', args: [args.quoteIn, args.minTokensOut, args.recipient] }),
    value: args.quoteIn, // native-quote curves require msg.value == quoteIn exactly
    ...base(args.nonce, args.chainId, GAS.limits.buy),
  }
}

export function buildApprove(args: { token: Hex; spender: Hex; nonce: number; chainId: number }): UnsignedTx {
  return {
    to: args.token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [args.spender, (1n << 256n) - 1n] }),
    value: 0n,
    ...base(args.nonce, args.chainId, GAS.limits.approve),
  }
}

export function buildSell(args: {
  curve: Hex; tokensIn: bigint; minQuoteOut: bigint; recipient: Hex; nonce: number; chainId: number
}): UnsignedTx {
  return {
    to: args.curve,
    data: encodeFunctionData({ abi: curveAbi, functionName: 'sell', args: [args.tokensIn, args.minQuoteOut, args.recipient] }),
    value: 0n,
    ...base(args.nonce, args.chainId, GAS.limits.sell),
  }
}

export const gasCostEth = (limit: bigint): number => Number(limit * currentMaxFee()) / 1e18

/**
 * What a leg actually costs, for P&L. Deliberately NOT currentMaxFee(): that carries a
 * 4x multiplier and a 0.5 gwei floor so transactions land, and unused gas is refunded
 * anyway. Accounting at the bid charged 245 microETH a trade against a measured 3.4.
 */
export const gasSpentEth = (used: bigint): number => Number(used * cachedBaseFee) / 1e18

/**
 * Why a mined transaction failed, from its receipt alone.
 *
 * These two are not the same event and must never read the same in a log. A revert with
 * gas to spare is the venue: our slippage bound lost an FCFS race, which is friction we
 * chose and priced. Consuming the entire limit is US: the ceiling is too low for the
 * transaction, no retry policy can fix it, and every one of them is a config bug.
 *
 * Treating the second as the first is exactly what hid six out-of-gas buys on 2026-08-19
 * behind a comment that said "the common case when an FCFS race is lost".
 *
 * The 98% band is for the handful of gas units a failing call can leave on the table:
 * observed out-of-gas buys landed at 149,856-150,000 against a 150,000 limit.
 */
export function classifyFailedTx(gasUsed: bigint, limit: bigint): 'out-of-gas' | 'reverted' {
  return gasUsed * 100n >= limit * 98n ? 'out-of-gas' : 'reverted'
}
