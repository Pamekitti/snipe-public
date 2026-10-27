// 6 minutes: every non-block message the decoder returns, with its sequence number, and
// the gap events beside them. Is a gap always an ignored message?
//
// Run this from the LAPTOP. It needs nothing but the public feed url, and a second full
// decoder on the box repeats the bot's hot path (base64 + RLP + parseTransaction +
// keccak256 for every transaction in every frame) on two shared cores while it trades.
//
// The gap rule below is deliberately NOT FeedClient's: the client advances lastSeq past
// an ignored message so production never reports that gap, which is the exact behaviour
// this script exists to characterise. Reusing the client would erase the measurement.
import WebSocket from 'ws'
import { decodeFrame } from '../src/feed/decoder.js'
process.env.ENV_FILE = '/dev/null'
const { ENDPOINTS } = await import('../src/config.js')
const ws = new WebSocket(ENDPOINTS.feed, { perMessageDeflate: false })
let last = 0, blocks = 0, gaps = 0, ignored = new Map<string, number>(), gapAfterIgnored = 0, gapOther: string[] = []
let lastIgnoredSeq = -1
ws.on('message', (d) => {
  // decodeFrame already carries each ignored message's sequenceNumber, so the frame is
  // parsed once. Re-parsing it here to rebuild a positional seqs[] mis-filed every gap
  // in any frame the decoder summarised into one item (bad json, no messages array).
  for (const r of decodeFrame(d.toString())) {
    if (r.kind === 'ignored') { ignored.set(r.reason, (ignored.get(r.reason) ?? 0) + 1); lastIgnoredSeq = r.sequenceNumber ?? -1; continue }
    if (r.kind !== 'block') continue
    blocks++
    if (last > 0 && r.block.block !== last + 1 && r.block.block > last) {
      gaps++
      if (lastIgnoredSeq > last && lastIgnoredSeq < r.block.block) gapAfterIgnored++
      else gapOther.push(`${last}->${r.block.block} (last ignored seq: ${lastIgnoredSeq})`)
    }
    if (r.block.block > last) last = r.block.block
  }
})
await new Promise((r) => setTimeout(r, 360_000))
console.log(`blocks ${blocks} | gaps ${gaps} | of which right after an ignored message ${gapAfterIgnored} | ignored:`, Object.fromEntries(ignored))
console.log('other gaps:', gapOther.slice(0, 8).join(' | '))
ws.terminate(); process.exit(0)
