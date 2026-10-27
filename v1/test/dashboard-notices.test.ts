import { describe, expect, it } from 'vitest'
import { dashboardNotices } from '../src/telemetry/dashboard-notices.js'
const base={operator:null,now:1000,balanceAt:900,priceAgeMs:100,priceSource:'coinbase'}
describe('dashboard notices',()=>{
  it('does not promote intentional stops or retrospective warnings to current faults',()=>{
    const alerts=['halted','exit','edge-probe','edge-buy-revert','stranded','quota','nonce'].map(id=>({id,sev:'crit' as const,msg:id}))
    expect(dashboardNotices({...base,alerts})).toEqual([])
    expect(alerts).toHaveLength(7)
  })
  it('keeps current execution and connection faults in Trading',()=>{
    const alerts=['feed','logs','config','stuck','parked','model'].map(id=>({id,sev:'crit' as const,msg:id}))
    expect(dashboardNotices({...base,alerts}).map(n=>[n.card,n.id])).toEqual(alerts.map(a=>['trading',a.id]))
  })
  it('reports missing wallet evidence without turning it into zero',()=>{
    expect(dashboardNotices({...base,alerts:[],balanceAt:null,priceAgeMs:null})).toMatchObject([{card:'wallet',id:'balance-stale'},{card:'wallet',id:'price-stale'}])
  })
})

describe('restored action banner',()=>{
  it('keeps useful warnings and deduplicates current faults without reviving operator-stop or probe noise',async()=>{
    const {dashboardBanner}=await import('../src/telemetry/dashboard-notices.js')
    const alerts=['halted','exit','edge-probe','quota','edge-buy-revert','feed'].map(id=>({id,sev:'warn' as const,msg:id}))
    const banner=dashboardBanner({alerts,notices:[{card:'trading',id:'feed',severity:'crit',message:'Feed disconnected'}],haltKinds:['stopped'],unresolvedExits:0})
    expect(banner.map(a=>a.id)).toEqual(['feed','quota','edge-buy-revert'])
    expect(banner[0]!.message).toBe('Feed disconnected')
  })
  it('retains a real stop and unresolved exits',async()=>{
    const {dashboardBanner}=await import('../src/telemetry/dashboard-notices.js')
    const alerts=['halted','exit'].map(id=>({id,sev:'crit' as const,msg:id}))
    expect(dashboardBanner({alerts,notices:[],haltKinds:['drawdown','stopped'],unresolvedExits:1})).toHaveLength(2)
  })
})
