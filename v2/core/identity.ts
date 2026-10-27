/**
 * What this kernel IS, as a fingerprint of what it DOES.
 *
 * THE PROBLEM THIS REPLACES. The old `MODEL_HASH` hashed the CONTENTS of 34 source files,
 * including `reporting.ts`, `validation.ts`, `report-worker.ts` and two scripts in
 * `scripts/`. So a comment, an import reorder, or a change to a reporting file that no
 * decision reads moved the identity, reset the virtual account to zero evidence, and
 * invalidated the release certificate. It moved 11 times in two days. Worse, the coupling
 * ran the wrong way: editing a file that cannot affect a decision invalidated the evidence,
 * while editing a CONSTANT that changes every decision did not.
 *
 * IDENTITY IS BEHAVIOUR. What matters is whether this kernel would make the same decisions,
 * so the fingerprint is taken over the things a decision reads: the frozen config and the
 * decision stream produced by replaying a fixed tape. Two builds that decide identically
 * have the same id no matter how their source is formatted, and two builds that decide
 * differently have different ids even if the diff is one digit in one constant.
 *
 * NO node:crypto. core/ is pure, and reaching for `node:crypto` to hash a filter is exactly
 * how the old `books.ts` acquired a host dependency inside a decision path. This is FNV-1a
 * over 64 bits, implemented in BigInt so it is exact and identical on every platform. It is
 * not cryptographic and does not need to be: nothing here defends against an adversary
 * choosing a collision, it defends against an operator not noticing a change.
 */

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK64 = 0xffffffffffffffffn

/**
 * FNV-1a, 64 bit, over the UTF-16 code units of the string.
 *
 * Code units rather than UTF-8 bytes because it avoids an encoder in core/ and the inputs
 * here are canonical JSON, which is ASCII apart from whatever a config string carries. The
 * choice only has to be FIXED, and it is fixed here.
 */
export function fnv1a64(s: string): bigint {
  let h = FNV_OFFSET
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i))
    h = (h * FNV_PRIME) & MASK64
  }
  return h
}

export const hex16 = (h: bigint): string => h.toString(16).padStart(16, '0')

/**
 * Canonical JSON: keys sorted, bigints as decimal strings, no whitespace.
 *
 * THE SAME FUNCTION THE GATE COMPARES WITH, deliberately. If the identity and the
 * equivalence check canonicalised differently, two runs could be declared identical by one
 * and different by the other. `JSON.stringify` alone is not enough: its key order is
 * insertion order, so two objects with the same fields built in different orders serialise
 * differently, which is exactly how the old `configId` changed without the config changing.
 */
export function canonical(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'bigint') return `"${v.toString()}"`
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null'
  if (typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v instanceof Map) {
    const entries = [...v.entries()].map(([k, val]) => [String(k), val] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`).join(',')}}`
  }
  if (v instanceof Set) return `[${[...v].map(canonical).sort().join(',')}]`
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}

/**
 * The id of a kernel, over a decision stream.
 *
 * `decisions` is every verdict the kernel produced replaying the certification tape, in
 * seq order, already canonicalised. `configDigest` is folded in because the same code under
 * a different config is a different decider, and that is the half the old hash missed
 * entirely.
 */
export function kernelId(configDigest: string, decisions: readonly string[]): string {
  return hex16(fnv1a64(`${configDigest}\n${decisions.join('\n')}`))
}

/**
 * The id of a config alone, for the `config-applied` event and the ledger.
 *
 * Over the canonical form of the frozen values, NOT over the file bytes. A reformatted TOML
 * that parses to the same values is the same policy and must not reset anything. (The file
 * bytes are digested separately by io/config-load.ts, which is a different question: "did
 * the file change", not "did the policy change".)
 */
export function configDigest(frozen: unknown): string {
  return hex16(fnv1a64(canonical(frozen)))
}
