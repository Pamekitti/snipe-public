/**
 * bot.enter() end to end, in observe mode, on a real curve: which book a launch lands in,
 * that a declined launch is still OBSERVED, and that the reason is written to the row.
 *
 * The pure decision is pinned in entry.test.ts. This file pins the wiring around it: the
 * exemption count actually reaches enter(), the probe's tripped cap actually reaches
 * pickEntry, a decline actually lands in launches.entry_reject, and the observation is
 * started before any of it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bot } from '../src/bot.js'
import { STRATEGY, RISK } from '../src/config.js'
import { setConfigForTest } from '../src/config/store.js'
import { simBuy, type CurveParams, type CurveState } from '../src/state/curve.js'
import { settle } from './helpers/settle.js'

const genesis: CurveState = {
  trackedQuote: 0n, trackedTokens: 10n ** 27n,
  quoteFeeBalance: 0n, creatorTaxBalance: 0n, graduated: false,
}
/** the observation.test.ts curve, with the tax and launch hour this test chooses */
const paramsFor = (creatorTaxBps: bigint, hourUtc: number): CurveParams => ({
  phantomQuote: 1_680_000_000_000_000_000n,
  launchSupply: 10n ** 27n,
  reservedTokens: (10n ** 27n * 1_680_000_000_000_000_000n) / 5_880_000_000_000_000_000n,
  feeBps: 100n, creatorTaxBps, snipeTaxStartBps: 9900n, snipeTaxSeconds: 3n,
  launchedAt: BigInt(Math.floor(Date.UTC(2026, 8, 6, hourUtc) / 1000)),
})

