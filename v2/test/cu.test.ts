/**
 * The provider meter, and the one arithmetic in it that the money turned on.
 *
 * This exists because on 2026-09-18 the account had spent 56.6M of a 95.2M cap, was about a day
 * and a half from the key refusing to answer, and nothing v2 could print knew it. So the two
 * properties pinned hardest here are: an unpriced call is never free, and a pace is never
 * extrapolated from a window too short to mean anything. Both are ways a meter starts lying while
 * still showing a number.
 *
 * IT IS A METER AND NEVER A GATE, so there is deliberately nothing here about refusing a trade.
 * `ProviderMeter` has no `allow()`; v1's did, and it moved reads onto a rate-limited public RPC in
 * the busiest hour of the week on a prediction.
 */
import { describe, it, expect } from 'vitest'
import { CU, CU_PER_BYTE, CU_PER_UNTYPED_REQUEST, MIN_OBS_MS, ProviderMeter } from '../io/cu.js'
import { buildReport } from '../projections/report.js'
import { History } from '../projections/history.js'
import { emptyState } from '../core/state.js'
import type { BookSpec, FrozenConfig, Switches } from '../core/config.js'

const BOOK: BookSpec = {
  id: 'alpha', minCreatorTaxBps: 0, maxCreatorTaxBps: 0, minExemptions: 3, templateLossBlockMs: 3_600_000,
  sizeWei: '5000000000000000', maxDrawdownWei: '15000000000000000',
  entry: { entryDelayMs: 2_000, entryFallbackLateMs: 600, maxEntryPriceMultiple: 4.5, buySlippageBps: 5_000 },
  exit: { maxHoldMs: 45_000, hardStopMultiple: 0.5, deadCoinAfterMs: 20_000, deadCoinBelowMultiple: 1.03, graduationExitAt: 0.12, maxSellAttempts: 20, exitRetryDelayMs: 300, sellFinalMinQuoteOutWei: '1' },
  takeProfit: { otherwise: 1.75, adaptiveWindow: 20, adaptiveBars: [1.25, 1.75] },
  guard: { window: 20, recoveryWindow: 8, openAt: 1, shutAt: -1, settleMs: 52_000, freshMs: 10_800_000, pnlBar: 1.75, maxReadingAgeMs: 10_800_000 },
}
const CFG: FrozenConfig = {
  specVersion: 1, books: [BOOK],
  risk: {
    maxConcurrent: 14, maxTradeSizeWei: '20000000000000000', bankrollWei: '80000000000000000', drawdownStakes: 3,
    maxWalletDrawdownWei: '60000000000000000',
    brokenWindow: 20, brokenFactor: 0.78, brokenGapPp: 15, maxLogsStalenessMs: 3_000, maxOverlayAgeMs: 1_500,
  },
  clock: { periodMs: 250 },
}
const SW: Switches = { sizeWei: 5_000_000_000_000_000n, mode: 'live', at: 0, by: 'test' }
const state = () => ({ ...emptyState(CFG, SW), at: 1_000_000 })

/** A meter on a clock the test moves by hand. */
function meterAt(cap: number | null = null, usdPerM: number | null = null) {
  let now = 0
  const m = new ProviderMeter(() => now, cap, usdPerM)
  return { m, tick: (ms: number) => { now += ms }, at: () => now }
}

