import type Database from 'better-sqlite3'
import type { BarOutcomes } from '../strategy/takeprofit.js'
// Read-only import. entry.ts is one of the eight files hashed into SHADOW_KERNEL:
// importing from it is free, EDITING it discards the observer's certificate.
import { templateKey } from '../strategy/entry.js'
export const MARKET_GAP_MS = 45_000
export type MarketSample = {t:number;sum:number|null;recentSum:number|null;pauseBelow:number|null;resumeAbove:number|null;n:number|null;fresh:boolean;source:'recorded'|'reconstructed';sumSource?:'recorded'|'reconstructed';recentSource?:'recorded'|'reconstructed'}
/** Either one fixed bars key, or the rung chosen from the launches before this one. */
export type BarChooser = string|((preceding:readonly BarOutcomes[])=>string)
/** How much launch history the chooser can see. Must exceed any adaptive window it asks for. */
const BAR_HISTORY_DEPTH = 200
export type MarketOutcomeRow = {token:string;block:number;launchedAt:number;bars:string
  /** the launch facts the paper rebuild needs to reapply the template-loss block */
  creatorTaxBps?:number|null;devBuyWei?:string|null;exemptions?:number|null}
export type MarketCoverage = {
  from:number|null;to:number|null;recorded:number;fresh:number;gapAfterMs:number;gaps:Array<{from:number;to:number}>
  reconstructedFrom:number|null;reconstructedTo:number|null;reconstructed:number
}
type GuardRow={at:number;market:number|null;market_recent:number|null;market_fresh:number;market_n:number|null;market_off:number|null;market_on:number|null;halts:string}
export type RecordedState={from:number;to:number;kinds:string[]}
const kindsOf=(value:string)=>{try{const x:unknown=JSON.parse(value);return Array.isArray(x)?x.filter((v):v is string=>typeof v==='string').sort():null}catch{return null}}

const sample=(t:number,sum:number|null,recentSum:number|null,pauseBelow:number|null,resumeAbove:number|null,n:number|null,fresh:boolean,source:MarketSample['source']):MarketSample=>({t,sum,recentSum,pauseBelow,resumeAbove,n,fresh,source})

export type ScoredObservation=MarketOutcomeRow&{t:number;bar:string;value:number|null}

/**
 * Score each observation at the rung chosen from the launches BEFORE it, never including
 * itself. The bot's adaptive bar is an argmax over the trailing window, pinned when the
 * position opens; letting a coin vote on the rung it is then scored at would be hindsight.
 *
 * The lines and the bar split both go through here, so a coin cannot be a win on one pane
 * and priced at a different rung on the other.
 */
export function scoreObservations(rows:readonly MarketOutcomeRow[],bar:BarChooser):ScoredObservation[]{
  const ordered=rows.map(row=>{
    let bars:BarOutcomes|null=null
    try{const parsed:unknown=JSON.parse(row.bars);if(parsed&&typeof parsed==='object')bars=parsed as BarOutcomes}catch{}
    return {row,t:row.launchedAt*1000,bars}
  }).sort((a,b)=>a.row.block-b.row.block)
  const seen:BarOutcomes[]=[]
  return ordered.map(({row,t,bars})=>{
    const key=typeof bar==='string'?bar:bar(seen)
    const v=bars?.[key]
    if(bars){seen.unshift(bars);if(seen.length>BAR_HISTORY_DEPTH)seen.pop()}
    return {...row,t,bar:key,value:typeof v==='number'&&Number.isFinite(v)?v:null}
  })
}

/**
 * Rebuild the measurement from venue observations, for history the guard never recorded.
 *
 * `recoveryWindow` mirrors FreshRecovery's second window: the latest N launches inside the
 * freshness horizon, which is what the Recovery pane plots. Leave it out and `recentSum`
 * stays null, which is what the pre-adaptive callers want.
 */
