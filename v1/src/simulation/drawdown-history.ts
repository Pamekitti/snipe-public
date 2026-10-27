import type { AccountConfig, AccountRun } from '../strategy/paper-account.js'
import type { ScenarioControl } from '../strategy/scenario-account.js'

/** Reconstruct only recorded reducer stops. No inferred recovery or accounting reset. */
export function drawdownHistory(run: AccountRun, initial: AccountConfig, controls: ScenarioControl[], through: number) {
  let limit=BigInt(initial.maxDrawdownWei),cash=0n,base=0n,peak=0n,halt:number|null=null
  const spans:Array<{from:number;to:number;kind:'drawdown'}>=[]
  const events=[...run.cash.map(p=>({at:p.t,sequence:-1,cash:BigInt(p.cashWei),control:null as ScenarioControl|null})),
    ...controls.map(c=>({at:c.at,sequence:c.sequence,cash:null as bigint|null,control:c}))].sort((a,b)=>a.at-b.at||Number(a.cash===null)-Number(b.cash===null)||a.sequence-b.sequence)
  for(const event of events){
    if(event.at>through)break
    if(event.cash!==null){cash=event.cash;const value=cash-base;peak=peak>value?peak:value;if(halt===null&&peak-value>=limit)halt=event.at}
    const c=event.control
    if(c?.kind==='control'){
      if(c.config)limit=BigInt(c.config.maxDrawdownWei)
      if(c.resetDrawdown){if(halt!==null)spans.push({from:halt,to:c.at,kind:'drawdown'});halt=null;base=cash;peak=0n}
    }
  }
  if(halt!==null)spans.push({from:halt,to:through,kind:'drawdown'})
  return spans
}
