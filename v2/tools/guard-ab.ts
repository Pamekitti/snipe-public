/**
 * Replay a tape and compare the venue guard that is running against the one being proposed,
 * on exactly the same rows. Offline, decides nothing, sends nothing.
 *
 *   npx tsx tools/guard-ab.ts <tape.db> [config/strategy.toml]
 *
 * The fold produces the NEW reading, because the fold is the new code. The OLD reading is
 * recomputed here from the same outcomes at the fixed 1.75 column, which is what the August
 * rule summed. Both are evaluated at the same instants, which are the publication moments:
 * `refreshSensors` runs only when rows settle, so a verdict exists exactly when evidence
 * arrived and neither rule is sampled on a clock the other never saw.
 *
 * THE SPEC IS FORCED, AND THAT MAKES THIS A COUNTERFACTUAL RATHER THAN A REPLAY. A tape's
 * `config-applied` rows carry the config that was actually in force, which is the whole
 * point of them and why `decide` takes no config parameter. Replaying them would measure
 * the new code under the old thresholds, which is a policy nobody proposed. This tool
 * overwrites `state.config` after every such row so the question it answers is "what would
 * the proposed guard have done over these hours", and the answer is not a proof of anything
 * that happened.
 */
import { Tape } from '../io/tape.js'
import { loadConfig } from '../io/config-load.js'
import { emptyState } from '../core/state.js'
import { decide } from '../core/decide.js'
import { barKey } from '../core/sim.js'
import type { Outcome, State } from '../core/state.js'
import type { Switches } from '../core/config.js'

const tapePath = process.argv[2] ?? 'data/tape.db'
const specPath = process.argv[3] ?? 'config/strategy.toml'

const loaded = loadConfig(specPath, Date.now(), null)
if (!loaded.ok) { console.error('spec would not load:', loaded.refusal.reason); process.exit(1) }
const cfg = loaded.value.values

/** The rule that is running today: one window of 20 at 1.75, stale reads open. */
const OLD = { window: 20, shutAt: -1, openAt: 1, freshMs: 10_800_000, bar: barKey(1.75) }

type Span = { open: boolean; from: number; why: string }
type Book = {
  rows: Outcome[]          // newest first, this book's, all of them
  oldOpen: boolean
  oldSpans: Span[]
  newSpans: Span[]
  failClosedChecks: number
  checks: number
}

const books = new Map<string, Book>()
for (const b of cfg.books) {
  books.set(b.id, { rows: [], oldOpen: true, oldSpans: [], newSpans: [], failClosedChecks: 0, checks: 0 })
}

function oldVerdict(bk: Book, now: number): { open: boolean; fresh: boolean; why: string } {
  const rows = bk.rows.filter((o) => Number.isFinite(o.perBar[OLD.bar])).slice(0, OLD.window)
  if (rows.length === 0) return { open: bk.oldOpen, fresh: false, why: 'no rows' }
  const sum = rows.reduce((a, o) => a + (o.perBar[OLD.bar] ?? 0), 0)
  const reach = now - rows[rows.length - 1]!.at
  if (rows.length < OLD.window || reach > OLD.freshMs) {
    // The August rule: no opinion, and no opinion reads open.
    return { open: true, fresh: false, why: `only ${rows.length} of ${OLD.window} / ${Math.round(reach / 60_000)}min; no opinion` }
  }
  if (bk.oldOpen) return { open: sum >= OLD.shutAt, fresh: true, why: `${sum.toFixed(2)} over 20` }
  return { open: sum > OLD.openAt, fresh: true, why: `${sum.toFixed(2)} over 20` }
}

function note(spans: Span[], open: boolean, at: number, why: string): void {
  const last = spans[spans.length - 1]
  if (last === undefined || last.open !== open) spans.push({ open, from: at, why })
}

let state: State = emptyState(cfg, { sizeWei: 10_000_000_000_000_000n, mode: 'live' } as unknown as Switches)
const tape = new Tape(tapePath)
let cursor = 1, folded = 0, firstAt = 0, lastAt = 0
let lastRow: Outcome | undefined

for (;;) {
  const batch = tape.read(cursor, 5_000)
  if (!batch.length) break
  for (const e of batch) {
    if (!firstAt) firstAt = e.at
    lastAt = e.at
    const out = decide(state, e)
    if (out) state = out.state
    // The counterfactual: every recorded config goes back to the one under test, so the
    // guard being measured is the proposed one and not the one the tape ran under.
    if (e.kind === 'config-applied') state = { ...state, config: cfg }
    folded++
    cursor = e.seq + 1

    // Did a publication land? The ring's tail changes only when rows settle.
    const all = state.cohort.all()
    const tail = all[all.length - 1]
    if (tail === undefined || tail === lastRow) continue
    const fresh: Outcome[] = []
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i] === lastRow) break
      fresh.push(all[i]!)
    }
    lastRow = tail
    for (const o of fresh) books.get(o.book)?.rows.unshift(o)

    // Both verdicts, same instant, same rows.
    for (const [id, bk] of books) {
      const nv = state.sensors.venue.get(id)?.value
      if (nv === undefined) continue
      bk.checks++
      if (!nv.fresh) bk.failClosedChecks++
      note(bk.newSpans, nv.open, state.at, nv.why)
      const ov = oldVerdict(bk, state.at)
      bk.oldOpen = ov.open
      note(bk.oldSpans, ov.open, state.at, ov.why)
    }
  }
}
tape.close()