export function reconstructMarketHistory(rows:readonly MarketOutcomeRow[],from:number,to:number,opts:{window:number;freshMs:number;bar:BarChooser;pauseBelow:number;resumeAbove:number;recoveryWindow?:number;scored?:readonly ScoredObservation[]}):MarketSample[]{
  const width=Math.max(1,Math.floor(opts.window)),rawLimit=width*2
  const recoveryWidth=opts.recoveryWindow&&opts.recoveryWindow>0?Math.floor(opts.recoveryWindow):null
  // `scored` lets the caller share one pass with the bar split, so a coin cannot be priced at
  // one rung on the lines and another on the bars, and the bars JSON is parsed once.
  const parsed=(opts.scored??scoreObservations(rows,opts.bar)).filter(row=>row.t<=to)
  const recent:typeof parsed=[]
  const add=(row:(typeof parsed)[number])=>{recent.push(row);if(recent.length>rawLimit)recent.shift()}
  const reading=(at:number)=>{
    const valid=recent.filter(row=>row.value!==null)
    const kept=valid.slice(-width)
    const n=kept.length
    const oldest=kept[0]?.t??null
    const latest=recoveryWidth===null?null:valid.filter(row=>at-row.t<=opts.freshMs).slice(-recoveryWidth)
    const fresh=n===width&&oldest!==null&&at-oldest<=opts.freshMs&&(latest===null||latest.length===recoveryWidth)
    return {sum:fresh?kept.reduce((total,row)=>total+row.value!,0):null,
      recentSum:fresh&&latest?latest.reduce((total,row)=>total+row.value!,0):null,
      n,oldest,fresh}
  }
  const out:MarketSample[]=[]
  const push=(point:MarketSample)=>{
    if(point.t<from||point.t>to)return
    if(out.at(-1)?.t===point.t)out[out.length-1]=point
    else out.push(point)
  }
  let i=0
  while(i<parsed.length&&parsed[i]!.t<from)add(parsed[i++]!)
  if(recent.length){const r=reading(from);push(sample(from,r.sum,r.recentSum,opts.pauseBelow,opts.resumeAbove,r.n,r.fresh,'reconstructed'))}
  for(;i<parsed.length;i++){
    const row=parsed[i]!
    const before=reading(recent.at(-1)?.t??row.t)
    if(before.fresh&&before.oldest!==null&&before.oldest+opts.freshMs<row.t){
      push(sample(before.oldest+opts.freshMs+1,null,null,opts.pauseBelow,opts.resumeAbove,before.n,false,'reconstructed'))
    }
    add(row)
    const r=reading(row.t)
    push(sample(row.t,r.sum,r.recentSum,opts.pauseBelow,opts.resumeAbove,r.n,r.fresh,'reconstructed'))
  }
  if(recent.length){
    const r=reading(to)
    if(r.fresh)push(sample(to,r.sum,r.recentSum,opts.pauseBelow,opts.resumeAbove,r.n,true,'reconstructed'))
    else if(out.some(point=>point.fresh)){
      const staleAt=r.oldest!==null&&r.n===width?r.oldest+opts.freshMs+1:to
      push(sample(Math.max(out.at(-1)?.t??from,Math.min(to,staleAt)),null,null,opts.pauseBelow,opts.resumeAbove,r.n,false,'reconstructed'))
    }
  }
  const first=out.findIndex(point=>point.fresh)
  return first<0?[]:out.slice(first)
}

/**
 * The bin width a span of history is drawn at: ~600 across the window, never under 15s.
 * `marketHistory` has always used this; the rebuilt series now shares it.
 */
export const binWidth=(from:number,to:number)=>Math.max(15_000,Math.ceil((to-from)/600/15_000)*15_000)

/**
 * Downsample a run to the pane it is drawn on, keeping first, min, max and last per bin.
 *
 * `reconstructMarketHistory` emits one sample per observation, which over seven days is
 * 3,500 points against about 600 the pane can resolve. Freshness changes end a run, so a
 * stale marker is never averaged away by its neighbours.
 */
export function thinSamples(samples:readonly MarketSample[],binMs:number):MarketSample[]{
  if(samples.length<3)return [...samples]
  const out:MarketSample[]=[];let group:MarketSample[]=[]
  const flush=()=>{
    if(!group.length)return
    let min=group[0]!,max=min,recentMin=min,recentMax=min
    for(const p of group){if((p.sum??Infinity)<(min.sum??Infinity))min=p;if((p.sum??-Infinity)>(max.sum??-Infinity))max=p;if((p.recentSum??Infinity)<(recentMin.recentSum??Infinity))recentMin=p;if((p.recentSum??-Infinity)>(recentMax.recentSum??-Infinity))recentMax=p}
    for(const p of [...new Set([group[0]!,min,max,recentMin,recentMax,group.at(-1)!])].sort((a,b)=>a.t-b.t))out.push(p)
    group=[]
  }
  let previous:MarketSample|undefined
  for(const point of samples){
    if(previous&&(previous.fresh!==point.fresh||(previous.recentSum===null)!==(point.recentSum===null)||previous.pauseBelow!==point.pauseBelow||previous.resumeAbove!==point.resumeAbove
      ||Math.floor(previous.t/binMs)!==Math.floor(point.t/binMs)))flush()
    group.push(point);previous=point
  }
  flush()
  return out
}

