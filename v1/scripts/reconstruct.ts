/**
 * Turn a shadow run into an honest estimate of what it would have earned.
 *
 * The bot already prices its own impact through the shadow book, so the thing this adds
 * is the two frictions a paper run cannot see from the inside: whether the buy would have
 * landed where we assumed in the block's ordering, and what the rivals who fill alongside
 * us do to the price. The research pass measured exit lag as the dominant cost, so that
 * is the knob swept here.
 */
import Database from 'better-sqlite3'
import { NON_TRADE_SQL } from '../src/telemetry/db.js'

const db = new Database(process.env.DB ?? 'data/bot.db', { readonly: true })
const ETHUSD = Number(process.env.ETHUSD ?? 2145)

const rows = db.prepare(`
  SELECT token, curve, spend_wei, proceeds_wei, pnl_wei, hold_ms, exit_reason, peak_mult,
         t_detect, t_decide, t_signed, t_sent
  FROM positions WHERE closed = 1 AND buy_ok = 1
    AND exit_reason NOT IN (${NON_TRADE_SQL})
`).all() as any[]

if (!rows.length) {
  console.log('no closed shadow positions yet. run the bot in shadow mode first:  MODE=shadow npm run bot')
  process.exit(0)
}

const spend = rows.map((r) => Number(BigInt(r.spend_wei)) / 1e18)
const proceeds = rows.map((r) => Number(BigInt(r.proceeds_wei ?? '0')) / 1e18)
const turnover = spend.reduce((a, b) => a + b, 0)

// gas is a fixed, known cost: measured limits at the fee we actually bid
const GAS_ETH = (150_000 + 260_000 + 80_000) * 0.08e-9

function rot(haircut: number): number {
  let pnl = 0
  for (let i = 0; i < rows.length; i++) {
    // a haircut stands in for the order flow that would not have arrived at our worse
    // price, plus the rivals filling in the same block as us
    pnl += proceeds[i]! * (1 - haircut) - spend[i]! - GAS_ETH
  }
  return pnl / turnover
}

console.log('================ shadow reconstruction ================\n')
console.log(`closed shadow trades     ${rows.length}`)
console.log(`turnover                 ${turnover.toFixed(4)} ETH`)
console.log(`\nreturn on turnover under increasing friction:`)
console.log(`  as recorded (own impact already priced in)   ${(rot(0) * 100).toFixed(2)}%`)
for (const h of [0.02, 0.05, 0.1, 0.15]) {
  const r = rot(h)
  console.log(`  with a ${(h * 100).toFixed(0).padStart(2)}% order-flow haircut                 ${(r * 100).toFixed(2)}%   ($${(r * turnover * ETHUSD).toFixed(2)} on this sample)`)
}
console.log(`\nthe pilot gate is 3% over 500+ live trades. the haircut is the one number`)
console.log(`the research pass could not measure; the live pilot measures it directly.`)

const lat = db.prepare(`SELECT kind, ms FROM latency WHERE kind IN ('exit-decide','sequencer-rtt')`).all() as any[]
const pct = (a: number[], p: number) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)]! : NaN)
if (lat.length) {
  console.log('\nlatency reality check:')
  for (const k of ['exit-decide', 'sequencer-rtt']) {
    const v = lat.filter((l) => l.kind === k).map((l) => l.ms)
    if (v.length) console.log(`  ${k.padEnd(14)} p50 ${pct(v, 0.5).toFixed(0)}ms  p95 ${pct(v, 0.95).toFixed(0)}ms  (n=${v.length})`)
  }
}

const byReason = db.prepare(`SELECT exit_reason, COUNT(*) n, AVG(hold_ms) hold FROM positions WHERE closed=1 GROUP BY exit_reason`).all() as any[]
console.log('\nexit mix (winners in the study held 2-55s):')
for (const r of byReason) console.log(`  ${String(r.exit_reason).padEnd(14)} ${String(r.n).padStart(5)}  mean hold ${(r.hold / 1000).toFixed(1)}s`)
