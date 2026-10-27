// extend the fresh window (data/fresh_*.json + fresh_trades.jsonl) up to the current head.
// idempotent: re-run any time, it only fetches blocks past the previous fresh.latest.
import fs from 'fs';
import { createPublicClient, http } from 'viem';
const RPC='https://rpc.mainnet.chain.robinhood.com';
const TL='0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';
const BUY='0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455';
const SELL='0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df';
const BB='0x5feba9b0d52c92ada4b9c571c2bee52390c54f2947208ab250221e6ee32f12ff';
const FACTORY='0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
async function rpc(m,p,tries=8){for(let k=0;k<tries;k++){try{const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});return await r.json();}catch(e){await new Promise(r=>setTimeout(r,700*(k+1)));}}return{error:{message:'net'}};}
const latest=parseInt((await rpc('eth_blockNumber',[])).result,16);
const F=JSON.parse(fs.readFileSync('data/fresh_launches.json'));
const from0=F.latest+1;
console.log('extending fresh window',from0,'->',latest,'=',((latest-from0)/864000).toFixed(2),'days');
let out=[],from=from0,chunk=96000;
while(from<=latest){const to=Math.min(latest,from+chunk-1);
  const r=await rpc('eth_getLogs',[{fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16),address:FACTORY,topics:[TL]}]);
  if(r.error||!r.result){chunk=Math.max(6000,chunk/2|0);await new Promise(x=>setTimeout(x,900));continue;}
  for(const l of r.result){const d=l.data.slice(2);
    out.push({block:parseInt(l.blockNumber,16),tx:l.transactionHash,token:'0x'+l.topics[1].slice(26),curve:'0x'+l.topics[2].slice(26),deployer:'0x'+l.topics[3].slice(26),pairToken:'0x'+d.slice(24,64)});}
  from=to+1;}
console.log('new launches',out.length);
// trades + buybacks, appended.
//
// FIXED 2026-08-18. This loop used to start at chunk=48000 and DOUBLE the chunk whenever a
// response came back under 3000 logs. The public RPC caps a getLogs response and returns the
// cap with no error, so every oversized chunk silently dropped its tail while the loop
// advanced past it anyway. It cost us 9,117 trade rows in blocks 39.5M-39.6M - exactly the
// window the bot went live in. Every recent curve looked untraded, dev-buy read 0.00 for all
// 36 live-traded tokens, and the research cohort quietly degenerated into "launches whose
// logs happened to survive the pull". The sim was scoring a different population than the
// bot was buying.
//
// Now: fixed 8k-block chunks (max observed 7,035 logs, comfortably under the cap) and a hard
// abort if any chunk comes back at or above CAP_SUSPECT, because a truncated pull must fail
// loudly rather than silently narrow the dataset.
const CAP_SUSPECT=9000;
const ws=fs.createWriteStream('fresh_trades.jsonl',{flags:'a'});let tot=0;from=from0;chunk=8000;
const bbs=fs.existsSync('data/fresh_buybacks.json')?JSON.parse(fs.readFileSync('data/fresh_buybacks.json')):[];
while(from<=latest){const to=Math.min(latest,from+chunk-1);
  const r=await rpc('eth_getLogs',[{fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16),topics:[[BUY,SELL,BB]]}]);
  if(r.error||!r.result){chunk=Math.max(2000,chunk/2|0);await new Promise(x=>setTimeout(x,900));continue;}
  for(const l of r.result){const d=l.data.slice(2);
    if(l.topics[0]===BB){bbs.push({b:parseInt(l.blockNumber,16),i:parseInt(l.logIndex,16),a:l.address.toLowerCase(),q:'0x'+d.slice(0,64),t:'0x'+d.slice(64,128)});continue;}
    ws.write(JSON.stringify({b:parseInt(l.blockNumber,16),i:parseInt(l.logIndex,16),a:l.address.toLowerCase(),s:l.topics[0]===BUY?'B':'S',u:'0x'+l.topics[1].slice(26),r:'0x'+l.topics[2].slice(26),q:'0x'+d.slice(0,64),t:'0x'+d.slice(64,128),f:'0x'+d.slice(128,192),x:'0x'+d.slice(192,256),tx:l.transactionHash})+'\n');}
  if(r.result.length>=CAP_SUSPECT){
    console.error(`ABORT: chunk ${from}-${to} returned ${r.result.length} logs, at or above the`
      +` suspected RPC cap. The response is probably truncated. Lower the chunk size and re-run;`
      +` do NOT let a partial pull land in the dataset.`);
    process.exit(1);}
  tot+=r.result.length;from=to+1;
  console.log(' trades',from,'/',latest,'tot',tot);}
await new Promise(r=>ws.end(r));
console.log('new trade rows',tot,'buybacks total',bbs.length);
fs.writeFileSync('data/fresh_buybacks.json',JSON.stringify(bbs));
// states for the new launches + anchors, merged
const client=createPublicClient({transport:http(RPC,{timeout:120000})});
const abi=JSON.parse(fs.readFileSync('data/abi_0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e.json'));
const states=JSON.parse(fs.readFileSync('data/fresh_states.json'));
for(let i=0;i<out.length;i+=250){
  const sl=out.slice(i,i+250); let r;
  for(let k=0;k<6;k++){try{r=await client.multicall({contracts:sl.map(l=>({address:FACTORY,abi,functionName:'getLaunchedToken',args:[l.token]})),multicallAddress:'0xcA11bde05977b3631167028862bE2a173976CA11'});break;}catch(e){await new Promise(x=>setTimeout(x,1500));}}
  sl.forEach((l,j)=>{const x=r?.[j]?.result; states.push(x?{token:l.token,phase:Number(x.phase),creatorTaxBps:Number(x.creatorTaxBps),pairToken:x.pairToken}:{token:l.token,err:true});});
}
fs.writeFileSync('data/fresh_states.json',JSON.stringify(states));
const ts=JSON.parse(fs.readFileSync('data/fresh_anchors.json'));
const a=[];for(let b=from0;b<=latest;b+=48000)a.push(b);a.push(latest);
for(const b of a){for(let k=0;k<5;k++){try{const bl=await client.getBlock({blockNumber:BigInt(b)});ts[b]=Number(bl.timestamp);break;}catch(e){await new Promise(x=>setTimeout(x,900));}}}
fs.writeFileSync('data/fresh_anchors.json',JSON.stringify(ts));
F.launches.push(...out); F.latest=latest;
fs.writeFileSync('data/fresh_launches.json',JSON.stringify(F));
console.log('DONE fresh window now',F.from,'->',latest,'launches',F.launches.length,'states',states.length,'anchors',Object.keys(ts).length);
