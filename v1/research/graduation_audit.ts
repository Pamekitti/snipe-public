/** Read-only historical V4 quotes. Run from bot/ with ENV_FILE=.env.example. */
import fs from 'node:fs'
import {createPublicClient,http,parseAbiItem,zeroAddress,type Hex} from 'viem'
import {V4,quoterAbi,type PoolKey} from '../src/tx/graduated.js'
const dir='data/graduation-audit',cohort=JSON.parse(fs.readFileSync(`${dir}/cohort.json`,'utf8'))
const raw=createPublicClient({transport:http('https://rpc.mainnet.chain.robinhood.com',{retryCount:5,retryDelay:1000})})
const c=new Proxy(raw,{get(t,k){const f=Reflect.get(t,k);if(typeof f!=='function')return f;return async(...args:any[])=>{for(let i=0;;i++){try{return await f(...args)}catch(e){if(i>=8||!/429|too many|timeout/i.test(String(e)))throw e;await new Promise(r=>setTimeout(r,1000*(i+1)))}}}}})

const sleep=()=>new Promise(r=>setTimeout(r,700))
async function blockAt(sec:number,lo:bigint,hi:bigint):Promise<bigint>{while(lo<hi){const m=(lo+hi+1n)/2n;await sleep();const b=await c.getBlock({blockNumber:m});if(Number(b.timestamp)<=sec)lo=m;else hi=m-1n}return lo}
const first=BigInt(Math.min(...cohort.launches.map((r:any)=>r.block))),tip=await c.getBlockNumber()
const end=await blockAt(Math.floor(cohort.snapshot_at/1000),first,tip)
const events=parseAbiItem('event PoolGraduated(address indexed token,uint256 positionId,uint256 tokenAmount,uint256 pairTokenAmount)')
let grads:any[]=[]
const cache=`${dir}/graduations.json`
if(fs.existsSync(cache))grads=JSON.parse(fs.readFileSync(cache,'utf8'))
else {let start=first;const scan=`${dir}/scan.json`;if(fs.existsSync(scan)){const saved=JSON.parse(fs.readFileSync(scan,'utf8'));start=BigInt(saved.next);grads=saved.grads}for(let lo=start;lo<=end;lo+=2000n){await sleep();const logs=await c.getLogs({address:'0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',event:events,fromBlock:lo,toBlock:lo+1999n<end?lo+1999n:end});grads.push(...logs);fs.writeFileSync(scan,JSON.stringify({next:String(lo+2000n),grads},(_,v)=>typeof v==='bigint'?String(v):v));process.stdout.write('.')}fs.writeFileSync(cache,JSON.stringify(grads,(_,v)=>typeof v==='bigint'?String(v):v))}
console.log('\nGraduations',grads.length)
const init=parseAbiItem('event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)')
let results:any[]=fs.existsSync(`${dir}/quotes.json`)?JSON.parse(fs.readFileSync(`${dir}/quotes.json`,'utf8')):[]
const eligible=cohort.launches.filter((r:any)=>r.passed===1&&r.creator_tax_bps>=50&&r.creator_tax_bps<=200&&r.exemptions>=3)
for(const g of grads){const token=g.args.token.toLowerCase(),l=eligible.find((r:any)=>r.token.toLowerCase()===token);if(!l||results.some(r=>r.token===token))continue
 const b=BigInt(g.blockNumber),r:any={token,name:l.symbol,gradBlock:String(b),detected_at:l.detected_at}
 try {await sleep();const gb=await c.getBlock({blockNumber:b});r.gradTime=Number(gb.timestamp)*1000
 await sleep();const logs=await c.getLogs({address:V4.manager,event:init,args:{currency1:token as Hex},fromBlock:b,toBlock:b});const a=logs[0]?.args;if(!a||a.currency0!==zeroAddress)throw Error('no native pool Initialize')
 const key={currency0:a.currency0,currency1:a.currency1,fee:a.fee,tickSpacing:a.tickSpacing,hooks:a.hooks} as PoolKey;r.key=key
 async function quote(amount:bigint,buy:boolean,block:bigint){await sleep();return (await c.simulateContract({address:V4.quoter,abi:quoterAbi,functionName:'quoteExactInputSingle',args:[{poolKey:key,zeroForOne:buy,exactAmount:amount,hookData:'0x'}],blockNumber:block})).result[0]}
 if(r.gradTime+47000>cohort.snapshot_at)throw Error('incomplete 47-second followup')
 const eb=await blockAt(Number(gb.timestamp)+2,b,b+100n<end?b+100n:end),xb=await blockAt(Number(gb.timestamp)+47,eb,b+700n<end?b+700n:end)
 r.entryBlock=String(eb);r.exitBlock=String(xb);r.tokens=String(await quote(20000000000000000n,true,eb));r.proceeds=String(await quote(BigInt(r.tokens),false,xb))
 if(token==='0x753b0f74502d3d66c278a563cb04503154e6eb0d') {r.rescue=[];for(const sec of [0,2,5,15,45,60,300,621]){const hb=await blockAt(Number(gb.timestamp)+sec,b,b+BigInt(sec*12+30)<end?b+BigInt(sec*12+30):end);r.rescue.push({sec,block:String(hb),proceeds:String(await quote(1806744472837777553324081n,false,hb))})}}
 }catch(e){r.error=String(e).slice(0,250)}
 results.push(r);fs.writeFileSync(`${dir}/quotes.json`,JSON.stringify(results,null,2));console.log(l.symbol,r.proceeds??r.error)
}
