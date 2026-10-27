/**
 * The switches file, which is the only thing that can change what the bot stakes.
 *
 * These tests exist because the defect they pin was invisible and expensive: `run-live.sh`
 * used to export money keys before node started, and the loader skipped any key already
 * present, so the file and the process disagreed silently.
 */
import { describe, it, expect } from 'vitest'
import { ethToWei, modeFrom, parseEnvText, sizeFrom, switchesFrom } from '../io/env-file.js'
import { assertChain, chainId, venueNotes } from '../io/env.js'

const file = (text: string) => ({ path: 'test', found: true, vars: parseEnvText(text) })
const MAX = 5_000_000_000_000_000n // 0.005 ETH, the spec's ceiling in these tests

describe('reading the switches file', () => {
  it('reads mode and size exactly, and ignores HALT', () => {
    const s = switchesFrom(file('MODE=live\nHALT=1\nTRADE_SIZE_ETH=0.001\n'), MAX, 1)
    expect(s).toEqual({
      ok: true,
      ignoredHalt: true,
      value: { sizeWei: 1_000_000_000_000_000n, bookSizes: new Map(), mode: 'live', at: 1, by: 'boot' },
    })
  })

  it('ignores comments, blank lines and one layer of quotes', () => {
    const vars = parseEnvText('# a comment\n\nMODE="live"\n HALT = 1 \nNOTAPAIR\n')
    expect(vars.get('MODE')).toBe('live')
    expect(vars.get('HALT')).toBe('1')
    expect(vars.has('NOTAPAIR')).toBe(false)
  })

  it('refuses to invent a mode or a stake when there is no file', () => {
    const s = switchesFrom({ path: 'missing', found: false, vars: new Map() }, MAX, 7)
    expect(s.ok).toBe(false)
    if (!s.ok) expect(s.reason).toMatch(/no switches file/)
  })

  it('refuses MODE=observe and any unknown mode, never boots them as live', () => {
    expect(switchesFrom(file('MODE=LIVE\n'), MAX, 1)).toMatchObject({ ok: true, value: { mode: 'live' } })
    expect(switchesFrom(file('MODE=observe\n'), MAX, 1).ok).toBe(false)
    expect(switchesFrom(file('MODE=yes\n'), MAX, 1).ok).toBe(false)
    expect(switchesFrom(file(''), MAX, 1).ok).toBe(false)
  })

  it('clamps the stake to the spec ceiling instead of honouring it', () => {
    expect(sizeFrom(parseEnvText('TRADE_SIZE_ETH=1.0\n'), MAX)).toBe(MAX)
    expect(sizeFrom(parseEnvText('SIZE_WEI=999999999999999999\n'), MAX)).toBe(MAX)
  })

  it('prefers exact wei over the ETH figure when both are written down', () => {
    expect(sizeFrom(parseEnvText('SIZE_WEI=2000000000000000\nTRADE_SIZE_ETH=0.001\n'), MAX))
      .toBe(2_000_000_000_000_000n)
  })

  it('is zero, not a guess, when the stake will not parse', () => {
    expect(sizeFrom(parseEnvText('TRADE_SIZE_ETH=abc\n'), MAX)).toBe(0n)
    expect(sizeFrom(parseEnvText('TRADE_SIZE_ETH=-1\n'), MAX)).toBe(0n)
    expect(sizeFrom(new Map(), MAX)).toBe(0n)
  })
})

describe('ETH to wei', () => {
  it('is exact where float64 is not', () => {
    expect(ethToWei('0.001')).toBe(1_000_000_000_000_000n)
    expect(ethToWei('0.005')).toBe(5_000_000_000_000_000n)
    expect(ethToWei('1')).toBe(10n ** 18n)
    expect(ethToWei('0.123456789012345678')).toBe(123_456_789_012_345_678n)
  })

  it('agrees with itself where the float route drifts', () => {
    expect(ethToWei('0.0123')).toBe(12_300_000_000_000_000n)
  })

  it('refuses what it cannot read instead of rounding it to zero', () => {
    expect(ethToWei('')).toBeNull()
    expect(ethToWei('0x10')).toBeNull()
    expect(ethToWei('1e-3')).toBeNull()
  })
})

