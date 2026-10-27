import {expect,it} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {SimulationStore} from '../src/simulation/store.js'
import {ensureForwardSchema,forwardStart,publishForwardObserver,readForwardLedger} from '../src/simulation/forward-ledger.js'
import {SCENARIO_IDS,SCENARIO_VERSION} from '../src/strategy/execution-scenarios.js'
import {SELECTED_GUARD} from '../src/strategy/scenario-guard.js'

const observer=(at=5000,pnl='-100')=>{
  const policy={...SELECTED_GUARD,n:1,m:1}
  const scenarios=SCENARIO_IDS.map(id=>({id,n:1,recentN:1,sum:-.1,recentSum:-.1,fresh:true,oldestAgeMs:1000}))
  const publications=SCENARIO_IDS.map(id=>({executionId:'trade-1',scenario:id,token:'0xabc',detectedAt:1000,launchAt:900,closeAt:2000,publicationAt:2100,stakeWei:'1000',pnlWei:pnl,executionStatus:'closed',executionReason:'time',configId:'config',admissionStatus:'admitted',admissionReason:'admitted',indicatorEvidence:true}))
  const reading={state:'shut' as const,reason:'scenario_loss_brake',at:2100,policy,configId:'config',scenarios,sumRange:[-.1,-.1] as [number,number],recentSumRange:[-.1,-.1] as [number,number],newEvidence:true,source:'conservative-paper' as const,version:SCENARIO_VERSION}
  return {at,modelHash:'model',configId:'config',policy,recordFrom:1000,publicationAt:2100,publications,tapes:SCENARIO_IDS.map(id=>({id,complete:true,outcomes:[{token:'0xabc',block:1,launched:900,available:2100,value:Number(pnl)/1000}]})),reading,decisions:[reading],failure:null,complete:true} as any
}

it('persists one atomic six-scenario publication and reconciles p50 cash, coin and indicator',()=>{
  const dir=mkdtempSync(join(tmpdir(),'forward-ledger-')),path=join(dir,'simulation.db'),store=new SimulationStore(path)
  try{
    expect(forwardStart(store.db,'model',SELECTED_GUARD,1000)).toBe(1000)
    publishForwardObserver(store.db,observer())
    publishForwardObserver(store.db,observer())
    expect((store.db.prepare('SELECT count(*) n FROM forward_publications').get() as any).n).toBe(6)
    const chart=readForwardLedger(path,0,5000,5000)!
    expect(chart.paper.cash).toEqual([{id:'trade-1',at:2000,pnlWei:'-100',epoch:chart.epochs[0]!.id}])
    expect(chart.paper.recordedPnlEth).toBe(-1e-16)
    expect(chart.coins[0]).toMatchObject({id:'trade-1',pnlWei:'-100',admission:{status:'admitted'}})
    expect(chart.market[0]).toMatchObject({sum:-.1,recentSum:-.1})
    expect(chart.market[0].scenarios.every((s:any)=>s.mainTokens?.[0]==='0xabc')).toBe(true)
    expect(()=>publishForwardObserver(store.db,observer(5000,'100'))).toThrow('conflicting forward publication')
  }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})

it('keeps an old durable indicator immutable when delayed evidence changes replayed source time',()=>{
  const dir=mkdtempSync(join(tmpdir(),'forward-delayed-')),path=join(dir,'simulation.db'),store=new SimulationStore(path)
  try{
    const first=observer()
    first.reading={...first.reading,configId:'',reason:'invalid_or_incomplete_scenario_evidence',sumRange:null,recentSumRange:null,
      scenarios:first.reading.scenarios.map((s:any)=>({...s,n:0,recentN:0,sum:0,recentSum:0,fresh:false}))}
    publishForwardObserver(store.db,first)
    const second=observer(6000)
    publishForwardObserver(store.db,second)
    const rows=store.db.prepare('SELECT at,payload FROM forward_indicators ORDER BY at').all() as Array<{at:number;payload:string}>
    expect(rows).toHaveLength(2)
    expect(JSON.parse(rows[0]!.payload).configId).toBe('')
    expect(JSON.parse(rows[1]!.payload).configId).toBe('config')
    expect(rows.map(r=>r.at)).toEqual([5000,6000])
  }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})

