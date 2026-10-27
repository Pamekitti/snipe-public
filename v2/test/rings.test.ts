/**
 * The dependency ring, enforced.
 *
 * This is the first test in v2 and it exists before any logic, because it is the rule that
 * makes the other rules possible. Two specific bans, and each one is a bug the old bot
 * actually shipped:
 *
 *   core/ may not import node: or npm.
 *     `books.ts` reached for `node:crypto` to hash a filter, which is how a pure decision
 *     file acquired a dependency on the host. Anything core/ cannot import, it cannot be
 *     non-deterministic about.
 *
 *   projections/ may not import core/decide.
 *     The old dashboard re-derived eleven decisions the bot had already made: it replayed
 *     the regime gate on every poll and discarded the answer, re-ran the take-profit argmax,
 *     re-encoded the entry screen in SQL twice, and coloured a position red at a threshold
 *     the bot does not act on. It could do all of that because the functions were reachable.
 *     If the display cannot reach them, it reads a projected field or it shows nothing.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RINGS = ['core', 'io', 'drivers', 'projections', 'tools'] as const
type Ring = (typeof RINGS)[number]

function walk(dir: string): string[] {
  let out: string[] = []
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return [] }
  for (const e of entries) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out = out.concat(walk(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

/** Every import specifier in a file, from static imports, type imports and re-exports. */
function imports(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const out: string[] = []
  const re = /(?:^|\n)\s*(?:import|export)\b[^\n;]*?from\s*['"]([^'"]+)['"]/g
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1]!)
  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
  for (let m = bare.exec(src); m; m = bare.exec(src)) out.push(m[1]!)
  return out
}

const files = new Map<Ring, string[]>(RINGS.map((r) => [r, walk(join(ROOT, r))]))
const isRelative = (s: string) => s.startsWith('.')
const rel = (f: string) => relative(ROOT, f)

