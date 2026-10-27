import Database from 'better-sqlite3'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,it} from 'vitest'
import {Telemetry} from '../src/telemetry/db.js'
import {scenarioPaper,displayCoins,scenarioOutcomeBuckets,publishedScenarioCoins} from '../src/telemetry/dashboard-paper.js'
import {executionScenarioHistory} from '../src/telemetry/dashboard-policy.js'
import {SELECTED_GUARD} from '../src/strategy/scenario-guard.js'
import {SCENARIO_IDS} from '../src/strategy/execution-scenarios.js'
import {MODEL_HASH} from '../src/simulation/identity.js'
import {dashboardShell} from '../src/telemetry/dashboard-page.js'
const observer=():any=>({at:100,recordFrom:1,comparableThrough:100,firstPending:null,complete:true,modelHash:MODEL_HASH,configId:'config',policy:SELECTED_GUARD,decisions:[{at:1,state:'shut',reason:'stale_or_warmup'}],outcomes:[{token:'coin',available:30,value:.5,configId:'config'}],
 continuous:[{id:'p50-after',complete:true,cash:[{id:'a',at:20,pnlWei:'1000000000000000'},{id:'b',at:50,pnlWei:'-500000000000000'}],netWei:'500000000000000',wins:1,losses:1,unavailable:[]}],
 accounts:[{id:'p50-after',policy:{cash:[]},marketOff:{complete:true,cash:[{at:20,pnlWei:'1000000000000000'},{at:50,pnlWei:'-500000000000000'}],netWei:'500000000000000',wins:1,losses:1,unavailable:[]}}]})
