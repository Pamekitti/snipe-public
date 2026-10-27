/** Pure execution kernel shared by research and the live shadow account. */
import { EVENT_TOPICS, logWord } from '../abi.js'
import { freshCurve, simBuy, simSell, markToExit, graduationProgress, type CurveParams, type CurveState } from '../state/curve.js'
import { evaluate } from './exit-evaluation.js'

export const fields = [
  "phantomQuote",
  "reservedTokens",
  "launchSupply",
  "feeBps",
  "creatorTaxBps",
  "snipeTaxStartBps",
  "snipeTaxSeconds",
  "launchedAt",
] as const;
export type Raw = {
  blockNumber: string;
  logIndex: string;
  transactionHash: string;
  topics: string[];
  data: string;
  address: string;
  at?: number;
};
export const params = (r: any): CurveParams =>
  Object.fromEntries(fields.map((k) => [k, BigInt(r[k])])) as CurveParams;
export const ordered = (logs: Raw[]) =>
  [
    ...new Map(
      logs.map((l) => [`${l.transactionHash}:${l.logIndex}`, l]),
    ).values(),
  ].sort(
    (a, b) =>
      Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
      Number(BigInt(a.logIndex) - BigInt(b.logIndex)),
  );
export function apply(s: CurveState, l: Raw): CurveState {
  const w = (n: number) => logWord(l.data, n);
  switch (l.topics[0]) {
    case EVENT_TOPICS.CurveBuy:
      return {
        ...s,
        trackedQuote: s.trackedQuote + w(0),
        trackedTokens: s.trackedTokens - w(1),
        quoteFeeBalance: s.quoteFeeBalance + w(2),
        creatorTaxBalance: s.creatorTaxBalance + w(3),
      };
    case EVENT_TOPICS.CurveSell:
      return {
        ...s,
        trackedQuote: s.trackedQuote - w(1),
        trackedTokens: s.trackedTokens + w(0),
        quoteFeeBalance: s.quoteFeeBalance + w(2),
        creatorTaxBalance: s.creatorTaxBalance + w(3),
      };
    case EVENT_TOPICS.BuybackLocked:
      return { ...s, trackedTokens: s.trackedTokens - w(1) };
    case EVENT_TOPICS.FeesSwept:
      return {
        ...s,
        trackedQuote: s.trackedQuote - w(0) - w(2),
        quoteFeeBalance: 0n,
        creatorTaxBalance: 0n,
      };
    case EVENT_TOPICS.FeesRescued:
      return {
        ...s,
        trackedQuote: s.trackedQuote - w(0) - w(1),
        quoteFeeBalance: 0n,
        creatorTaxBalance: 0n,
      };
    case EVENT_TOPICS.CurveCompleted:
      return { ...s, trackedQuote: 0n, trackedTokens: 0n, graduated: true };
    default:
      return s;
  }
}
export function replay(r: any) {
  const p = params(r.params);
  let s = freshCurve(p);
  const wallet = (r.wallet ?? "").toLowerCase().replace("0x", "");
  const recorded = r.mode === "recorded_fill";
  const all = ordered(r.logs).map((l) => ({
    ...l,
    at: l.at ?? Number(r.blocks?.[l.blockNumber]?.timestamp) * 1000,
  }));
  const ours = (l: Raw) =>
    Boolean(wallet) &&
    l.topics.slice(1, 3).some((t) => t.slice(-40).toLowerCase() === wallet);
  const logs = recorded ? all : all.filter((l) => !ours(l));
  if (logs.some((l) => !Number.isFinite(l.at)))
    return { status: "missing_block_time" };
  const size = BigInt(r.sizeWei),
    entry = r.entryAt,
    buyAt = r.buyAt ?? entry,
    openedAt = r.openedAt ?? entry,
    lag = r.sellDelayMs ?? 600;
  let i = 0,
    firstTick = entry;
  let tokens: bigint;
  let spent: bigint;
  if (recorded) {
    const boundary = logs.findIndex(
      (l) =>
        l.transactionHash.toLowerCase() === String(r.buyHash).toLowerCase() &&
        l.topics[0] === EVENT_TOPICS.CurveBuy,
    );
    if (boundary < 0) return { status: "missing_actual_buy_event" };
    while (i <= boundary) s = apply(s, logs[i++]!);
    const fill = logs[boundary]!;
    tokens = logWord(fill.data, 1);
    spent = logWord(fill.data, 0);
    firstTick = Math.max(entry, fill.at);
  } else {
    firstTick = Math.max(buyAt, openedAt);
    while (i < logs.length && logs[i]!.at < entry) s = apply(s, logs[i++]!);
    try {
      if (r.maxEntryMultiple) {
        const decision = simBuy(p, s, size, BigInt(Math.floor(buyAt / 1000)), {
          exempt: r.exempt ?? false,
        });
        const fresh = simBuy(
          p,
          freshCurve(p),
          size,
          BigInt(Math.floor(buyAt / 1000)),
          { exempt: r.exempt ?? false },
        );
        if (Number(fresh.tokensOut) / Number(decision.tokensOut) > r.maxEntryMultiple)
          return { status: "entry_price_rejected" };
      }
      while (i < logs.length && logs[i]!.at < buyAt) s = apply(s, logs[i++]!);
      const z = simBuy(p, s, size, BigInt(Math.floor(buyAt / 1000)), {
        exempt: r.exempt ?? false,
      });
      s = z.next;
      tokens = z.tokensOut;
      spent = z.spent;
    } catch (e) {
      return {
        status: "buy_reverted",
        error: String(e),
        pnlWei: -BigInt(r.buyGasWei ?? 0),
        exitAt: buyAt,
      };
    }
  }
  const pos = {
    exiting: false,
    peakMarkWei: recorded ? BigInt(r.entryMarkWei) : markToExit(p, s, tokens),
    id: 1,
    token: r.token,
    curve: r.curve,
    tokens,
    spendWei: spent,
    entryMarkWei: recorded ? BigInt(r.entryMarkWei) : markToExit(p, s, tokens),
    openedAt,
    buyHash: r.buyHash ?? "",
    filled: true,
    takeProfitMultiple: r.takeProfit,
    rules: r.rules,
  };
  const end = r.endAt ?? entry + 180000;
  let pending: number | null = null;
  let reason: string | null = null;
  const trace: any[] = [];
  const interval = r.pollMs ?? 500;
  for (let at = firstTick; at <= end; at += interval) {
    while (i < logs.length && logs[i]!.at <= at) {
      const l = logs[i++]!;
      const ours = (r.wallet ?? "").toLowerCase().replace("0x", "");
      if (
        ours &&
        l.topics.slice(1, 3).some((t) => t.slice(-40).toLowerCase() === ours)
      )
        continue;
      // Fixed external order quantities, recomputed against candidate reserves.
      try {
        if (recorded) s = apply(s, l);
        else if (
          l.topics[0] === EVENT_TOPICS.CurveCompleted &&
          !s.graduated &&
          s.trackedTokens > p.reservedTokens
        )
          return { status: "graduation_path_diverged", at, trace };
        else if (l.topics[0] === EVENT_TOPICS.CurveBuy)
          s = simBuy(
            p,
            s,
            logWord(l.data, 0),
            BigInt(Math.floor(l.at / 1000)),
            {
              exempt:
                logWord(l.data, 2) === (logWord(l.data, 0) * p.feeBps) / 10000n,
            },
          ).next;
        else if (l.topics[0] === EVENT_TOPICS.CurveSell)
          s = simSell(p, s, logWord(l.data, 0)).next;
        else s = apply(s, l);
      } catch {
        return {
          status: "external_order_unresolved",
          at,
          token: r.token,
          trace,
        };
      }
    }
    if (pending !== null && at >= pending) {
      try {
        const z = simSell(p, s, tokens);
        return {
          status: "closed",
          entryAt: entry,
          exitAt: at,
          tokens,
          spent,
          pnlWei: z.quoteOut - spent - BigInt(r.gasWei ?? 0),
          proceedsWei: z.quoteOut,
          reason,
          trace,
        };
      } catch {
        return {
          status: "pool_required",
          entryAt: entry,
          at,
          tokens,
          spent,
          reason,
          trace,
          assumption:
            "candidate curve state requires historical-pool compatibility check",
        };
      }
    }
    if (pending === null) {
      const mark = markToExit(p, s, tokens);
      reason = evaluate(
        pos,
        mark,
        at,
        s.graduated || graduationProgress(p, s) <= 0.12,
      );
      if (reason) {
        trace.push({ at, reason, mark });
        if (recorded)
          return {
            status: "decision",
            decisionAt: at,
            reason,
            mark,
            tokens,
            spent,
            trace,
          };
        pending = at + lag;
      }
    }
  }
  return { status: "incomplete_path", tokens, spent, trace };
}

