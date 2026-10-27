/**
 * The document, and the regions the live stream replaces piece by piece.
 *
 * THE PAGE IS NEVER RELOADED. The old one called `location.reload()` every two seconds, which
 * is why a selected book, a scroll position and an expanded row could not survive. Here the
 * shell is served once, each region is rendered separately with a stable id, and the server
 * pushes only the regions whose HTML actually changed.
 *
 * THE BROWSER DOES NOT DECIDE. Control (`client.ts`) assigns finished HTML and remembers which
 * tab is open. Charts (`charts-client.ts`) plot finished series at a decimal count the
 * projection already chose. Neither colours a win rate or compares a reading to a cut.
 *
 * uPlot is spliced in AFTER the template is built. The minified source contains `${` and
 * backticks; interpolating it would throw at import time, which would stop the live process.
 * A missing vendor file degrades to empty panes and does not throw.
 */
import { esc, secs, usd } from '../format.js'
import { renderChartPayload, renderChartShell, renderWalletChartPayload, renderWalletChartShell } from './charts.js'
import { CHART_JS } from './charts-client.js'
import { renderBooks, renderExits, renderKpis, renderOpen, val, barCell } from './tables.js'
import { CLIENT_JS } from './client.js'
import type { Alert } from '../alerts.js'
import type { ViewModel } from '../viewmodel.js'

/** The regions the stream can replace. Adding one means adding it here and in the client. */
export const REGIONS = ['hdr', 'alerts', 'wallet', 'walletchart', 'walletpayload', 'books', 'charts', 'chartpayload', 'kpis', 'open', 'exits'] as const
export type RegionId = (typeof REGIONS)[number]

export type Regions = Record<RegionId, string>

export type Vendor = { readonly js: string; readonly css: string }

export function renderRegions(vm: ViewModel, alerts: readonly Alert[]): Regions {
  return {
    hdr: renderHeader(vm),
    alerts: renderAlerts(alerts),
    wallet: renderWallet(vm),
    walletchart: renderWalletChartShell(vm),
    walletpayload: renderWalletChartPayload(vm),
    books: renderBooks(vm),
    charts: renderChartShell(vm),
    chartpayload: renderChartPayload(vm),
    kpis: renderKpis(vm),
    open: renderOpen(vm),
    exits: renderExits(vm),
  }
}

