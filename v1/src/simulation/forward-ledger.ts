import Database from 'better-sqlite3'
import {existsSync} from 'node:fs'
import {SCENARIO_IDS} from '../strategy/execution-scenarios.js'
import type {GuardPolicy,ScenarioReading} from '../strategy/scenario-guard.js'
import {digest} from './store.js'
import type {buildScenarioObserver} from './scenario-observer.js'

type Observer=NonNullable<ReturnType<typeof buildScenarioObserver>>
export type ForwardPublication=Observer['publications'][number]

/** The one place the book defaults, so 'main' is written in exactly one file. */
export const DEFAULT_BOOK='main'

export function ensureForwardSchema(db:Database.Database){
  db.exec(`CREATE TABLE IF NOT EXISTS forward_runtime(model TEXT,policy_hash TEXT,start_at INTEGER,book TEXT NOT NULL DEFAULT '${DEFAULT_BOOK}',PRIMARY KEY(model,book));
    CREATE TABLE IF NOT EXISTS simulation_epochs(id TEXT PRIMARY KEY,model TEXT,config TEXT,policy TEXT,started_at INTEGER,ended_at INTEGER,last_at INTEGER,reason TEXT);
    CREATE INDEX IF NOT EXISTS simulation_epoch_time ON simulation_epochs(started_at,ended_at);
    CREATE TABLE IF NOT EXISTS forward_publications(epoch TEXT,execution_id TEXT,scenario TEXT,launch_at INTEGER,close_at INTEGER,published_at INTEGER,payload TEXT,PRIMARY KEY(epoch,execution_id,scenario));
    CREATE INDEX IF NOT EXISTS forward_publication_time ON forward_publications(epoch,published_at,scenario);
    CREATE INDEX IF NOT EXISTS forward_published_time ON forward_publications(published_at,scenario);
    CREATE INDEX IF NOT EXISTS forward_launch_time ON forward_publications(launch_at,scenario);
    CREATE TABLE IF NOT EXISTS forward_indicators(epoch TEXT,at INTEGER,published_at INTEGER,payload TEXT,PRIMARY KEY(epoch,at));
    CREATE INDEX IF NOT EXISTS forward_indicator_time ON forward_indicators(at);
    CREATE TRIGGER IF NOT EXISTS forward_publications_immutable BEFORE UPDATE ON forward_publications BEGIN SELECT RAISE(ABORT,'forward publications are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS forward_publications_no_delete BEFORE DELETE ON forward_publications BEGIN SELECT RAISE(ABORT,'forward publications are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS forward_indicators_immutable BEFORE UPDATE ON forward_indicators BEGIN SELECT RAISE(ABORT,'forward indicators are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS forward_indicators_no_delete BEFORE DELETE ON forward_indicators BEGIN SELECT RAISE(ABORT,'forward indicators are immutable'); END;`)
  const publicationColumns=db.prepare('PRAGMA table_info(forward_publications)').all() as Array<{name:string}>
  if(!publicationColumns.some(c=>c.name==='durable_at'))db.exec('ALTER TABLE forward_publications ADD COLUMN durable_at INTEGER')
  // THE BOOK, added 2026-09-16, and load-bearing rather than descriptive.
  //
  // Every close below is "end every open epoch that is not this one". With one book that is
  // correct and says "a config change starts a new segment". With two books it is mutual
  // destruction, and it was measured rather than guessed: after one tick each, BOTH epochs
  // carry ended_at BEFORE their own started_at, zero epochs are open, and both keep receiving
  // publications forever. Nothing throws, the chart's segments are silently wrong, and
  // forward_publications is immutable so it cannot be repaired by re-running.
  //
  // Scoping every close to the book is what makes "a config change ends MY segment" true
  // again. Existing rows backfill to 'main', which is what one book has always been.
  const epochColumns=db.prepare('PRAGMA table_info(simulation_epochs)').all() as Array<{name:string}>
  if(!epochColumns.some(c=>c.name==='book')){
    db.exec("ALTER TABLE simulation_epochs ADD COLUMN book TEXT")
    db.exec("UPDATE simulation_epochs SET book='main' WHERE book IS NULL")
  }
  // forward_runtime needs the book IN THE PRIMARY KEY, not merely as a column: the model hash
  // does not vary by book, so keyed on model alone two books share one row, each reads the
  // other's policy hash as a change, and start_at jumps forward on every tick so no epoch ever
  // looks compatible. SQLite cannot ALTER a primary key, so an existing table is rebuilt.
  // It holds one row per model and carries no immutability trigger, so a rebuild is safe.
  const runtimeColumns=db.prepare('PRAGMA table_info(forward_runtime)').all() as Array<{name:string}>
  if(!runtimeColumns.some(c=>c.name==='book')){
    db.transaction(()=>{
      db.exec(`CREATE TABLE forward_runtime_v2(model TEXT,policy_hash TEXT,start_at INTEGER,book TEXT NOT NULL DEFAULT '${DEFAULT_BOOK}',PRIMARY KEY(model,book));`)
      db.exec(`INSERT INTO forward_runtime_v2(model,policy_hash,start_at,book) SELECT model,policy_hash,start_at,'${DEFAULT_BOOK}' FROM forward_runtime;`)
      db.exec('DROP TABLE forward_runtime;')
      db.exec('ALTER TABLE forward_runtime_v2 RENAME TO forward_runtime;')
    })()
  }
}



