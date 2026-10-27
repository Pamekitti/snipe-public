/**
 * Why paper-liked coins were not live-booked. Diagnostic; decides nothing.
 *
 *   npx tsx tools/miss-audit.ts data/tape-box.db config/strategy.toml
 *
 * Paper universe = every launch that passed `admits` (band + exempt floor + template).
 * Live take = a buy that filled or closed. A send is not a take.
 */
import { writeFileSync } from 'node:fs'
import { parseTransaction } from 'viem'
import { Tape } from '../io/tape.js'
import { loadConfig } from '../io/config-load.js'
import { emptyState, type State } from '../core/state.js'
import { decide } from '../core/decide.js'
import type { Switches } from '../core/config.js'
import type { RefusalBucket } from '../core/contracts.js'

const tapePath = process.argv[2] ?? 'data/tape-box.db'
const specPath = process.argv[3] ?? 'config/strategy.toml'
const outPath = process.argv[4] ?? 'data/miss-audit.json'

const SEND_GATES = new Set<RefusalBucket>([
  'risk-halted', 'risk-entered', 'risk-capacity', 'risk-size', 'risk-bankroll',
  'risk-logs-unhealthy', 'risk-logs-stale', 'risk-degraded',
  'guard-pumped', 'guard-sim-failed',
  'sensor-unreadable', 'sensor-stale', 'sensor-no-rows',
])

const PAPER_STAKE_ETH = 0.02
const WEI = 1e18

type Watch = {
  token: string
  curve: string
  book: string
  at: number
  venueOpen: boolean | null
  venueSum: number | null
  venueWhy: string | null
  haltKind: string | null
  reserved: number
  openFilled: number
  openUnfilled: number
  recovery: boolean
  stopped: boolean
  firstRefusal: { bucket: string; reason: string; at: number } | null
  buyAt: number | null
  intentId: string | null
  signedAt: number | null
  sendOk: boolean | null
  filledAt: number | null
  closedAt: number | null
  livePnlEth: number | null
  paperStakes: number | null
  paperAt: number | null
  paperDropped: boolean
  cls: string
  why: string
}

const loaded = loadConfig(specPath, Date.now(), null)
if (!loaded.ok) {
  console.error(`spec would not load: ${loaded.refusal.reason}`)
  process.exit(1)
}

const switches: Switches = {
  sizeWei: 5_000_000_000_000_000n,
  mode: 'live',
  at: 0,
  by: 'miss-audit',
}

function snap(s: State): Pick<Watch, 'venueOpen' | 'venueSum' | 'venueWhy' | 'haltKind' | 'reserved' | 'openFilled' | 'openUnfilled' | 'stopped'> {
  let openFilled = 0
  let openUnfilled = 0
  for (const p of s.positions.values()) {
    if (p.closed) continue
    if (p.filled === false || p.tokensHeld === 0n) openUnfilled++
    else openFilled++
  }
  const stopped = s.risk.halts.has('stopped')
  return {
    venueOpen: null, venueSum: null, venueWhy: null, haltKind: null,
    reserved: s.risk.reserved, openFilled, openUnfilled, stopped,
  }
}

function venueOf(s: State, book: string): { open: boolean | null; sum: number | null; why: string | null; halt: string | null } {
  const v = s.sensors.venue.get(book)?.value
  const halt = [...s.risk.halts.values()].find((h) => h.book === book || h.book === null)
  return {
    open: v?.open ?? null,
    sum: v?.sumStakes ?? null,
    why: v?.why ?? null,
    halt: halt ? `${halt.kind}:${halt.reason}` : null,
  }
}

