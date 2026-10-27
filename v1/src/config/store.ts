/**
 * The live config snapshot, and the watcher that replaces it when the file changes.
 *
 * THE PRECEDENCE RULE, which is the whole point:
 *
 *   hot fields      THE FILE WINS over process.env.
 *   restart fields  process.env wins over the file (today's dotenv behaviour, unchanged).
 *
 * The asymmetry is deliberate and it is the fix for the 2026-09-06 failure. dotenv never
 * overrides a variable already in process.env, and pm2 replays its own saved environment on
 * every `pm2 restart --update-env`, so an edited .env lost to a stale pm2 copy of
 * TRADE_SIZE_ETH and nothing reported it. For a hot field the file has to win or "edit the
 * file" is not a mechanism, it is a suggestion. For a restart field process.env still wins,
 * because that is how a second instance is started from the command line
 * (`MODE=observe DASH=0 DB_FILE=... pm2 start`) and that recipe must keep working.
 *
 * A second instance that also needs different HOT values points ENV_FILE at its own file.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO:
 *
 *   It never clears a halt. Raising MAX_DRAWDOWN_USD while the drawdown stop is holding
 *   flips the number and leaves the halt exactly where it is. The stop not lifting itself is
 *   the whole safety argument for letting the regime gate resume on its own, and a file edit
 *   is not a decision to put money back to work. Same for HALT: 1 applies live, 0 does not.
 *
 *   It never reconstructs anything. RiskManager holds the halts in memory and nothing
 *   persists them, so building a new one would silently un-halt the bot. Only values move.
 *
 *   It never applies half a change. If any value in the file is bad, NOTHING is applied and
 *   the previous snapshot stands.
 */
import { readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { config as loadDotenv, parse as parseEnvFile } from 'dotenv'
import {
  HOT, HOT_KEYS, RESTART, crossCheck, parseField, type Book,
  type Applies, type Config, type HotKey, type RestartKey, type Scope,
} from './schema.js'

export type Change = {
  env: string
  from: string
  to: string
  scope: Scope
  applies: Applies
}

export type ReloadResult = {
  at: number
  /** hot changes that are now live */
  applied: Change[]
  /** restart-only settings edited in the file. Reported, never applied. */
  pending: Change[]
  /** why nothing was applied. Non-empty means the previous snapshot still stands. */
  errors: string[]
  ok: boolean
}

const ENV_PATH = resolve(process.env.ENV_FILE ?? '.env')

/**
 * The REAL environment: what the shell, pm2 or the test runner handed this process, captured
 * before dotenv writes any file values into process.env.
 *
 * The distinction is load-bearing. dotenv copies the file into process.env, after which
 * process.env can no longer tell you whether `GATE_LIVE=1` came from the command line or
 * from the file, and a later edit to the file is shadowed by dotenv's own copy of the old
 * value forever. Reading restart-only keys from this snapshot instead keeps the command line
 * winning (which is how the watch-only instance is started) AND lets the file change be
 * SEEN, so it can be reported as needing a restart instead of vanishing.
 */
const SHELL_ENV: Record<string, string | undefined> = { ...process.env }

// Populate process.env from THE SAME FILE the store reads, before anything else in the tree
// looks at it. This used to be a bare `import 'dotenv/config'` in config.ts, which always
// loads `.env` and ignores ENV_FILE: a second instance pointed at its own file still had its
// restart-only keys (MODE, GATE_LIVE, the RPC urls) filled in from the primary's `.env`,
// which is a quietly wrong answer. dotenv still never overrides a variable already set, so a
// real command-line `MODE=observe` keeps winning over both files.
loadDotenv({ path: ENV_PATH })

/** How a value is written into a log line, an audit row and a diff. One shape, everywhere. */
function show(v: unknown): string {
  if (v === null) return 'off'
  if (typeof v === 'boolean') return v ? '1' : '0'
  // Books render back as the operator's own line. Without this they go through String() and
  // land as "[object Object]" in the applied-diff line, the boot log, the
  // chain_truth.filter_changes audit row and the health detail, all at once.
  if (Array.isArray(v)) {
    return v.map((b) => {
      const x = b as { id?: string; minTaxBps?: number; maxTaxBps?: number }
      return x && typeof x === 'object' && 'id' in x ? `${x.id}:${x.minTaxBps}-${x.maxTaxBps}` : String(b)
    }).join(',')
  }
  if (typeof v === 'object' && v !== null && 'from' in v) {
    const w = v as { from: number; to: number }
    return `${w.from}-${w.to}`
  }
  return String(v)
}

/**
 * Read and parse the file. A missing file is not an error: on the laptop there may be none,
 * and every field then falls back to process.env and its default, which is what the test
 * suite has always run on. An UNREADABLE file (permissions, half-written) IS an error, and
 * the caller keeps the previous snapshot rather than reverting to defaults, because
 * defaults on a live bot are a size change nobody asked for.
 */
function readEnvFile(): { vals: Record<string, string> } | { error: string } {
  try {
    return { vals: parseEnvFile(readFileSync(ENV_PATH)) }
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err?.code === 'ENOENT') return { vals: {} }
    return { error: `cannot read ${ENV_PATH}: ${err?.message ?? String(e)}` }
  }
}

