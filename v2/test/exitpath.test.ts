/**
 * Getting OUT of a position: the approve that makes a sell possible, and the release that
 * makes a second attempt possible.
 *
 * WHY THIS FILE EXISTS. On 2026-09-16 v2 bought three coins with real money and could not sell
 * any of them, for two reasons that had both been in the code since it was written:
 *
 *   Nothing ever raised an `approve`. The intent kind, the transaction builder and the signer
 *   path all existed; no decision emitted one. `sell` pulls tokens with `safeTransferFrom`, so
 *   all three sells reverted on chain at 49,028 gas, which is `ERC20InsufficientAllowance`.
 *
 *   Nothing ever released a sequenced sell that reverted. `evaluateExit` returns null while
 *   `inflightIntentId` is set; only a `CurveSell` log or a pre-sequencing rejection cleared it,
 *   and a chain revert is neither. The three positions froze permanently, and every projection
 *   showed them open, marked and healthy.
 *
 * Both were invisible to the suite because no test had ever taken a position from a fill to a
 * failed exit. `lifecycle.test.ts` folds a trade that WORKS; this one folds the ways it does
 * not.
 */
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { decide } from '../core/decide.js'
import { APPROVE_KEPT_MS, emptyState, freshGradState, type Position, type State } from '../core/state.js'
import { EVENT_TOPICS } from '../core/chain.js'
import { SELL_SETTLE_GIVEUP_MS } from '../core/exit.js'
import { freshCurve, type CurveParams } from '../core/curve.js'
import type { Event, RecoverySale } from '../core/events.js'
import type { Intent } from '../core/intents.js'
import type { BookSpec, FrozenConfig, Switches } from '../core/config.js'
import { exitRetryAction } from '../io/control.js'
import { assertMigrationSafe, assertTransportCompatible } from '../tools/migrate-snapshot.js'

const CURVE = '0x000000000000000000000000000000000000cccc'
const TOKEN = '0x000000000000000000000000000000000000aaaa'
const BUY_HASH = '0x' + '11'.repeat(32)

const BOOK: BookSpec = {
  id: 'only', minCreatorTaxBps: 0, maxCreatorTaxBps: 0, minExemptions: 3, templateLossBlockMs: 3_600_000,
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
    maxWalletDrawdownWei: '15000000000000000',
    brokenWindow: 20, brokenFactor: 0.78, brokenGapPp: 15, maxLogsStalenessMs: 3_000, maxOverlayAgeMs: 1_500,
  },
  clock: { periodMs: 250 },
}

const SW: Switches = { sizeWei: 5_000_000_000_000_000n, mode: 'live', at: 0, by: 'test' }

const LAUNCHED_AT = 1_789_595_729
const PARAMS: CurveParams = {
  phantomQuote: 1_680_000_000_000_000_000n,
  reservedTokens: 285_714_285_714_285_714_285_714_285n,
  launchSupply: 1_000_000_000_000_000_000_000_000_000n,
  feeBps: 100n, creatorTaxBps: 0n, snipeTaxStartBps: 9_900n, snipeTaxSeconds: 3n,
  launchedAt: BigInt(LAUNCHED_AT),
}

const T0 = (LAUNCHED_AT + 60) * 1000
const w = (v: bigint | string): string => BigInt(v).toString(16).padStart(64, '0')

let seq = 0
const ev = <T extends object>(at: number, kind: string, body: T): Event =>
  ({ seq: ++seq, at, run: 'test', kind, ...body } as unknown as Event)

const rules = {
  ...BOOK.exit, takeProfitMultiple: BOOK.takeProfit.otherwise,
  buySlippageBps: BOOK.entry.buySlippageBps,
} as Position['rules']

/**
 * A state holding one open position that has just had a sell sequenced, which is the exact
 * shape all three live positions were frozen in.
 */
function withInflightSell(opts: { signedAt: number } = { signedAt: T0 }): State {
  const s = emptyState(CFG, SW)
  s.curves.set(CURVE, {
    curve: CURVE, token: TOKEN, params: PARAMS,
    confirmed: freshCurve(PARAMS), working: freshCurve(PARAMS),
    pending: new Map(), confirmedThrough: 100, degraded: false, workingAt: T0,
  })
  const pos: Position = {
    id: 'buy-1', token: TOKEN, curve: CURVE, book: 'only', bookDigest: 'd', templateKey: 't',
    openedAt: T0 - 60_000, spendWei: 5_000_000_000_000_000n, entryMarkWei: 4_800_000_000_000_000n,
    rules, tokensHeld: 1_000_000_000_000_000_000_000n, peakMarkWei: 4_800_000_000_000_000n,
    proceedsWei: 0n, closedAt: null, abandonedAt: null, abandonReason: null,
    exitReason: null, attempts: 0, inflightIntentId: 'sell-2',
    lastBuyHash: null, lastSellHash: '0x' + '22'.repeat(32), awaitingSellReceipt: null,
    closed: false, venue: 'curve', grad: null, filled: true,
  }
  s.positions.set(pos.id, pos)
  s.risk.reserved = 1
  s.risk.deployedWei = pos.spendWei
  s.inflight.set('sell-2', {
    kind: 'sell', intentId: 'sell-2', token: TOKEN, curve: CURVE, reason: 'time',
    raisedAt: T0, hash: '0x' + '22'.repeat(32), nonce: 4, signedAt: opts.signedAt,
  })
  // Ids are minted from this counter. Left at 0 the retry would mint `sell-2` again and
  // silently overwrite the record under test, which is a fixture trap rather than a finding.
  return { ...s, at: T0, decisions: 10 }
}

