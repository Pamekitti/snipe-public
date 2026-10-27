import { afterEach, describe, expect, it } from 'vitest'
import { Telemetry } from '../src/telemetry/db.js'
import { binWidth, marketHistory, paperReconstructed, reconstructMarketHistory, scoreObservations, spliceReconstructed, thinSamples } from '../src/telemetry/market-history.js'
import type { MarketSample } from '../src/telemetry/market-history.js'
import Database from 'better-sqlite3'
const handles:Database.Database[]=[]
afterEach(()=>handles.splice(0).forEach(db=>db.close()))
function fixture(){const db=new Telemetry(':memory:').raw();handles.push(db);const statement=db.prepare('INSERT INTO guard_samples (at,live,market,market_fresh,market_n,market_off,market_on,execution,execution_limit,drawdown,drawdown_limit,halts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');return {db,sample:(at:number,sum:number|null=1,fresh=1,off=-1,on=1,halts='[]',live=1)=>statement.run(at,live,sum,fresh,20,off,on,null,null,0.01,0.06,halts)}}
describe('recorded market history',()=>{
  it('preserves sparse history without moving the selected period or inventing earlier evidence',()=>{
    const {db,sample}=fixture();sample(90000,0.2);sample(105000,-0.1)
    const data=marketHistory(db,0,120000)
    expect(data.coverage).toMatchObject({from:90000,to:105000,recorded:2,fresh:2})
    expect(data.coverage.gaps).toEqual([{from:0,to:90000}])
    expect(data.samples.map(s=>s.t)).toEqual([90000,105000])
  })
  it('preserves missing readings, unknown periods and both sides of changed thresholds',()=>{
    const {db,sample}=fixture();sample(0,1);sample(15000,null,0);sample(30000,2,1,-2,3);sample(120000,4,1,-2,3)
    const data=marketHistory(db,0,150000)
    expect(data.samples.find(s=>s.t===15000)!.sum).toBeNull()
    expect(data.samples.find(s=>s.t===30000)).toMatchObject({sum:2,pauseBelow:-2,resumeAbove:3})
    expect(data.samples.find(s=>s.t===30001)).toMatchObject({sum:null,pauseBelow:null,resumeAbove:null})
    expect(data.coverage.gaps).toContainEqual({from:30000,to:120000})
  })
  it('retains first, last and extremes in a downsampled continuous run',()=>{
    const {db,sample}=fixture();for(let i=0;i<100;i++)sample(i*15000,i===31?-10:i===32?12:0)
    const data=marketHistory(db,0,7*86400000)
    expect(data.samples.length).toBeLessThan(100)
    expect(data.samples.map(s=>s.sum)).toEqual(expect.arrayContaining([-10,12,0]))
    expect(data.samples[0]!.t).toBe(0);expect(data.samples.filter(p=>p.fresh).at(-1)!.t).toBe(99*15000)
    expect(data.samples.at(-1)).toMatchObject({sum:null,fresh:false})
  })
  it('draws only sampled stop states and never extends them across a recording gap',()=>{
    const {db,sample}=fixture();sample(0,-9,1,-1,1,'[]');sample(15000,2,1,-1,1,'["stopped","venue"]');sample(30000,3,1,-1,1,'["venue","stopped"]');sample(45000,4,1,-1,1,'[]');sample(120000,5,1,-1,1,'["drawdown"]')
    const data=marketHistory(db,0,180000)
    expect(data.halts).toEqual([{from:15000,to:45000,kinds:['stopped','venue']},{from:120000,to:120000,kinds:['drawdown']}])
    // A negative market reading alone is not evidence of an actual halt.
    expect(data.states[0]).toEqual({from:0,to:15000,kinds:[]})
    expect(data.coverage.gaps).not.toContainEqual({from:0,to:15000})
  })
  it('excludes simulations and out-of-range samples, while keeping zero distinct from missing',()=>{
    const {db,sample}=fixture();sample(-1000);sample(1000,0);sample(2000,9,1,-1,1,'[]',0);sample(4000)
    expect(marketHistory(db,0,3000).samples).toMatchObject([{t:1000,sum:0,fresh:true}])
  })
  it('uses the same recorded return for legacy recovery but does not infer adaptive recovery',()=>{
    const {db,sample}=fixture();sample(1000,2,1,-1,2);sample(2000,3,1,-1,null as any)
    const out=marketHistory(db,0,3000).samples
    expect(out.find(p=>p.t===1000)).toMatchObject({sum:2,recentSum:2})
    expect(out.find(p=>p.t===2000)).toMatchObject({sum:3,recentSum:null})
  })

  it('returns explicit absence when an older database has no guard table',()=>{
    const db=new Database(':memory:');handles.push(db)
    expect(marketHistory(db,0,1000)).toMatchObject({samples:[],states:[],halts:[],coverage:{from:null,to:null,recorded:0,gaps:[{from:0,to:1000}]}})
  })
})

