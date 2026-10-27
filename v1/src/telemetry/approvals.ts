/** Durable approval attempts. Persist the hash before broadcasting the signed bytes. */
import type Database from 'better-sqlite3'

export function ensureApprovalSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS approval_transactions (
    hash TEXT PRIMARY KEY, position_id INTEGER NOT NULL, nonce TEXT,
    at INTEGER NOT NULL, rejected INTEGER NOT NULL DEFAULT 0, gas_wei TEXT
  ); CREATE INDEX IF NOT EXISTS idx_approval_position ON approval_transactions(position_id)`)
  const cols = db.prepare('PRAGMA table_info(positions)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'approval_gas_wei')) {
    db.exec('ALTER TABLE positions ADD COLUMN approval_gas_wei TEXT')
  }
}

export function recordApproval(db: Database.Database, id: number, hash: string, nonce: number, now = Date.now()): void {
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO approval_transactions(hash,position_id,nonce,at) VALUES (?,?,?,?)')
      .run(hash, id, String(nonce), now)
    db.prepare(`UPDATE positions SET approval_gas_wei=NULL,
      onchain_pnl_wei=CASE WHEN closed=1 THEN NULL ELSE onchain_pnl_wei END WHERE id=?`).run(id)
  })()
}

export function rejectApproval(db: Database.Database, hash: string): void {
  db.prepare("UPDATE approval_transactions SET rejected=1, gas_wei='0' WHERE hash=?").run(hash)
}