function classify(w: Watch): string {
  if (w.buyAt && (w.filledAt || w.closedAt)) return 'taken'
  if (w.buyAt && w.signedAt && !w.filledAt && !w.closedAt) return 'signed-unbooked'
  if (w.buyAt && !w.signedAt) return 'decided-unsent'
  const r = w.firstRefusal
  if (r) {
    if (r.bucket === 'risk-capacity' && w.openFilled === 0) return 'capacity-ghost'
    if (r.bucket === 'risk-capacity') return 'capacity-real'
    if (r.bucket === 'risk-halted') {
      const x = `${w.haltKind ?? ''} ${r.reason}`.toLowerCase()
      if (x.includes('venue')) return 'venue-shut'
      if (x.includes('drawdown')) return 'drawdown'
      if (x.includes('stopped') || x.includes('manual')) return 'operator-stop'
      if (x.includes('broken')) return 'broken'
      return 'halt-other'
    }
    if (r.bucket === 'guard-pumped') return 'pump'
    if (r.bucket === 'risk-logs-unhealthy' || r.bucket === 'risk-logs-stale' || r.bucket === 'risk-degraded') return 'stream'
    if (r.bucket.startsWith('sensor') || r.bucket === 'guard-sim-failed') return 'sensor'
    if (r.bucket === 'risk-size' && /size 0/.test(r.reason)) return 'book-size-0'
    if (r.bucket === 'risk-size') return 'size-other'
    if (r.bucket === 'risk-bankroll') return 'bankroll'
    if (r.bucket === 'risk-entered') return 'already-entered'
    return r.bucket
  }
  if (w.recovery) return 'restart'
  return 'never-released'
}

/** Why this coin did or did not get a live send. Signed-buy is tape truth (curve match). */
function why(w: Watch): string {
  if (w.signedAt) return w.filledAt || w.closedAt ? 'opened' : 'signed-unfilled'
  const r = w.firstRefusal
  if (r) {
    if (r.bucket === 'risk-size' && /size 0/.test(r.reason)) return 'book-size-0'
    if (r.bucket === 'risk-bankroll') return 'bankroll'
    if (r.bucket === 'risk-capacity') return w.openFilled === 0 ? 'slots-ghost' : 'slots-full'
    if (r.bucket === 'risk-halted') {
      const x = `${w.haltKind ?? ''} ${r.reason}`.toLowerCase()
      if (x.includes('venue')) return 'venue-shut'
      if (x.includes('drawdown')) return 'drawdown'
      if (x.includes('stopped') || x.includes('manual')) return 'operator-stop'
      if (x.includes('broken')) return 'broken'
      return 'halt-other'
    }
    if (r.bucket === 'guard-pumped') return 'pump'
    if (r.bucket === 'risk-logs-unhealthy' || r.bucket === 'risk-logs-stale' || r.bucket === 'risk-degraded') return 'stream'
    if (r.bucket.startsWith('sensor') || r.bucket === 'guard-sim-failed') return 'sensor'
    if (r.bucket === 'risk-entered') return 'already-entered'
    if (r.bucket === 'risk-size') return 'size-other'
    return r.bucket
  }
  if (w.buyAt) return 'decided-unsent'
  if (w.recovery) return 'restart'
  return 'never-tried'
}

function stats(xs: number[]): { n: number; mean: number | null; median: number | null; sd: number | null } {
  const n = xs.length
  if (n === 0) return { n: 0, mean: null, median: null, sd: null }
  const mean = xs.reduce((a, b) => a + b, 0) / n
  const srt = [...xs].sort((a, b) => a - b)
  const median = n % 2 ? srt[(n - 1) / 2]! : (srt[n / 2 - 1]! + srt[n / 2]!) / 2
  const sd = n < 2 ? 0 : Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1))
  return { n, mean, median, sd }
}

function hhmm(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ')
}

const watches = new Map<string, Watch>()
const curveToken = new Map<string, string>()
const scoredSeen = new Set<string>()
const closedSeen = new Set<string>()
const filledSeen = new Set<string>()
const intentToken = new Map<string, string>()
let recoveringUntil = 0
let lastAt = 0
let events = 0
let refusalsN = 0
const buckets: Record<string, number> = {}
const capacitySnaps: Array<{ at: number; reserved: number; openFilled: number; openUnfilled: number; token: string; book: string }> = []
const signedBuys: Array<{ at: number; token: string | null; intentId: string; book: string | null }> = []
const recoveries: Array<{ at: number; reserved: number; openFilled: number; inflightBuys: number }> = []

console.error(`miss-audit: streaming ${tapePath}`)
const tape = new Tape(tapePath)
let state = emptyState(loaded.value.values, switches)
let from = 1
const t0 = Date.now()

