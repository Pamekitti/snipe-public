/**
 * The saved fold, and the reasons not to trust one.
 *
 * A checkpoint is the one place in this bot where state arrives from somewhere other than the
 * tape, so the whole file is about the ways that could go wrong quietly:
 *
 *   every value comes back, including the ones v8 does not know      here
 *   a class comes back as that class, with its methods               here
 *   a fold that resumes from a snapshot decides what an unbroken one did   here
 *   a field somebody added makes the snapshot unusable, not partial  here
 *   a value nobody can encode is a throw, never a dropped field      here
 *   a corrupt or foreign file reads as null, and null means replay   here
 *
 * The last four matter more than the first two. A snapshot that fails loudly costs a slow
 * boot; a snapshot that restores 90% of a book costs a wallet.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deserialize, serialize } from 'node:v8'
import { describe, expect, it } from 'vitest'
import { BoundedMap, BoundedSet, Ring } from '../core/contracts.js'
import { decide } from '../core/decide.js'
import { emptyState, type State } from '../core/state.js'
import type { BookSpec, FrozenConfig, Switches } from '../core/config.js'
import type { Event } from '../core/events.js'
import { History } from '../projections/history.js'
import { dropSnapshot, readSnapshot, shapeOf, sweepSnapshots, writeSnapshot, type Registry } from '../io/snapshot.js'
import { codeId, snapshotPathFor } from '../io/codeid.js'

const REGISTRY: Registry = new Map<string, new (...args: never[]) => object>([
  ['Ring', Ring as never],
  ['BoundedMap', BoundedMap as never],
  ['BoundedSet', BoundedSet as never],
  ['History', History as never],
])

const band = (id: string): BookSpec => ({
  id, minCreatorTaxBps: 0, maxCreatorTaxBps: 0, minExemptions: 3, templateLossBlockMs: 3_600_000,
  sizeWei: '5000000000000000', maxDrawdownWei: '15000000000000000',
  entry: { entryDelayMs: 2_000, entryFallbackLateMs: 600, maxEntryPriceMultiple: 4.5, buySlippageBps: 5_000 },
  exit: { maxHoldMs: 45_000, hardStopMultiple: 0.5, deadCoinAfterMs: 20_000, deadCoinBelowMultiple: 1.03, graduationExitAt: 0.12, maxSellAttempts: 20, exitRetryDelayMs: 300, sellFinalMinQuoteOutWei: '1' },
  takeProfit: { otherwise: 1.75, adaptiveWindow: 20, adaptiveBars: [1.25, 1.75] },
  guard: { window: 20, recoveryWindow: 8, openAt: 1, shutAt: -1, settleMs: 52_000, freshMs: 10_800_000, pnlBar: 1.75, maxReadingAgeMs: 10_800_000 },
})

const CFG: FrozenConfig = {
  specVersion: 1, books: [band('alpha')],
  risk: {
    maxConcurrent: 14, maxTradeSizeWei: '20000000000000000', bankrollWei: '80000000000000000', drawdownStakes: 3,
    maxWalletDrawdownWei: '60000000000000000',
    brokenWindow: 20, brokenFactor: 0.78, brokenGapPp: 15, maxLogsStalenessMs: 3000, maxOverlayAgeMs: 1500,
  },
  clock: { periodMs: 250 },
}
const SW: Switches = {
  sizeWei: 5_000_000_000_000_000n,
  bookSizes: new Map([['only', { sizeWei: 1_000_000_000_000_000n, at: 1, by: 'dashboard' }]]),
  mode: 'live', at: 0, by: 'test',
}

const tick = (seq: number): Event => ({ seq, at: 1_000_000 + seq * 250, run: 'r', kind: 'clock' }) as Event

/** Fold `n` ticks, feeding History exactly the way `main.ts` does. */
function fold(from: State, h: History, seqs: readonly number[]): State {
  let s = from
  for (const n of seqs) {
    const e = tick(n)
    const out = decide(s, e)
    if (!out) continue
    s = out.state
    h.observe(e, s, out.intents, out.refusals)
  }
  return s
}

/**
 * A canonical string for any value, written independently of the codec.
 *
 * Deliberately not `expect(a).toEqual(b)`: `toEqual` is happy to call two objects equal when
 * one has lost its prototype, which is the exact failure a snapshot can have. This carries the
 * constructor name, bigint-ness and frozen-ness into the comparison.
 */