// Version 3 is separate from the historical replay API above. Saved results stay immutable.
import { CurveRevert } from '../state/curve.js'
import { poolReplayHash } from './pool-evidence.js'
import { EXECUTION_VERSION, EVIDENCE_VERSION, compareOrder, type ExecutionRequest, type ExecutionResult, type ExecutionLog } from './execution-model.js'
export type { ExecutionRequest, ExecutionResult } from './execution-model.js'


/** A refunded fill reports spend, not the external order's original budget. */
function externalBuyAmount(l: ExecutionLog): bigint {
  if (!l.externalBuy) return logWord(l.data,0)
  const q=l.externalBuy
  if (!/^[a-f0-9]{64}$/.test(q.traceHash) || !/^\d+$/.test(q.quoteInWei) || !/^\d+$/.test(q.minTokensOut)
    || BigInt(q.quoteInWei)<logWord(l.data,0)) throw new Error('invalid_external_buy_input')
  return BigInt(q.quoteInWei)
}

/** Independent prediction. Actual receipts and fills are deliberately absent from its request. */
export function predictExecution(r: ExecutionRequest, research?: { allowPoolQuote: true }): ExecutionResult {
  const out: ExecutionResult = { modelVersion:EXECUTION_VERSION, evidenceVersion:EVIDENCE_VERSION,
    status:'unavailable', reason:'invalid_request', entryAt:r.entryAt, exitAt:null, decisionAt:null,
    tokens:null, spentWei:null, proceedsWei:null, pnlWei:null, costsWei:'0', scenario:r.timing.kind==='scenario'?r.timing.label:null,
    trace:[], assumption:'External traders retain historical order quantities' }
  const unknown = (reason:string) => ({...out,status:'unavailable' as const,reason,pnlWei:null})
  try {
    if (r.researchPoolQuote && !research?.allowPoolQuote) return unknown('research_pool_quote_not_allowed')
    if (r.modelVersion!==EXECUTION_VERSION || r.evidenceVersion!==EVIDENCE_VERSION || !r.strategyVersion) return unknown('version_mismatch')
    if (!r.coverage.complete || !r.coverage.independentlyChecked || r.coverage.gaps.length || r.coverage.from>r.seed.at || r.coverage.through<r.endAt) return unknown('source_gap')
    if (r.seed.observedAt>r.entryAt || r.seed.at>r.entryAt || r.timing.frozenAt>r.entryAt || r.timing.fitThrough>r.timing.frozenAt) return unknown('noncausal_input')
    const inclusionMs=r.timing.buyInclusionMs??0
    const orderFraction=r.timing.buyOrderFraction
    if(orderFraction!==undefined&&(!Number.isFinite(orderFraction)||orderFraction<0||orderFraction>1||r.timing.kind!=='scenario'))return unknown('invalid_modeled_buy_order')
    if (![r.entryAt,r.endAt,r.pollMs,r.timing.sendMs,r.timing.confirmationMs,r.timing.sellMs,r.costs.retryMs,r.costs.approvalDelayMs,inclusionMs].every(Number.isFinite)
      || r.pollMs<=0 || r.endAt<=r.entryAt || r.endAt-r.entryAt>3600_000 || r.timing.sendMs<0 || r.timing.confirmationMs<0 || r.timing.sellMs<0
      || inclusionMs<0 || r.costs.retryMs<0 || r.costs.approvalDelayMs<0 || !Number.isInteger(r.costs.maxSellAttempts) || r.costs.maxSellAttempts<1
      || !Number.isInteger(r.costs.failedSellAttempts) || r.costs.failedSellAttempts<0) return unknown('invalid_timing_or_costs')
    const p=params(r.params), size=BigInt(r.sizeWei), minimum=BigInt(r.minTokens)
    if (size<=0n || minimum<=0n || BigInt(r.entryQuoteTokens)<minimum || !Number.isFinite(r.maxEntryMultiple) || r.maxEntryMultiple<=0) return unknown('invalid_entry_intent')
    let costs=BigInt(r.costs.buyWei)
    if ([r.costs.buyWei,r.costs.approvalWei,r.costs.sellWei,r.costs.failedSellWei].some(x=>BigInt(x)<0n)) return unknown('invalid_costs')
    const seen=new Map<string,ExecutionLog>()
    for(const l of r.logs) {
      if (!Number.isFinite(l.at) || !Number.isFinite(l.observedAt) || l.observedAt<l.at
        || !Object.values(l.order).every(v=>Number.isSafeInteger(v)&&v>=0)) return unknown('missing_event_order_or_observation')
      const key=`${l.transactionHash.toLowerCase()}:${l.logIndex}`
      const old=seen.get(key)
      if(old && JSON.stringify(old)!==JSON.stringify(l)) return unknown('conflicting_duplicate')
      seen.set(key,l)
    }
    const wallet=r.wallet.toLowerCase().replace('0x','')
    const isOwn=(l:ExecutionLog)=>!!wallet && l.topics.slice(1,3).some(t=>t.slice(-40).toLowerCase()===wallet)
    const sourceLogs=[...seen.values()].filter(l=>compareOrder(l.order,r.seed.order)>0).sort((a,b)=>compareOrder(a.order,b.order))
    const firstExcluded=sourceLogs.find(isOwn)?.order
    const logs=sourceLogs.filter(l=>!isOwn(l))
    if(logs.some((l,i)=>i>0 && l.at<logs[i-1]!.at)) return unknown('inconsistent_chain_clock')
    const sentAt=r.entryAt+r.timing.sendMs, buyAt=sentAt+inclusionMs
    const confirmedAt=Math.max(sentAt+r.timing.confirmationMs,buyAt)
    if(confirmedAt>r.endAt)return unknown('buy_inclusion_outside_coverage')
    const knownBeforeEntry=logs.findLastIndex(l=>l.observedAt<=r.entryAt)
    if(orderFraction===undefined&&logs.some((l,index)=>index>knownBeforeEntry&&l.at<=buyAt&&buyAt<l.at+(l.timeResolutionMs??1))&&r.timing.sameTimeOrder==='unavailable')return unknown('ambiguous_buy_order')
    let s={...r.seed.state,trackedQuote:BigInt(r.seed.state.trackedQuote),trackedTokens:BigInt(r.seed.state.trackedTokens),quoteFeeBalance:BigInt(r.seed.state.quoteFeeBalance),creatorTaxBalance:BigInt(r.seed.state.creatorTaxBalance)}, i=0
    // Removing an earlier wallet order also changes subsequent external fills.
    let beforeBuy=logs.findLastIndex(l=>l.at+(l.timeResolutionMs??1)<=buyAt||l.observedAt<=r.entryAt||l.at<=buyAt&&r.timing.sameTimeOrder==='after')
    if(orderFraction!==undefined){
      let certain=logs.findLastIndex(l=>l.at+(l.timeResolutionMs??1)<=buyAt||l.observedAt<=r.entryAt)
      const transaction=(l:ExecutionLog)=>`${l.order.block}:${l.order.transaction}:${l.transactionHash}`
      if(certain>=0){const key=transaction(logs[certain]!);certain=logs.findLastIndex(l=>transaction(l)===key)}
      const ends=new Map<string,number>()
      logs.forEach((l,index)=>{if(l.at<=buyAt&&buyAt<l.at+(l.timeResolutionMs??1))ends.set(transaction(l),index)})
      const bucket=[...ends.values()]
      const count=Math.min(bucket.length,Math.floor(orderFraction*bucket.length+0.5))
      beforeBuy=Math.max(certain,count>0?bucket[count-1]!:-1)
    }
    while(i<=beforeBuy) {
      const l=logs[i++]!
      if(firstExcluded && compareOrder(l.order,firstExcluded)>0) {
        if(l.topics[0]===EVENT_TOPICS.CurveBuy)s=simBuy(p,s,externalBuyAmount(l),BigInt(Math.floor(l.at/1000)),{exempt:logWord(l.data,2)===(logWord(l.data,0)*p.feeBps)/10000n,...(l.externalBuy?{minTokensOut:BigInt(l.externalBuy.minTokensOut)}:{})}).next
        else if(l.topics[0]===EVENT_TOPICS.CurveSell)s=simSell(p,s,logWord(l.data,0)).next
        else if(l.topics[0]===EVENT_TOPICS.CurveCompleted&&!s.graduated&&s.trackedTokens>p.reservedTokens)return unknown('graduation_path_diverged_before_entry')
        else s=apply(s,l)
      } else s=apply(s,l)
    }
    const fresh=simBuy(p,freshCurve(p),size,BigInt(Math.floor(sentAt/1000)))
    // The price guard is evaluated from the submitted quote. The contract enforces minTokens at execution.
    if(Number(fresh.tokensOut)/Number(BigInt(r.entryQuoteTokens))>=r.maxEntryMultiple)
      return {...out,status:'rejected',reason:'entry_price_rejected',exitAt:r.entryAt,pnlWei:'0'}
    let fill: ReturnType<typeof simBuy>
    try {
      fill=simBuy(p,s,size,BigInt(Math.floor(buyAt/1000)))
      if(fill.tokensOut<minimum) throw new Error('minimum_tokens')
    } catch(e) {
      return {...out,status:'buy_reverted',reason:String(e),exitAt:confirmedAt,pnlWei:String(-costs),costsWei:String(costs),tokens:'0',spentWei:'0',proceedsWei:'0'}
    }
    s=fill.next; out.tokens=String(fill.tokensOut); out.spentWei=String(fill.spent)
    const externalAfterBuy=logs.slice(i)
    let sellReplayThrough = logs[beforeBuy]?.order ?? r.seed.order
    // Observation replay and execution order are separate clocks. A prior polling tick
    // must not force all unresolved same-second orders ahead of a pending sell.
    const sellStateAt=(at:number,decisionAt:number):CurveState=>{
      let state={...fill.next}
      const last=externalAfterBuy.findLastIndex(l=>l.at+(l.timeResolutionMs??1)<=at||l.observedAt<=decisionAt||l.at<=at&&r.timing.sameTimeOrder==='after')
      for(const l of externalAfterBuy.slice(0,last+1)){
        try {
        if(l.topics[0]===EVENT_TOPICS.CurveBuy)state=simBuy(p,state,externalBuyAmount(l),BigInt(Math.floor(l.at/1000)),{exempt:logWord(l.data,2)===(logWord(l.data,0)*p.feeBps)/10000n,...(l.externalBuy?{minTokensOut:BigInt(l.externalBuy.minTokensOut)}:{})}).next
        else if(l.topics[0]===EVENT_TOPICS.CurveSell)state=simSell(p,state,logWord(l.data,0)).next
        else if(l.topics[0]===EVENT_TOPICS.CurveCompleted&&!state.graduated&&state.trackedTokens>p.reservedTokens)throw new Error('graduation_path_diverged')
        else state=apply(state,l)
        } catch(error) {
          out.replayFailure={order:l.order,transactionHash:l.transactionHash,error:String(error),
            state:Object.fromEntries(Object.entries(state).map(([k,v])=>[k,typeof v==='boolean'?v:String(v)]))}
          throw error
        }
      }
      sellReplayThrough = externalAfterBuy[last]?.order ?? logs[beforeBuy]?.order ?? r.seed.order
      return state
    }
    costs+=BigInt(r.costs.approvalWei); out.costsWei=String(costs)
    const snapshots:Array<{at:number;state:CurveState}>=[{at:confirmedAt,state:{...s}}]
    const advance=(at:number):string|null=>{
      while(i<logs.length && logs[i]!.at<=at) {
        const l=logs[i++]!
        try {
          if(l.topics[0]===EVENT_TOPICS.CurveBuy) s=simBuy(p,s,externalBuyAmount(l),BigInt(Math.floor(l.at/1000)),{exempt:logWord(l.data,2)===(logWord(l.data,0)*p.feeBps)/10000n,...(l.externalBuy?{minTokensOut:BigInt(l.externalBuy.minTokensOut)}:{})}).next
          else if(l.topics[0]===EVENT_TOPICS.CurveSell) s=simSell(p,s,logWord(l.data,0)).next
          else if(l.topics[0]===EVENT_TOPICS.CurveCompleted && !s.graduated && s.trackedTokens>p.reservedTokens) return 'graduation_path_diverged'
          else s=apply(s,l)
        }catch{return 'external_order_unresolved'}
        snapshots.push({at:Math.max(confirmedAt,l.observedAt),state:{...s}})
      }
      return null
    }
    const issue=advance(confirmedAt);if(issue)return unknown(issue)
    // Never observe a later chain state while an earlier event is still unobserved.
    let visible={...fill.next}, nextVisible=0, visibleAt=confirmedAt
    const observe=(at:number)=>{
      while(nextVisible<snapshots.length) {
        const next=snapshots[nextVisible]!
        visibleAt=Math.max(visibleAt,next.at)
        if(visibleAt>at)break
        visible=next.state;nextVisible++
      }
    }
    observe(confirmedAt)
    const entryMark=markToExit(p,visible,fill.tokensOut)
    const openedAt=r.openedAt??r.entryAt
    if(!Number.isFinite(openedAt)||openedAt<r.entryAt||openedAt>confirmedAt)return unknown('invalid_position_clock')
    const pos={exiting:false,peakMarkWei:entryMark,entryMarkWei:entryMark,takeProfitMultiple:r.takeProfit,openedAt,rules:{...r.rules}}
    const progress = r.progressHold
    if (progress && (![progress.initialMs, progress.stepMs, progress.lookbackMs, progress.maximumMs].every(v => Number.isFinite(v) && v > 0) || progress.maximumMs < progress.initialMs)) return unknown('invalid_progress_hold')
    if (progress) pos.rules.maxHoldMs = progress.initialMs
    const marks: Array<{ at: number; mark: bigint }> = []
    let pending:number|null=null, reason:string|null=null, attempts=0, lastMark:string|null=null
    for(let at=confirmedAt;at<=r.endAt;at+=r.pollMs) {
      const executionAt:number=pending!==null && pending<=at?pending:at
      if(pending!==null && pending<=at) {
        const knownBeforeDecision=logs.findLastIndex(l=>l.observedAt<=out.decisionAt!)
        if(logs.some((l,index)=>index>knownBeforeDecision&&l.at<=pending!&&pending!<l.at+(l.timeResolutionMs??1))&&r.timing.sameTimeOrder==='unavailable')return unknown('ambiguous_sell_order')
        if(attempts>=r.costs.maxSellAttempts)return unknown('sell_attempts_exhausted')
        attempts++
        if(attempts<=r.costs.failedSellAttempts){costs+=BigInt(r.costs.failedSellWei);out.costsWei=String(costs);pending=executionAt+r.costs.retryMs+r.timing.sellMs;continue}
        try { s=sellStateAt(executionAt,out.decisionAt!) }
        catch { return unknown('sell_state_replay_unresolved') }
        try {
          const sold=simSell(p,s,fill.tokensOut);costs+=BigInt(r.costs.sellWei)
          return {...out,status:'closed',reason:reason!,exitAt:executionAt,pnlWei:String(sold.quoteOut-fill.spent-costs),proceedsWei:String(sold.quoteOut),costsWei:String(costs)}
        }catch(error){
          if (!(error instanceof CurveRevert) || error.message !== 'CurveGraduated') return unknown('sell_execution_unresolved')
          const inputHash=poolReplayHash(r)
          out.poolReplay={version:'pool-replay-v1',inputHash,token:r.token,curve:r.curve,wallet:r.wallet,
            buyAt,entryAfter:logs[beforeBuy]?.order??r.seed.order,exitAfter:sellReplayThrough,
            tokens:String(fill.tokensOut),attemptedAt:executionAt,decisionAt:out.decisionAt!,costsAlreadyChargedWei:String(costs),
            curveState:Object.fromEntries(Object.entries(s).map(([k,v])=>[k,typeof v==='boolean'?v:String(v)]))}
          if (r.researchPoolQuote && research?.allowPoolQuote) return resolveResearchPoolQuote(out,r.researchPoolQuote,r.endAt)
          const pool=r.graduation
          if(!pool)return unknown(s.graduated?'graduated_pool_evidence_required':'sell_execution_unresolved')
          const compatible=pool.kind==='independent-contract-replay' && pool.inputHash===inputHash && pool.attemptedAt===executionAt
            && pool.tokens===String(fill.tokensOut) && Number.isSafeInteger(pool.executionAt) && pool.executionAt>=executionAt && pool.executionAt<=r.endAt
            && /^[a-f0-9]{64}$/.test(pool.evidenceHash) && !!pool.source
            && Object.entries(s).every(([k,v])=>String(v)===String(pool.curveState[k]))
          if(!compatible)return unknown('graduated_pool_input_mismatch')
          const proceeds=BigInt(pool.proceedsWei),gas=BigInt(pool.gasWei)
          if(proceeds<=0n||gas<0n)return unknown('invalid_graduated_execution')
          costs+=gas
          return {...out,status:'closed',reason:'graduated-swap',exitAt:pool.executionAt,pnlWei:String(proceeds-fill.spent-costs),proceedsWei:String(proceeds),costsWei:String(costs)}
        }
      }
      if(pending!==null)continue
      const fault=advance(at);if(fault)return unknown(fault)
      observe(at)
      if(pending===null) {
        const mark=markToExit(p,visible,fill.tokensOut)
        if (progress && at - openedAt >= pos.rules.maxHoldMs && pos.rules.maxHoldMs < progress.maximumMs) {
          const earlier = marks.findLast(v => v.at <= at - progress.lookbackMs)
          if (earlier && mark > earlier.mark) pos.rules.maxHoldMs = Math.min(progress.maximumMs, pos.rules.maxHoldMs + progress.stepMs)
        }
        if (progress) marks.push({ at, mark })
        reason=evaluate(pos,mark,at,visible.graduated||graduationProgress(p,visible)<=0.12)
        if(lastMark!==String(mark)||reason){out.trace.push({at,markWei:String(mark),reason});lastMark=String(mark)}
        if(reason){out.decisionAt=at;pending=Math.max(at,confirmedAt+r.costs.approvalDelayMs)+r.timing.sellMs}
      }
    }
    return unknown('incomplete_holding')
  }catch(e){return unknown(`invalid_execution_evidence: ${String(e)}`)}
}

