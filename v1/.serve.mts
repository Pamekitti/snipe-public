import http from 'node:http'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
const SP = process.env.SP!
process.env.GATE_DB = SP + '/live/data/gate.db'
const db = new Database(SP + '/live/data/bot.db', { readonly: true })
const bot: any = { tel: { raw: () => db } }
const { chartSnapshot, recentExits } = await import('./src/telemetry/dashboard.js')
const { dashboardHtml } = await import('./src/telemetry/dashboard-page.js')
const state = JSON.parse(readFileSync(SP + '/state.json', 'utf8'))

http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x')
  try {
    if (u.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      state.gate.dataAgeMs = 151 * 60_000
      // state.json is a captured snapshot from before the recent-exits rewrite, so its
      // recent[] carries the old shape. Rebuilt with the REAL mapping rather than a copy:
      // the copy that used to live here drifted the first time dashboard.ts changed.
      state.recent = recentExits(db)
      delete state.funnel
      return res.end(JSON.stringify(state))
    }
    if (u.pathname === '/api/chart') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(chartSnapshot(bot, u.searchParams.get('h') ?? '4h')))
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(dashboardHtml())
  } catch (e) { res.writeHead(500); res.end(String(e)) }
}).listen(8799, '127.0.0.1', () => console.log('preview up'))
