/** Preserved exploratory exit grid. Offline tape reads only; no execution driver.
 * Retrospective configured-policy analysis, not a reproduction of historical live decisions. */
import { writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { decide } from '../core/decide.js'
import { simulationOf } from '../core/config.js'
import { blocksFromMs, LIVE_PATH, path, scoreLaunch } from '../core/sim.js'
import type { Observation, State } from '../core/state.js'
import { emptyState } from '../core/state.js'
import { loadConfig } from '../io/config-load.js'
import { Tape } from '../io/tape.js'

const [tapePath, specPath, cutoffArg, outputPath] = process.argv.slice(2)
if (!tapePath || !specPath || !cutoffArg || !outputPath) throw new Error('usage: tail_grid tape spec cutoff output')
const cutoff = Number(cutoffArg)
const loaded = loadConfig(specPath, Date.now(), null)
if (!loaded.ok) throw new Error(loaded.refusal.reason)
const cfg = loaded.value.values
const calibration = simulationOf(cfg)
const hardStops = [0.5, 0.6, 0.7, 0.8, 0.9]
const deadTimes = [0, 10_000, 20_000, 30_000, 40_000]
const tps = [1.25, 1.36, 1.5, 1.75, 2, 2.5, 3]
const observations = new Map<string, Observation>()
let state: State = emptyState(cfg, { sizeWei: 5_000_000_000_000_000n, mode: 'live', at: 0, by: 'rolling7' })
let cursor = 1
let folded = 0
let firstAt = 0
let lastAt = 0
const tape = new Tape(tapePath)
for (;;) {
  const batch = tape.read(cursor, 5_000)
  if (batch.length === 0) break
  for (const event of batch) {
    if (firstAt === 0) firstAt = event.at
    lastAt = event.at
    state = decide(state, event).state
    if (event.kind === 'config-applied') state = { ...state, config: cfg }
    if (event.kind === 'chain-read') {
      for (const observation of state.observations.values()) {
        if (!observations.has(observation.token)) observations.set(observation.token, observation)
      }
    }
    cursor = event.seq + 1
    folded++
  }
}
tape.close()

const rows: unknown[] = []
let considered = 0
let unavailable = 0
for (const observation of [...observations.values()].sort((a, b) => a.startedAt - b.startedAt || a.token.localeCompare(b.token))) {
  if (observation.startedAt < cutoff) continue
  considered++
  const replay = path(
    { token: observation.token, block: observation.launchBlock, deployer: observation.deployer, tx: observation.launchTx },
    0.01,
    observation.events,
    observation.creatorTaxBps,
    LIVE_PATH,
  )
  if (replay === null) { unavailable++; continue }
  const results: Record<string, number> = {}
  for (const hard of hardStops) for (const deadMs of deadTimes) {
    const scored = scoreLaunch(replay, tps, {
      hardStop: hard,
      deadAfterBlk: blocksFromMs(deadMs),
      deadBelowMultiple: 1.03,
      holdBlk: blocksFromMs(45_000),
      pollBlk: 12,
      exitLagBlk: 6,
    }, blocksFromMs(45_000), calibration)
    for (const tp of tps) results[`h${hard}-d${deadMs}-tp${tp}`] = scored.perBar[tp.toFixed(2)]!
  }
  rows.push({ token: observation.token, book: observation.book, at: observation.startedAt, results })
}

writeFileSync(outputPath, gzipSync(JSON.stringify({
  methodology: { tape: tapePath, spec: specPath, cutoff, folded, firstAt, lastAt, stakeEth: 0.01, calibration: calibration.model, considered, unavailable },
  rows,
}), { level: 6 }))
console.log(JSON.stringify({ folded, observations: observations.size, considered, unavailable, selected: rows.length, firstAt, lastAt, cutoff }))
