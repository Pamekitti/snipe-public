import { dashboardMoney, effectiveMarketPolicy, bookedWindow } from '../src/telemetry/dashboard-policy.js'
import { rollingKpis } from '../src/telemetry/kpi.js'
import { liveBooks } from '../src/strategy/books.js'
/** Serve captured data locally. Both databases are read-only; control requests are refused. */
import http from 'node:http'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { operatorState } from '../src/telemetry/operator-state.js'
import { dashboardNotices, dashboardBanner } from '../src/telemetry/dashboard-notices.js'
import { LEVELS } from '../src/telemetry/levels.js'
const option=(name:string)=>{const i=process.argv.indexOf('--'+name);return i<0?undefined:process.argv[i+1]}
const stateFile=option('state'),dbFile=option('db'),gateFile=option('gate'),simFile=option('simulation')
if(!stateFile||!dbFile||!gateFile)throw new Error('Usage: ENV_FILE=.env.example node --import tsx scripts/dashboard-preview.ts --state snapshot.json --db bot.db --gate gate.db [--simulation bot.simulation.db] [--port 8799]')
process.env.GATE_DB=gateFile
const { chartSnapshot, bookSummary, bookRejectFunnel, bookDelta, unstampedBook }=await import('../src/telemetry/dashboard.js')
const { dashboardHtml }=await import('../src/telemetry/dashboard-page.js')
const db=new Database(dbFile,{readonly:true,fileMustExist:true})
const s=JSON.parse(fs.readFileSync(stateFile,'utf8')),capturedAt=s.capturedAt??s.at
if(!Number.isFinite(capturedAt))throw new Error('Snapshot needs capturedAt or at in milliseconds')
const config=s.config.values,k=s.risk,venue=k.venue,gate=s.gate
const latest=db.prepare('SELECT MAX(at) at FROM guard_samples WHERE live=1').get() as {at:number|null}
// This projects captured owner inputs through the same presentation function as the bot.
// Missing execution/recovery evidence stays missing rather than being replayed.
const operator=s.operator??operatorState({now:capturedAt,mode:s.mode,kinds:k.haltKinds,
  reasons:k.haltKinds.map((kind:any)=>({kind,reason:kind===k.haltKind?k.haltReason:kind+' stop is active',since:null})),
  drawdownEth:k.drawdownEth,limitEth:k.drawdownLimitEth,open:k.open,databaseOpen:s.discipline.openRows,capacity:k.maxConcurrent,
  deployedEth:k.deployedEth,bankrollEth:k.bankrollEth,tradeSizeEth:k.tradeSizeEth,
  logsHealthy:s.plumbing.logsHealthy,logsAgeMs:s.plumbing.logsAgeMs,logsLimitMs:s.plumbing.logsStaleLimit,lastEntryAt:null,
  market:venue?{...venue,ageMs:latest.at===null?Infinity:Math.max(0,capturedAt-latest.at)}:null,
  marketBar:venue?Number(venue.bar):undefined,marketWindow:config.venuePauseWindow,marketOff:config.venuePauseOff,marketOn:config.venuePauseOn,marketFreshMs:config.venueFreshHours*3600000,
  touch:gate?{...gate,ageMs:gate.readingAgeMs??0}:null,touchWindow:gate?.window??20,touchOff:gate?.shutAt??10,touchOn:gate?.openAt??25,
  execution:k.broken??null,executionWindow:20,executionLimit:config.brokenGapPp,
  recovery:null,recoveryWindow:config.ddResumeWindow,recoveryOn:config.ddResumeOn,liftsUsed:k.ddLiftsUsed,liftsLimit:2,
})
const notices=dashboardNotices({alerts:s.alerts,operator,now:capturedAt,balanceAt:s.truth.lastBalanceAt,priceAgeMs:s.truth.priceAgeMs,priceSource:s.truth.priceSource})
const bannerAlerts=dashboardBanner({alerts:s.alerts,notices,haltKinds:k.haltKinds,unresolvedExits:s.discipline.stuck+s.discipline.parked})
const marketPolicy=s.marketPolicy??effectiveMarketPolicy(config.venueFreshRecovery,{window:config.venuePauseWindow,off:config.venuePauseOff,on:config.venuePauseOn,freshMs:config.venueFreshHours*3600000})
const savedStrategy=JSON.parse((db.prepare("SELECT value FROM chain_truth WHERE key='strategy_json'").get() as {value:string}|undefined)?.value??'{}')
if(!s.marketPolicy && savedStrategy.venueRecoveryPolicy){
  const guard=s.operator?.guards?.find((g:any)=>g.id==='venue')
  Object.assign(marketPolicy,{id:savedStrategy.venueRecoveryPolicy,source:savedStrategy.venueIndicator,
    window:guard?.required??marketPolicy.window,pauseBelow:guard?.stopAt??marketPolicy.pauseBelow,
    recoveryWindow:savedStrategy.venueRecoveryWindow,recoverAbove:savedStrategy.venueRecoveryOn})
}
const capturedGate={holdMs:savedStrategy.gateHoldMs}
const kpis=s.kpis.map((w:any)=>{const cash=bookedWindow(db,capturedAt-w.ms,capturedAt,s.truth.priceUsd);return {...w,n:cash.n,pnlUsd:cash.bookUsd,rotPct:cash.rotPct,winRate:cash.winPct,attempts:cash.attempts,missing:cash.missing}})
// THE BOOKS, rebuilt here rather than replayed. A captured snapshot predates the block, so
// without this the whole book card is hidden in the preview and every browser assertion
// about it is unreachable, which reads as a passing test rather than as missing data. This is
// the same mistake `--simulation` was added to fix; see the note below.
const previewBooks=liveBooks()
const previewFunnel=bookRejectFunnel(db,previewBooks,capturedAt-24*3600_000,capturedAt)
// A captured bot.db is read-only and may predate the column entirely, so ask before naming it.
const previewHasBook=(db.pragma('table_info(positions)') as Array<{name:string}>).some(c=>c.name==='book')
const previewTrades=db.prepare(`SELECT exit_at, CAST(spend_wei AS REAL) spend,
  CAST(COALESCE(onchain_pnl_wei, pnl_wei) AS REAL) pnl, exit_reason, (onchain_pnl_wei IS NOT NULL) verified,
  `+(previewHasBook?'COALESCE(book, ?)':'?')+` book FROM positions WHERE live=1 AND closed=1 AND exit_at >= ?`)
  .all(unstampedBook(previewBooks),capturedAt-7*86_400_000) as any[]
