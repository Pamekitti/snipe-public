import fs from 'fs';
const RPC='https://rpc.mainnet.chain.robinhood.com';
const BUY='0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455', SELL='0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df';
async function rpc(method, params){ const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}); return await r.json(); }
const L = JSON.parse(fs.readFileSync('v2_launches.json'));
const start = L.launches[0].block - 10; const latest = L.latest;
const out = fs.createWriteStream('trades.jsonl');
let from = start; let chunk = 48000; let total=0; const t0=Date.now();
while (from <= latest) {
  const to = Math.min(latest, from+chunk-1);
  let res;
  try { res = await rpc('eth_getLogs',[{fromBlock:'0x'+from.toString(16), toBlock:'0x'+to.toString(16), topics:[[BUY,SELL]]}]); }
  catch(e){ res={error:{message:String(e)}}; }
  if (res.error) { console.log('ERR',from,to,chunk,JSON.stringify(res.error).slice(0,120)); chunk=Math.max(1000,Math.floor(chunk/2)); continue; }
  const logs=res.result;
  for (const l of logs) {
    const d=l.data.slice(2);
    out.write(JSON.stringify({b:parseInt(l.blockNumber,16), i:parseInt(l.logIndex,16), a:l.address.toLowerCase(), s:l.topics[0]===BUY?'B':'S', u:'0x'+l.topics[1].slice(26), r:'0x'+l.topics[2].slice(26), q:'0x'+d.slice(0,64), t:'0x'+d.slice(64,128), f:'0x'+d.slice(128,192), x:'0x'+d.slice(192,256), tx:l.transactionHash})+'\n');
  }
  total+=logs.length;
  console.log(from,to,'chunk',chunk,'logs',logs.length,'total',total,((Date.now()-t0)/1000).toFixed(0)+'s');
  from = to+1;
  if (logs.length<3000 && chunk<96000) chunk=Math.min(96000,chunk*2);
  else if (logs.length>15000) chunk=Math.max(2000,Math.floor(chunk/2));
}
out.end(); console.log('DONE total',total);
