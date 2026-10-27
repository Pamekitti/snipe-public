/**
 * Compare the current venue guard with correlation-aware variants on one tape.
 *
 * This is a guard-only opportunity replay. It holds the observed launch outcomes fixed and
 * changes only how those outcomes vote on halt/reopen. It does not reconstruct wallet fills,
 * nonce contention, gas, capacity or the cash-drawdown stop, so ETH figures are scaled
 * simulator equivalents rather than booked wallet P&L.
 *
 *   npx tsx tools/guard-robustness-backtest.ts <tape.db> [config/strategy.toml]
 */
import { decodeFunctionData, type Hex } from 'viem'
import { decide } from '../core/decide.js'
import { venueVerdict } from '../core/guard.js'
import { emptyState } from '../core/state.js'
import type { FrozenConfig, Switches } from '../core/config.js'
import type { Observation, Outcome, State } from '../core/state.js'
import { launcherAbi } from '../io/abi.js'
import { loadConfig } from '../io/config-load.js'
import { Tape } from '../io/tape.js'
import { HistoricalTransactionCache } from './research-rpc.js'

const HOUR = 3_600_000
const CLUSTER_MS = 60_000
const HOLDOUT_MS = 6 * HOUR
const RPC_BATCH = 25
const CHAIN_ID = 4663

type LaunchMeta = {
  readonly launchAt: number
  readonly tx: string
  readonly deployer: string
  recipient: string | null
  exemptions: string | null
}

type RawRow = {
  readonly token: string
  readonly book: string
  readonly at: number
  readonly launchAt: number
  readonly stakes: number
  readonly deployer: string
  readonly recipient: string | null
  readonly exemptions: string | null
}

type ScoreRow = {
  readonly at: number
  readonly value: number
  readonly positive: number
  readonly negative: number
  readonly n: number
  readonly tokens: readonly string[]
}

type Span = { readonly open: boolean; readonly from: number; readonly why: string }

type Variant = {
  readonly id: 'current' | 'cluster' | 'cluster_cap' | 'cluster_tanh' | 'recovery_cap' | 'recovery_tanh'
  readonly label: string
  readonly rows: readonly ScoreRow[]
}

type Metric = {
  readonly n: number
  readonly wins: number
  readonly losses: number
  readonly sum: number
  readonly mean: number | null
  readonly median: number | null
  readonly sd: number | null
  readonly maxDrawdown: number
}

const tapePath = process.argv[2] ?? 'data/tape.db'
const specPath = process.argv[3] ?? 'config/strategy.toml'
const loaded = loadConfig(specPath, Date.now(), null)
if (!loaded.ok) {
  console.error(`spec would not load: ${loaded.refusal.reason}`)
  process.exit(1)
}
const cfg = loaded.value.values

const metaByToken = new Map<string, LaunchMeta>()
const outcomes = new Map<string, Outcome[]>()
for (const b of cfg.books) outcomes.set(b.id, [])

let state: State = emptyState(cfg, { sizeWei: 5_000_000_000_000_000n, mode: 'live' } as unknown as Switches)
const tape = new Tape(tapePath)
let cursor = 1
let folded = 0
let firstAt = 0
let lastAt = 0
let lastTail: Outcome | undefined

for (;;) {
  const batch = tape.read(cursor, 5_000)
  if (batch.length === 0) break
  for (const event of batch) {
    if (firstAt === 0) firstAt = event.at
    lastAt = event.at
    const out = decide(state, event)
    if (out) state = out.state
    if (event.kind === 'config-applied') state = { ...state, config: cfg }
    folded++
    cursor = event.seq + 1

    if (event.kind === 'chain-read') rememberObservations(state.observations, metaByToken)

    const all = state.cohort.all()
    const tail = all[all.length - 1]
    if (tail === undefined || tail === lastTail) continue
    const fresh: Outcome[] = []
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i] === lastTail) break
      fresh.push(all[i]!)
    }
    lastTail = tail
    for (let i = fresh.length - 1; i >= 0; i--) {
      const row = fresh[i]!
      outcomes.get(row.book)?.push(row)
    }
  }
}
tape.close()

const acquisition = new HistoricalTransactionCache()
await enrichLaunches(metaByToken, acquisition)

