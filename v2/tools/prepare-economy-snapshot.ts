/** Prebuild this additive transport upgrade from the actual fold, without replaying hypothetical trades. */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deserialize } from 'node:v8'
import Database from 'better-sqlite3'
import { BoundedMap, BoundedSet, Ring } from '../core/contracts.js'
import { canonical } from '../core/identity.js'
import { decide } from '../core/decide.js'
import { emptyState, type State } from '../core/state.js'
import { History } from '../projections/history.js'
import { readSnapshot, shapeOf, writeSnapshot, type Registry } from '../io/snapshot.js'
import { snapshotPathFor } from '../io/codeid.js'
import { haltedEconomyEligibility } from '../io/economy.js'
import type { Event } from '../core/events.js'
import { assertTransportCompatible } from './migrate-snapshot.js'
import { createHash } from 'node:crypto'
import { quietWallet } from '../io/economy.js'

/** Exact core inventories reviewed for the quiet-readiness upgrade. */
export function assertQuietCompatible(source: string, target: string): void {
  const digest = (root: string) => {
    const hash = createHash('sha256')
    for (const name of readdirSync(join(root, 'core')).filter(n => n.endsWith('.ts')).sort()) {
      hash.update(name); hash.update(readFileSync(join(root, 'core', name)))
    }
    return hash.digest('hex')
  }
  if (digest(source) !== '734509b0d2f490c5ad87758b1ea61d37da758b892145b203a2e338e36ee048a7'
    || digest(target) !== 'bd4af40b9ba5eaa206b80958702445f9c1b874ddffb03d2c191e59661d5c1a91') throw new Error('Unreviewed core in quiet snapshot upgrade')
  for (const path of ['projections/history.ts', 'io/snapshot.ts']) {
    if (readFileSync(join(source, path), 'utf8') !== readFileSync(join(target, path), 'utf8')) throw new Error(`Snapshot semantics changed: ${path}`)
  }
}

// Only these additive edits are compatible with the previous snapshot. Any other core
// edit needs its own migration and proof. Old events do not contain entryReady.
const ADDITIONS: Record<string, readonly [string, string][]> = {
  'events.ts': [['; entryReady?: boolean', '']],
  'state.ts': [['  /** False while public observation must be checked before an entry. Absent on old tapes. */\n  readonly entryReady?: boolean\n', '']],
  'decide.ts': [["      if (event.entryReady !== undefined) {\n        return { state: { ...s, sensors: { ...s.sensors, entryReady: event.entryReady } }, intents, refusals }\n      }\n", '']],
  'risk.ts': [["  if (state.sensors.entryReady === false) {\n    return no(at, 'risk-logs-unhealthy', req.token, 'entry waits for paid log catch-up after halted observation')\n  }\n", '']],
}

