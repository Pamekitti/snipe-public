/** Pons' native ETH V4 exit. The encoding matches the official interface and the
 * confirmed HUSDP rescue on 2026-09-07. Quotes include hook fees and our own impact. */
import { decodeEventLog, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, zeroAddress, type Hex } from 'viem'
import { currentMaxFee, type UnsignedTx } from './builder.js'
import { robinhoodChain } from '../config.js'

export const V4 = {
  manager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  router: '0x8876789976dEcBfCbBbe364623C63652db8C0904',
  quoter: '0xe202BB8dd524eE9C5E679e5B5809f7A373a982Ef',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  hook: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
  gas: 1_000_000n,
  preparationGas: 2_500_000n,
} as const
export type PoolKey = { currency0: Hex; currency1: Hex; fee: number; tickSpacing: number; hooks: Hex }
export const poolType = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'
export const quoterAbi = parseAbi([
  'struct PoolKey {address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks;}',
  'struct Params {PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData;}',
  'function quoteExactInputSingle(Params params) returns(uint256 amountOut,uint256 gasEstimate)',
])
export const permitAbi = parseAbi([
  'function allowance(address owner,address token,address spender) view returns(uint160 amount,uint48 expiration,uint48 nonce)',
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
])
export const routerAbi = parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable'])
export const v4Events = parseAbi([
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
  'event HookFeeCollected(bytes32 indexed poolId,address currency,uint256 feeAmount,uint256 taxAmount)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])
export const poolId = (key: PoolKey): Hex => keccak256(encodeAbiParameters(parseAbiParameters(poolType), [key]))

export function swapData(key: PoolKey, amount: bigint, minimum: bigint, deadline: bigint): Hex {
  if (key.currency0 !== zeroAddress || key.hooks.toLowerCase() !== V4.hook.toLowerCase()) throw new Error('unsupported graduated pool')
  const swap = encodeAbiParameters(parseAbiParameters(`(${poolType} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)`),
    [{ poolKey: key, zeroForOne: false, amountIn: amount, amountOutMinimum: minimum, minHopPriceX36: 0n, hookData: '0x' }])
  const settle = encodeAbiParameters(parseAbiParameters('address,uint256'), [key.currency1, amount])
  const take = encodeAbiParameters(parseAbiParameters('address,uint256'), [zeroAddress, minimum])
  const input = encodeAbiParameters(parseAbiParameters('bytes,bytes[]'), ['0x060c0f', [swap, settle, take]])
  return encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: ['0x10', [input], deadline] })
}
export function graduatedTx(to: Hex, data: Hex, nonce: number, gas: bigint = V4.gas): UnsignedTx {
  return { to, data, nonce, value: 0n, gas, chainId: robinhoodChain.id,
    maxFeePerGas: currentMaxFee(), maxPriorityFeePerGas: 0n }
}

/** Pool Swap reports gross ETH. The verified hook's fee event supplies both deductions.
 * Restrict all three events to our pool, router and token transfer. Never use a wallet
 * balance difference, which could contain other trades in the same block. */
export function graduatedProceeds(logs: readonly { address: string; topics: readonly string[]; data: string }[], key: PoolKey, wallet: string): bigint {
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
  if (swaps !== 1 || feeEvents !== 1 || sold !== paid || sold === 0n || gross <= fees) throw new Error('graduated receipt does not prove a complete ETH sale')
  return gross - fees
}
