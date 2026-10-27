/**
 * Replay a tape and write the decision stream, so two builds can be compared line by line.
 *
 *   npx tsx tools/dump-kernel.ts <tape.db> <strategy.toml> <decisions.txt>
 */
import { writeFileSync } from 'node:fs'
import { loadConfig } from '../io/config-load.js'
import { emptyState } from '../core/state.js'
import { replay } from '../drivers/replay.js'
import { configDigest, kernelId } from '../core/identity.js'
import { Tape } from '../io/tape.js'
import type { Event } from '../core/events.js'
import type { Switches } from '../core/config.js'

const tapePath = process.argv[2]
const specPath = process.argv[3]
const outPath = process.argv[4]
if (!tapePath || !specPath || !outPath) {
  console.error('usage: npx tsx tools/dump-kernel.ts <tape.db> <strategy.toml> <decisions.txt>')
  process.exit(1)
}

const loaded = loadConfig(specPath, Date.now(), null)
if (!loaded.ok) {
  console.error(`the spec would not load: ${loaded.refusal.reason}`)
  process.exit(1)
}
const switches: Switches = {
  sizeWei: BigInt(loaded.value.values.risk.maxTradeSizeWei),
  mode: 'live',
  at: 0,
  by: 'dump-kernel',
}

const tape = new Tape(tapePath)
const events: Event[] = []
let from = 1
for (;;) {
  const batch = tape.read(from, 5_000)
  if (!batch.length) break
  events.push(...batch)
  from = batch[batch.length - 1]!.seq + 1
}
tape.close()

const result = replay(emptyState(loaded.value.values, switches), events)
const id = kernelId(configDigest(loaded.value.values), result.decisions)
writeFileSync(outPath, result.decisions.join('\n') + (result.decisions.length ? '\n' : ''))
console.log(`replay: ${result.events} events, ${result.decisions.length} intents, ${result.refusals} refusals`)
console.log(`replay: kernel ${id}`)
console.log(`replay: wrote ${result.decisions.length} decisions to ${outPath}`)
