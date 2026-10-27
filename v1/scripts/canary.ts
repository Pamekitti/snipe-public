/**
 * Phase 0: how long does it actually take for a transaction we send to land?
 *
 * The sequencer round trip is easy to measure and the sender already tracks it. What
 * that number does not tell you is inclusion: the gap between the sequencer accepting
 * the bytes and the block containing them being visible. This sends real zero-value
 * transactions to ourselves and measures both, so the hosting decision is made on
 * numbers from the machine that would run the bot rather than on an estimate.
 *
 * Costs about half a cent per probe. Needs a funded key.
 */
import { createPublicClient, http } from 'viem'
import { robinhoodChain } from '../src/config.js'
import { Signer } from '../src/tx/signer.js'
import { Sender } from '../src/tx/sender.js'
import { setBaseFee, currentMaxFee } from '../src/tx/builder.js'
import { FeedClient } from '../src/feed/client.js'
import { Telemetry } from '../src/telemetry/db.js'

const N = Number(process.env.PROBES ?? 25)
const GAP_MS = Number(process.env.GAP_MS ?? 4_000)
const LABEL = process.env.LABEL ?? 'laptop'

const client = createPublicClient({ chain: robinhoodChain, transport: http() })
const signer = new Signer()
const sender = new Sender()
const feed = new FeedClient()
const tel = new Telemetry('data/canary.db')

const pending = new Map<string, { sentAt: number; sendMs: number }>()
const results: { sendMs: number; landMs: number }[] = []

feed.on('block', (b) => {
  for (const tx of b.txs) {
    const p = pending.get(tx.hash.toLowerCase())
    if (!p) continue
    pending.delete(tx.hash.toLowerCase())
    const landMs = Date.now() - p.sentAt
    results.push({ sendMs: p.sendMs, landMs })
    tel.latency('canary-land', landMs, true, LABEL)
    console.log(`  landed in block ${b.block} after ${landMs.toFixed(0)}ms (send ack was ${p.sendMs.toFixed(0)}ms)`)
  }
})

async function main() {
  const bal = await client.getBalance({ address: signer.address })
  const fee = await client.getGasPrice().catch(() => 0n)
  setBaseFee(fee)
  console.log(`canary "${LABEL}" from ${signer.address}`)
  console.log(`balance ${(Number(bal) / 1e18).toFixed(6)} ETH, baseFee ${Number(fee) / 1e9} gwei, maxFee ${Number(currentMaxFee()) / 1e9} gwei`)
  const cost = (21_000n * currentMaxFee() * BigInt(N))
  if (bal < cost) {
    console.error(`\nneed at least ${(Number(cost) / 1e18).toFixed(6)} ETH for ${N} probes. fund ${signer.address} and rerun.`)
    process.exit(1)
  }

  await sender.start()
  feed.start()
  await new Promise((r) => setTimeout(r, 2_000)) // let the feed connect

  let nonce = Number(await client.getTransactionCount({ address: signer.address, blockTag: 'pending' }))
  for (let i = 0; i < N; i++) {
    const signed = await signer.sign({
      to: signer.address, data: '0x', value: 0n, gas: 21_000n,
      maxFeePerGas: currentMaxFee(), maxPriorityFeePerGas: 0n, nonce: nonce++, chainId: robinhoodChain.id,
    })
    const sentAt = Date.now()
    pending.set(signed.hash.toLowerCase(), { sentAt, sendMs: 0 })
    const r = await sender.send(signed.raw)
    const p = pending.get(signed.hash.toLowerCase())
    if (p) p.sendMs = r.ms
    tel.latency('canary-send', r.ms, r.ok, LABEL)
    console.log(`probe ${i + 1}/${N} ${r.ok ? 'accepted' : 'REJECTED ' + r.error} in ${r.ms.toFixed(0)}ms via ${r.via}`)
    if (!r.ok) nonce--
    await new Promise((res) => setTimeout(res, GAP_MS))
  }

  await new Promise((r) => setTimeout(r, 5_000))
  const pct = (arr: number[], p: number) => arr.length ? arr.sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))]! : NaN
  const send = results.map((r) => r.sendMs), land = results.map((r) => r.landMs)
  const rtt = sender.stats()
  console.log(`\n================ canary: ${LABEL} ================`)
  console.log(`probes landed           ${results.length}/${N}`)
  console.log(`send ack (ms)           p50 ${pct([...send], 0.5).toFixed(0)}  p95 ${pct([...send], 0.95).toFixed(0)}`)
  console.log(`send -> visible (ms)    p50 ${pct([...land], 0.5).toFixed(0)}  p95 ${pct([...land], 0.95).toFixed(0)}`)
  if (rtt) console.log(`idle rtt probe (ms)     min ${rtt.min.toFixed(0)}  med ${rtt.med.toFixed(0)}  p95 ${rtt.p95.toFixed(0)}`)
  console.log(`\nentry needs < 2000ms of headroom, exits care about the first ~200ms.`)
  await sender.stop()
  feed.stop()
  tel.close()
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
