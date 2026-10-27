/**
 * The environment, read from files, BEFORE anything else reads the environment.
 *
 * THIS MODULE IS IMPORTED FIRST AND FOR ITS SIDE EFFECT. That is unusual enough to explain:
 * `io/env.ts` used to resolve every endpoint at import time, and ES modules are evaluated
 * before the importing file's body runs, so `main.ts` calling a dotenv loader in its body was
 * always too late. The consequence was live and expensive: on 2026-09-16 the box ran with
 * `RPC_URL` and `LOGS_WS_URL` absent from the process environment even though both were in
 * `.env`, so every per-launch `meta` multicall went to the free public endpoint and came back
 * `Too Many Requests` inside the entry window. Loading here, in a module whose only import is
 * a pure one, is what makes "the file is authoritative" true rather than aspirational.
 *
 * TWO FILES, AND ONLY ONE OF THEM CAN MOVE MONEY.
 *
 *   SECRETS   the key, the endpoints, the chain. The machine's description, shared with `bot/`
 *             while it still exists. The inherited environment WINS over it, so a one-off
 *             `RPC_URL=... npx tsx main.ts` still works the way anyone would expect.
 *   SWITCHES  `MODE`, `TRADE_SIZE_ETH`, `SIZE_WEI`. v2's own file, and the ONLY place
 *             those are read from. The inherited environment cannot reach them at all.
 *             `HALT` is ignored if still written; STOP ALL on the dashboard stops new buys.
 *
 * The second rule is the fix for the defect that `run-live.sh` exported `TRADE_SIZE_ETH`
 * before node started, while the loader skipped any key already set. Making the money keys
 * file-only means the script cannot win that argument, because it is no longer in it.
 *
 * Everything worth testing lives in `io/env-file.ts`, which has no side effect. This module is
 * the side effect.
 */
import { isMoneyKey, readEnvFile, type EnvFile } from './env-file.js'

export { MONEY_KEYS, switchesFrom, sizeFrom, ethToWei, type EnvFile } from './env-file.js'

/** The machine's description. Everything except the four money keys, and never over an override. */
export const SECRETS: EnvFile = readEnvFile(process.env.ENV_FILE ?? '../v1/.env')

/** v2's own switches. The only source for `MODE`, `TRADE_SIZE_ETH` and `SIZE_WEI`. */
export const SWITCHES: EnvFile = readEnvFile(process.env.SWITCHES_FILE ?? '.env')

for (const [k, v] of SECRETS.vars) {
  if (isMoneyKey(k)) continue
  if (process.env[k] === undefined) process.env[k] = v
}

// v2's own file is the most specific description of this machine, so its non-money keys do
// override an inherited value. Its money keys are deliberately NOT exported into the
// environment: `main.ts` reads them from `SWITCHES.vars`, so nothing downstream can pick them
// up from `process.env` by accident and reintroduce the two-sources-of-truth defect.
for (const [k, v] of SWITCHES.vars) {
  if (isMoneyKey(k)) continue
  process.env[k] = v
}

/** One line per file, for the boot banner. Names the file, never a value. */
export function envProvenance(): string {
  const say = (label: string, f: EnvFile): string =>
    `${label} ${f.found ? `${f.path} (${f.vars.size} keys)` : `${f.path} MISSING`}`
  return `${say('secrets', SECRETS)}; ${say('switches', SWITCHES)}`
}
