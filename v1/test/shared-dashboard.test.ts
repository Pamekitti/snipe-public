import {it,expect} from 'vitest'
import {scenarioComparison,scenarioOutcomeBuckets} from '../src/telemetry/dashboard-paper.js'
import {Telemetry} from '../src/telemetry/db.js'
import {SELECTED_GUARD} from '../src/strategy/scenario-guard.js'
import {drawdownHistory} from '../src/simulation/drawdown-history.js'
const observer=():any=>({at:100,recordFrom:1,comparableThrough:100,complete:true,modelHash:'test',configId:'a',policy:SELECTED_GUARD,decisions:[{at:1,state:'shut'},{at:15,state:'open'}],
  outcomes:[{token:'a',available:30,value:.5,configId:'a'}],
  accounts:[{id:'p50-after',drawdownHalts:[{from:40,to:50,kind:'drawdown'}],policy:{complete:true,cash:[{at:20,pnlWei:'20000000000000000'},{at:40,pnlWei:'-10000000000000000'}]},marketOff:{complete:true,cash:[{at:10,pnlWei:'40000000000000000'},{at:30,pnlWei:'-20000000000000000'}]}}]})
it('computes cumulative monetary retention with a fixed reference and unavailable zero denominators',()=>{
  const result=scenarioComparison(observer(),1,100)
  expect(result.points[0]).toMatchObject({winRetained:null,lossRetained:null})
  expect(result.points.at(-1)).toMatchObject({cash:.01,reference:.02,drawdown:.01,winRetained:50,lossRetained:50})
  expect(result.halts.some(h=>h.kind==='drawdown')).toBe(true)
  const partial=observer();partial.complete=false;partial.firstPending=45;partial.comparableThrough=45
  expect(scenarioComparison(partial,1,100).points.at(-1)?.cash).toBeNull()
  expect(scenarioComparison(partial,1,100).points.find(p=>p.t===40)?.cash).toBe(.01)
})
it('does not publish future outcomes into the bars',()=>{
  const db=new Telemetry(':memory:').raw()
  try{
    db.prepare('INSERT INTO launches(token,detected_at,passed) VALUES (?,?,?)').run('a',5,1)
    expect(scenarioOutcomeBuckets(db,observer(),1,29,100).buckets[0]).toMatchObject({win:0,net:null})
    expect(scenarioOutcomeBuckets(db,observer(),1,30,100).buckets[0]).toMatchObject({win:1,net:.5,configs:['a']})
  }finally{db.close()}
})
it('drawdown shading retains losses across recorded accounting resets',()=>{
  const config:any={maxDrawdownWei:'10'}
  const run:any={cash:[{t:2,cashWei:'20'},{t:3,cashWei:'10'},{t:5,cashWei:'-1'}]}
  const controls:any=[{kind:'control',at:4,sequence:0,resetDrawdown:true}]
  expect(drawdownHistory(run,config,controls,6)).toEqual([{from:3,to:4,kind:'drawdown'},{from:5,to:6,kind:'drawdown'}])
})

it('settles cash before a simultaneous drawdown reset regardless of control sequence',()=>{
  const run:any={cash:[{t:2,cashWei:'20'},{t:3,cashWei:'10'},{t:4,cashWei:'0'}]}
  const controls:any=[{kind:'control',at:3,sequence:-3,resetDrawdown:true}]
  expect(drawdownHistory(run,{maxDrawdownWei:'10'} as any,controls,5)).toEqual([{from:3,to:3,kind:'drawdown'},{from:4,to:5,kind:'drawdown'}])
})