/** A compatible restart keeps this boundary. A policy change starts forward from now. */
export function forwardStart(db:Database.Database,model:string,policy:GuardPolicy,now:number,book:string=DEFAULT_BOOK){
  ensureForwardSchema(db)
  const policyHash=digest(policy)
  // Keyed by (model, book). `model` alone is the same for every book, so without the book a
  // second book reads the first one's policy hash, calls it a change, and moves start_at.
  const row=db.prepare('SELECT policy_hash policyHash,start_at startAt FROM forward_runtime WHERE model=? AND COALESCE(book,?)=?').get(model,DEFAULT_BOOK,book) as {policyHash:string;startAt:number}|undefined
  if(row?.policyHash===policyHash){
    db.prepare('UPDATE simulation_epochs SET ended_at=? WHERE ended_at IS NULL AND model<>? AND COALESCE(book,?)=?').run(now-1,model,DEFAULT_BOOK,book)
    return row.startAt
  }
  db.transaction(()=>{
    // Scoped to this book. Unscoped, starting book B ends book A's live epoch.
    db.prepare('UPDATE simulation_epochs SET ended_at=? WHERE ended_at IS NULL AND COALESCE(book,?)=?').run(now-1,DEFAULT_BOOK,book)
    db.prepare('DELETE FROM forward_runtime WHERE model=? AND COALESCE(book,?)=?').run(model,DEFAULT_BOOK,book)
    db.prepare('INSERT INTO forward_runtime(model,policy_hash,start_at,book) VALUES (?,?,?,?)').run(model,policyHash,now,book)
  })()
  return now
}

