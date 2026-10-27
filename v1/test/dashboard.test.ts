import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import type { HaltKind } from '../src/strategy/risk.js'
import { makeGateDb } from './helpers/gatedb.js'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The dashboard shares a process with the trading loop and there is no uncaughtException
 * handler, so "the page threw" and "the bot died" are the same event. These tests exist
 * to keep a reporting bug from ever being that.
 */
let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dash-'))
  const gate = makeGateDb(join(dir, 'gate.db'))
  const base = Date.now() - 3600_000
  for (let i = 0; i < 60; i++) {
    // one scoring pass every 5 min, 2 launches each; ~50% touch so the gate is open
    gate.obs({ token: `t${i}`, curve: `c${i}`, block: 1000 + i,
      launched_at: Math.floor((base + i * 30_000) / 1000), peak: 1.3,
      touch: i % 2, at: base + Math.floor(i / 2) * 300_000 })
  }
  gate.obs({ token: 'bad', curve: 'bad', block: 9999, launched_at: Math.floor(base / 1000),
    peak: null, at: base, error: 'no path' })
  gate.state('ran_at', String(Date.now() - 60_000))
  gate.state('gate', 'open')
  gate.close()
  process.env.GATE_DB = join(dir, 'gate.db')
})
afterAll(() => { delete process.env.GATE_DB; rmSync(dir, { recursive: true, force: true }) })

