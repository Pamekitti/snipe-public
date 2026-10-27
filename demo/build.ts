/** Static historical display export. Imports projections only, never a driver, signer or provider. */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { emptyState, type Position, type State } from '../v2/core/state.js'
import { loadConfig } from '../v2/io/config-load.js'
import { History } from '../v2/projections/history.js'
import { project, type ViewModel, type ChartPayload } from '../v2/projections/viewmodel.js'
import { absent, bar, shown } from '../v2/projections/format.js'
import { loadVendor } from '../v2/projections/vendor.js'
import { renderPage, renderRegions } from '../v2/projections/render/page.js'
import { CLIENT_JS } from '../v2/projections/render/client.js'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
const read = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'))
type ExportedPosition = Pick<Position, 'id' | 'book' | 'templateKey' | 'openedAt' | 'closedAt' | 'abandonedAt' | 'exitReason' | 'filled' | 'rules'> & { spendWei: string; entryMarkWei: string; peakMarkWei: string; proceedsWei: string }
const input = read('datasets/samples/v2-closed-positions.json') as { positions: ExportedPosition[] }
const retirement = read('datasets/samples/retirement-state.json')
const config = loadConfig(join(root, 'v2/config/strategy.toml'), 0, null)
if (!config.ok) throw new Error('Retirement config failed validation')
const cfg = config.value.values
const cases = [
  { id: 'active', title: 'Trading history · 19 Sep 2026', at: Date.parse('2026-09-19T23:59:59Z'), missing: false },
  { id: 'retired', title: 'Retired · 25 Oct 2026', at: retirement.at as number, missing: false },
  { id: 'missing', title: 'Missing-data interface fixture', at: retirement.at as number, missing: true },
]
const rows = input.positions.map((r, index) => {
  const token = '0x' + (index + 1).toString(16).padStart(40, '0')
  return { ...r, token, curve: token, bookDigest: 'sanitized-historical-display',
    spendWei: BigInt(r.spendWei), entryMarkWei: BigInt(r.entryMarkWei), peakMarkWei: BigInt(r.peakMarkWei),
    proceedsWei: BigInt(r.proceedsWei), tokensHeld: 0n, closed: true, attempts: 0,
    abandonReason: r.abandonedAt === null ? null : 'Recorded abandonment', inflightIntentId: null,
    lastBuyHash: null, lastSellHash: null, awaitingSellReceipt: null, venue: 'curve', grad: null,
  } as Position
}).sort((a,b) => (a.abandonedAt ?? a.closedAt ?? a.openedAt) - (b.abandonedAt ?? b.closedAt ?? b.openedAt))
const views: Record<string, ReturnType<typeof renderRegions>> = {}
let initial: ViewModel | null = null
function sanitizeVm(vm: ViewModel, c: typeof cases[number]): ViewModel {
  const historical = 'Historical display reconstruction; feed, observer, wallet path and historical guard state were not preserved in these public inputs.'
  const payload = (p: ChartPayload): ChartPayload => ({ ...p, bands: [], trades: p.trades.map(t => ({ ...t, token: 'sample-' + parseInt(t.token.slice(-4), 16) })), panes: p.panes.map(pane => {
    if (['paper','market','coins'].includes(pane.id)) return { ...pane, t: [], y: [], stack: [], rules: [], missing: 'Unavailable: the public ledger contains closes, not the observer or feed history.' }
    return { ...pane, title: pane.id === 'wallet' ? 'All books · position P&L' : 'Selected book · position P&L', subtitle: 'recorded position deltas in this window · excludes separately booked wallet gas', ...(c.missing ? { t: [], y: [], missing: 'Deliberately missing in this interface fixture.' } : {}) }
  }) })
  return { ...vm, canControl: false, mode: 'shadow', kernelId: absent('Not a replay certificate', 'display export'),
    zeroText: 'retirement ledger export', seq: 0, hasUsd: false,
    trading: { ...vm.trading, state: shown({ value: 'historical', text: c.id === 'retired' ? 'RETIRED' : 'HISTORICAL VIEW', tone: 'muted' }), why: historical, occupancy: c.id === 'retired' ? '0' : 'not reconstructed', size: absent('Historical switch state unavailable', 'not reconstructed') },
    streams: { logs: absent(historical, 'unavailable'), feed: absent(historical, 'unavailable'), overlay: absent(historical, 'unavailable'), blocking: null, gaps: 0 },
    wallet: { ...vm.wallet, closed: c.missing ? absent<number>('Missing evidence in interface fixture') : vm.wallet.closed, sinceZeroEth: absent('Accounting epoch is not reconstructed', 'unavailable'), sinceZeroUsd: absent('USD conversion omitted'), drawdown: bar(null, 'not reconstructed', 'muted', 'Historical peak path unavailable'), drawdownText: 'not reconstructed' },
    bookTabs: vm.bookTabs.map(t => ({ ...t, adjustable: false, state: absent('Historical guard and size switches unavailable', 'guard unavailable'), stakeEth: 'historical rules vary' })),
    walletPayload: payload(vm.walletPayload), chartPayload: payload(vm.chartPayload),
    exits: vm.exits.map(e => ({ ...e, tokenText: 'sample-' + Number(BigInt(e.token)), tokenUrl: '#', curveUrl: '#', chartUrl: '#' })),
    notices: [...vm.notices, { id: 'account', reason: historical }],
    kpis: vm.kpis.map(k => ({ ...k, cells: c.missing ? k.cells.map(() => absent<number | string>('Missing evidence in interface fixture')) : k.cells, label: k.key.toLowerCase().includes('pnl') || k.label === 'P&L' ? 'Position P&L (before wallet gas)' : k.label })),
  }
}
for (const c of cases) {
  let state: State = emptyState(cfg, { sizeWei: 0n, mode: 'shadow', at: c.at, by: 'static display' })
  const history = new History()
  for (const p of c.missing ? [] : rows) {
    const at = p.abandonedAt ?? p.closedAt ?? p.openedAt
    if (at > c.at) continue
    state = { ...state, at, seq: state.seq + 1 }
    state.positions.set(p.id, p)
    history.observe({ kind: 'clock', run: 'historical-display', at, seq: state.seq }, state, [], [])
  }
  state = { ...state, at: c.at }
  history.observe({ kind: 'clock', run: 'historical-display', at: c.at, seq: state.seq + 1 }, state, [], [])
  if (c.id === 'retired') state = { ...state, walletBalance: { value: BigInt(retirement.walletWei), at: retirement.at, source: 'chain', n: 1 } }
  for (const book of cfg.books) for (const windowLabel of ['1h','4h','12h','24h','3d','7d']) {
    const unavailable = { paper: 'Observer history unavailable in this ledger export.', truePeak: 'Independent observer peak unavailable.', ...(c.id !== 'retired' ? { account: 'No wallet balance history is available at this selected time.' } : {}), ...(c.missing ? { money: 'Missing-data interface fixture; no historical rows are shown.' } : {}) }
    const vm = sanitizeVm(project(state, history, { unavailable, ethUsd: null, canControl: false, selectedBook: book.id, windowLabel, exitsBook: null }), c)
    const rendered = renderRegions(vm, [])
    rendered.open = `<section class="card"><h2>Open positions</h2><p>${c.id === 'retired' ? 'Zero at retirement, confirmed by the saved final check.' : 'Historical open inventory is unavailable in this closed-position export.'}</p></section>`
    rendered.hdr = rendered.hdr.replace(/\d+ declared · \d+ funded/, '2 historical books · funding not reconstructed')
    views[`${c.id}|${book.id}|${windowLabel}`] = rendered
    if (c.id === 'active' && book.id === 'untaxed' && windowLabel === '24h') initial = vm
  }
}
if (!initial) throw new Error('No initial display')
const style = `<style>.demo-banner{position:sticky;top:0;z-index:100;background:#162824;border-bottom:1px solid #407b67;padding:14px 20px;color:#e3f3ed;font:14px system-ui;line-height:1.5}.demo-banner strong{display:block;letter-spacing:.08em}.demo-banner select{background:#101c19;color:#e3f3ed;padding:7px;border:1px solid #407b67;margin:6px 8px 0 0;border-radius:4px;max-width:100%}.demo-banner a{color:#9bdbc2}.mode{display:none!important}.demo-note{max-width:1200px;margin:0 auto}.demo-banner small{display:block;color:#b6cdc4}a[href="#"]{pointer-events:none}</style>`
const banner = `<aside class="demo-banner"><div class="demo-note"><strong>SNIPE / HISTORICAL DEMO / READ ONLY</strong><label for="demo-case">View <select id="demo-case">${cases.map(c => `<option value="${c.id}">${c.title}</option>`).join('')}</select></label><a href="../results/performance.md">Result definitions</a> · <a href="../docs/interface.md">Interface notes</a><small>Source captured 25 Oct 2026. Selected trading view ends 19 Sep 2026 23:59:59 UTC. Position P&amp;L excludes separately booked wallet gas. No network, wallet, or trading connection.</small></div></aside>`
let page = renderPage(initial, [], loadVendor())
page = page.replace(`<script>${CLIENT_JS}</script>`, '<script src="views.js"></script><script src="client.js"></script>')
  .replace(/<link[^>]+(?:icon|manifest)[^>]*>/g, '').replace('</head>', style + '</head>').replace('<body>', '<body>' + banner)
  .replace('</head>', '<meta http-equiv="Content-Security-Policy" content="default-src \'self\' data:; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; connect-src \'none\'; object-src \'none\'">' + '</head>')
  .replace(/<title>[^<]*<\/title>/, '<title>Snipe · historical dashboard demo</title>')
  .replace('<div class="region" id="r-open">' + renderRegions(initial, []).open + '</div>', '<div class="region" id="r-open">' + views['active|untaxed|24h']!.open + '</div>')
  .replace(/\d+ declared · \d+ funded/, '2 historical books · funding not reconstructed')
  .replaceAll('Total wallet</h2>', 'All books · position P&amp;L</h2>')
writeFileSync(join(root, 'demo/index.html'), page)
writeFileSync(join(root, 'demo/views.js'), 'window.SNIPE_DEMO_VIEWS=' + JSON.stringify(views).replaceAll('<', '\\u003c') + ';\n')
writeFileSync(join(root, 'demo/manifest.json'), JSON.stringify({ schema: 1, sourceCaptured: '2026-10-25', cases, books: cfg.books.map(b => b.id), windows: ['1h','4h','12h','24h','3d','7d'], views: Object.keys(views).length, tradingControls: false, networkRequired: false, basis: 'Stored position deltas, excluding separately booked wallet gas. Missing observer data stays missing.' }, null, 2) + '\n')
console.log('Built', Object.keys(views).length, 'static historical views')
