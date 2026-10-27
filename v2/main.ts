/**
 * The live process. Wires the transports to the driver to the tape to the page.
 *
 * THIS IS WHAT MAKES V2 ABLE TO TRADE. Until this file exists the core can fold a tape and
 * the monitor can draw it, but nothing ingests a live log and nothing can send. Mode is
 * enforced here the way the driver already enforces it: `shadow` signs and never sends,
 * `live` sends. Missing MODE, MODE=observe, or a missing switches file refuses to boot.
 *
 * IT DOES NOT TOUCH compute-1. This is a separate process, a separate port, a separate tape.
 * Cutover is a money decision and is not this file's job.
 */
// FIRST, AND FOR ITS SIDE EFFECT. It reads the env files, and modules below read the
// environment as they are evaluated. See the header of io/dotenv.ts for what that cost.
import { SWITCHES, envProvenance } from './io/dotenv.js'
import { readEnvFile, switchesFrom } from './io/env-file.js'
import { watch } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { decide } from './core/decide.js'
import { SELL_SETTLE_GIVEUP_MS } from './core/exit.js'
import { routes, ADDRESSES } from './core/chain.js'
import { bookLedger, emptyState, haltedFor, ledgerNetWei, stoppedKey, walletNetWei, type State } from './core/state.js'
import { holdPreviouslyOpenStaleVenue } from './core/observe.js'
import type { Event } from './core/events.js'
import type { Switches } from './core/config.js'
import { LiveDriver } from './drivers/live.js'
import { bootApply, loadConfig } from './io/config-load.js'
import { makeWorld } from './io/world.js'
import { Tape } from './io/tape.js'
import { LogsSubscriber } from './io/logs.js'
import { FeedClient } from './io/feed.js'
import { assertChain, chainId, ENDPOINTS, hasKey, PROVIDER, venueNotes } from './io/env.js'
import { ProviderMeter } from './io/cu.js'
import { RpcRouteLedger } from './io/routing.js'
import { LaunchTransactionCache } from './io/launch-cache.js'
import { ComparisonBudget } from './io/comparison-budget.js'
import { QuietEconomy, quietEconomyEligibility } from './io/quiet-economy.js'
import { quietWallet } from './io/economy.js'
import { ApiModeController, apiSwitchEligibility, recoveryOwner } from './io/api-mode.js'
import { EVENT_TOPICS as RPC_TOPICS } from './io/abi.js'
import { HaltedEconomyController, haltedEconomyEligibility, runPreparedResume, stoppedEconomyEligibility } from './io/economy.js'
import { PriceFeed } from './io/price.js'
import { bookSizeAction, controlAction, exitRetryAction, operatorHaltKind } from './io/control.js'
import { History } from './projections/history.js'
import { BoundedMap, BoundedSet, Ring } from './core/contracts.js'
import { dropSnapshot, readSnapshot, shapeOf, sweepSnapshots, writeSnapshot } from './io/snapshot.js'
import { snapshotPathFor } from './io/codeid.js'
import { serve } from './projections/server.js'
import type { ProjectOptions } from './projections/viewmodel.js'

/** How long a file has to stop changing before it is read. One save is several `fs.watch` events. */
const SETTLE_MS = 400
/** How often the wallet balance is re-read when nothing has traded. Hourly, like the ETH price. */
const BALANCE_EVERY_MS = 3_600_000
/**
 * How often the gas bid and the nonce ladder are checked against the chain. v1's housekeeping
 * period. Thirty seconds, not an hour: these two are about whether the NEXT transaction can be
 * sent at all, so a stale answer is a missed trade rather than a stale display number.
 */
const MAINTAIN_EVERY_MS = 30_000
/**
 * How often the fold is saved. Five minutes is the most tape a crash can cost us in replay,
 * and the write is a pause in the trading loop, so it is not shorter for the sake of it.
 */
const SNAPSHOT_EVERY_MS = 300_000
/**
 * How long another build's snapshot is left alone. Six hours, because the one written by
 * `tools/build-snapshot.ts` before a restart is the next build's and must survive until it boots.
 */
const SNAPSHOT_KEEP_OTHERS_MS = 6 * 3_600_000

/**
 * The classes a snapshot is allowed to carry.
 *
 * `io/snapshot.ts` refuses a prototype nobody named rather than guessing at one, and `io/` may
 * not reach into `projections/`, so the list is built here where both rings are in scope. A new
 * class inside `State` or `History` belongs here; forget it and the snapshot refuses to write,
 * loudly, instead of restoring an object with no methods.
 */
const SNAPSHOT_CLASSES = new Map<string, new (...args: never[]) => object>([
  ['Ring', Ring as never],
  ['BoundedMap', BoundedMap as never],
  ['BoundedSet', BoundedSet as never],
  ['History', History as never],
])

const specPath = process.argv[2] ?? process.env.SPEC_PATH ?? 'config/strategy.toml'
const tapePath = process.argv[3] ?? process.env.TAPE_PATH ?? 'data/tape.db'
const host = process.env.MONITOR_HOST ?? '127.0.0.1'

/**
 * The port, or a refusal. A `NaN` here binds a random port, and a bot on a port nobody can
 * find looks exactly like a bot that is not running: the report skill curls 8787 and reports
 * UNREACHABLE. Better to refuse to start than to run somewhere unreachable.
 */
function portFrom(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 8788
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    console.error(`PORT=${raw} is not a port. Fix it or unset it; refusing to bind somewhere unfindable.`)
    process.exit(1)
  }
  return n
}
const port = portFrom(process.env.PORT)

const loaded = loadConfig(specPath, Date.now(), null)
if (!loaded.ok) {
  console.error(`the spec would not load: ${loaded.refusal.reason}`)
  process.exit(1)
}

