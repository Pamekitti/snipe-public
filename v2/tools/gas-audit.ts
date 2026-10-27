/**
 * How much gas a tape proves the bot burned, per book, against each book's stop.
 *
 * DIAGNOSTIC, and it decides nothing. It exists because "charge gas to the drawdown stop" is a
 * change to when the bot halts itself, and that is a money decision nobody should take on an
 * argument alone: this prints the number the argument is about. Run it before and after changing
 * a stop, never instead of `replay-proof.ts`.
 *
 * Only PROVED gas is counted, which is what the fold charges: every wei here came from a
 * receipt's `gasUsed * effectiveGasPrice`. The ordinary legs of a healthy trade never have their
 * receipt read, so this is a FLOOR on the friction, not the whole of it.
 *
 *   npx tsx tools/gas-audit.ts data/tape.db config/strategy.toml
 */
import { Tape } from '../io/tape.js'
import { loadConfig } from '../io/config-load.js'
import { bookLedger, emptyState, ledgerNetWei, walletNetWei } from '../core/state.js'
import { replay } from '../drivers/replay.js'
import type { Event } from '../core/events.js'
import type { Switches } from '../core/config.js'

const tapePath = process.argv[2] ?? 'data/tape.db'
const specPath = process.argv[3] ?? 'config/strategy.toml'

const loaded = loadConfig(specPath, Date.now(), null)
if (!loaded.ok) {
  console.error(`the spec would not load: ${loaded.refusal.reason}`)
  process.exit(1)
}
const switches: Switches = {
  sizeWei: BigInt(loaded.value.values.risk.maxTradeSizeWei),
  mode: 'live', at: 0, by: 'gas-audit',
}

const tape = new Tape(tapePath)
const events: Event[] = []
for (let from = 1; ;) {
  const batch = tape.read(from, 5_000)
  if (!batch.length) break
  events.push(...batch)
  from = batch[batch.length - 1]!.seq + 1
}
tape.close()

const eth = (w: bigint): string => (Number(w) / 1e18).toFixed(9)
const pct = (part: bigint, whole: bigint): string =>
  whole > 0n ? `${(Number((part * 10_000n) / whole) / 100).toFixed(2)}%` : 'n/a'

/**
 * THE MEASUREMENT: the receipt events themselves, summed off the tape.
 *
 * Read straight from the rows rather than through the fold, because the fold cannot answer this
 * question about a tape. `chargeGas` is reached only when a receipt's hash matches an in-flight
 * record, and a replay signs nothing and sends nothing, so no hash ever matches and the ledger
 * comes out at exactly zero. Asked through `replay` this tool printed `gas 0.000000000` on a tape
 * carrying 37 real verdicts, which reads as "no gas was burned" and means "this could not see it".
 *
 * A FLOOR, not the whole friction. Only receipts the bot actually asked for are on the tape, and
 * the ordinary legs of a healthy trade never have theirs read.
 */
const verdicts = events.flatMap((e) => (e.kind === 'receipt' && e.result != null ? [e.result] : []))
const provedGasWei = verdicts.reduce((a, v) => a + BigInt(v.gasWei), 0n)
const reverted = verdicts.filter((v) => !v.ok).length
const receipts = events.filter((e) => e.kind === 'receipt').length

console.log(`gas-audit: ${events.length} events, ${receipts} receipts, ${verdicts.length} carrying a verdict, ${reverted} of those failed`)
const wStop = BigInt(loaded.value.values.risk.maxWalletDrawdownWei)
console.log(`gas-audit: proved gas ${eth(provedGasWei)} ETH, which is ${pct(provedGasWei, wStop)} of the ${eth(wStop)} ETH wallet stop`)
console.log(`gas-audit: per-book attribution needs a live run; a receipt event does not name its book.`)

/**
 * The fold's own view, second and clearly labelled, because on a tape it is not a measurement.
 * It is here to show a live tape charging what the receipts prove, once one exists.
 */
const { state } = replay(emptyState(loaded.value.values, switches), events)
console.log(`gas-audit: the fold charged ${eth(state.risk.walletGasWei)} ETH replaying this tape`
  + `${state.risk.walletGasWei === 0n ? ' (expected: a replay sends nothing, so no receipt matches an in-flight record)' : ''}`)
for (const spec of loaded.value.values.books) {
  const l = bookLedger(state.risk, spec.id)
  console.log(
    `  ${spec.id.padEnd(9)} booked ${eth(l.realizedWei).padStart(13)}`
    + `  gas ${eth(l.gasWei).padStart(13)}`
    + `  net ${eth(ledgerNetWei(l)).padStart(13)}`
    + `  against its ${eth(BigInt(spec.maxDrawdownWei))} stop`,
  )
}
console.log(`  ${'WALLET'.padEnd(9)} booked ${eth(state.risk.walletRealizedWei).padStart(13)}`
  + `  gas ${eth(state.risk.walletGasWei).padStart(13)}`
  + `  net ${eth(walletNetWei(state.risk)).padStart(13)}`
  + `  against its ${eth(wStop)} stop`)
console.log(`gas-audit: halts at the end of the tape ${JSON.stringify([...state.risk.halts.keys()])}`)
