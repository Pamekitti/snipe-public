// 30s of an explicitly bounded research socket, window forced open: does a launch arrive
// over the socket before the poller, and does it arrive WITH its own transaction's dev buy
// (the 2026-09-06 review catch: a bare launch log screens as "dev buy 0" and is rejected)?
import { ResearchPolicy } from './core/acquisition-policy.mjs'
const socket = process.env.RESEARCH_WS_URL ?? ''
if (!socket) throw new Error('RESEARCH_WS_URL is required for the paid socket probe')
const policy = new ResearchPolicy([socket]); policy.beforeSend(socket, 1)
process.env.ENV_FILE = '/dev/null'
process.env.LOGS_WS_URL = socket
const { LogsSubscriber } = await import('../src/logs/subscriber.js')
const { EVENT_TOPICS } = await import('../src/abi.js')
const name = (t: string) => Object.entries(EVENT_TOPICS).find(([, v]) => v === t)?.[0] ?? t.slice(0, 10)
const s = new LogsSubscriber(undefined, () => true)
s.on('ws', (x) => console.log('ws:', JSON.stringify(x)))
s.on('status', (x) => console.log('poll:', JSON.stringify(x)))
let wsBatches = 0, withBuy = 0
s.on('logs', (ls) => {
  const launch = ls.find((l) => l.topics[0] === EVENT_TOPICS.TokenLaunched)
  if (!launch) return
  const sameTx = ls.filter((l) => l.transactionHash === launch.transactionHash)
  const buy = sameTx.some((l) => l.topics[0] === EVENT_TOPICS.CurveBuy)
  // a socket batch is small (one tx); a poller batch carries whole blocks
  const viaWs = ls.length === sameTx.length
  if (viaWs) { wsBatches++; if (buy) withBuy++ }
  console.log(`${viaWs ? 'WS  ' : 'POLL'} launch block ${launch.blockNumber} tx ${launch.transactionHash.slice(0, 10)}: ${sameTx.map((l) => name(l.topics[0])).join('+')}${buy ? '' : '  <-- NO DEV BUY'}`)
})
await s.start()
await new Promise((r) => setTimeout(r, 30_000))
console.log(`after 30s: wsUp=${s.wsUp} wsLaunches=${s.wsLaunches} wsFirstSeen=${s.wsFirstSeen} receiptMisses=${s.wsReceiptMisses} socketBatches=${wsBatches} withDevBuy=${withBuy} bytes=${s.wsBytes} projected ${((s.wsCuPerMonth() ?? 0) / 1e6).toFixed(1)}M CU/month; poll healthy=${s.healthy} failures=${s.failures1h()}`)
s.stop(); policy.close(); process.exit(0)
