/** The same fixed-policy V2 engine, applied to recovered September history. */
import Database from '../../v2/node_modules/better-sqlite3/lib/index.js'
import {readFileSync,writeFileSync} from 'node:fs'
import {gunzipSync,gzipSync} from 'node:zlib'
import {path,evaluate,policyRule,calibrateReturn,LIVE_PATH,RES,type SimEvent} from '../../v2/core/sim.js'
import {EVENT_TOPICS as T,ADDRESSES} from '../../v2/core/chain.js'
import {createHash} from 'node:crypto'

const root='v1/data/research/20260922-market-september-v1'
const previous='v1/data/research/20260922-market-fixed-v1'
const prior=JSON.parse(gunzipSync(readFileSync(`${previous}/results.json.gz`)).toString())
if(createHash('sha256').update(readFileSync('v2/core/sim.ts')).digest('hex')!==prior.validation.sourceHashes['v2/core/sim.ts'])throw Error('Simulator changed since the frozen reference')
const d=new Database(`${root}/history.sqlite`,{readonly:true})
const own=new Set<string>(JSON.parse(readFileSync(`${root}/legacy-own-hashes.json`,'utf8')).map((x:string)=>x.toLowerCase()))
const rows:any[]=prior.rows.filter((r:any)=>r.source==='v2')
const validation:any={...prior.validation,historicalParameterChecks:{archive:0,firstBuyVerified:0,missingFirstBuy:0,inconsistentFirstBuy:0},
  historicalTaxSources:{archive:0,recorded:0,inferred:0,unknown:0,conflict:0},
  history:'All recorded pre-V2 launches included in population. Prices from archived complete windows or fresh bounded public-RPC reads.',
  standardParameterInference:'When immutable parameter metadata is absent, use the same factory-standard model only if the first recorded buy matches its genesis constant-product output exactly. This does not independently identify every parameter.',
  cashFidelity:'Diagnostic only: historical execution and global coverage lack a passing certificate.'}
