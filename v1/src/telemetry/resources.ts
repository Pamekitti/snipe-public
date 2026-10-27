import { statfsSync, readFileSync } from 'node:fs'
import { totalmem } from 'node:os'
import * as LEVELS from './levels.js'
/**
 * What the machine has left. Disk and memory, sampled locally, nothing over the network.
 *
 * On 2026-09-13 the box ran a 43 s query on a 5 s timer for seven hours. Load sat at 2.8, the
 * disk read 249 GB, the page cache thrashed, and the bot's own event loop stretched its 60 s
 * heartbeat to 115 s until the dashboard stopped answering. Every signal that would have
 * named it was already being measured except two: how full the disk was (78%, on a database
 * growing 2.2 GB a day) and how much memory the three node processes held (760 MB of 1.8 GB,
 * no swap). Event-loop lag was already alerted on and is left where it is.
 *
 * Pure and side-effect free: the bot samples, the dashboard decides. Every reader returns
 * null rather than throwing, because a watchdog that can crash the process it watches is
 * worse than no watchdog.
 */

export type DiskReading = { freeBytes: number; totalBytes: number }
export type ResourceReading = {
  at: number
  path: string
  disk: DiskReading | null
  memTotalBytes: number | null
  rss: { main: number | null; simulation: number | null; shadow: number | null }
}
type Alert = { id: string; sev: 'crit' | 'warn'; msg: string }

/** Free space a non-root process can actually use, which is `bavail`, not `bfree`. */
export function diskFree(path: string): DiskReading | null {
  try {
    const s = statfsSync(path)
    const bsize = Number(s.bsize), avail = Number(s.bavail), blocks = Number(s.blocks)
    if (!Number.isFinite(bsize) || !Number.isFinite(avail) || !Number.isFinite(blocks)) return null
    return { freeBytes: avail * bsize, totalBytes: blocks * bsize }
  } catch { return null }
}

/** VmRSS is reported in kB. Exported so the parse is testable off Linux. */
export function parseVmRss(status: string): number | null {
  const m = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
  return m ? Number(m[1]) * 1024 : null
}

export function rssOf(pid: number | null | undefined): number | null {
  if (!pid || !Number.isFinite(pid)) return null
  try { return parseVmRss(readFileSync(`/proc/${pid}/status`, 'utf8')) } catch { return null }
}

export function memTotal(): number | null {
  try {
    const m = /^MemTotal:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'))
    if (m) return Number(m[1]) * 1024
  } catch { /* not linux */ }
  const t = totalmem()
  return Number.isFinite(t) && t > 0 ? t : null
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const gb = (bytes: number) => (bytes / 1e9).toFixed(1) + ' GB'
const mb = (bytes: number) => (bytes / 1e6).toFixed(0) + ' MB'

/** Every tracked process that reported a size, largest first. */
function processes(r: ResourceReading): Array<{ name: string; bytes: number }> {
  return [
    { name: 'bot', bytes: r.rss?.main },
    { name: 'capture', bytes: r.rss?.simulation },
    { name: 'shadow', bytes: r.rss?.shadow },
  ].filter((p): p is { name: string; bytes: number } => finite(p.bytes)).sort((a, b) => b.bytes - a.bytes)
}

export function resourceAlerts(r: ResourceReading | null | undefined): Alert[] {
  const out: Alert[] = []
  if (!r) return out

  if (r.disk && finite(r.disk.freeBytes) && finite(r.disk.totalBytes) && r.disk.totalBytes > 0) {
    const pct = (r.disk.freeBytes / r.disk.totalBytes) * 100
    const where = `${pct.toFixed(0)}% free (${gb(r.disk.freeBytes)} of ${gb(r.disk.totalBytes)}) on ${r.path}`
    if (pct < LEVELS.diskCritFreePct) out.push({ id: 'disk', sev: 'crit', msg: `disk ${where}: sqlite writes fail when it fills, and the book is a sqlite write` })
    else if (pct < LEVELS.diskWarnFreePct) out.push({ id: 'disk', sev: 'warn', msg: `disk ${where}` })
  }

  const procs = processes(r)
  if (procs.length) {
    const sum = procs.reduce((n, p) => n + p.bytes, 0)
    const detail = procs.map(p => `${p.name} ${mb(p.bytes)}`).join(', ')
    const total = finite(r.memTotalBytes) && r.memTotalBytes > 0 ? r.memTotalBytes : null
    const frac = total ? sum / total : null
    if (frac !== null && frac >= LEVELS.memoryCritFraction) {
      out.push({ id: 'memory', sev: 'crit', msg: `memory ${(frac * 100).toFixed(0)}% of ${gb(total!)} held by ${detail}: the OOM killer takes the bot, not the worker` })
    } else if (frac !== null && frac >= LEVELS.memoryWarnFraction) {
      out.push({ id: 'memory', sev: 'warn', msg: `memory ${(frac * 100).toFixed(0)}% of ${gb(total!)} held by ${detail}` })
    } else if (procs[0]!.bytes >= LEVELS.memoryWarnProcessBytes) {
      out.push({ id: 'memory', sev: 'warn', msg: `memory: ${procs[0]!.name} holds ${mb(procs[0]!.bytes)} (${detail})` })
    }
  }
  return out
}

/** One word for the health log, so a row is written on a transition rather than every poll. */
export function resourceLevel(r: ResourceReading | null | undefined): 'ok' | 'warn' | 'crit' {
  const alerts = resourceAlerts(r)
  return alerts.some(a => a.sev === 'crit') ? 'crit' : alerts.length ? 'warn' : 'ok'
}

export function resourceDetail(r: ResourceReading | null | undefined): string {
  const alerts = resourceAlerts(r)
  return alerts.length ? alerts.map(a => a.msg).join('; ') : 'disk and memory within limits'
}