const maxSize = BigInt(loaded.value.values.risk.maxTradeSizeWei)
const loadedSwitches = switchesFrom(SWITCHES, maxSize, Date.now())
if (!loadedSwitches.ok) {
  console.error(loadedSwitches.reason)
  process.exit(1)
}
if (loadedSwitches.ignoredHalt) {
  console.warn(`v2: HALT in ${SWITCHES.path} is ignored. Use STOP ALL on the dashboard to stop new buys.`)
}
const switches: Switches = loadedSwitches.value
const mode = switches.mode
if (!hasKey()) {
  console.error(`v2: MODE=${mode} needs a key in the secrets file. There is no silent observe fallback.`)
  process.exit(1)
}

const tape = new Tape(tapePath)
const history = new History()

function foldInto(state: State, event: Event): State {
  const out = decide(state, event)
  if (!out) return state
  history.observe(event, out.state, out.intents, out.refusals)
  return out.state
}

let state = emptyState(loaded.value.values, switches)
let cursor = 1

/**
 * Start from the saved fold when there is one that provably belongs to this tape.
 *
 * THE TEST IS THE EVENT, NOT THE FILE. A snapshot claims to be the fold through seq N; the
 * tape is asked for event N and must answer with the same `at`. That is what stops a snapshot
 * from another tape, a restored backup or a pruned tape from being believed. Everything else
 * that could be wrong — a changed format, a field somebody added, an unreadable byte — comes
 * back as null from `readSnapshot`, and null means the loop below does what it has always
 * done. A slow boot is a cost; a wrong book is a loss.
 */
const snapshotPath = snapshotPathFor(tapePath)
const freshShape = shapeOf({ state, history })
let saved = readSnapshot(snapshotPath, SNAPSHOT_CLASSES, freshShape)
if (saved === null && mode === 'live' && tape.nextSeq() > 1) {
  // This release changes past guard decisions. Replaying the old tape under the new rule
  // would invent buys that were never sent, so resume the actual old fold instead.
  const previousCodeId = 'e28a8b7dadceb97c'
  const previous = readSnapshot(`${tapePath}.snapshot-${previousCodeId}`, SNAPSHOT_CLASSES, freshShape, previousCodeId)
  if (previous === null) {
    console.error('v2: no compatible snapshot for the freshness-rule migration; refusing to invent historical trades.')
    process.exit(1)
  }
  const [anchor] = tape.read(previous.seq, 1)
  if (anchor?.seq !== previous.seq || anchor.at !== previous.at || tape.nextSeq() !== previous.seq + 1) {
    console.error('v2: the previous snapshot does not end at this tape tip; refusing the freshness-rule migration.')
    process.exit(1)
  }
  const prior = previous.payload.state as State
  if (!quiet(prior)) {
    console.error('v2: the previous fold is not flat; refusing the freshness-rule migration.')
    process.exit(1)
  }
  const migrated = holdPreviouslyOpenStaleVenue(prior, 'untaxed')
  if (migrated === null || haltedFor(migrated.risk, 'untaxed') !== null) {
    console.error('v2: the old untaxed halt is not a stale open verdict; refusing the freshness-rule migration.')
    process.exit(1)
  }
  saved = { ...previous, payload: { ...previous.payload, state: migrated } }
  console.log(`v2: held the prior open untaxed verdict at seq ${previous.seq}; keeping the actual wallet fold.`)
}
if (saved !== null) {
  const [anchor] = tape.read(saved.seq, 1)
  if (anchor === undefined || anchor.seq !== saved.seq || anchor.at !== saved.at) {
    if (mode === 'live') {
      console.error(`v2: the snapshot says seq ${saved.seq}, and this tape does not; refusing to invent historical trades.`)
      process.exit(1)
    }
    console.warn(`v2: the snapshot says seq ${saved.seq}, and this tape does not; replaying from the start.`)
    dropSnapshot(snapshotPath)
  } else {
    state = saved.payload.state as State
    Object.assign(history, saved.payload.history)
    cursor = saved.seq + 1
    console.log(`v2: resumed the fold from seq ${saved.seq}; replaying ${tape.nextSeq() - cursor} events, not ${saved.seq}`)
  }
}