it('shows partial scenario scores during warmup without marking them fresh',()=>{
  const dir=mkdtempSync(join(tmpdir(),'forward-warmup-')),path=join(dir,'simulation.db'),store=new SimulationStore(path)
  try{
    const value=observer(),policy={...value.policy,n:15,m:8}
    value.policy=policy
    value.reading={...value.reading,policy,reason:'stale_or_warmup',scenarios:value.reading.scenarios.map((s:any)=>({...s,fresh:false}))}
    publishForwardObserver(store.db,value)
    const point=readForwardLedger(path,0,5000,5000)!.market.find((p:any)=>p.sum!==null)
    expect(point).toMatchObject({sum:-.1,recentSum:-.1,n:1,fresh:false,reason:'stale_or_warmup'})
  }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})

it('keeps published history visible when the worker becomes stale',()=>{
  const dir=mkdtempSync(join(tmpdir(),'forward-stale-')),path=join(dir,'simulation.db'),store=new SimulationStore(path)
  try{
    publishForwardObserver(store.db,observer())
    const chart=readForwardLedger(path,0,30000,30000)!
    expect(chart.paper.cash).toHaveLength(1)
    expect(chart.paper.health.stalled).toBe(true)
    expect(chart.paper.points.some(p=>p.eth===null)).toBe(true)
  }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})

it('uses the writer heartbeat during a quiet market instead of inventing a gap',()=>{
  const dir=mkdtempSync(join(tmpdir(),'forward-heartbeat-')),path=join(dir,'simulation.db'),store=new SimulationStore(path)
  try{
    publishForwardObserver(store.db,observer())
    store.db.prepare("INSERT OR REPLACE INTO checkpoints(name,value,at) VALUES ('writer',?,?)").run(JSON.stringify({at:29000}),29000)
    const chart=readForwardLedger(path,0,30000,30000)!
    expect(chart.paper.health.stalled).toBe(false)
    expect(chart.paper.health.heartbeatAt).toBe(29000)
    expect(chart.paper.points.at(-1)).toMatchObject({t:30000,eth:-1e-16})
  }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})

it('closes an incompatible epoch at the new deployment boundary',()=>{
  const dir=mkdtempSync(join(tmpdir(),'forward-model-')),path=join(dir,'simulation.db'),store=new SimulationStore(path)
  try{
    publishForwardObserver(store.db,observer())
    expect(forwardStart(store.db,'model-2',SELECTED_GUARD,10000)).toBe(10000)
    const row=store.db.prepare("SELECT ended_at endedAt FROM simulation_epochs WHERE model='model'").get() as {endedAt:number}
    expect(row.endedAt).toBe(9999)
  }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})

/**
 * TWO BOOKS THROUGH ONE LEDGER.
 *
 * Every close in this file is "end every open epoch that is not this one". With one book that
 * is right and means "a config change starts a new segment". With two it was mutual
 * destruction, and it was measured rather than argued: after one tick each, BOTH epochs
 * carried an ended_at BEFORE their own started_at, zero epochs were open, and both went on
 * receiving publications forever. Nothing threw. `forward_publications` is immutable, so the
 * damage could not have been undone by re-running the worker.
 *
 * The books are distinguished by configId, which is what makes their epoch ids differ.
 */
it('keeps one live epoch per book instead of the two books closing each other',()=>{
  const dir=mkdtempSync(join(tmpdir(),'forward-books-')),path=join(dir,'simulation.db'),store=new SimulationStore(path)
  try{
    const forBook=(config:string,at:number)=>{
      const o=observer(at)
      o.configId=config
      o.reading={...o.reading,configId:config}
      o.publications=o.publications.map((p:any)=>({...p,configId:config,executionId:'trade-'+config}))
      return o
    }
    expect(forwardStart(store.db,'model',SELECTED_GUARD,1000,'untaxed')).toBe(1000)
    expect(forwardStart(store.db,'model',SELECTED_GUARD,1000,'taxed')).toBe(1000)
    // alternate, which is what two observers on one worker tick actually do
    publishForwardObserver(store.db,forBook('cfgUntaxed',5000),'untaxed')
    publishForwardObserver(store.db,forBook('cfgTaxed',5001),'taxed')
    publishForwardObserver(store.db,forBook('cfgUntaxed',5002),'untaxed')
    publishForwardObserver(store.db,forBook('cfgTaxed',5003),'taxed')

    const rows=store.db.prepare('SELECT id,book,started_at s,ended_at e,last_at l FROM simulation_epochs ORDER BY book').all() as any[]
    expect(rows).toHaveLength(2)
    expect(rows.map(r=>r.book).sort()).toEqual(['taxed','untaxed'])
    // the whole point: both still open, each still its own segment
    expect(rows.every(r=>r.e===null)).toBe(true)
    // and none of them ended before it started, which is what the bug produced
    expect(rows.every(r=>r.e===null||r.e>=r.s)).toBe(true)
    expect(rows.every(r=>r.l>=r.s)).toBe(true)
    // both books really did write, so this is not passing by writing nothing
    expect((store.db.prepare('SELECT count(*) n FROM forward_publications').get() as any).n).toBe(SCENARIO_IDS.length*2)
  }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})