for (;;) {
  const batch = tape.read(from, 4_000)
  if (!batch.length) break
  for (const e of batch) {
    const beforeObs = state.observations.size
    const out = decide(state, e)
    if (!out) continue
    state = out.state
    lastAt = state.at
    events++
    refusalsN += out.refusals.length
    for (const r of out.refusals) buckets[r.bucket] = (buckets[r.bucket] ?? 0) + 1

    if (e.kind === 'recovery-start') {
      recoveringUntil = state.at + 15 * 60_000
      let inflightBuys = 0
      for (const f of state.inflight.values()) if (f.kind === 'buy') inflightBuys++
      const s = snap(state)
      recoveries.push({ at: state.at, reserved: s.reserved, openFilled: s.openFilled, inflightBuys })
    }
    if (e.kind === 'recovery-complete') recoveringUntil = 0

    if (state.observations.size > beforeObs || e.kind === 'chain-read') {
      for (const o of state.observations.values()) {
        if (watches.has(o.token)) continue
        const sl = snap(state)
        const v = venueOf(state, o.book)
        curveToken.set(o.curve, o.token)
        watches.set(o.token, {
          token: o.token, curve: o.curve, book: o.book, at: o.startedAt,
          venueOpen: v.open, venueSum: v.sum, venueWhy: v.why, haltKind: v.halt,
          reserved: sl.reserved, openFilled: sl.openFilled, openUnfilled: sl.openUnfilled,
          recovery: state.at < recoveringUntil, stopped: sl.stopped,
          firstRefusal: null, buyAt: null, intentId: null, signedAt: null, sendOk: null,
          filledAt: null, closedAt: null, livePnlEth: null, paperStakes: null, paperAt: null,
          paperDropped: false, cls: '', why: '',
        })
      }
    }

    for (const i of out.intents) {
      if (i.kind !== 'buy') continue
      intentToken.set(i.intentId, i.token)
      const w = watches.get(i.token)
      if (!w) continue
      if (w.buyAt === null) {
        w.buyAt = state.at
        w.intentId = i.intentId
        const sl = snap(state)
        const v = venueOf(state, w.book)
        w.reserved = sl.reserved
        w.openFilled = sl.openFilled
        w.openUnfilled = sl.openUnfilled
        w.venueOpen = v.open
        w.venueSum = v.sum
        w.haltKind = v.halt
      }
    }

    for (const r of out.refusals) {
      if (!SEND_GATES.has(r.bucket)) continue
      const w = watches.get(r.subject)
      if (!w || w.firstRefusal || w.buyAt) continue
      w.firstRefusal = { bucket: r.bucket, reason: r.reason, at: r.at }
      const sl = snap(state)
      const v = venueOf(state, w.book)
      w.reserved = sl.reserved
      w.openFilled = sl.openFilled
      w.openUnfilled = sl.openUnfilled
      w.venueOpen = v.open
      w.venueSum = v.sum
      w.haltKind = v.halt
      if (r.bucket === 'risk-capacity') {
        capacitySnaps.push({
          at: state.at, reserved: sl.reserved, openFilled: sl.openFilled,
          openUnfilled: sl.openUnfilled, token: w.token, book: w.book,
        })
      }
    }

    if (e.kind === 'tx-signed' && e.txKind === 'buy') {
      let token = intentToken.get(e.intentId) ?? state.inflight.get(e.intentId)?.token ?? null
      if (!token) {
        try {
          const to = parseTransaction(e.raw as `0x${string}`).to?.toLowerCase()
          if (to) token = curveToken.get(to) ?? null
        } catch { /* raw is only used to join the tape send to the watch */ }
      }
      const w = token ? watches.get(token) : undefined
      signedBuys.push({ at: state.at, token, intentId: e.intentId, book: w?.book ?? null })
      if (w && w.signedAt === null) w.signedAt = state.at
    }
    if (e.kind === 'tx-send-result') {
      const token = intentToken.get(e.intentId)
      const w = token ? watches.get(token) : undefined
      if (w && w.sendOk === null) w.sendOk = e.ok
    }

    for (const p of state.positions.values()) {
      if (p.closed) {
        if (closedSeen.has(p.id)) continue
        closedSeen.add(p.id)
        const w = watches.get(p.token)
        if (!w) continue
        w.closedAt = p.closedAt ?? state.at
        w.livePnlEth = Number(p.proceedsWei - p.spendWei) / WEI
        if (w.filledAt === null && p.tokensHeld === 0n) w.filledAt = w.closedAt
      } else if (p.filled !== false && p.tokensHeld > 0n) {
        if (filledSeen.has(p.id)) continue
        filledSeen.add(p.id)
        const w = watches.get(p.token)
        if (w && w.filledAt === null) w.filledAt = state.at
      }
    }

    if (e.kind === 'clock' || e.kind === 'feed-block') {
      for (const o of state.cohort.all()) {
        if (scoredSeen.has(o.token)) continue
        scoredSeen.add(o.token)
        const w = watches.get(o.token)
        if (!w) continue
        w.paperAt = o.at
        if (o.stakes === null) w.paperDropped = true
        else w.paperStakes = o.stakes
      }
    }

    if (events % 200_000 === 0) {
      const s = ((Date.now() - t0) / 1000).toFixed(0)
      console.error(`miss-audit: ${events} events, ${watches.size} watches, ${s}s, at ${hhmm(state.at)}`)
    }
  }
  from = batch[batch.length - 1]!.seq + 1
}
tape.close()

