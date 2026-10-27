/**
 * Ground truth from the tape: signed buys vs CurveBuy/CurveSell logs.
 *   npx tsx tools/fill-audit.ts data/tape.db
 */
import { parseTransaction } from 'viem'
import Database from 'better-sqlite3'

const path = process.argv[2] ?? '/tmp/t-miss.db'
const db = new Database(path, { readonly: true })

const buys = db.prepare(
  "SELECT seq, at, body FROM events WHERE kind='tx-signed' AND instr(body, '\"txKind\":\"buy\"')>0",
).all() as Array<{ seq: number; at: number; body: string }>
const sells = db.prepare(
  "SELECT seq, at, body FROM events WHERE kind='tx-signed' AND instr(body, '\"txKind\":\"sell\"')>0",
).all() as Array<{ seq: number; at: number; body: string }>

const buyHashes = new Set<string>()
const sellHashes = new Set<string>()
const buyRows: Array<{ at: number; hash: string; to: string | null; intentId: string }> = []

for (const r of buys) {
  const b = JSON.parse(r.body) as { hash: string; raw: string; intentId: string }
  const hash = b.hash.toLowerCase()
  buyHashes.add(hash)
  let to: string | null = null
  try {
    const tx = parseTransaction(b.raw as `0x${string}`)
    to = (tx.to ?? null)?.toLowerCase() ?? null
  } catch {
    to = null
  }
  buyRows.push({ at: r.at, hash, to, intentId: b.intentId })
}
for (const r of sells) {
  const b = JSON.parse(r.body) as { hash: string }
  sellHashes.add(b.hash.toLowerCase())
}

const buyHit = new Set<string>()
const sellHit = new Set<string>()
const CURVE_BUY = '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455'
const CURVE_SELL = '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df'

const logs = db.prepare("SELECT at, body FROM events WHERE kind='logs'").all() as Array<{ at: number; body: string }>
for (const row of logs) {
  const body = row.body
  for (const h of buyHashes) {
    if (buyHit.has(h)) continue
    if (body.includes(h.slice(2))) buyHit.add(h)
  }
  for (const h of sellHashes) {
    if (sellHit.has(h)) continue
    if (body.includes(h.slice(2))) sellHit.add(h)
  }
}

function utc(at: number): string {
  return new Date(at).toISOString().slice(0, 19).replace('T', ' ')
}

const filled = buyRows.filter((b) => buyHit.has(b.hash))
const unfilled = buyRows.filter((b) => !buyHit.has(b.hash))
const morning = buyRows.filter((b) => utc(b.at) >= '2026-09-18 07:00:00' && utc(b.at) < '2026-09-18 09:00:00')

console.log(JSON.stringify({
  signedBuys: buyRows.length,
  signedSells: sells.length,
  buyHashInLogs: buyHit.size,
  sellHashInLogs: sellHit.size,
  filled: filled.length,
  unfilled: unfilled.length,
  morning: morning.map((b) => ({
    at: utc(b.at),
    intentId: b.intentId,
    hash: b.hash.slice(0, 16),
    to: b.to,
    inLogs: buyHit.has(b.hash),
  })),
  unfilledByHour: unfilled.reduce<Record<string, number>>((acc, b) => {
    const h = utc(b.at).slice(0, 13)
    acc[h] = (acc[h] ?? 0) + 1
    return acc
  }, {}),
  filledByHour: filled.reduce<Record<string, number>>((acc, b) => {
    const h = utc(b.at).slice(0, 13)
    acc[h] = (acc[h] ?? 0) + 1
    return acc
  }, {}),
}, null, 2))
