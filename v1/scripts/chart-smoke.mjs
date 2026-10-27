#!/usr/bin/env node
/**
 * Headless smoke test for the dashboard chart.
 *
 *   node scripts/chart-smoke.mjs [url]        default http://localhost:8787
 *
 * The chart is canvas, so vitest cannot see it and the DOM-shim harness used for the rest
 * of the page cannot either. This fetches the real served page, runs both script blocks
 * against a shimmed DOM with a RECORDING 2d context, and asserts that every pane actually
 * issued draw calls, that the tooltip renders without artifacts, and that all six
 * lookbacks work.
 *
 * It is not a substitute for looking at the page. It is a substitute for shipping a chart
 * that throws on load, which is what it caught twice on 2026-08-19:
 *   - Object.assign(base, opts) mutated the shared base, so base.hooks.drawClear was
 *     undefined by the time it was read and no pane ever constructed
 *   - render() assigned a colour string over series.stroke, which uPlot normalises into
 *     stroke(u, idx) and calls on every draw, so the next draw called a string
 * Both are invisible to a type checker and to every unit test in the suite.
 *
 * Two shim details that took a while to get right, kept here so the next person does not
 * rediscover them: the script blocks must run under INDIRECT eval, because separate
 * <script> tags share global scope and `var uPlot = ...` is invisible across a
 * new Function() boundary; and the lookback sweep has to go through the page's own
 * tickChart(), because the page declares `let chartData`, which is script-scoped and never
 * a property of globalThis.
 */
const URL_BASE = process.argv[2] || 'http://localhost:8787'

