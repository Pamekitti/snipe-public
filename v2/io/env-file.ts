/**
 * Reading an env file, and turning one of them into the two switches. No side effects.
 *
 * Split from `io/dotenv.ts` because that module exists FOR its side effect: it populates
 * `process.env` at import, which is the only way to be earlier than the modules that read it.
 * A test that wanted to check how `TRADE_SIZE_ETH` is parsed would, by importing it, read the
 * real secrets file and put a live private key into the test process's environment. Everything
 * worth testing is therefore here, where importing it does nothing at all.
 */
import { readFileSync } from 'node:fs'
import type { Mode, Switches } from '../core/config.js'

/**
 * The keys that decide whether money moves, and how much.
 *
 * `MODE` is here even though it is restart-only, because the question it answers ("does this
 * process send?") is the same question and it must have the same single source.
 *
 * `HALT` is listed so a leftover line is not exported into `process.env`. It is not a switch.
 * Stop new buys with STOP ALL on the dashboard.
 */
export const MONEY_KEYS = ['MODE', 'HALT', 'TRADE_SIZE_ETH', 'SIZE_WEI'] as const
export type MoneyKey = (typeof MONEY_KEYS)[number]

export const isMoneyKey = (k: string): k is MoneyKey => (MONEY_KEYS as readonly string[]).includes(k)

export type EnvFile = {
  readonly path: string
  readonly found: boolean
  readonly vars: ReadonlyMap<string, string>
}

/**
 * `KEY=value` a line at a time, with `#` comments and one optional layer of quotes.
 *
 * Deliberately not a dotenv library: this runs before anything else in the process and the
 * whole format is four lines of parsing. A dependency here would be a dependency that has to
 * be loaded before the thing that configures the loader.
 */
export function parseEnvText(text: string): Map<string, string> {
  const vars = new Map<string, string>()
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const key = t.slice(0, eq).trim()
    let val = t.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    vars.set(key, val)
  }
  return vars
}

export function readEnvFile(path: string): EnvFile {
  try {
    return { path, found: true, vars: parseEnvText(readFileSync(path, 'utf8')) }
  } catch {
    return { path, found: false, vars: new Map() }
  }
}

/**
 * `"0.001"` to `1000000000000000n`, exactly, without passing through float64.
 *
 * `Math.round(Number(eth) * 1e18)` is what this replaces. It is right at 0.001 and wrong by a
 * few wei somewhere past 0.009, which is where an ETH figure in wei stops being exactly
 * representable as a double. This number sizes every trade, so it is parsed as text.
 */
export function ethToWei(s: string): bigint | null {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s.trim())
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null
  const frac = (m[2] ?? '').padEnd(18, '0').slice(0, 18)
  return BigInt(m[1] || '0') * 10n ** 18n + BigInt(frac || '0')
}

/**
 * The stake asked for, never above what the spec allows.
 *
 * `SIZE_WEI` wins over `TRADE_SIZE_ETH` because it is the exact form. An absent or unparseable
 * pair is 0, which refuses every entry at `risk-size` and says so, rather than falling back to
 * a number nobody wrote down.
 */
export function sizeFrom(vars: ReadonlyMap<string, string>, maxSizeWei: bigint): bigint {
  const wei = vars.get('SIZE_WEI')
  const eth = vars.get('TRADE_SIZE_ETH')
  const asked = wei !== undefined && /^\d+$/.test(wei) ? BigInt(wei)
    : eth !== undefined ? ethToWei(eth)
      : null
  if (asked === null || asked < 0n) return 0n
  return asked > maxSizeWei ? maxSizeWei : asked
}

export function modeFrom(vars: ReadonlyMap<string, string>): Mode | null {
  const raw = vars.get('MODE')
  if (raw === undefined) return null
  const m = raw.toLowerCase()
  return m === 'live' || m === 'shadow' ? m : null
}

export type SwitchesResult =
  | { readonly ok: true; readonly value: Switches; readonly ignoredHalt: boolean }
  | { readonly ok: false; readonly reason: string }

/**
 * Size and mode from the switches file, or a refusal.
 *
 * A MISSING FILE, A MISSING MODE, OR MODE=observe REFUSES TO BOOT. The old fallback
 * (observe and halted) looked like a running bot and sent nothing. Falling back to
 * `bot/.env` would also be wrong: that file says `TRADE_SIZE_ETH=0.005` where this
 * process trades a different size.
 *
 * `HALT` in the file is ignored. New buys stop from the dashboard.
 */
export function switchesFrom(file: EnvFile, maxSizeWei: bigint, now: number): SwitchesResult {
  if (!file.found) {
    return {
      ok: false,
      reason: `no switches file at ${file.path}. Refusing to boot. Write MODE=live and TRADE_SIZE_ETH. Use STOP ALL on the dashboard to stop new buys.`,
    }
  }
  const mode = modeFrom(file.vars)
  if (mode === null) {
    const wrote = file.vars.get('MODE')
    if (wrote === undefined) {
      return { ok: false, reason: `MODE is missing from ${file.path}. Set MODE=live. MODE=observe is gone.` }
    }
    return {
      ok: false,
      reason: `MODE=${wrote} is not allowed. Set MODE=live (sends) or MODE=shadow (signs, does not send). MODE=observe is gone.`,
    }
  }
  return {
    ok: true,
    ignoredHalt: file.vars.has('HALT'),
    value: {
      sizeWei: sizeFrom(file.vars, maxSizeWei),
      bookSizes: new Map(),
      mode,
      at: now,
      by: 'boot',
    },
  }
}