for (;;) {
  const rows = tape.read(cursor, 5_000)
  if (!rows.length) break
  for (const e of rows) {
    try {
      state = foldInto(state, e)
    } catch (err) {
      // Skipping a thrown event was how a bag got forgotten: the book silently missing a
      // fill, then trading as if it were flat. A fold throw is a refuse-to-boot, not a gap.
      console.error(`v2: fold threw at seq ${e.seq} kind=${e.kind}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      console.error('v2: refusing to boot. Skipping this event would trade on a book that never saw it.')
      process.exit(1)
    }
    cursor = e.seq + 1
  }
}
// Closed rows the event scan missed (a receipt at the end of the tape) still fill the table.
history.catchUp(state)

/**
 * What the paid endpoint is costing this run. A METER AND NEVER A GATE: see `io/cu.ts`.
 *
 * Built before the world and the subscriber because both of them report into it. It is read only
 * by `/api/state`, so no decision can ever see it and the kernel id cannot move because of it.
 */
const meter = new ProviderMeter(() => Date.now(), PROVIDER.cuCapPerMonth, PROVIDER.usdPerMillionCu)
const apiMode = new ApiModeController(SWITCHES.path, SWITCHES.vars)
const routeLedger = new RpcRouteLedger(`${tapePath}.rpc-routes.json`, () => Date.now())
const launchCache = new LaunchTransactionCache(chainId())
const comparisonBudget = PROVIDER.filterMode === 'compare' ? new ComparisonBudget(`${tapePath}.rpc-comparison.sqlite`) : undefined

const made = makeWorld({
  apiMode,
  recoveryOwner: (what, args) => recoveryOwner(driver.current(), what, args),
  ...(PROVIDER.txCache ? { launchCache } : {}),
  backgroundEligible: () => haltedReadsEligible(),
  launchBlock: curve => apiMode.mode() === 'economy' || PROVIDER.haltedReadEconomy ? driver.current().pendingLaunches.get(curve)?.block : undefined,
  mode,
  record: (event) => {
    try { tape.append([event]) } catch (e) { console.error(`tape write failed: ${String(e)}`) }
  },
  log: (line) => console.log(line),
  onKeyedRequest: () => meter.request('chain read'),
  onRpc: (route, method, purpose, event, owner) => {
    const phase = usagePhase()
    routeLedger[event](route, method, purpose, phase, owner)
    if (route === 'paid' && event === 'request') meter.method(method)
  },
})

const driver = new LiveDriver({
  world: made.world, initial: state, mode, startSeq: tape.nextSeq(),
  onDecision: (event, s, intents, refusals) => {
    history.observe(event, s, intents, refusals)
    if (!PROVIDER.txCache && event.kind === 'chain-read' && event.request.kind === 'meta') {
      const result = event.result as { exemptions?: number | null } | null
      launchCache.compare(event.request.args[2] ?? '', result?.exemptions ?? null)
    }
    if (!haltedReadsEligible()) made.preemptBackground()
    if (intents.some(i => ['buy', 'sell', 'approve', 'grad', 'broadcast'].includes(i.kind))) quietEconomy?.interrupt('transaction work')
    if (refusals.some(r => r.reason === 'quiet preparation missed the entry deadline'
      || (s.sensors.quietEntryHold && r.bucket === 'risk-logs-unhealthy'))) {
      quietEconomy?.disable('preparation missed an entry deadline')
    }
    // The send is not the mine. Reading here used to show 0.256 while 0.02 was already
    // spent, because the balance beat the block. Read now, and again in 2s when the
    // receipt should exist. `receipt` is the same fact when the fold asked for one.
    if (event.kind === 'tx-send-result' || event.kind === 'receipt') {
      void readWalletTruth()
      made.world.later(2_000, () => { void readWalletTruth() })
    }
  },
})

/**
 * Ask the chain what the wallet holds, and fold the answer.
 *
 * WHY MAIN AND NOT THE FOLD. Every other chain read is raised as an intent by a decision that
 * needs it. This one is needed by nobody: no rule reads the balance, and adding an intent for
 * it would put a new decision in the stream and change the kernel id for a number that is only
 * ever displayed. So it is scheduled here, out of band, and the fold only stores what comes
 * back.
 *
 * THREE TIMES plus a delayed follow-up: at boot; hourly; after a send or a receipt; and
 * again 2 seconds later, because the send is not the mine. A failure is swallowed and the
 * previous reading keeps ageing on the card, which is more honest than blinking to
 * unavailable on one bad RPC answer.
 */
let balanceInFlight = false
async function readBalance(): Promise<void> {
  const addr = made.address
  if (addr === null || balanceInFlight) return
  balanceInFlight = true
  try {
    /**
     * `world.read` returns a ReadOutcome, not the wei. The driver already unwraps `.result`
     * before ingest. This path used to ingest the whole outcome object as `result`, and the
     * fold only stores a decimal string, so every successful boot/hourly read was dropped.
     * Found live 2026-09-17: the card showed a 07:58 UTC reading while the process had
     * restarted 75 times and "read" the balance each boot.
     */
    const r = await made.world.read('balance', [addr])
    if (r.error !== null || r.result == null) {
      console.error(`balance read failed after ${r.tries} tr${r.tries === 1 ? 'y' : 'ies'} in ${r.latencyMs}ms${r.error ? `: ${r.error}` : ''}`)
      return
    }
    driver.ingest('chain-read', {
      request: { kind: 'balance', args: [addr] },
      result: r.result, viaKey: r.viaKey, tries: r.tries, latencyMs: r.latencyMs,
    })
  } catch (e) {
    console.error(`balance read failed: ${String(e)}`)
  } finally {
    balanceInFlight = false
  }
}

/**
 * Ask the wallet whether each open filled bag still holds tokens.
 *
 * WHY HERE. Recovery already does this at boot. Leaving it until the next restart is how
 * Total sat at chain + dead spend for thirteen hours. The fold already knows what a zero
 * means: an inflight sell pulls the receipt; otherwise the bag is abandoned. A brand-new
 * buy is skipped so a read a block behind the sequencer cannot invent an abandonment.
 */
async function readOpenBags(): Promise<void> {
  if (made.address === null) return
  const s = driver.current()
  const now = s.at
  for (const p of s.positions.values()) {
    if (p.closed || p.filled === false) continue
    if (p.inflightIntentId === null && now - p.openedAt < SELL_SETTLE_GIVEUP_MS) continue
    try {
      const r = await made.world.read('position-wallet', [p.token, p.id])
      if (r.error !== null || r.result == null) {
        console.error(`position-wallet ${p.id} failed after ${r.tries} tr${r.tries === 1 ? 'y' : 'ies'} in ${r.latencyMs}ms${r.error ? `: ${r.error}` : ''}`)
        continue
      }
      driver.ingest('chain-read', {
        request: { kind: 'position-wallet', args: [p.token, p.id] },
        result: r.result, viaKey: r.viaKey, tries: r.tries, latencyMs: r.latencyMs,
      })
    } catch (e) {
      console.error(`position-wallet ${p.id} failed: ${String(e)}`)
    }
  }
}

/** Chain ETH, then leftover bags. Same ticks as the old balance-only read. */
async function readWalletTruth(): Promise<void> {
  await readBalance()
  await readOpenBags()
}

/**
 * THE FILE IS AUTHORITATIVE AT BOOT, and until 2026-09-17 it was not.
 *
 * The tape is folded first, and every `config-applied` row on it replaces `state.config` with
 * the spec that was in force at the time — which is exactly right for a replay and exactly wrong
 * for a boot. This block only ran on an EMPTY tape, so on any real tape the process finished boot
 * holding the LAST RECORDED spec and the file was never read into a decision again. The watcher
 * below fires only on a subsequent edit, so `WITH_CONFIG=1 ./deploy.sh` followed by a restart
 * shipped a file that changed nothing and reported success. Found by deploying the 15/8 guard and
 * then reading `/api/state`, which still said `window 20`: the same class of defect as the pm2
 * environment replaying a stale `.env` over the file in v1, one layer up.
 *
 * IT IS AN EVENT, NOT AN ASSIGNMENT. The transition goes onto the tape like any other, so a
 * replay of this tape reaches the same config at the same point and the fold stays the only path
 * by which a value reaches a decision.
 *
 * `changed` is measured against the FOLDED config rather than against nothing, so the line the
 * operator reads names the keys that actually moved at this boot.
 */
const boot = bootApply(tape.stats().rows, driver.current().config, loaded.value.values)
if (boot.apply) {
  if (boot.changed.length > 0) {
    console.log(`v2: the spec on disk differs from the tape's last applied spec; applying the file: ${boot.changed.join(', ')}`)
  }
  driver.ingest('config-applied', {
    specVersion: loaded.value.values.specVersion,
    digest: loaded.value.digest,
    values: loaded.value.values,
    changed: boot.changed,
    source: 'boot',
  })
}

/**
 * Call back once, after `path` has stopped changing.
 *
 * TWO DEFECTS, ONE HELPER. `fs.watch` fires several times for one save, and a writer that
 * truncates and then fills (tar, scp, an editor) is briefly a file with no `[risk]` table in
 * it: reading on the first event is how the box logged `spec reload refused: missing the
 * [risk] table` and then `ENOENT` during the 2026-09-16 deploy. And watching the FILE follows
 * the inode, so an editor that writes a new file and renames it over the old one leaves the
 * watch pointing at something nobody will ever write to again, which is a hot-reload that
 * silently stops working after the first edit. Watching the directory and filtering by name
 * survives both.
 */
function watchSettled(path: string, then: () => void): void {
  const full = resolve(path)
  const dir = dirname(full)
  const name = basename(full)
  let timer: NodeJS.Timeout | null = null
  watch(dir, (_kind, changed) => {
    if (changed !== null && changed !== name) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; then() }, SETTLE_MS)
    timer.unref?.()
  })
}

