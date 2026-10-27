/**
 * The dashboard page. Self-contained: no network calls, no fonts, no CDN.
 *
 * This is an OPERATIONS page, not a report. It answers "is anything wrong right now",
 * which is a different question from "did the strategy work", and the difference decides
 * the layout: the state strip first, then faults, then three headline cards, the rolling
 * windows, the history, and the trade tables.
 *
 * Every fact is stated once. The 2026-09-12 review found the previous layout saying the
 * pause state six times and the drawdown six ways, with a hidden market card still being
 * filled every second. The rule now: the strip owns the bot's state, each card owns one
 * number, each pane owns one series, and the tooltip carries the detail.
 *
 * The rolling windows exist because a cumulative number is the wrong instrument for this
 * job. On 2026-08-18 the venue stopped paying and the bot traded down the slope for eight
 * hours while the all-time figure stayed green the whole way. Three windows side by side
 * make that visible in minutes: the short one turns first while the long ones still look
 * fine, and that divergence IS the signal.
 */
import { readFileSync } from 'node:fs'
import { STRATEGY } from '../config.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * uPlot, inlined from src/telemetry/vendor rather than node_modules, because deploy is
 * `rsync src/` and a file under src/ is guaranteed to be on the box.
 *
 * The try/catch is not defensive habit, it is load-bearing. This module is imported during
 * bot startup, so an unguarded readFileSync here turns a missing asset into a bot that
 * will not boot. A chartless page is an acceptable failure; a dead trading process is not.
 */
function loadVendor(dir: string): { js: string; css: string } {
  try {
    return {
      js: readFileSync(join(dir, 'uPlot.iife.min.js'), 'utf8'),
      css: readFileSync(join(dir, 'uPlot.min.css'), 'utf8'),
    }
  } catch {
    return { js: '', css: '' }
  }
}
/** exported so a test can prove a missing file degrades instead of throwing */
export { loadVendor }

const VENDOR = loadVendor(join(dirname(fileURLToPath(import.meta.url)), 'vendor'))
export const vendorLoaded = (): boolean => VENDOR.js.length > 0

export function dashboardHtml(captured?: {holdMs:number}): string {
  // The bundle is spliced in AFTER the template is built, never inside it: String.raw
  // still interpolates ${...}, and the minified source contains six of them plus a
  // backtick. Splicing inline throws at import time, which (see above) stops the bot.
  //
  // The replacer is a FUNCTION on purpose. A plain string replacement would interpret
  // $&, $` and $1 inside the bundle as substitution patterns. Today's build contains
  // none of those; a future version bump is exactly where that would go wrong silently.
  return PAGE
    .replace('/*__UPLOT_CSS__*/', () => VENDOR.css)
    .replace('/*__UPLOT_JS__*/', () => VENDOR.js)
    // The "Max 45s" row was typed as a literal and went stale the moment the exit clock
    // moved 45s -> 90s on 2026-08-27. It is the GATE's window, not maxHoldMs: truePeak
    // comes from gate.db, which gatewatch.py fills at gateHoldMs. So splicing maxHoldMs
    // here would have swapped one wrong number for a differently wrong one. Same argument
    // as STRATEGY.gate.holdMs itself. The fixed touch multiple is no longer shown anywhere
    // on this page (2026-09-12); the gate still uses it, the page does not.
    .replaceAll('__GATE_HOLD_S__', () => String(Math.round((captured?.holdMs ?? STRATEGY.gate.holdMs) / 1000)))
}

/**
 * The page as authored, vendor placeholders still in place.
 *
 * Exists for the tests: assertions like "no >undefined< anywhere" are about OUR markup,
 * and running them over the rendered output means running them over 51 KB of minified
 * third-party JS, where `typeof x=="undefined"` is an ordinary thing to find. Scoping the
 * regexes here keeps them sharp instead of forcing them to be loosened.
 */