const holdoutAt = lastAt - HOLDOUT_MS
const result: Record<string, unknown> = {
  methodology: {
    tape: tapePath,
    config: specPath,
    folded,
    from: iso(firstAt),
    to: iso(lastAt),
    hours: (lastAt - firstAt) / HOUR,
    holdoutFrom: iso(holdoutAt),
    holdoutHours: HOLDOUT_MS / HOUR,
    clusterMs: CLUSTER_MS,
    clusterRule: 'connected launches within 60s sharing creator fee recipient, deployer, or exact exemption set',
    clusterValue: 'median raw stakes',
    cap: 'clamp cluster median to [-1,+1]',
    tanh: 'tanh(cluster median)',
    caveat: 'guard-only opportunity replay; scaled ETH is not receipt-backed wallet P&L',
    acquisition: acquisition.summary(),
  },
  books: {},
}

for (const book of cfg.books) {
  const raw = rawRows(outcomes.get(book.id) ?? [], metaByToken, book.guard.settleMs)
  const clusters = clusterRows(raw)
  const currentRows = raw.map((r) => ({
    at: r.at, value: r.stakes,
    positive: Math.max(0, r.stakes), negative: Math.min(0, r.stakes),
    n: 1, tokens: [r.token],
  }))
  const variants: Variant[] = [
    { id: 'current', label: 'current 15/8 raw', rows: currentRows },
    { id: 'cluster', label: 'cluster median', rows: clusters },
    { id: 'cluster_cap', label: 'cluster median, clamp ±1', rows: clusters.map((r) => ({ ...r, value: clamp(r.value, -1, 1) })) },
    { id: 'cluster_tanh', label: 'cluster median, tanh', rows: clusters.map((r) => ({ ...r, value: Math.tanh(r.value) })) },
    { id: 'recovery_cap', label: 'raw pause; 8 distinct clusters; positive cluster sum capped +1', rows: clusters },
    { id: 'recovery_tanh', label: 'raw pause; 8 distinct clusters; positive cluster sum tanh', rows: clusters },
  ]

  const variantResults = new Map<string, {
    spans: readonly Span[]
    full: Metric
    train: Metric
    holdout: Metric
    day: Metric
    bins24h: readonly number[]
    binStats: ReturnType<typeof stats>
    shutHours: number
    holdoutShutHours: number
    reopens: number
    holdoutReopens: number
    incomplete: number
  }>()

  for (const variant of variants) {
    const replay = variant.id === 'recovery_cap'
      ? recoveryGuardSpans(currentRows, clusters.map((r) => ({ ...r, value: r.negative + Math.min(1, r.positive) })), book.guard, firstAt)
      : variant.id === 'recovery_tanh'
        ? recoveryGuardSpans(currentRows, clusters.map((r) => ({ ...r, value: r.negative + Math.tanh(r.positive) })), book.guard, firstAt)
        : guardSpans(variant.rows, book.guard, firstAt)
    const spans = replay.spans
    const bins24h = binSums(raw, spans, lastAt - 24 * HOUR, lastAt, 8)
    variantResults.set(variant.id, {
      spans,
      full: metrics(raw, spans, firstAt, lastAt),
      train: metrics(raw, spans, firstAt, holdoutAt),
      holdout: metrics(raw, spans, holdoutAt, lastAt),
      day: metrics(raw, spans, lastAt - 24 * HOUR, lastAt),
      bins24h,
      binStats: stats(bins24h),
      shutHours: shutMs(spans, firstAt, lastAt) / HOUR,
      holdoutShutHours: shutMs(spans, holdoutAt, lastAt) / HOUR,
      reopens: transitions(spans, firstAt, lastAt, true),
      holdoutReopens: transitions(spans, holdoutAt, lastAt, true),
      incomplete: replay.incomplete,
    })
  }

  const baseline = variantResults.get('current')!
  const sizeEth = Number(BigInt(book.sizeWei)) / 1e18
  const comparisons: Record<string, unknown> = {}
  for (const variant of variants.slice(1)) {
    const candidate = variantResults.get(variant.id)!
    comparisons[variant.id] = {
      full: compare(raw, baseline.spans, candidate.spans, firstAt, lastAt),
      holdout: compare(raw, baseline.spans, candidate.spans, holdoutAt, lastAt),
    }
  }

  const largestClusters = clusters
    .filter((c) => c.n > 1)
    .slice()
    .sort((a, b) => b.n - a.n || Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 10)
    .map((c) => ({ at: iso(c.at), n: c.n, medianStakes: c.value, tokens: c.tokens }))

  const shown: Record<string, unknown> = {}
  for (const variant of variants) {
    const x = variantResults.get(variant.id)!
    shown[variant.id] = {
      label: variant.label,
      scoreRows: variant.rows.length,
      clustersCollapsed: raw.length - variant.rows.length,
      shutHours: x.shutHours,
      reopens: x.reopens,
      incompleteChecks: x.incomplete,
      full: withEth(x.full, sizeEth),
      training: withEth(x.train, sizeEth),
      holdout: withEth(x.holdout, sizeEth),
      last24h: withEth(x.day, sizeEth),
      last24hBinsStakes: x.bins24h,
      last24hBinStats: x.binStats,
      holdoutShutHours: x.holdoutShutHours,
      holdoutReopens: x.holdoutReopens,
    }
  }

  ;(result.books as Record<string, unknown>)[book.id] = {
    sizeEth,
    outcomes: raw.length,
    metadataCoverage: {
      recipient: raw.filter((r) => r.recipient !== null).length,
      exemptions: raw.filter((r) => r.exemptions !== null).length,
      deployer: raw.filter((r) => !r.deployer.startsWith('unknown:')).length,
    },
    clusters: clusters.length,
    multiLaunchClusters: clusters.filter((c) => c.n > 1).length,
    largestClusters,
    variants: shown,
    comparisonsToCurrent: comparisons,
  }
}

