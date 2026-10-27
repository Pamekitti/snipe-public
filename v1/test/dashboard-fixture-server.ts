/** Local UI fixtures. No trading engine, database writes or wallet connection. */
import http from 'node:http'
const upstream=process.argv[2]??'http://127.0.0.1:8811',port=Number(process.argv[3]??8812)
const original:any=await (await fetch(upstream+'/api/state')).json()
if(!original.preview)throw new Error('Fixture upstream must be read-only')
let stopped=true
const requests:string[]=[]
http.createServer(async(req,res)=>{
 const url=new URL(req.url??'/','http://localhost');res.setHeader('cache-control','no-store')
 if(url.pathname==='/requests'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(requests))}
 if(url.pathname==='/api/control'&&req.method==='POST'){
  let body='';for await(const chunk of req)body+=chunk
  const action=JSON.parse(body).action
  if(!['start','stop'].includes(action)){res.writeHead(400);return res.end('{}')}
  requests.push(action);stopped=action==='stop'
  res.setHeader('content-type','application/json');return res.end(JSON.stringify({ok:true,why:stopped?'Stopped':'Automatic operation requested; market recovery still required'}))
 }
 if(req.method!=='GET'){res.writeHead(405);return res.end()}
 const scenario=url.searchParams.get('scenario')??'normal'
 if(url.pathname==='/api/state'){
  const s=structuredClone(original);s.at=Date.now();s.preview=false;s.testFixture=true;s.bannerAlerts=[];s.notices=[]
  const guard=s.operator.guards.find((g:any)=>g.id==='venue')
  if(scenario==='stale')s.at-=60000
  if(scenario==='missing'){s.money.today=null;s.risk.venue=null;guard.status='unknown';guard.reading=null}
  if(scenario==='warmup'){s.risk.venue.n=7;s.risk.venue.fresh=false;guard.status='unknown';guard.n=7}
  if(scenario==='observer'){s.risk.venue.observerError='RPC collection unavailable';guard.status='unknown'}
  if(scenario==='open-negative'){s.operator.status='enabled';s.operator.blockers=[];s.risk.halted=false;s.risk.haltKinds=[];Object.assign(s.risk.venue,{state:'open',sum:-2,recentSum:1.5});Object.assign(guard,{blocking:false,status:'pass',reading:-2})}
  // an open position also puts a mark on the account, which is when the account card splits
  if(scenario==='position'){s.positions=[{token:'test-position',tokenUrl:'#',curveUrl:'#',ageMs:10000,capMs:45000,multiple:1.4,peak:1.6,takeProfit:2.5,estimatedReturnEth:0.002,markEth:0.022,spendEth:0.02,supplyLeft:0.6,state:'holding'}];s.risk.open=1;s.truth.openMarkEth=0.022}
  if(scenario==='drawdown'){s.operator.status='paused';s.operator.blockers=[{kind:'drawdown',reason:'Drawdown limit reached'}];s.risk.haltKinds=['drawdown'];s.operator.recovery={n:17,required:20,sum:0.4,complete:false,canClear:false,remainingBlockers:['venue'],budgetResetAt:Date.now()+3600000,note:'Separate fixed 1.75x recovery calculation. Other stops apply.',checks:[{id:'sample',label:'17 / 20 post-stop outcomes',ok:false},{id:'allowance',label:'0 / 2 recoveries used today',ok:true}]}}
  if(scenario==='controls'){s.operator.status=stopped?'needs-you':'paused';s.operator.blockers=[{kind:stopped?'stopped':'venue',reason:stopped?'Stopped by you':'Waiting for recovery'}];s.risk.haltKind=stopped?'stopped':'venue';s.risk.haltKinds=[s.risk.haltKind];s.risk.halted=true;s.operator.controls.stopped=stopped}
  res.setHeader('content-type','application/json');return res.end(JSON.stringify(s))
 }
 const response=await fetch(upstream+url.pathname+url.search);res.setHeader('content-type',response.headers.get('content-type')??'text/html')
 if(url.pathname==='/api/chart'&&scenario==='missing'){const chart:any=await response.json();chart.market=[];chart.outcomes={buckets:[],pending:null,unavailable:null};return res.end(JSON.stringify(chart))}
 res.end(await response.text())
}).listen(port,'127.0.0.1',()=>console.log('UI fixtures only: http://127.0.0.1:'+port))