/** Arithmetic reconstruction is explicitly separate and cannot certify prediction accuracy. */
export function reconstructExecution(r: Parameters<typeof replay>[0]) {
  return {kind:'actual-fill-reconstruction' as const,result:replay({...r,mode:'recorded_fill'})}
}


/** Pure settlement for explicitly labeled offline historical-quote sensitivities. */
export function resolveResearchPoolQuote(out: ExecutionResult, a: import('./execution-model.js').ResearchPoolQuote, endAt: number): ExecutionResult {
  const h=out.poolReplay
  const unknown=()=>({...out,status:'unavailable' as const,reason:'research_pool_quote_mismatch',pnlWei:null})
  if(!h||out.spentWei===null||a.kind!=='historical-pool-quote-scenario'||a.inputHash!==h.inputHash||a.attemptedAt!==h.attemptedAt
    ||a.tokens!==h.tokens||!a.scenarioId||!Number.isSafeInteger(a.executionAt)||a.executionAt>endAt
    ||![a.block,a.blockAt,a.nextBlockAt,a.extraDelayMs,a.haircutBps,a.preparationTransactions].every(Number.isSafeInteger)
    ||a.block<0||a.blockAt>a.executionAt||a.nextBlockAt<=a.executionAt||a.nextBlockAt<=a.blockAt
    ||a.extraDelayMs<0||a.preparationTransactions<0||a.haircutBps<0||a.haircutBps>10000
    ||a.executionAt!==h.attemptedAt+a.extraDelayMs+a.preparationTransactions*1000
    ||!/^[a-f0-9]{64}$/.test(a.evidenceHash)||!/^\d+$/.test(a.proceedsWei)||!/^\d+$/.test(a.gasWei))return unknown()
  const proceeds=BigInt(a.proceedsWei)*(10000n-BigInt(a.haircutBps))/10000n
  const costs=BigInt(h.costsAlreadyChargedWei)+BigInt(a.gasWei)
  return {...out,status:'closed',reason:'graduated-quote-scenario',exitAt:a.executionAt,
    pnlWei:String(proceeds-BigInt(out.spentWei)-costs),proceedsWei:String(proceeds),costsWei:String(costs),approximation:a}
}
