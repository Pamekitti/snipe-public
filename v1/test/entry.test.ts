/**
 * strategy/entry.ts: the one decision point for every trading filter, as a pure function.
 *
 * Numbers behind each rule are in config.ts next to the value. What this file pins is the
 * SHAPE: whether a launch is taken, at what size, and with which reject bucket.
 *
 * There were two books until 2026-09-07: a `probe` cohort traded candidate filters at a
 * tenth the size under its own cap. It is deleted, and its cases with it.
 */
import { describe, it, expect } from 'vitest'
import { pickEntry, liveEntryConfig, type EntryConfig } from '../src/strategy/entry.js'
import { inEntryWindow, utcHour } from '../src/strategy/launch.js'
import { parseEntryWindow, STRATEGY } from '../src/config.js'

const cfg: EntryConfig = {
  minCreatorTaxBps: 50, maxCreatorTaxBps: 10000,
  minExemptionsToEnter: 3,
  tradeSizeEth: 0.005,
  templateLossBlockMs: 3_600_000,
}
/** a chain timestamp at the given UTC hour on 2026-09-06 */
const at = (h: number, m = 0): bigint => BigInt(Math.floor(Date.UTC(2026, 8, 6, h, m) / 1000))
const main = { creatorTaxBps: 100n, exemptions: 5 }
const bucket = (p: ReturnType<typeof pickEntry>) => ('reject' in p ? p.reject.split(' ')[0] : 'entered')

describe('pickEntry, the main book', () => {
  it('enters a taxed, bundled, daytime launch at the main size', () => {
    expect(pickEntry(main, cfg)).toEqual({ sizeWei: 5_000_000_000_000_000n })
  })

  it('declines below the creator-tax floor, bucket `tax`', () => {
    const p = pickEntry({ ...main, creatorTaxBps: 0n }, cfg)
    expect(p).toEqual({ reject: 'tax 0bps' })
    expect(bucket(p)).toBe('tax')
  })

  it('declines below the exempt-wallet floor, bucket `exempt`, and treats missing calldata as zero', () => {
    expect(pickEntry({ ...main, exemptions: 2 }, cfg)).toEqual({ reject: 'exempt 2' })
    expect(pickEntry({ ...main, exemptions: null }, cfg)).toEqual({ reject: 'exempt 0' })
    expect(pickEntry({ ...main, exemptions: 3 }, cfg)).toMatchObject({ sizeWei: 5_000_000_000_000_000n })
  })



  it('names the FIRST failing filter, in adoption order: tax, then exempt', () => {
    expect(bucket(pickEntry({ ...main, creatorTaxBps: 0n, exemptions: 1 }, cfg))).toBe('tax')
    expect(bucket(pickEntry({ ...main, exemptions: 1 }, cfg))).toBe('exempt')
  })
})

describe('the entry window helpers', () => {
  it('inEntryWindow handles a window that wraps midnight', () => {
    const w = { from: 22, to: 4 }
    expect(inEntryWindow(at(23), w)).toBe(true)
    expect(inEntryWindow(at(3), w)).toBe(true)
    expect(inEntryWindow(at(4), w)).toBe(false)
    expect(inEntryWindow(at(12), w)).toBe(false)
    expect(utcHour(at(23, 59))).toBe(23)
  })

  it('parseEntryWindow: blank or nonsense is OFF, not a silently wrong window', () => {
    expect(parseEntryWindow('12-21')).toEqual({ from: 12, to: 21 })
    expect(parseEntryWindow(' 22 - 4 ')).toEqual({ from: 22, to: 4 })
    expect(parseEntryWindow('')).toBeNull()
    expect(parseEntryWindow(undefined)).toBeNull()
    expect(parseEntryWindow('noon-nine')).toBeNull()
    expect(parseEntryWindow('25-3')).toBeNull()
    expect(parseEntryWindow('5-5')).toBeNull()
  })
})

describe('the live configuration', () => {
  it('liveEntryConfig reads STRATEGY, and the shipped values are the measured ones', () => {
    const live = liveEntryConfig()
    expect(live.minCreatorTaxBps).toBe(STRATEGY.minCreatorTaxBps)
    expect(live.minExemptionsToEnter).toBe(3)
    // No window here any more: the entry clock was deleted on 2026-09-07 and the bot
    // trades 24 hours. The window HELPERS survive, because the provider socket still runs
    // on hours of its own (config.ts wsHours), and those are still tested below.
    expect(live).not.toHaveProperty('entryWindowUtc')
  })
})

