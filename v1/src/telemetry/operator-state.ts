import { FRESH_POLICY } from '../strategy/fresh-policy.js'
import type { HaltKind } from '../strategy/risk.js'
import { ddWarnPct, ddCritPct, ALERT_LEVELS } from './levels.js'

export type Guard = {
  id: string; name: string; status: 'pass' | 'watch' | 'halt' | 'unknown'; blocking: boolean
  reading: number | null; unit: string; stopAt: number; stopOperator: '<' | '<=' | '>='
  clearAt: number | null; clearOperator: '>' | '>=' | null; clearText: string
  n: number | null; required: number | null; ageMs: number | null; detail: string; margin: number | null; recentReading?: number | null;
  policy?: {id:string;source:string;window:number;recoveryWindow:number;pauseBelow:number;recoverAbove:number;freshMs:number;configId?:string;fullRecoverAbove?:number;requiresNewPublication?:boolean}; publicationAt?: number | null
}
export type OperatorInput = {
  now: number; mode: string; kinds: HaltKind[]; reasons: Array<{ kind: HaltKind; reason: string; since: number | null }>
  drawdownEth: number; limitEth: number; open: number; databaseOpen: number; capacity: number
  deployedEth: number; bankrollEth: number; tradeSizeEth: number
  logsHealthy: boolean; logsAgeMs: number; logsLimitMs: number; lastEntryAt: number | null
  market: { sum: number; n: number; fresh: boolean; oldestAgeMs: number; ageMs: number; state: string;
    source?: string; recentSum?: number; observerError?: string | null; verified?: boolean; publicationAt?: number | null; pending?: number; configId?:string;
    policyId?:string;window?:number;recoveryWindow?:number;recoveryOn?:number;fullRecoveryOn?:number;recoveryMode?:'fresh'|'full'|'both';sumRange?:[number,number]|null;recentSumRange?:[number,number]|null;reason?:string } | null
  marketBar?: number; marketWindow: number; marketOff: number; marketOn: number; marketFreshMs: number
  touch: { rate: number; n: number; stale?: string | null; state: string; dataAgeMs: number | null; ageMs: number } | null
  touchBar?: number; touchHoldMs?: number; touchWindow: number; touchOff: number; touchOn: number
  execution: { gapPp: number; n: number; at?: number; realPp?: number; replayPp?: number } | null
  executionFactor?: number; executionWindow: number; executionLimit: number
  recovery: { n: number; sum: number; at: number } | null
  recoveryError?: string | null; recoveryWindow: number; recoveryOn: number; liftsUsed: number; liftsLimit: number
  operatorRecoveryPending?: boolean
}

