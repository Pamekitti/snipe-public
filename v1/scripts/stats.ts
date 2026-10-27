/**
 * What happened. Reads the telemetry database and reports the numbers the go/no-go
 * decision actually turns on: return on turnover, the latency budget, and the exit mix.
 */
import Database from 'better-sqlite3'
import { STRATEGY } from '../src/config.js'
import { NON_TRADE_SQL } from '../src/telemetry/db.js'

const db = new Database(process.env.DB ?? 'data/bot.db', { readonly: true })
const ETHUSD = Number(process.env.ETHUSD ?? 2145)
const pct = (a: number[], p: number) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]! : NaN)

// the `trades` view owns what counts: closed, LIVE (this file used to average shadow
// rows into live results), no bookkeeping closures, receipt-true P&L where backfilled
const closed = db.prepare(`SELECT * FROM trades`).all() as any[]
const bookkeeping = (db.prepare(
  `SELECT COUNT(*) n FROM positions WHERE closed = 1 AND exit_reason IN (${NON_TRADE_SQL})`,
).get() as any).n
const all = db.prepare(`SELECT COUNT(*) n FROM positions`).get() as any
const launches = db.prepare(`SELECT COUNT(*) n, SUM(passed) p FROM launches`).get() as any

console.log('================ pons sniper: results ================\n')
console.log(`launches seen            ${launches.n}`)
console.log(`passed filters           ${launches.p ?? 0}`)
console.log(`positions opened         ${all.n}`)
console.log(`positions closed         ${closed.length}`)
if (bookkeeping) console.log(`non-trades excluded      ${bookkeeping} (recovered orphans / reverted buys)`)
console.log('')