const unattributedTrades=previewBooks.length>1?previewTrades.filter(r=>r.book==null).length:0
const books=previewBooks.map(b=>{
  const rows=previewTrades.filter(r=>(r.book??unstampedBook(previewBooks))===b.id)
  const funnel=previewFunnel.get(b.id)??{buckets:{},n:0,entered:0,basis:'band'}
  return {id:b.id,minTaxBps:b.minTaxBps,maxTaxBps:b.maxTaxBps,digest:b.digest,
    band:b.minTaxBps+'-'+b.maxTaxBps+' bps',
    kpis:rollingKpis(rows,capturedAt,s.truth.priceUsd),
    trades:{...bookSummary(rows,s.truth.priceUsd),windowMs:7*86_400_000},
    rejects:{...funnel,note:'of '+funnel.n+' launches in this band that passed the book screen, last 24h'},
    guard:null,controllable:false,
    controlWhy:'per-book pause needs the per-book risk split (phase 4). STOP halts the wallet.'}
})
const delta=bookDelta(books)
const money=dashboardMoney(db,capturedAt,s.truth.priceUsd)
// `--simulation` is optional but the paper and market panes are EMPTY without it: since the
// chart moved onto the forward ledger, chartSnapshot reads `bot.simulation.path` and returns
// its warming-up fallback when there is none. That made every paper assertion in
// alignment.browser.mjs unreachable, which reads as a broken test rather than missing data.
const source={tel:{raw:()=>db},priceReading:()=>({usd:s.truth.priceUsd}),
  simulation:simFile?{path:simFile,status:null}:undefined} as any
const charts=new Map<string,unknown>()
const server=http.createServer((req,res)=>{
  res.setHeader('cache-control','no-store')
  if(req.method!=='GET'){res.writeHead(405);return res.end('Read-only snapshot. Controls are disabled.')}
  try{
    const url=new URL(req.url??'/','http://localhost')
    if(url.pathname==='/api/state'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({...s,kpis,money,marketPolicy,operator,notices,bannerAlerts,books,delta,unattributedTrades,levels:LEVELS,at:Date.now(),preview:true,capturedAt}))}
    if(url.pathname==='/api/chart'){
      const key=url.searchParams.get('h')??'4h'
      // Validated against the configured names for the same reason the live route does it:
      // the cache key includes the book, so an unvalidated one lets any URL mint an entry.
      const asked=url.searchParams.get('book')
      const bookKey=asked==='vs'?'vs':asked&&books.some(b=>b.id===asked)?asked:''
      const cacheKey=key+':'+bookKey
      if(!charts.has(cacheKey))charts.set(cacheKey,chartSnapshot(source,key,capturedAt,false,bookKey||undefined))
      res.setHeader('content-type','application/json');return res.end(JSON.stringify(charts.get(cacheKey)))
    }
    res.setHeader('content-type','text/html; charset=utf-8');res.end(dashboardHtml(capturedGate))
  }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:String(error)}))}
})
server.listen(Number(option('port')??8799),'127.0.0.1',()=>console.log('Read-only dashboard snapshot: http://127.0.0.1:'+(option('port')??8799)))