export const dashboardShell = (): string => PAGE

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pons sniper</title>
<style>/*__UPLOT_CSS__*/</style>
<style>
:root{color-scheme:dark;--bg:#101317;--panel:#191d23;--panel2:#222831;--rule:#2b323b;--rule2:#3a424d;--ink:#e5e9ef;--muted:#a0a9b6;--ok:#66bea5;--warn:#e1b467;--bad:#ed8c82;--accent:#8eaff0;--rec:#c4a1ed;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}
/* load-bearing: .row and .card set display, which beats the UA stylesheet's [hidden] rule,
   so the account breakdown and the positions card would show while flat */
[hidden]{display:none!important}
body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font:14px/1.5 var(--sans)}.wrap{max-width:1280px;margin:auto}h1{font-size:18px;letter-spacing:-.02em;font-weight:600;margin:0}.sub{font-size:12px;color:var(--muted);margin-top:4px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:12px}.modebadge{font-size:11px;font-weight:650;letter-spacing:.07em;padding:5px 9px;border-radius:5px;border:1px solid var(--rule);color:var(--muted);background:var(--panel);white-space:nowrap}
.grid{display:grid;gap:12px;margin-bottom:12px}.g3{grid-template-columns:repeat(3,minmax(0,1fr))}.card{min-width:0;background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:13px 16px}.card h2{font-size:12px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}.card.wide{margin-bottom:12px}.row{display:flex;justify-content:space-between;gap:12px;padding:3px 0;align-items:baseline}.row .k{color:var(--muted);min-width:0}.row .v{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right;min-width:0;overflow-wrap:anywhere}.big{font:600 28px/1.2 var(--mono);letter-spacing:-.035em;font-variant-numeric:tabular-nums;margin-bottom:5px;overflow-wrap:anywhere}.unit{font:400 13px var(--sans);color:var(--muted);letter-spacing:0}.secondary{color:var(--muted);font-family:var(--mono);font-variant-numeric:tabular-nums;min-height:21px;margin-bottom:8px}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.mut{color:var(--muted)}.card small{color:var(--muted);font-size:11px}.card-notices:empty{display:none}.card-notices p{font-size:13px;margin:10px 0 0;padding-top:9px;border-top:1px solid var(--rule);overflow-wrap:anywhere}
button,summary{touch-action:manipulation}button{font:600 13px var(--sans);color:var(--ink);background:var(--panel2);border:1px solid var(--rule);border-radius:5px;min-height:36px;padding:6px 12px;cursor:pointer}button:hover:not(:disabled){background:#2b3441;border-color:#586677}button:disabled{opacity:.4;cursor:default}button:focus-visible,summary:focus-visible,a:focus-visible,#panes:focus-visible{outline:2px solid var(--accent);outline-offset:3px}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
#btnStop{color:var(--bad);border-color:#72463f}#btnStart.armed{color:var(--ok);border-color:var(--ok)}.ctlMsg{font-size:12px;color:var(--muted);flex-basis:100%}.ctlMsg:empty{display:none}.ctlMsg.bad{color:var(--bad)}
.bar{height:6px;background:var(--panel2);border-radius:4px;overflow:hidden;min-width:48px}.bar i{display:block;height:100%;background:var(--accent);border-radius:4px}.drawdown-bar{margin:14px 0 8px}.pill{font-size:10px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;padding:3px 7px;border-radius:4px;border:1px solid var(--rule);white-space:nowrap}.empty{color:var(--muted);padding:12px;text-align:center}.sm{font-size:12px;color:var(--muted)}
.info{margin-top:10px;font-size:13px;color:var(--muted)}.info summary{cursor:pointer;list-style:none;display:inline-block;border-bottom:1px dotted var(--muted);padding:3px 0}.info summary::-webkit-details-marker{display:none}.info-body{padding:10px 0 0;color:var(--muted)}.info-body p{margin:0 0 8px}.recovery-checks{list-style:none;padding:0;margin:8px 0}.recovery-checks li{margin:7px 0}.info[hidden]{display:none}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;color:var(--muted);font:500 12px var(--sans);padding:10px 12px;border-bottom:1px solid var(--rule);white-space:nowrap}td{font-family:var(--mono);font-variant-numeric:tabular-nums;padding:8px 10px;border-bottom:1px solid var(--rule);white-space:nowrap}tr:last-child td{border-bottom:0}#kpi td,#kpi th{text-align:right}#kpi td:first-child,#kpi th:first-child{text-align:left;font-family:var(--sans);color:var(--muted)}#kpi .hd{font-size:16px;font-weight:600}#kpi tr.sep td{border-top:1px solid var(--rule)}#rec th.n,#rec td.n{text-align:right}#rec .sym{font:600 14px var(--sans);max-width:150px;display:inline-block;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom}#rec tbody tr.hd{cursor:pointer}#rec tbody tr.hd:hover td,#rec tbody tr.hd.open td{background:var(--panel2)}#rec td.det{padding:0;background:#15191f}.capt{position:relative;height:5px;min-width:72px;background:var(--panel2);border-radius:3px;overflow:hidden}.capt u,.capt b{position:absolute;left:0;top:0;bottom:0;display:block}.capt u{background:var(--rule)}.pnl-cell strong{font-weight:600}.pnl-cell small{font-size:11px;margin-left:9px;opacity:.85;color:inherit}.det .box{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:0 24px;padding:18px 20px}.det h4{font:600 12px var(--sans);letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}.det .g{padding:0 0 15px}.det .r{display:flex;justify-content:space-between;gap:12px;padding:4px 0;font-size:13px;white-space:normal}.det .r span:first-child{font-family:var(--sans);color:var(--muted)}.det .r span:last-child{text-align:right;overflow-wrap:anywhere}.det .lk{padding:0 20px 18px;font:12px var(--sans);display:flex;gap:14px;flex-wrap:wrap;white-space:normal;overflow-wrap:anywhere}
.section-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:5px}.section-heading h2{margin:0}.section-heading button{min-height:28px;padding:3px 8px;font-size:12px;color:var(--muted);background:transparent}
.seg{display:flex;gap:4px;flex-wrap:wrap}.seg button{font:500 12px var(--mono);min-height:34px;padding:5px 9px;background:transparent;color:var(--muted);border-color:transparent}.seg button[aria-pressed="true"]{color:var(--ink);background:var(--panel2);border-color:#475873}#zoomchip{display:none;color:var(--accent);border-color:#475873}.pane-title{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;font:600 11px var(--sans);letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin:10px 0 4px}.chart-help,.chart-empty{font:12px var(--sans);color:var(--muted);line-height:1.5;margin:4px 0 10px}.chart-empty{padding:24px 12px;border:1px dashed var(--rule);border-radius:6px}#paperDiagnostics{font:12px var(--sans);color:var(--muted);margin:6px 0 12px;line-height:1.5;overflow-wrap:anywhere}.pane-title span{font-weight:400;text-transform:none;letter-spacing:0;font-family:var(--mono);font-variant-numeric:tabular-nums}.pane-title span b{font-weight:600}#panes{position:relative}.pane{position:relative}.uplot,.u-wrap{font-family:var(--mono)!important}.u-cursor-x,.u-cursor-y{border-color:var(--muted)!important;opacity:.45}.u-select{background:#8eaff020;border:1px solid var(--accent)}.u-legend{display:none!important}#tip{position:absolute;z-index:20;pointer-events:none;display:none;background:var(--panel2);border:1px solid #465363;border-radius:7px;padding:12px 14px;font-size:13px;line-height:1.5;max-width:calc(100% - 8px);box-shadow:0 8px 26px #0005}#tip .t{font-size:12px;color:var(--muted);margin-bottom:7px}#tip .r{display:flex;justify-content:space-between;gap:14px}#tip .r span:first-child{color:var(--muted)}#tip .r span:last-child{font-family:var(--mono);text-align:right}#tip hr{border:0;border-top:1px solid var(--rule);margin:9px 0}.lgd{display:flex;gap:8px 16px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:12px}.lgd i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}.lgd i.hatch{background:repeating-linear-gradient(135deg,var(--muted) 0 1px,transparent 1px 3px)}.lgd i.strip{width:22px;height:6px;background:linear-gradient(90deg,var(--bad),var(--rule2) 50%,var(--ok))}.lgd button{font:12px var(--sans);color:var(--muted);background:none;border:0;min-height:28px;padding:0}.lgd button[aria-pressed="false"]{opacity:.55;text-decoration:line-through}.lgd button[aria-pressed="false"] i{background:var(--rule)!important}#chartnote{font-size:12px;color:var(--muted);margin-top:9px}.foot{font-size:12px;color:var(--muted);margin-top:20px}
#banner[hidden]{display:none}#banner{border:1px solid #645038;border-left:3px solid var(--warn);border-radius:6px;background:#251f19;color:var(--ink);padding:10px 14px;margin-bottom:12px;font-size:13px}#banner.crit{border-color:#704640;border-left-color:var(--bad);background:#291d1d}#banner>strong{display:block;color:var(--warn);font-size:11px;letter-spacing:.06em;margin-bottom:4px}#banner.crit>strong{color:var(--bad)}#banner ul{margin:0;padding-left:18px}#banner li{margin:5px 0;overflow-wrap:anywhere}
#tradingCard{display:flex;align-items:center;gap:10px 22px;flex-wrap:wrap;margin-bottom:12px}#tradingCard .big{font:600 20px/1.2 var(--sans);letter-spacing:-.02em;margin:0;white-space:nowrap}#tradingCard .reason{flex:1 1 280px;min-width:0;color:var(--muted);font-size:13px;line-height:1.45;overflow-wrap:anywhere}#tradingCard .reason b{color:var(--ink);font-weight:600;font-family:var(--mono);font-variant-numeric:tabular-nums}#tradingCard .reason .blocker{display:block;margin:2px 0}.kv{display:flex;gap:8px;align-items:baseline;font-size:12px;color:var(--muted);white-space:nowrap}.kv .v{font:600 13px var(--mono);color:var(--ink);font-variant-numeric:tabular-nums}.kv small{font-size:11px;color:var(--muted)}#tradingCard .ctl{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:auto}#tradingCard .card-notices{flex-basis:100%}#technical{margin-bottom:12px}#technicalDetails{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:300px;overflow:auto}#eventHistory{max-height:200px;overflow:auto;font-size:12px}#posCard td .pill{border-color:#475873}
@media(max-width:900px){.g3{grid-template-columns:repeat(2,minmax(0,1fr))}.g3>.card:first-child{grid-column:1/-1}.big{font-size:25px}}
@media(max-width:800px){body{padding:12px}.card{padding:12px}.grid{gap:10px;margin-bottom:12px}.card h2{margin-bottom:8px}#tradingCard .ctl{margin-left:0;flex-basis:100%}#tradingCard .reason{flex-basis:100%}}
@media(max-width:480px){.top{margin-bottom:12px}.g3{grid-template-columns:1fr}.card h2{font-size:11px;letter-spacing:.035em}.big{font-size:24px}.unit{font-size:12px}.row{gap:7px;font-size:13px}.secondary{font-size:12px;overflow-wrap:anywhere}.kv{white-space:normal}#tradingCard .big{font-size:18px}#tradingCard{gap:6px 14px}.ctlMsg{font-size:11px}.seg{gap:1px}.seg button{padding:5px 8px;min-height:38px}.det .box{grid-template-columns:1fr;padding:16px}.det .lk{padding:0 16px 16px}th,td{padding:7px 6px;font-size:12px}#kpi td,#kpi th{font-size:11px;padding:6px 4px}#kpi td:first-child{white-space:normal;width:72px;max-width:72px}#kpi .hd{font-size:12px}#rec .sym{max-width:80px;font-size:12px}.pnl-cell small{display:none}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
/* THE OUTCOME STRIP. Numbers, not a chart: this has to be readable on a phone at 400px,
   and the operator's question is "what did the last twenty launches actually pay". */
/* two stat blocks, each one reading label / number / rule, because the operator's two
   questions are "is the venue paying" and "is it paying ENOUGH to come back on" */
#outcomeCard .ohead{display:flex;flex-wrap:wrap;gap:10px 28px;margin-bottom:11px}
#outcomeCard .ostat{display:flex;flex-direction:column;gap:1px;min-width:0}
#outcomeCard .ostat .olab{font-size:10px;letter-spacing:.06em;text-transform:uppercase;opacity:.55}
#outcomeCard .ostat .oval{font-size:19px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.15}
#outcomeCard .ostat .orule{font-size:11px;opacity:.6}
/* GRID, not flex. With flex the last row stretched its one or two cells across the full
   width and read as two enormous outcomes; equal grid columns keep every launch the same
   size wherever it falls. */
#outcomeCard .ostrip{display:grid;grid-template-columns:repeat(auto-fill,minmax(68px,1fr));gap:4px}
#outcomeCard .ocell{padding:5px 7px;border-radius:5px;text-align:right;
  font-variant-numeric:tabular-nums;font-size:12px;line-height:1.25;border-top:2px solid transparent}
#outcomeCard .ocell b{display:block;font-weight:650}
#outcomeCard .ocell small{display:block;opacity:.6;font-size:10px}
#outcomeCard .ocell.up{background:color-mix(in srgb,var(--ok) 15%,transparent);color:var(--ok)}
#outcomeCard .ocell.dn{background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad)}
/* The recovery window is a SUBSET of the twenty, marked in place rather than repeated as a
   second list that would read as eight more launches. The marker is NEUTRAL on purpose: an
   outline in the cell's own colour made every losing recovery cell look like an alarm. */
#outcomeCard .ocell.rec{border-top-color:var(--fg)}
#outcomeCard .onote{margin-top:10px;font-size:12px;opacity:.7}
@media(max-width:480px){
  #outcomeCard .ostrip{grid-template-columns:repeat(auto-fill,minmax(58px,1fr))}
  #outcomeCard .ocell{font-size:11px;padding:4px 5px}
  #outcomeCard .ostat .oval{font-size:17px}
}
/* THE BOOKS. A strip of tiles, one per configured book, then the comparison table and the
   post-band reject funnel. Auto-fit rather than a fixed two columns: the same rule has to
   hold at one book, at two and at the four the config allows, and a 1fr 1fr grid renders a
   single book as a half-width tile beside dead space. */
#bookStrip{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:12px;margin-bottom:16px}
.bookTile{background:var(--panel2);border-radius:8px;padding:12px 14px;min-width:0}
.bookTile .bname{font:600 13px var(--sans);display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.bookTile .bband{font:400 11px var(--mono);opacity:.6}
.bookTile .bbig{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.2;margin:6px 0 2px}
.bookTile .brow{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:2px 0}
.bookTile .brow span:first-child{font-family:var(--sans);opacity:.6}
.bookTile .brow span:last-child{font-variant-numeric:tabular-nums}
.bookTile button{margin-top:9px;width:100%}
#bookKpi td,#bookKpi th{text-align:right}
#bookKpi td:first-child,#bookKpi th:first-child{text-align:left;font-family:var(--sans);color:var(--muted)}
/* The delta column is GREY until both books clear the gate, and the reason is spelled out
   beside the heading. A confident-looking number on a dashboard gets acted on whether or
   not the sample earned it, so "not yet" has to look different from "zero". */
#bookKpi td.dim,#bookKpi th.dim{opacity:.38}
#bookRejects{margin-top:16px}
#bookRejects h3{font:600 12px var(--sans);letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:0 0 4px}
#bookRejects .rnote{font-size:12px;opacity:.65;margin:0 0 8px}
#bookRejects .rbar{display:flex;align-items:center;gap:10px;padding:3px 0;font-size:12px}
#bookRejects .rlab{font-family:var(--sans);opacity:.75;width:106px;flex:none;overflow:hidden;text-overflow:ellipsis}
#bookRejects .rtrack{flex:1;height:8px;border-radius:4px;background:var(--rule);overflow:hidden;min-width:40px}
#bookRejects .rtrack i{display:block;height:100%;background:var(--rule2)}
#bookRejects .rbar.ok .rtrack i{background:var(--ok)}
#bookRejects .rn{font-variant-numeric:tabular-nums;width:90px;flex:none;text-align:right;white-space:nowrap}
#bookTabs{margin:0 0 10px}
@media(max-width:480px){
  #bookStrip{grid-template-columns:1fr}
  .bookTile .bbig{font-size:19px}
  #bookKpi td,#bookKpi th{font-size:11px;padding:6px 4px}
  #bookRejects .rlab{width:78px}
  #bookRejects .rn{width:74px}
}
</style></head><body><div class="wrap">

<div class="top">
  <div><h1>Pons sniper</h1><div class="sub" id="sub">connecting…</div></div>
  <div id="mode" class="modebadge">–</div>
</div>

<!-- THE STRIP: the bot's state, said once. Readings and thresholds live in the sentence. -->
<div class="card" id="tradingCard">
  <div class="big" id="tradingState">Connecting</div>
  <div class="reason" id="tradingWhy"></div>
  <div class="kv"><span class="k">Last closed</span><span class="v" id="lastTrade">Not recorded</span></div>
  <div class="kv"><span class="k">Open</span><span class="v" id="openNow">Unavailable</span></div>
  <div class="kv" title="New entries only. An open position keeps the rules it opened under."><span class="k">Size</span><span class="v" id="tradeSize">Unavailable</span><small id="tradeSizeUsd"></small></div>
  <div class="ctl"><button id="btnStop" type="button">STOP</button><button id="btnStart" type="button" disabled>RESUME AUTO</button><button id="btnReset" type="button" disabled>RESET DRAWDOWN</button><span class="ctlMsg" id="ctlMsg" role="status"></span></div>
  <div class="card-notices" id="tradingNotices"></div>
</div>

<div class="card" id="outcomeCard">
  <h2>What the venue just paid</h2>
  <div class="ohead">
    <div class="ostat"><span class="olab" id="oTitle">Market · last 20</span>
      <span class="oval" id="oSum">–</span><span class="orule" id="oRule"></span></div>
    <div class="ostat"><span class="olab" id="oRecTitle">Recovery · latest 8</span>
      <span class="oval" id="oRecovery">–</span><span class="orule" id="oRecRule"></span></div>
  </div>
  <div class="ostrip" id="oStrip"></div>
  <div class="onote" id="oNote"></div>
</div>

<section id="banner" hidden aria-live="polite"><strong id="bannerHd">ACTION NEEDED</strong><ul id="bannerList"></ul></section>

<div class="grid g3" id="operatingCards">
  <div class="card" id="todayCard"><h2>Today’s net P&amp;L</h2><div class="big" id="todayPnl">Unavailable</div><div class="secondary" id="todayEth"></div><div id="todayTrades" class="mut"></div><small>Closed cash · UTC day · costs included</small></div>
  <div class="card" id="walletCard"><h2>Account</h2><div class="big" id="eqNow">Unavailable</div><div class="secondary" id="cashUsd"></div>
    <div class="row" id="acctOpen" hidden><span class="k" id="acctOpenLabel">In open positions</span><span class="v" id="acctOpenValue">Unavailable</span></div>
    <div class="row" id="acctWallet" hidden><span class="k">Wallet</span><span class="v" id="acctWalletValue">Unavailable</span></div>
    <details class="info"><summary>Account details</summary><div class="info-body"><p id="walletFreshness"></p><p id="eqDelta"></p><p>Open positions are valued before exit gas. Pending entries count at their committed cost.</p></div></details>
    <div class="card-notices" id="walletNotices"></div>
  </div>
  <div class="card" id="killCard"><h2>Drawdown left</h2><div class="big" id="dd">Unavailable</div><div class="secondary" id="ddUsd"></div>
    <div class="bar drawdown-bar" role="progressbar" aria-label="Drawdown allowance used" aria-valuemin="0" aria-valuemax="100" id="ddProgress"><i id="ddBar" style="width:0%"></i></div>
    <div class="row"><span class="k">Used</span><span class="v" id="ddUsed">Unavailable</span></div>
    <details class="info" id="recoveryInfo" hidden><summary id="recoverySummary">Recovery conditions</summary><div class="info-body" id="recoveryDetail"></div></details>
  </div>
</div>

<!-- ROLLING WINDOWS: a cumulative number cannot say "right now". The calendar day is the card above. -->
<div class="card wide">
  <div class="section-heading"><h2>Rolling performance</h2><button id="moreMetrics" type="button" aria-expanded="false">More metrics</button></div>
  <div class="scroll"><table id="kpi">
    <thead><tr><th>metric</th><th>1h</th><th>4h</th><th>12h</th></tr></thead>
    <tbody id="kpiBody"><tr><td colspan="4" class="empty">waiting for trades…</td></tr></tbody>
  </table></div>
</div>

<!-- THE BOOKS. Every row here is per book; the wallet totals stay in the cards above, which
     already ARE the totals. Stating them a second time under a "totals" heading is exactly
     the duplication the 2026-09-12 review existed to remove. -->
<div class="card wide" id="bookCard" hidden>
  <div class="section-heading"><h2>Books</h2><span class="mut" id="bookNote"></span></div>
  <div id="bookStrip"></div>
  <div class="scroll"><table id="bookKpi">
    <thead id="bookKpiHead"></thead>
    <tbody id="bookKpiBody"></tbody>
  </table></div>
  <div id="bookRejects"></div>
</div>

<div class="card wide">
  <div class="section-heading">
    <h2>History</h2>

    <div class="seg" id="seg">
      <button id="zoomchip" type="button">zoomed · reset</button>
      <button data-h="1h">1h</button><button data-h="4h">4h</button><button data-h="12h">12h</button>
      <button data-h="24h">24h</button><button data-h="3d">3d</button><button data-h="7d">7d</button>
    </div>
  </div>
  <div id="replayCoverage" class="chart-empty" hidden></div>
  <div id="panes" tabindex="0" role="group" aria-label="History charts. Use Left and Right arrows to inspect, Home and End to jump, Escape to dismiss.">
    <div class="pane-title">Account history <span>wallet + open cost · ETH</span></div><div class="pane" id="paneWallet"></div>
    <!-- The wallet pane above is TIER 1 and never swaps: it is the one chain-truth line and it
         has no book dimension. Everything below the tabs is per book and swaps as a set. The
         bar sits here, between the two, rather than in its own card, because moving the wallet
         pane out would need a second tooltip container and a second width source and would put
         the "all panes share one plotting width" assertion at risk for one position of layout
         order. Buttons are rendered from state.books at runtime, never spliced into this HTML. -->
    <div class="seg" id="bookTabs" hidden role="group" aria-label="Which book the charts below show"></div>
    <div class="pane-title">Paper Wallet · 24h baseline <span id="paperValue"></span></div><p class="chart-help" id="paperNote"></p><div class="pane" id="panePaper"></div><p class="chart-empty" id="paperEmpty" hidden>No paper results recorded in this period.</p>
    <div class="pane-title"><b id="mainPlotTitle">Market Indicator</b> <span id="mainPlotValue"></span></div><div class="pane" id="paneVenue"></div><p class="chart-empty" id="emptyVenue" hidden></p>
    <p class="chart-help"><span style="color:var(--accent)" id="mainLineLabel">Main 15</span> · <span style="color:var(--rec)" id="freshLineLabel">Fresh 8</span> · lowest score across six scenarios · stakes</p>
    <p class="chart-help" id="marketNote"></p>
    <div class="pane-title" id="volumeTitle">Coins · p50-after <span id="volumeTotal"></span></div><div class="pane" id="paneVolume"></div><p class="chart-empty" id="emptyVolume" hidden></p>
    <div id="tip" role="status" aria-live="off"></div>
  </div>
  <div class="lgd" id="lgd">
    <button data-seg="filtered" aria-pressed="true"><i style="background:var(--rule2)"></i>Filtered out</button>
    <button data-seg="win" aria-pressed="true"><i style="background:var(--ok)"></i>Paper win</button>
    <button data-seg="loss" aria-pressed="true"><i style="background:var(--bad)"></i>Paper loss</button>
    <button data-seg="notSimulated" aria-pressed="true"><i style="background:var(--muted)"></i>Passed, no estimate</button>
    <button id="flatLegend" data-seg="flat" aria-pressed="true"><i style="background:var(--accent)"></i>Break-even</button>
    <button data-seg="pending" aria-pressed="true"><i class="hatch"></i>Pending</button>
    <button data-line="net" aria-pressed="true"><i class="strip"></i>Paper return · trade sizes</button>
    <button data-line="halts" aria-pressed="true"><i style="background:rgba(237,140,130,.3)"></i>Trading paused</button>
    <button data-line="dark" aria-pressed="true"><i class="hatch"></i>Bot down</button>
  </div>
  <div id="chartnote"></div>

</div>

<details class="card" id="technical"><summary>Details</summary><h3>Paper accuracy checks</h3><div id="paperDiagnostics"></div><div id="executionStatus"></div><div id="technicalDetails"></div><div id="eventHistory"></div></details>

<!-- hidden while flat: the strip already says "Open 0 / 14", and the bot is flat most of the day -->
<div class="card wide" id="posCard" hidden><h2>Open positions</h2>
  <div class="scroll"><table>
    <thead><tr><th>Opened</th><th>Token</th><th>Age</th><th></th><th>Mult</th><th>Pinned TP</th><th>Est. return</th><th>Supply left</th><th>State</th></tr></thead>
    <tbody id="posBody"></tbody>
  </table></div>
</div>

<div class="card wide"><h2>Recent exits</h2>
  <div class="scroll"><table id="rec">
    <thead><tr>
      <th>Time</th><th>Coin</th><th class="n">P&amp;L · $ / ETH</th><th>Reason</th><th>Hold</th>
      <th class="n" title="the take-profit rung this position opened on. the take profit is a schedule over the venue's trailing gate rate, so the book holds several at once and the same exit multiple means different things on different rungs">Pinned TP</th>
      <th class="n" title="highest the coin reached inside the gate's __GATE_HOLD_S__s observation window, measured independently of when we sold. this is the GATE's window, not the exit clock: the two are deliberately decoupled, so it does not move when maxHoldMs moves">Max __GATE_HOLD_S__s</th>
      <th class="n">Exit</th><th title="how much of the available run we kept">Kept</th>
      <th class="n">Dev buy</th><th class="n">Exempt</th><th></th>
    </tr></thead>
    <tbody id="recBody"><tr><td colspan="12" class="empty">nothing closed yet</td></tr></tbody>
  </table></div>
</div>

<div class="foot" id="foot">–</div>

<script>/*__UPLOT_JS__*/</script>
<script>
const $ = id => document.getElementById(id);
const n = (v,d=2) => v===null||v===undefined||Number.isNaN(v) ? '–' : Number(v).toFixed(d);
// always carry the sign. the previous inline pattern, (v>=0?'+':'')+'$'+abs(v), printed
// -$22.41 as "$22.41" and left colour as the only clue that money had been lost.
const cls = v => v > 0 ? 'ok' : v < 0 ? 'bad' : 'mut';
const usd = (v,d=2) => v===null||v===undefined ? '–' : (v<0?'-$':'+$') + n(Math.abs(v),d);
const eth = (v,d=5) => v===null||v===undefined ? '–' : (v<0?'-':'+') + n(Math.abs(v),d) + ' ETH';
const pct = (v,d=0) => v===null||v===undefined ? '–' : n(v,d)+'%';
const sgn = (v,d=2) => v===null||v===undefined ? '–' : (v>=0?'+':'')+n(v,d);
const hhmm = t => t==null ? '–' : new Date(t).toLocaleTimeString('en-GB',{timeZone:'UTC',hour:'2-digit',minute:'2-digit'});
const hhmmss = t => t==null ? '–' : new Date(t).toLocaleTimeString('en-GB',{timeZone:'UTC'});
function shortError(v){return String(v||'').split(/RpcRequestError:|Request body:|URL:/)[0].trim().slice(0,240)}
function set(el, txt, cls){ el.textContent = txt; if(cls!==undefined){ el.className = el.className.replace(/\b(ok|warn|bad|mut)\b/g,'').trim()+' '+cls; } }
// Memoised because it is called from inside the canvas draw hooks - once per trade dot,
// once per stack segment per bucket - which is ~400 getComputedStyle calls per redraw at
// 24h, and each one forces a style resolution. The page has no theme switcher, so these
// custom properties never change after first paint.
const CSSV = new Map();
function css(v){
  let hit = CSSV.get(v);
  if (hit === undefined){
    hit = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    CSSV.set(v, hit);
  }
  return hit;
}
// coin names come from launch calldata, i.e. from whoever deployed the token, and land in
// innerHTML. Anything a stranger controls gets escaped before it is rendered.
const ESCMAP={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g, c => ESCMAP[c]); }

// ---------- rolling KPI table ----------
// Rendered as metric-rows x window-columns so the eye scans ACROSS a metric and sees the
// short window diverge from the long ones. That divergence is the early warning; a single
// column of numbers cannot show it.
//
// The server computes 24h too (the report skill reads it); the page shows three windows and
// leaves the calendar day to the Today card, so the same number is not on screen twice.
const PAGE_WINDOWS = ['1h','4h','12h'];
const KPI_ROWS = [
  { key:'n',            label:'trades',              fmt:v=>v===null?'–':String(v), color:()=>'' },
  { key:'pnlUsd',       label:'P&L',                 fmt:v=>usd(v),                 color:v=>cls(v), sep:true, hd:true },
  { key:'rotPct',       label:'return on turnover',  fmt:v=>v===null?'–':(v>0?'+':'')+n(v,2)+'%', color:v=>cls(v), hd:true },
  { key:'medianRotPct', label:'median trade',        fmt:v=>v===null?'–':(v>0?'+':'')+n(v,2)+'%', color:v=>cls(v) },
  { key:'popRate',      label:'pop rate (took profit)', fmt:v=>pct(v),  color:v=>v===null?'mut':v>=25?'ok':v>=15?'warn':'bad', sep:true },
  { key:'winRate',      label:'win rate',            fmt:v=>pct(v),     color:v=>v===null?'mut':v>=50?'ok':'warn' },
  { key:'verifiedPct',  label:'receipt-verified',    fmt:v=>pct(v),     color:v=>v===null?'mut':v>=99?'ok':'warn' },
];

// ---------- the books ----------
// Which book the four swapping panes are showing. '' means book 0, 'vs' means the comparison
// tab. Kept beside the lookback because the pair is what identifies a chart payload: a cache
// keyed on the lookback alone paints the OTHER book's data the moment you switch.
let chartBook = localStorage.getItem('snipe.book') || '';
// Rows of the per-book comparison table. Every mean carries its spread and its n; there is
// no row here that prints an average alone.
const BOOK_ROWS = [
  { key:'n',            label:'closed trades',      fmt:v=>v==null?'–':String(v) },
  { key:'pnlUsd',       label:'booked P&L',         fmt:v=>usd(v),                                   color:v=>cls(v), hd:true },
  { key:'rotPct',       label:'return on turnover', fmt:v=>v==null?'–':(v>0?'+':'')+n(v,2)+'%',      color:v=>cls(v), hd:true },
  { key:'medianRotPct', label:'median trade',       fmt:v=>v==null?'–':(v>0?'+':'')+n(v,2)+'%',      color:v=>cls(v) },
  { key:'sdRotPct',     label:'sd of trade return', fmt:v=>v==null?'–':n(v,2)+'%' },
  { key:'winRate',      label:'win rate',           fmt:v=>pct(v) },
];
function bookTabs(bks){
  const bar=$('bookTabs');
  // Rendered from the payload, never spliced into the HTML template: the labels are operator
  // config and change without a deploy, and a placeholder in the template goes stale silently.
  const tabs=bks.map(b=>'<button type="button" data-book="'+esc(b.id)+'">'+esc(b.id)+'</button>');
  if(bks.length>1)tabs.push('<button type="button" data-book="vs">A vs B</button>');
  const html=tabs.join('');
  if(bar.dataset.built!==html){bar.innerHTML=html;bar.dataset.built=html;}
  // With one book there is nothing to switch between, so the bar would be one dead button.
  bar.hidden=bks.length<2;
  if(bks.length<2&&chartBook){chartBook='';localStorage.removeItem('snipe.book');}
  const active=chartBook||bks[0].id;
  [...bar.querySelectorAll('button[data-book]')].forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.book===active)));
}
$('bookTabs').addEventListener('click',e=>{
  const b=e.target.closest('button[data-book]'); if(!b||!b.dataset.book)return;
  const bks=(lastState&&lastState.books)||[];
  // book 0 is stored as '' so the URL stays the default one and a renamed book 0 cannot
  // strand the page on a name the server will refuse.
  chartBook=(bks[0]&&b.dataset.book===bks[0].id)?'':b.dataset.book;
  if(chartBook)localStorage.setItem('snipe.book',chartBook);else localStorage.removeItem('snipe.book');
  bookTabs(bks); tickChart();
});
function renderBooks(s){
  const bks=s.books||[];
  $('bookCard').hidden=!bks.length;
  if(!bks.length)return;
  bookTabs(bks);
  const d=s.delta||{};
  // The unattributed count is part of the note, not a footnote: with two books configured
  // every closed trade older than the cutover belongs to neither, so the book columns do not
  // add up to the wallet card above and the page has to say where the difference went.
  const orphans=s.unattributedTrades||0;
  const orphanNote=orphans?' '+orphans+' closed trades predate the split and belong to neither book; books start their accounting at the cutover.':'';
  // The basis, said out loud. This table is one query partitioned per book; Rolling
  // performance above is cash-basis over the wallet (bookedWindow, different filters), so the
  // two counts for the same window do not tie and a reader comparing them deserves to know
  // why rather than concluding one of them is broken.
  const basis=' Closed trades over 7 days, one query per book. Rolling performance above is cash basis and wallet-wide, so the two will not tie.';
  set($('bookNote'),(bks.length<2
    ? 'One book configured. A second one is a BOOKS line in .env and its own money decision.'
    : (d.ready?'Difference is '+d.a+' minus '+d.b+', over 7 days.'
      :'Difference held back: '+(d.why||'not enough closed trades')+'. '+d.minN+' a side is the gate.')+orphanNote)+basis);
  $('bookStrip').innerHTML=bks.map(b=>{
    const t=b.trades||{},g=b.guard;
    // Zero closed trades is "nothing happened", never "broke even". The wallet KPI table has
    // dimmed n=0 columns for the same reason since 2026-09-12.
    const none=!t.n;
    return '<div class="bookTile"><div class="bname"><span>'+esc(b.id)+'</span><span class="bband">'+esc(b.band)+'</span></div>'
      +'<div class="bbig '+(none?'mut':cls(t.pnlUsd))+'">'+(none?'–':usd(t.pnlUsd))+'</div>'
      +'<div class="brow"><span>closed · 7d</span><span>'+(t.n||0)+'</span></div>'
      +'<div class="brow"><span>return on turnover</span><span class="'+cls(t.rotPct)+'">'+(t.rotPct==null?'–':(t.rotPct>0?'+':'')+n(t.rotPct,2)+'%')+'</span></div>'
      +'<div class="brow"><span>median · sd · n</span><span>'+(t.medianRotPct==null?'–':n(t.medianRotPct,2)+'%')+' · '+(t.sdRotPct==null?'–':n(t.sdRotPct,2)+'%')+' · '+(t.n||0)+'</span></div>'
      +'<div class="brow"><span>guard</span><span>'+(g?esc(g.state||'–')+' · '+(g.sum==null?'–':sgn(g.sum))+' stakes':'no tape yet')+'</span></div>'
      +'<button type="button" disabled title="'+esc(b.controlWhy||'')+'">PAUSE BOOK</button></div>';
  }).join('');
  // The comparison table. One partition of one query per book, so every cell in a column
  // comes from the same population; the wallet KPI table above mixes two queries by design
  // and printing its median beside its mean would be dishonest.
  const two=bks.slice(0,2);
  const wide=two.length>1;
  $('bookKpiHead').innerHTML='<tr><th>metric</th>'+two.map(b=>'<th>'+esc(b.id)+'</th>').join('')
    +(wide?'<th class="'+(d.ready?'':'dim')+'">difference</th>':'')+'</tr>';
  $('bookKpiBody').innerHTML=BOOK_ROWS.map(r=>{
    const cells=two.map(b=>{
      const t=b.trades||{},v=t[r.key];
      // same rule as the tile above and as the wallet KPI table: n=0 dims every other row
      const none=!t.n&&r.key!=='n';
      return '<td class="'+(none?'mut':(r.color?r.color(v):''))+(r.hd?' hd':'')+'">'+(none?'–':r.fmt(v))+'</td>';
    }).join('');
    let diff='';
    if(wide){
      const v=d.ready?d[r.key]:null;
      // Greyed, and a dash rather than a number. "not enough evidence" and "no difference"
      // are different answers and must not render as the same cell.
      diff='<td class="'+(d.ready?(r.color?r.color(v):''):'dim')+'">'+(d.ready&&v!=null?(v>0?'+':'')+n(v,2)+(r.key==='n'?'':'%'):'–')+'</td>';
    }
    return '<tr><td>'+r.label+'</td>'+cells+diff+'</tr>';
  }).join('');
  // The post-band funnel. Wallet-level rejects stay in the Details block whole: most of those
  // buckets fire at the book screen before any band is read, so they belong to no book.
  $('bookRejects').innerHTML=bks.map(b=>{
    const rj=b.rejects||{buckets:{},n:0,entered:0};
    const rows=Object.keys(rj.buckets).map(k=>[k,rj.buckets[k]]).sort((x,y)=>y[1]-x[1]);
    rows.unshift(['entered',rj.entered||0]);
    // Width is the share of the DENOMINATOR, not of the largest bucket. Scaled to the max,
    // the biggest bucket always drew full width whatever its real share, so a 73% bucket and
    // a 100% bucket were the same bar and the bar disagreed with the number beside it.
    return '<h3>'+esc(b.id)+' · what happened after the band</h3><p class="rnote">'+esc(rj.note||'')+'</p>'
      +(rj.n?rows.map(r=>'<div class="rbar'+(r[0]==='entered'?' ok':'')+'"><span class="rlab">'+esc(r[0])+'</span>'
        +'<span class="rtrack"><i style="width:'+(100*r[1]/rj.n).toFixed(1)+'%"></i></span>'
        +'<span class="rn">'+r[1]+' · '+Math.round(100*r[1]/rj.n)+'%</span></div>').join('')
        :'<p class="rnote">No launches in this band in the last 24 hours.</p>');
  }).join('');
}