it('gives each book its own forward_runtime row, so one book cannot move the other start',()=>{
  const dir=mkdtempSync(join(tmpdir(),'forward-runtime-')),path=join(dir,'simulation.db'),store=new SimulationStore(path)
  try{
    // The model hash does NOT vary by book. Keyed on model alone, the second book reads the
    // first book's policy hash, treats it as a change, and moves start_at every single tick.
    expect(forwardStart(store.db,'model',SELECTED_GUARD,1000,'untaxed')).toBe(1000)
    expect(forwardStart(store.db,'model',SELECTED_GUARD,2000,'taxed')).toBe(2000)
    expect(forwardStart(store.db,'model',SELECTED_GUARD,3000,'untaxed')).toBe(1000)
    expect(forwardStart(store.db,'model',SELECTED_GUARD,4000,'taxed')).toBe(2000)
    const rows=store.db.prepare('SELECT model,book,start_at startAt FROM forward_runtime ORDER BY book').all() as any[]
    expect(rows).toEqual([{model:'model',book:'taxed',startAt:2000},{model:'model',book:'untaxed',startAt:1000}])
  }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})

it('an existing single-book ledger keeps working and backfills to main',()=>{
  const dir=mkdtempSync(join(tmpdir(),'forward-migrate-')),path=join(dir,'simulation.db'),store=new SimulationStore(path)
  try{
    // Rows written before the book column existed. The migration must not orphan them: they
    // are one book's history and that book is the one that has always been running.
    store.db.exec(`CREATE TABLE IF NOT EXISTS simulation_epochs(id TEXT PRIMARY KEY,model TEXT,config TEXT,policy TEXT,started_at INTEGER,ended_at INTEGER,last_at INTEGER,reason TEXT)`)
    store.db.prepare('INSERT OR REPLACE INTO simulation_epochs(id,model,config,policy,started_at,ended_at,last_at,reason) VALUES (?,?,?,?,?,?,?,?)')
      .run('old','model','config','{}',500,null,600,null)
    expect(forwardStart(store.db,'model',SELECTED_GUARD,1000)).toBe(1000)
    const old=store.db.prepare("SELECT book,ended_at e FROM simulation_epochs WHERE id='old'").get() as any
    expect(old.book).toBe('main')
    // the default book IS main, so starting it closes the old segment exactly as before
    expect(old.e).toBe(999)
  }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})

it('rebuilds an OLD forward_runtime in place without losing the row it already had',()=>{
  const dir=mkdtempSync(join(tmpdir(),'forward-rebuild-')),path=join(dir,'simulation.db'),store=new SimulationStore(path)
  try{
    // The real migration path: a database written before books existed, where forward_runtime
    // has `model` as its sole primary key. SQLite cannot ALTER a primary key, so this drops
    // and recreates a table on a live 2.4 GB database. The row that survives is the running
    // book's own start_at; losing it would restart the forward epoch and discard the segment.
    store.db.exec('DROP TABLE IF EXISTS forward_runtime')
    store.db.exec('CREATE TABLE forward_runtime(model TEXT PRIMARY KEY,policy_hash TEXT,start_at INTEGER)')
    store.db.prepare('INSERT INTO forward_runtime VALUES (?,?,?)').run('model','oldhash',777)

    ensureForwardSchema(store.db)

    const cols=(store.db.prepare('PRAGMA table_info(forward_runtime)').all() as Array<{name:string}>).map(c=>c.name)
    expect(cols).toContain('book')
    const rows=store.db.prepare('SELECT model,policy_hash policyHash,start_at startAt,book FROM forward_runtime').all() as any[]
    expect(rows).toEqual([{model:'model',policyHash:'oldhash',startAt:777,book:'main'}])
    // and the composite key really is in force now
    store.db.prepare('INSERT INTO forward_runtime(model,policy_hash,start_at,book) VALUES (?,?,?,?)').run('model','other',888,'taxed')
    expect((store.db.prepare('SELECT count(*) n FROM forward_runtime').get() as any).n).toBe(2)
    // running it again is a no-op, because it runs on every publish
    ensureForwardSchema(store.db)
    expect((store.db.prepare('SELECT count(*) n FROM forward_runtime').get() as any).n).toBe(2)
  }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})