/** Resolve both measurements over intervals. Explicit nulls end validity in either source. */
export function spliceReconstructed(recorded:readonly MarketSample[],rebuilt:readonly MarketSample[]):{samples:MarketSample[];spans:Array<{from:number;to:number}>;points:number}{
  const direct=[...recorded].sort((a,b)=>a.t-b.t), replay=[...rebuilt].sort((a,b)=>a.t-b.t)
  const timestamps=[...direct,...replay].map(p=>p.t)
  const replayEnd=replay.at(-1)?.t
  if(replayEnd!==undefined&&direct.at(-1)&&replayEnd<direct.at(-1)!.t)timestamps.push(replayEnd+1)
  const times=[...new Set(timestamps)].sort((a,b)=>a-b)
  const samples:MarketSample[]=[],spans:Array<{from:number;to:number}>=[]
  let ri=0,bi=0,r:MarketSample|undefined,b:MarketSample|undefined,points=0,active=false
  const valid=(p:MarketSample|undefined,key:'sum'|'recentSum')=>p?.fresh&&p[key]!=null&&Number.isFinite(p[key])
  for(const t of times){
    while(ri<direct.length&&direct[ri]!.t<=t)r=direct[ri++]!
    while(bi<replay.length&&replay[bi]!.t<=t)b=replay[bi++]!
    // A reconstruction ends at its final sample, even if that sample is fresh.
    const available=t<=(replay.at(-1)?.t??-Infinity)?b:undefined
    const main=valid(r,'sum')?r:valid(available,'sum')?available:undefined
    const recent=valid(r,'recentSum')?r:valid(available,'recentSum')?available:undefined
    const rebuiltHere=main?.source==='reconstructed'||recent?.source==='reconstructed'
    if(active)spans[spans.length-1]!.to=t
    if(rebuiltHere&&!active)spans.push({from:t,to:t})
    active=rebuiltHere
    // Keep recorded timestamps and value transitions; skip replay ticks in healthy runs.
    if(r&&r.t!==t&&!rebuiltHere&&main===r&&recent===r)continue
    const base=main??recent??r??b!
    const previous=samples.at(-1)
    if(previous&&t-previous.t>1&&((previous.sum!==null&&!main)||(previous.recentSum!==null&&!recent)))samples.push({...previous,t:t-1})
    samples.push({...base,t,sum:main?.sum??null,recentSum:recent?.recentSum??null,
      fresh:!!(main||recent),source:rebuiltHere?'reconstructed':'recorded',
      sumSource:main?.source,recentSource:recent?.source})
    if(rebuiltHere)points++
  }
  return {samples,spans,points}
}

/** Downsample inside continuous runs only. Keep both sides of every gap and threshold change. */
export function marketHistory(db:Database.Database,from:number,to:number){
  let rows:GuardRow[]
  try{
    // market_recent arrived on 2026-09-12. A read-only handle on a snapshot taken before
    // that cannot ALTER the table, so ask what the file actually has rather than assume.
    const columns=new Set((db.prepare('PRAGMA table_info(guard_samples)').all() as Array<{name:string}>).map(r=>r.name))
    const recent=columns.has('market_recent')?'market_recent':'NULL market_recent'
    rows=db.prepare(`SELECT at,market,${recent},market_fresh,market_n,market_off,market_on,halts
      FROM guard_samples WHERE live=1 AND at>=? AND at<=? ORDER BY at`).all(from,to) as GuardRow[]
  }catch(error){
    if(!String(error).includes('no such table: guard_samples'))throw error
    rows=[]
  }
  const binMs=Math.max(15_000,Math.ceil((to-from)/600/15_000)*15_000)
  const samples:MarketSample[]=[],states:RecordedState[]=[]
  let group:GuardRow[]=[],previous:GuardRow|undefined
  const flush=()=>{
    if(!group.length)return
    let min=group[0]!,max=min,recentMin=min,recentMax=min
    for(const row of group){if((row.market??Infinity)<(min.market??Infinity))min=row;if((row.market??-Infinity)>(max.market??-Infinity))max=row;if((row.market_recent??Infinity)<(recentMin.market_recent??Infinity))recentMin=row;if((row.market_recent??-Infinity)>(recentMax.market_recent??-Infinity))recentMax=row}
    // A recorded recovery threshold identifies the legacy guard, whose two windows match.
    for(const row of [...new Set([group[0]!,min,max,recentMin,recentMax,group.at(-1)!]) ].sort((a,b)=>a.at-b.at))samples.push(sample(row.at,row.market_fresh?row.market:null,row.market_fresh?(row.market_recent??(row.market_on!==null?row.market:null)):null,row.market_off,row.market_on,row.market_n,!!row.market_fresh,'recorded'))
    group=[]
  }
  for(const row of rows){
    const gap=!!previous&&row.at-previous.at>MARKET_GAP_MS
    const boundary=previous&&(gap||!!row.market_fresh!==!!previous.market_fresh||(row.market_recent===null)!==(previous.market_recent===null)||row.market_off!==previous.market_off||row.market_on!==previous.market_on||Math.floor(row.at/binMs)!==Math.floor(previous.at/binMs))
    if(boundary)flush()
    if(gap)samples.push(sample(previous!.at+1,null,null,null,null,null,false,'recorded'))
    group.push(row)
    const kinds=kindsOf(row.halts),active=states.at(-1)
    if(kinds){
      if(active&&!gap&&active.to===previous?.at&&active.kinds.join(',')===kinds.join(','))active.to=row.at
      else {
        // A different sampled state bounds the previous interval. A recording gap does not.
        if(active&&!gap&&active.to===previous?.at)active.to=row.at
        states.push({from:row.at,to:row.at,kinds})
      }
    }
    previous=row
  }
  flush()
  if(previous&&to-previous.at>MARKET_GAP_MS)samples.push(sample(previous.at+1,null,null,null,null,null,false,'recorded'))
  const gaps:Array<{from:number;to:number}>=[]
  let cursor:number|null=null
  for(const row of rows){
    if(cursor===null?row.at>from:row.at-cursor>MARKET_GAP_MS)gaps.push({from:cursor??from,to:row.at})
    cursor=row.at
  }
  if(cursor===null||to-cursor>MARKET_GAP_MS)gaps.push({from:cursor??from,to})
  return {samples,states,halts:states.filter(s=>s.kinds.length>0),coverage:{from:rows[0]?.at??null,to:rows.at(-1)?.at??null,
    recorded:rows.length,fresh:rows.filter(r=>r.market_fresh&&r.market!==null).length,gapAfterMs:MARKET_GAP_MS,gaps}}
}

