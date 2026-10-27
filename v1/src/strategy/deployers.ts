/**
 * Deployer track record.
 *
 * The one selection signal that held up in EVERY era measured (organic Aug 6-12,
 * industrial Aug 13-15, farm-saturation Aug 16-18): return per trade falls monotonically
 * with how many launches the deployer has already done.
 *
 *   prior launches:   0        1-2      3-9      10+
 *   organic era:    +2.87%   +0.69%   -2.15%   -2.53%
 *   industrial:     +1.90%   +1.15%   -1.38%   -1.27%
 *   current (held-out test):
 *                   +2.94%   +0.32%   -5.32%   -3.97%
 *
 * Serial launchers lose money for the people who buy their coins, always. 60% of all
 * launches on this venue come from deployers with 2+ launches, so this is not a rare cut.
 *
 * KNOWN LIMIT, do not forget it: a farm that rotates to a fresh deployer wallet for every
 * launch reads as "first launch" and sails straight through. Checked against the 22 real
 * trades of the 2026-08-17 pilot: 19 of 22 losers were first-launch deployers. This filter
 * catches the lazy operators, not the disciplined ones. Beating rotation needs funding-trail
 * tracing, which is not built.
 *
 * Lookups are a Map hit, never an RPC call: the entry clock has 2s of headroom and none of
 * it is being spent here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export type DeployerFile = { asOfBlock: number; counts: Record<string, number> }

export class DeployerRegistry {
  private counts = new Map<string, number>()
  /** launches at or below this block are already in `counts`; above it we count ourselves */
  asOfBlock = 0
  loaded = false

  /**
   * @param file  historical export (research/data -> v1/data/deployers.json)
   */
  load(file?: string): void {
    const p = file ?? path.join(here, '..', '..', 'data', 'deployers.json')
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as DeployerFile
      this.asOfBlock = raw.asOfBlock ?? 0
      for (const [addr, n] of Object.entries(raw.counts ?? {})) {
        this.counts.set(addr.toLowerCase(), n)
      }
      this.loaded = true
    } catch {
      // an empty registry means every deployer looks new, which turns the filter OFF
      // rather than silently rejecting everything. The caller must check `loaded`.
      this.loaded = false
    }
  }

  /** seed launches this bot already saw in earlier runs, so a restart cannot reset history */
  seed(rows: Array<{ deployer: string; block: number }>): number {
    let n = 0
    for (const r of rows) {
      if (r.block <= this.asOfBlock) continue
      this.bump(r.deployer)
      n++
    }
    return n
  }

  /** how many launches this deployer had BEFORE the one being screened */
  priorLaunches(deployer: string): number {
    return this.counts.get(deployer.toLowerCase()) ?? 0
  }

  /** record a launch we have now seen; call AFTER screening it */
  bump(deployer: string): void {
    const k = deployer.toLowerCase()
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1)
  }

  get size(): number {
    return this.counts.size
  }
}

export const deployers = new DeployerRegistry()