// node:http rather than fetch: the shim below replaces global setTimeout with a
// synchronous stub, and undici (which backs fetch) keeps sockets alive past that point
// and calls .unref() on what it gets back. Using the raw http module sidesteps it.
import http from 'node:http'
function get(path) {
  return new Promise((resolve, reject) => {
    http.get(URL_BASE + path, (res) => {
      let b = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { b += c })
      res.on('end', () => {
        try { resolve(path === '/' ? b : JSON.parse(b)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}
const html = await get('/')
const state = await get('/api/state')
const LOOKBACKS = ['1h', '4h', '12h', '24h', '3d', '7d']
const payloads = {}
for (const lb of LOOKBACKS) payloads[lb] = await get('/api/chart?h=' + lb)
const chart4h = payloads['4h']
const calls = []
const ctx2d = new Proxy({}, {
  get(t, k) {
    if (k === 'canvas') return { width: 1200, height: 400 }
    if (k === 'measureText') return () => ({ width: 40 })
    if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) })
    if (k === 'createLinearGradient') return () => ({ addColorStop() {} })
    if (typeof k === 'string' && /^(font|fillStyle|strokeStyle|lineWidth|textAlign|textBaseline|globalAlpha|lineJoin|lineCap|globalCompositeOperation|imageSmoothingEnabled|filter|miterLimit|lineDashOffset|shadowBlur|shadowColor|direction|letterSpacing|fontKerning|fontStretch|shadowOffsetX|shadowOffsetY|textRendering|wordSpacing|fontVariantCaps)$/.test(k)) return ''
    return (...a) => { calls.push(k); return k === 'getLineDash' ? [] : undefined }
  },
  set() { return true },
})

globalThis.Path2D = class Path2D {
  constructor(){ this.ops = [] }
  moveTo(){ this.ops.push('moveTo') } lineTo(){ this.ops.push('lineTo') }
  arc(){ this.ops.push('arc') } rect(){ this.ops.push('rect') }
  closePath(){} bezierCurveTo(){} quadraticCurveTo(){} arcTo(){} ellipse(){}
  addPath(){} stroke(){} fill(){}
}
class HTMLElement {}
class HTMLCanvasElement extends HTMLElement {}
globalThis.HTMLElement = HTMLElement
globalThis.HTMLCanvasElement = HTMLCanvasElement
globalThis.Node = HTMLElement

let idSeq = 0
function mkEl(tag = 'div') {
  const kids = []
  const el = {
    tagName: String(tag).toUpperCase(), nodeType: 1, _id: ++idSeq,
    style: new Proxy({}, { get: (t, k) => t[k] ?? '', set: (t, k, v) => { t[k] = v; return true } }),
    dataset: {}, childNodes: kids, children: kids,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    className: '', textContent: '', innerHTML: '', title: '',
    width: 1200, height: 400,
    clientWidth: 1200, clientHeight: 400, offsetWidth: 1200, offsetHeight: 400,
    offsetTop: 0, offsetLeft: 0, scrollTop: 0, scrollLeft: 0,
    appendChild(c) { kids.push(c); c.parentNode = el; return c },
    insertBefore(c) { kids.push(c); c.parentNode = el; return c },
    removeChild(c) { const i = kids.indexOf(c); if (i >= 0) kids.splice(i, 1); return c },
    remove() {}, setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    _on: {},
    addEventListener(t, fn) { (el._on[t] = el._on[t] || []).push(fn) },
    removeEventListener(t, fn) { el._on[t] = (el._on[t] || []).filter((f) => f !== fn) },
    dispatchEvent: () => true,
    getContext: () => ctx2d,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1200, bottom: 400, width: 1200, height: 400, x: 0, y: 0 }),
    querySelector: (sel) => sel === 'summary' ? mkEl('summary') : null, querySelectorAll: () => [],
    closest: () => null, contains: () => false, focus() {}, blur() {},
  }
  Object.setPrototypeOf(el, (String(tag).toLowerCase() === 'canvas' ? HTMLCanvasElement : HTMLElement).prototype)
  return el
}

const byId = new Map()
for (const m of html.matchAll(/\bid="([a-zA-Z0-9]+)"/g)) byId.set(m[1], mkEl())
byId.get('chart') // may not exist any more, fine

const doc = {
  getElementById: (id) => byId.get(id) ?? null,
  createElement: (t) => mkEl(t),
  createElementNS: (ns, t) => mkEl(t),
  createTextNode: () => mkEl('#text'),
  querySelector: () => null,
  querySelectorAll: (sel) => {
    if (sel === '#seg button[data-h]') return ['1h','4h','12h','24h','3d','7d'].map(h => { const e = mkEl('button'); e.dataset.h = h; return e })
    return []
  },
  addEventListener() {}, removeEventListener() {},
  documentElement: mkEl('html'), body: mkEl('body'), head: mkEl('head'),
  title: '', visibilityState: 'visible', hidden: false,
  fonts: { ready: Promise.resolve() },
}
doc.documentElement.appendChild(doc.body)

const VARS = { '--bg':'#0f1216','--panel':'#171b21','--panel2':'#1e242c','--rule':'#2a313a',
  '--ink':'#dfe4ea','--muted':'#8b95a3','--ok':'#4fa88f','--warn':'#d3a04a','--bad':'#d1685c',
  '--accent':'#e08a4e','--mono':'ui-monospace,monospace' }

const errors = []
globalThis.window = globalThis
globalThis.document = doc
globalThis.devicePixelRatio = 2
globalThis.getComputedStyle = () => ({ getPropertyValue: (v) => VARS[v] ?? '', fontFamily: 'monospace' })
globalThis.localStorage = {
  __store: {},
  getItem(k) { return this.__store[k] ?? null },
  setItem(k, v) { this.__store[k] = String(v) },
  removeItem(k) { delete this.__store[k] },
}
globalThis.requestAnimationFrame = (fn) => { try { fn(0) } catch (e) { errors.push('rAF: ' + e.message) }; return 1 }
globalThis.cancelAnimationFrame = () => {}
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} })
globalThis.addEventListener = () => {}
globalThis.dispatchEvent = () => true
globalThis.removeEventListener = () => {}
globalThis.Event = class { constructor(t){ this.type=t } }
globalThis.CustomEvent = class { constructor(t,o){ this.type=t; this.detail=o&&o.detail } }
try { Object.defineProperty(globalThis,'navigator',{value:{userAgent:'node',platform:'MacIntel'},configurable:true}) } catch {}
// the page reads location.search so a preview/fixture query string rides along with its
// polls; without this the first fetch throws and every later failure is a symptom of it
globalThis.location = { search: '', pathname: '/', href: URL_BASE + '/' }
globalThis.screen = { width: 1600, height: 1000 }
globalThis.innerWidth = 1600
globalThis.innerHeight = 1000
globalThis.setInterval = () => 1
globalThis.setTimeout = (fn) => { try { fn() } catch (e) { errors.push('timeout: ' + e.message) }; return 1 }
globalThis.clearTimeout = () => {}
globalThis.fetch = async (u) => ({
  ok: true,
  json: async () => {
    if (!String(u).startsWith('/api/chart')) return state
    const lb = globalThis.__lb
    return lb ? payloads[lb] : chart4h
  },
})

