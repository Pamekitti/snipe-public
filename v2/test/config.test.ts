/**
 * The spec's rules, and the two structural guarantees that make them worth having.
 *
 * Every refusal case below is a value that would have looked fine and been wrong. The old
 * config layer had the right instinct (refuse, never clamp) and the wrong coverage: the
 * checks that existed were good, and the ones that mattered most were comments.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseToml } from 'smol-toml'
import { describe, expect, it } from 'vitest'
import {
  READERS, SPEC, checkSize, effectiveBookDrawdownWei, effectiveWalletDrawdownWei, validate,
  type FrozenConfig, type Switches,
} from '../core/config.js'
import { bootApply, diffConfig, loadConfig } from '../io/config-load.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SPEC_PATH = join(ROOT, 'config/strategy.toml')
const AT = 1_700_000_000_000

const raw = () => parseToml(readFileSync(SPEC_PATH, 'utf8')) as Record<string, unknown>

/** Deep clone so a mutation in one case cannot leak into the next. */
const withSpec = (mutate: (r: any) => void) => { const r = JSON.parse(JSON.stringify(raw())); mutate(r); return r }

const refusal = (r: ReturnType<typeof validate>) => (r.ok ? null : r.refusal)

describe('the shipped spec', () => {
  it('loads, and matches what the live bot is configured with', () => {
    const loaded = loadConfig(SPEC_PATH, AT, null)
    expect(refusal(loaded as any)).toBeNull()
    if (!loaded.ok) return
    const c = loaded.value.values
    // These are the values read off the running box on 2026-09-16, not defaults. If the box
    // moves, this test is the thing that says the spec drifted from reality.
    // TWO books since 2026-09-16: `untaxed` is the one that trades and `taxed` is the
    // measurement arm, declared and unfunded. Their bands must not touch.
    expect(c.books).toHaveLength(2)
    expect(c.books.map((b) => b.id)).toEqual(['untaxed', 'taxed'])
    expect(c.books[0]!.minCreatorTaxBps).toBe(0)
    expect(c.books[0]!.maxCreatorTaxBps).toBe(0)
    expect(c.books[0]!.minExemptions).toBe(3)
    // 50, not 1: the measurement arm is the band that actually ran from 2026-08-28 to
    // 2026-09-15, so that it is a control for the policy rather than a wider one. 1-49 bps
    // therefore routes to no book, on purpose.
    expect(c.books[1]!.minCreatorTaxBps).toBe(50)
    expect(c.books[1]!.maxCreatorTaxBps).toBe(200)
    // the wallet stop covers the SUM of the two books' own stops
    const sum = c.books.reduce((a, b) => a + BigInt(b.maxDrawdownWei), 0n)
    expect(BigInt(c.risk.maxWalletDrawdownWei)).toBe(sum)
    // Both books are funded at 0.01. The size switch can only reduce this.
    expect(c.books[0]!.sizeWei).toBe('10000000000000000')
    expect(c.books[1]!.sizeWei).toBe('10000000000000000')
    // Code-only deploys deliberately keep the box's live strategy file. Version 2 is the
    // current fixed-size policy; version 3 adds the optional adaptive-sizing table.
    expect([2, 3]).toContain(c.specVersion)
    expect(c.simulation).toEqual({
      model: 'trade-huber-pooled-20260919',
      positiveFactor: 0.8844571237124664,
      negativeFactor: 0.9906639095130271,
    })
    expect(c.risk.drawdownStakes).toBe(2)
    // Every book carries a complete policy, resolved from [defaults] at load, so no read site
    // ever holds a book with a default still to apply.
    const untaxed = c.books[0]!
    const taxed = c.books[1]!
    expect(untaxed.entry.entryDelayMs).toBe(2_000)
    expect(untaxed.exit.maxHoldMs).toBe(45_000)
    expect(untaxed.exit.graduationExitAt).toBe(0.12)
    // The Sep 1-19 adaptive search selected a 30s dead exit and a capped, weighted four-rung
    // selector for untaxed. The same resolved selector feeds entries and its indicator.
    expect(untaxed.exit.hardStopMultiple).toBe(0.5)
    expect(untaxed.exit.deadCoinAfterMs).toBe(30_000)
    expect(untaxed.takeProfit.otherwise).toBe(1.75)
    expect(untaxed.takeProfit.adaptiveWindow).toBe(20)
    expect(untaxed.takeProfit.adaptiveHalfLife).toBe(10)
    expect(untaxed.takeProfit.adaptiveLossCap).toBe(0.5)
    expect(untaxed.takeProfit.adaptiveProfitCap).toBe(0.5)
    expect(untaxed.takeProfit.adaptiveBars).toEqual([1.25, 1.36, 1.5, 1.75])
    expect(untaxed.guard.pnlBar).toBe(1.75)
    if (c.specVersion >= 3) {
      expect(untaxed.sizing).toMatchObject({
        enabled: true, referenceSizeWei: '5000000000000000', window: 15,
        recentWindow: 8, confirmations: 2, clipStakes: 0.5,
        strongThreshold: 0.1, weakBps: 5000, strongBps: 12500,
        maxBaseSizeWei: '2500000000000000', freshMs: 10_800_000,
      })
    } else {
      expect(untaxed.sizing).toBeUndefined()
    }
    // Taxed retains the shared 0.5 stop, 20s dead exit and adaptive seven-rung TP policy.
    expect(taxed.exit.hardStopMultiple).toBe(0.5)
    expect(taxed.exit.deadCoinAfterMs).toBe(20_000)
    expect(taxed.takeProfit.otherwise).toBe(1.75)
    expect(taxed.takeProfit.adaptiveHalfLife).toBe(0)
    expect(taxed.takeProfit.adaptiveLossCap).toBe(0)
    expect(taxed.takeProfit.adaptiveProfitCap).toBe(0)
    expect(taxed.takeProfit.adaptiveBars).toEqual([1.25, 1.36, 1.5, 1.75, 2, 2.5, 3])
    expect(taxed.guard.pnlBar).toBe(1.75)
    if (c.specVersion >= 3) {
      expect(taxed.sizing).toMatchObject({ window: 30, confirmations: 3, strongThreshold: 0.05 })
    } else {
      expect(taxed.sizing).toBeUndefined()
    }
    // The guard is in STAKES since the indicator became the simulator on 2026-09-16. These
    // are the September 15 selected rule `n15-m8-b-1.5-r1-h2-fresh`: the main 15 must sum
    // below -1.5 to pause, and the freshest 8 above +1 to reopen. Changing them is a policy
    // decision, not drift, and this test is the place that decision has to be made twice.
    expect(untaxed.guard.shutAt).toBe(-1.5)
    expect(untaxed.guard.openAt).toBe(1)
    expect(untaxed.guard.window).toBe(15)
    expect(untaxed.guard.recoveryWindow).toBe(8)
    expect(untaxed.guard.freshMs).toBe(3 * 3_600_000)
    expect(taxed.guard.shutAt).toBe(untaxed.guard.shutAt)
    expect(taxed.guard.openAt).toBe(untaxed.guard.openAt)
    expect(taxed.guard.window).toBe(untaxed.guard.window)
    expect(taxed.guard.recoveryWindow).toBe(untaxed.guard.recoveryWindow)
    expect(taxed.guard.freshMs).toBe(untaxed.guard.freshMs)
    expect(c.risk.maxConcurrent).toBe(0)
    // Zero is no cap. Leftover reserved or deployedWei must not sit out open coins.
    expect(c.risk.bankrollWei).toBe('0')
    // The declared stop remains 0.01 × 2, while the live pilot stop follows its 0.0025 base.
    expect(untaxed.maxDrawdownWei).toBe('20000000000000000')
    expect(taxed.maxDrawdownWei).toBe('20000000000000000')
    const liveSize = 5_000_000_000_000_000n
    const defaultBookStop = c.specVersion >= 3 ? 5_000_000_000_000_000n : 10_000_000_000_000_000n
    expect(effectiveBookDrawdownWei(c, untaxed, liveSize)).toBe(defaultBookStop)
    expect(effectiveBookDrawdownWei(c, taxed, liveSize)).toBe(defaultBookStop)
    expect(effectiveWalletDrawdownWei(c, liveSize)).toBe(defaultBookStop * 2n)
    const switches: Switches = {
      sizeWei: liveSize,
      bookSizes: new Map([['untaxed', { sizeWei: 1_000_000_000_000_000n, at: AT, by: 'dashboard' }]]),
      mode: 'live', at: AT, by: 'file',
    }
    expect(effectiveBookDrawdownWei(c, untaxed, switches)).toBe(2_000_000_000_000_000n)
    expect(effectiveBookDrawdownWei(c, taxed, switches)).toBe(defaultBookStop)
    expect(effectiveWalletDrawdownWei(c, switches)).toBe(2_000_000_000_000_000n + defaultBookStop)
  })

  it('digests the bytes, so key order cannot change identity', () => {
    const a = loadConfig(SPEC_PATH, AT, null)
    const b = loadConfig(SPEC_PATH, AT, null)
    expect(a.ok && b.ok && a.value.digest).toBe(b.ok ? b.value.digest : 'mismatch')
    expect(a.ok && a.value.digest).toMatch(/^[0-9a-f]{16}$/)
  })

  it('reports no changes against itself and names exactly what moved', () => {
    const first = loadConfig(SPEC_PATH, AT, null)
    expect(first.ok && first.value.changed).toEqual([])
    if (!first.ok) return
    // One key in [defaults] moves the SAME key on every book, and the diff names each one,
    // which is the shape an operator needs: "what did this edit actually change, and where".
    const moved = validate(AT, withSpec((r) => { r.defaults.exit.max_hold_ms = 50_000 }))
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    expect(diffConfig(first.value.values, moved.value)).toEqual(['books[0].exit.maxHoldMs', 'books[1].exit.maxHoldMs'])
  })
})

