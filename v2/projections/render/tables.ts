/**
 * The three tables: rolling windows, what is open, and what closed.
 *
 * ROLLING IS METRIC ROWS × TIME COLUMNS, copied from v1. Short beside long is the signal:
 * the last hour turning while the day still looks fine. More metrics hides the quieter
 * rows behind one button, so the four that matter stay large.
 *
 * EXITS ARE A SCAN ROW. Twenty fields will not fit in a glance. The table stays narrow
 * (time, coin, combined P&L, reason, hold, TP, peak, exit, kept bar, dev, exempt) and a
 * click opens the rest. Every cell still carries `data-label` so a test can see it; the
 * phone stylesheet for `#rec` shrinks the table instead of turning each row into cards.
 *
 * A VALUE THAT IS ABSENT SAYS SO. `Shown.missing` becomes a `title` and a muted class, never a
 * zero and never an empty cell.
 */
import { esc, hhmmss } from '../format.js'
import type { Bar, Shown } from '../format.js'
import type { ExitView, KpiRow, PositionView, ViewModel } from '../viewmodel.js'

// ---------------------------------------------------------------------------
// The two primitives every cell is built from
// ---------------------------------------------------------------------------

/**
 * A finished value, with its tone, and its provenance kept in the tooltip.
 *
 * The tooltip names WHEN the reading was taken, not how old it is. An age recomputed every
 * second changes the HTML every second, so the whole region is re-pushed over the stream to
 * update text nobody is looking at: in practice that was 3KB a second for the KPI table alone,
 * entirely invisible. A wall-clock time only changes when a new reading actually arrives, which
 * is the moment the operator has a reason to look, and it is the more useful of the two anyway
 * because it can be matched against a log line. The ages that genuinely tick are in the header
 * strip, where something is changing every second regardless.
 */
export function val(s: Shown<unknown>): string {
  const cls = s.missing === null ? `tone-${s.tone}` : 'absent'
  const title = s.missing === null
    ? (s.source === null ? '' : ` title="${esc(`${s.source}${s.at === null ? '' : `, read ${hhmmss(s.at)} UTC`}${s.n === null ? '' : `, n=${s.n}`}`)}"`)
    : ` title="${esc(s.missing)}"`
  return `<span class="${cls}"${title}>${esc(s.text)}</span>`
}

/** A proportion. The track is always drawn so an empty bar is visibly an empty bar. */
export function barCell(b: Bar): string {
  if (b.missing !== null) {
    return `<span class="absent" title="${esc(b.missing)}">${esc(b.text)}</span>`
  }
  return `<span class="bar tone-${b.tone}" title="${esc(b.text)}">
    <span class="bar-track"><span class="bar-fill" style="width:${(100 * b.fraction).toFixed(1)}%"></span></span>
    <span class="bar-text">${esc(b.text)}</span>
  </span>`
}

/** The colour chip that ties a row to its book tab. Books are coloured by position, not by name. */
export function pip(book: string | null, index: number): string {
  if (book === null) return ''
  return `<span class="pip pip-${index % PIPS}" aria-hidden="true"></span>`
}

/** The book name on the row, so a filter is not the only way to see which policy took the trade. */
export function bookBadge(book: string, index: number): string {
  return `<span class="book-badge pip-${index % PIPS}">${esc(book)}</span>`
}

/** How many distinct book colours the stylesheet declares. Beyond this they repeat. */
const PIPS = 6

export function bookIndex(vm: ViewModel, book: string | null): number {
  if (book === null) return 0
  const i = vm.bookTabs.findIndex((t) => t.id === book)
  return i < 0 ? 0 : i
}

