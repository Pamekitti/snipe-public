/**
 * History and the total-wallet chart: pane shells, and the finished series as JSON.
 *
 * THE BROWSER DOES NOT DRAW GEOMETRY FROM THIS FILE. It used to: SVG paths, computed here,
 * replaced every second, which is why the line jumped. uPlot now owns the pixels. This file
 * emits the shells (titles, lookback, empty pane divs) and JSON payloads of series the
 * drawer only plots. Stroke colour, rule values and axis decimals are fields on the payload,
 * so the drawer never compares a number to a threshold.
 *
 * FOUR REGIONS, DELIBERATELY. `r-walletchart` / `r-charts` are the shells. `r-walletpayload`
 * / `r-chartpayload` are the series. Applying a shell with `innerHTML` would destroy the
 * canvases; the stream already diffs, so a quiet second sends neither, and a new minute
 * sends only the payloads. The total wallet never lives inside History: a book click must
 * not rebuild it.
 */
import { esc } from '../format.js'
import { LEVELS } from '../levels.js'
import type { ChartPane, ViewModel } from '../viewmodel.js'

const PANE_H: Record<ChartPane['id'], number> = {
  wallet: LEVELS.paneWalletPx,
  virtual: LEVELS.paneWalletPx,
  paper: LEVELS.panePaperPx,
  market: LEVELS.paneVenuePx,
  coins: LEVELS.paneVolumePx,
}

function paneShell(p: ChartPane): string {
  const h = PANE_H[p.id]
  return `<div class="pane-title">${esc(p.title)} <span id="sub-${esc(p.id)}"></span></div>
    <div class="pane" id="pane-${esc(p.id)}" data-h="${h}" data-kind="${esc(p.kind)}"></div>
    <p class="chart-empty" id="empty-${esc(p.id)}" hidden></p>`
}

function lookbackSeg(labels: readonly string[], selected: string): string {
  return labels
    .map((w) => `<button type="button" class="tab${w === selected ? ' on' : ''}" data-window="${esc(w)}">${esc(w)}</button>`)
    .join('')
}

/** Total wallet: booked closes of every book, above the books. This is the only period row. */
export function renderWalletChartShell(vm: ViewModel): string {
  const lookbacks = lookbackSeg(vm.lookbacks, vm.lookback)
  const panes = vm.walletPayload.panes.map(paneShell).join('\n')
  return `<section class="card wide" id="walletchart">
  <header class="card-head">
    <h2>Total wallet</h2>
    <div class="seg" role="group" aria-label="lookback">${lookbacks}</div>
  </header>
  <div id="wallet-panes">
${panes}
    <div id="wallet-tip" role="status" aria-live="off"></div>
  </div>
</section>`
}

export function renderWalletChartPayload(vm: ViewModel): string {
  return JSON.stringify(vm.walletPayload)
}

/** The four empty History panes. They share Total wallet's period; titles come from the payload. */
export function renderChartShell(vm: ViewModel): string {
  const panes = vm.chartPayload.panes.map(paneShell).join('\n')

  return `<section class="card wide" id="charts">
  <header class="card-head">
    <h2>History</h2>
    <div class="seg" role="group" aria-label="chart zoom">
      <button type="button" class="tab" id="zoomchip" hidden>reset zoom</button>
    </div>
  </header>
  <p class="book-head" id="chart-bookhead"></p>
  <div id="panes">
${panes}
    <div id="tip" role="status" aria-live="off"></div>
  </div>
  <div class="lgd" id="lgd">
    <button type="button" data-seg="filtered" aria-pressed="true"><i style="background:var(--rule2)"></i>Filtered out</button>
    <button type="button" data-seg="win" aria-pressed="true"><i style="background:var(--good)"></i>Paper win</button>
    <button type="button" data-seg="loss" aria-pressed="true"><i style="background:var(--bad)"></i>Paper loss</button>
    <button type="button" data-seg="pending" aria-pressed="true"><i class="hatch"></i>Pending</button>
    <button type="button" data-seg="flat" aria-pressed="true" hidden><i style="background:var(--accent)"></i>Break-even</button>
    <button type="button" data-seg="notSimulated" aria-pressed="true" hidden><i style="background:var(--dim)"></i>No estimate</button>
    <button type="button" data-seg="net" aria-pressed="true"><i class="strip"></i>Paper return · trade sizes</button>
    <button type="button" data-seg="trades" aria-pressed="true"><i class="dot"></i>Trades</button>
    <button type="button" data-seg="halts" aria-pressed="true"><i class="halt"></i>Trading paused</button>
  </div>
</section>`
}

/** Finished series. Raw JSON; the page escapes it for HTML, the stream sends it as a string. */
export function renderChartPayload(vm: ViewModel): string {
  return JSON.stringify(vm.chartPayload)
}
