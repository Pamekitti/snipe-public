// Read-only endpoint probes. Never print configured URLs, keys or request headers.
import 'dotenv/config'
import Database from 'better-sqlite3'
const redact = value => String(value).replace(/(?:https?|wss?):\/\/\S+/gi, '[endpoint]').slice(0, 350)
const publicUrl = 'https://rpc.mainnet.chain.robinhood.com'
const candidates = [
  ['provider', process.env.RPC_KEY_URL || (process.env.LOGS_WS_URL || '').replace(/^wss:\/\//, 'https://')],
  ['configured-public', process.env.RPC_URL],
  ['public', publicUrl],
]
const seen = new Set(), probes = []
for (const [label, url] of candidates) {
  if (!url || seen.has(url)) continue
  seen.add(url)
  for (const [method, params] of [['eth_blockNumber', []], ['eth_getBlockByNumber', ['latest', false]],
    ['eth_getLogs', [{fromBlock:'latest',toBlock:'latest'}]]]) {
    const started = Date.now()
    try {
      const response = await fetch(url, { method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({jsonrpc:'2.0',id:1,method,params}), signal: AbortSignal.timeout(5000) })
      const body = await response.json()
      probes.push({label,host:new URL(url).hostname,method,status:response.status,ms:Date.now()-started,
        error:body.error ? {code:body.error.code,message:redact(body.error.message)} : null,
        result:method==='eth_blockNumber'?body.result:method==='eth_getLogs'?{count:body.result?.length}:body.result?{number:body.result.number,hash:body.result.hash,timestamp:body.result.timestamp}:null})
    } catch (e) { probes.push({label,method,ms:Date.now()-started,error:redact(e.message)}) }
  }
}
const state = await (await fetch('http://localhost:8787/api/state')).json()
const db = new Database(process.env.DB_FILE?.replace(/\.db$/,'.simulation.db') || 'data/bot.simulation.db',{readonly:true,fileMustExist:true})
const processor=db.prepare("SELECT value FROM checkpoints WHERE name='processor'").get()
const latest=db.prepare("SELECT at,payload FROM captures WHERE kind='opportunity' ORDER BY at DESC LIMIT 1").get()
const capture=latest?JSON.parse(latest.payload):null
console.log(JSON.stringify({at:new Date().toISOString(),probes,processor:processor?JSON.parse(processor.value):null,
  state:{at:state.at,config:state.config,activeGuard:state.activeGuard,risk:state.risk,plumbing:state.plumbing,captureHealth:state.captureHealth},
  capture: capture?{at:latest.at,config:capture.config,takeProfit:capture.takeProfit,selectorReady:capture.selector?.complete,
    selectorFailure:capture.selector?.failure,haltKinds:capture.haltKinds}:null},null,2))
db.close()
