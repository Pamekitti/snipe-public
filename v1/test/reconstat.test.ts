/**
 * The sim-vs-live alarm statistic.
 *
 * Guards the 2026-08-26 fix: the alarm read the MEAN of the last 50 per-trade gaps and so
 * fired at -3.93pp on a window whose median was 0.00 with 38/50 exact. One row carried it
 * (position 870: live +0.0165 ETH vs sim +0.0058, a -215pp gap on a single spend, and the
 * "error" was live BEATING the model on a 2.36x runner).
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const { reconSummary, median, LIMIT_PP } = createRequire(import.meta.url)('../scripts/reconstat.cjs')

describe('reconSummary', () => {
  it('does not alarm on the real 2026-08-26 window', () => {
    // 38 exact, a scatter of small gaps, and the one 215pp outlier
    const gaps = [
      ...Array(38).fill(0),
      -215.06, 40.07, 31.9, -23.5, -20, 10.9, -4.4, 3.7, -1.2, 0.9, 0.4, -0.3,
    ]
    const r = reconSummary(gaps)
    expect(r.n).toBe(50)
    expect(r.median).toBe(0)
    expect(r.alarm).toBe(false)
    // the mean is still reported, and it is still ugly: that is the point of showing both
    expect(r.mean).toBeLessThan(-3)
    expect(r.text).toContain('gap=+0.00pp')
    expect(r.text).toContain('mean=-3.5')
  })

  it('still alarms when the sim genuinely drifts', () => {
    // every trade off by ~2pp in the same direction: a real model error, not a tail
    const r = reconSummary(Array.from({ length: 50 }, (_, i) => -2.0 - (i % 5) * 0.1))
    expect(r.alarm).toBe(true)
    expect(r.median).toBeLessThan(-LIMIT_PP)
  })

  it('one huge outlier cannot create an alarm on its own', () => {
    const clean = Array(49).fill(0.1)
    expect(reconSummary([...clean, -500]).alarm).toBe(false)
    expect(reconSummary([...clean, 500]).alarm).toBe(false)
  })

  it('one huge outlier cannot suppress a real one either', () => {
    const drifting = Array(49).fill(-3.0)
    expect(reconSummary([...drifting, 500]).alarm).toBe(true)
  })

  it('alarms in both directions', () => {
    expect(reconSummary(Array(20).fill(2.1)).alarm).toBe(true)
    expect(reconSummary(Array(20).fill(-2.1)).alarm).toBe(true)
    expect(reconSummary(Array(20).fill(1.4)).alarm).toBe(false)
  })

  it('an empty window is not an alarm, it is no data', () => {
    const r = reconSummary([])
    expect(r.alarm).toBe(false)
    expect(r.text).toBe('recon=–')
  })

  it('the line stays parseable by push.py and the report skill', () => {
    // both match /gap=([+-]?[\d.]+)pp/ and must read the MEDIAN out of it
    const r = reconSummary([0, 0, 0, -100])
    const m = /gap=([+-]?[\d.]+)pp/.exec(r.text)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(r.median)
  })

  it('median handles even and odd windows', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBe(0)
  })
})
