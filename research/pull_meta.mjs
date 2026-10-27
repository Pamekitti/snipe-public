// fetch launch calldata (name/symbol/logo/description/socials/buyback/exemptions) for launches.
// this is exactly what the bot can see in the sequencer feed at +0s, so it is fair game as a filter.
import fs from 'fs';
import { decodeFunctionData } from 'viem';
const RPC='https://rpc.mainnet.chain.robinhood.com';
const abi=JSON.parse(fs.readFileSync('data/abi_0xe33E9E479dF8802cb0866d5d05258bEc4cF62948.json'));
const out=fs.existsSync('data/meta.json')?JSON.parse(fs.readFileSync('data/meta.json')):{};
const files=['data/v2_launches.json','data/fresh_launches.json'];
const W=new Set(JSON.parse(fs.readFileSync('data/meta_want.json')));
let want=[];
for(const f of files){const L=JSON.parse(fs.readFileSync(f)); for(const l of L.launches){ if(!out[l.token] && W.has(l.token)) want.push(l);} }
console.log('need',want.length,'of',want.length+Object.keys(out).length);
async function batch(txs){
  const body=txs.map((tx,i)=>({jsonrpc:'2.0',id:i,method:'eth_getTransactionByHash',params:[tx]}));
  for(let k=0;k<6;k++){try{const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(Array.isArray(j))return j;}catch(e){} await new Promise(r=>setTimeout(r,800*(k+1)));}
  return null;
}
const B=40; let done=0; const t0=Date.now();
for(let i=0;i<want.length;i+=B){
  const sl=want.slice(i,i+B); const res=await batch(sl.map(l=>l.tx));
  if(!res){console.log('batch failed',i);continue;}
  for(const r of res){ const l=sl[r.id]; const t=r.result; if(!t){out[l.token]={err:true};continue;}
    let m={from:t.from,to:t.to,value:t.value};
    try{ const d=decodeFunctionData({abi,data:t.input}); const p=d.args[0];
      m.fn=d.functionName; m.name=p.name; m.symbol=p.symbol; m.logo=p.logo?p.logo.length:0; m.logo_prefix=(p.logo||'').slice(0,12); m.desc=p.description?p.description.length:0;
      m.tw=!!p.socials?.twitter; m.tg=!!p.socials?.telegram; m.dc=!!p.socials?.discord; m.web=!!p.socials?.website; m.fc=!!p.socials?.farcaster;
      m.ctax=Number(p.creatorTaxBps); m.buyback=!!p.buybackEnabled; m.quoteIn=d.args[3]?.toString(); m.exempt=(d.args[6]||[]).length;
      m.feeRecipSelf=(p.creatorFeeRecipient||'').toLowerCase()===t.from.toLowerCase();
    }catch(e){ m.decodeErr=String(e).slice(0,60); m.inputLen=t.input.length; }
    out[l.token]=m; }
  done+=sl.length;
  if(done%400===0||done===want.length){console.log(done,'/',want.length,((Date.now()-t0)/1000).toFixed(0)+'s'); fs.writeFileSync('data/meta.json',JSON.stringify(out));}
}
fs.writeFileSync('data/meta.json',JSON.stringify(out));
console.log('DONE',Object.keys(out).length);