for (const o of state.cohort.all()) {
  if (scoredSeen.has(o.token)) continue
  scoredSeen.add(o.token)
  const w = watches.get(o.token)
  if (!w) continue
  w.paperAt = o.at
  if (o.stakes === null) w.paperDropped = true
  else w.paperStakes = o.stakes
}

const rows = [...watches.values()]
for (const w of rows) {
  w.cls = classify(w)
  w.why = why(w)
}

const end = lastAt
const holdoutFrom = end - 4 * 3_600_000
const dayMs = 86_400_000
const h24 = end - dayMs
const d7 = end - 7 * dayMs

function inWin(w: Watch, from: number, to: number): boolean {
  return w.at >= from && w.at < to
}

function pack(subset: Watch[]) {
  const byCls: Record<string, number> = {}
  const byBook: Record<string, number> = {}
  const paper: number[] = []
  const paperMiss: number[] = []
  const paperTake: number[] = []
  const paperMissWin: number[] = []
  const paperMissLose: number[] = []
  const livePnl: number[] = []
  const clsPaper: Record<string, number[]> = {}
  for (const w of subset) {
    byCls[w.cls] = (byCls[w.cls] ?? 0) + 1
    byBook[w.book] = (byBook[w.book] ?? 0) + 1
    if (w.paperStakes !== null) {
      paper.push(w.paperStakes)
      clsPaper[w.cls] ??= []
      clsPaper[w.cls]!.push(w.paperStakes)
      if (w.cls === 'taken') paperTake.push(w.paperStakes)
      else {
        paperMiss.push(w.paperStakes)
        if (w.paperStakes > 0) paperMissWin.push(w.paperStakes)
        if (w.paperStakes < 0) paperMissLose.push(w.paperStakes)
      }
    }
    if (w.livePnlEth !== null) livePnl.push(w.livePnlEth)
  }
  const clsStats: Record<string, ReturnType<typeof stats> & { paperEth: number | null; nWatches: number }> = {}
  for (const [k, xs] of Object.entries(clsPaper)) {
    const st = stats(xs)
    clsStats[k] = {
      ...st,
      nWatches: byCls[k] ?? 0,
      paperEth: st.mean === null ? null : xs.reduce((a, b) => a + b, 0) * PAPER_STAKE_ETH,
    }
  }
  return {
    n: subset.length,
    byCls,
    byBook,
    paper: { ...stats(paper), sum: paper.reduce((a, b) => a + b, 0), eth: paper.reduce((a, b) => a + b, 0) * PAPER_STAKE_ETH },
    paperTaken: { ...stats(paperTake), sum: paperTake.reduce((a, b) => a + b, 0) },
    paperMissed: { ...stats(paperMiss), sum: paperMiss.reduce((a, b) => a + b, 0) },
    missedWinners: { ...stats(paperMissWin), sum: paperMissWin.reduce((a, b) => a + b, 0), eth: paperMissWin.reduce((a, b) => a + b, 0) * PAPER_STAKE_ETH },
    missedLosers: { ...stats(paperMissLose), sum: paperMissLose.reduce((a, b) => a + b, 0), eth: paperMissLose.reduce((a, b) => a + b, 0) * PAPER_STAKE_ETH },
    liveClosed: { ...stats(livePnl), sum: livePnl.reduce((a, b) => a + b, 0) },
    clsStats,
  }
}