describe('dependency rings', () => {
  it('core imports nothing outside itself', () => {
    const offenders: string[] = []
    for (const f of files.get('core')!) {
      for (const spec of imports(f)) {
        if (!isRelative(spec)) { offenders.push(`${rel(f)} -> ${spec}`); continue }
        // A relative import that climbs out of core/ leaves the ring.
        if (spec.startsWith('../')) offenders.push(`${rel(f)} -> ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('core has no node: builtins, so it cannot read a clock, a file or a random source', () => {
    const offenders: string[] = []
    for (const f of files.get('core')!) {
      for (const spec of imports(f)) if (spec.startsWith('node:')) offenders.push(`${rel(f)} -> ${spec}`)
    }
    expect(offenders).toEqual([])
  })

  it('core calls no clock and no random source', () => {
    const offenders: string[] = []
    for (const f of files.get('core')!) {
      const src = readFileSync(f, 'utf8')
      // Strip block and line comments: these names are discussed in prose throughout core/.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      if (/\bDate\.now\s*\(/.test(code)) offenders.push(`${rel(f)}: Date.now()`)
      if (/\bnew\s+Date\s*\(/.test(code)) offenders.push(`${rel(f)}: new Date()`)
      if (/\bMath\.random\s*\(/.test(code)) offenders.push(`${rel(f)}: Math.random()`)
      if (/\blocaleCompare\s*\(/.test(code)) offenders.push(`${rel(f)}: localeCompare()`)
    }
    expect(offenders).toEqual([])
  })

  it('projections never import the decision layer', () => {
    const offenders: string[] = []
    for (const f of files.get('projections')!) {
      for (const spec of imports(f)) {
        if (/(^|\/)core\/(decide|entry|exit|takeprofit|guard|risk)(\.js)?$/.test(spec)) {
          offenders.push(`${rel(f)} -> ${spec}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('io never imports the decision layer', () => {
    const offenders: string[] = []
    for (const f of files.get('io')!) {
      for (const spec of imports(f)) {
        if (/(^|\/)core\/decide(\.js)?$/.test(spec)) offenders.push(`${rel(f)} -> ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * No bare number in a comparison anywhere in projections/.
   *
   * THIS IS THE RULE THAT WOULD HAVE CAUGHT FOUR SHIPPED DEFECTS. The old page coloured a win
   * rate green at a literal `>=50` (dashboard-page.ts:352), a pop rate at `>=25` (`:351`), a
   * receipt rate at `>=99` (`:353`) and a kept bar at `0.7` / `0.3` (`:665`). None of them was
   * written down anywhere the bot could see, so the display's idea of "good" and the bot's
   * rules drifted apart with nothing to notice.
   *
   * A threshold the bot acts on must come from `state.config`, so the warning fires at the
   * same number the refusal does. A threshold that only decides how something LOOKS must come
   * from `levels.ts`. There is no third place.
   *
   * 0 and 1, with their bigint forms, are exempt: they are emptiness and sign, not policy.
   */
  it('projections hold no bare number in a comparison', () => {
    const ALLOWED = new Set(['0', '1', '0n', '1n'])
    const offenders: string[] = []
    for (const f of files.get('projections')!) {
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
      // The operator must be surrounded by whitespace and the number must stand alone, so
      // that `<h2>` in a template literal and `.slice(0, 6)` are not read as comparisons.
      const after = /(?<=\s)(?:[<>]=?|={2,3}|!={1,2})\s+(-?\d[\d_]*(?:\.\d+)?n?)(?![\w.])/g
      for (let m = after.exec(src); m; m = after.exec(src)) {
        if (!ALLOWED.has(m[1]!)) offenders.push(`${rel(f)} -> ${m[0]!.trim()}`)
      }
      const before = /(?<![\w.$])(-?\d[\d_]*(?:\.\d+)?n?)\s+(?:[<>]=?|={2,3}|!={1,2})(?=\s)/g
      for (let m = before.exec(src); m; m = before.exec(src)) {
        if (!ALLOWED.has(m[1]!)) offenders.push(`${rel(f)} -> ${m[0]!.trim()}`)
      }
    }
    expect(offenders, 'move these into levels.ts, or read them from state.config').toEqual([])
  })

  /**
   * The renderer imports nothing that can compute.
   *
   * Everything under `projections/render/` may reach `format.ts` (stringifiers and escaping),
   * `levels.ts` (declared display thresholds) and its own siblings, and may type-import
   * anything, because a type cannot be called. Everything else is a door back to the old
   * behaviour where the page re-derived a decision the bot had already made.
   *
   * It walks the directory rather than naming a file. The previous version hardcoded
   * `dashboard.ts` and would have thrown, not failed, the day that file was renamed.
   */
  it('the renderer imports only formatting, levels, siblings and types', () => {
    const pages = files.get('projections')!.filter((f) => f.includes(`${sep}render${sep}`))
    expect(pages.length, 'projections/render/ has no files; the rule below would vacuously pass').toBeGreaterThan(0)
    const ALLOWED = new Set(['../format.js', '../levels.js'])
    const offenders: string[] = []
    for (const page of pages) {
      const src = readFileSync(page, 'utf8')
      for (const line of src.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('import ')) continue
        if (t.startsWith('import type ')) continue
        const m = /from\s*['"]([^'"]+)['"]/.exec(t)
        if (!m) continue
        // `./x.js` is a sibling inside render/, which is the renderer talking to itself.
        if (ALLOWED.has(m[1]!) || /^\.\/[\w-]+\.js$/.test(m[1]!)) continue
        offenders.push(`${rel(page)} -> ${m[1]}`)
      }
    }
    expect(offenders, 'the renderer may not import anything that computes').toEqual([])
  })

  /**
   * The browser is sent no code that can compute either.
   *
   * `client.ts` ships a string of JavaScript into the document. It is outside the type system
   * and outside every rule above, so the one property that matters is checked textually: it may
   * read the DOM, fetch, and assign `innerHTML`, and it may not contain arithmetic on a
   * projected value or a threshold of its own. In practice that means no `toFixed`, which is
   * the tell for a formatter, and no comparison against a bare number.
   */
  it('the inlined browser client formats nothing', () => {
    const src = readFileSync(join(ROOT, 'projections', 'render', 'client.ts'), 'utf8')
    const body = src.slice(src.indexOf('export const CLIENT_JS'))
    const offenders: string[] = []
    if (/\.toFixed\s*\(/.test(body)) offenders.push('client.ts: toFixed()')
    if (/\.toLocaleString\s*\(/.test(body)) offenders.push('client.ts: toLocaleString()')
    if (/Intl\./.test(body)) offenders.push('client.ts: Intl')
    expect(offenders, 'the browser may swap in HTML, not produce it').toEqual([])
  })

  /**
   * The chart drawer may format already-numeric series for axes and the tooltip. It still
   * must not contain the policy cuts the old page shipped: a win rate at 50, a pop rate at
   * 25, a receipt rate at 99, a kept bar at 0.7 / 0.3, a pause line compared to -1.
   */
  it('the chart drawer holds no policy cut', () => {
    const src = readFileSync(join(ROOT, 'projections', 'render', 'charts-client.ts'), 'utf8')
    const body = src.slice(src.indexOf('export const CHART_JS'))
    const offenders: string[] = []
    if (/>=\s*50\b/.test(body)) offenders.push('win-rate cut 50')
    if (/>=\s*25\b/.test(body)) offenders.push('pop-rate cut 25')
    if (/>=\s*99\b/.test(body)) offenders.push('receipt cut 99')
    if (/>=\s*0\.7\b/.test(body)) offenders.push('kept-good 0.7')
    if (/>=\s*0\.3\b/.test(body)) offenders.push('kept-warn 0.3')
    if (/={2,3}\s*-1\b/.test(body)) offenders.push('pause compared to -1')
    expect(offenders, 'stroke, rules and decimals belong on the payload').toEqual([])
  })
})
