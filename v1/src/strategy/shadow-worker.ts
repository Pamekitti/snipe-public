/** One background process. It has no signing or transaction-sending imports. */
import Database from 'better-sqlite3'
import { readClient } from '../rpc/read.js'
import { EVENT_TOPICS } from '../abi.js'
import { ADDRESSES, STRATEGY } from '../config.js'
import { ShadowAccount, SHADOW_KERNEL, encodeShadow, type ShadowIntent, type ShadowJob } from './shadow-account.js'
import { gapVerdict, requireStableSource, scanCandidates, transientDbError } from './shadow-source.js'

const db = new Database(process.argv[2]!)
// 1s was not enough: the main process writes launches at 12k-36k a day into the same file,
// and on 2026-09-12 a SQLITE_BUSY inside cacheCoverage latched source_fault and stopped the
// observer for four hours. Both handles now wait 5s. src/telemetry/db.ts sets the same.
db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000')
const account = new ShadowAccount(db)
const gate = new Database(process.argv[3]!, { readonly: true, fileMustExist: true })
const client = readClient(undefined, { publicLogs: true, onProviderRequest: method => process.send?.({ type: 'rpc', method }) })
let config = process.argv[4]!
let error: string | null = null
let busy = false
let stopped = false
let captureReady = false
const streamGaps: Array<[number, number]> = []
const meta = (key: string, value: string) => db.prepare('INSERT OR REPLACE INTO shadow_meta VALUES (?,?)').run(key, value)
const metaGet = (key: string) => (db.prepare('SELECT value FROM shadow_meta WHERE key=?').get(key) as { value: string } | undefined)?.value

/** A launch the live feed never saw. Kept visible and counted, never silently dropped. */
function recordFeedGap(token: string) {
  let tokens: string[] = []
  try { const saved: unknown = JSON.parse(metaGet('feed_gap_tokens') ?? '[]'); if (Array.isArray(saved)) tokens = saved.filter((t): t is string => typeof t === 'string') } catch {}
  if (tokens.includes(token)) return
  meta('feed_gap_count', String(Number(metaGet('feed_gap_count') ?? 0) + 1))
  meta('feed_gap_tokens', encodeShadow([...tokens, token].slice(-20)))
}

function cacheCoverage(lo: number, hi: number, rows: any[], curves: string[]) {
  // Every statement prepared once, outside the transaction: the write lock is held for the
  // loop, and the main process is blocked behind it for as long as this takes.
  const save = db.prepare('INSERT OR REPLACE INTO shadow_source_logs VALUES (?,?,?,?)')
  const priorOf = db.prepare('SELECT json FROM shadow_source_logs WHERE curve=? AND block=? AND idx=?')
  const cover = db.prepare('INSERT OR IGNORE INTO shadow_coverage VALUES (?,?,?)')
  db.transaction(() => {
    for (const r of rows) {
      const address = String(r.address).toLowerCase()
      if (!curves.includes(address)) continue
      if (r.removed) throw new Error('removed chain log requires source repair')
      const block = Number(r.blockNumber), idx = Number(r.logIndex)
      const raw = { ...r, address, blockNumber: '0x'+block.toString(16), logIndex: '0x'+idx.toString(16) }
      const prior = priorOf.get(address, block, idx) as { json: string } | undefined
      if (prior && JSON.parse(prior.json).blockHash !== raw.blockHash) throw new Error('chain hash changed; source repair required')
      save.run(address, block, idx, encodeShadow(raw))
    }
    for (const curve of curves) cover.run(curve, lo, hi)
  })()
}

process.on('message', (m: any) => {
  try {
    if (m.type === 'config') config = m.config
    if (m.type === 'coverage') {
      const prior = db.prepare("SELECT value FROM shadow_meta WHERE key='capture_cursor'").get() as { value: string } | undefined
      if (prior && m.lo > Number(prior.value)+1) {
        streamGaps.push([Number(prior.value)+1, m.lo-1])
        meta('stream_gaps', encodeShadow(streamGaps))
      }
      meta('capture_cursor', String(Math.max(m.hi, Number(prior?.value ?? 0))))
      captureReady = streamGaps.length === 0
      const pending = db.prepare("SELECT intent FROM shadow_jobs WHERE status IN ('queued','source-error')").all() as Array<{ intent: string }>
      const curves = pending.map(r => JSON.parse(r.intent).curve as string)
      if (curves.length) cacheCoverage(m.lo, m.hi, m.rows, curves)
    }
    if (m.type === 'stop') stopped = true
  } catch (e) { error = String(e); if (!transientDbError(e)) meta('source_fault', error) }
})

