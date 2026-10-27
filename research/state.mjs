import { createPublicClient, http } from 'viem';
import fs from 'fs';
const client = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com', {timeout: 120000, batch:false}) });
const FACTORY='0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const abi = JSON.parse(fs.readFileSync('abi_0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e.json'));
const L = JSON.parse(fs.readFileSync('v2_launches.json'));
// anchors
const anchors=[]; const first=L.launches[0].block-10;
for (let b=first; b<=L.latest; b+=48000) anchors.push(b); anchors.push(L.latest);
const ts={};
for (const b of anchors) { for(let k=0;k<5;k++){ try{ const bl=await client.getBlock({blockNumber:BigInt(b)}); ts[b]=Number(bl.timestamp); break;}catch(e){ await new Promise(r=>setTimeout(r,1000)); } } }
fs.writeFileSync('anchors.json', JSON.stringify(ts));
console.log('anchors', Object.keys(ts).length);
// multicall getLaunchedToken
const res=[]; const BATCH=300;
for (let i=0;i<L.launches.length;i+=BATCH) {
  const slice=L.launches.slice(i,i+BATCH);
  let r;
  for(let k=0;k<6;k++){ try{ r = await client.multicall({contracts: slice.map(l=>({address:FACTORY, abi, functionName:'getLaunchedToken', args:[l.token]})), multicallAddress:'0xcA11bde05977b3631167028862bE2a173976CA11'}); break; }catch(e){ console.log('retry',i,e.shortMessage?.slice(0,80)); await new Promise(r=>setTimeout(r,1500)); } }
  slice.forEach((l,j)=>{ const x=r[j]?.result; res.push(x?{token:l.token, phase:Number(x.phase), creatorTaxBps:Number(x.creatorTaxBps), buyback:x.buybackEnabled, sweptQuote:x.sweptQuote.toString(), sweptAt:Number(x.sweptAt), poolFee:Number(x.poolFee), pairToken:x.pairToken}:{token:l.token, err:true}); });
  if (i%3000===0) console.log(i, 'phases so far', res.filter(x=>x.phase>0).length);
}
fs.writeFileSync('states.json', JSON.stringify(res));
const ph={}; res.forEach(x=>{ph[x.phase??'err']=(ph[x.phase??'err']||0)+1});
console.log('phase dist', ph);
const ct={}; res.forEach(x=>{ct[x.creatorTaxBps]=(ct[x.creatorTaxBps]||0)+1}); console.log('creatorTax dist', Object.entries(ct).sort((a,b)=>b[1]-a[1]).slice(0,12));
const pt={}; res.forEach(x=>{pt[x.pairToken]=(pt[x.pairToken]||0)+1}); console.log('pairToken dist', pt);
