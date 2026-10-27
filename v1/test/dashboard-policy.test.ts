import { Script } from 'node:vm'
import { dashboardShell } from '../src/telemetry/dashboard-page.js'
import {afterEach,describe,expect,it} from 'vitest'
import Database from 'better-sqlite3'
import {Telemetry} from '../src/telemetry/db.js'
import {FRESH_POLICY} from '../src/strategy/fresh-policy.js'
import {adaptiveBuckets,adaptiveHistory,bookedWindow,dashboardMoney,darkSpans,effectiveMarketPolicy,outcomeBuckets,paperCalibration,paperSeries} from '../src/telemetry/dashboard-policy.js'
const handles:Database.Database[]=[]
const fixture=()=>{const db=new Telemetry(':memory:').raw();handles.push(db);return db}
afterEach(()=>handles.splice(0).forEach(db=>db.close()))
const insert=(db:Database.Database,id:number,at:number,pnl:string|null,reason='time',chain:string|null=null)=>db.prepare('INSERT INTO positions(id,live,closed,exit_at,exit_reason,spend_wei,pnl_wei,onchain_pnl_wei) VALUES (?,1,1,?,?,?, ?,?)').run(id,at,reason,'1000000000000000000',pnl,chain)
describe('dashboard policy and cash',()=>{
 it('distinguishes active recovery from the inactive legacy setting',()=>{
  const p=effectiveMarketPolicy(true,{window:60,off:-4,on:2,freshMs:900})
  expect(p).toMatchObject({window:20,recoveryWindow:8,pauseBelow:-1,recoverAbove:1,inactiveLegacyRecovery:2})
  expect(effectiveMarketPolicy(false,{window:60,off:-4,on:2,freshMs:900})).toMatchObject({window:60,recoverAbove:2})
 })
 it('uses receipt P&L and charges failed attempts without counting them as trades',()=>{
  const db=fixture();insert(db,1,100,'900000000000000000','time','100000000000000000');insert(db,2,200,'-1000000000000000','buy-reverted')
  expect(bookedWindow(db,0,300,2000)).toMatchObject({n:1,attempts:2,bookEth:0.099,bookUsd:198,winPct:100})
 })
 it('does not turn missing cash into zero or a win-rate verdict',()=>{
  const db=fixture();insert(db,1,100,null)
  expect(bookedWindow(db,0,200,2000)).toMatchObject({missing:1,bookEth:null,bookUsd:null,winPct:null})
 })
 it('uses UTC midnight, excludes future rows and keeps the epoch separate',()=>{
  const db=fixture(),midnight=Date.UTC(2026,8,12);insert(db,1,midnight-1,'1000000000000000000');insert(db,2,midnight,'-100000000000000000');insert(db,3,midnight+1001,'9000000000000000000')
  db.prepare("INSERT INTO chain_truth VALUES ('epoch_base_id','1')").run()
  db.prepare('INSERT INTO balance(at,wei,open_n) VALUES (?,?,0)').run(midnight,'999000000000000000000')
  const m=dashboardMoney(db,midnight+1000,2000)
  expect(m.today).toMatchObject({from:midnight,n:1,bookEth:-0.1});expect(m.epoch.bookEth).toBe(-0.1)
 })
 it('persists extra market evidence without changing existing guard columns',async()=>{
  const tel=new Telemetry(':memory:');handles.push(tel.raw())
  tel.guardSample(100,[{id:'venue',reading:-2,recentReading:1.2,status:'halt',n:20,stopAt:-1,clearAt:null,policy:FRESH_POLICY,publicationAt:90}],['venue'],true)
  await new Promise(resolve=>setImmediate(resolve))
  expect(tel.raw().prepare('SELECT * FROM guard_samples').get()).toMatchObject({market:-2,market_recent:1.2,market_publication:90,market_on:null})
 })
})
function shadows(){const db=fixture();db.exec(`CREATE TABLE shadow_jobs(id INTEGER PRIMARY KEY,config TEXT,entry INTEGER,status TEXT,published_at INTEGER,available INTEGER,pnl TEXT,size TEXT,intent TEXT);
 CREATE TABLE shadow_decisions(config TEXT,at INTEGER,reading TEXT);`);return db}