let metricsExpanded=localStorage.getItem('snipe.moreMetrics')==='1';
function renderKpis(ws){
  const cols = PAGE_WINDOWS.map(l => (ws||[]).find(w => w.label===l)).filter(Boolean);
  if(!cols.length){ $('kpiBody').innerHTML = '<tr><td colspan="4" class="empty">waiting for trades…</td></tr>'; return; }
  $('moreMetrics').textContent=metricsExpanded?'Fewer metrics':'More metrics';$('moreMetrics').setAttribute('aria-expanded',String(metricsExpanded));
  $('kpiBody').innerHTML = KPI_ROWS.filter(r=>metricsExpanded||['n','pnlUsd','rotPct','winRate'].includes(r.key)).map(r =>
    '<tr'+(r.sep?' class="sep"':'')+'><td>'+r.label+'</td>' + cols.map(w => {
      const v = w[r.key];
      // n=0 must read as "nothing happened", never as a zero result
      const dim = w.n===0 && r.key!=='n' && !(r.key==='pnlUsd'&&w.attempts>0);
      return '<td class="'+(dim?'mut':r.color(v))+(r.hd?' hd':'')+'">'+(dim?'–':r.fmt(v))+'</td>';
    }).join('') + '</tr>').join('');
}

// ---------- state poll (1s) ----------
let lastState = null, stateConnected = false, stateBusy = false, lastBannerHtml = null;
function amount(id,value,unit,places,tone,signed){
  const el=$(id);set(el,'',tone);
  el.innerHTML=value==null?'Unavailable':(signed&&value>=0?'+':'')+n(value,places)+' <span class="unit">'+unit+'</span>';
}
const plainUsd = v => v==null ? 'Unavailable' : '$'+n(v,2);
const plainEth = v => v==null ? 'Unavailable' : n(v,5)+' ETH';
const ago = v => v==null ? 'age unknown' : v<60000 ? Math.floor(v/1000)+'s ago' : v<3600000 ? Math.floor(v/60000)+'m ago' : n(v/3600000,1)+'h ago';
function disconnected(message){
  stateConnected=false;set($('tradingState'),'Status unavailable','mut');
  set($('sub'),message,'bad');
  paintControls((lastState && lastState.risk)||{});
}
// The one sentence that states the market pause: both readings, both thresholds. Every other
// place that used to repeat this (a hidden card, a boilerplate line, legend labels) is gone.
function marketWhy(s){
  const k=s.risk, v=k.venue||{}, mp=s.marketPolicy, op=s.operator;
  const guard=op && op.guards.find(g=>g.id==='venue');
  if(v.observerError) return 'Market evidence temporarily unavailable.';
  if(!v.fresh) return 'Waiting for complete fresh market evidence'+(mp&&v.n!=null?' ('+v.n+' / '+mp.window+' outcomes).':'.');
  if(!mp) return 'Waiting for market recovery.';
  if(mp.source==='conservative-paper')return 'Main '+mp.window+': <b>'+(v.sumRange?.map(x=>sgn(x)).join(' to ')??'unavailable')+'</b> stakes. Latest '+mp.recoveryWindow+': <b>'+(v.recentSumRange?.map(x=>sgn(x)).join(' to ')??'unavailable')+'</b> stakes.'
    +' Pause if any scenario falls below '+n(mp.pauseBelow,2)+'. Recover only with new evidence and every scenario '+(mp.recoveryMode==='full'?'above '+sgn(mp.fullRecoverAbove)+' in the main window':'above '+sgn(mp.recoverAbove)+' in the fresh window'+(mp.recoveryMode==='fresh'?'':', and above '+sgn(mp.fullRecoverAbove)+' in the main window'))+'.';
  const main=guard&&guard.reading!=null?guard.reading:v.sum;
  const recent=mp.source==='adaptive-shadow'?v.recentSum:v.sum;
  return 'Market: last '+mp.window+' outcomes <b class="'+cls(main)+'">'+sgn(main)+'</b> stakes, pause below <b>'+n(mp.pauseBelow,2)+'</b>.'
    +' Resumes when the latest '+mp.recoveryWindow+' clear <b>'+sgn(mp.recoverAbove)+'</b>'
    +(recent!=null?', now <b class="'+cls(recent)+'">'+sgn(recent)+'</b>.':'.');
}
async function tick(){
  if(stateBusy)return;
  stateBusy=true;
  let s;
  try {
    const response=await fetch('/api/state'+location.search,{cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('State unavailable');
    s=await response.json();
    if(s.error||!s.risk)throw new Error(s.error||'State unavailable');
  } catch { disconnected('Connection lost. Last received values are shown.');return; }
  finally { stateBusy=false; }
  lastState=s;
  stateConnected=!!s.at && Date.now()-s.at<((s.levels||{}).stateStaleMs||10000);
  const k=s.risk,op=s.operator,tv=s.truth||{},mp=s.marketPolicy,market=op && op.guards.find(g=>g.id==='venue');
  const md=$('mode');md.textContent=s.testFixture?'UI TEST FIXTURE':s.preview?'READ-ONLY SNAPSHOT':s.live?'LIVE MODE':String(s.mode).toUpperCase();md.className='modebadge';
  set($('sub'),stateConnected?s.preview?'Captured '+new Date(s.capturedAt).toLocaleString('en-GB',{timeZone:'UTC'})+' UTC':'Live · updated '+ago(Math.max(0,Date.now()-s.at))+' · UTC':'Connection stale. Last received values are shown.',stateConnected?'mut':'bad');
  const stopped=op && op.blockers.length===1 && op.blockers[0].kind==='stopped';
  // THE HEADLINE ANSWERS ONE QUESTION: are we trading or not. Until 2026-09-13 it named the
  // MODE ('Auto enabled'), which reads as good news while entries are held by a stop, and on
  // a phone that is the whole of what an operator sees. The mode, the status and the
  // blockers all still appear, one line down, where they qualify the answer instead of
  // standing in for it.
  const halted=k && k.halted;
  const label=!stateConnected||!op?'Status unavailable'
    :stopped?'STOPPED BY YOU'
    :halted?'HALTED — '+(k.haltKind||'unknown')
    :'TRADING';
  set($('tradingState'),label,!stateConnected||!op?'mut':halted||stopped?'bad':'ok');
  // the mode the headline used to show, kept as the qualifier it always was
  const mode=!op?'':op.status==='enabled'?'Automatic operation enabled.':op.status==='waiting'?'Waiting for entry.':op.status==='paused'?'Automatically paused.':op.status==='needs-you'?'Action needed.':'';
  // the blockers, each once. the specific follow-ups (what RESUME AUTO checks, where the
  // drawdown recovery is written up) stay; the generic "resumes when stops clear" does not.
  const follow=!op||!op.blockers.length?'':stopped?'RESUME AUTO checks recovery before trading.':op.recovery?(!op.recovery.checks.find(c=>c.id==='allowance').ok?'Automatic recovery allowance exhausted.':'Recovery conditions are under Drawdown left.'):k.autoResumes?'':'Manual action required.';
  $('tradingWhy').innerHTML=!op?'Waiting for operator status.':op.blockers.length
    ?op.blockers.map(b=>'<span class="blocker">'+(b.kind==='stopped'?'Stopped by you':b.kind==='venue'?marketWhy(s):esc(shortError(b.reason)))+'</span>').join('')+(follow?'<span class="blocker">'+esc(follow)+'</span>':'')
    :'<span class="blocker">'+esc(mode||'Waiting for qualifying launches.')+'</span>'
     +(op.status==='waiting'&&op.why?'<span class="blocker">'+esc(op.why)+'</span>':'');
  renderOutcomes(s,mp);
  set($('lastTrade'),s.minsSinceTrade==null?'Not recorded':n(s.minsSinceTrade,0)+' min ago');
  set($('openNow'),String(k.open)+' / '+k.maxConcurrent);
  set($('tradeSize'),k.tradeSizeEth==null?'Unavailable':n(k.tradeSizeEth,3)+' ETH');set($('tradeSizeUsd'),k.tradeSizeUsd==null?'':plainUsd(k.tradeSizeUsd));
  paintControls(k);
  const fresh=stateConnected && !k.venue?.observerError && k.venue?.verified!==false && market && market.reading!=null && Number.isFinite(market.reading) && market.status!=='unknown';
  const recent=mp?.source==='adaptive-shadow'?k.venue?.recentSum:k.venue?.sum;
  set($('mainPlotTitle'),'Market Indicator');
  $('mainPlotValue').innerHTML=fresh?'<b class="'+cls(market.reading)+'">'+sgn(market.reading)+'</b> trade sizes':chartData?.market?.at(-1)?.diagnostic?'Simulated scores':'No fresh signal';
  set($('marketNote'),mp?mp.source==='conservative-paper'?'Main '+mp.window+' below '+n(mp.pauseBelow,2)+' in any scenario pauses. New evidence and all scenarios '+(mp.recoveryMode==='full'?'main above '+sgn(mp.fullRecoverAbove):'fresh above '+sgn(mp.recoverAbove)+(mp.recoveryMode==='both'?' and main above '+sgn(mp.fullRecoverAbove):''))+' required to recover.':'Pause below '+n(mp.pauseBelow,2)+' · allow trading again above '+sgn(mp.recoverAbove)+'. One trade size is the amount used for one buy.'+(mp.source==='adaptive-shadow'?' Purple: latest '+mp.recoveryWindow+' coins'+(fresh&&recent!=null?' ('+sgn(recent)+')':'')+'.':''):'Waiting for market settings.');
  // drawdown: remaining is the headline, the bar is the percentage, one row says used-of-limit
  const ddPct=k.drawdownLimitEth>0&&k.drawdownEth!=null?100*k.drawdownEth/k.drawdownLimitEth:null;
  const ddTone=ddPct==null?'mut':ddPct>=(s.levels||{}).ddCritPct?'bad':ddPct>=(s.levels||{}).ddWarnPct?'warn':'';
  amount('dd',k.drawdownLimitEth==null?null:Math.max(0,k.drawdownLimitEth-k.drawdownEth),'ETH',4,ddTone);
  set($('ddUsd'),k.drawdownLimitUsd==null?'Unavailable':plainUsd(Math.max(0,k.drawdownLimitUsd-k.drawdownUsd)));
  const progress=ddPct==null?0:Math.min(100,Math.max(0,ddPct));
  $('ddBar').style.width=progress+'%';$('ddBar').style.background=ddTone==='bad'?css('--bad'):ddTone==='warn'?css('--warn'):css('--accent');
  $('ddProgress').setAttribute('aria-valuenow',String(progress));$('ddProgress').setAttribute('aria-valuetext',ddPct==null?'Unavailable':n(ddPct,1)+'% used');$('ddProgress').title=ddPct==null?'':n(ddPct,1)+'% of the allowance used';
  set($('ddUsed'),k.drawdownEth==null||k.drawdownLimitEth==null?'Unavailable':n(k.drawdownEth,4)+' of '+n(k.drawdownLimitEth,4)+' ETH',ddTone);
  $('ddUsed').title=k.drawdownUsd==null?'':plainUsd(k.drawdownUsd)+' of '+plainUsd(k.drawdownLimitUsd);
  const recovery=op && op.recovery;$('recoveryInfo').hidden=!recovery;
  if(recovery){
    set($('recoverySummary'),'Recovery · '+recovery.n+'/'+recovery.required+' scored');
    $('recoveryDetail').innerHTML='<p>'+n(recovery.sum,2)+' stakes · '+(recovery.complete?'complete window':'partial evidence')+'</p><ul class="recovery-checks">'+recovery.checks.map(c=>'<li class="'+(c.ok?'ok':'warn')+'">'+(c.ok?'✓ ':'○ ')+esc(c.label)+'</li>').join('')+'</ul><p>'+(recovery.canClear?'Eligible to clear on the next guard evaluation.':'Waiting for every condition above.')+'</p>'+(recovery.remainingBlockers.length?'<p>Other stops still apply: '+esc(recovery.remainingBlockers.join(', '))+'.</p>':'')+(recovery.lastError?'<p class="bad">'+esc(recovery.lastError)+'</p>':'')+'<p>'+esc(recovery.note)+'</p>'+(!recovery.checks.find(c=>c.id==='allowance').ok?'<p>Allowance resets '+new Date(recovery.budgetResetAt).toLocaleString('en-GB',{timeZone:'UTC'})+'. Other conditions must still pass.</p>':'');
  }
  // account: one number. the breakdown row appears only while something is open, because the
  // bot is flat for all but ~30 s of a trade and "wallet 0.42316 / open 0.00000" twice was noise.
  amount('eqNow',tv.netWorthEth,'ETH',5,'');set($('cashUsd'),plainUsd(tv.netWorthUsd));
  const openMark=tv.openMarkEth!=null&&tv.openMarkEth>0;
  $('acctOpen').hidden=!openMark;$('acctWallet').hidden=!openMark;
  if(openMark){set($('acctOpenLabel'),'In '+k.open+' open position'+(k.open===1?'':'s'));set($('acctOpenValue'),plainEth(tv.openMarkEth));set($('acctWalletValue'),plainEth(tv.walletEth));}
  const since=tv.baselineAt?new Date(tv.baselineAt).toLocaleString('en-GB',{timeZone:'UTC'}):null;
  set($('eqDelta'),tv.pnlSinceBaselineUsd==null?'No baseline recorded.':usd(tv.pnlSinceBaselineUsd)+' account change since '+since+' UTC.',cls(tv.pnlSinceBaselineUsd));
  set($('walletFreshness'),'Balance read '+ago(tv.lastBalanceAt?Date.now()-tv.lastBalanceAt:null)+'. ETH price '+plainUsd(tv.priceUsd)+' ('+(tv.priceSource||'unknown source')+'), '+ago(tv.priceAgeMs)+'.');
  const banner=(s.bannerAlerts||[]).filter(a=>['bookdrift','model','stuck','parked','config','config-restart','feed','logs','balance-stale','price-stale','disk','memory'].includes(a.id)),critical=banner.some(a=>a.severity==='crit');
  $('banner').hidden=!banner.length;$('banner').className=critical?'crit':'warning';
  set($('bannerHd'),critical?'ACTION NEEDED':'CHECK THIS');
  const bannerHtml=banner.map(a=>'<li>'+esc(a.id==='bookdrift'?'Tracked prices disagreed with the chain. Review execution diagnostics.':shortError(a.message))+'</li>').join('');
  if(lastBannerHtml!==bannerHtml){$('bannerList').innerHTML=bannerHtml;lastBannerHtml=bannerHtml;}
  // notices addressed to the old market card land on the strip, which now owns the market state
  const noticeCard=a=>a.card==='market'?'trading':a.card;
  for(const card of ['trading','wallet']){
    $(card+'Notices').innerHTML=(s.notices||[]).filter(a=>noticeCard(a)===card&&!banner.some(b=>b.id===a.id)).map(a=>'<p class="'+(a.severity==='crit'?'bad':'warn')+'">'+esc(a.id==='bookdrift'?'Tracked prices disagreed with the chain. Review execution diagnostics.':shortError(a.message))+'</p>').join('');
  }
  document.title=(!stateConnected||critical?'(!) ':banner.length?'(?) ':'')+'Pons sniper';
  const cash=s.money?.today;
  set($('todayPnl'),cash?usd(cash.bookUsd):'Unavailable',cls(cash?.bookUsd));set($('todayEth'),cash?eth(cash.bookEth):'');
  set($('todayTrades'),cash?cash.n+' trades · '+(cash.winPct==null?'win rate unavailable':n(cash.winPct,0)+'% wins'):'No accounting evidence');
  set($('executionStatus'),k.broken?'Execution monitor: '+k.broken.n+' matched trades':'Execution monitor: insufficient evidence');
  set($('technicalDetails'),(s.alerts||[]).map(a=>a.msg).join('\n\n'));
  renderKpis(s.kpis);
  renderBooks(s);

  // positions: the card exists only while something is open
  const pb = $('posBody');
  $('posCard').hidden = !s.positions.length;
  pb.innerHTML = s.positions.map(x => {
    const w = Math.min(100, x.ageMs / x.capMs * 100);
    const mc = x.estimatedReturnEth==null?'mut':cls(x.estimatedReturnEth);
    const sc = x.state==='stuck'?'bad':x.state==='holding'?'':'warn';
    return '<tr><td class="mut">'+hhmmss(Date.now()-x.ageMs)+'</td>'
      +'<td><a href="'+x.tokenUrl+'" target="_blank" rel="noopener">'+x.token.slice(0,12)+'…</a> · <a class="sm" href="'+x.curveUrl+'" target="_blank" rel="noopener">curve</a></td>'
      +'<td>'+(x.ageMs/1000).toFixed(0)+'s</td>'
      +'<td><div class="bar"><i style="width:'+w+'%"></i></div></td>'
      +'<td class="'+mc+'">'+x.multiple.toFixed(2)+'×</td>'
      +'<td class="mut">'+(x.takeProfit==null?'Unavailable':x.takeProfit.toFixed(2)+'×')+(x.takeProfit!=null&&x.multiple>=x.takeProfit?' · reached':'')+'</td>'
      +'<td>'+eth(x.estimatedReturnEth,5)+'<small class="mut"> before gas</small></td>'
      +'<td class="'+(x.supplyLeft<0.2?'bad':x.supplyLeft<0.4?'warn':'mut')+'">'+(x.supplyLeft*100).toFixed(0)+'%</td>'
      +'<td><span class="pill '+sc+'">'+x.state+'</span></td></tr>';
  }).join('');

  renderRecent(s);

  $('foot').innerHTML = s.wallet ? '<a href="'+s.explorer+'/address/'+s.wallet+'" target="_blank" rel="noopener">wallet '+s.wallet.slice(0,10)+'…</a>' : '';
}

// Built to a string first and only written when it actually differs. tick() runs at 1Hz
// but these are CLOSED trades, so the table changes when one exits (16 in the last six
// hours) and is otherwise identical. Reassigning innerHTML anyway reparsed ~14 KB and
// rebuilt 240 cells every second, and it dropped any text selection you had in the table
// - which you notice the moment you try to copy a token address out of it. Comparing the
// finished string is exact, so a backfill flipping verified on an old row still lands.
let lastRecentHtml = null;
function renderRecent(s){
  const rb = $('recBody');
  let html;
  if(!s.recent.length){ html = '<tr><td colspan="12" class="empty">nothing closed yet</td></tr>'; }
  else html = s.recent.map((x,i) => {
    const dollars=x.pnl==null||s.truth?.priceUsd==null?null:x.pnl*s.truth.priceUsd;
    const peak = x.peak_mult || 0, ex = x.exitMult;
    // The denominator is the run that was THERE, not the part we stayed for. peak_mult
    // stops when we sell, so scoring capture against it flatters every take-profit to
    // ~100% by construction. max() guards the entry-basis difference between the two.
    const avail = x.truePeak!=null ? Math.max(x.truePeak, peak) : peak;
    // how much of it we kept. 1.00 means we sold the top, 0 means we gave it all back
    const capt = (avail>1 && ex!=null) ? Math.max(0, Math.min(1, (ex-1)/(avail-1))) : null;
    // what the exit rule actually cost on this trade
    const left = (x.truePeak!=null && ex!=null) ? x.truePeak-ex : null;
    const name = (x.symbol || x.name)
      ? '<span class="sym">'+esc(x.symbol || x.name)+'</span>'
          + (x.name && x.symbol && x.name!==x.symbol ? ' <span class="nm" hidden>'+esc(x.name)+'</span>' : '')
      : '<span class="mut">'+x.token.slice(0,10)+'…</span>';
    const rc = x.exit_reason==='tp' ? 'ok' : x.exit_reason==='stop' ? 'bad' : 'mut';
    return '<tr class="hd" tabindex="0" aria-expanded="'+(openRow===i)+'" data-i="'+i+'">'
      +'<td class="mut" title="'+(x.exitAt==null?'':new Date(x.exitAt).toISOString())+'">'+hhmm(x.exitAt)+'</td>'
      +'<td><a href="'+x.tradeUrl+'" title="'+esc(x.name||x.symbol||x.token)+'" target="_blank" rel="noopener">'+name+'</a></td>'
      +'<td class="n pnl-cell '+cls(x.pnl)+'"><strong>'+usd(dollars)+'</strong><small>'+(x.pnl==null?'Unavailable':eth(x.pnl,5))+'</small></td>'
      +'<td class="'+rc+'">'+esc(x.exit_reason)+'</td>'
      +'<td>'+(x.hold_ms/1000).toFixed(0)+'s</td>'
      +'<td class="n mut">'+(x.takeProfit==null?'–':x.takeProfit.toFixed(2))+'</td>'
      +'<td class="n '+(left==null?'mut':left>0.10?'warn':'')+'"'
        +(left==null?'':' title="left '+left.toFixed(3)+'× on the table after we sold"')+'>'
        +(x.truePeak==null?'–':x.truePeak.toFixed(2)+'×')+'</td>'
      +'<td class="n '+(ex==null?'mut':ex>=1?'ok':'bad')+'">'+(ex==null?'–':ex.toFixed(2)+'×')+'</td>'
      +'<td style="width:80px">'+(capt==null?'' :
          '<div class="capt" title="kept '+(100*capt).toFixed(0)+'% of the run to '+avail.toFixed(2)+'×">'
          +'<u style="width:100%"></u>'
          +'<b style="width:'+(100*capt).toFixed(0)+'%;background:'+(capt>=0.7?'var(--ok)':capt>=0.3?'var(--warn)':'var(--bad)')+'"></b></div>')
      +'</td>'
      +'<td class="n mut">'+(x.devBuyEth==null?'–':x.devBuyEth.toFixed(3))+'</td>'
      +'<td class="n mut">'+(x.exemptions==null?'–':x.exemptions)+'</td>'
      +'<td class="sm mut">'+(openRow===i?'&#9662;':'&#9656;')+'</td>'
      +'</tr>'
      + (openRow===i ? detailRow(x) : '');
  }).join('');
  if (html !== lastRecentHtml){ rb.innerHTML = html; lastRecentHtml = html; }
}

// ---------- recent exits: one row expands to everything we recorded ----------
// Twenty-odd fields per trade will not fit in a scannable table, and most of them only
// matter once a specific trade looks wrong. So the table stays narrow and the detail is
// one click away. The take profit became a schedule over the venue's gate rate on
// 2026-08-19, so which rung a trade opened on is no longer derivable from config and a
// 1.26x exit is a banked win on one rung and a missed clock exit on another. Keep the
// empty-state colspan in step with the column count.
let openRow = null;
$('recBody').addEventListener('click', e => {
  if (e.target.closest('a')) return;          // links still work
  const tr = e.target.closest('tr.hd'); if(!tr) return;
  const i = Number(tr.dataset.i);
  openRow = (openRow === i) ? null : i;
  if (lastState) renderRecent(lastState);
});

$('recBody').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){const row=e.target.closest('tr.hd');if(row){e.preventDefault();row.click();}}});

