/** Repair missed paper intents after the collector switch outage. No transaction sends. */
import Database from 'better-sqlite3'
import { readCurve } from '../src/recovery.js'
import { ShadowAccount, encodeShadow, type ShadowIntent } from '../src/strategy/shadow-account.js'
import { adaptiveTakeProfit } from '../src/strategy/takeprofit.js'

const [file, gateFile] = process.argv.slice(2)
if (!file || !gateFile) throw new Error('usage: repair-paper-capture.ts BOT_DB GATE_DB')
const db = new Database(file)
db.pragma('busy_timeout = 5000')
const gate = new Database(gateFile, { readonly: true })
const account = new ShadowAccount(db)
const last = db.prepare('SELECT intent FROM shadow_jobs ORDER BY entry DESC LIMIT 1').get() as {intent:string}|undefined
if (!last) throw new Error('No preceding captured policy')
const base: ShadowIntent = JSON.parse(last.intent)
// Preserve this boundary across retries, including partial RPC failures.
const saved = db.prepare("SELECT value FROM shadow_meta WHERE key='capture_repair_from'").get() as {value:string}|undefined
const from = saved ? Number(saved.value) : base.entry
db.prepare('INSERT OR IGNORE INTO shadow_meta VALUES (?,?)').run('capture_repair_from', String(from))
const through = Date.now()
const changes = JSON.parse((db.prepare("SELECT value FROM chain_truth WHERE key='filter_changes'").get() as any)?.value ?? '[]')
if (changes.some((r:any) => r.at > from && /TRADE_SIZE|BANKROLL|ENTRY_|PROBE|deadCoin|takeProfit/.test(r.change ?? '')))
  throw new Error('Policy changed inside capture gap; split the repair by policy first')
const rows = db.prepare(`SELECT l.*,p.t_decide,p.take_profit FROM launches l
  LEFT JOIN positions p ON p.token=l.token AND p.live=1
  WHERE l.launched_at*1000>? AND l.detected_at<=? AND l.passed=1
    AND l.creator_tax_bps>=? AND l.exemptions>=?
    AND NOT EXISTS(SELECT 1 FROM shadow_jobs s WHERE s.token=l.token)
  ORDER BY l.launched_at,l.block`).all(from,through,base.config.entry.minCreatorTaxBps,base.config.entry.minExemptionsToEnter) as any[]
// Backup before the first repair mutation of captured jobs or the fault latch.
const backup = `${file}.paper-repair-${through}.bak`
await db.backup(backup)
let added=0
for (const l of rows) {
  const entry = l.t_decide ?? Math.max(l.detected_at, l.launched_at*1000+2000)
  const preceding = gate.prepare('SELECT bars FROM obs WHERE at<? AND error IS NULL AND bars IS NOT NULL ORDER BY block DESC LIMIT 20')
    .all(entry).map((r:any)=>JSON.parse(r.bars))
  const adaptive = (base.config.targetPolicy as any).adaptive
  const chosen = adaptiveTakeProfit(preceding, adaptive.window, adaptive.bars, (base.config.targetPolicy as any).otherwise)
  const {params} = await readCurve(l.curve)
  if (Number(params.launchedAt)!==l.launched_at || Number(params.creatorTaxBps)!==l.creator_tax_bps)
    throw new Error(`Immutable launch parameters disagree: ${l.token}`)
  const intent = {...base,token:l.token,curve:l.curve,block:l.block,launched:l.launched_at*1000,entry,
    params:Object.fromEntries(Object.entries(params).map(([k,v])=>[k,String(v)])),
    exemptions:l.exemptions,devBuyWei:l.dev_buy_wei,tp:l.take_profit??chosen.multiple,
    targetReason:'historical capture repair',selector:{rows:preceding,at:entry},
    calibration:account.calibrate(entry),
    captureRepair:{at:through,timing:l.t_decide?'recorded decision':'later of detection and launch plus 2s',prospective:false}}
  account.enqueue(intent)
  added++
  console.log(`captured ${added}/${rows.length}: ${l.token}`)
}
db.transaction(()=>{
  const fault=(db.prepare("SELECT value FROM shadow_meta WHERE key='source_fault'").get() as any)?.value
  // Only repair this known missing-capture fault. Hash/source failures remain latched.
  if (fault && /^uncaptured launch 0x[0-9a-f]+ during stream gap /.test(fault)) {
    db.prepare('INSERT OR REPLACE INTO shadow_meta VALUES (?,?)').run('capture_repair_fault',fault)
    db.prepare("DELETE FROM shadow_meta WHERE key='source_fault'").run()
  }
  db.prepare('INSERT OR REPLACE INTO shadow_meta VALUES (?,?)').run('capture_repair',encodeShadow({from,through,added,backup,prospective:false}))
  // Historical repairs are not fresh prospective evidence authorizing real entries.
  db.prepare("DELETE FROM shadow_meta WHERE key LIKE 'verified:%'").run()
})()
console.log(encodeShadow({added,from,through,backup,verification:'requires renewed prospective verification'}))
gate.close();db.close()
