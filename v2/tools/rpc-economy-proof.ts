/** Offline same-input proof. Never signs, sends, or opens a writable trading database. */
import { createReadStream, readFileSync, mkdtempSync } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { createInterface } from 'node:readline'
import { deserialize } from 'node:v8'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { BoundedMap, BoundedSet, Ring } from '../core/contracts.js'
import { History } from '../projections/history.js'
import { readSnapshot, writeSnapshot, type Registry } from '../io/snapshot.js'
import { canonical } from '../core/identity.js'
import { decide } from '../core/decide.js'
import type { State } from '../core/state.js'
import type { Event } from '../core/events.js'

async function main() {
  const [baselineRoot, snapshot, tail, max = '250000'] = process.argv.slice(2)
  if (!baselineRoot || !snapshot || !tail) throw new Error('usage: rpc-economy-proof BASELINE_V2 SNAPSHOT TAIL.jsonl.gz [MAX_EVENTS]')
  const limit = Number(max)
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('invalid event limit')
  const before = await import(pathToFileURL(join(resolve(baselineRoot), 'core/decide.ts')).href)
  const raw = deserialize(readFileSync(snapshot))
  const registry: Registry = new Map([['Ring', Ring as never], ['BoundedMap', BoundedMap as never], ['BoundedSet', BoundedSet as never], ['History', History as never]])
  const load = () => {
    const value = readSnapshot(snapshot, registry, raw.shape, raw.codeId)
    if (!value) throw new Error('historical snapshot failed validation')
    return value
  }
  let a = load().payload.state as State, b = load().payload.state as State
  let resumed: State | null = null
  let count = 0, decisions = 0, previous = a.seq
  const output = join(mkdtempSync(join(tmpdir(), 'snipe-rpc-proof-')), 'snapshot')
  for await (const line of createInterface({ input: createReadStream(tail).pipe(createGunzip()), crlfDelay: Infinity })) {
    const row = JSON.parse(line)
    if (row.seq <= previous) continue
    if (row.seq !== previous + 1) throw new Error(`missing event at ${previous + 1}`)
    const e = { ...JSON.parse(row.body), seq: row.seq, at: row.at, run: row.run, kind: row.kind } as Event
    const x = before.decide(a, e), y = decide(b, e)
    if (canonical([x.intents, x.refusals]) !== canonical([y.intents, y.refusals])) throw new Error(`decisions differ at ${e.seq}`)
    a = x.state; b = y.state; decisions += y.intents.length + y.refusals.length
    if (resumed) {
      const z = decide(resumed, e)
      if (canonical([z.intents, z.refusals]) !== canonical([y.intents, y.refusals])) throw new Error(`snapshot decisions differ at ${e.seq}`)
      resumed = z.state
    }
    count++; previous = e.seq
    if (count === Math.floor(limit / 2)) {
      writeSnapshot(output, { seq: b.seq, at: b.at, shape: raw.shape, payload: { state: b, history: new History() } }, registry)
      resumed = readSnapshot(output, registry, raw.shape)?.payload.state as State | null
      if (!resumed) throw new Error('snapshot round trip failed')
    }
    if (count >= limit) break
  }
  if (!count || canonical(a) !== canonical(b) || (resumed && canonical(resumed) !== canonical(b))) throw new Error('state comparison failed')
  console.log(JSON.stringify({ events: count, decisions, through: previous, state: 'identical', decisionsMatch: true, snapshotMatch: resumed !== null,
    scope: 'historical identical inputs, not transport arrival timing or profit' }))
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
