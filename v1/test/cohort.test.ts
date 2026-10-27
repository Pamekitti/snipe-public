import { describe, expect, it } from 'vitest'
import { Cohort, touchedBar } from '../src/strategy/cohort.js'

/**
 * The in-memory half of the regime gate. gatewatch.py still owns the durable record; this
 * exists only so a verdict reaches the halt decision the moment the 45s hold closes instead
 * of up to 5m51s later.
 *
 * The tests that matter here are the ones where being wrong costs money rather than
 * coverage: double-counting a launch (which moves the rate on nothing), and answering with
 * a rate computed from too little data (which is how a quiet venue reads as a bad one).
 */
const T0 = 1_787_000_000_000

describe('Cohort: recording', () => {
  it('is empty until something is recorded', () => {
    expect(new Cohort().reading(20, T0)).toBeNull()
  })

  it('computes the rate as touches over the window', () => {
    const c = new Cohort()
    for (let i = 0; i < 10; i++) c.record(`0x${i}`, T0 + i * 1000, i < 3)
    const r = c.reading(20, T0)!
    expect(r.n).toBe(10)
    expect(r.rate).toBe(30)
  })

  it('keeps only the newest `window` verdicts by launch time', () => {
    const c = new Cohort()
    // 20 misses first, then 5 touches: a window of 5 must see only the touches
    for (let i = 0; i < 20; i++) c.record(`0xmiss${i}`, T0 + i * 1000, false)
    for (let i = 0; i < 5; i++) c.record(`0xhit${i}`, T0 + (100 + i) * 1000, true)
    expect(c.reading(5, T0)!.rate).toBe(100)
    expect(c.reading(25, T0)!.rate).toBe(20)
  })

  it('orders by launch time, not by arrival order', () => {
    const c = new Cohort()
    // a late-arriving verdict for an OLD launch must not displace newer ones
    c.record('0xnew', T0 + 60_000, true)
    c.record('0xold', T0, false)
    expect(c.reading(1, T0)!.rate).toBe(100) // the newest is 0xnew, which touched
  })
})

describe('Cohort: dedupe', () => {
  it('never counts the same token twice', () => {
    const c = new Cohort()
    c.record('0xaa', T0, true)
    c.record('0xaa', T0, true)
    c.record('0xaa', T0, true)
    expect(c.reading(20, T0)!.n).toBe(1)
  })

  it('is case-insensitive on the token, because gate.db and the feed disagree on case', () => {
    const c = new Cohort()
    c.record('0xAABB', T0, true)
    c.record('0xaabb', T0, true)
    expect(c.reading(20, T0)!.n).toBe(1)
  })

  it('lets a later verdict correct an earlier one for the same launch', () => {
    // gatewatch is the authority; if it disagrees with our live scoring, it wins
    const c = new Cohort()
    c.record('0xaa', T0, true)
    c.record('0xaa', T0, false)
    expect(c.reading(20, T0)!.rate).toBe(0)
  })
})

describe('Cohort: hydrate', () => {
  it('seeds from gate.db rows so a restart is not blind', () => {
    const c = new Cohort()
    c.hydrate([
      { token: '0x01', launched_at: T0 / 1000, touch: 1 },
      { token: '0x02', launched_at: T0 / 1000 + 1, touch: 0 },
    ])
    expect(c.reading(20, T0)!.n).toBe(2)
    expect(c.reading(20, T0)!.rate).toBe(50)
  })

  it('takes launched_at in SECONDS, matching the gate.db column', () => {
    const c = new Cohort()
    c.hydrate([{ token: '0x01', launched_at: T0 / 1000, touch: 1 }])
    // if seconds were treated as ms the age would be ~56 years, not zero
    expect(c.reading(20, T0)!.dataAgeMs).toBe(0)
  })

  it('does not double-count a launch it already scored live', () => {
    const c = new Cohort()
    c.record('0xAA', T0, true)
    c.hydrate([{ token: '0xaa', launched_at: T0 / 1000, touch: 1 }])
    expect(c.reading(20, T0)!.n).toBe(1)
  })
})