watchSettled(specPath, () => {
  const next = loadConfig(specPath, Date.now(), driver.current().config)
  if (!next.ok) {
    // A refusal that survives the settle is real, and the previous spec stays in force. That is
    // the live bot's rule and the opposite of the monitor's, which has nothing to fall back to.
    console.error(`spec reload refused: ${next.refusal.reason}`)
    return
  }
  if (next.value.changed.length === 0) return
  driver.ingest('config-applied', {
    specVersion: next.value.values.specVersion,
    digest: next.value.digest,
    values: next.value.values,
    changed: next.value.changed,
    source: 'file',
  })
})

/**
 * The hot switches: edit the file, and the bot is holding the new value a second later.
 *
 * WHY THIS HAD TO COME BACK. `bot/` applied `TRADE_SIZE_ETH` the moment `.env` was saved.
 * v2 used to read the environment once at boot, so a size change needed a restart, and a
 * restart with open positions is the one thing the runbook forbids. New buys stop from the
 * dashboard (STOP ALL), not from a file line.
 *
 * IT GOES THROUGH THE FOLD, not through a mutable global. `switch-set` is an event: it lands on
 * the tape, a replay reaches the same state, and the page reads the change from the same place
 * it reads everything else. The clamp against `risk.maxTradeSizeWei` lives in the fold, so a
 * typo in the file cannot stake more than the spec agreed to.
 *
 * MODE IS NOT HOT AND IS NOT SILENTLY IGNORED. Switching to `shadow` with positions open
 * strands them: shadow signs and never sends. It is logged as needing a restart, and the
 * running value stays in force.
 */
const describe = (s: Switches): string => `size=${s.sizeWei} mode=${s.mode}`

if (SWITCHES.found) {
  watchSettled(SWITCHES.path, () => {
    const file = readEnvFile(SWITCHES.path)
    if (!file.found) {
      console.error(`the switches file vanished (${SWITCHES.path}); ${describe(driver.current().switches)} stays in force`)
      return
    }
    const now = driver.current()
    const wanted = switchesFrom(file, BigInt(now.config.risk.maxTradeSizeWei), Date.now())
    if (!wanted.ok) {
      console.error(`the switches file would not load (${wanted.reason}); ${describe(now.switches)} stays in force`)
      return
    }
    if (wanted.ignoredHalt) {
      console.warn(`v2: HALT in ${SWITCHES.path} is ignored. Use STOP ALL on the dashboard to stop new buys.`)
    }

    if (wanted.value.sizeWei !== now.switches.sizeWei) {
      console.log(`switch: size ${now.switches.sizeWei} -> ${wanted.value.sizeWei} wei, from ${SWITCHES.path}`)
      driver.ingest('switch-set', { name: 'size', value: { kind: 'size', wei: String(wanted.value.sizeWei) }, by: 'file' })
    }
    if (wanted.value.mode !== now.switches.mode) {
      console.error(`switch: MODE ${now.switches.mode} -> ${wanted.value.mode} needs a restart and is NOT in force. Restart only when flat: shadow signs and never sends, so a mode change with positions open strands them.`)
    }
  })
}