export function bookTabs(vm: ViewModel): string {
  if (vm.bookTabs.length === 0) return ''
  const rows = vm.bookTabs.map((t, i) => {
    const on = t.id === vm.selectedBook ? ' on' : ''
    const unfunded = t.funded ? '' : ' unfunded'
    const tone = t.state.missing === null ? `tone-${t.state.tone}` : 'absent'
    const tab = `<button type="button" class="tab book${on}${unfunded}" data-book="${esc(t.id)}">
      ${pip(t.id, i)}<span class="tab-id">${esc(t.id)}</span>
      <span class="tab-meta ${tone}">${esc(t.state.text)} · ${esc(t.stakeEth)}</span>
    </button>`
    const sizeControl = vm.canControl && t.adjustable
      ? `<div class="book-size" data-size-control="${esc(t.id)}" data-size-old="${esc(t.stakeEth)}" data-size-source="${esc(t.sizeSource)}" data-drawdown-stakes="${t.drawdownStakes}">
          <label class="sr-only" for="size-${esc(t.id)}">${esc(t.id)} base trade size in ETH</label>
          <input id="size-${esc(t.id)}" class="size-input" type="number" inputmode="decimal" min="${esc(t.minimumEth)}" max="${esc(t.declaredEth)}" step="0.0001" value="${esc(t.stakeEth)}" data-size-input="${esc(t.id)}" aria-label="${esc(t.id)} base trade size in ETH">
          <span class="size-unit">ETH</span>
          <button type="button" class="btn" data-size-set="${esc(t.id)}">SET SIZE</button>
          ${t.sizeSource === 'book' ? `<button type="button" class="btn" data-size-default="${esc(t.id)}">USE DEFAULT</button>` : ''}
          <span class="size-adaptive" title="${esc(t.sizingWhy)}">next ${esc(t.nextStakeEth)} · ${esc(t.sizingMultiplier)} ${esc(t.sizingState)} · range ${esc(t.sizingRangeEth)} · n${t.sizingN}</span>
        </div>`
      : ''
    const controls = vm.canControl
      ? `<div class="book-controls">
          ${sizeControl}
          <button type="button" class="btn${t.controlAction === 'stop' ? ' danger' : ''}" data-action="${t.controlAction}" data-control-book="${esc(t.id)}">${esc(t.controlLabel)}</button>
          <button type="button" class="btn" data-action="reset" data-control-book="${esc(t.id)}">RESET DD</button>
        </div>`
      : ''
    return `<div class="book-row">${tab}${controls}</div>`
  }).join('')
  return `<div class="tabs books" role="group" aria-label="book">${rows}</div>`
}

/** Tabs once, above History and Rolling, with this book's stop / auto / reset. */
export function renderBooks(vm: ViewModel): string {
  const tabs = bookTabs(vm)
  if (tabs === '') return `<section class="card empty" id="books" hidden></section>`
  return `<section class="card wide" id="books">${tabs}</section>`
}

// ---------------------------------------------------------------------------
// Rolling performance
// ---------------------------------------------------------------------------

export function renderKpis(vm: ViewModel): string {
  const head = vm.rollingWindows.map((w) => `<th class="n">${esc(w)}</th>`).join('')
  const body = vm.kpis.map((r) => kpiRow(r)).join('\n')
  return `<section class="card wide" id="kpis">
  <div class="section-heading"><h2>Rolling performance</h2>
    <button type="button" class="more" data-metrics="1" aria-expanded="false">More metrics</button></div>
  <div class="scroll"><table id="kpi">
    <thead><tr><th>metric</th>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table></div>
</section>`
}

function kpiRow(r: KpiRow): string {
  const tds = r.cells.map((c) => `<td class="n${r.loud ? ' hd' : ''}" data-label="${esc(r.label)}">${val(c)}</td>`).join('')
  return `    <tr class="${r.extra ? 'extra' : ''}${r.loud ? ' loud' : ''}"><td data-label="metric">${esc(r.label)}</td>${tds}</tr>`
}

// ---------------------------------------------------------------------------
// Open positions
// ---------------------------------------------------------------------------

/**
 * Directly above Recent exits, in the page flow. Not sticky, not under the wallet.
 *
 * That is v1's place for the live bag: age, hold bar, mark, pinned TP, estimated return,
 * supply left, state. Hidden-while-flat kept the card out of the way and also meant a
 * 10-second hold had no home and a buy still in flight never appeared. The strip still
 * has the count; this is the place you watch the row.
 */
export function renderOpen(vm: ViewModel): string {
  const cap = esc(vm.trading.occupancyOf)
  if (vm.positions.length === 0) {
    return `<section class="card wide" id="open">
  <header class="card-head"><h2>Open positions</h2><span class="muted">${cap}</span></header>
  <p class="muted">nothing open</p>
</section>`
  }
  return `<section class="card wide live" id="open">
  <header class="card-head"><h2>Open positions</h2><span class="muted">${cap}</span></header>
  <div class="scroll">
    <table>
      <thead><tr>
        <th>Opened</th><th>Book</th><th>Token</th><th>Age</th><th></th>
        <th class="n">Mult</th><th class="n">Pinned TP</th><th class="n">Est. return</th>
        <th class="n">Supply left</th><th>State</th>
      </tr></thead>
      <tbody>
${vm.positions.map((p) => openRow(vm, p)).join('\n')}
      </tbody>
    </table>
  </div>
</section>`
}

