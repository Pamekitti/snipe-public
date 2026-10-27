import { pickEntry, type EntryConfig } from '../../src/strategy/entry.js'
import { FreshRecovery, type ShadowOutcome } from '../../src/strategy/fresh-recovery.js'
import { EXECUTION_VERSION, type ExecutionResult } from '../../src/strategy/execution-model.js'

export type PaperKind='policy'|'continuous'|'market-off'|'latest-eight'
export type AccountConfig={entry:EntryConfig;bankrollWei:string;maxConcurrent:number;maxDrawdownWei:string;entryHours:number[]}
export type Holding={id:string;token:string;template:string;entryAt:number;sizeWei:string;result:ExecutionResult;availableAt:number;block:number;launched:number;checked:boolean}
export type AccountState={
  modelVersion:typeof EXECUTION_VERSION;strategyVersion:string;kind:PaperKind;at:number
  cashWei:string;peakWei:string;epochCashWei:string;epochPeakWei:string;drawdownWei:string
  halted:boolean;drawdownHalted:boolean;marketPaused:boolean;config:AccountConfig;holdings:Holding[];losses:Record<string,number>
  seen:string[];tokensSeen:string[];outcomes:ShadowOutcome[];recovery:ReturnType<FreshRecovery['snapshot']>
  unknown:string[];initialKnown:boolean
}
export type AccountEvent=
  | {kind:'control';id:string;at:number;sequence:number;strategyVersion:string;halted?:boolean;marketPaused?:boolean;resetDrawdown?:boolean;config?:AccountConfig}
  | {kind:'opportunity';id:string;at:number;sequence:number;strategyVersion:string;token:string;template:string;creatorTaxBps:string;exemptions:number|null;sizeWei:string;result:ExecutionResult;availableAt:number;block:number;launched:number;checked:boolean}
  | {kind:'publication';id:string;at:number;sequence:number;strategyVersion:string;outcomes:ShadowOutcome[]}
  | {kind:'gap';id:string;at:number;sequence:number;strategyVersion:string;reason:string}
