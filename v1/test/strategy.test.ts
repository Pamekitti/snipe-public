import { describe, it, expect } from 'vitest'
import { snipeTaxBps, simBuy, simSell, reserves, type CurveParams, type CurveState } from '../src/state/curve.js'
import { evaluate, minQuoteOutFor, newPosition } from '../src/strategy/exit.js'
import { RiskManager, haltPhase } from '../src/strategy/risk.js'
import { parseLaunchCalldata, screenCurve, inBook, type LaunchMeta } from '../src/strategy/launch.js'
import { DeployerRegistry } from '../src/strategy/deployers.js'
import { GAS, STRATEGY, RISK } from '../src/config.js'
import { gasSpentEth, gasCostEth, setBaseFee } from '../src/tx/builder.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REG_FIXTURE = path.join(os.tmpdir(), 'snipe-deployers-fixture.json')
fs.writeFileSync(REG_FIXTURE, JSON.stringify({
  asOfBlock: 1000,
  counts: { '0xaaaa000000000000000000000000000000000001': 3, '0xbbbb000000000000000000000000000000000002': 1 },
}))
import { NonceManager } from '../src/tx/nonce.js'
import { mkPosition } from './helpers/position.js'

const params: CurveParams = {
  phantomQuote: 1_680_000_000_000_000_000n,
  launchSupply: 10n ** 27n,
  reservedTokens: (10n ** 27n * 1_680_000_000_000_000_000n) / (1_680_000_000_000_000_000n + 4_200_000_000_000_000_000n),
  feeBps: 100n, creatorTaxBps: 100n,
  snipeTaxStartBps: 9900n, snipeTaxSeconds: 3n, launchedAt: 1_000_000n,
}
const fresh: CurveState = { trackedQuote: 0n, trackedTokens: 10n ** 27n, quoteFeeBalance: 0n, creatorTaxBalance: 0n, graduated: false }

describe('snipe tax schedule', () => {
  it('matches the contract at each second boundary', () => {
    // startBps >> ((elapsed*14)/window), clamped to 10000-fee-tax-100
    expect(snipeTaxBps(params, 1_000_000n)).toBe(9700n) // 9900 clamped
    expect(snipeTaxBps(params, 1_000_001n)).toBe(618n)
    expect(snipeTaxBps(params, 1_000_002n)).toBe(19n)
    expect(snipeTaxBps(params, 1_000_003n)).toBe(0n)
    expect(snipeTaxBps(params, 1_000_030n)).toBe(0n)
  })
  it('is zero for exempt wallets even at second zero', () => {
    expect(snipeTaxBps(params, 1_000_000n, true)).toBe(0n)
  })
  it('makes entering at 2s vastly cheaper than at 0s', () => {
    const at0 = simBuy(params, fresh, 10n ** 16n, 1_000_000n)
    const at2 = simBuy(params, fresh, 10n ** 16n, 1_000_002n)
    expect(at2.tokensOut).toBeGreaterThan(at0.tokensOut * 30n)
  })
})

describe('curve round trip', () => {
  it('a buy immediately sold back loses roughly the two fee legs', () => {
    const b = simBuy(params, fresh, 10n ** 16n, 1_000_010n)
    const s = simSell(params, b.next, b.tokensOut)
    const ratio = Number(s.quoteOut) / Number(b.spent)
    expect(ratio).toBeGreaterThan(0.94)
    expect(ratio).toBeLessThan(0.97)
  })
  it('a bigger order gets a worse price per token', () => {
    const small = simBuy(params, fresh, 5n * 10n ** 15n, 1_000_010n)
    const big = simBuy(params, fresh, 50n * 10n ** 15n, 1_000_010n)
    const pxSmall = Number(small.spent) / Number(small.tokensOut)
    const pxBig = Number(big.spent) / Number(big.tokensOut)
    expect(pxBig).toBeGreaterThan(pxSmall)
  })
  it('reserves stay consistent after a buy', () => {
    const b = simBuy(params, fresh, 10n ** 16n, 1_000_010n)
    const r = reserves(params, b.next)
    expect(r.q).toBeGreaterThan(params.phantomQuote)
    expect(r.t).toBeLessThan(10n ** 27n)
  })
})

