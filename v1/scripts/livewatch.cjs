// Live watch for the 2026-08-18 strategy. Baselined at the last pre-rewrite position id so
// the old shadow/pilot rows never pollute the numbers. Prints one line: "ok ..." or "TROUBLE ...".
const path = require('node:path')
const { reconSummary } = require('./reconstat.cjs')
const db = require('better-sqlite3')(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true })

// the epoch boundary is OWNED by chain_truth.epoch_base_id (TruthKeeper); the literal
// 150 was the historical value and a REBASELINE would have moved the epoch while this
// monitor kept measuring from 150 forever, mixing epochs into its drawdown alarm
const truthGet = (k) => { try { return db.prepare('SELECT value FROM chain_truth WHERE key=?').get(k)?.value ?? null } catch { return null } }
const BASE = Number(process.env.WATCH_BASE_ID ?? truthGet('epoch_base_id') ?? 150)
// The ETH price, PUBLISHED by the bot into chain_truth.eth_usd and refreshed hourly since
// 2026-09-07 (src/telemetry/price.ts). This monitor used to carry `?? 2145` as its own
// copy, which is how the same trade came to show different dollars here and on the page.
// The env var and the literal remain only as the offline fallback chain.
const ETHUSD = Number(process.env.ETHUSD ?? truthGet('eth_usd') ?? 2515)
// alarm thresholds come from what the bot PUBLISHED, constants only as fallback: this
// monitor once hardcoded "no repeat deployers" while the live book had allowed 3 prior
// launches for hours, so legitimate trades read as filter leaks
const strat = (() => { try { return JSON.parse(truthGet('strategy_json') ?? '{}') } catch { return {} } })()
const MAX_HOLD = Number(strat.maxHoldMs ?? 45_000)
const MAX_PRIOR = Number(strat.maxPriorLaunches ?? 0)
// The "held too long" bar. This was the literal 70_000, chosen when the clock was 45s, and
// it became an EVERY-TRADE false alarm the moment the clock moved to 90s: a normal 90s exit
// is over 70s, so `over > 2` fired on any three healthy trades. Anything derived from the
// clock has to move with the clock. 25s of headroom is the same slack the p50 check below
// already uses, and it covers the observed sell latency (~1.2s poll + retries).
const HOLD_SLACK_MS = 25_000
const LONG_HOLD = MAX_HOLD + HOLD_SLACK_MS
// The kill switch, published by the bot (see publishStrategy), in ETH since 2026-09-07.
// Warn at 60% of it, the same threshold the dashboard uses, so the two agree instead of
// quoting different bounds at the operator. Compared in ETH on both sides: while this
// monitor multiplied its P&L by a price to meet a dollar bound, a stale price moved the
// alarm. configdrift.test.ts fails the build if a literal bound comes back here.
const DD_LIMIT_ETH = Number(strat.maxDrawdownEth ?? process.env.MAX_DRAWDOWN_ETH ?? 0.05)
const DD_WARN_ETH = DD_LIMIT_ETH * 0.6

const rows = db
  .prepare('SELECT id,hold_ms,exit_reason,pnl_wei,proceeds_wei,spend_wei,closed,token,buy_ok,onchain_pnl_wei,exit_at FROM positions WHERE id>? AND live=1')
  .all(BASE)
const closed = rows.filter((r) => r.closed === 1)
const msg = []

let p50h = 0
if (closed.length) {
  const holds = closed.map((r) => Number(r.hold_ms || 0)).sort((a, b) => a - b)
  p50h = holds[Math.floor(holds.length / 2)]
  const over = holds.filter((h) => h > LONG_HOLD).length
  // the exit clock IS the strategy now: a regression here is the expensive failure mode
  if (p50h > LONG_HOLD) msg.push(`CLOCK WRONG p50 hold ${p50h}ms (expect ~${MAX_HOLD})`)
  else if (over > 2) msg.push(`${over} trades held >${Math.round(LONG_HOLD / 1000)}s`)

  // filter leak: entries past the PUBLISHED prior-launch bound, not past zero
  const q = db.prepare(`SELECT prior_launches p FROM launches WHERE token IN (${closed.map(() => '?').join(',')})`)
  const leak = q.all(...closed.map((r) => r.token)).filter((x) => x.p !== null && x.p > MAX_PRIOR).length
  if (leak > 0) msg.push(`FILTER LEAK: ${leak} entries past the prior-launch bound (${MAX_PRIOR})`)
}

