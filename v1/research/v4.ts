import { createPublicClient, http, fallback, parseAbiItem, formatEther, keccak256, concat, pad, toHex, type Hex } from 'viem'
import Database from 'better-sqlite3'
import { robinhoodChain, ADDRESSES } from '../src/config.js'
const client = createPublicClient({ chain: robinhoodChain, transport: fallback([
  http('https://rpc.mainnet.chain.robinhood.com', { retryCount: 6, retryDelay: 2000, timeout: 20_000 }),
  http('https://robinhoodchain.blockscout.com/api/eth-rpc', { retryCount: 3, retryDelay: 2000, timeout: 20_000 }),
]) })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const FACTORY = ADDRESSES.factory as Hex
const PM = '0x8366a39CC670B4001A1121B8F6A443A643e40951' as const
const WALLET = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1' as const
const ETH = 2145
const abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'extsload', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bytes32' }] },
] as const
const evGrad = parseAbiItem('event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)')
const evInit = parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)')
const evSwap = parseAbiItem('event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)')
async function poolState(id: Hex) {
  const base = BigInt(keccak256(concat([id, pad(toHex(6n), { size: 32 })])))
  const s0 = BigInt(await client.readContract({ address: PM, abi, functionName: 'extsload', args: [toHex(base, { size: 32 })] })); await sleep(400)
  const liq = BigInt(await client.readContract({ address: PM, abi, functionName: 'extsload', args: [toHex(base + 3n, { size: 32 })] })); await sleep(400)
  return { sqrt: s0 & ((1n << 160n) - 1n), liq }
}
async function main() {
  const tip = await client.getBlockNumber(); await sleep(400)
  const db = new Database('data/bot.db', { readonly: true })
  const bags = JSON.parse((db.prepare("select value from chain_truth where key='stranded_bags'").get() as any).value).bags as any[]
  const rows: any[] = []
  for (const bg of bags) {
    const token = bg.token.toLowerCase() as Hex
    const lb = BigInt((db.prepare('select block from launches where lower(token)=?').get(token) as any).block)
    const held = await client.readContract({ address: token, abi, functionName: 'balanceOf', args: [WALLET] }); await sleep(400)
    let grad: any = null
    for (let lo = lb; lo < lb + 10_000n && !grad; lo += 2_000n) {
      const l = await client.getLogs({ address: FACTORY, event: evGrad, args: { token }, fromBlock: lo, toBlock: lo + 1_999n }); await sleep(400)
      if (l.length) grad = l[0]
    }
    if (!grad) { console.log(`${bg.id}: no PoolGraduated within 10k blocks`); continue }
    const g = grad.args
    const init = (await client.getLogs({ address: PM, event: evInit, args: { currency1: token }, fromBlock: grad.blockNumber - 3n, toBlock: grad.blockNumber + 3n }))[0]; await sleep(400)
    if (!init) { console.log(`${bg.id}: no Initialize`); continue }
    const id = init.args.id as Hex
    const p0 = Number(g.pairTokenAmount) / Number(g.tokenAmount)
    const st = await poolState(id)
    const sq = Number(st.sqrt) / 2 ** 96
    const pNow = sq > 0 ? 1 / (sq * sq) : 0
    rows.push({ id: bg.id, token, poolId: id, held, p0, pNow, liq: st.liq, gradBlock: grad.blockNumber, ethIn: g.pairTokenAmount, tokIn: g.tokenAmount })
    console.log(`${bg.id}  +${grad.blockNumber - lb} blk  ${formatEther(g.pairTokenAmount)} ETH in  liquidity now ${st.liq}`)
  }
  console.log()
  console.log('  id    at graduation$   now$      now/grad   pool liq')
  let t0 = 0, t1 = 0
  for (const r of rows) {
    const v0 = Number(r.held) / 1e18 * r.p0 * ETH, v1 = Number(r.held) / 1e18 * r.pNow * ETH; t0 += v0; t1 += v1
    console.log(`  ${String(r.id).padEnd(5)} ${v0.toFixed(2).padStart(10)}   ${v1.toFixed(2).padStart(8)}   ${(100 * r.pNow / r.p0).toFixed(1).padStart(6)}%   ${r.liq}`)
  }
  console.log(`  total ${t0.toFixed(2).padStart(10)}   ${t1.toFixed(2).padStart(8)}`)
  // the router: freshest pool only, first 10k blocks after its graduation
  const fresh = rows.reduce((a, b) => (b.gradBlock > a.gradBlock ? b : a))
  const swaps: any[] = []
  for (let lo = fresh.gradBlock; lo < fresh.gradBlock + 10_000n; lo += 2_000n) {
    try { swaps.push(...await client.getLogs({ address: PM, event: evSwap, args: { id: fresh.poolId }, fromBlock: lo, toBlock: lo + 1_999n })) } catch {}
    await sleep(400)
  }
  const senders = [...new Set(swaps.map((s) => s.args.sender as string))]
  console.log()
  console.log(`router(s) on pool ${fresh.id} in its first ~17 min: ${swaps.length} swaps via ${senders.join(', ') || '(none)'}`)
  if (swaps.length) {
    const first = swaps[0].args, last = swaps[swaps.length - 1].args
    console.log(`  price moved from ${(1 / (Number(first.sqrtPriceX96) / 2 ** 96) ** 2 / fresh.p0 * 100).toFixed(0)}% to ${(1 / (Number(last.sqrtPriceX96) / 2 ** 96) ** 2 / fresh.p0 * 100).toFixed(0)}% of graduation in that window`)
  }
  console.log('POOLKEYS=' + JSON.stringify(rows.map((r) => ({ id: r.id, token: r.token, poolId: r.poolId }))))
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1) })
