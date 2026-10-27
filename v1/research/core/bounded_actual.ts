/** Evaluate frozen actual intents with every pool quote sensitivity. */
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs'
import { resolveResearchPoolQuote } from '../../src/strategy/counterfactual.js'
const root=process.argv[2]!
const predictions=JSON.parse(readFileSync(root+'/actual-audit/predictions.json','utf8'))
const audit=JSON.parse(readFileSync(root+'/actual-audit/audit.json','utf8'))
const requests=JSON.parse(readFileSync(root+'/actual-audit/pool-requests.json','utf8'))
const quotes=JSON.parse(readFileSync(root+'/pool-quotes/actual-pool-requests.json','utf8')).quotes
for(const d of [0,2000,5000])for(const h of [0,1000,2500]) {
 const values=predictions.map((r:any)=>{
  const hand=r.poolReplay;if(!hand)return r
  const q=quotes[hand.inputHash+':'+d],input=requests.find((v:any)=>v.handoff.inputHash===hand.inputHash)
  if(q?.kind!=='historical-pool-quote-scenario')return {...r,reason:q?.reason??'quote_unavailable'}
  return resolveResearchPoolQuote(r,{...q,haircutBps:h,scenarioId:`pool-d${d}-h${h}`},input.request.endAt)
 })
 const out=root+`/actual-scenarios/pool-d${d}-h${h}`;mkdirSync(out,{recursive:true})
 writeFileSync(out+'/predictions.json',JSON.stringify(values))
 writeFileSync(out+'/audit.json',JSON.stringify({...audit,poolScenario:{kind:'historical-quote',extraDelayMs:d,haircutBps:h}}))
}
