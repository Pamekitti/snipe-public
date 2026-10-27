import { expect, it } from 'vitest'
import { shouldRebuild, REBUILD_FLOOR_MS, REBUILD_CEILING_MS } from '../src/simulation/cadence.js'
import { SimulationStore } from '../src/simulation/store.js'

const state = (over: Partial<Parameters<typeof shouldRebuild>[0]> = {}) =>
  ({ dirty: false, now: 1_000_000, builtAt: 1_000_000 - REBUILD_CEILING_MS + 1, nextDeadline: Infinity, ...over })

it('rebuilds on new data but never faster than the floor', () => {
  expect(shouldRebuild(state({ dirty: true, builtAt: 1_000_000 - REBUILD_FLOOR_MS }))).toBe(true)
  expect(shouldRebuild(state({ dirty: true, builtAt: 1_000_000 - REBUILD_FLOOR_MS + 1 }))).toBe(false)
})

it('rebuilds without new data at the ceiling, and at a deadline it was told about', () => {
  expect(shouldRebuild(state())).toBe(false)
  expect(shouldRebuild(state({ builtAt: 1_000_000 - REBUILD_CEILING_MS }))).toBe(true)
  expect(shouldRebuild(state({ nextDeadline: 1_000_000 }))).toBe(true)
  expect(shouldRebuild(state({ nextDeadline: 1_000_001 }))).toBe(false)
})

it('marks the store dirty for exactly the writes the report reads', () => {
  const store = new SimulationStore(':memory:')
  try {
    const event = (kind: string, sequence: number) =>
      ({ session: 's', sequence, at: 1000, kind, key: 'k', payload: {}, provenance: 'prospective' as const })
    store.dirty = false
    store.append([event('chain-log-ish-noise', 1)])
    expect(store.dirty).toBe(false)
    store.append([event('opportunity', 2)])
    expect(store.dirty).toBe(true)
    store.dirty = false
    store.append([event('control', 3)])
    expect(store.dirty).toBe(true)
    store.dirty = false
    store.gap('g', 1, 2, 'because')
    expect(store.dirty).toBe(true)
    store.dirty = false
    store.saveResult('s:2', {}, { status: 'closed' }, 2000, 'prospective')
    expect(store.dirty).toBe(true)
  } finally { store.close() }
})

it('drops the index that caused the 2026-09-13 starvation', () => {
  const store = new SimulationStore(':memory:')
  try {
    const names = (store.db.pragma('index_list(captures)') as Array<{ name: string }>).map(i => i.name)
    expect(names).not.toContain('capture_chronology')
    expect(names).toContain('capture_kind')
    expect(names).toContain('capture_key')
  } finally { store.close() }
})