describe('receipt-backed reconciliation of an operator recovery sale', () => {
  const OLD = '0x' + '22'.repeat(32)
  const HASH = '0x' + '33'.repeat(32)
  const proof = (): RecoverySale => ({
    token: TOKEN, curve: CURVE, oldHash: OLD, hash: HASH, oldNonce: 4, nonce: 8, confirmedNonce: 9,
    tokensSoldWei: '1000000000000000000000',
    receipt: { ok: true, gasWei: '2000000000000', proceedsWei: '4000000000000000', remainingWei: '0', error: null },
  })
  const stopped = () => {
    const s = withInflightSell()
    s.risk.halts.set('stopped', { kind: 'stopped', book: null, reason: 'existing stop', at: T0 })
    s.positions.get('buy-1')!.sellReceipts = new Map([[OLD, { reason: 'time', readAt: T0 }]])
    return s
  }
  const event = (recoverySale: RecoverySale) => ev(T0 + 1, 'operator', {
    action: 'reconcile-sale', positionId: 'buy-1', recoverySale, why: 'approved recovery sale; receipt verified',
  })

  it('books the confirmed sale and gas once, clears the obsolete obligation, and preserves the stop', () => {
    const first = decide(stopped(), event(proof()))
    const p = first.state.positions.get('buy-1')!
    expect(p).toMatchObject({ closed: true, tokensHeld: 0n, proceedsWei: 4_000_000_000_000_000n })
    expect(first.state.inflight.has('sell-2')).toBe(false)
    expect(p.sellReceipts?.size).toBe(0)
    expect(first.state.risk.walletRealizedWei).toBe(-1_000_000_000_000_000n)
    expect(first.state.risk.walletGasWei).toBe(2_000_000_000_000n)
    expect(first.state.risk.deployedWei).toBe(0n)
    expect(first.state.risk.reserved).toBe(0)
    expect(first.state.risk.halts.get('stopped')?.reason).toBe('existing stop')
    expect(first.intents).toHaveLength(0)
    const duplicate = decide(first.state, event(proof()))
    expect(duplicate.state.risk.walletRealizedWei).toBe(-1_000_000_000_000_000n)
    expect(duplicate.state.risk.walletGasWei).toBe(2_000_000_000_000n)
    expect(duplicate.intents).toHaveLength(0)
  })

  it.each([
    ['unknown old hash', (p: RecoverySale) => ({ ...p, oldHash: BUY_HASH })],
    ['same hash', (p: RecoverySale) => ({ ...p, hash: OLD })],
    ['invalid hash', (p: RecoverySale) => ({ ...p, hash: '0x1234' })],
    ['wrong token', (p: RecoverySale) => ({ ...p, token: CURVE })],
    ['wrong curve', (p: RecoverySale) => ({ ...p, curve: TOKEN })],
    ['nonce not superseded', (p: RecoverySale) => ({ ...p, nonce: p.oldNonce })],
    ['nonce not confirmed', (p: RecoverySale) => ({ ...p, confirmedNonce: p.nonce })],
    ['wrong amount', (p: RecoverySale) => ({ ...p, tokensSoldWei: '1' })],
    ['invalid amount', (p: RecoverySale) => ({ ...p, tokensSoldWei: '0x10' })],
    ['reverted sale', (p: RecoverySale) => ({ ...p, receipt: { ...p.receipt, ok: false } })],
    ['missing proceeds', (p: RecoverySale) => ({ ...p, receipt: { ...p.receipt, proceedsWei: null } })],
    ['missing remaining balance', (p: RecoverySale) => ({ ...p, receipt: { ...p.receipt, remainingWei: null } })],
    ['remaining tokens', (p: RecoverySale) => ({ ...p, receipt: { ...p.receipt, remainingWei: '1' } })],
    ['invalid gas', (p: RecoverySale) => ({ ...p, receipt: { ...p.receipt, gasWei: '-1' } })],
  ] as const)('refuses %s without changing position or cash', (_name, change) => {
    const out = decide(stopped(), event(change(proof())))
    expect(out.state.positions.get('buy-1')).toMatchObject({ closed: false, lastSellHash: OLD })
    expect(out.state.risk.walletRealizedWei).toBe(0n)
    expect(out.state.risk.walletGasWei).toBe(0n)
    expect(out.intents).toHaveLength(0)
    expect(out.refusals.some(r => r.bucket === 'exit-stuck')).toBe(true)
  })

  it('refuses while entries are enabled or another sale is unresolved', () => {
    const running = stopped()
    running.risk.halts.clear()
    expect(decide(running, event(proof())).state.positions.get('buy-1')!.closed).toBe(false)
    const multiple = stopped()
    multiple.positions.get('buy-1')!.sellReceipts!.set(BUY_HASH, { reason: 'time', readAt: T0 })
    expect(decide(multiple, event(proof())).state.positions.get('buy-1')!.closed).toBe(false)
    const active = stopped()
    active.inflight.set('another-sell', { ...active.inflight.get('sell-2')!, hash: BUY_HASH })
    expect(decide(active, event(proof())).state.positions.get('buy-1')!.closed).toBe(false)
  })
})