describe('exit rules', () => {
  const mk = mkPosition

  it('does not arm below the arm multiple, and does not trail before arming', () => {
    const p = mk()
    expect(evaluate(p, 115n, 1000, false)).toBeNull() // +15%, keep holding
    expect(evaluate(p, 100n, 1000, false)).toBeNull() // back to flat, still inside the clock
  })
  it('takes the profit and no longer pretends to trail', () => {
    // the trail was deleted with the take profit's arrival: it armed at +20% and fired
    // 50% off the peak, so a +21% take profit leaves it no reachable band. It had fired
    // once in 656 simulated trades even before that.
    const p = mk()
    expect(evaluate(p, 115n, 1000, false)).toBeNull() // +15%, keep riding
    expect(evaluate(p, 125n, 1100, false)).toBe('tp')
    // a big peak followed by a collapse is now the hard stop's job, not a trail's
    const q = mk()
    expect(evaluate(q, 119n, 1000, false)).toBeNull()
    expect(q.peakMarkWei).toBe(119n)                  // peak still recorded for reporting
    expect(evaluate(q, 60n, 1100, false)).toBeNull()  // -50% off peak, but above the stop
    expect(evaluate(q, 50n, 1200, false)).toBe('stop')
  })
  it('hard stops at -50% regardless of arming', () => {
    expect(evaluate(mk(), 55n, 1000, false)).toBeNull()
    expect(evaluate(mk(), 50n, 1000, false)).toBe('stop')
  })
  it('exits on the time cap and on graduation', () => {
    // print the dead-coin bar first (104 > 103) so this exercises the CLOCK in
    // isolation: a coin still flat at 44s is the bailout's business, not the cap's
    const alive = () => { const p = mk(); evaluate(p, 104n, 1_000, false); return p }
    // read the cap off config rather than pinning a literal: this assertion has now been
    // wrong twice (120s -> 45s on 08-18, 45s -> 90s on 08-27) and each time it failed as a
    // test bug rather than telling anyone anything about the clock
    const cap = STRATEGY.maxHoldMs
    expect(evaluate(alive(), 100n, cap - 1_000, false)).toBeNull() // inside the cap
    expect(evaluate(alive(), 100n, cap + 1, false)).toBe('time')
    expect(evaluate(alive(), 100n, cap * 2, false)).toBe('time')
    // the clock went 45s -> 90s and back on 2026-08-27. The 90s comment above it named its
    // own revert condition ("if p50 hold lands near 90s and the P&L does not follow"); p50
    // landed at 92.8s over 30 live trades that lost $86.46, so it reverted on its terms.
    expect(evaluate(alive(), 100n, 45_001, false)).toBe('time')
    expect(cap).toBe(45_000)
    expect(evaluate(mk(), 100n, 10, true)).toBe('graduating')
  })
})

describe('exit retry ladder', () => {
  it('every attempt goes out at the floor: a bound can only refuse a sell, never improve one', () => {
    // 2026-09-06: the first rung was 3% and reverted on 41 positions in a day; the 29 hard
    // stops among them then filled at 0.31 of their first quote (clean fills: 1.00). With
    // no mempool the curve pays its price at mining time whatever the bound says, so the
    // ladder only ever bought a 3s wait on a coin that was falling. See STRATEGY.
    const mark = 1_000_000n
    for (const n of [0, 1, 2, 3, 4]) expect(minQuoteOutFor(mark, n)).toBe(1n)
    expect(minQuoteOutFor(0n, 0)).toBe(1n) // a zero mark never yields a zero bound
  })
})