describe('reconstructed market history',()=>{
  const row=(block:number,launchedAt:number,value:number|string)=>({token:'0x'+block.toString(16).padStart(40,'0'),block,launchedAt,bars:typeof value==='string'?value:JSON.stringify({'1.75':value})})

  it('rebuilds the rolling return under the live freshness rule',()=>{
    const data=reconstructMarketHistory([
      row(1,1,0.5),row(2,2,-0.25),row(3,3,1),
    ],0,8_000,{window:2,freshMs:4_000,bar:'1.75',pauseBelow:-1,resumeAbove:1})
    expect(data.find(point=>point.t===2_000)).toMatchObject({sum:0.25,n:2,fresh:true,source:'reconstructed'})
    expect(data.find(point=>point.t===3_000)).toMatchObject({sum:0.75,n:2,fresh:true})
    expect(data.at(-1)).toMatchObject({t:6_001,sum:null,fresh:false})
  })

  it('inserts freshness expiry before outcomes resume after a quiet interval',()=>{
    const data=reconstructMarketHistory([row(1,1,1),row(2,2,1),row(3,10,1),row(4,11,1)],0,12000,
      {window:2,freshMs:4000,bar:'1.75',pauseBelow:-1,resumeAbove:1})
    expect(data.find(p=>p.t===5001)).toMatchObject({sum:null,fresh:false})
    expect(data.find(p=>p.t===11000)).toMatchObject({sum:2,fresh:true})
  })

  it('matches the live two-window overfetch when rows are missing the selected bar',()=>{
    const data=reconstructMarketHistory([
      row(1,1,1),row(2,2,1),row(3,3,1),row(4,4,'{}'),row(5,5,'{}'),row(6,6,'{}'),
    ],0,6_000,{window:2,freshMs:10_000,bar:'1.75',pauseBelow:-1,resumeAbove:1})
    expect(data.at(-1)).toMatchObject({t:6_000,sum:null,n:1,fresh:false})
  })

  it('hands the seam to direct samples and preserves later recorded gaps',()=>{
    const {db,sample}=fixture();sample(5_000,2);sample(80_000,3)
    const recorded=marketHistory(db,0,90_000)
    const reconstructed=reconstructMarketHistory([
      row(1,1,0.5),row(2,2,0.5),row(3,3,0.5),row(4,4,0.5),
    ],0,5_000,{window:2,freshMs:10_000,bar:'1.75',pauseBelow:-1,resumeAbove:1})
    // One splice path now fills the head as well as every interior gap.
    const merged=spliceReconstructed(recorded.samples,reconstructed)
    expect(merged.samples.filter(point=>point.source==='reconstructed').every(point=>point.t<5_000)).toBe(true)
    expect(merged.samples.find(point=>point.t===5_000)?.source).toBe('recorded')
    expect(merged.samples.some(point=>point.t===5_001&&point.sum===null)).toBe(true)
    expect(merged.points).toBe(3)
  })
})

