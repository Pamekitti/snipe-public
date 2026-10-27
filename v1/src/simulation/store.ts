import { MODEL_HASH } from './identity.js'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { EXECUTION_VERSION, EVIDENCE_VERSION } from '../strategy/execution-model.js'
import { SCENARIO_IDS, SCENARIO_VERSION, compactBundle, type ExecutionBundle } from '../strategy/execution-scenarios.js'
import { EVENT_TOPICS, logWord } from '../abi.js'
export const encode=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?String(x):x)
export const digest=(v:unknown)=>createHash('sha256').update(encode(v)).digest('hex')
export type CaptureEvent={session:string;sequence:number;at:number;kind:string;key:string;payload:unknown;provenance:'prospective'|'reconstruction'}
export class SimulationStore {
  readonly db:Database.Database
  /**
   * Set by every write that can change the paper report, cleared by the worker when it
   * rebuilds. The report is a pure function of these tables, so an unchanged database
   * cannot produce a different report.
   */
  dirty=true
  private lastCheckpointPrune=0
  constructor(path:string){
    this.db=new Database(path);this.db.pragma('journal_mode = WAL');this.db.pragma('busy_timeout = 1000')
    // capture_chronology(at,session,sequence) is dropped, not created: no query ordered by
    // `at` alone, but SQLite chose it for the report's kind= scan and walked every row of the
    // table to test a column it did not carry. That was the 2026-09-13 outage.
    this.db.exec(`DROP INDEX IF EXISTS capture_chronology;
      CREATE TABLE IF NOT EXISTS captures(session TEXT,sequence INTEGER,at INTEGER,kind TEXT,key TEXT,payload TEXT,provenance TEXT,hash TEXT,PRIMARY KEY(session,sequence));
      CREATE INDEX IF NOT EXISTS capture_key ON captures(key,kind,at);
      CREATE INDEX IF NOT EXISTS capture_kind ON captures(kind,at,session,sequence);
      CREATE TABLE IF NOT EXISTS gaps(id TEXT PRIMARY KEY,lo INTEGER,hi INTEGER,reason TEXT);
      CREATE TABLE IF NOT EXISTS results(id TEXT,model TEXT,evidence TEXT,request TEXT,result TEXT,at INTEGER,provenance TEXT,PRIMARY KEY(id,model,evidence));
      CREATE TABLE IF NOT EXISTS selector_results(id TEXT,model TEXT,config TEXT,payload TEXT,available_at INTEGER,PRIMARY KEY(id,model));
      CREATE TRIGGER IF NOT EXISTS selector_immutable BEFORE UPDATE ON selector_results BEGIN SELECT RAISE(ABORT,'selector results are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS selector_no_delete BEFORE DELETE ON selector_results BEGIN SELECT RAISE(ABORT,'selector results are immutable'); END;
      CREATE TABLE IF NOT EXISTS checkpoints(name TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE IF NOT EXISTS processing_jobs(id TEXT,model TEXT,session TEXT,sequence INTEGER,at INTEGER,status TEXT,attempts INTEGER DEFAULT 0,retry_at INTEGER DEFAULT 0,error TEXT,updated_at INTEGER,PRIMARY KEY(id,model));
      CREATE INDEX IF NOT EXISTS processing_ready ON processing_jobs(model,status,retry_at,at);
      CREATE TABLE IF NOT EXISTS virtual_admissions(id TEXT,model TEXT,at INTEGER,status TEXT,reason TEXT,target REAL,evidence TEXT,PRIMARY KEY(id,model));
      CREATE TRIGGER IF NOT EXISTS admissions_immutable BEFORE UPDATE ON virtual_admissions BEGIN SELECT RAISE(ABORT,'admissions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS admissions_no_delete BEFORE DELETE ON virtual_admissions BEGIN SELECT RAISE(ABORT,'admissions are immutable'); END;
      CREATE TABLE IF NOT EXISTS scenario_results(id TEXT,model TEXT,evidence TEXT,bundle TEXT,at INTEGER,available_at INTEGER,PRIMARY KEY(id,model,evidence));
      CREATE TRIGGER IF NOT EXISTS scenarios_immutable BEFORE UPDATE ON scenario_results BEGIN SELECT RAISE(ABORT,'scenario results are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS scenarios_no_delete BEFORE DELETE ON scenario_results BEGIN SELECT RAISE(ABORT,'scenario results are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS captures_immutable BEFORE UPDATE ON captures BEGIN SELECT RAISE(ABORT,'captures are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS captures_no_delete BEFORE DELETE ON captures BEGIN SELECT RAISE(ABORT,'captures are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS results_immutable BEFORE UPDATE ON results BEGIN SELECT RAISE(ABORT,'results are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS results_no_delete BEFORE DELETE ON results BEGIN SELECT RAISE(ABORT,'results are immutable'); END;`)
    // `checkpoints` is the only table here without immutability triggers, so it is the only one
    // that can be pruned, and until 2026-09-15 it had no timestamp to prune on. Four key
    // families accrued forever; `verified-logs:*` alone held 20.4 MB in 418 rows.
    if(!(this.db.prepare('PRAGMA table_info(checkpoints)').all() as Array<{name:string}>).some(c=>c.name==='at'))
      this.db.exec('ALTER TABLE checkpoints ADD COLUMN at INTEGER')
  }
  nextJob(now:number) {
    this.db.prepare(`UPDATE processing_jobs SET status='complete',error=NULL,retry_at=0 WHERE model=? AND status!='complete'
      AND EXISTS(SELECT 1 FROM results r WHERE r.id=processing_jobs.id AND r.model=?)`).run(MODEL_HASH,EXECUTION_VERSION+':'+MODEL_HASH)
    this.db.prepare(`INSERT OR IGNORE INTO processing_jobs(id,model,session,sequence,at,status,updated_at)
      SELECT session||':'||sequence,?,session,sequence,at,'pending',? FROM captures c WHERE kind='opportunity' AND substr(session,-64)=?
      AND NOT EXISTS(SELECT 1 FROM results r WHERE r.id=c.session||':'||c.sequence AND r.model=?)`)
      .run(MODEL_HASH,now,MODEL_HASH,EXECUTION_VERSION+':'+MODEL_HASH)
    // A claimed job is retryable after a crash. One worker owns this table.
    this.db.prepare("UPDATE processing_jobs SET status='retry' WHERE model=? AND status='running' AND retry_at<=?").run(MODEL_HASH,now)
    const row=this.db.prepare(`SELECT c.session,c.sequence,c.at,c.key,c.payload,j.attempts FROM processing_jobs j
      JOIN captures c ON c.session=j.session AND c.sequence=j.sequence
      WHERE j.model=? AND j.status IN ('pending','retry') AND j.retry_at<=? AND c.at<?
      ORDER BY CASE WHEN c.at>=? THEN 0 ELSE 1 END,CASE WHEN j.status='pending' THEN 0 ELSE 1 END,j.retry_at,c.at,j.id LIMIT 1`).get(MODEL_HASH,now,now-190000,now-3*3600000) as any
    if(row)this.db.prepare("UPDATE processing_jobs SET status='running',retry_at=?,updated_at=? WHERE id=? AND model=?")
      .run(now+300000,now,row.session+':'+row.sequence,MODEL_HASH)
    return row
  }
  finishJob(id:string,now:number) {
    this.db.prepare("UPDATE processing_jobs SET status='complete',error=NULL,retry_at=0,updated_at=? WHERE id=? AND model=?").run(now,id,MODEL_HASH)
    this.dirty=true
  }
  retryJob(id:string,now:number,error:string) {
    const old=this.db.prepare('SELECT attempts FROM processing_jobs WHERE id=? AND model=?').get(id,MODEL_HASH) as {attempts:number}
    const attempts=(old?.attempts??0)+1,retryAt=now+Math.min(60000,1000*2**Math.min(attempts-1,6))
    const safe=error.replace(/(?:https?|wss?):\/\/\S+/gi,'[RPC]').slice(0,350)
    this.db.prepare("UPDATE processing_jobs SET status='retry',attempts=?,retry_at=?,error=?,updated_at=? WHERE id=? AND model=?").run(attempts,retryAt,safe,now,id,MODEL_HASH)
    this.checkpoint('processor',{at:now,last:id,error:safe,retryAt,failures:attempts});this.dirty=true
  }
  jobHealth(now:number) {
    const counts=this.db.prepare('SELECT status,count(*) n FROM processing_jobs WHERE model=? GROUP BY status').all(MODEL_HASH)
    const oldest=this.db.prepare("SELECT id,at,status,attempts,retry_at retryAt,error FROM processing_jobs WHERE model=? AND status!='complete' ORDER BY at LIMIT 1").get(MODEL_HASH)??null
    const last=this.db.prepare("SELECT max(updated_at) at FROM processing_jobs WHERE model=? AND status='complete'").get(MODEL_HASH) as {at:number|null}
    return {at:now,modelHash:MODEL_HASH,counts,oldestBlockingJob:oldest,lastCompletedAt:last.at}
  }
  append(events:readonly CaptureEvent[]){
    const get=this.db.prepare('SELECT hash FROM captures WHERE session=? AND sequence=?'),put=this.db.prepare('INSERT INTO captures VALUES (?,?,?,?,?,?,?,?)')
    this.db.transaction(()=>{for(const e of events){
      const hash=digest(e),old=get.get(e.session,e.sequence) as {hash:string}|undefined
      if(old){if(old.hash!==hash)throw new Error('conflicting capture delivery');continue}
      put.run(e.session,e.sequence,e.at,e.kind,e.key,encode(e.payload),e.provenance,hash)
      if(e.kind==='opportunity'||e.kind==='control'||e.kind==='actual-reconciliation')this.dirty=true
    }})()
  }
  gap(id:string,lo:number,hi:number,reason:string){this.dirty=true;this.db.prepare('INSERT OR IGNORE INTO gaps VALUES (?,?,?,?)').run(id,lo,hi,reason)}
  saveResult(id:string,request:unknown,result:unknown,at:number,provenance:string){
    const evidence=digest(request)
    // `evidence` stays a digest of the WHOLE request, so row identity means what it always
    // meant. The stored column drops the log bodies; see compactRequest.
    this.db.prepare('INSERT OR IGNORE INTO results VALUES (?,?,?,?,?,?,?)').run(id,EXECUTION_VERSION+':'+MODEL_HASH,EVIDENCE_VERSION+':'+evidence,encode(compactRequest(request)),encode(result),at,provenance)
    this.dirty=true
    this.checkpoint('processor',{at,last:id,error:null})
  }
  saveScenarios(id:string,bundle:ExecutionBundle,at:number){
    if(bundle.version!==SCENARIO_VERSION||!Number.isFinite(at)||bundle.scenarios.length!==SCENARIO_IDS.length
      ||SCENARIO_IDS.some(key=>bundle.scenarios.filter(s=>s.id===key).length!==1))throw new Error('invalid scenario publication')
    const complete=bundle.scenarios.every(s=>s.result.pnlWei!==null&&s.result.exitAt!==null&&s.result.status!=='unavailable')
    if(complete!==bundle.complete||complete&&(bundle.closedThrough!==Math.max(...bundle.scenarios.map(s=>s.result.exitAt!))||at<bundle.closedThrough!)
      ||bundle.publicationFloor!==undefined&&(!Number.isFinite(bundle.publicationFloor)||at<bundle.publicationFloor))throw new Error('scenario publication precedes closure or source publication')
    const evidence=digest(bundle.scenarios.map(s=>s.request))
    // Every check above runs on the full bundle, and `evidence` digests the full requests, so
    // identity and validation are unchanged. Only the stored bytes shrink: one log array for
    // the bundle instead of six clones. expandBundle puts them back.
    const stored=encode(compactBundle(bundle))
    const prior=this.db.prepare('SELECT bundle FROM scenario_results WHERE id=? AND model=? AND evidence=?').get(id,MODEL_HASH,SCENARIO_VERSION+':'+evidence) as {bundle:string}|undefined
    if(prior&&prior.bundle!==stored)throw new Error('conflicting scenario result for frozen inputs')
    this.dirty=true
    this.db.prepare('INSERT OR IGNORE INTO scenario_results VALUES (?,?,?,?,?,?)').run(id,MODEL_HASH,SCENARIO_VERSION+':'+evidence,stored,at,complete?Math.max(at,bundle.closedThrough!)+1:null)
  }
  checkpoint(name:string,value:unknown){
    if(name==='processor'&&value&&typeof value==='object'&&'error' in value&&typeof value.error==='string')value={...value,error:value.error.replace(/(?:https?|wss?):\/\/\S+/gi,'[RPC]').slice(0,300)}
    this.db.prepare('INSERT OR REPLACE INTO checkpoints(name,value,at) VALUES (?,?,?)').run(name,encode(value),Date.now())}
  /**
   * Drop the two checkpoint families nothing reads back after their job is done. `verified-logs`
   * is a resume cache for one in-flight job: a miss re-runs the double eth_getLogs and the job
   * retries, and for a finished job the same logs are in scenario_results. `cost-model` has no
   * reader anywhere. `verified-header` is NOT pruned; verify-execution-scenarios.ts checks every
   * log's blockHash against it, and at 100 bytes a row it is not the problem.
   *
   * A NULL `at` predates the column, so it is old by definition. Six hours is well past the
   * 190 s job eligibility plus the 60 s retry ceiling.
   */
  pruneCheckpoints(now:number){
    if(now-this.lastCheckpointPrune<3600_000)return
    this.lastCheckpointPrune=now
    try{
      this.db.prepare("DELETE FROM checkpoints WHERE name LIKE 'verified-logs:%' AND (at IS NULL OR at<?)").run(now-6*3600_000)
      this.db.prepare("DELETE FROM checkpoints WHERE name LIKE 'cost-model:%' AND (at IS NULL OR at<?)").run(now-7*86_400_000)
    }catch{/* a busy database is retried next hour; nothing here is load-bearing */}
  }
  /**
   * Delete per-book observer snapshots for books that are no longer configured.
   *
   * Each is ~518 KB and is only ever overwritten by a book of the same name, so a rename or a
   * removal strands one permanently. Book 0 lives under the unsuffixed name and is never
   * touched here.
   */
  dropObserverCheckpointsExcept(bookIds:readonly string[]){
    try{
      const keep=bookIds.map(id=>'scenario-observer:'+id)
      const placeholders=keep.map(()=>'?').join(',')
      this.db.prepare(`DELETE FROM checkpoints WHERE name LIKE 'scenario-observer:%'${keep.length?` AND name NOT IN (${placeholders})`:''}`).run(...keep)
    }catch{/* a busy database is retried on the next rebuild; nothing here is load-bearing */}
  }
  read<T>(name:string):T|null{const row=this.db.prepare('SELECT value FROM checkpoints WHERE name=?').get(name) as {value:string}|undefined;return row?JSON.parse(row.value):null}
  close(){this.db.close()}
}