describe('refuse, never clamp', () => {
  it('refuses an out-of-range number rather than pulling it into range', () => {
    const r = refusal(validate(AT, withSpec((s) => { s.risk.max_concurrent = 1_001 })))
    expect(r?.bucket).toBe('config-refused')
    expect(r?.subject).toBe('risk.max_concurrent')
  })

  it('refuses a typo instead of falling back to a default', () => {
    const r = refusal(validate(AT, withSpec((s) => { s.defaults.exit.max_hold_msec = s.defaults.exit.max_hold_ms; delete s.defaults.exit.max_hold_ms })))
    expect(r?.reason).toContain('unknown key')
  })

  it('refuses a simulation factor that erases the sign of an outcome', () => {
    const r = refusal(validate(AT, withSpec((s) => { s.simulation.positive_factor = 0 })))
    expect(r?.subject).toBe('simulation.positive_factor')
  })

  it('replays a spec-v1 file without inventing a calibration field or changing its digest', () => {
    const legacy = withSpec((s) => { s.spec_version = 1; delete s.simulation })
    const r = validate(AT, legacy)
    expect(r.ok && r.value.simulation).toBeUndefined()
  })

  it('requires an explicit simulation model from spec v2 onward', () => {
    const r = refusal(validate(AT, withSpec((s) => { delete s.simulation })))
    expect(r?.subject).toBe('simulation')
  })

  it('refuses wei written as a number, because 0.08 ETH does not fit a double exactly', () => {
    const r = refusal(validate(AT, withSpec((s) => { s.risk.bankroll_wei = 80000000000000000 })))
    expect(r?.subject).toBe('risk.bankroll_wei')
    expect(r?.reason).toContain('decimal wei string')
  })

  it('refuses a size switch above the ceiling rather than clamping it', () => {
    const c = validate(AT, raw())
    expect(c.ok).toBe(true)
    if (!c.ok) return
    const over = checkSize(AT, BigInt(c.value.risk.maxTradeSizeWei) + 1n, c.value)
    expect(over.ok).toBe(false)
    expect(over.ok ? null : over.refusal.bucket).toBe('switch-refused')
    expect(checkSize(AT, 5_000_000_000_000_000n, c.value).ok).toBe(true)
  })
})