describe('backfill for the adaptive policy',()=>{
  const bars=(o:Record<string,number>)=>JSON.stringify(o)
  const obs=(block:number,launchedAt:number,json:string)=>({token:'0x'+block.toString(16).padStart(40,'0'),block,launchedAt,bars:json})

  it('carries the recovery window as recentSum and blanks it with the main reading',()=>{
    const rows=[1,2,3,4].map(i=>obs(i,i,bars({'1.75':i===4?-2:1})))
    const data=reconstructMarketHistory(rows,0,10_000,
      {window:3,recoveryWindow:2,freshMs:10_000,bar:'1.75',pauseBelow:-1,resumeAbove:1})
    // three valid rows in the main window, the latest two in the recovery window
    expect(data.find(p=>p.t===3_000)).toMatchObject({sum:3,recentSum:2,n:3,fresh:true})
    expect(data.find(p=>p.t===4_000)).toMatchObject({sum:0,recentSum:-1,fresh:true})
    expect(data.every(p=>p.recentSum===null||p.sum!==null)).toBe(true)
  })

  it('holds the reading back until the recovery window is also full',()=>{
    const rows=[1,2].map(i=>obs(i,i,bars({'1.75':1})))
    const data=reconstructMarketHistory(rows,0,5_000,
      {window:2,recoveryWindow:4,freshMs:10_000,bar:'1.75',pauseBelow:-1,resumeAbove:1})
    expect(data).toEqual([])
  })

  it('scores each launch at the rung the launches before it earned most on',()=>{
    // the first three teach the chooser that 3.00 pays; the fourth is then scored there
    const cold=bars({'1.25':0.1,'3.00':2})
    const rows=[obs(1,1,cold),obs(2,2,cold),obs(3,3,cold),obs(4,4,bars({'1.25':0.1,'3.00':-5}))]
    const chooser=(preceding:readonly Record<string,number>[])=>
      preceding.length>=3?'3.00':'1.25'
    const scored=scoreObservations(rows,chooser)
    expect(scored.map(r=>r.bar)).toEqual(['1.25','1.25','1.25','3.00'])
    expect(scored.map(r=>r.value)).toEqual([0.1,0.1,0.1,-5])
  })

  it('never lets a launch choose the rung it is then scored at',()=>{
    const seen:number[]=[]
    scoreObservations([obs(1,1,bars({'1.75':1})),obs(2,2,bars({'1.75':1}))],preceding=>{seen.push(preceding.length);return '1.75'})
    expect(seen).toEqual([0,1])
  })
})

