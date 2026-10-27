import { MODEL_HASH } from '../simulation/identity.js'
import { SCENARIO_IDS } from '../strategy/execution-scenarios.js'
import type Database from 'better-sqlite3'
import { FRESH_POLICY } from '../strategy/fresh-policy.js'
import type { GuardPolicy } from '../strategy/scenario-guard.js'
import { NON_TRADE_REASONS } from './db.js'
import { scoreObservations, type BarChooser, type MarketOutcomeRow, type ScoredObservation } from './market-history.js'

const table = (db: Database.Database, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
export function effectiveMarketPolicy(adaptive: boolean, legacy: {window:number;off:number;on:number;freshMs:number}, scenario?: GuardPolicy | null) {
  if(scenario)return {id:scenario.id,source:'conservative-paper',window:scenario.n,recoveryWindow:scenario.m,
    pauseBelow:scenario.off,recoverAbove:scenario.freshOn,fullRecoverAbove:scenario.fullOn,recoveryMode:scenario.mode,
    freshMs:scenario.ageMs,pauseOperator:'<',recoveryOperator:'>',requiresNewPublication:true,requiresAllScenarios:true}
  return adaptive ? {...FRESH_POLICY, inactiveLegacyRecovery: legacy.on} : {
    id:'legacy',source:'fixed-bar',window:legacy.window,recoveryWindow:legacy.window,
    pauseBelow:legacy.off,recoverAbove:legacy.on,freshMs:legacy.freshMs,
    pauseOperator:'<',recoveryOperator:'>',requiresNewPublication:false,
  }
}

/** Published scores remain drawable while the next selector result is pending. */
export function recordedScenarioDisplay(r:any) {
  const error=String(r.observerError??'')
  const selectorPending=error==='selector_unresolved_execution'
    &&Number.isFinite(r.publicationAt)&&r.publicationAt>0&&r.publicationAt<=r.at
  const releaseOnly=/ENOENT:.*\.release\.json/.test(error)||[
    'historical_fidelity_not_passed','selection_not_validated','prospective_certification_not_passed',
  ].some(reason=>error===reason||error==='Error: '+reason)
  const valid=(r.verified&&!error||releaseOnly||selectorPending)&&r.scenarios?.length===6
    &&SCENARIO_IDS.every(id=>r.scenarios.filter((s:any)=>s.id===id).length===1)
    &&r.scenarios.every((s:any)=>s.fresh&&s.n>=r.policy.n&&s.recentN>=r.policy.m
      &&Number.isFinite(s.sum)&&Number.isFinite(s.recentSum))
  return {sum:valid?Math.min(...r.scenarios.map((s:any)=>s.sum)):null,
    recentSum:valid?Math.min(...r.scenarios.map((s:any)=>s.recentSum)):null,
    diagnostic:!!valid&&!r.verified,valid:!!valid}
}

/**
 * One book's recorded guard line. `book` is not optional decoration: this function splices a
 * gap marker whenever consecutive rows disagree, so two interleaved books would render as one
 * series with a spurious break at every single sample.
 */
export function executionScenarioHistory(db:Database.Database,from:number,to:number,allModels=false,book='main') {
  if(!table(db,'execution_guard_decisions'))return {samples:[] as any[],events:[] as any[]}
  const hasBook=(db.prepare('PRAGMA table_info(execution_guard_decisions)').all() as Array<{name:string}>).some(c=>c.name==='book')
  const rows=(hasBook
    ?db.prepare("SELECT model,at,reading FROM execution_guard_decisions WHERE (? OR model=?) AND COALESCE(book,'main')=? AND at>=? AND at<=? ORDER BY at,id").all(allModels?1:0,MODEL_HASH,book,from,to)
    :db.prepare('SELECT model,at,reading FROM execution_guard_decisions WHERE (? OR model=?) AND at>=? AND at<=? ORDER BY at,id').all(allModels?1:0,MODEL_HASH,from,to)) as Array<{model:string;at:number;reading:string}>
  const samples:any[]=[],events:any[]=[]
  let previous:any=null
  for(const row of rows){
    const r=JSON.parse(row.reading)
    if(!r)continue
    const display=recordedScenarioDisplay(r),valid=display.valid
    if(previous&&(row.model!==previous.model||row.at-previous.at>30000||r.configId!==previous.configId||r.policy.id!==previous.policy.id))samples.push({...samples.at(-1),t:previous.at+1,sum:null,recentSum:null,fresh:false,reason:'recording_gap_or_configuration_change'})
    samples.push({t:row.at,modelHash:row.model,sum:display.sum,recentSum:display.recentSum,diagnostic:display.diagnostic,
      sumRange:r.sumRange,recentSumRange:r.recentSumRange,n:r.scenarios?.length?Math.min(...r.scenarios.map((s:any)=>s.n)):0,fresh:!!valid,source:'recorded',
      scenarios:r.scenarios??[],reason:r.reason,verified:!!r.verified,observerError:r.observerError,configId:r.configId,publicationAt:r.publicationAt,
      policyId:r.policy.id,window:r.policy.n,recoveryWindow:r.policy.m,state:r.state,
      pauseBelow:r.policy.off,resumeAbove:r.policy.freshOn,fullResumeAbove:r.policy.mode==='fresh'?null:r.policy.fullOn})
    if(!previous||previous.state!==r.state||previous.configId!==r.configId||previous.reason!==r.reason)events.push({t:row.at,state:r.state,reason:r.reason,policyChanged:!!previous&&previous.policy.id!==r.policy.id})
    previous={...r,model:row.model,at:row.at}
  }
  if(previous&&to-previous.at>30000)samples.push({...samples.at(-1),t:previous.at+1,sum:null,recentSum:null,fresh:false,reason:'recording_gap'})
  return {samples,events}
}

/** Closed cash only. Unknown cash invalidates the total instead of becoming zero. */
export function bookedWindow(db:Database.Database, from:number, to:number, price:number, afterId=0) {
  const rows=db.prepare(`SELECT exit_reason,spend_wei,onchain_pnl_wei,pnl_wei FROM positions
    WHERE live=1 AND closed=1 AND exit_at>=? AND exit_at<=? AND id>?`).all(from,to,afterId) as Array<{exit_reason:string;spend_wei:string|null;onchain_pnl_wei:string|null;pnl_wei:string|null}>
  const main=rows.filter(r=>!(NON_TRADE_REASONS as readonly string[]).includes(r.exit_reason))
  const value=(r:typeof rows[number])=>r.onchain_pnl_wei??r.pnl_wei
  const missing=rows.filter(r=>value(r)===null).length
  const wei=missing?null:rows.reduce((sum,r)=>sum+BigInt(value(r)!),0n)
  // ONE population on both sides of the ratio. Until 2026-09-16 the numerator summed every
  // closed row and the denominator summed only `main`, so a reverted buy's burned gas was
  // in the return and its stake was not in the turnover. The two agree now, and they agree
  // on ALL rows, because `wei` is the number displayed directly beside this one: the wallet
  // is right, burned gas rides the row, and a ratio whose numerator is the displayed P&L
  // must divide by everything that P&L was earned on.
  //
  // `n` and `winPct` stay on `main`, which is a different question and is labelled as one:
  // a buy that never landed is not a trade that won or lost. `turnoverEth` is returned so
  // the displayed ratio can be checked against its own denominator rather than inferred.
  const spend=rows.reduce((sum,r)=>sum+BigInt(r.spend_wei??'0'),0n)
  const wins=main.filter(r=>value(r)!==null&&BigInt(value(r)!)>0n).length
  return {from,to,n:main.length,attempts:rows.length,missing,bookEth:wei===null?null:Number(wei)/1e18,
    bookUsd:wei===null?null:Number(wei)/1e18*price,winPct:main.length&&main.every(r=>value(r)!==null)?100*wins/main.length:null,
    turnoverEth:Number(spend)/1e18,
    rotPct:wei!==null&&spend>0n?100*Number(wei)/Number(spend):null}
}
export function dashboardMoney(db:Database.Database,now:number,price:number) {
  const epoch=Number((db.prepare("SELECT value FROM chain_truth WHERE key='epoch_base_id'").get() as {value:string}|undefined)?.value??0)
  return {today:bookedWindow(db,Math.floor(now/86400000)*86400000,now,price),epoch:bookedWindow(db,0,now,price,epoch)}
}

type Decision={at:number;reading:string;config:string}
/** Use recorded decision times. Old rows have readings but no certified threshold metadata. */
export function adaptiveHistory(db:Database.Database,from:number,to:number) {
  if(!table(db,'shadow_decisions'))return {samples:[],events:[]}
  const rows=db.prepare('SELECT at,reading,config FROM shadow_decisions WHERE at>=? AND at<=? ORDER BY at').all(from,to) as Decision[]
  const columns=table(db,'guard_samples')?db.prepare('PRAGMA table_info(guard_samples)').all() as Array<{name:string}>:[]
  // The policy in force at `from` plus every change inside the window. Reading the whole
  // table from the beginning of time cost a scan of 33k rows on every poll.
  type Meta={at:number;market_policy:string}
  const metadata:Meta[]=columns.some(c=>c.name==='market_policy')?[
    ...db.prepare('SELECT at,market_policy FROM guard_samples WHERE at<? AND market_policy IS NOT NULL ORDER BY at DESC LIMIT 1').all(from) as Meta[],
    ...db.prepare('SELECT at,market_policy FROM guard_samples WHERE at>=? AND at<=? AND market_policy IS NOT NULL ORDER BY at').all(from,to) as Meta[],
  ]:[]
  // One point per decision is four times finer than any pane can resolve, and every field
  // below rode on all 38k of them. Bin the run and keep its shape: first, min, max, last.
  const binMs=Math.max(15_000,Math.ceil((to-from)/600/15_000)*15_000)
  const samples:any[]=[],events:any[]=[];let prev:any=null,metaIndex=-1,group:any[]=[]
  const flush=()=>{
    if(!group.length)return
    let min=group[0]!,max=min,recentMin=min,recentMax=min
    for(const p of group){if((p.sum??Infinity)<(min.sum??Infinity))min=p;if((p.sum??-Infinity)>(max.sum??-Infinity))max=p;if((p.recentSum??Infinity)<(recentMin.recentSum??Infinity))recentMin=p;if((p.recentSum??-Infinity)>(recentMax.recentSum??-Infinity))recentMax=p}
    for(const p of [...new Set([group[0]!,min,max,recentMin,recentMax,group.at(-1)!])].sort((a,b)=>a.t-b.t))samples.push(p)
    group=[]
  }
  for(const row of rows){
    let r:any;try{r=JSON.parse(row.reading)}catch{continue}
    while(metaIndex+1<metadata.length&&metadata[metaIndex+1]!.at<=row.at)metaIndex++
    let policy:any=null;try{policy=metaIndex>=0?JSON.parse(metadata[metaIndex]!.market_policy):null}catch{}
    if(policy?.configId!==row.config)policy=null
    const policyKey=policy?JSON.stringify(policy):null
    const valid=r.fresh&&r.verified&&!r.observerError
    // config, policy and publicationAt stay local: the page reads none of the three, and on
    // a 7-day window the repeated policy object alone was 578 KB of the payload.
    const p={t:row.at,sum:valid?r.sum:null,recentSum:valid?r.recentSum:null,n:r.n,fresh:!!valid,source:'recorded',
      pauseBelow:policy?.pauseBelow??null,resumeAbove:policy?.recoverAbove??null}
    // Anything that changes what the reading MEANS ends the run. Only quiet stretches bin.
    if(prev&&(prev.config!==row.config||(prev.recentSum==null)!==(p.recentSum==null)||prev.fresh!==p.fresh||prev.pauseBelow!==p.pauseBelow||prev.resumeAbove!==p.resumeAbove||prev.state!==r.state||prev.policyKey!==policyKey||Math.floor(prev.t/binMs)!==Math.floor(p.t/binMs)))flush()
    if(prev&&prev.config!==row.config)samples.push({...p,t:prev.t+1,sum:null,recentSum:null,fresh:false,pauseBelow:null,resumeAbove:null})
    if(!prev||prev.state!==r.state||prev.config!==row.config||prev.policyKey&&policyKey&&prev.policyKey!==policyKey)events.push({t:row.at,state:r.state,reason:r.reason,policyChanged:!!prev&&(prev.config!==row.config||!!prev.policyKey&&!!policyKey&&prev.policyKey!==policyKey)})
    group.push(p)
    prev={...p,config:row.config,state:r.state,policyKey}
  }
  flush()
  // Decisions are event-driven. A quiet interval is not evidence of a collector outage.
  // Invalid recorded readings above end the line; do not extend its tail to now.
  return {samples,events}
}

export function adaptiveBuckets(db:Database.Database,from:number,to:number,bucket:number) {
  if(!table(db,'shadow_jobs'))return {buckets:[],pending:null,unavailable:null}
  const hasPublished=(db.prepare('PRAGMA table_info(shadow_jobs)').all() as Array<{name:string}>).some(c=>c.name==='published_at')
  const published=hasPublished?'COALESCE(published_at,available)':'available'
  const rows=db.prepare(`SELECT config,${hasPublished?'published_at':'NULL AS published_at'},available,pnl,size FROM shadow_jobs WHERE status='published'
    AND ${published}>=? AND ${published}<=? ORDER BY ${published},id`).all(from,to) as Array<{config:string;published_at:number|null;available:number;pnl:string|null;size:string|null}>
  const bins=new Map<number,any>()
  for(const r of rows){
    const t=Math.floor((r.published_at??r.available)/bucket)*bucket
    const b=bins.get(t)??{t,positive:0,negative:0,net:0,wins:0,losses:0,zero:0,missing:0,n:0,configs:[]}
    if(!b.configs.includes(r.config))b.configs.push(r.config)
    if(r.pnl===null||r.size===null||BigInt(r.size)<=0n)b.missing++
    else{const v=Number(r.pnl)/Number(r.size);b.n++;b.net+=v;if(v>0){b.positive+=v;b.wins++}else if(v<0){b.negative+=v;b.losses++}else b.zero++}
    bins.set(t,b)
  }
  return {buckets:[...bins.values()].map(b=>({...b,net:b.missing?null:b.net})),...shadowCounts(db,to)}
}

/** Jobs still owed a result (queued, modeled, or awaiting a retry) and jobs the source could not serve. */
const PENDING_STATUSES=['queued','modeled','source-error']
function shadowCounts(db:Database.Database,to:number) {
  const counts=db.prepare("SELECT status,COUNT(*) n FROM shadow_jobs WHERE entry<=? GROUP BY status").all(to) as Array<{status:string;n:number}>
  return {pending:counts.filter(r=>PENDING_STATUSES.includes(r.status)).reduce((a,r)=>a+r.n,0),unavailable:counts.find(r=>r.status==='unavailable')?.n??0}
}

/**
 * Launch volume and simulated outcome per bucket, keyed by the LAUNCH's detection time so a
 * coin's result sits in the bar it was launched in, not minutes to the right where the shadow
 * account published it.
 *
 * One shadow row per token: when several policy versions simulated the same coin, the latest
 * publication wins. Published outcomes are a proper subset of the coins that passed the book
 * screen (entry filters decline some, jobs can be rejected or unavailable, some are never
 * enqueued), so `passed` splits into win / loss / flat / pending / notSimulated and the page
 * names each. `filtered` is the book screen's rejects. Nothing here uses the fixed touch test.
 */
export function outcomeBuckets(db:Database.Database,from:number,to:number,bucket:number,observed:readonly MarketOutcomeRow[]=[],rung:BarChooser='',scored?:readonly ScoredObservation[]) {
  type Bin={t:number;total:number;passed:number;win:number;loss:number;flat:number;pending:number;notSimulated:number;filtered:number;reconstructed:number;pos:number;neg:number;net:number|null;missing:number;n:number;configs:string[]}
  const bins=new Map<number,Bin>()
  const bin=(t:number)=>{let b=bins.get(t);if(!b){b={t,total:0,passed:0,win:0,loss:0,flat:0,pending:0,notSimulated:0,filtered:0,reconstructed:0,pos:0,neg:0,net:0,missing:0,n:0,configs:[]};bins.set(t,b)}return b}
  // CAST(... AS INTEGER) is load-bearing. A bound divisor binds as REAL, so `x / ?` is float
  // division and `(x / ?) * ?` returns x unchanged: one bucket per launch, each one correct.
  const launches=db.prepare(`SELECT CAST(detected_at / ? AS INTEGER) * ? AS t, COUNT(*) total, COALESCE(SUM(passed),0) passed
    FROM launches WHERE detected_at>=? AND detected_at<=? GROUP BY t ORDER BY t`).all(bucket,bucket,from,to) as Array<{t:number;total:number;passed:number}>
  for(const r of launches){const b=bin(r.t);b.total=r.total;b.passed=r.passed}
  const finish=(extra:{pending:number|null;unavailable:number|null})=>({buckets:[...bins.values()].sort((a,b)=>a.t-b.t).map(b=>({...b,
    filtered:Math.max(0,b.total-b.passed),notSimulated:Math.max(0,b.passed-(b.win+b.loss+b.flat+b.pending)),net:b.missing||!b.n?null:b.net})),...extra})
  const simulated=new Set<string>()
  if(table(db,'shadow_jobs')){
    const hasPublished=(db.prepare('PRAGMA table_info(shadow_jobs)').all() as Array<{name:string}>).some(c=>c.name==='published_at')
    const at=hasPublished?'COALESCE(s.published_at,s.available)':'s.available'
    // NULL sorts last under DESC, so a published row outranks a queued one for the same token
    const jobs=db.prepare(`SELECT t,token,status,config,pnl,size FROM (
        SELECT CAST(l.detected_at / ? AS INTEGER) * ? AS t, s.token, s.status, s.config, s.pnl, s.size,
               ROW_NUMBER() OVER (PARTITION BY s.token ORDER BY ${at} DESC, s.id DESC) rn
        FROM shadow_jobs s JOIN launches l ON l.token=s.token
        WHERE l.detected_at>=? AND l.detected_at<=?) WHERE rn=1`).all(bucket,bucket,from,to) as Array<{t:number;token:string;status:string;config:string;pnl:string|null;size:string|null}>
    for(const r of jobs){
      const b=bin(r.t)
      simulated.add(r.token)
      if(PENDING_STATUSES.includes(r.status)){b.pending++;b.missing++;continue}
      if(r.status!=='published'){if(r.status==='unavailable')b.missing++;continue}
      if(!b.configs.includes(r.config))b.configs.push(r.config)
      if(r.pnl===null||r.size===null||BigInt(r.size)<=0n){b.missing++;continue}
      const v=Number(r.pnl)/Number(r.size);b.n++;b.net=(b.net??0)+v
      if(v>0){b.pos+=v;b.win++}else if(v<0){b.neg+=v;b.loss++}else b.flat++
    }
  }
  fillFromObservations(db,from,to,bucket,observed,rung,simulated,bin,scored)
  return finish(table(db,'shadow_jobs')?shadowCounts(db,to):{pending:null,unavailable:null})
}

/**
 * Coins the shadow account never simulated, scored from the venue observation instead.
 *
 * This is what puts history on the pane before the observer existed. It is NOT the same
 * measurement: obs prices every coin that cleared the entry screen at full notional size,
 * where the shadow account also declines on bankroll, concurrency and template loss blocks.
 * Wider population, same question. The page says so; see `reconstructed` on each bucket.
 */
function fillFromObservations(db:Database.Database,from:number,to:number,bucket:number,
  observed:readonly MarketOutcomeRow[],rung:BarChooser,simulated:ReadonlySet<string>,
  bin:(t:number)=>{reconstructed:number;win:number;loss:number;flat:number;missing:number;n:number;pos:number;neg:number;net:number|null;configs:string[]},
  scored?:readonly ScoredObservation[]){
  const pending=observed.filter(row=>!simulated.has(row.token))
  if(!pending.length)return
  // Score the WHOLE observed set, then drop the simulated ones. Scoring only the unsimulated
  // subset would pick each rung from a gappy history, so the bars could price a coin at a
  // different rung than the lines did. The caller shares its pass when it has one.
  const priced=(scored??scoreObservations(observed,rung)).filter(row=>!simulated.has(row.token))
  // Bucket on the launch's own detection time, the same axis the volume bars use, so a
  // reconstructed outcome cannot land one bar away from the coin it belongs to.
  const at=new Map((db.prepare(`SELECT token, CAST(detected_at / ? AS INTEGER) * ? AS t FROM launches
    WHERE passed=1 AND detected_at>=? AND detected_at<=?`).all(bucket,bucket,from,to) as Array<{token:string;t:number}>)
    .map(r=>[r.token,r.t] as const))
  for(const row of priced){
    const t=at.get(row.token)
    if(t===undefined)continue
    const b=bin(t)
    b.reconstructed++
    if(row.value===null){b.missing++;continue}
    b.n++;b.net=(b.net??0)+row.value
    if(row.value>0){b.pos+=row.value;b.win++}else if(row.value<0){b.neg+=row.value;b.loss++}else b.flat++
  }
}

/**
 * Downtime, read from the balance samples rather than from any halt record.
 *
 * `TruthKeeper.sampleBalance` writes a row about every 25 s for as long as the PROCESS is
 * alive, halted or not, so a gap between samples is the bot being down and nothing else.
 * Gaps are measured between observed rows only: `balance` is pruned to 7 days, so absence
 * at the left edge of a 7-day window is pruning, not an outage, and shading it would be a
 * lie. The chart note already says when samples begin.
 */
export function darkSpans(rows: ReadonlyArray<{at:number}>, to:number, gapMs=120_000): Array<[number,number]> {
  const out: Array<[number,number]> = []
  let prev: number | null = null
  for (const r of rows) {
    if (!Number.isFinite(r.at)) continue
    if (prev !== null && r.at - prev > gapMs) out.push([prev, r.at])
    prev = prev === null ? r.at : Math.max(prev, r.at)
  }
  if (prev !== null && to - prev > gapMs) out.push([prev, to])
  return out
}

const monthStartOf = (ms:number): number => { const d=new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) }
const monthKey = (ms:number): number => { const d=new Date(ms); return d.getUTCFullYear()*12 + d.getUTCMonth() }