async function header(block: number) {
  const cached = db.prepare('SELECT hash,timestamp FROM shadow_headers WHERE block=?').get(block) as { hash: string; timestamp: number } | undefined
  if (cached) return cached
  const h = await client.getBlock({ blockNumber: BigInt(block) })
  if (!h.hash) throw new Error('missing canonical block hash')
  const row = { hash: h.hash, timestamp: Number(h.timestamp) }
  db.prepare('INSERT OR REPLACE INTO shadow_headers VALUES (?,?,?)').run(block, row.hash, row.timestamp)
  return row
}

async function source(i: ShadowIntent, tip: number) {
  // Live poll coverage is a cache hint, not completeness proof. The provider can return
  // an incomplete head block without an error. Verify the settled interval twice.
  const scan = async () => {
    const result: any[]=[]
    for (let from = i.block; from <= tip; from += 2000) {
      const to = Math.min(tip, from+1999)
      const rows = await client.request({ method: 'eth_getLogs', params: [{ address: i.curve as `0x${string}`,
        fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [Object.values(EVENT_TOPICS)] }] } as any) as any[]
      result.push(...rows)
    }
    return result
  }
  const first = await scan()
  await new Promise(resolve => setTimeout(resolve, 1000))
  const logs = requireStableSource(first, await scan())
  cacheCoverage(i.block, tip, logs, [i.curve])
  const blocks: Record<string, { timestamp: number }> = {}
  for (const r of logs) {
    const h = await header(Number(r.blockNumber))
    if (r.blockHash !== h.hash) throw new Error('log/header hash mismatch')
    blocks[r.blockNumber] = { timestamp: h.timestamp }
  }
  return { logs, blocks, coverage: { from: i.block, to: tip, complete: true, source: 'settled-history-double-scan', settleMs: 10000, scanGapMs: 1000 } }
}

async function buyCost(hashes: string[]): Promise<string> {
  const values: bigint[] = []
  for (const hash of hashes) {
    const key = `receipt:${hash}`
    const cached = db.prepare('SELECT value FROM shadow_meta WHERE key=?').get(key) as { value: string } | undefined
    if (cached) values.push(BigInt(cached.value))
    else {
      const r = await client.getTransactionReceipt({ hash: hash as `0x${string}` })
      const gas = r.gasUsed * r.effectiveGasPrice
      meta(key, gas.toString()); values.push(gas)
    }
  }
  values.sort((a,b) => a<b ? -1 : a>b ? 1 : 0)
  return ((values[Math.floor((values.length-1)/2)]! + values[Math.floor(values.length/2)]!) / 2n).toString()
}

function publishStatus() {
  const fault = db.prepare("SELECT value FROM shadow_meta WHERE key='source_fault'").get() as { value: string } | undefined
  const unavailable = db.prepare("SELECT error FROM shadow_jobs WHERE status='unavailable' ORDER BY id LIMIT 1").get() as { error: string } | undefined
  const pending = db.prepare("SELECT COUNT(*) n,MIN(entry) oldest FROM shadow_jobs WHERE status IN ('queued','source-error')").get() as { n: number; oldest: number | null }
  const proof = db.prepare('SELECT value FROM shadow_meta WHERE key=?').get(`verified:${config}`) as { value: string } | undefined
  process.send?.({ type: 'status', at: Date.now(), config, error: fault?.value ?? unavailable?.error ?? (!captureReady ? 'stream coverage awaiting verification' : error),
    pending: pending.n, oldestPending: pending.oldest, verified: !!proof,
    outcomes: account.outcomes(config, Date.now()) })
}

