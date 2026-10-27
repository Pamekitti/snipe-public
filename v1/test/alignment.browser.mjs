/** Read-only browser regression for the four history charts. */
import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
// Same CommonJS-vs-ESM problem dashboard.browser.mjs documents: a laptop `npm i playwright`
// resolves to CJS, whose `chromium` hangs off the default export. Without this the suite
// throws on launch before it asserts anything, which is how it sat broken unnoticed.
const pw=await import(process.env.PLAYWRIGHT_MODULE||'playwright')
const chromium=pw.chromium??pw.default?.chromium
const url=process.argv[2]||'http://127.0.0.1:8799'
const state=await (await fetch(url+'/api/state')).json()
assert.equal(state.preview,true,'Use the local read-only preview')
const base=await (await fetch(url+'/api/chart?h=4h')).json()
const browser=await chromium.launch({channel:'chrome',headless:true})
const page=await browser.newPage({viewport:{width:1440,height:1100}})
const errors=[];page.on('pageerror',e=>errors.push(e.message))
const out=new URL('../../docs/dashboard-preview/simple-history/',import.meta.url).pathname
await mkdir(out,{recursive:true})
let fixture=null
await page.addInitScript(()=>localStorage.setItem('snipe.hidden','filtered,win,loss,pending'))
await page.route('**/api/chart?*',r=>fixture?r.fulfill({json:fixture}):r.continue())
await page.route('**/api/control',()=>{throw new Error('Browser QA must not send controls')})
const ready=async()=>{
 await page.goto(url)
 await page.waitForFunction(()=>window.eval('charts') && Object.keys(window.eval('charts')).length===4 && window.eval('chartData'))
 // Wait on #mainPlotValue, not #mainPlotTitle. The title was a live string when this was
 // written and is now the static literal 'Market Indicator', present in the HTML skeleton
 // before render() has run at all, so asserting on it stopped being a readiness signal and
 // started being a guaranteed timeout. #mainPlotValue ships empty and only render() fills
 // it, in all three of its branches, so a non-empty value means the page has painted.
 await page.waitForFunction(()=>document.querySelector('#mainPlotValue').textContent.trim().length>0)
}
const graphics=()=>page.evaluate(()=>{
 const cs=window.eval('charts')
 const colorCount=(chart,rgb)=>{
  const b=chart.bbox,data=chart.ctx.getImageData(b.left,b.top,b.width,b.height).data
  let n=0;for(let i=0;i<data.length;i+=4)if(data[i+3]&&rgb.every((v,j)=>Math.abs(data[i+j]-v)<12))n++
  return n
 }
 return {paper:colorCount(cs.paper,[102,190,165])+colorCount(cs.paper,[237,140,130]),
  bars:colorCount(cs.volume,[102,190,165])+colorCount(cs.volume,[237,140,130])+colorCount(cs.volume,[160,169,182])+colorCount(cs.volume,[58,66,77]),
  market:colorCount(cs.venue,[142,175,240]),pause:colorCount(cs.venue,[237,140,130]),resume:colorCount(cs.venue,[102,190,165]),
  axes:Object.values(cs).map(c=>({min:c.scales.x.min,max:c.scales.x.max,width:c.bbox.width}))}
})
try{
 await ready()
 assert.equal(await page.locator('#paperAccount,#paneRecovery').count(),0)
 assert.equal(await page.locator('#technical').getAttribute('open'),null)
 assert.equal(await page.locator('#paperDiagnostics').isVisible(),false)
 assert.match(await page.locator('#paperValue').textContent(),/ETH · estimated/)
 assert.match(await page.locator('#paperNote').textContent(),/Incomplete history; accuracy not verified/)
 assert.equal(await page.locator('[data-seg="filtered"]').getAttribute('aria-pressed'),'false','Passed coins remain the default view')
 let g=await graphics();for(const k of ['paper','bars','market','pause','resume'])assert(g[k]>10,k+' has no visible pixels')
 assert.equal(new Set(g.axes.map(a=>a.width)).size,1)
 assert.equal(new Set(g.axes.map(a=>a.min)).size,1)
 assert.equal(new Set(g.axes.map(a=>a.max)).size,1)
 assert.equal(await page.evaluate(()=>window.eval('charts.venue.data[2]').every(x=>x===null)),true,'Legacy mode has only one market line')
 for(const range of ['1h','12h','24h','3d','7d','4h']){
  await page.locator('[data-h="'+range+'"]').click()
  await page.waitForFunction(r=>document.querySelector('#panes').dataset.lookback===r,range)
  g=await graphics();assert(g.bars>10,range+' loses counts');assert(g.paper>10,range+' loses paper')
 }
 const camera=await page.evaluate(()=>{
  const c=window.eval('charts'),d=window.eval('chartData'),min=(d.to-3600000)/1000,max=(d.to-1800000)/1000
  c.wallet.setScale('x',{min,max});return{min,max}
 })
 await page.evaluate(()=>window.eval('tickChart()'))
 for(const a of (await graphics()).axes){assert.equal(a.min,camera.min);assert.equal(a.max,camera.max)}
 await page.locator('#zoomchip').click()
 await page.locator('#panes').screenshot({path:out+'desktop.png'})
 for(const width of [375,414]){
  await page.setViewportSize({width,height:900});await page.waitForTimeout(200)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  g=await graphics();assert(g.paper>10);assert(g.bars>10);assert(g.market>10)
  await page.locator('#panes').screenshot({path:out+'phone-'+width+'.png'})
 }
 // Results unavailable: visible coin counts, no zero profit, and a useful empty state.
 fixture={...structuredClone(base),paper:{...base.paper,points:[],recordedPnlEth:null,monthToDate:null,n:0},
  outcomes:{buckets:base.outcomes.buckets.map(b=>({...b,win:0,loss:0,flat:0,pending:0,notSimulated:b.passed,net:null}))}}
 await ready()
 assert.equal(await page.locator('#paperEmpty').isVisible(),true)
 assert.equal(await page.locator('#panePaper').isVisible(),false)
 assert((await graphics()).bars>10)
 assert((await graphics()).bars>10,'Passed coins remain visible when rejects are hidden')
 await page.locator('[data-seg="filtered"]').click()
 assert((await graphics()).bars>10,'Showing rejected coins keeps counts visible')
 await page.locator('#panes').screenshot({path:out+'phone-missing-paper.png'})
 await page.locator('#technical summary').click();assert.equal(await page.locator('#paperDiagnostics').isVisible(),true)
 // A gap stays a gap. A stale collector retains its recorded line and shows the problem.
 fixture=structuredClone(base)
 fixture.paper.points=[{t:base.from,eth:0},{t:base.from+10000,eth:.01},{t:base.from+20000,eth:null},{t:base.to-10000,eth:.02},{t:base.to,eth:.03}]
 fixture.paper.health={stalled:true,fault:'collection disconnected',missing:1};fixture.paper.pending=3
 await ready();assert.match(await page.locator('#paperNote').textContent(),/Collection needs attention/)
 assert.equal(await page.evaluate(()=>window.eval('charts.paper.series[1].spanGaps')),false)
 assert.equal(await page.evaluate(()=>window.eval('charts.paper.data[1].includes(null)')),true)
 // If the live guard later uses a different recovery window, both readings share one pane.
 fixture.marketSource='adaptive-shadow';fixture.market=base.market.map(p=>({...p,recentSum:p.sum==null?null:p.sum+.3}))
 await ready();assert.equal(await page.evaluate(()=>window.eval('charts.venue.data[2]').some(x=>x!==null)),true)
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({passed:true,checks:['four charts','real-data paper and bar pixels','two thresholds','375px and 414px','all six ranges','zoom survives refresh','old legend migration','missing paper keeps counts','hidden rejects keep passes','collapsed details','null gaps','stale collector','adaptive recovery in one pane'],screenshots:out}))
}finally{await browser.close()}