describe('operator reconciliation of an exhausted position', () => {
  function exhaustedStopped(): State {
    const s = withInflightSell()
    const pos = [...s.positions.values()][0]!
    pos.attempts = pos.rules.maxSellAttempts
    pos.inflightIntentId = null
    pos.lastSellHash = null
    pos.awaitingSellReceipt = null
    s.inflight.clear()
    s.risk.halts.set('stopped', { kind: 'stopped', book: null, reason: 'test stop', at: T0 })
    return s
  }

  it('requires an explicit position retry and fresh balance before renewing the exit budget', () => {
    const s = exhaustedStopped()
    const riskBefore = { pnl:s.risk.walletRealizedWei,gas:s.risk.walletGasWei,peak:s.risk.walletPeakWei,halts:[...s.risk.halts] }
    const control = exitRetryAction('buy-1',{stopped:true,broken:false,positions:s.positions})
    expect(control).toMatchObject({do:'retry-exit',positionId:'buy-1',code:202})
    const asked = decide(s,ev(T0+1,'operator',{action:'retry-exit',positionId:'buy-1',why:'test recovery'}))
    expect(asked.intents).toEqual([{kind:'read',what:'position-wallet',args:[TOKEN,'buy-1']}])
    expect(asked.state.positions.get('buy-1')!.attempts).toBe(20)
    const failed = decide(asked.state,ev(T0+2,'chain-read',{request:{kind:'position-wallet',args:[TOKEN,'buy-1']},result:null,viaKey:true,tries:1,latencyMs:1}))
    expect(failed.state.positions.get('buy-1')!.attempts).toBe(20)
    const balance = decide(failed.state,ev(T0+3,'chain-read',{request:{kind:'position-wallet',args:[TOKEN,'buy-1']},result:{balanceWei:'1000000000000000000000'},viaKey:true,tries:1,latencyMs:1}))
    expect(balance.state.positions.get('buy-1')).toMatchObject({attempts:0,priorSellAttempts:20,tokensHeld:1_000_000_000_000_000_000_000n})
    expect(balance.intents).toEqual([{kind:'read',what:'allowance',args:[TOKEN,CURVE,'buy-1']}])
    expect(tick(balance.state,T0+4).intents.some(i=>i.kind==='sell')).toBe(false)
    const ready = decide(balance.state,ev(T0+5,'chain-read',{request:{kind:'allowance',args:[TOKEN,CURVE,'buy-1']},result:{allowanceWei:'1000000000000000000000'},viaKey:true,tries:1,latencyMs:1}))
    expect(tick(ready.state,T0+6).intents.some(i=>i.kind==='sell')).toBe(true)
    expect({pnl:s.risk.walletRealizedWei,gas:s.risk.walletGasWei,peak:s.risk.walletPeakWei,halts:[...s.risk.halts]}).toEqual(riskBefore)
  })

  it('refuses a retry while entries are enabled or another recovery is pending', () => {
    const s=exhaustedStopped()
    expect(exitRetryAction('buy-1',{stopped:false,broken:false,positions:s.positions}).code).toBe(409)
    const one=decide(s,ev(T0+1,'operator',{action:'retry-exit',positionId:'buy-1',why:'test'}))
    expect(exitRetryAction('buy-1',{stopped:true,broken:false,positions:one.state.positions}).code).toBe(409)
    const two=decide(one.state,ev(T0+2,'operator',{action:'retry-exit',positionId:'buy-1',why:'duplicate'}))
    expect(two.intents).toHaveLength(0)
    expect(two.state.positions.get('buy-1')!.attempts).toBe(20)
  })

  it('keeps a migrated exhausted position inactive until an operator requests recovery', () => {
    const s=exhaustedStopped()
    expect(()=>assertMigrationSafe(s,false)).toThrow('flat book')
    expect(()=>assertMigrationSafe(s,true)).not.toThrow()
    let current=decide(s,ev(T0+1,'recovery-start',{reason:'restart'})).state
    for(let i=1;i<=60;i++) {
      const out=tick(current,T0+i*1000)
      expect(out.intents.some(x=>['buy','sell','approve','grad','broadcast'].includes(x.kind))).toBe(false)
      current=out.state
    }
    expect(current.positions.get('buy-1')!.attempts).toBe(20)
    expect(current.risk.halts.has('stopped')).toBe(true)
  })

  it('allows a flat transport-only migration without changing operator state', () => {
    const s = emptyState(CFG, SW)
    expect(() => assertMigrationSafe(s, false)).toThrow('stopped')
    expect(() => assertMigrationSafe(s, false, true)).not.toThrow()
    expect(() => assertTransportCompatible(resolve('.'))).not.toThrow()
  })

  it('distinguishes stale unsigned approval records from a potentially live transaction during migration', () => {
    const s=exhaustedStopped()
    s.inflight.set('old-approval',{kind:'approve',intentId:'old-approval',token:'0xold',curve:'0xoldcurve',raisedAt:s.at-APPROVE_KEPT_MS-1,hash:'',signedAt:0,nonce:-1})
    expect(()=>assertMigrationSafe(s,true)).not.toThrow()
    s.inflight.get('old-approval')!.hash=BUY_HASH
    expect(()=>assertMigrationSafe(s,true)).toThrow('in flight')
  })

  it('asks for a fresh token balance only for an exhausted position while stopped', () => {
    const out = decide(exhaustedStopped(), ev(T0 + 1, 'operator', {
      action: 'reconcile-empty', why: 'operator requested recovery',
    }))
    expect(out.intents).toContainEqual({ kind: 'read', what: 'position-wallet', args: [TOKEN, 'buy-1'] })
  })

  it('abandons an exactly empty bag without booking a fabricated loss', () => {
    const s = exhaustedStopped()
    const out = decide(s, ev(T0 + 2, 'chain-read', {
      request: { kind: 'position-wallet', args: [TOKEN, 'buy-1'] },
      result: { balanceWei: '0' }, viaKey: true, tries: 1, latencyMs: 1,
    }))
    const pos = out.state.positions.get('buy-1')!
    expect(pos.closed).toBe(true)
    expect(pos.abandonedAt).toBe(T0 + 2)
    expect(out.state.risk.deployedWei).toBe(0n)
    expect(out.state.risk.reserved).toBe(0)
    expect(out.state.risk.walletRealizedWei).toBe(0n)
    expect(out.state.risk.books.get('only')?.realizedWei ?? 0n).toBe(0n)
    expect(out.refusals.some((r) => r.bucket === 'exit-abandoned')).toBe(true)
  })

  it('keeps a non-empty bag open and corrects its amount from the chain', () => {
    const s = exhaustedStopped()
    const out = decide(s, ev(T0 + 3, 'chain-read', {
      request: { kind: 'position-wallet', args: [TOKEN, 'buy-1'] },
      result: { balanceWei: '123' }, viaKey: true, tries: 1, latencyMs: 1,
    }))
    const pos = out.state.positions.get('buy-1')!
    expect(pos.closed).toBe(false)
    expect(pos.tokensHeld).toBe(123n)
    expect(out.state.risk.deployedWei).toBe(pos.spendWei)
  })

  it('refuses reconciliation when the operator stop is absent', () => {
    const s = exhaustedStopped()
    s.risk.halts.delete('stopped')
    const out = decide(s, ev(T0 + 4, 'operator', {
      action: 'reconcile-empty', why: 'operator requested recovery',
    }))
    expect(out.intents).toHaveLength(0)
    expect(out.refusals.some((r) => r.reason.includes('not operator-stopped'))).toBe(true)
  })
})

