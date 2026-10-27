/**
 * Entrypoint.
 *
 * MODE=observe   watch and score, no key needed, nothing signed
 * MODE=shadow    the full production path, signed but never broadcast  (default)
 * MODE=live      real money. also requires LIVE=1, so it takes two deliberate acts.
 */
import { Bot } from './bot.js'
import { checkVenueParams, recoverOpenPositions } from './recovery.js'
import { STRATEGY, RISK, LIVE } from './config.js'
import { booksBanner } from './strategy/books.js'
import { bootConfigErrors, config, envFilePath, startConfigWatch } from './config/store.js'
import { haltPhase, type HaltPhase } from './strategy/risk.js'
import { acceptance, healthLine } from './telemetry/summary.js'
import { startDashboard } from './telemetry/dashboard.js'

const mode = (process.env.MODE ?? 'shadow') as 'observe' | 'shadow' | 'live'
const requireDevBuy = process.env.REQUIRE_DEV_BUY !== '0'

async function main() {
  console.log(`\n=== pons sniper === mode=${mode} devBuyFilter=${requireDevBuy}`)

  const venue = await checkVenueParams()
  venue.notes.forEach((n) => console.log(`  note: ${n}`))
  if (!venue.ok) {
    console.error('venue check failed, refusing to start')
    process.exit(1)
  }

  // What this process ACTUALLY loaded, printed in every mode. Until now the only banner was
  // the live one, so on 2026-09-06 an operator had no way to tell from the logs that pm2 had
  // fed the process a stale TRADE_SIZE_ETH and the edited .env had been ignored.
  console.log(`  config from ${envFilePath()}`)
  console.log(`  size ${STRATEGY.tradeSizeEth} ETH, bankroll ${STRATEGY.bankrollEth} ETH, max ${STRATEGY.maxConcurrent} concurrent`)
  const stakes = (RISK.maxDrawdownEth / STRATEGY.tradeSizeEth).toFixed(1)
  console.log(`  stop: ${RISK.maxDrawdownEth} ETH from peak (${stakes} stakes, ~$${(RISK.maxDrawdownEth * RISK.ethUsd).toFixed(0)} at $${RISK.ethUsd}/ETH)`)
  // What is actually being traded, and what the per-book stops add up to on the wallet. The
  // second half is the whole content of "the wallet total must be visible": with a stop per
  // book, the number that bounds the loss is the SUM, and it is written nowhere else.
  console.log(`  ${booksBanner()}`)
  // the socket's hours, not a trading window: the bot enters launches around the clock
  console.log(`  socket/key hours ${STRATEGY.wsHours ? `${STRATEGY.wsHours.from}-${STRATEGY.wsHours.to} UTC` : 'always'}`)

  const cfgErrors = bootConfigErrors()
  for (const e of cfgErrors) console.error(`  CONFIG: ${e}`)

  if (mode === 'live') {
    if (!LIVE) {
      console.error('MODE=live needs LIVE=1 as well. two switches, on purpose.')
      process.exit(1)
    }
    // A bad value falls back to the default, and a default trade size nobody chose is a
    // money decision made by a typo. Shadow and observe may run on it; live may not.
    if (cfgErrors.length) {
      console.error('refusing to start live on a config the file could not supply. Fix the values above.')
      process.exit(1)
    }
  }

  // DB_FILE: a watch-only (MODE=observe DASH=0) instance beside the live one must not
  // write the live bot's launches table, which gatewatch scores
  const bot = new Bot({ mode, requireDevBuy, dbFile: process.env.DB_FILE })

  // HALT=1: stop buying, sell what we hold, then sit idle with the dashboard and the
  // truth keeper still up. This is the operator's version of the kill switch and it runs
  // the same path, because the alternative people reach for is pm2 stop, which kills the
  // exit managers and strands the bags.
  if (config().halt) bot.risk.halt('halted by operator (HALT=1)', 'manual')

  // A stop made from the dashboard survives the restart that follows it. Without this a
  // pm2 restart or a box reboot silently puts money back to work, which is the same trap
  // the "HALT=0 does not apply live" rule exists to prevent, arriving by a different door.
  bot.restoreHaltState()

  await bot.start()
  const dash = process.env.DASH === '0' ? null : startDashboard(bot)

  // From here a number moves by editing the file. No restart, and nothing that is already
  // open changes rules under itself. See config/store.ts for the precedence and the refusals.
  const stopConfigWatch = startConfigWatch((r) => bot.onConfigReload(r))

  // anything we were holding when we last stopped is still ours to sell
  if (mode !== 'observe') {
    const held = await recoverOpenPositions(bot.tel, bot.walletAddress as never, mode === 'live' ? 1 : 0)
    if (held.length) {
      console.log(`recovered ${held.length} open position(s) from the last run:`)
      bot.risk.seedEntered(held.map((h) => h.token))
      for (const h of held) {
        if (h.unknown) {
          console.log(`  ${h.token.slice(0, 12)} balance unreadable; left open, will retry next start`)
          continue
        }
        console.log(`  ${h.token.slice(0, 12)} holding ${h.tokens} tokens, allowance ${h.allowance > 0n ? 'set' : 'missing'}`)
        try {
          await bot.resume(h)
        } catch (e) {
          console.error(`  could not resume ${h.token.slice(0, 12)}: ${String(e).slice(0, 90)}`)
          console.error('  it is still open in the database and will be retried next start.')
        }
      }
      console.log('  all resumed positions are queued to exit immediately.')
    }
  }

  // The kill switch stops us buying, it does not stop us selling. Quitting here would
  // kill the exit managers with the process and leave whatever we hold unsold, which is
  // the one failure that costs a whole position. Stay up, flatten, then sit idle.
  let phase: HaltPhase = 'running'
  const t = setInterval(() => {
    const open = bot.openPositions()
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${healthLine(bot)}${bot.risk.halted ? ` | HALTED: ${bot.risk.haltReason}` : ''}`)
    const next = haltPhase(bot.risk.halted, open.length)
    if (next !== phase) {
      phase = next
      if (phase === 'flattening') {
        console.error(`\nkill switch fired: ${bot.risk.haltReason}. entries off, selling ${open.length} open position(s).`)
      } else if (phase === 'idle') {
        console.error(`\nkill switch fired: ${bot.risk.haltReason}. flat, holding nothing, buying nothing.`)
        console.error('the process stays up on purpose. stop it with: pm2 stop compute-1')
        for (const line of acceptance(bot.tel.raw())) console.error(line)
      }
    }
    // a position that will not sell is worse than a halt: say so every minute
    const stuck = open.filter((p) => p.stuck)
    if (phase !== 'running' && stuck.length) {
      console.error(`STUCK: ${stuck.length} position(s) still holding tokens, exits failing`)
    }
  }, 60_000)

  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    clearInterval(t)
    stopConfigWatch()
    const open = bot.openPositions()
    if (open.length) {
      console.log(`\n${open.length} position(s) still open and still holding tokens.`)
      open.forEach((p) => console.log(`  ${p.token.slice(0, 12)} ${p.tokens} tokens${p.stuck ? ' (exits failing)' : ''}`))
      console.log('their rows stay open, so restarting picks them up and exits them.')
    }
    console.log('\nacceptance checks:')
    for (const line of acceptance(bot.tel.raw())) console.log(line)
    dash?.close()
    await bot.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => { console.error(e); process.exit(1) })