export function assertEconomyCompatible(source: string, target: string): void {
  const files = (root: string, dir: string): string[] => readdirSync(join(root, dir)).sort().flatMap(name => {
    const path = join(dir, name)
    return statSync(join(root, path)).isDirectory() ? files(root, path) : path.endsWith('.ts') ? [path] : []
  })
  const paths = files(source, 'core')
  if (JSON.stringify(paths) !== JSON.stringify(files(target, 'core'))) throw new Error('Core file inventory changed')
  for (const path of [...paths, 'projections/history.ts', 'io/snapshot.ts']) {
    let candidate = readFileSync(join(target, path), 'utf8')
    for (const [added, legacy] of ADDITIONS[path.replace(/^core\//, '')] ?? []) {
      if (!candidate.includes(added)) throw new Error(`Expected additive readiness change missing in ${path}`)
      candidate = candidate.replace(added, legacy)
    }
    if (candidate !== readFileSync(join(source, path), 'utf8')) throw new Error(`Unapproved snapshot semantic change: ${path}`)
  }
}

async function main(): Promise<void> {
  const [sourceRoot, sourcePath, tapePath] = process.argv.slice(2)
  if (!sourceRoot || !sourcePath || !tapePath) throw new Error('usage: prepare-economy-snapshot SOURCE_ROOT SOURCE_SNAPSHOT TAPE')
  const target = resolve(new URL('..', import.meta.url).pathname)
  const transportOnly = process.argv.includes('--transport-only')
  const quietUpgrade = process.argv.includes('--quiet-upgrade')
  if (quietUpgrade) assertQuietCompatible(sourceRoot, target)
  else if (transportOnly) assertTransportCompatible(sourceRoot, target)
  else assertEconomyCompatible(sourceRoot, target)
  const raw = deserialize(readFileSync(sourcePath))
  const sourceCode = await import(pathToFileURL(join(resolve(sourceRoot), 'io/codeid.ts')).href)
  if (raw.codeId !== sourceCode.codeId() || (!transportOnly && !quietUpgrade && raw.codeId !== '654d5cde1e1380bf')) throw new Error('Snapshot does not match the verified source build')
  const shape = shapeOf({ state: emptyState(raw.payload.state.config, raw.payload.state.switches), history: new History() })
  const registry: Registry = new Map([['Ring', Ring as never], ['BoundedMap', BoundedMap as never], ['BoundedSet', BoundedSet as never], ['History', History as never]])
  const read = () => {
    const snapshot = readSnapshot(sourcePath, registry, shape, raw.codeId)
    if (!snapshot) throw new Error('Source snapshot failed validation')
    return snapshot
  }
  const candidate = read(), baseline = read()
  if (candidate.seq !== baseline.seq) throw new Error('Snapshot changed during verification; retry')
  let state = candidate.payload.state as State, old = baseline.payload.state as State
  const history = candidate.payload.history as History, oldHistory = baseline.payload.history as History
  if (!transportOnly && !quietUpgrade && state.sensors.entryReady !== undefined) throw new Error('Source already contains a readiness hold')
  if (quietUpgrade && state.sensors.quietEntryHold !== undefined) throw new Error('Source already contains quiet routing state')
  const previous = await import(pathToFileURL(join(resolve(sourceRoot), 'core/decide.ts')).href)
  const db = new Database(tapePath, { readonly: true, fileMustExist: true })
  const tip = db.prepare('SELECT seq FROM events ORDER BY seq DESC LIMIT 1').get() as { seq: number }
  const anchor = db.prepare('SELECT at FROM events WHERE seq=?').get(candidate.seq) as { at: number } | undefined
  if (anchor?.at !== candidate.at) throw new Error('Snapshot does not belong to this tape')
  let cursor = candidate.seq + 1, n = 0
  while (cursor <= tip.seq) {
    const rows = db.prepare('SELECT * FROM events WHERE seq>=? AND seq<=? ORDER BY seq LIMIT 1000').all(cursor, tip.seq) as Array<{ seq: number; at: number; kind: string; body: string; run: string }>
    if (!rows.length) throw new Error('Tape coverage missing')
    for (const row of rows) {
      if (row.seq !== cursor) throw new Error(`Tape sequence missing at ${cursor}`)
      const event = { ...JSON.parse(row.body), seq: row.seq, at: row.at, kind: row.kind, run: row.run } as Event
      if (!transportOnly && !quietUpgrade && event.kind === 'logs-status' && event.entryReady !== undefined) throw new Error('Source tape already has readiness events')
      if (quietUpgrade && event.kind === 'logs-status' && event.quietEntryHold !== undefined) throw new Error('Source tape already has quiet events')
      const a = decide(state, event), b = previous.decide(old, event)
      if (canonical([a.intents, a.refusals]) !== canonical([b.intents, b.refusals])) throw new Error(`Decisions differ at ${row.seq}`)
      state = a.state; old = b.state
      history.observe(event, state, a.intents, a.refusals)
      oldHistory.observe(event, old, b.intents, b.refusals)
      cursor = row.seq + 1; n++
    }
  }
  db.close()
  history.catchUp(state); oldHistory.catchUp(old)
  if (canonical(state) !== canonical(old) || canonical(history) !== canonical(oldHistory)) throw new Error('Actual fold changed')
  const eligibility = quietUpgrade || transportOnly ? quietWallet(state, true, true) : haltedEconomyEligibility(state, true)
  if (!eligibility.eligible) throw new Error(`Cannot prepare while wallet is active: ${eligibility.reason}`)
  const output = snapshotPathFor(tapePath)
  writeSnapshot(output, { seq: state.seq, at: state.at, shape, payload: { state, history } }, registry)
  const checked = readSnapshot(output, registry, shape)
  if (!checked || canonical(checked.payload.state) !== canonical(state)) throw new Error('Snapshot readback differs')
  console.log(JSON.stringify({ output, through: state.seq, comparedEvents: n, state: 'identical', history: 'identical', decisions: 'identical' }))
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
