import { createPublicClient, http, parseAbiItem, decodeEventLog } from 'viem';
import fs from 'fs';
const client = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com', {timeout: 120000}) });
const FACTORY='0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const ev = parseAbiItem('event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)');
const latest = Number(await client.getBlockNumber());
const days = Number(process.argv[2]||13);
const CHUNK = 96000;
let out=[]; let to=latest; const bottom = latest - days*864000;
// find launch timestamps: get block timestamps for chunk edges and interpolate (100ms blocks)
while (to>bottom) {
  const from = Math.max(bottom, to-CHUNK+1);
  const t0=Date.now();
  let logs;
  try { logs = await client.getLogs({address:FACTORY, event:ev, fromBlock:BigInt(from), toBlock:BigInt(to)}); }
  catch(e){ console.log('ERR',from,to,e.shortMessage?.slice(0,100)); await new Promise(r=>setTimeout(r,2000)); continue; }
  for (const l of logs) out.push({block:Number(l.blockNumber), tx:l.transactionHash, token:l.args.token, curve:l.args.curve, deployer:l.args.deployer, pairToken:l.args.pairToken, cfg:Number(l.args.launchConfigId), thr:l.args.graduationThreshold.toString()});
  console.log(from,to,logs.length,(Date.now()-t0)+'ms', 'total',out.length);
  to = from-1;
}
out.sort((a,b)=>a.block-b.block);
fs.writeFileSync('v2_launches.json', JSON.stringify({latest, launches:out}));
console.log('done', out.length);
