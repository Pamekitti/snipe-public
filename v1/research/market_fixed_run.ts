/** Diagnostic unrestricted opportunities, using the existing V2 path/evaluation engine. */
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import Database from '../../v2/node_modules/better-sqlite3/lib/index.js'
import { path, evaluate, policyRule, calibrateReturn, LIVE_PATH, RES, type SimEvent } from '../../v2/core/sim.js'
import { ADDRESSES, EVENT_TOPICS as T } from '../../v2/core/chain.js'

const root = 'v1/data/research/20260922-market-fixed-v1'
const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, 'utf8'))
const db = new Database(`${root}/evidence.sqlite`, { readonly: true })
const start = manifest.end - 7 * 86400_000
const launches = new Map<string, any>()
const curves = new Map<string, any>()
const metas = new Map<string, any>()
const gaps: Array<{lo:number;hi:number}> = []
let through: number | null = null
let maxBlock = 0, duplicates = 0, omittedEmptyRanges = 0
const rawWord = (d:string,n:number) => '0x' + d.slice(2+n*64,66+n*64)
const ethWord = (d:string,n:number) => Number(BigInt(rawWord(d,n))) / 1e18

for (const r of db.prepare('SELECT * FROM legacy').iterate() as Iterable<any>) {
  launches.set(r.token.toLowerCase(), {...r, source:'legacy', events:[], params:null, devEth:Number(r.dev||0)/1e18})
}
for (const row of db.prepare('SELECT at,kind,body FROM events ORDER BY seq').iterate() as Iterable<any>) {
  const e=JSON.parse(row.body)
  if(row.kind==='chain-read') {
    const r=e.result
    if(r?.params && e.request.kind==='meta') {
      const c=e.request.args[0].toLowerCase()
      if(!metas.has(c)) metas.set(c,{params:r.params,ex:r.exemptions??null,metaAt:row.at})
    }
    continue
  }
  if(e.source==='poll') {
    if(through!==null && e.lo>through+1) {
      omittedEmptyRanges++
      // Empty successful polls emit no batch. Only quarantine long unproven intervals,
      // and do not mislabel ordinary empty ranges as demonstrated data loss.
      if(e.lo-through>600)gaps.push({lo:through+1,hi:e.lo-1})
    }
    through=Math.max(through??0,e.hi);maxBlock=Math.max(maxBlock,e.hi)
  }
  // Register the whole batch first, so launch-transaction buys preceding its launch log are retained.
  for(const l of e.logs) {
    if(l.topics[0]!==T.TokenLaunched || l.address.toLowerCase()!==ADDRESSES.factory)continue
    const token='0x'+l.topics[1].slice(-40).toLowerCase(),curve='0x'+l.topics[2].slice(-40).toLowerCase()
    if(launches.has(token)){duplicates++;continue}
    const r={token,curve,at:row.at,block:l.blockNumber,pair:'0x'+l.data.slice(2,66).slice(-40).toLowerCase(),
      deployer:'0x'+l.topics[3].slice(-40).toLowerCase(),tx:l.transactionHash.toLowerCase(),
      source:'v2',events:[],devEth:0,completedBlock:null,seen:new Set<string>()}
    launches.set(token,r);curves.set(curve,r)
  }
  for(const l of e.logs) {
    const r=curves.get(l.address.toLowerCase())
    if(!r || l.blockNumber>r.block+600 || l.blockNumber<r.block)continue
    const key=l.blockHash+':'+l.logIndex
    if(r.seen.has(key))continue
    r.seen.add(key)
    const b=l.blockNumber,s=l.topics[0]
    if(s===T.CurveCompleted) {r.completedBlock=b;continue}
    let event:SimEvent|undefined
    if(s===T.CurveBuy || s===T.CurveSell) {
      event={b,s:s===T.CurveBuy?'B':'S',q:rawWord(l.data,0),t:rawWord(l.data,1),f:rawWord(l.data,2),x:rawWord(l.data,3),
        r:l.topics[2]?'0x'+l.topics[2].slice(-40).toLowerCase():'',tx:l.transactionHash.toLowerCase()}
      if(s===T.CurveBuy && event.tx===r.tx)r.devEth+=ethWord(l.data,0)
    } else if(s===T.BuybackLocked)event={b,s:'L',q:rawWord(l.data,0),t:rawWord(l.data,1)}
    if(event)r.events.push({...event,li:l.logIndex})
  }
}
db.close()
console.log(JSON.stringify({launches:launches.size,metadata:metas.size,gaps:gaps.length,maxBlock}))