describe('what the meter charges', () => {
  it('prices the poller tick at what the provider actually bills for it', () => {
    // 70 CU a tick is the whole reason any of this exists: at ~385k ticks a day it was ~26M of
    // the account's 26.8M CU/day. If either number below drifts, the saving is being measured
    // against a made-up price.
    expect(CU['eth_blockNumber']).toBe(10)
    expect(CU['eth_getLogs']).toBe(60)
    const { m } = meterAt()
    m.method('eth_blockNumber')
    m.method('eth_getLogs')
    expect(m.reading().cu).toBe(70)
  })

  it('charges a method it has never heard of, rather than calling it free', () => {
    // An unpriced call is an unknown cost. Rounding unknown down to zero is how a meter shows a
    // reassuring number while the invoice climbs.
    const { m } = meterAt()
    m.method('eth_someMethodInventedNextQuarter')
    expect(m.reading().cu).toBe(CU_PER_UNTYPED_REQUEST)
    expect(m.reading().byMethod[0]!.method).toBe('eth_someMethodInventedNextQuarter')
  })

  it('charges nothing for the methods the provider charges nothing for', () => {
    const { m } = meterAt()
    m.method('eth_chainId')
    expect(m.reading().cu).toBe(0)
  })

  it('bills socket traffic by the byte, not by the event', () => {
    const { m } = meterAt()
    m.bytes(1_000)
    expect(m.reading().cu).toBeCloseTo(1_000 * CU_PER_BYTE, 6)
    // ~40 CU for a typical 1,000-byte subscription event, which is the figure the launch-socket
    // projection in the 09-07 audit was built on.
    expect(m.reading().cu).toBeCloseTo(40, 6)
  })

  it('ignores a nonsense byte count instead of poisoning the total with NaN', () => {
    const { m } = meterAt()
    m.method('eth_getLogs')
    m.bytes(Number.NaN)
    m.bytes(-5)
    expect(m.reading().cu).toBe(60)
  })

  it('names the biggest line, so the bill has a cause and not just a size', () => {
    const { m } = meterAt()
    for (let i = 0; i < 10; i++) { m.method('eth_getLogs'); m.method('eth_blockNumber') }
    m.request('chain read')
    const top = m.reading().byMethod[0]!
    expect(top.method).toBe('eth_getLogs')
    expect(top.calls).toBe(10)
    expect(top.cu).toBe(600)
  })
})