const tick = (s: State, at: number): { state: State; intents: readonly Intent[]; refusals: readonly { bucket: string; reason: string }[] } => {
  const out = decide(s, ev(at, 'clock', {}))
  return out as never
}

describe('the approve that makes an exit possible at all', () => {
  /** The fill log for our own buy, which is what opens a position. */
  const fill = (at: number) => ev(at, 'logs', {
    from: 100, to: 101, logs: [{
      address: CURVE, topics: [EVENT_TOPICS.CurveBuy], blockNumber: 101,
      transactionHash: BUY_HASH,
      data: '0x' + w(5_000_000_000_000_000n) + w(1_000_000_000_000_000_000_000n) + w(0n) + w(0n),
    }],
  })

  function openedPosition(): { state: State; intents: readonly Intent[] } {
    const s = emptyState(CFG, SW)
    s.curves.set(CURVE, {
      curve: CURVE, token: TOKEN, params: PARAMS,
      confirmed: freshCurve(PARAMS), working: freshCurve(PARAMS),
      pending: new Map(), confirmedThrough: 100, degraded: false, workingAt: T0,
    })
    s.inflight.set('buy-1', {
      kind: 'buy', intentId: 'buy-1', token: TOKEN, curve: CURVE, book: 'only', bookDigest: 'd',
      templateKey: 't', sizeWei: 5_000_000_000_000_000n, rules, hash: BUY_HASH, nonce: 3, signedAt: T0,
    } as never)
    s.risk.reserved = 1
    s.risk.deployedWei = 5_000_000_000_000_000n
    const out = decide(s, fill(T0))
    return { state: out.state, intents: out.intents }
  }

  it('raises an approve the moment the buy fills, not at exit time', () => {
    const { intents } = openedPosition()
    const a = intents.find((i) => i.kind === 'approve')
    expect(a, 'a filled position with no approve can never be sold').toBeDefined()
  })

  it('approves the curve as spender of this position\'s token', () => {
    const { intents } = openedPosition()
    const a = intents.find((i) => i.kind === 'approve')!
    expect(a).toMatchObject({ kind: 'approve', token: TOKEN, curve: CURVE })
  })

  it('records the approve as inflight, so a rejected one is visible rather than lost', () => {
    const { state, intents } = openedPosition()
    const a = intents.find((i) => i.kind === 'approve')!
    expect(state.inflight.get(a.intentId)?.kind).toBe('approve')
  })

  /**
   * THE LEAK, STATED AS A TEST. An approve emits `Approval`, so no fill and no receipt ever
   * comes back looking for this record: once the send has answered, it has no job left. Only
   * a clean rejection deleted it until 2026-09-18, and the box was carrying 3,427 dead ones
   * in a Map with no ceiling, all of them written into every snapshot.
   */
  it('drops the approve once the send has answered, rather than keeping it forever', () => {
    const { state, intents } = openedPosition()
    const a = intents.find((i) => i.kind === 'approve')!
    const hash = '0x' + '77'.repeat(32)
    const signed = decide(state, ev(T0 + 1, 'tx-signed', {
      intentId: a.intentId, txKind: 'approve', hash, nonce: 4, raw: '0x00',
    })).state
    const sent = decide(signed, ev(T0 + 2, 'tx-send-result', {
      intentId: a.intentId, hash, ok: true, nonceConsumed: true, uncertain: false,
      statusCode: null, error: null, tSigned: T0 + 1, tSent: T0 + 2,
    })).state
    expect(sent.inflight.has(a.intentId)).toBe(false)
  })

  /**
   * The same leak from the other side. A REPLAY mints its own intent ids, so the send result
   * on the tape often names an id this fold never minted and the delete above never fires.
   * The sweep is what stops a boot rebuilding thousands of records nothing will ever read.
   */
  it('sweeps approves a send result never came back for, once they are old', () => {
    const s = emptyState(CFG, SW)
    for (let i = 0; i < 40; i++) {
      s.inflight.set(`old-${i}`, {
        kind: 'approve', intentId: `old-${i}`, token: TOKEN, curve: CURVE,
        raisedAt: T0, hash: '', nonce: -1, signedAt: 0,
      })
    }
    s.inflight.set('fresh', {
      kind: 'approve', intentId: 'fresh', token: TOKEN, curve: CURVE,
      raisedAt: T0 + APPROVE_KEPT_MS, hash: '', nonce: -1, signedAt: 0,
    })
    const out = decide(s, ev(T0 + APPROVE_KEPT_MS + 1, 'clock', {}))
    expect(out.state.inflight.has('old-0'), 'a dead approve is forgotten').toBe(false)
    expect(out.state.inflight.has('fresh'), 'one still inside the window is not').toBe(true)
  })

  it('drops an uncertain approve too, since nothing will ever come back for it', () => {
    const { state, intents } = openedPosition()
    const a = intents.find((i) => i.kind === 'approve')!
    const sent = decide(state, ev(T0 + 2, 'tx-send-result', {
      intentId: a.intentId, hash: '', ok: false, nonceConsumed: true, uncertain: true,
      statusCode: null, error: 'timed out', tSigned: T0 + 1, tSent: T0 + 2,
    })).state
    expect(sent.inflight.has(a.intentId)).toBe(false)
  })

  it('still opens the position it approved for', () => {
    const { state } = openedPosition()
    const pos = [...state.positions.values()].find((p) => !p.closed)
    expect(pos?.token).toBe(TOKEN)
    expect(pos?.tokensHeld).toBe(1_000_000_000_000_000_000_000n)
  })
})