it('the derived single book is named main, so an existing ledger CONTINUES rather than forking',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'forward-continuity-')),path=join(dir,'simulation.db'),store=new SimulationStore(path)
  try{
    // The box has no BOOKS line, so config/store.ts resolves one book named 'main', and the
    // migration backfills every pre-books row to 'main' too. Those two names have to be the
    // same string or the running book would silently start a parallel ledger beside its own
    // history and the chart would lose its segment. This asserts they agree, through the real
    // config rather than a literal.
    const {STRATEGY}=await import('../src/config.js')
    expect(STRATEGY.books[0]!.id).toBe('main')
    store.db.exec(`CREATE TABLE IF NOT EXISTS simulation_epochs(id TEXT PRIMARY KEY,model TEXT,config TEXT,policy TEXT,started_at INTEGER,ended_at INTEGER,last_at INTEGER,reason TEXT)`)
    store.db.prepare('INSERT OR REPLACE INTO simulation_epochs(id,model,config,policy,started_at,ended_at,last_at,reason) VALUES (?,?,?,?,?,?,?,?)')
      .run('legacy','oldmodel','config','{}',500,null,600,null)
    ensureForwardSchema(store.db)
    const legacy=store.db.prepare("SELECT book FROM simulation_epochs WHERE id='legacy'").get() as any
    expect(legacy.book).toBe(STRATEGY.books[0]!.id)
  }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})

it('reads ONE book per call, so two books do not interleave into a third line nobody traded',()=>{
  const dir=mkdtempSync(join(tmpdir(),'forward-read-books-')),path=join(dir,'simulation.db'),store=new SimulationStore(path)
  try{
    const forBook=(config:string,at:number,pnl:string)=>{
      const o=observer(at,pnl)
      o.configId=config
      o.reading={...o.reading,configId:config}
      o.publications=o.publications.map((p:any)=>({...p,configId:config,executionId:'trade-'+config}))
      return o
    }
    forwardStart(store.db,'model',SELECTED_GUARD,1000,'untaxed')
    forwardStart(store.db,'model',SELECTED_GUARD,1000,'taxed')
    // deliberately different cash, so an unscoped read is visibly the sum of the two
    publishForwardObserver(store.db,forBook('cfgUntaxed',5000,'-100'),'untaxed')
    publishForwardObserver(store.db,forBook('cfgTaxed',5001,'-700'),'taxed')
    store.close()

    const a=readForwardLedger(path,0,9000,9000,'untaxed')!
    const b=readForwardLedger(path,0,9000,9000,'taxed')!
    expect(a.paper.n).toBe(1);expect(b.paper.n).toBe(1)
    expect(a.paper.recordedPnlEth).toBeCloseTo(-100/1e18,24)
    expect(b.paper.recordedPnlEth).toBeCloseTo(-700/1e18,24)
    // one segment each, not two: the epochs belong to the book that opened them
    expect(a.epochs).toHaveLength(1);expect(b.epochs).toHaveLength(1)
    expect(a.epochs[0]!.id).not.toBe(b.epochs[0]!.id)
    // and the indicator series does not carry the other book's readings
    expect(a.market.every((p:any)=>p.configId==null||p.configId==='cfgUntaxed')).toBe(true)
    expect(b.market.every((p:any)=>p.configId==null||p.configId==='cfgTaxed')).toBe(true)
  }finally{rmSync(dir,{recursive:true,force:true})}
})

it('defaults to book 0 and still reads a ledger written before the book column existed',()=>{
  const dir=mkdtempSync(join(tmpdir(),'forward-read-legacy-')),path=join(dir,'simulation.db'),store=new SimulationStore(path)
  try{
    forwardStart(store.db,'model',SELECTED_GUARD,1000)
    publishForwardObserver(store.db,observer(5000))
    // drop the column the way an old file has it: rebuilt without `book` at all. The reader
    // opens the file READ-ONLY, so it cannot migrate one in and must not throw on its absence.
    store.db.exec(`CREATE TABLE legacy AS SELECT id,model,config,policy,started_at,ended_at,last_at,reason FROM simulation_epochs;
      DROP TABLE simulation_epochs; ALTER TABLE legacy RENAME TO simulation_epochs;`)
    store.close()
    const r=readForwardLedger(path,0,9000,9000)!
    expect(r.paper.n).toBe(1)
    expect(r.epochs).toHaveLength(1)
    // and an explicit book name on a column-less file still reads, rather than returning null
    expect(readForwardLedger(path,0,9000,9000,'anything')!.paper.n).toBe(1)
  }finally{rmSync(dir,{recursive:true,force:true})}
})
