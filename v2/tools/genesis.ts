/**
 * Seed v2 state from the live bot's databases and one chain read.
 *
 * HISTORY ARRIVES AS FOLDED STATE, NOT AS REPLAYED EVENTS. The feed overlay, the arming
 * blocks and the reseeds were never recorded before the tape existed, so inventing events
 * for them would put fiction in an append-only ledger. One honest seed beats a plausible
 * reconstruction.
 *
 * Writes a `config-applied` and the seed events onto an empty tape: entered tokens,
 * template losses, deployers, the per-book ledger, and the scored launches gate.db already
 * holds so a restart is not blind for the first 20. A tape that already has rows is
 * refused: a second genesis would double-count.
 *
 *   npx tsx tools/genesis.ts --bot-db ../v1/data/bot.db --gate-db ../v1/data/gate.db
 */
import { createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import Database from 'better-sqlite3'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { Tape } from '../io/tape.js'
import { ENDPOINTS, hasKey, requireKey } from '../io/env.js'
import { loadConfig } from '../io/config-load.js'
import { templateKey } from '../core/entry.js'
import { routeBook } from '../core/book.js'
import { barKey } from '../core/sim.js'
import type { Event } from '../core/events.js'
import type { FrozenConfig } from '../core/config.js'
import type { Outcome } from '../core/state.js'

export type GenesisInputs = {
  readonly config: FrozenConfig
  readonly digest: string
  readonly botDb: string
  readonly gateDb: string | null
}

export type GenesisSeeds = {
  readonly events: Event[]
  readonly entered: number
  readonly templates: number
  readonly deployers: number
  readonly outcomes: number
  readonly firstBook: string
  readonly realizedWei: string
}

function openBot(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true })
}

function msAt(v: number): number {
  return v > 1e12 ? v : v * 1000
}

function readEntered(bot: Database.Database): string[] {
  return (bot.prepare(
    `SELECT DISTINCT lower(token) token FROM positions WHERE buy_ok = 1 AND token IS NOT NULL`,
  ).all() as Array<{ token: string }>).map((r) => r.token)
}

function readTemplates(bot: Database.Database): Array<readonly [string, number]> {
  const templateRows = bot.prepare(
    `SELECT p.exit_at at, l.creator_tax_bps tax, l.dev_buy_wei dev, l.exemptions ex
     FROM positions p JOIN launches l ON l.token = p.token
     WHERE p.live = 1 AND p.closed = 1 AND p.buy_ok = 1
       AND CAST(COALESCE(p.onchain_pnl_wei, p.pnl_wei, '0') AS REAL) < 0
       AND p.exit_reason NOT IN ('recovered-flat','buy-reverted','buy-never-mined')`,
  ).all() as Array<{ at: number; tax: number; dev: string; ex: number | null }>
  const templates = new Map<string, number>()
  for (const r of templateRows) {
    const k = templateKey(Number(r.tax), BigInt(r.dev ?? '0'), r.ex)
    if ((templates.get(k) ?? 0) < r.at) templates.set(k, r.at)
  }
  return [...templates.entries()]
}

function readDeployers(bot: Database.Database): Array<readonly [string, number]> {
  return (bot.prepare(
    `SELECT lower(deployer) d, COUNT(*) n FROM launches WHERE deployer IS NOT NULL GROUP BY 1`,
  ).all() as Array<{ d: string; n: number }>).map((r) => [r.d, r.n] as const)
}

/**
 * The old book is one policy. Its realised P&L becomes the first book's ledger; every other
 * book starts at zero. Splitting historical P&L across bands would invent a per-book history
 * the old process never kept.
 */
function readLedger(bot: Database.Database, config: FrozenConfig): {
  rows: Array<{ book: string; realizedWei: string; peakWei: string }>
  firstBook: string
  realizedWei: string
} {
  const pnl = bot.prepare(
    `SELECT COALESCE(SUM(CAST(COALESCE(onchain_pnl_wei, pnl_wei, '0') AS TEXT)), '0') wei
     FROM positions WHERE live = 1 AND closed = 1 AND buy_ok = 1
       AND exit_reason NOT IN ('recovered-flat','buy-reverted','buy-never-mined')`,
  ).get() as { wei: string | number }
  const wei = String(pnl.wei ?? '0')
  const firstBook = config.books[0]?.id ?? 'untaxed'
  const peak = BigInt(wei) > 0n ? wei : '0'
  return {
    firstBook,
    realizedWei: wei,
    rows: config.books.map((b) => ({
      book: b.id,
      realizedWei: b.id === firstBook ? wei : '0',
      peakWei: b.id === firstBook ? peak : '0',
    })),
  }
}

function taxByToken(bot: Database.Database): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of bot.prepare(
    `SELECT lower(token) t, creator_tax_bps tax FROM launches WHERE token IS NOT NULL AND creator_tax_bps IS NOT NULL AND creator_tax_bps >= 0`,
  ).all() as Array<{ t: string; tax: number }>) {
    out.set(r.t, r.tax)
  }
  return out
}

