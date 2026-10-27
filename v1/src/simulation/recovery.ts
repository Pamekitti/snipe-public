import { MODEL_HASH } from './identity.js'
import { SCENARIO_IDS } from '../strategy/execution-scenarios.js'
import type { buildScenarioObserver } from './scenario-observer.js'

/** The unchanged DD count and threshold are applied to every compatible scenario. */
export function scenarioRecovery(observer: ReturnType<typeof buildScenarioObserver>, configId: string,
  haltAt: number, now: number, heartbeatAt: number, window: number, ageMs: number, verified: boolean) {
  if (!verified || !observer?.complete || observer.modelHash !== MODEL_HASH || observer.configId !== configId
    || heartbeatAt > now || now-heartbeatAt > 15000 || observer.at > now) return null
  if (observer.tapes.length !== SCENARIO_IDS.length || SCENARIO_IDS.some(id=>observer.tapes.filter(t=>t.id===id).length!==1)) return null
  const scores = observer.tapes.map(tape => {
    if (!tape.complete) return null
    const seen = new Set<string>()
    for (const o of tape.outcomes) {
      if (seen.has(o.token.toLowerCase()) || ![o.value,o.launched,o.available].every(Number.isFinite) || o.available<=o.launched) return null
      seen.add(o.token.toLowerCase())
    }
    const rows = tape.outcomes.filter(o=>o.available>haltAt&&o.available<=now&&now-o.launched<=ageMs)
      .sort((a,b)=>b.block-a.block||b.token.localeCompare(a.token)).slice(0,window)
    return {n:rows.length,sum:rows.reduce((s,o)=>s+o.value,0)}
  })
  if (scores.some(s=>s===null)) return null
  return {n:Math.min(...scores.map(s=>s!.n)),sum:Math.min(...scores.map(s=>s!.sum)),source:'shared-execution' as const}
}
