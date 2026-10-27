/**
 * Changing a number must not need a restart, and must not move the rules under a bag that
 * is already held.
 *
 * These tests exist because of 2026-09-06: four numbers took twenty minutes, three restarts
 * of a live process, and a silent failure in which the bot reported the old trade size while
 * the restart claimed to have worked. Every case below is one of the ways that went wrong,
 * or one of the ways a fix for it could go wrong in turn.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The store resolves its path once at import, so the file has to exist first.
const dir = mkdtempSync(join(tmpdir(), 'cfg-'))
const ENV = join(dir, '.env')
const write = (body: string): void => writeFileSync(ENV, body)
write('TRADE_SIZE_ETH=0.005\nBANKROLL_ETH=0.02\nMAX_DRAWDOWN_ETH=0.04\n')
process.env.ENV_FILE = ENV
// set on the "command line", i.e. before the store captures the real environment
process.env.MODE = 'observe'

const store = await import('../src/config/store.js')
const { config, reloadConfig, configErrors, pendingRestartChanges, startConfigWatch } = store

const BASE = 'TRADE_SIZE_ETH=0.005\nBANKROLL_ETH=0.02\nMAX_DRAWDOWN_ETH=0.04\n'

describe('a number changes without a restart', () => {
  beforeEach(() => {
    write(BASE)
    reloadConfig()
  })
  afterEach(() => {
    write(BASE)
    reloadConfig()
  })

  it('reads the file at boot, not whatever the environment happens to hold', () => {
    expect(config().tradeSizeEth).toBe(0.005)
    expect(config().bankrollEth).toBe(0.02)
    expect(config().maxDrawdownEth).toBe(0.04)
  })

  it('applies an edit and reports exactly what moved', () => {
    write('TRADE_SIZE_ETH=0.01\nBANKROLL_ETH=0.04\nMAX_DRAWDOWN_ETH=0.08\n')
    const r = reloadConfig()
    expect(r.ok).toBe(true)
    expect(config().tradeSizeEth).toBe(0.01)
    expect(config().maxDrawdownEth).toBe(0.08)
    expect(r.applied.map((c) => `${c.env} ${c.from}->${c.to}`).sort()).toEqual([
      'BANKROLL_ETH 0.02->0.04',
      'MAX_DRAWDOWN_ETH 0.04->0.08',
      // The operator did not write this line and SHOULD still see it. The wallet stop is
      // derived as books x MAX_DRAWDOWN_ETH when it is unset, so moving the per-book stop
      // moves the wallet stop with it. A derived safety limit that changes silently is the
      // thing the applied diff exists to prevent.
      'MAX_WALLET_DRAWDOWN_ETH 0.04->0.08',
      'TRADE_SIZE_ETH 0.005->0.01',
    ])
  })

  it('THE 2026-09-06 REGRESSION: the file beats a stale process.env for a hot setting', () => {
    // pm2 saves the environment at `pm2 start` and replays it on every
    // `pm2 restart --update-env`; dotenv then refuses to override it. That is how an edited
    // .env lost to a pm2 copy of TRADE_SIZE_ETH with nothing reporting it. For a hot
    // setting the file has to win or "edit the file" is not a mechanism.
    process.env.TRADE_SIZE_ETH = '0.005'
    try {
      write('TRADE_SIZE_ETH=0.01\n')
      expect(reloadConfig().ok).toBe(true)
      expect(config().tradeSizeEth).toBe(0.01)
    } finally {
      delete process.env.TRADE_SIZE_ETH
    }
  })

  it('but the command line still beats the file for a restart-only setting', () => {
    // `MODE=observe DASH=0 DB_FILE=... pm2 start` is the documented way to run a second
    // watch-only instance beside the live one, and it has to keep working. MODE was set
    // above, before the store captured the environment, so it stands in for that.
    write(BASE + 'MODE=live\n')
    reloadConfig()
    const c = pendingRestartChanges().find((x) => x.env === 'MODE')
    expect(c, 'the file lost to the command line, so nothing is pending').toBeUndefined()
  })

  it('a restart-only key that only the FILE supplies is still seen when it changes', () => {
    // The trap this replaced: dotenv copies the file into process.env at boot, and reading
    // restart keys back out of process.env then shadows the file forever, so an edit to
    // GATE_LIVE could never be detected and simply vanished. Restart keys are read from the
    // environment as it was BEFORE dotenv touched it.
    write(BASE + 'GATE_LIVE=1\n')
    reloadConfig()
    write(BASE + 'GATE_LIVE=0\n')
    const r = reloadConfig()
    const c = r.pending.find((x) => x.env === 'GATE_LIVE')
    expect(c?.to, 'the change is visible and reported').toBe('0')
    expect(r.applied, 'and it is not applied').toEqual([])
  })

  it('a value out of range is refused WHOLE, and the previous numbers keep running', () => {
    // The old behaviour accepted it: canEnter then refused every launch for 'above size
    // ceiling' and the bot looked dead rather than misconfigured.
    write('TRADE_SIZE_ETH=0.1\nBANKROLL_ETH=0.04\n')
    const r = reloadConfig()
    expect(r.ok).toBe(false)
    expect(r.applied).toEqual([])
    expect(r.errors.join(' ')).toMatch(/TRADE_SIZE_ETH=0.1 is above the ceiling/)
    expect(config().tradeSizeEth, 'still the last good value').toBe(0.005)
    expect(config().bankrollEth, 'the VALID edit in the same file is not applied either').toBe(0.02)
    expect(configErrors()).toHaveLength(1)
  })

  it('a value that is not a number at all is refused, not coerced to NaN', () => {
    write('MAX_DRAWDOWN_ETH=eighty\n')
    expect(reloadConfig().ok).toBe(false)
    // NaN >= NaN is false, so a NaN limit silently DISABLES the kill switch
    expect(config().maxDrawdownEth).toBe(0.04)
  })

  it('a blank number falls back to the documented default rather than to zero', () => {
    // Number('') is 0, and a zero drawdown limit halts instantly
    write('MAX_DRAWDOWN_ETH=\n')
    expect(reloadConfig().ok).toBe(true)
    expect(config().maxDrawdownEth).toBe(0.06)
  })

  it('the entry window is gone from the hot config entirely', () => {
    // ENTRY_UTC_HOURS was the only kind:'window' field and the only per-trade one. It was
    // deleted on 2026-09-07 with the entry clock; what remains of the predicate is
    // WS_HOURS, which is restart-only because the socket it gates is built once.
    expect(config()).not.toHaveProperty('entryWindowUtc')
    write('ENTRY_UTC_HOURS=12-24\n')
    // an unknown key in the file is simply ignored, not an error: the bot must not refuse
    // to start because a stale line was left behind after a deletion
    expect(reloadConfig().ok).toBe(true)
  })

  it('refuses a pair that is individually fine and jointly useless', () => {
    // each of these has a failure mode that looks like a dead bot rather than a bad number
    write('TRADE_SIZE_ETH=0.01\nBANKROLL_ETH=0.005\n')
    expect(reloadConfig().errors.join(' ')).toMatch(/above BANKROLL_ETH/)

    // a stop under one stake fires on the first ordinary loss, so it is a stopped bot
    write('TRADE_SIZE_ETH=0.02\nBANKROLL_ETH=0.08\nMAX_DRAWDOWN_ETH=0.01\n')
    expect(reloadConfig().errors.join(' ')).toMatch(/below one TRADE_SIZE_ETH/)
  })

  it('a restart-only change is reported and never applied', () => {
    // GATE_LIVE and DB_FILE are absent from the environment here, so the file supplies them
    // and a change to either is a genuine pending restart.
    write(BASE + 'GATE_LIVE=0\nDB_FILE=data/other.db\n')
    const r = reloadConfig()
    expect(r.ok).toBe(true)
    expect(r.applied, 'nothing hot moved').toEqual([])
    expect(r.pending.map((c) => c.env)).toEqual(expect.arrayContaining(['DB_FILE', 'GATE_LIVE']))
    expect(r.pending.every((c) => c.scope === 'restart')).toBe(true)

    // and it clears itself when the file goes back to what the process booted with
    write(BASE)
    const back = reloadConfig()
    expect(back.pending.map((c) => c.env)).not.toContain('GATE_LIVE')
  })

  it('the env file it loads into process.env is the one ENV_FILE names', () => {
    // `import 'dotenv/config'` always reads `.env` and ignores ENV_FILE, so a second
    // instance pointed at its own file used to have its restart-only keys filled in from
    // the primary's file. The store loads its OWN path before anything else reads env.
    write(BASE + 'PONS_TERMINAL_URL=https://example.test/from-the-named-file\n')
    reloadConfig()
    const c = pendingRestartChanges().find((x) => x.env === 'PONS_TERMINAL_URL')
    expect(c?.to).toBe('https://example.test/from-the-named-file')
  })

  it('never prints the private key, even in a diff', () => {
    write(BASE + 'PRIVATE_KEY=0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n')
    const r = reloadConfig()
    const pk = r.pending.find((c) => c.env === 'PRIVATE_KEY')
    expect(pk?.to).toBe('(changed)')
    expect(JSON.stringify(r)).not.toContain('deadbeef')
  })

  it('a missing file is not an error; an unreadable one keeps the previous values', () => {
    rmSync(ENV)
    const r = reloadConfig()
    expect(r.ok, 'no file means defaults, which is how the laptop suite has always run').toBe(true)
    expect(config().tradeSizeEth).toBe(0.01) // the schema default
  })

  it('the snapshot is frozen, so nothing can move a value except a reload', () => {
    const c = config()
    expect(Object.isFrozen(c)).toBe(true)
    expect(() => { (c as { tradeSizeEth: number }).tradeSizeEth = 999 }).toThrow()
  })

  it('a reload swaps the snapshot rather than mutating it, so a captured one is stable', () => {
    const before = config()
    write('TRADE_SIZE_ETH=0.02\nBANKROLL_ETH=0.04\n')
    reloadConfig()
    expect(before.tradeSizeEth, 'the object a position captured is untouched').toBe(0.005)
    expect(config().tradeSizeEth).toBe(0.02)
  })

  it('the watcher notices a write on its own', async () => {
    const seen: string[] = []
    const stop = startConfigWatch((r) => { seen.push(...r.applied.map((c) => c.env)) }, { debounceMs: 5, pollMs: 20 })
    try {
      write('TRADE_SIZE_ETH=0.0075\nBANKROLL_ETH=0.02\n')
      const deadline = Date.now() + 3000
      while (Date.now() < deadline && !seen.includes('TRADE_SIZE_ETH')) {
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(seen, 'the file changed and nothing had to ask').toContain('TRADE_SIZE_ETH')
      expect(config().tradeSizeEth).toBe(0.0075)
    } finally {
      stop()
    }
  })
})

describe('an open position keeps the rules it opened under', () => {
  it('the clock, the hard stop and the bailout come off the position, not the globals', async () => {
    const { newPosition, evaluate } = await import('../src/strategy/exit.js')
    const pos = newPosition({
      id: 1, token: '0xt', curve: '0xc', tokens: 1000n, spendWei: 5_000_000_000_000_000n,
      entryMarkWei: 1000n, openedAt: 0, buyHash: '0xh', takeProfitMultiple: 2, filled: true,
      rules: { maxHoldMs: 45_000, hardStopMultiple: 0.5, deadCoinAfterMs: 20_000, deadCoinBelowMult: 1.03 },
    })
    // the rules travelled onto the position
    expect(pos.rules.maxHoldMs).toBe(45_000)

    // lift the peak clear of the dead-coin bar first, so this tests the clock and only it
    expect(evaluate(pos, 1100n, 1_000, false)).toBeNull()
    // a bag opened under a 45s clock is not sold at 30s because the clock later changed
    expect(evaluate(pos, 1100n, 30_000, false)).toBeNull()
    expect(evaluate(pos, 1100n, 45_000, false)).toBe('time')

    // and one opened under a 20s bailout keeps that too
    const flat = newPosition({
      id: 2, token: '0xt2', curve: '0xc2', tokens: 1000n, spendWei: 5_000_000_000_000_000n,
      entryMarkWei: 1000n, openedAt: 0, buyHash: '0xh', takeProfitMultiple: 2, filled: true,
      rules: { maxHoldMs: 45_000, hardStopMultiple: 0.5, deadCoinAfterMs: 20_000, deadCoinBelowMult: 1.03 },
    })
    expect(evaluate(flat, 1000n, 19_000, false)).toBeNull()
    expect(evaluate(flat, 1000n, 20_000, false)).toBe('dead')
  })

  it('the bailout can be switched OFF for a position without selling it instantly', () => {
    // afterMs 0 must short-circuit: `now - openedAt >= 0` is true on the first tick
    return import('../src/strategy/exit.js').then(({ newPosition, evaluate }) => {
      const pos = newPosition({
        id: 3, token: '0xt3', curve: '0xc3', tokens: 1000n, spendWei: 1n, entryMarkWei: 1000n,
        openedAt: 0, buyHash: '0xh', takeProfitMultiple: 2, filled: true,
        rules: { maxHoldMs: 45_000, hardStopMultiple: 0.5, deadCoinAfterMs: 0, deadCoinBelowMult: 1.03 },
      })
      expect(evaluate(pos, 1000n, 1, false)).toBeNull()
    })
  })
})

describe('a config change never puts money back to work', () => {
  it('raising the drawdown limit does not lift a drawdown halt', async () => {
    const { RiskManager } = await import('../src/strategy/risk.js')
    const r = new RiskManager(10n ** 18n)
    r.halt('drawdown $45 from peak', 'drawdown')
    expect(r.halted).toBe(true)

    // the store swapping MAX_DRAWDOWN_USD underneath changes no halt state: halts live in
    // memory on this object and only resume() or the day rollover touch them
    expect(r.isHalted('drawdown')).toBe(true)
    r.resume('drawdown')
    expect(r.halted, 'drawdown is not caller-liftable, whatever the limit now says').toBe(true)
  })

  it('the bankroll is read through on every check, so a change applies at once', async () => {
    const { RiskManager } = await import('../src/strategy/risk.js')
    let bankroll = 10n ** 16n // 0.01 ETH
    const r = new RiskManager(() => bankroll)
    const args = { token: '0xa', sizeWei: 8n * 10n ** 15n, logsHealthy: true, logsAgeMs: 0 }
    expect(r.canEnter(args).allow).toBe(true)
    r.reserve(args.token, args.sizeWei)
    expect(r.canEnter({ ...args, token: '0xb' }).allow, 'no room at 0.01').toBe(false)
    bankroll = 4n * 10n ** 16n // the operator raised BANKROLL_ETH
    expect(r.canEnter({ ...args, token: '0xb' }).allow, 'room now, with no restart').toBe(true)
  })
})

describe('the switches the 2026-09-07 policy added', () => {
  it('takes the kill switch in ETH, the same unit as the trade size', () => {
    // It was MAX_DRAWDOWN_USD until 2026-09-07, which coupled the stop to ETHUSD: a
    // configured 2145 against a real 2515 made a "$240" limit really $282. Divided by the
    // trade size this value IS the stake multiple, which is what the replays fit.
    write('TRADE_SIZE_ETH=0.02\nBANKROLL_ETH=0.08\nMAX_DRAWDOWN_ETH=0.112\n')
    expect(reloadConfig().ok).toBe(true)
    expect(config().maxDrawdownEth).toBe(0.112)
    expect(config().maxDrawdownEth / config().tradeSizeEth).toBeCloseTo(5.6, 5)
  })

  it('moving the ETH price cannot move the stop any more', () => {
    // the whole reason the price may be fetched hourly: it decides nothing
    write('TRADE_SIZE_ETH=0.02\nBANKROLL_ETH=0.08\nMAX_DRAWDOWN_ETH=0.112\nETHUSD=4000\n')
    expect(reloadConfig().ok).toBe(true)
    expect(config().maxDrawdownEth).toBe(0.112)
    expect(config().ethUsd).toBe(4000)
  })

  it('refuses a venue band with no gap, whole, keeping the running numbers', () => {
    // equal thresholds are not a narrow band, they are a sensor that flaps on every launch.
    //
    // The refused file asks for -3 and the running value is -4, and that difference is the
    // point: until 2026-09-07 the default was also -3, so this assertion passed whether the
    // reload kept the running number or silently fell back to the default. It can now only
    // pass for the right reason.
    write('VENUE_PAUSE_OFF=-3\nVENUE_PAUSE_ON=-3\n')
    const r = reloadConfig()
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('hysteresis')
    expect(config().venuePauseOff).toBe(-1)
    expect(config().venuePauseOn).toBe(1)
  })

  it('takes the whole policy as one edit', () => {
    write([
      'MAX_DRAWDOWN_ETH=0.112', 'TRADE_SIZE_ETH=0.02', 'BANKROLL_ETH=0.08',
      'VENUE_PAUSE_WINDOW=40', 'VENUE_PAUSE_OFF=-3', 'VENUE_PAUSE_ON=0.5', 'VENUE_FRESH_H=6',
      'DD_RESUME_WINDOW=20', 'DD_RESUME_ON=0', 'BROKEN_GAP_PP=15', '',
    ].join('\n'))
    expect(reloadConfig().ok).toBe(true)
    const c = config()
    expect(c.maxDrawdownEth).toBe(0.112)
    expect(c.venueFreshHours).toBe(6)
    expect(c.brokenGapPp).toBe(15)
  })
})

/**
 * THE TAX BAND, hot since 2026-09-15. It was a compiled-in 50 from 2026-08-28, so moving
 * the book's single load-bearing filter cost a deploy and a restart. A filter that expensive
 * to revert is one nobody reverts at 3am.
 */