describe('a receipt event whose verdict never arrived', () => {
  /**
   * THE SELL PATH HAD THIS HAZARD BEFORE ANY OF TODAY'S CHANGES, latently.
   *
   * `foldCurveSellReceipt` guarded `e.result === null` and then read fields off it. The box's tape
   * carries 15 receipt events with no `result` key at all — an older shape, `{hash, receipt}` —
   * and `undefined === null` is false. This handler never met one in the replay only because the
   * matching in-flight sell had already gone; that is luck, not a guard. A throw here is
   * `process.exit(1)` in `main.ts`, so the shape of an old event could stop the bot booting.
   */
  it('does not throw, and settles nothing, when the event carries no verdict', () => {
    const s = withInflightSell()
    const old = { seq: 9_998, at: T0 + 1, run: 'test', kind: 'receipt', hash: '0x' + '22'.repeat(32), receipt: { status: 'reverted' } } as unknown as Event
    expect(() => decide(s, old)).not.toThrow()
    const out = decide(s, old)
    const pos = out.state.positions.get('buy-1')!
    expect(pos.closed, 'no verdict is not a revert and not a sale').toBe(false)
    expect(pos.attempts, 'and it is not an attempt either: nothing was learned').toBe(0)
    expect(out.state.inflight.has('sell-2'), 'the sequenced sell stays on the books').toBe(true)
  })
})