describe('published adaptive evidence',()=>{
 it('uses publication time, frozen net costs and each outcome stake rather than TP touch',()=>{
  const db=shadows(),q=db.prepare('INSERT INTO shadow_jobs VALUES (?,?,?,?,?,?,?,?,?)')
  q.run(1,'a',0,'published',1100,1000,'500','1000','{"tp":3}')
  q.run(2,'a',0,'published',1200,1000,'-100','2000','{"tp":1.25}')
  q.run(3,'a',0,'published',1300,1000,'0','1000','{}')
  q.run(4,'a',0,'rejected',1400,1000,null,null,'{}')
  q.run(5,'a',0,'queued',null,null,null,null,'{}')
  q.run(6,'a',0,'unavailable',null,null,null,null,'{}')
  q.run(7,'a',0,'published',3000,3000,'999','1000','{}')
  const r=adaptiveBuckets(db,1000,2000,1000)
  expect(r).toMatchObject({pending:1,unavailable:1,buckets:[{positive:0.5,negative:-0.05,net:0.45,wins:1,losses:1,zero:1,n:3}]})
  expect(adaptiveBuckets(db,0,999,1000).buckets).toEqual([])
 })
 it('keeps missing outcomes unavailable and supports pre-publication-column databases',()=>{
  const db=shadows();db.prepare('INSERT INTO shadow_jobs VALUES (1,?,0,?,1000,1000,NULL,?,?)').run('a','published','1000','{}')
  expect(adaptiveBuckets(db,0,2000,1000).buckets[0]).toMatchObject({n:0,missing:1,net:null})
  db.exec('ALTER TABLE shadow_jobs DROP COLUMN published_at')
  expect(adaptiveBuckets(db,0,2000,1000).buckets).toHaveLength(1)
 })
 it('preserves observed decisions, missing data and policy boundaries without guessing thresholds',()=>{
  const db=shadows(),q=db.prepare('INSERT INTO shadow_decisions VALUES (?,?,?)')
  const reading=(patch={})=>JSON.stringify({sum:-2,recentSum:1.5,n:20,fresh:true,verified:true,state:'open',reason:'fresh_recovery',...patch})
  q.run('a',1000,reading());q.run('a',2000,reading({state:'shut',observerError:'rate limited'}));q.run('b',60000,reading())
  const h=adaptiveHistory(db,0,70000)
  expect(h.samples[0]).toMatchObject({sum:-2,recentSum:1.5,pauseBelow:null,resumeAbove:null})
  expect(h.samples.find(p=>p.t===2000)?.sum).toBeNull()
  expect(h.events.at(-1)).toMatchObject({state:'open',policyChanged:true})
  expect(h.samples.some(p=>p.t===2001&&p.sum===null)).toBe(true)
 })
 it('keeps valid readings continuous across quiet intervals and stops at recorded invalid evidence',()=>{
  const db=shadows(),q=db.prepare('INSERT INTO shadow_decisions VALUES (?,?,?)')
  const r=(patch={})=>JSON.stringify({sum:-0.8,recentSum:0.5,n:20,fresh:true,verified:true,state:'shut',...patch})
  q.run('a',1000,r());q.run('a',61000,r());q.run('a',181000,r());q.run('a',182000,r({fresh:false}));q.run('a',240000,r())
  const h=adaptiveHistory(db,0,250000)
  expect(h.samples.filter(p=>p.t<182000).every(p=>p.sum===-0.8)).toBe(true)
  expect(h.samples.filter(p=>p.sum===null).map(p=>p.t)).toEqual([182000])
  expect(h.samples.at(-1).t).toBe(240000)
 })
 it('only attaches recorded metadata to the matching evidence configuration',()=>{
  const db=shadows();db.prepare('INSERT INTO guard_samples(at,live,market_fresh,halts,market_policy) VALUES (0,1,1,?,?)').run('[]',JSON.stringify({...FRESH_POLICY,configId:'a'}))
  const q=db.prepare('INSERT INTO shadow_decisions VALUES (?,?,?)'),r=JSON.stringify({sum:0,recentSum:2,n:20,fresh:true,verified:true,state:'open'})
  q.run('a',1000,r);q.run('b',2000,r)
  const h=adaptiveHistory(db,0,3000)
  expect(h.samples[0].pauseBelow).toBe(-1);expect(h.samples.at(-1).pauseBelow).toBeNull()
 })
 it('downsamples a quiet run to the pane it is drawn on, keeping its extremes',()=>{
  const db=shadows(),q=db.prepare('INSERT INTO shadow_decisions VALUES (?,?,?)')
  const r=(sum:number)=>JSON.stringify({sum,recentSum:sum,n:20,fresh:true,verified:true,state:'shut'})
  // 100 decisions inside one 17-minute bin of a 7-day window, two of them the extremes
  for(let i=0;i<100;i++)q.run('a',i*10_000,r(i===31?-10:i===32?12:0))
  const h=adaptiveHistory(db,0,7*86400000)
  expect(h.samples.length).toBeLessThan(100)
  expect(h.samples.map(p=>p.sum)).toEqual(expect.arrayContaining([-10,12,0]))
  expect(h.samples[0].t).toBe(0);expect(h.samples.at(-1).t).toBe(99*10_000)
 })
 it('ships only the fields the page draws with',()=>{
  const db=shadows()
  db.prepare('INSERT INTO shadow_decisions VALUES (?,?,?)').run('a',1000,
    JSON.stringify({sum:1,recentSum:1,n:20,fresh:true,verified:true,state:'shut',publicationAt:5}))
  // config, policy and publicationAt are read by nobody on the page and rode on every sample
  expect(Object.keys(adaptiveHistory(db,0,2000).samples[0]).sort())
    .toEqual(['fresh','n','pauseBelow','recentSum','resumeAbove','source','sum','t'])
 })
 it('returns explicit absence for databases without shadow tables',()=>{
  const db=fixture();expect(adaptiveHistory(db,0,1)).toEqual({samples:[],events:[]});expect(adaptiveBuckets(db,0,1,1)).toMatchObject({buckets:[],pending:null,unavailable:null})
 })
})

