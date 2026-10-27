import type { OperatorState } from './operator-state.js'
import { balanceStaleMs, priceStaleMs } from './levels.js'
export type DashboardNotice = { card: 'trading'|'market'|'wallet'; id: string; message: string; severity: 'warn'|'crit' }
export function dashboardBanner(input: {
  alerts:Array<{id:string;sev:'warn'|'crit';msg:string}>; notices:DashboardNotice[]
  haltKinds:readonly string[]; unresolvedExits:number
}) {
  const items=new Map<string,{id:string;message:string;severity:'warn'|'crit'}>()
  for(const a of input.alerts){
    if(a.id==='edge-probe')continue
    if(a.id==='halted'&&input.haltKinds.length===1&&input.haltKinds[0]==='stopped')continue
    if(a.id==='exit'&&input.unresolvedExits===0)continue
    if(a.id==='stranded')continue // Historical bookkeeping closes are not current holdings.
    items.set(a.id,{id:a.id,message:a.msg,severity:a.sev})
  }
  for(const n of input.notices)items.set(n.id,{id:n.id,message:n.message,severity:n.severity})
  return [...items.values()].sort((a,b)=>Number(b.severity==='crit')-Number(a.severity==='crit'))
}
/** Dashboard presentation only. Raw alerts remain available to the operational monitors. */
export function dashboardNotices(input: {
  alerts: Array<{id:string;sev:'warn'|'crit';msg:string}>; operator: OperatorState|null
  now:number; balanceAt:number|null; priceAgeMs:number|null; priceSource:string
}): DashboardNotice[] {
  const notices:DashboardNotice[]=[]
  const currentTrading=new Set(['feed','logs','logstale','config','config-restart','stuck','parked','model','bookdrift','graduation','disk','memory'])
  for(const a of input.alerts){
    if(currentTrading.has(a.id))notices.push({card:'trading',id:a.id,message:a.msg,severity:a.sev})
  }
  const touch=input.operator?.guards.find(g=>g.id==='gate')
  if(touch?.blocking)notices.push({card:'market',id:'touch-stop',message:'Touch-rate safety check is blocking entries. '+touch.detail,severity:'crit'})
  if(input.balanceAt===null||input.now-input.balanceAt>balanceStaleMs)
    notices.push({card:'wallet',id:'balance-stale',message:input.balanceAt===null?'No wallet balance recorded.':'Wallet balance is stale. Last received values are shown.',severity:'warn'})
  if(input.priceAgeMs===null||input.priceAgeMs>priceStaleMs||input.priceSource==='config')
    notices.push({card:'wallet',id:'price-stale',message:'Dollar amounts use a stale or fallback ETH price.',severity:'warn'})
  return notices
}