/** Materialize the worker result before it is sent to the trading process. */
export function publishForwardObserver(db:Database.Database,observer:Observer,book:string=DEFAULT_BOOK){
  ensureForwardSchema(db)
  const epoch=digest([observer.modelHash,observer.configId,observer.policy,observer.recordFrom])
  const groups=new Map<string,ForwardPublication[]>()
  for(const p of observer.publications){const rows=groups.get(p.executionId)??[];rows.push(p);groups.set(p.executionId,rows)}
  for(const [id,rows] of groups)if(rows.length!==SCENARIO_IDS.length||SCENARIO_IDS.some(s=>rows.filter(r=>r.scenario===s).length!==1))throw new Error('incomplete forward publication '+id)
  // The replay contains source-time readings that can legitimately improve when delayed
  // evidence arrives. Those readings are useful offline, but rewriting one would make a
  // live ledger claim the worker knew evidence before it was durably available. Persist
  // only the current reading at its durable worker publication time.
  const latestIndicator=db.prepare('SELECT at,payload FROM forward_indicators WHERE epoch=? ORDER BY at DESC LIMIT 1').get(epoch) as {at:number;payload:string}|undefined
  const comparableReading=(reading:ScenarioReading)=>JSON.stringify({...reading,at:0})
  const currentReading=observer.reading
  const latestReading=latestIndicator?JSON.parse(latestIndicator.payload) as ScenarioReading:null
  const indicatorChanged=!latestReading||comparableReading(latestReading)!==comparableReading(currentReading)
  const indicatorAt=Math.max(observer.at,(latestIndicator?.at??-1)+1)
  const reading=indicatorChanged?{...currentReading,at:indicatorAt}:null
  const insertPublication=db.prepare('INSERT OR IGNORE INTO forward_publications(epoch,execution_id,scenario,launch_at,close_at,published_at,payload,durable_at) VALUES (?,?,?,?,?,?,?,?)')
  const priorPublication=db.prepare('SELECT payload FROM forward_publications WHERE epoch=? AND execution_id=? AND scenario=?')
  const insertIndicator=db.prepare('INSERT INTO forward_indicators VALUES (?,?,?,?)')
  db.transaction(()=>{
    // AND book: without it, publishing book B ends book A's epoch and vice versa, until both
    // are marked ended before they started and neither is open. Measured, not theorised.
    db.prepare('UPDATE simulation_epochs SET ended_at=? WHERE ended_at IS NULL AND id<>? AND COALESCE(book,?)=?').run(observer.recordFrom-1,epoch,DEFAULT_BOOK,book)
    db.prepare('INSERT OR IGNORE INTO simulation_epochs(id,model,config,policy,started_at,ended_at,last_at,reason,book) VALUES (?,?,?,?,?,?,?,?,?)').run(epoch,observer.modelHash,observer.configId,JSON.stringify(observer.policy),observer.recordFrom,null,observer.at,observer.failure,book)
    db.prepare('UPDATE simulation_epochs SET last_at=?,reason=? WHERE id=?').run(observer.at,observer.failure,epoch)
    for(const p of observer.publications){
      const payload=JSON.stringify(p),old=priorPublication.get(epoch,p.executionId,p.scenario) as {payload:string}|undefined
      if(old&&old.payload!==payload)throw new Error('conflicting forward publication '+p.executionId+':'+p.scenario)
      insertPublication.run(epoch,p.executionId,p.scenario,p.launchAt,p.closeAt,p.publicationAt,payload,observer.at)
    }
    if(reading)insertIndicator.run(epoch,reading.at,observer.publicationAt,JSON.stringify(reading))
    db.prepare("INSERT OR REPLACE INTO checkpoints(name,value,at) VALUES ('forward-ledger',?,?)").run(JSON.stringify({epoch,modelHash:observer.modelHash,configId:observer.configId,publicationAt:observer.publicationAt,complete:observer.complete,failure:observer.failure}),observer.at)
  })()
  return epoch
}

type Epoch={id:string;model:string;config:string;policy:string;startedAt:number;endedAt:number|null;lastAt:number;reason:string|null}
const openReadonly=(path:string)=>{const db=new Database(path,{readonly:true,fileMustExist:true});db.pragma('busy_timeout = 5');return db}

/**
 * Read-only chart projection. It never replays an execution or advances the guard.
 *
 * SCOPED TO ONE BOOK, and it has to be. Phase 2 gave every book its own epoch, its own
 * configId and its own guard tape over one shared evidence set. Reading the table unscoped
 * would interleave two books' publications into one cumulative line and one indicator
 * series, which is not a blend of the two books, it is a third thing that no book traded.
 *
 * `book` defaults to the name of book 0, so a single-book install and every ledger written
 * before the column existed (backfilled to 'main') read exactly as they did before.
 */