// Preceding receipt costs only. Final six hours never contribute cost calibration.
const source = new Database(manifest.localSource,{readonly:true})
const txKinds=new Map<string,string>()
const costs:Record<string,Array<{at:number;eth:number}>>={buy:[],approve:[],sell:[]}
for(const r of source.prepare("SELECT at,kind,body FROM events WHERE seq<=? AND kind IN ('tx-signed','receipt') ORDER BY seq").iterate(manifest.localMaxSeq) as Iterable<any>){
  const e=JSON.parse(r.body)
  if(r.kind==='tx-signed'){if(e.hash && e.txKind)txKinds.set(e.hash.toLowerCase(),e.txKind);continue}
  const kind=txKinds.get(e.hash?.toLowerCase())
  if(kind && costs[kind] && e.result?.gasWei && e.result.ok && r.at<manifest.end-6*3600_000)
    costs[kind].push({at:r.at,eth:Number(e.result.gasWei)/1e18})
}
source.close()
for(const tx of JSON.parse(readFileSync(`${root}/known-bot-transactions.json`,'utf8'))) {
  if(tx.hash && tx.kind)txKinds.set(tx.hash.toLowerCase(),tx.kind)
}
writeFileSync(`${root}/gas-samples.json`,JSON.stringify(costs))
const fallback:Record<string,number>={buy:2e-6,approve:1e-6,sell:1.6e-6}
function gasAt(at:number){
  let gas=0,defaults=0
  for(const k of ['buy','approve','sell']){
    const a=costs[k].filter(x=>x.at<at).slice(-100).map(x=>x.eth).sort((a,b)=>a-b)
    if(a.length<20){gas+=fallback[k];defaults++}
    else gas+=(a[Math.floor((a.length-1)/2)]!+a[Math.floor(a.length/2)]!)/2
  }
  return {gas,defaults}
}
function group(tax:number|null,ex:number|null){
  if(tax===null || tax<0)return 'unknown_tax'
  if(tax===0)return ex===null?'untaxed_unknown':ex>=3?'untaxed_3plus':'untaxed_0to2'
  return tax<50?'tax_001_049':tax<=200?'tax_05_2':'tax_above2'
}
const results:any[]=[]
let processed=0
for(const r of [...launches.values()].filter(r=>r.at>=start && r.at<=manifest.end).sort((a,b)=>a.at-b.at)){
  const m=metas.get(r.curve),p=m?.params
  const tax=p?Number(p.creatorTaxBps):r.tax??null,ex=m?.ex??r.ex??null
  const out:any={token:r.token,at:r.at,source:r.source,tax,ex,pair:r.pair,devEth:r.devEth,
    group:r.pair!==ADDRESSES.ethPair?'noneth':group(tax,ex),status:'unavailable',reason:null,scenarios:{}}
  const unavailable=(reason:string)=>{out.reason=reason;results.push(out)}
  if(out.group==='noneth'){unavailable('non_eth_pair');continue}
  if(r.source==='legacy'){unavailable('before_v2_tape');continue}
  if(!p){unavailable('missing_curve_metadata');continue}
  if(r.block+550>maxBlock || r.at+55000>manifest.end){unavailable('pending_tail');continue}
  if(gaps.some(g=>g.lo<=r.block+550 && g.hi>=r.block)){unavailable('long_unproven_log_interval');continue}
  if(p.phantomQuote!=='1680000000000000000'||p.launchSupply!=='1000000000000000000000000000'
    ||p.reservedTokens!=='285714285714285714285714285'||p.feeBps!=='100'
    ||p.snipeTaxStartBps!=='9900'||p.snipeTaxSeconds!=='3'){
    out.params=p;unavailable('nonstandard_curve_parameters');continue
  }
  const seq=r.events.filter((e:SimEvent)=>!e.tx || !txKinds.has(e.tx)).sort((a:any,b:any)=>a.b-b.b||a.li-b.li)
  let P
  try{P=path({token:r.token,block:r.block,deployer:r.deployer,tx:r.tx},0.0025,seq,tax,{...LIVE_PATH,horizon:550})}
  catch(e){unavailable('path_error:'+String(e));continue}
  if(!P){unavailable('entry_unavailable');continue}
  const first=P.pts[0]!
  out.entryLiquidityEth=first.q-1.68
  out.entryPriceMultiple=(first.q/1.68)*(1e9/first.t)
  // No graduation-approach exit in this deliberately two-rule experiment.
  // Once the curve is actually unsellable, keep its outcome unavailable instead of inventing a pool fill.
  const full=P.pts.find(x=>x.t<=RES+1e-6)?.off??Infinity
  const grad=Math.min(full,r.completedBlock===null?Infinity:r.completedBlock-r.block-20)
  const noApproach={...P,pts:P.pts.map(x=>({...x,grad:false}))}
  const gas=gasAt(r.at)
  for(const lag of [6,12]){
    const policy={takeProfit:1.36,hardStop:0,deadAfterBlk:0,deadBelowMultiple:0,holdBlk:450,pollBlk:12,exitLagBlk:lag}
    const score=evaluate(noApproach,policyRule(policy),lag,450)
    if(grad<=score.off){out.scenarios[String(lag)]={status:'unavailable',reason:'graduated_pool_required'};continue}
    const rawGross=(score.mult-1)*0.0025
    const gross=calibrateReturn(score.mult-1,manifest.policy.calibration)*0.0025
    const pnl=gross-gas.gas
    if(!Number.isFinite(pnl)||score.off>550)throw Error('Invalid outcome')
    out.scenarios[String(lag)]={status:'closed',pnlEth:pnl,rawPnlEth:rawGross-gas.gas,doubleGasPnlEth:gross-2*gas.gas,
      gasEth:gas.gas,gasDefaults:gas.defaults,exitAt:r.at+2000+score.off*100,reason:score.reason,holdMs:score.off*100}
  }
  out.status=out.scenarios['6'].status;out.reason=out.scenarios['6'].reason
  results.push(out)
  if(++processed%10000===0)console.log('scored',processed)
}
const validation={diagnosticOnly:true,cashFidelity:'No passing certificate binds this dataset and policy',
  ownOrderImpact:'Production float path; known actual bot orders excluded; external historical orders retained; all hypothetical entries independent',
  clock:'Production block clock: 10 blocks/second, not exact historical subsecond inclusion',
  gas:'Median of up to 100 preceding successful receipts per leg; minimum 20; fallback buy 2, approval 1, sell 1.6 microETH',
  graduation:'No approach exit; actual/simulated full graduation before exit is unavailable',
  logCoverage:'Global topic polling, but empty poll coverage is not persisted; completeness not independently certified',
  maxBlock,gaps,omittedEmptyRanges,duplicates,costSamples:Object.fromEntries(Object.entries(costs).map(([k,v])=>[k,v.length])),
  sourceHashes:Object.fromEntries(['v2/core/sim.ts','v1/research/market_fixed_run.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]))}
writeFileSync(`${root}/results.json.gz`,gzipSync(JSON.stringify({manifest,validation,rows:results})))
writeFileSync(`${root}/validation.json`,JSON.stringify(validation,null,2))
console.log(JSON.stringify({rows:results.length,closed:results.filter(r=>r.status==='closed').length,
  reasons:results.reduce((a,r)=>(a[r.reason]=(a[r.reason]??0)+1,a),{}),costSamples:validation.costSamples}))
