import { describe, expect, it, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RegimeGate } from '../src/strategy/gate.js'
import { makeGateDb } from './helpers/gatedb.js'

const NOW = 1_760_000_000_000
const W = 40
const OPEN_AT = 25
const SHUT_AT = 20

const dirs: string[] = []
/** `ran_at` defaults to "the watcher ran just now"; pass null to simulate a dead one. */
function gateDb(
  rows: Array<{ block: number; touch: number }>,
  state?: string,
  ranAt: number | null = NOW - 60_000,
  at?: string,
): string {
  let file = at
  if (!file) {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'))
    dirs.push(dir)
    file = join(dir, 'gate.db')
  }
  const g = makeGateDb(file)
  for (const r of rows) g.obs({ token: `t${r.block}`, block: r.block, touch: r.touch })
  if (state) g.state('gate', state)
  if (ranAt !== null) g.state('ran_at', String(ranAt))
  g.close()
  return file
}
const gate = (file: string) => new RegimeGate(file, () => NOW)
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('RegimeGate', () => {
  it('is silent when the watcher has never run: a missing db must not halt the bot', () => {
    expect(gate('/nonexistent/gate.db').read(W, OPEN_AT, SHUT_AT)).toBeNull()
  })

  it('a gate.db without the bars column costs the adaptive bar, never the gate (2026-09-06)', () => {
    // preparing the `bars` statement threw on an unmigrated watcher db and the catch nulled
    // EVERY statement: the regime gate was silently off, not just the adaptive take profit
    const dir = mkdtempSync(join(tmpdir(), 'gate-'))
    dirs.push(dir)
    const file = join(dir, 'gate.db')
    const db = new Database(file)
    db.exec(`CREATE TABLE obs (token TEXT PRIMARY KEY, curve TEXT, block INTEGER, launched_at INTEGER, peak REAL, touch INTEGER, at INTEGER, error TEXT);
             CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)`)
    const oi = db.prepare('INSERT INTO obs VALUES (?,?,?,?,?,?,?,?)')
    for (let i = 0; i < W; i++) oi.run(`t${i}`, `t${i}`, 1000 + i, 0, 1.0, 0, 0, null) // no touches: a shut venue
    db.prepare('INSERT INTO state VALUES (?,?)').run('gate', 'shut')
    db.prepare('INSERT INTO state VALUES (?,?)').run('ran_at', String(NOW))
    db.close()
    const g = gate(file)
    const r = g.read(W, OPEN_AT, SHUT_AT)
    expect(r).not.toBeNull()          // the gate keeps its opinion
    expect(r!.rate).toBe(0)
    expect(g.readBars(W)).toBeNull()  // the adaptive bar has none, and falls back to its rung
  })

  it('is silent when the db exists but has no observations yet', () => {
    expect(gate(gateDb([])).read(W, OPEN_AT, SHUT_AT)).toBeNull()
  })

  it('retries a db that did not exist yet instead of latching it off forever', () => {
    // the watcher's timer and the bot's start order are independent, so gate.db routinely
    // appears minutes after boot. Latching the first failure disabled the gate for the
    // whole process lifetime, which is the one failure this module may not have.
    const dir = mkdtempSync(join(tmpdir(), 'gate-'))
    dirs.push(dir)
    const file = join(dir, 'gate.db')
    let now = NOW
    const g = new RegimeGate(file, () => now)
    expect(g.read(W, OPEN_AT, SHUT_AT)).toBeNull()

    // the watcher's first pass now creates it, five minutes into the bot's life
    gateDb(Array.from({ length: 10 }, (_, i) => ({ block: 1000 + i, touch: 1 })), 'open', NOW, file)
    // the retry is throttled, so the very next tick still says nothing...
    now += 1_000
    expect(g.read(W, OPEN_AT, SHUT_AT)).toBeNull()
    // ...but a minute later it picks the watcher up
    now += 60_000
    const r = g.read(W, OPEN_AT, SHUT_AT)
    expect(r).not.toBeNull()
    expect(r!.n).toBe(10)
    g.close()
  })

  it('computes the touch rate over the newest N launches, not all of them', () => {
    // 40 recent misses buried under 100 ancient hits: the old era must not vote
    const rows = [
      ...Array.from({ length: 100 }, (_, i) => ({ block: 1000 + i, touch: 1 })),
      ...Array.from({ length: 40 }, (_, i) => ({ block: 2000 + i, touch: 0 })),
    ]
    const g = gate(gateDb(rows)).read(W, OPEN_AT, SHUT_AT)
    expect(g).not.toBeNull()
    expect(g!.rate).toBe(0)
    expect(g!.n).toBe(40)
  })

  it('reports the rate the watcher would compute', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ block: 1000 + i, touch: i < 10 ? 1 : 0 }))
    expect(gate(gateDb(rows)).read(W, OPEN_AT, SHUT_AT)!.rate).toBe(25)
  })

  it('seeds the band from the verdict the watcher stored, then applies the rule itself', () => {
    // CHANGED 2026-08-19: the bot used to echo `state.gate` verbatim, which is what made a
    // verdict take up to 5m51s to arrive. It now owns the hysteresis, so the stored value
    // only decides WHICH SIDE of the band we start on and the rate decides the rest.
    const dead = Array.from({ length: 40 }, (_, i) => ({ block: 1000 + i, touch: 0 }))
    // a 0% rate shuts from either starting side, which is the whole point of reading it
    expect(gate(gateDb(dead, 'shut')).read(W, OPEN_AT, SHUT_AT)!.state).toBe('shut')
    expect(gate(gateDb(dead, 'open')).read(W, OPEN_AT, SHUT_AT)!.state).toBe('shut')

    // and inside the band the seed is what separates the two answers
    const band = Array.from({ length: 40 }, (_, i) => ({ block: 1000 + i, touch: i < 9 ? 1 : 0 }))
    expect(gate(gateDb(band, 'open')).read(W, OPEN_AT, SHUT_AT)!.rate).toBe(22.5)
    expect(gate(gateDb(band, 'open')).read(W, OPEN_AT, SHUT_AT)!.state).toBe('open')  // 22.5 > 20
    expect(gate(gateDb(band, 'shut')).read(W, OPEN_AT, SHUT_AT)!.state).toBe('shut')  // 22.5 < 25
  })

  it('falls back to the shut threshold when a pre-heartbeat watcher stored no verdict', () => {
    // we cannot know which side of the hysteresis it was on, so pick the answer that can
    // only cost us upside. This used to hardcode 'open', which is the answer that costs money.
    const bad = Array.from({ length: 40 }, (_, i) => ({ block: 1000 + i, touch: 0 }))
    expect(gate(gateDb(bad, undefined)).read(W, OPEN_AT, SHUT_AT)!.state).toBe('shut')
    const good = Array.from({ length: 40 }, (_, i) => ({ block: 1000 + i, touch: 1 }))
    expect(gate(gateDb(good, undefined)).read(W, OPEN_AT, SHUT_AT)!.state).toBe('open')
  })

  it('shuts when the watcher has stopped heartbeating, however good the frozen rate looks', () => {
    // a frozen gate.db reads 'open' forever. That is the one way this design fails
    // towards losing money, so a dead watcher is a shut gate.
    const rows = Array.from({ length: 40 }, (_, i) => ({ block: 1000 + i, touch: 1 }))
    const g = gate(gateDb(rows, 'open', NOW - 31 * 60_000)).read(W, OPEN_AT, SHUT_AT)!
    expect(g.state).toBe('shut')
    expect(g.rate).toBe(100)          // the rate still looks perfect
    expect(g.stale).toMatch(/not running/)
  })

  it('shuts when a watcher with observations never heartbeated at all', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ block: 1000 + i, touch: 1 }))
    const g = gate(gateDb(rows, 'open', null)).read(W, OPEN_AT, SHUT_AT)!
    expect(g.state).toBe('shut')
    expect(g.stale).toMatch(/never/)
  })

  it('stays open while the heartbeat is inside the window', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ block: 1000 + i, touch: 1 }))
    const g = gate(gateDb(rows, 'open', NOW - 29 * 60_000)).read(W, OPEN_AT, SHUT_AT)!
    expect(g.state).toBe('open')
    expect(g.stale).toBeUndefined()
  })

  it('ignores rows the watcher could not score', () => {
    const file = gateDb(Array.from({ length: 10 }, (_, i) => ({ block: 1000 + i, touch: 1 })))
    const db = new Database(file)
    db.prepare('INSERT INTO obs (token,curve,block,launched_at,peak,touch,at,error) VALUES (?,?,?,?,?,?,?,?)')
      .run('bad', 'bad', 1100, 0, null, 0, 0, 'no path')
    db.close()
    const g = gate(file).read(W, OPEN_AT, SHUT_AT)!
    expect(g.n).toBe(10)      // the failed row is not a miss, it is an unknown
    expect(g.rate).toBe(100)
  })
})
