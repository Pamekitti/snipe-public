/**
 * Reading the spec off disk. The only place TOML, the filesystem or a hash function appears.
 *
 * WHY THIS IS NOT IN core/. `core/` may not import `node:` or npm, so it cannot parse a file
 * or compute a digest. That is not an inconvenience to work around, it is the property that
 * makes `core/` deterministic. So parsing happens here, the rules live in `core/config.ts`
 * as a pure function over already-parsed data, and the whole rule set is testable without a
 * filesystem.
 *
 * WHAT THIS PRODUCES. A `config-applied` event, not a config object. Nothing hands a config
 * to a decision directly; it goes on the tape and reaches `decide` as `state.config`. A
 * replay is therefore configured by the same rows the live run was.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parse as parseToml } from 'smol-toml'
import { validate } from '../core/config.js'
import type { FrozenConfig } from '../core/config.js'
import { no, ok, type Ok } from '../core/contracts.js'

export type LoadedConfig = {
  readonly values: FrozenConfig
  /** sha256 of the file's exact bytes, 16 hex. What a decision is stamped with. */
  readonly digest: string
  /** dotted paths whose value differs from `previous`. Empty on first load. */
  readonly changed: readonly string[]
}

/**
 * Digest the BYTES, not the parsed object.
 *
 * A parsed object digests differently depending on key order, which is how the old
 * simulation store ended up with a `configId` that turned on `JSON.stringify` ordering. The
 * bytes are what the operator wrote and what git diffed, so they are the honest identity.
 */
function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** Flatten to dotted paths so a diff can name exactly what moved. */
function flatten(v: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  if (Array.isArray(v)) {
    v.forEach((x, i) => { for (const [k, val] of flatten(x, `${prefix}[${i}]`)) out.set(k, val) })
  } else if (typeof v === 'object' && v !== null) {
    for (const [k, val] of Object.entries(v)) {
      for (const [kk, vv] of flatten(val, prefix ? `${prefix}.${k}` : k)) out.set(kk, vv)
    }
  } else {
    out.set(prefix, String(v))
  }
  return out
}

export function diffConfig(before: FrozenConfig | null, after: FrozenConfig): string[] {
  if (!before) return []
  const a = flatten(before), b = flatten(after)
  const keys = new Set([...a.keys(), ...b.keys()])
  // Sorted with a byte comparator so the changed list is stable across machines, which
  // matters because it goes onto the tape and into the digest of what happened.
  return [...keys].filter((k) => a.get(k) !== b.get(k)).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
}

/**
 * Read, parse and validate. A refusal leaves the caller holding the previous spec.
 *
 * `at` is the `at` the driver will stamp on the event, passed in rather than read, so even
 * the refusal carries tape time rather than wall time.
 */
export function loadConfig(path: string, at: number, previous: FrozenConfig | null): Ok<LoadedConfig> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    return no(at, 'config-refused', path, `cannot read the spec: ${String(e)}`)
  }
  let raw: unknown
  try {
    raw = parseToml(text)
  } catch (e) {
    // A parse failure names the file and the parser's own message, which carries a line
    // number. Never a generic "invalid config".
    return no(at, 'config-refused', path, `TOML parse failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  const checked = validate(at, raw)
  if (!checked.ok) return checked
  return ok({ values: checked.value, digest: digestOf(text), changed: diffConfig(previous, checked.value) })
}

/**
 * Does the file on disk still need applying once the tape has been folded?
 *
 * THE DEFECT THIS ANSWERS. Boot loads the file, seeds state with it, then folds the tape — and
 * every `config-applied` row on that tape replaces `state.config` with the spec in force at the
 * time. Correct for a replay, wrong for a boot: the process finished holding the LAST RECORDED
 * spec, not the file, and the only other path to the file is a watcher that fires on a later
 * edit. So shipping a spec and restarting changed nothing and said nothing. Measured on
 * 2026-09-17 by deploying the 15/8 guard and reading `window 20` back out of `/api/state`.
 *
 * ON AN EMPTY TAPE THE FILE ALWAYS APPLIES, because there is no history to disagree with, and
 * the first row of a tape should say what the run was configured with.
 *
 * OTHERWISE ONLY WHEN SOMETHING MOVED. Re-applying an identical spec every boot would put a row
 * on the tape and a line in the log saying nothing happened, and the operator would learn to
 * ignore both.
 *
 * A separate function from `loadConfig` because it is a rule rather than a read, and rules here
 * are tested without a filesystem.
 */
export function bootApply(
  tapeRows: number,
  folded: FrozenConfig | null,
  file: FrozenConfig,
): { readonly apply: boolean; readonly changed: readonly string[] } {
  const changed = diffConfig(folded, file)
  return { apply: tapeRows === 0 || changed.length > 0, changed }
}
