/** Public-data feasibility probe. Never signs, submits orders, or loads wallet credentials.
 * Run from the repo root: node v1/research/core/short_feasibility.mjs
 * Quote walks are diagnostic arithmetic, not exchange fills or a profitability backtest.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
const require = createRequire(new URL('../../../v2/package.json', import.meta.url))
const Database = require('better-sqlite3')
const { decodeAbiParameters } = require('viem')
const root = fileURLToPath(new URL('../../../', import.meta.url))
const startedAt = new Date().toISOString()
const out = `${root}v1/data/research/short-feasibility-${startedAt.replace(/[:.]/g, '-')}`
mkdirSync(out, { recursive: false })
const requests = []
const save = (name, value) => writeFileSync(`${out}/${name}`, JSON.stringify(value, null, 2), { flag: 'wx' })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const base = 'https://api.rh.lighter.xyz/api/v1/'
async function get(path) {
  const began = Date.now()
  const record = { path, at: new Date(began).toISOString() }
  try {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(10000) })
    record.status = response.status
    record.body = await response.json()
    record.ok = response.ok && record.body.code === 200
  } catch (error) { record.ok = false; record.error = String(error) }
  record.latencyMs = Date.now() - began
  requests.push(record)
  return record
}
function stats(values) {
  const a = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!a.length) return { n: 0, mean: null, median: null, sd: null }
  const mean = a.reduce((s, x) => s + x, 0) / a.length
  return { n: a.length, mean, median: (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2,
    sd: a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / (a.length - 1)) : null,
    min: a[0], max: a.at(-1) }
}
function walk(rows, amount, descending) {
  const levels = rows.map(x => ({ price: Number(x.price), size: Number(x.remaining_base_amount) }))
    .filter(x => x.price > 0 && x.size > 0).sort((a, b) => descending ? b.price - a.price : a.price - b.price)
  let left = amount, quote = 0
  for (const x of levels) { const size = Math.min(left, x.size); quote += size * x.price; left -= size; if (left < 1e-10) break }
  return { complete: left < 1e-10, filled: amount - left, quote, averagePrice: amount - left > 0 ? quote / (amount - left) : null }
}
assert.equal(walk([{ price: '2', remaining_base_amount: '3' }], 4, true).complete, false)
assert.equal(walk([{ price: '2', remaining_base_amount: '3' }, { price: '1', remaining_base_amount: '2' }], 4, true).quote, 7)
const catalog = await get('orderBookDetails')
if (!catalog.ok) { save('requests.json', requests); throw new Error('Public market catalog unavailable') }
const markets = catalog.body.order_book_details.filter(x => x.market_type === 'perp')
const selected = ['PONS', 'CASHCAT', 'ANSEM'].map(s => markets.find(x => x.symbol === s)).filter(Boolean)
save('catalog.json', catalog)

// A bounded sample of recent observed launches, not a claim about executed buys or all tokens.
const tapePath = `${root}v1/data/research/20260921-adaptive-size-v1/source/tape-through-20260921.db`
const db = new Database(tapePath, { readonly: true, fileMustExist: true })
const tapeEnd = db.prepare('SELECT seq,at FROM events ORDER BY seq DESC LIMIT 1').get()
const seen = new Set(), cohort = [], count = { taxed: 0, untaxed: 0 }
for (const row of db.prepare("SELECT seq,at,body FROM events WHERE at>=? AND seq<=? AND kind='chain-read' ORDER BY at DESC").iterate(tapeEnd.at - 3600000, tapeEnd.seq)) {
  const b = JSON.parse(row.body)
  if (b.request?.kind !== 'meta' || !b.result?.params) continue
  const token = b.request.args[1]?.toLowerCase(), tax = Number(b.result.params.creatorTaxBps)
  if (!token || seen.has(token)) continue
  seen.add(token)
  const book = tax === 0 ? 'untaxed' : tax >= 50 && tax <= 200 ? 'taxed' : null
  if (!book || b.result.exemptions < 3 || b.result.exemptions == null || count[book] >= 6) continue
  count[book]++
  cohort.push({ token, curve: b.request.args[0], book, taxBps: tax, exemptions: b.result.exemptions,
    sourceSeq: row.seq, observedAt: row.at, launchedAt: Number(b.result.params.launchedAt) * 1000 })
  if (count.taxed === 6 && count.untaxed === 6) break
}
db.close()
for (const coin of cohort) {
  try {
    const r = await fetch('https://rpc.mainnet.chain.robinhood.com', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: coin.token, data: '0x95d89b41' }, 'latest'] })
    })
    const j = await r.json()
    coin.symbolResponse = j
    if (!j.result) throw new Error(JSON.stringify(j.error))
    coin.symbol = decodeAbiParameters([{ type: 'string' }], j.result)[0]
    coin.symbolCandidates = markets.filter(m => m.symbol.toUpperCase() === coin.symbol.toUpperCase()).map(m => m.market_id)
    coin.identityStatus = coin.symbolCandidates.length ? 'symbol candidate only; exact underlying unresolved' : 'no symbol candidate in this catalog; exact-address support unverified'
  } catch (error) { coin.symbolError = String(error); coin.identityStatus = 'unresolved' }
  await pause(250)
}
save('cohort.json', { tapePath, tapeEnd, sampleDefinition: 'latest six launches per creator-tax band with >=3 exemptions in the final recorded hour; other live filters not applied', coins: cohort })
console.log(JSON.stringify({ phase: 'cohort', counts: count, out }))

async function websocketProbe(durationMs) {
  const events = [], previous = new Map(), checked = new Map(), gaps = [], errors = []
  const began = Date.now()
  await new Promise(resolve => {
    const ws = new WebSocket('wss://api.rh.lighter.xyz/stream?readonly=true')
    let finished = false
    const finish = () => { if (!finished) { finished = true; clearTimeout(timer); ws.close(); resolve() } }
    const timer = setTimeout(finish, durationMs)
    ws.onopen = () => {
      for (const m of selected) ws.send(JSON.stringify({ type: 'subscribe', channel: `order_book/${m.market_id}` }))
    }
    ws.onmessage = event => {
      try {
        const body = JSON.parse(event.data)
        if (body.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return }
        events.push({ receivedAt: Date.now(), body })
        if (body.order_book) {
          const last = previous.get(body.channel), b = body.order_book
          if (body.type === 'update/order_book' && last != null && b.begin_nonce != null) {
            checked.set(body.channel, (checked.get(body.channel) ?? 0) + 1)
            if (b.begin_nonce !== last) gaps.push({ channel: body.channel, expected: last, begin: b.begin_nonce })
          }
          if (b.nonce != null) previous.set(body.channel, b.nonce)
        }
      } catch (error) { errors.push(String(error)) }
    }
    ws.onerror = () => { errors.push('WebSocket error'); finish() }
    ws.onclose = e => { if (!finished) errors.push(`early close ${e.code}`); finish() }
  })
  return { began, ended: Date.now(), durationMs: Date.now() - began, events, checks: Object.fromEntries(checked), gaps, errors }
}
const wsPromise = (async () => [await websocketProbe(30000), await websocketProbe(10000)])()
const samples = []
for (let round = 0; round < 8; round++) {
  for (const m of selected) {
    const r = await get(`orderBookOrders?market_id=${m.market_id}&limit=100`)
    if (!r.ok || !r.body.bids?.length || !r.body.asks?.length) { samples.push({ round, symbol: m.symbol, valid: false }); continue }
    const bid = Math.max(...r.body.bids.map(x => Number(x.price))), ask = Math.min(...r.body.asks.map(x => Number(x.price)))
    const step = 10 ** -m.supported_size_decimals
    const minimumSize = Math.ceil(Math.max(Number(m.min_base_amount), Number(m.min_quote_amount) / bid) / step - 1e-9) * step
    const size = Math.ceil(Math.max(minimumSize, 20 / bid) / step - 1e-9) * step
    const sell = walk(r.body.bids, size, true), buy = walk(r.body.asks, size, false)
    const valid = bid > 0 && ask >= bid && sell.complete && buy.complete
    samples.push({ round, at: r.at, symbol: m.symbol, valid, bid, ask, size, minimumSize,
      minimumQuote: minimumSize * bid, open: sell, closeSameSnapshot: buy,
      spreadPct: (ask - bid) / ((ask + bid) / 2) * 100,
      roundTripCostPct: valid ? (buy.quote - sell.quote) / sell.quote * 100 : null,
      roundTripCostQuote: valid ? buy.quote - sell.quote : null })
  }
  await pause(2000)
}
const tradeEvidence = []
for (const m of selected) {
  const r = await get(`recentTrades?market_id=${m.market_id}&limit=100`)
  const trades = r.ok ? r.body.trades : []
  tradeEvidence.push({ symbol: m.symbol, fetched: trades.length,
    reportedTakerShortIncreases: trades.filter(t => t.is_maker_ask === false && Number(t.taker_position_size_before) <= 0 && t.taker_position_size_before != null).length,
    reportedTakerShortReductions: trades.filter(t => t.is_maker_ask === true && Number(t.taker_position_size_before) < 0).length,
    latestTradeAt: trades.length ? Math.max(...trades.map(t => t.timestamp)) : null })
}
const wsRuns = await wsPromise
save('websocket.json', wsRuns)
save('requests.json', requests)
save('quote-walks.json', samples)
const summary = {
  startedAt, endedAt: new Date().toISOString(), readonly: true, signedOrders: 0, sentOrders: 0,
  activePerps: markets.filter(m => m.status === 'active').length,
  latestMarketCreatedAt: new Date(Math.max(...markets.map(m => Number(m.created_at)))).toISOString(),
  cohort: { tapeEnd, counts: count, symbolReads: cohort.filter(x => x.symbol).length,
    symbolCandidates: cohort.filter(x => x.symbolCandidates?.length).length, exactAddressMappingAvailable: false },
  requests: { total: requests.length, succeeded: requests.filter(x => x.ok).length,
    latencyMs: stats(requests.map(x => x.latencyMs)) },
  markets: selected.map(m => ({ symbol: m.symbol, marketId: m.market_id, minimumBase: m.min_base_amount,
    minimumQuote: m.min_quote_amount, status: m.status, forceReduceOnly: m.market_config?.force_reduce_only,
    quotes: samples.filter(s => s.symbol === m.symbol).length,
    usableQuotes: samples.filter(s => s.symbol === m.symbol && s.valid).length,
    spreadPct: stats(samples.filter(s => s.symbol === m.symbol && s.valid).map(s => s.spreadPct)),
    sameSnapshotRoundTripCostPct: stats(samples.filter(s => s.symbol === m.symbol && s.valid).map(s => s.roundTripCostPct)),
    minimumOrderQuote: stats(samples.filter(s => s.symbol === m.symbol && s.valid).map(s => s.minimumQuote)) })),
  tradeEvidence,
  websocket: wsRuns.map(r => ({ durationMs: r.durationMs, events: r.events.length,
    snapshots: r.events.filter(e => e.body.type === 'subscribed/order_book').length,
    continuityChecks: r.checks, gaps: r.gaps.length, errors: r.errors })),
  limitations: [
    'No account authentication, funded order, deposit, withdrawal, or transaction was attempted.',
    'A short public-data sample cannot establish long-term uptime, settlement, solvency, or executable fills.',
    'Symbol comparison is only candidate screening; exact underlying contract mappings are absent from the catalog.',
    'The cohort is observed launches from a dated local snapshot, not actual fills or a complete live universe.',
    'Quote walks use one snapshot, floating-point arithmetic, no queue position or order delay, and exclude funding and account-specific fees.',
    'No profitability backtest was run. Taxed/untaxed spot calibrations are not validated for derivatives.'
  ]
}
save('summary.json', summary)
const files = ['catalog.json', 'cohort.json', 'requests.json', 'quote-walks.json', 'websocket.json', 'summary.json']
save('manifest.json', { instrument: fileURLToPath(import.meta.url), instrumentSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  files: Object.fromEntries(files.map(f => [f, createHash('sha256').update(readFileSync(`${out}/${f}`)).digest('hex')])) })
console.log(JSON.stringify({ out, summary }, null, 2))
