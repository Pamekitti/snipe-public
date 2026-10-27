/**
 * Prove that resuming from a saved fold lands exactly where an unbroken fold lands.
 *
 * A checkpoint is the one thing in this bot that puts state into the process from somewhere
 * other than the tape, so it is not argued about either. This folds a real tape twice: straight
 * through, and again broken in half with a snapshot written, read back, and the rest replayed
 * on top. The two must agree on every field of `State`, on everything `History` holds, and on
 * the decisions made after the break.
 *
 *   npx tsx tools/snapshot-proof.ts data/tape-box.db config/strategy.toml [--at 0.5]
 *
 * A mismatch prints the first field that differs. "same" means the snapshot is a faithful
 * shortcut for THIS tape; run it again after changing anything inside `State` or `History`.
 */
import { parseArgs } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tape } from '../io/tape.js'
import { loadConfig } from '../io/config-load.js'
import { BoundedMap, BoundedSet, Ring } from '../core/contracts.js'
import { decide } from '../core/decide.js'
import { emptyState, type State } from '../core/state.js'
import { History } from '../projections/history.js'
import { dropSnapshot, readSnapshot, shapeOf, writeSnapshot, type Registry } from '../io/snapshot.js'
import type { Switches } from '../core/config.js'
import type { Event } from '../core/events.js'

const REGISTRY: Registry = new Map<string, new (...args: never[]) => object>([
  ['Ring', Ring as never],
  ['BoundedMap', BoundedMap as never],
  ['BoundedSet', BoundedSet as never],
  ['History', History as never],
])

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { at: { type: 'string', default: '0.5' } },
})
const tapePath = positionals[0] ?? 'data/tape.db'
const specPath = positionals[1] ?? 'config/strategy.toml'
const breakAt = Number(values.at)

const loaded = loadConfig(specPath, Date.now(), null)
if (!loaded.ok) { console.error(`the spec would not load: ${loaded.refusal.reason}`); process.exit(1) }
const switches: Switches = { sizeWei: BigInt(loaded.value.values.risk.maxTradeSizeWei), mode: 'shadow', at: 0, by: 'proof' }

const tape = new Tape(tapePath)
const events: Event[] = []
for (let from = 1; ;) {
  const batch = tape.read(from, 5_000)
  if (!batch.length) break
  events.push(...batch)
  from = batch[batch.length - 1]!.seq + 1
}
tape.close()
if (events.length === 0) { console.error(`${tapePath} has no events`); process.exit(1) }
const cut = Math.max(1, Math.min(events.length - 1, Math.floor(events.length * breakAt)))

/** Every decision the fold made, as one string per event, so a divergence has a seq on it. */
function foldRange(state: State, history: History, range: readonly Event[], log: string[]): State {
  let s = state
  for (const e of range) {
    const out = decide(s, e)
    if (!out) continue
    s = out.state
    history.observe(e, s, out.intents, out.refusals)
    for (const i of out.intents) log.push(`${e.seq}:${i.kind}`)
    for (const r of out.refusals) log.push(`${e.seq}:${r.bucket}`)
  }
  return s
}

/** Canonical text for any value, carrying prototype, bigint-ness and order. */
function digest(value: unknown, path: Set<object> = new Set()): string {
  if (typeof value === 'bigint') return `${value}n`
  if (value === null || typeof value !== 'object') return String(value)
  const o = value as object
  if (path.has(o)) return '<cycle>'
  path.add(o)
  const name = (Object.getPrototypeOf(o) as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'null-proto'
  let body: string
  if (Array.isArray(value)) body = `[${value.map((v) => digest(v, path)).join(',')}]`
  else if (value instanceof Map) body = `{${[...value].map(([k, v]) => `${digest(k, path)}=>${digest(v, path)}`).join(',')}}`
  else if (value instanceof Set) body = `{${[...value].map((v) => digest(v, path)).join(',')}}`
  else body = `{${Object.entries(o).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}:${digest(v, path)}`).join(',')}}`
  path.delete(o)
  return `${name}${body}`
}

/** The first field whose text differs, so a mismatch names itself instead of dumping megabytes. */
function firstDifference(a: object, b: object): string {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = digest((a as Record<string, unknown>)[k])
    const y = digest((b as Record<string, unknown>)[k])
    if (x !== y) return `${k}: straight ${x.length} chars, resumed ${y.length} chars\n  straight ${x.slice(0, 300)}\n  resumed  ${y.slice(0, 300)}`
  }
  return '(no top-level field differs)'
}

const t0 = Date.now()
const straightLog: string[] = []
const straightHistory = new History()
const straight = foldRange(emptyState(loaded.value.values, switches), straightHistory, events, straightLog)
straightHistory.catchUp(straight)
const straightMs = Date.now() - t0

const beforeLog: string[] = []
const beforeHistory = new History()
const before = foldRange(emptyState(loaded.value.values, switches), beforeHistory, events.slice(0, cut), beforeLog)

const dir = mkdtempSync(join(tmpdir(), 'snipe-snapproof-'))
const file = join(dir, 'tape.db.snapshot')
const shape = shapeOf({ state: before, history: beforeHistory })
const written = writeSnapshot(file, { seq: before.seq, at: before.at, shape, payload: { state: before, history: beforeHistory } }, REGISTRY)

const t1 = Date.now()
const back = readSnapshot(file, REGISTRY, shape)
if (back === null) { console.error('the snapshot did not read back at all'); dropSnapshot(file); rmSync(dir, { recursive: true, force: true }); process.exit(1) }
const readMs = Date.now() - t1

const resumedHistory = new History()
Object.assign(resumedHistory, back.payload.history)
const resumedLog: string[] = []
const t2 = Date.now()
const resumed = foldRange(back.payload.state as State, resumedHistory, events.slice(cut), resumedLog)
resumedHistory.catchUp(resumed)
const resumedMs = Date.now() - t2
rmSync(dir, { recursive: true, force: true })

const tailOfStraight = straightLog.slice(beforeLog.length)
const sameState = digest(straight) === digest(resumed)
const sameHistory = digest(straightHistory) === digest(resumedHistory)
const sameDecisions = tailOfStraight.join('|') === resumedLog.join('|')

console.log(`snapshot-proof: ${events.length} events, broken after seq ${before.seq} (${(breakAt * 100).toFixed(0)}%)`)
console.log(`snapshot-proof: saved ${(written.bytes / 1_000_000).toFixed(1)} MB in ${written.ms}ms, read back in ${readMs}ms`)
console.log(`snapshot-proof: straight fold ${(straightMs / 1000).toFixed(1)}s, resumed tail ${(resumedMs / 1000).toFixed(1)}s`)
console.log(`snapshot-proof: state    ${sameState ? 'same' : 'DIFFERENT'}`)
console.log(`snapshot-proof: history  ${sameHistory ? 'same' : 'DIFFERENT'}`)
console.log(`snapshot-proof: decisions after the break ${sameDecisions ? 'same' : 'DIFFERENT'} (${resumedLog.length} of them)`)
if (!sameState) console.log(`  first difference in state -> ${firstDifference(straight, resumed)}`)
if (!sameHistory) console.log(`  first difference in history -> ${firstDifference(straightHistory, resumedHistory)}`)
process.exit(sameState && sameHistory && sameDecisions ? 0 : 1)