console.log(JSON.stringify(result, null, 2))
acquisition.close()

function rememberObservations(observations: ReadonlyMap<string, Observation>, into: Map<string, LaunchMeta>): void {
  for (const o of observations.values()) {
    if (into.has(o.token)) continue
    into.set(o.token, {
      launchAt: o.startedAt,
      tx: o.launchTx.toLowerCase(),
      deployer: o.deployer.toLowerCase(),
      recipient: null,
      exemptions: null,
    })
  }
}

async function enrichLaunches(meta: Map<string, LaunchMeta>, cache: HistoricalTransactionCache): Promise<void> {
  const byTx = new Map<string, LaunchMeta[]>()
  for (const row of meta.values()) {
    let found = byTx.get(row.tx)
    if (!found) { found = []; byTx.set(row.tx, found) }
    found.push(row)
  }
  const txs = [...byTx.keys()]
  for (let i = 0; i < txs.length; i += RPC_BATCH) {
    const chunk = txs.slice(i, i + RPC_BATCH)
    const replies = await cache.transactions(CHAIN_ID, chunk)
    for (const tx of chunk) {
      const result = replies.get(tx) ?? null
      if (result === null) continue
      const input = result.input
      if (typeof input !== 'string' || !input.startsWith('0x')) continue
      try {
        const decoded = decodeFunctionData({ abi: launcherAbi, data: input as Hex })
        const args = decoded.args as readonly unknown[]
        const params = args[0] as { readonly creatorFeeRecipient?: string } | undefined
        const recipient = params?.creatorFeeRecipient?.toLowerCase() ?? null
        const ex = Array.isArray(args[6])
          ? (args[6] as string[]).map((x) => x.toLowerCase()).sort().join(',')
          : null
        for (const row of byTx.get(tx) ?? []) {
          row.recipient = recipient
          row.exemptions = ex
        }
      } catch { /* a missing historical input stays unknown, never zero */ }
    }
    // The public endpoint meters batch members rather than HTTP requests. Pacing here keeps a
    // one-off historical analysis from becoming a burst of hundreds of reads.
    await new Promise<void>((resolve) => setTimeout(resolve, 400))
  }
}

function rawRows(rows: readonly Outcome[], meta: ReadonlyMap<string, LaunchMeta>, settleMs: number): RawRow[] {
  return rows
    .filter((o): o is Outcome & { stakes: number } => o.stakes !== null && Number.isFinite(o.stakes))
    .map((o) => {
      const m = meta.get(o.token)
      return {
        token: o.token, book: o.book, at: o.at,
        launchAt: m?.launchAt ?? o.at - settleMs,
        stakes: o.stakes,
        deployer: m?.deployer ?? `unknown:${o.token}`,
        recipient: m?.recipient ?? null,
        exemptions: m?.exemptions ?? null,
      }
    })
    .sort((a, b) => a.launchAt - b.launchAt || a.at - b.at || a.token.localeCompare(b.token))
}

