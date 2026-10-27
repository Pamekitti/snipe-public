/**
 * A saved fold, so a restart does not have to recompute one.
 *
 * WHY THIS EXISTS. State is defined as the fold of every event since the tape's zero, and that
 * definition is what lets a change be proved: replay the tape before and after and compare
 * kernel ids. The cost is that the only way the process knows today's numbers is to recompute
 * them from event 1, and the tape grows ~38k events an hour. On 2026-09-18 that was a
 * thirteen-minute restart during which the bot could not trade. A checkpoint keeps the
 * definition and skips the recomputation: it is a fold someone already did, and it can always
 * be checked by replaying to it.
 *
 * WHY IT IS GENERIC RATHER THAN A FIELD-BY-FIELD CODEC. A hand-written codec is wrong the day
 * somebody adds a field to `State`, and wrong silently: the field restores as whatever a fresh
 * object happened to hold, and the bot trades on a book missing a number nobody noticed. This
 * walks the object graph instead, so a new field is carried without anyone remembering to.
 * Anything it does not understand — a function, a class nobody registered — is a THROW, never a
 * dropped value, and `main.ts` answers a throw by replaying the tape the old way.
 *
 * WHAT IT IS NOT. It is not a second source of truth. The tape is still the record; this is a
 * cache of a prefix of it, keyed to the exact event it was taken at, and refused the moment
 * anything about that binding does not match.
 */
import { deserialize, serialize } from 'node:v8'
import { readdirSync, renameSync, rmSync, statSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { codeId } from './codeid.js'

/** Bumped by hand when the meaning of a saved field changes under the same name. */
const FORMAT = 1

/** The marker a registered class instance is carried as. Chosen not to collide with a field. */
const CLASS = '__snapshotClass'
/** Frozen objects come back frozen: `Object.freeze` is how the spec says "nobody may edit this". */
const FROZEN = '__snapshotFrozen'

/** Class name to constructor. `main.ts` owns this: `io/` may not reach into `projections/`. */
export type Registry = ReadonlyMap<string, new (...args: never[]) => object>

export type Snapshot = {
  readonly format: number
  /** the seq of the last event folded into this payload */
  readonly seq: number
  /** the `at` of that event, checked against the tape so a snapshot cannot cross tapes */
  readonly at: number
  /** the build that folded it. A snapshot may only be read back by the code that wrote it. */
  readonly codeId: string
  /** own-key sets of the restored objects, checked against fresh ones. See `shapeOf`. */
  readonly shape: string
  readonly payload: Record<string, unknown>
}

/**
 * The own-key set of each top-level object, as one string.
 *
 * The only place a stale snapshot can leak a default is the top level, because everything
 * below it is replaced wholesale rather than merged. So the top level is the only place that
 * needs checking, and checking it is what makes "somebody added a field" a full replay instead
 * of a silent zero.
 */
export function shapeOf(parts: Readonly<Record<string, object>>): string {
  return Object.entries(parts)
    .map(([name, value]) => `${name}:${Object.keys(value).sort().join(',')}`)
    .sort()
    .join('|')
}

function protoName(value: object, byProto: Map<object, string>): string | undefined {
  return byProto.get(Object.getPrototypeOf(value) as object)
}

/**
 * Deep copy into something `v8.serialize` can hold, with class instances marked.
 *
 * `v8.serialize` already carries Map, Set, bigint, cycles and shared references, so the only
 * work here is the prototypes it drops on the floor.
 */
function encode(value: unknown, byProto: Map<object, string>, seen: Map<object, unknown>, path: string): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') throw new Error(`${path} is a function; a snapshot cannot carry one`)
    if (typeof value === 'symbol') throw new Error(`${path} is a symbol; a snapshot cannot carry one`)
    return value
  }
  const already = seen.get(value)
  if (already !== undefined) return already

  if (Array.isArray(value)) {
    const out: unknown[] = []
    seen.set(value, out)
    for (let i = 0; i < value.length; i++) out.push(encode(value[i], byProto, seen, `${path}[${i}]`))
    return out
  }
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>()
    seen.set(value, out)
    for (const [k, v] of value) out.set(encode(k, byProto, seen, `${path}<key>`), encode(v, byProto, seen, `${path}.${String(k)}`))
    return out
  }
  if (value instanceof Set) {
    const out = new Set<unknown>()
    seen.set(value, out)
    for (const v of value) out.add(encode(v, byProto, seen, `${path}<member>`))
    return out
  }

  const proto = Object.getPrototypeOf(value) as object | null
  const plain = proto === Object.prototype || proto === null
  const name = plain ? undefined : protoName(value, byProto)
  if (!plain && name === undefined) {
    throw new Error(`${path} is a ${(value as object).constructor?.name ?? 'nameless'}, which no registry entry names`)
  }
  const out: Record<string, unknown> = {}
  seen.set(value, out)
  for (const [k, v] of Object.entries(value)) out[k] = encode(v, byProto, seen, `${path}.${k}`)
  if (name !== undefined) out[CLASS] = name
  if (Object.isFrozen(value)) out[FROZEN] = true
  return out
}

