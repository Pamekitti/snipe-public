// What second after launch did our buys actually land in, and what did that cost?
//
// The snipe tax reads block.timestamp - launchedAt in WHOLE seconds, so the tax our fill
// paid names the bracket it landed in (about 618bps at elapsed 1, 19bps at elapsed 2, then
// nothing). The CurveBuy event of our own buy carries (quoteIn, tokensOut, fee, snipeTax).
// Receipts use the isolated research route. Paid use needs an explicit shared allowance.
//
//   npx tsx research/taxpaid.ts [days]
import { createRequire } from 'node:module'
import { EVENT_TOPICS, logWord } from '../src/abi.js'
const require = createRequire(import.meta.url)
const db = require('better-sqlite3')('data/bot.db', { readonly: true })

const { ResearchRpc } = await import('./core/acquisition-policy.mjs')
const research = new ResearchRpc()
const DAYS = Number(process.argv[2] ?? 3)
const WALLET = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
const ETHUSD = Number(process.env.ETHUSD ?? 2145)

const rpc = async (method: string, params: unknown[]) => {
  return research.request(method, params)
}
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : NaN }

const rows = db.prepare(`
  SELECT p.id, p.buy_hash, p.t_sent, p.fill_block, p.entry_block, l.launched_at,
         CAST(COALESCE(p.onchain_pnl_wei, p.pnl_wei) AS REAL) / 1e18 * ? usd
  FROM positions p JOIN launches l ON l.token = p.token
  WHERE p.exit_at > ? AND p.live = 1 AND p.closed = 1 AND p.buy_ok = 1 AND COALESCE(p.cohort, 'main') = 'main'
    AND p.exit_reason NOT IN ('recovered-flat', 'buy-reverted', 'buy-never-mined') AND p.buy_hash IS NOT NULL AND l.launched_at > 0
  ORDER BY p.id`).all(ETHUSD, Date.now() - DAYS * 86_400_000) as any[]
console.log(`${rows.length} main trades in ${DAYS}d with a buy hash`)

type R = { id: number; elapsed: number; taxBps: number; usd: number; sentAfterLaunchMs: number; blocksAfterLaunch: number }
const out: R[] = []
let fails = 0
for (const r of rows) {
  try {
    const rc: any = await rpc('eth_getTransactionReceipt', [r.buy_hash])
    if (!rc) { fails++; continue }
    const buy = (rc.logs as any[]).find((l) => l.topics?.[0] === EVENT_TOPICS.CurveBuy)
    const blk: any = await rpc('eth_getBlockByNumber', [rc.blockNumber, false])
    if (!buy || !blk) { fails++; continue }
    const quoteIn = logWord(buy.data, 0), tax = logWord(buy.data, 3)
    const taxBps = quoteIn > 0n ? Number((tax * 10_000n) / quoteIn) : 0
    const elapsed = parseInt(blk.timestamp, 16) - Number(r.launched_at)
    out.push({ id: r.id, elapsed, taxBps, usd: r.usd, sentAfterLaunchMs: r.t_sent - Number(r.launched_at) * 1000, blocksAfterLaunch: parseInt(rc.blockNumber, 16) - Number(r.entry_block) })
  } catch (e) { fails++ }
  await new Promise((res) => setTimeout(res, 60))
}
console.log(`resolved ${out.length}, failed ${fails}`)
const by = new Map<number, R[]>()
for (const r of out) { const a = by.get(r.elapsed) ?? []; a.push(r); by.set(r.elapsed, a) }
console.log('\nelapsed second at fill | trades | tax bps (median) | $/trade | win% | buy sent at (ms after launch, p50) | blocks after launch (p50)')
for (const [e, a] of [...by].sort((x, y) => x[0] - y[0])) {
  console.log(`${String(e).padStart(3)}s | ${String(a.length).padStart(4)} | ${pct(a.map((r) => r.taxBps), 0.5).toFixed(0).padStart(5)} | ${(a.reduce((s, r) => s + r.usd, 0) / a.length).toFixed(2).padStart(6)} | ${Math.round(100 * a.filter((r) => r.usd > 0).length / a.length)}% | ${pct(a.map((r) => r.sentAfterLaunchMs), 0.5)} | ${pct(a.map((r) => r.blocksAfterLaunch), 0.5)}`)
}
const two = out.filter((r) => r.elapsed === 2)
console.log(`\nof the fills at elapsed 2: sent-after-launch p10 ${pct(two.map((r) => r.sentAfterLaunchMs), 0.1)} p50 ${pct(two.map((r) => r.sentAfterLaunchMs), 0.5)} p90 ${pct(two.map((r) => r.sentAfterLaunchMs), 0.9)} ms; blocks after launch p10 ${pct(two.map((r) => r.blocksAfterLaunch), 0.1)} p50 ${pct(two.map((r) => r.blocksAfterLaunch), 0.5)}`)
// inside the target second: is an earlier send worth anything at the same tax?
console.log('\nfills at elapsed 2, by when the buy was sent (ms after launch): trades | $/trade | win% | blocks after launch p50')
for (const [lo, hi] of [[0, 2250], [2250, 2320], [2320, 2400], [2400, 2600], [2600, 1e9]] as const) {
  const a = two.filter((r) => r.sentAfterLaunchMs >= lo && r.sentAfterLaunchMs < hi)
  if (!a.length) continue
  console.log(`${lo}-${hi >= 1e9 ? 'inf' : hi} | ${String(a.length).padStart(3)} | ${(a.reduce((s2, r) => s2 + r.usd, 0) / a.length).toFixed(2).padStart(6)} | ${Math.round(100 * a.filter((r) => r.usd > 0).length / a.length)}% | ${pct(a.map((r) => r.blocksAfterLaunch), 0.5)}`)
}
console.log('fills at elapsed 2, by blocks after the launch block: trades | $/trade | win%')
for (const [lo, hi] of [[0, 15], [15, 18], [18, 21], [21, 1e9]] as const) {
  const a = two.filter((r) => r.blocksAfterLaunch >= lo && r.blocksAfterLaunch < hi)
  if (!a.length) continue
  console.log(`${lo}-${hi >= 1e9 ? 'inf' : hi} | ${String(a.length).padStart(3)} | ${(a.reduce((s2, r) => s2 + r.usd, 0) / a.length).toFixed(2).padStart(6)} | ${Math.round(100 * a.filter((r) => r.usd > 0).length / a.length)}%`)
}
console.log(`send -> fill delay (ms), all: p50 ${pct(out.map((r) => (r.elapsed * 1000) - r.sentAfterLaunchMs), 0.5)} (negative means the fill block's whole-second stamp is before the send; block stamps are seconds)`)
console.log('acquisition', research.summary())
research.close()
process.exit(0)
