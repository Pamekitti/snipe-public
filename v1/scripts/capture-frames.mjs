// refresh the decoder fixtures from the live feed
import WebSocket from 'ws'; import fs from 'fs';
const ws = new WebSocket('wss://feed.mainnet.chain.robinhood.com', { perMessageDeflate:false });
const out=[]; const T0=Date.now();
ws.on('message', d => { out.push({t:Date.now()-T0, raw:d.toString()});
  if (out.length>=400){ fs.writeFileSync('test/fixtures/feed-frames.json', JSON.stringify(out)); console.log('wrote',out.length); process.exit(0);} });
ws.on('error', e=>{ console.error(e.message); process.exit(1); });
