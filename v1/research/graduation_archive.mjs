// Read-only archive quotes. Trading endpoint variables and .env are never read.
import fs from 'node:fs';import{createPublicClient,custom,parseAbi}from'viem';import{ResearchRpc}from'./core/acquisition-policy.mjs';
const rpc=new ResearchRpc();
const rows=JSON.parse(fs.readFileSync(process.argv[2] ?? 'data/graduation-audit/quotes.json','utf8'));
const c=createPublicClient({transport:custom({request:({method,params})=>rpc.request(method,params??[])})});const abi=parseAbi(['struct PoolKey {address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks;}','struct Params {PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData;}','function quoteExactInputSingle(Params params) returns(uint256 amountOut,uint256 gasEstimate)']);
const sleep=()=>new Promise(r=>setTimeout(r,300));
async function quote(r,amount,buy,block){await sleep();return(await c.simulateContract({address:'0xe202BB8dd524eE9C5E679e5B5809f7A373a982Ef',abi,functionName:'quoteExactInputSingle',args:[{poolKey:r.key,zeroForOne:buy,exactAmount:amount,hookData:'0x'}],blockNumber:BigInt(block)})).result[0]}
async function blockAt(sec,lo,hi){while(lo<hi){const m=(lo+hi+1n)/2n;await sleep();const b=await c.getBlock({blockNumber:m});if(Number(b.timestamp)<=sec)lo=m;else hi=m-1n}return lo}
for(const r of rows){delete r.error;try{r.tokens=String(await quote(r,20000000000000000n,true,r.entryBlock));r.proceeds=String(await quote(r,BigInt(r.tokens),false,r.exitBlock));
if(r.token==='0x753b0f74502d3d66c278a563cb04503154e6eb0d'){r.rescue=[];for(const sec of[0,2,5,15,45,60,300,621]){let b=BigInt(r.gradBlock);const hb=await blockAt(r.gradTime/1000+sec,b,b+BigInt(sec*12+30));r.rescue.push({sec,block:String(hb),proceeds:String(await quote(r,1806744472837777553324081n,false,hb))})}}
}catch(err){r.error=err.shortMessage||'quote failed'}console.log(JSON.stringify(r))}
console.error(JSON.stringify({acquisition:rpc.summary()}));rpc.close()
