import { describe, expect, it } from 'vitest'
import { makeGateDb } from './helpers/gatedb.js'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RegimeGate } from '../src/strategy/gate.js'
import { Cohort } from '../src/strategy/cohort.js'

/**
 * The in-process half of the gate. gatewatch.py used to own the hysteresis and the bot
 * borrowed its verdict from the `state.gate` row; that borrow is what cost up to 5m51s.
 * Now the bot applies the same rule itself, against a rate it can compute the instant a
 * hold closes.
 *
 * The rule and the thresholds are unchanged. Everything here is about it being the SAME
 * decision arriving sooner, so the tests are mostly parity tests.
 */
const WINDOW = 20
const OPEN_AT = 25
const SHUT_AT = 10

function mkdb(opts: { touches?: number; ranAt?: number | null; gate?: string | null } = {}) {
  const { touches = 10, ranAt = Date.now(), gate = 'open' } = opts
  const dir = mkdtempSync(join(tmpdir(), 'gate-live-'))
  const file = join(dir, 'gate.db')
  const g = makeGateDb(file)
  const nowS = Math.floor(Date.now() / 1000)
  for (let i = 0; i < WINDOW; i++) {
    g.obs({ token: `dbt${i}`, curve: `c${i}`, block: i, launched_at: nowS - i, peak: 1.3,
      touch: i < touches ? 1 : 0, at: Date.now() })
  }
  if (ranAt !== null) g.state('ran_at', String(ranAt))
  if (gate !== null) g.state('gate', gate)
  g.close()
  return file
}

/** fill a cohort with a given touch rate, all fresh */
function fill(rate: number, n = WINDOW, now = Date.now()): Cohort {
  const c = new Cohort()
  const hits = Math.round((rate / 100) * n)
  for (let i = 0; i < n; i++) c.record(`live${i}`, now - i * 1000, i < hits)
  return c
}

describe('RegimeGate: the live cohort is preferred over the file', () => {
  it('reports the cohort rate, not the database rate, once the ring is full', () => {
    // file says 50%, live says 5%: the live one is the one that is actually current
    const g = new RegimeGate(mkdb({ touches: 10 }), Date.now, fill(5))
    expect(g.read(WINDOW, OPEN_AT, SHUT_AT)!.rate).toBe(5)
  })

  it('falls back to the file while the ring is still filling after a restart', () => {
    const g = new RegimeGate(mkdb({ touches: 10 }), Date.now, fill(5, 3))
    expect(g.read(WINDOW, OPEN_AT, SHUT_AT)!.rate).toBe(50)
  })

  it('falls back to the file when nothing has been scored live at all', () => {
    const g = new RegimeGate(mkdb({ touches: 8 }), Date.now, new Cohort())
    expect(g.read(WINDOW, OPEN_AT, SHUT_AT)!.rate).toBe(40)
  })
})

describe('RegimeGate: hysteresis is applied in-process, unchanged', () => {
  it('stays open on a rate above shutAt but below openAt', () => {
    // 15% is inside the band: staying open needs >10, and it is
    const g = new RegimeGate(mkdb({ gate: 'open' }), Date.now, fill(15))
    expect(g.read(WINDOW, OPEN_AT, SHUT_AT)!.state).toBe('open')
  })

  it('does NOT reopen on a rate inside the band once shut', () => {
    const g = new RegimeGate(mkdb({ gate: 'shut' }), Date.now, fill(15))
    expect(g.read(WINDOW, OPEN_AT, SHUT_AT)!.state).toBe('shut')
  })

  it('shuts the moment the rate falls to shutAt', () => {
    const g = new RegimeGate(mkdb({ gate: 'open' }), Date.now, fill(10))
    expect(g.read(WINDOW, OPEN_AT, SHUT_AT)!.state).toBe('shut')
  })

  it('reopens at openAt and not a step below', () => {
    const g = new RegimeGate(mkdb({ gate: 'shut' }), Date.now, fill(25))
    expect(g.read(WINDOW, OPEN_AT, SHUT_AT)!.state).toBe('open')
  })

  it('carries its own state between reads instead of re-reading the file', () => {
    const g = new RegimeGate(mkdb({ gate: 'open' }), Date.now, fill(40))
    expect(g.read(WINDOW, OPEN_AT, SHUT_AT)!.state).toBe('open')
    // drop to 5%: shuts. then back to 15%, which is NOT enough to reopen.
    g.setCohort(fill(5))
    expect(g.read(WINDOW, OPEN_AT, SHUT_AT)!.state).toBe('shut')
    g.setCohort(fill(15))
    expect(g.read(WINDOW, OPEN_AT, SHUT_AT)!.state).toBe('shut')
    g.setCohort(fill(25))
    expect(g.read(WINDOW, OPEN_AT, SHUT_AT)!.state).toBe('open')
  })

  it('matches gatewatch.py step for step over a rate sequence', () => {
    // gatewatch: now = "open" if (rate >= OPEN_AT if was == "shut" else rate > SHUT_AT) else "shut"
    const seq = [40, 30, 25, 20, 15, 10, 5, 10, 15, 20, 25, 30, 45, 5, 60]
    let want: 'open' | 'shut' = 'shut'
    const g = new RegimeGate(mkdb({ gate: 'shut' }), Date.now, new Cohort())
    for (const rate of seq) {
      want = (want === 'shut' ? rate >= OPEN_AT : rate > SHUT_AT) ? 'open' : 'shut'
      g.setCohort(fill(rate))
      expect(g.read(WINDOW, OPEN_AT, SHUT_AT)!.state, `rate ${rate}`).toBe(want)
    }
  })
})