describe('risk manager', () => {
  it('reserves capacity synchronously so a burst cannot breach the cap', () => {
    const r = new RiskManager(10n ** 18n)
    const size = 10n ** 15n
    // simulate 20 launches arriving in the same instant, all gating before any completes
    let admitted = 0
    for (let i = 0; i < 20; i++) {
      const g = r.canEnter({ token: `0xtok${i}`, sizeWei: size, logsHealthy: true, logsAgeMs: 0 })
      if (g.allow) { r.reserve(`0xtok${i}`, size); admitted++ }
    }
    expect(admitted).toBe(14) // maxConcurrent, not 20
  })

  it('unreserve gives the slot back when an entry never happens', () => {
    const r = new RiskManager(10n ** 18n)
    r.reserve('0x1', 10n ** 15n)
    expect(r.openCount).toBe(1)
    r.unreserve(10n ** 15n)
    expect(r.openCount).toBe(0)
    expect(r.deployedWei).toBe(0n)
  })

  it('seedRealized restores the epoch ledger and re-checks the kill switch', () => {
    // Derived from the configured limit, not a hardcoded figure: the stop has moved three
    // times and every time it broke this test rather than the behaviour, which is the
    // wrong thing to have to notice during a deploy. Plain ETH arithmetic since
    // 2026-09-07, with no price in it at all.
    const wei = (eth: number) => BigInt(Math.round(eth * 1e18))
    const inside = wei(RISK.maxDrawdownEth * 0.85)
    const past = wei(RISK.maxDrawdownEth * 1.15)
    const peak = 10n ** 16n

    const r = new RiskManager(10n ** 18n)
    // a restart after losses: the DB says we are down, the peak was higher
    r.seedRealized(peak - inside, peak)
    expect(r.realizedPnlWei).toBe(peak - inside)
    expect(r.peakPnlWei).toBe(peak)
    expect(r.halted).toBe(false) // 85% of the stop: still trading
    // a deeper restored loss must halt immediately instead of silently re-arming
    const r2 = new RiskManager(10n ** 18n)
    r2.seedRealized(-past, 0n) // 115% of the stop, from a flat peak
    expect(r2.halted).toBe(true)
  })

  it('never allows a second entry into the same token', () => {
    const r = new RiskManager(10n ** 18n)
    const args = { token: '0xAbC', sizeWei: 10n ** 15n, logsHealthy: true, logsAgeMs: 0 }
    expect(r.canEnter(args).allow).toBe(true)
    r.reserve('0xAbC', 10n ** 15n)
    expect(r.canEnter(args).allow).toBe(false)
    // and case does not let one slip through
    expect(r.canEnter({ ...args, token: '0xabc' }).allow).toBe(false)
  })
  it('halts on drawdown and stops entering', () => {
    const r = new RiskManager(10n ** 18n)
    r.reserve('0x1', 10n ** 15n)
    r.closed(10n ** 15n, -(10n ** 17n)) // -0.1 ETH ~ $188 > $150 limit
    expect(r.halted).toBe(true)
    expect(r.canEnter({ token: '0x2', sizeWei: 1n, logsHealthy: true, logsAgeMs: 0 }).allow).toBe(false)
  })
  // a halted bot that quits still holding tokens strands them: the exit managers die
  // with the process and nothing sells. that costs the whole position, not a trade.
  it('stays up to flatten after the kill switch fires', () => {
    expect(haltPhase(false, 0)).toBe('running')
    expect(haltPhase(false, 3)).toBe('running')
    expect(haltPhase(true, 3)).toBe('flattening')
    expect(haltPhase(true, 0)).toBe('idle')
  })
  it('refuses entries while the authoritative stream is stale', () => {
    const r = new RiskManager(10n ** 18n)
    expect(r.canEnter({ token: '0x1', sizeWei: 1n, logsHealthy: true, logsAgeMs: 99_999 }).allow).toBe(false)
    expect(r.canEnter({ token: '0x1', sizeWei: 1n, logsHealthy: false, logsAgeMs: 0 }).allow).toBe(false)
  })
})

describe('nonce manager', () => {
  it('reserves in order and rolls back a rejection', async () => {
    const n = new NonceManager(async () => 5)
    await n.init()
    expect(n.reserve()).toBe(5)
    expect(n.reserve()).toBe(6)
    expect(n.release(6)).toBe(true) // last one out can go back
    expect(n.peek()).toBe(6)
    expect(n.release(5)).toBe(true) // now 5 is the last one out, so it also rolls back
    expect(n.peek()).toBe(5)
  })
  it('cannot roll back a nonce that a later tx already jumped over', async () => {
    const n = new NonceManager(async () => 5)
    await n.init()
    const first = n.reserve() // 5
    n.reserve() // 6, still in flight
    expect(n.release(first)).toBe(false) // 6 claimed a higher slot; leave the hole
    expect(n.peek()).toBe(7)
  })
  it('only resyncs when nothing is in flight', async () => {
    let chain = 9
    const n = new NonceManager(async () => chain)
    await n.init()
    n.reserve()
    chain = 20
    expect(await n.resyncIfIdle()).toBe(false)
    n.settle()
    expect(await n.resyncIfIdle()).toBe(true)
    expect(n.peek()).toBe(20)
  })
})

