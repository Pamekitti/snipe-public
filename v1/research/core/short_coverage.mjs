/** Compare every signed Pons buy in a V2 tape with Lighter's current market catalog.
 * Read-only. It never loads a wallet key or submits an order.
 * Usage: node v1/research/core/short_coverage.mjs [tape.db]
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../../../v2/package.json', import.meta.url))
const Database = require('better-sqlite3')
const { createPublicClient, http, parseTransaction } = require('viem')

const root = fileURLToPath(new URL('../../../', import.meta.url))
const tapePath = process.argv[2] ?? `${root}v1/data/research/20260921-adaptive-size-v1/source/tape-through-20260921.db`
const checkedAt = new Date().toISOString()
const outputDir = `${root}v1/data/research/short-coverage-${checkedAt.replace(/[:.]/g, '-')}`
mkdirSync(outputDir, { recursive: false })

const db = new Database(tapePath, { readonly: true, fileMustExist: true })
const tapeRange = db.prepare('SELECT min(seq) lo, max(seq) hi, min(at) firstAt, max(at) lastAt FROM events').get()
const metaByCurve = new Map()
for (const row of db.prepare("SELECT body FROM events WHERE kind='chain-read'").iterate()) {
  let body
  try { body = JSON.parse(row.body) } catch { continue }
  if (body.request?.kind !== 'meta' || !body.result?.params) continue
  metaByCurve.set(String(body.request.args[0]).toLowerCase(), {
    curve: String(body.request.args[0]).toLowerCase(),
    token: String(body.request.args[1]).toLowerCase(),
    taxBps: Number(body.result.params.creatorTaxBps),
    launchedAt: Number(body.result.params.launchedAt) * 1000,
  })
}

const buys = []
for (const row of db.prepare("SELECT seq,at,body FROM events WHERE kind='tx-signed' ORDER BY seq").iterate()) {
  const body = JSON.parse(row.body)
  if (body.txKind !== 'buy') continue
  let tx
  try { tx = parseTransaction(body.raw) } catch { continue }
  const meta = metaByCurve.get(String(tx.to).toLowerCase())
  buys.push({ seq: row.seq, at: row.at, hash: body.hash, curve: String(tx.to).toLowerCase(), ...meta })
}
db.close()

const tokens = [...new Set(buys.map(x => x.token).filter(Boolean))]
const chain = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
}
const client = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0], { timeout: 60_000 }) })
const symbolAbi = [{ type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }]
const symbolResults = []
for (let offset = 0; offset < tokens.length; offset += 200) {
  const chunk = tokens.slice(offset, offset + 200)
  const results = await client.multicall({
    contracts: chunk.map(address => ({ address, abi: symbolAbi, functionName: 'symbol' })),
    allowFailure: true,
    batchSize: 2048,
    multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
  })
  symbolResults.push(...results)
}

async function lighter(path) {
  const response = await fetch(`https://api.rh.lighter.xyz/api/v1/${path}`, { signal: AbortSignal.timeout(15_000) })
  const body = await response.json()
  if (!response.ok || body.code !== 200) throw new Error(`Lighter ${path} failed`)
  return body
}
const [marketResponse, assetResponse] = await Promise.all([lighter('orderBookDetails'), lighter('assetDetails')])
const markets = marketResponse.order_book_details.filter(x => x.market_type === 'perp' && x.status === 'active')
const marketBySymbol = new Map(markets.map(x => [x.symbol.toUpperCase(), x]))
const assetByAddress = new Map(assetResponse.asset_details.map(x => [x.l1_address.toLowerCase(), x]))

const rows = tokens.map((token, index) => {
  const symbolResult = symbolResults[index]
  const symbol = symbolResult.status === 'success' ? symbolResult.result : null
  const buy = buys.find(x => x.token === token)
  const book = buy.taxBps === 0 ? 'untaxed' : buy.taxBps >= 50 && buy.taxBps <= 200 ? 'taxed' : 'other'
  const candidate = symbol ? marketBySymbol.get(symbol.toUpperCase()) : null
  return {
    token, symbol, taxBps: buy.taxBps, launchedAt: buy.launchedAt, book,
    exactAssetRegistryMatch: assetByAddress.get(token) ?? null,
    symbolOnlyPerpCandidate: candidate ? {
      symbol: candidate.symbol,
      marketId: candidate.market_id,
      marketCreatedAt: Number(candidate.created_at),
      marketPredatesToken: Number(candidate.created_at) < buy.launchedAt,
    } : null,
    symbolError: symbolResult.status === 'failure' ? String(symbolResult.error) : null,
  }
})

const report = {
  diagnosticOnly: true,
  checkedAt,
  tape: { path: tapePath, ...tapeRange },
  definitions: {
    signedBuy: 'a tx-signed event whose txKind is buy',
    taxed: 'creator tax from 50 through 200 basis points',
    untaxed: 'creator tax equal to zero',
    exactMatch: 'Pons token contract equals a Lighter assetDetails l1_address',
    symbolCandidate: 'case-insensitive ticker equality only; copied tickers do not prove asset identity',
  },
  counts: {
    signedBuys: buys.length,
    mappedSignedBuys: buys.filter(x => x.token).length,
    uniqueTokens: tokens.length,
    untaxed: rows.filter(x => x.book === 'untaxed').length,
    taxed: rows.filter(x => x.book === 'taxed').length,
    other: rows.filter(x => x.book === 'other').length,
    symbolReadsSucceeded: rows.filter(x => x.symbol).length,
    symbolReadsFailed: rows.filter(x => x.symbolError).length,
    activeLighterPerps: markets.length,
    exactAssetRegistryMatches: rows.filter(x => x.exactAssetRegistryMatch).length,
    symbolOnlyCandidates: rows.filter(x => x.symbolOnlyPerpCandidate).length,
  },
  exactMatches: rows.filter(x => x.exactAssetRegistryMatch),
  symbolOnlyCandidates: rows.filter(x => x.symbolOnlyPerpCandidate),
  rows,
  limitations: [
    'Lighter perpetual market metadata exposes symbols and oracle prices but no underlying token contract address.',
    'A symbol match is not an identity match because Pons permits copied names and symbols.',
    'The tape ends at its recorded lastAt and is not a claim about later launches.',
    'This checks Lighter only; it does not prove that no short market exists anywhere else.',
  ],
}
const reportPath = `${outputDir}/coverage.json`
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
const manifest = {
  instrument: fileURLToPath(import.meta.url),
  instrumentSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  coverageSha256: createHash('sha256').update(readFileSync(reportPath)).digest('hex'),
}
writeFileSync(`${outputDir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ outputDir, counts: report.counts, symbolOnlyCandidates: report.symbolOnlyCandidates }, null, 2))
