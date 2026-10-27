/** Bounded transport evidence collector. No wallet, signer, dotenv, or broadcast imports. */
import { mkdirSync, writeFileSync, renameSync, existsSync, openSync, closeSync, appendFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { ComparisonBudget } from '../io/comparison-budget.js'
import { LogFilter } from '../io/log-filter.js'
import { EVENT_TOPICS } from '../io/abi.js'
import type { RawLog } from '../core/events.js'
import { CU } from '../io/cu.js'

const PUBLIC = 'https://rpc.mainnet.chain.robinhood.com'
const topics = Object.values(EVENT_TOPICS)
const key = (l: RawLog) => `${l.blockHash}:${l.logIndex}`
const normalize = (l: any): RawLog => {
  if (!l || l.removed || !Array.isArray(l.topics) || typeof l.data !== 'string'
    || typeof l.address !== 'string' || typeof l.transactionHash !== 'string' || typeof l.blockHash !== 'string'
    || !/^0x[0-9a-f]+$/i.test(l.blockNumber) || !/^0x[0-9a-f]+$/i.test(l.logIndex)) throw new Error('invalid log evidence')
  return { address: l.address.toLowerCase(), topics: l.topics, data: l.data, transactionHash: l.transactionHash,
    blockHash: l.blockHash, blockNumber: Number(l.blockNumber), logIndex: Number(l.logIndex), transactionIndex: Number(l.transactionIndex ?? 0) }
}
function stats(values: number[]) {
  if (!values.length) return { n: 0, mean: null, median: null, sd: null, p95: null }
  const sorted = [...values].sort((a, b) => a - b), mean = values.reduce((a, b) => a + b, 0) / values.length
  return { n: values.length, mean, median: (sorted[Math.floor((values.length - 1) / 2)]! + sorted[Math.floor(values.length / 2)]!) / 2,
    sd: Math.sqrt(values.reduce((s, x) => s + (x - mean) ** 2, 0) / values.length), p95: sorted[Math.ceil(values.length * .95) - 1] }
}

async function main() {
  const [outputArg, hoursArg = '24'] = process.argv.slice(2)
  const endpoint = process.env.RESEARCH_RPC_URL, budgetPath = process.env.RESEARCH_PAID_BUDGET_PATH
  const maximum = Number(process.env.RESEARCH_MAX_PAID_REQUESTS), hours = Number(hoursArg)
  if (!outputArg || !endpoint || !budgetPath || process.env.RESEARCH_ALLOW_PAID !== '1'
    || !Number.isSafeInteger(maximum) || maximum <= 0 || maximum > 100_000 || !Number.isFinite(hours) || hours <= 0 || hours > 24) {
    throw new Error('usage: rpc-economy-compare OUTPUT.json [HOURS<=24]; explicit RESEARCH_RPC_URL, RESEARCH_ALLOW_PAID=1, shared RESEARCH_PAID_BUDGET_PATH and RESEARCH_MAX_PAID_REQUESTS<=100000 required')
  }
  const output = resolve(outputArg)
  if (existsSync(output)) throw new Error('comparison output already exists; choose a new run path')
  mkdirSync(dirname(output), { recursive: true }); mkdirSync(dirname(budgetPath), { recursive: true })
  const budget = new ComparisonBudget(budgetPath, maximum)
  const arrivalPath = `${output}.arrivals.jsonl`
  const arrivalFd = openSync(arrivalPath, 'wx', 0o600)
  const started = Date.now(), ends = started + hours * 3_600_000
  const measurements: Array<{ at: number; route: string; method: string; ms: number; ok: boolean; cu: number }> = []
  let stopping = false, stopReason: string | null = null
  process.once('SIGTERM', () => { stopping = true }); process.once('SIGINT', () => { stopping = true })
  const rpc = async (route: 'public' | 'paid', method: string, params: unknown[]): Promise<any> => {
    if (route === 'paid') budget.claim([method])
    const at = Date.now(); let ok = false
    try {
      const response = await fetch(route === 'public' ? PUBLIC : endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(750),
      })
      if (!response.ok) { void response.body?.cancel(); throw new Error(`HTTP ${response.status}`) }
      const value = await response.json() as any
      if (value.error || value.result == null) throw new Error('RPC returned no usable result')
      if (['eth_blockNumber', 'eth_getLogs', 'eth_getFilterChanges'].includes(method)) {
        appendFileSync(arrivalFd, JSON.stringify({ route, method, requestedAt: at, receivedAt: Date.now(),
          ...(method === 'eth_getLogs' ? { range: params[0] } : {}), result: value.result }) + '\n')
      }
      ok = true; return value.result
    } finally {
      measurements.push({ at, route, method, ms: Date.now() - at, ok, cu: route === 'paid' ? CU[method]! : 0 })
    }
  }
  const filter = new LogFilter({ topics, normalize, request: (method, params) => rpc('paid', method, params) })
  const readHead = async (route: 'public' | 'paid') => {
    const result = await rpc(route, 'eth_blockNumber', [])
    if (typeof result !== 'string' || !/^0x[0-9a-f]+$/i.test(result)) throw new Error('invalid head')
    return Number(result)
  }
  const scan = async (route: 'public' | 'paid', from: number, through: number): Promise<RawLog[]> => {
    const rows: RawLog[] = []
    for (let lo = from; lo <= through; lo += 2000) {
      const raw = await rpc(route, 'eth_getLogs', [{ fromBlock: `0x${lo.toString(16)}`, toBlock: `0x${Math.min(through, lo + 1999).toString(16)}`, topics: [topics] }])
      if (!Array.isArray(raw)) throw new Error('invalid range response')
      rows.push(...raw.map(normalize))
    }
    return rows
  }
  let publicCursor = await readHead('public'), verified = publicCursor, auditAt = 0
  const publicRows = new Map<string, RawLog>(), references = new Map<string, RawLog>(), launches = new Set<string>()
  let missing = 0, mismatched = 0, audited = 0
  const save = () => {
    const now = Date.now()
    const windows = [{ hours: 24, bins: 8 }, { hours: 168, bins: 7 }].map(w => ({ ...w,
      rows: Array.from({ length: w.bins }, (_, i) => {
        const from = now - w.hours * 3_600_000 + i * w.hours * 3_600_000 / w.bins, to = from + w.hours * 3_600_000 / w.bins
        const rows = measurements.filter(x => x.at >= from && x.at < to)
        return { from, to, partial: from < started, requests: rows.length, failures: rows.filter(x => !x.ok).length,
          paidUnits: rows.reduce((n, x) => n + x.cu, 0), publicLatency: stats(rows.filter(x => x.route === 'public').map(x => x.ms)), paidLatency: stats(rows.filter(x => x.route === 'paid').map(x => x.ms)) }
      }) }))
    const result = { started, at: now, durationHours: (now - started) / 3_600_000, holdoutStarts: ends - 6 * 3_600_000,
      allowance: budget.status(), filter: filter.status(), publicCursor, verified, audited, missing, mismatched, launches: launches.size,
      windows, stopReason, activationReady: false,
      remainingEvidence: ['paired entry and guard decisions with at least 20 reference opportunities', 'final six-hour holdout', 'per-feature net savings including verification'],
      arrivalPath,
      note: 'Transport evidence only. This collector cannot certify profit or authorize activation.' }
    writeFileSync(`${output}.tmp`, JSON.stringify(result, null, 2)); renameSync(`${output}.tmp`, output)
  }
  try {
    while (!stopping && Date.now() < ends) {
      const tick = Date.now()
      try {
        const head = await readHead('public')
        if (head < publicCursor) throw new Error('public head regressed')
        const rows = await scan('public', publicCursor, head)
        for (const row of rows) publicRows.set(key(row), row)
        publicCursor = head
      } catch { /* failed scans advance neither cursor nor coverage */ }
      try {
        await filter.poll(verified, true)
        if (Date.now() - auditAt >= 30_000) {
          const head = await readHead('paid')
          await filter.poll(verified, true)
          const rows = await scan('paid', verified, head)
          filter.verify(verified, head, rows)
          for (const row of rows) {
            references.set(key(row), row)
            if (row.topics[0] === EVENT_TOPICS.TokenLaunched) launches.add(row.transactionHash)
          }
          verified = head; auditAt = Date.now()
          for (const [id, row] of references) if (row.blockNumber < Math.min(verified, publicCursor)) {
            const other = publicRows.get(id)
            if (!other) missing++
            else if (JSON.stringify(other) !== JSON.stringify(row)) mismatched++
            audited++; references.delete(id); publicRows.delete(id)
          }
          for (const [id, row] of publicRows) if (row.blockNumber < Math.min(verified, publicCursor)) {
            mismatched++; publicRows.delete(id)
          }
          save()
          if (filter.disabledReason) { stopReason = filter.disabledReason; break }
        }
      } catch (e) {
        if (String(e).includes('allowance')) { stopReason = 'comparison allowance exhausted'; break }
        filter.repair()
      }
      if (publicRows.size + references.size > 100_000) { stopReason = 'comparison evidence backlog exceeded'; break }
      await new Promise(r => setTimeout(r, Math.max(0, 1000 - (Date.now() - tick))))
    }
  } finally { save(); budget.close(); closeSync(arrivalFd) }
  console.log(JSON.stringify({ output, stopReason, activationReady: false }))
}
main().catch(e => { console.error(String(e.message).replace(/(?:https?|wss?):\/\/\S+/gi, '[RPC]')); process.exitCode = 1 })