const spanH = (lastAt - firstAt) / 3_600_000
const shutHours = (spans: Span[]): number => {
  let ms = 0
  for (let i = 0; i < spans.length; i++) {
    if (!spans[i]!.open) ms += (spans[i + 1]?.from ?? lastAt) - spans[i]!.from
  }
  return ms / 3_600_000
}
/** Was the book open at `t`? Before the first verdict it had not spoken, so: no. */
const openAt = (spans: Span[], t: number): boolean => {
  let open = false
  for (const s of spans) { if (s.from > t) break; open = s.open }
  return open
}

/**
 * What the launches each rule ADMITTED were worth, in stakes.
 *
 * A launch is admitted on the verdict standing when it launched, which is `settleMs` before
 * its row settled, not the verdict its own row went on to produce. Capacity, slots, the
 * drawdown stop and the size switch are NOT modelled, so this is what the policy would have
 * been worth trading everything it could see: an upper bound on both the winning and the
 * losing side, and not a P&L.
 */
const admitted = (bk: Book, spans: Span[], stakeOf: (o: Outcome) => number | null, settleMs: number) => {
  let sum = 0, n = 0
  for (const o of bk.rows) {
    const v = stakeOf(o)
    if (v === null || !Number.isFinite(v)) continue
    if (!openAt(spans, o.at - settleMs)) continue
    sum += v; n++
  }
  return { sum, n }
}

console.log(`folded ${folded} events over ${spanH.toFixed(1)}h of tape\n`)
for (const [id, bk] of books) {
  const oldShut = shutHours(bk.oldSpans), newShut = shutHours(bk.newSpans)
  console.log(`######## ${id}  (${bk.rows.length} scored rows, ${bk.checks} verdicts)`)
  console.log(`  RUNNING  20 / -1 / +1 fixed 1.75, stale=open : shut ${oldShut.toFixed(2)}h `
    + `(${(100 * oldShut / spanH).toFixed(0)}%) over ${bk.oldSpans.filter((s) => !s.open).length} episodes`)
  console.log(`  PROPOSED 15 / 8 / -1.5 / +1 adaptive, fail-closed : shut ${newShut.toFixed(2)}h `
    + `(${(100 * newShut / spanH).toFixed(0)}%) over ${bk.newSpans.filter((s) => !s.open).length} episodes`)
  console.log(`  of ${bk.checks} verdicts, ${bk.failClosedChecks} (${(100 * bk.failClosedChecks / Math.max(1, bk.checks)).toFixed(1)}%) were incomplete or stale and so failed closed`)

  // BOTH RULES ARE PAID AT THE SAME COLUMN, and it is the one the bot would really have
  // traded at: `pinTakeProfit` chooses the adaptive rung whichever guard is running. The two
  // rules differ in which launches they ADMIT, not in what an admitted launch is worth, so
  // valuing each at its own ruler would score the ruler rather than the gate.
  const settleMs = cfg.books.find((b) => b.id === id)?.guard.settleMs ?? 52_000
  const paid = (x: Outcome): number | null => x.stakes
  const o = admitted(bk, bk.oldSpans, paid, settleMs)
  const n = admitted(bk, bk.newSpans, paid, settleMs)
  console.log(`  admitted, in stakes (no capacity, no drawdown, not a P&L):`)
  console.log(`    RUNNING  ${o.sum >= 0 ? '+' : ''}${o.sum.toFixed(2)} over ${o.n} launches`)
  console.log(`    PROPOSED ${n.sum >= 0 ? '+' : ''}${n.sum.toFixed(2)} over ${n.n} launches`)

  // A single total over one era is a point estimate with no spread, which this repo does not
  // accept as an answer. Eight bins is the house window shape; the tape is only long enough
  // for the short one.
  const BINS = 8
  const width = (lastAt - firstAt) / BINS
  const perBin = (spans: Span[], stakeOf: (x: Outcome) => number | null): number[] => {
    const out = new Array<number>(BINS).fill(0)
    for (const x of bk.rows) {
      const v = stakeOf(x)
      if (v === null || !Number.isFinite(v)) continue
      if (!openAt(spans, x.at - settleMs)) continue
      const i = Math.min(BINS - 1, Math.max(0, Math.floor((x.at - firstAt) / width)))
      out[i] = out[i]! + v
    }
    return out
  }
  const stat = (xs: number[]): string => {
    const s = [...xs].sort((a, b) => a - b)
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length
    const med = xs.length % 2 ? s[(xs.length - 1) / 2]! : (s[xs.length / 2 - 1]! + s[xs.length / 2]!) / 2
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1))
    return `mean ${mean >= 0 ? '+' : ''}${mean.toFixed(2)}, median ${med >= 0 ? '+' : ''}${med.toFixed(2)}, sd ${sd.toFixed(2)}, n ${xs.length}`
  }
  const ob = perBin(bk.oldSpans, paid)
  const nb = perBin(bk.newSpans, paid)
  console.log(`  per ${(width / 3_600_000).toFixed(1)}h bin, stakes admitted:`)
  console.log(`    RUNNING  [${ob.map((x) => x.toFixed(1)).join(' ')}]  ${stat(ob)}`)
  console.log(`    PROPOSED [${nb.map((x) => x.toFixed(1)).join(' ')}]  ${stat(nb)}`)
  console.log(`    PROPOSED wins ${nb.filter((x, i) => x > ob[i]!).length} of ${BINS} bins`)

  const last = bk.newSpans[bk.newSpans.length - 1]
  console.log(`  ends ${last?.open ? 'OPEN' : 'SHUT'}: ${last?.why ?? 'no verdict'}`)
  console.log()
}