const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
console.log('smoke: ' + URL_BASE + '  (' + blocks.length + ' script blocks, page ' + html.length + 'B)')
// indirect eval, NOT new Function: separate <script> tags share global scope, so
// `var uPlot = ...` in block 0 must be visible to block 1. new Function scopes it away
// and the page then silently takes its "library missing" branch.
const geval = eval
for (let i = 0; i < blocks.length; i++) {
  try { geval(blocks[i]) }
  catch (e) { errors.push('block ' + i + ': ' + e.message + '\n' + String(e.stack).split('\n').slice(1, 4).join('\n')) }
}
console.log('uPlot visible to page: ' + (typeof globalThis.uPlot))
for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r))

console.log('\ncanvas ops recorded: ' + calls.length)
const uniq = [...new Set(calls)]
console.log('  ' + uniq.join(', '))
const need = ['fillRect', 'arc', 'stroke', 'fillText', 'moveTo', 'lineTo']
for (const n of need) console.log('  ' + (uniq.includes(n) ? 'yes' : 'NO ') + '  ' + n)
// exercise the tooltip: it is pure DOM, so the shim covers it fully
const tip = byId.get('tip')
const cd = chart4h
const probes = [cd.to - 60_000, cd.from + (cd.to - cd.from) / 2, cd.from + 1000,
                (cd.trades[cd.trades.length - 1] || {}).t]
for (const t of probes) {
  if (t == null) continue
  try {
    globalThis.paintTip(t)
    const h = tip.innerHTML || ''
    if (!h) errors.push('paintTip(' + new Date(t).toISOString() + ') rendered nothing')
    else if (/undefined|NaN|\[object/.test(h)) errors.push('tooltip artifact: ' + h.slice(0, 200))
  } catch (e) { errors.push('paintTip: ' + e.message) }
}
console.log('\ntooltip sample:\n  ' + String(tip.innerHTML).replace(/<\/div>/g, '\n  ').replace(/<[^>]+>/g, '').replace(/\n\s*\n/g, '\n').trim())

// Every lookback must render. Driven through the page's own tickChart() rather than by
// poking chartData: the page declares it with `let`, which is script-scoped and never a
// property of globalThis, so assigning from out here silently makes a second variable.
console.log('')
for (const lb of LOOKBACKS) {
  try {
    globalThis.__lb = lb
    const before = calls.length
    await globalThis.tickChart()
    for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r))
    const drew = calls.length - before
    const payload = payloads[lb]
    console.log('  ' + lb.padEnd(4) + ' ops=' + String(drew).padEnd(5) +
      ' buckets=' + String(payload.outcomes.buckets.length).padEnd(4) +
      ' note="' + (byId.get('chartnote').textContent || '') + '"')
    if (drew === 0) errors.push(lb + ': render drew nothing')
  } catch (e) { errors.push(lb + ' render: ' + e.message) }
}

