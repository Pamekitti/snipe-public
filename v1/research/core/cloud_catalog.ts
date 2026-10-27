import { readFileSync } from 'node:fs'
import type { GuardPolicy } from '../../src/strategy/scenario-guard.js'
export function candidates(): GuardPolicy[] {
  const result: GuardPolicy[] = []
  for (const n of [8, 10, 12, 15, 20, 30]) for (const m of [3, 5, 8]) {
    if (m >= n) continue
    for (const age of [30, 60, 120, 180]) for (const off of [-2.5, -2, -1.5, -1, -.5, 0]) {
      for (const freshOn of [.5, 1, 1.5, 2]) {
        result.push({ id: `fresh-${result.length}`, n, m, off, freshOn, fullOn: 2, ageMs: age * 60000, mode: 'fresh' })
        for (const fullOn of [1, 2, 3]) result.push({ id: `both-${result.length}`, n, m, off, freshOn, fullOn, ageMs: age * 60000, mode: 'both' })
      }
    }
  }
  for (const n of [8, 10, 12, 15, 20, 30]) for (const age of [30, 60, 120, 180])
    for (const off of [-2.5, -2, -1.5, -1, -.5, 0]) for (const fullOn of [1, 2, 3])
      result.push({ id: `full-${result.length}`, n, m: 3, off, freshOn: 1, fullOn, ageMs: age * 60000, mode: 'full' })
  return result
}
export const HOLDS = [20, 25, 30, 35, 40, 45, 50, 60] as const
export const TARGETS = [1.25, 1.36, 1.5, 1.75, 2, 2.5, 3] as const
export const EXIT_IDS = [...HOLDS.map(s => 'hold-'+s), 'adaptive-hold', 'progress-30']
export const FAMILIES = { freshBrake: [-1, -.5, 0], minNewOutcomes: [2, 4], cooldownMs: [30000,60000,120000], halfLifeMs: [900000,1800000,3600000], positiveCap: [1,2], participation: [.25,.375,.5] }

export type ExitDescriptor = { id: string; holdMs: number; progressHold?: { initialMs: number; stepMs: number; lookbackMs: number; maximumMs: number }; core: boolean; changes: number }
export const EXECUTION_EXITS: ExitDescriptor[] = JSON.parse(readFileSync(new URL('./cloud-exits.json',import.meta.url),'utf8'))