function rawFor(env: string, scope: Scope, file: Record<string, string>): string | undefined {
  return scope === 'hot' ? (file[env] ?? SHELL_ENV[env]) : (SHELL_ENV[env] ?? file[env])
}

type Built = { config: Config; restart: Record<string, string>; errors: string[] }

function build(file: Record<string, string>): Built {
  const errors: string[] = []
  const out = {} as Record<HotKey, unknown>
  for (const k of HOT_KEYS) {
    const f = HOT[k]
    const r = parseField(f, rawFor(f.env, f.scope, file))
    if ('error' in r) {
      errors.push(r.error)
      continue
    }
    out[k] = r.value
  }
  // ---- derived defaults, before the freeze ----
  // Two fields cannot express their default as a literal, because it depends on another
  // field, and parseField deliberately sees one field at a time. Resolving them here means
  // `Config.books` is never empty and `Config.maxWalletDrawdownEth` is never 0 downstream,
  // so no consumer has to know that "absent" is a case.
  const books = out.books as readonly Book[] | undefined
  if (!books?.length) {
    // Absent BOOKS is ONE book from the scalar band keys, which is exactly the behaviour
    // that shipped before BOOKS existed. The name `main` matches the cohort literal already
    // used throughout the trading queries.
    out.books = [{ id: 'main', minTaxBps: out.entryMinTaxBps as number, maxTaxBps: out.entryMaxTaxBps as number }]
  }
  if (!(out.maxWalletDrawdownEth as number)) {
    out.maxWalletDrawdownEth = (out.books as readonly Book[]).length * (out.maxDrawdownEth as number)
  }

  const config = Object.freeze(out) as Config
  // Cross-field rules only make sense once every field parsed; reporting "size above
  // bankroll" when the bankroll itself failed to parse would just be noise.
  // The second argument is the set of env names the operator actually WROTE. Config cannot
  // show that: a derived single book is indistinguishable from an explicit one-book BOOKS
  // line, and one rule (the band declared twice) turns on exactly that difference.
  const present = new Set<string>()
  for (const k of HOT_KEYS) if (rawFor(HOT[k].env, HOT[k].scope, file) !== undefined) present.add(HOT[k].env)
  if (!errors.length) errors.push(...crossCheck(config, present))
  const restart: Record<string, string> = {}
  for (const env of Object.keys(RESTART) as RestartKey[]) {
    restart[env] = rawFor(env, 'restart', file) ?? ''
  }
  return { config, restart, errors }
}

// The state. `current` is swapped wholesale; it is never mutated in place, so a caller that
// captured a snapshot for an open position keeps exactly what it captured.
let currentFile = (() => {
  const r = readEnvFile()
  return 'error' in r ? {} : r.vals
})()
let built = build(currentFile)
let current: Config = built.config
let currentRestart = built.restart
/** what this process actually captured at startup. Pending is always measured against it. */
const bootRestart = { ...built.restart }
let bootErrors = built.errors
let changedAt = 0
let lastErrors: string[] = built.errors

/** The live snapshot. Every hot read goes through this. */
export function config(): Config {
  return current
}

/**
 * Problems found in the file the LAST time it was read. Non-empty at boot means the process
 * is running on defaults for at least one setting; index.ts refuses to go live on that.
 */
export function configErrors(): string[] {
  return lastErrors
}

export function bootConfigErrors(): string[] {
  return bootErrors
}

export function envFilePath(): string {
  return ENV_PATH
}

/** ms of the last applied change, 0 if the config has not moved since boot */
export function configChangedAt(): number {
  return changedAt
}

/**
 * Restart-only settings whose value in the file no longer matches what this process
 * captured at startup. Measured against BOOT, not against the last read, so an edit that is
 * reverted stops being pending instead of leaving a phantom behind.
 */