export type PaperPoint = { t:number; eth:number }
export type PaperSeries = {
  points: PaperPoint[]; monthStart:number; recordFrom:number|null; monthToDate:number|null
  n:number; wins:number; pending:number; excluded:number; seams:number[]
  dark:Array<[number,number]>; unavailable:string|null
  /** cash events on the drawn line that came from the venue rebuild, and where they start */
  rebuilt:number; rebuiltFrom:number|null
}

/**
 * Downsample without losing the shape. `thin` keeps every n-th point, which on this series
 * would drop the trough: the account fell to -0.30 ETH on 2026-09-12 between two ordinary
 * points, and "how far down did it go" is the question the pane exists to answer. So bin by
 * time and keep each bin's first, lowest, highest and last, the same rule `adaptiveHistory`
 * uses. `keep` carries the structural points on top: the month drop and both edges.
 */
function condense(pts:PaperPoint[], keep:ReadonlySet<number>, max=400): PaperPoint[] {
  if (pts.length <= max) return pts
  const span = pts[pts.length-1]!.t - pts[0]!.t
  const bin = Math.max(1, Math.ceil(span / Math.max(1, Math.floor(max/4))))
  const seen = new Set<number>()
  for (let i=0; i<pts.length; ) {
    const end = pts[i]!.t + bin
    let lo=i, hi=i, j=i
    while (j<pts.length && pts[j]!.t < end) { if(pts[j]!.eth<pts[lo]!.eth)lo=j; if(pts[j]!.eth>pts[hi]!.eth)hi=j; j++ }
    if (j===i) j=i+1
    seen.add(i); seen.add(lo); seen.add(hi); seen.add(j-1)
    i=j
  }
  for (const k of keep) seen.add(k)
  return [...seen].sort((a,b)=>a-b).map(i=>pts[i]!)
}