/**
 * Is anything at risk right now? The poller reads this to decide whether to pay full speed.
 *
 * WHY THE POLLER ASKS AT ALL: see `POLL_FLAT_MS` in `io/logs.ts`. Short version, measured
 * 2026-09-18: 70 CU every ~225ms around the clock was ~97% of the provider bill, and a position
 * was open 1.17h of that day. The cap it was heading for 429s the launch socket and the entry
 * reads together, so the credits spent on an idle book were buying a future outage.
 *
 * WIDER THAN `needsTick` BELOW, on purpose. That one gates a clock event, so it waits for a sent
 * buy to have a hash. This one wants the fast stream BEFORE the money moves: a buy still being
 * signed counts, and so does a launch merely armed, because an armed launch is about to be priced
 * against confirmed logs plus the overlay and that is the worst moment to hold a one-second-old
 * book.
 *
 * EITHER STREAM NOT CONFIRMED HEALTHY ALSO COUNTS. The socket is what makes a launch arrive in
 * time; without it the poller is the only detection path there is. The test is `!== true` rather
 * than `=== false` so an unknown reading takes the fast, expensive, safe side.
 *
 * A closure over `logs`, which is constructed with it on the next line. Safe because nothing
 * calls it until `logs.start()` runs, far below.
 */
function atRisk(): boolean {
  const s = driver.current()
  for (const p of s.positions.values()) if (!p.closed) return true
  for (const f of s.inflight.values()) if (f.kind === 'buy') return true
  if (s.armed.size > 0) return true
  if (apiMode.mode() === 'paid' && !logs.wsUp) return true
  return s.sensors.feedConnected?.value !== true
}

let startupReconciled = false
function haltedReadsEligible(): boolean {
  return apiMode.mode() === 'paid' && !apiMode.ownsReadiness() && PROVIDER.haltedReadEconomy && startupReconciled && driver.current().sensors.entryReady === false
    && !economy.preparing && !quietEconomy?.preparing() && !preparingStart && haltedEconomyEligibility(driver.current(), true).eligible
}
function usagePhase(): 'halted' | 'quiet' | 'critical' {
  const state = driver.current()
  if (haltedEconomyEligibility(state, startupReconciled).eligible) return 'halted'
  return quietEconomyEligibility(state, startupReconciled, driver.idle(), logs.wsUp).eligible ? 'quiet' : 'critical'
}
let quietEconomy: QuietEconomy | undefined
const logs = new LogsSubscriber(undefined, () => apiMode.mode() === 'paid', () => made.world.now(), {
  apiMode: () => apiMode.mode(),
  providerUrl: ENDPOINTS.rpcKey,
  onProviderRequest: (method) => meter.method(method),
  onProviderBytes: (bytes) => { meter.bytes(bytes, 'launch subscription'); routeLedger.subscription(bytes, usagePhase()) },
  routeLedger,
  filterMode: () => PROVIDER.filterMode,
  phase: usagePhase,
  filterEligible: () => quietWallet(driver.current(), startupReconciled, driver.idle()).eligible
    && !atRisk() && driver.current().pendingLaunches.size === 0,
  filterStatePath: `${tapePath}.rpc-filter.json`,
  ...(comparisonBudget ? { comparisonBudget } : {}),
  economyEnabled: () => apiMode.mode() === 'paid' && !apiMode.ownsReadiness() && (PROVIDER.haltedEconomy || PROVIDER.quietEconomy),
  economyEligibility: () => {
    if (quietEconomy?.usePublic()) return { eligible: true, reason: 'quiet observation between opportunities' }
    if (!PROVIDER.haltedEconomy) return { eligible: false, reason: 'halted economy is disabled' }
    const eligibility = haltedEconomyEligibility(driver.current(), startupReconciled)
    return eligibility.eligible && !economy.usePublic()
      ? { eligible: false, reason: 'waiting for the entry hold to be processed' } : eligibility
  },
}, atRisk)
logs.on('batch', (b) => {
  if (b.logs.some(l => l.topics[0] === RPC_TOPICS.TokenLaunched)) quietEconomy?.interrupt('launch arrived')
  driver.ingest('logs', { logs: b.logs, source: b.source, lo: b.lo, hi: b.hi })
})
logs.on('status', (s) => {
  if (!s.healthy) quietEconomy?.interrupt('log stream failed')
  driver.ingest('logs-status', { healthy: s.healthy, mode: s.mode === 'ws' ? 'ws' : 'poll', reason: s.reason ?? '' })
})
logs.on('ws', s => { if (!s.up) quietEconomy?.interrupt('launch socket failed') })

async function drainLaunches(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await driver.whenIdle()
    if (signal.aborted) return
    const current = driver.current()
    if (current.pendingLaunches.size === 0 && current.armed.size === 0) return
    driver.ingest('clock', {})
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}

const economy = new HaltedEconomyController({
  enabled: () => apiMode.mode() === 'paid' && !apiMode.ownsReadiness() && PROVIDER.haltedEconomy,
  eligibility: (requireIdle) => haltedEconomyEligibility(driver.current(), startupReconciled, !requireIdle || driver.idle()),
  entryReady: () => driver.current().sensors.entryReady !== false,
  setReady: async (entryReady) => {
    driver.ingest('logs-status', {
      healthy: logs.healthy, mode: 'poll', entryReady,
      ...(driver.current().sensors.quietEntryHold !== undefined ? { quietEntryHold: false } : {}),
      reason: entryReady ? 'paid catch-up processed' : 'public observation while all books are halted',
    })
    await driver.whenIdle()
  },
  prepare: (stillCurrent) => {
    made.preemptBackground()
    return logs.preparePaidResume(async signal => {
      if (PROVIDER.haltedReadEconomy) await made.prepareExecution()
      await drainLaunches(signal)
    }, stillCurrent)
  },
})