function decode(value: unknown, registry: Registry, seen: Map<object, unknown>, path: string): unknown {
  if (value === null || typeof value !== 'object') return value
  const already = seen.get(value)
  if (already !== undefined) return already

  if (Array.isArray(value)) {
    const out: unknown[] = []
    seen.set(value, out)
    for (let i = 0; i < value.length; i++) out.push(decode(value[i], registry, seen, `${path}[${i}]`))
    return out
  }
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>()
    seen.set(value, out)
    for (const [k, v] of value) out.set(decode(k, registry, seen, `${path}<key>`), decode(v, registry, seen, `${path}.${String(k)}`))
    return out
  }
  if (value instanceof Set) {
    const out = new Set<unknown>()
    seen.set(value, out)
    for (const v of value) out.add(decode(v, registry, seen, `${path}<member>`))
    return out
  }

  const raw = value as Record<string, unknown>
  const name = typeof raw[CLASS] === 'string' ? (raw[CLASS] as string) : undefined
  const frozen = raw[FROZEN] === true
  let out: Record<string, unknown>
  if (name === undefined) {
    out = {}
  } else {
    const ctor = registry.get(name)
    if (ctor === undefined) throw new Error(`${path} was saved as a ${name}, which no registry entry names`)
    // Built without running the constructor on purpose: every field is coming from the
    // snapshot, and a constructor that installed a default would quietly outrank it.
    out = Object.create(ctor.prototype) as Record<string, unknown>
  }
  seen.set(value, out)
  for (const [k, v] of Object.entries(raw)) {
    if (k === CLASS || k === FROZEN) continue
    out[k] = decode(v, registry, seen, `${path}.${k}`)
  }
  return frozen ? Object.freeze(out) : out
}

const byProtoOf = (registry: Registry): Map<object, string> => {
  const m = new Map<object, string>()
  for (const [name, ctor] of registry) m.set(ctor.prototype as object, name)
  return m
}

/**
 * Write the snapshot beside the tape, atomically.
 *
 * Temp file then rename, because a half-written snapshot that boot believed would be a bot
 * trading on half a book. A rename inside one directory is atomic, so the file is either the
 * whole old one or the whole new one.
 */
export function writeSnapshot(
  path: string,
  snap: { seq: number; at: number; shape: string; payload: Readonly<Record<string, object>> },
  registry: Registry,
): { bytes: number; ms: number } {
  const t0 = Date.now()
  const body: Snapshot = {
    format: FORMAT,
    seq: snap.seq,
    at: snap.at,
    codeId: codeId(),
    shape: snap.shape,
    payload: encode(snap.payload, byProtoOf(registry), new Map(), 'payload') as Record<string, unknown>,
  }
  const bytes = serialize(body)
  const tmp = `${path}.writing`
  writeFileSync(tmp, bytes)
  renameSync(tmp, path)
  return { bytes: bytes.length, ms: Date.now() - t0 }
}

/**
 * Read a snapshot, or null for every reason not to trust one.
 *
 * NULL IS ALWAYS SAFE and is therefore the answer to anything unexpected: a missing file, a
 * format from another build, a shape whose fields have moved, an unreadable byte. The caller
 * replays the tape, which is slow and always right.
 */
export function readSnapshot(path: string, registry: Registry, shape: string, expectedCodeId = codeId()): Snapshot | null {
  let bytes: Buffer
  try {
    statSync(path)
    bytes = readFileSync(path)
  } catch {
    return null
  }
  try {
    const body = deserialize(bytes) as Snapshot
    if (body.format !== FORMAT) return null
    if (!Number.isInteger(body.seq) || body.seq < 1) return null
    // The build is checked here as well as in the filename, so a file copied or renamed by
    // hand is still refused by the only thing that can tell: what is inside it.
    if (body.codeId !== expectedCodeId) return null
    if (body.shape !== shape) return null
    const payload = decode(body.payload, registry, new Map(), 'payload') as Record<string, unknown>
    return { ...body, payload }
  } catch {
    return null
  }
}

/** Throw the snapshot away. Used when the tape it was taken from is not the tape we have. */
export function dropSnapshot(path: string): void {
  try { rmSync(path) } catch { /* nothing to drop */ }
}

/**
 * Delete other builds' snapshots once they are old enough to belong to nobody.
 *
 * Each build keeps its own file, so without this every deploy leaves 28 MB behind forever on a
 * box that has run out of disk before. Age is the test rather than "not mine", because
 * `tools/build-snapshot.ts` writes the NEXT build's file while this one is still trading, and
 * deleting that would delete the thing that makes the next restart fast.
 */
export function sweepSnapshots(mine: string, olderThanMs: number, now = Date.now()): number {
  const dir = dirname(mine)
  const prefix = `${basename(mine).split('.snapshot-')[0]!}.snapshot-`
  let dropped = 0
  let names: string[]
  try { names = readdirSync(dir) } catch { return 0 }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const p = join(dir, name)
    if (p === mine) continue
    try {
      if (now - statSync(p).mtimeMs < olderThanMs) continue
      unlinkSync(p)
      dropped++
    } catch { /* someone else's to worry about */ }
  }
  return dropped
}
