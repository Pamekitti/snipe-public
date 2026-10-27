/**
 * src/telemetry/epoch.ts: one call moves BOTH drawdown stops to zero.
 *
 * 2026-08-27 and 2026-09-06: the session drawdown sat near the kill switch on money the
 * new rules could not lose again, and REBASELINE=1 (which only clears the chain side) had
 * to be paired with a hand-written epoch_base_id. This pins that the script moves the
 * epoch to MAX(id), leaves an audit row, clears the four chain keys, refuses while a
 * position is open, and that the rebuilt ledger really reads zero afterwards.
 *
 * It moved out of scripts/newepoch.cjs into src/ on 2026-09-07, when the drawdown stop
 * started lifting itself: the reset IS the lift, so the bot needs the same transaction the
 * hand tool runs. scripts/newepoch.ts is now the command line over this module.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { rebuildRealized } from '../src/telemetry/truth.js'
import { newEpoch, CHAIN_KEYS } from '../src/telemetry/epoch.js'

const SCHEMA = `
CREATE TABLE positions (
  id INTEGER PRIMARY KEY, token TEXT, live INTEGER, closed INTEGER DEFAULT 0,
  pnl_wei TEXT, onchain_pnl_wei TEXT, exit_at INTEGER, burned_gas_wei TEXT, t_detect INTEGER
);
CREATE TABLE chain_truth (key TEXT PRIMARY KEY, value TEXT);
`

function db(rows: Array<{ pnl: string; closed?: number; onchain?: string | null }>) {
  const d = new Database(':memory:')
  d.exec(SCHEMA)
  const ins = d.prepare('INSERT INTO positions (token, live, closed, pnl_wei, onchain_pnl_wei, exit_at) VALUES (?,1,?,?,?,?)')
  rows.forEach((r, i) => ins.run(`0x${i}`, r.closed ?? 1, r.pnl, r.onchain ?? null, 1_000 + i))
  const set = d.prepare('INSERT OR REPLACE INTO chain_truth (key,value) VALUES (?,?)')
  set.run('epoch_base_id', '1')
  set.run('baseline_wei', '100'); set.run('baseline_block', '7'); set.run('baseline_at', '5'); set.run('peak_flat_wei', '150')
  set.run('stranded_bags', '[{"id":1}]')
  return d
}
const get = (d: Database.Database, k: string) => (d.prepare('SELECT value FROM chain_truth WHERE key=?').get(k) as any)?.value ?? null

describe('newepoch', () => {
  it('moves the epoch to MAX(id), records what the old epoch booked, and clears the chain keys', () => {
    // rows 2..4 are in the old epoch (base 1): +10, +30, -25 -> realized 15, peak 40
    const d = db([{ pnl: '999' }, { pnl: '10' }, { pnl: '30', onchain: '30' }, { pnl: '-25' }])
    const r = newEpoch(d, 'test reset', 1_700_000_000_000)
    expect(r).toMatchObject({ was: 1, now: 4 })
    expect(get(d, 'epoch_base_id')).toBe('4')
    const prev = JSON.parse(get(d, 'epoch_base_prev')!)
    expect(prev).toMatchObject({ was: 1, now: 4, why: 'test reset', realized_wei: '15', peak_wei: '40' })
    expect(prev.chain).toEqual({ baseline_wei: '100', baseline_block: '7', baseline_at: '5', peak_flat_wei: '150' })
    for (const k of CHAIN_KEYS) expect(get(d, k)).toBeNull()
    expect(get(d, 'epoch_note')).toContain('epoch 4 opened 2023-11-14')
    // the ledger the bot rebuilds at boot now reads zero: no drawdown, no peak
    expect(rebuildRealized(d, 4)).toEqual({ realized: 0n, peak: 0n })
    // what the wallet holds is not accounting; it survives
    expect(get(d, 'stranded_bags')).toBe('[{"id":1}]')
  })

  it('refuses while a position is open, and changes nothing', () => {
    const d = db([{ pnl: '10' }, { pnl: '0', closed: 0 }])
    expect(() => newEpoch(d, 'x')).toThrow('1 open position(s)')
    expect(get(d, 'epoch_base_id')).toBe('1')
    expect(get(d, 'peak_flat_wei')).toBe('150')
  })

  it('refuses without a reason', () => {
    const d = db([{ pnl: '10' }])
    expect(() => newEpoch(d, '   ')).toThrow('a reason is required')
    expect(get(d, 'epoch_base_id')).toBe('1')
  })
})