describe('pickEntry, the template loss block (2026-09-06)', () => {
  it('refuses a template for an hour after a real loss on it, names the age, and forgets it after', () => {
    expect(pickEntry({ ...main, templateLossAgeMs: 7 * 60_000 }, cfg)).toEqual({ reject: 'template-loss 7m ago' })
    expect(bucket(pickEntry({ ...main, templateLossAgeMs: 0 }, cfg))).toBe('template-loss')
    expect(pickEntry({ ...main, templateLossAgeMs: 3_600_000 }, cfg)).toMatchObject({ sizeWei: 5_000_000_000_000_000n })
    expect(pickEntry({ ...main, templateLossAgeMs: null }, cfg)).toMatchObject({ sizeWei: 5_000_000_000_000_000n })
    expect(pickEntry(main, cfg)).toMatchObject({ sizeWei: 5_000_000_000_000_000n })
  })
  it('the basic filters still name the reject first', () => {
    expect(pickEntry({ ...main, creatorTaxBps: 0n, templateLossAgeMs: 1000 }, cfg)).toMatchObject({ reject: 'tax 0bps' })
  })
  it('templateKey: tax, exact dev buy, exempt count; never the deployer', async () => {
    const { templateKey } = await import('../src/strategy/entry.js')
    expect(templateKey(200n, 60_000_000_000_000_000n, 6)).toBe('200:60000000000000000:6')
    expect(templateKey(200n, 60_000_000_000_000_000n, null)).toBe('200:60000000000000000:')
    expect(templateKey(200n, 60_000_000_000_000_000n, 20)).not.toBe(templateKey(200n, 60_000_000_000_000_000n, 6))
  })
})

/**
 * THE TAX BAND, both ends inclusive, added 2026-09-15 with ENTRY_MIN_TAX_BPS and
 * ENTRY_MAX_TAX_BPS. The floor alone could not express "untaxed only": a floor of 0 admits
 * every band from 0 to 200, which is the opposite policy from the one the daily edge check
 * flagged (7d replay/trade: taxed -2.0% on n=4,918 against untaxed +5.1% on n=7,602).
 */
describe('the creator-tax band', () => {
  const untaxedOnly: EntryConfig = { ...cfg, minCreatorTaxBps: 0, maxCreatorTaxBps: 0 }

  it('admits an untaxed launch and refuses every taxed one when the band is 0/0', () => {
    expect(pickEntry({ creatorTaxBps: 0n, exemptions: 5 }, untaxedOnly)).toEqual({ sizeWei: 5_000_000_000_000_000n })
    expect(bucket(pickEntry({ creatorTaxBps: 1n, exemptions: 5 }, untaxedOnly))).toBe('tax')
    expect(bucket(pickEntry({ creatorTaxBps: 100n, exemptions: 5 }, untaxedOnly))).toBe('tax')
  })

  it('still refuses a failed tax read, which arrives as -1 and is not the same as untaxed', () => {
    expect(bucket(pickEntry({ creatorTaxBps: -1n, exemptions: 5 }, untaxedOnly))).toBe('tax')
  })

  it('keeps the exempt floor above the band, so an untaxed unbundled launch is still refused', () => {
    expect(bucket(pickEntry({ creatorTaxBps: 0n, exemptions: 1 }, untaxedOnly))).toBe('exempt')
  })

  it('names one funnel bucket for both ends, because the operator counts the band not the side', () => {
    expect(bucket(pickEntry({ creatorTaxBps: 10n, exemptions: 5 }, cfg))).toBe('tax')
    expect(bucket(pickEntry({ creatorTaxBps: 10n, exemptions: 5 }, { ...cfg, minCreatorTaxBps: 0, maxCreatorTaxBps: 5 }))).toBe('tax')
  })

  it('treats a stored config with no ceiling as unbounded rather than throwing', () => {
    // Every ShadowIntent.config.entry and capture payload written before 2026-09-15 has no
    // maxCreatorTaxBps, and shadow-account.admission() replays those rows on every tick.
    // BigInt(undefined) would throw and mark the job unavailable.
    const historical = { minCreatorTaxBps: 50, minExemptionsToEnter: 3, tradeSizeEth: 0.005, templateLossBlockMs: 3_600_000 } as unknown as EntryConfig
    expect(pickEntry({ creatorTaxBps: 100n, exemptions: 5 }, historical)).toEqual({ sizeWei: 5_000_000_000_000_000n })
    expect(pickEntry({ creatorTaxBps: 9_999n, exemptions: 5 }, historical)).toEqual({ sizeWei: 5_000_000_000_000_000n })
  })

  it('reads both ends live, so the band moves without a restart', () => {
    expect(liveEntryConfig().minCreatorTaxBps).toBe(STRATEGY.minCreatorTaxBps)
    expect(liveEntryConfig().maxCreatorTaxBps).toBe(STRATEGY.maxEntryTaxBps)
  })
})