function bins(from: number, to: number, n: number, label: (i: number, a: number, b: number) => string) {
  const width = (to - from) / n
  const out = []
  for (let i = 0; i < n; i++) {
    const a = from + i * width
    const b = i === n - 1 ? to : a + width
    out.push({ label: label(i, a, b), from: a, to: b, ...pack(rows.filter((w) => inWin(w, a, b))) })
  }
  return out
}

const morningFrom = Date.parse('2026-09-18T07:00:00Z')
const morningTo = Date.parse('2026-09-18T09:00:00Z')
const openish = rows.filter((w) => w.cls !== 'venue-shut' && w.cls !== 'operator-stop' && w.cls !== 'drawdown')

const ghostHours: Record<string, number> = {}
for (const c of capacitySnaps) {
  const k = hhmm(c.at).slice(0, 13)
  ghostHours[k] = (ghostHours[k] ?? 0) + 1
}

const topMissWins = rows
  .filter((w) => w.cls !== 'taken' && (w.paperStakes ?? 0) > 0)
  .sort((a, b) => (b.paperStakes ?? 0) - (a.paperStakes ?? 0))
  .slice(0, 25)
  .map((w) => ({
    at: hhmm(w.at), book: w.book, cls: w.cls, stakes: w.paperStakes,
    paperEth: (w.paperStakes ?? 0) * PAPER_STAKE_ETH,
    reason: w.firstRefusal?.reason ?? null,
    venueOpen: w.venueOpen, reserved: w.reserved, openFilled: w.openFilled,
    signed: w.signedAt !== null, filled: w.filledAt !== null,
  }))

const morningRows = rows.filter((w) => inWin(w, morningFrom, morningTo)).map((w) => ({
  at: hhmm(w.at), book: w.book, cls: w.cls, why: w.why, stakes: w.paperStakes,
  reason: w.firstRefusal?.reason ?? null,
  venueOpen: w.venueOpen, venueSum: w.venueSum,
  reserved: w.reserved, openFilled: w.openFilled, openUnfilled: w.openUnfilled,
  buy: w.buyAt !== null, signed: w.signedAt !== null, filled: w.filledAt !== null,
  closed: w.closedAt !== null, livePnlEth: w.livePnlEth,
}))

const SIT = new Set(['venue-shut', 'operator-stop'])
const OPENED = new Set(['opened', 'signed-unfilled'])

function isOpenOn(w: Watch): boolean {
  if (w.stopped || w.venueOpen !== true) return false
  return !SIT.has(w.why)
}

function countWhy(subset: Watch[]) {
  const by: Record<string, number> = {}
  const missed: Record<string, number> = {}
  const paperMiss: Record<string, number[]> = {}
  let opened = 0
  let signedUnfilled = 0
  for (const w of subset) {
    by[w.why] = (by[w.why] ?? 0) + 1
    if (w.why === 'opened') opened++
    else if (w.why === 'signed-unfilled') signedUnfilled++
    else {
      missed[w.why] = (missed[w.why] ?? 0) + 1
      if (w.paperStakes !== null) {
        paperMiss[w.why] ??= []
        paperMiss[w.why]!.push(w.paperStakes)
      }
    }
  }
  const paperOf = (xs: number[]) => ({ ...stats(xs), eth: xs.reduce((a, b) => a + b, 0) * PAPER_STAKE_ETH })
  return {
    n: subset.length,
    opened,
    signedUnfilled,
    tried: opened + signedUnfilled,
    missedN: subset.length - opened - signedUnfilled,
    by,
    missed,
    missedPaper: Object.fromEntries(Object.entries(paperMiss).map(([k, xs]) => [k, paperOf(xs)])),
  }
}

const openOn = rows.filter(isOpenOn)
const openOnUntaxed = openOn.filter((w) => w.book === 'untaxed')
const openOnTaxed = openOn.filter((w) => w.book === 'taxed')
const openOn24h = openOn.filter((w) => inWin(w, h24, end))
const openOnMorning = openOn.filter((w) => inWin(w, morningFrom, morningTo))