function digest(value: unknown, path: Set<object> = new Set()): string {
  if (typeof value === 'bigint') return `${value}n`
  if (value === null || typeof value !== 'object') return String(value)
  const o = value as object
  if (path.has(o)) return '<cycle>'
  path.add(o)
  const name = (Object.getPrototypeOf(o) as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'null-proto'
  const frozen = Object.isFrozen(o) ? '!' : ''
  let body: string
  if (Array.isArray(value)) body = `[${value.map((v) => digest(v, path)).join(',')}]`
  else if (value instanceof Map) body = `{${[...value].map(([k, v]) => `${digest(k, path)}=>${digest(v, path)}`).join(',')}}`
  else if (value instanceof Set) body = `{${[...value].map((v) => digest(v, path)).join(',')}}`
  else body = `{${Object.entries(o).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}:${digest(v, path)}`).join(',')}}`
  path.delete(o)
  return `${name}${frozen}${body}`
}

function tempFile(): { path: string; clean: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'snipe-snap-'))
  return { path: join(dir, 'tape.db.snapshot'), clean: () => rmSync(dir, { recursive: true, force: true }) }
}

function saved(state: State, history: History, file: string): void {
  writeSnapshot(
    file,
    { seq: state.seq, at: state.at, shape: shapeOf({ state, history }), payload: { state, history } },
    REGISTRY,
  )
}

describe('the saved fold', () => {
  it('comes back as the same state, prototypes and bigints included', () => {
    const { path, clean } = tempFile()
    try {
      const h = new History()
      const s = fold(emptyState(CFG, SW), h, [1, 2, 3, 4, 5])
      saved(s, h, path)
      const back = readSnapshot(path, REGISTRY, shapeOf({ state: s, history: h }))
      expect(back).not.toBeNull()
      expect(digest(back!.payload.state)).toBe(digest(s))
      expect(digest(back!.payload.history)).toBe(digest(h))
    } finally { clean() }
  })

  it('gives every class back its methods, not a bag of fields', () => {
    const { path, clean } = tempFile()
    try {
      const h = new History()
      const s = fold(emptyState(CFG, SW), h, [1, 2])
      s.launchMetaByTx.set('0xabc', { creatorTaxBps: 42 } as never)
      s.launchTxUnparseable.add('0xdead')
      saved(s, h, path)
      const back = readSnapshot(path, REGISTRY, shapeOf({ state: s, history: h }))!
      const r = back.payload.state as State
      expect(r.cohort).toBeInstanceOf(Ring)
      expect(r.cohort.all()).toEqual(s.cohort.all())
      expect(r.launchMetaByTx).toBeInstanceOf(BoundedMap)
      expect(r.launchMetaByTx.get('0xabc')).toEqual({ creatorTaxBps: 42 })
      expect(r.launchTxUnparseable).toBeInstanceOf(BoundedSet)
      expect(r.launchTxUnparseable.has('0xdead')).toBe(true)
      expect(back.payload.history).toBeInstanceOf(History)
      expect((back.payload.history as History).coverage).toEqual(h.coverage)
    } finally { clean() }
  })

  it('the spec comes back frozen, because frozen is how the spec says nobody may edit it', () => {
    const { path, clean } = tempFile()
    try {
      const h = new History()
      const s = fold(emptyState(Object.freeze(CFG), SW), h, [1])
      saved(s, h, path)
      const r = readSnapshot(path, REGISTRY, shapeOf({ state: s, history: h }))!.payload.state as State
      expect(Object.isFrozen(r.config)).toBe(Object.isFrozen(s.config))
    } finally { clean() }
  })

  /** The property the whole feature rests on: resuming decides what never stopping decided. */
  it('a fold that resumes from a snapshot lands where an unbroken one did', () => {
    const { path, clean } = tempFile()
    try {
      const straightH = new History()
      const straight = fold(emptyState(CFG, SW), straightH, [1, 2, 3, 4, 5, 6, 7, 8])

      const firstH = new History()
      const first = fold(emptyState(CFG, SW), firstH, [1, 2, 3, 4])
      saved(first, firstH, path)

      const back = readSnapshot(path, REGISTRY, shapeOf({ state: first, history: firstH }))!
      const resumedH = new History()
      Object.assign(resumedH, back.payload.history)
      const resumed = fold(back.payload.state as State, resumedH, [5, 6, 7, 8])

      expect(digest(resumed)).toBe(digest(straight))
      expect(digest(resumedH)).toBe(digest(straightH))
    } finally { clean() }
  })

  it('a field somebody added makes the whole snapshot unusable, not partly used', () => {
    const { path, clean } = tempFile()
    try {
      const h = new History()
      const s = fold(emptyState(CFG, SW), h, [1])
      saved(s, h, path)
      const grown = `${shapeOf({ state: s, history: h })},aFieldAddedLater`
      expect(readSnapshot(path, REGISTRY, grown)).toBeNull()
    } finally { clean() }
  })

  it('refuses to write a value nobody can bring back, rather than dropping it', () => {
    const { path, clean } = tempFile()
    try {
      const h = new History()
      const s = fold(emptyState(CFG, SW), h, [1])
      const withStranger = { ...s, registry: new Map([['when', new Date()]]) } as unknown as State
      expect(() => saved(withStranger, h, path)).toThrow(/Date/)
      const withFn = { ...s, registry: new Map([['fn', () => 1]]) } as unknown as State
      expect(() => saved(withFn, h, path)).toThrow(/function/)
    } finally { clean() }
  })

  it('reads a missing, corrupt or foreign file as null, which is what makes a bad one harmless', () => {
    const { path, clean } = tempFile()
    try {
      const h = new History()
      const s = fold(emptyState(CFG, SW), h, [1])
      const shape = shapeOf({ state: s, history: h })
      expect(readSnapshot(path, REGISTRY, shape)).toBeNull()

      writeFileSync(path, Buffer.from('not a snapshot at all'))
      expect(readSnapshot(path, REGISTRY, shape)).toBeNull()

      saved(s, h, path)
      expect(readSnapshot(path, REGISTRY, 'a shape from another build')).toBeNull()
      expect(readSnapshot(path, REGISTRY, shape)).not.toBeNull()

      dropSnapshot(path)
      expect(readSnapshot(path, REGISTRY, shape)).toBeNull()
    } finally { clean() }
  })

  /**
   * The build stamp is the answer to the two holes the shape check cannot see: a field added
   * INSIDE a stored object, which would come back missing rather than refused, and a rules
   * change, after which the saved numbers are what the old rules computed.
   */
  it('belongs to the build that wrote it, and says so inside the file as well as in its name', () => {
    const { path, clean } = tempFile()
    try {
      const h = new History()
      const s = fold(emptyState(CFG, SW), h, [1])
      const shape = shapeOf({ state: s, history: h })
      saved(s, h, path)

      expect(snapshotPathFor('data/tape.db')).toBe(`data/tape.db.snapshot-${codeId()}`)
      expect(codeId()).toMatch(/^[0-9a-f]{16}$/)
      expect(readSnapshot(path, REGISTRY, shape)).not.toBeNull()

      // What another build's file looks like from here: same bytes, a stamp that is not ours.
      const mine = deserialize(readFileSync(path)) as { codeId: string }
      writeFileSync(path, serialize({ ...mine, codeId: 'a build from 2019' }))
      expect(readSnapshot(path, REGISTRY, shape)).toBeNull()
      expect(readSnapshot(path, REGISTRY, shape, 'a build from 2019')).not.toBeNull()
      expect(readSnapshot(path, REGISTRY, shape, 'another build')).toBeNull()
    } finally { clean() }
  })

  it('sweeps other builds once they are old, and never the one written for the next restart', () => {
    const { path, clean } = tempFile()
    try {
      const h = new History()
      const s = fold(emptyState(CFG, SW), h, [1])
      saved(s, h, path)
      const stale = `${path.split('.snapshot-')[0]!}.snapshot-0000000000000000`
      const fresh = `${path.split('.snapshot-')[0]!}.snapshot-1111111111111111`
      writeFileSync(stale, Buffer.from('an older build'))
      writeFileSync(fresh, Buffer.from('the build we are about to restart into'))
      const hourAgo = Date.now() - 3_600_000

      // An hour's grace: the stale one is a day old by this clock, the fresh one minutes.
      utimesSync(stale, new Date(hourAgo - 86_400_000), new Date(hourAgo - 86_400_000))
      expect(sweepSnapshots(path, 3_600_000)).toBe(1)
      expect(existsSync(stale)).toBe(false)
      expect(existsSync(fresh)).toBe(true)
      expect(existsSync(path)).toBe(true)
    } finally { clean() }
  })

  /**
   * Boot compares the shape of a FRESH state against the saved one, so a folded state has to
   * carry the same field names as an empty one. If a fold ever starts spreading a new key in,
   * every boot silently stops resuming and nobody finds out until someone times a restart.
   */
  it('a folded state has the same fields as a fresh one, so boot can accept its own snapshot', () => {
    const h = new History()
    const s = fold(emptyState(CFG, SW), h, [1, 2, 3])
    expect(shapeOf({ state: s, history: h })).toBe(shapeOf({ state: emptyState(CFG, SW), history: new History() }))
  })
})