/** a bot.db with just what the chart endpoint reads */
function botDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE positions (id INTEGER PRIMARY KEY, token TEXT, curve TEXT, live INTEGER,
           spend_wei TEXT, pnl_wei TEXT, onchain_pnl_wei TEXT, exit_reason TEXT, exit_at INTEGER,
           closed INTEGER, buy_ok INTEGER, hold_ms INTEGER, peak_mult REAL, entry_block INTEGER)`)
  db.exec(`CREATE TABLE balance (at INTEGER PRIMARY KEY, wei TEXT, open_n INTEGER, deployed_wei TEXT)`)
  db.exec(`CREATE TABLE health (id INTEGER PRIMARY KEY, at INTEGER, component TEXT, ok INTEGER, detail TEXT)`)
  db.exec(`CREATE TABLE launches (token TEXT PRIMARY KEY, detected_at INTEGER, passed INTEGER, reject_reason TEXT)`)
  const now = Date.now()
  // one of every reject prefix strategy/launch.ts can emit, plus a shape the CASE arms do
  // not name, so `other` is never silently zero in these tests
  const lch = db.prepare('INSERT INTO launches (token,detected_at,passed,reject_reason) VALUES (?,?,?,?)')
  const REASONS: Array<[number, string | null]> = [
    [1, null],
    [0, 'dev buy 12000000000000000'],
    [0, 'dev buy 5000000000000000'],
    [0, 'non-eth pair 0x5e812136'],
    [0, 'creator tax 500bps'],
    [0, 'repeat deployer (7 prior launches)'],
    [0, 'no exempt wallets (0)'],
    [0, 'param read failed boom'],
  ]
  for (let i = 0; i < 96; i++) {
    const r = REASONS[i % REASONS.length]!
    lch.run(`0xl${i}`, now - (96 - i) * 60_000, r[0], r[1])
  }
  const bal = db.prepare('INSERT INTO balance VALUES (?,?,?,?)')
  for (let i = 0; i < 120; i++) bal.run(now - (120 - i) * 30_000, String(Math.round(8e16 + i * 1e13)), 0, '0')
  const pos = db.prepare(`INSERT INTO positions (id,token,curve,live,spend_wei,pnl_wei,onchain_pnl_wei,
    exit_reason,exit_at,closed,buy_ok,hold_ms,peak_mult,entry_block) VALUES (?,?,?,?,?,?,?,?,?,1,1,45000,1.2,1)`)
  for (let i = 0; i < 40; i++) {
    const tp = i % 3 === 0
    pos.run(i + 1, `0xtok${i}`, `0xc${i}`, 1, String(75e14),
      String(tp ? 18e14 : -9e14), String(tp ? 18e14 : -9e14),
      tp ? 'tp' : 'time', now - (40 - i) * 90_000)
  }
  // bookkeeping closes that every consumer must exclude from P&L
  pos.run(500, '0xrev', '0xcv', 1, '0', '-1000', null, 'buy-reverted', now - 60_000)
  pos.run(501, '0xflat', '0xcf', 1, String(75e14), '0', null, 'recovered-flat', now - 60_000)
  // a shadow trade, which must never reach a production number
  pos.run(502, '0xshadow', '0xcs', 0, String(75e14), String(-50e14), null, 'time', now - 60_000)
  db.prepare('INSERT INTO health (at,component,ok,detail) VALUES (?,?,?,?)')
    .run(now - 1800_000, 'halt', 0, 'regime gate shut')
  db.prepare('INSERT INTO health (at,component,ok,detail) VALUES (?,?,?,?)')
    .run(now - 1200_000, 'halt', 1, 'armed')
  return db
}

const fakeBot = (db: Database.Database) => ({ tel: { raw: () => db } }) as any

describe('chartSnapshot', () => {
  it('ships the paper wallet, bounded to the lookback and blank without an account', async () => {
    const { chartSnapshot } = await import('../src/telemetry/dashboard.js')
    const cd: any = chartSnapshot(fakeBot(botDb()), '1h')
    expect(cd.paper).toBeDefined()
    expect(Array.isArray(cd.paper.points)).toBe(true)
    expect(cd.paper.points.every((p: any) => p.t >= cd.from && p.t <= cd.to)).toBe(true)
    expect(Array.isArray(cd.paper.dark)).toBe(true)
    expect(Array.isArray(cd.paper.seams)).toBe(true)
    // the fixture has no shadow account, so the line is absent rather than a flat zero
    expect(cd.paper.monthToDate).toBeNull()
  })

  it('returns every series the page draws, bounded to the lookback', async () => {
    const { chartSnapshot } = await import('../src/telemetry/dashboard.js')
    const cd: any = chartSnapshot(fakeBot(botDb()), '1h')
    expect(cd.lookback).toBe('1h')
    expect(cd.to - cd.from).toBe(3600_000)
    expect(cd.wallet.length).toBeGreaterThan(2)
    expect(cd.wallet.every((p: any) => p.t >= cd.from)).toBe(true)
    expect(cd.trades.every((p: any) => p.t >= cd.from)).toBe(true)
    expect(Array.isArray(cd.outcomes.buckets)).toBe(true)
    expect(Array.isArray(cd.recordedHalts)).toBe(true)
    expect(Array.isArray(cd.recordedStates)).toBe(true)
  })

  it('falls back to a default rather than throwing on a junk lookback', async () => {
    const { chartSnapshot } = await import('../src/telemetry/dashboard.js')
    expect(() => chartSnapshot(fakeBot(botDb()), 'garbage')).not.toThrow()
  })

  it('survives an empty database', async () => {
    const { chartSnapshot } = await import('../src/telemetry/dashboard.js')
    const empty = new Database(':memory:')
    empty.exec(`CREATE TABLE positions (id INTEGER PRIMARY KEY, live INTEGER, spend_wei TEXT,
      pnl_wei TEXT, onchain_pnl_wei TEXT, exit_reason TEXT, exit_at INTEGER, closed INTEGER,
      token TEXT, hold_ms INTEGER)`)
    empty.exec(`CREATE TABLE balance (at INTEGER PRIMARY KEY, wei TEXT, open_n INTEGER, deployed_wei TEXT)`)
    empty.exec(`CREATE TABLE health (id INTEGER PRIMARY KEY, at INTEGER, component TEXT, ok INTEGER, detail TEXT)`)
    empty.exec(`CREATE TABLE launches (token TEXT PRIMARY KEY, detected_at INTEGER, passed INTEGER, reject_reason TEXT)`)
    const cd: any = chartSnapshot(fakeBot(empty), '24h')
    expect(cd.wallet).toEqual([])
    expect(cd.trades).toEqual([])
    expect(cd.outcomes.buckets).toEqual([])
  })
})

describe('recentExits', () => {
  it('carries the close time so the table can lead with a clock', async () => {
    // added 2026-09-12: the page had no timestamp anywhere except "44 min ago" in the strip
    const { recentExits } = await import('../src/telemetry/dashboard.js')
    const { Telemetry } = await import('../src/telemetry/db.js')
    const tel = new Telemetry(':memory:')
    const db = tel.raw()
    const now = Date.now()
    const ins = db.prepare(`INSERT INTO positions (id,token,curve,live,closed,spend_wei,pnl_wei,
      exit_reason,exit_at,hold_ms) VALUES (?,?,?,1,1,?,?,?,?,?)`)
    ins.run(1, '0xa', '0xca', '20000000000000000', '1000000000000000', 'tp', now - 600_000, 21_000)
    ins.run(2, '0xb', '0xcb', '20000000000000000', '-900000000000000', 'time', now - 60_000, 47_000)
    const rows: any[] = recentExits(db)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => Number.isFinite(r.exitAt))).toBe(true)
    // newest first, and the value is epoch ms, not seconds
    expect(rows[0]!.exitAt).toBeGreaterThan(rows[1]!.exitAt)
    expect(rows[0]!.exitAt).toBeGreaterThan(1_700_000_000_000)
    tel.raw().close()
  })
})

describe('dashboardHtml', () => {
  it('renders a complete document with no template artifacts', async () => {
    const { dashboardShell } = await import('../src/telemetry/dashboard-page.js')
    const h = dashboardShell()
    expect(h.startsWith('<!doctype html>')).toBe(true)
    expect(h.trimEnd().endsWith('</html>')).toBe(true)
    // A bad template splice lands in a rendered position, not in the script body, where
    // "undefined" appears legitimately inside the null-guards. Check where it would hurt.
    expect(h).not.toContain('>undefined<')
    expect(h).not.toContain('="undefined"')
    expect(h).not.toContain('[object Object]')
    expect(h).not.toContain('>NaN<')
  })

  it('has an element for every id the script writes to', async () => {
    const { dashboardShell } = await import('../src/telemetry/dashboard-page.js')
    const h = dashboardShell()
    // $('x') against a missing element throws on .textContent and kills the whole tick,
    // so every referenced id must exist in the markup
    const ids = new Set([...h.matchAll(/\$\('([a-zA-Z0-9]+)'\)/g)].map((m) => m[1]!))
    const declared = new Set([...h.matchAll(/\bid="([a-zA-Z0-9]+)"/g)].map((m) => m[1]!))
    const missing = [...ids].filter((i) => !declared.has(i))
    expect(missing).toEqual([])
  })

  it('carries no experiment framing', async () => {
    const { dashboardShell } = await import('../src/telemetry/dashboard-page.js')
    const h = dashboardShell()
    expect(h).not.toContain('gate to scale')
    expect(h).not.toContain('Sim vs live')
    expect(h).not.toContain('pilot')
    expect(h).not.toMatch(/2000 ms/) // the entry budget must come from config now
  })

  it('states each fact once, with no removed control left behind', async () => {
    // the 2026-09-12 redundancy pass. Each of these was on the page two to six times, or
    // was a control that blanked its own pane. The fixed touch multiple is gone entirely:
    // the gate still scores on it, the page no longer shows or colours by it.
    const { dashboardHtml, dashboardShell } = await import('../src/telemetry/dashboard-page.js')
    const html = dashboardHtml(), shell = dashboardShell()
    expect(shell).not.toContain('__TOUCH_BAR__')
    expect(html).not.toContain('1.21')
    // the touch test's own controls and labels, not the word wherever it appears in prose
    for (const gone of ['data-seg="touched"', 'data-seg="missed"', 'touched __', 'Coins: touched',
                        'Market return', 'Live readings', 'Pass rate', 'Wallet cash', 'Drawdown used'])
      expect(html).not.toContain(gone)
    // the positions card starts hidden and the exits table leads with a time
    expect(html).toContain('id="posCard" hidden')
    const head = html.slice(html.indexOf('<table id="rec">'))
    expect(head.slice(0, head.indexOf('</tr>'))).toContain('<th>Time</th>')
    // three rolling columns, and the calendar day left to the Today card
    const kpi = html.slice(html.indexOf('<table id="kpi">'), html.indexOf('id="kpiBody"'))
    expect([...kpi.matchAll(/<th>([^<]+)<\/th>/g)].map(m => m[1])).toEqual(['metric', '1h', '4h', '12h'])
  })

  it('offers exactly the lookbacks the API knows about', async () => {
    const { dashboardHtml } = await import('../src/telemetry/dashboard-page.js')
    const { LOOKBACKS } = await import('../src/telemetry/dashboard.js')
    const h = dashboardHtml()
    const offered = [...h.matchAll(/data-h="([^"]+)"/g)].map((m) => m[1]!)
    expect(offered.sort()).toEqual(Object.keys(LOOKBACKS).sort())
  })
})

/**
 * Buy alerts. There was nothing here until 2026-08-19, and that absence is the reason a buy
 * failure rate of 2% -> 37.5% (p=5.6e-10) ran for four hours before anyone noticed: a buy
 * that never fills does not appear in return-on-turnover, it just quietly is not there.
 */
describe('buildAlerts, buy failures', () => {
  const base = {
    halted: false, haltReason: '', haltKind: null as HaltKind | null,
    autoResumes: false, resumesWhen: null as string | null,
    feedConnected: true, feedAgeMs: 0,
    logsHealthy: true, logsAgeMs: 0, logsStaleLimit: 3_000,
    drawdownEth: 0, drawdownLimitEth: 0.1, ethUsd: 2515,
    gateState: 'open' as const, gateRate: 40, gateHeartbeatMs: 0, gateDataAgeMs: 0,
    minsSinceTrade: 1 as number | null, upMs: 3_600_000,
    rot1h: 0, n1h: 0,
    stuck: 0, stranded: 0, exitFailures: 0,
    parked: 0, nonceResyncs1h: 0, pollFailures1h: 0, detectLagP50: null as number | null, detectLagN: 0,
    markErrP50: null as number | null, markErrN: 0, bookDrift1h: 0,
    // the 2026-09-07 guards, at healthy values: the venue paying, and us keeping pace with it
    venueSum: 2 as number | null, venueN: 40, venueFresh: true as boolean | undefined,
    brokenGapPp: 0 as number | null, brokenN: 20, brokenLimitPp: 15 as number | undefined,
    buyFails: 0, buyAttempts: 0, buyOutOfGas: 0, buyGasHeadroom: null as number | null,
  }
  const ids = async (over: Partial<typeof base>) => {
    const { buildAlerts } = await import('../src/telemetry/dashboard.js')
    return buildAlerts({ ...base, ...over }).map((x) => `${x.id}:${x.sev}`)
  }

  it('any book-vs-chain disagreement is critical (2026-09-06)', async () => {
    const { buildAlerts } = await import('../src/telemetry/dashboard.js')
    expect(await ids({ bookDrift1h: 0 })).toEqual([])
    expect(await ids({ bookDrift1h: 1 })).toEqual(['bookdrift:crit'])
    const msg = buildAlerts({ ...base, bookDrift1h: 3 }).find((a) => a.id === 'bookdrift')!.msg
    expect(msg).toContain('3 time')
    expect(msg).toContain('re-seeded')
  })

  it('warns then crits as the drawdown approaches the kill switch, in ETH', async () => {
    // ETH against the ETH bound since 2026-09-07. While both sides went through ETHUSD, a
    // stale price moved this ladder and the stop it is warning about in lockstep, so the
    // percentage was right and the dollars on it were not.
    expect(await ids({ drawdownEth: 0.5 * 0.1 })).not.toContain('dd:warn')
    expect(await ids({ drawdownEth: 0.7 * 0.1 })).toContain('dd:warn')
    expect(await ids({ drawdownEth: 0.9 * 0.1 })).toContain('dd:crit')
  })

  it('prints the drawdown in ETH and the dollars beside it', async () => {
    const { buildAlerts } = await import('../src/telemetry/dashboard.js')
    const msg = buildAlerts({ ...base, drawdownEth: 0.08, ethUsd: 2500 })
      .find((x) => x.id === 'dd')!.msg
    expect(msg).toContain('0.0800 ETH')
    expect(msg).toContain('$200')
    expect(msg).toContain('80%')
  })

  it('tells the operator WHEN a halt lifts, not merely that it does', async () => {
    const { buildAlerts } = await import('../src/telemetry/dashboard.js')
    const msg = (over: Partial<typeof base>) =>
      buildAlerts({ ...base, ...over }).find((x) => x.id === 'halted')!.msg
    // the bug this replaced: an inline `haltKind === 'gate'` told whoever was reading at
    // 3am that a halt lifting by itself "needs you"
    expect(msg({ halted: true, haltReason: 'venue not paying', haltKind: 'venue',
                 autoResumes: true, resumesWhen: 'when the venue pays again' }))
      .toContain('venue pays again')
    expect(msg({ halted: true, haltReason: 'drawdown 0.112 ETH from peak', haltKind: 'drawdown' }))
      .toContain('needs you')
  })

  it('says nothing on a healthy book', async () => {
    expect(await ids({ buyAttempts: 20, buyFails: 0 })).toEqual([])
  })

  it('a halted bot is not an idle bot', async () => {
    // The suppressors used to be a closed entry window and a shut touch gate, both since
    // deleted. `halted` replaces them and covers more: it is true for the venue pause, the
    // drawdown stop, an operator stop and HALT=1, so a bot that is legitimately not
    // entering is reported once, by the `halted` alert, rather than twice.
    expect(await ids({ minsSinceTrade: 600, halted: true, haltReason: 'venue not paying', haltKind: 'venue' }))
      .not.toContain('idle:warn')
    expect(await ids({ minsSinceTrade: 600 })).toContain('idle:warn')
  })

  it('a fresh boot that has not traded yet is not idle', async () => {
    expect(await ids({ minsSinceTrade: null, upMs: 60_000 })).not.toContain('idle:crit')
    expect(await ids({ minsSinceTrade: null })).toContain('idle:crit')
  })

  it('separates a stranded bag from a stuck one', async () => {
    expect(await ids({ buyAttempts: 20, stuck: 1, stranded: 0 })).toContain('stuck:crit')
    expect(await ids({ buyAttempts: 20, stuck: 1, stranded: 0 })).not.toContain('stranded:crit')
    expect(await ids({ buyAttempts: 20, stuck: 0, stranded: 1 })).toContain('stranded:crit')
    expect(await ids({ buyAttempts: 20, stuck: 0, stranded: 1 })).not.toContain('stuck:crit')
    expect(await ids({ buyAttempts: 20, stuck: 1, stranded: 1 })).toEqual(
      expect.arrayContaining(['stuck:crit', 'stranded:crit']),
    )
  })

  it('says a stranded bag needs a human, not patience', async () => {
    const { buildAlerts } = await import('../src/telemetry/dashboard.js')
    const msg = buildAlerts({ ...base, buyAttempts: 20, stranded: 1 })
      .find((a) => a.id === 'stranded')!.msg
    expect(msg).toContain('DEX')
  })

  it('ignores a rate built on too few attempts', async () => {
    // 1 of 5 is 20%, which would trip the warn bar if n were not checked first
    expect(await ids({ buyAttempts: 5, buyFails: 1 })).toEqual([])
  })

  it('quota is a bill forecast and says the reads stay on the key', async () => {
    // 2026-09-06 16:10 UTC: the warn line asserted "reads have fallen back" at 29.8M pace
    // with 1% of the month spent. The projection no longer routes anything.
    const { buildAlerts } = await import('../src/telemetry/dashboard.js')
    const quota = (over: Record<string, unknown>) =>
      buildAlerts({ ...base, ...over } as any).find((a) => a.id === 'quota')
    expect(quota({ cuPerMonth: 20e6 })).toBeUndefined()
    expect(quota({ cuPerMonth: 29e6 })!.sev).toBe('warn')
    expect(quota({ cuPerMonth: 29e6 })!.msg).toContain('reads stay on the key')
    expect(quota({ cuPerMonth: 29e6 })!.msg).not.toContain('have fallen back')
    expect(quota({ cuPerMonth: 31e6 })!.sev).toBe('crit')
    // degenerate inputs never throw and never alert
    expect(quota({ cuPerMonth: null })).toBeUndefined()
    expect(quota({ cuPerMonth: Number.NaN })).toBeUndefined()
  })

  it('warns past 10% and escalates past 25%', async () => {
    // 2.0% is the measured healthy baseline over 297 attempts, so 10% is already signal
    expect(await ids({ buyAttempts: 20, buyFails: 1 })).toEqual([])           // 5%
    expect(await ids({ buyAttempts: 20, buyFails: 3 })).toEqual(['buy:warn']) // 15%
    expect(await ids({ buyAttempts: 20, buyFails: 8 })).toEqual(['buy:crit']) // 40%, the real event
  })

  it('treats a single out-of-gas buy as critical regardless of rate', async () => {
    // one in twenty is 5%, under every rate bar, and still a config bug that retries cannot fix
    expect(await ids({ buyAttempts: 20, buyFails: 1, buyOutOfGas: 1 })).toEqual(['buy-oog:crit'])
  })

  it('warns on gas headroom BEFORE anything fails', async () => {
    // the alert that would have paid: buys climbed 99k -> 118k as the book widened, and
    // nothing said so until they reached the 150k ceiling and started reverting
    expect(await ids({ buyGasHeadroom: 118_040 / 150_000 })).toEqual(['buy-gas:warn'])
    expect(await ids({ buyGasHeadroom: 118_040 / 400_000 })).toEqual([]) // fine at the new limit
  })

  // ---- 2026-09-06: the plumbing that failed silently on 09-05 ----

  it('a forced nonce resync is worth a line even when the repair worked', async () => {
    // 13 buys went to a dead nonce over 25 minutes and nothing said so
    expect(await ids({ nonceResyncs1h: 0 })).toEqual([])
    expect(await ids({ nonceResyncs1h: 1 })).toEqual(['nonce:warn'])
    expect(await ids({ nonceResyncs1h: 3 })).toEqual(['nonce:crit'])
  })

  it('reports rate limiting by the hour, above the measured daytime baseline', async () => {
    // 183-612/h was normal on 09-05; the evening spiked to 1,619/h
    expect(await ids({ pollFailures1h: 600 })).toEqual([])
    expect(await ids({ pollFailures1h: 601 })).toEqual(['pollfail:warn'])
    expect(await ids({ pollFailures1h: 1001 })).toEqual(['pollfail:crit'])
  })

  it('separates a parked position (restart is the retry) from a stranded bag (booked and gone)', async () => {
    expect(await ids({ parked: 1 })).toEqual(['parked:crit'])
    expect(await ids({ stranded: 1 })).toEqual(['stranded:crit'])
    const { buildAlerts } = await import('../src/telemetry/dashboard.js')
    expect(buildAlerts({ ...base, stranded: 2 }).find((a) => a.id === 'stranded')!.msg).toContain('-stake')
    expect(buildAlerts({ ...base, parked: 1 }).find((a) => a.id === 'parked')!.msg).toContain('restart')
  })

  it('warns when launches are seen late, and only on enough of them', async () => {
    // the 08-27 loss was entry lag: the move is over by 5s, a launch seen at 7s is bought at the top
    // the price model against the chain (2026-09-06): 1.28 for an afternoon while take
    // profit fired on 2 of 46; 1.00 is right, and a handful of exits is not a verdict
    expect(await ids({ markErrP50: 1.28, markErrN: 12 })).toEqual(['model:crit'])
    expect(await ids({ markErrP50: 0.75, markErrN: 12 })).toEqual(['model:crit'])
    expect(await ids({ markErrP50: 1.10, markErrN: 12 })).toEqual(['model:warn'])
    expect(await ids({ markErrP50: 1.03, markErrN: 40 })).toEqual([])
    expect(await ids({ markErrP50: 1.28, markErrN: 5 })).toEqual([])
    expect(await ids({ markErrP50: NaN, markErrN: 50 })).toEqual([])
    expect(await ids({ detectLagP50: 3_500, detectLagN: 20 })).toEqual(['detectlag:warn'])
    expect(await ids({ detectLagP50: 3_500, detectLagN: 5 })).toEqual([])
    expect(await ids({ detectLagP50: 1_500, detectLagN: 200 })).toEqual([])
    expect(await ids({ detectLagP50: null, detectLagN: 0 })).toEqual([])
  })

  it('the venue sensor and the bot-broken check', async () => {
    // a fresh window that has lost money warns; nothing else about it alerts
    expect(await ids({ venueSum: -4.2, venueN: 40, venueFresh: true })).toEqual(['venue:warn'])
    expect(await ids({ venueSum: -0.5, venueN: 40, venueFresh: true })).toEqual([])
    // an unfresh window is not a measurement: a thin night must never page anyone
    expect(await ids({ venueSum: -9, venueN: 12, venueFresh: false })).toEqual([])
    // us against the venue: warn at two thirds of the limit, crit where it halts
    expect(await ids({ brokenGapPp: -16, brokenN: 20, brokenLimitPp: 15 })).toEqual(['broken:crit'])
    expect(await ids({ brokenGapPp: -11, brokenN: 20, brokenLimitPp: 15 })).toEqual(['broken:warn'])
    expect(await ids({ brokenGapPp: -5, brokenN: 20, brokenLimitPp: 15 })).toEqual([])
    // silent on a window that is not full, however bad the number looks
    expect(await ids({ brokenGapPp: -40, brokenN: 8, brokenLimitPp: 15 })).toEqual([])
  })

  it('never throws on a degenerate payload, and stays quiet on it', async () => {
    // the monitors rule: a monitor that crashes is worse than one that prints less
    const { buildAlerts } = await import('../src/telemetry/dashboard.js')
    const junk = { ...base, nonceResyncs1h: undefined, pollFailures1h: NaN, parked: undefined, bookDrift1h: NaN,
      detectLagP50: null, detectLagN: undefined,
      venueSum: NaN, venueN: undefined, venueFresh: undefined,
      brokenGapPp: NaN, brokenN: undefined, brokenLimitPp: undefined } as any
    expect(() => buildAlerts(junk)).not.toThrow()
    expect(buildAlerts(junk).map((a) => a.id)).toEqual([])
  })
})

/**
 * The /api/state body cache, added 2026-09-16 when that route moved off `json()` and onto the
 * serialize-and-gzip-once path /api/chart already used.
 *
 * None of this had any coverage before, because every existing test calls `snapshot()`
 * directly and never goes through the HTTP body. That is exactly where a stale body hides: a
 * control that clears the object memo but not the serialized bytes looks correct in every
 * unit test and tells the operator their STOP did nothing.
 */
describe('the response body cache', () => {
  let __caches: typeof import('../src/telemetry/dashboard.js')['__caches']
  beforeAll(async () => { __caches = (await import('../src/telemetry/dashboard.js')).__caches })
  beforeEach(() => __caches.clear())

  it('serializes once per TTL and gzips anything over a kilobyte', () => {
    let built = 0
    const big = { pad: 'x'.repeat(4000) }
    const make = () => { built++; return big }
    const a = __caches.cachedBody('k', 60_000, make)
    const b = __caches.cachedBody('k', 60_000, make)
    expect(built).toBe(1)
    expect(b).toBe(a)
    expect(a.gz).not.toBeNull()
    expect(a.gz!.length).toBeLessThan(a.raw.length)
  })

  it('leaves a small body uncompressed, because gzip costs more than it saves there', () => {
    const small = __caches.cachedBody('small', 60_000, () => ({ ok: true }))
    expect(small.raw.length).toBeLessThan(1024)
    expect(small.gz).toBeNull()
  })

  it('invalidateState drops the state body, so the next request re-serializes', () => {
    let built = 0
    const make = () => { built++; return { halted: built === 1 } }
    expect(JSON.parse(__caches.cachedBody('state', 60_000, make).raw.toString())).toEqual({ halted: true })
    __caches.invalidateState()
    // Without the drop this returns the pre-control body for the rest of the TTL.
    expect(JSON.parse(__caches.cachedBody('state', 60_000, make).raw.toString())).toEqual({ halted: false })
    expect(built).toBe(2)
  })

  it('evicts entries older than ten of their own TTLs, so the map cannot grow forever', () => {
    vi.useFakeTimers()
    try {
      __caches.cachedBody('old', 1_000, () => ({ a: 1 }))
      expect(__caches.size()).toBe(1)
      vi.advanceTimersByTime(10_001)
      // The sweep runs on a miss, which is the only moment the map can grow.
      __caches.cachedBody('new', 1_000, () => ({ b: 2 }))
      expect(__caches.size()).toBe(1)
    } finally { vi.useRealTimers() }
  })

  it('keeps an entry that is stale for serving but not yet old enough to evict', () => {
    vi.useFakeTimers()
    try {
      __caches.cachedBody('warm', 1_000, () => ({ a: 1 }))
      vi.advanceTimersByTime(2_000)
      __caches.cachedBody('other', 1_000, () => ({ b: 2 }))
      expect(__caches.size()).toBe(2)
    } finally { vi.useRealTimers() }
  })
})
