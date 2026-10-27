import type Database from 'better-sqlite3'
import { MODEL_HASH } from './identity.js'
import { digest } from './store.js'
import { replayScenarios, type ExecutionBundle } from '../strategy/execution-scenarios.js'
import type { ExecutionRequest, TimingModel } from '../strategy/execution-model.js'
import { adaptiveTakeProfit, barKey, type BarOutcomes } from '../strategy/takeprofit.js'

/** All targets use the same frozen inputs. No actual outcome enters selection. */
export function replayTargets(request: ExecutionRequest, timings: readonly TimingModel[], targets: readonly number[]) {
  const bundles: Record<string, ExecutionBundle> = {}
  for (const target of targets) {
    if (!Number.isFinite(target) || target <= 1 || bundles[barKey(target)]) throw new Error('invalid selector targets')
    bundles[barKey(target)] = replayScenarios({ ...request, takeProfit: target }, timings)
  }
  const complete = targets.length > 0 && Object.values(bundles).every(b => b.complete)
  const size = BigInt(request.sizeWei)
  const scores: Record<string, number> = {}
  if (complete && size > 0n) for (const [key, bundle] of Object.entries(bundles)) {
    scores[key] = Number(bundle.scenarios.find(s => s.id === 'p50-after')!.result.pnlWei) / Number(size)
  }
  return { bundles, scores, complete: complete && size > 0n,
    closedThrough: complete ? Math.max(...Object.values(bundles).map(b => b.closedThrough!)) : null,
    scenario: 'p50-after' as const, source: 'shared-execution-targets' as const }
}
/** Persist the shared base request once in scenario_results, then only target deltas. */
export function compactTargets(value: ReturnType<typeof replayTargets>) {
  const {bundles,...metadata}=value
  return {...metadata,results:Object.fromEntries(Object.entries(bundles).map(([key,b])=>[key,b.scenarios.map(s=>({id:s.id,result:s.result}))]))}
}
export type SelectorSnapshot = {
  modelHash: string; configId: string; at: number; publicationAt: number | null;
  rows: BarOutcomes[]; evidenceIds: string[]; complete: boolean; failure: string | null;
  source: 'shared-execution-targets'; scenario: 'p50-after'; window: number;
  blockingIds?: string[];
}
export const SELECTOR_SETTLE_MS = 190000
export type SelectorCandidate = {id:string;at:number;block:number;token:string;configId:string;availableAt:number|null;scores:BarOutcomes|null}
/** Choose the required population before checking completeness. Never replace a missing member. */
export function selectorEvidence(candidates:readonly SelectorCandidate[],configId:string,now:number,window:number,keys:readonly string[]) {
  const required=candidates.filter(r=>r.configId===configId&&r.at<=now
    &&(r.availableAt!==null&&r.availableAt<=now||r.at+SELECTOR_SETTLE_MS<now))
    .sort((a,b)=>b.block-a.block||b.token.localeCompare(a.token)||b.id.localeCompare(a.id)).slice(0,window)
  const blocking=required.filter(r=>r.availableAt===null||r.availableAt>now||!r.scores||keys.some(k=>!Number.isFinite(r.scores![k])))
  const visible=required.filter(r=>!blocking.includes(r))
  const complete=required.length===window&&blocking.length===0
  return {rows:visible.map(r=>r.scores!),evidenceIds:required.map(r=>r.id),blockingIds:blocking.map(r=>r.id),complete,
    publicationAt:visible.length?Math.max(...visible.map(r=>r.availableAt!)):null,
    failure:blocking.length?'selector_unresolved_execution':!complete?'selector_warmup':null}
}
/** Includes book-passing launches before trading filters, capacity and template exclusions. */
export function selectorSnapshot(db: Database.Database, now: number): SelectorSnapshot | null {
  const latest = db.prepare("SELECT payload FROM captures WHERE kind='opportunity' AND substr(session,-64)=? AND at<=? ORDER BY at DESC,session DESC,sequence DESC LIMIT 1").get(MODEL_HASH, now) as {payload:string}|undefined
  if (!latest) return null
  const config = JSON.parse(latest.payload).config, configId = digest(config), window = config.targetPolicy.adaptive.window
  const candidates = db.prepare(`SELECT c.session||':'||c.sequence id,c.at,c.payload,json_extract(s.payload,'$.scores') scored,s.available_at FROM captures c
    LEFT JOIN selector_results s ON s.id=c.session||':'||c.sequence AND s.model=?
    WHERE c.kind='opportunity' AND substr(c.session,-64)=? AND c.at<=?
    ORDER BY c.at DESC,c.session DESC,c.sequence DESC`).all(MODEL_HASH, MODEL_HASH, now) as any[]
  const compatible = candidates.map(r=>({...r,capture:JSON.parse(r.payload)})).filter(r => digest(r.capture.config) === configId)
  const keys = config.targetPolicy.adaptive.bars.map(barKey)
  const evidence=selectorEvidence(compatible.map(r=>({id:r.id,at:r.at,block:r.capture.launch.block,token:r.capture.launch.token,
    configId,availableAt:r.available_at,scores:r.scored?JSON.parse(r.scored):null})),configId,now,window,keys)
  return { modelHash: MODEL_HASH, configId, at: now, ...evidence,
    source: 'shared-execution-targets', scenario: 'p50-after', window }
}
export function selectSharedTarget(snapshot: SelectorSnapshot | null | undefined, configId: string, now: number,
  heartbeatAt: number, policy: {adaptive:{window:number;bars:readonly number[]};otherwise:number;maxRateAgeMs:number}) {
  const valid = !!snapshot && snapshot.modelHash === MODEL_HASH && snapshot.configId === configId && snapshot.complete
    && snapshot.at <= now && heartbeatAt <= now && now-heartbeatAt <= Math.min(15000,policy.maxRateAgeMs)
  return { ...adaptiveTakeProfit(valid ? snapshot!.rows : null, policy.adaptive.window, policy.adaptive.bars, policy.otherwise),
    source: 'shared-execution-targets', ready: valid, failure: valid ? null : snapshot?.failure ?? 'selector_unavailable' }
}
/** Admission is pinned at capture time; later target scores cannot retroactively open it. */
export function capturedTarget(capture:any,at:number) {
  if(!capture?.config?.targetPolicy?.adaptive)return {multiple:null,ready:false,failure:'missing_pinned_target_policy',source:'shared-execution-targets'}
  const selected=selectSharedTarget(capture.selector,digest(capture.config),at,capture.selectorHeartbeatAt??0,capture.config.targetPolicy)
  // THE ONE INVARIANT: replay the take profit the bot ACTUALLY TRADED on this launch. A
  // replay at any other rung is not a measurement of this book, and the whole point of the
  // paper account is that it is comparable to the real one.
  if(selected.ready&&capture.takeProfit?.ready===true&&capture.takeProfit.multiple===selected.multiple){
    return {...selected,ready:true,failure:null}
  }
  /**
   * The bot did not trade the shared selector's target here, because another sensor was
   * driving the take profit. Replay WHAT IT DID TRADE rather than refusing.
   *
   * Refusing was the old behaviour and it is how the measurement went dark on 2026-09-16:
   * `pickTakeProfit` switches source on VENUE_EXECUTION_SCENARIOS (bot.ts), so flipping that
   * guard off to get the bot trading again silently made every capture mismatch. Measured on
   * the box: 132 admissions `eligible` up to 06:55:22, then every one `pinned_target_mismatch`
   * and not one scenario bundle written afterwards. The paper wallet, the coins strip and the
   * indicator's evidence tape all froze, and the dashboard went on drawing the frozen tape as
   * though it were live. A guard reading a tape that stopped is worse than a guard with no
   * tape, because it looks like an opinion.
   *
   * This is NOT a relaxation of the invariant above: the multiple used here is the one the
   * live decision recorded. It is a relaxation of WHERE that multiple is allowed to come from.
   * The source rides along so the admission audit says which, and a capture with no definite
   * multiple is still refused.
   */
  const live=capture.takeProfit?.multiple
  // STILL NEVER A FALLBACK. `ready` on the captured decision means the live bot picked this
  // multiple from evidence; a flat-fallback guess is refused here exactly as before. Only the
  // SOURCE restriction is lifted, not the evidence requirement.
  if(capture.takeProfit?.ready===true&&typeof live==='number'&&Number.isFinite(live)&&live>0){
    return {multiple:live,ready:true,failure:null,source:'live-take-profit' as const}
  }
  return {...selected,ready:false,failure:selected.failure??'pinned_target_mismatch'}
}