function openRow(vm: ViewModel, p: PositionView): string {
  const peakTitle = p.peakText === null ? '' : ` title="${esc(p.peakText)}"`
  const ret = p.pnl.missing === null
    ? `${val(p.pnl)}<small class="mut"> before gas</small>`
    : val(p.pnl)
  return `        <tr>
          <td class="mut" data-label="opened">${esc(p.openedText)}</td>
          <td data-label="book">${bookBadge(p.book, bookIndex(vm, p.book))}</td>
          <td data-label="token"><a href="${esc(p.tokenUrl)}" target="_blank" rel="noopener" title="${esc(p.token)}">${esc(p.tokenText)}</a> · <a class="sm" href="${esc(p.curveUrl)}" target="_blank" rel="noopener">curve</a></td>
          <td data-label="age">${val(p.age)}</td>
          <td data-label="hold">${holdCell(p.hold)}</td>
          <td class="n" data-label="×"${peakTitle}>${val(p.multiple)}</td>
          <td class="n mut" data-label="pinned TP">${val(p.takeProfit)}</td>
          <td class="n" data-label="est. return">${ret}</td>
          <td class="n" data-label="supply left">${val(p.supplyLeft)}</td>
          <td data-label="state"><span class="pill tone-${p.state.tone}">${esc(p.state.text)}</span>${p.stateDetail ? `<small class="mut">${esc(p.stateDetail)}</small>` : ''}${vm.canControl && p.canRetryExit ? `<button type="button" class="btn" data-action="retry-exit" data-position-id="${esc(p.id)}" data-recovery-token="${esc(p.token)}">RETRY EXIT</button>` : ''}</td>
        </tr>`
}

/** Age is already a column; the bar only has to move. */
function holdCell(b: Bar): string {
  if (b.missing !== null) {
    return `<span class="absent" title="${esc(b.missing)}">–</span>`
  }
  return `<span class="bar tone-${b.tone}" title="${esc(b.text)}"><span class="bar-track"><span class="bar-fill" style="width:${(100 * b.fraction).toFixed(1)}%"></span></span></span>`
}

// ---------------------------------------------------------------------------
// Exits
// ---------------------------------------------------------------------------

/**
 * One shared table across every book, newest first.
 *
 * Shared and not per book, because the question it answers is "what just happened", and that is
 * chronological. The colour pip (only when "all" is showing more than one book) and the filter
 * are what make the book visible without splitting the order.
 *
 * THE SCAN IS TWELVE COLUMNS, NOT FOURTEEN. Tax and the second P&L column left this row; they
 * are one click away in the detail grid. Max Ns is the independent observer peak, Kept is the
 * colour bar of how much of that run we took. The phone stylesheet shrinks `#rec` rather than
 * wrapping each row into labelled chips, which is what made forty exits unreadable.
 */
export function renderExits(vm: ViewModel): string {
  const filters = [{ id: 'all', label: 'all' }, ...vm.bookTabs.map((t) => ({ id: t.id, label: t.id }))]
    .map((f) => {
      const on = (vm.exitsBook === null && f.id === 'all') || f.id === vm.exitsBook
      return `<button type="button" class="tab${on ? ' on' : ''}" data-exits-book="${esc(f.id)}">${esc(f.label)}</button>`
    })
    .join('')

  const rows = vm.exits.length === 0
    ? `        <tr><td colspan="12" class="empty" data-label="status">${esc(vm.exitsMissing ?? 'nothing has closed on this tape yet')}</td></tr>`
    : vm.exits.map((e) => exitRow(vm, e)).join('\n')

  return `<section class="card wide" id="exits">
  <header class="card-head">
    <h2>Last 40 exits</h2>
    <div class="tabs" role="group" aria-label="filter by book">${filters}</div>
  </header>
  <div class="scroll">
    <table id="rec">
      <thead><tr>
        <th>Time</th><th>Coin</th><th class="n">${vm.hasUsd ? 'P&amp;L · ETH / $' : 'P&amp;L · ETH'}</th><th>Reason</th><th>Hold</th>
        <th class="n">Pinned TP</th>
        <th class="n" title="Modeled peak from entry at launch block +20 with a 0.01 ETH stake. This can differ from the peak observed by the real trade.">Replay ${esc(vm.exitsMaxHoldLabel.toLowerCase())}</th>
        <th class="n">Exit</th>
        <th title="how much of the available run we kept">Kept</th>
        <th class="n">Dev buy</th><th class="n">Exempt</th><th></th>
      </tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>
</section>`
}