/**
 * The simulated account's cumulative P&L, in ETH, reset to zero at 00:00 UTC on the 1st.
 *
 * WHY THE WALK STARTS BEFORE THE WINDOW. Every pane is pinned to the lookback (1h..7d), so
 * a month-long line would be clipped to the view and a 1h tab would open at zero. The walk
 * therefore starts at the 1st of the month containing `from`, accumulates silently through
 * the rows the view does not show, and emits its first point AT `from` carrying that total.
 * A 1h view then reads +0.3337 -> +0.3457 instead of 0 -> +0.0120.
 *
 * WHY `close_at`. That is when the modelled position settled, which is what an equity curve
 * means. `entry` books profit before it exists. `available` is the guard's anti-hindsight
 * embargo, a fact about the guard and not about the trade. `published_at` trails `close_at`
 * by 6500 s on average and 31256 s at worst, because publication waits on a gatewatch
 * observation, so plotting on it would shift the whole curve hours right of the money.
 *
 * That lag has a consequence this cannot fix and must not hide: only `published` rows count,
 * so the right edge is always short by whatever has closed and not yet been published.
 * `pending` carries that number to the page, which says it in the chart note.
 *
 * READ-ONLY. Nothing here writes, and nothing here imports from strategy/: the shadow
 * kernel hash covers eight source files, and touching any of them changes every config id
 * and shuts the fresh-recovery guard until 20 new outcomes arrive.
 */
