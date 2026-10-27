import fs from 'fs'; import { keccak256, toHex } from 'viem';
const RPC='https://rpc.mainnet.chain.robinhood.com';
const T=keccak256(toHex('BuybackLocked(uint256,uint256)'));
async function rpc(method, params){ const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}); return await r.json(); }
const L = JSON.parse(fs.readFileSync('v2_launches.json'));
let from=L.launches[0].block-10, latest=L.latest, chunk=192000, out=[];
while(from<=latest){ const to=Math.min(latest,from+chunk-1);
  const res=await rpc('eth_getLogs',[{fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16),topics:[T]}]);
  if(res.error){ console.log('ERR',from,to,chunk,res.error.message); chunk=Math.max(4000,chunk/2|0); await new Promise(r=>setTimeout(r,1500)); continue; }
  for(const l of res.result){ const d=l.data.slice(2); out.push({b:parseInt(l.blockNumber,16),i:parseInt(l.logIndex,16),a:l.address.toLowerCase(),q:'0x'+d.slice(0,64),t:'0x'+d.slice(64,128)}); }
  from=to+1; if(res.result.length<2000&&chunk<384000) chunk*=2;
}
fs.writeFileSync('buybacks.json',JSON.stringify(out)); console.log('buybacks',out.length,'curves',new Set(out.map(x=>x.a)).size);
