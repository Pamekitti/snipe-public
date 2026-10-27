/** Offline matrix generation through the same pure execution model as paper accounts. */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { apply, params, ordered, predictExecution } from '../../src/strategy/counterfactual.js'
import { freshCurve, simBuy, CurveRevert } from '../../src/state/curve.js'
import type { ExecutionRequest, ExecutionResult } from '../../src/strategy/execution-model.js'
import { EXECUTION_EXITS, TARGETS } from './cloud_catalog.js'
function unknown(at: number, reason: string): ExecutionResult {
  return { modelVersion:'execution-account-v3',evidenceVersion:'capture-v3',status:'unavailable',reason,entryAt:at,exitAt:null,decisionAt:null,tokens:null,spentWei:null,proceedsWei:null,pnlWei:null,costsWei:'0',scenario:null,trace:[],assumption:'External traders retain historical order quantities' }
}
export function executeJob(job: any) {
  const q = job.request as ExecutionRequest & { clockBounds?: number[] }
  if (!q) return {...job, request:undefined, matrix:null}
  try {
    const p = params(q.params), wallet = q.wallet.toLowerCase().replace('0x','')
    let s = freshCurve(p)
    for (const l of ordered(q.logs)) {
      const log = l as ExecutionRequest['logs'][number]
      if (log.observedAt <= q.entryAt && !log.topics.slice(1,3).some(t => t.slice(-40).toLowerCase() === wallet)) s = apply(s,log)
    }
    const quote = simBuy(p,s,BigInt(q.sizeWei),BigInt(Math.floor(q.entryAt/1000))).tokensOut
    q.entryQuoteTokens=String(quote);q.minTokens=String(quote*5000n/10000n)
  } catch (e) {
    if (e instanceof CurveRevert && e.message === 'CurveGraduated') {
      // bot.enter returns before sending when the observed curve cannot quote a buy.
      const result = {status:'rejected',reason:'entry_quote_graduated',exitAt:q.entryAt,decisionAt:q.entryAt,tokens:'0',spentWei:'0',proceedsWei:'0',pnlWei:'0',costsWei:'0'}
      const matrix = [600,1200,2000,...(q.clockBounds ?? [])].flatMap(() => ['before','after'].map(() => EXECUTION_EXITS.map(() => TARGETS.map(() => result))))
      return {...job,request:undefined,matrix,coverage:q.coverage,costProof:job.request.costProof,clockN:job.request.clockN}
    }
    return {...job,request:undefined,matrix:null,unavailable:[...job.unavailable,'causal_entry_quote:'+String(e)]}
  }
  const matrix = [600,1200,2000,...(q.clockBounds ?? [])].flatMap((sell,k) => ['before','after'].map(order => {
    const request = {...q,timing:{...q.timing,sellMs:sell,sameTimeOrder:order as 'before'|'after',label:k<3?'fixed-unfitted-reference':'preceding-sell-bound',n:k<3?0:job.request.clockN}}
    return EXECUTION_EXITS.map(spec => TARGETS.map(tp => {
      const r = predictExecution({...request,takeProfit:tp,rules:{...q.rules,maxHoldMs:spec.holdMs},...(spec.progressHold?{progressHold:spec.progressHold}:{})})
      return {status:r.status,reason:r.reason,exitAt:r.exitAt,decisionAt:r.decisionAt,tokens:r.tokens,spentWei:r.spentWei,proceedsWei:r.proceedsWei,pnlWei:r.pnlWei,costsWei:r.costsWei,...(r.poolReplay?{poolReplay:r.poolReplay}:{})}
    }))
  }))
  return {...job,request:undefined,matrix,coverage:q.coverage,costProof:job.request.costProof,clockN:job.request.clockN,quote:q.entryQuoteTokens,endAt:q.endAt,poolCosts:q.costs}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, output] = process.argv.slice(2)
  const jobs = JSON.parse(readFileSync(source!, 'utf8'))
  const rows = jobs.map(executeJob)
  writeFileSync(output!+'.tmp',JSON.stringify(rows));renameSync(output!+'.tmp',output!)
  console.log(JSON.stringify({jobs:rows.length,complete:rows.filter((r:any)=>r.matrix).length}))
}
