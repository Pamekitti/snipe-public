/**
 * The template gate: a per-dev-buy-value regime gate.
 *
 * The farms that ate 2026-08-19 stamp identical launches from fresh deployer wallets,
 * and the exact dev-buy wei value is the one legible signature (0.0890 x40/day from 33
 * deployers; we went 3/22 on it for -$20.53). Value-shape rules do NOT work -- round
 * values are organic human choices too, and blocking by frequency removed +$15.71 of
 * 08-18 winners -- so the gate is OUTCOME-based: gatewatch scores every passed launch's
 * 45s peak already; a value whose trailing-24h scored obs are >= minObs with touch under
 * shutBelowPct is blocked until its own results lift it. See STRATEGY.book.templateGate.
 *
 * Direction of unknowns is the opposite of the take-profit schedule's, on purpose:
 * UNKNOWN MEANS ALLOWED, because a value with no history is every organic launch ever.
 * The one exception is the seed, which is blocked before any scoring.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { screenCurve, type LaunchMeta } from '../src/strategy/launch.js'
import { RegimeGate } from '../src/strategy/gate.js'
import { STRATEGY } from '../src/config.js'
import { makeGateDb } from './helpers/gatedb.js'

const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

const meta: LaunchMeta = {
  name: 'T', symbol: 'T', logo: '', hasTwitter: false, hasWebsite: false, hasTelegram: false,
  descriptionLen: 0, exemptions: 3, buybackEnabled: false, quoteInWei: 0n,
}
const args = (over: Partial<Parameters<typeof screenCurve>[0]> = {}) => ({
  creatorTaxBps: 0n, devBuyWei: 89_000_000_000_000_000n, meta, priorLaunches: 0,
  requireDevBuy: true, ...over,
})

describe('screenCurve and the blocklist', () => {
  it('rejects a blocked dev value, bucketed under "template"', () => {
    const v = screenCurve(args({ blockedDev: new Set(['89000000000000000']) }))
    expect(v.pass).toBe(false)
    expect(v.reason).toMatch(/^template /)
  })

  it('matches EXACT wei values only: a neighbouring value passes', () => {
    const v = screenCurve(args({
      devBuyWei: 89_000_000_000_000_001n,
      blockedDev: new Set(['89000000000000000']),
    }))
    expect(v.pass).toBe(true)
  })

  it('unknown means allowed: no blocklist screens like an empty one', () => {
    expect(screenCurve(args()).pass).toBe(true)
    expect(screenCurve(args({ blockedDev: new Set() })).pass).toBe(true)
  })

  it('stays out of observe-everything mode, like the rest of the book', () => {
    const v = screenCurve(args({
      requireDevBuy: false, blockedDev: new Set(['89000000000000000']),
    }))
    expect(v.pass).toBe(true)
  })
})

describe('the seed', () => {
  it('carries the 0.089 farm, which cost -$22.88 the day it was found', () => {
    expect(STRATEGY.book.templateGate.seed).toContain('89000000000000000')
  })

  it('the bot merges the seed over whatever gatewatch publishes, so a fresh or empty file never unblocks it', () => {
    const bot = src('../src/bot.ts')
    expect(bot).toMatch(/templateGate\.seed/)
    // screening reads an already-populated Set, it does not go and fetch one
    expect(bot).toMatch(/blockedDev:\s*this\.templateBlocked\b/)
  })

  it('refreshes the list OFF the entry path, not inside screening', () => {
    // This was a lazily-refreshed getter called inline by screenCurve, so once every 30s a
    // launch paid for a synchronous better-sqlite3 read of gate.db (written by a separate
    // process under WAL) in the middle of a ~2s entry budget the surrounding code works to
    // shave 100-300ms off. The cost was small on average and landed entirely on one unlucky
    // launch, which is the worst way to distribute it.
    const bot = src('../src/bot.ts')
    expect(bot).toMatch(/private refreshTemplateBlocklist\(\): void/)
    // called from housekeeping, and once at boot so a restart does not screen against the
    // bare seed for its first 30 seconds
    const house = bot.slice(bot.indexOf('private async housekeeping'))
    expect(house).toMatch(/this\.refreshTemplateBlocklist\(\)/)
    expect(bot).not.toMatch(/blockedDev:\s*this\.refreshTemplateBlocklist/)
  })
})

describe('RegimeGate.templateBlock', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  const fileWith = (value: string | null): string => {
    const dir = mkdtempSync(join(tmpdir(), 'tmplgate-'))
    dirs.push(dir)
    const file = join(dir, 'gate.db')
    const g = makeGateDb(file)
    if (value !== null) g.state('template_block', value)
    g.close()
    return file
  }

  it('reads what gatewatch published', () => {
    const g = new RegimeGate(fileWith(JSON.stringify({ at: 5, values: ['89000000000000000', '420000000000000000'] })))
    expect(g.templateBlock()).toEqual({ at: 5, values: ['89000000000000000', '420000000000000000'] })
  })

  it('has no opinion on a missing db, a missing row, or a garbled one', () => {
    expect(new RegimeGate('/nonexistent/gate.db').templateBlock()).toBeNull()
    expect(new RegimeGate(fileWith(null)).templateBlock()).toBeNull()
    expect(new RegimeGate(fileWith('not json')).templateBlock()).toBeNull()
    expect(new RegimeGate(fileWith(JSON.stringify({ at: 5 }))).templateBlock()).toBeNull()
  })

  it('drops non-string entries rather than passing them to a Set of wei strings', () => {
    const g = new RegimeGate(fileWith(JSON.stringify({ at: 5, values: ['1', 2, null] })))
    expect(g.templateBlock()).toEqual({ at: 5, values: ['1'] })
  })
})

describe('gatewatch owns the scoring and reads its thresholds from the bot', () => {
  it('the bot publishes the thresholds under their own keys', () => {
    const bot = src('../src/bot.ts')
    expect(bot).toMatch(/templateWindowMs:\s*STRATEGY\.book\.templateGate\.windowMs/)
    expect(bot).toMatch(/templateMinObs:\s*STRATEGY\.book\.templateGate\.minObs/)
    expect(bot).toMatch(/templateShutBelowPct:\s*STRATEGY\.book\.templateGate\.shutBelowPct/)
  })

  it('gatewatch reads those keys and publishes into gate.db state', () => {
    const gw = src('../scripts/gatewatch.py')
    expect(gw).toMatch(/spec\.get\("templateMinObs"/)
    expect(gw).toMatch(/spec\.get\("templateShutBelowPct"/)
    expect(gw).toMatch(/spec\.get\("templateWindowMs"/)
    expect(gw).toMatch(/'template_block'/)
  })
})