describe('the creator-tax band', () => {
  beforeEach(() => { write(BASE); reloadConfig() })
  afterEach(() => { write(BASE); reloadConfig() })

  it('defaults to the band the bot ran before the keys existed', () => {
    expect(config().entryMinTaxBps).toBe(50)
    expect(config().entryMaxTaxBps).toBe(10000)
  })

  it('pins an untaxed-only book from the file, with no restart', () => {
    write(BASE + 'ENTRY_MIN_TAX_BPS=0\nENTRY_MAX_TAX_BPS=0\n')
    reloadConfig()
    expect(configErrors()).toEqual([])
    expect(config().entryMinTaxBps).toBe(0)
    expect(config().entryMaxTaxBps).toBe(0)
    expect(pendingRestartChanges()).toEqual([])
  })

  it('refuses an inverted band and keeps the previous one, because no launch could be admitted', () => {
    write(BASE + 'ENTRY_MIN_TAX_BPS=100\nENTRY_MAX_TAX_BPS=50\n')
    reloadConfig()
    expect(configErrors().join(' ')).toMatch(/ENTRY_MAX_TAX_BPS/)
    expect(config().entryMinTaxBps).toBe(50)
    expect(config().entryMaxTaxBps).toBe(10000)
  })

  it('accepts an equal band, which is how one exact tax is written', () => {
    write(BASE + 'ENTRY_MIN_TAX_BPS=100\nENTRY_MAX_TAX_BPS=100\n')
    reloadConfig()
    expect(configErrors()).toEqual([])
    expect(config().entryMinTaxBps).toBe(100)
  })
})