export function paperSeries(db:Database.Database, from:number, to:number,
  balance:ReadonlyArray<{at:number}> = [],
  /** cash events rebuilt from venue observations, for history the account never recorded */
  rebuilt:ReadonlyArray<{t:number;eth:number}> = []): PaperSeries {
  const monthStart = monthStartOf(to)
  const empty = (unavailable:string|null): PaperSeries => ({ points:[], monthStart, recordFrom:null,
    monthToDate:null, n:0, wins:0, pending:0, excluded:0, seams:[], dark:darkSpans(balance,to),
    rebuilt:0, rebuiltFrom:null, unavailable })
  if (!table(db,'shadow_jobs')) return empty('no shadow account tables')

  // Probe every column this reads, not just the newest one. Older databases predate
  // `close_at`, and so do the stub tables the dashboard suites seed; a missing column has to
  // read as "cannot draw this" rather than throw, because a throw here takes the bot with it.
  try {
    const cols=new Set((db.prepare('PRAGMA table_info(shadow_jobs)').all() as Array<{name:string}>).map(c=>c.name))
    for (const need of ['close_at','pnl','size','status','token','id'])
      if (!cols.has(need)) return empty(`shadow_jobs has no ${need} column`)
    // Latest publication wins. NULL sorts last under DESC, so a published row outranks a
    // queued one; with neither timestamp column present, insertion order is the only order.
    const rank=['published_at','available'].filter(c=>cols.has(c)).map(c=>'s.'+c)
    const at = rank.length>1 ? `COALESCE(${rank.join(',')})` : rank[0] ?? 's.id'
    const lo = monthStartOf(from)
    // One row per token. `UNIQUE(token,config)` lets one coin appear once per policy version,
    // and two rows for the same coin would both be added to the running total.
    const rows = db.prepare(`SELECT close_at t, pnl, size FROM (
        SELECT s.close_at, s.pnl, s.size,
               ROW_NUMBER() OVER (PARTITION BY s.token ORDER BY ${at} DESC, s.id DESC) rn
        FROM shadow_jobs s WHERE s.status='published' AND s.close_at IS NOT NULL
          AND s.close_at>=? AND s.close_at<=?) WHERE rn=1 ORDER BY t`)
      .all(lo,to) as Array<{t:number;pnl:string|null;size:string|null}>

    const recordFrom = (db.prepare("SELECT MIN(close_at) m FROM shadow_jobs WHERE status='published' AND close_at IS NOT NULL")
      .get() as {m:number|null}).m ?? null
    const pending = (db.prepare("SELECT COUNT(*) n FROM shadow_jobs WHERE status='modeled'").get() as {n:number}).n ?? 0
    // One seam per policy or kernel version after the first, placed at its first launch. Its
    // two columns are probed separately: a database that cannot name its policy versions can
    // still draw the line, and losing the ticks is a smaller loss than losing the pane.
    const seams = cols.has('entry') && cols.has('config')
      ? (db.prepare('SELECT MIN(entry) m FROM shadow_jobs GROUP BY config ORDER BY m').all() as Array<{m:number}>)
        .map(r=>r.m).slice(1).filter(m=>m>=from&&m<=to)
      : []

    // The rebuild covers only what the account never recorded. A recorded row always wins, so
    // the two never double-count the same day, and the seam is a change of source, not of
    // arithmetic. `lineStart` no longer clamps to `recordFrom`: that is the whole point.
    const lo2 = monthStartOf(from)
    const fill = recordFrom === null ? rebuilt : rebuilt.filter(r => r.t < recordFrom)
    const merged: Array<{t:number;pnl:string|null;size:string|null;eth?:number}> = [
      ...fill.filter(r => r.t >= lo2 && r.t <= to).map(r => ({t:r.t, pnl:null, size:null, eth:r.eth})),
      ...rows,
    ].sort((a,b) => a.t - b.t)
    const rebuiltFrom = fill.length ? Math.max(lo2, fill[0]!.t) : null
    // Earliest instant the pane can draw: the window's left edge, or the first cash event if
    // the account has nothing older. The walk still accumulates silently from the month start
    // through rows the view does not show, so a 1h tab opens at the running total, not at 0.
    const lineStart = Math.max(from, merged[0]?.t ?? from)
    const curMonth = monthKey(to)
    const pts:PaperPoint[] = []
    const keep = new Set<number>()
    let run = 0, month = monthKey(lo), excluded = 0, n = 0, wins = 0, emittedLeft = false
    for (const r of merged) {
      if (monthKey(r.t) !== month) {
        const b = monthStartOf(r.t)
        if (b >= lineStart) { keep.add(pts.push({t:b-1,eth:round6(run)})-1); keep.add(pts.push({t:b,eth:0})-1) }
        run = 0; month = monthKey(r.t)
      }
      if (!emittedLeft && r.t >= lineStart) { keep.add(pts.push({t:lineStart,eth:round6(run)})-1); emittedLeft = true }
      if (r.eth !== undefined) {
        run += r.eth
        if (monthKey(r.t) === curMonth) { n++; if (r.eth>0) wins++ }
        if (r.t >= lineStart) pts.push({t:r.t,eth:round6(run)})
        continue
      }
      const pnl = Number(r.pnl), size = Number(r.size)
      if (r.pnl===null || r.size===null || !Number.isFinite(pnl) || !Number.isFinite(size) || size<=0) { excluded++; continue }
      run += pnl/1e18
      if (monthKey(r.t) === curMonth) { n++; if (pnl>0) wins++ }
      if (r.t >= lineStart) pts.push({t:r.t,eth:round6(run)})
    }
    if (!emittedLeft && recordFrom !== null && lineStart <= to) { keep.add(pts.push({t:lineStart,eth:round6(run)})-1); emittedLeft = true }
    if (pts.length) keep.add(pts.push({t:to,eth:round6(run)})-1)

    return { points:condense(pts,keep), monthStart, recordFrom,
      monthToDate:recordFrom===null&&!fill.length?null:round6(run),
      n, wins, pending, excluded, seams, dark:darkSpans(balance,to),
      rebuilt:fill.filter(r=>r.t>=lineStart&&r.t<=to).length, rebuiltFrom, unavailable:null }
  } catch (e) {
    // chartSnapshot runs inside the trading process and /api/chart returns {error} on a
    // throw, which blanks EVERY pane. One unreadable pane beats five, so this one fails
    // alone and says why.
    return empty(String((e as Error)?.message ?? e).slice(0,120))
  }
}
const round6 = (v:number): number => Math.round(v*1e6)/1e6