describe('RegimeGate: the existing safety rules survive', () => {
  it('still treats a dead watcher as shut even with a perfect live cohort', () => {
    // the watcher dying is not evidence the venue is good; keep the conservative answer
    const g = new RegimeGate(mkdb({ ranAt: Date.now() - 45 * 60_000 }), Date.now, fill(80))
    const r = g.read(WINDOW, OPEN_AT, SHUT_AT)!
    expect(r.state).toBe('shut')
    expect(r.stale).toContain('gatewatch is not running')
  })

  it('still returns null (no opinion) when gate.db does not exist', () => {
    const g = new RegimeGate(join(tmpdir(), 'nope-' + Math.random(), 'gate.db'), Date.now, fill(50))
    expect(g.read(WINDOW, OPEN_AT, SHUT_AT)).toBeNull()
  })

  it('still returns null when the watcher exists but has scored nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-empty-'))
    const file = join(dir, 'gate.db')
    makeGateDb(file).close()
    expect(new RegimeGate(file, Date.now, new Cohort()).read(WINDOW, OPEN_AT, SHUT_AT)).toBeNull()
  })

  it('reports dataAgeMs from whichever source it used', () => {
    const now = Date.now()
    const c = new Cohort()
    for (let i = 0; i < WINDOW; i++) c.record(`x${i}`, now - 120_000 - i * 1000, true)
    const g = new RegimeGate(mkdb(), () => now, c)
    expect(g.read(WINDOW, OPEN_AT, SHUT_AT)!.dataAgeMs).toBe(120_000)
  })
})

describe('RegimeGate: a broken cohort must not read as open', () => {
  it('falls back to the file rather than throwing when the cohort misbehaves', () => {
    const g = new RegimeGate(mkdb({ touches: 4 }), Date.now, {
      reading() { throw new Error('scoring is broken') },
    } as unknown as Cohort)
    const r = g.read(WINDOW, OPEN_AT, SHUT_AT)
    // 20% from the file, and the band says a shut gate does not reopen there
    expect(r).not.toBeNull()
    expect(r!.rate).toBe(20)
  })

  it('never yields open purely because the live path failed', () => {
    const g = new RegimeGate(mkdb({ touches: 0, gate: 'shut' }), Date.now, {
      reading() { throw new Error('boom') },
    } as unknown as Cohort)
    expect(g.read(WINDOW, OPEN_AT, SHUT_AT)!.state).toBe('shut')
  })
})

describe('RegimeGate: the live path is off until it has been proven', () => {
  it('ignores the cohort entirely when STRATEGY.gate.live is false', () => {
    // file says 50%, live says 5%: with the flag off the file must still be the answer,
    // so the scorer can run in production and be compared before it decides anything
    const g = new RegimeGate(mkdb({ touches: 10 }), Date.now, fill(5), false)
    expect(g.read(WINDOW, OPEN_AT, SHUT_AT)!.rate).toBe(50)
  })

  it('uses the cohort once the flag is on', () => {
    const g = new RegimeGate(mkdb({ touches: 10 }), Date.now, fill(5), true)
    expect(g.read(WINDOW, OPEN_AT, SHUT_AT)!.rate).toBe(5)
  })

  it('still applies the hysteresis in-process with the flag off, so resume is still instant', () => {
    // the flag gates the DATA SOURCE, not the latency fix: the band is ours either way
    const g = new RegimeGate(mkdb({ touches: 0, gate: 'open' }), Date.now, null, false)
    expect(g.read(WINDOW, OPEN_AT, SHUT_AT)!.state).toBe('shut')
  })
})

