/**
 * Fold a tape through the v2 core and compare the fold's intents to what actually traded.
 *
 * Two comparisons, both offline, neither of them a send:
 *
 *   1. Against the tape's own `tx-signed` events, when this tape is a v2 run. Token is
 *      recovered from the signed bytes' `to` against the fold's tracked curves, because
 *      the live run and the replay mint different intent ids.
 *   2. Against bot.db positions, when the tape is the old bot's recording and we want to
 *      know whether v2 would have bought the same coins.
 *
 *   npx tsx tools/replay-proof.ts data/tape.db config/strategy.toml [--bot-db ../v1/data/bot.db]
 */
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { parseTransaction, type Hex } from 'viem'
import { Tape } from '../io/tape.js'
import { loadConfig } from '../io/config-load.js'
import { emptyState } from '../core/state.js'
import { replay, compareAgainstLive, type Divergence } from '../drivers/replay.js'
import { configDigest, kernelId } from '../core/identity.js'
import type { Switches } from '../core/config.js'
import type { Event } from '../core/events.js'
import type { Intent } from '../core/intents.js'
import type { State } from '../core/state.js'

export type ProofResult = {
  readonly events: number
  readonly intents: number
  readonly refusals: number
  readonly buckets: Readonly<Record<string, number>>
  /** this kernel's behaviour on this tape, as one number to compare across builds */
  readonly kernelId: string
  readonly tapeDivergences: readonly Divergence[]
  readonly liveBought: number
  readonly foldBought: number
  readonly liveOnly: number
  readonly foldOnly: number
}

function readTape(path: string): Event[] {
  const tape = new Tape(path)
  const events: Event[] = []
  let from = 1
  for (;;) {
    const batch = tape.read(from, 5_000)
    if (!batch.length) break
    events.push(...batch)
    from = batch[batch.length - 1]!.seq + 1
  }
  tape.close()
  return events
}

function tokenOfSigned(e: Extract<Event, { kind: 'tx-signed' }>, state: State): string {
  try {
    const tx = parseTransaction(e.raw as Hex)
    const to = (tx.to ?? '').toLowerCase()
    if (e.txKind === 'approve') return to
    return state.curves.get(to)?.token ?? to
  } catch {
    return ''
  }
}

export function prove(
  events: readonly Event[],
  initial: ReturnType<typeof emptyState>,
  botDb: string | null,
  onIntent?: (seq: number, intent: Intent) => void,
): ProofResult {
  const foldIntents: Array<{ seq: number; intent: Intent }> = []
  const result = replay(initial, events, (_state, event, intents) => {
    for (const i of intents) {
      onIntent?.(event.seq, i)
      if (i.kind === 'buy' || i.kind === 'sell') foldIntents.push({ seq: event.seq, intent: i })
    }
  })

  const liveSigned: Array<{ seq: number; intentId: string; txKind: string; token: string }> = []
  for (const e of events) {
    if (e.kind !== 'tx-signed') continue
    liveSigned.push({
      seq: e.seq, intentId: e.intentId, txKind: e.txKind,
      token: tokenOfSigned(e, result.state),
    })
  }
  const tapeDivergences = liveSigned.length ? compareAgainstLive(foldIntents, liveSigned) : []

  let liveBought = 0, foldBought = 0, liveOnly = 0, foldOnly = 0
  if (botDb) {
    const db = new Database(botDb, { readonly: true, fileMustExist: true })
    const bought = new Set((db.prepare(
      `SELECT lower(token) t FROM positions WHERE live = 1 AND buy_ok = 1 AND token IS NOT NULL`,
    ).all() as Array<{ t: string }>).map((r) => r.t))
    db.close()
    const foldSet = new Set(
      foldIntents.flatMap((f) => f.intent.kind === 'buy' ? [f.intent.token.toLowerCase()] : []),
    )
    liveBought = bought.size
    foldBought = foldSet.size
    for (const t of bought) if (!foldSet.has(t)) liveOnly++
    for (const t of foldSet) if (!bought.has(t)) foldOnly++
  }

  return {
    events: result.events,
    intents: result.decisions.length,
    refusals: result.refusals,
    buckets: result.buckets,
    /**
     * The whole point of `core/identity.ts`, finally printed by something.
     *
     * The id is this kernel's decision stream over THIS tape, so two builds compared on the
     * same tape have the same id exactly when they would have traded the same. That is the
     * only honest way to answer "did my change to the fold move anything", and it is the
     * question every edit to `decide.ts` raises. Nothing computes it at run time yet, which
     * is why `state.kernelId` is empty on the page and null in the report.
     */
    kernelId: kernelId(configDigest(initial.config), result.decisions),
    tapeDivergences,
    liveBought, foldBought, liveOnly, foldOnly,
  }
}

function main(): void {
  const args = parseArgs({
    allowPositionals: true,
    options: { 'bot-db': { type: 'string' } },
  })
  const tapePath = args.positionals[0] ?? 'data/tape.db'
  const specPath = args.positionals[1] ?? 'config/strategy.toml'
  const loaded = loadConfig(specPath, Date.now(), null)
  if (!loaded.ok) {
    console.error(`the spec would not load: ${loaded.refusal.reason}`)
    process.exit(1)
  }
  const switches: Switches = {
    sizeWei: BigInt(loaded.value.values.risk.maxTradeSizeWei),
    mode: 'live',
    at: 0,
    by: 'replay-proof',
  }
  const events = readTape(tapePath)
  const proof = prove(events, emptyState(loaded.value.values, switches), args.values['bot-db'] ?? null)

  console.log(`replay: ${proof.events} events, ${proof.intents} intents, ${proof.refusals} refusals`)
  console.log(`replay: buckets ${JSON.stringify(proof.buckets)}`)
  console.log(`replay: kernel ${proof.kernelId} (this fold's decisions on this tape; compare it across builds)`)
  if (proof.tapeDivergences.length || events.some((e) => e.kind === 'tx-signed')) {
    console.log(`replay: ${proof.tapeDivergences.length} divergences vs tx-signed on this tape`)
    for (const d of proof.tapeDivergences.slice(0, 20)) console.log(`  ${d.kind} seq=${d.seq} ${d.detail}`)
    if (proof.tapeDivergences.length > 20) console.log(`  … ${proof.tapeDivergences.length - 20} more`)
  } else {
    console.log('replay: no tx-signed on this tape (a shadow run, or the old bot\'s recording)')
  }
  if (args.values['bot-db']) {
    console.log(`replay vs bot.db: live bought ${proof.liveBought}, fold would buy ${proof.foldBought}, live-only ${proof.liveOnly}, fold-only ${proof.foldOnly}`)
  }
  if (proof.tapeDivergences.length) process.exit(2)
}

const invoked = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invoked) main()