const failed = rows.filter((r) => r.buy_ok === 0).length
if (failed > 2) msg.push(`${failed} failed buys`)

// Rebuild P&L from proceeds rather than trusting pnl_wei. Rows up to id 174 were
// booked with gas priced at the BID (490k limit x 0.5 gwei = 245 microETH) instead of
// at the burn (measured 3.4). That is $0.53 of phantom cost a trade, and on 21 trades
// it turned a real -$3.94 into a reported -$14.97. Fixed in the bot from id 175; this
// reads around the stored value so the old rows stop lying too.
const GAS_ETH = 5.1e-6 // 255k gas at the observed 0.02 gwei
// Closures that never put capital on a curve, so they belong in neither numerator nor
// denominator. MUST match NON_TRADE_REASONS in src/telemetry/db.ts, which owns the list and
// exposes it as the `trades` view; a .cjs script cannot import from the TS tree. The list
// grew on 2026-08-19 and this copy is exactly the kind that drifts, so it is spelled out
// rather than inlined three times.
const NON_TRADE = new Set(['recovered-flat', 'buy-reverted', 'buy-never-mined'])
// receipt truth where the backfill worker has landed, reconstruction as the fallback.
// ONE expression, because the daily-cap line below sums the same rows over a narrower
// window: two copies of this would eventually disagree, and then the two numbers on the
// same output line would be measuring different things.
const pnlOf = (r) => r.onchain_pnl_wei != null
  ? Number(r.onchain_pnl_wei) / 1e18
  : (Number(r.proceeds_wei || 0) - (NON_TRADE.has(r.exit_reason) ? 0 : Number(r.spend_wei || 0))) / 1e18 - GAS_ETH
const pnlEth = closed.reduce((a, r) => a + pnlOf(r), 0)
// reverted buys never deployed capital, so they do not belong in the denominator
const spend = closed.reduce((a, r) => a + (NON_TRADE.has(r.exit_reason) ? 0 : Number(r.spend_wei || 0) / 1e18), 0)
const pnl = pnlEth * ETHUSD
const rot = spend ? (pnlEth / spend) * 100 : 0
const wins = closed.filter((r) => (r.onchain_pnl_wei != null ? Number(r.onchain_pnl_wei) > 0 : Number(r.proceeds_wei || 0) > Number(r.spend_wei || 0))).length
if (pnlEth <= -DD_WARN_ETH) {
  msg.push(`DRAWDOWN ${pnlEth.toFixed(4)} ETH ($${pnl.toFixed(2)}) against the ${DD_LIMIT_ETH} ETH stop`)
}

// sim-vs-live drift, from the recon loop's own database. The statistic and its bar live
// in reconstat.cjs; downstream (push.py, the report skill) parses `gap=` off this line.
let reconTail = 'recon=–'
try {
  const rdb = require('better-sqlite3')(path.join(__dirname, '..', 'data', 'recon.db'), { readonly: true })
  const last = rdb.prepare('SELECT gap_pp FROM recon WHERE ok=1 ORDER BY position_id DESC LIMIT 50').all()
  const recon = reconSummary(last.map((r) => r.gap_pp))
  reconTail = recon.text
  if (recon.alarm) msg.push(`SIM DRIFT ${reconTail}`)
} catch {} // recon.db not created yet: fine, the line just shows a dash

// Real exposure only. `rows - closed` counted buy_ok=0 bookkeeping rows as open positions,
// so this reported open=2 against a genuinely flat book for a day (ids 277 and 357, sends
// that failed and never landed). recovery.ts decides exposure from the chain balance and
// filters the same way; the dashboard's own count was already right, which is how the two
// disagreed in every report.
const openN = rows.filter((r) => r.closed !== 1 && r.buy_ok === 1).length
const tail =
  `n=${closed.length} open=${openN} rot=${rot.toFixed(2)}% ` +
  `pnl=$${pnl.toFixed(2)} win=${closed.length ? Math.round((wins / closed.length) * 100) : 0}% p50hold=${p50h}ms ` +
  `${reconTail} gate=${Math.min(closed.length, 100)}/100`
console.log((msg.length ? `TROUBLE ${msg.join(' | ')} || ` : 'ok ') + tail)
