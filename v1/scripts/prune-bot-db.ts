/**
 * Clear the bot.db retention backlog in one pass, for the years of rows the live hourly sweep
 * would take days to reach. Run it with the bot STOPPED, then VACUUM to give the pages back.
 *
 *   node --import tsx scripts/prune-bot-db.ts data/bot.db [liveConfigId]
 *
 * The live config id defaults to the config of the newest shadow job, which is the one
 * scripts/verify-shadow.ts certifies. Its request and result columns are never touched.
 */
import { openCoverageDb } from '../src/strategy/shadow-coverage.js'
import { runRetention } from '../src/strategy/bot-db-retention.js'

const file = process.argv[2]
if (!file) { console.error('usage: prune-bot-db.ts <bot.db> [liveConfigId]'); process.exit(2) }
const db = openCoverageDb(file)
db.pragma('busy_timeout = 30000')

const live = process.argv[3]
  ?? (db.prepare('SELECT config FROM shadow_jobs ORDER BY entry DESC LIMIT 1').get() as { config: string } | undefined)?.config
  ?? ''
if (!live) { console.error('no shadow_jobs rows: pass the live config id explicitly'); process.exit(2) }
console.log(`live config (never archived): ${live}`)

const size = (t: string, cols: string) =>
  (db.prepare(`SELECT COUNT(*) n,COALESCE(SUM(${cols}),0) b FROM ${t}`).get() as { n: number; b: number })
const show = (label: string, r: { n: number; b: number }) =>
  console.log(`  ${label.padEnd(20)} ${r.n.toLocaleString().padStart(10)} rows  ${(r.b / 1e6).toFixed(1)} MB`)

const tables: Array<[string, string]> = [
  ['shadow_source_logs', 'LENGTH(json)'],
  ['shadow_jobs', "LENGTH(COALESCE(request,''))+LENGTH(COALESCE(result,''))"],
  ['shadow_decisions', 'LENGTH(reading)+LENGTH(checkpoint)'],
  ['health', "LENGTH(COALESCE(detail,''))"],
  ['execution_guard_decisions', "LENGTH(COALESCE(checkpoint,''))"],
]
console.log('before:')
for (const [t, c] of tables) { try { show(t, size(t, c)) } catch { console.log(`  ${t}: absent`) } }

const now = Date.now()
const report = await runRetention(db, { now, liveConfig: live, budgetMs: 10 * 60_000 })
// Not part of the hourly sweep's scope: health lives on the Telemetry handle and the guard
// decisions trim themselves on the next write. Both are cheap to finish here.
const health = db.prepare('DELETE FROM health WHERE at<?').run(now - 8 * 86_400_000).changes
const guard = db.prepare('DELETE FROM execution_guard_decisions WHERE at<?').run(now - 8 * 86_400_000).changes
// GROUP BY includes the book: without it this keeps ONE newest checkpoint across both books
// and blanks the other, which is exactly the row the surviving book reads back at startup.
const stale = db.prepare(`UPDATE execution_guard_decisions SET checkpoint='' WHERE checkpoint<>'' AND id NOT IN
  (SELECT MAX(id) FROM execution_guard_decisions GROUP BY model,policy,COALESCE(book,'main'))`).run().changes

console.log(`\nsource logs deleted: ${report.sourceLogs.toLocaleString()}`)
console.log(`jobs archived:       ${report.jobs.toLocaleString()}`)
console.log(`decisions deleted:   ${report.decisions.toLocaleString()}`)
console.log(`health deleted:      ${health.toLocaleString()}`)
console.log(`guard rows deleted:  ${guard.toLocaleString()}  checkpoints blanked: ${stale.toLocaleString()}`)
console.log(`busy skips:          ${report.skipped}`)

console.log('\nafter:')
for (const [t, c] of tables) { try { show(t, size(t, c)) } catch { console.log(`  ${t}: absent`) } }
console.log('\nnow VACUUM to release the pages: node -e "require(\'better-sqlite3\')(\'' + file + '\').exec(\'VACUUM\')"')
db.close()
