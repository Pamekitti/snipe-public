/** Research batch replay; shared entry and external orders, independent candidate exits. */
import { EVENT_TOPICS, logWord } from '../../src/abi.js';
import { freshCurve,simBuy,simSell,markToExit,graduationProgress } from '../../src/state/curve.js';
import { evaluate } from '../../src/strategy/exit-evaluation.js';
import { params,ordered,apply,type Raw } from '../../src/strategy/counterfactual.js';
import { replay } from './grid_replay.js';
function prepare(r:any):any {
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
    l.topics.slice(1, 3).some((t:string) => t.slice(-40).toLowerCase() === wallet);
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
  return {p,s,logs,tokens,spent,firstTick,i,entry,buyAt,openedAt};
}

export function replayMany(r:any, variants:any[]):any[] {
 const allowed=new Set(['rules','takeProfit','sellDelayMs','exitPolicy']);
 if(r.mode==='recorded_fill' || variants.some(v=>Object.keys(v).some(k=>!allowed.has(k)))) return variants.map(v=>replay({...r,...v}));
 const initial=prepare(r);
 if(initial.status) return variants.map(()=>initial);
 const {p,logs,tokens,spent,firstTick,entry,openedAt}=initial;
 let s=initial.s,i=initial.i;
 const initialMark=markToExit(p,s,tokens);
 const states=variants.map(v=>{
  const q={...r,...v};
  return {r:q,pos:{exiting:false,peakMarkWei:initialMark,id:1,token:r.token,curve:r.curve,tokens,spendWei:spent,entryMarkWei:initialMark,openedAt,buyHash:r.buyHash??'',filled:true,takeProfitMultiple:q.takeProfit,rules:{...q.rules}},
   deadline:q.exitPolicy?.initialMs??q.rules.maxHoldMs,checkpointMark:initialMark,lastImproved:openedAt,improvementMark:initialMark,pending:null as number|null,reason:null as string|null,trace:[] as any[],done:null as any};
 });
 const trace:any[]=[];
 const recorded=false;
 function advance(at:number):any {
    while (i < logs.length && logs[i]!.at <= at) {
      const l = logs[i++]!;
      const ours = (r.wallet ?? "").toLowerCase().replace("0x", "");
      if (
        ours &&
        l.topics.slice(1, 3).some((t:string) => t.slice(-40).toLowerCase() === ours)
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

  return null;
 }
 const end=r.endAt??entry+180000,interval=r.pollMs??500;
 for(let at=firstTick;at<=end;at+=interval){
  const failure=advance(at);
  if(failure) return states.map(v=>v.done??{...failure,trace:v.trace});
  let mark:bigint|undefined,quote:any,quoteTried=false;
  for(const v of states){
   if(v.done)continue;
   if(v.pending!==null && at>=v.pending){
    if(!quoteTried){try{quote=simSell(p,s,tokens)}catch{quote=null}quoteTried=true}
    v.done=quote?{status:'closed',entryAt:entry,exitAt:at,tokens,spent,pnlWei:BigInt(quote.quoteOut)-BigInt(spent)-BigInt(v.r.gasWei??0),proceedsWei:quote.quoteOut,reason:v.reason,trace:v.trace}
      :{status:'pool_required',entryAt:entry,at,tokens,spent,reason:v.reason,trace:v.trace,assumption:'candidate curve state requires historical-pool compatibility check'};
    continue;
   }
   if(v.pending!==null)continue;
   mark??=markToExit(p,s,tokens);
   const h=v.r.exitPolicy;
   if(h){
    const age=at-openedAt;
    if(h.kind==='progress' && age>=v.deadline && v.deadline<h.capMs && mark*10000n>=v.checkpointMark*BigInt(10000+h.improvementBps)){
     v.deadline=Math.min(h.capMs,v.deadline+h.stepMs);v.checkpointMark=mark;
    }
    if(h.kind==='inactivity'){
     if(mark*10000n>=v.improvementMark*BigInt(10000+h.improvementBps)){v.lastImproved=at;v.improvementMark=mark}
     v.deadline=Math.min(h.capMs,v.lastImproved-openedAt+h.idleMs);
    }
    v.pos.rules.maxHoldMs=v.deadline;
   }
   v.reason=evaluate(v.pos,mark,at,s.graduated||graduationProgress(p,s)<=0.12);
   if(v.reason){v.trace.push({at,reason:v.reason,mark});v.pending=at+(v.r.sellDelayMs??600)}
  }
  if(states.every(v=>v.done))return states.map(v=>v.done);
 }
 return states.map(v=>v.done??{status:'incomplete_path',tokens,spent,trace:v.trace});
}
