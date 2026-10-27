/**
 * Fold the live tape and serve the dashboard from it.
 *
 * WHAT THIS IS FOR TODAY. The new core cannot trade until it has a transport, but the tape it
 * will be judged on is already recording. So the same fold, the same read model and the same
 * page run against real live data now, read-only, beside the bot that is actually trading.
 * That is worth having on its own, and it is also the most honest smoke test available,
 * because it runs on the real event stream rather than on fixtures written to pass. It has
 * already caught four defects that way.
 *
 * IT CANNOT TRADE. No signer, no sender, no chain client, and the tape opens READ ONLY. The
 * intents the fold produces are counted and thrown away.
 *
 * IT CANNOT CLAIM THE OTHER PROCESS'S TRADES, AND IT SAYS SO. The live bot's intent ids are
 * token addresses; the fold mints its own (`buy-7`). They never join, so no fill this tape
 * carries is ever matched to a position here, and every money figure would be a structurally
 * correct zero. A zero that means "none" and a zero that means "not measured" look identical
 * on a screen, so `unavailable.money` is declared below and every field that depends on it
 * renders that sentence instead of a number. This is the 2026-09-16 "frozen tape drawn as
 * live" defect, refused at the source.
 *
 * It tails: folds everything present, then polls. Polling rather than watching because the
 * tape is written by another process through WAL, and one second behind is fine for a page a
 * person reads.
 */
import Database from 'better-sqlite3'
import { decide } from '../core/decide.js'
import { emptyState, type State } from '../core/state.js'
import { loadConfig } from '../io/config-load.js'
import { History } from '../projections/history.js'
import { serve } from '../projections/server.js'
import type { ProjectOptions } from '../projections/viewmodel.js'
import type { Event } from '../core/events.js'
import type { Switches } from '../core/config.js'

const tapePath = process.argv[2] ?? 'data/tape.db'
const specPath = process.argv[3] ?? 'config/strategy.toml'
const port = Number(process.env.PORT ?? 8788)
/**
 * Loopback by default, the tailnet address when asked.
 *
 * Defaulting to loopback is deliberate: a page that binds every interface the moment someone
 * runs it is how an internal dashboard ends up on the internet. The box is reached over the
 * tailnet, so binding the tailnet address is an explicit choice the operator makes.
 */
const host = process.env.MONITOR_HOST ?? '127.0.0.1'

const loaded = loadConfig(specPath, Date.now(), null)
if (!loaded.ok) {
  // A spec that will not load is fatal HERE and only here: this process has nothing to fall
  // back to. The live bot's rule is the opposite (keep the previous spec in force), and the
  // difference is deliberate.
  console.error(`the spec would not load: ${loaded.refusal.reason}`)
  process.exit(1)
}

/**
 * The size the fold should REASON with, which is not a size anything will trade.
 *
 * It matters that this is not zero. At zero every launch stops at `risk-size` and the decision
 * path beyond it (bankroll, stream health, the pump guard) is never exercised, so the monitor
 * would report a funnel that says more about its own configuration than about the market. It
 * does NOT move the market indicator: the replay prices its own entry at a fixed 0.010 ETH so
 * that a size change cannot move the ruler. The live switch is not on the tape yet, so it is
 * supplied here.
 *
 * Read-only: no signer, no sender, a read-only tape handle. Mode is `shadow` so the page
 * cannot claim this process is sending. The size is only ever an input to arithmetic.
 */
const sizeWei = BigInt(process.env.MONITOR_SIZE_WEI ?? '5000000000000000')
const switches: Switches = { sizeWei, mode: 'shadow', at: Date.now(), by: 'monitor' }
let state: State = emptyState(loaded.value.values, switches)
const history = new History()

/**
 * What this run cannot produce, and the sentence the page shows instead of a number.
 *
 * Each one names a missing RECORDING, not a missing feature, because that is what an operator
 * can act on. Paper is not in this list: the fold already scores every routed launch, so the
 * ungated wallet is a projection of this tape, not a second process.
 */