function readOutcomes(gatePath: string | null, bot: Database.Database, config: FrozenConfig): Outcome[] {
  if (!gatePath || !existsSync(gatePath)) return []
  let gate: Database.Database
  try { gate = new Database(gatePath, { readonly: true, fileMustExist: true }) }
  catch { return [] }
  try {
    const cols = (gate.prepare(`PRAGMA table_info(obs)`).all() as Array<{ name: string }>).map((c) => c.name)
    if (!cols.includes('bars')) return []
    const rows = gate.prepare(
      `SELECT lower(token) token, bars, launched_at, peak, at
       FROM obs WHERE error IS NULL AND bars IS NOT NULL AND launched_at > 0
       ORDER BY launched_at DESC LIMIT 500`,
    ).all() as Array<{ token: string; bars: string; launched_at: number; peak: number | null; at: number }>
    const tax = taxByToken(bot)
    const perBook = new Map<string, Outcome[]>()
    for (const r of rows) {
      const t = tax.get(r.token)
      if (t === undefined) continue
      const routed = routeBook(msAt(r.at), config, r.token, t)
      if (!routed.ok) continue
      let perBar: Record<string, number>
      try { perBar = JSON.parse(r.bars) as Record<string, number> }
      catch { continue }
      const book = routed.value
      const key = barKey(book.guard.pnlBar)
      const stakes = Object.prototype.hasOwnProperty.call(perBar, key) ? Number(perBar[key]) : null
      const list = perBook.get(book.id) ?? []
      if (list.length >= book.guard.window * 2) continue
      list.push({
        token: r.token, book: book.id, at: msAt(r.at),
        perBar, stakes: stakes !== null && Number.isFinite(stakes) ? stakes : null,
        peak: Number(r.peak ?? 0),
      })
      perBook.set(book.id, list)
    }
    const out: Outcome[] = []
    for (const list of perBook.values()) {
      list.reverse()
      out.push(...list)
    }
    return out
  } finally {
    gate.close()
  }
}

export function buildGenesisEvents(input: GenesisInputs, at: number, run = 'genesis'): GenesisSeeds {
  const bot = openBot(input.botDb)
  try {
    const entered = readEntered(bot)
    const templates = readTemplates(bot)
    const deployers = readDeployers(bot)
    const ledger = readLedger(bot, input.config)
    const outcomes = readOutcomes(input.gateDb, bot, input.config)
    const events: Event[] = [
      {
        seq: 1, at, run, kind: 'config-applied',
        specVersion: input.config.specVersion, digest: input.digest,
        values: input.config, changed: [], source: 'boot',
      },
      { seq: 2, at, run, kind: 'seed', what: 'entered', rows: entered },
      { seq: 3, at, run, kind: 'seed', what: 'template-losses', rows: templates },
      { seq: 4, at, run, kind: 'seed', what: 'deployers', rows: deployers },
      { seq: 5, at, run, kind: 'seed', what: 'ledger', rows: ledger.rows },
    ]
    if (outcomes.length) {
      events.push({ seq: 6, at, run, kind: 'seed', what: 'outcomes', rows: outcomes })
    }
    return {
      events, entered: entered.length, templates: templates.length, deployers: deployers.length,
      outcomes: outcomes.length, firstBook: ledger.firstBook, realizedWei: ledger.realizedWei,
    }
  } finally {
    bot.close()
  }
}

async function chainNonce(): Promise<number | null> {
  if (!hasKey()) return null
  try {
    const account = privateKeyToAccount(requireKey() as `0x${string}`)
    const client = createPublicClient({ transport: http(ENDPOINTS.rpc) })
    return await client.getTransactionCount({ address: account.address, blockTag: 'pending' })
  } catch (e) {
    console.error(`chain nonce read failed (seed continues without it): ${String(e)}`)
    return null
  }
}

async function main(): Promise<void> {
  const args = parseArgs({
    options: {
      'bot-db': { type: 'string', default: '../v1/data/bot.db' },
      'gate-db': { type: 'string', default: '../v1/data/gate.db' },
      tape: { type: 'string', default: 'data/tape.db' },
      spec: { type: 'string', default: 'config/strategy.toml' },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  const specPath = args.values.spec!
  const loaded = loadConfig(specPath, Date.now(), null)
  if (!loaded.ok) {
    console.error(`the spec would not load: ${loaded.refusal.reason}`)
    process.exit(1)
  }
  const gatePath = args.values['gate-db']!
  const seeds = buildGenesisEvents({
    config: loaded.value.values,
    digest: loaded.value.digest,
    botDb: args.values['bot-db']!,
    gateDb: existsSync(gatePath) ? gatePath : null,
  }, Date.now())
  const nonce = await chainNonce()
  console.log(`genesis: ${seeds.entered} entered, ${seeds.templates} templates, ${seeds.deployers} deployers, ${seeds.outcomes} outcomes`)
  console.log(`genesis: ledger ${seeds.firstBook} = ${seeds.realizedWei} wei; chain nonce ${nonce === null ? 'not read' : nonce}`)

  if (args.values['dry-run']) {
    console.log(JSON.stringify(seeds.events, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2))
    return
  }

  const tapePath = args.values.tape!
  const tape = new Tape(tapePath)
  if (tape.stats().rows > 0) {
    console.error(`tape ${tapePath} already has ${tape.stats().rows} events; genesis refused`)
    tape.close()
    process.exit(2)
  }
  tape.append(seeds.events)
  tape.close()
  console.log(`genesis: wrote ${seeds.events.length} events to ${tapePath}`)
}

const invoked = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invoked) await main()