export type CashPoint={t:number;cashWei:string;id:string}
export type AccountRun={state:AccountState;decisions:Array<{id:string;at:number;allow:boolean;reason:string}>;cash:CashPoint[]}
export function initialAccount(kind:PaperKind,strategyVersion:string,at:number,config:AccountConfig,known:boolean):AccountState {
  return {modelVersion:EXECUTION_VERSION,strategyVersion,kind,at,cashWei:'0',peakWei:'0',epochCashWei:'0',epochPeakWei:'0',drawdownWei:'0',halted:false,drawdownHalted:false,marketPaused:false,config,
    holdings:[],losses:{},seen:[],tokensSeen:[],outcomes:[],recovery:new FreshRecovery(at).snapshot(),unknown:[],initialKnown:known}
}
/** Pure replay. Calendar boundaries affect presentation only; this reducer never resets at a month. */
export function reduceAccount(initial:AccountState,events:readonly AccountEvent[],through:number):AccountRun {
  const s:AccountState=structuredClone(initial),cash:CashPoint[]=[],decisions:AccountRun['decisions']=[]
  const seen=new Set(s.seen),tokensSeen=new Set(s.tokensSeen),guard=new FreshRecovery(s.at);guard.restore(s.recovery)
  let configSource=initial.config
  let lockedWei=s.holdings.reduce((total,h)=>total+BigInt(h.sizeWei),0n)
  let cashWei=BigInt(s.cashWei),peakWei=BigInt(s.peakWei),drawdownWei=BigInt(s.drawdownWei)
  let epochCashWei=BigInt(s.epochCashWei),epochPeakWei=BigInt(s.epochPeakWei)
  let bankrollWei=BigInt(s.config.bankrollWei),maxDrawdownWei=BigInt(s.config.maxDrawdownWei)
  const settle=(at:number)=>{
    if(!s.holdings.length){s.at=at;return}
    const closed=s.holdings.filter(h=>h.result.exitAt!==null&&h.result.exitAt<=at).sort((a,b)=>a.result.exitAt!-b.result.exitAt!||a.id.localeCompare(b.id))
    if(!closed.length){s.at=at;return}
    for(const h of closed){
      if(h.result.pnlWei===null){s.unknown.push(h.id);continue}
      const pnl=BigInt(h.result.pnlWei);cashWei+=pnl;peakWei=cashWei>peakWei?cashWei:peakWei
      s.cashWei=String(cashWei);s.peakWei=String(peakWei)
      const dd=peakWei-cashWei;drawdownWei=dd>drawdownWei?dd:drawdownWei;s.drawdownWei=String(drawdownWei)
      epochCashWei+=pnl;epochPeakWei=epochCashWei>epochPeakWei?epochCashWei:epochPeakWei
      s.epochCashWei=String(epochCashWei);s.epochPeakWei=String(epochPeakWei)
      if(s.kind!=='continuous'&&epochPeakWei-epochCashWei>=maxDrawdownWei)s.drawdownHalted=true
      if(pnl<0n)s.losses[h.template]=h.result.exitAt!
      cash.push({t:h.result.exitAt!,cashWei:s.cashWei,id:h.id})
      if(h.checked&&s.kind==='continuous')s.outcomes.push({token:h.token,block:h.block,launched:h.launched,available:Math.max(h.availableAt,h.result.exitAt!+1),value:Number(pnl)/Number(h.sizeWei)})
    }
    lockedWei-=closed.reduce((total,h)=>total+BigInt(h.sizeWei),0n)
    const done=new Set(closed.map(h=>h.id));s.holdings=s.holdings.filter(h=>!done.has(h.id))
    s.at=at
  }
  for(const e of [...events].filter(e=>e.at<=through).sort((a,b)=>a.at-b.at||a.sequence-b.sequence||a.id.localeCompare(b.id))){
    if(seen.has(e.id))continue
    if(e.strategyVersion!==s.strategyVersion)throw new Error('account strategy version mismatch')
    if(e.at<s.at)throw new Error('backfill precedes checkpoint; rebuild from initial state')
    settle(e.at);seen.add(e.id)
    if(e.kind==='control'){
      if(e.config&&e.config!==configSource){s.config=structuredClone(e.config);configSource=e.config;bankrollWei=BigInt(s.config.bankrollWei);maxDrawdownWei=BigInt(s.config.maxDrawdownWei)}
      if(e.halted!==undefined)s.halted=e.halted
      if(e.marketPaused!==undefined)s.marketPaused=e.marketPaused
      if(e.resetDrawdown){epochCashWei=0n;epochPeakWei=0n;s.epochCashWei='0';s.epochPeakWei='0';s.drawdownHalted=false}
      continue
    }
    if(e.kind==='publication'){
      if(s.kind==='latest-eight'){s.outcomes=structuredClone(e.outcomes);guard.read(s.outcomes,e.at)}
      continue
    }
    if(e.kind==='gap'){s.unknown.push(e.id+':'+e.reason);continue}
    const loss=s.losses[e.template]
    const pick=pickEntry({creatorTaxBps:BigInt(e.creatorTaxBps),exemptions:e.exemptions,templateLossAgeMs:loss===undefined?null:e.at-loss},s.config.entry)
    let reason='admitted'
    if('reject'in pick)reason=pick.reject
    else if(s.config.entryHours.length&&!s.config.entryHours.includes(new Date(e.at).getUTCHours()))reason='entry_hours'
    else if(tokensSeen.has(e.token.toLowerCase()))reason='token_already_attempted'
    else if(s.unknown.length||!s.initialKnown)reason='unresolved_account_state'
    else if(s.kind!=='continuous'&&(s.halted||s.drawdownHalted))reason='account_pause'
    else if(s.kind==='policy'&&s.marketPaused)reason='historical_market_pause'
    else if(s.kind==='latest-eight'&&guard.read(s.outcomes,e.at).state!=='open')reason='candidate_market_pause'
    else if(s.holdings.length>=s.config.maxConcurrent)reason='capacity'
    else if(lockedWei+pick.sizeWei>bankrollWei)reason='bankroll'
    else if(pick.sizeWei!==BigInt(e.sizeWei))reason='execution_stake_mismatch'
    const allow=reason==='admitted';decisions.push({id:e.id,at:e.at,allow,reason})
    if(!allow)continue
    if(e.result.modelVersion!==EXECUTION_VERSION)throw new Error('execution model version mismatch')
    if(e.result.status==='rejected')continue
    s.tokensSeen.push(e.token.toLowerCase())
    tokensSeen.add(e.token.toLowerCase())
    if(e.result.status==='unavailable'||e.result.pnlWei===null||e.result.exitAt===null){s.unknown.push(e.id);continue}
    if(e.result.exitAt<e.at)throw new Error('execution closes before admission')
    lockedWei+=pick.sizeWei
    s.holdings.push({id:e.id,token:e.token,template:e.template,entryAt:e.at,sizeWei:e.sizeWei,result:e.result,availableAt:e.availableAt,block:e.block,launched:e.launched,checked:e.checked})
  }
  if(through<s.at)throw new Error('account clock moved backwards')
  settle(through);s.seen=[...seen];s.recovery=guard.snapshot()
  return {state:s,decisions,cash}
}
export function monthlyAccount(run:AccountRun,initial:AccountState,from:number,to:number){
  const d=new Date(to),monthStart=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1)
  let baseline=BigInt(initial.cashWei)
  for(const p of run.cash)if(p.t<monthStart)baseline=BigInt(p.cashWei)
  const incomplete=!run.state.initialKnown||run.state.unknown.length>0||initial.at>monthStart
  const points:Array<{t:number;eth:number|null}>=[]
  const firstDate=new Date(Math.max(from,initial.at))
  let cashIndex=0,priorCash=BigInt(initial.cashWei)
  for(let year=firstDate.getUTCFullYear(),month=firstDate.getUTCMonth(); Date.UTC(year,month,1)<=to; month++){
    const start=Date.UTC(year,month,1),end=Date.UTC(year,month+1,1)
    while(cashIndex<run.cash.length&&run.cash[cashIndex]!.t<start)priorCash=BigInt(run.cash[cashIndex++]!.cashWei)
    const monthBase=priorCash
    points.push({t:start,eth:initial.at<=start&&initial.initialKnown?0:null})
    while(cashIndex<run.cash.length&&run.cash[cashIndex]!.t<end){
      const p=run.cash[cashIndex++]!;priorCash=BigInt(p.cashWei)
      points.push({t:p.t,eth:initial.at<=start?Number(priorCash-monthBase)/1e18:null})
    }
  }
  const firstUnknown=run.decisions.find(d=>d.reason==='unresolved_account_state')?.at
  if(incomplete){
    const gapAt=firstUnknown??Math.max(initial.at,monthStart)
    for(let i=points.length-1;i>=0;i--)if(points[i]!.t>=gapAt)points.splice(i,1)
    points.push({t:gapAt,eth:null})
  }
  points.sort((a,b)=>a.t-b.t)
  const before=points.filter(p=>p.t<from).at(-1)
  return {modelVersion:EXECUTION_VERSION,account:initial.kind,monthStart,monthToDate:incomplete?null:Number(BigInt(run.state.cashWei)-baseline)/1e18,
    points:[...(before?[{...before,t:from}]:[]),...points.filter(p=>p.t>=from&&p.t<=to)],
    coverage:{complete:!incomplete,initialKnown:run.state.initialKnown,unresolved:run.state.unknown},
    pending:run.state.holdings.length,unavailable:run.state.unknown.length,lastProcessedAt:run.state.at,
    reconstruction:initial.initialKnown?'recorded-initial-state':'initial-state-unavailable'}
}