it('ships syntactically valid browser code',()=>{
 const scripts=[...dashboardShell().matchAll(/<script>([\s\S]*?)<\/script>/g)]
 for(const script of scripts)expect(()=>new Script(script[1]!)).not.toThrow()
})

describe('outcome buckets backfilled from venue observations',()=>{
 const BUCKET=3_600_000, T=BUCKET*1000
 const obs=(token:string,block:number,bars:Record<string,number>)=>({token,block,launchedAt:Math.floor(T/1000)+block,bars:JSON.stringify(bars)})
 /** the real launches schema, plus the shadow account's table with its token column */
 function book(){
  const db=fixture()
  db.exec(`CREATE TABLE shadow_jobs(id INTEGER PRIMARY KEY,token TEXT,config TEXT,entry INTEGER,
    status TEXT,published_at INTEGER,available INTEGER,pnl TEXT,size TEXT)`)
  const add=db.prepare('INSERT INTO launches(token,detected_at,passed) VALUES (?,?,?)')
  const job=db.prepare('INSERT INTO shadow_jobs(token,config,entry,status,published_at,available,pnl,size) VALUES (?,?,?,?,?,?,?,?)')
  return {db,add,job}
 }

 it('scores a passed coin the shadow account never simulated',()=>{
  const {db,add}=book()
  add.run('0xa',T+1000,1);add.run('0xb',T+2000,1);add.run('0xc',T+3000,0)
  const r=outcomeBuckets(db,T,T+BUCKET,BUCKET,[obs('0xa',1,{'1.75':0.5}),obs('0xb',2,{'1.75':-0.25})],'1.75')
  const b=r.buckets[0]!
  expect(b).toMatchObject({total:3,passed:2,filtered:1,win:1,loss:1,flat:0,reconstructed:2,notSimulated:0})
  expect(b.net).toBeCloseTo(0.25,10)
  expect(b.pos).toBeCloseTo(0.5,10);expect(b.neg).toBeCloseTo(-0.25,10)
 })

 it('never counts a coin twice when the shadow account already simulated it',()=>{
  const {db,add,job}=book()
  add.run('0xa',T+1000,1)
  job.run('0xa','cfg',T+1000,'published',T+2000,T+2000,'900','1000')
  const r=outcomeBuckets(db,T,T+BUCKET,BUCKET,[obs('0xa',1,{'1.75':-5})],'1.75')
  // the recorded outcome wins; the observation for the same coin is dropped, not added
  expect(r.buckets[0]).toMatchObject({passed:1,win:1,loss:0,reconstructed:0,n:1})
  expect(r.buckets[0]!.net).toBeCloseTo(0.9,10)
 })

 it('keeps a rung the observation does not carry as missing, not as a zero return',()=>{
  const {db,add}=book()
  add.run('0xa',T+1000,1);add.run('0xb',T+2000,1)
  const r=outcomeBuckets(db,T,T+BUCKET,BUCKET,[obs('0xa',1,{'1.75':0.5}),obs('0xb',2,{'1.25':0.5})],'1.75')
  expect(r.buckets[0]).toMatchObject({win:1,loss:0,flat:0,missing:1,reconstructed:2,net:null})
 })

 it('ignores an observation whose launch is outside the requested period',()=>{
  const {db,add}=book()
  add.run('0xa',T+1000,1);add.run('0xold',T-BUCKET,1)
  const r=outcomeBuckets(db,T,T+BUCKET,BUCKET,[obs('0xa',1,{'1.75':1}),obs('0xold',0,{'1.75':9})],'1.75')
  expect(r.buckets).toHaveLength(1)
  expect(r.buckets[0]).toMatchObject({total:1,reconstructed:1,win:1})
 })

 it('lets a simulated coin still teach the chooser, so both panes use one rung',()=>{
  // 0xa is already simulated, so it contributes no bar of its own. It must still count as a
  // preceding launch: scoring only the unsimulated rows would pick 0xb's rung from a gappy
  // history and price it differently than the venue lines do.
  const {db,add,job}=book()
  add.run('0xa',T+1000,1);add.run('0xb',T+2000,1)
  job.run('0xa','cfg',T+1000,'published',T+1500,T+1500,'100','1000')
  const rung=(preceding:readonly Record<string,number>[])=>preceding.length?'3.00':'1.25'
  const r=outcomeBuckets(db,T,T+BUCKET,BUCKET,
   [obs('0xa',1,{'1.25':1,'3.00':-1}),obs('0xb',2,{'1.25':1,'3.00':-1})],rung)
  // 0xb is scored at 3.00 (a loss) because 0xa preceded it, not at 1.25 (a win)
  expect(r.buckets[0]).toMatchObject({reconstructed:1,win:1,loss:1})
 })

 it('prices each coin at the rung the launches before it chose',()=>{
  const {db,add}=book()
  add.run('0xa',T+1000,1);add.run('0xb',T+2000,1)
  const rung=(preceding:readonly Record<string,number>[])=>preceding.length?'3.00':'1.25'
  const r=outcomeBuckets(db,T,T+BUCKET,BUCKET,
   [obs('0xa',1,{'1.25':1,'3.00':-1}),obs('0xb',2,{'1.25':1,'3.00':-1})],rung)
  expect(r.buckets[0]).toMatchObject({win:1,loss:1})
 })
})

