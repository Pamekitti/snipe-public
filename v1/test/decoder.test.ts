import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { decodeFrame } from '../src/feed/decoder.js'

const frames: { t: number; raw: string }[] = JSON.parse(
  fs.readFileSync(new URL('./fixtures/feed-frames.json', import.meta.url), 'utf8'),
)

describe('feed decoder against 400 live frames', () => {
  const results = frames.flatMap((f) => decodeFrame(f.raw))
  const blocks = results.filter((r) => r.kind === 'block').map((r: any) => r.block)

  it('decodes every frame into a block or a confirmation, never an error', () => {
    expect(results.filter((r) => r.kind === 'ignored')).toHaveLength(0)
    expect(blocks.length).toBe(398)
    expect(results.filter((r) => r.kind === 'confirmed').length).toBe(2)
  })

  it('block numbers are contiguous', () => {
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i]!.block).toBe(blocks[i - 1]!.block + 1)
    }
  })

  it('extracts every signed tx and parses all of them', () => {
    const total = blocks.reduce((n, b) => n + b.txs.length, 0)
    expect(total).toBe(8293)
    for (const b of blocks) for (const tx of b.txs) expect(tx.hash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('timestamps are sane and monotonic', () => {
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i]!.timestamp).toBeGreaterThanOrEqual(blocks[i - 1]!.timestamp)
    }
    expect(blocks[0]!.timestamp).toBeGreaterThan(1_700_000_000)
  })

  it('survives garbage input', () => {
    expect(decodeFrame('not json')[0]!.kind).toBe('ignored')
    expect(decodeFrame('{"version":1}')[0]!.kind).toBe('ignored')
  })
})
