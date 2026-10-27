/** Apply offline quote evidence through the same settlement used by predictExecution. */
import { readFileSync,writeFileSync,renameSync } from 'node:fs'
import { resolveResearchPoolQuote } from '../../src/strategy/counterfactual.js'
const [source,quotesFile,output,delayArg,haircutArg]=process.argv.slice(2)
const rows=JSON.parse(readFileSync(source!,'utf8')), proof=JSON.parse(readFileSync(quotesFile!,'utf8'))
const delay=Number(delayArg),haircut=Number(haircutArg)
for(const row of rows)for(const lane of row.matrix??[])for(const exits of lane)for(let i=0;i<exits.length;i++) {
  const r=exits[i],h=r.poolReplay;if(!h)continue
  const quote=proof.quotes[h.inputHash+':'+delay]
  if(quote?.kind==='historical-pool-quote-scenario')exits[i]=resolveResearchPoolQuote(r,{...quote,haircutBps:haircut,scenarioId:`pool-d${delay}-h${haircut}`},row.endAt)
  else exits[i]={...r,reason:quote?.reason??'pool_quote_not_acquired'}
}
writeFileSync(output!+'.tmp',JSON.stringify(rows));renameSync(output!+'.tmp',output!)