describe('paper wallet series',()=>{
 const SEP=Date.UTC(2026,8,1), OCT=Date.UTC(2026,9,1), H=3600_000, WEI=1e18
 /** the columns paperSeries reads, in the shape a live database has them */
 function acct(){
  const db=fixture()
  db.exec(`CREATE TABLE shadow_jobs(id INTEGER PRIMARY KEY,token TEXT,config TEXT,entry INTEGER,
    status TEXT,published_at INTEGER,available INTEGER,close_at INTEGER,pnl TEXT,size TEXT)`)
  const job=db.prepare(`INSERT INTO shadow_jobs(token,config,entry,status,published_at,available,close_at,pnl,size)
    VALUES (?,?,?,?,?,?,?,?,?)`)
  const add=(token:string,closeAt:number,eth:number,config='c1',status='published')=>
   job.run(token,config,closeAt-30_000,status,closeAt,closeAt,closeAt,String(Math.round(eth*WEI)),String(0.02*WEI))
  return {db,add}
 }

 it('fills the days before the record began, and never over a recorded row',()=>{
  const {db,add}=acct()
  const start=SEP+10*24*H
  for(let i=0;i<5;i++)add('0xr'+i,start+i*600_000,0.02)        // the real record, +0.1
  // rebuilt cash, some before the record and some overlapping it
  const rebuilt=[{t:SEP+2*24*H,eth:0.05},{t:SEP+5*24*H,eth:-0.01},{t:start+3*600_000,eth:9}]
  const r=paperSeries(db,SEP,start+H,[],rebuilt)
  expect(r.recordFrom).toBe(start)
  // the +9 sits inside the recorded span and is dropped; 0.05 - 0.01 + 0.1 stands
  expect(r.monthToDate).toBeCloseTo(0.14,9)
  expect(r.rebuilt).toBe(2)
  expect(r.rebuiltFrom).toBe(SEP+2*24*H)
  expect(r.points[0]!.t).toBeLessThanOrEqual(SEP+2*24*H)
 })

 it('draws a line from the rebuild alone when the account recorded nothing',()=>{
  const {db}=acct()
  const r=paperSeries(db,SEP,SEP+3*24*H,[],[{t:SEP+24*H,eth:0.3}])
  expect(r.recordFrom).toBeNull()
  expect(r.monthToDate).toBeCloseTo(0.3,9)   // not null: there IS something to show now
  expect(r.rebuilt).toBe(1)
 })

 it('leaves the pane exactly as it was when there is nothing to rebuild',()=>{
  const {db,add}=acct()
  for(let i=0;i<3;i++)add('0xr'+i,SEP+24*H+i*600_000,0.02)
  const plain=paperSeries(db,SEP,SEP+2*24*H)
  const withNone=paperSeries(db,SEP,SEP+2*24*H,[],[])
  expect(withNone.points).toEqual(plain.points)
  expect(withNone).toMatchObject({rebuilt:0,rebuiltFrom:null})
 })

 it('carries the month to date to the left edge of a short window',()=>{
  const {db,add}=acct()
  for(let i=0;i<10;i++)add('0xa'+i,SEP+9*24*H+i*60_000,0.01)   // +0.1, before the window
  const W=SEP+20*24*H
  for(let i=0;i<3;i++)add('0xb'+i,W+i*600_000,-0.005)          // -0.015, inside it
  const r=paperSeries(db,W-H/2,W+H)
  expect(r.points[0]!.eth).toBeCloseTo(0.1,9)                  // not zero: the whole point
  expect(r.points.at(-1)!.eth).toBeCloseTo(0.085,9)
  expect(r.monthToDate).toBeCloseTo(0.085,9)
  expect(r).toMatchObject({n:13,wins:10,excluded:0,pending:0,unavailable:null})
 })

 it('drops to zero at the first of the month',()=>{
  const {db,add}=acct()
  add('0xa',SEP+20*24*H,0.085)
  add('0xb',OCT+2*H,0.02)
  const r=paperSeries(db,OCT-2*H,OCT+3*H)
  expect(r.points.filter(p=>p.t===OCT-1)[0]!.eth).toBeCloseTo(0.085,9)
  expect(r.points.filter(p=>p.t===OCT)[0]!.eth).toBe(0)
  expect(r.monthToDate).toBeCloseTo(0.02,9)
  expect(r.n).toBe(1)                                          // October's count, not both
 })

 it('draws nothing before the record begins',()=>{
  const {db,add}=acct()
  const start=SEP+10*24*H
  add('0xa',start,0.01)
  const r=paperSeries(db,SEP+5*24*H,start+H)
  expect(r.recordFrom).toBe(start)
  expect(r.points.every(p=>p.t>=start)).toBe(true)
 })

 it('counts a coin simulated under two policy versions once',()=>{
  const {db,add}=acct()
  const t=SEP+12*24*H
  add('0xdupe',t,0.01,'c1')
  add('0xdupe',t,0.04,'c2')
  const r=paperSeries(db,t-H,t+H)
  expect(r.n).toBe(1)
  expect(r.monthToDate).toBeCloseTo(0.04,9)                    // the later publication wins
  expect(r.seams).toEqual([t-30_000])                          // the second version, once
 })

 it('excludes an outcome with no usable P&L instead of scoring it flat',()=>{
  const {db,add}=acct()
  const t=SEP+12*24*H
  add('0xa',t,0.01)
  db.prepare(`INSERT INTO shadow_jobs(token,config,entry,status,published_at,available,close_at,pnl,size)
    VALUES ('0xb','c1',?,'published',?,?,?,NULL,'0')`).run(t,t+1000,t+1000,t+1000)
  const r=paperSeries(db,t-H,t+H)
  expect(r.excluded).toBe(1)
  expect(r.monthToDate).toBeCloseTo(0.01,9)
 })

 it('leaves closed but unconfirmed outcomes off the line and counts them',()=>{
  const {db,add}=acct()
  const t=SEP+12*24*H
  add('0xa',t,0.01)
  add('0xb',t+60_000,9.99,'c1','modeled')
  const r=paperSeries(db,t-H,t+H)
  expect(r.pending).toBe(1)
  expect(r.monthToDate).toBeCloseTo(0.01,9)
 })

 it('marks each policy version inside the window',()=>{
  const {db,add}=acct()
  const t=SEP+12*24*H
  add('0xa',t,0.01,'c1')
  add('0xb',t+2*H,0.01,'c2')
  expect(paperSeries(db,t-H,t+3*H).seams).toEqual([t+2*H-30_000])
 })

 it('reports absence rather than throwing on a database with no shadow account',()=>{
  const bare=new Database(':memory:');handles.push(bare)
  const r=paperSeries(bare,0,1)
  expect(r).toMatchObject({points:[],monthToDate:null,recordFrom:null,unavailable:'no shadow account tables'})
 })

 it('reports absence rather than throwing when an older database has no close_at',()=>{
  const db=fixture()
  db.exec('CREATE TABLE shadow_jobs(id INTEGER PRIMARY KEY,token TEXT,config TEXT,entry INTEGER,status TEXT,pnl TEXT,size TEXT)')
  expect(()=>paperSeries(db,0,1)).not.toThrow()
  expect(paperSeries(db,0,1).unavailable).toBe('shadow_jobs has no close_at column')
 })

 it('still draws when a database predates published_at',()=>{
  const db=fixture()
  db.exec(`CREATE TABLE shadow_jobs(id INTEGER PRIMARY KEY,token TEXT,config TEXT,entry INTEGER,
    status TEXT,available INTEGER,close_at INTEGER,pnl TEXT,size TEXT)`)
  const t=SEP+12*24*H
  db.prepare(`INSERT INTO shadow_jobs(token,config,entry,status,available,close_at,pnl,size)
    VALUES ('0xa','c1',?,'published',?,?,?,?)`).run(t,t,t,String(0.01*WEI),String(0.02*WEI))
  const r=paperSeries(db,t-H,t+H)
  expect(r.unavailable).toBeNull()
  expect(r.monthToDate).toBeCloseTo(0.01,9)
 })

 it('downsamples a long month without losing the trough',()=>{
  const {db,add}=acct()
  const t0=SEP+5*24*H
  // 3000 closes, with one deliberate slump in the middle. A stride that keeps every n-th
  // point would step straight over the bottom of it, which is the number the pane is for.
  for(let i=0;i<3000;i++) add('0x'+i, t0+i*60_000, i>=1400&&i<1500 ? -0.02 : 0.0004)
  const r=paperSeries(db,t0-H,t0+3000*60_000)
  expect(r.points.length).toBeLessThan(900)
  const low=Math.min(...r.points.map(p=>p.eth))
  expect(low).toBeLessThan(-1.4)                                // the slump is still drawn
  expect(r.points.at(-1)!.eth).toBeCloseTo(r.monthToDate!,6)    // and the end is still exact
 })

 it('returns an empty line, not a zero one, when the account has no rows',()=>{
  const {db}=acct()
  const r=paperSeries(db,SEP,SEP+H)
  expect(r).toMatchObject({points:[],monthToDate:null,recordFrom:null,n:0,unavailable:null})
 })
})

