/**
 * Fold the tape with THIS build and leave the snapshot where its boot will look for it.
 *
 * WHAT IT IS FOR. A snapshot belongs to the build that wrote it (`io/codeid.ts`), so the first
 * boot after a deploy has nothing to resume from and replays the whole tape — thirteen minutes
 * of not trading on 2026-09-18. This does that replay in a second process, beside the running
 * bot, while the running bot keeps trading. The restart then finds a snapshot it can use and
 * comes up in seconds.
 *
 *   cd ~/snipe-v2 && npx tsx tools/build-snapshot.ts data/tape.db config/strategy.toml
 *
 * IT DOES NOT TOUCH THE RUNNING PROCESS. It reads the tape, which SQLite allows beside the
 * writer, and writes one file that no other build will read. Run it after `deploy.sh` and
 * before the restart; run it again if the deploy changed anything, because the filename it
 * writes is derived from the code.
 *
 * The snapshot it leaves is a few minutes behind by the time the restart happens, and that is
 * fine: boot replays the gap, which is seconds of events.
 */
import { Tape } from '../io/tape.js'
import { loadConfig } from '../io/config-load.js'
import { BoundedMap, BoundedSet, Ring } from '../core/contracts.js'
import { decide } from '../core/decide.js'
import { emptyState, type State } from '../core/state.js'
import { History } from '../projections/history.js'
import { codeId, snapshotPathFor } from '../io/codeid.js'
import { readSnapshot, shapeOf, writeSnapshot, type Registry } from '../io/snapshot.js'
import { switchesFrom } from '../io/env-file.js'
import { SWITCHES } from '../io/dotenv.js'

const REGISTRY: Registry = new Map<string, new (...args: never[]) => object>([
  ['Ring', Ring as never],
  ['BoundedMap', BoundedMap as never],
  ['BoundedSet', BoundedSet as never],
  ['History', History as never],
])

const tapePath = process.argv[2] ?? 'data/tape.db'
const specPath = process.argv[3] ?? 'config/strategy.toml'

const loaded = loadConfig(specPath, Date.now(), null)
if (!loaded.ok) { console.error(`the spec would not load: ${loaded.refusal.reason}`); process.exit(1) }

/**
 * The same switches the live process boots with.
 *
 * `emptyState` takes them, and a snapshot folded under a different size or mode would be a
 * snapshot of a different bot. Reading the same file the bot reads is the only way to be sure
 * this is the state that boot would have computed.
 */
const sw = switchesFrom(SWITCHES, BigInt(loaded.value.values.risk.maxTradeSizeWei), Date.now())
if (!sw.ok) { console.error(sw.reason); process.exit(1) }

const out = snapshotPathFor(tapePath)
const tape = new Tape(tapePath)
const history = new History()
let state: State = emptyState(loaded.value.values, sw.value)
let cursor = 1
const t0 = Date.now()

for (;;) {
  const rows = tape.read(cursor, 5_000)
  if (!rows.length) break
  for (const e of rows) {
    try {
      const d = decide(state, e)
      if (d) {
        state = d.state
        history.observe(e, state, d.intents, d.refusals)
      }
    } catch (err) {
      // The live boot refuses to start on a fold throw, so this refuses to leave a snapshot of
      // a fold that threw. Writing one would hand the bot a book with a hole in it.
      console.error(`build-snapshot: fold threw at seq ${e.seq} kind=${e.kind}: ${String(err)}`)
      console.error('build-snapshot: no snapshot written. The next boot replays the tape, which is slow and right.')
      process.exit(1)
    }
    cursor = e.seq + 1
  }
}
history.catchUp(state)
const foldMs = Date.now() - t0

const shape = shapeOf({ state, history })
const written = writeSnapshot(out, { seq: state.seq, at: state.at, shape, payload: { state, history } }, REGISTRY)

// Read it back before claiming anything. A snapshot nobody verified is a slow boot the
// operator thinks they have avoided.
const back = readSnapshot(out, REGISTRY, shape)
if (back === null || back.seq !== state.seq) {
  console.error(`build-snapshot: wrote ${out} and could not read it back. Delete it and replay.`)
  process.exit(1)
}
tape.close()
console.log(`build-snapshot: build ${codeId()}, folded ${cursor - 1} events in ${(foldMs / 1000).toFixed(1)}s`)
console.log(`build-snapshot: ${out} holds the fold through seq ${state.seq}, ${(written.bytes / 1_000_000).toFixed(1)} MB`)
console.log('build-snapshot: restart now and boot replays only what has landed since.')
