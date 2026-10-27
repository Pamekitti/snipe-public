/**
 * Merge shadow_coverage in one pass, for the backlog a live hourly run would take days to
 * clear. Run it with the bot STOPPED, then VACUUM to give the pages back to the filesystem.
 *
 *   node --import tsx scripts/coalesce-coverage.ts data/bot.db
 */
import { coalesceCoverage, openCoverageDb } from '../src/strategy/shadow-coverage.js'

const file = process.argv[2]
if (!file) { console.error('usage: coalesce-coverage.ts <bot.db>'); process.exit(2) }
const db = openCoverageDb(file)
db.pragma('busy_timeout = 30000')
const count = () => (db.prepare('SELECT COUNT(*) n FROM shadow_coverage').get() as { n: number }).n
const before = count()
console.log(`shadow_coverage rows before: ${before.toLocaleString()}`)
const report = await coalesceCoverage(db, { minRows: 1 })
const after = count()
console.log(`curves merged: ${report.curves}  skipped (busy): ${report.skipped}`)
console.log(`shadow_coverage rows after:  ${after.toLocaleString()}  (-${(before - after).toLocaleString()})`)
console.log('now VACUUM the database to release the pages: node -e "require(\'better-sqlite3\')(\'' + file + '\').exec(\'VACUUM\')"')
db.close()
