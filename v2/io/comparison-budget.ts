import Database from 'better-sqlite3'
import { CU } from './cu.js'

/** A shared allowance for optional probes. Never used by production recovery. */
export class ComparisonBudget {
  private readonly db: Database.Database
  constructor(path: string, private readonly maximum = 100_000) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > 100_000) throw new Error('invalid comparison allowance')
    this.db = new Database(path)
    this.db.pragma('busy_timeout = 1000')
    this.db.exec('CREATE TABLE IF NOT EXISTS rpc_comparison_budget(id INTEGER PRIMARY KEY CHECK(id=1), used INTEGER NOT NULL, maximum INTEGER NOT NULL)')
    this.db.prepare('INSERT OR IGNORE INTO rpc_comparison_budget VALUES(1,0,?)').run(maximum)
    if (this.status().maximum !== maximum) { this.db.close(); throw new Error('comparison allowance mismatch') }
  }
  claim(methods: readonly string[]): void {
    if (methods.some(m => CU[m] === undefined || CU[m]! > 60)) throw new Error('comparison method is not allowed')
    this.db.transaction(() => {
      const { used, maximum } = this.status()
      if (used + methods.length > maximum) throw new Error('comparison allowance exhausted')
      this.db.prepare('UPDATE rpc_comparison_budget SET used=used+? WHERE id=1').run(methods.length)
    }).immediate()
  }
  status(): { used: number; maximum: number } {
    return this.db.prepare('SELECT used, maximum FROM rpc_comparison_budget WHERE id=1').get() as { used: number; maximum: number }
  }
  close(): void { this.db.close() }
}