const w=(l:any,n:number)=>BigInt('0x'+l.data.slice(2+n*64,66+n*64))
const hex=(x:bigint)=>'0x'+x.toString(16)
const b=(l:any)=>typeof l.blockNumber==='number'?l.blockNumber:Number(BigInt(l.blockNumber))
const li=(l:any)=>typeof l.logIndex==='number'?l.logIndex:Number(BigInt(l.logIndex))
const classify=(t:number|null,e:number|null)=>t===null||t<0?'unknown_tax':t===0?(e===null?'untaxed_unknown':e>=3?'untaxed_3plus':'untaxed_0to2'):t<50?'tax_001_049':t<=200?'tax_05_2':'tax_above2'
let count=0
for(const row of d.prepare('SELECT f.body,p.body path,p.source FROM facts f LEFT JOIN paths p ON p.curve=f.curve ORDER BY f.at').iterate() as Iterable<any>){
 const f=JSON.parse(row.body),ev=row.path?JSON.parse(row.path):null
 let tax=f.creator_tax_bps>=0?f.creator_tax_bps:null
 const ex=f.exemptions??null
 const out:any={token:f.token.toLowerCase(),at:f.detected_at,source:'historical',tax,ex,pair:(f.pair_token||'').toLowerCase(),
  devEth:f.dev_buy_wei===null?null:Number(f.dev_buy_wei)/1e18,group:'',status:'unavailable',reason:null,scenarios:{},pathSource:row.source}
 const done=(reason:string)=>{out.tax=tax;out.group=out.pair===ADDRESSES.ethPair?classify(tax,ex):'noneth';out.reason=reason;rows.push(out)}
 if(out.pair!==ADDRESSES.ethPair){done('non_eth_pair');continue}
 if(!ev){done('historical_path_unavailable');continue}
 if(row.source==='legacy-global-capture'){done('historical_path_unverified');continue}
 const logs=[...new Map(ev.logs.filter((l:any)=>b(l)>=f.block&&b(l)<=f.block+600).map((l:any)=>[l.transactionHash+':'+l.logIndex,l])).values()] as any[]
 logs.sort((a,b_)=>b(a)-b(b_)||li(a)-li(b_))
 let lo=0n,hi=10000n
 for(const l of logs){
  if(l.topics[0]!==T.CurveBuy && l.topics[0]!==T.CurveSell)continue
  const gross=l.topics[0]===T.CurveBuy?w(l,0):w(l,1)+w(l,2)+w(l,3),paid=w(l,3)
  if(gross<=0n)continue
  lo=lo>((paid*10000n+gross-1n)/gross)?lo:(paid*10000n+gross-1n)/gross
  hi=hi<(((paid+1n)*10000n-1n)/gross)?hi:((paid+1n)*10000n-1n)/gross
 }
 if(lo>hi){validation.historicalTaxSources.conflict++;done('conflicting_creator_tax_evidence');continue}
 if(ev.params){tax=Number(ev.params.creatorTaxBps);validation.historicalTaxSources.archive++}
 else if(lo===hi){tax=Number(lo);validation.historicalTaxSources.inferred++}
 else if(tax!==null){validation.historicalTaxSources.recorded++}
 else {validation.historicalTaxSources.unknown++;done('creator_tax_unknown');continue}
 if(BigInt(tax)<lo||BigInt(tax)>hi){validation.historicalTaxSources.conflict++;done('conflicting_creator_tax_evidence');continue}
 if(tax>9800){done('unsupported_tax_economics');continue}
 const p=ev.params
 const firstBuy=logs.find(l=>l.topics[0]===T.CurveBuy)
 if(p && firstBuy && p.phantomQuote==='1680000000000000000' && p.launchSupply==='1000000000000000000000000000'){
  const net=w(firstBuy,0)-w(firstBuy,2)-w(firstBuy,3)
  const supply=BigInt(p.launchSupply),reserved=BigInt(p.reservedTokens),phantom=BigInt(p.phantomQuote)
  let expected=net>0n?supply*net/(phantom+net):0n;if(expected>supply-reserved)expected=supply-reserved
  const error=expected-w(firstBuy,1)
  if(error>1n||error< -1n){done('initial_state_unverified');continue}
 }
 if(p){
  if(p.phantomQuote!=='1680000000000000000'||p.launchSupply!=='1000000000000000000000000000'||p.reservedTokens!=='285714285714285714285714285'||p.feeBps!=='100'||p.snipeTaxStartBps!=='9900'||p.snipeTaxSeconds!=='3'){
   done('nonstandard_curve_parameters');continue
  }
  validation.historicalParameterChecks.archive++
 }else{
  const first=logs.find(l=>l.topics[0]===T.CurveBuy)
  if(!first){validation.historicalParameterChecks.missingFirstBuy++;done('genesis_economics_unverified');continue}
  const net=w(first,0)-w(first,2)-w(first,3),supply=1000000000000000000000000000n,ph=1680000000000000000n,res=285714285714285714285714285n
  if(net<=0n){done('invalid_first_buy');continue}
  let expect=supply*net/(ph+net);if(expect>supply-res)expect=supply-res
  const delta=expect-w(first,1)
  if(delta>1n||delta< -1n){validation.historicalParameterChecks.inconsistentFirstBuy++;done('genesis_economics_mismatch');continue}
  validation.historicalParameterChecks.firstBuyVerified++
 }
 const launchTx=logs.find(l=>l.topics[0]===T.CurveBuy && b(l)===f.block)?.transactionHash?.toLowerCase()??''
 const events:SimEvent[]=[]
 let graduated=Infinity
 for(const l of logs){
  if(l.topics[0]===T.CurveCompleted){graduated=Math.min(graduated,b(l)-f.block-20);continue}
  if(own.has(l.transactionHash.toLowerCase()))continue
  if(l.topics[0]===T.CurveBuy || l.topics[0]===T.CurveSell)events.push({b:b(l),s:l.topics[0]===T.CurveBuy?'B':'S',q:hex(w(l,0)),t:hex(w(l,1)),f:hex(w(l,2)),x:hex(w(l,3)),r:l.topics[2]?'0x'+l.topics[2].slice(-40).toLowerCase():'',tx:l.transactionHash.toLowerCase()})
  else if(l.topics[0]===T.BuybackLocked)events.push({b:b(l),s:'L',q:hex(w(l,0)),t:hex(w(l,1))})
 }
 let P
 try{P=path({token:out.token,block:f.block,deployer:f.deployer??'',tx:launchTx},.0025,events,tax,{...LIVE_PATH,horizon:550})}
 catch(e){done('path_error');continue}
 if(!P){done('entry_unavailable');continue}
 out.entryLiquidityEth=P.pts[0]!.q-1.68
 const full=P.pts.find(x=>x.t<=RES+1e-6)?.off??Infinity
 const until=Math.min(full,graduated)
 const model={...P,pts:P.pts.map(x=>({...x,grad:false}))}
 // Same declared gas fallback as the initial experiment, before any V2 receipt history exists.
 const gas=4.6e-6
 for(const lag of [6,12]){
  const policy={takeProfit:1.36,hardStop:0,deadAfterBlk:0,deadBelowMultiple:0,holdBlk:450,pollBlk:12,exitLagBlk:lag}
  const s=evaluate(model,policyRule(policy),lag,450)
  if(until<=s.off){out.scenarios[String(lag)]={status:'unavailable',reason:'graduated_pool_required'};continue}
  const gross=calibrateReturn(s.mult-1,prior.manifest.policy.calibration)*.0025
  out.scenarios[String(lag)]={status:'closed',pnlEth:gross-gas,rawPnlEth:(s.mult-1)*.0025-gas,doubleGasPnlEth:gross-2*gas,
   gasEth:gas,gasDefaults:3,exitAt:out.at+2000+s.off*100,reason:s.reason,holdMs:s.off*100}
 }
 out.status=out.scenarios['6'].status;done(out.scenarios['6'].reason)
 if(++count%20000===0)console.log('historical scored',count)
}
d.close()
rows.sort((a,b_)=>a.at-b_.at)
if(new Set(rows.map(r=>r.token)).size!==rows.length)throw Error('Duplicate population tokens')
for(const file of ['v1/research/market_september_run.ts','v1/research/market_september_history.py','v1/research/market_september_params.ts']){
 validation.sourceHashes[file]=createHash('sha256').update(readFileSync(file)).digest('hex')
}
const manifest={...prior.manifest,start:1788220800000,first:1788220800000,v2Start:prior.manifest.first,
 extendedFrom:`${previous}/results.json.gz`,extendedSourceSha256:createHash('sha256').update(readFileSync(`${previous}/results.json.gz`)).digest('hex'),
 historicalPopulation:rows.filter(r=>r.source==='historical').length,status:'Diagnostic whole-population study; only resolved paths contribute P&L'}
writeFileSync(`${root}/results.json.gz`,gzipSync(JSON.stringify({manifest,validation,rows})))
writeFileSync(`${root}/manifest.json`,JSON.stringify(manifest,null,2));writeFileSync(`${root}/validation.json`,JSON.stringify(validation,null,2))
console.log(JSON.stringify({rows:rows.length,closed:rows.filter(r=>r.status==='closed').length,reasons:rows.reduce((a,r)=>(a[r.reason]=(a[r.reason]??0)+1,a),{}),validation}))
