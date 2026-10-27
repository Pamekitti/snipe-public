import { describe, expect, it, vi } from 'vitest'
import { BackgroundReads } from '../io/background-reads.js'

describe('halted background reads', () => {
  it('uses paid immediately when ineligible', async () => {
    const publicRead = vi.fn(), paid = vi.fn(async () => 2)
    expect(await new BackgroundReads(() => false).read(publicRead, paid)).toBe(2)
    expect(publicRead).not.toHaveBeenCalled()
  })
  it('keeps successful public data and rescues failures with paid service', async () => {
    const reads = new BackgroundReads(() => true), paid = vi.fn(async () => 2)
    expect(await reads.read(async () => 1, paid)).toBe(1)
    expect(paid).not.toHaveBeenCalled()
    expect(await reads.read(async () => { throw new Error('429') }, paid)).toBe(2)
  })
  it('does not wait for a hung public operation when critical work arrives', async () => {
    const reads = new BackgroundReads(() => true), paid = vi.fn(async () => 2)
    let signal!: AbortSignal
    const result = reads.read(s => { signal = s; return new Promise<number>(() => {}) }, paid)
    reads.preempt()
    expect(await result).toBe(2)
    expect(signal.aborted).toBe(true)
    expect(paid).toHaveBeenCalledTimes(1)
  })
  it('discards a result if eligibility changed before it completed', async () => {
    let eligible = true
    const reads = new BackgroundReads(() => eligible)
    expect(await reads.read(async () => { eligible = false; return 1 }, async () => 2)).toBe(2)
  })
})