const pc = (v,d=2) => v==null ? '–' : (v>=0?'+':'')+ (100*v).toFixed(d)+'%';
// one key/value line, shared by the expanded trade detail and the chart tooltip
const dr = (k,v,cls) => '<div class="r"><span>'+k+'</span><span class="'+(cls||'')+'">'+v+'</span></div>';
const grp = (title, rows) => '<div class="g"><h4>'+title+'</h4>'+rows.join('')+'</div>';
function detailRow(x){
  // the book's own bounds, never the page's copy of them
  const pol = (lastState && lastState.policy) || {};
  const tok = x.tokens!=null ? (x.tokens/1e24).toFixed(2)+'B' : '–';
  const lo = (x.truePeak!=null && x.exitMult!=null) ? x.truePeak-x.exitMult : null;
  // entry impact IS the depth reading: how far our own stake moved this curve. The size is
  // whatever the position was opened at, which is why it is not written down here.
  const depth = x.entryImpact;
  const g1 = grp('Entry', [
    dr('opened', x.exitAt==null||x.hold_ms==null?'–':hhmmss(x.exitAt-x.hold_ms)+' UTC', 'mut'),
    dr('size in', (x.spend/1e18).toFixed(5)+' ETH'),
    dr('tokens', tok),
    dr('curve depth (our impact)', pc(depth), depth==null?'mut':depth>-0.02?'ok':depth>-0.05?'warn':'bad'),
    dr('fill vs slippage floor', pc(x.fillVsFloor), x.fillVsFloor==null?'mut':x.fillVsFloor>=0?'ok':'bad'),
    dr('landed', x.fillLagBlocks==null?'–':'+'+x.fillLagBlocks+' blocks'),
  ]);
  const g2 = grp('Exit', [
    dr('reason', esc(x.exit_reason)),
    dr('held', (x.hold_ms/1000).toFixed(1)+' s'),
    dr('peak while held / exit', (x.peak_mult||0).toFixed(3)+'&times; / '+(x.exitMult==null?'–':x.exitMult.toFixed(3)+'&times;')),
    dr('Max __GATE_HOLD_S__s (any holder)', x.truePeak==null?'–':x.truePeak.toFixed(3)+'&times;'),
    dr('left after we sold', lo==null?'–':(lo>0?'+':'')+lo.toFixed(3)+'&times;', lo==null?'mut':lo>0.10?'warn':'ok'),
    dr('proceeds', x.proceeds==null?'–':(x.proceeds/1e18).toFixed(5)+' ETH'),
    dr('vs local quote', pc(x.exitVsQuote), x.exitVsQuote==null?'mut':x.exitVsQuote>=0?'ok':'bad'),
  ]);
  // Which book opened the row. Shown only once a second book is configured: before that
  // every row is the one book and the label is noise in every detail panel.
  const books = (lastState && lastState.books) || [];
  const g3 = grp('The launch', [
    books.length>1 ? dr('book', esc(x.book||'unattributed'), 'mut') : '',
    dr('dev buy', x.devBuyEth==null?'–':x.devBuyEth.toFixed(4)+' ETH'),
    dr('exempt wallets', x.exemptions==null?'–':String(x.exemptions), (x.exemptions||0)>=(pol.minExemptionsToEnter||3)?'ok':'bad'),
    dr('creator tax', x.creator_tax_bps==null?'–':x.creator_tax_bps+' bps'),
    dr('prior launches', x.prior_launches==null?'–':String(x.prior_launches), (x.prior_launches||0)<=(pol.maxPriorLaunches!=null?pol.maxPriorLaunches:3)?'ok':'warn'),
    dr('pitch', [x.has_twitter?'twitter':null, x.has_website?'website':null].filter(Boolean).join(' + ') || 'none', 'mut'),
  ]);
  const g4 = grp('Money &amp; timing', [
    dr('P&L', usd(x.pnl==null||lastState?.truth?.priceUsd==null?null:x.pnl*lastState.truth.priceUsd)+' / '+eth(x.pnl,6), cls(x.pnl)),
    dr('gas', x.gasEth==null?'–':x.gasEth.toFixed(6)+' ETH', 'mut'),
    dr('modeled vs on-chain', x.modeledPnl==null?'–':(x.modeledPnl.toFixed(6)+' / '+x.pnl.toFixed(6)),
       x.verified?'ok':'warn'),
    dr('detect &rarr; decide', x.detectToDecideMs==null?'–':x.detectToDecideMs+' ms', 'mut'),
    dr('decide &rarr; sent', x.decideToSentMs==null?'–':x.decideToSentMs+' ms', 'mut'),
  ]);
  const links = '<div class="lk">'
    + '<a href="'+x.tradeUrl+'" target="_blank" rel="noopener">chart</a>'
    + '<a href="'+x.tokenUrl+'" target="_blank" rel="noopener">token</a>'
    + '<a href="'+x.curveUrl+'" target="_blank" rel="noopener">curve</a>'
    + (x.buyUrl?'<a href="'+x.buyUrl+'" target="_blank" rel="noopener">buy tx</a>':'')
    + (x.sellUrl?'<a href="'+x.sellUrl+'" target="_blank" rel="noopener">sell tx</a>':'')
    + '<span class="mut">'+esc(x.token)+'</span>'
    + '</div>';
  return '<tr><td class="det" colspan="12"><div class="box">'+g1+g2+g3+g4+'</div>'+links+'</td></tr>';
}