/**
 * The simulated account's cash flow, rebuilt for history it never recorded.
 *
 * The shadow account cannot be backfilled and should not be: it is prospective by
 * construction. Its certifier refuses any intent older than `capture_started_at`, a
 * historical intent sorts ahead of every live one in the worker queue, and a stale oldest
 * pending entry trips the 180 s backlog rule that shuts the live venue guard. So the record
 * simply starts when the recorder did, 2026-09-11, and the operator wants the eleven days
 * before it.
 *
 * What exists for those days is the venue's own outcome per coin. It is close to the account
 * on coins where both ran, measured 2026-09-13 on the 525 they share: the sums differ by 12%,
 * the slope is 0.97 and they agree on sign 97.3% of the time. What differs is the POPULATION.
 * The venue prices every coin that cleared the entry screen; the account also declines on the
 * template-loss block, on concurrency and on bankroll. So this walks the same coins in launch
 * order and applies those three, rather than summing the lot and calling it a portfolio.
 *
 * `scale` is the residual, measured live against the recorded rows rather than hard-coded;
 * see `paperCalibration`. Returns cash events at CLOSE time, which is what an equity curve
 * plots, already merged into a running total in ETH.
 */
export type PaperRebuildOpts = {
  tradeSizeEth:number; bankrollEth:number; maxConcurrent:number; templateLossBlockMs:number
  /** entry lands this long after launch, and the rule holds at most this long */
  entryLagMs:number; holdMs:number
  /** median round-trip gas, ETH. The venue replay is gross of it. */
  gasEth:number
  scale:number
}
export function paperReconstructed(
  scored:readonly ScoredObservation[], opts:PaperRebuildOpts,
): Array<{t:number;eth:number;token:string}> {
  const closes:Array<{t:number;eth:number;token:string}> = []
  const active:Array<{closeAt:number;eth:number}> = []
  const lostAt = new Map<string,number>()
  const ordered=[...scored].filter(r=>r.value!==null).sort((a,b)=>a.t-b.t||a.block-b.block)
  for (const row of ordered) {
    const at=row.t+opts.entryLagMs
    // retire everything that had settled before this coin launched
    for (let i=active.length-1;i>=0;i--) if (active[i]!.closeAt<=at) active.splice(i,1)
    const template=templateKey(BigInt(row.creatorTaxBps??0),BigInt(row.devBuyWei??'0'),row.exemptions??null)
    const loss=lostAt.get(template)
    // the same three refusals the account applies, in the same order
    if (loss!=null && at-loss < opts.templateLossBlockMs) continue
    if (active.length >= opts.maxConcurrent) continue
    if ((active.length+1)*opts.tradeSizeEth > opts.bankrollEth + 1e-12) continue
    const closeAt=at+opts.holdMs
    const eth=row.value!*opts.scale*opts.tradeSizeEth-opts.gasEth
    closes.push({t:closeAt,eth,token:row.token})
    active.push({closeAt,eth})
    if (eth<0) lostAt.set(template,closeAt)
  }
  return closes.sort((a,b)=>a.t-b.t)
}
