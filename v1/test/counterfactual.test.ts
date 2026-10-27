import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { replay } from '../src/strategy/counterfactual.js'

const fixture = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/replay-before-extraction.json.gz', import.meta.url))).toString())
const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v))
describe('shared counterfactual engine', () => {
  it('preserves the pre-extraction outputs for 144 independently captured requests', () => {
    for (const c of fixture.cases) expect(json(replay(c.request))).toEqual(c.expected)
  })
  it('refuses a path with a missing timestamp', () => {
    const request = structuredClone(fixture.cases[0].request)
    request.blocks = {}
    expect(replay(request).status).toBe('missing_block_time')
  })
  it('deduplicates repeated stream events without changing execution', () => {
    const request = structuredClone(fixture.cases[0].request)
    expect(json(replay({ ...request, logs: [...request.logs, ...request.logs] }))).toEqual(json(replay(request)))
  })
  it('excludes the configured wallet orders before simulating external flow', () => {
    const request = structuredClone(fixture.cases[0].request)
    const event = request.logs.find((l: any) => l.topics.length > 1)
    expect(event).toBeDefined()
    const wallet = '0x'+event.topics[1].slice(-40)
    const filtered = request.logs.filter((l: any) => !l.topics.slice(1,3).some((t: string) => t.slice(-40).toLowerCase() === wallet.slice(2).toLowerCase()))
    expect(filtered.length).toBeLessThan(request.logs.length)
    expect(json(replay({ ...request, wallet }))).toEqual(json(replay({ ...request, wallet:'', logs:filtered })))
  })
})