// ---------- chart (5s, own cadence because it is the expensive half) ----------
// Four uPlot panes sharing one x-axis: money, the two market signals, then the coins. They
// are separate instances rather than one chart because the series have unrelated x arrays
// (balance samples, decision times, launch buckets) and uPlot wants one shared x per
// instance. Cursor and zoom are stitched back together below.
//
// The coins pane is why the first rewrite happened. On 2026-08-19 the bot sat idle for
// 2h20m and answering "quiet venue or broken bot" took a database session, because the page
// plotted neither launch volume nor what the filters did with it. Since 2026-09-12 the same
// pane also carries the simulated outcome of every coin that passed: the stack is counts by
// outcome, the strip under it is the bucket's net return in stakes. The fixed touch-multiple
// test that used to colour these bars is gone from the page; the regime gate still uses it.
const MONO = css('--mono') || 'monospace';
// Bottom to top, and the order is the point: wins and losses sit on the baseline so the eye
// can compare them without measuring. Pending rides above them, and the grey mass of coins
// the strategy never took sits on top where it reads as volume rather than as detail. The
// order is FIXED so a red/green colour-blind reader can still tell the two apart by place.
const SEG = [
  ['win',      (u) => css('--ok')],
  ['loss',     (u) => css('--bad')],
  ['pending',  (u) => hatch(u)],
  ['flat', (u) => css('--accent')],
  ['notSimulated', (u) => css('--muted')],
  ['filtered', (u) => css('--rule2')],
];
// Unestimated passes stay visible when rejected coins are hidden.
const segVal = (b,k) => b[k]||0;
let HATCH = null;
function hatch(u){
  if (HATCH) return HATCH;
  const R = pr(u), c = document.createElement('canvas'); c.width = c.height = Math.max(4, Math.round(6*R));
  const g = c.getContext('2d');
  g.fillStyle = css('--panel2'); g.fillRect(0,0,c.width,c.height);
  g.strokeStyle = css('--muted'); g.lineWidth = 1.2*R; g.beginPath(); g.moveTo(0,c.height); g.lineTo(c.width,0); g.stroke();
  HATCH = u.ctx.createPattern(c, 'repeat');
  return HATCH;
}

// Show passed coins by default. Unestimated passes have their own visible segment.
const savedHidden = localStorage.getItem('snipe.chartHidden.v2');
let hidden = new Set((savedHidden==null?'filtered':savedHidden).split(',').filter(Boolean));
const shown = b => SEG.reduce((a,s) => a + (hidden.has(s[0]) ? 0 : segVal(b,s[0])), 0);

let lookback = localStorage.getItem('snipe.lookback') || '4h';
let chartData = null;
let charts = null;
let userZoomed = false;
let syncing = false;
const mouse = { x: 0, y: 0 };

function selSync(){ [...document.querySelectorAll('#seg button[data-h]')].forEach(b => b.setAttribute('aria-pressed', String(b.dataset.h===lookback))); }
$('seg').addEventListener('click', e => {
  const b = e.target.closest('button');
  // the zoom chip lives in this container too and carries no data-h; without this guard
  // clicking it sets lookback to undefined and every later fetch 404s
  if(!b || !b.dataset.h) return;
  lookback = b.dataset.h; userZoomed=false; localStorage.setItem('snipe.lookback', lookback);
  selSync(); tickChart();   // aborts whatever is in flight; a click is never queued behind a poll
});
$('zoomchip').addEventListener('click', () => resetZoom());
function lgdSync(){
  document.querySelectorAll('#lgd button[data-seg],#lgd button[data-line]').forEach(b=>{const k=b.dataset.seg||b.dataset.line;b.setAttribute('aria-pressed',String(!hidden.has(k)));});
}
$('lgd').addEventListener('click', e => {
  const b = e.target.closest('button[data-seg],button[data-line]'); if(!b) return;
  const k = b.dataset.seg || b.dataset.line;
  if (hidden.has(k)) hidden.delete(k); else hidden.add(k);
  localStorage.setItem('snipe.chartHidden.v2', [...hidden].join(','));
  lgdSync();
  render();   // the n scale is built from the VISIBLE sum, so this has to redraw
});

// Seven days of history does not change every five seconds, and rebuilding it that often
// blocks the trading process. The server memo uses this same table.
const CHART_POLL_MS={'1h':5000,'4h':5000,'12h':10000,'24h':15000,'3d':30000,'7d':60000};
let chartAbort=null,chartTimer=null,chartInFlight=false;
// Last payload per lookback, so going 7d then back to 4h paints from memory while the
// refresh is still in the air. The chart is history: a few seconds stale is the normal state
// of every lookback above 1h anyway, and the request that follows corrects it.
const chartSeen={};
function scheduleChart(){
  if(chartTimer)clearTimeout(chartTimer);
  // The in-flight check is what keeps this from recursing where setTimeout runs its callback
  // synchronously, which is exactly what the smoke harness does.
  chartTimer=setTimeout(()=>{chartTimer=null;if(!chartInFlight)tickChart();},CHART_POLL_MS[lookback]||5000);
}
async function tickChart(){
  // A lookback click used to be dropped when a poll was in flight, which on 7d meant waiting
  // out the whole 4s request and then the next tick. Cancel the old one and go.
  if(chartAbort)chartAbort.abort();
  const control=new AbortController();chartAbort=control;chartInFlight=true;
  // AbortSignal.timeout rather than a setTimeout: it is the deadline, and it survives a page
  // whose timers are stubbed. Combined with the controller so a click still cancels at once.
  const deadline=AbortSignal.timeout(10000);
  const signal=AbortSignal.any?AbortSignal.any([control.signal,deadline]):control.signal;
  const requested=lookback,askedBook=chartBook;
  // Keyed on the lookback AND the book. It was the lookback alone, which was right while a
  // payload was identified by its lookback; switching books would now paint the other book's
  // cached data first and label it with this book's name.
  const seenKey=requested+'|'+askedBook;
  const stale=()=>requested!==lookback||askedBook!==chartBook;
  // Paint the last payload for this lookback straight away. Without it the panes sat on the
  // PREVIOUS lookback's data, at the previous x range, with nothing saying anything was
  // loading, for as long as the request took.
  if(chartSeen[seenKey]&&(!chartData||chartData.lookback!==requested||(chartData.book||'')!==(chartSeen[seenKey].book||''))){chartData=chartSeen[seenKey];render();}
  try {
    const q=new URLSearchParams(location.search);if(askedBook)q.set('book',askedBook);
    const response=await fetch('/api/chart?h='+encodeURIComponent(requested)+'&'+q.toString(),{cache:'no-store',signal});
    if(!response.ok)throw new Error('Chart unavailable');
    const data=await response.json();if(data.error)throw new Error(data.error);
    chartSeen[seenKey]=data;
    if(stale())return;
    chartData=data;render();
  }catch(e){ if(control.signal.aborted&&stale())return;
    $('chartnote').textContent='Chart connection lost. Last received history is shown.'; }
  finally{
    // Only the newest request owns the schedule; an aborted one leaves it to its replacement.
    // chartInFlight clears last so a synchronous timer cannot re-enter through scheduleChart.
    if(chartAbort===control){chartAbort=null;scheduleChart();chartInFlight=false;}
  }
}

// Two books' STEP series on one x axis. uPlot takes one x array per pane and the books close
// at their own times, so the union of both timestamps is the only honest grid. A step series
// carries its last value forward, and a null carries forward as a null, which is the gap the
// book is actually in; interpolating across it would invent a line neither book drew.
function alignSteps(lists,field){
  const seen={};for(const p of lists)for(const r of p)seen[r.t]=1;
  const xs=Object.keys(seen).map(Number).sort((a,b)=>a-b);
  const ys=lists.map(p=>{let i=0,last=null;return xs.map(t=>{while(i<p.length&&p[i].t<=t){last=p[i][field];i++;}return last==null?null:last;});});
  return [xs.map(t=>t/1000)].concat(ys);
}

// ---- lookups the tooltip and the dot layer share ----
const buckets = () => (chartData && chartData.outcomes && chartData.outcomes.buckets) || [];
function netAt(t){
  const p = chartData && chartData.wallet; if(!p || !p.length) return null;
  if (t < p[0].t || t > p[p.length-1].t) return null;
  for (let i=1;i<p.length;i++) if (p[i].t>=t) {
    const a=p[i-1], b=p[i], fr=(t-a.t)/Math.max(1,b.t-a.t);
    return a.eth+(b.eth-a.eth)*fr;
  }
  return p[p.length-1].eth;
}
// Month-to-date simulated P&L at t. A step series, not an interpolated one: the total
// changes when a modelled position closes and is flat between closes, so reading between
// two points must return the earlier total, never a blend of the two.
function paperAt(t){
  const p = chartData && chartData.paper && chartData.paper.points; if(!p || !p.length) return null;
  if (t < p[0].t || t > p[p.length-1].t) return null;
  const r = lastAtOrBefore(p,t);
  return r ? r.eth : null;
}
// The last entry at or before t. These run on every mousemove across four panes; scanning
// from index 0 made hover cost grow with the lookback.
function lastAtOrBefore(rows,t){
  let lo=0,hi=rows.length-1,found=-1;
  while(lo<=hi){const mid=(lo+hi)>>1;if(rows[mid].t<=t){found=mid;lo=mid+1;}else hi=mid-1;}
  return found<0?null:rows[found];
}
// The server sends ONE market series, already the right one for the mode the bot is in, so
// there is no mode branch here any more. The tooltip reads the same array the line draws
// from, which is the only way the two cannot disagree.
function marketAt(t){
  const rows=chartData&&chartData.market;if(!rows || !rows.length)return null;
  if(t>rows[rows.length-1].t)return null;
  const out=lastAtOrBefore(rows,t);
  return out;
}
function bucketAt(t){
  const bs = buckets(); if(!bs.length) return null;
  const w = chartData.bucketMs;
  const b = lastAtOrBefore(bs,t);
  return b && t<b.t+w ? b : null;
}

// ---- the x range every pane is pinned to ----
// The requested time range stays fixed even when a pane has less recorded history.
function fullRange(){ return [chartData.from/1000,chartData.to/1000]; }