function clusterRows(rows: readonly RawRow[]): ScoreRow[] {
  const parent = rows.map((_r, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]! }
    return x
  }
  const join = (a: number, b: number): void => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  for (let i = 0; i < rows.length; i++) {
    for (let j = i - 1; j >= 0; j--) {
      if (rows[i]!.launchAt - rows[j]!.launchAt > CLUSTER_MS) break
      if (related(rows[i]!, rows[j]!)) join(i, j)
    }
  }
  const groups = new Map<number, RawRow[]>()
  for (let i = 0; i < rows.length; i++) {
    const root = find(i)
    let found = groups.get(root)
    if (!found) { found = []; groups.set(root, found) }
    found.push(rows[i]!)
  }
  return [...groups.values()]
    .map((g) => ({
      at: Math.max(...g.map((x) => x.at)),
      value: median(g.map((x) => x.stakes)) ?? 0,
      positive: g.reduce((n, x) => n + Math.max(0, x.stakes), 0),
      negative: g.reduce((n, x) => n + Math.min(0, x.stakes), 0),
      n: g.length,
      tokens: g.map((x) => x.token).sort(),
    }))
    .sort((a, b) => a.at - b.at || a.tokens[0]!.localeCompare(b.tokens[0]!))
}

function related(a: RawRow, b: RawRow): boolean {
  if (a.recipient !== null && a.recipient === b.recipient) return true
  if (!a.deployer.startsWith('unknown:') && a.deployer === b.deployer) return true
  return a.exemptions !== null && a.exemptions !== '' && a.exemptions === b.exemptions
}

function guardSpans(rows: readonly ScoreRow[], spec: FrozenConfig['books'][number]['guard'], first: number): {
  readonly spans: readonly Span[]
  readonly incomplete: number
} {
  const recent: ScoreRow[] = []
  const spans: Span[] = []
  let open = true
  let incomplete = 0
  note(spans, false, first, 'no complete window yet')
  open = false
  for (let i = 0; i < rows.length;) {
    const at = rows[i]!.at
    while (i < rows.length && rows[i]!.at === at) {
      recent.push(rows[i]!)
      i++
    }
    while (recent.length > spec.window) recent.shift()
    const fresh = recent.slice(Math.max(0, recent.length - spec.recoveryWindow))
    const verdict = venueVerdict(spec, {
      mainSum: recent.reduce((n, x) => n + x.value, 0),
      mainN: recent.length,
      freshSum: fresh.reduce((n, x) => n + x.value, 0),
      freshN: fresh.length,
      reachMs: at - recent[0]!.at,
    }, open)
    if (!verdict.fresh) incomplete++
    open = verdict.open
    note(spans, open, at, verdict.why)
  }
  return { spans, incomplete }
}

/**
 * Preserve the current raw pause exactly. Only a shut book's recovery evidence is changed:
 * it needs eight independent clusters, and a correlated positive burst gets at most one vote.
 * Negative outcomes are summed inside the cluster rather than damped, so bad-market evidence
 * never becomes weaker merely because one actor launched several losing coins together.
 */
function recoveryGuardSpans(
  raw: readonly ScoreRow[], recovery: readonly ScoreRow[],
  spec: FrozenConfig['books'][number]['guard'], first: number,
): { readonly spans: readonly Span[]; readonly incomplete: number } {
  const main: ScoreRow[] = []
  const fresh: ScoreRow[] = []
  const spans: Span[] = []
  let open = false, incomplete = 0, r = 0
  note(spans, false, first, 'no complete raw window yet')
  for (let i = 0; i < raw.length;) {
    const at = raw[i]!.at
    while (i < raw.length && raw[i]!.at === at) { main.push(raw[i]!); i++ }
    while (r < recovery.length && recovery[r]!.at <= at) { fresh.push(recovery[r]!); r++ }
    while (main.length > spec.window) main.shift()
    while (fresh.length > spec.recoveryWindow) fresh.shift()

    const mainReady = main.length >= spec.window
    const recoveryReady = fresh.length >= spec.recoveryWindow
    const reach = mainReady ? at - main[0]!.at : Number.POSITIVE_INFINITY
    const recoveryReach = recoveryReady ? at - fresh[0]!.at : Number.POSITIVE_INFINITY
    const isFresh = reach <= spec.freshMs && recoveryReach <= spec.freshMs
    let why: string
    if (!mainReady || !isFresh || (!open && !recoveryReady)) {
      open = false
      incomplete++
      why = !mainReady
        ? `only ${main.length} of ${spec.window} raw launches; fail closed`
        : !recoveryReady
          ? `only ${fresh.length} of ${spec.recoveryWindow} independent recovery clusters; fail closed`
          : 'raw or independent-cluster window is stale; fail closed'
    } else if (open) {
      const sum = main.reduce((n, x) => n + x.value, 0)
      open = sum >= spec.shutAt
      why = `${sum.toFixed(2)} raw stakes over ${main.length}`
    } else {
      const sum = fresh.reduce((n, x) => n + x.value, 0)
      open = sum > spec.openAt
      why = `${sum.toFixed(2)} bounded stakes over ${fresh.length} independent clusters`
    }
    note(spans, open, at, why)
  }
  return { spans, incomplete }
}