describe('a sell that was sequenced and then reverted on chain', () => {
  it('is left alone while it might still settle', () => {
    const s = withInflightSell()
    const { state, refusals } = tick(s, T0 + SELL_SETTLE_GIVEUP_MS - 1_000)
    expect(refusals.some((r) => r.bucket === 'exit-unsettled')).toBe(false)
    expect([...state.positions.values()][0]!.inflightIntentId).toBe('sell-2')
  })

  it('is released once it has gone quiet for too long', () => {
    const s = withInflightSell()
    const { state, refusals } = tick(s, T0 + SELL_SETTLE_GIVEUP_MS + 1_000)
    expect(refusals.some((r) => r.bucket === 'exit-unsettled')).toBe(true)
    expect([...state.positions.values()][0]!.inflightIntentId).not.toBe('sell-2')
  })

  it('waits for a receipt before counting an attempt', () => {
    const s = withInflightSell()
    const { state } = tick(s, T0 + SELL_SETTLE_GIVEUP_MS + 1_000)
    expect([...state.positions.values()][0]!.attempts).toBe(0)
  })

  it('requests the receipt before deciding another approval is needed', () => {
    const s = withInflightSell()
    const { intents } = tick(s, T0 + SELL_SETTLE_GIVEUP_MS + 1_000)
    expect(intents.some((i) => i.kind === 'approve')).toBe(false)
    expect(intents.some((i) => i.kind === 'read' && i.what === 'receipt')).toBe(true)
  })

  it('does not send another sell while the previous receipt is unresolved', () => {
    const s = withInflightSell()
    // Past maxHoldMs, so the exit reason is there waiting as soon as the position is free.
    const { intents } = tick(s, T0 + SELL_SETTLE_GIVEUP_MS + 1_000)
    expect(intents.some((i) => i.kind === 'sell' && i.token === TOKEN)).toBe(false)
  })

  it('drops the dead inflight record rather than leaking it', () => {
    const s = withInflightSell()
    const { state } = tick(s, T0 + SELL_SETTLE_GIVEUP_MS + 1_000)
    expect(state.inflight.has('sell-2')).toBe(false)
  })

  /**
   * The ceiling still holds. Releasing a stuck sell must not turn into an unbounded retry
   * loop: v1 sent 33,804 sells against two positions that could never exit, and
   * `maxSellAttempts` is the budget that stops it.
   */
  it('gives up the curve and asks the graduated venue once the attempts are spent, if the curve is ready', () => {
    const s = withInflightSell()
    const pos = [...s.positions.values()][0]!
    pos.attempts = BOOK.exit.maxSellAttempts
    pos.inflightIntentId = null
    s.inflight.clear()
    const c = s.curves.get(CURVE)!
    // Confirmed still has sellable tokens, so the ordinary graduation flip does not fire.
    // The working book is already empty: that is the case the exhausted rescue is for.
    c.working = { ...c.working, trackedTokens: PARAMS.reservedTokens }
    const { state, intents, refusals } = tick(s, T0 + SELL_SETTLE_GIVEUP_MS + 1_000)
    expect(intents.some((i) => i.kind === 'sell')).toBe(false)
    expect(refusals.some((r) => r.bucket === 'exit-stuck')).toBe(true)
    const after = [...state.positions.values()][0]!
    expect(after.venue).toBe('graduated')
    expect(intents.some((i) => i.kind === 'read' && i.what === 'grad-pool')).toBe(true)
  })

  it('does not call graduate on a curve that is still the venue', () => {
    const s = withInflightSell()
    const pos = [...s.positions.values()][0]!
    pos.attempts = BOOK.exit.maxSellAttempts
    pos.inflightIntentId = null
    s.inflight.clear()
    const { state, intents, refusals } = tick(s, T0 + SELL_SETTLE_GIVEUP_MS + 1_000)
    expect(intents.some((i) => i.kind === 'sell' || i.kind === 'grad')).toBe(false)
    expect(intents.some((i) => i.kind === 'read' && i.what === 'grad-pool')).toBe(false)
    expect(refusals.some((r) => r.bucket === 'exit-stuck')).toBe(true)
    expect([...state.positions.values()][0]!.venue).toBe('curve')
  })

  /**
   * A sell decided but never signed freezes the position just as thoroughly, and `signedAt`
   * is 0 in that case, so the clock has to come from somewhere else or the comparison is
   * against the epoch and fires instantly.
   */
  it('releases a sell the driver never signed, measured from when it was decided', () => {
    const s = withInflightSell({ signedAt: 0 })
    expect(tick(s, T0 + 1_000).refusals.some((r) => r.bucket === 'exit-unsettled')).toBe(false)
    expect(tick(s, T0 + SELL_SETTLE_GIVEUP_MS + 1_000).refusals.some((r) => r.bucket === 'exit-unsettled')).toBe(true)
  })

  /**
   * This is what makes the first restart after a fix survivable. Replaying a tape recorded
   * while a position was stuck re-raises the exit every fifteen tape-seconds with no driver
   * to sign any of it; if those counted, an hour of catch-up would spend all twenty attempts
   * and the live process would inherit a position that had already given up.
   */
  it('charges no attempt for a sell that was never signed, however often it is freed', () => {
    let s = withInflightSell({ signedAt: 0 })
    for (let i = 1; i <= 50; i++) s = tick(s, T0 + i * SELL_SETTLE_GIVEUP_MS).state
    expect([...s.positions.values()][0]!.attempts).toBe(0)
  })
})