// ---- shared canvas layers ----
const pr = u => u.ctx.canvas.width / u.width;
function clipPlot(u){
  u.ctx.save();
  u.ctx.beginPath();
  u.ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
  u.ctx.clip();
}
// Only sampled stops are shaded, and only on the account pane: the money is what a stop
// protects, and painting the same band on four panes said the same thing four times.
// Missing history does not imply trading was enabled.
function drawBands(u){
  const cd = chartData; if(!cd || hidden.has('halts')) return;
  const ctx = u.ctx, R = pr(u);
  clipPlot(u);
  const paint = (iv, fill) => {
    const a = Math.max(cd.from, iv.from), b = Math.min(cd.to, iv.to==null?cd.to:iv.to);
    if (b<=a) return;
    const x0 = u.valToPos(a/1000,'x',true), x1 = u.valToPos(b/1000,'x',true);
    ctx.fillStyle = fill;
    ctx.fillRect(x0, u.bbox.top, Math.max(R, x1-x0), u.bbox.height);
  };
  (cd.recordedHalts||[]).forEach(iv => paint(iv, iv.kinds?.includes('drawdown')?css('--bad')+'28':iv.kinds?.includes('venue')?'rgba(220,170,45,.15)':css('--muted')+'18'));
  ctx.restore();
}
// One dot per closed trade, area by size, ring for a take-profit. The only place the SHAPE
// of the edge is visible: a few fat greens beside a crowd of small reds is a different
// business from an even drizzle, and no average on this page can tell those apart.
function drawTrades(u){
  const cd = chartData; if(!cd || !cd.trades || !cd.trades.length) return;
  if(!cd.wallet || cd.wallet.length<2) return;
  const ctx = u.ctx, R = pr(u);
  clipPlot(u);
  // Cached per payload: this ran on every draw of every pane, spreading the whole trades
  // array (732 of them over 7d) into Math.max each time.
  if(cd.__big===undefined){let m=0.01;for(const t of cd.trades){const v=Math.abs(t.usd);if(v>m)m=v;}cd.__big=m;}
  const big = cd.__big;
  for (const td of cd.trades){
    const x = u.valToPos(td.t/1000,'x',true);
    if (x < u.bbox.left-20*R || x > u.bbox.left+u.bbox.width+20*R) continue;
    const n = netAt(td.t); if (n==null) continue;
    const y = u.valToPos(n,'y',true);
    const r = (2+4*Math.sqrt(Math.min(1,Math.abs(td.usd)/big)))*R;
    const c = td.usd>=0 ? css('--ok') : css('--bad');
    ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fillStyle=c+'cc'; ctx.fill();
    if (td.r==='tp'){ ctx.beginPath(); ctx.arc(x,y,r+2.5*R,0,Math.PI*2); ctx.strokeStyle=c; ctx.lineWidth=R; ctx.stroke(); }
  }
  ctx.restore();
}
// Hours the BOT PROCESS was down, shaded on the paper pane only. It is a different claim
// from the halt bands on the account pane: halted means the bot chose not to trade and the
// simulated account kept scoring; down means nothing was recorded at all, and a flat line
// there is absence of evidence rather than a quiet market.
function drawDark(u){
  const cd = chartData; if(!cd || !cd.paper || hidden.has('dark')) return;
  const spans = cd.paper.dark || []; if(!spans.length) return;
  const ctx = u.ctx, R = pr(u);
  clipPlot(u);
  ctx.fillStyle = css('--muted')+'26';
  for (const sp of spans){
    const a = Math.max(cd.from, sp[0]), b = Math.min(cd.to, sp[1]);
    if (b<=a) continue;
    const x0 = u.valToPos(a/1000,'x',true), x1 = u.valToPos(b/1000,'x',true);
    ctx.fillRect(x0, u.bbox.top, Math.max(R, x1-x0), u.bbox.height);
  }
  ctx.restore();
}
// One tick per policy or kernel version, at its first launch. Deliberately unlabelled: the
// tooltip names the seam, and four words of canvas text at 400px wide is unreadable anyway.
function drawSeams(u){
  const cd = chartData; if(!cd || !cd.paper) return;
  const seams = cd.paper.seams || []; if(!seams.length) return;
  const ctx = u.ctx, R = pr(u);
  clipPlot(u);
  ctx.strokeStyle = css('--rule2'); ctx.lineWidth = R; ctx.setLineDash([3*R,3*R]);
  for (const t of seams){
    if (t<cd.from || t>cd.to) continue;
    const x = Math.round(u.valToPos(t/1000,'x',true))+0.5*R;
    ctx.beginPath(); ctx.moveTo(x,u.bbox.top); ctx.lineTo(x,u.bbox.top+u.bbox.height); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}
// zero line plus the pane's own threshold: pause on the market pane, recover on the recovery
// pane. The threshold is named in the pane title, so it needs no legend entry.
function drawMarketMissing(u){
  const cd=chartData;if(!cd)return;
  const rows=cd.market||[],key='sum';
  const ctx=u.ctx;clipPlot(u);ctx.fillStyle=css('--muted')+'18';
  const shade=(a,b)=>{if(b<=a)return;const x=u.valToPos(a/1000,'x',true),end=u.valToPos(b/1000,'x',true);ctx.fillRect(x,u.bbox.top,end-x,u.bbox.height);};
  shade(cd.from,rows.length?rows[0].t:cd.to);
  for(let i=0;i<rows.length;i++)if(rows[i][key]==null)shade(rows[i].t,rows[i+1]?.t??cd.to);
  if(rows.length)shade(rows[rows.length-1].t,cd.to);
  ctx.restore();
}
function drawPaperCoverage(u){
  const cd=chartData,points=cd?.paper?.points||[];if(!cd)return;
  clipPlot(u);u.ctx.fillStyle=css('--muted')+'18';
  const shade=(a,b)=>{const lo=Math.max(cd.from,a),hi=Math.min(cd.to,b);if(hi>lo)u.ctx.fillRect(u.valToPos(lo/1000,'x',true),u.bbox.top,u.valToPos(hi/1000,'x',true)-u.valToPos(lo/1000,'x',true),u.bbox.height);};
  if(!points.length)shade(cd.from,cd.to);
  else {shade(cd.from,points[0].t);for(let i=0;i<points.length;i++)if(points[i].eth==null)shade(points[i].t,points[i+1]?.t??cd.to);}
  u.ctx.restore();
}
function drawGuides(u){
  const ctx=u.ctx,R=pr(u),y=u.valToPos(0,'p',true);
  clipPlot(u);ctx.strokeStyle=css('--muted')+'66';ctx.lineWidth=R;ctx.setLineDash([3*R,4*R]);
  ctx.beginPath();ctx.moveTo(u.bbox.left,y);ctx.lineTo(u.bbox.left+u.bbox.width,y);ctx.stroke();
  const policy=lastState?.marketPolicy;
  if(policy)for(const [value,color] of [[policy.pauseBelow,css('--bad')],[policy.recoveryMode==='full'?null:policy.recoverAbove,css('--ok')],[policy.recoveryMode==='fresh'?null:policy.fullRecoverAbove,css('--rec')]]){
    if(value==null)continue;
    const y=u.valToPos(value,'p',true);ctx.strokeStyle=color;ctx.setLineDash([5*R,5*R]);ctx.beginPath();ctx.moveTo(u.bbox.left,y);ctx.lineTo(u.bbox.left+u.bbox.width,y);ctx.stroke();
  }
  ctx.setLineDash([]);ctx.restore();
}
// Stack order is FIXED, never sorted by size per bucket: a stack that reorders itself is
// unreadable across time, which is the only axis that matters here.
function drawBars(u){
  const cd = chartData; const bs = buckets();
  if (!bs.length) return;
  const ctx = u.ctx, R = pr(u);
  clipPlot(u);
  // Width is CLAMPED IN PIXELS, not left as a fraction of the slot. A slot is
  // (plot width / bucket count), and that ranges from ~25px at 1h with 44 buckets to
  // ~110px at 7d with 9, so a pure fraction draws slivers at one end and slabs at the
  // other, and drag-zoom makes it worse in both directions. Clamping gives the same bar
  // everywhere and lets the gaps carry the spacing instead.
  const x0 = u.valToPos(bs[0].t/1000,'x',true);
  const x1 = u.valToPos((bs[0].t+cd.bucketMs)/1000,'x',true);
  const bw = Math.min(Math.max(1.5*R, (x1-x0)*0.55), 11*R);
  const half = (x1-x0)/2;
  for (const b of bs){
    // centred on the bucket's MIDPOINT, since b.t is its start and the bar no longer
    // fills the slot; left-aligning a thin bar puts it a half-slot away from its own data
    const cx = u.valToPos(b.t/1000,'x',true) + half - bw/2;
    if (cx < u.bbox.left-bw || cx > u.bbox.left+u.bbox.width+bw) continue;
    let acc = 0;
    for (const s of SEG){
      if (hidden.has(s[0])) continue;
      const v = segVal(b, s[0]);
      if (v<=0) continue;
      const yt = u.valToPos(acc+v,'n',true), yb = u.valToPos(acc,'n',true);
      // a one-pixel gap between segments so two adjacent colours never read as one block
      const h = yb-yt, gap = h > 3*R ? R : 0;
      ctx.fillStyle = s[1](u);
      ctx.fillRect(cx, yt+gap, bw, Math.max(R, h-gap));
      acc += v;
    }
  }
  ctx.restore();
  if (!hidden.has('net')) drawStrip(u, bs);
}
// The net simulated return per bucket, as a diverging colour strip under the bars: green for
// a bucket the strategy would have made money in, red for one it would have lost in, the
// depth of the colour is the size. Counts above, money below, one axis. The number itself is
// in the tooltip. Buckets with nothing simulated stay grey; pending-only buckets are hatched.
function drawStrip(u, bs){
  const cd = chartData, ctx = u.ctx, R = pr(u);
  const top = u.bbox.top + u.bbox.height + 5*R, h = 8*R;
  const slot = u.valToPos((bs[0].t+cd.bucketMs)/1000,'x',true) - u.valToPos(bs[0].t/1000,'x',true);
  const byT = new Map(bs.map(b => [b.t, b]));
  ctx.save();
  ctx.beginPath(); ctx.rect(u.bbox.left, top, u.bbox.width, h); ctx.clip();
  const start = Math.floor(cd.from/cd.bucketMs)*cd.bucketMs;
  for (let t = start; t < cd.to; t += cd.bucketMs){
    const b = byT.get(t);
    const x = u.valToPos(t/1000,'x',true) + R, w = Math.max(R, slot-2*R);
    let fill = css('--rule2'), alpha = 1;
    if (b && b.net==null && b.pending && !b.win && !b.loss && !b.flat) fill = hatch(u);
    else if (b && b.net!=null && Math.abs(b.net) >= 0.05){
      fill = b.net > 0 ? css('--ok') : css('--bad');
      alpha = 0.35 + 0.65*Math.min(1, Math.abs(b.net)/1.6);
    }
    ctx.globalAlpha = alpha; ctx.fillStyle = fill; ctx.fillRect(x, top, w, h);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  ctx.save();
  ctx.fillStyle = css('--muted'); ctx.font = (10*R)+'px '+MONO; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('return', u.bbox.left - 8*R, top + h - R);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.font = (9*R)+'px '+MONO;
  const labelEvery=Math.max(1,Math.ceil(28*R/slot));
  for(let i=0;i<bs.length;i++){
    const b=bs[i];
    if(b.net==null || !b.n || i%labelEvery!==0) continue;
    const x=u.valToPos((b.t+cd.bucketMs/2)/1000,'x',true);
    if(x<u.bbox.left||x>u.bbox.left+u.bbox.width) continue;
    ctx.fillStyle=b.net>0?css('--ok'):b.net<0?css('--bad'):css('--muted');
    ctx.fillText((b.net>0?'+':'')+b.net.toFixed(slot>=34*R?2:1),x,top+h+3*R);
  }
  ctx.restore();
}

// ---- zoom, kept in step across the panes ----
// heights live here and nowhere else: buildCharts and the ResizeObserver both read them,
// and when they were written out twice, editing one left resize drawing the old geometry
const PANE_H = { wallet:185, paper:185, venue:175, volume:235 };
const PANE_KEYS = ['wallet','paper','venue','volume'];
function panes(){ return charts ? PANE_KEYS.map(k => charts[k]) : []; }
function onXScale(u){
  if (syncing) return;
  syncing = true;
  const mn = u.scales.x.min, mx = u.scales.x.max;
  for (const p of panes()) if (p!==u) p.setScale('x', {min:mn, max:mx});
  syncing = false;
  const fr = fullRange();
  userZoomed = mn > fr[0]+1 || mx < fr[1]-1;
  $('zoomchip').style.display = userZoomed ? 'inline-block' : 'none';
}
function resetZoom(){
  if (!charts || !chartData) return;
  const fr = fullRange();
  syncing = true;
  for (const p of panes()) p.setScale('x', {min:fr[0], max:fr[1]});
  syncing = false;
  userZoomed = false;
  $('zoomchip').style.display = 'none';
}

// ---- tooltip ----
// uPlot ships none on purpose. Hand-rolled because it should answer more than "what is
// this number": it carries the market reading, the recorded stop state and the outcome
// split at the cursor, which is the whole diagnostic in one hover.
$('panes').addEventListener('mousemove', e => {
  const r = $('panes').getBoundingClientRect();
  mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
});
$('panes').addEventListener('mouseleave', () => { $('tip').style.display = 'none'; });

function paintTip(t){
  const cd = chartData; if(!cd) return;
  const tip = $('tip');
  const d = new Date(t);
  let h = '<div class="t">'+d.toLocaleTimeString('en-GB',{timeZone:'UTC'})+' UTC</div>';

  const nw = netAt(t);
  if (nw!=null){
    const base = cd.wallet[0].eth;
    h += dr('account history', nw.toFixed(6)+' ETH');
    h += dr('since window start', (nw-base>=0?'+':'')+(nw-base).toFixed(6), cls(nw-base));
  }
  const pw = paperAt(t);
  if (pw!=null){
    h += dr('paper estimate', (pw>=0?'+':'')+pw.toFixed(6)+' ETH', cls(pw));
    const sm = (cd.paper&&cd.paper.seams||[]).filter(x=>Math.abs(x-t)<=(cd.bucketMs||300000));
    const segment=cd.paper?.segments?.find(s=>t>=s.from&&t<=s.through);
    if(segment)h+=dr('paper segment starts',new Date(segment.from).toISOString().slice(0,19).replace('T',' ')+' UTC','mut');
    if (sm.length) h += dr('policy changed here', '', 'mut');
  }
  const v=marketAt(t);
  h+=dr('Main '+(v?.window??lastState?.marketPolicy?.window??15),v?.sum!=null?sgn(v.sum)+' stakes':'History unavailable',v?.sum!=null?cls(v.sum):'mut');
  if((cd.marketSource==='adaptive-shadow'||cd.marketSource==='conservative-paper'))h+=dr('Fresh '+(v?.recoveryWindow??lastState?.marketPolicy?.recoveryWindow??8),v?.recentSum!=null?sgn(v.recentSum)+' trade sizes':'History unavailable',v?.recentSum!=null?cls(v.recentSum):'mut');
  if(v){
    h+=dr('evidence',esc(v.reason==='selector_unresolved_execution'?'Last published scores; next simulation pending':v.reason||'published')+(v.verified?' · verified':' · unverified'),'mut');
    for(const score of v.scenarios||[]){h+=dr(esc(score.id),'Main '+n(score.sum,2)+' / Fresh '+n(score.recentSum,2)+(score.fresh?'':' · incomplete'),'mut');if(score.id==='p50-after'&&score.mainIds)h+=dr('p50 contributing coins',score.mainIds.map(i=>esc((cd.contributorTokens?.[i]||'unknown').slice(0,8))).join(', '),'mut');}
    h+=dr('sample time',new Date(v.t).toLocaleTimeString('en-GB',{timeZone:'UTC'}),'mut');
    if(v.sum!=null&&(v.sumSource??v.source)==='reconstructed')h+=dr('market source','Reconstructed shared-engine decisions','mut');
    if(v.recentSum!=null&&(v.recentSource??v.source)==='reconstructed')h+=dr('recovery source','Reconstructed shared-engine decisions','mut');
    if(v.pauseBelow!=null&&v.resumeAbove!=null)h+=dr('thresholds then',n(v.pauseBelow,2)+' / '+n(v.resumeAbove,2)+' stakes','mut');
  }
  const recorded=(cd.recordedStates||[]).findLast(iv=>t>=iv.from&&t<=iv.to);
  h+=dr('recorded stops',!recorded?'Unknown':recorded.kinds.length?esc(recorded.kinds.join(', ')):'None recorded',recorded && recorded.kinds.length?'warn':'mut');
  const b = bucketAt(t);
  if (b){
    h += '<hr>';
    const rate = b.total ? 100*b.passed/b.total : 0;
    h += dr('coins launched', String(b.total));
    h += dr('passed filters', b.passed+'  ('+rate.toFixed(0)+'%)', b.passed?'ok':'mut');
    h += dr('simulated win / loss / flat', b.win+' / '+b.loss+' / '+b.flat);
    if (b.pending) h += dr('pending', String(b.pending), 'warn');
    if (b.notSimulated) h += dr('passed, not simulated', String(b.notSimulated), 'mut');
    if (b.reconstructed) h += dr('rebuilt from observations', String(b.reconstructed), 'mut');
    h += dr('positive', sgn(b.pos)+' stakes', b.pos>0?'ok':'mut');
    h += dr('negative', n(b.neg,2)+' stakes', b.neg<0?'bad':'mut');
    h += dr('net', b.net==null?'Unavailable':sgn(b.net)+' stakes', b.net==null?'mut':cls(b.net));
    if (b.configs && b.configs.length>1) h += dr('policy versions', String(b.configs.length), 'mut');
  }

  const coins=(cd.outcomes?.coins||[]).filter(c=>b&&c.at>=b.t&&c.at<b.t+cd.bucketMs);
  const coin=coins.reduce((best,c)=>!best||Math.abs(c.at-t)<Math.abs(best.at-t)?c:best,null);
  if(coin){
    h+='<hr>'+dr('coin',esc(coin.token.slice(0,12))+'…');
    h+=dr('shadow p50-after',coin.value==null?'Unavailable: '+esc(coin.reason):sgn(coin.value)+' stakes');
    h+=dr('simulated admission',esc(coin.admission.status)+' · '+esc(coin.admission.reason));
    h+=dr('actual entry',esc(coin.actual.status)+' · '+esc(coin.actual.reason||''));
    h+=dr('indicator evidence',coin.indicatorEvidence?'Included':'Not in published shadow account','mut');
    h+=dr('launch',new Date(coin.at).toISOString().slice(11,19)+' UTC','mut');
    h+=dr('closure',coin.exitAt?new Date(coin.exitAt).toISOString().slice(11,19)+' UTC':'Unavailable','mut');
    h+=dr('publication',coin.availableAt?new Date(coin.availableAt).toISOString().slice(11,19)+' UTC':'Unavailable','mut');
  }
  // the nearest trade, but only when the cursor is actually near one
  let near = null, bestD = 30_000;
  for (const td of (cd.trades||[])){
    if(td.usd==null)continue;
    const dd = Math.abs(td.t - t);
    if (dd < bestD){ bestD = dd; near = td; }
  }
  if (near){
    h += '<hr>';
    h += dr(near.token ? near.token.slice(0,10)+'…' : 'trade', near.r, 'mut');
    h += dr('P&L', usd(near.usd), cls(near.usd));
    if (near.holdMs) h += dr('held', (near.holdMs/1000).toFixed(0)+'s', 'mut');
  }
  tip.innerHTML = h;
  tip.style.display = 'block';
  const w = tip.offsetWidth, ph = $('panes').clientWidth;
  tip.style.left = Math.max(4,Math.min(mouse.x+14, ph-w-4))+'px';
  tip.style.top = (mouse.y+14)+'px';
}
function onCursor(u){
  const L = u.cursor.left;
  if (L==null || L<0){ $('tip').style.display='none'; return; }
  paintTip(u.posToVal(L,'x')*1000);
}

let inspectedTime=null;
$('panes').addEventListener('keydown',e=>{
  if(e.target!==$('panes')||!charts||!chartData)return;
  if(e.key==='Escape'){$('tip').style.display='none';return;}
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
  e.preventDefault();
  const p=charts.wallet,lo=p.scales.x.min*1000,hi=p.scales.x.max*1000;
  inspectedTime=Math.max(lo,Math.min(hi,e.key==='Home'?lo:e.key==='End'?hi:(inspectedTime??hi)+(e.key==='ArrowLeft'?-1:1)*chartData.bucketMs));
  const left=p.valToPos(inspectedTime/1000,'x');
  const r=p.over.getBoundingClientRect(),container=$('panes').getBoundingClientRect();
  mouse.x=r.left-container.left+left;mouse.y=r.top-container.top;
  $('tip').setAttribute('aria-live','polite');
  p.setCursor({left,top:0});paintTip(inspectedTime);
});
$('panes').addEventListener('pointermove',()=>{$('tip').setAttribute('aria-live','off');});

// ---- construction ----
const AX = () => ({ stroke: css('--muted'), font: '12px '+MONO,
  grid: { show:true, stroke: css('--rule'), width:1 },
  ticks: { show:true, stroke: css('--rule'), width:1, size:4 } });
// x axis with grid but no labels, for the panes that are not the bottom one
const XMUTE = () => Object.assign(AX(), { scale:'x', side:2, size:0, gap:0,
  ticks:{show:false}, values: (u,sp) => sp.map(()=>null) });

function mkPane(el, height, opts){
  // Build the merged opts WITHOUT mutating a shared base. Object.assign(base, opts)
  // overwrites base.hooks with the caller's, so reading base.hooks.drawClear afterwards
  // hits undefined and no pane ever constructs. The bands layer belongs to the account
  // pane only; the draw layer is per-pane; they must not clobber each other.
  const oh = opts.hooks || {};
  const o = Object.assign({
    width: $('panes').clientWidth, height: height,
    legend: { show: false },
    cursor: { sync: { key:'snipe', scales:['x',null] }, drag:{x:true,y:false,setScale:true}, points:{show:false} },
  }, opts);
  o.hooks = {
    drawClear: (opts.bands ? [drawBands] : []).concat(oh.drawClear || []),
    draw: (oh.draw || []).slice(),
    setScale: [(u,k)=>{ if(k==='x') onXScale(u); }],
    setCursor: [onCursor],
  };
  delete o.bands;
  return new uPlot(Object.assign(o,{tzDate:ts=>uPlot.tzDate(new Date(ts*1000),'UTC')}), o.series.map(()=>[]), el);
}

function buildCharts(){
  charts = {};
  charts.wallet = mkPane($('paneWallet'), PANE_H.wallet, {
    bands: true,
    padding:[8,46,0,0],
    scales: { x:{time:true}, y:{ range: (u,lo,hi) => {
      if (!isFinite(lo)||!isFinite(hi)) return [0,1];
      if (hi-lo < 1e-9) return [lo-0.0005, hi+0.0005];
      const p=(hi-lo)*0.15; return [lo-p, hi+p];
    } } },
    axes: [ XMUTE(), Object.assign(AX(), { scale:'y', side:3, size:64,
      values: (u,vs) => vs.map(v => v==null?null:v.toFixed(5)) }) ],
    // a function, not a colour: uPlot normalises series.stroke into stroke(u, idx) and
    // calls it on every draw, so assigning a string over it later throws. Reading the
    // direction here also means the colour follows the data with nothing to keep in sync.
    series: [ {}, { scale:'y', width:1.75, points:{show:false}, stroke: () => {
      const w = (chartData && chartData.wallet) || [];
      return w.length>1 && w[w.length-1].eth >= w[0].eth ? css('--ok') : css('--bad');
    } } ],
    hooks: { draw: [drawTrades] },
  });
  // The simulated account, month to date. Its own pane rather than a second line on the one
  // above: that pane is chain truth and this one is a replay, and drawing them on one scale
  // invites reading the gap as a wallet balance.
  charts.paper = mkPane($('panePaper'), PANE_H.paper, {
    padding:[8,46,0,0],
    // Fitted to the data, exactly like the account pane above, and deliberately NOT forced
    // to include zero. A 1h view sits at +0.34 and moves 0.01; padding out to zero would
    // draw that hour as a flat line and throw away the only thing the lookback is for. The
    // sign is carried by the axis labels and by the stroke colour instead.
    scales: { x:{time:true}, y:{ range: (u,lo,hi) => {
      if (!isFinite(lo)||!isFinite(hi)) return [-0.001,0.001];
      if (hi-lo < 1e-9) return [lo-0.0005, hi+0.0005];
      const p=(hi-lo)*0.15; return [lo-p, hi+p];
    } } },
    axes: [ XMUTE(), Object.assign(AX(), { scale:'y', side:3, size:64,
      values: (u,vs) => vs.map(v => v==null?null:v.toFixed(4)) }) ],
    // same contract as the account pane: a stroke FUNCTION, never a colour assigned later.
    // Coloured on the sign, not on the direction, because zero is what a month starts from.
    // stepped, because a month-to-date total holds flat between closes and jumps at one.
    // It is also what paperAt() reads, so the line and the tooltip cannot disagree.
    // series[1] is THE paper line in both modes and keeps spanGaps:false (asserted by
    // alignment.browser.mjs). series[2] exists only for the A-vs-B tab and is fed all-null
    // otherwise; uPlot fixes its series list at construction, so the slot has to be here.
    series: [ {}, { scale:'y', width:1.75, spanGaps:false, points:{show:false},
      paths:uPlot.paths.stepped({align:1}), stroke: () => {
      const p = (chartData && chartData.paper && chartData.paper.points) || [];
      return p.length && p[p.length-1].eth < 0 ? css('--bad') : css('--ok');
    } },
      { scale:'y', width:1.75, spanGaps:false, points:{show:false},
        paths:uPlot.paths.stepped({align:1}), stroke: () => css('--rec') } ],
    hooks: { drawClear:[drawPaperCoverage,drawDark], draw:[drawSeams] },
  });
  charts.venue=mkPane($('paneVenue'),PANE_H.venue,{
    padding:[8,46,0,0],
    scales:{x:{time:true},p:{range:(u,lo,hi)=>{
      const policy=lastState?.marketPolicy;
      const a=Math.min(lo??0,policy?.pauseBelow??0,policy?.recoverAbove??0,(policy?.recoveryMode==='fresh'?0:policy?.fullRecoverAbove)??0,0),b=Math.max(hi??0,policy?.pauseBelow??0,policy?.recoverAbove??0,(policy?.recoveryMode==='fresh'?0:policy?.fullRecoverAbove)??0,0),pad=Math.max(.25,(b-a)*.15);
      return [a-pad,b+pad];
    }}},
    axes:[XMUTE(),Object.assign(AX(),{scale:'p',side:3,size:64,values:(u,vs)=>vs.map(v=>v==null?null:v.toFixed(1))})],
    series:[{},
      {scale:'p',paths:uPlot.paths.stepped({align:1}),stroke:css('--accent'),width:2,spanGaps:false,points:{show:false}},
      {scale:'p',paths:uPlot.paths.stepped({align:1}),stroke:css('--rec'),width:2,spanGaps:false,points:{show:false}}],
    hooks:{drawClear:[drawMarketMissing],draw:[drawGuides]},
  });
  charts.volume = mkPane($('paneVolume'), PANE_H.volume, {
    padding:[8,46,0,0],
    scales: { x:{time:true}, n:{ range: (u,lo,hi) => [0,Math.max(1,hi*1.12)] } },
    axes: [
      // the gap leaves room for the net-return strip between the plot and the time labels
      Object.assign(AX(), { scale:'x', side:2, size:82, gap:36 }),
      Object.assign(AX(), { scale:'n', side:3, size:64 }),
    ],
    // the bars are drawn by hand in the hook; this series exists only to own the n scale
    series: [ {}, { scale:'n', paths: () => null, points:{show:false} } ],
    hooks: { draw: [drawBars] },
  });
}

let didFocusPrefix=false;
function unavailablePane(key,available,message){
 $('pane'+key).hidden=!available;
 $('empty'+key).hidden=available;
 if(!available)set($('empty'+key),message);
}
function render(){
  const cd = chartData; if(!cd) return;
  if (typeof uPlot === 'undefined'){
    $('chartnote').textContent = 'chart library did not load; everything else on this page is live';
    return;
  }
  if (!charts) buildCharts();

  const dw = [ (cd.wallet||[]).map(p=>p.t/1000), (cd.wallet||[]).map(p=>p.eth) ];
  // ONE series per pane, one array, no holes. Two things used to break this line:
  //   - a resumeAbove == null guard that blanked the sum. It was meant to hide samples
  //     recorded before the guard wrote its thresholds; guard_samples.market_on is null on
  //     900 of 963 rows in a 4h window, so it hid 93% of the Market line instead.
  //   - recorded and rebuilt points riding in two uPlot series, each writing a null into the
  //     other, which turned every handover into a visible break.
  // A sample that carries a number gets drawn. Where it came from is in the tooltip and in
  // the chart note, which is where a caveat belongs; it is not worth losing the line over.
  set($('mainLineLabel'),'Main '+(cd.marketPolicy?.window??lastState?.marketPolicy?.window??15));
  set($('freshLineLabel'),'Fresh '+(cd.marketPolicy?.recoveryWindow??lastState?.marketPolicy?.recoveryWindow??8));
  const market=cd.market||[];
  const dv=[market.map(p=>p.t/1000),market.map(p=>p.sum??null),market.map(p=>p.recentSum??null)];
  const bs = buckets();
  // the scale series carries the VISIBLE sum. Feeding it b.total instead would leave the
  // axis pinned to full height after hiding "filtered", which is the whole point of the
  // toggle: you hide the 90% so the remaining 10% gets the pixels.
  const dn = [bs.map(b=>b.t/1000), bs.map(shown)];

  const w = cd.wallet||[];

  // A zoomed chart must survive the 5s poll, or the view snaps back under your cursor.
  // A chart frozen in the past during live trading is worse than no chart, hence the chip.
  const camera=userZoomed?{min:charts.wallet.scales.x.min,max:charts.wallet.scales.x.max}:null;
  syncing=true;
  // A VS B. Two real lines per pane, because phase 2 gave each book its own guard tape over
  // one shared evidence set; neither is a copy of the other. Only the first two books are
  // drawn, and the note below says so rather than letting a third book vanish silently.
  const vs=chartBook==='vs'&&Array.isArray(cd.compare)&&cd.compare.length>1;
  const cmp=vs?cd.compare.slice(0,2):null;
  // In comparison mode the pane's evidence is the two books' tapes, not cd.market (which is
  // book 0's). Asking the wrong array here hid the pane whenever book 0 was the quiet one.
  // SAY WHICH GUARD THIS IS. The pane draws the scenario tape whatever guard is live, so
  // when another sensor is gating entries the thresholds printed below it are not the ones
  // refusing anything, and a tape that stopped updating must not read as a current opinion.
  const mt=cd.marketTape||{};
  const wrongGuard=mt.representsLiveGuard===false;
  const staleTape=mt.stale===true&&!!mt.lastSampleAt;
  const venueHas=vs?cmp.some(c=>(c.market||[]).some(p=>p.sum!=null)):market.some(p=>p.sum!=null||p.recentSum!=null);
  unavailablePane('Venue',venueHas,'Indicator unavailable: '+(market.at(-1)?.reason||lastState?.activeGuard?.reading?.reason||'waiting for a complete compatible window')+'. Missing evidence is not a zero score.');
  const hd=cd.historicalBackfill;
  $('replayCoverage').hidden=true;
  if(hd)set($('replayCoverage'),'Reconstructed history · '+hd.counts.replayed+' / '+hd.counts.opportunities+' launch replays available. '+hd.counts.unavailable+' unavailable. Gaps are preserved; simulated earnings are not validated.');
  const pp=(cd.paper&&cd.paper.points)||[];
  // THE BOOK LINES STAY OFF THE WALLET PANE, deliberately. The wallet pane is chain truth and
  // has no book dimension; the book lines are booked P&L, and A + B does not equal the wallet
  // (the residual is open positions, gas on reverted sells and unbooked receipts, which
  // truth.unreconciledEth names). Overlaying them would reintroduce exactly the misreading
  // the comment on charts.paper was written about: the gap read as a wallet balance.
  const dp=vs?alignSteps([cmp[0].paper,cmp[1].paper],'eth')
            :[pp.map(p=>p.t/1000),pp.map(p=>p.eth),pp.map(()=>null)];
  const dvs=vs?alignSteps([cmp[0].market,cmp[1].market],'sum')
             :[dv[0],dv[1],(cd.marketSource==='adaptive-shadow'||cd.marketSource==='conservative-paper')?dv[2]:dv[2].map(()=>null)];
  charts.wallet.setData(dw,false);charts.paper.setData(dp,false);charts.venue.setData(dvs,false);charts.volume.setData(dn,false);
  // Coins are per book with different denominators, so there is nothing to compare on one
  // axis. The pane goes away rather than showing book 0's coins under a comparison heading.
  $('volumeTitle').hidden=vs;
  unavailablePane('Volume',!vs,'Coins are counted per book against different denominators, so the comparison tab draws the two paper lines and the two guard tapes instead. Pick a book above to see its coins.');
  // The HEADING, not just the note below: an operator glancing at this pane must not read a
  // tape from an inactive guard, or a frozen one, as the reason entries are on or off.
  set($('mainPlotTitle'),wrongGuard?'Market Indicator · NOT THE LIVE GUARD':staleTape?'Market Indicator · STALE':'Market Indicator',wrongGuard||staleTape?'warn':'');
  if(vs){
    set($('mainLineLabel'),cmp[0].bookId);set($('freshLineLabel'),cmp[1].bookId);
    // The single-book copy below the pane describes Main vs Fresh, which is not what these
    // two lines are. Leaving it would label book B's tape as "the latest 8 coins".
    set($('marketNote'),'Each line is that book\'s own guard tape, lowest score across six scenarios, in stakes. The two books share one evidence set and one set of thresholds; only the entry filter differs.');
  }
  const fr=fullRange(),range=camera||{min:fr[0],max:fr[1]};
  for(const p of panes())p.setScale('x',range);
  syncing=false;
  if(!didFocusPrefix&&cd.paper.coverage?.through&&new URLSearchParams(location.search).get('focus')==='prefix'){
    didFocusPrefix=true;syncing=true;
    range.min=(cd.paper.recordFrom-10000)/1000;range.max=(cd.paper.coverage.through+10000)/1000;
    for(const p of panes())p.setScale('x',range);
    syncing=false;userZoomed=true;
  }
  $('zoomchip').style.display=userZoomed?'inline-block':'none';
  $('panes').dataset.rangeFrom=String(range.min*1000);$('panes').dataset.rangeTo=String(range.max*1000);
  $('panes').dataset.lookback=cd.lookback;
  $('eventHistory').innerHTML=(cd.marketEvents||[]).slice(-30).reverse().map(e=>'<p>'+new Date(e.t).toISOString().slice(11,19)+' UTC · '+esc(e.state)+' · '+esc(e.reason)+(e.policyChanged?' · policy changed':'')+'</p>').join('');

  const pa = cd.paper || {};
  const total=pa.recordedPnlEth??pa.monthToDate;
  const partial=total==null?pp.filter(p=>p.eth!=null).at(-1)?.eth:null;
  const value=total??partial;
  // In comparison mode EITHER book having a line is enough to show the pane. Asking only
  // book 0 hid both lines whenever book 0 was the one with no outcomes yet.
  const hasPaper=vs?cmp.some(c=>(c.paper||[]).some(p=>p.eth!=null)):pp.some(p=>p.eth!=null);
  set($('paperValue'),value==null?'No recorded estimate':(value>=0?'+':'')+value.toFixed(4)+(total==null?' ETH · incomplete history':' ETH · estimated'),value==null?'mut':cls(value));
  $('panePaper').hidden=!hasPaper;$('paperEmpty').hidden=hasPaper;
  const since=pa.recordFrom?new Date(Math.max(pa.recordFrom,pa.monthStart)).toLocaleDateString('en-GB',{timeZone:'UTC',day:'numeric',month:'short'}):null;
  set($('paperNote'),vs
    ?'Cumulative paper P&L per book · '+cmp[0].bookId+' '+(cmp[0].n||0)+' outcomes · '+cmp[1].bookId+' '+(cmp[1].n||0)+' outcomes'+(cd.compare.length>2?' · '+(cd.compare.length-2)+' further book(s) not drawn':'')
    :'p50-after · '+(pa.n||0)+' trades · no market or DD stop'+(pa.segments?.length>1?' · separate account segments':''));
  if(!hasPaper)set($('paperEmpty'),pa.unavailable?'Paper results could not be loaded. See Details.':'No paper results recorded in this period.');

  const comparison=cd.paperComparison, validation=cd.paperAccounts?.validation;
  const diagnostics=[];
  if(hd)diagnostics.push('Historical coverage: '+new Date(hd.from).toISOString()+' to '+new Date(hd.through).toISOString()+'. '+hd.counts.unavailable+' unavailable replays.');
  if(pa.segments?.length>1)diagnostics.push('Separate known-start paper accounts are displayed across gaps. Their starting balances and losses are not joined.');
  if(pa.coverage)diagnostics.push('Paper coverage: '+JSON.stringify(pa.coverage));
  if(cd.historyError)diagnostics.push('History: '+cd.historyError);
  if(comparison){
    diagnostics.push('Matched '+comparison.matched+' / '+comparison.actualAttempts+' actual attempts · unmatched '+comparison.unmatched);
    diagnostics.push(comparison.matched?'Actual '+comparison.actualEth.toFixed(6)+' ETH · paper '+comparison.paperEth.toFixed(6)+' ETH':'Matched actual and paper cash unavailable');
    diagnostics.push('Failed buys agree '+comparison.failedBuy.agreed+' / '+comparison.failedBuy.n);
    const e=comparison.entryErrorPct;
    if(e.n)diagnostics.push('Entry quantity error: mean '+e.mean.toFixed(2)+'%, median '+e.median.toFixed(2)+'%, sd '+(e.sd==null?'unavailable':e.sd.toFixed(2)+'%')+', n='+e.n);
    for(const row of comparison.largestDiscrepancies.slice(0,3))diagnostics.push('Position '+row.id+': '+row.errorPp.toFixed(2)+' pp error');
  }
  const candidate=cd.paperAccounts?.candidateIndicator;
  if(candidate)diagnostics.push('Scenario indicator: '+(candidate.verified?'verified':'unvalidated')+' · '+candidate.n+' / '+(candidate.policy?.n??20)+' outcomes per scenario · '+candidate.reason);
  if(candidate?.sumRange)diagnostics.push('Main sum '+candidate.sumRange.map(v=>v.toFixed(2)).join(' to ')+' stakes · fresh '+candidate.recentSumRange.map(v=>v.toFixed(2)).join(' to ')+' stakes');
  if(validation)diagnostics.push('Source: '+validation.sourceVerification+' · arithmetic: '+validation.arithmeticVerification+' · historical accuracy: '+validation.historicalAccuracy+' · prospective: '+validation.prospectiveValidation);
  if(pa.unavailable)diagnostics.push('Displayed paper: '+pa.unavailable);
  if(pa.health?.fault)diagnostics.push('Collection: '+pa.health.fault);
  if(pa.health?.missing)diagnostics.push(pa.health.missing+' eligible launches have no recorded simulation');
  diagnostics.unshift('Charts use the shared execution model. Simulated earnings have not passed historical cash fidelity.');
  $('paperDiagnostics').textContent=diagnostics.join(' · ');
  const tot=bs.reduce((a,b)=>a+b.total,0),pas=bs.reduce((a,b)=>a+b.passed,0);
  set($('volumeTotal'),tot.toLocaleString('en-GB')+' seen · '+pas.toLocaleString('en-GB')+' passed'+(tot?' ('+Math.round(100*pas/tot)+'%)':''));
  $('flatLegend').hidden=!bs.some(b=>b.flat);
  const notes=['p50-after · continuous-account outcomes. Grey: no available admitted outcome.'];
  if(!market.length)notes.push('Market history is unavailable in this period.');
  if(!w.length)notes.push('No account samples in this period.');
  // These two go FIRST, because everything after them is qualified by them.
  if(wrongGuard)notes.unshift('This indicator is the '+esc(mt.drawnGuard||'scenario')+' tape. Entries are gated on the '+esc(mt.activeGuard||'other')+' guard right now, so the thresholds under this pane are not the ones refusing trades.');
  if(staleTape)notes.unshift('Indicator tape is STALE: no new sample for '+Math.round((mt.ageMs||0)/60000)+' min. It is not a current reading.');
  $('chartnote').textContent = notes.join('  ·  ');
}

let rzTimer = null;
new ResizeObserver(() => {
  clearTimeout(rzTimer);
  rzTimer = setTimeout(() => {
    if (!charts) return;
    const w = $('panes').clientWidth; if (!w) return;
    for (const k of PANE_KEYS) charts[k].setSize({width:w, height:PANE_H[k]});
  }, 100);
}).observe($('panes'));

selSync();
lgdSync();
/**
 * THE OPERATOR CONTROLS.
 *
 * Three rules, each from a way this could go wrong on a phone at 3am:
 *  - stop fires on the first tap. Someone reaching for stop has already decided.
 *  - start arms on the first tap and fires on the second, within five seconds. It puts
 *    real money back to work, and a mis-tap must not.
 *  - the buttons show their OWN pending state and are disabled while a request is in
 *    flight. The payload is memoised for a second server-side, so a button that trusted
 *    the next poll would sit there looking untouched and invite a second press.
 */
var ctlBusy = false, startArmed = 0, resetArmed = 0;
function paintControls(k) {
  var stop = $('btnStop'), start = $('btnStart'), reset = $('btnReset');
  if (!stop || !start || !reset) return;
  var stopped = (k.haltKinds || []).indexOf('stopped') >= 0;
  stop.disabled = ctlBusy || (stateConnected && stopped) || !!(lastState && lastState.preview);
  stop.textContent = stateConnected && stopped ? 'STOPPED' : 'STOP';
  // Start is offered only when the operator's own stop is the thing holding. A drawdown
  // stop or a broken halt is not theirs to lift from here, and a button that looks live
  // and then refuses is worse than one that is plainly unavailable.
  var mine = stateConnected && !(lastState && lastState.preview) && stopped && k.haltKind === 'stopped';
  start.disabled = ctlBusy || !mine;
  if (startArmed && Date.now() - startArmed > 5000) { startArmed = 0; setCtl(''); }
  start.className = startArmed ? 'armed' : '';
  start.textContent = startArmed ? 'Confirm resume' : 'RESUME AUTO';
  // The drawdown reset. Offered while a drawdown is actually on the clock and the book is
  // flat, which is the epoch boundary's own precondition. 'manual' and 'broken' outrank
  // 'drawdown' and are not the operator's to wave away, so the button goes dead under them
  // rather than looking live and then refusing.
  var ddHeld = k.haltKind !== 'manual' && k.haltKind !== 'broken';
  var mineToReset = stateConnected && !(lastState && lastState.preview)
    && k.open === 0 && ddHeld && k.drawdownEth > 0;
  reset.disabled = ctlBusy || !mineToReset;
  if (resetArmed && Date.now() - resetArmed > 5000) { resetArmed = 0; setCtl(''); }
  reset.className = resetArmed ? 'armed' : '';
  reset.textContent = resetArmed ? 'Confirm reset' : 'RESET DRAWDOWN';
}
/**
 * THE OUTCOME STRIP. The venue sensor's own rows, not a second query: obs is roughly 80%
 * coins the book would never buy, so anything that re-derives this from the raw table will
 * disagree with the guard it is supposed to be explaining. risk.venue.outcomes comes
 * straight off the loop that built the sum (strategy/gate.ts trailingOutcome, and
 * fresh-recovery.ts for the adaptive path), which is why the numbers here always add up to
 * the number beside them.
 */
function renderOutcomes(s, mp) {
  var v = s.risk && s.risk.venue, strip = $('oStrip');
  if (!strip) return;
  if (mp && mp.source === 'conservative-paper') {
    strip.innerHTML = ((v&&v.outcomes)||[]).map(o=>'<div class="ocell '+(o.value>=0?'up':'dn')+'" title="'+esc(o.token)+'"><b>'+sgn(o.value)+'</b><small>'+hhmm(o.launchedAt*1000)+'</small></div>').join('');
    var valid = v && v.fresh && !v.observerError;
    var range = function (values) { return valid && values ? values.map(function (x) { return sgn(x); }).join(' to ') + ' stakes' : 'Unavailable'; };
    set($('oTitle'), 'Market · last ' + mp.window + ' per scenario');
    set($('oSum'), range(v && v.sumRange));
    set($('oRule'), 'Any below ' + n(mp.pauseBelow, 2) + ' pauses' + (mp.recoveryMode === 'fresh' ? '' : '; all above ' + sgn(mp.fullRecoverAbove) + ' required to recover'));
    set($('oRecTitle'), 'Recovery · latest ' + mp.recoveryWindow + ' per scenario');
    set($('oRecovery'), range(v && v.recentSumRange));
    set($('oRecRule'), mp.recoveryMode === 'full' ? 'Recovery uses the main window' : 'All above ' + sgn(mp.recoverAbove) + ' required');
    set($('oNote'), valid ? 'Tiles show p50-after outcomes. Permission requires all six scenarios. New complete evidence required. Adaptive TP is pinned at entry.' : 'Waiting for complete, compatible and verified paper evidence.');
    return;
  }
  var all = (v && v.outcomes) || [];
  if (!all.length) {
    strip.innerHTML = '';
    set($('oSum'), '–', 'mut');
    set($('oRecovery'), '–', 'mut');
    set($('oRule'), ''); set($('oRecRule'), '');
    set($('oNote'), v ? 'The sensor has no scored launches under the book floors yet.' : 'Waiting for a venue reading.');
    return;
  }
  var win = (mp && mp.window) || all.length;
  var recN = (mp && mp.recoveryWindow) || 0;
  // the adaptive path picks its recovery slice by launch time, not by position, so trust
  // recentOutcomes when the sensor supplies it and fall back to "the newest recN" otherwise
  var recTokens = {};
  ((v && v.recentOutcomes) || all.slice(0, recN)).forEach(function (o) { if (o.token) recTokens[o.token] = 1; });
  var seen = 0;
  strip.innerHTML = all.map(function (o, i) {
    var isRec = o.token ? !!recTokens[o.token] : i < recN;
    if (isRec) seen++;
    return '<div class="ocell ' + (o.value >= 0 ? 'up' : 'dn') + (isRec ? ' rec' : '') + '"'
      + ' title="' + esc((o.token || 'unknown').slice(0, 12)) + (o.peak != null ? ' · peak ' + n(o.peak, 2) + 'x' : '') + '">'
      + '<b>' + sgn(o.value) + '</b>'
      + '<small>' + (o.peak != null ? n(o.peak, 2) + 'x' : hhmm(o.launchedAt * 1000)) + '</small>'
      + '</div>';
  }).join('');
  var sum = all.reduce(function (a, o) { return a + o.value; }, 0);
  var wins = all.filter(function (o) { return o.value > 0; }).length;
  // MARKET: the pause side. Reads "is the venue paying at all".
  set($('oTitle'), 'Market · last ' + all.length);
  set($('oSum'), sgn(sum) + ' stakes', cls(sum));
  set($('oRule'), mp ? 'pauses below ' + n(mp.pauseBelow, 2) : '');
  // RECOVERY: the come-back-on side, over a subset of the same launches.
  var recent = v && v.recentSum != null ? v.recentSum : null;
  set($('oRecTitle'), 'Recovery · newest ' + (seen || recN) + ' (marked)');
  set($('oRecovery'), recent != null ? sgn(recent) + ' stakes' : '–', recent != null ? cls(recent) : 'mut');
  set($('oRecRule'), mp ? 'reopens above ' + sgn(mp.recoverAbove) : '');
  set($('oNote'), wins + ' of ' + all.length + ' paid'
    + (all.length < win ? ' · window still filling, ' + all.length + ' of ' + win : '')
    + (v && v.bar ? ' · bar ' + v.bar : '')
    + (v && v.fresh === false ? ' · STALE, not counted as a fresh window' : '')
    + (v && v.fallback ? ' · gatewatch is answering: ' + v.fallback : ''),
    v && v.fallback ? 'warn' : '');
}
function setCtl(msg, bad) {
  var el = $('ctlMsg');
  if (el) { el.textContent = msg || ''; el.className = 'ctlMsg' + (bad ? ' bad' : ''); }
}
async function post(action) {
  ctlBusy = true; paintControls((lastState && lastState.risk)||{});
  setCtl(action === 'stop' ? 'Stopping…' : action === 'reset' ? 'Opening a new accounting epoch…' : 'Checking recovery rules…');
  try {
    var r = await fetch('/api/control', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: action }), cache: 'no-store', signal: AbortSignal.timeout(10000),
    });
    var j = await r.json().catch(function () { return {}; });
    setCtl(j.why || ('http ' + r.status), !r.ok);
  } catch (e) {
    setCtl('could not reach the bot', true);
  } finally {
    ctlBusy = false; startArmed = 0; resetArmed = 0;
    tick();   // do not wait a second to show what happened
  }
}
if ($('btnStop')) $('btnStop').addEventListener('click', function () { if (!ctlBusy) post('stop'); });
if ($('btnStart')) $('btnStart').addEventListener('click', function () {
  if (ctlBusy || !stateConnected) return;
  if (!startArmed) { startArmed = Date.now(); setCtl('tap again to resume automatic operation; recovery rules still apply'); paintControls((lastState && lastState.risk) || {}); return; }
  post('start');
});
// Two taps, for the same reason RESUME AUTO takes two: it moves the accounting boundary the
// stop measures against, and that is not undoable from here.
if ($('btnReset')) $('btnReset').addEventListener('click', function () {
  if (ctlBusy || !stateConnected) return;
  if (!resetArmed) { resetArmed = Date.now(); setCtl('tap again to reset the drawdown to zero; the stop starts from here'); paintControls((lastState && lastState.risk) || {}); return; }
  post('reset');
});

$('moreMetrics').addEventListener('click',()=>{metricsExpanded=!metricsExpanded;localStorage.setItem('snipe.moreMetrics',metricsExpanded?'1':'0');if(lastState)renderKpis(lastState.kpis);});

tick(); setInterval(tick, 1000);
tickChart();   // reschedules itself; the cadence follows the lookback, see CHART_POLL_MS
</script></div></body></html>`
