/**
 * The gate.db test fixture, matching the schema gatewatch.py's open_gate_db() owns in
 * production. Eight fixtures across five suites used to carry their own copy of this
 * DDL, so a gatewatch schema change meant eight hand-edits or a suite that silently
 * tested yesterday's shape. The DATA stays with each test -- only the shape lives here.
 */
import Database from 'better-sqlite3'

export type ObsRow = {
  token: string
  curve?: string
  block: number
  /** SECONDS, matching gatewatch (obs.at is the ms one) */
  launched_at?: number | null
  peak?: number | null
  touch?: number
  at?: number
  error?: string | null
  /** JSON of mult-1 per bar, {"1.36":0.05,...}; NULL on rows scored before 2026-09-05 */
  bars?: string | null
  /** the launch's creator tax (bps) and exempt-wallet count, written to the BOOK db when
   *  one is attached; absent means a buyable coin (100 bps, 3 wallets) */
  tax?: number | null
  ex?: number | null
}

/**
 * `bookFile`: a stub of bot.db holding only the launches columns the P&L sensor joins on,
 * for suites that drive RegimeGate directly. Never point it at a bot.db the Bot itself
 * will open: Telemetry's CREATE TABLE IF NOT EXISTS would find the stub and skip the real
 * schema. Bot-level suites write launches through the Bot's own database instead.
 */
export function makeGateDb(file: string, bookFile?: string) {
  const db = new Database(file)
  db.exec(`CREATE TABLE obs (token TEXT PRIMARY KEY, curve TEXT, block INTEGER,
           launched_at INTEGER, peak REAL, touch INTEGER, at INTEGER, error TEXT, bars TEXT);
           CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)`)
  const oi = db.prepare('INSERT INTO obs VALUES (?,?,?,?,?,?,?,?,?)')
  const si = db.prepare('INSERT INTO state VALUES (?,?)')
  const book = bookFile ? new Database(bookFile) : null
  book?.exec('CREATE TABLE IF NOT EXISTS launches (token TEXT PRIMARY KEY, creator_tax_bps INTEGER, exemptions INTEGER)')
  const li = book?.prepare('INSERT OR REPLACE INTO launches VALUES (?,?,?)')
  return {
    db,
    // defaults apply only when a key is ABSENT: an explicit null is data (an unscorable
    // row, a launch with no timestamp) and must reach the database as null
    obs: (r: ObsRow) => {
      oi.run(r.token, r.curve ?? r.token, r.block,
        'launched_at' in r ? r.launched_at : 0,
        'peak' in r ? r.peak : 1.0,
        r.touch ?? 0, r.at ?? 0, r.error ?? null, r.bars ?? null)
      li?.run(r.token, 'tax' in r ? r.tax : 100, 'ex' in r ? r.ex : 3)
    },
    state: (key: string, value: string) => si.run(key, value),
    close: () => { db.close(); book?.close() },
  }
}