/** Presentation of the decision owners' readings. This function never places or lifts a halt. */
export function operatorState(x: OperatorInput) {
  const has = (kind: HaltKind) => x.kinds.includes(kind)
  const m = x.market, e = x.execution, t = x.touch
  const adaptive = m?.source === 'adaptive-shadow'
  const scenarios = m?.source === 'conservative-paper'
  const guards: Guard[] = [
    { id: 'venue', name: 'Market return', blocking: has('venue'), status: !m?.fresh || m.observerError || m.verified === false ? 'unknown' : has('venue') ? 'halt' : 'pass',
      recentReading: m?.recentSum ?? null, policy: scenarios ? {id:m.policyId??'unverified-scenario-release',source:'conservative-paper',window:x.marketWindow,recoveryWindow:m.recoveryWindow??0,pauseBelow:x.marketOff,recoverAbove:x.marketOn,fullRecoverAbove:m.fullRecoveryOn,freshMs:x.marketFreshMs,configId:m.configId,requiresNewPublication:true} : adaptive ? {...FRESH_POLICY,configId:m?.configId} : undefined, publicationAt: m?.publicationAt, reading: m?.sum ?? null, unit: 'stakes', stopAt: x.marketOff, stopOperator: '<', clearAt: adaptive || scenarios ? null : x.marketOn, clearOperator: adaptive || scenarios ? null : '>',
      clearText: scenarios ? `Every scenario: ${m.recoveryMode==='full'?`main ${m.window} above ${m.fullRecoveryOn} stakes`:`latest ${m.recoveryWindow} above ${m.recoveryOn} stakes${m.fullRecoveryOn===undefined?'':` and main ${m.window} above ${m.fullRecoveryOn} stakes`}`}; new complete publication required` : adaptive ? `New evidence with latest ${FRESH_POLICY.recoveryWindow} above +${FRESH_POLICY.recoverAbove} stake; ${FRESH_POLICY.window} fresh outcomes required` : `Above ${x.marketOn} stakes, or no fresh window under the current rule`, n: m?.n ?? 0, required: x.marketWindow,
      ageMs: m?.ageMs ?? null, margin: m?.fresh ? m.sum - x.marketOff : null,
      detail: scenarios ? `Six execution scenarios with pinned adaptive TP. Main ${m.sumRange?.map(v=>v.toFixed(2)).join(' to ')??'unavailable'} stakes; fresh ${m.recentSumRange?.map(v=>v.toFixed(2)).join(' to ')??'unavailable'} stakes. ${m.observerError??m.reason}. Actual wallet cash is separate.` : adaptive ? `Adaptive shadow returns after modeled costs. Latest ${FRESH_POLICY.recoveryWindow}: ${m?.recentSum?.toFixed(2) ?? 'unavailable'} stakes. ${m?.observerError ?? (m?.fresh ? 'Fresh evidence.' : 'Warming up or stale; entries remain paused.')} Actual wallet cash is separate.` : !m ? 'No reading; this guard keeps its existing state' : !m.fresh
        ? `No fresh signal: ${m.n}/${x.marketWindow} launches; oldest ${(m.oldestAgeMs / 3600000).toFixed(1)}h, limit ${x.marketFreshMs / 3600000}h. This can release the market pause.`
        : `Replay return at ${x.marketBar ?? 'the recorded'}x for screened launches meeting the tax and exemption floors. One stake is one trade-sized investment; this is not booked P&L.` },
    { id: 'broken', name: 'Execution quality', blocking: has('broken'), status: has('broken') ? 'halt' : !e ? 'unknown'
        : e.gapPp <= -x.executionLimit * ALERT_LEVELS.brokenWarnFraction ? 'watch' : 'pass',
      reading: e?.gapPp ?? null, unit: 'pp', stopAt: -x.executionLimit, stopOperator: '<=', clearAt: null, clearOperator: null,
      clearText: 'Investigate the fault, then restart the process while flat', n: e?.n ?? 0, required: x.executionWindow,
      ageMs: e?.at ? Math.max(0, x.now - e.at) : null, margin: e ? e.gapPp + x.executionLimit : null,
      detail: `Actual return minus adjusted replay of the same coins${x.executionFactor === undefined ? '' : ` (replay factor ${x.executionFactor})`}. Negative means worse execution. This stop never lifts itself.` },
    { id: 'drawdown', name: 'Drawdown', blocking: has('drawdown'), status: has('drawdown') ? 'halt'
        : x.limitEth > 0 && x.drawdownEth / x.limitEth * 100 >= ddWarnPct ? 'watch' : 'pass',
      reading: x.drawdownEth, unit: 'ETH', stopAt: x.limitEth, stopOperator: '>=', clearAt: null, clearOperator: null,
      clearText: 'Complete post-stop evidence, flat book and recovery allowance', n: null, required: null, ageMs: 0,
      margin: Math.max(0, x.limitEth - x.drawdownEth), detail: 'Realized drawdown from the accounting-period peak; open marks do not set this bound' },
    { id: 'gate', name: 'Touch-rate check', blocking: has('gate'), status: has('gate') ? 'halt' : !t || t.stale ? 'unknown' : 'pass',
      reading: t?.rate ?? null, unit: '%', stopAt: x.touchOff, stopOperator: '<=', clearAt: x.touchOn, clearOperator: '>=',
      clearText: `At least ${x.touchOn}% and a readable watcher`, n: t?.n ?? 0, required: x.touchWindow,
      ageMs: t?.ageMs ?? null, margin: t && !t.stale ? t.rate - x.touchOff : null,
      detail: t?.stale || `This safety check is still active${x.touchBar === undefined ? '' : `: launches reaching ${x.touchBar}x within ${(x.touchHoldMs ?? 0) / 1000}s`}. Watcher failure can also place its stop.` },
  ]
  for (const guard of guards) {
    const ownerOpen = guard.id === 'venue' ? m?.state === 'open' : guard.id === 'gate' ? t?.state === 'open' && !t.stale : false
    if (guard.blocking && ownerOpen && x.kinds[0] !== guard.id) guard.detail += ' Its clearing condition is met, but a higher-priority stop still prevents this guard clearing.'
  }
  const recoveryChecks = [
    { id: 'flat', label: 'Flat in memory and database, with no pending buys', ok: x.open === 0 && x.databaseOpen === 0 },
    { id: 'sample', label: `${x.recovery?.n ?? 0} / ${x.recoveryWindow} post-stop launches scored`, ok: (x.recovery?.n ?? 0) >= x.recoveryWindow },
    { id: 'return', label: `Full window must earn above ${x.recoveryOn} stakes`, ok: !!x.recovery && x.recovery.n >= x.recoveryWindow && x.recovery.sum > x.recoveryOn },
    { id: 'allowance', label: `${x.liftsUsed} / ${x.liftsLimit} automatic recoveries used today`, ok: x.liftsUsed < x.liftsLimit },
    { id: 'priority', label: 'No manual configuration stop or execution fault', ok: !has('manual') && !has('broken') },
    { id: 'live', label: 'Live trading mode', ok: x.mode === 'live' },
  ]
  const recovery = has('drawdown') ? {
    n: x.recovery?.n ?? 0, required: x.recoveryWindow, sum: x.recovery?.sum ?? null,
    at: x.recovery?.at ?? null, complete: (x.recovery?.n ?? 0) >= x.recoveryWindow,
    budgetResetAt: (Math.floor(x.now / 86400000) + 1) * 86400000,
    threshold: x.recoveryOn, checks: recoveryChecks,
    lastError: x.recoveryError ?? null,
    canClear: recoveryChecks.every(c => c.ok) && !x.recoveryError, remainingBlockers: x.kinds.filter(k => k !== 'drawdown'),
    note: `Recovery uses the separate fixed ${x.marketBar ?? 'recorded'}x target, not adaptive shadow returns. Clearing drawdown opens a new accounting period. Other active stops still apply. Future results determine the wait; no restart time is promised.`,
  } : null
  const waiting = x.mode !== 'live' ? `${x.mode === 'shadow' ? 'Shadow simulation' : 'Observe mode'}: no transactions are broadcast` : !x.logsHealthy ? 'Authoritative log stream is unhealthy'
    : x.logsAgeMs > x.logsLimitMs ? 'Authoritative logs are stale'
    : x.open >= x.capacity ? 'All position slots are occupied'
    : x.bankrollEth - x.deployedEth < x.tradeSizeEth ? 'Available capital is below one trade size' : null
  const needsYou = has('manual') || has('broken') || has('stopped') || has('drawdown') && x.liftsUsed >= x.liftsLimit
  const status = x.kinds.length ? needsYou ? 'needs-you' : 'paused' : waiting ? 'waiting' : 'enabled'
  const why = x.kinds.length ? x.reasons.map(r => r.reason).join('; ')
    : waiting ?? 'No active stops; data healthy and capacity available. Waiting for qualifying launches.'
  const warnings = guards.filter(g => g.status === 'watch').map(g => `${g.name}: ${g.margin?.toFixed(g.unit === 'ETH' ? 4 : 2)} ${g.unit} to its halt threshold`)
  return { at: x.now, status, why, guards, blockers: x.reasons, recovery,
    outlook: warnings.length ? warnings.join(' · ') : x.kinds.length ? 'Entries resume only after every active blocker clears' : guards.some(g => g.status === 'unknown') ? 'Some guards have no current verdict; check the evidence before interpreting the market' : 'No guard is in its warning band; future results can change this',
    controls: { stopped: has('stopped'), canStart: x.kinds[0] === 'stopped', stopAvailable: !has('stopped'),
      recoveryPending: x.operatorRecoveryPending ?? false },
    capacity: { open: x.open, limit: x.capacity, freeEth: Math.max(0, x.bankrollEth - x.deployedEth) },
    logsHealthy: x.logsHealthy && x.logsAgeMs <= x.logsLimitMs, lastEntryAt: x.lastEntryAt,
    drawdownPercent: x.limitEth > 0 ? 100 * x.drawdownEth / x.limitEth : null, drawdownCriticalPercent: ddCritPct }
}
export type OperatorState = ReturnType<typeof operatorState>
