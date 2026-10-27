// Passive: what is the socket actually worth? No trades, no receipts, no paid reads.
//
// For each launch the socket pushes, two clocks start:
//   (a) ms until the PUBLIC rpc can serve the curve's params (readCurve). Before that the bot
//       would reject the launch 'param read failed', so a socket lead the public rpc cannot
//       serve is worth nothing without paid reads.
//   (b) ms until our own poller (public rpc, the transport that trades today) delivers the
//       same launch. That is the lead the socket really has over what we run.
// Prints percentiles every minute and at the end.
//
//   set -a; . ./.env; set +a; npx tsx research/wsgap.ts 40      (minutes)
import WebSocket from 'ws'
import { ResearchPolicy } from './core/acquisition-policy.mjs'
process.env.ENV_FILE = '/dev/null'
process.env.LOGS_WS_URL = '' // the poller instance below must not open a socket of its own
const { LogsSubscriber } = await import('../src/logs/subscriber.js')
const { parseTokenLaunched } = await import('../src/strategy/launch.js')
const { readCurve } = await import('../src/recovery.js')
const { ADDRESSES } = await import('../src/config.js')
const { EVENT_TOPICS } = await import('../src/abi.js')

const URL = process.env.RESEARCH_WS_URL || ''
if (!URL) { console.error('RESEARCH_WS_URL is required for the paid socket probe'); process.exit(1) }
const policy = new ResearchPolicy([URL])
const MINUTES = Number(process.argv[2] ?? 40)
const MAX_INFLIGHT = 2 // probes on the public rpc at once; the bot shares that server
const PROBE_MS = 250
const PROBE_DEADLINE_MS = 6_000

const hexToNum = (h: string) => parseInt(h, 16)
const norm = (l: any) => ({
  address: String(l.address).toLowerCase(), topics: l.topics, data: l.data,
  blockNumber: hexToNum(l.blockNumber), logIndex: hexToNum(l.logIndex),
  transactionHash: l.transactionHash, blockHash: l.blockHash, removed: false,
})
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN }

const seenWs = new Map<string, number>() // curve -> socket arrival ms (-1: the poller had it first)
const gapA: number[] = [], gapB: number[] = []
let inflight = 0, probes = 0, failA = 0, pollFirst = 0

const poller = new LogsSubscriber(undefined, () => false)
poller.on('logs', (ls) => {
  const t = Date.now()
  for (const l of ls) {
    if (l.topics[0] !== EVENT_TOPICS.TokenLaunched) continue
    const li = parseTokenLaunched(l)
    if (!li) continue
    const t0 = seenWs.get(li.curve)
    if (t0 === undefined) { pollFirst++; seenWs.set(li.curve, -1); continue }
    if (t0 > 0) gapB.push(t - t0)
  }
})
await poller.start()

const ws = new WebSocket(URL)
ws.on('open', () => { policy.beforeSend(URL, 1); ws.send(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'eth_subscribe',
  params: ['logs', { address: ADDRESSES.factory, topics: [EVENT_TOPICS.TokenLaunched] }],
})) })
ws.on('message', (d) => {
  let m: any
  try { m = JSON.parse(d.toString()) } catch { return }
  const r = m?.params?.result
  if (!r?.topics) return
  const t0 = Date.now()
  const li = parseTokenLaunched(norm(r))
  if (!li || seenWs.has(li.curve)) return
  seenWs.set(li.curve, t0)
  if (inflight >= MAX_INFLIGHT) return
  inflight++; probes++
  void (async () => {
    const deadline = t0 + PROBE_DEADLINE_MS
    let ok = false
    while (Date.now() < deadline) {
      try { await readCurve(li.curve as any); ok = true; break } catch { await new Promise((r) => setTimeout(r, PROBE_MS)) }
    }
    if (ok) gapA.push(Date.now() - t0); else failA++
    inflight--
  })()
})
ws.on('error', (e) => console.log('ws error', e.message))
ws.on('close', () => console.log('ws closed'))

const report = (tag: string) => console.log(
  `${tag} socket launches=${[...seenWs.values()].filter((v) => v > 0).length} pollerFirst=${pollFirst} probes=${probes} | ` +
  `(a) public rpc serves the curve: n=${gapA.length} p50=${pct(gapA, 0.5)}ms p90=${pct(gapA, 0.9)}ms never<6s=${failA} | ` +
  `(b) socket lead over our poller: n=${gapB.length} p50=${pct(gapB, 0.5)}ms p90=${pct(gapB, 0.9)}ms`)
const iv = setInterval(() => report(new Date().toISOString().slice(11, 19)), 60_000)
await new Promise((r) => setTimeout(r, MINUTES * 60_000))
clearInterval(iv)
report('FINAL')
poller.stop(); ws.terminate(); policy.close(); process.exit(0)