if (closed.length) {
  const pnl = closed.map((r) => Number(r.pnl_true_wei ?? 0) / 1e18)
  const spend = closed.map((r) => Number(BigInt(r.spend_wei ?? '0')) / 1e18)
  const total = pnl.reduce((a, b) => a + b, 0)
  const turnover = spend.reduce((a, b) => a + b, 0)
  const wins = pnl.filter((p) => p > 0).length
  const holds = closed.map((r) => r.hold_ms as number).filter(Boolean)

  console.log(`return on turnover       ${((total / turnover) * 100).toFixed(2)}%   <- the go/no-go number (gate: 3%)`)
  console.log(`total pnl                ${total.toFixed(5)} ETH  ($${(total * ETHUSD).toFixed(2)})`)
  console.log(`turnover                 ${turnover.toFixed(4)} ETH`)
  console.log(`win rate                 ${((wins / closed.length) * 100).toFixed(1)}%  (${wins}/${closed.length})`)
  console.log(`mean pnl per trade       $${((total / closed.length) * ETHUSD).toFixed(3)}`)
  console.log(`hold time (s)            p50 ${(pct(holds, 0.5) / 1000).toFixed(1)}  p90 ${(pct(holds, 0.9) / 1000).toFixed(1)}`)

  const byReason = new Map<string, { n: number; pnl: number }>()
  for (const r of closed) {
    const k = r.exit_reason ?? 'unknown'
    const e = byReason.get(k) ?? { n: 0, pnl: 0 }
    e.n++; e.pnl += Number(r.pnl_true_wei ?? 0) / 1e18
    byReason.set(k, e)
  }
  console.log('\nexit reasons:')
  for (const [k, v] of [...byReason.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${k.padEnd(16)} ${String(v.n).padStart(5)}   $${(v.pnl * ETHUSD).toFixed(2)}`)
  }

  // by dev-buy band: the research (2026-08-17) found the 0.05-0.08 band is where every
  // sniper's filter sits, so it is the most crowded and gets the least follow-on flow.
  // shadow keeps trading the wide cohort so this table keeps measuring it live.
  const bands: Array<[string, number, number]> = [['0.05-0.08', 0.05, 0.08], ['0.08-0.12', 0.08, 0.12], ['0.12+', 0.12, Infinity]]
  const devOf = new Map<string, number>()
  for (const l of db.prepare(`SELECT token, dev_buy_wei FROM launches`).all() as any[]) {
    devOf.set(l.token, Number(BigInt(l.dev_buy_wei ?? '0')) / 1e18)
  }
  console.log('\nby dev-buy band (ROT, n):')
  for (const [name, lo, hi] of bands) {
    const rows = closed.filter((r) => { const d = devOf.get(r.token) ?? 0; return d >= lo && d < hi })
    if (!rows.length) { console.log(`  ${name.padEnd(12)} (none)`); continue }
    const p = rows.reduce((a, r) => a + Number(r.pnl_true_wei ?? 0) / 1e18, 0)
    const t = rows.reduce((a, r) => a + Number(BigInt(r.spend_wei ?? '0')) / 1e18, 0)
    const w = rows.filter((r) => Number(r.pnl_true_wei ?? 0) > 0).length
    console.log(`  ${name.padEnd(12)} ${((p / t) * 100).toFixed(2).padStart(7)}%   n=${String(rows.length).padStart(4)}   win ${((w / rows.length) * 100).toFixed(0)}%   $${(p * ETHUSD).toFixed(2)}`)
  }
  // the deployer track record: the cut that replaced the bundle book on 2026-08-18.
  // bundle columns are still read so we can watch the farmed signal keep decaying.
  const meta = new Map<string, any>()
  for (const l of db.prepare(`SELECT token, exemptions, has_twitter, live_book, prior_launches FROM launches`).all() as any[]) meta.set(l.token, l)
  const withMeta = closed.filter((r) => meta.get(r.token)?.exemptions != null)
  const line = (label: string, rows: any[], note = '') => {
    if (!rows.length) { console.log(`  ${label.padEnd(22)} (none)`); return }
    const p = rows.reduce((a, r) => a + Number(r.pnl_true_wei ?? 0) / 1e18, 0)
    const t = rows.reduce((a, r) => a + Number(BigInt(r.spend_wei ?? '0')) / 1e18, 0)
    const w = rows.filter((r) => Number(r.pnl_true_wei ?? 0) > 0).length
    console.log(`  ${label.padEnd(22)} ${((p / t) * 100).toFixed(2).padStart(7)}%   n=${String(rows.length).padStart(4)}   win ${((w / rows.length) * 100).toFixed(0).padStart(3)}%   $${(p * ETHUSD).toFixed(2).padStart(8)}${note}`)
  }
  if (withMeta.length) {
    console.log('\nby launch calldata (bundle = creator registered snipe-tax-exempt wallets):')
    line('bundle', withMeta.filter((r) => meta.get(r.token).exemptions > 0))
    line('no bundle', withMeta.filter((r) => meta.get(r.token).exemptions === 0))
  }
  // deployer history. everything we buy should be first-launch; the other rows only fill
  // up if the filter is off (REQUIRE_DEV_BUY=0) or the registry failed to load.
  const withDep = closed.filter((r) => meta.get(r.token)?.prior_launches != null)
  if (withDep.length) {
    console.log('\nby deployer track record (0 = first launch, the live book):')
    line('first launch', withDep.filter((r) => meta.get(r.token).prior_launches === 0))
    line('1-2 prior', withDep.filter((r) => { const n = meta.get(r.token).prior_launches; return n >= 1 && n <= 2 }))
    line('3-9 prior', withDep.filter((r) => { const n = meta.get(r.token).prior_launches; return n >= 3 && n <= 9 }))
    line('10+ prior', withDep.filter((r) => meta.get(r.token).prior_launches >= 10))
  }
  // hold length actually achieved: the clock is the strategy now, so watch it drift
  const holdMs = closed.map((r) => Number(r.hold_ms ?? 0)).filter((h) => h > 0).sort((a, b) => a - b)
  if (holdMs.length) {
    const q = (f: number) => holdMs[Math.min(holdMs.length - 1, Math.floor(holdMs.length * f))]!
    console.log(`\nhold ms: p50 ${q(0.5)}  p90 ${q(0.9)}  max ${holdMs[holdMs.length - 1]}  (cap ${STRATEGY.maxHoldMs})`)
  }

  // the discipline checks: these are the rules that separated winners from losers
  const perToken = new Map<string, number>()
  for (const r of closed) perToken.set(r.token, (perToken.get(r.token) ?? 0) + 1)
  const maxEntries = Math.max(...perToken.values())
  console.log(`\ndiscipline:`)
  console.log(`  buys per token         max ${maxEntries}  ${maxEntries === 1 ? '(good: never averaged down)' : '(BAD: averaging down)'}`)
  const stuck = db.prepare(`SELECT COUNT(*) n FROM positions WHERE closed = 0`).get() as any
  console.log(`  positions never closed ${stuck.n}  ${stuck.n === 0 ? '(good: always exited)' : '(BAD: bag-holding)'}`)
}

// modelled vs actual: the whole reason a live pilot is worth paying for
const slip = closed.filter((r) => r.expected_wei && BigInt(r.expected_wei) > 0n && r.proceeds_wei)
if (slip.length >= 5) {
  const diffs = slip.map((r) => (Number(BigInt(r.proceeds_wei)) - Number(BigInt(r.expected_wei))) / Number(BigInt(r.expected_wei)))
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length
  console.log('\nmodelled vs actual fill (the friction shadow mode cannot see):')
  console.log(`  trades compared        ${slip.length}`)
  console.log(`  mean slippage          ${(mean * 100).toFixed(2)}%   <- how optimistic the model is`)
  console.log(`  median                 ${(pct(diffs, 0.5) * 100).toFixed(2)}%`)
  console.log(`  worst decile           ${(pct(diffs, 0.1) * 100).toFixed(2)}%`)
  console.log(`  (research assumed the paper-to-live gap is 2-4 percentage points)`)
}

const lat = db.prepare(`SELECT kind, ms FROM latency`).all() as any[]
if (lat.length) {
  console.log('\nlatency (ms):')
  const kinds = [...new Set(lat.map((l) => l.kind))]
  for (const k of kinds) {
    const v = lat.filter((l) => l.kind === k).map((l) => l.ms)
    console.log(`  ${String(k).padEnd(16)} n=${String(v.length).padStart(5)}  p50 ${pct(v, 0.5).toFixed(0)}  p95 ${pct(v, 0.95).toFixed(0)}`)
  }
}

const timing = db.prepare(`SELECT t_detect, t_decide, t_signed, t_sent FROM positions WHERE t_sent IS NOT NULL`).all() as any[]
if (timing.length) {
  const dd = timing.map((t) => t.t_decide - t.t_detect)
  const ds = timing.map((t) => t.t_sent - t.t_decide)
  console.log('\nentry budget (ms, against a 2000ms snipe-tax window):')
  console.log(`  detect -> decide       p50 ${pct(dd, 0.5).toFixed(0)}  p95 ${pct(dd, 0.95).toFixed(0)}`)
  console.log(`  decide -> sent         p50 ${pct(ds, 0.5).toFixed(0)}  p95 ${pct(ds, 0.95).toFixed(0)}`)
}

const mirror = db.prepare(`SELECT wallet, side, COUNT(*) n, SUM(we_traded) ours FROM mirror GROUP BY wallet, side`).all() as any[]
if (mirror.length) {
  console.log('\nwinner mirror (what the two profitable wallets did):')
  for (const m of mirror) {
    console.log(`  ${m.wallet.slice(0, 12)} ${m.side}  ${String(m.n).padStart(5)} trades, ${m.ours} on tokens we also traded`)
  }
  const overlap = db.prepare(`SELECT COUNT(DISTINCT curve) n FROM mirror WHERE we_traded = 1`).get() as any
  const theirs = db.prepare(`SELECT COUNT(DISTINCT curve) n FROM mirror`).get() as any
  console.log(`  token overlap: we traded ${overlap.n} of the ${theirs.n} curves they touched`)
}