async function tick() {
  if (stopped) { process.exit(0); return }
  if (busy) return
  busy = true
  try {
    const fault = db.prepare("SELECT 1 FROM shadow_meta WHERE key='source_fault'").get()
    if (fault) return
    if (streamGaps.length) {
      const [lo, hi] = streamGaps[0]!
      const to = Math.min(hi, lo+1999)
      const rows = await client.request({ method: 'eth_getLogs', params: [{ address: ADDRESSES.factory,
        fromBlock: `0x${lo.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [EVENT_TOPICS.TokenLaunched] }] } as any) as any[]
      for (const r of rows) {
        const token = '0x'+r.topics[1].slice(-40).toLowerCase()
        const known = db.prepare('SELECT passed,creator_tax_bps tax,exemptions ex FROM launches WHERE token=?').get(token) as any
        const captured = db.prepare('SELECT 1 FROM shadow_jobs WHERE token=?').get(token)
        const verdict = gapVerdict(known, !!captured, { tax: STRATEGY.minCreatorTaxBps, exemptions: STRATEGY.minExemptionsToEnter })
        if (verdict === 'feed-gap') recordFeedGap(token)
        if (verdict === 'missed') {
          meta('source_fault', `uncaptured launch ${token} during stream gap ${lo}-${to}; admission reconstruction required`)
          return
        }
      }
      if (to === hi) streamGaps.shift(); else streamGaps[0] = [to+1, hi]
      meta('stream_gaps', encodeShadow(streamGaps)); captureReady = streamGaps.length === 0
    }
    const job = db.prepare("SELECT * FROM shadow_jobs WHERE status IN ('queued','source-error') ORDER BY entry,id LIMIT 1").get() as ShadowJob | undefined
    if (job) {
      let i: ShadowIntent = JSON.parse(job.intent)
      if (i.kernel !== SHADOW_KERNEL) {
        db.prepare("UPDATE shadow_jobs SET status='unavailable',error=? WHERE id=?")
          .run('execution version changed; original intent preserved; explicit reconstruction required', job.id)
        return
      }
      const admission = account.admission(job)
      if (!admission.allow) {
        if (admission.reason === 'unresolved_prior_execution') throw new Error(admission.reason)
        db.prepare("UPDATE shadow_jobs SET status='rejected',error=? WHERE id=?").run(admission.reason, job.id)
      } else {
        const calibration = i.calibration
        if (!calibration || calibration.n < 20 || calibration.latest >= i.entry) throw new Error('missing preceding entry-pinned cost samples')
        const completeAt = i.entry + calibration.sendMs + calibration.openMs + i.config.rules.maxHoldMs + 3000
        if (Date.now() < completeAt) return
        const tip = Math.max(i.block, Number(await client.getBlockNumber({ cacheTime: 0 })) - 100)
        const tipHeader = await header(tip)
        if (tipHeader.timestamp*1000 > Date.now()-10000) return
        if (tipHeader.timestamp*1000 < completeAt) return
        const endAt = Math.min(tipHeader.timestamp*1000, i.entry+180000)
        // The tip still proves settlement above. The scan itself stops at the first candidate
        // whose header is past endAt, because the replay never reads a log after that.
        let scanTo = tip
        for (const candidate of scanCandidates(i.block, i.launched, endAt, tip)) {
          if (candidate >= tip || (await header(candidate)).timestamp*1000 >= endAt) { scanTo = candidate; break }
        }
        const data = await source(i, scanTo)
        const request = { ...data, params: i.params, token: i.token, curve: i.curve, wallet: i.wallet,
          entryAt: i.entry, buyAt: i.entry+calibration.sendMs, openedAt: i.entry+calibration.openMs,
          takeProfit: i.tp, rules: i.config.rules, sizeWei: admission.size.toString(),
          maxEntryMultiple: i.config.maxEntryMultiple, gasWei: calibration.gasWei, buyGasWei: await buyCost(calibration.buyHashes),
          sellDelayMs: 1200, pollMs: 50, endAt, calibration }
        account.complete(job, request, Date.now())
      }
      error = null
    }
  } catch (e) { error = String(e) }
  finally {
    try { account.publish(gate, Date.now()) } catch (e) { error = String(e) }
    busy = false; publishStatus()
  }
}
// A latch left over from a contention error is the bug fixed above, not evidence that the
// replay is wrong, so clear it once at boot and keep the record. A correctness latch still
// stops the observer until a human has looked at it.
const latched = metaGet('source_fault')
if (latched && transientDbError(latched)) {
  db.prepare("DELETE FROM shadow_meta WHERE key='source_fault'").run()
  meta('source_fault_cleared', encodeShadow({ at: Date.now(), was: latched }))
}
const savedGaps = db.prepare("SELECT value FROM shadow_meta WHERE key='stream_gaps'").get() as { value: string } | undefined
if (savedGaps) streamGaps.push(...JSON.parse(savedGaps.value))
setInterval(publishStatus, 5000)
setInterval(() => void tick(), 1000)
void tick()