describe('downtime spans',()=>{
 it('reports gaps between samples and a stale tail',()=>{
  expect(darkSpans([{at:1000},{at:2000},{at:500_000}],900_000)).toEqual([[2000,500_000],[500_000,900_000]])
 })
 it('does not call the space before the first sample downtime',()=>{
  // `balance` is pruned to 7 days, so absence at the left edge of a 7d window is pruning
  expect(darkSpans([{at:600_000},{at:620_000}],640_000)).toEqual([])
 })
 it('survives an empty series and a non-finite timestamp',()=>{
  expect(darkSpans([],1000)).toEqual([])
  expect(()=>darkSpans([{at:NaN},{at:1000}],2000)).not.toThrow()
 })
})

describe('paper calibration against the recorded account',()=>{
 const WEI=1e18
 function acct(){
  const db=fixture()
  db.exec(`CREATE TABLE shadow_jobs(id INTEGER PRIMARY KEY,token TEXT,config TEXT,entry INTEGER,
    status TEXT,intent TEXT,close_at INTEGER,pnl TEXT,size TEXT)`)
  const job=db.prepare(`INSERT INTO shadow_jobs(token,config,entry,status,intent,close_at,pnl,size)
    VALUES (?,?,?,?,?,?,?,?)`)
  const add=(token:string,stake:number,tp=1.75,status='published')=>
   job.run(token,'c1',1,status,JSON.stringify({tp}),1,String(Math.round(stake*0.02*WEI)),String(0.02*WEI))
  return {db,add}
 }
 const venue=(n:number,v:number,tp='1.75')=>new Map(
  Array.from({length:n},(_,i)=>['0x'+i,{[tp]:v}] as [string,Record<string,number>]))

 it('returns the ratio of what the account booked to what the venue replayed',()=>{
  const {db,add}=acct()
  for(let i=0;i<150;i++)add('0x'+i,0.4)          // account booked 0.4 stakes each
  const r=paperCalibration(db,venue(150,0.5))    // venue replayed 0.5
  expect(r.measured).toBe(true)
  expect(r.n).toBe(150)
  expect(r.scale).toBeCloseTo(0.8,6)
 })

 it('refuses to fit on a thin overlap and says so',()=>{
  const {db,add}=acct()
  for(let i=0;i<40;i++)add('0x'+i,0.4)
  expect(paperCalibration(db,venue(40,0.5))).toMatchObject({scale:1,n:0,measured:false})
 })

 it('clamps rather than trusting a lopsided window',()=>{
  const {db,add}=acct()
  for(let i=0;i<150;i++)add('0x'+i,0.9)
  expect(paperCalibration(db,venue(150,0.05)).scale).toBe(1.2)
  const {db:db2,add:add2}=acct()
  for(let i=0;i<150;i++)add2('0x'+i,0.01)
  expect(paperCalibration(db2,venue(150,0.9)).scale).toBe(0.5)
 })

 it('pairs each job at ITS OWN rung, not a shared one',()=>{
  const {db,add}=acct()
  for(let i=0;i<150;i++)add('0x'+i,0.4,2)        // every job chose the 2.00 rung
  // bars only carry 1.75, so nothing pairs and the fit is refused
  expect(paperCalibration(db,venue(150,0.5,'1.75')).measured).toBe(false)
  expect(paperCalibration(db,venue(150,0.5,'2.00')).measured).toBe(true)
 })

 it('ignores jobs the account never published',()=>{
  const {db,add}=acct()
  for(let i=0;i<150;i++)add('0x'+i,0.4,1.75,'modeled')
  expect(paperCalibration(db,venue(150,0.5)).measured).toBe(false)
 })
})