/**
 * What a reader of `results` actually reads. `request.logs` was 338,398 of a 340,274 byte row
 * measured on the box 2026-09-15, and exactly one reader touched it: reporting.ts built a
 * transactionHash -> tokens map from the CurveBuy logs to compute entry error. So store that
 * map, the log count, and a digest that still commits the row to the exact log set that
 * produced the result. The bodies live once, in scenario_results.bundle.
 *
 * `logs` stays as an empty array rather than being removed, so a reader written against the
 * old shape iterates zero times instead of throwing. Requests without a `logs` array pass
 * through untouched, which covers the two unavailable-result call sites in processor.ts.
 */
export function compactRequest(request:unknown):unknown{
  if(!request||typeof request!=='object'||!Array.isArray((request as {logs?:unknown}).logs))return request
  const logs=(request as {logs:Array<{topics?:unknown;transactionHash?:unknown;data?:unknown}>}).logs
  const fills:Record<string,string>={}
  for(const l of logs){
    if(!l||!Array.isArray(l.topics)||l.topics[0]!==EVENT_TOPICS.CurveBuy)continue
    if(typeof l.transactionHash!=='string'||typeof l.data!=='string')continue
    fills[l.transactionHash.toLowerCase()]=String(logWord(l.data,1))
  }
  return {...request,logs:[],logsDigest:digest(logs),logCount:logs.length,fills}
}
