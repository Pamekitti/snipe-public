import { createPublicClient, http, formatEther, parseAbi } from 'viem';
import fs from 'fs';
const client = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });
const FACTORY='0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const abi = JSON.parse(fs.readFileSync('abi_0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e.json'));
const views = abi.filter(f=>f.type==='function' && (f.stateMutability==='view'||f.stateMutability==='pure'));
console.log('view fns:', views.map(f=>f.name+'('+f.inputs.map(i=>i.type).join(',')+')').join('\n  '));
for (const f of views) {
  if (f.inputs.length) continue;
  try { const r = await client.readContract({address:FACTORY, abi, functionName:f.name}); console.log('  ',f.name,'=',typeof r==='bigint'?r.toString():JSON.stringify(r,(k,v)=>typeof v==='bigint'?v.toString():v)); } catch(e){ console.log('  ',f.name,'ERR',e.shortMessage); }
}
// launch configs
for (const fn of ['getLaunchConfig','launchConfigs','launchConfig']) {
  const f=views.find(x=>x.name===fn); if(!f) continue;
  for (let i=0;i<6;i++){ try{ const r=await client.readContract({address:FACTORY,abi,functionName:fn,args:[BigInt(i)]}); console.log(fn,i,JSON.stringify(r,(k,v)=>typeof v==='bigint'?v.toString():v)); }catch(e){ console.log(fn,i,'ERR',e.shortMessage?.slice(0,80)); break;} }
}
