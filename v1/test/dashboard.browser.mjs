/** Laptop-only browser QA. Run against dashboard-preview.ts, never production controls. */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
// A laptop `npm i playwright` resolves to CommonJS, whose `chromium` hangs off the default
// export rather than being a named one. Accept both, or PLAYWRIGHT_MODULE has to point at an
// ESM build and these checks quietly never run.
const pw=await import(process.env.PLAYWRIGHT_MODULE||'playwright')
const chromium=pw.chromium??pw.default?.chromium
const url=process.argv[2]||'http://127.0.0.1:8799'
const captured=await (await fetch(url+'/api/state')).json()
assert.equal(captured.preview,true,'Browser checks require the read-only preview')
const charts=await (await fetch(url+'/api/chart?h=4h')).json()
const browser=await chromium.launch({channel:'chrome',headless:true})
const page=await browser.newPage({viewport:{width:1440,height:1100}})
const errors=[];page.on('pageerror',e=>errors.push(e.message))
const output=new URL('../../docs/dashboard-preview/',import.meta.url).pathname
await mkdir(output,{recursive:true})
let fixture=null,chartFixture=null,failState=false,posted=[],syntheticStopped=true
await page.route('**/api/state',async route=>{
 if(failState)return route.fulfill({status:503,json:{error:'Unavailable fixture'}})
 if(!fixture)return route.continue()
 return route.fulfill({json:{...structuredClone(fixture),at:fixture.at===0?0:Date.now()}})
})
await page.route('**/api/chart?*',async route=>chartFixture?route.fulfill({json:chartFixture}):route.continue())
await page.route('**/api/control',async route=>{
 const action=route.request().postDataJSON().action;posted.push(action);syntheticStopped=action==='stop'
 fixture.risk.haltKinds=syntheticStopped?['stopped']:['venue'];fixture.risk.haltKind=syntheticStopped?'stopped':'venue';fixture.risk.halted=true
 fixture.operator.blockers=syntheticStopped?[{kind:'stopped',reason:'Stopped by you',since:null}]:[{kind:'venue',reason:'Waiting for market recovery',since:null}];fixture.operator.status=syntheticStopped?'needs-you':'paused'
 return route.fulfill({json:{ok:true,why:syntheticStopped?'Stopped':'Automatic operation requested; entries paused: waiting for market recovery'}})
})
const wait=async predicate=>page.waitForFunction(predicate)
const load=async()=>{await page.goto(url);await wait(()=>document.querySelectorAll('.pane canvas').length===4);await wait(()=>document.querySelector('#tradingState').textContent!=='Connecting')}
const colors=async()=>page.evaluate(()=>{
 const wallet=window.eval('chartData').wallet||[]
 const paper=(window.eval('chartData').paper||{}).points||[]
 // Probe a colour each pane actually paints with the DEFAULT legend state. `volume` used to
 // be probed on --rule2, the "filtered out" segment, which the page hides by default and the
 // initScript above hides explicitly, so that assertion could never have passed.
 const targets={wallet:wallet.length>1&&wallet.at(-1).eth>=wallet[0].eth?[102,190,165]:[237,140,130],paper:paper.length&&paper.at(-1).eth<0?[237,140,130]:[102,190,165],venue:[142,175,240],volume:[102,190,165]}
 return Object.entries(targets).map(([key,rgb])=>{
  const chart=window.eval('charts')[key],canvas=chart.ctx.canvas,ctx=canvas.getContext('2d'),b=chart.bbox
  const data=ctx.getImageData(b.left,b.top,b.width,b.height).data;let count=0
  for(let i=0;i<data.length;i+=4)if(data[i+3]>0&&rgb.every((v,j)=>Math.abs(data[i+j]-v)<12))count++
  return {key,count,width:b.width,height:b.height}
 })
})
try{
 await page.addInitScript(()=>{if(localStorage.getItem('snipe.hidden')===null)localStorage.setItem('snipe.hidden','filtered')})
 await load()
 for(const id of ['gateState','vvVenue','feedRate','polState','prState','edState','dlP50','cumTrades',
                  'marketValue','marketVerdict','marketOn','marketInfo','paneFlow','sizeCard','ddPercent','nwRecon'])assert.equal(await page.locator('#'+id).count(),0)
 assert.equal(await page.locator('#kpiBody tr').count(),4)
 await page.locator('#moreMetrics').click();assert.equal(await page.locator('#kpiBody tr').count(),7)
 await page.locator('#moreMetrics').click();assert.equal(await page.locator('#kpiBody tr').count(),4)
 // three rolling columns; the calendar day is the Today card and is not repeated here
 assert.deepEqual(await page.locator('#kpi thead th').allTextContents(),['metric','1h','4h','12h'])
 // the exits table leads with a UTC time, the only clock on the page besides the strip
 assert.equal(await page.locator('#rec thead th').first().textContent(),'Time')
 assert.match(await page.locator('#recBody tr.hd td').first().textContent(),/^\d{2}:\d{2}$/)
 // flat book: the positions card stays out of the way instead of saying "none" twice
 assert.equal(await page.locator('#posCard').isVisible(),false)
 // the market state is stated once, in the strip, with both readings and both thresholds
 const why=await page.locator('#tradingWhy').textContent()
 if((captured.risk.haltKinds||[]).includes('venue')){assert(why.includes('stakes'));assert(why.includes('pause below'))}
 const pnl=captured.recent[0].pnl,price=captured.truth.priceUsd
 assert.equal(await page.locator('#recBody tr.hd .pnl-cell strong').first().textContent(),(pnl<0?'-$':'+$')+Math.abs(pnl*price).toFixed(2))
 assert((await page.locator('#recBody tr.hd .pnl-cell small').first().textContent()).includes('ETH'))
 const graphic=await colors();for(const p of graphic){assert(p.count>10,`${p.key} has no plotted graphics`);assert(p.height>=140)}
 assert.equal(new Set(graphic.map(p=>p.width)).size,1,'All time axes must have the same plotting width')
 assert.equal(await page.locator('#btnStart').isDisabled(),true)
 const camera=await page.evaluate(()=>{const c=window.eval('charts'),d=window.eval('chartData'),min=(d.to-3600000)/1000,max=(d.to-1800000)/1000;c.wallet.setScale('x',{min,max});return{min,max}})
 await page.evaluate(()=>window.eval('tickChart()'))
 const after=await page.evaluate(()=>Object.values(window.eval('charts')).map(c=>({min:c.scales.x.min,max:c.scales.x.max})))
 for(const c of after){assert.equal(c.min,camera.min);assert.equal(c.max,camera.max)}
 await page.locator('#zoomchip').click()
 const historical=await page.evaluate(()=>{const d=window.eval('chartData');window.eval('paintTip')(Math.min(d.from,...d.market.map(p=>p.t))-1);return document.querySelector('#tip').textContent})
 assert(historical.includes('No fresh market signal'));assert(historical.includes('Unknown'))
 await page.mouse.move(0,0)
 await page.locator('#recBody tr.hd').first().press('Enter');assert.equal(await page.locator('#recBody td.det').count(),1)
 await page.locator('#recBody tr.hd').first().press('Enter');assert.equal(await page.locator('#recBody td.det').count(),0)
 // Exercise all ranges; each retains independently plotted wallet and launch graphics.
 for(const range of ['1h','12h','24h','3d','7d','4h']){await page.locator(`[data-h="${range}"]`).click();await page.waitForFunction(r=>document.querySelector('#panes').dataset.lookback===r,range)}
 await load();await page.evaluate(()=>scrollTo(0,0));await page.mouse.click(5,5);
 await page.screenshot({path:output+'redesign-desktop.png',fullPage:true})
 await page.screenshot({path:output+'redesign-desktop-top.png'})
 for(const width of [375,414]){
  await page.setViewportSize({width,height:1000});await page.waitForTimeout(150)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width)
  const tops=await page.locator('#operatingCards>.card').evaluateAll(cs=>cs.map(c=>c.getBoundingClientRect().top))
  assert.equal(new Set(tops).size,3,'the three headline cards stack at phone width')
  await page.mouse.click(5,5);
  await page.screenshot({path:output+`redesign-phone-${width}.png`,fullPage:true})
  await page.screenshot({path:output+`redesign-phone-${width}-top.png`})
 }
 // Missing market evidence never hides the other two panes.
 await page.setViewportSize({width:1440,height:1100})
 chartFixture={...charts,market:[],recordedHalts:[],recordedStates:[],marketCoverage:{from:null,to:null,recorded:0,fresh:0,gaps:[]}}
 await load()
 // missing market evidence never hides the money or the coins
 const missing=await colors();assert(missing.find(p=>p.key==='wallet').count>10);assert(missing.find(p=>p.key==='volume').count>10);assert.equal(missing.find(p=>p.key==='venue').count,0)
 await page.screenshot({path:output+'redesign-no-market.png',fullPage:true})
 chartFixture={...charts,marketSource:'adaptive-shadow',market:[charts.market.at(-1)],marketCoverage:{...charts.marketCoverage,recorded:1,fresh:1}};await load();assert((await colors()).find(p=>p.key==='venue').count===0,'A single reading must not invent a line');
 fixture={...structuredClone(captured),marketPolicy:{...captured.marketPolicy,source:'fixed-bar'}}
 const rebuilt={...charts.market.at(-1),source:'reconstructed'}
 chartFixture={...charts,marketSource:'fixed-bar',market:[rebuilt],marketCoverage:{from:null,to:null,recorded:0,fresh:0,gapAfterMs:45000,gaps:[],reconstructed:1,reconstructedFrom:rebuilt.t,reconstructedTo:rebuilt.t}}
 await load();assert((await colors()).find(p=>p.key==='venue').count===0,'A single reconstructed reading must not invent a line');
 // The backfilled span rides in the SAME series as the recorded one, drawn solid: the line
 // has to be continuous, and the note is what says how much of it was rebuilt.
 // rather than one line that quietly changes which coins it is measuring.
 fixture={...structuredClone(captured)}
 const seam=charts.market.at(-1).t-3_600_000
 const backfilled=charts.market.map((p,i)=>i<charts.market.length/2?{...p,t:p.t-86_400_000,source:'reconstructed'}:{...p,source:'recorded'})
 // marketSource is pinned so the fixture does not depend on which policy the captured box ran
 chartFixture={...charts,marketSource:'adaptive-shadow',market:backfilled,marketRecordedFrom:seam,
   marketRebuilt:{points:backfilled.filter(p=>p.source==='reconstructed').length,spans:[{from:backfilled[0].t,to:seam}]}}
 await load()
 assert.equal(await page.evaluate(()=>charts.venue.series.length),3,'market and optional recent line share one pane')
 assert(await page.evaluate(()=>!charts.venue.series[1].dash),'the line is solid, never dashed')
 // The whole point: a rebuilt stretch followed by a recorded one draws as ONE unbroken run.
 assert.equal(await page.evaluate(()=>charts.venue.data[1].filter(v=>v==null).length),0,'no holes between rebuilt and recorded')
 assert((await page.locator('#chartnote').textContent()).includes('rebuilt from venue observations'),'the page says the span is rebuilt')
 await page.screenshot({path:output+'redesign-backfilled.png',fullPage:true})
 chartFixture={...chartFixture,wallet:[],trades:[],outcomes:{buckets:[],pending:null,unavailable:null}};await load();assert((await page.locator('#chartnote').textContent()).includes('No account samples'))
 chartFixture=null
 // Synthetic state cases use the real page and network path, with controls intercepted above.
 fixture=structuredClone(captured);fixture.bannerAlerts=[{id:'feed',severity:'crit',message:'Feed disconnected <script>bad()</script>'}]
 await load();assert.equal(await page.locator('#bannerHd').textContent(),'ACTION NEEDED');assert((await page.locator('#bannerList').textContent()).includes('<script>'));assert.equal(await page.locator('#banner script').count(),0)
 fixture.bannerAlerts=[];await page.evaluate(()=>window.eval('tick()'));await wait(()=>document.querySelector('#banner').hidden)
 fixture=structuredClone(captured);fixture.preview=false;fixture.operator.blockers=[];fixture.operator.status='enabled';fixture.risk.halted=false;fixture.risk.haltKind=null;fixture.risk.haltKinds=[]
 await load();assert.equal(await page.locator('#tradingState').textContent(),'Auto enabled')
 const market=fixture.operator.guards.find(g=>g.id==='venue');market.reading=-0.5;market.status='pass';market.blocking=false
 await page.evaluate(()=>window.eval('tick()'));await wait(()=>document.querySelector('#mainPlotValue').textContent.includes('-0.50'))
 assert((await page.locator('#marketNote').textContent()).includes('Pause below'),'the plot names its own threshold')
 market.status='unknown';market.reading=0.6;await page.evaluate(()=>window.eval('tick()'));await wait(()=>document.querySelector('#mainPlotValue').textContent==='No fresh signal')
 fixture.at=0;await page.evaluate(()=>window.eval('tick()'));await wait(()=>document.querySelector('#tradingState').textContent==='Status unavailable');assert(await page.locator('#btnStart').isDisabled())
 fixture.at=Date.now();failState=true;await page.evaluate(()=>window.eval('tick()'));await wait(()=>document.querySelector('#sub').textContent.includes('Connection lost'));assert.equal(await page.locator('#btnStop').isDisabled(),false);failState=false
 // Drawdown remains above 100% numerically; the graphic alone is capped.
 fixture=structuredClone(captured);fixture.risk.drawdownEth=0.075;fixture.risk.drawdownLimitEth=0.06;fixture.risk.drawdownUsd=187.5
 fixture.operator.status='needs-you';fixture.operator.blockers=[{kind:'drawdown',reason:'Drawdown limit reached'},{kind:'stopped',reason:'Stopped by you'}]
 fixture.operator.recovery={n:17,required:20,sum:0.4,complete:false,canClear:false,remainingBlockers:['stopped'],budgetResetAt:Date.now()+3600000,note:'Future results determine the wait; no restart time is promised.',checks:[{id:'sample',label:'17 / 20 launches scored',ok:false},{id:'allowance',label:'2 / 2 automatic recoveries used today',ok:false}]}
 await load()
 // above the limit the number still reads over 100%; only the graphic is capped
 assert.equal(await page.locator('#ddProgress').getAttribute('aria-valuetext'),'125.0% used');assert.equal(await page.locator('#ddBar').evaluate(e=>e.style.width),'100%')
 assert.equal(await page.locator('#ddUsed').textContent(),'0.0750 of 0.0600 ETH')
 assert((await page.locator('#tradingWhy').textContent()).includes('Stopped by you'));assert((await page.locator('#tradingWhy').textContent()).includes('allowance exhausted'))
 await page.locator('#recoveryInfo summary').click();assert((await page.locator('#recoveryDetail').textContent()).includes('Other stops still apply: stopped'))
 await page.screenshot({path:output+'redesign-recovery.png',fullPage:true})
 fixture=structuredClone(captured)
 const freshMarket=fixture.operator.guards.find(g=>g.id==='venue')
 Object.assign(freshMarket,{clearAt:null,clearOperator:null,clearText:'New evidence with latest 8 above +1 stake; 20 fresh outcomes required',detail:'Adaptive shadow returns after modeled costs. Latest 8: 1.25 stakes. Prospective verification pending.',n:20,required:20})
 await page.setViewportSize({width:375,height:1000});await load()
 assert.equal(await page.locator('#paneRecovery').count(),0)
 assert((await page.locator('#marketNote').textContent()).includes('allow trading again above'))
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),375)
 await page.screenshot({path:output+'redesign-recovery-phone.png',fullPage:true})
 await page.setViewportSize({width:1440,height:1100})
 fixture=structuredClone(captured);fixture.positions=[{token:'0xopen0000000000',tokenUrl:'#',curveUrl:'#',ageMs:17000,capMs:90000,multiple:1.09,peak:1.2,takeProfit:1.75,estimatedReturnEth:0.00181,markEth:0.0219,spendEth:0.02,supplyLeft:0.61,state:'holding'}]
 fixture.risk.open=1;fixture.truth.openMarkEth=0.0201
 await load()
 assert.equal(await page.locator('#posCard').isVisible(),true)
 assert.equal(await page.locator('#posBody tr').count(),1)
 assert.equal(await page.locator('#openNow').textContent(),'1 / '+captured.risk.maxConcurrent)
 assert.equal(await page.locator('#acctOpenLabel').textContent(),'In 1 open position')
 assert.equal(await page.locator('#acctWallet').isVisible(),true)
 await page.screenshot({path:output+'redesign-open-position.png',fullPage:true})
 fixture=structuredClone(captured);fixture.preview=false;fixture.at=Date.now();fixture.risk.haltKind='stopped';fixture.risk.haltKinds=['stopped'];fixture.risk.halted=true;fixture.operator.blockers=[{kind:'stopped',reason:'Stopped by you'}];fixture.operator.status='needs-you'
 await load();assert.equal(await page.locator('#btnStart').textContent(),'RESUME AUTO');await page.locator('#btnStart').click();assert.equal(posted.length,0);assert.equal(await page.locator('#btnStart').textContent(),'Confirm resume');assert((await page.locator('#ctlMsg').textContent()).includes('recovery rules still apply'));await page.locator('#btnStart').click();await wait(()=>document.querySelector('#tradingState').textContent==='Automatically paused');assert.deepEqual(posted,['start']);assert((await page.locator('#ctlMsg').textContent()).includes('entries paused'));assert(await page.locator('#btnStart').isDisabled());assert.equal(await page.locator('#btnStop').isDisabled(),false)
 await page.locator('#btnStop').click();await wait(()=>document.querySelector('#tradingState').textContent==='Stopped by you');assert.deepEqual(posted,['start','stop'])
 assert.deepEqual(errors,[])
 console.log('PASS: real-data chart pixels across four aligned panes, all periods, zoom/polling, hover and tap, keyboard inspection, phone widths, missing data, stale state, recovery, ETH limits, open positions and intercepted controls')
}finally{await browser.close()}
