// Read-only launch-entry and held-inventory quotes. Input is produced by
// graduation_launch_prepare.mjs. The configured archive RPC is used without a wallet key.
import fs from 'node:fs'
import {createPublicClient,custom,parseAbi,zeroAddress} from 'viem'
import {ResearchRpc} from './core/acquisition-policy.mjs'
const rpc=new ResearchRpc()
const input=JSON.parse(fs.readFileSync(process.argv[2]||'data/graduation-launch-audit/targets.json','utf8'))
const c=createPublicClient({transport:custom({request:({method,params})=>rpc.request(method,params??[])})}),wallet='0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
const abi=parseAbi(['function buy(uint256 quoteIn,uint256 minTokensOut,address recipient) payable returns(uint256 tokensOut)','function launchedAt() view returns(uint256)','function graduated() view returns(bool)','function getReserves() view returns(uint256,uint256)'])
const qabi=parseAbi(['struct PoolKey {address currency0;address currency1;uint24 fee;int24 tickSpacing;address hooks;}','struct Params {PoolKey poolKey;bool zeroForOne;uint128 exactAmount;bytes hookData;}','function quoteExactInputSingle(Params params) returns(uint256 amountOut,uint256 gasEstimate)'])
const sleep=()=>new Promise(r=>setTimeout(r,180)),cache=new Map()
async function block(n){if(!cache.has(String(n))){await sleep();cache.set(String(n),await c.getBlock({blockNumber:n}))}return cache.get(String(n))}
async function firstAt(sec,lo,hi){while(lo<hi){const m=(lo+hi)/2n;if(Number((await block(m)).timestamp)<sec)lo=m+1n;else hi=m}return lo}
async function buy(r,at){await sleep();return(await c.simulateContract({account:wallet,address:r.launch.curve,abi,functionName:'buy',args:[20000000000000000n,1n,wallet],value:20000000000000000n,blockNumber:at})).result}
async function quote(r,amount,at){await sleep();return(await c.simulateContract({address:'0xe202BB8dd524eE9C5E679e5B5809f7A373a982Ef',abi:qabi,functionName:'quoteExactInputSingle',args:[{poolKey:r.key,zeroForOne:false,exactAmount:amount,hookData:'0x'}],blockNumber:at})).result[0]}
for(const r of input.targets){
 const age=r.gradTime-r.launch.launched_at;r.gradAge=age
 if(age>47){r.scope='graduated after normal time cap';console.log(JSON.stringify(r));continue}
 r.scope='fast graduation';r.waits=[]
 try{
  const eb=await firstAt(r.launch.launched_at+2,BigInt(r.launch.block),BigInt(r.launch.block)+80n);r.entryBlock=String(eb)
  try{r.normalTokens=String(await buy(r,eb))}catch(e){r.entryError=e.shortMessage||'entry failed'}
  const delayed=await firstAt(r.launch.launched_at+3,eb,BigInt(r.launch.block)+100n)
  try{r.delayedEntryTokens=String(await buy(r,delayed))}catch(e){r.delayedEntryError=e.shortMessage||'delayed entry failed'}
  if(r.position){r.inventory=r.position.tokens_held;r.inventorySource='actual launch purchase'}
  else if(r.normalTokens){r.inventory=r.normalTokens;r.inventorySource='hypothetical normal launch purchase'}
  else {r.scope='normal launch entry unavailable';console.log(JSON.stringify(r));continue}
  for(const sec of [2,5,15,30,60,180,600]){
   const v={sec}
   if((r.gradTime+sec)*1000>input.snapshot_at){v.error='outside frozen followup';r.waits.push(v);continue}
   try{const b=await firstAt(r.gradTime+sec,BigInt(r.gradBlock),BigInt(r.gradBlock)+BigInt(sec*12+100));v.block=String(b);v.proceeds=String(await quote(r,BigInt(r.inventory),b))}catch(e){v.error=e.shortMessage||'quote failed'}
   r.waits.push(v)
  }
  if(r.launch.entry_reject?.startsWith('pumped')){
   r.guardWindow=[]
   for(let b=eb;b<=BigInt(r.gradBlock)+2n;b+=2n){const v={block:String(b)};try{v.tokens=String(await buy(r,b))}catch(e){v.error=e.shortMessage||'entry failed'}r.guardWindow.push(v)}
  }
 }catch(e){r.error=e.shortMessage||'historical read failed'}
 console.log(JSON.stringify(r))
}
console.error(JSON.stringify({acquisition:rpc.summary()}));rpc.close()