describe('Cohort: provenance', () => {
  /**
   * The silent failure this exists to catch: the ring is SEEDED from gate.db, so a live
   * scorer that died on its first launch still reports a full window of 20 and a plausible
   * rate, forever. `n` cannot tell the two apart. `liveN` can.
   */
  it('counts hydrated verdicts in n but NOT in liveN', () => {
    const c = new Cohort()
    c.hydrate(Array.from({ length: 20 }, (_, i) => (
      { token: `0x${i}`, launched_at: T0 / 1000 + i, touch: 1 }
    )))
    const r = c.reading(20, T0)!
    expect(r.n).toBe(20)
    expect(r.liveN).toBe(0)
  })

  it('counts verdicts we scored ourselves in liveN', () => {
    const c = new Cohort()
    for (let i = 0; i < 5; i++) c.record(`0x${i}`, T0 + i * 1000, true)
    expect(c.reading(20, T0)!.liveN).toBe(5)
  })

  it('reports liveN over the WINDOW, not over everything ever recorded', () => {
    const c = new Cohort()
    // 20 live verdicts, then 20 newer hydrated ones push them out of a window of 20
    for (let i = 0; i < 20; i++) c.record(`0xlive${i}`, T0 + i * 1000, true)
    c.hydrate(Array.from({ length: 20 }, (_, i) => (
      { token: `0xfile${i}`, launched_at: T0 / 1000 + 100 + i, touch: 1 }
    )))
    expect(c.reading(20, T0)!.liveN).toBe(0)
    expect(c.reading(40, T0)!.liveN).toBe(20)
  })

  it('a live verdict for a token we hydrated promotes it to live', () => {
    const c = new Cohort()
    c.hydrate([{ token: '0xaa', launched_at: T0 / 1000, touch: 0 }])
    expect(c.reading(20, T0)!.liveN).toBe(0)
    c.record('0xAA', T0, true)
    const r = c.reading(20, T0)!
    expect(r.n).toBe(1)
    expect(r.liveN).toBe(1)
  })
})

describe('Cohort: hydrate reports what it ACCEPTED', () => {
  it('does not count a row with no launch time', () => {
    const c = new Cohort()
    expect(c.hydrate([
      { token: '0x01', launched_at: T0 / 1000, touch: 1 },
      { token: '0x02', launched_at: null, touch: 1 },
    ])).toBe(1)
  })

  it('does not count a row with no token', () => {
    const c = new Cohort()
    expect(c.hydrate([{ token: '', launched_at: T0 / 1000, touch: 1 }])).toBe(0)
  })

  it('does not count a token we already scored live', () => {
    const c = new Cohort()
    c.record('0xaa', T0, true)
    expect(c.hydrate([{ token: '0xAA', launched_at: T0 / 1000, touch: 1 }])).toBe(0)
  })

  it('counts a clean seed in full', () => {
    const c = new Cohort()
    expect(c.hydrate(Array.from({ length: 20 }, (_, i) => (
      { token: `0x${i}`, launched_at: T0 / 1000 + i, touch: 0 }
    )))).toBe(20)
  })
})

describe('Cohort: staleness', () => {
  it('reports the age of the newest verdict, not the oldest', () => {
    const c = new Cohort()
    c.record('0xold', T0 - 3_600_000, true)
    c.record('0xnew', T0 - 60_000, true)
    expect(c.reading(20, T0)!.dataAgeMs).toBe(60_000)
  })
})

describe('Cohort: bounded memory', () => {
  it('does not grow without limit on a long-running process', () => {
    const c = new Cohort(50)
    for (let i = 0; i < 5_000; i++) c.record(`0x${i}`, T0 + i * 1000, true)
    expect(c.size).toBeLessThanOrEqual(50)
    // and still answers correctly for a window it can serve
    expect(c.reading(20, T0)!.n).toBe(20)
  })

  it('keeps at least the full window even when the cap is small', () => {
    const c = new Cohort(20)
    for (let i = 0; i < 100; i++) c.record(`0x${i}`, T0 + i * 1000, i % 2 === 0)
    expect(c.reading(20, T0)!.n).toBe(20)
  })
})

describe('touchedBar: the same question gatewatch.py asks', () => {
  const E = 1_000_000_000_000_000n // 0.001 ETH entry mark

  it('counts a mark exactly at the take profit as a touch', () => {
    // gatewatch uses `peak >= TP`, so the boundary belongs to the touch side
    expect(touchedBar(E, (E * 121n) / 100n, 1.21)).toBe(true)
  })

  it('does not count a mark just under it', () => {
    expect(touchedBar(E, (E * 12099n) / 10000n, 1.21)).toBe(false)
  })

  it('counts anything above', () => {
    expect(touchedBar(E, E * 2n, 1.21)).toBe(true)
  })

  it('is false for a mark that never left the entry', () => {
    expect(touchedBar(E, E, 1.21)).toBe(false)
  })

  it('is false rather than dividing by zero on a curve we could not price', () => {
    expect(touchedBar(0n, E * 5n, 1.21)).toBe(false)
    expect(touchedBar(-1n, E * 5n, 1.21)).toBe(false)
  })

  it('does not lose a touch to integer truncation on tiny marks', () => {
    // 4/3 = 1.333x on marks of a few wei still has to register
    expect(touchedBar(3n, 4n, 1.21)).toBe(true)
  })
})
