// Read-only feasibility sample. No provider key, signer, trading instance or RPC poller.
// ENV_FILE=.env.example node --import tsx research/provider_feed_sample.ts 90
import { decodeFunctionData } from 'viem'
process.env.ENV_FILE = '/dev/null'
const { FeedClient } = await import('../src/feed/client.js')
const { launcherAbi } = await import('../src/abi.js')
const { ADDRESSES } = await import('../src/config.js')

const seconds = Math.min(120, Math.max(10, Number(process.argv[2] ?? 90)))
const startedAt = Date.now()
const feed = new FeedClient()
const rows: object[] = []
const seen = new Set<string>()
let blocks = 0, gaps = 0, decodeFailures = 0
feed.on('gap', () => { gaps++ })
feed.on('block', b => {
  if (b.timestamp * 1000 < startedAt) return // exclude reconnect backlog
  blocks++
  for (const tx of b.txs) {
    if (tx.to?.toLowerCase() !== ADDRESSES.launcher.toLowerCase() || seen.has(tx.hash)) continue
    seen.add(tx.hash)
    try {
      const decoded = decodeFunctionData({ abi: launcherAbi, data: tx.data })
      const [p, , pair, quote, , , exemptions] = decoded.args
      rows.push({ hash: tx.hash, observedAt: Date.now(), chainSecond: b.timestamp,
        native: pair.toLowerCase() === ADDRESSES.ethPair,
        symbol: p.symbol, tax: p.creatorTaxBps, exemptions: exemptions.length,
        devBuyWei: quote.toString(),
        candidate: pair.toLowerCase() === ADDRESSES.ethPair && quote >= 10n ** 16n &&
          exemptions.length >= 1 && p.creatorTaxBps <= 200,
      })
    } catch { decodeFailures++ }
  }
})
feed.start()
const progress = setInterval(() => console.error(JSON.stringify({ elapsedS: (Date.now() - startedAt) / 1000, blocks, launches: rows.length })), 30_000)
await new Promise(resolve => setTimeout(resolve, seconds * 1000))
clearInterval(progress)
feed.stop()
console.log(JSON.stringify({ startedAt, endedAt: Date.now(), blocks, gaps, decodeFailures, rows }))
process.exit(0)
