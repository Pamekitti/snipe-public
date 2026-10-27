/**
 * Values, turned into something a person can read, with their provenance still attached.
 *
 * A NUMBER ON THIS PAGE IS NEVER BARE. Every drawable value is a `Shown<T>`, which carries the
 * value for scripts, the text for people, a tone for colour, and either a reading's age and
 * source or a sentence saying why there is no value. The old dashboard rendered `0.00` for
 * "we measured zero", for "the reading never arrived" and for "this run cannot produce one",
 * and an operator could not tell the three apart.
 *
 * NOTHING HERE DECIDES ANYTHING. These are stringifiers and two tone rules. Both tone rules
 * take their cuts as arguments so the cuts can only ever come from `levels.ts`, which is what
 * `rings.test.ts` enforces by failing on a numeric literal in a comparison.
 *
 * GEOMETRY IS NOT HERE. Chart shells and the series payload live in `render/charts.ts`.
 * The pixels are uPlot's, in `render/charts-client.ts`.
 */
import type { Sensed, Source } from '../core/contracts.js'

export type Tone = 'good' | 'bad' | 'warn' | 'plain' | 'muted'

/** A value the page may draw. `value` is for scripts, `text` is for people, `tone` is the colour. */
export type Shown<T> = {
  readonly value: T | null
  readonly text: string
  readonly tone: Tone
  /** when the underlying reading was taken, or null when it is not a reading */
  readonly at: number | null
  readonly ageMs: number | null
  readonly source: Source | 'fold' | 'config' | 'projection' | 'switch' | null
  /** the denominator, when the value is a rate. Null when it does not have one. */
  readonly n: number | null
  /** the sentence to show instead of a value. Non-null means there is no value. */
  readonly missing: string | null
}

/** A proportion drawn as a bar. `fraction` is already clamped to 0..1. */
export type Bar = {
  readonly fraction: number
  readonly text: string
  readonly tone: Tone
  readonly missing: string | null
}

// ---------------------------------------------------------------------------
// The scales a formatter needs. Not thresholds: units.
// ---------------------------------------------------------------------------

const WEI_PER_ETH = 1e18
const MS = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const
const DP = { eth: 4, usd: 2, pct: 1, mult: 2, seconds: 1, stakes: 2 } as const
/** Longer than this and an address is shortened. A column width, not a rule about addresses. */
const TOKEN_CHARS = 12

// ---------------------------------------------------------------------------
// Stringifiers
// ---------------------------------------------------------------------------

/**
 * Wei to ETH.
 *
 * `Number(BigInt)` is lossy above 2^53 wei, which is 0.009 ETH, so the division is done on
 * the bigint and only the remainder reaches float. At this wallet's size the naive version
 * would have been fine, which is exactly why it would have survived to a size where it is
 * not.
 */
export function eth(wei: bigint | null, signed = true): string {
  if (wei === null) return '–'
  const neg = wei < 0n
  const abs = neg ? -wei : wei
  const whole = abs / 10n ** 18n
  const frac = abs % 10n ** 18n
  const n = Number(whole) + Number(frac) / WEI_PER_ETH
  const body = n.toFixed(DP.eth)
  if (neg) return `-${body}`
  return signed ? `+${body}` : body
}

/** Wei as a float, for a chart axis. Same bigint-first division, same reason. */
export function ethValue(wei: bigint): number {
  const neg = wei < 0n
  const abs = neg ? -wei : wei
  const n = Number(abs / 10n ** 18n) + Number(abs % 10n ** 18n) / WEI_PER_ETH
  return neg ? -n : n
}

export function usd(n: number | null, signed = true): string {
  if (n === null) return '–'
  const body = Math.abs(n).toFixed(DP.usd)
  if (n < 0) return `-$${body}`
  return signed ? `+$${body}` : `$${body}`
}

export function pct(n: number | null, signed = false): string {
  if (n === null) return '–'
  const body = `${Math.abs(n).toFixed(DP.pct)}%`
  if (n < 0) return `-${body}`
  return signed ? `+${body}` : body
}

export function mult(n: number | null): string {
  return n === null ? '–' : `${n.toFixed(DP.mult)}x`
}

/** The indicator's unit. Signed always: the sign IS the verdict. */
export function stakes(n: number | null): string {
  if (n === null) return '–'
  return (n < 0 ? '' : '+') + n.toFixed(DP.stakes)
}

export function count(n: number | null): string {
  return n === null ? '–' : String(n)
}

/** Seconds with one decimal, for holds. Anything over a minute is an age, not a hold. */
export function secs(ms: number | null): string {
  return ms === null ? '–' : `${(ms / MS.second).toFixed(DP.seconds)}s`
}

/**
 * How long ago, in the largest unit that still reads as a number.
 *
 * "never" rather than a dash when there is no reading at all, because a dash is what an
 * operator reads as "zero" at a glance and "never" is not something you can misread.
 */
