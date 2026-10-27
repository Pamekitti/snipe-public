/** Stable event identity, excluding provider-specific transport metadata. */
export function canonicalSourceLogs(rows: any[]) {
  const unique = new Map<string, any>()
  for (const r of rows) {
    const block = Number(r.blockNumber), index = Number(r.logIndex)
    if (r.removed || !Number.isSafeInteger(block) || block < 0 || !Number.isSafeInteger(index) || index < 0
      || !r.blockHash || !r.transactionHash || !Array.isArray(r.topics)) throw new Error('invalid historical log')
    const row = { address: String(r.address).toLowerCase(), blockNumber: '0x'+block.toString(16),
      logIndex: '0x'+index.toString(16), blockHash: r.blockHash, transactionHash: r.transactionHash,
      topics: r.topics, data: r.data, removed: false }
    const key=block+':'+index, prior=unique.get(key)
    if (prior && JSON.stringify(prior)!==JSON.stringify(row)) throw new Error('conflicting historical log')
    unique.set(key,row)
  }
  return [...unique.values()].sort((a,b)=>Number(a.blockNumber)-Number(b.blockNumber)||Number(a.logIndex)-Number(b.logIndex))
}

/**
 * `source_fault` is a latch: the worker's tick does nothing at all while it is set, and only
 * a human clears it. That is right for anything that makes the replay WRONG (a removed log, a
 * block hash that changed under us, an admission we genuinely missed) and wrong for write
 * contention, which resolves itself on the next tick. Telling the two apart is the difference
 * between a four-hour outage and a retry: on 2026-09-12 a SQLITE_BUSY stopped the observer
 * from 18:53 until it was cleared by hand.
 */
export function transientDbError(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code
  if (typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))) return true
  return /database is locked|database table is locked|database schema is locked/i.test(String(e))
}

export type GapLaunch = { passed: number; tax: number; ex: number } | undefined

/**
 * What a launch found inside a stream gap means for the replay.
 *
 * `missed` is the only one that invalidates it: the coin is in `launches`, cleared the entry
 * screen, and has no job, so the shadow account's bankroll and concurrency are wrong from
 * that point on. A coin absent from `launches` is a `feed-gap`: the LIVE bot never saw it
 * either, so the account excluding it is faithful to what the bot could have done. Latching
 * on those stopped the observer for four hours on 2026-09-12 over ten seconds of stream.
 */
export function gapVerdict(known: GapLaunch, captured: boolean, floors: { tax: number; exemptions: number }): 'captured' | 'feed-gap' | 'declined' | 'missed' {
  if (captured) return 'captured'
  if (!known) return 'feed-gap'
  if (known.passed && known.tax >= floors.tax && known.ex >= floors.exemptions) return 'missed'
  return 'declined'
}

/**
 * Candidate upper bounds for a replay's log scan, tightest first.
 *
 * The replay walks logs only up to `endAt`, so scanning to the chain head buys nothing and
 * costs one 2,000-block chunk per 3.4 minutes of job age, twice. A fresh coin was 2 calls; a
 * seven-hour-old one was 264; the 218-job backlog after the 2026-09-12 stall would have been
 * about 29,000 on the live bot's budget. The worker takes these in order and keeps the first
 * whose real header is already past `endAt`, falling back to the tip. Block rates are in
 * blocks per second: Arbitrum ran 9.9 over the week measured, so 12 usually lands first.
 */
export function scanCandidates(block: number, launched: number, endAt: number, tip: number, rates: readonly number[] = [12, 30, 80]): number[] {
  if (!Number.isFinite(launched) || launched <= 0 || endAt <= launched) return [tip]
  const seconds = (endAt - launched) / 1000
  const out: number[] = []
  for (const rate of rates) {
    const candidate = Math.min(tip, block + Math.ceil(seconds * rate) + 100)
    if (candidate >= tip) break
    if (!out.includes(candidate)) out.push(candidate)
  }
  out.push(tip)
  return out
}

export function requireStableSource(first: any[], second: any[]) {
  const a=canonicalSourceLogs(first), b=canonicalSourceLogs(second)
  if (JSON.stringify(a)!==JSON.stringify(b)) throw new Error('historical source still changing')
  return b
}