it('uses the continuous account and holds known cash',()=>{
 const paper=scenarioPaper(observer(),1,100)
 expect(paper.account).toBe('continuous-scenario')
 expect(paper.points.at(-1)).toEqual({t:100,eth:.0005})
 expect(paper.points.some(p=>p.eth===9)).toBe(false)
 expect(paper.n).toBe(2)
})
it('ends an account at the coverage gap even when later closed results exist',()=>{
 const o=observer();o.complete=false;o.comparableThrough=40;o.firstPending=40
 const paper=scenarioPaper(o,1,100)
 expect(paper.points.at(-2)).toEqual({t:39,eth:.001})
 expect(paper.points.at(-1)).toEqual({t:40,eth:null})
 expect(paper.n).toBe(1)
 expect(paper.recordedPnlEth).toBeNull()
})
it('shows a known flat stopped account without inventing trades',()=>{
 const o=observer();o.continuous[0]={id:'p50-after',complete:true,cash:[],netWei:'0',wins:0,losses:0,unavailable:[]}
 const paper=scenarioPaper(o,1,100)
 expect(paper.points).toEqual([{t:1,eth:0},{t:100,eth:0}]);expect(paper.n).toBe(0)
})
it('keeps skipped shadow winners visible, distinct from actual entries and unpublished returns',()=>{
 const db=new Telemetry(':memory:').raw()
 try{
  db.prepare('INSERT INTO launches(token,detected_at,passed,entry_reject) VALUES (?,?,?,?)').run('coin',5,1,'venue')
  const row={id:'a',token:'coin',at:5,availableAt:30,pnlWei:'1000000000000000',sizeWei:'2000000000000000',status:'closed',reason:'tp',admission:{status:'skipped',reason:'historical_market_pause'}}
  const unavailable=displayCoins(db,[row],observer(),1,29)[0]!
  expect(unavailable.value).toBeNull()
  const coins=displayCoins(db,[row],observer(),1,100)
  expect(coins[0]).toMatchObject({value:.5,indicatorEvidence:true,admission:{status:'admitted'},actual:{status:'skipped',reason:'venue'}})
  expect(scenarioOutcomeBuckets(db,observer(),1,100,100,coins).buckets[0]).toMatchObject({win:1,net:.5})
 }finally{db.close()}
})
it('preserves six scenario details and missing evidence without advancing stored decisions',()=>{
 const db=new Telemetry(':memory:').raw()
 try{
  db.exec('CREATE TABLE execution_guard_decisions(id INTEGER PRIMARY KEY,model TEXT,at INTEGER,reading TEXT)')
  const scenarios=SCENARIO_IDS.map((id,i)=>({id,n:15,recentN:8,sum:i-2,recentSum:i/2,fresh:true}))
  const reading={policy:SELECTED_GUARD,configId:'config',verified:true,scenarios,sumRange:[-2,3],recentSumRange:[0,2.5],state:'shut',reason:'scenario_loss_brake',publicationAt:9}
  const insert=db.prepare('INSERT INTO execution_guard_decisions(model,at,reading) VALUES (?,?,?)')
  insert.run(MODEL_HASH,10,JSON.stringify(reading))
  insert.run(MODEL_HASH,20,JSON.stringify({...reading,verified:false,observerError:'missing_source'}))
  const before=JSON.stringify(db.prepare('SELECT * FROM execution_guard_decisions').all())
  const first=executionScenarioHistory(db,1,30)
  expect(first.samples[0]).toMatchObject({sum:-2,recentSum:0,window:15,recoveryWindow:8,scenarios})
  expect(first.samples[1]).toMatchObject({sum:null,recentSum:null,fresh:false,observerError:'missing_source'})
  expect(executionScenarioHistory(db,1,30)).toEqual(first)
  expect(JSON.stringify(db.prepare('SELECT * FROM execution_guard_decisions').all())).toBe(before)
  expect((db.prepare('SELECT count(*) n FROM execution_guard_decisions').get() as any).n).toBe(2)
 }finally{db.close()}
})
it('does not splice old models or bridge configuration and recording gaps',()=>{
 const db=new Telemetry(':memory:').raw()
 try{
  db.exec('CREATE TABLE execution_guard_decisions(id INTEGER PRIMARY KEY,model TEXT,at INTEGER,reading TEXT)')
  const r={policy:SELECTED_GUARD,configId:'a',verified:true,scenarios:SCENARIO_IDS.map(id=>({id,n:15,sum:2,recentSum:1,fresh:true})),sumRange:[2,2],recentSumRange:[1,1],state:'shut',reason:'hold'}
  const put=db.prepare('INSERT INTO execution_guard_decisions(model,at,reading) VALUES (?,?,?)')
  put.run('old-model',1,JSON.stringify(r));put.run(MODEL_HASH,10,JSON.stringify(r));put.run(MODEL_HASH,40000,JSON.stringify({...r,configId:'b'}))
  const samples=executionScenarioHistory(db,0,80000).samples
  expect(samples.map(p=>p.t)).toEqual([10,11,40000,40001])
  expect(samples[1].sum).toBeNull();expect(samples[3].sum).toBeNull()
  const history=executionScenarioHistory(db,0,80000,true).samples
  expect(history[0].modelHash).toBe('old-model');expect(history[1].sum).toBeNull();expect(history[2].modelHash).toBe(MODEL_HASH)
 }finally{db.close()}
})
it('renders exactly the four existing chart containers without the added table',()=>{
 const html=dashboardShell()
 expect([...html.matchAll(/class="pane" id="(pane\w+)"/g)].map(m=>m[1])).toEqual(['paneWallet','panePaper','paneVenue','paneVolume'])
 for(const id of ['paneComparison','paneSimDd','paneWinRetention','paneLossRetention','replayResults','replayRows'])expect(html.includes(id),id).toBe(false)
 expect(html).toContain('Main 15');expect(html).toContain('Fresh 8')
})

