/** Guard compatibility audit of frozen outcomes. This cannot certify execution or activate Auto. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {prepareScenarioAccounts,type ScenarioAccountInput} from '../../src/strategy/scenario-account.js'
import {SELECTED_GUARD,BASELINE_GUARD,CONSERVATIVE_GUARD} from '../../src/strategy/scenario-guard.js'
import {MODEL_HASH} from '../../src/simulation/identity.js'
const [inputPath,out,cutoffArgument]=process.argv.slice(2)
if(!inputPath||!out||!cutoffArgument||!Number.isFinite(Number(cutoffArgument)))throw new Error('Usage: guard_release_audit.ts ACCOUNT_INPUT NEW_OUTPUT_DIRECTORY ERA_CUTOFF_MS')
const bytes=readFileSync(inputPath),input:ScenarioAccountInput=JSON.parse(bytes.toString())
mkdirSync(out,{recursive:false})
const prepared=prepareScenarioAccounts(input),cutoff=Number(cutoffArgument)
const stats=(cash:Array<{at:number;pnlWei:string}>,from:number,to:number)=>{
  let net=0n,peak=0n,dd=0n,win=0n,loss=0n
  for(const p of cash.filter(p=>p.at>=from&&p.at<to)){
    const v=BigInt(p.pnlWei);net+=v;peak=peak>net?peak:net;dd=dd>peak-net?dd:peak-net
    if(v>0n)win+=v;else loss-=v
  }
  return {netWei:String(net),drawdownWei:String(dd),winningWei:String(win),losingWei:String(loss)}
}
const rows=[]
for(const policy of [BASELINE_GUARD,CONSERVATIVE_GUARD,SELECTED_GUARD]){
  const run=prepared.replay(policy)
  for(const account of run.accounts)for(const [era,from,to] of [['sep1-7',input.start,cutoff],['sep8-14',cutoff,input.through+1]] as const){
    const selected=stats(account.selected.cash,from,to),reference=stats(account.reference.cash,from,to)
    rows.push({policy,scenario:account.id,era,...selected,winRetained:Number(reference.winningWei)?Number(selected.winningWei)/Number(reference.winningWei):null,
      lossRetained:Number(reference.losingWei)?Number(selected.losingWei)/Number(reference.losingWei):null,complete:account.selected.complete,reference})
  }
}
writeFileSync(out+'/guard-compatibility.json',JSON.stringify({modelHash:MODEL_HASH,inputHash:createHash('sha256').update(bytes).digest('hex'),rows,
  diagnosticOnly:true,executionReplayed:false,productionScheduleReplayed:false,stakeWei:input.opportunities[0]?.sizeWei,
  controls:input.controls.length,limitations:['Frozen outcome reuse checks guard/account compatibility only.','Input retains previous publication times and execution assumptions.','Not a production replay at the current live stake.'],decision:'not_validated'},null,2))
console.log(JSON.stringify({rows:rows.length,decision:'not_validated',output:out}))