quietEconomy = new QuietEconomy({
  enabled: () => apiMode.mode() === 'paid' && !apiMode.ownsReadiness() && PROVIDER.quietEconomy,
  eligible: () => quietEconomyEligibility(driver.current(), startupReconciled, driver.idle(), logs.wsUp),
  hold: held => driver.ingest('logs-status', { healthy: logs.healthy, mode: 'poll',
    entryReady: !held, quietEntryHold: held, reason: held ? 'quiet observation' : 'quiet paid preparation processed' }),
  prepare: current => {
    made.preemptBackground()
    return logs.preparePaidResume(async () => {
      if (PROVIDER.haltedReadEconomy) await made.prepareExecution()
      await driver.whenIdle()
    }, current)
  },
  path: `${tapePath}.rpc-quiet.json`,
})

// Beside the tape, because it is the same kind of thing: what this run must remember about
// the last one. A restart that forgets an upstream ban renews it.
const feed = new FeedClient(ENDPOINTS.feedWs, `${tapePath}.feed-cooldown.json`, () => made.world.now())
feed.on('block', (b) => {
  if (launchCache) for (const tx of b.txs) {
    if (tx.to?.toLowerCase() === ADDRESSES.launcher) launchCache.remember(tx.raw, tx.hash)
  }
  const tracked = driver.current().curves
  const txs = b.txs
    .filter((tx) => tx.to !== null && routes(tx.to, (a) => tracked.has(a), tx.data))
    .map((tx) => ({ hash: tx.hash, to: tx.to!.toLowerCase(), data: tx.data }))
  driver.ingest('feed-block', { block: b.block, timestamp: b.timestamp, txs })
})
feed.on('gap', (g) => { quietEconomy?.interrupt('feed gap'); driver.ingest('feed-gap', { expected: g.expected, got: g.got, reason: g.got < 0 ? 'disconnect' : 'sequence hole' }) })
feed.on('status', (s) => { if (!s.connected) quietEconomy?.interrupt('feed disconnected'); driver.ingest('feed-status', { connected: s.connected, reason: s.reason ?? '' }) })

const display: { ethUsd: ProjectOptions['ethUsd'] } = { ethUsd: null }
/** Seed is never shown. The page stays unavailable until Coinbase answers. */
const price = new PriceFeed(4000, () => made.world.now())

async function refreshPrice(): Promise<void> {
  const moved = await price.refresh()
  display.ethUsd = price.display()
  if (moved) console.log(`v2: eth usd ${moved.usd} from ${moved.source}`)
}

const OPTIONS: ProjectOptions = {
  unavailable: mode === 'shadow'
    ? { money: 'shadow mode signs and does not send, so this run has no fills of its own' }
    : {},
  get ethUsd() { return display.ethUsd },
  get providerCu() { return meter.reading() },
  get rpcRouting() {
    const economySelected = apiMode.mode() === 'economy'
    const age = logs.lastHealthyAt ? Math.max(0, made.world.now() - logs.lastHealthyAt) : null
    const reason = economySelected && !apiMode.preparing()
      ? !logs.healthy ? 'public log requests are failing'
        : age === null || age > driver.current().config.risk.maxLogsStalenessMs ? 'public log coverage is stale'
          : driver.current().sensors.feedConnected?.value !== true ? 'the sequencer feed is unavailable'
            : driver.current().sensors.entryReady === false ? 'API preparation has not completed' : null
      : null
    return { ...logs.routingStatus(), cache: launchCache?.stats ?? null,
    api: { ...apiMode.status(), publicCoverageAgeMs: economySelected ? age : null,
      failures1h: logs.failures1h(), recommendPaid: reason !== null, reason },
    paidUsage: routeLedger.paidUsage(PROVIDER.usdPerMillionCu), lastExitRescue: routeLedger.lastExitRescue,
    quiet: { disabledReason: quietEconomy?.disabledReason ?? null, preparing: quietEconomy?.preparing() ?? false },
    comparison: comparisonBudget?.status() ?? null,
    entryReady: driver.current().sensors.entryReady !== false,
    lastPreparation: quietEconomy?.lastPreparation && (!economy.lastPreparation || quietEconomy.lastPreparation.at > economy.lastPreparation.at)
      ? quietEconomy.lastPreparation : economy.lastPreparation } },
  canControl: true,
}

let controlGeneration = 0
let preparingStart = false

