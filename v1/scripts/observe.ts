/**
 * M1 acceptance: run the entire data plane against the live chain, decide nothing.
 *
 * This answers the questions that decide whether the design holds up: does the feed keep
 * up, does the optimistic overlay agree with what the logs later confirm, how often would
 * a rival's transaction have reverted, and how many launches actually pass the filters.
 */
import { Bot } from '../src/bot.js'

const MINUTES = Number(process.env.MINUTES ?? 10)
const bot = new Bot({ mode: 'observe', dbFile: 'data/observe.db' })

let feedBlocks = 0, feedTxs = 0, gaps = 0, logCount = 0
let firstBlockAt = 0, lastBlock = 0

bot.feed.on('block', (b) => {
  feedBlocks++
  feedTxs += b.txs.length
  lastBlock = b.block
  if (!firstBlockAt) firstBlockAt = Date.now()
})
bot.feed.on('gap', (g) => { if (g.got > 0) gaps++ })
bot.logs.on('logs', (ls) => { logCount += ls.length })
bot.on('would-enter', (e: any) => {
  console.log(`  WOULD ENTER ${e.launch.token.slice(0, 10)} expect ${(Number(e.expected) / 1e18).toExponential(3)} tokens`)
})

await bot.start()
console.log(`observing for ${MINUTES} minutes...\n`)

const started = Date.now()
const report = setInterval(() => {
  const mins = (Date.now() - started) / 60_000
  const s = bot.stats
  const st = bot.state
  console.log(
    `[${mins.toFixed(1)}m] feed ${feedBlocks} blocks / ${feedTxs} txs (${(feedTxs / Math.max(1, (Date.now() - firstBlockAt) / 1000)).toFixed(0)}/s), gaps ${gaps} | ` +
    `logs ${logCount} via ${bot.logs.mode} | launches ${s.launches} pass ${s.screened} would-enter ${s.entered} | ` +
    `overlay applied ${st.overlayApplied} skipped-revert ${st.overlaySkippedRevert}`,
  )
}, 30_000)

setTimeout(async () => {
  clearInterval(report)
  const s = bot.stats
  const st = bot.state
  const elapsedMin = (Date.now() - started) / 60_000
  console.log('\n================ observe summary ================')
  console.log(`duration                ${elapsedMin.toFixed(1)} min`)
  console.log(`feed blocks             ${feedBlocks} (${(feedBlocks / elapsedMin / 60).toFixed(1)}/s), gaps ${gaps}`)
  console.log(`feed txs                ${feedTxs}`)
  console.log(`authoritative logs      ${logCount} via ${bot.logs.mode}`)
  console.log(`launches seen           ${s.launches}  (${(s.launches / elapsedMin * 60 * 24).toFixed(0)}/day extrapolated)`)
  console.log(`passed all filters      ${s.screened}  (${(s.screened / elapsedMin * 60 * 24).toFixed(0)}/day extrapolated)`)
  console.log(`would have entered      ${s.entered}`)
  console.log(`overlay txs applied     ${st.overlayApplied}`)
  console.log(`overlay txs skipped     ${st.overlaySkippedRevert} (predicted to revert on their own slippage bound)`)
  const v = st.verdicts
  const fp = v.skippedTotal ? (v.skippedThenLanded / v.skippedTotal) * 100 : 0
  console.log(`\nsimulate-before-apply, checked against what actually landed:`)
  console.log(`  predicted revert       ${v.skippedTotal}, of which ${v.skippedThenLanded} landed anyway -> ${fp.toFixed(1)}% false positives`)
  console.log(`  predicted success      ${v.appliedTotal}, of which ${v.appliedThenLanded} landed -> ${v.appliedTotal ? ((v.appliedThenLanded / v.appliedTotal) * 100).toFixed(1) : 0}% confirmed`)
  console.log(`  (a high false-positive rate means the overlay drifts and should be disabled)`)
  if (s.rejects.size) {
    console.log('rejection reasons:')
    for (const [r, n] of [...s.rejects.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${r}`)
  }
  await bot.stop()
  process.exit(0)
}, MINUTES * 60_000)