const OPTIONS: ProjectOptions = {
  unavailable: {
    money: 'this core did not place these trades. The tape is the old bot\'s, whose intent ids are token addresses while the fold mints its own, so no fill here belongs to a position here.',
    account: 'no wallet balance is on this tape. The balance read in the old bot runs outside the recorder.',
    truePeak: 'the independent peak is the replay\'s, and the replay needs the launch\'s own curve logs. This tape carries the old bot\'s log batches, so the fold scores what it saw.',
  },
  // No price feed reaches this process, and inventing one would put a number on the page that
  // nothing can check. The ETH columns are exact; the dollar columns say why they are absent.
  ethUsd: null,
}

/**
 * The null driver: every send this fold raises is answered with a clean refusal.
 *
 * WITHOUT IT THE FUNNEL SATURATES AND STOPS SAYING ANYTHING. `risk.reserved` is taken when
 * the entry is decided and given back when the send settles, and in this process nothing ever
 * sends. After `maxConcurrent` decisions every later launch is refused for capacity, so the
 * page reported `risk-capacity` beside `open 0` and every stage past capacity went untested.
 *
 * A CLEAN REFUSAL IS THE TRUE ANSWER, not a convenient one: this run has no sender, so nothing
 * was sequenced, so the slot and the capital do go back. It is the same event a real sequencer
 * rejection produces, and it is fed through the same fold, so the counts it produces are real
 * counts of a real refusal rather than a special case in the core.
 */
function refuseEverySend(s: State, raised: readonly { kind: string; intentId?: string }[], h: History, e: Event): State {
  let out = s
  for (const i of raised) {
    if (i.kind !== 'buy' && i.kind !== 'sell' && i.kind !== 'approve') continue
    if (!i.intentId) continue
    const r = decide(out, {
      seq: e.seq, at: e.at, run: e.run, kind: 'tx-send-result',
      intentId: i.intentId, hash: '', ok: false, nonceConsumed: false, uncertain: false,
      statusCode: null, error: 'this run has no sender: the monitor is read-only', tSigned: e.at, tSent: e.at,
    } as Event)
    out = r.state
    h.observe(e, out, r.intents, r.refusals)
  }
  return out
}

const db = new Database(tapePath, { readonly: true, fileMustExist: true })
const readFrom = db.prepare('SELECT seq, at, run, kind, body FROM events WHERE seq >= ? ORDER BY seq LIMIT ?')
let cursor = 1
let folded = 0
let intents = 0

function pump(): number {
  let n = 0
  for (;;) {
    const rows = readFrom.all(cursor, 5_000) as Array<{ seq: number; at: number; run: string; kind: string; body: string }>
    if (!rows.length) break
    for (const r of rows) {
      const event = { seq: r.seq, at: r.at, run: r.run, kind: r.kind, ...JSON.parse(r.body) } as Event
      try {
        const out = decide(state, event)
        state = out.state
        intents += out.intents.length
        history.observe(event, state, out.intents, out.refusals)
        state = refuseEverySend(state, out.intents, history, event)
      } catch (e) {
        // One malformed event must not stop the tail. It is counted as a gap, which is exactly
        // what it is: a range of the tape this fold could not reproduce.
        state = { ...state, gaps: [...state.gaps, { stream: 'recorder', lo: r.seq, hi: r.seq, reason: String((e as Error).message ?? e) }] }
      }
      cursor = r.seq + 1
      n++
      folded++
    }
  }
  return n
}

const first = pump()
history.catchUp(state)
serve({ port, host, current: () => state, history: () => history, options: OPTIONS })
console.log(`monitor: folded ${first} events from ${tapePath}`)
console.log(`monitor: serving http://${host}:${port} (read only, cannot trade)`)

const timer = setInterval(() => {
  const n = pump()
  if (n) console.log(`monitor: +${n} events (${folded} folded, ${intents} intents the fold would have raised)`)
}, 1_000)
timer.unref?.()

process.on('SIGINT', () => { clearInterval(timer); db.close(); process.exit(0) })