export function ago(ms: number | null): string {
  if (ms === null) return 'never'
  if (ms < MS.second) return `${Math.round(ms)}ms`
  if (ms < MS.minute) return `${Math.round(ms / MS.second)}s`
  if (ms < MS.hour) return `${Math.round(ms / MS.minute)}m`
  if (ms < MS.day) return `${(ms / MS.hour).toFixed(1)}h`
  return `${(ms / MS.day).toFixed(1)}d`
}

/** UTC wall clock. The box, the logs and every window in this repo are UTC and nothing converts. */
export function hhmmss(at: number | null): string {
  if (at === null) return '–'
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

export function hhmm(at: number | null): string {
  if (at === null) return '–'
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/** Date and minute, for the zero point and anything that can be more than a day old. */
export function dayHhmm(at: number | null): string {
  if (at === null) return '–'
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

export function isoUtc(at: number): string {
  return new Date(at).toISOString().replace('T', ' ').replace('.000Z', 'Z')
}

/** A token address, short enough for a column and long enough to search a block explorer for. */
export function shortToken(token: string): string {
  return token.length > TOKEN_CHARS ? `${token.slice(0, 6)}…${token.slice(-4)}` : token
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/**
 * Escape anything that reaches the document.
 *
 * EVERY interpolation in `render/` goes through this, including values that "cannot" contain
 * markup. Token symbols come off the chain, refusal reasons are free text assembled in core/,
 * and a halt reason can quote a provider's error body. The page is loopback-only over a
 * tailnet, so this is not an XSS boundary so much as a guarantee that a stray `<` renders as
 * a `<` instead of eating the rest of the row.
 */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---------------------------------------------------------------------------
// Tone
// ---------------------------------------------------------------------------

/** Positive is good, negative is bad, zero has no opinion. The only sign rule in the tree. */
export function signTone(n: number | bigint | null): Tone {
  if (n === null) return 'plain'
  const v = typeof n === 'bigint' ? (n > 0n ? 1 : n < 0n ? -1 : 0) : n
  if (v > 0) return 'good'
  if (v < 0) return 'bad'
  return 'plain'
}

/**
 * A fraction of an allowance, coloured against two declared cuts.
 *
 * The cuts are arguments rather than literals so they can only ever come from `levels.ts`.
 * Higher is worse here: this measures how much of a budget has been spent.
 */
export function spentTone(fraction: number | null, warnAt: number, critAt: number): Tone {
  if (fraction === null) return 'plain'
  if (fraction >= critAt) return 'bad'
  if (fraction >= warnAt) return 'warn'
  return 'plain'
}

/**
 * A fraction of something we wanted all of, coloured against two declared cuts.
 *
 * The mirror of `spentTone`: higher is better. This is the kept bar, where the fraction is
 * the share of the available run we actually took.
 */
export function keptTone(fraction: number | null, goodAt: number, warnAt: number): Tone {
  if (fraction === null) return 'plain'
  if (fraction >= goodAt) return 'good'
  if (fraction >= warnAt) return 'warn'
  return 'bad'
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function shown<T>(v: {
  value: T | null
  text: string
  tone?: Tone
  at?: number | null
  ageMs?: number | null
  source?: Shown<T>['source']
  n?: number | null
  missing?: string | null
}): Shown<T> {
  return {
    value: v.value,
    text: v.text,
    tone: v.tone ?? 'plain',
    at: v.at ?? null,
    ageMs: v.ageMs ?? null,
    source: v.source ?? null,
    n: v.n ?? null,
    missing: v.missing ?? null,
  }
}

/**
 * There is no value, and this is why.
 *
 * `label` is what the cell draws, `why` is the sentence behind it. They are separate because
 * the cell has a column's width and the sentence needs a paragraph: the label goes in the
 * table, the sentence goes in the notices block and the tooltip.
 */
export function absent<T>(why: string, label = 'not measured'): Shown<T> {
  return { value: null, text: label, tone: 'muted', at: null, ageMs: null, source: null, n: null, missing: why }
}

/**
 * A `Sensed<T>` from the fold, turned into something drawable, with its age and denominator.
 *
 * `now` is the fold's own `at`, never a wall clock: an age computed against the machine clock
 * would drift away from the tape and a replay would render differently from the run.
 */
export function fromSensed<T, U>(
  now: number,
  s: Sensed<T> | null,
  draw: (v: T) => { value: U | null; text: string; tone?: Tone },
  why: string,
  label = 'never read',
): Shown<U> {
  if (s === null) return absent<U>(why, label)
  const d = draw(s.value)
  return shown<U>({
    value: d.value,
    text: d.text,
    tone: d.tone ?? 'plain',
    at: s.at,
    ageMs: now - s.at,
    source: s.source,
    n: s.n,
  })
}

export function bar(fraction: number | null, text: string, tone: Tone, missing: string | null = null): Bar {
  const f = fraction === null ? 0 : Math.max(0, Math.min(1, fraction))
  return { fraction: f, text, tone, missing }
}