serve({
  port, host,
  current: () => driver.current(),
  history: () => history,
  options: OPTIONS,
  onControl: async (action, bookArg, sizeEthArg, positionId, apiModeArg) => {
    if (action === 'set-api-mode') {
      if (!startupReconciled) return { do: 'nothing', code: 409, why: 'startup reconciliation is incomplete' }
      if (bookArg != null || preparingStart) return { do: 'nothing', code: 409, why: 'API routing is wallet-wide; wait for START preparation' }
      economy.cancel(); quietEconomy?.cancel(); made.preemptBackground()
      return apiMode.change(apiModeArg, {
        eligibility: () => apiSwitchEligibility(driver.current(), startupReconciled, driver.idle()),
        hold: async held => {
          driver.ingest('logs-status', { healthy: logs.healthy, mode: 'poll', entryReady: !held,
            quietEntryHold: false, reason: held ? 'manual API change preparing' : 'manual API routing ready' })
          await driver.whenIdle()
        },
        routingChanged: () => logs.refreshRouting(),
        prepare: (target, current) => logs.prepareResume(target === 'paid' ? 'paid' : 'public', async signal => {
          await assertChain(made.readChainId)
          await made.prepareExecution(quietWallet(driver.current(), startupReconciled, true).eligible)
          await drainLaunches(signal)
        }, current),
      })
    }
    const s = driver.current()
    if (action === 'retry-exit') {
      const r = exitRetryAction(positionId, {
        stopped:s.risk.halts.has(stoppedKey(null)),broken:s.risk.halts.has('broken'),positions:s.positions,
      })
      if (r.do === 'retry-exit') driver.ingest('operator',{action:'retry-exit',positionId:r.positionId,why:r.why})
      return r
    }
    if (action === 'preview-size' || action === 'preview-default' || action === 'set-size' || action === 'clear-size') {
      const sized = bookSizeAction(action, bookArg, sizeEthArg, {
        at: s.at, config: s.config, switches: s.switches,
      })
      if (sized.do === 'set-size' || sized.do === 'clear-size') {
        driver.ingest('switch-set', {
          name: 'book-size',
          value: {
            kind: 'book-size',
            book: sized.book!,
            wei: sized.do === 'clear-size' ? null : sized.sizeWei!,
          },
          by: 'dashboard',
        })
      }
      return sized
    }
    const asked = typeof bookArg === 'string' && bookArg !== '' ? bookArg : null
    if (asked !== null && !s.config.books.some((b) => b.id === asked)) {
      return { do: 'nothing', code: 400, why: `no book named ${asked}` }
    }
    if (action === 'stop') { controlGeneration++; apiMode.cancel(); economy.cancel(); quietEconomy?.cancel() }
    if (action === 'start' && apiMode.preparing()) return { do: 'nothing', code: 409, why: 'API routing is still preparing' }
    if (action === 'start') { made.preemptBackground(); quietEconomy?.interrupt('operator START') }
    const haltKind = operatorHaltKind(s.risk.halts)
    const openOf = (book: string | null) => [...s.positions.values()]
      .filter((p) => !p.closed && (book === null || p.book === book)).length
    // NET, not booked P&L, because net is what the stop measures. Reading the gross figure here
    // meant "drawdown is already zero" could refuse a reset on a book whose gas had moved the
    // stop, which is the same drift the report and the alert had until 2026-09-17.
    const ledger = asked === null ? null : bookLedger(s.risk, asked)
    const dd = ledger === null
      ? s.risk.walletPeakWei - walletNetWei(s.risk)
      : ledger.peakWei - ledgerNetWei(ledger)
    const r = controlAction(action, {
      stopped: s.risk.halts.has(stoppedKey(null)),
      haltKind,
      open: openOf(asked),
      drawdownWei: dd < 0n ? 0n : dd,
      broken: s.risk.halts.has('broken'),
      book: asked,
      bookStopped: asked !== null && s.risk.halts.has(stoppedKey(asked)),
    })
    if (r.do === 'start' && asked === null) {
      if (preparingStart) return { do: 'nothing', code: 409, why: 'still stopped: START preparation is already running' }
      preparingStart = true
      const generation = controlGeneration
      try {
        const stillCurrent = () => controlGeneration === generation
        const outcome = await runPreparedResume({
          stillCurrent,
          prepare: () => logs.prepareResume(apiMode.mode() === 'paid' ? 'paid' : 'public', async signal => {
            if (PROVIDER.haltedReadEconomy || apiMode.mode() === 'economy') await made.prepareExecution()
            await drainLaunches(signal)
          }, stillCurrent),
          ready: () => {
            const current = driver.current()
            const eligible = stoppedEconomyEligibility(current, startupReconciled, driver.idle())
            if (!eligible.eligible) return eligible
            if (current.pendingLaunches.size > 0 || current.armed.size > 0) {
              return { eligible: false, reason: 'pre-resume launch work is unresolved' }
            }
            return eligible
          },
          lift: async () => {
            apiMode.ready()
            driver.ingest('logs-status', { healthy: logs.healthy, mode: 'poll', entryReady: true, reason: `START ${apiMode.mode()} catch-up processed` })
            driver.ingest('operator', { action: 'start', why: 'automatic operation requested after paid catch-up' })
            await driver.whenIdle()
          },
        })
        return outcome.resumed ? { ...r, why: outcome.why } : { do: 'nothing', code: 409, why: `still stopped: ${outcome.why}` }
      } finally { preparingStart = false }
    }
    if (r.do !== 'nothing') {
      driver.ingest('operator', asked === null
        ? { action: r.do, why: r.why }
        : { action: r.do, why: r.why, book: asked })
    }
    return r
  },
})

/** Tick while something is held, or a sent buy has not become a position yet. */
function needsTick(s: State): boolean {
  for (const p of s.positions.values()) if (!p.closed) return true
  for (const f of s.inflight.values()) if (f.kind === 'buy' && f.hash) return true
  return false
}

const balanceTimer = setInterval(() => { void readWalletTruth(); void refreshPrice() }, BALANCE_EVERY_MS)
balanceTimer.unref?.()

/**
 * The gas bid and the nonce ladder, kept true to the chain.
 *
 * OUT OF BAND, like the balance read and for the same reason: no rule reads either of these,
 * so raising them as intents would put new decisions in the stream and move the kernel id for
 * numbers no decision consumes. `flat` is read here because the book is here.
 *
 * Shadow and live both sign, so both keep the bid and the ladder true.
 */
let maintainInFlight = false
const maintainTimer = setInterval(() => {
  if (maintainInFlight) return
  maintainInFlight = true
  const open = [...driver.current().positions.values()].filter((p) => !p.closed).length
  void made.maintain(open === 0)
    .catch((e) => console.error(`maintain failed: ${String(e)}`))
    .finally(() => { maintainInFlight = false })
}, MAINTAIN_EVERY_MS)
maintainTimer.unref?.()

const period = loaded.value.values.clock.periodMs
let clock: ReturnType<typeof setInterval> | undefined

if (apiMode.mode() === 'economy') {
  apiMode.notReady('Economy startup preparation pending')
  driver.ingest('logs-status', { healthy: false, mode: 'poll', entryReady: false, quietEntryHold: false,
    reason: 'Economy startup coverage is preparing' })
  await driver.whenIdle()
}

/**
 * Who the chain says it is, before a single byte is signed for it.
 *
 * A wrong chain id used to look like a quiet market. Refuse to boot.
 */