describe('splicing the rebuild into the observer blanks',()=>{
  const pt=(t:number,sum:number|null,source:MarketSample['source']='recorded'):MarketSample=>
    ({t,sum,recentSum:sum,pauseBelow:-1,resumeAbove:1,n:20,fresh:sum!==null,source})

  it('fills a blank in the middle of a recorded run and keeps the readings on both sides',()=>{
    // the observer read, went blank for three samples, then came back
    const recorded=[pt(1000,1),pt(2000,null),pt(3000,null),pt(4000,null),pt(5000,2)]
    const rebuilt=[pt(2500,9,'reconstructed'),pt(3500,9,'reconstructed')]
    const out=spliceReconstructed(recorded,rebuilt)
    expect(out.points).toBe(3)
    expect(out.samples.filter(p=>p.t>=2500&&p.t<=3500).every(p=>p.sum===9)).toBe(true)
    expect(out.samples.find(p=>p.t===3501)?.sum).toBeNull()
    // the recorded readings are untouched and still recorded
    expect(out.samples.find(p=>p.t===1000)).toMatchObject({sum:1,source:'recorded'})
    expect(out.samples.find(p=>p.t===5000)).toMatchObject({sum:2,source:'recorded'})
    expect(out.spans).toEqual([{from:2500,to:3501}])
  })

  it('never interleaves the wider population into a healthy run',()=>{
    const recorded=[pt(1000,1),pt(2000,2),pt(3000,3)]
    const rebuilt=[pt(1500,9,'reconstructed'),pt(2500,9,'reconstructed')]
    const out=spliceReconstructed(recorded,rebuilt)
    expect(out.points).toBe(0)
    expect(out.samples.every(p=>p.source==='recorded')).toBe(true)
  })

  it('lets a recorded reading win at the same instant',()=>{
    const out=spliceReconstructed([pt(1000,1)],[pt(1000,9,'reconstructed')])
    expect(out.samples).toMatchObject([pt(1000,1)])
    expect(out.points).toBe(0)
  })

  it('fills the head before the observer existed, and a tail it never covered',()=>{
    const recorded=[pt(5000,1),pt(6000,null)]
    const rebuilt=[pt(1000,9,'reconstructed'),pt(2000,9,'reconstructed'),pt(9000,9,'reconstructed')]
    const out=spliceReconstructed(recorded,rebuilt)
    expect(out.samples.map(p=>p.t)).toEqual([1000,2000,5000,6000,9000])
    // two separate stretches, not one span running through the recorded reading
    expect(out.spans).toEqual([{from:1000,to:5000},{from:6000,to:9000}])
  })

  it('fills everything when the observer never recorded a reading at all',()=>{
    const out=spliceReconstructed([pt(1000,null),pt(2000,null)],[pt(1500,5,'reconstructed')])
    expect(out.points).toBe(1)
    expect(out.samples.map(p=>p.t)).toEqual([1000,1500,1501,2000])
  })

  it('fills recovery independently without replacing the recorded market value',()=>{
    const recorded=[{...pt(1000,2),recentSum:null},{...pt(2000,3),recentSum:null}]
    const rebuilt=[pt(1000,8,'reconstructed'),pt(2000,9,'reconstructed')]
    const out=spliceReconstructed(recorded,rebuilt)
    expect(out.samples).toMatchObject([
      {t:1000,sum:2,recentSum:8,sumSource:'recorded',recentSource:'reconstructed'},
      {t:2000,sum:3,recentSum:9,sumSource:'recorded',recentSource:'reconstructed'},
    ])
  })

  it('ends a rebuilt interval at expiry and resumes after a real evidence gap',()=>{
    const out=spliceReconstructed([pt(1500,null),pt(2500,null)],
      [pt(1000,8,'reconstructed'),pt(2000,null,'reconstructed'),pt(3000,9,'reconstructed')])
    expect(out.samples.find(p=>p.t===1500)?.sum).toBe(8)
    expect(out.samples.find(p=>p.t===1999)?.sum).toBe(8)
    expect(out.samples.filter(p=>p.t>=2000&&p.t<3000).every(p=>p.sum===null)).toBe(true)
    expect(out.samples.at(-1)?.sum).toBe(9)
    expect(out.spans).toEqual([{from:1000,to:2000},{from:3000,to:3000}])
  })

  it('ignores rebuilt points that carry no reading of their own',()=>{
    const out=spliceReconstructed([pt(1000,null)],[pt(1500,null,'reconstructed')])
    expect(out).toMatchObject({points:0,spans:[]})
  })
})

describe('thinning a rebuilt run to the pane',()=>{
  const pt=(t:number,sum:number|null):MarketSample=>
    ({t,sum,recentSum:sum,pauseBelow:-1,resumeAbove:1,n:20,fresh:sum!==null,source:'reconstructed'})

  it('keeps the first, last and both extremes of a run', ()=>{
    // one observation every 10s for a week is 60k points; the pane resolves about 600
    const run=Array.from({length:100},(_,i)=>pt(i*10_000,i===31?-10:i===32?12:0))
    const out=thinSamples(run,binWidth(0,7*86400000))
    expect(out.length).toBeLessThan(100)
    expect(out.map(p=>p.sum)).toEqual(expect.arrayContaining([-10,12,0]))
    expect(out[0]!.t).toBe(0);expect(out.at(-1)!.t).toBe(99*10_000)
  })

  it('never merges a stale marker into the readings around it',()=>{
    const out=thinSamples([pt(0,1),pt(1000,1),pt(2000,null),pt(3000,1),pt(4000,1)],15_000)
    expect(out.map(p=>p.sum)).toContain(null)
    expect(out.find(p=>p.sum===null)!.t).toBe(2000)
  })

  it('preserves recovery extremes even when the market value is constant',()=>{
    const run=Array.from({length:10},(_,i)=>({...pt(i*1000,1),recentSum:i===3?-8:i===6?9:0}))
    expect(thinSamples(run,15000).map(p=>p.recentSum)).toEqual(expect.arrayContaining([-8,9]))
  })

  it('leaves a run shorter than three points exactly as it is',()=>{
    expect(thinSamples([pt(0,1),pt(1,2)],15_000).map(p=>p.t)).toEqual([0,1])
  })
})