describe('a late sale after the give-up still returns the slot', () => {
  /**
   * This is the remaining hole that made the cap look full. Giving up deleted the inflight
   * sell, so a CurveSell or receipt that then arrived had nobody to match. The row stayed
   * open, reserved and deployedWei stayed taken, and the next launch was refused for a
   * budget that was not actually out.
   */
  const SELL_HASH = '0x' + '22'.repeat(32)
  const sellLog = (at: number) => ev(at, 'logs', {
    source: 'ws', lo: 101, hi: 101,
    logs: [{
      address: CURVE, topics: [EVENT_TOPICS.CurveSell],
      data: '0x' + w(1_000_000_000_000_000_000_000n) + w(6_000_000_000_000_000n) + w(0n) + w(0n),
      blockNumber: 101, blockHash: '0x' + 'ef'.repeat(32),
      transactionHash: SELL_HASH, transactionIndex: 0, logIndex: 0,
    }],
  })

  it('asks for the receipt when it gives up, instead of forgetting the hash', () => {
    const { state, intents } = tick(withInflightSell(), T0 + SELL_SETTLE_GIVEUP_MS + 1_000)
    const pos = [...state.positions.values()][0]!
    expect(pos.awaitingSellReceipt).toBe(SELL_HASH)
    expect(pos.lastSellHash).toBe(SELL_HASH)
    expect(intents.some((i) => i.kind === 'read' && i.what === 'receipt' && i.args[0] === SELL_HASH)).toBe(true)
    expect(state.risk.reserved).toBe(1)
    expect(state.risk.deployedWei).toBe(5_000_000_000_000_000n)
  })

  it('closes from a CurveSell that lands after the inflight record is gone', () => {
    const given = tick(withInflightSell(), T0 + SELL_SETTLE_GIVEUP_MS + 1_000).state
    const out = decide(given, sellLog(T0 + SELL_SETTLE_GIVEUP_MS + 2_000))
    const pos = out.state.positions.get('buy-1')!
    expect(pos.closed).toBe(true)
    expect(pos.proceedsWei).toBe(6_000_000_000_000_000n)
    expect(out.state.risk.reserved).toBe(0)
    expect(out.state.risk.deployedWei).toBe(0n)
  })

  it('counts a successful sell once when an incomplete receipt arrives before its fill log', () => {
    const first = decide(withInflightSell(), ev(T0 + 100, 'receipt', {
      hash: SELL_HASH,
      result: {ok:true,gasWei:'1000',proceedsWei:'6000000000000000',remainingWei:null,error:'balance read failed'},
    })).state
    expect(first.positions.get('buy-1')!.attempts).toBe(1)
    const out = decide(first, sellLog(T0 + 200))
    expect(out.state.positions.get('buy-1')!.closed).toBe(true)
    expect(out.state.positions.get('buy-1')!.attempts).toBe(1)
    expect(out.state.risk.walletGasWei).toBe(1000n)
  })

  it('closes from the receipt that lands after the inflight record is gone', () => {
    const given = tick(withInflightSell(), T0 + SELL_SETTLE_GIVEUP_MS + 1_000).state
    const out = decide(given, ev(T0 + SELL_SETTLE_GIVEUP_MS + 2_000, 'receipt', {
      hash: SELL_HASH,
      result: { ok: true, gasWei: '1000', proceedsWei: '6000000000000000', remainingWei: '0', outOfGas: false, error: null },
    }))
    const pos = out.state.positions.get('buy-1')!
    expect(pos.closed).toBe(true)
    expect(pos.proceedsWei).toBe(6_000_000_000_000_000n)
    expect(out.state.risk.reserved).toBe(0)
    expect(out.state.risk.deployedWei).toBe(0n)
  })

  it('does not drop a newer sell when the old one comes back reverted', () => {
    const given = tick(withInflightSell(), T0 + SELL_SETTLE_GIVEUP_MS + 1_000).state
    // Compatibility with a prior build that already submitted overlapping attempts.
    const next = {kind:'sell' as const,intentId:'sell-newer',token:TOKEN,curve:CURVE,reason:'time',raisedAt:T0+SELL_SETTLE_GIVEUP_MS,hash:'0x'+'33'.repeat(32),nonce:5,signedAt:T0+SELL_SETTLE_GIVEUP_MS}
    given.inflight.set(next.intentId,next)
    given.positions.get('buy-1')!.inflightIntentId=next.intentId
    const out = decide(given, ev(T0 + SELL_SETTLE_GIVEUP_MS + 2_000, 'receipt', {
      hash: SELL_HASH,
      result: { ok: false, gasWei: '49028', proceedsWei: null, remainingWei: '0', outOfGas: false, error: 'ERC20InsufficientAllowance' },
    }))
    const after = out.state.positions.get('buy-1')!
    expect(after.closed).toBe(false)
    expect(out.state.inflight.has(next!.intentId)).toBe(true)
    expect(after.inflightIntentId).toBe(next!.intentId)
    expect(after.attempts).toBe(1)
  })

  it('still pulls the receipt from a zero wallet after the inflight sell is gone', () => {
    const given = tick(withInflightSell(), T0 + SELL_SETTLE_GIVEUP_MS + 1_000).state
    const pos = given.positions.get('buy-1')!
    if (pos.inflightIntentId !== null) {
      given.inflight.delete(pos.inflightIntentId)
      pos.inflightIntentId = null
    }
    const out = decide(given, ev(T0 + SELL_SETTLE_GIVEUP_MS + 2_000, 'chain-read', {
      request: { kind: 'position-wallet', args: [TOKEN, 'buy-1'] },
      result: { balanceWei: '0' },
      viaKey: true, tries: 1, latencyMs: 1,
    }))
    expect(out.state.positions.get('buy-1')!.closed).toBe(false)
    expect(out.intents.some((i) => i.kind === 'read' && i.what === 'receipt' && i.args[0] === SELL_HASH)).toBe(true)
    expect(out.state.risk.reserved).toBe(1)
  })
})

