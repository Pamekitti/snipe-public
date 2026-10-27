import { expect, it } from 'vitest'
import { ArrivalRing, promoteArrivals, arrivalMap, ARRIVAL_PROMOTE_MS } from '../src/simulation/arrivals.js'

const CURVE = '0xAbCdEf0000000000000000000000000000000001'

it('keeps only the horizon and forgets the rest', () => {
  const ring = new ArrivalRing(1000)
  ring.push(CURVE, '0xtx1', 0, 1000)
  ring.push(CURVE, '0xtx2', 0, 1500)
  expect(ring.size).toBe(2)
  ring.push(CURVE, '0xtx3', 0, 2600)
  // 1000 and 1500 are both older than 2600 - 1000, so only the newest survives.
  expect(ring.size).toBe(1)
  expect(ring.window(CURVE, 0, 3000).map(a => a[0])).toEqual(['0xtx3'])
})

it('records the earliest arrival per log and ignores case in the address', () => {
  const ring = new ArrivalRing()
  ring.push(CURVE, '0xtx', 3, 5000)
  ring.push(CURVE.toLowerCase(), '0xtx', 3, 5200)   // a backfill redelivering the same log
  ring.push(CURVE, '0xtx', 4, 5100)
  ring.push('0xother', '0xtx', 3, 4000)
  const window = ring.window(CURVE.toUpperCase(), 0, 9999)
  expect(window).toEqual([['0xtx', 3, 5000], ['0xtx', 4, 5100]])
})

it('clips the promoted slice to the window and reports what it covered', () => {
  const ring = new ArrivalRing()
  ring.push(CURVE, '0xearly', 0, 500)
  ring.push(CURVE, '0xinside', 0, 1500)
  ring.push(CURVE, '0xlate', 0, 9000)
  const payload = promoteArrivals(ring, CURVE, 1000, 2000, false)
  expect(payload.n).toBe(1)
  expect(payload.arrivals).toEqual([['0xinside', 0, 1500]])
  expect(payload).toMatchObject({ version: 1, curve: CURVE, from: 1000, through: 2000, partial: false })
})

it('rebuilds the replay lookup and survives a payload it cannot read', () => {
  const ring = new ArrivalRing()
  ring.push(CURVE, '0xtx', 7, 1234)
  const map = arrivalMap(promoteArrivals(ring, CURVE, 0, 9999, false))
  expect(map.get('0xtx:7')).toBe(1234)
  expect(arrivalMap(null).size).toBe(0)
  expect(arrivalMap({ version: 2 } as any).size).toBe(0)
  expect(arrivalMap({ version: 1, arrivals: [['0xa', NaN, 1], 'junk'] } as any).size).toBe(0)
})

it('promotes before the replay becomes eligible for the job', () => {
  // processor.ts only picks up an opportunity captured more than 190s ago. The promotion has
  // to have landed by then or every arrival is modeled.
  expect(ARRIVAL_PROMOTE_MS).toBeLessThan(190_000)
})
