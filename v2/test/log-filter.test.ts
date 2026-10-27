import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LogFilter } from '../io/log-filter.js'
import { ComparisonBudget } from '../io/comparison-budget.js'
import type { RawLog } from '../core/events.js'

const row = (n: number): RawLog => ({ blockNumber: n, blockHash: `0xb${n}`, logIndex: 0, transactionIndex: 0,
  transactionHash: `0xt${n}`, address: '0xa', topics: ['0xf'], data: '0x' })
function fixture(path?: string) {
  let now = 0, answer: unknown = [], failure: Error | null = null
  const calls: string[] = []
  const filter = new LogFilter({ topics: ['0xf'], normalize: r => r, now: () => now,
    ...(path ? { path } : {}), request: async method => {
      calls.push(method); if (failure) throw failure
      return method === 'eth_newFilter' ? '0x1' : answer
    } })
  return { filter, calls, answer: (r: unknown) => { answer = r }, fail: (e: Error | null) => { failure = e }, time: (n: number) => { now = n } }
}
describe('filter collection and independent coverage', () => {
  it('disables an uneconomic filter after a bounded warm-up', () => {
    const f = fixture()
    for (let i = 0; i < 120; i++) { f.filter.cycle(); f.filter.charge(80) }
    f.filter.cycle()
    expect(f.filter.disabledReason).toMatch(/no compute-unit saving/)
  })
  it('sorts duplicates, verifies known blocks, and retains newer evidence', async () => {
    const f = fixture(); f.answer([row(12), row(11), row(11)])
    expect((await f.filter.poll(10, true)).map(r => r.blockNumber)).toEqual([11, 11, 12])
    f.filter.verify(10, 11, [row(11)])
    expect(f.filter.disabledReason).toBeNull()
    f.filter.verify(11, 12, [row(11), row(12)])
    expect(f.filter.checked).toBe(2)
  })
  it('does not treat empty replies as range verification', async () => {
    const f = fixture(); await f.filter.poll(10, false)
    f.time(2000); expect(f.filter.auditDue()).toBe(true)
    f.filter.verify(10, 12, [row(11)])
    expect(f.filter.disabledReason).toMatch(/missed/)
  })
  it('persists an automatic disable across restart', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'snipe-filter-')), 'state.json')
    const f = fixture(path); f.answer([row(11)]); await f.filter.poll(10, false)
    f.filter.verify(10, 12, [])
    expect(fixture(path).filter.disabledReason).toMatch(/unverified/)
  })
  it('requires recreation after an ambiguous or expired filter', async () => {
    const f = fixture(); await f.filter.poll(10, false)
    f.fail(new Error('filter not found')); await expect(f.filter.poll(10, false)).rejects.toThrow()
    f.filter.repair(); expect(f.filter.auditDue()).toBe(true)
    f.fail(null); await f.filter.poll(10, false)
    expect(f.calls.filter(m => m === 'eth_newFilter')).toHaveLength(2)
  })
  it('rejects malformed responses and removed logs', async () => {
    const f = fixture(); f.answer({})
    await expect(f.filter.poll(10, false)).rejects.toThrow('invalid filter response')
    f.answer([{ ...row(11), removed: true }])
    await expect(f.filter.poll(10, false)).rejects.toThrow('removed')
  })
})
describe('comparison allowance', () => {
  it('shares charges across connections and charges each batch member before sending', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'snipe-allowance-')), 'budget.sqlite')
    const a = new ComparisonBudget(path, 3), b = new ComparisonBudget(path, 3)
    a.claim(['eth_newFilter', 'eth_getFilterChanges']); b.claim(['eth_getLogs'])
    expect(() => a.claim(['eth_getFilterChanges'])).toThrow('exhausted')
    expect(b.status().used).toBe(3)
    expect(() => a.claim(['unknown'])).toThrow('not allowed')
    a.close(); b.close()
  })
})
