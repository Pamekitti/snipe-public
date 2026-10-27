/**
 * Is the venue's ruler actually adaptive, or is it 1.75 wearing a different name?
 *
 *   npx tsx tools/pin-audit.ts <tape.db> [config/strategy.toml]
 *
 * The guard's unit is a launch's return at the column it PINNED when its watch opened. That
 * is a claim about the code, and a claim about the code is worth exactly one measurement: if
 * every launch pins the warmup fallback then the sum is the old fixed column and the word
 * "adaptive" is decoration. So this reads the pinned column off each observation as the fold
 * opens it, and prints what the distribution actually is.
 *
 * It also sums the same rows twice, once at the pinned column and once at a fixed 1.75, and
 * reports how often a 15-row window would land on DIFFERENT sides of the band depending on
 * which ruler was used. That is the number that says whether the choice of ruler changes any
 * decision, as opposed to changing a label on a page.
 *
 * Offline. Folds, decides nothing, sends nothing.
 */
import { Tape } from '../io/tape.js'
import { loadConfig } from '../io/config-load.js'
import { emptyState } from '../core/state.js'
import { decide } from '../core/decide.js'
import { barKey } from '../core/sim.js'
import { venueVerdict } from '../core/guard.js'
import type { Outcome, State } from '../core/state.js'
import type { Switches } from '../core/config.js'

const tapePath = process.argv[2] ?? 'data/tape.db'
const specPath = process.argv[3] ?? 'config/strategy.toml'

const loaded = loadConfig(specPath, Date.now(), null)
if (!loaded.ok) { console.error('spec would not load:', loaded.refusal.reason); process.exit(1) }
const cfg = loaded.value.values

type Book = {
  /** pinned column -> how many watches opened on it */
  pins: Map<number, number>
  /** watches opened while this book had fewer than adaptiveWindow scored rows */
  coldPins: number
  opened: number
  /** token -> the column that token's watch pinned */
  pinOf: Map<string, number>
  rows: Outcome[]          // newest first
  settled: number
  /** verdict instants where pinned and fixed-1.75 rulers disagreed on open/shut */
  disagreed: number
  compared: number
}

const books = new Map<string, Book>()
for (const b of cfg.books) {
  books.set(b.id, { pins: new Map(), coldPins: 0, opened: 0, pinOf: new Map(), rows: [], settled: 0, disagreed: 0, compared: 0 })
}

let state: State = emptyState(cfg, { sizeWei: 10_000_000_000_000_000n, mode: 'live' } as unknown as Switches)
const tape = new Tape(tapePath)
let cursor = 1, folded = 0, firstAt = 0, lastAt = 0
let lastRow: Outcome | undefined
const seenCurves = new Set<string>()

// Both rulers are read on the same instants, which are the publication moments, because
// `refreshSensors` runs only when rows settle and a verdict exists only where evidence landed.
const fixedOpen = new Map<string, boolean>()
const pinnedOpen = new Map<string, boolean>()
const FIXED = barKey(1.75)

for (;;) {
  const batch = tape.read(cursor, 5_000)
  if (!batch.length) break
  for (const e of batch) {
    if (!firstAt) firstAt = e.at
    lastAt = e.at
    const out = decide(state, e)
    if (out) state = out.state
    if (e.kind === 'config-applied') state = { ...state, config: cfg }
    folded++
    cursor = e.seq + 1

    // Every watch the fold just opened, with the column it froze.
    for (const [curve, o] of state.observations) {
      if (seenCurves.has(curve)) continue
      seenCurves.add(curve)
      const bk = books.get(o.book)
      if (bk === undefined) continue
      const bar = o.pinnedBar ?? 0
      bk.opened++
      bk.pins.set(bar, (bk.pins.get(bar) ?? 0) + 1)
      const spec = cfg.books.find((b) => b.id === o.book)!
      if (bk.rows.length < spec.takeProfit.adaptiveWindow) bk.coldPins++
      bk.pinOf.set(o.token.toLowerCase(), bar)
    }

    const all = state.cohort.all()
    const tail = all[all.length - 1]
    if (tail === undefined || tail === lastRow) continue
    const fresh: Outcome[] = []
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i] === lastRow) break
      fresh.push(all[i]!)
    }
    lastRow = tail
    for (const o of fresh) {
      const bk = books.get(o.book)
      if (bk === undefined) continue
      bk.rows.unshift(o)
      bk.settled++
    }

    // Same window, same instant, two rulers: the pinned column the code uses and the fixed
    // 1.75 the August rule used. Only the ruler differs, so a disagreement is attributable.
    for (const spec of cfg.books) {
      const bk = books.get(spec.id)!
      const win = bk.rows.slice(0, spec.guard.window)
      if (win.length < spec.guard.window) continue
      const reachMs = state.at - win[win.length - 1]!.at
      const sums = (val: (o: Outcome) => number) => ({
        mainSum: win.reduce((a, o) => a + val(o), 0),
        mainN: win.length,
        freshSum: win.slice(0, spec.guard.recoveryWindow).reduce((a, o) => a + val(o), 0),
        freshN: Math.min(win.length, spec.guard.recoveryWindow),
        reachMs,
      })
      const p = venueVerdict(spec.guard, sums((o) => o.stakes ?? 0), pinnedOpen.get(spec.id) ?? false)
      const f = venueVerdict(spec.guard, sums((o) => o.perBar[FIXED] ?? 0), fixedOpen.get(spec.id) ?? false)
      pinnedOpen.set(spec.id, p.open)
      fixedOpen.set(spec.id, f.open)
      bk.compared++
      if (p.open !== f.open) bk.disagreed++
    }
  }
}
tape.close()

const hours = (lastAt - firstAt) / 3_600_000
console.log(`folded ${folded} events over ${hours.toFixed(1)}h of tape\n`)

for (const spec of cfg.books) {
  const bk = books.get(spec.id)!
  const bars = [...bk.pins.entries()].sort((a, b) => a[0] - b[0])
  console.log(`######## ${spec.id}: ${bk.opened} watches opened, ${bk.settled} scored`)
  console.log(`  warmup fallback is ${spec.guard.pnlBar}, argmax runs over ${spec.takeProfit.adaptiveWindow} rows`)
  console.log(`  pinned column, as frozen at watch-open:`)
  for (const [bar, n] of bars) {
    const pct = (100 * n / Math.max(1, bk.opened)).toFixed(1)
    console.log(`    ${bar.toFixed(2)}  ${String(n).padStart(6)}  ${pct.padStart(5)}%  ${'#'.repeat(Math.round(Number(pct) / 2))}`)
  }
  console.log(`  distinct columns used: ${bars.length}`)
  console.log(`  opened while the argmax was still cold (<${spec.takeProfit.adaptiveWindow} rows): ${bk.coldPins}`)
  const pct = (100 * bk.disagreed / Math.max(1, bk.compared)).toFixed(1)
  console.log(`  verdicts where the pinned ruler and a fixed 1.75 disagreed on open/shut: `
    + `${bk.disagreed} of ${bk.compared} (${pct}%)`)
  console.log()
}
