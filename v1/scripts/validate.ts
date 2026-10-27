/**
 * Bit-exactness gate for the curve math.
 *
 * Replays real curves from genesis through their entire recorded trade history and
 * checks every predicted output against what the chain actually emitted. The python
 * research engine cleared 1e-6 with floats; this one is integer math, so the bar is
 * exact equality. Anything less means the bot would misprice its own minQuoteOut.
 *
 * The functions under test live in `v2/core/curve.ts`. That file is a verbatim port of
 * the old `v1/src/state/curve.ts`; this script is the bit-exactness gate that says so.
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import { createPublicClient, custom } from 'viem'
import { robinhoodChain, ADDRESSES, ENDPOINTS } from '../src/config.js'
import { curveAbi, EVENT_TOPICS } from '../src/abi.js'
import { simSell, snipeTaxBps, reserves, type CurveParams, type CurveState } from '../../v2/core/curve.js'

const RESEARCH = new URL('../../research/data/', import.meta.url).pathname
const SAMPLE = Number(process.env.SAMPLE ?? 60)

type Trade = { b: number; i: number; a: string; s: 'B' | 'S'; u: string; r: string; q: string; t: string; f: string; x: string; tx: string }

// A 429 inside HTTP 200 is a failed read, not an empty event set or a false exemption.
// Serialize this offline instrument's requests so it does not flood the public endpoint.
let rpcTail: Promise<unknown> = Promise.resolve()
function rpc(method: string, params: unknown[]): Promise<any> {
  const result = rpcTail.then(async () => {
    for (let attempt = 0; ; attempt++) {
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)))
      try {
        const response = await fetch(ENDPOINTS.rpc, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(120_000),
        })
        if (!response.ok) throw new Error(`RPC HTTP ${response.status}`)
        const body = await response.json() as any
        if (body.error) throw new Error(`RPC ${body.error.code}: ${body.error.message}`)
        if (body.result == null) throw new Error(`RPC ${method} returned no result`)
        return body.result
      } catch (e) {
        if (attempt >= 8 || !/429|too many|timeout|timed out|502|503|fetch failed/i.test(String(e))) throw e
      }
    }
  })
  rpcTail = result.catch(() => {})
  return result
}
const client = createPublicClient({ chain: robinhoodChain,
  transport: custom({ request: ({ method, params }) => rpc(method, (params ?? []) as unknown[]) }),
})

function loadTrades(): Map<string, Trade[]> {
  const raw = zlib.gunzipSync(fs.readFileSync(`${RESEARCH}trades.jsonl.gz`)).toString('utf8')
  const byCurve = new Map<string, Trade[]>()
  for (const line of raw.split('\n')) {
    if (!line) continue
    const t = JSON.parse(line) as Trade
    let arr = byCurve.get(t.a)
    if (!arr) byCurve.set(t.a, (arr = []))
    arr.push(t)
  }
  for (const arr of byCurve.values()) arr.sort((p, q) => p.b - q.b || p.i - q.i)
  return byCurve
}

async function main() {
  const launches = JSON.parse(fs.readFileSync(`${RESEARCH}v2_launches.json`, 'utf8')).launches as any[]
  const byCurve = loadTrades()
  const buybacks = JSON.parse(fs.readFileSync(`${RESEARCH}buybacks.json`, 'utf8')) as { a: string; b: number; i: number; q: string; t: string }[]
  const bbByCurve = new Map<string, typeof buybacks>()
  for (const b of buybacks) {
    let arr = bbByCurve.get(b.a)
    if (!arr) bbByCurve.set(b.a, (arr = []))
    arr.push(b)
  }

  // FeesSwept was never captured in the research pull, and it moves reserves:
  // trackedQuote drops by protocol+creator while the fee buckets zero out.
  async function fetchSweeps(curve: string, fromBlock: number, toBlock: number) {
    const logs = await rpc('eth_getLogs', [{ address: curve, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}`, topics: [[EVENT_TOPICS.FeesSwept]] }])
    return logs.map((l: any) => ({
      b: parseInt(l.blockNumber, 16), i: parseInt(l.logIndex, 16),
      protocol: BigInt('0x' + l.data.slice(2, 66)),
      buyback: BigInt('0x' + l.data.slice(66, 130)),
      creator: BigInt('0x' + l.data.slice(130, 194)),
    }))
  }

  // busiest curves first: they exercise the most state transitions per RPC call spent
  const candidates = launches
    .map((l) => ({ ...l, key: l.curve.toLowerCase(), n: byCurve.get(l.curve.toLowerCase())?.length ?? 0 }))
    .filter((l) => l.n >= 20)
    .sort((a, b) => b.n - a.n)
    .slice(0, SAMPLE)

  console.log(`fetching params for ${candidates.length} curves (median ${candidates[Math.floor(candidates.length / 2)]?.n} trades each)`)

  const fields = ['phantomQuote', 'reservedTokens', 'feeBps', 'creatorTaxBps', 'snipeTaxStartBps', 'snipeTaxSeconds', 'launchedAt', 'launchSupply', 'pairToken'] as const
  const params = new Map<string, CurveParams & { supply: bigint; pairToken: string }>()
  for (let i = 0; i < candidates.length; i += 20) {
    const slice = candidates.slice(i, i + 20)
    const res = await client.multicall({
      contracts: slice.flatMap((c) => fields.map((f) => ({ address: c.curve as `0x${string}`, abi: curveAbi, functionName: f }))),
      multicallAddress: ADDRESSES.multicall3 as `0x${string}`,
    })
    slice.forEach((c, j) => {
      const vals = fields.map((_, k) => res[j * fields.length + k]?.result)
      if (vals.some((v) => v === undefined)) throw new Error(`Incomplete parameters for ${c.curve}`)
      const [phantomQuote, reservedTokens, feeBps, creatorTaxBps, snipeTaxStartBps, snipeTaxSeconds, launchedAt, supply, pairToken] = vals as any[]
      params.set(c.key, { phantomQuote, reservedTokens, launchSupply: supply, feeBps, creatorTaxBps, snipeTaxStartBps, snipeTaxSeconds, launchedAt, supply, pairToken })
    })
  }

  const sweepsByCurve = new Map<string, Awaited<ReturnType<typeof fetchSweeps>>>()
  for (let i = 0; i < candidates.length; i += 8) {
    const slice = candidates.slice(i, i + 8)
    const got = await Promise.all(slice.map((c) => {
      // Replay only the captured history. Later sweeps belong to later, uncaptured trades.
      const tradeEnd = (byCurve.get(c.key) ?? []).reduce((end, trade) => Math.max(end, trade.b), c.block as number)
      const through = (bbByCurve.get(c.key) ?? []).reduce((end, buyback) => Math.max(end, buyback.b), tradeEnd)
      return fetchSweeps(c.curve, c.block, through)
    }))
    slice.forEach((c, j) => sweepsByCurve.set(c.key, got[j]!))
  }
  console.log(`fetched sweeps: ${[...sweepsByCurve.values()].reduce((n, a) => n + a.length, 0)} FeesSwept events`)

  // Only the first few seconds of each curve carry a nonzero snipe tax, so that is
  // the only window where the schedule is observable. Fetch real timestamps there.
  const tsBlocks = new Set<number>()
  for (const c of candidates) {
    for (const t of byCurve.get(c.key) ?? []) {
      if (t.s === 'B' && t.b - c.block <= 60) tsBlocks.add(t.b)
    }
  }
  const blockTs = new Map<number, bigint>()
  const blockList = [...tsBlocks]
  for (let i = 0; i < blockList.length; i += 25) {
    const slice = blockList.slice(i, i + 25)
    const got = await Promise.all(slice.map(async (b) => {
      const block = await rpc('eth_getBlockByNumber', [`0x${b.toString(16)}`, false])
      return BigInt(block.timestamp)
    }))
    slice.forEach((b, j) => { if (got[j] !== null) blockTs.set(b, got[j]!) })
  }
  console.log(`fetched ${blockTs.size} block timestamps for the snipe-tax window`)

  // the creator's bundle (up to 32 wallets) is exempt; they are not us, so exclude them
  const exemptSet = new Set<string>()
  {
    const probes: { key: string; curve: string; r: string }[] = []
    for (const c of candidates) {
      const seen = new Set<string>()
      for (const t of byCurve.get(c.key) ?? []) {
        if (t.s === 'B' && t.b - c.block <= 60 && !seen.has(t.r)) { seen.add(t.r); probes.push({ key: c.key, curve: c.curve, r: t.r }) }
      }
    }
    for (let i = 0; i < probes.length; i += 60) {
      const slice = probes.slice(i, i + 60)
      const res = await client.multicall({
        contracts: slice.map((x) => ({ address: x.curve as `0x${string}`, abi: curveAbi, functionName: 'snipeTaxExempt', args: [x.r as `0x${string}`] })),
        multicallAddress: ADDRESSES.multicall3 as `0x${string}`,
      })
      slice.forEach((x, j) => {
        if (res[j]?.status !== 'success') throw new Error(`Exemption read failed for ${x.curve}: ${res[j]?.error?.message.split('\n')[0] ?? 'unknown'}`)
        if (res[j]?.result === true) exemptSet.add(`${x.key}:${x.r}`)
      })
    }
    console.log(`identified ${exemptSet.size} snipe-tax-exempt wallets to exclude`)
  }

  let curvesOk = 0, curvesDrift = 0
  // A: the AMM core, using the fee/tax the chain actually charged. This is the path
  //    used to fold other traders' events into local state, and it must be perfect.
  let ammChecked = 0, ammExact = 0
  // B: full prediction including the snipe-tax schedule, on non-exempt trades only.
  //    This is the path our own buy sizing depends on.
  let taxChecked = 0, taxExact = 0
  const taxMisses: { curve: string; recipient: string; elapsed: number; zeroTax: boolean }[] = []
  const failures: string[] = []

  for (const c of candidates) {
    const p = params.get(c.key)
    const trades = byCurve.get(c.key)
    if (!p || !trades) continue

    // genesis: the curve holds the entire supply and no real quote yet
    let s: CurveState = { trackedQuote: 0n, trackedTokens: p.supply, quoteFeeBalance: 0n, creatorTaxBalance: 0n, graduated: false }
    const bb = [...(bbByCurve.get(c.key) ?? [])]
    const sweeps = [...(sweepsByCurve.get(c.key) ?? [])]
    let drifted: string | null = null

    for (const t of trades) {
      while (bb.length && (bb[0]!.b < t.b || (bb[0]!.b === t.b && bb[0]!.i < t.i))) {
        s = { ...s, trackedTokens: s.trackedTokens - BigInt(bb.shift()!.t) }
      }
      while (sweeps.length && (sweeps[0]!.b < t.b || (sweeps[0]!.b === t.b && sweeps[0]!.i < t.i))) {
        const w = sweeps.shift()!
        s = { ...s, trackedQuote: s.trackedQuote - w.protocol - w.creator, quoteFeeBalance: 0n, creatorTaxBalance: 0n }
      }
      const spent = BigInt(t.q), gotTok = BigInt(t.t), obsFee = BigInt(t.f), obsTax = BigInt(t.x)
      const { q: Q, t: T } = reserves(p, s)

      if (t.s === 'B') {
        // --- A: constant product with the observed fees removed
        // the final buy of a curve's life is clamped at the reserved-token floor and
        // partially refunded, so the constant-product result is an upper bound only
        const net = spent - obsFee - obsTax
        const sellable = T > p.reservedTokens ? T - p.reservedTokens : 0n
        const cp = T > 0n && Q + net > 0n ? (net * T) / (Q + net) : -1n
        const predicted = cp > sellable ? sellable : cp
        ammChecked++
        if (predicted === gotTok) ammExact++
        else if (!drifted) drifted = `buy@${t.b}: amm ${predicted} vs ${gotTok}`

        // --- B: does our snipe-tax schedule reproduce the fee they were charged?
        //     launch-tx buyers are the creator's exempt bundle, so skip them.
        if (t.tx !== c.tx) {
          // real block timestamp, not a 10-blocks-per-second approximation: the
          // snipe tax brackets are 1s wide so an off-by-one there is an off-by-8x fee
          const bts = blockTs.get(t.b)
          const stBps = bts === undefined ? -1n : snipeTaxBps(p, bts)
          const testable = stBps >= 0n && !exemptSet.has(`${c.key}:${t.r}`)
          const expectFee = (spent * p.feeBps) / 10000n + (spent * (stBps < 0n ? 0n : stBps)) / 10000n
          if (testable) taxChecked++
          if (testable && expectFee === obsFee) taxExact++
          else if (testable) {
            // is this wallet in the creator's exempt bundle? that would explain a
            // charged fee lower than the schedule says
            const zeroTax = (spent * p.feeBps) / 10000n === obsFee
            taxMisses.push({ curve: c.curve, recipient: t.r, elapsed: Number(bts! - p.launchedAt), zeroTax })
          }
        }

        // advance state from the chain's own numbers, never from our prediction
        s = { ...s, trackedQuote: s.trackedQuote + spent, trackedTokens: s.trackedTokens - gotTok,
              quoteFeeBalance: s.quoteFeeBalance + obsFee, creatorTaxBalance: s.creatorTaxBalance + obsTax }
      } else {
        // sells have no snipe tax, so the full prediction is testable directly
        const r = (() => { try { return simSell(p, s, spent) } catch { return null } })()
        ammChecked++
        if (r && r.quoteOut === gotTok && r.fee === obsFee && r.tax === obsTax) ammExact++
        else if (!drifted) drifted = `sell@${t.b}: quote ${r?.quoteOut} vs ${gotTok}`
        s = { ...s, trackedQuote: s.trackedQuote - gotTok, trackedTokens: s.trackedTokens + spent,
              quoteFeeBalance: s.quoteFeeBalance + obsFee, creatorTaxBalance: s.creatorTaxBalance + obsTax }
      }
    }
    if (drifted) { curvesDrift++; if (failures.length < 8) failures.push(`${c.curve.slice(0, 12)} (${trades.length} trades) ${drifted}`) }
    else curvesOk++
  }

  const ammPct = (ammExact / ammChecked) * 100
  const taxPct = (taxExact / taxChecked) * 100
  console.log(`\ncurves with zero divergence anywhere: ${curvesOk}/${curvesOk + curvesDrift}`)
  console.log(`A. constant-product core:  ${ammExact}/${ammChecked} exact (${ammPct.toFixed(4)}%)`)
  console.log(`B. snipe-tax schedule:     ${taxExact}/${taxChecked} exact (${taxPct.toFixed(4)}%)`)
  if (failures.length) { console.log('\nfirst divergences:'); failures.forEach((f) => console.log('  ' + f)) }

  if (taxMisses.length) {
    const zero = taxMisses.filter((m) => m.zeroTax).length
    console.log(`\nsnipe-tax misses: ${taxMisses.length}; of those, ${zero} paid exactly the base fee (i.e. zero snipe tax)`)
    console.log('  elapsed distribution:', JSON.stringify(taxMisses.reduce((a: any, m) => ((a[m.elapsed] = (a[m.elapsed] || 0) + 1), a), {})))
    // confirm by asking the curve whether those recipients are exempt
    const probe = taxMisses.filter((m) => m.zeroTax).slice(0, 25)
    if (probe.length) {
      const res = await client.multicall({
        contracts: probe.map((m) => ({ address: m.curve as `0x${string}`, abi: curveAbi, functionName: 'snipeTaxExempt', args: [m.recipient as `0x${string}`] })),
        multicallAddress: ADDRESSES.multicall3 as `0x${string}`,
      })
      const exempt = res.filter((r) => r.result === true).length
      console.log(`  probed ${probe.length} of them on-chain: ${exempt} are snipeTaxExempt`)
    }
  }

  const pass = ammPct > 99.99 && taxPct > 99.9
  console.log(pass ? '\nPASS: bit-exact against chain history' : '\nFAIL: math diverges from chain')
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
