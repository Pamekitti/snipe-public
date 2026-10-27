import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../io/config-load.js'
import { Tape } from '../io/tape.js'
import { decide } from '../core/decide.js'
import { emptyState } from '../core/state.js'
import { buildGenesisEvents } from '../tools/genesis.js'
import { prove } from '../tools/replay-proof.js'
import type { Switches } from '../core/config.js'

const spec = loadConfig('config/strategy.toml', 1, null)
if (!spec.ok) throw new Error(spec.refusal.reason)

const SW: Switches = { sizeWei: 1n, mode: 'live', at: 0, by: 'test' }

function fixture(): { dir: string; bot: string; gate: string } {
  const dir = mkdtempSync(join(tmpdir(), 'snipe-genesis-'))
  const bot = join(dir, 'bot.db')
  const gate = join(dir, 'gate.db')
  const b = new Database(bot)
  b.exec(`
    CREATE TABLE launches (token TEXT, deployer TEXT, creator_tax_bps INTEGER, dev_buy_wei TEXT, exemptions INTEGER);
    CREATE TABLE positions (
      token TEXT, live INTEGER, closed INTEGER, buy_ok INTEGER,
      onchain_pnl_wei TEXT, pnl_wei TEXT, exit_reason TEXT, exit_at INTEGER
    );
  `)
  b.prepare(`INSERT INTO launches VALUES (?,?,?,?,?)`).run('0xabc', '0xdev', 0, '1000', 3)
  b.prepare(`INSERT INTO positions VALUES (?,?,?,?,?,?,?,?)`).run(
    '0xabc', 1, 1, 1, '5000000000000000', null, 'take-profit', 1_700_000_000_000,
  )
  b.close()
  const g = new Database(gate)
  g.exec(`CREATE TABLE obs (token TEXT, bars TEXT, launched_at INTEGER, peak REAL, at INTEGER, error TEXT);`)
  const now = Date.now()
  for (let i = 0; i < 20; i++) {
    g.prepare(`INSERT INTO obs VALUES (?,?,?,?,?,NULL)`).run(
      `0x${i.toString(16).padStart(40, '0')}`,
      JSON.stringify({ '1.25': 0, '1.36': -0.15, '1.75': -0.15 }),
      Math.floor(now / 1000) - i,
      1.1,
      now - i * 1_000,
    )
  }
  // Route those 20 tokens as untaxed so genesis can assign a book.
  const b2 = new Database(bot)
  for (let i = 0; i < 20; i++) {
    b2.prepare(`INSERT INTO launches VALUES (?,?,?,?,?)`).run(
      `0x${i.toString(16).padStart(40, '0')}`, '0xdev', 0, '1000', 3,
    )
  }
  b2.close()
  g.close()
  return { dir, bot, gate }
}

describe('genesis', () => {
  it('writes seed events a fold can turn into a venue halt', () => {
    const { dir, bot, gate } = fixture()
    try {
      const seeds = buildGenesisEvents({
        config: spec.value.values, digest: spec.value.digest, botDb: bot, gateDb: gate,
      }, 1_700_000_000_000)
      expect(seeds.entered).toBe(1)
      expect(seeds.outcomes).toBe(20)
      expect(seeds.firstBook).toBe('untaxed')
      expect(seeds.events[0]!.kind).toBe('config-applied')

      let state = emptyState(spec.value.values, SW)
      for (const e of seeds.events) state = decide(state, e).state
      expect(state.risk.everEntered.has('0xabc')).toBe(true)
      expect(state.risk.walletRealizedWei).toBe(5_000_000_000_000_000n)
      const v = state.sensors.venue.get('untaxed')
      // Genesis seeds 20 rows; the sensor reads the book's own window out of them, so this
      // follows the shipped spec rather than pinning a number that moves with policy.
      expect(v?.value.window).toBe(spec.value.values.books[0]!.guard.window)
      expect(v?.value.open).toBe(false)

      const tapePath = join(dir, 'tape.db')
      const tape = new Tape(tapePath)
      tape.append(seeds.events)
      tape.close()
      const again = new Tape(tapePath)
      expect(again.stats().rows).toBe(seeds.events.length)
      again.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('replay proof', () => {
  it('an empty tape diverges from nothing', () => {
    const p = prove([], emptyState(spec.value.values, SW), null)
    expect(p.events).toBe(0)
    expect(p.tapeDivergences).toEqual([])
    expect(p.liveBought).toBe(0)
  })

  it('counts bot.db buys the fold did not produce as live-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snipe-proof-'))
    const bot = join(dir, 'bot.db')
    try {
      const db = new Database(bot)
      db.exec(`CREATE TABLE positions (token TEXT, live INTEGER, buy_ok INTEGER);`)
      db.prepare(`INSERT INTO positions VALUES (?,?,?)`).run('0xabc', 1, 1)
      db.close()
      const p = prove([], emptyState(spec.value.values, SW), bot)
      expect(p.liveBought).toBe(1)
      expect(p.foldBought).toBe(0)
      expect(p.liveOnly).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
