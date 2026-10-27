/** Preserve the actual wallet fold across a decision-changing repair. Never sends. */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { deserialize } from 'node:v8'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join, relative, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { BoundedMap, BoundedSet, Ring } from '../core/contracts.js'
import { APPROVE_KEPT_MS, emptyState, stoppedKey, type State } from '../core/state.js'
import { History } from '../projections/history.js'
import { readSnapshot, shapeOf, writeSnapshot, type Registry } from '../io/snapshot.js'
import { snapshotPathFor } from '../io/codeid.js'
import { canonical } from '../core/identity.js'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

function compatibilityFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith('.ts')) out.push(path)
    }
  }
  walk(join(root, 'core'))
  out.push(join(root, 'projections/history.ts'), join(root, 'io/snapshot.ts'))
  return out
}

function compatibilityDigest(root: string): string {
  const hash = createHash('sha256')
  for (const path of compatibilityFiles(root)) {
    hash.update(relative(root, path)); hash.update('\0'); hash.update(readFileSync(path)); hash.update('\0')
  }
  return hash.digest('hex')
}

export function assertTransportCompatible(sourceRoot: string, targetRoot = ROOT): void {
  if (compatibilityDigest(resolve(sourceRoot)) !== compatibilityDigest(resolve(targetRoot))) {
    throw new Error('Transport-only migration requires byte-identical core, history and snapshot code')
  }
}

export function assertMigrationSafe(state: State, allowExhausted: boolean, transportOnly = false): void {
  if (!transportOnly && !state.risk.halts.has(stoppedKey(null)) && !state.risk.halts.has('broken')) {
    throw new Error('New entries must already be stopped before migration')
  }
  const held = new Set([...state.positions.values()].filter(p=>!p.closed).map(p=>p.token))
  const active = [...state.inflight.values()].some(f => !(f.kind === 'approve'
    && f.signedAt === 0 && !f.hash && state.at - f.raisedAt > APPROVE_KEPT_MS && !held.has(f.token)))
  if (active) {
    throw new Error('A transaction is still in flight')
  }
  for (const p of state.positions.values()) {
    if (p.closed) continue
    if (!allowExhausted || !p.filled || p.venue !== 'curve'
      || p.attempts < p.rules.maxSellAttempts || p.inflightIntentId !== null
      || p.awaitingSellReceipt !== null || (p.sellReceipts?.size ?? 0) > 0
      || p.exitRecovery || p.approval?.hash || p.approval?.intentId) {
      throw new Error('Migration requires a flat book, or an explicitly approved exhausted position with no pending transaction')
    }
  }
}
function main(): void {
  const {values} = parseArgs({options:{
    source:{type:'string'}, 'source-build':{type:'string'}, tape:{type:'string',default:'data/tape.db'},
    'allow-exhausted':{type:'boolean',default:false}, 'transport-only-source':{type:'string'},
  }})
  if (!values.source || !values['source-build']) throw new Error('--source and --source-build are required')
  const processes = JSON.parse(execFileSync('pm2',['jlist'],{encoding:'utf8'})) as Array<{name:string;pm2_env:{status:string}}>
  const live = processes.find(p=>p.name==='snipe-v2-live')
  if (!live || live.pm2_env.status !== 'stopped') throw new Error('snipe-v2-live must be stopped before migrating its shutdown snapshot')
  const raw = deserialize(readFileSync(values.source))
  const initial = emptyState(raw.payload.state.config,raw.payload.state.switches)
  const shape = shapeOf({state:initial,history:new History()})
  const registry:Registry = new Map([['Ring',Ring as never],['BoundedMap',BoundedMap as never],['BoundedSet',BoundedSet as never],['History',History as never]])
  const source = readSnapshot(values.source,registry,shape,values['source-build'])
  if (!source) throw new Error('Source snapshot failed its build or shape checks')
  const state = source.payload.state as State
  const transportOnly = values['transport-only-source'] !== undefined
  if (values['transport-only-source']) assertTransportCompatible(values['transport-only-source'])
  assertMigrationSafe(state,values['allow-exhausted'],transportOnly)
  const db = new Database(values.tape,{readonly:true,fileMustExist:true})
  const tip = db.prepare('SELECT seq,at FROM events ORDER BY seq DESC LIMIT 1').get() as {seq:number;at:number}
  db.close()
  if (source.seq !== tip.seq || source.at !== tip.at) throw new Error('The shutdown snapshot does not match the tape tip')
  const output = snapshotPathFor(values.tape)
  if (resolve(output) === resolve(values.source)) throw new Error('Source and destination builds must differ')
  writeSnapshot(output,{seq:source.seq,at:source.at,shape,payload:source.payload as Record<string,object>},registry)
  const checked = readSnapshot(output,registry,shape)
  if (!checked || checked.seq !== source.seq) throw new Error('Migrated snapshot verification failed')
  const invariant = (s: State) => canonical({risk:s.risk,positions:s.positions,switches:s.switches,config:s.config})
  if (invariant(checked.payload.state as State) !== invariant(state)) throw new Error('Migration changed wallet state')
  console.log(JSON.stringify({output,seq:source.seq,transportOnly,open:[...state.positions.values()].filter(p=>!p.closed).length,halts:[...state.risk.halts.keys()],message:'Preserved wallet amounts, positions, attempts and safety stops. No trade or control was sent.'}))
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try { main() } catch(e) { console.error(e instanceof Error ? e.message : String(e));process.exitCode=1 }
}
