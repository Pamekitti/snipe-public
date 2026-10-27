/**
 * Open a new accounting epoch by hand: both drawdown stops start from zero.
 *
 *   npm run newepoch -- "why"        then, if the bot is running:  pm2 restart compute-1
 *
 * The restart is required for a HAND reset: the bot holds epochBaseId in memory from boot.
 * It is not done here because moving accounting state and restarting the trading process
 * are two decisions (the same rule as deploy.sh). The bot's own automatic reset, when the
 * drawdown stop lifts itself, needs no restart because it moves the in-memory value too.
 *
 * The transaction, its guards and its audit row live in src/telemetry/epoch.ts, which the
 * bot also calls. This file is the command line and nothing else.
 */
import Database from 'better-sqlite3'
import { newEpoch } from '../src/telemetry/epoch.js'

const why = process.argv.slice(2).join(' ')
const db = new Database(process.env.DB_FILE ?? 'data/bot.db')
try {
  const r = newEpoch(db, why)
  console.log(`epoch_base_id ${r.was} -> ${r.now}; chain baseline and peak cleared (re-recorded at the next flat sample)`)
  console.log('now restart the bot:  pm2 restart compute-1')
} catch (e) {
  console.error(String((e as Error).message ?? e))
  process.exit(1)
}
