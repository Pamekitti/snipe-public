import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { RawLog } from '../core/events.js'

export type FilterMode = 'off' | 'compare' | 'live'
const key = (l: RawLog) => `${l.blockHash.toLowerCase()}:${l.logIndex}`
const fingerprint = (l: RawLog) => JSON.stringify([l.address.toLowerCase(), l.topics.map(t => t.toLowerCase()), l.data.toLowerCase(), l.transactionHash.toLowerCase(), l.blockNumber, l.transactionIndex])

/** Filter delivery is tentative. Only independent range reads prove coverage. */
export class LogFilter {
  private id: string | null = null
  private started = 0
  private candidates = new Map<string, RawLog>()
  disabledReason: string | null = null
  repairs = 0
  polls = 0
  checked = 0
  private lastAudit = 0
  private cycles = 0
  private paidUnits = 0
  constructor(private readonly opts: {
    request: (method: string, params: unknown[], comparison: boolean) => Promise<any>
    topics: readonly string[]
    normalize: (raw: any) => RawLog
    path?: string
    now?: () => number
  }) {
    if (opts.path && existsSync(opts.path)) {
      try { this.disabledReason = JSON.parse(readFileSync(opts.path, 'utf8')).disabledReason ?? null }
      catch { this.disabledReason = 'filter state could not be read' }
    }
  }
  auditDue(): boolean { return this.id === null || this.now() - this.lastAudit >= 2_000 }
  cycle(): void {
    if (this.cycles >= 120 && this.paidUnits >= this.cycles * 70) this.disable('filter verification provides no compute-unit saving')
    this.cycles++
  }
  charge(units: number): void { this.paidUnits += units }
  private now(): number { return this.opts.now?.() ?? Date.now() }
  async poll(cursor: number, comparison: boolean): Promise<RawLog[]> {
    if (this.disabledReason) return []
    if (this.id === null) {
      const id = await this.opts.request('eth_newFilter', [{ fromBlock: `0x${cursor.toString(16)}`, topics: [this.opts.topics] }], comparison)
      if (typeof id !== 'string' || !/^0x[0-9a-f]+$/i.test(id)) throw new Error('invalid filter id')
      this.id = id; this.started = cursor; this.lastAudit = this.now()
    }
    const raw = await this.opts.request('eth_getFilterChanges', [this.id], comparison)
    if (!Array.isArray(raw)) throw new Error('invalid filter response')
    if (raw.some(l => l.removed)) throw new Error('filter returned removed logs')
    const rows: RawLog[] = raw.map(this.opts.normalize)
    rows.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    for (const row of rows) {
      const old = this.candidates.get(key(row))
      if (old && fingerprint(old) !== fingerprint(row)) throw new Error('filter changed an event')
      this.candidates.set(key(row), row)
    }
    if (this.candidates.size > 50_000) throw new Error('filter verification backlog exceeded')
    this.polls++
    return rows
  }
  /** Compare only blocks covered by both reads; newer filter rows wait for the next scan. */
  verify(lo: number, hi: number, rows: readonly RawLog[]): void {
    if (!this.id || this.disabledReason) return
    const from = Math.max(lo, this.started)
    const expected = new Map(rows.filter(l => l.blockNumber >= from && l.blockNumber <= hi).map(l => [key(l), l]))
    for (const [id, row] of expected) {
      const candidate = this.candidates.get(id)
      if (!candidate || fingerprint(candidate) !== fingerprint(row)) {
        this.disable('filter missed or changed a verified event'); return
      }
    }
    for (const [id, row] of this.candidates) if (row.blockNumber <= hi) {
      if (row.blockNumber >= from && !expected.has(id)) { this.disable('filter returned an unverified event'); return }
      this.candidates.delete(id)
    }
    this.started = hi + 1; this.lastAudit = this.now(); this.checked += expected.size
  }
  repair(): void { this.repairs++; this.id = null; this.candidates.clear() }
  disable(reason: string): void {
    this.disabledReason = reason.replace(/(?:https?|wss?):\/\/\S+/gi, '[RPC]').slice(0, 160)
    this.repair()
    if (this.opts.path) {
      try { writeFileSync(`${this.opts.path}.tmp`, JSON.stringify({ disabledReason: this.disabledReason })); renameSync(`${this.opts.path}.tmp`, this.opts.path) }
      catch { /* the in-memory disable still applies */ }
    }
  }
  status() { return { disabledReason: this.disabledReason, repairs: this.repairs, polls: this.polls, checked: this.checked,
    paidUnits: this.paidUnits, equivalentRangeUnits: this.cycles * 70 } }
}
