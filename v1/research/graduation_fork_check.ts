/** Full automatic exit on a LOCAL Anvil fork. No live wallet key or live send endpoint. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, parseTransaction, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Bot } from '../src/bot.js'
import { newPosition } from '../src/strategy/exit.js'
import { Signer } from '../src/tx/signer.js'
import { NonceManager } from '../src/tx/nonce.js'
import { setBaseFee } from '../src/tx/builder.js'
import { V4, quoterAbi, permitAbi, swapData } from '../src/tx/graduated.js'
import { robinhoodChain } from '../src/config.js'
const endpoint = 'http://127.0.0.1:18545'
const client = createPublicClient({ chain: robinhoodChain, transport: http(endpoint, { timeout: 30000 }) })
assert.match(await client.request({ method: 'web3_clientVersion' }), /anvil/i)
const token = '0x753b0f74502d3d66c278a563cb04503154e6eb0d' as Hex
const curve = '0xb82a38eda8f475d1a01f301dd3e7fc4c7235cb78' as Hex
const original = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1' as Hex
const key = ('0x' + '1'.padStart(64, '0')) as Hex // public test key, only the local fork
const account = privateKeyToAccount(key)
const wallet = createWalletClient({ chain: robinhoodChain, transport: http(endpoint) })
const rpc = (method: string, params: unknown[]) => client.request({ method, params } as any)
const tokenAbi = parseAbi(['function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)', 'function approve(address,uint256) returns(bool)', 'event Transfer(address indexed from,address indexed to,uint256 value)'])
await rpc('anvil_impersonateAccount', [original])
await rpc('anvil_setBalance', [account.address, '0x8ac7230489e80000'])
// Public test keys may carry a delegation on the source chain. This is a clean
// EOA fixture on the local fork, so remove any inherited executable account code.
await rpc('anvil_setCode', [account.address, '0x'])
const tokens = await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [original] })
assert(tokens > 0n)
const funding = await wallet.writeContract({ account: original, address: token, abi: tokenAbi, functionName: 'transfer', args: [account.address, tokens], gas: 300000n })
assert.equal((await client.waitForTransactionReceipt({ hash: funding })).status, 'success')
await rpc('anvil_stopImpersonatingAccount', [original])
let dump: (() => Promise<void>) | undefined
if (process.env.FORK_DUMP === '1') {
  const dumpAccount = privateKeyToAccount(('0x' + '2'.padStart(64, '0')) as Hex)
  await rpc('anvil_setBalance', [dumpAccount.address, '0xde0b6b3a7640000'])
  await rpc('anvil_setCode', [dumpAccount.address, '0x'])
  const logs: any[] = []
  for (let fromBlock = 56954704n; fromBlock <= 56954753n; fromBlock += 10n) {
    logs.push(...await client.getLogs({ address: token, event: tokenAbi[3], fromBlock, toBlock: fromBlock + 9n }))
  }
  const receivers = [...new Set(logs.filter(l => l.args.value! > 1000000n * 10n**18n).map(l => l.args.to!))]
  let dumpTokens = 0n
  for (const holder of receivers) {
    if ([original, curve, V4.manager].some(a => a.toLowerCase() === holder.toLowerCase())) continue
    const code = await client.getCode({ address: holder })
    if (code && code !== '0x') continue
    const balance = await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [holder] })
    if (balance < 1000000n * 10n**18n) continue
    const needed = 40000000n * 10n**18n - dumpTokens
    const amount = balance < needed ? balance : needed
    await rpc('anvil_impersonateAccount', [holder])
    await rpc('anvil_setBalance', [holder, '0xde0b6b3a7640000'])
    const hash = await wallet.writeContract({ account: holder, address: token, abi: tokenAbi, functionName: 'transfer', args: [dumpAccount.address, amount], gas: 300000n })
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success')
    await rpc('anvil_stopImpersonatingAccount', [holder])
    dumpTokens += amount
    if (dumpTokens >= 40000000n * 10n**18n) break
  }
  assert(dumpTokens >= 30000000n * 10n**18n, 'no existing holder large enough for the price-drop fixture')
  const poolKey = { currency0: '0x0000000000000000000000000000000000000000' as Hex, currency1: token, fee: 0, tickSpacing: 200, hooks: V4.hook }
  const quote = async () => (await client.simulateContract({ address: V4.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey, zeroForOne: false, exactAmount: tokens, hookData: '0x' }] })).result[0]
  const sendDump = async (to: Hex, data: Hex) => {
    const hash = await wallet.sendTransaction({ account: dumpAccount, to, data, gas: 1000000n })
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success')
  }
  dump = async () => {
    const beforeQuote = await quote()
    await sendDump(token, encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [V4.permit2, dumpTokens] }))
    await sendDump(V4.permit2, encodeFunctionData({ abi: permitAbi, functionName: 'approve', args: [token, V4.router, dumpTokens, Math.floor(Date.now()/1000)+600] }))
    await sendDump(V4.router, swapData(poolKey, dumpTokens, 1n, BigInt(Math.floor(Date.now()/1000)+180)))
    const afterQuote = await quote()
    assert(afterQuote < beforeQuote * 90n / 100n, 'fixture did not exceed the former 10% bound')
    console.log('Price drop between preparation and execution', { beforeQuote: String(beforeQuote), afterQuote: String(afterQuote), dropPct: Number(beforeQuote-afterQuote)/Number(beforeQuote)*100 })
  }
}
const before = await client.getBalance({ address: account.address })
setBaseFee((await client.getBlock()).baseFeePerGas ?? 20000000n)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graduation-fork-'))
const bot = new Bot({ mode: 'live', dbFile: path.join(dir, 'bot.db') })
const owner = bot as any
owner.signer = new Signer(key)
owner.nonce = new NonceManager(() => client.getTransactionCount({ address: account.address, blockTag: 'pending' }))
await owner.nonce.init()
owner.client = client
owner.graduationRpc = client
owner.sender = { send: async (raw: Hex) => {
  const start = Date.now()
  if (dump && parseTransaction(raw).to?.toLowerCase() === V4.router.toLowerCase()) { const run = dump; dump = undefined; await run() }
  const hash = await wallet.sendRawTransaction({ serializedTransaction: raw })
  return { ok: true, hash, ms: Date.now() - start, via: 'local-anvil-only' }
} }
const started = Date.now()
const id = bot.tel.openPosition({ token, curve, live: 1, t_detect: started, t_decide: started, t_signed: started, t_sent: started,
  entry_block: 56954704, spend_wei: '20000000000000000', min_tokens_out: '1', tokens_held: String(tokens),
  entry_mark_wei: '20000000000000000', buy_hash: null, buy_ok: 1, buy_error: null, take_profit: 2 })
const pos = newPosition({ id, token, curve, tokens, spendWei: 20000000000000000n, entryMarkWei: 20000000000000000n,
  openedAt: started, buyHash: '', filled: true, takeProfitMultiple: 2 })
owner.positions.set(curve, pos)
bot.risk.reserve(token, pos.spendWei)
const params = { phantomQuote: 1680000000000000000n, reservedTokens: 285714285714285714285714285n, launchSupply: 10n**27n,
  feeBps: 100n, creatorTaxBps: 100n, snipeTaxStartBps: 9900n, snipeTaxSeconds: 3n, launchedAt: 1788796267n }
bot.state.track(curve, token, params, { trackedQuote: 0n, trackedTokens: 0n, quoteFeeBalance: 0n, creatorTaxBalance: 0n, graduated: true }, 56954753)
while (owner.positions.size && Date.now() - started < 180000) {
  owner.pumpExits()
  await new Promise(r => setTimeout(r, 50))
}
await new Promise<void>(r => setImmediate(r))
const row = bot.tel.raw().prepare('SELECT * FROM positions WHERE id=?').get(id) as any
const transactions = bot.tel.raw().prepare('SELECT kind,status,gas_wei,hash FROM graduation_transactions WHERE position_id=? ORDER BY at').all(id) as any[]
const errors = bot.tel.raw().prepare("SELECT detail FROM health WHERE component='exit' AND ok=0").all()
console.log(JSON.stringify({ elapsedMs: Date.now()-started, transactions, errors, closed: row.closed, proceeds: row.proceeds_wei }, null, 2))
assert.equal(row.closed, 1, 'automatic manager did not finish')
assert.equal(row.exit_reason, 'graduated-swap')
const remainingTokens = await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [account.address] })
assert.equal(remainingTokens, 0n)
const gas = transactions.reduce((s, r) => s + BigInt(r.gas_wei), 0n)
const after = await client.getBalance({ address: account.address })
console.log('wallet reconciliation', { before: String(before), after: String(after), gas: String(gas), proceeds: row.proceeds_wei })
assert.equal(after - before + gas, BigInt(row.proceeds_wei), 'receipt proceeds do not match the fork wallet')
assert.equal(transactions.filter(t=>t.kind.includes('approval')).length, 2)
fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ elapsedMs: Date.now()-started, transactions, proceeds:row.proceeds_wei, gas:String(gas), walletChange:String(after-before), prepGas:row.graduation_prep_gas_wei, remainingTokens:String(remainingTokens), walletAccountingExact:after-before+gas===BigInt(row.proceeds_wei), exitReason:row.exit_reason }, null, 2))
console.log('PASS: automatic exit, zero remaining tokens, exact wallet reconciliation; evidence', dir)
bot.tel.close()