export function renderPage(vm: ViewModel, alerts: readonly Alert[], vendor: Vendor = { js: '', css: '' }): string {
  const r = renderRegions(vm, alerts)
  const page = `<!doctype html>
<html lang="en" data-book="${esc(vm.selectedBook ?? '')}" data-window="${esc(vm.lookback)}" data-exits="${esc(vm.exitsBook ?? 'all')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#101317">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="apple-mobile-web-app-title" content="PONS">
<meta name="application-name" content="PONS">
<title>PONS v2 · ${esc(vm.mode)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<style>/*__UPLOT_CSS__*/</style>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
${REGIONS.map((id) => (id === 'chartpayload' || id === 'walletpayload')
    ? `<div class="region" id="r-${id}" hidden>${esc(r[id])}</div>`
    : `<div class="region" id="r-${id}">${r[id]}</div>`).join('\n')}
</div>
<script>/*__UPLOT_JS__*/</script>
<script>${CHART_JS}</script>
<script>${CLIENT_JS}</script>
</body>
</html>`
  // Function replacer: a plain string replacement would interpret $&, $` and $1 inside the
  // bundle as substitution patterns. Today's build contains none of those; a future version
  // bump is exactly where that would go wrong silently.
  return page
    .replace('/*__UPLOT_CSS__*/', () => vendor.css)
    .replace('/*__UPLOT_JS__*/', () => vendor.js)
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

function renderHeader(vm: ViewModel): string {
  const api = vm.rpcRouting?.api
  const apiButtons = api && vm.canControl ? `<div class="api-modes" role="group" aria-label="API mode">
    ${(['economy', 'paid'] as const).map(mode => `<button class="btn${api.selected === mode ? ' api-selected' : ''}" data-action="set-api-mode" data-api-mode="${mode}" aria-pressed="${api.selected === mode}"${api.preparing ? ' disabled' : ''}>${mode === 'economy' ? 'Economy' : 'Paid'}</button>`).join('')}
  </div>` : ''
  const haltBtn = `<button class="btn danger" data-action="${vm.trading.controlAction}">${esc(vm.trading.controlLabel)}</button>`
  const controls = vm.canControl
    ? `<div class="controls">
      ${apiButtons}
      ${haltBtn}
      <button class="btn" data-action="reset">RESET DD</button>
    </div>`
    : `<div class="controls"><span class="muted" title="this process cannot halt the bot that is trading, so a button here would be a button that lies">read only</span></div>`

  return `<header class="strip">
  <div class="strip-row">
    <h1>PONS v2</h1>
    <span class="mode mode-${esc(vm.mode)}">${esc(vm.mode)}</span>
    <span class="clock">${esc(vm.atText)} UTC</span>
    <span class="muted">zero ${esc(vm.zeroText)}</span>
    <span class="muted">spec v${vm.specVersion}</span>
    <span class="muted">seq ${vm.seq}</span>
  </div>
  <div class="strip-row">
    <span class="big ${vm.trading.state.missing === null ? `tone-${vm.trading.state.tone}` : 'absent'}" title="${esc(vm.trading.why)}">${esc(vm.trading.state.text)}</span>
    <span>open <b>${esc(vm.trading.occupancy)}</b></span>
    <span>default ${val(vm.trading.size)}</span>
    <span>wallet <b>${esc(vm.wallet.eth.text)}</b></span>
    <span class="muted">${vm.booksDeclared} declared · ${vm.booksFunded} funded</span>
    ${controls}
  </div>
  <div class="strip-row small">
    ${api ? `<span class="${api.preparing || api.error || api.recommendPaid ? 'tone-warn' : 'muted'}">API ${api.preparing ? `preparing ${esc(api.effective)}` : esc(api.selected)}${api.selected === 'economy' ? ' · public APIs · paid exit rescue enabled · no rescue cap' : ''}</span>
    ${api.error ? `<span class="tone-warn">${esc(api.error)}</span>` : ''}
    ${api.recommendPaid ? `<span class="tone-warn">Paid recommended: ${esc(api.reason ?? 'public data is unavailable')}</span>` : ''}
    ${api.publicCoverageAgeMs === null ? '' : `<span class="muted">public coverage ${secs(api.publicCoverageAgeMs)} old · ${api.failures1h} request failures in 1h</span>`}` : ''}
    <span>logs ${val(vm.streams.logs)}</span>
    <span>feed ${val(vm.streams.feed)}</span>
    <span>overlay ${val(vm.streams.overlay)}</span>
    ${vm.streams.gaps > 0 ? `<span class="tone-warn">${vm.streams.gaps} gap${vm.streams.gaps === 1 ? '' : 's'}</span>` : ''}
    ${vm.streams.blocking === null ? '' : `<span class="tone-bad">${esc(vm.streams.blocking)}</span>`}
    ${vm.rpcRouting === null || api ? '' : `<span class="${vm.rpcRouting.mode === 'public' ? 'tone-good' : vm.rpcRouting.entryReady === false ? 'tone-warn' : 'muted'}" title="${esc(vm.rpcRouting.eligibilityReason)}">RPC economy ${esc(vm.rpcRouting.mode)}${vm.rpcRouting.entryReady === false && vm.rpcRouting.mode !== 'public' && vm.rpcRouting.mode !== 'cooldown' ? ' · entries waiting for catch-up' : ''}${vm.rpcRouting.lastPreparation ? ` · last catch-up ${vm.rpcRouting.lastPreparation.ms}ms${vm.rpcRouting.lastPreparation.ok ? '' : ' failed, entries held'}` : ''}</span>`}
    ${vm.unrouted === null ? '' : `<span class="tone-warn" title="a launch there is observed and then refused entry-no-book, which looks the same on the funnel as one rejected on merit">${esc(vm.unrouted)}</span>`}
    ${vm.rpcRouting ? `<span class="muted">collection ${esc(vm.rpcRouting.activeTransport ?? 'range')} · verified block ${vm.rpcRouting.verifiedCursor ?? 'unknown'} · paid rescues ${vm.rpcRouting.paid.fallbacks}${vm.rpcRouting.cache ? ` · reused transactions ${vm.rpcRouting.cache.hits}` : ''}</span>` : ''}
    ${vm.rpcRouting?.filter?.disabledReason ? `<span class="tone-warn">Filter disabled: ${esc(vm.rpcRouting.filter.disabledReason)}</span>` : ''}
    ${vm.rpcRouting?.quiet?.disabledReason ? `<span class="tone-warn">Quiet routing disabled: ${esc(vm.rpcRouting.quiet.disabledReason)}</span>` : ''}
    ${vm.rpcRouting?.quiet?.preparing ? '<span class="tone-warn">Preparing paid service · entries held</span>' : ''}
    ${vm.rpcRouting?.paidUsage?.map(window => `<span class="muted">${esc(window.label)} estimated paid monitoring/entries ${window.monitoring.estimatedUsd === null ? 'unknown' : usd(window.monitoring.estimatedUsd, false)} · exit rescue ${window.rescue.estimatedUsd === null ? 'unknown' : usd(window.rescue.estimatedUsd, false)}</span>`).join('') ?? ''}
    ${vm.rpcRouting?.lastExitRescue ? `<span class="muted" title="${esc(vm.rpcRouting.lastExitRescue.owner)}">last paid exit rescue ${esc(vm.rpcRouting.lastExitRescue.method)}</span>` : ''}
  </div>
</header>`
}

function renderAlerts(alerts: readonly Alert[]): string {
  if (alerts.length === 0) return `<section class="card empty" hidden></section>`
  const order = { crit: 0, warn: 1, info: 2 } as const
  const sorted = [...alerts].sort((a, b) => order[a.sev] - order[b.sev])
  return `<section class="card alerts">
  <ul>
${sorted.map((a) => `    <li class="sev-${a.sev}"><span class="sev">${a.sev}</span>${esc(a.msg)}</li>`).join('\n')}
  </ul>
</section>`
}

/**
 * The wallet card: what the account holds, and separately what the bot has made.
 *
 * THE TWO LINES ARE LABELLED BECAUSE THEY ARE DIFFERENT QUANTITIES. The big figure is the
 * chain balance, which moves with gas, with deposits, and with tokens still held. The line
 * under it is cumulative booked P&L, which is the number the drawdown stop reads.
 *
 * The sparkline that used to live here is gone: Total wallet is that line, full width,
 * under this card, above the book tabs.
 */
function renderWallet(vm: ViewModel): string {
  return `<section class="card" id="wallet">
  <header class="card-head">
    <h2>TOTAL REAL WALLET</h2>
    <span class="muted">chain balance, not rebased, not per book</span>
  </header>
  <div class="figures">
    <span class="big">${val(vm.wallet.eth)}</span>
    ${vm.hasUsd && vm.wallet.usd.missing === null ? `<span class="big">${val(vm.wallet.usd)}</span>` : ''}
    <span class="since">booked P&amp;L ${val(vm.wallet.sinceZeroEth)}${vm.hasUsd ? ` ${val(vm.wallet.sinceZeroUsd)}` : ''}</span>
    <span class="since">${esc(vm.wallet.closed.text)} closed · ${val(vm.wallet.winPct)} win</span>
  </div>
  <div class="dd">
    <span class="muted">drawdown</span>${barCell(vm.wallet.drawdown)}
  </div>
</section>`
}

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

/**
 * One stylesheet, inlined, because it is 4KB and a second request over a tailnet costs more
 * than the bytes. Rolling, History and Recent exits copy v1's shapes; the strip and the
 * wallet card are v2's.
 */
const CSS = `
:root{
  --bg:#101317; --panel:#191d23; --panel2:#222831; --line:#2b323b; --rule2:#3a424d; --ink:#e5e9ef; --dim:#a0a9b6;
  --good:#66bea5; --bad:#ed8c82; --warn:#e1b467; --accent:#8eaff0;
  --p0:#5aa9e6; --p1:#c678dd; --p2:#3fbf7f; --p3:#d99a2b; --p4:#e5534b; --p5:#56b6c2;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --tap:44px;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0;background:var(--bg);color:var(--ink)}
body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-text-size-adjust:100%}
.wrap{max-width:1500px;margin:0 auto;padding:12px;padding-bottom:max(12px,env(safe-area-inset-bottom))}
h1{font:600 15px/1 system-ui;margin:0;letter-spacing:.04em}
h2{font:600 12px/1 system-ui;margin:0;letter-spacing:.1em;color:var(--dim);text-transform:uppercase}
b{font-weight:600}
code{font-family:var(--mono);font-size:.92em}
.muted,.absent,.mut{color:var(--dim)}
.absent{border-bottom:1px dotted var(--dim);cursor:help}
.tone-good{color:var(--good)} .tone-bad{color:var(--bad)}
.tone-warn{color:var(--warn)} .tone-muted{color:var(--dim)}
.missing{color:var(--dim);font-size:13px;margin:8px 0;max-width:70ch}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* --- strip --- */
.strip{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:10px}
.strip-row{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center}
.strip-row+.strip-row{margin-top:8px}
.strip-row.small{font-size:12.5px;color:var(--dim)}
.clock{font-family:var(--mono)}
.big{font:600 20px/1.2 var(--mono)}
.mode{font:600 11px/1 system-ui;letter-spacing:.08em;text-transform:uppercase;padding:4px 7px;border-radius:4px;border:1px solid var(--line)}
.mode-live{color:var(--bad);border-color:var(--bad)}
.mode-shadow{color:var(--warn);border-color:var(--warn)}
.mode-observe{color:var(--dim)}
.controls{margin-left:auto;display:flex;gap:8px}
.api-modes{display:flex;gap:0;border:1px solid var(--line);border-radius:6px;overflow:hidden}
.api-modes .btn{border:0;border-radius:0}
.api-modes .api-selected{background:var(--panel2);font-weight:700}
.btn{min-height:var(--tap);padding:0 14px;background:#1a212a;color:var(--ink);border:1px solid var(--line);border-radius:6px;font:600 12px/1 system-ui;letter-spacing:.06em;cursor:pointer}
.btn:hover{border-color:var(--accent)}
.btn.danger{border-color:var(--bad);color:var(--bad)}

/* --- cards --- */
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:10px}
.card.empty{display:none}
#open.live{border-color:#3a4d66}
.pill{font:650 10px/1.4 system-ui;letter-spacing:.04em;text-transform:uppercase;padding:3px 7px;border-radius:4px;border:1px solid var(--line);white-space:nowrap}
.pill.tone-warn{color:var(--warn);border-color:var(--warn)}
.pill.tone-bad{color:var(--bad);border-color:var(--bad)}
.pill.tone-good{color:var(--good);border-color:var(--good)}
.pill.tone-muted,.pill.tone-plain{color:var(--dim)}
.card.wide{margin-bottom:10px}
.card-head{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin-bottom:10px}
.card-head h2{margin-right:auto}
.figures{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline;margin-bottom:8px}
.since{color:var(--dim);font-size:13px}
.dd{display:flex;gap:10px;align-items:center;font-size:12.5px;margin-bottom:6px}
.book-head{font-family:var(--mono);font-size:12.5px;color:var(--ink);margin:0 0 10px;padding:6px 8px;background:#0d1217;border-left:3px solid var(--accent);border-radius:0 4px 4px 0}
.section-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:5px}
.section-heading h2{margin:0}
.section-heading button.more{min-height:28px;padding:3px 8px;font-size:12px;color:var(--dim);background:transparent;border:1px solid var(--line);border-radius:5px;cursor:pointer}

/* --- tabs --- */
.tabs,.seg{display:flex;flex-wrap:wrap;gap:6px}
.tab{min-height:var(--tap);padding:0 12px;background:transparent;color:var(--dim);border:1px solid var(--line);border-radius:6px;font:500 13px/1 system-ui;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.tab:hover{color:var(--ink)}
.tab.on{background:#1a212a;color:var(--ink);border-color:var(--accent)}
.tabs.books{margin-bottom:0;gap:8px}
.book-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.book-controls{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.book-controls .btn{min-height:34px;padding:0 10px;font-size:11px;letter-spacing:.04em}
.book-size{display:flex;align-items:center;gap:5px;padding:3px 5px;border:1px solid var(--line);border-radius:6px;background:#0d1217}
.size-input{width:88px;min-height:28px;padding:0 6px;background:#111820;color:var(--ink);border:1px solid var(--line);border-radius:4px;font:600 12px var(--mono)}
.size-input:focus{outline:2px solid var(--accent);outline-offset:1px}
.size-unit{color:var(--dim);font:600 10px system-ui;letter-spacing:.05em}
.size-adaptive{flex-basis:100%;color:var(--dim);font:500 10px/1.35 var(--mono)}
.tab.book{flex-direction:column;align-items:flex-start;justify-content:center;gap:2px;padding:6px 12px}
.tab.book .tab-id{font-weight:600}
.tab-meta{font-size:11px}
.tab.unfunded .tab-id{opacity:.65}
.seg{gap:4px}
.seg .tab{font:500 12px var(--mono);min-height:34px;padding:5px 9px}
#zoomchip{color:var(--accent);border-color:#475873}

/* --- pips --- */
.pip{display:inline-block;width:3px;height:12px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.pip-0{background:var(--p0)} .pip-1{background:var(--p1)} .pip-2{background:var(--p2)}
.pip-3{background:var(--p3)} .pip-4{background:var(--p4)} .pip-5{background:var(--p5)}
.book-badge{display:inline-block;font:600 10px/1.4 system-ui;letter-spacing:.04em;text-transform:uppercase;padding:1px 6px;border-radius:3px;margin-right:7px;vertical-align:2px;border:1px solid currentColor}
.book-badge.pip-0{color:var(--p0);background:transparent}
.book-badge.pip-1{color:var(--p1);background:transparent}
.book-badge.pip-2{color:var(--p2);background:transparent}
.book-badge.pip-3{color:var(--p3);background:transparent}
.book-badge.pip-4{color:var(--p4);background:transparent}
.book-badge.pip-5{color:var(--p5);background:transparent}

/* --- tables --- */
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:14px}
table.grid{font-size:13px}
th{text-align:left;color:var(--dim);font:500 12px system-ui;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{font-family:var(--mono);font-variant-numeric:tabular-nums;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
tr:last-child td{border-bottom:0}
table.grid th{font:600 11px/1 system-ui;letter-spacing:.06em;text-transform:uppercase;padding:6px 8px}
table.grid td{padding:6px 8px;border-bottom:1px solid #1a2028}
table.grid td.num,table.grid th.num{text-align:right}
table.grid tbody tr:hover{background:#151b22}

/* --- rolling --- */
#kpi td,#kpi th{text-align:right}
#kpi td:first-child,#kpi th:first-child{text-align:left;font-family:system-ui,sans-serif;color:var(--dim)}
#kpi .hd{font-size:16px;font-weight:600}
#kpi tr.extra{display:none}
#kpi.show-extra tr.extra{display:table-row}

/* --- recent exits --- */
#open th.n,#open td.n,#rec th.n,#rec td.n{text-align:right}
#rec .sym{font:600 14px system-ui,sans-serif;max-width:150px;display:inline-block;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom}
#rec tbody tr.hd{cursor:pointer}
#rec tbody tr.hd:hover td,#rec tbody tr.hd.open td{background:var(--panel2)}
#rec td.det{padding:0;background:#15191f;white-space:normal}
.capt{position:relative;height:5px;min-width:72px;background:var(--panel2);border-radius:3px;overflow:hidden}
.capt u,.capt b{position:absolute;left:0;top:0;bottom:0;display:block}
.capt u{background:var(--line);width:100%}
.capt b.tone-good{background:var(--good)}
.capt b.tone-warn{background:var(--warn)}
.capt b.tone-bad{background:var(--bad)}
.capt b.tone-muted,.capt b.tone-plain{background:var(--dim)}
.pnl-cell strong{font-weight:600}
.pnl-cell small{font-size:11px;margin-left:9px;opacity:.85;color:inherit}
.pnl-cell .pnl-eth{font-weight:600}
.det .box{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:0 24px;padding:18px 20px}
.det h4{font:600 12px system-ui;letter-spacing:.04em;text-transform:uppercase;color:var(--dim);margin:0 0 10px}
.det .g{padding:0 0 15px}
.det .r{display:flex;justify-content:space-between;gap:12px;padding:4px 0;font-size:13px;white-space:normal}
.det .r span:first-child{font-family:system-ui,sans-serif;color:var(--dim)}
.det .r span:last-child{text-align:right;overflow-wrap:anywhere}
.det .lk{padding:0 20px 16px;display:flex;gap:12px;flex-wrap:wrap;align-items:baseline}
.det .lk a{color:var(--accent);text-decoration:none}
.sm{font-size:12px;color:var(--dim)}

/* --- bars (wallet drawdown) --- */
.bar{display:inline-flex;align-items:center;gap:7px}
.bar-track{display:inline-block;width:64px;height:7px;background:#1c232c;border-radius:4px;overflow:hidden;flex:none}
.bar-fill{display:block;height:100%;background:currentColor;border-radius:4px}
.bar-text{font-family:var(--mono);font-size:12px}

/* --- history panes --- */
.pane-title{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;font:600 11px system-ui;letter-spacing:.05em;text-transform:uppercase;color:var(--dim);margin:10px 0 4px}
.pane-title span{font-weight:400;text-transform:none;letter-spacing:0;font-family:var(--mono);font-variant-numeric:tabular-nums}
#panes,#wallet-panes{position:relative}
.pane{position:relative}
.chart-empty{font:12px system-ui;color:var(--dim);line-height:1.5;margin:4px 0 10px;padding:24px 12px;border:1px dashed var(--line);border-radius:6px}
.uplot,.u-wrap{font-family:var(--mono)!important}
.u-cursor-x,.u-cursor-y{border-color:var(--dim)!important;opacity:.45}
.u-select{background:#5aa9e620;border:1px solid var(--accent)}
.u-legend{display:none!important}
#tip,#wallet-tip{position:absolute;z-index:20;pointer-events:none;display:none;background:var(--panel2);border:1px solid #465363;border-radius:7px;padding:12px 14px;font-size:13px;line-height:1.5;max-width:calc(100% - 8px);box-shadow:0 8px 26px #0005}
#tip .t,#wallet-tip .t{font-size:12px;color:var(--dim);margin-bottom:7px}
#tip .r,#wallet-tip .r{display:flex;justify-content:space-between;gap:14px}
#tip .r span:first-child,#wallet-tip .r span:first-child{color:var(--dim)}
#tip .r span:last-child,#wallet-tip .r span:last-child{font-family:var(--mono);text-align:right}
.lgd{display:flex;gap:8px 16px;flex-wrap:wrap;font-size:12px;color:var(--dim);margin-top:12px;align-items:center}
.lgd i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.lgd i.hatch{background:repeating-linear-gradient(135deg,var(--dim) 0 1px,transparent 1px 3px)}
.lgd i.strip{width:22px;height:6px;background:linear-gradient(90deg,var(--bad),var(--line) 50%,var(--good))}
.lgd i.dot{border-radius:50%;background:var(--good)}
.lgd i.halt{width:14px;background:linear-gradient(90deg,var(--bad),var(--warn),var(--dim))}
.lgd button{font:12px system-ui,sans-serif;color:var(--dim);background:none;border:0;min-height:28px;padding:0;cursor:pointer}
.lgd button[aria-pressed="false"]{opacity:.55;text-decoration:line-through}
.lgd button[aria-pressed="false"] i{background:var(--line)!important}

/* --- alerts --- */
.alerts ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.alerts li{display:flex;gap:9px;align-items:baseline;font-size:13px;line-height:1.45}
.sev{font:600 10px/1.6 system-ui;letter-spacing:.06em;text-transform:uppercase;padding:0 6px;border-radius:3px;flex:none;min-width:38px;text-align:center}
.sev-crit .sev{background:var(--bad);color:#fff}
.sev-warn .sev{background:var(--warn);color:#000}
.sev-info .sev{background:#2a3441;color:var(--dim)}

/* --- the phone: shrink rolling and exits, do not wrap them into chips --- */
@media(max-width:860px){
  .wrap{padding:8px}
  .strip-row{gap:6px 12px}
  .controls{margin-left:0;width:100%;flex-wrap:wrap}
  .api-modes{flex:1 0 100%}
  .btn{flex:1}
  .big{font-size:18px}
  table.grid thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  table.grid tr{display:flex;flex-wrap:wrap;gap:7px 14px;border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin-bottom:8px}
  table.grid tbody tr:hover{background:transparent}
  table.grid td{display:flex;flex-direction:column;align-items:flex-start;gap:1px;border:0;padding:0;white-space:nowrap}
  table.grid td::before{content:attr(data-label);color:var(--dim);font-size:10px;line-height:1.3;letter-spacing:.05em;text-transform:uppercase}
  table.grid td.num{text-align:left}
  table.grid td:first-child{font-weight:600;font-size:15px}
  table.grid td:first-child::before,table.grid td:nth-child(2)::before{display:none}
  .bar-track{width:52px}
  .tab.book{flex:1 1 auto}
  .book-row,.book-controls{width:100%}
  .book-size{flex:1 1 100%}
  .size-input{flex:1;width:auto;min-width:88px}
}
@media(max-width:480px){
  #kpi td,#kpi th{font-size:11px;padding:6px 4px}
  #kpi td:first-child{white-space:normal;width:72px;max-width:72px}
  #kpi .hd{font-size:12px}
  #rec .sym{max-width:80px;font-size:12px}
  .pnl-cell .pnl-usd{display:none}
  .pnl-cell .pnl-eth{margin-left:0}
  th,td{padding:7px 6px;font-size:12px}
  .det .box{grid-template-columns:1fr;padding:16px}
  .det .lk{padding:0 16px 16px}
  .seg{gap:1px}
  .seg .tab{padding:5px 8px;min-height:38px}
}
@media(prefers-reduced-motion:no-preference){
  .region{transition:opacity .12s linear}
}
`
