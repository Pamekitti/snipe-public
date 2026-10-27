/**
 * The architecture diagram, checked against the code.
 *
 * WHY THIS TEST EXISTS. A diagram nobody checks is wrong within a week, and in this repo that
 * is not a theory: the old CLAUDE.md said "no silent killers" during the same week a silent
 * killer stopped the measurement pipeline for 20 minutes, and `levels.ts` opened with "a
 * threshold lives here" while nineteen of its twenty thresholds sat inline elsewhere. Both
 * were sincere. Neither was enforced.
 *
 * So the rule is: documentation that describes a closed set gets a test, or it does not get
 * written. Adding an event kind or a refusal bucket now fails the build until it is drawn.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REFUSAL_BUCKETS } from '../core/contracts.js'
import { EVENT_CLASS, EVENT_KINDS } from '../core/events.js'

const DOC = readFileSync(fileURLToPath(new URL('../docs/architecture.md', import.meta.url)), 'utf8')

/** The mermaid blocks, in document order: [0] is the flow, [1] is the decision order. */
function mermaidBlocks(md: string): string[] {
  const out: string[] = []
  const re = /```mermaid\n([\s\S]*?)```/g
  for (let m = re.exec(md); m; m = re.exec(md)) out.push(m[1]!)
  return out
}

const blocks = mermaidBlocks(DOC)

describe('the architecture document', () => {
  it('has exactly the two diagrams the tests below assume', () => {
    expect(blocks).toHaveLength(2)
  })
})

describe('diagram 1: events in, intents out', () => {
  const flow = blocks[0] ?? ''

  it('draws every event kind', () => {
    const missing = EVENT_KINDS.filter((k) => !flow.includes(k))
    expect(missing, 'these event kinds exist in code and are not on the flow diagram').toEqual([])
  })

  it('names no event kind that does not exist', () => {
    // Anything in the edge labels that looks like a kind but is not one. Edge labels are where
    // kinds are named, so this is where a stale name would survive unnoticed.
    const labelled = new Set<string>()
    const re = /\|([^|]+)\|/g
    for (let m = re.exec(flow); m; m = re.exec(flow)) {
      for (const part of m[1]!.split(',')) {
        const t = part.trim()
        if (/^[a-z][a-z-]+$/.test(t)) labelled.add(t)
      }
    }
    const known = new Set<string>(EVENT_KINDS)
    // 'no', 'yes' and similar are flow answers, not kinds; only hyphenated names or exact
    // matches are treated as claims about the event union.
    const claims = [...labelled].filter((t) => t.includes('-') || known.has(t))
    expect(claims.filter((t) => !known.has(t)), 'these look like event kinds and are not').toEqual([])
  })

  it('keeps the ban that kills display recomputation visible in the picture', () => {
    // If someone deletes this from the diagram they are probably about to delete it from the
    // ring test too, and the diagram is where a human would notice.
    expect(flow).toMatch(/may NEVER import core\/decide/)
  })

  it('states that core has no clock and no dependencies', () => {
    expect(flow).toMatch(/No node:, no npm, no clock/)
    expect(flow).toMatch(/THE ONLY CLOCK/)
  })
})

describe('diagram 2: what refuses a trade', () => {
  const decisions = blocks[1] ?? ''

  it('draws every refusal bucket', () => {
    const missing = REFUSAL_BUCKETS.filter((b) => !decisions.includes(b))
    expect(missing, 'these buckets exist in code and are not on the decision diagram').toEqual([])
  })

  it('names no bucket that does not exist', () => {
    // Node labels of the shape ["some-bucket"], which is how buckets are drawn.
    const drawn = new Set<string>()
    const re = /\["([a-z][a-z-]+)"\]/g
    for (let m = re.exec(decisions); m; m = re.exec(decisions)) drawn.add(m[1]!)
    const known = new Set<string>(REFUSAL_BUCKETS)
    const claims = [...drawn].filter((t) => t.includes('-'))
    expect(claims.filter((t) => !known.has(t)), 'these look like buckets and are not').toEqual([])
  })

  it('puts the screen before the trading filter, which is what makes the funnel mean anything', () => {
    // The screen defines the universe every sensor measures on, so it must run on launches
    // the bot will never buy. If it moved after the filter the gate would only ever see the
    // bot's own choices, which is the confound that made the old venue sensor unreadable.
    expect(decisions.indexOf('screen-pair')).toBeLessThan(decisions.indexOf('entry-tax'))
    expect(decisions.indexOf('entry-tax')).toBeLessThan(decisions.indexOf('risk-halted'))
    expect(decisions.indexOf('risk-halted')).toBeLessThan(decisions.indexOf('guard-pumped'))
  })

  it('puts the graduation guard last, because it is the only check that costs two simulations', () => {
    for (const cheaper of ['screen-pair', 'entry-exempt', 'risk-capacity', 'risk-bankroll'] as const) {
      expect(decisions.indexOf(cheaper), `${cheaper} should be refused before the simulations run`)
        .toBeLessThan(decisions.indexOf('guard-pumped'))
    }
  })
})

describe('the event classes', () => {
  it('classify every kind, so a new kind must declare who caused it', () => {
    expect(Object.keys(EVENT_CLASS).sort()).toEqual([...EVENT_KINDS].sort())
  })

  it('agree with the tape: only the driver writes effects', () => {
    const effects = EVENT_KINDS.filter((k) => EVENT_CLASS[k] === 'effect')
    expect(effects).toEqual(['nonce', 'tx-signed', 'tx-send-result'])
  })
})
