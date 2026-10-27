import { expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { resourceAlerts, resourceLevel, parseVmRss, diskFree, memTotal } from '../src/telemetry/resources.js'
import { diskWarnFreePct, diskCritFreePct, memoryWarnProcessBytes } from '../src/telemetry/levels.js'

const GB = 1e9
const reading = (over: any = {}) => ({ at: 1, path: '/data', disk: null, memTotalBytes: 2 * GB,
  rss: { main: null, simulation: null, shadow: null }, ...over })
const ids = (r: any) => resourceAlerts(r).map(a => a.id + ':' + a.sev)
const withFree = (pct: number) => reading({ disk: { freeBytes: 20 * GB * pct / 100, totalBytes: 20 * GB } })

it('warns and crits on free disk at the documented thresholds', () => {
  expect(ids(withFree(diskWarnFreePct + 0.1))).toEqual([])
  expect(ids(withFree(diskWarnFreePct - 0.1))).toEqual(['disk:warn'])
  expect(ids(withFree(diskCritFreePct - 0.1))).toEqual(['disk:crit'])
  expect(resourceAlerts(withFree(1))[0]!.msg).toContain('/data')
})

it('warns on one fat process and crits when the set threatens the machine', () => {
  const rss = (main: number, sim = 0, shadow = 0) => reading({ rss: { main, simulation: sim, shadow } })
  expect(ids(rss(memoryWarnProcessBytes - 1))).toEqual([])
  expect(ids(rss(memoryWarnProcessBytes))).toEqual(['memory:warn'])
  expect(ids(rss(0.5 * GB, 1.0 * GB))).toEqual(['memory:warn'])   // 75% of 2 GB
  expect(ids(rss(0.9 * GB, 1.0 * GB))).toEqual(['memory:crit'])   // 95% of 2 GB
  expect(resourceAlerts(rss(0.9 * GB, 1.0 * GB))[0]!.msg).toContain('capture')
})

it('says nothing rather than something wrong when a reading is missing or junk', () => {
  expect(resourceAlerts(null)).toEqual([])
  expect(resourceAlerts(undefined)).toEqual([])
  expect(ids(reading())).toEqual([])
  expect(ids(reading({ disk: { freeBytes: NaN, totalBytes: NaN } }))).toEqual([])
  expect(ids(reading({ disk: { freeBytes: 1, totalBytes: 0 } }))).toEqual([])
  expect(ids(reading({ rss: { main: NaN, simulation: null, shadow: undefined } }))).toEqual([])
  // No MemTotal: the per-process rung still works, the fraction rungs cannot fire.
  expect(ids(reading({ memTotalBytes: null, rss: { main: 1.9 * GB, simulation: null, shadow: null } }))).toEqual(['memory:warn'])
  expect(resourceLevel(null)).toBe('ok')
  expect(resourceLevel(withFree(1))).toBe('crit')
})

it('reads the units the kernel actually reports', () => {
  expect(parseVmRss('Name:\tnode\nVmRSS:\t  284672 kB\nThreads:\t11\n')).toBe(284672 * 1024)
  expect(parseVmRss('VmHWM:\t 1 kB\n')).toBeNull()
  expect(parseVmRss('')).toBeNull()
})

it('reads the real filesystem and memory on whatever host runs the suite', () => {
  const disk = diskFree(tmpdir())
  expect(disk).not.toBeNull()
  expect(disk!.totalBytes).toBeGreaterThan(0)
  expect(disk!.freeBytes).toBeGreaterThanOrEqual(0)
  expect(disk!.freeBytes).toBeLessThanOrEqual(disk!.totalBytes)
  expect(diskFree('/no/such/path/anywhere')).toBeNull()
  expect(memTotal()).toBeGreaterThan(0)
})
