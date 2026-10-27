/** Bounded read-only immutable getter recovery for paths with no verifiable first buy. */
import {createRequire} from 'node:module'
import {readFileSync,writeFileSync} from 'node:fs'
import {gunzipSync} from 'node:zlib'
import Database from '../../v2/node_modules/better-sqlite3/lib/index.js'
import {curveAbi} from '../../v2/io/abi.js'
const require=createRequire(new URL('../../v2/package.json',import.meta.url))
const {createPublicClient,http}=require('viem')
const root='v1/data/research/20260922-market-september-v1'
const doc=JSON.parse(gunzipSync(readFileSync(`${root}/results.json.gz`)).toString())
const missing=doc.rows.filter((r:any)=>r.source==='historical'&&['genesis_economics_unverified','creator_tax_unknown','genesis_economics_mismatch'].includes(r.reason))
const strata=new Map<string,any[]>()
for(const r of doc.rows){
 if(r.source!=='historical'||r.pathSource!=='public-rpc-full-window'||r.status!=='closed')continue
 const key=new Date(r.at).toISOString().slice(0,10)+':'+(r.tax===0?'0':r.tax<50?'low':r.tax<=200?'medium':'high')
 const xs=strata.get(key)??[];xs.push(r);strata.set(key,xs)
}
// Deterministic token-order sample, chosen without looking at P&L.
const sample=[...strata.values()].flatMap(xs=>xs.sort((a,b)=>a.token.localeCompare(b.token)).slice(0,3))
const targets=[...new Map([...missing,...sample].map((r:any)=>[r.token,r])).values()]
const db=new Database(`${root}/history.sqlite`)
const client=createPublicClient({transport:http('https://rpc.mainnet.chain.robinhood.com',{retryCount:0,timeout:30000})})
const keys=['phantomQuote','reservedTokens','launchSupply','feeBps','creatorTaxBps','snipeTaxStartBps','snipeTaxSeconds','launchedAt']
const rows=targets.map((r:any)=>db.prepare('SELECT f.curve,p.body,p.source FROM facts f JOIN paths p ON p.curve=f.curve WHERE f.token=?').get(r.token)).filter(Boolean)
let recovered=0,failed=0
for(let i=0;i<rows.length;i+=100){
 const part=rows.slice(i,i+100)
 const contracts=part.flatMap((r:any)=>keys.map(functionName=>({address:r.curve,abi:curveAbi,functionName})))
 let answers:any[]|null=null
 for(let attempt=0;attempt<3;attempt++){
  try{answers=await client.multicall({contracts,batchSize:0,multicallAddress:'0xcA11bde05977b3631167028862bE2a173976CA11',allowFailure:true});break}
  catch{await new Promise(r=>setTimeout(r,5000*(attempt+1)))}
 }
 for(let j=0;j<part.length;j++){
  const cells=answers?.slice(j*8,j*8+8)
  if(!cells||cells.length!==8||cells.some((x:any)=>x.status!=='success')){failed++;continue}
  const p=JSON.parse(part[j].body);p.params=Object.fromEntries(keys.map((k,n)=>[k,String(cells[n].result)]));p.parameterSource='immutable getters, latest; not current reserves'
  db.prepare('UPDATE paths SET body=?,source=? WHERE curve=?').run(JSON.stringify(p),part[j].source+':immutable-getters',part[j].curve);recovered++
 }
 console.log(JSON.stringify({processed:Math.min(i+100,rows.length),total:rows.length,recovered,failed}))
 await new Promise(r=>setTimeout(r,1400))
}
db.close();writeFileSync(`${root}/parameter-recovery.json`,JSON.stringify({targets:targets.length,missingTargets:missing.length,independentStratifiedSample:sample.length,recovered,failed,fields:keys,source:'Public RPC read-only immutable deployment constants'},null,2))