describe('RegimeGate: which source decided is visible', () => {
  it('says live when the ring served the rate', () => {
    const r = new RegimeGate(mkdb(), Date.now, fill(35)).read(WINDOW, OPEN_AT, SHUT_AT)!
    expect(r.source).toBe('live')
    expect(r.liveN).toBe(WINDOW)
  })

  it('says file when the ring is too thin, and still reports how thin', () => {
    // the silent failure this guards: the ring is SEEDED from the file, so a live path
    // that stopped filling looks identical on the rate alone
    const r = new RegimeGate(mkdb(), Date.now, fill(35, 4)).read(WINDOW, OPEN_AT, SHUT_AT)!
    expect(r.source).toBe('file')
    expect(r.liveN).toBe(4)
  })

  it('says file when the flag is off, however full the ring is', () => {
    const r = new RegimeGate(mkdb(), Date.now, fill(35), false).read(WINDOW, OPEN_AT, SHUT_AT)!
    expect(r.source).toBe('file')
  })

  /**
   * liveN counts LIVE-SCORED verdicts, not ring occupancy. Without that distinction a bot
   * that hydrated 20 rows and then never scored again reports source 'live' and liveN 20
   * forever, which is precisely the state the field was added to expose.
   */
  it('reports liveN 0 on a freshly hydrated ring, however full it is', () => {
    const g = new RegimeGate(mkdb({ touches: 7 }), Date.now)
    const c = new Cohort()
    expect(g.hydrate(c, WINDOW)).toBe(WINDOW)
    g.setCohort(c)
    const r = g.read(WINDOW, OPEN_AT, SHUT_AT)!
    // the ring can serve the rate, so it decides...
    expect(r.source).toBe('live')
    expect(r.n).toBe(WINDOW)
    // ...but nothing in it was scored by us, and that has to be visible
    expect(r.liveN).toBe(0)
  })

  it('liveN climbs as our own verdicts replace the hydrated ones', () => {
    const g = new RegimeGate(mkdb(), Date.now)
    const c = new Cohort()
    g.hydrate(c, WINDOW)
    g.setCohort(c)
    const now = Date.now()
    for (let i = 0; i < 5; i++) c.record(`fresh${i}`, now + i * 1000, true)
    expect(g.read(WINDOW, OPEN_AT, SHUT_AT)!.liveN).toBe(5)
  })

  it('reports liveN even with the flag off, because that is the point of shadow mode', () => {
    // the scorer runs dark so it can be COMPARED before it decides; zeroing the one number
    // that proves it is filling defeats the comparison
    const r = new RegimeGate(mkdb(), Date.now, fill(35), false).read(WINDOW, OPEN_AT, SHUT_AT)!
    expect(r.source).toBe('file')
    expect(r.liveN).toBe(WINDOW)
  })
})

describe('RegimeGate.hydrate reports the ring, not the file', () => {
  it('returns what the cohort accepted when rows are unusable', () => {
    // 20 rows offered, 5 with a null launched_at: "seeded 20/20" would be a lie
    const dir = mkdtempSync(join(tmpdir(), 'gate-partial-'))
    const file = join(dir, 'gate.db')
    const g = makeGateDb(file)
    const nowS = Math.floor(Date.now() / 1000)
    for (let i = 0; i < WINDOW; i++) {
      g.obs({ token: `t${i}`, curve: `c${i}`, block: i, launched_at: i < 5 ? null : nowS - i,
        peak: 1.3, touch: 1, at: Date.now() })
    }
    g.state('ran_at', String(Date.now()))
    g.close()
    const c = new Cohort()
    expect(new RegimeGate(file, Date.now).hydrate(c, WINDOW)).toBe(WINDOW - 5)
    expect(c.size).toBe(WINDOW - 5)
  })

  it('returns 0 rather than throwing when there is no database', () => {
    const g = new RegimeGate(join(tmpdir(), 'nope-' + Math.random(), 'gate.db'))
    expect(g.hydrate(new Cohort(), WINDOW)).toBe(0)
  })
})