describe('entry clock', () => {
  // the tax bracket is decided by whole-second block timestamps, so the only thing that
  // matters is which side of the launchedAt+2 boundary we land on
  const p: CurveParams = { ...params, launchedAt: 1_000_000n }
  it('the bracket we aim for is 30x cheaper than the one just before it', () => {
    const early = snipeTaxBps(p, 1_000_001n)
    const target = snipeTaxBps(p, 1_000_002n)
    expect(early).toBe(618n)
    expect(target).toBe(19n)
    expect(Number(early) / Number(target)).toBeGreaterThan(30)
  })
  it('overshooting the window is nearly free, undershooting is not', () => {
    const spend = 10n ** 16n
    const at1 = simBuy(p, fresh, spend, 1_000_001n).tokensOut
    const at2 = simBuy(p, fresh, spend, 1_000_002n).tokensOut
    const at3 = simBuy(p, fresh, spend, 1_000_003n).tokensOut
    // landing one second late costs 19bps; landing one second early costs ~6%
    expect(Number(at3 - at2) / Number(at2)).toBeLessThan(0.003)
    expect(Number(at2 - at1) / Number(at1)).toBeGreaterThan(0.05)
  })
})

describe('graduation proximity', () => {
  // a position still open when sellable hits zero cannot be exited at any price,
  // so the trigger has to fire on approach rather than on arrival
  it('reports supply remaining and reaches zero at graduation', async () => {
    const { graduationProgress } = await import('../src/state/curve.js')
    expect(graduationProgress(params, fresh)).toBeCloseTo(1, 2)
    const nearlyDone = { ...fresh, trackedTokens: params.reservedTokens + 1n }
    expect(graduationProgress(params, nearlyDone)).toBeLessThan(0.001)
    const done = { ...fresh, trackedTokens: params.reservedTokens }
    expect(graduationProgress(params, done)).toBe(0)
  })

  it('fires the exit while selling is still possible, not after', async () => {
    const { graduationProgress, simSell } = await import('../src/state/curve.js')
    const initial = params.launchSupply - params.reservedTokens
    // at the configured threshold there is still real depth to sell into
    const atThreshold = { ...fresh, trackedTokens: params.reservedTokens + (initial * 12n) / 100n }
    expect(graduationProgress(params, atThreshold)).toBeCloseTo(0.12, 2)
    // a real position, roughly what 0.005 ETH buys at launch
    const position = 2_800_000_000_000_000_000_000_000n
    const out = simSell(params, atThreshold, position)
    expect(out.quoteOut).toBeGreaterThan(0n)
    // whereas at zero the curve refuses outright, at any size
    const exhausted = { ...fresh, trackedTokens: params.reservedTokens }
    expect(() => simSell(params, exhausted, position)).toThrow(/CurveGraduated/)
  })
})