/**
 * The chain the signer signs for.
 *
 * v2 defaulted to 6343 from the day it was written. Nothing on the box sets `CHAIN_ID`, so the
 * default WAS the value, and on the first live evening the sequencer answered `invalid chain id
 * for signer: have 6343 want 4663` to every buy. The fold was right, the signer was right, and
 * no transaction could ever land. 4663 is `robinhoodChain.id` in `v1/src/config.ts` and what
 * `eth_chainId` returns.
 */
describe('the chain is asked, not assumed', () => {
  it('signs for 4663 when nothing says otherwise', () => {
    const had = process.env.CHAIN_ID
    delete process.env.CHAIN_ID
    try {
      expect(chainId()).toBe(4663)
    } finally {
      if (had !== undefined) process.env.CHAIN_ID = had
    }
  })

  it('starts when the chain agrees', async () => {
    await expect(assertChain(async () => chainId())).resolves.toBeUndefined()
  })

  it('refuses to start when the chain is a different one, and names both numbers', async () => {
    await expect(assertChain(async () => 6343)).rejects.toThrow(/6343/)
    await expect(assertChain(async () => 6343)).rejects.toThrow(String(chainId()))
  })
})

/**
 * v1 printed these at boot and v2 printed nothing, so both conditions were invisible until
 * somebody went looking for them in a bad hour. Warnings and not refusals, which is where v1 draws
 * the line too: a wrong chain id leaves no useful work to do, while these leave the bot trading
 * worse, and a process that exits cannot tell anyone why.
 */
describe('what is degraded about the venue is said out loud at boot', () => {
  const NOW = 1_800_000_000_000
  const fresh = Math.floor(NOW / 1000) - 2
  const ws = 'wss://provider.example/key'

  it('says nothing when the head is fresh and the socket is configured', () => {
    expect(venueNotes({ headTimestampS: fresh, nowMs: NOW, logsWs: ws })).toEqual([])
  })

  it('names a stale read endpoint with its age, because every read is then about a moved chain', () => {
    const notes = venueNotes({ headTimestampS: Math.floor(NOW / 1000) - 45, nowMs: NOW, logsWs: ws })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/45s stale/)
  })

  it('does not complain at 30s, which is v1`s threshold and not a strict one', () => {
    expect(venueNotes({ headTimestampS: Math.floor(NOW / 1000) - 30, nowMs: NOW, logsWs: ws })).toEqual([])
  })

  it('says the head could not be read, rather than treating unknown as fresh', () => {
    const notes = venueNotes({ headTimestampS: null, nowMs: NOW, logsWs: ws })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/could not read/)
  })

  it('names a missing socket, because http polling costs a large slice of a ~3s window', () => {
    const notes = venueNotes({ headTimestampS: fresh, nowMs: NOW, logsWs: '' })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/LOGS_WS_URL/)
  })

  it('reports both when both are wrong, rather than stopping at the first', () => {
    expect(venueNotes({ headTimestampS: Math.floor(NOW / 1000) - 600, nowMs: NOW, logsWs: '' })).toHaveLength(2)
  })

  it('never says a secret out loud: the socket url is only ever reported as absent', () => {
    const notes = venueNotes({ headTimestampS: fresh, nowMs: NOW, logsWs: '' })
    expect(notes.join(' ')).not.toContain('wss://')
  })
})

describe('the mode is never inferred', () => {
  it('reads only the switches file, so an inherited variable cannot make a process send', () => {
    expect(modeFrom(new Map([['MODE', 'live']]))).toBe('live')
    expect(modeFrom(new Map())).toBeNull()
    expect(modeFrom(new Map([['MODE', 'observe']]))).toBeNull()
  })
})