describe('the cross-checks, each one a bug that produces no error', () => {
  it('refuses overlapping bands, because a launch would route to two books', () => {
    const r = refusal(validate(AT, withSpec((s) => {
      s.books.push({ id: 'second', min_creator_tax_bps: 0, max_creator_tax_bps: 5_000, min_exemptions: 3, template_loss_block_ms: 3_600_000, size_wei: '0' })
    })))
    expect(r?.subject).toBe('books')
    expect(r?.reason).toContain('overlap')
  })

  it('accepts a THIRD disjoint band, which is the whole point of the structure', () => {
    // The shipped spec already carries two. A third has to sit above both. Size 0
    // contributes nothing to the wallet bar, so the funded books' scale is unchanged.
    const r = validate(AT, withSpec((s) => {
      s.books.push({ id: 'heavy', min_creator_tax_bps: 201, max_creator_tax_bps: 10_000, min_exemptions: 3, template_loss_block_ms: 3_600_000, size_wei: '0' })
    }))
    expect(refusal(r)).toBeNull()
    expect(r.ok && r.value.books.map((b) => b.id)).toEqual(['untaxed', 'taxed', 'heavy'])
    expect(r.ok && r.value.books[2]!.maxDrawdownWei).toBe('0')
  })

  it('derives each book\'s stop as size × drawdown_stakes, so a size edit cannot leave the stop behind', () => {
    const r = validate(AT, withSpec((s) => { s.books[0].size_wei = '10000000000000000' }))
    expect(refusal(r)).toBeNull()
    if (!r.ok) return
    expect(r.value.books[0]!.maxDrawdownWei).toBe('20000000000000000')
    expect(r.value.risk.maxWalletDrawdownWei).toBe('40000000000000000')
  })

  it('replays a historical config without drawdown_stakes from its recorded wei stops', () => {
    const legacy = {
      books: [{ sizeWei: '10000000000000000', maxDrawdownWei: '15000000000000000' }],
      risk: { maxWalletDrawdownWei: '15000000000000000' },
    } as unknown as FrozenConfig
    expect(effectiveBookDrawdownWei(legacy, legacy.books[0]!, 5_000_000_000_000_000n)).toBe(15_000_000_000_000_000n)
    expect(effectiveWalletDrawdownWei(legacy, 5_000_000_000_000_000n)).toBe(15_000_000_000_000_000n)
  })

  it('refuses a leftover max_drawdown_wei, because the stop is no longer a second knob', () => {
    const r = refusal(validate(AT, withSpec((s) => { s.books[0].max_drawdown_wei = '15000000000000000' })))
    expect(r?.subject).toBe('books[0]')
    expect(r?.reason).toContain('unknown key')
  })

  it('refuses a leftover max_wallet_drawdown_wei, because the wallet bar is the sum of the derived stops', () => {
    const r = refusal(validate(AT, withSpec((s) => { s.risk.max_wallet_drawdown_wei = '30000000000000000' })))
    expect(r?.subject).toBe('risk')
    expect(r?.reason).toContain('unknown key')
  })

  it('refuses a drawdown multiple under one stake, which would halt on a single ordinary loss', () => {
    const r = refusal(validate(AT, withSpec((s) => { s.risk.drawdown_stakes = 0 })))
    expect(r?.subject).toBe('risk.drawdown_stakes')
  })

  it('resolves every book against [defaults], key by key, one level deep', () => {
    /**
     * AN OVERRIDE REPLACES KEYS, NOT TABLES. Writing [books.guard] with one key in it has to
     * keep the other six from the defaults, because "this book pauses at -3 instead" is what
     * an operator means, not "this book has no freshness rule". A whole-table replace would
     * silently drop every key they did not retype, and the missing ones would fail validation
     * somewhere far from the edit.
     */
    const r = validate(AT, withSpec((s) => {
      s.books[1].guard = { shut_at: -3 }
      s.books[1].exit = { max_hold_ms: 90_000 }
    }))
    expect(refusal(r)).toBeNull()
    if (!r.ok) return
    const [a, b] = r.value.books
    expect(b!.guard.shutAt).toBe(-3)
    expect(a!.guard.shutAt).toBe(-1.5)        // the other book is untouched
    expect(b!.guard.window).toBe(a!.guard.window)       // inherited
    expect(b!.guard.freshMs).toBe(a!.guard.freshMs)     // inherited
    expect(b!.exit.maxHoldMs).toBe(90_000)
    expect(b!.exit.hardStopMultiple).toBe(a!.exit.hardStopMultiple)
  })

  it('names the book in every policy refusal, so the operator knows which one they broke', () => {
    const r = refusal(validate(AT, withSpec((s) => { s.books[1].exit = { hard_stop_multiple: 5 } })))
    expect(r?.subject).toBe('books[1].exit.hard_stop_multiple')
  })

  it('refuses a book that stakes more than the wallet ceiling', () => {
    // `risk.max_trade_size_wei` bounds what the SPEC may declare, not only what the switch may
    // take, so a document cannot commit more per launch than the wallet has agreed to.
    const r = refusal(validate(AT, withSpec((s) => { s.books[0].size_wei = '20000000000000001' })))
    expect(r?.subject).toBe('books[0].size_wei')
    expect(r?.reason).toContain('max_trade_size_wei')
  })

  it('refuses a dead-coin bail that arms after the clock has already sold', () => {
    // The pair would read as configured and do nothing: the bail can never fire, so the number
    // in the file describes a rule that does not exist. Untaxed overrides this key to off, so
    // the invalid default reaches taxed first.
    const r = refusal(validate(AT, withSpec((s) => { s.defaults.exit.dead_coin_after_ms = 45_000 })))
    expect(r?.subject).toBe('books[1].exit.dead_coin_after_ms')
    expect(r?.reason).toContain('could never fire')
  })

  it('checks the indicator bar against THAT book\'s ladder, not a shared one', () => {
    // Book 1 moves its own bars and keeps the default 1.75 indicator, which its own ladder no
    // longer scores. A shared check would have passed this because book 0 still has 1.75.
    const r = refusal(validate(AT, withSpec((s) => { s.books[1].take_profit = { adaptive_bars: [1.25, 1.5] } })))
    expect(r?.subject).toBe('books[1].guard.pnl_bar')
    expect(r?.reason).toContain('never scores that column')
  })

  it('refuses a gate with no hysteresis, which would oscillate on one sample', () => {
    const r = refusal(validate(AT, withSpec((s) => { s.defaults.guard.open_at = s.defaults.guard.shut_at })))
    expect(r?.subject).toBe('books[0].guard')
    expect(r?.reason).toContain('oscillates')
  })

  it('refuses a settle window shorter than the replay it is settling', () => {
    /**
     * The walk buys 20 blocks after launch and runs 500 blocks past that. Settling sooner
     * scores every launch on a path whose tail never arrived, and the error is one-directional
     * rather than noisy: the tail is where the winners are, so the market would read worse than
     * it is exactly when it is good.
     */
    const r = refusal(validate(AT, withSpec((s) => { s.defaults.guard.settle_ms = 45_000 })))
    expect(r?.subject).toBe('books[0].guard.settle_ms')
    expect(r?.reason).toContain('truncated path')
  })

  it('refuses an indicator pointed at a bar the replay never scores', () => {
    // The replay produces exactly the bars in adaptive_bars. An indicator on any other bar
    // reads a column that is never written, so the venue sensor silently has no rows at all
    // and a guard with no rows has no opinion forever. Untaxed overrides the default bar, so
    // the invalid default reaches taxed first.
    const r = refusal(validate(AT, withSpec((s) => { s.defaults.guard.pnl_bar = 1.6 })))
    expect(r?.subject).toBe('books[1].guard.pnl_bar')
    expect(r?.reason).toContain('never scores that column')
  })

  it('refuses a fresh window longer than the main one it is drawn from', () => {
    // The reopen slice is the head of the pause window. A longer one would release a book on
    // rows the pause never saw, so the two thresholds would be reading different populations
    // and the hysteresis would stop being a band at all.
    const r = refusal(validate(AT, withSpec((s) => { s.defaults.guard.recovery_window = 16 })))
    expect(r?.subject).toBe('books[0].guard.recovery_window')
    expect(r?.reason).toContain('cannot be longer')
  })

  it('refuses unsorted take-profit bars, because the argmax reports the first best', () => {
    const r = refusal(validate(AT, withSpec((s) => { s.defaults.take_profit.adaptive_bars = [2.0, 1.25, 1.5] })))
    expect(r?.subject).toBe('books[1].take_profit.adaptive_bars')
  })

  it('refuses a duplicate book id, which would merge two books money silently', () => {
    const r = refusal(validate(AT, withSpec((s) => {
      s.books.push({ ...s.books[0], min_creator_tax_bps: 50, max_creator_tax_bps: 100 })
    })))
    expect(r?.reason).toContain('duplicate book id')
  })

  it('refuses a book id that is not alphanumeric, since ids become SQL and DOM identifiers', () => {
    const r = refusal(validate(AT, withSpec((s) => { s.books[0].id = 'main-book' })))
    expect(r?.subject).toBe('books[0].id')
  })

  it('refuses an inverted band', () => {
    const r = refusal(validate(AT, withSpec((s) => { s.books[0].min_creator_tax_bps = 100 })))
    expect(r?.reason).toContain('inverted band')
  })
})

