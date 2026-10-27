/**
 * A hash of the code that folds, so a saved fold cannot outlive the build that wrote it.
 *
 * WHY A SNAPSHOT NEEDS THIS. A checkpoint is the state as computed BY A PARTICULAR BUILD. Load
 * it into a different one and two things go wrong quietly: a field added inside a stored object
 * — a position, a curve — comes back missing rather than defaulted, and the numbers the new
 * rules would have produced over those same events are not the numbers in the file. Neither
 * shows up as an error. Both show up as a bot trading on a book that is subtly not its own.
 *
 * So the snapshot is stamped with this and refused when it does not match. The cost is one full
 * replay after a deploy, which `tools/build-snapshot.ts` removes by folding the new build's
 * snapshot in the background before the restart.
 *
 * TESTS AND TOOLS ARE NOT IN IT, deliberately. They cannot change what the fold computes, and
 * making a test edit cost a thirteen-minute boot would teach everyone to skip the restart.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Everything whose source can change what the fold computes or what the state holds. */
const FOLDS = ['core', 'drivers', 'io', 'projections']

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function sources(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries.sort()) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

let cached: string | null = null

/** Sixteen hex characters naming this build's fold. Computed once; the files cannot change under it. */
export function codeId(): string {
  if (cached !== null) return cached
  const h = createHash('sha256')
  const files = [...FOLDS.flatMap((d) => sources(join(ROOT, d))), join(ROOT, 'main.ts')].sort()
  for (const f of files) {
    // The path is hashed with the body so that moving a file is a different build even when
    // every byte of source is the same.
    h.update(f.slice(ROOT.length))
    h.update('\0')
    try { h.update(readFileSync(f)) } catch { h.update('missing') }
    h.update('\0')
  }
  cached = h.digest('hex').slice(0, 16)
  return cached
}

/** Where this build keeps its snapshot. Two builds never fight over one file. */
export const snapshotPathFor = (tapePath: string): string => `${tapePath}.snapshot-${codeId()}`
