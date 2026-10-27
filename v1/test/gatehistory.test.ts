import { describe, expect, it } from 'vitest'
import {
  replayGate, venueRate, toIntervals, haltIntervals, thin, type GateObs,
} from '../src/telemetry/gatehistory.js'

const CFG = { window: 20, openAt: 25, shutAt: 20 }
const T0 = 1_700_000_000_000

/**
 * Build obs rows. `perPass` controls how many land in one scoring pass: rows inside a pass
 * are 1s apart, and a new pass starts 5 minutes later, which is what gatewatch does.
 */
const obs = (touches: number[], perPass = 1): GateObs[] =>
  touches.map((t, i) => {
    const pass = Math.floor(i / perPass)
    return {
      block: 1000 + i,
      launched_at: 1_700_000_000 + i * 10,
      at: T0 + pass * 300_000 + (i % perPass) * 1_000,
      touch: t,
    }
  })

describe('replayGate', () => {
  it('steps once per pass, not once per observation', () => {
    // 40 rows in passes of 20 must advance the machine twice, not forty times
    expect(replayGate(obs(Array(40).fill(1), 20), CFG).length).toBe(2)
    expect(replayGate(obs(Array(40).fill(1), 1), CFG).length).toBe(40)
  })

  it('does not flap on a threshold crossed and recrossed inside one pass', () => {
    // This is the bug the first version had. Rows 0-19 are all hits (rate would cross
    // open mid-batch), rows 20-39 are all misses, and the whole lot is scored in ONE
    // backfill pass. gatewatch only looks once, at the end, where the rate is 0%.
    const pts = replayGate(obs([...Array(20).fill(1), ...Array(20).fill(0)], 40), CFG)
    expect(pts.length).toBe(1)
    expect(pts[0]!.rate).toBe(0)
    expect(pts[0]!.state).toBe('shut') // never opened, because it was never asked
  })

  it('starts shut, because an unproven venue is not a paying one', () => {
    // only a rate INSIDE the band proves the seed: 22% would hold open (>20) but cannot
    // open from shut (<25). W=100 so 22% is reachable.
    const wide = { window: 100, openAt: 25, shutAt: 20 }
    const pts = replayGate(obs([...Array(78).fill(0), ...Array(22).fill(1)], 100), wide)
    expect(pts[pts.length - 1]!.rate).toBeCloseTo(22, 9)
    expect(pts[pts.length - 1]!.state).toBe('shut')
  })

  it('shuts at exactly shutAt, because the test is > and not >=', () => {
    const up = replayGate(obs([...Array(5).fill(1), ...Array(15).fill(0)]), CFG)
    expect(up[up.length - 1]!.rate).toBe(25)
    expect(up[up.length - 1]!.state).toBe('open')
    // one more miss rolls a hit out of the window: 4 of 20 = 20%, NOT > shutAt
    const down = replayGate(obs([...Array(5).fill(1), ...Array(16).fill(0)]), CFG)
    expect(down[down.length - 1]!.rate).toBe(20)
    expect(down[down.length - 1]!.state).toBe('shut')
  })

  it('ranks the window by block descending, the way gatewatch does', () => {
    // an old good era must not vote on today
    const pts = replayGate(obs([...Array(100).fill(1), ...Array(20).fill(0)]), CFG)
    const last = pts[pts.length - 1]!
    expect(last.rate).toBe(0)
    expect(last.n).toBe(20)
  })

  it('plots against the scoring time, not the launch time', () => {
    // the verdict became knowable when it was scored; using launched_at would draw the
    // gate reacting to launches before it could have seen them
    const rows = obs([1])
    expect(replayGate(rows, CFG)[0]!.t).toBe(rows[0]!.at)
  })

  it('handles an empty table without throwing', () => {
    expect(replayGate([], CFG)).toEqual([])
  })
})

describe('venueRate', () => {
  it('is a measurement, so it survives a backfill that collapses into one pass', () => {
    // same rows, wildly different pass structure: the venue curve must not care
    const spread = venueRate(obs([1, 0, 1, 0, 1], 1), 20)
    const backfilled = venueRate(obs([1, 0, 1, 0, 1], 5), 20)
    expect(spread.map((p) => p.rate)).toEqual(backfilled.map((p) => p.rate))
  })

  it('plots against the venue clock and covers every launch', () => {
    const rows = obs([1, 1, 1])
    const v = venueRate(rows, 20)
    expect(v.length).toBe(3)
    expect(v[0]!.t).toBe(rows[0]!.launched_at * 1000)
  })

  it('matches a naive recompute over a long random run', () => {
    let seed = 42
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const touches: number[] = Array.from({ length: 500 }, () => (rnd() > 0.6 ? 1 : 0))
    const v = venueRate(obs(touches), 20)
    for (let i = 0; i < touches.length; i++) {
      const win = touches.slice(Math.max(0, i - 19), i + 1)
      expect(v[i]!.rate).toBeCloseTo((100 * win.reduce((a, b) => a + b, 0)) / win.length, 10)
    }
  })

  it('is empty for no observations', () => {
    expect(venueRate([], 20)).toEqual([])
  })
})

describe('toIntervals', () => {
  it('spans the shut stretches and leaves an ongoing one open-ended', () => {
    const pts = replayGate(obs([...Array(20).fill(1), ...Array(20).fill(0)]), CFG)
    const shut = toIntervals(pts, 'shut')
    expect(shut.length).toBeGreaterThan(0)
    expect(shut[shut.length - 1]!.to).toBeNull()
  })

  it('returns nothing when the state never occurs', () => {
    // all hits: it opens on the very first pass and never shuts, so there is no seed span
    const pts = replayGate(obs(Array(30).fill(1)), CFG)
    expect(toIntervals(pts, 'shut')).toEqual([])
  })
})

describe('haltIntervals', () => {
  it('pairs a halt with its resume', () => {
    expect(haltIntervals([
      { at: 100, ok: 0, detail: 'drawdown' },
      { at: 300, ok: 1, detail: '' },
    ])).toEqual([{ from: 100, to: 300, label: 'drawdown' }])
  })

  it('leaves an unresolved halt running to now', () => {
    const iv = haltIntervals([{ at: 100, ok: 0, detail: 'gate shut' }])
    expect(iv[0]!.to).toBeNull()
    expect(iv[0]!.label).toBe('gate shut')
  })

  it('ignores repeated halts without an intervening resume', () => {
    const iv = haltIntervals([
      { at: 100, ok: 0, detail: 'first' },
      { at: 150, ok: 0, detail: 'second' },
      { at: 200, ok: 1, detail: '' },
    ])
    expect(iv).toEqual([{ from: 100, to: 200, label: 'first' }])
  })

  it('is empty when the bot never halted', () => {
    expect(haltIntervals([{ at: 1, ok: 1, detail: '' }])).toEqual([])
  })
})

describe('thin', () => {
  it('always keeps the newest point', () => {
    const t = thin(Array.from({ length: 1000 }, (_, i) => i), 100)
    expect(t.length).toBeLessThanOrEqual(101)
    expect(t[t.length - 1]).toBe(999)
  })

  it('leaves short series alone', () => {
    expect(thin([1, 2, 3], 400)).toEqual([1, 2, 3])
  })
})