describe('an exhausted bag is sold on the graduated venue, not left held', () => {
  const HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044'
  const pool = {
    currency0: '0x0000000000000000000000000000000000000000',
    currency1: TOKEN,
    fee: 10_000,
    tickSpacing: 200,
    hooks: HOOK,
  }

  function onVenue(): State {
    const s = withInflightSell()
    const pos = [...s.positions.values()][0]!
    pos.inflightIntentId = null
    pos.attempts = BOOK.exit.maxSellAttempts
    pos.inflightIntentId = null
    s.inflight.clear()
    pos.venue = 'graduated'
    pos.grad = freshGradState()
    s.inflight.clear()
    return s
  }

  it('asks the factory for the pool before it signs anything', () => {
    const { intents } = tick(onVenue(), T0 + 1)
    expect(intents.some((i) => i.kind === 'read' && i.what === 'grad-pool')).toBe(true)
    expect(intents.some((i) => i.kind === 'grad' || i.kind === 'sell')).toBe(false)
  })

  it('asks the factory to graduate when the token is still in phase 0 and the curve is ready', () => {
    const s = onVenue()
    const folded = decide(s, ev(T0 + 1, 'chain-read', {
      request: { kind: 'grad-pool', args: [TOKEN, CURVE] },
      result: { ok: true, phase: 0, ready: true, pool },
      viaKey: false, tries: 1, latencyMs: 0,
    }))
    expect([...folded.state.positions.values()][0]!.grad?.phase).toBe(0)
    const { intents } = tick(folded.state, T0 + 2)
    const g = intents.find((i) => i.kind === 'grad')
    expect(g).toMatchObject({ kind: 'grad', step: 'prepare-graduate', token: TOKEN })
  })

  it('does not send graduate while the curve itself says it is not ready', () => {
    const s = onVenue()
    const folded = decide(s, ev(T0 + 1, 'chain-read', {
      request: { kind: 'grad-pool', args: [TOKEN, CURVE] },
      result: { ok: true, phase: 0, ready: false, pool },
      viaKey: false, tries: 1, latencyMs: 0,
    }))
    const { intents } = tick(folded.state, T0 + 2)
    expect(intents.some((i) => i.kind === 'grad')).toBe(false)
  })

  it('reads the wallet once the factory says the pool is tradeable', () => {
    const s = onVenue()
    const folded = decide(s, ev(T0 + 1, 'chain-read', {
      request: { kind: 'grad-pool', args: [TOKEN, CURVE] },
      result: { ok: true, phase: 2, pool },
      viaKey: false, tries: 1, latencyMs: 0,
    }))
    const { intents } = tick(folded.state, T0 + 2)
    expect(intents.some((i) => i.kind === 'read' && i.what === 'grad-wallet')).toBe(true)
  })
})
