import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { prepareScenarioAccounts, compactScenarioAccountResult, type ScenarioAccountInput } from '../../src/strategy/scenario-account.js'
import type { GuardPolicy } from '../../src/strategy/scenario-guard.js'
const [source, policiesFile, output] = process.argv.slice(2)
const input = JSON.parse(readFileSync(source!, 'utf8')) as ScenarioAccountInput
const policies: GuardPolicy[] = JSON.parse(readFileSync(policiesFile!, 'utf8'))
const prepared = prepareScenarioAccounts(input)
const manifest=JSON.parse(readFileSync(process.argv[5] ?? source!.replace(/accounts\/[^/]+$/, 'input-manifest.json'),'utf8'))
const meta = new Map(input.opportunities.map(o => [o.id,o]))
const start=manifest.start
const periods: Array<{id:string;from:number;to:number;fit:boolean}>=manifest.periods ?? [3,5,7].map(d=>({id:'train'+d,from:start,to:start+d*86400000,fit:true})).concat([{id:'all',from:start,to:input.through,fit:false}])
const results=[]
for (const policy of policies) {
  const run=prepared.replay(policy)
  const periodsResult=Object.fromEntries(periods.map(p=>[p.id,run.accounts.map(a=>{
    const cash=a.selected.cash.filter(c=>c.at>=p.from&&c.at<p.to&&(!p.fit||(meta.get(c.id)?.availableAt??Infinity)<p.to))
    let net=0n,peak=0n,dd=0n,profit=0n,loss=0n
    for(const c of cash){const x=BigInt(c.pnlWei);net+=x;if(net>peak)peak=net;if(peak-net>dd)dd=peak-net;if(x>0n)profit+=x;else loss-=x}
    const episodes = new Map<number,number>()
    for (const c of cash) {
      const entry=meta.get(c.id)?.at ?? c.at
      const r=a.recoveries.findLast(r=>r.at<=entry)
      if(r)episodes.set(r.at,(episodes.get(r.at)??0)+Number(c.pnlWei)/1e18)
    }
    const missing=[...a.selected.unavailable,...a.reference.unavailable,...(run.continuous.find(s=>s.id===a.id)?.metrics.unavailable??[])]
    const unknown=input.start>p.from || input.through<p.to || missing.some(id=>(meta.get(id)?.at??start)<p.to)
    return {id:a.id,net:Number(net)/1e18,dd:Number(dd)/1e18,profit:Number(profit)/1e18,loss:Number(loss)/1e18,n:cash.length,complete:!unknown,
      recoveryLoss:[...episodes.values()].reduce((s,n)=>s+Math.max(0,-n),0),losingRecoveries:[...episodes.values()].filter(n=>n<0).length}
  })]))
  results.push({...compactScenarioAccountResult(run),periods:periodsResult})
  if(results.length%10===0)writeFileSync(output!+'.progress.json',JSON.stringify({completed:results.length,total:policies.length,heartbeat:Date.now()}))
}
writeFileSync(output!+'.tmp',JSON.stringify({results,stats:prepared.stats}));renameSync(output!+'.tmp',output!)
console.log(JSON.stringify({completed:results.length,stats:prepared.stats,peakRss:process.resourceUsage().maxRSS}))
