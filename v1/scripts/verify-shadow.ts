/** Compare prospective frozen requests with the pre-extraction research worker. */
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SHADOW_KERNEL, encodeShadow } from '../src/strategy/shadow-account.js'
import { proveExecutionSource } from './lib/shadow-source-proof.js'
import { readClient } from '../src/rpc/read.js'
import { EVENT_TOPICS } from '../src/abi.js'

const file = process.argv[2]
if (!file) throw new Error('usage: verify-shadow.ts DATABASE [--certify]')
const certify = process.argv.includes('--certify')
const db = new Database(resolve(file), { readonly: !certify, fileMustExist: true })
const latest = db.prepare('SELECT config FROM shadow_jobs ORDER BY id DESC LIMIT 1').get() as { config: string } | undefined
if (!latest) throw new Error('no shadow intents')
const config = latest.config
const started = db.prepare("SELECT value FROM shadow_meta WHERE key='capture_started_at'").get() as { value: string } | undefined
if (!started || !Number.isFinite(Number(started.value))) throw new Error('missing prospective capture boundary')
const rows = db.prepare("SELECT * FROM shadow_jobs WHERE config=? AND status='published' ORDER BY entry").all(config) as any[]
if (rows.length < 20) throw new Error(`prospective warmup ${rows.length}/20`)
const missing = db.prepare("SELECT token,status,error FROM shadow_jobs WHERE status IN ('unavailable','source-error')").all()
if (missing.length) throw new Error(`unresolved shadow executions: ${encodeShadow(missing)}`)
const fault = db.prepare("SELECT value FROM shadow_meta WHERE key='source_fault'").get()
if (fault) throw new Error(`source fault: ${encodeShadow(fault)}`)
const gaps = db.prepare("SELECT value FROM shadow_meta WHERE key='stream_gaps'").get() as { value: string } | undefined
if (gaps && JSON.parse(gaps.value).length) throw new Error('unresolved stream coverage gaps')
const reference = resolve('research/core/reference-worker-20260911.ts')
const child = spawn(process.execPath, ['--import','tsx', reference], {
  cwd: process.cwd(), env: { PATH: process.env.PATH, ENV_FILE: '/dev/null', MODE: 'observe', LIVE: '0', DASH: '0', DOTENV_CONFIG_QUIET: 'true' },
  stdio: ['pipe','pipe','inherit'],
})
const reader = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
const client = readClient(undefined, { publicLogs: true })
const checked: Array<{ id: number; hash: string; source: ReturnType<typeof proveExecutionSource> }> = []
// The independent fetch is the certificate's own evidence, so it has to survive the public
// endpoint's transient refusals: on 2026-09-13 the first run died 9 s in on one 429-shaped
// error with the cause thrown away, and the same call succeeded 111 ms later by hand. Three
// tries, backing off, and a short pace between chunks so ~300 calls do not arrive as a burst.
async function fetched<T>(what: string, token: string, call: () => Promise<T>): Promise<T> {
  let cause: unknown
  for (const waitMs of [0, 1000, 3000, 8000]) {
    if (waitMs) await new Promise(r => setTimeout(r, waitMs))
    try { const out = await call(); await new Promise(r => setTimeout(r, 120)); return out }
    catch (e) { cause = e }
  }
  const why = String((cause as any)?.shortMessage ?? (cause as any)?.message ?? cause).slice(0, 200)
  throw new Error(`independent ${what} fetch unavailable: ${token} (${why})`)
}
async function compare(request: any, expected: string, token: string) {
  child.stdin.write(JSON.stringify({ ...request, op: 'replay' })+'\n')
  const line = await reader.next()
  if (line.done) throw new Error('reference worker exited')
  const result = JSON.parse(line.value)
  if (!result.ok || encodeShadow(result.value) !== expected) throw new Error(`reference mismatch: ${token}`)
}
try {
  for (const row of rows) {
    const i = JSON.parse(row.intent), request = JSON.parse(row.request)
    if (i.kernel !== SHADOW_KERNEL || !request.coverage?.complete) throw new Error(`source identity/coverage: ${row.token}`)
    if (i.entry < Number(started.value) || request.coverage.source !== 'settled-history-double-scan'
      || request.coverage.settleMs !== 10000 || request.coverage.scanGapMs !== 1000) throw new Error(`unverified collection protocol: ${row.token}`)
    const { from, to } = request.coverage
    if (from !== i.block || !Number.isSafeInteger(to) || to < from) throw new Error(`invalid source range: ${row.token}`)
    let cursor = from
    const ranges = db.prepare('SELECT lo,hi FROM shadow_coverage WHERE curve=? ORDER BY lo').all(i.curve) as Array<{lo: number; hi: number}>
    for (const range of ranges) {
      if (range.lo > cursor) break
      cursor = Math.max(cursor, range.hi+1)
    }
    if (cursor <= to) throw new Error(`incomplete durable coverage: ${row.token}`)
    const logs: any[] = []
    for (let start=from; start<=to; start+=2000) {
      logs.push(...await fetched('source', row.token, () => client.request({ method:'eth_getLogs', params:[{address:i.curve,
        fromBlock:'0x'+start.toString(16),toBlock:'0x'+Math.min(to,start+1999).toString(16),topics:[Object.values(EVENT_TOPICS)]}] } as any) as Promise<any[]>))
    }
    const headers = new Map<number, {hash: string; timestamp: number}>()
    const blocks: Record<string, {timestamp: number}> = {}
    for (const log of [...request.logs,...logs]) {
      const block=Number(log.blockNumber)
      let header=headers.get(block) ?? db.prepare('SELECT hash,timestamp FROM shadow_headers WHERE block=?').get(block) as { hash: string; timestamp: number } | undefined
      if (!header) {
        const h=await fetched('header', row.token, () => client.getBlock({blockNumber:BigInt(block)}))
        if(h.hash) header={hash:h.hash,timestamp:Number(h.timestamp)}
      }
      if (!header || header.hash !== log.blockHash) throw new Error(`unverified block timestamp: ${row.token}`)
      headers.set(block,header); blocks[log.blockNumber]={timestamp:header.timestamp}
    }
    for (const log of request.logs) if (headers.get(Number(log.blockNumber))?.timestamp !== request.blocks[log.blockNumber]?.timestamp) throw new Error(`changed frozen timestamp: ${row.token}`)
    const source = proveExecutionSource(request.logs, logs, headers, row.close_at)
    if (!(row.available > Math.max(row.close_at, row.gate_at, row.published_at))) throw new Error(`publication ordering: ${row.token}`)
    if (!(request.calibration.latest < i.entry && request.calibration.n >= 20)) throw new Error(`noncausal calibration: ${row.token}`)
    if (encodeShadow(request.calibration) !== encodeShadow(i.calibration)) throw new Error(`changed cost samples: ${row.token}`)
    if (request.takeProfit !== i.tp || request.entryAt !== i.entry || request.sizeWei !== row.size) throw new Error(`unpinned intent: ${row.token}`)
    await compare(request,row.result,row.token)
    await compare({...request,logs,blocks},row.result,row.token)
    checked.push({ id: row.id, source, hash: createHash('sha256').update(row.intent+row.request+row.result+row.available).digest('hex') })
  }
} finally { child.stdin.end(); reader.return?.(); child.kill() }
const proof = { config, kernel: SHADOW_KERNEL, at: Date.now(), count: checked.length, checked,
  referenceSha256: createHash('sha256').update(readFileSync(reference)).digest('hex'),
  verdict: 'execution-and-publication-parity', profitabilityValidated: false }
if (certify) db.transaction(() => {
  const stop = db.prepare("SELECT value FROM chain_truth WHERE key='operator_stop'").get() as { value: string } | undefined
  if (stop?.value !== '1') throw new Error('operator STOP must remain set during certification')
  db.prepare('INSERT OR REPLACE INTO shadow_meta VALUES (?,?)').run(`verified:${config}`, JSON.stringify(proof))
})()
console.log(JSON.stringify(proof, null, 2))
db.close()