describe('the file on disk is what a boot ends up running', () => {
  /**
   * THE DEFECT: boot folded the tape after seeding state from the file, and every
   * `config-applied` row on the tape replaced the config with the spec in force at the time. So a
   * real tape always ended boot on the LAST RECORDED spec, the file was never read into a decision
   * again, and `WITH_CONFIG=1 ./deploy.sh` plus a restart shipped a policy that changed nothing
   * and said so nowhere. Caught on 2026-09-17 by shipping the 15/8 guard and reading `window 20`
   * back out of `/api/state`.
   */
  const cfg = () => {
    const r = validate(AT, raw())
    if (!r.ok) throw new Error(r.refusal.reason)
    return r.value
  }

  it('applies the file when the folded spec disagrees, naming what moved', () => {
    const file = cfg()
    const olderSpec = { ...file, risk: { ...file.risk, brokenGapPp: 30 } }
    const r = bootApply(601_052, olderSpec, file)
    expect(r.apply).toBe(true)
    expect(r.changed).toEqual(['risk.brokenGapPp'])
  })

  it('says nothing and writes nothing when the tape already agrees with the file', () => {
    // Re-applying an identical spec every boot would put a row on the tape and a line in the log
    // saying nothing happened, and an operator learns to ignore both.
    expect(bootApply(601_052, cfg(), cfg())).toEqual({ apply: false, changed: [] })
  })

  it('always applies on an empty tape, so the first row says what the run was configured with', () => {
    expect(bootApply(0, null, cfg())).toMatchObject({ apply: true })
    expect(bootApply(0, cfg(), cfg())).toMatchObject({ apply: true })
  })

  it('notices a guard window change, which is the one that made this visible', () => {
    const file = cfg()
    const twenty = {
      ...file,
      books: file.books.map((b) => ({ ...b, guard: { ...b.guard, window: 20, shutAt: -1 } })),
    }
    const r = bootApply(1, twenty, file)
    expect(r.apply).toBe(true)
    expect(r.changed.some((k) => k.endsWith('guard.window'))).toBe(true)
    expect(r.changed.some((k) => k.endsWith('guard.shutAt'))).toBe(true)
  })
})