/**
 * How the venue's replayed outcome compares to what the account actually booked, on the coins
 * where BOTH ran. Measured here rather than hard-coded so it tightens as the record grows.
 *
 * On 2026-09-13 this read 0.882 over 525 shared coins: the venue replay is 12% richer than
 * the account, not the 2x the older analysis notes claim for `obs.bars` against REAL trades.
 * The two comparisons are different questions and both are true; this is the one that matters
 * for joining a rebuilt stretch to a recorded one without a step at the seam.
 *
 * Under 100 shared coins the ratio is noise, so it returns 1.0 and says so: an unscaled
 * rebuild is an honest statement of the venue's own number, a ratio fitted on 20 coins is not.
 */
export function paperCalibration(db:Database.Database, bars:ReadonlyMap<string,Record<string,number>>):
  {scale:number; n:number; measured:boolean} {
  const none={scale:1,n:0,measured:false}
  if(!table(db,'shadow_jobs')||!bars.size)return none
  try{
    const rows=db.prepare(`SELECT token,pnl,size,intent FROM shadow_jobs
      WHERE status='published' AND pnl IS NOT NULL AND size IS NOT NULL`)
      .all() as Array<{token:string;pnl:string;size:string;intent:string}>
    let account=0,venue=0,n=0
    for(const r of rows){
      const b=bars.get(r.token.toLowerCase()); if(!b)continue
      let tp:unknown=null; try{tp=(JSON.parse(r.intent) as {tp?:unknown}).tp}catch{continue}
      if(typeof tp!=='number')continue
      const v=b[tp.toFixed(2)]; if(typeof v!=='number'||!Number.isFinite(v))continue
      const stake=Number(r.pnl)/Number(r.size); if(!Number.isFinite(stake))continue
      account+=stake; venue+=v; n++
    }
    if(n<100||Math.abs(venue)<1e-9)return none
    // Clamp rather than trust: a near-zero denominator or a lopsided window could otherwise
    // put a 5x multiplier on eleven days of chart.
    return {scale:Math.min(1.2,Math.max(0.5,account/venue)),n,measured:true}
  }catch{return none}
}
