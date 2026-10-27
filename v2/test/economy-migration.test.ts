import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { assertEconomyCompatible } from '../tools/prepare-economy-snapshot.js'

it('permits only the additive readiness field and rejects unrelated changes to the fold', () => {
  const root = mkdtempSync(join(tmpdir(), 'economy-compat-'))
  const source = join(root, 'source'), target = join(root, 'target')
  try {
    for (const tree of [source, target]) {
      for (const dir of ['core', 'io', 'projections']) mkdirSync(join(tree, dir), { recursive: true })
      writeFileSync(join(tree, 'io/snapshot.ts'), 'same snapshot')
      writeFileSync(join(tree, 'projections/history.ts'), 'same history')
      writeFileSync(join(tree, 'core/events.ts'), tree === source ? 'type Event = { healthy: boolean }' : 'type Event = { healthy: boolean; entryReady?: boolean }')
    }
    expect(() => assertEconomyCompatible(source, target)).not.toThrow()
    writeFileSync(join(target, 'core/events.ts'), 'type Event = { healthy: string; entryReady?: boolean }')
    expect(() => assertEconomyCompatible(source, target)).toThrow(/Unapproved/)
    writeFileSync(join(target, 'core/unrelated.ts'), 'new rule')
    expect(() => assertEconomyCompatible(source, target)).toThrow(/inventory/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