describe('launch calldata', () => {
  // two real launchAndBuy transactions from chain history
  const PLAIN = '0xf85f8e4100000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000d0601ce157db5bdc3162bbac2a2c8af5320d9eec000000000000000000000000000000000000000000000000006605c07ac948520000000000000000000000000000000000000000000000000000000000000000000000000000000000000000495c5f25cb41419d504e598801ef078fd9d0480b00000000000000000000000000000000000000000000000000000000000004600000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001c000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000240000000000000000000000000495c5f25cb41419d504e598801ef078fd9d0480b00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ca334db6301055305178e8e7c69b02407df457de6f5ef3be4e6bb19c1460e167d7bc38724aa6e8973582b368edd8598c10f86944a926a3296f1a38225b1f96560000000000000000000000000000000000000000000000000000000000000015706c73646f6e7462757974686973697361746573740000000000000000000000000000000000000000000000000000000000000000000000000000000000000a504c53444f4e54425559000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002b4d61696e6e657420696e746567726174696f6e207465737420746f6b656e2e20446f206e6f74206275792e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' as const
  const BUNDLE = '0xf85f8e4100000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007c4b0e7ec40eee0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e38df78758c217330fced50e4b2ecda35228ee2600000000000000000000000000000000000000000000000000000000000005400000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000000000000000000000000000000000000000024000000000000000000000000000000000000000000000000000000000000002e0000000000000000000000000e38df78758c217330fced50e4b2ecda35228ee2600000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000000a9fc75d4203a33fe660e8fa32c74c3aa41c1fda4bf23d3a39b6bc22a1f8b1ca7296bc0a4c2c6dcfae43dccb736c2625a98ad61025e9c0faf5fd875ba11f28c35000000000000000000000000000000000000000000000000000000000000000b537472617461204c616e64000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000653545241544100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000042697066733a2f2f6261666b7265696461667a6b6863647635726168796b72733636637163626172727670616f6766736769647267756b3677706a37746b64666b343400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000614f6e636861696e206c616e642065636f6e6f6d79206f6e20506f6e732e200d0a0d0a436c61696d20612070617263656c2c20776f726b20746865207365616d20756e6465722069742c207472616465207768617420636f6d6573206f75742e0d0a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000160000000000000000000000000000000000000000000000000000000000000001868747470733a2f2f782e636f6d2f7374726174616f6e7268000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001568747470733a2f2f737472617461612e6c616e642f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030000000000000000000000008bce0fd4f5004f1512a365c9ce94025152123a3a00000000000000000000000000c15f2bae8634b39809d2de25708cefc64a0f5800000000000000000000000075841b191e974857e51bdf6658cdb939b98d0ee9' as const
  it('decodes a plain launch (no bundle, no socials)', () => {
    const m = parseLaunchCalldata(PLAIN)!
    expect(m).not.toBeNull()
    expect(m.symbol).toBe('PLSDONTBUY')
    expect(m.exemptions).toBe(0)
    expect(m.hasTwitter).toBe(false)
  })
  it('decodes a bundled launch with a twitter link', () => {
    const m = parseLaunchCalldata(BUNDLE)!
    expect(m.name).toBe('Strata Land')
    expect(m.exemptions).toBe(3)
    expect(m.hasTwitter).toBe(true)
    expect(m.quoteInWei).toBeGreaterThan(0n)
  })
  it('ignores other selectors', () => {
    expect(parseLaunchCalldata('0x59a87bc1' + '00'.repeat(64) as any)).toBeNull()
  })
})