export function readForwardLedger(path:string|undefined,from:number,to:number,now=Date.now(),book=DEFAULT_BOOK){
  if(!path||!existsSync(path))return null
  let db:Database.Database|undefined
  try{
    db=openReadonly(path)
    if(!(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='simulation_epochs'").get()))return null
    // A ledger written before phase 2 has no `book` column at all, and this reader opens the
    // file READ-ONLY, so it cannot migrate one in. Fall back to an unscoped read there: every
    // such row predates books and belongs to book 0 by construction.
    const hasBook=(db.pragma('table_info(simulation_epochs)') as Array<{name:string}>).some(c=>c.name==='book')
    const bookWhere=hasBook?' AND COALESCE(book,?)=?':''
    const bookArgs=hasBook?[DEFAULT_BOOK,book]:[]
    const epochs=db.prepare(`SELECT id,model,config,policy,started_at startedAt,ended_at endedAt,last_at lastAt,reason FROM simulation_epochs
      WHERE started_at<=? AND COALESCE(ended_at,?)>=?${bookWhere} ORDER BY started_at`).all(to,to,from,...bookArgs) as Epoch[]
    if(!epochs.length)return null
    const allEpochs=db.prepare(`SELECT id,model,config,policy,started_at startedAt,ended_at endedAt,last_at lastAt,reason FROM simulation_epochs WHERE 1=1${bookWhere} ORDER BY started_at`).all(...bookArgs) as Epoch[]
    const heartbeatRow=db.prepare("SELECT value,at FROM checkpoints WHERE name='writer'").get() as {value:string;at:number|null}|undefined
    let heartbeatAt=heartbeatRow?.at??0
    if(heartbeatRow)try{heartbeatAt=Math.max(heartbeatAt,Number((JSON.parse(heartbeatRow.value) as {at?:number}).at??0))}catch{/* checkpoint timestamp remains authoritative */}
    const workerLive=now-heartbeatAt<=15000
    const maxAge=Math.max(...epochs.map(e=>JSON.parse(e.policy).ageMs),0)
    const pubRows=db.prepare("SELECT epoch,durable_at durableAt,payload FROM forward_publications WHERE COALESCE(durable_at,published_at)<=? AND (scenario='p50-after' OR launch_at>=?) ORDER BY COALESCE(durable_at,published_at),execution_id,scenario").all(to,from-maxAge) as Array<{epoch:string;durableAt:number|null;payload:string}>
    const publications=pubRows.map(r=>({epoch:r.epoch,durableAt:r.durableAt,...JSON.parse(r.payload) as ForwardPublication}))
    const paperPoints:Array<{t:number;eth:number|null;epoch:string}>=[],cash:Array<{id:string;at:number;pnlWei:string;epoch:string}>=[],segments:any[]=[]
    for(const e of epochs){
      const rows=publications.filter(p=>p.epoch===e.id&&p.scenario==='p50-after'&&p.admissionStatus==='admitted'&&p.pnlWei!==null&&p.closeAt!==null).sort((a,b)=>a.closeAt!-b.closeAt!||a.executionId.localeCompare(b.executionId))
      let total=0n
      for(const p of rows)if(p.closeAt!<from)total+=BigInt(p.pnlWei!)
      const start=Math.max(from,e.startedAt);paperPoints.push({t:start,eth:Number(total)/1e18,epoch:e.id})
      for(const p of rows)if(p.closeAt!>=from&&p.closeAt!<=to){total+=BigInt(p.pnlWei!);paperPoints.push({t:p.closeAt!,eth:Number(total)/1e18,epoch:e.id});cash.push({id:p.executionId,at:p.closeAt!,pnlWei:p.pnlWei!,epoch:e.id})}
      const live=e.endedAt===null&&workerLive,end=Math.min(to,e.endedAt??(live?to:e.lastAt))
      if(end>=start)paperPoints.push({t:end,eth:Number(total)/1e18,epoch:e.id})
      if(end<to)paperPoints.push({t:end+1,eth:null,epoch:e.id})
      segments.push({id:e.id,from:e.startedAt,through:end,modelHash:e.model,configId:e.config,live,reason:e.reason})
    }
    const p50=publications.filter(p=>p.scenario==='p50-after'&&p.launchAt>=from&&p.launchAt<=to).map(p=>({id:p.executionId,token:p.token,at:p.launchAt,entryAt:p.detectedAt,exitAt:p.closeAt,availableAt:p.publicationAt,durableAt:p.durableAt,pnlWei:p.pnlWei,sizeWei:p.stakeWei,configId:p.configId,scenario:p.scenario,status:p.executionStatus,reason:p.executionReason,indicatorEvidence:p.indicatorEvidence,admission:{status:p.admissionStatus,reason:p.admissionReason},epoch:p.epoch}))
    const indicatorRows=db.prepare('SELECT epoch,at,payload FROM forward_indicators WHERE at<=? ORDER BY at').all(to) as Array<{epoch:string;at:number;payload:string}>
    const market:any[]=[],events:any[]=[]
    for(const e of epochs){
      const rows=indicatorRows.filter(r=>r.epoch===e.id).map(r=>JSON.parse(r.payload) as ScenarioReading)
      const prior=rows.filter(r=>r.at<from).at(-1),visible=[...(prior?[{...prior,at:from}]:[]),...rows.filter(r=>r.at>=from&&r.at<=to)]
      let previous:string|undefined
      for(const r of visible){
        const complete=r.scenarios.length===SCENARIO_IDS.length&&r.scenarios.every(s=>s.fresh&&s.n>=r.policy.n&&s.recentN>=r.policy.m)
        const scoreAvailable=r.scenarios.length===SCENARIO_IDS.length&&r.scenarios.every(s=>s.n>0&&s.recentN>0&&Number.isFinite(s.sum)&&Number.isFinite(s.recentSum))
        const point:any={t:r.at,epoch:e.id,modelHash:e.model,configId:r.configId,state:r.state,reason:r.reason,source:'forward-ledger',fresh:complete,n:Math.min(...r.scenarios.map(s=>s.n)),sum:scoreAvailable?Math.min(...r.scenarios.map(s=>s.sum)):null,recentSum:scoreAvailable?Math.min(...r.scenarios.map(s=>s.recentSum)):null,scenarios:r.scenarios,window:r.policy.n,recoveryWindow:r.policy.m,pauseBelow:r.policy.off,resumeAbove:r.policy.freshOn,policyId:r.policy.id,verified:false}
        const evidence=publications.filter(p=>p.epoch===e.id&&p.indicatorEvidence&&(p.durableAt??p.publicationAt)<=r.at)
        point.scenarios=point.scenarios.map((s:any)=>{
          const tape=evidence.filter(p=>p.scenario===s.id&&p.configId===r.configId).map(p=>({p,value:Number(p.pnlWei)/Number(p.stakeWei)}))
          const main=[...tape].sort((a,b)=>b.p.launchAt-a.p.launchAt||b.p.token.localeCompare(a.p.token)).slice(0,r.policy.n)
          const fresh=tape.filter(x=>r.at-x.p.launchAt<=r.policy.ageMs).sort((a,b)=>b.p.launchAt-a.p.launchAt||b.p.token.localeCompare(a.p.token)).slice(0,r.policy.m)
          const sum=(x:typeof tape)=>x.reduce((n,v)=>n+v.value,0)
          const match=main.length===s.n&&fresh.length===s.recentN&&Math.abs(sum(main)-s.sum)<1e-9&&Math.abs(sum(fresh)-s.recentSum)<1e-9
          return {...s,mainTokens:match?main.map(x=>x.p.token):null,freshTokens:match?fresh.map(x=>x.p.token):null}
        })
        market.push(point);if(previous!==r.state){events.push({t:r.at,state:r.state,reason:r.reason});previous=r.state}
      }
      const end=Math.min(to,e.endedAt??e.lastAt);if(end<to)market.push({t:end+1,epoch:e.id,sum:null,recentSum:null,fresh:false,reason:e.reason??'ledger_not_current'})
    }
    const latest=allEpochs.at(-1)!,live=latest.endedAt===null&&workerLive
    const complete=live&&!latest.reason
    const visiblePnlWei=cash.reduce((sum,p)=>sum+BigInt(p.pnlWei),0n)
    return {epochs:segments,paper:{cash,points:paperPoints.sort((a,b)=>a.t-b.t),dark:[],seams:[],estimated:true,monthToDate:null,n:cash.length,wins:cash.filter(p=>BigInt(p.pnlWei)>0n).length,recordFrom:epochs[0]!.startedAt,recordedPnlEth:Number(visiblePnlWei)/1e18,pending:0,unavailable:complete?0:1,coverage:{complete,from:epochs[0]!.startedAt,through:segments.at(-1)!.through},health:{stalled:!live,fault:latest.reason??(live?null:'forward worker stale'),pending:0,lastClose:cash.at(-1)?.at??null,heartbeatAt:heartbeatAt||null},account:'continuous-scenario',scenario:'p50-after',source:'forward-ledger',modelHash:latest.model,label:'24h baseline'},coins:p50,market,events,latest}
  }catch{return null}finally{db?.close()}
}