describe('what the meter will and will not extrapolate', () => {
  it('reports the measured total at once and no pace at all before it has a window', () => {
    // v1's scar: a restart in a busy minute projected the socket at 57M/month against a measured
    // 16M, because the first seconds after a boot are a burst. The total is a fact; the pace is a
    // claim, and it waits.
    const { m, tick } = meterAt()
    m.method('eth_getLogs')
    tick(60_000)
    const early = m.reading()
    expect(early.cu).toBe(60)
    expect(early.perDay).toBeNull()
    expect(early.perMonth).toBeNull()
    expect(early.usdPerMonth).toBeNull()
    expect(early.capFraction).toBeNull()
  })

  it('extrapolates once it has one, at the rate it actually saw', () => {
    const { m, tick } = meterAt()
    // One hour of the shipped flat cadence: a 70 CU tick every second.
    tick(MIN_OBS_MS)
    for (let i = 0; i < 3_600; i++) { m.method('eth_blockNumber'); m.method('eth_getLogs') }
    const r = m.reading()
    expect(r.cu).toBe(3_600 * 70)
    // 252k CU in MIN_OBS_MS of elapsed time, projected over a day.
    expect(r.perDay).toBeCloseTo((3_600 * 70 / MIN_OBS_MS) * 86_400_000, 0)
    expect(r.perMonth).toBeCloseTo(r.perDay! * 30, 0)
  })

  it('prices the month only when told the rate, and measures the cap only when told the cap', () => {
    const { m, tick } = meterAt()
    tick(MIN_OBS_MS)
    m.method('eth_getLogs')
    const blind = m.reading()
    expect(blind.perMonth).not.toBeNull()
    expect(blind.usdPerMonth).toBeNull()
    expect(blind.capFraction).toBeNull()
    expect(blind.capPerMonth).toBeNull()

    const priced = meterAt(95_200_000, 0.525)
    priced.tick(MIN_OBS_MS)
    priced.m.method('eth_getLogs')
    const r = priced.m.reading()
    expect(r.usdPerMonth).toBeCloseTo((r.perMonth! / 1_000_000) * 0.525, 6)
    expect(r.capFraction).toBeCloseTo(r.perMonth! / 95_200_000, 9)
  })

  /** A 70 CU poll every `everyMs` for `MIN_OBS_MS`, then the reading. */
  function pollingAt(everyMs: number, cap: number | null, usdPerM = 0.525) {
    const { m, tick } = meterAt(cap, usdPerM)
    tick(MIN_OBS_MS)
    for (let i = 0; i < Math.round(MIN_OBS_MS / everyMs); i++) {
      m.method('eth_blockNumber')
      m.method('eth_getLogs')
    }
    return m.reading()
  }

  /** The provider's $50 and $150 usage limits, in CU at the published $0.525 per million. */
  const CAP_50 = (50 / 0.525) * 1_000_000
  const CAP_150 = (150 / 0.525) * 1_000_000

  it('reproduces the measured 26.8M CU/day that started all of this', () => {
    // The pre-change live pace: a 70 CU tick every ~225ms, around the clock.
    const r = pollingAt(225, CAP_50)
    expect(r.perDay! / 1_000_000).toBeGreaterThan(25)
    expect(r.perDay! / 1_000_000).toBeLessThan(29)
    expect(r.usdPerMonth).toBeGreaterThan(400)
    expect(r.capFraction).toBeGreaterThan(4)
  })

  it('shows the flat cadence cutting it to about a quarter, and still not fitting the $50 cap', () => {
    // THIS IS WHY THE CAP HAD TO BE RAISED AND THE CADENCE WAS NOT ENOUGH ON ITS OWN. One second a
    // tick is ~6M CU/day, ~181M a month, ~$95 — a 4.4x cut, and still 1.9x a $50 limit. The two
    // steps are not alternatives: without the fuse the key still stops answering before month end,
    // and it takes the launch socket and the entry reads with it.
    const flat = pollingAt(1_000, CAP_50)
    const busy = pollingAt(225, CAP_50)
    expect(flat.perDay! / 1_000_000).toBeGreaterThan(5)
    expect(flat.perDay! / 1_000_000).toBeLessThan(7)
    expect(flat.perDay!).toBeLessThan(busy.perDay! / 4)
    expect(flat.usdPerMonth).toBeGreaterThan(80)
    expect(flat.usdPerMonth).toBeLessThan(110)
    expect(flat.capFraction).toBeGreaterThan(1)
  })

  it('fits inside the raised cap, which is the pair of changes actually shipped', () => {
    const flat = pollingAt(1_000, CAP_150)
    expect(flat.capFraction).toBeLessThan(1)
    // With real headroom, not by a hair: the flag warns at 80% and should stay quiet here.
    expect(flat.capFraction).toBeLessThan(0.8)
  })
})

describe('the machine report carries the meter', () => {
  it('omits the block entirely for a process with no meter, rather than reporting zero spend', () => {
    // The monitor and every tool fold someone else's tape and make no provider calls at all. A
    // zero there would read as a free bot.
    expect(buildReport(state(), new History(), null).provider).toBeNull()
  })

  it('passes the reading through with the cap fraction the flag is built on', () => {
    const { m, tick } = meterAt(95_200_000, 0.525)
    tick(MIN_OBS_MS)
    for (let i = 0; i < 1_000; i++) m.method('eth_getLogs')
    const r = buildReport(state(), new History(), null, m.reading()).provider!
    expect(r.cu).toBe(60_000)
    expect(r.topMethod).toBe('eth_getLogs')
    expect(r.topMethodCu).toBe(60_000)
    expect(r.capPerMonth).toBe(95_200_000)
    expect(r.cuPerDay).not.toBeNull()
    expect(r.capFraction).not.toBeNull()
  })

  it('carries nulls, not zeros, while the pace is still unknown', () => {
    const { m } = meterAt(95_200_000, 0.525)
    m.method('eth_getLogs')
    const r = buildReport(state(), new History(), null, m.reading()).provider!
    expect(r.cu).toBe(60)
    expect(r.cuPerDay).toBeNull()
    expect(r.cuPerMonth).toBeNull()
    expect(r.usdPerMonth).toBeNull()
    expect(r.capFraction).toBeNull()
  })
})