describe('selection book', () => {
  const meta = (o: Partial<LaunchMeta>): LaunchMeta => ({
    name: 'x', symbol: 'X', logo: 'ipfs://a', hasTwitter: true, hasWebsite: false, hasTelegram: false,
    descriptionLen: 10, exemptions: 3, buybackEnabled: false, quoteInWei: 10n ** 17n, ...o,
  })
  const eth = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n
  // read the floor from config so a refit moves the test with the strategy instead of
  // leaving it asserting a number nobody meant to keep
  const FLOOR = STRATEGY.book.minDevBuyWei
  const MAXPRIOR = STRATEGY.book.maxPriorLaunches
  const MAXCTAX = BigInt(STRATEGY.maxCreatorTaxBps)
  const screen = (o: Partial<Parameters<typeof screenCurve>[0]>) =>
    screenCurve({ creatorTaxBps: 0n, devBuyWei: FLOOR, meta: meta({}), priorLaunches: 0, requireDevBuy: true, ...o })

  it('needs BOTH a dev buy at the floor and a deployer at or under the prior cap', () => {
    expect(screen({}).pass).toBe(true)
    expect(screen({ devBuyWei: FLOOR - 1n }).pass).toBe(false)
    // the cap is a bound, not a first-launch rule: at the cap passes, one over does not
    expect(screen({ priorLaunches: MAXPRIOR }).pass).toBe(true)
    expect(screen({ priorLaunches: MAXPRIOR + 1 }).pass).toBe(false)
    expect(screen({ devBuyWei: FLOOR - 1n, priorLaunches: MAXPRIOR }).pass).toBe(false)
  })
  it('rejects repeat deployers with a reason that names the count', () => {
    const v = screen({ priorLaunches: 7 })
    expect(v.pass).toBe(false)
    expect(v.reason).toContain('7 prior launches')
  })
  it('the dev buy is a floor with no ceiling: 0.03 and 0.4 both buy', () => {
    // widened 0.08 -> 0.01 on 2026-08-19. sole-reason attribution over the current era put
    // 126 launches in the 0.01-0.08 band at a 61% win rate and a +16.80% median, and every
    // upper bound tested (0.08 through 1.50) lost on walk-forward. see config.
    expect(screen({ devBuyWei: eth(0.03), meta: meta({}) }).pass).toBe(true)
    expect(screen({ devBuyWei: eth(0.4), meta: meta({ exemptions: 14, hasTwitter: true }) }).pass).toBe(true)
    // still a floor: under it is out, whatever the calldata claims
    expect(screen({ devBuyWei: FLOOR - 1n, meta: meta({ exemptions: 14 }) }).pass).toBe(false)
  })
  it('creator tax above the bound is a no, and REQUIRE_DEV_BUY=0 opens everything else', () => {
    expect(screen({ creatorTaxBps: MAXCTAX + 1n, devBuyWei: eth(1), meta: meta({}), requireDevBuy: false }).pass).toBe(false)
    expect(screen({ creatorTaxBps: MAXCTAX, devBuyWei: 0n, priorLaunches: 99, requireDevBuy: false }).pass).toBe(true)
  })
  it('an UNTAXED launch still passes the screen, on purpose, even though we no longer buy it', () => {
    // 2026-08-28. STRATEGY.minCreatorTaxBps declines these at the entry decision, NOT here.
    // screenCurve sets launches.passed and gatewatch.py scores WHERE passed = 1, so moving
    // the floor into this function would stop us observing the very coins that prove the
    // filter works -- untaxed coins lost $494.55 over 874 trades against a positive taxed
    // book, and that comparison needs both arms to keep being recorded.
    expect(STRATEGY.minCreatorTaxBps).toBeGreaterThan(0)
    expect(screen({ creatorTaxBps: 0n }).pass).toBe(true)
    expect(screen({ creatorTaxBps: BigInt(STRATEGY.minCreatorTaxBps) - 1n }).pass).toBe(true)
  })
  it('needs at least one pre-approved exempt wallet', () => {
    // zero-exemption launches were 145 of 464 in the 40h window and returned a -1.98%
    // median at a 35% win rate, against +18.60% / 70% for the rest. see config.
    expect(screen({ meta: meta({ exemptions: 0 }) }).pass).toBe(false)
    expect(screen({ meta: meta({ exemptions: 1 }) }).pass).toBe(true)
    expect(screen({ meta: meta({ exemptions: 14 }) }).pass).toBe(true)
    expect(screen({ meta: meta({ exemptions: 0 }) }).reason).toContain('exempt')
  })
  it('unknown metadata is a reject, never a pass on unknown', () => {
    expect(screen({ meta: null }).pass).toBe(false)
  })
  it('inBook matches the screen', () => {
    expect(inBook(FLOOR, 0, 1)).toBe(true)
    expect(inBook(FLOOR, MAXPRIOR, 1)).toBe(true)
    expect(inBook(FLOOR, MAXPRIOR + 1, 1)).toBe(false)
    expect(inBook(FLOOR - 1n, 0, 1)).toBe(false)
    expect(inBook(FLOOR, 0, 0)).toBe(false)
    expect(inBook(FLOOR, 0, null)).toBe(false)
  })
})

describe('deployer registry', () => {
  it('counts priors, never the launch being screened, and survives a restart', () => {
    const r = new DeployerRegistry()
    r.load(REG_FIXTURE)
    expect(r.loaded).toBe(true)
    // a deployer in the historical file
    expect(r.priorLaunches('0xAAAA000000000000000000000000000000000001')).toBe(3)
    expect(r.priorLaunches('0x0000000000000000000000000000000000000009')).toBe(0)
    // seeing a launch bumps it for next time
    r.bump('0x0000000000000000000000000000000000000009')
    expect(r.priorLaunches('0x0000000000000000000000000000000000000009')).toBe(1)
    // case insensitive
    expect(r.priorLaunches('0xaaaa000000000000000000000000000000000001')).toBe(3)
  })
  it('seed only counts launches after the historical cutoff', () => {
    const r = new DeployerRegistry()
    r.load(REG_FIXTURE)
    const added = r.seed([
      { deployer: '0xAAAA000000000000000000000000000000000001', block: 100 },  // before cutoff: ignored
      { deployer: '0xAAAA000000000000000000000000000000000001', block: 5000 }, // after: counted
    ])
    expect(added).toBe(1)
    expect(r.priorLaunches('0xAAAA000000000000000000000000000000000001')).toBe(4)
  })
  it('a missing file leaves the registry UNLOADED so the caller can refuse to trade', () => {
    const r = new DeployerRegistry()
    r.load('/nonexistent/deployers.json')
    expect(r.loaded).toBe(false)
    expect(r.priorLaunches('0xAAAA000000000000000000000000000000000001')).toBe(0)
  })
})