try {
  await assertChain(made.readChainId)
} catch (e) {
  console.error(`v2: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}

/**
 * What is degraded about the venue, printed once at boot. v1's `checkVenueParams` notes.
 *
 * In every mode, because a stale read endpoint or a missing socket ruins a shadow run
 * exactly as it ruins a live one.
 *
 * Warnings, never a refusal: these are degradations rather than the process being unable to work,
 * and one that exits cannot tell anyone why.
 */
for (const note of venueNotes({
  headTimestampS: await made.readHeadTimestamp(),
  nowMs: Date.now(),
  logsWs: ENDPOINTS.logsWs,
})) console.warn(`v2: NOTE ${note}`)

await made.start()
await readWalletTruth()
driver.ingest('recovery-start', { reason: 'boot: check wallet tokens against inflight buys and open rows' })
await driver.whenIdle()
driver.ingest('recovery-complete', { authoritativeBlock: 0 })
await driver.whenIdle()
startupReconciled = true
clock = setInterval(() => {
  if (!needsTick(driver.current())) return
  driver.ingest('clock', {})
}, period)
clock.unref?.()
await logs.start()
if (apiMode.mode() === 'economy') {
  try {
    await logs.prepareResume('public', async () => {
      await made.prepareExecution(quietWallet(driver.current(), startupReconciled, true).eligible)
      await driver.whenIdle()
    }, () => true)
    apiMode.ready()
    driver.ingest('logs-status', { healthy: logs.healthy, mode: 'poll', entryReady: true, quietEntryHold: false, reason: 'Economy startup coverage processed' })
  } catch (error) {
    apiMode.notReady(String((error as Error).message ?? error))
    driver.ingest('logs-status', { healthy: logs.healthy, mode: 'poll', entryReady: false, reason: 'Economy startup preparation failed' })
  }
} else await economy.reconcile()
const economyTimer = setInterval(() => {
  if (apiMode.mode() === 'economy' || apiMode.ownsReadiness()) return
  if (!quietEconomy?.ownsReadiness()) void economy.reconcile().catch((e) => console.error(`RPC economy: ${String(e)}`))
  if (driver.current().sensors.entryReady !== false || quietEconomy?.ownsReadiness()) quietEconomy?.reconcile()
}, 100)
economyTimer.unref?.()
feed.start()

/**
 * The ETH price, LAST AND NOT AWAITED. A display number may not delay trading.
 *
 * `PriceFeed` allows an 8 second timeout, and awaiting it before `logs.start()` put a
 * Coinbase round trip in front of the log subscription on a bot whose entry window is about
 * three seconds. The page shows dollars as unavailable until this lands, which is the honest
 * reading of "we do not know the price yet".
 */
void refreshPrice()

/**
 * What is actually in force, printed once, so the log can be diffed against the file.
 *
 * The rule this serves is that what is live is read and never remembered. The banner names the
 * files it read and the switches it resolved from them; nothing here is a value from a
 * doc or a memory, and no secret is printed.
 */
console.log(`v2: env ${envProvenance()}`)
console.log(`v2: switches size=${switches.sizeWei} wei mode=${switches.mode} (by ${switches.by})`)
console.log(`v2: mode=${mode} chain=${chainId()} spec=${specPath} tape=${tapePath}`)
console.log(`v2: folded through seq ${cursor - 1}, next ${tape.nextSeq()}`)
console.log(`v2: serving http://${host}:${port}`)
if (mode !== 'live') console.log(`v2: not sending. MODE=live is required to broadcast.`)

/**
 * Save the fold, so the next restart replays minutes instead of days.
 *
 * A FAILURE HERE IS NOT A TRADING FAILURE and is not allowed to become one: the snapshot is a
 * cache of the tape, so a throw is logged and the run carries on, and the only thing lost is
 * the next boot's head start.
 */
function saveSnapshot(why: string): void {
  const s = driver.current()
  try {
    const { bytes, ms } = writeSnapshot(
      snapshotPath,
      { seq: s.seq, at: s.at, shape: shapeOf({ state: s, history }), payload: { state: s, history } },
      SNAPSHOT_CLASSES,
    )
    const swept = sweepSnapshots(snapshotPath, SNAPSHOT_KEEP_OTHERS_MS)
    console.log(`v2: saved the fold through seq ${s.seq} (${why}), ${(bytes / 1_000_000).toFixed(1)} MB in ${ms}ms${swept > 0 ? `, dropped ${swept} from older builds` : ''}`)
  } catch (e) {
    console.error(`v2: could not save the fold (${why}); the next boot replays the tape: ${String(e)}`)
  }
}
/**
 * Only while there is nothing in the air.
 *
 * Saving costs a few hundred milliseconds of the one thread that also decides, and the entry
 * window here is about three seconds, so a save landing on a launch is a missed trade. Holding
 * off is free: an older snapshot means a longer boot, never a wrong one, and this bot is flat
 * most of the time. Boot and shutdown do not ask, because at boot nothing has started and at
 * shutdown nothing is going to.
 */
function quiet(s: State): boolean {
  // A buy or a sell in the air, not `inflight.size`: settled `approve` records are never
  // removed, so thousands of them accumulate and a size test would hold the save off forever.
  for (const f of s.inflight.values()) if (f.kind === 'buy' || f.kind === 'sell') return false
  for (const p of s.positions.values()) if (!p.closed) return false
  return true
}

saveSnapshot('boot')
const snapshotTimer = setInterval(() => {
  if (!quiet(driver.current())) return
  saveSnapshot('periodic')
}, SNAPSHOT_EVERY_MS)
snapshotTimer.unref?.()

const stop = (): void => {
  economy.stop()
  clearInterval(economyTimer)
  logs.stop()
  routeLedger.flush()
  feed.stop()
  clearInterval(maintainTimer)
  clearInterval(snapshotTimer)
  if (clock) clearInterval(clock)
  // A planned restart is the case this exists for: saving on the way out is what makes
  // `pm2 restart` cost seconds instead of the whole tape.
  saveSnapshot('shutdown')
  tape.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