let n = 0
describe('bot.enter() routes a launch into the right book, or declines it on the record', () => {
  let dir: string
  let bot: Bot

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'entry-'))
    bot = new Bot({ mode: 'observe', dbFile: join(dir, 'bot.db') } as any)
    // a healthy stream, or canEnter declines everything for a reason this file is not testing
    ;(bot as any).logs.healthy = true
    ;(bot as any).logs.lastHealthyAt = Date.now()
  })
  afterEach(async () => {
    await settle()
    bot.tel.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** track a fresh curve, record its launch row the way onLaunch does, return the LaunchInfo */
  const arm = (o: { taxBps: bigint; hour: number; exemptions: number | null }) => {
    n++
    const curve = `0x${(0xc000 + n).toString(16).padStart(40, '0')}`
    const token = `0x${(0xa000 + n).toString(16).padStart(40, '0')}`
    const params = paramsFor(o.taxBps, o.hour)
    bot.state.track(curve, token, params, genesis, 100)
    bot.tel.launch({
      token, curve, deployer: '0xd', pair_token: '0x0000000000000000000000000000000000000000', block: 100,
      launched_at: Number(params.launchedAt), creator_tax_bps: Number(o.taxBps), dev_buy_wei: '0',
      detected_at: Date.now(), detect_source: 'logs', passed: 1, reject_reason: null, exemptions: o.exemptions,
    })
    const l = { token, curve, deployer: '0xd', pairToken: '0x0000000000000000000000000000000000000000', block: 100, detectedAt: Date.now(), source: 'logs' as const, exemptions: o.exemptions, devBuyWei: 0n as bigint | undefined }
    return { l, params, curve, token }
  }
  const rejectOf = async (token: string) => {
    await settle()
    return (bot.tel.raw().prepare('SELECT entry_reject FROM launches WHERE token=?').get(token) as any)?.entry_reject ?? null
  }
  const drive = async (o: Parameters<typeof arm>[0]) => {
    const a = arm(o)
    const fired: any[] = []
    bot.on('would-enter', (e) => fired.push(e))
    await (bot as any).enter(a.l, a.params)
    return { ...a, fired }
  }

  // ---- 2026-09-06: the template loss block ----

  it('after a real loss on a template, the same template is refused for an hour and the reason is on the row; another template enters', async () => {
    // 14:53-14:58 UTC: four launches of tax 200 / dev 0.06 / 6 exempt from four fresh
    // wallets, entered at 1.7-2.2x, sold at 0.31-0.46x, -$27 in seven minutes
    const { templateKey } = await import('../src/strategy/entry.js')
    const { newPosition } = await import('../src/strategy/exit.js')
    const key = templateKey(200n, 60_000_000_000_000_000n, 6)
    const lost = newPosition({
      id: 1, token: '0x' + '77'.repeat(20), curve: '0x' + '78'.repeat(20), tokens: 1n, spendWei: 5_000_000_000_000_000n,
      entryMarkWei: 5_000_000_000_000_000n, openedAt: Date.now(), buyHash: '0x' + 'ab'.repeat(32), takeProfitMultiple: 1.5, templateKey: key,
    })
    ;(bot as any).noteTemplateOutcome(lost, -1_000_000n)
    const same = arm({ taxBps: 200n, hour: 15, exemptions: 6 })
    same.l.devBuyWei = 60_000_000_000_000_000n
    const fired: any[] = []
    bot.on('would-enter', (e) => fired.push(e))
    await (bot as any).enter(same.l, same.params)
    expect(fired).toHaveLength(0)
    expect(await rejectOf(same.token)).toMatch(/^template-loss 0m ago/)
    // one exempt wallet more is a different script: it enters
    const other = arm({ taxBps: 200n, hour: 15, exemptions: 7 })
    other.l.devBuyWei = 60_000_000_000_000_000n
    await (bot as any).enter(other.l, other.params)
    expect(fired).toHaveLength(1)
    // a WIN on the template does not block it
    ;(bot as any).noteTemplateOutcome({ ...lost, templateKey: templateKey(100n, 1n, 5) }, 1n)
    const win = arm({ taxBps: 100n, hour: 15, exemptions: 5 })
    win.l.devBuyWei = 1n
    await (bot as any).enter(win.l, win.params)
    expect(fired).toHaveLength(2)
  })

  it('a restart seeds the block from the last hour of real losing closes in the database', async () => {
    const id = bot.tel.openPosition({
      token: '0x' + '79'.repeat(20), curve: '0x' + '7a'.repeat(20), live: 1, t_detect: 1, t_decide: 2, t_signed: 3, t_sent: 4,
      entry_block: 1, spend_wei: '5000000000000000', min_tokens_out: '1', tokens_held: '1',
      entry_mark_wei: '5000000000000000', buy_hash: '0x' + 'ab'.repeat(32), buy_ok: 1, buy_error: null, take_profit: 1.5,
    })
    bot.tel.launch({
      token: '0x' + '79'.repeat(20), curve: '0x' + '7a'.repeat(20), deployer: '0xd', pair_token: '0x0', block: 1,
      launched_at: 1, creator_tax_bps: 200, dev_buy_wei: '60000000000000000', detected_at: Date.now(), detect_source: 'logs',
      passed: 1, reject_reason: null, exemptions: 6,
    })
    bot.tel.closePosition(id, { exit_reason: 'stop', exit_at: Date.now() - 10 * 60_000, exit_hash: '0x' + 'cd'.repeat(32), proceeds_wei: '1', expected_wei: '1', pnl_wei: '-5000000000000000', hold_ms: 1, tokens_held: '0', peak_mult: 1 })
    await settle()
    ;(bot as any).templateLossAt.clear()
    ;(bot as any).seedTemplateLosses()
    const { templateKey } = await import('../src/strategy/entry.js')
    expect((bot as any).templateLossAt.has(templateKey(200n, 60_000_000_000_000_000n, 6))).toBe(true)
  })

  it('a taxed, bundled, daytime launch enters the MAIN book at the main size, with no reject on the row', async () => {
    const r = await drive({ taxBps: 100n, hour: 15, exemptions: 5 })
    expect(r.fired).toHaveLength(1)
    expect(r.fired[0].sizeWei).toBe(BigInt(Math.round(STRATEGY.tradeSizeEth * 1e18)))
    expect(await rejectOf(r.token)).toBeNull()
  })

  it('too few exempt wallets: observed, declined, and the reason is on the row', async () => {
    const r = await drive({ taxBps: 100n, hour: 15, exemptions: 2 })
    expect(r.fired).toHaveLength(0)
    expect(await rejectOf(r.token)).toBe('exempt 2')
    expect(bot.stats.rejects.get('exempt')).toBe(1)
    // the observation was started BEFORE the decline: the control group keeps its sample
    expect((bot as any).observations.has(r.curve)).toBe(true)
  })

  it('an untaxed launch is declined on the tax floor, bucket `tax`', async () => {
    // the probe book took these at a tenth the size until 2026-09-07. Its last verdict was
    // "not paying" (55 real trades, -$6.81) and it is deleted, so an untaxed coin is simply
    // a tax reject now, whatever its exempt count.
    for (const exemptions of [15, 20]) {
      const r = await drive({ taxBps: 0n, hour: 15, exemptions })
      expect(r.fired).toHaveLength(0)
      expect(await rejectOf(r.token)).toBe('tax 0bps')
    }
  })

  it('a risk-gate decline is recorded too, so the skip reasons are complete', async () => {
    bot.risk.halt('operator says no', 'manual')
    const r = await drive({ taxBps: 100n, hour: 15, exemptions: 5 })
    expect(r.fired).toHaveLength(0)
    expect(await rejectOf(r.token)).toMatch(/^halted: operator says no/)
  })

  it('a night launch enters, because the bot trades around the clock', async () => {
    // there was an entry window (12-24 UTC) until 2026-09-07. It kept only 73% of
    // September's profit with six of seven nights positive, and the venue pause plus the
    // self-lifting drawdown stop replaced it. A 03:00 launch is now an ordinary launch.
    const r = await drive({ taxBps: 100n, hour: 3, exemptions: 5 })
    expect(r.fired).toHaveLength(1)
    expect(await rejectOf(r.token)).toBeNull()
  })

  // ---- 2026-09-06: THE GRADUATION GUARD. every bag was bought at 3.4x-6.8x a fresh curve ----

  /** the curve after `eth` of buys landed before us, as the feed overlay would show it */
  const pumpedBy = (params: CurveParams, eth: bigint) => simBuy(params, genesis, eth, params.launchedAt + 1n).next

  it('refuses a curve the bundle has already pumped past the multiple, and records it as `pumped`', async () => {
    n++
    const curve = `0x${(0xd000 + n).toString(16).padStart(40, '0')}`
    const token = `0x${(0xb000 + n).toString(16).padStart(40, '0')}`
    const params = paramsFor(100n, 15)
    // 3 ETH in against a 1.68 ETH phantom reserve prices the curve ~8x fresh: the shape of
    // 1300, 1438, 1629, 1661 and 1722 (8.6-10.4x) at the moment we fired on them
    bot.state.track(curve, token, params, pumpedBy(params, 3_000_000_000_000_000_000n), 100)
    bot.tel.launch({ token, curve, deployer: '0xd', pair_token: '0x0000000000000000000000000000000000000000', block: 100,
      launched_at: Number(params.launchedAt), creator_tax_bps: 100, dev_buy_wei: '0', detected_at: Date.now(),
      detect_source: 'logs', passed: 1, reject_reason: null, exemptions: 15 })
    const fired: any[] = []
    bot.on('would-enter', (e) => fired.push(e))
    await (bot as any).enter({ token, curve, deployer: '0xd', pairToken: '0x0000000000000000000000000000000000000000', block: 100, detectedAt: Date.now(), source: 'logs' as const, exemptions: 15 }, params)
    expect(fired).toHaveLength(0)
    expect(await rejectOf(token)).toMatch(/^pumped [5-9]\.\dx$/)
    expect(bot.stats.rejects.get('pumped')).toBe(1)
    expect((bot as any).observations.has(curve)).toBe(true)   // still observed
    expect(bot.risk.openCount).toBe(0)                          // the reserved slot was given back
  })

  it('a normal launch never trips it: 1.5 ETH in (a big dev buy plus two seconds of buyers) is ~3.6x fresh, inside the p90 of real trades, and it enters', async () => {
    n++
    const curve = `0x${(0xd000 + n).toString(16).padStart(40, '0')}`
    const token = `0x${(0xb000 + n).toString(16).padStart(40, '0')}`
    const params = paramsFor(100n, 15)
    bot.state.track(curve, token, params, pumpedBy(params, 1_500_000_000_000_000_000n), 100)
    bot.tel.launch({ token, curve, deployer: '0xd', pair_token: '0x0000000000000000000000000000000000000000', block: 100,
      launched_at: Number(params.launchedAt), creator_tax_bps: 100, dev_buy_wei: '400000000000000000', detected_at: Date.now(),
      detect_source: 'logs', passed: 1, reject_reason: null, exemptions: 15 })
    const fired: any[] = []
    bot.on('would-enter', (e) => fired.push(e))
    await (bot as any).enter({ token, curve, deployer: '0xd', pairToken: '0x0000000000000000000000000000000000000000', block: 100, detectedAt: Date.now(), source: 'logs' as const, exemptions: 15 }, params)
    expect(fired).toHaveLength(1)
    expect(await rejectOf(token)).toBeNull()
  })
})