function note(spans: Span[], open: boolean, at: number, why: string): void {
  const last = spans[spans.length - 1]
  if (last === undefined || last.open !== open) spans.push({ open, from: at, why })
}

function openAt(spans: readonly Span[], at: number): boolean {
  let open = false
  for (const span of spans) {
    if (span.from > at) break
    open = span.open
  }
  return open
}

function admitted(rows: readonly RawRow[], spans: readonly Span[], from: number, to: number): RawRow[] {
  return rows.filter((r) => r.launchAt >= from && r.launchAt < to && openAt(spans, r.launchAt))
}

function metrics(rows: readonly RawRow[], spans: readonly Span[], from: number, to: number): Metric {
  const taken = admitted(rows, spans, from, to).slice().sort((a, b) => a.at - b.at || a.token.localeCompare(b.token))
  const values = taken.map((x) => x.stakes)
  let equity = 0, high = 0, drawdown = 0
  for (const value of values) {
    equity += value
    if (equity > high) high = equity
    if (high - equity > drawdown) drawdown = high - equity
  }
  const s = stats(values)
  return {
    n: values.length,
    wins: values.filter((x) => x > 0).length,
    losses: values.filter((x) => x < 0).length,
    sum: values.reduce((a, b) => a + b, 0),
    mean: s.mean,
    median: s.median,
    sd: s.sd,
    maxDrawdown: drawdown,
  }
}

function compare(rows: readonly RawRow[], base: readonly Span[], candidate: readonly Span[], from: number, to: number): Record<string, number> {
  let avoidedLosses = 0, avoidedLossStakes = 0, missedWinners = 0, missedWinnerStakes = 0
  let addedWinners = 0, addedWinnerStakes = 0, addedLosses = 0, addedLossStakes = 0
  for (const row of rows) {
    if (row.launchAt < from || row.launchAt >= to) continue
    const b = openAt(base, row.launchAt), c = openAt(candidate, row.launchAt)
    if (b && !c && row.stakes < 0) { avoidedLosses++; avoidedLossStakes += row.stakes }
    if (b && !c && row.stakes > 0) { missedWinners++; missedWinnerStakes += row.stakes }
    if (!b && c && row.stakes > 0) { addedWinners++; addedWinnerStakes += row.stakes }
    if (!b && c && row.stakes < 0) { addedLosses++; addedLossStakes += row.stakes }
  }
  return { avoidedLosses, avoidedLossStakes, missedWinners, missedWinnerStakes, addedWinners, addedWinnerStakes, addedLosses, addedLossStakes }
}

function binSums(rows: readonly RawRow[], spans: readonly Span[], from: number, to: number, bins: number): number[] {
  const out = new Array<number>(bins).fill(0)
  const width = (to - from) / bins
  for (const row of admitted(rows, spans, from, to)) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor((row.launchAt - from) / width)))
    out[i] = out[i]! + row.stakes
  }
  return out
}

function shutMs(spans: readonly Span[], from: number, to: number): number {
  let total = 0
  for (let i = 0; i < spans.length; i++) {
    const start = Math.max(from, spans[i]!.from)
    const end = Math.min(to, spans[i + 1]?.from ?? to)
    if (!spans[i]!.open && end > start) total += end - start
  }
  return total
}

function transitions(spans: readonly Span[], from: number, to: number, open: boolean): number {
  return spans.filter((s) => s.from >= from && s.from < to && s.open === open).length
}

function stats(values: readonly number[]): { mean: number | null; median: number | null; sd: number | null; n: number } {
  if (values.length === 0) return { mean: null, median: null, sd: null, n: 0 }
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const med = median(values)
  const sd = values.length < 2 ? 0 : Math.sqrt(values.reduce((n, x) => n + (x - mean) ** 2, 0) / (values.length - 1))
  return { mean, median: med, sd, n: values.length }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function withEth(metric: Metric, sizeEth: number): Metric & { readonly ethEquivalent: number; readonly maxDrawdownEthEquivalent: number } {
  return { ...metric, ethEquivalent: metric.sum * sizeEth, maxDrawdownEthEquivalent: metric.maxDrawdown * sizeEth }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

function iso(at: number): string {
  return new Date(at).toISOString()
}
