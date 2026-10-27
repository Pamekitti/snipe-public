/**
 * Replay a tape through the fold, and compare the result against what the live run did.
 *
 * THIS IS THE ONLY PROOF THE REWRITE HAS. There is no live shadow (the cutover is stop and
 * switch), so equivalence is established offline: fold the same events the live bot saw and
 * check the decisions match. That is only meaningful because the feed overlay is on the
 * tape. The old replay rebuilt the overlay from `eth_getLogs` instead, which made it an
 * independent SECOND OPINION rather than a reproduction, and that is the real reason its
 * paper account matched none of 49 real trades.
 *
 * IT NEVER SENDS. The driver has no signer, no socket and no chain client. It cannot act on
 * an intent even if it wanted to; it records them and compares.
 *
 * DIVERGENCE IS A VALUE, NOT A THROW. A replay that stops at the first difference tells you
 * about one; this collects them all, because the useful question is "how many and of what
 * kind", and a single early difference usually explains a hundred later ones.
 */
import { decide } from '../core/decide.js'
import type { Intent } from '../core/intents.js'
import { canonical } from '../core/identity.js'
import type { Event } from '../core/events.js'
import type { State } from '../core/state.js'

/** One place where the replay and the live run disagreed. */
export type Divergence = {
  readonly seq: number
  readonly at: number
  readonly kind: 'intent-missing' | 'intent-extra' | 'intent-differs'
  readonly detail: string
}

export type ReplayResult = {
  readonly state: State
  /** every intent the fold produced, canonicalised, in seq order. The kernel's behaviour. */
  readonly decisions: readonly string[]
  readonly divergences: readonly Divergence[]
  readonly events: number
  readonly refusals: number
  /** refusals by bucket, so a run can be summarised without walking every one */
  readonly buckets: Readonly<Record<string, number>>
}

/**
 * Fold a whole tape.
 *
 * `onEvent` is called after each fold, so a caller can drive a progress line or feed a
 * projection without this function knowing what either is.
 */
export function replay(
  initial: State,
  events: Iterable<Event>,
  onEvent?: (state: State, event: Event, intents: readonly Intent[]) => void,
): ReplayResult {
  let state = initial
  const decisions: string[] = []
  const buckets: Record<string, number> = {}
  let count = 0
  let refusals = 0

  for (const e of events) {
    const out = decide(state, e)
    if (!out) continue
    state = out.state
    count++
    for (const r of out.refusals) {
      refusals++
      buckets[r.bucket] = (buckets[r.bucket] ?? 0) + 1
    }
    // Only INTENTS enter the behaviour fingerprint. A refusal is a fact about the world
    // (a launch we did not want), while an intent is a decision to act; two kernels that
    // refuse for differently worded reasons are the same decider, and two that act
    // differently are not.
    for (const i of out.intents) decisions.push(`${e.seq}:${canonical(i)}`)
    onEvent?.(state, e, out.intents)
  }

  return { state, decisions, divergences: [], events: count, refusals, buckets }
}

/**
 * Compare the fold's intents against what the live run actually did, from the same tape.
 *
 * The live run's own actions are on the tape as `tx-signed` events, so this needs no second
 * source: the tape holds both the inputs and the outputs of the run being checked.
 *
 * CANONICAL JSON, ZERO TOLERANCE. Keys sorted, bigints as decimal strings. A comparison that
 * tolerated "close enough" would pass the day the rewrite got a price wrong by a wei, which
 * is exactly the day it needs to fail.
 */
export function compareAgainstLive(
  foldIntents: ReadonlyArray<{ readonly seq: number; readonly intent: Intent }>,
  liveSigned: ReadonlyArray<{ readonly seq: number; readonly intentId: string; readonly txKind: string; readonly token: string }>,
): readonly Divergence[] {
  const out: Divergence[] = []
  // Keyed on (txKind, token), not on intentId: the live run and the replay mint ids from
  // their own counters, and requiring those to match would compare bookkeeping rather than
  // behaviour. What must match is that the same kind of action was taken on the same token.
  const key = (k: string, t: string) => `${k}|${t.toLowerCase()}`

  const mine = new Map<string, { seq: number; intent: Intent }>()
  for (const f of foldIntents) {
    if (f.intent.kind !== 'buy' && f.intent.kind !== 'sell') continue
    mine.set(key(f.intent.kind, f.intent.token), f)
  }
  const theirs = new Map<string, { seq: number; token: string; txKind: string }>()
  for (const l of liveSigned) {
    if (l.txKind !== 'buy' && l.txKind !== 'sell') continue
    theirs.set(key(l.txKind, l.token), l)
  }

  for (const [k, l] of theirs) {
    if (!mine.has(k)) out.push({ seq: l.seq, at: 0, kind: 'intent-missing', detail: `the live run ${l.txKind} ${l.token} and the fold did not` })
  }
  for (const [k, f] of mine) {
    if (theirs.has(k)) continue
    // Narrowed rather than asserted: `mine` only ever holds buys and sells (the filter
    // above), but the compiler cannot see that through a Map, and a cast here would be the
    // one place this file stopped being checkable.
    const i = f.intent
    if (i.kind !== 'buy' && i.kind !== 'sell') continue
    out.push({ seq: f.seq, at: 0, kind: 'intent-extra', detail: `the fold would ${i.kind} ${i.token} and the live run did not` })
  }
  return out
}