// ---- interactive: the legend toggles ----
// The load path is only half the page. Clicking a legend entry has to hide that segment
// AND rescale the axis to what is left, which is the entire point of the control.
function fire(el, type, ev) { for (const fn of (el._on?.[type] || [])) fn(ev) }
function fakeButton(seg) {
  const b = { dataset: { seg }, tagName: 'BUTTON', _attrs: {},
    setAttribute(k, v) { b._attrs[k] = v }, getAttribute: (k) => b._attrs[k] }
  b.closest = (sel) => (sel.includes('data-seg') ? b : null)
  return b
}
{
  const lgd = byId.get('lgd')
  const flowBefore = calls.length
  // the grey starts hidden on a first visit, so the first click shows it and the second hides it
  // mirrors the page: no saved choice means the grey is hidden; a saved '' means shown
  const has = () => { const raw = globalThis.localStorage.__store?.['snipe.chartHidden.v2']; return raw == null ? true : raw.split(',').includes('filtered') }
  const startedHidden = has()
  try {
    fire(lgd, 'click', { target: fakeButton('filtered') })
    await new Promise(r => setImmediate(r))
    const drew = calls.length - flowBefore
    if (drew === 0) errors.push('legend toggle: flipping a segment redrew nothing')
    else console.log('\nlegend toggle "filtered" -> redrew (' + drew + ' canvas ops)')
    console.log('  persisted: ' + JSON.stringify(globalThis.localStorage.__store?.['snipe.chartHidden.v2']))
    if (has() === startedHidden) errors.push('legend toggle: not persisted, still ' + (startedHidden ? 'hidden' : 'shown'))
    // and back again
    fire(lgd, 'click', { target: fakeButton('filtered') })
    await new Promise(r => setImmediate(r))
    if (has() !== startedHidden) errors.push('legend toggle: second click did not restore the start state')
    else console.log('  toggles back cleanly')
  } catch (e) { errors.push('legend toggle: ' + e.message) }
}

// ---- recent exits: rows render, and one expands to the detail panel ----
{
  const rb = byId.get('recBody')
  try {
    const h = rb.innerHTML || ''
    if (!h) errors.push('recent exits rendered nothing')
    if (/undefined|NaN|\[object/.test(h)) errors.push('recent exits artifact: ' + h.slice(0, 200))
    const rows = (h.match(/<tr class="hd"/g) || []).length
    console.log('\nrecent exits: ' + rows + ' rows')
    if (!rows && !h.includes('nothing closed')) errors.push('recent exits: missing empty state')
    // coin names come from launch calldata; they must arrive escaped
    if (/<script|onerror=|onload=/i.test(h)) errors.push('recent exits: unescaped markup in a coin name')

    if(rows){
    const before = h.length
    fire(rb, 'click', { target: { closest: (sel) => (sel === 'a' ? null : { dataset: { i: '0' } }) } })
    await new Promise(r => setImmediate(r))
    const after = rb.innerHTML || ''
    const opened = (after.match(/<td class="det"/g) || []).length
    console.log('  click row 0 -> detail panels open: ' + opened + ' (html ' + before + ' -> ' + after.length + 'B)')
    if (opened !== 1) errors.push('detail panel: expected exactly 1 open, got ' + opened)
    if (/undefined|NaN|\[object/.test(after)) errors.push('detail panel artifact: ' + after.slice(after.indexOf('class="det"'), after.indexOf('class="det"') + 300))
    fire(rb, 'click', { target: { closest: (sel) => (sel === 'a' ? null : { dataset: { i: '0' } }) } })
    await new Promise(r => setImmediate(r))
    const closed = ((rb.innerHTML || '').match(/<td class="det"/g) || []).length
    if (closed !== 0) errors.push('detail panel: did not close, ' + closed + ' still open')
    else console.log('  clicking again closes it')
    }
  } catch (e) { errors.push('recent exits: ' + e.message) }
}

console.log('\nerrors: ' + errors.length)
for (const e of errors) console.log('  !! ' + e)

process.exitCode = errors.length ? 1 : 0
console.log(errors.length ? '\nFAIL' : '\nPASS')
