/** Read-only proof for a clean, empty restart interval. Never resets an account. */
import Database from 'better-sqlite3'
import {writeFileSync} from 'node:fs'
import {toHex} from 'viem'
import {readClient} from '../src/rpc/read.js'
import {ADDRESSES} from '../src/config.js'
import {EVENT_TOPICS} from '../src/abi.js'
import {encode,digest} from '../src/simulation/store.js'
const [path,id,out]=process.argv.slice(2)
if(!path||!id||!out)throw Error('Usage: check-restart-gap.ts DATABASE GAP_ID NEW_PROOF_JSON')
const db=new Database(path,{readonly:true,fileMustExist:true})
try {
 const gap=db.prepare('SELECT * FROM gaps WHERE id=?').get(id) as {id:string;lo:number;hi:number;reason:string}|undefined
 if(!gap||!id.startsWith('restart:'))throw Error('Unknown restart gap')
 const client=readClient(undefined,{background:true,publicLogs:true})
 const end=await client.getBlockNumber(),start=end-1999n
 const first=await client.getBlock({blockNumber:start}),last=await client.getBlock({blockNumber:end})
 if(Number(first.timestamp)*1000>gap.lo-2000||Number(last.timestamp)*1000<gap.hi+10000)throw Error('Gap is outside the bounded settled range')
 const filter={address:ADDRESSES.factory,topics:[EVENT_TOPICS.TokenLaunched],fromBlock:toHex(start),toBlock:toHex(end)}
 const a=await client.request({method:'eth_getLogs',params:[filter]})
 await new Promise(r=>setTimeout(r,1000))
 const b=await client.request({method:'eth_getLogs',params:[filter]})
 if(encode(a)!==encode(b))throw Error('Independent log scans disagree')
 const blocks=new Map<string,{timestamp:bigint;hash:string|null}>()
 for(const log of a) {
  if(!log.blockNumber||!log.blockHash)throw Error('Unmined log')
  if(!blocks.has(log.blockNumber))blocks.set(log.blockNumber,await client.getBlock({blockNumber:BigInt(log.blockNumber)}))
  if(blocks.get(log.blockNumber)!.hash!==log.blockHash)throw Error('Log/header hash mismatch')
 }
 const relevant=a.filter(l=>{const at=Number(blocks.get(l.blockNumber!)!.timestamp)*1000;return at>=gap.lo-2000&&at<=gap.hi+2000})
 const lastAgain=await client.getBlock({blockNumber:end})
 if(lastAgain.hash!==last.hash)throw Error('Boundary changed')
 const clean=gap.reason==='writer restart interval; prospective capture unavailable'
 const proof={at:Date.now(),gap,clean,start:String(start),end:String(end),first:{timestamp:String(first.timestamp),hash:first.hash},last:{timestamp:String(last.timestamp),hash:last.hash},scanHash:digest(a),matchingScans:2,launchesInExpandedGap:relevant,headers:[...blocks].map(([block,h])=>({block,timestamp:String(h.timestamp),hash:h.hash})),emptyVerified:clean&&relevant.length===0,readOnly:true}
 writeFileSync(out,encode(proof),{flag:'wx'})
 console.log(encode({gap,emptyVerified:proof.emptyVerified,launches:relevant.length,proof:out}))
}finally{db.close()}
