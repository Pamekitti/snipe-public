/**
 * Pons V4 graduation: the bytes and the receipt proof.
 *
 * Restored after the 2026-09-17 deploy deleted this file as "stale" because the laptop tree
 * did not carry it. The fold already decided the after-graduation sell; without this the
 * driver could not read the factory or sign a V4 swap, so five live bags sat on a curve
 * that would no longer take them.
 *
 * Encoding matches v1 `v1/src/tx/graduated.ts` and the confirmed HUSDP rescue.
 */
import {
  decodeEventLog, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters,
  zeroAddress, type Hex,
} from 'viem'
import { currentMaxFee, type UnsignedTx } from './builder.js'
import { erc20Abi } from './abi.js'
import { chainId } from './env.js'
import type { GradStep, PoolKey } from '../core/state.js'

export const FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' as const

export const V4 = {
  manager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  router: '0x8876789976dEcBfCbBbe364623C63652db8C0904',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  hook: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
  gas: 1_000_000n,
  preparationGas: 2_500_000n,
} as const

export const poolType = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'
export const permitAbi = parseAbi([
  'function allowance(address owner,address token,address spender) view returns(uint160 amount,uint48 expiration,uint48 nonce)',
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
])
export const routerAbi = parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable'])
export const factoryGraduationAbi = parseAbi([
  'function graduate(address token)',
  'function createGraduatedPool(address token)',
  'function memeHook() view returns(address)',
  'function getLaunchedToken(address token) view returns((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))',
])
export const readyAbi = parseAbi(['function readyToGraduate() view returns (bool)'])
export const v4Events = parseAbi([
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
  'event HookFeeCollected(bytes32 indexed poolId,address currency,uint256 feeAmount,uint256 taxAmount)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])

export function poolId(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters(poolType), [{
    currency0: key.currency0 as Hex,
    currency1: key.currency1 as Hex,
    fee: key.fee,
    tickSpacing: key.tickSpacing,
    hooks: key.hooks as Hex,
  }]))
}

export function swapData(key: PoolKey, amount: bigint, minimum: bigint, deadline: bigint): Hex {
  if (key.currency0.toLowerCase() !== zeroAddress || key.hooks.toLowerCase() !== V4.hook.toLowerCase()) {
    throw new Error('unsupported graduated pool')
  }
  const swap = encodeAbiParameters(
    parseAbiParameters(`(${poolType} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)`),
    [{
      poolKey: {
        currency0: key.currency0 as Hex, currency1: key.currency1 as Hex,
        fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks as Hex,
      },
      zeroForOne: false, amountIn: amount, amountOutMinimum: minimum, minHopPriceX36: 0n, hookData: '0x',
    }],
  )
  const settle = encodeAbiParameters(parseAbiParameters('address,uint256'), [key.currency1 as Hex, amount])
  const take = encodeAbiParameters(parseAbiParameters('address,uint256'), [zeroAddress, minimum])
  const input = encodeAbiParameters(parseAbiParameters('bytes,bytes[]'), ['0x060c0f', [swap, settle, take]])
  return encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: ['0x10', [input], deadline] })
}

export function graduatedTx(to: Hex, data: Hex, nonce: number, gas: bigint = V4.gas): UnsignedTx {
  return {
    to, data, nonce, value: 0n, gas, chainId: chainId(),
    maxFeePerGas: currentMaxFee(), maxPriorityFeePerGas: 0n,
  }
}

/**
 * Pool Swap reports gross ETH. The hook fee event supplies both deductions.
 * Restrict all three events to our pool, router and token transfer. Never use a wallet
 * balance difference, which could contain other trades in the same block.
 */
export function graduatedProceeds(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  key: PoolKey,
  wallet: string,
): bigint {
  const id = poolId(key).toLowerCase()
  let gross = 0n, fees = 0n, paid = 0n, sold = 0n, swaps = 0, feeEvents = 0
  for (const l of logs) {
    let e
    try { e = decodeEventLog({ abi: v4Events, topics: l.topics as [Hex, ...Hex[]], data: l.data as Hex }) } catch { continue }
    if (e.eventName === 'Swap' && l.address.toLowerCase() === V4.manager.toLowerCase()
      && e.args.id.toLowerCase() === id && e.args.sender.toLowerCase() === V4.router.toLowerCase()) {
      if (e.args.amount0 <= 0n || e.args.amount1 >= 0n) throw new Error('unexpected swap direction')
      gross += e.args.amount0; sold -= e.args.amount1; swaps++
    }
    if (e.eventName === 'HookFeeCollected' && l.address.toLowerCase() === key.hooks.toLowerCase() && e.args.poolId.toLowerCase() === id) {
      if (e.args.currency !== zeroAddress) throw new Error('unexpected fee currency')
      fees += e.args.feeAmount + e.args.taxAmount; feeEvents++
    }
    if (e.eventName === 'Transfer' && l.address.toLowerCase() === key.currency1.toLowerCase()
      && e.args.from.toLowerCase() === wallet.toLowerCase() && e.args.to.toLowerCase() === V4.manager.toLowerCase()) paid += e.args.value
  }
  if (swaps !== 1 || feeEvents !== 1 || sold !== paid || sold === 0n || gross <= fees) {
    throw new Error('graduated receipt does not prove a complete ETH sale')
  }
  return gross - fees
}

export function buildGradTx(args: {
  readonly step: GradStep
  readonly token: Hex
  readonly pool: PoolKey | null
  readonly amountWei: bigint
  readonly deadline: number
  readonly nonce: number
}): UnsignedTx {
  switch (args.step) {
    case 'prepare-graduate':
      return graduatedTx(
        FACTORY,
        encodeFunctionData({ abi: factoryGraduationAbi, functionName: 'graduate', args: [args.token] }),
        args.nonce, V4.preparationGas,
      )
    case 'prepare-pool':
      return graduatedTx(
        FACTORY,
        encodeFunctionData({ abi: factoryGraduationAbi, functionName: 'createGraduatedPool', args: [args.token] }),
        args.nonce, V4.preparationGas,
      )
    case 'approve-token':
      return graduatedTx(
        args.token,
        encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [V4.permit2, args.amountWei] }),
        args.nonce,
      )
    case 'approve-permit':
      return graduatedTx(
        V4.permit2,
        encodeFunctionData({
          abi: permitAbi, functionName: 'approve',
          args: [args.token, V4.router, args.amountWei, args.deadline],
        }),
        args.nonce,
      )
    case 'swap': {
      if (args.pool === null) throw new Error('a swap needs the pool the grad-pool read already proved')
      return graduatedTx(
        V4.router,
        swapData(args.pool, args.amountWei, 1n, BigInt(args.deadline)),
        args.nonce,
      )
    }
  }
}
