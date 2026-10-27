// Two questions about the dev buy, answered from the chain.
//   1. Are the 'dev buy 0' rejects real (the launch had no bundled buy), or did our log fetch
//      miss the CurveBuy that sits in the same transaction?
//   2. Does the launch calldata's quoteIn equal the CurveBuy event's quoteIn (dev_buy_wei)?
//      If so the socket path can screen from calldata and never needs a receipt.
//   npx tsx research/devbuycheck.ts
import { createRequire } from 'node:module'
import { parseLaunchCalldata, parseTokenLaunched } from '../src/strategy/launch.js'
import { EVENT_TOPICS } from '../src/abi.js'
process.env.ENV_FILE = '/dev/null'
const { ADDRESSES, ENDPOINTS } = await import('../src/config.js')
const require = createRequire(import.meta.url)
const db = require('better-sqlite3')('data/bot.db', { readonly: true })

const rpc = async (method: string, params: unknown[]) => {
  await new Promise((r) => setTimeout(r, 300))
  const res = await fetch(ENDPOINTS.rpcPublic, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const j: any = await res.json()
  if (j.error) throw new Error(JSON.stringify(j.error))
  return j.result
}
const hex = (n: number) => '0x' + n.toString(16)
const since = Date.now() - 86_400_000

// 1. dev buy 0 rejects: is there a CurveBuy from that curve in the launch block?
const zeros = db.prepare("SELECT token, curve, block, detected_at FROM launches WHERE detected_at > ? AND reject_reason = 'dev buy 0' ORDER BY detected_at DESC LIMIT 25").all(since)
let real = 0, missed = 0, unknown = 0
for (const z of zeros) {
  try {
    const logs: any[] = await rpc('eth_getLogs', [{ fromBlock: hex(z.block), toBlock: hex(z.block), address: z.curve, topics: [EVENT_TOPICS.CurveBuy] }])
    if (logs.length) missed++; else real++
  } catch (e) { unknown++ }
}
console.log(`dev buy 0 rejects sampled ${zeros.length}: really no dev buy ${real}, CurveBuy WAS in the launch block (our batch missed it) ${missed}, unknown ${unknown}`)

// 2. calldata quoteIn vs event dev_buy_wei on passed launches
const passed = db.prepare("SELECT token, curve, block, dev_buy_wei FROM launches WHERE detected_at > ? AND passed = 1 AND CAST(dev_buy_wei AS REAL) > 0 ORDER BY detected_at DESC LIMIT 12").all(since)
let same = 0, diff = 0, noTx = 0
for (const p of passed) {
  try {
    const logs: any[] = await rpc('eth_getLogs', [{ fromBlock: hex(p.block), toBlock: hex(p.block), address: ADDRESSES.factory, topics: [EVENT_TOPICS.TokenLaunched] }])
    const mine = logs.map((l) => ({ l, li: parseTokenLaunched({ ...l, address: String(l.address).toLowerCase(), blockNumber: parseInt(l.blockNumber, 16), logIndex: parseInt(l.logIndex, 16), removed: false }) }))
      .find((x) => x.li && x.li.curve.toLowerCase() === p.curve.toLowerCase())
    if (!mine) { noTx++; continue }
    const tx: any = await rpc('eth_getTransactionByHash', [mine.l.transactionHash])
    const meta = parseLaunchCalldata(tx.input)
    const q = meta?.quoteInWei ?? null
    const ev = BigInt(p.dev_buy_wei)
    if (q === ev) same++
    else { diff++; console.log(`  differs: ${p.token.slice(0, 12)} calldata ${q} event ${ev}`) }
  } catch (e) { noTx++; console.log('  err', String(e).slice(0, 80)) }
}
console.log(`calldata quoteIn vs event dev buy on ${passed.length} passed launches: same ${same}, differs ${diff}, could not check ${noTx}`)
process.exit(0)