describe('the paper wallet rebuilt from venue observations',()=>{
  const bars=(v:number)=>JSON.stringify({'1.75':v})
  const coin=(i:number,launchedAt:number,v:number,tax=100,dev='1',ex=5)=>
    ({token:'0x'+i.toString(16).padStart(40,'0'),block:i,launchedAt,bars:bars(v),
      creatorTaxBps:tax,devBuyWei:dev,exemptions:ex})
  const opts=(o:Partial<Parameters<typeof paperReconstructed>[1]>={})=>({
    tradeSizeEth:0.02,bankrollEth:0.08,maxConcurrent:14,templateLossBlockMs:3_600_000,
    entryLagMs:2_600,holdMs:45_000,gasEth:0,scale:1,...o,
  })

  it('books a stake times the rung return at close time, not at launch',()=>{
    const out=paperReconstructed(scoreObservations([coin(1,1_000,0.5)],'1.75'),opts())
    expect(out).toHaveLength(1)
    expect(out[0]!.t).toBe(1_000_000+2_600+45_000)
    expect(out[0]!.eth).toBeCloseTo(0.01,12)
  })

  it('charges gas, so a flat coin is a small loss rather than nothing',()=>{
    const out=paperReconstructed(scoreObservations([coin(1,1_000,0)],'1.75'),opts({gasEth:0.00004}))
    expect(out[0]!.eth).toBeCloseTo(-0.00004,12)
  })

  it('blocks a template for an hour after a loss on it, then lets it back',()=>{
    const rows=[coin(1,1_000,-0.5),coin(2,1_100,0.5),coin(3,1_000+3_700,0.5)]
    const out=paperReconstructed(scoreObservations(rows,'1.75'),opts())
    // the loser books; the coin 100s later on the same template does not; the one past the
    // hour does. Two cash events, not three.
    expect(out).toHaveLength(2)
    expect(out.map(r=>r.token)).toEqual([rows[0]!.token,rows[2]!.token])
  })

  it('does not block a DIFFERENT template after a loss',()=>{
    const rows=[coin(1,1_000,-0.5),coin(2,1_100,0.5,200)]
    expect(paperReconstructed(scoreObservations(rows,'1.75'),opts())).toHaveLength(2)
  })

  it('refuses past the concurrency ceiling and lets the slot back when one settles',()=>{
    // three coins one second apart, room for two at a time
    const rows=[coin(1,1_000,0.5),coin(2,1_001,0.5,200),coin(3,1_002,0.5,300)]
    expect(paperReconstructed(scoreObservations(rows,'1.75'),opts({maxConcurrent:2}))).toHaveLength(2)
    // the fourth launches after the first has closed, so it fits
    const later=[...rows,coin(4,1_100,0.5,400)]
    expect(paperReconstructed(scoreObservations(later,'1.75'),opts({maxConcurrent:2}))).toHaveLength(3)
  })

  it('refuses past the bankroll even when concurrency allows',()=>{
    const rows=[coin(1,1_000,0.5),coin(2,1_001,0.5,200),coin(3,1_002,0.5,300)]
    expect(paperReconstructed(scoreObservations(rows,'1.75'),
      opts({maxConcurrent:14,bankrollEth:0.04}))).toHaveLength(2)
  })

  it('scales every event by the measured calibration',()=>{
    const rows=[coin(1,1_000,0.5)]
    const full=paperReconstructed(scoreObservations(rows,'1.75'),opts())
    const half=paperReconstructed(scoreObservations(rows,'1.75'),opts({scale:0.5}))
    expect(half[0]!.eth).toBeCloseTo(full[0]!.eth/2,12)
  })

  it('skips a coin whose bars carry no value at the chosen rung',()=>{
    const row={...coin(1,1_000,0),bars:'{}'}
    expect(paperReconstructed(scoreObservations([row],'1.75'),opts())).toHaveLength(0)
  })
})