it('projects published scenario cash without exposing replay logs or future results',()=>{
 const dir=mkdtempSync(join(tmpdir(),'chart-coins-')),path=join(dir,'simulation.db'),db=new Database(path)
 try{
  db.exec('CREATE TABLE captures(session TEXT,sequence INTEGER,kind TEXT,key TEXT,at INTEGER,payload TEXT);CREATE TABLE scenario_results(id TEXT,model TEXT,available_at INTEGER,bundle TEXT);CREATE TABLE results(id TEXT,model TEXT,result TEXT)')
  const session='session:'+MODEL_HASH,id=session+':1'
  db.prepare('INSERT INTO captures VALUES (?,?,?,?,?,?)').run(session,1,'opportunity','coin',10,JSON.stringify({sizeWei:'5000000000000000'}))
  db.prepare('INSERT INTO scenario_results VALUES (?,?,?,?)').run(id,MODEL_HASH,30,JSON.stringify({complete:true,scenarios:[{id:'p50-after',request:{logs:[{privateLargePayload:'not part of the response'}],coverage:{complete:true,independentlyChecked:true,gaps:[]}},result:{pnlWei:'2500000000000000',status:'closed',reason:'tp'}}]}))
  expect(publishedScenarioCoins(path,1,29)[0]).toMatchObject({pnlWei:null,availableAt:null,status:'unavailable'})
  const rows=publishedScenarioCoins(path,1,30)
  expect(rows[0]).toMatchObject({pnlWei:'2500000000000000',sizeWei:'5000000000000000',availableAt:30,status:'closed'})
  expect(JSON.stringify(rows)).not.toContain('privateLargePayload')
 }finally{db.close();rmSync(dir,{recursive:true,force:true})}
})
it('omits irrelevant filtered coin details but preserves total chart counts',()=>{
 const db=new Telemetry(':memory:').raw()
 try{
  const put=db.prepare('INSERT INTO launches(token,detected_at,passed) VALUES (?,?,?)');put.run('filtered',5,0);put.run('coin',6,1)
  const coins=displayCoins(db,[],null,1,100)
  expect(coins.map(c=>c.token)).toEqual(['coin'])
  expect(scenarioOutcomeBuckets(db,null,1,100,100,coins).buckets[0]).toMatchObject({total:2,filtered:1,passed:1})
 }finally{db.close()}
})

it('does not mix old launch rows into forward-ledger Coins',()=>{
  const db=new Database(':memory:')
  db.exec('CREATE TABLE launches(token TEXT,detected_at INTEGER,passed INTEGER,entry_reject TEXT); CREATE TABLE positions(token TEXT,t_decide INTEGER,live INTEGER)')
  db.prepare('INSERT INTO launches VALUES (?,?,?,?)').run('old',10,1,null)
  const row:any={id:'new:1',token:'new',at:80,availableAt:95,pnlWei:'500',sizeWei:'1000',configId:'c',reason:'time',status:'closed',indicatorEvidence:true,admission:{status:'admitted',reason:'admitted'},epoch:'e'}
  const coins=displayCoins(db,[row],null,1,100,true)
  expect(coins.map(c=>c.token)).toEqual(['new'])
  expect(scenarioOutcomeBuckets(db,null,1,100,100,coins,true).buckets[0]).toMatchObject({total:1,passed:1,win:1,net:.5})
  db.close()
})

it('keeps the return sum for admitted trades when other launches have no admitted outcome',()=>{
 const db=new Telemetry(':memory:').raw()
 try{
  const put=db.prepare('INSERT INTO launches(token,detected_at,passed) VALUES (?,?,?)');put.run('coin',5,1);put.run('unknown',6,1)
  const row={id:'a',token:'coin',at:5,availableAt:30,pnlWei:'1000000000000000',sizeWei:'2000000000000000',status:'closed',reason:'tp'}
  const coins=displayCoins(db,[row],observer(),1,100)
  expect(scenarioOutcomeBuckets(db,observer(),1,100,100,coins).buckets[0]).toMatchObject({win:1,net:.5,missing:1})
  expect(displayCoins(db,[{...row,pnlWei:'-1'}],observer(),1,100)[0]).toMatchObject({value:null,admission:{reason:'cash_outcome_mismatch'}})
 }finally{db.close()}
})