/**
 * BOOKS through the real config store: parsed from the file, resolved when absent, and
 * refused as a whole when wrong. The refusal matters most. reloadConfig applies a file or
 * rejects it entirely, so a bad BOOKS line must leave the PREVIOUS books running rather than
 * half-applying a new set, which on a live wallet would mean trading a band nobody chose.
 */
describe('BOOKS, through the config store', () => {
  it('resolves an absent BOOKS to one book built from the scalar band keys', () => {
    write('ENTRY_MIN_TAX_BPS=0\nENTRY_MAX_TAX_BPS=0\n')
    expect(reloadConfig().ok).toBe(true)
    expect(config().books).toEqual([{ id: 'main', minTaxBps: 0, maxTaxBps: 0 }])
  })

  it('parses a two-book line and derives the wallet stop as books x the per-book stop', () => {
    write('BOOKS=untaxed:0-0,taxed:50-10000\nMAX_DRAWDOWN_ETH=0.015\n')
    const r = reloadConfig()
    expect(r.ok).toBe(true)
    expect(config().books.map((b) => b.id)).toEqual(['untaxed', 'taxed'])
    expect(config().maxWalletDrawdownEth).toBeCloseTo(0.030, 10)
  })

  it('an explicit wallet stop wins over the derived one', () => {
    write('BOOKS=untaxed:0-0,taxed:50-10000\nMAX_DRAWDOWN_ETH=0.015\nMAX_WALLET_DRAWDOWN_ETH=0.020\n')
    expect(reloadConfig().ok).toBe(true)
    expect(config().maxWalletDrawdownEth).toBe(0.020)
  })

  it('REFUSES a bad BOOKS line whole, keeping the books that were already running', () => {
    write('BOOKS=untaxed:0-0,taxed:50-10000\nMAX_DRAWDOWN_ETH=0.015\n')
    expect(reloadConfig().ok).toBe(true)
    const before = config().books
    // overlapping bands: the one rule the rest of the design rests on
    write('BOOKS=low:0-100,high:50-10000\nMAX_DRAWDOWN_ETH=0.015\n')
    const bad = reloadConfig()
    expect(bad.ok).toBe(false)
    expect(bad.errors.join(' ')).toContain('overlaps')
    expect(config().books).toEqual(before)
  })

  it('refuses a malformed BOOKS line the same way, rather than trading a partial set', () => {
    write('BOOKS=untaxed:0-0,taxed:50-10000\n')
    expect(reloadConfig().ok).toBe(true)
    write('BOOKS=untaxed:0-0,broken\n')
    const bad = reloadConfig()
    expect(bad.ok).toBe(false)
    expect(config().books.map((b) => b.id)).toEqual(['untaxed', 'taxed'])
  })
})