/**
 * Regression for the 2026-08-18 accounting bug: P&L charged gas at the BID
 * (limit x maxFee, floored at 0.5 gwei) rather than at what the chain actually
 * takes. Measured over 40 receipts that day: buy 100,161 gas, sell 77,276, at
 * 0.0200 gwei -> 3.4 microETH a round trip. The bid-priced version charged 245,
 * a 71x overstatement that fed straight into the drawdown kill switch.
 */
describe('gas accounting', () => {
  it('prices a round trip from gas actually burned, not from the bid', () => {
    setBaseFee(20_000_000n) // 0.02 gwei, the observed level
    const roundTrip = gasSpentEth(GAS.used.buy) + gasSpentEth(GAS.used.sell) + gasSpentEth(GAS.used.approve)
    expect(roundTrip).toBeGreaterThan(3e-6)
    expect(roundTrip).toBeLessThan(8e-6)
    // the bid stays deliberately loose so transactions land; it is just not the cost
    expect(gasCostEth(GAS.limits.buy)).toBeGreaterThan(roundTrip * 10)
  })

  it('does not fall to zero if the chain reports a base fee of zero', () => {
    setBaseFee(0n) // setBaseFee ignores non-positive input, so the last good value holds
    expect(gasSpentEth(GAS.used.buy)).toBeGreaterThan(0)
  })
})

describe('take profit', () => {
  const pos = (entry: bigint, tp = 1.25) => newPosition({
    id: 1, token: '0xt', curve: '0xc', tokens: 1n, spendWei: 5_000_000_000_000_000n,
    entryMarkWei: entry, openedAt: 1_000, takeProfitMultiple: tp, buyHash: '0xh', filled: true,
  } as never)

  it('fires at the position\'s own multiple and not a tick before', () => {
    const just_under = (1_000_000n * 125n) / 100n - 1n
    expect(evaluate(pos(1_000_000n), just_under, 1_100, false)).toBeNull()
    expect(evaluate(pos(1_000_000n), just_under + 1n, 1_100, false)).toBe('tp')
  })

  it('reads the PINNED multiple, not the config, so two open bags can differ', () => {
    // this is the whole point of the schedule: a cold-regime bag and a hot-regime bag are
    // open at the same time on different rungs, and a shared config scalar cannot express
    // that. 1.30 of entry is a take profit for the 1.25 bag and nothing at all for 1.50's.
    const mark = (1_000_000n * 130n) / 100n
    expect(evaluate(pos(1_000_000n, 1.25), mark, 1_100, false)).toBe('tp')
    expect(evaluate(pos(1_000_000n, 1.50), mark, 1_100, false)).toBeNull()
    expect(evaluate(pos(1_000_000n, 1.50), (1_000_000n * 150n) / 100n, 1_100, false)).toBe('tp')
  })

  it('beats the clock to the punch, so a spike at 44s is banked not held', () => {
    const p = pos(1_000_000n)
    // mark is well past the take profit but the hold clock has not expired
    expect(evaluate(p, 2_000_000n, 1_000 + STRATEGY.maxHoldMs - 1, false)).toBe('tp')
  })

  it('still yields to graduation, which is existential', () => {
    expect(evaluate(pos(1_000_000n), 2_000_000n, 1_100, true)).toBe('graduating')
  })

  it('leaves losers to the clock', () => {
    expect(evaluate(pos(1_000_000n), 900_000n, 1_100, false)).toBeNull()
    expect(evaluate(pos(1_000_000n), 900_000n, 1_000 + STRATEGY.maxHoldMs, false)).toBe('time')
  })
})