function exitRow(vm: ViewModel, e: ExitView): string {
  const pnl = vm.hasUsd
    ? `<strong class="pnl-eth">${val(e.pnlEth)}</strong><small class="pnl-usd">${val(e.pnlUsd)}</small>`
    : `<strong class="pnl-eth">${val(e.pnlEth)}</strong>`
  return `        <tr class="hd" tabindex="0" aria-expanded="false" data-token="${esc(e.token)}" data-book="${esc(e.book)}">
          <td class="mut" data-label="time">${esc(e.timeText)}</td>
          <td data-label="coin">${bookBadge(e.book, bookIndex(vm, e.book))}<span class="sym" title="${esc(e.token)}">${esc(e.tokenText)}</span></td>
          <td class="n pnl-cell" data-label="P&amp;L">${pnl}</td>
          <td class="tone-${e.reasonTone}" data-label="reason">${esc(e.reason)}</td>
          <td data-label="hold">${val(e.hold)}</td>
          <td class="n mut" data-label="TP">${val(e.takeProfit)}</td>
          <td class="n" data-label="peak">${val(e.truePeak)}</td>
          <td class="n" data-label="exit">${val(e.exit)}</td>
          <td data-label="kept">${captBar(e.kept)}</td>
          <td class="n mut" data-label="dev buy">${val(e.devBuy)}</td>
          <td class="n mut" data-label="ex">${val(e.exemptions)}</td>
          <td class="sm" data-label="more">&#9656;</td>
        </tr>
        <tr class="detail" hidden data-token="${esc(e.token)}">
          <td class="det" colspan="12" data-label="detail">${exitDetail(vm, e)}</td>
        </tr>`
}

/** The 5px capture bar. Percent lives in the tooltip; drawing it twice is what the scan dropped. */
function captBar(b: Bar): string {
  if (b.missing !== null) {
    return `<span class="absent" title="${esc(b.missing)}">–</span>`
  }
  return `<div class="capt" title="${esc(b.text)}"><u></u><b class="tone-${b.tone}" style="width:${(100 * b.fraction).toFixed(0)}%"></b></div>`
}

function exitDetail(vm: ViewModel, e: ExitView): string {
  const books = vm.bookTabs.length > 1 ? dr('book', esc(e.book), 'mut') : ''
  return `<div class="box">
    ${grp('Entry', [
      dr('opened', esc(e.openedText) + ' UTC', 'mut'),
      dr('size in', val(e.spendEth)),
      dr('detect → entry', val(e.detectToEntry), 'mut'),
    ])}
    ${grp('Exit', [
      dr('reason', esc(e.reason), `tone-${e.reasonTone}`),
      dr('held', val(e.hold)),
      dr('peak while held / exit', `${val(e.heldPeak)} / ${val(e.exit)}`),
      dr(vm.exitsMaxHoldLabel, val(e.truePeak)),
      dr('left after we sold', val(e.leftAfter)),
      dr('proceeds', val(e.proceedsEth)),
    ])}
    ${grp('The launch', [
      books,
      dr('dev buy', val(e.devBuy)),
      dr('exempt wallets', val(e.exemptions)),
      dr('creator tax', val(e.taxBps)),
    ])}
    ${grp('Money', [
      dr('P&amp;L', vm.hasUsd ? `<strong>${val(e.pnlEth)}</strong> / ${val(e.pnlUsd)}` : `<strong>${val(e.pnlEth)}</strong>`),
    ])}
  </div>
  <div class="lk">
    <a href="${esc(e.chartUrl)}" target="_blank" rel="noopener">chart</a>
    <a href="${esc(e.tokenUrl)}" target="_blank" rel="noopener">token</a>
    <a href="${esc(e.curveUrl)}" target="_blank" rel="noopener">curve</a>
    <span class="mut">${esc(e.token)}</span>
  </div>`
}

function grp(title: string, rows: readonly string[]): string {
  return `<div class="g"><h4>${title}</h4>${rows.filter((r) => r !== '').join('')}</div>`
}

function dr(k: string, v: string, cls = ''): string {
  return `<div class="r"><span>${k}</span><span class="${cls}">${v}</span></div>`
}
