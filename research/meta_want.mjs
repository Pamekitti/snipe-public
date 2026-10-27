// keep the pull_meta allowlist in step with the fresh window: every fresh launch token.
// pull_meta.mjs only fetches tokens that are in meta_want.json AND missing from meta.json,
// so running this before it makes the meta backfill incremental and cheap.
import fs from 'fs';
const F=JSON.parse(fs.readFileSync('data/fresh_launches.json'));
const want=new Set(JSON.parse(fs.readFileSync('data/meta_want.json')));
let add=0;
for(const l of F.launches){ if(!want.has(l.token)){ want.add(l.token); add++; } }
if(add) fs.writeFileSync('data/meta_want.json',JSON.stringify([...want]));
console.log('meta_want +'+add+' -> '+want.size);