export function pendingRestartChanges(): Change[] {
  return restartDiff(bootRestart, currentRestart)
}

function hotDiff(before: Config, after: Config): Change[] {
  const applied: Change[] = []
  for (const k of HOT_KEYS) {
    const f = HOT[k]
    const a = show(before[k]), b = show(after[k])
    if (a !== b) applied.push({ env: f.env, from: a, to: b, scope: 'hot', applies: f.applies })
  }
  return applied
}

function restartDiff(beforeR: Record<string, string>, afterR: Record<string, string>): Change[] {
  const out: Change[] = []
  for (const env of Object.keys(afterR)) {
    if (beforeR[env] === afterR[env]) continue
    // a key is never printed, in a log line or a payload
    const redact = env === 'PRIVATE_KEY'
    out.push({
      env,
      from: redact ? '(set)' : beforeR[env] ?? '',
      to: redact ? '(changed)' : afterR[env] ?? '',
      scope: 'restart',
      applies: 'account',
    })
  }
  return out
}

/**
 * Re-read the file and swap the snapshot if everything in it is valid.
 *
 * Returns what moved so the caller can log it, audit it, republish strategy_json for the
 * out-of-process monitors, and act on HALT. This function itself only moves values.
 */
export function reloadConfig(now = Date.now()): ReloadResult {
  const read = readEnvFile()
  if ('error' in read) {
    lastErrors = [read.error]
    return { at: now, applied: [], pending: pendingRestartChanges(), errors: lastErrors, ok: false }
  }
  const next = build(read.vals)
  if (next.errors.length) {
    lastErrors = next.errors
    return { at: now, applied: [], pending: pendingRestartChanges(), errors: next.errors, ok: false }
  }
  const applied = hotDiff(current, next.config)
  current = next.config
  currentRestart = next.restart
  currentFile = read.vals
  lastErrors = []
  if (applied.length) changedAt = now
  return { at: now, applied, pending: pendingRestartChanges(), errors: [], ok: true }
}

/**
 * Watch the file and reload on change.
 *
 * Two mechanisms on purpose. fs.watch on the DIRECTORY (not the file) survives the
 * write-temp-then-rename that editors do, which silently breaks a watch bound to the inode.
 * The mtime poll is the backstop, because fs.watch is not reliable on every filesystem and a
 * config change that is silently not noticed is the exact failure being fixed here.
 *
 * Every callback is wrapped: this shares a process with the trading loop and there is no
 * uncaughtException handler, so a throw in here is a dead bot.
 */
export function startConfigWatch(
  onReload: (r: ReloadResult) => void,
  opts: { debounceMs?: number; pollMs?: number } = {},
): () => void {
  const debounceMs = opts.debounceMs ?? 250
  const pollMs = opts.pollMs ?? 10_000
  let timer: NodeJS.Timeout | null = null
  let watcher: FSWatcher | null = null

  const stamp = (): string => {
    try {
      const s = statSync(ENV_PATH)
      return `${s.mtimeMs}:${s.size}`
    } catch {
      return 'none'
    }
  }
  let seen = stamp()

  const fire = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      try {
        seen = stamp()
        onReload(reloadConfig())
      } catch (e) {
        console.error(`config watch: ${(e as Error).message}`)
      }
    }, debounceMs)
    timer.unref?.()
  }

  try {
    watcher = watch(dirname(ENV_PATH), (_evt, name) => {
      if (!name || basename(String(name)) === basename(ENV_PATH)) fire()
    })
    watcher.on('error', () => {
      /* the poll below is the backstop */
    })
  } catch {
    watcher = null
  }

  const poll = setInterval(() => {
    const s = stamp()
    if (s !== seen) {
      seen = s
      fire()
    }
  }, pollMs)
  poll.unref?.()

  return () => {
    if (timer) clearTimeout(timer)
    clearInterval(poll)
    try {
      watcher?.close()
    } catch {
      /* already gone */
    }
  }
}

/**
 * Tests only: install a snapshot directly, and hand back a restore function. Nothing in the
 * bot may call this; the file is the only way config moves in production.
 */
export function setConfigForTest(over: Partial<Config>): () => void {
  const before = current
  current = Object.freeze({ ...current, ...over }) as Config
  return () => {
    current = before
  }
}

/** Tests only: the raw file values the last load saw. */
export function configFileValues(): Record<string, string> {
  return currentFile
}