const missedOpenRows = openOn
  .filter((w) => !OPENED.has(w.why))
  .sort((a, b) => (b.paperStakes ?? -99) - (a.paperStakes ?? -99))
  .slice(0, 30)
  .map((w) => ({
    at: hhmm(w.at), book: w.book, why: w.why, stakes: w.paperStakes,
    reason: w.firstRefusal?.reason ?? null,
    reserved: w.reserved, openFilled: w.openFilled,
  }))

const signedMatched = signedBuys.filter((b) => b.token !== null).length

const report = {
  tape: { events, lastAt, lastUtc: hhmm(end), watches: rows.length, refusals: refusalsN, buckets },
  signedBuys: signedBuys.length,
  recoveries: recoveries.map((r) => ({ ...r, utc: hhmm(r.at) })),
  capacityRefusals: capacitySnaps.length,
  capacityGhostish: capacitySnaps.filter((c) => c.openFilled === 0).length,
  capacityByHour: ghostHours,
  era: pack(rows),
  last24h: pack(rows.filter((w) => inWin(w, h24, end))),
  last24hHoldout: pack(rows.filter((w) => inWin(w, h24, holdoutFrom))),
  last4hHoldout: pack(rows.filter((w) => inWin(w, holdoutFrom, end))),
  last7d: pack(rows.filter((w) => inWin(w, d7, end))),
  bins24h: bins(h24, end, 8, (_i, a, b) => `${hhmm(a)}–${hhmm(b).slice(11)}`),
  bins7d: bins(end - 7 * dayMs, end, 7, (_i, a) => new Date(a).toISOString().slice(0, 10)),
  morning: pack(rows.filter((w) => inWin(w, morningFrom, morningTo))),
  morningOpenish: pack(rows.filter((w) => inWin(w, morningFrom, morningTo) && w.cls !== 'venue-shut' && w.cls !== 'operator-stop')),
  whenAllowed: pack(openish),
  whenAllowedHoldout: pack(openish.filter((w) => w.at < holdoutFrom)),
  byBook: {
    untaxed: pack(rows.filter((w) => w.book === 'untaxed')),
    taxed: pack(rows.filter((w) => w.book === 'taxed')),
    untaxed24h: pack(rows.filter((w) => w.book === 'untaxed' && inWin(w, h24, end))),
    taxed24h: pack(rows.filter((w) => w.book === 'taxed' && inWin(w, h24, end))),
    untaxedHoldout: pack(rows.filter((w) => w.book === 'untaxed' && inWin(w, h24, holdoutFrom))),
    taxedHoldout: pack(rows.filter((w) => w.book === 'taxed' && inWin(w, h24, holdoutFrom))),
  },
  topMissedWinners: topMissWins,
  morningRows,
  openOn: {
    signedBuys: signedBuys.length,
    signedMatchedToWatch: signedMatched,
    all: countWhy(openOn),
    untaxed: countWhy(openOnUntaxed),
    taxed: countWhy(openOnTaxed),
    last24h: countWhy(openOn24h),
    last24hUntaxed: countWhy(openOn24h.filter((w) => w.book === 'untaxed')),
    morning: countWhy(openOnMorning),
    morningUntaxed: countWhy(openOnMorning.filter((w) => w.book === 'untaxed')),
    missedExamples: missedOpenRows,
  },
}

writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`miss-audit: ${events} events, ${rows.length} watches, ${signedBuys.length} signed buys, matched ${signedMatched}, wrote ${outPath}`)
console.log('miss-audit: era why', JSON.stringify(Object.fromEntries(
  Object.entries(rows.reduce<Record<string, number>>((acc, w) => {
    acc[w.why] = (acc[w.why] ?? 0) + 1
    return acc
  }, {})).sort((a, b) => b[1] - a[1]),
)))
console.log('miss-audit: OPEN+ON all', JSON.stringify(report.openOn.all))
console.log('miss-audit: OPEN+ON untaxed', JSON.stringify(report.openOn.untaxed))
console.log('miss-audit: OPEN+ON taxed', JSON.stringify(report.openOn.taxed))
console.log('miss-audit: OPEN+ON 24h untaxed', JSON.stringify(report.openOn.last24hUntaxed))
console.log('miss-audit: OPEN+ON morning untaxed', JSON.stringify(report.openOn.morningUntaxed))