describe('every key declares its readers', () => {
  /**
   * Dotted paths of every leaf in FrozenConfig, with array indices collapsed.
   *
   * IT DESCENDS INTO `books` SINCE 2026-09-16. A book is a complete policy now, so treating
   * the array as one opaque leaf would let every per-book key ship with no declared reader,
   * which is exactly the check this file exists to make. An array of PRIMITIVES stays a leaf
   * (`adaptiveBars` is one value, not seven), an array of TABLES is walked with the index
   * dropped, because a reader allowed to read book 0's guard may read book 1's.
   */
  function leaves(v: unknown, prefix = ''): string[] {
    if (Array.isArray(v)) {
      if (!v.length || typeof v[0] !== 'object' || v[0] === null) return prefix ? [prefix] : []
      return [...new Set(v.flatMap((x) => leaves(x, prefix)))]
    }
    if (typeof v === 'object' && v !== null) {
      return Object.entries(v).flatMap(([k, val]) => leaves(val, prefix ? `${prefix}.${k}` : k))
    }
    return [prefix]
  }

  const loaded = loadConfig(SPEC_PATH, AT, null)
  const cfg: FrozenConfig | null = loaded.ok ? loaded.value.values : null

  it('SPEC covers every field of FrozenConfig, so adding a key forces declaring its readers', () => {
    expect(cfg).not.toBeNull()
    if (!cfg) return
    // specVersion is identity, not a tunable, so it is deliberately not in SPEC.
    const undeclared = leaves(cfg).filter((k) => k !== 'specVersion' && !(k in SPEC))
    expect(undeclared).toEqual([])
  })

  it('SPEC names no key that FrozenConfig does not have', () => {
    expect(cfg).not.toBeNull()
    if (!cfg) return
    const actual = new Set(leaves(cfg))
    const missing = Object.keys(SPEC).filter((k) => !actual.has(k))
    const allowed = cfg.books.every((book) => book.sizing === undefined)
      ? missing.filter((k) => k.startsWith('books.sizing.'))
      : []
    expect(missing.filter((k) => !allowed.includes(k))).toEqual([])
  })

  /**
   * Modules the spec already names that are not written yet. Steps 5 to 7 of the rewrite.
   *
   * This list is self-liquidating: the assertion below fails if it names a module that HAS
   * landed, so finishing a module forces deleting its line, and the day the list is empty the
   * check becomes the strict one with no further edit. A pending list that could silently
   * stay stale would be the same kind of dead rule as the twenty thresholds the old repo
   * collected and never read.
   */
  // Shrinks as core/ is written, and the assertion below makes shrinking it compulsory: a
  // module that exists and is still listed here fails the suite. That is the point. A list
  // of "not yet" that nobody has to maintain becomes a list of lies within a week.
  const NOT_WRITTEN_YET = ['driver'] as const

  const coreModules = () =>
    new Set(readdirSync(join(ROOT, 'core')).filter((f) => f.endsWith('.ts')).map((f) => f.replace(/\.ts$/, '')))

  it('every declared reader is a real module, or one this list admits is unwritten', () => {
    const known = coreModules()
    const bogus: string[] = []
    for (const [key, s] of Object.entries(SPEC)) {
      for (const r of s.readers) {
        if (!known.has(r) && !(NOT_WRITTEN_YET as readonly string[]).includes(r)) bogus.push(`${key} -> ${r}`)
      }
    }
    expect(bogus).toEqual([])
  })

  it('the unwritten list does not name a module that already exists', () => {
    const known = coreModules()
    const stale = NOT_WRITTEN_YET.filter((m) => known.has(m))
    expect(stale, 'these modules exist now; delete them from NOT_WRITTEN_YET').toEqual([])
  })

  it('every reader is one of the declared READERS', () => {
    const allowed = new Set<string>(READERS)
    const bogus: string[] = []
    for (const [key, s] of Object.entries(SPEC)) {
      for (const r of s.readers) if (!allowed.has(r)) bogus.push(`${key} -> ${r}`)
    }
    expect(bogus).toEqual([])
  })

  it('every key has at least one reader, so a key nothing reads cannot be shipped', () => {
    const orphans = Object.entries(SPEC).filter(([, s]) => s.readers.length === 0).map(([k]) => k)
    expect(orphans).toEqual([])
  })

  it('names every reader of a key read by more than one module', () => {
    // The 09-16 defect in one assertion. VENUE_EXECUTION_SCENARIOS was documented with one
    // clause and read by eleven behaviours; the fix is not a longer doc, it is that a
    // multi-reader key must say so in the list a test can check.
    const multi = Object.entries(SPEC).filter(([, s]) => s.readers.length > 1)
    expect(multi.length).toBeGreaterThan(0)
    for (const [key, s] of multi) {
      expect(new Set(s.readers).size, `${key} lists a reader twice`).toBe(s.readers.length)
    }
  })
})
